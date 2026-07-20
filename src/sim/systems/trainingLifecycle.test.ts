import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
  benchmarkTrainingJob,
  cancelTraining,
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

  it('uses one deterministic approximately-five-percent failure roll per stage', () => {
    const repeated = trainingStageFailurePlan({ id: 'same', outcomeSeed: 42 }, 'base')
    expect(trainingStageFailurePlan({ id: 'same', outcomeSeed: 42 }, 'base')).toEqual(repeated)
    const failures = Array.from({ length: 2_000 }, (_, seed) =>
      trainingStageFailurePlan({ id: `job-${seed}`, outcomeSeed: seed }, 'base').willFail,
    ).filter(Boolean).length
    expect(failures).toBeGreaterThan(65)
    expect(failures).toBeLessThan(135)
  })

  it('lets a completed checkpoint choose a specific researched post-train stage', () => {
    const state = started(930)
    const job = state.player.trainingJob!
    const completed = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays }],
        trainingJob: { ...job, progressPfDays: job.targetPfDays },
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
    const model = next.player.models.at(-1)!
    expect(model.release).toBe('internal')
    expect(next.player.trainingJobs).toHaveLength(0)
    expect(next.evaluations).toContainEqual(expect.objectContaining({ modelId: model.id, kind: 'internal', published: false }))
  })
})
