import { describe, expect, it } from 'vitest'
import {
  postTrainEffectProfile,
  postTrainMinimumDays,
} from '../balance/postTraining'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import type { PostTrainStage, SimState, TrainingJob } from '../types'
import {
  canReleaseTrainingJob,
  keepInternal,
  selectPostTrain,
  startTraining,
} from './training'

type TrainablePostStage = Exclude<PostTrainStage, 'none'>

function withMirroredJob(state: SimState, job: TrainingJob): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      trainingJob: job,
      trainingJobs: [job],
    },
  }
}

function baseReady(seed: number): SimState {
  let state = createGame(seed)
  state = {
    ...state,
    player: {
      ...state.player,
      cash: 2_000_000_000,
      researchUnlocked: [
        ...state.player.researchUnlocked,
        'align_rlhf',
        'align_process',
        'domain_agents',
      ],
    },
  }
  state = startTraining(state, {
    name: `Post correctness ${seed}`,
    family: 'dense',
    paramsB: 1,
  })
  const job = state.player.trainingJob
  expect(job, state.alerts[0]?.message).not.toBeNull()
  return withMirroredJob(state, {
    ...job!,
    progressPfDays: job!.targetPfDays,
    daysElapsed: job!.minCalendarDays,
    awaitingDecision: true,
    paused: true,
  })
}

function profile(state: SimState, job: TrainingJob) {
  return postTrainEffectProfile(
    job,
    state.player.researchUnlocked,
    state.player.models,
  )
}

