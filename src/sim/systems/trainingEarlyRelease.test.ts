import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { SimState, TrainingJob } from '../types'
import {
  canReleaseTrainingJob,
  detectLossPlateau,
  releaseFromJob,
  releaseTrainingEarly,
  startTraining,
  trainingMinimumStatus,
} from './training'

function started(seed = 1701): SimState {
  const base = createGame(seed)
  return startTraining(
    {
      ...base,
      player: {
        ...base.player,
        cash: 5_000_000_000,
        allocation: { training: 0.9, inference: 0.05, research: 0.05 },
      },
    },
    { name: 'Plateau Run', family: 'dense', paramsB: 1 },
  )
}

function lossHistory(losses: number[]): NonNullable<TrainingJob['lossHistory']> {
  return losses.map((loss, index) => ({
    day: index + 1,
    stage: 'base',
    progress: 0.45 + index * 0.01,
    loss,
  }))
}

function withJob(state: SimState, patch: Partial<TrainingJob>): SimState {
  const job = { ...state.player.trainingJob!, ...patch }
  return {
    ...state,
    player: { ...state.player, trainingJob: job, trainingJobs: [job] },
  }
}

describe('training early release', () => {
  it('detects a deterministic recent plateau but rejects a still-improving curve', () => {
    const plateau = { lossHistory: lossHistory([3.02, 3.01, 3.03, 3, 3.02, 3.01]) }
    const improving = { lossHistory: lossHistory([3.5, 3.4, 3.3, 3.2, 3.1, 3]) }

    expect(detectLossPlateau(plateau)).toBe(true)
    expect(detectLossPlateau(plateau)).toBe(true)
    expect(detectLossPlateau(improving)).toBe(false)
  })

  it('marks a plateaued, calendar-mature checkpoint as early-release ready', () => {
    const state = started()
    const job = state.player.trainingJob!
    const early = {
      ...job,
      progressPfDays: job.targetPfDays * 0.5,
      daysElapsed: job.minCalendarDays,
      lossHistory: lossHistory([3.02, 3.01, 3.03, 3, 3.02, 3.01]),
    }

    expect(trainingMinimumStatus(early)).toMatchObject({
      ok: false,
      completeReady: false,
      plateaued: true,
      earlyReleaseReady: true,
    })
    expect(canReleaseTrainingJob(early)).toEqual({ ok: true, releaseKind: 'early' })
  })

  it('denies early release without a plateau and before the calendar minimum', () => {
    const state = started(1702)
    const job = state.player.trainingJob!
    const improving = withJob(state, {
      progressPfDays: job.targetPfDays * 0.5,
      daysElapsed: job.minCalendarDays,
      lossHistory: lossHistory([3.5, 3.4, 3.3, 3.2, 3.1, 3]),
    })
    const tooSoon = withJob(state, {
      progressPfDays: job.targetPfDays * 0.5,
      daysElapsed: Math.max(0, (job.minCalendarDays ?? 0) - 1),
      lossHistory: lossHistory([3.02, 3.01, 3.03, 3, 3.02, 3.01]),
    })

    expect(releaseTrainingEarly(improving, job.id).player.trainingJobs).toHaveLength(1)
    expect(canReleaseTrainingJob(tooSoon.player.trainingJob!)).toMatchObject({ ok: false })
    expect(releaseTrainingEarly(tooSoon, job.id).player.trainingJobs).toHaveLength(1)
  })

  it('builds from current progress with lower capability and benchmarks than full training', () => {
    const state = started(1703)
    const job = state.player.trainingJob!
    const plateau = lossHistory([3.02, 3.01, 3.03, 3, 3.02, 3.01])
    const earlyState = withJob(state, {
      progressPfDays: job.targetPfDays * 0.5,
      daysElapsed: job.minCalendarDays,
      lossHistory: plateau,
    })
    const fullState = withJob(state, {
      progressPfDays: job.targetPfDays,
      daysElapsed: job.minCalendarDays,
      lossHistory: plateau,
    })

    const earlyModel = releaseTrainingEarly(earlyState, job.id).player.models.at(-1)!
    const fullModel = releaseFromJob(fullState, job.id).player.models.at(-1)!

    expect(earlyModel.trainComputeSpent).toBeCloseTo(job.targetPfDays * 0.5)
    expect(earlyModel.capability).toBeLessThan(fullModel.capability)
    expect(earlyModel.benchmarks.mmlu).toBeLessThan(fullModel.benchmarks.mmlu)
  })
})
