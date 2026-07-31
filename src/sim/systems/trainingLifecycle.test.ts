import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
  benchmarkTrainingJob,
  cancelTraining,
  completeTrainingJobsNow,
  keepInternal,
  selectPostTrain,
  startTraining,
  trainingStageFailurePlan,
} from './training'

function started(seed = 930) {
  const state = startTraining(createGame(seed), {
    name: 'Lifecycle',
    family: 'dense',
    paramsB: 1,
  })
  expect(state.player.trainingJob).not.toBeNull()
  return state
}

describe('training lifecycle controls', () => {
  it('creates and finalizes an omni product on a sparse backbone without dropping active params', () => {
    let state = createGame(929)
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 2_000_000_000,
        researchUnlocked: [
          ...state.player.researchUnlocked,
          'mm_vision',
          'mm_diff',
          'mm_video',
          'mm_omni',
          'moe_basics',
          'moe_routing',
          'data_mix',
        ],
      },
    }
    state = startTraining(state, {
      name: 'Sparse Omni',
      family: 'omni',
      backbone: 'moe',
      productPreset: 'omni',
      paramsB: 0.1,
      activeParamsB: 0.01,
      dataPlan: {
        totalUnits: 200,
        weights: { chat: 0.4, image: 0.2, audio: 0.2, video: 0.2 },
        allowSynthetic: true,
      },
    })

    expect(state.player.trainingJob, state.alerts[0]?.message).toMatchObject({
      family: 'omni',
      backbone: 'moe',
      productPreset: 'omni',
      activeParamsB: 0.01,
    })

    state = completeTrainingJobsNow(state)
    state = keepInternal(state)
    expect(state.player.models.find((model) => model.name === 'Sparse Omni')).toMatchObject({
      family: 'omni',
      backbone: 'moe',
      productPreset: 'omni',
      activeParamsB: 0.01,
    })
  })

  it('cancels exactly one concurrent job and preserves the compatibility mirror', () => {
    let state = started()
    state = startTraining(state, { name: 'Second', family: 'dense', paramsB: 1 })
    expect(state.player.trainingJobs).toHaveLength(2)
    const cancelledId = state.player.trainingJobs![0]!.id

    state = cancelTraining(state, cancelledId)

    expect(state.player.trainingJobs).toHaveLength(1)
    expect(state.player.trainingJobs?.some((job) => job.id === cancelledId)).toBe(false)
    expect(state.player.trainingJob?.id).toBe(state.player.trainingJobs?.[0]?.id)
  })

  it('keeps mature catastrophic failures rare and scales them with recipe risk', () => {
    const repeated = trainingStageFailurePlan({ id: 'same', outcomeSeed: 42 }, 'base')
    expect(trainingStageFailurePlan({ id: 'same', outcomeSeed: 42 }, 'base')).toEqual(repeated)
    const failures = Array.from({ length: 2_000 }, (_, seed) =>
      trainingStageFailurePlan({ id: `job-${seed}`, outcomeSeed: seed }, 'base').willFail,
    ).filter(Boolean).length
    const highRiskFailures = Array.from({ length: 2_000 }, (_, seed) =>
      trainingStageFailurePlan(
        { id: `job-${seed}`, outcomeSeed: seed, outcomeRisk: 'high' },
        'base',
      ).willFail,
    ).filter(Boolean).length
    expect(failures).toBeGreaterThan(15)
    expect(failures).toBeLessThan(55)
    expect(highRiskFailures).toBeGreaterThan(failures * 4)
  })

  it('lets a completed checkpoint choose a specific researched post-train stage', () => {
    const state = started(930)
    const job = state.player.trainingJob!
    const completed = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays, daysElapsed: job.minCalendarDays }],
        trainingJob: { ...job, progressPfDays: job.targetPfDays, daysElapsed: job.minCalendarDays },
        researchUnlocked: [...state.player.researchUnlocked, 'align_rlhf'],
      },
    }

    const next = selectPostTrain(completed, job.id, 'rlhf')
    expect(next.player.trainingJob).toMatchObject({ postTrain: 'rlhf', postTrainProgress: 0, postTrainTarget: 8 })
  })

  it('benchmarks a completed run as a private model without releasing it', () => {
    const state = started(932)
    const job = state.player.trainingJob!
    const completed = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays }],
        trainingJob: { ...job, progressPfDays: job.targetPfDays },
      },
    }

    const next = benchmarkTrainingJob(completed, job.id)
    // Mid-run / milestone benchmarks are non-terminal snapshots — they do not
    // materialize or release a model, and the job remains active.
    const updated = next.player.trainingJobs?.find((candidate) => candidate.id === job.id)
    expect(updated).toBeTruthy()
    expect(updated!.benchmarkSnapshots?.length ?? 0).toBeGreaterThan(0)
    expect(updated!.lastBenchmarkDay).toBe(next.day)
    expect(next.player.models.length).toBe(completed.player.models.length)
  })
})
