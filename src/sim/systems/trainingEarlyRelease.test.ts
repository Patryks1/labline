import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { SimState, TrainingJob } from '../types'
import {
  canReleaseTrainingJob,
  detectLossPlateau,
  earlyReleasePenalty,
  keepInternal,
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

describe('training early release / anytime launch', () => {
  it('detects a deterministic recent plateau but rejects a still-improving curve', () => {
    const plateau = { lossHistory: lossHistory([3.02, 3.01, 3.03, 3, 3.02, 3.01]) }
    const improving = { lossHistory: lossHistory([3.5, 3.4, 3.3, 3.2, 3.1, 3]) }

    expect(detectLossPlateau(plateau)).toBe(true)
    expect(detectLossPlateau(plateau)).toBe(true)
    expect(detectLossPlateau(improving)).toBe(false)
  })

  it('allows launch at ≥5% progress without calendar or plateau gates', () => {
    const state = started()
    const job = state.player.trainingJob!
    const mid = {
      ...job,
      progressPfDays: job.targetPfDays * 0.5,
      daysElapsed: 0,
      lossHistory: lossHistory([3.5, 3.4, 3.3, 3.2, 3.1, 3]),
    }

    expect(trainingMinimumStatus(mid)).toMatchObject({
      ok: false,
      completeReady: false,
      calendarReady: true,
      launchReady: true,
      earlyReleaseReady: true,
    })
    expect(canReleaseTrainingJob(mid)).toEqual({ ok: true, releaseKind: 'early' })
  })

  it('blocks launch below 5% progress', () => {
    const state = started(1702)
    const job = state.player.trainingJob!
    const tooSoon = withJob(state, {
      progressPfDays: job.targetPfDays * 0.02,
      daysElapsed: 0,
    })

    expect(canReleaseTrainingJob(tooSoon.player.trainingJob!)).toMatchObject({ ok: false })
    expect(releaseTrainingEarly(tooSoon, job.id).player.trainingJobs).toHaveLength(1)
    expect(keepInternal(tooSoon, job.id).player.trainingJobs).toHaveLength(1)
  })

  it('scales maturity multipliers with √progress independent of legacy calendar telemetry', () => {
    const half = earlyReleasePenalty({
      progressPfDays: 50,
      targetPfDays: 100,
      daysElapsed: 10,
      minCalendarDays: 10,
    })
    const halfEarlyCal = earlyReleasePenalty({
      progressPfDays: 50,
      targetPfDays: 100,
      daysElapsed: 0,
      minCalendarDays: 10,
    })
    const full = earlyReleasePenalty({
      progressPfDays: 100,
      targetPfDays: 100,
      daysElapsed: 10,
      minCalendarDays: 10,
    })

    expect(half.progress).toBeCloseTo(0.5)
    expect(half.capabilityMultiplier).toBeCloseTo(0.45 + Math.sqrt(0.5) * 0.55, 5)
    expect(halfEarlyCal.capabilityMultiplier).toBe(half.capabilityMultiplier)
    expect(halfEarlyCal.calendarProgress).toBe(1)
    expect(full.capabilityMultiplier).toBeCloseTo(1, 5)
    expect(full.benchmarkMultiplier).toBeCloseTo(1, 5)
    expect(full.reliabilityMultiplier).toBeCloseTo(1, 5)
  })

  it('builds from current progress with lower capability and benchmarks than full training', () => {
    const state = started(1703)
    const job = state.player.trainingJob!
    const plateau = lossHistory([3.02, 3.01, 3.03, 3, 3.02, 3.01])
    const earlyState = withJob(state, {
      progressPfDays: job.targetPfDays * 0.5,
      daysElapsed: 0,
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

  it('keeps internal at mid-run without requiring calendar maturity', () => {
    const state = started(1704)
    const job = state.player.trainingJob!
    const mid = withJob(state, {
      progressPfDays: job.targetPfDays * 0.2,
      daysElapsed: 0,
    })

    const next = keepInternal(mid, job.id)
    expect(next.player.trainingJobs).toHaveLength(0)
    const model = next.player.models.at(-1)!
    expect(model.release).toBe('internal')
    expect(model.trainComputeSpent).toBeCloseTo(job.targetPfDays * 0.2)
  })
})