describe('post-training earned effects', () => {
  it.each<TrainablePostStage>(['sft', 'rlhf', 'process', 'tools'])(
    'treats selecting %s as a zero-benefit plan that cannot be finalized',
    (stage) => {
      const ready = baseReady(10_100 + ['sft', 'rlhf', 'process', 'tools'].indexOf(stage))
      const jobId = ready.player.trainingJob!.id
      const selected = selectPostTrain(ready, jobId, stage)
      const job = selected.player.trainingJob!
      const earned = profile(selected, job)

      expect(job).toMatchObject({
        postTrain: stage,
        postTrainProgress: 0,
        postTrainDaysElapsed: 0,
      })
      expect(earned.stageEffectiveness[stage]).toBe(0)
      expect(earned.scaleStrength).toBe(0)
      expect(earned.alignmentEquivalent).toBe(0)
      expect(earned.toolsEnabled).toBe(false)
      expect(canReleaseTrainingJob(job)).toMatchObject({ ok: false })

      const finalized = keepInternal(selected, jobId)
      expect(finalized.player.models).toHaveLength(selected.player.models.length)
      expect(finalized.player.trainingJob?.id).toBe(jobId)
    },
  )

  it('scales earned evidence monotonically with allocated PF independent of days', () => {
    const ready = baseReady(10_110)
    const selected = selectPostTrain(
      ready,
      ready.player.trainingJob!.id,
      'tools',
    )
    const selectedJob = selected.player.trainingJob!
    const minimumDays = postTrainMinimumDays('tools', selectedJob.targetParamsB)
    const at = (progress: number, calendar: number) =>
      profile(selected, {
        ...selectedJob,
        postTrainProgress: selectedJob.postTrainTarget * progress,
        postTrainDaysElapsed: minimumDays * calendar,
      }).stageEffectiveness.tools

    expect(at(0, 0.5)).toBe(0)
    expect(at(0.5, 0)).toBeGreaterThan(0)

    const quarter = at(0.25, 0.25)
    const half = at(0.5, 0.5)
    const complete = at(1, 1)
    expect(quarter).toBeGreaterThan(0)
    expect(half).toBeGreaterThan(quarter)
    expect(complete).toBeGreaterThan(half)
    expect(quarter).toBeLessThan(complete * 0.4)
    expect(half).toBeLessThan(complete * 0.8)
  })

  it('round-trips partial PF/calendar evidence without marking the stage complete', () => {
    const ready = baseReady(10_120)
    const selected = selectPostTrain(
      ready,
      ready.player.trainingJob!.id,
      'tools',
    )
    const selectedJob = selected.player.trainingJob!
    const minimumDays = postTrainMinimumDays('tools', selectedJob.targetParamsB)
    const partialJob: TrainingJob = {
      ...selectedJob,
      postTrainProgress: selectedJob.postTrainTarget * 0.42,
      postTrainDaysElapsed: minimumDays * 0.42,
      completedPostTrainStages: [],
      postTrainStageEffectiveness: {},
    }
    const before = profile(selected, partialJob)
    const restored = roundTripState(withMirroredJob(selected, partialJob))
    const afterJob = restored.player.trainingJob!
    const after = profile(restored, afterJob)

    expect(afterJob.postTrain).toBe('tools')
    expect(afterJob.postTrainProgress).toBeCloseTo(partialJob.postTrainProgress)
    expect(afterJob.postTrainDaysElapsed).toBeCloseTo(partialJob.postTrainDaysElapsed!)
    expect(afterJob.completedPostTrainStages).not.toContain('tools')
    expect(after.stageEffectiveness.tools).toBeCloseTo(
      before.stageEffectiveness.tools,
      10,
    )

    const pfCompleteButCalendarShort: TrainingJob = {
      ...partialJob,
      postTrainProgress: partialJob.postTrainTarget,
      postTrainDaysElapsed: minimumDays - 1,
    }
    const restoredShort = roundTripState(
      withMirroredJob(selected, pfCompleteButCalendarShort),
    )
    expect(restoredShort.player.trainingJob?.completedPostTrainStages).toContain(
      'tools',
    )
  })

  it('does not promote a saved model stage label or inflate explicit earned evidence', () => {
    const ready = baseReady(10_130)
    const internal = keepInternal(ready, ready.player.trainingJob!.id)
    const base = internal.player.models.find((model) =>
      model.name.startsWith('Post correctness'),
    )!
    const labelOnly = {
      ...base,
      postTrain: 'tools' as const,
      completedPostTrainStages: [],
      postTrainStageEffectiveness: {},
      postTrainStageRuns: {},
      integratedMethods: (base.integratedMethods ?? []).filter(
        (id) => id !== 'align_process',
      ),
      modelStack: (base.modelStack ?? []).filter((id) => id !== 'align_process'),
      reasoningEnabled: true,
      io: { ...base.io!, tools: 0 },
      modalities: base.modalities.filter((modality) => modality !== 'tools'),
    }
    const labelState: SimState = {
      ...internal,
      player: {
        ...internal.player,
        models: [labelOnly],
      },
    }
    const restoredLabel = roundTripState(labelState).player.models[0]!

    expect(restoredLabel.postTrain).toBe('none')
    expect(restoredLabel.completedPostTrainStages).toEqual([])
    expect(restoredLabel.postTrainStageEffectiveness).toEqual({})
    expect(restoredLabel.io?.tools).toBe(0)
    expect(restoredLabel.modalities).not.toContain('tools')
    expect(restoredLabel.reasoningEnabled).toBe(false)

    const earned = {
      ...labelOnly,
      postTrain: 'tools' as const,
      completedPostTrainStages: ['tools' as const],
      postTrainStageEffectiveness: { tools: 0.32 },
      postTrainStageRuns: { tools: 1 },
      reasoningEnabled: true,
      io: { ...labelOnly.io!, tools: 7 },
      modalities: [...labelOnly.modalities, 'tools' as const],
    }
    const earnedState: SimState = {
      ...labelState,
      player: { ...labelState.player, models: [earned] },
    }
    const restoredEarned = roundTripState(earnedState).player.models[0]!

    expect(restoredEarned.postTrain).toBe('tools')
    expect(restoredEarned.completedPostTrainStages).toEqual(['tools'])
    expect(restoredEarned.postTrainStageEffectiveness?.tools).toBeCloseTo(0.32)
    expect(restoredEarned.io?.tools).toBe(7)
    expect(restoredEarned.modalities).toContain('tools')
  })
})
