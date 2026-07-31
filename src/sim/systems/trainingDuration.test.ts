import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { minimumTrainingCalendarDays } from './trainingDuration'
import {
  appendLossPoint,
  startTraining,
  tickTraining,
  trainingLoss,
} from './training'
import type { TrainingJob } from '../types'

function richState(seed: number) {
  const state = createGame(seed)
  return {
    ...state,
    player: {
      ...state.player,
      cash: 5_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
    },
  }
}

describe('minimum training duration', () => {
  it('derives a bounded calendar gate from scale, family, and mode', () => {
    const small = minimumTrainingCalendarDays({ paramsB: 1, family: 'dense' })
    const frontier = minimumTrainingCalendarDays({ paramsB: 405, family: 'dense' })
    const video = minimumTrainingCalendarDays({ paramsB: 405, family: 'video' })
    const distill = minimumTrainingCalendarDays({ paramsB: 405, family: 'dense', mode: 'distill' })
    expect(frontier).toBeGreaterThan(small)
    expect(video).toBeGreaterThan(frontier)
    expect(distill).toBeLessThan(frontier)
  })

  it('keeps PF work and upfront cash independent of launch-time pool size', () => {
    const fast = startTraining(richState(1201), { name: 'PoolInvariant', family: 'dense', paramsB: 1 })
    const slowBase = richState(1201)
    const slow = startTraining({
      ...slowBase,
      player: { ...slowBase.player, allocation: { training: 0.05, inference: 0.9, research: 0.05 } },
    }, { name: 'PoolInvariant', family: 'dense', paramsB: 1 })
    expect(slow.player.trainingJob!.targetPfDays).toBeCloseTo(fast.player.trainingJob!.targetPfDays)
    expect(slow.player.trainingJob!.cashSunk).toBe(fast.player.trainingJob!.cashSunk)
  })

  it('requires funded active calendar days after compute is complete', () => {
    let state = startTraining(richState(1201), {
      name: 'FastTrain',
      family: 'dense',
      paramsB: 1,
      computePriority: 100,
    })
    const job = state.player.trainingJob!
    const minDays = job.minCalendarDays!
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...job, progressPfDays: job.targetPfDays },
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays }],
      },
    }

    for (let day = 0; day < minDays - 1; day++) {
      const next = tickTraining(state)
      state = {
        ...next,
        day: state.day + 1,
        player: { ...next.player, cash: 5_000_000_000 },
      }
      expect(state.player.trainingJob!.awaitingDecision).not.toBe(true)
    }
    state = tickTraining(state)
    expect(state.player.trainingJob!.daysElapsed).toBe(minDays)
    expect(state.player.trainingJob!.awaitingDecision).toBe(true)
  })
})

describe('training loss curve', () => {
  const job: Pick<TrainingJob, 'id' | 'outcomeSeed' | 'targetParamsB'> = {
    id: 'loss-job',
    outcomeSeed: 4242,
    targetParamsB: 8,
  }

  it('trends downward with diminishing late gains and stays above the floor', () => {
    const early = trainingLoss(job, 'base', 0.05, 1)
    const mid = trainingLoss(job, 'base', 0.5, 50)
    const late = trainingLoss(job, 'base', 0.95, 95)
    expect(early).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(late * 0.85)
    // Late-run day-to-day trend improvement is much smaller than early.
    const earlyDelta =
      trainingLoss(job, 'base', 0.0, 1) - trainingLoss(job, 'base', 0.1, 10)
    const lateDelta =
      trainingLoss(job, 'base', 0.85, 85) - trainingLoss(job, 'base', 0.95, 95)
    expect(earlyDelta).toBeGreaterThan(lateDelta * 2)
    expect(late).toBeGreaterThanOrEqual(1.15 * 0.92)
  })

  it('records non-monotonic observed history with up-ticks while trending down', () => {
    let historyJob: TrainingJob = {
      id: job.id,
      name: 'LossHist',
      family: 'dense',
      targetParamsB: job.targetParamsB,
      targetPfDays: 100,
      progressPfDays: 0,
      postTrain: 'none',
      postTrainProgress: 0,
      postTrainTarget: 0,
      mode: 'pretrain',
      dataMix: 'web',
      dataPlan: {
        totalUnits: 100,
        totalMTok: 100,
        trainShare: 0.82,
        weights: {},
        allowSynthetic: true,
      },
      dataConsumed: {},
      dataCoverage: 1,
      dataQualityUsed: 70,
      syntheticUnits: 0,
      trainShare: 0.82,
      trainMTok: 82,
      verifyMTok: 18,
      cashBurnPerDay: 0,
      cashSunk: 0,
      outcomeSeed: job.outcomeSeed,
      lossHistory: [],
    }

    for (let day = 1; day <= 40; day++) {
      const progress = day / 40
      historyJob = {
        ...historyJob,
        lossHistory: appendLossPoint(historyJob, 'base', progress, day),
      }
    }
    const losses = historyJob.lossHistory!.map((point) => point.loss)
    expect(losses.length).toBe(40)
    expect(losses[0]!).toBeGreaterThan(losses[losses.length - 1]!)
    const upTicks = losses.filter((loss, index) => index > 0 && loss > losses[index - 1]!).length
    expect(upTicks).toBeGreaterThan(0)
    expect(Math.min(...losses)).toBeGreaterThanOrEqual(1.15 * 0.92 - 1e-9)
  })

  it('is deterministic for the same seed / day sequence', () => {
    const a = Array.from({ length: 20 }, (_, day) =>
      trainingLoss(job, 'base', day / 20, day + 1),
    )
    const b = Array.from({ length: 20 }, (_, day) =>
      trainingLoss(job, 'base', day / 20, day + 1),
    )
    expect(a).toEqual(b)

    let histA: TrainingJob = {
      id: job.id,
      name: 'DetA',
      family: 'dense',
      targetParamsB: job.targetParamsB,
      targetPfDays: 20,
      progressPfDays: 0,
      postTrain: 'none',
      postTrainProgress: 0,
      postTrainTarget: 0,
      mode: 'pretrain',
      dataMix: 'web',
      dataPlan: {
        totalUnits: 20,
        totalMTok: 20,
        trainShare: 0.82,
        weights: {},
        allowSynthetic: true,
      },
      dataConsumed: {},
      dataCoverage: 1,
      dataQualityUsed: 70,
      syntheticUnits: 0,
      trainShare: 0.82,
      trainMTok: 16,
      verifyMTok: 4,
      cashBurnPerDay: 0,
      cashSunk: 0,
      outcomeSeed: job.outcomeSeed,
      lossHistory: [],
    }
    let histB = { ...histA }
    for (let day = 1; day <= 12; day++) {
      histA = { ...histA, lossHistory: appendLossPoint(histA, 'base', day / 12, day) }
      histB = { ...histB, lossHistory: appendLossPoint(histB, 'base', day / 12, day) }
    }
    expect(histA.lossHistory).toEqual(histB.lossHistory)
  })
})
