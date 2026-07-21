import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { computeSnapshot } from './compute'
import {
  progressRivalTrainingJob,
} from './rivals'
import { enforceMinTrainingDuration, MIN_TRAINING_DAYS } from './trainingDuration'
import {
  appendLossPoint,
  startTraining,
  tickTraining,
  trainingLoss,
} from './training'
import type { RivalTrainJob, TrainingJob } from '../types'

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
  it('scales work so estimated duration is at least 30 days', () => {
    expect(enforceMinTrainingDuration(100, 20)).toBe(600)
    expect(enforceMinTrainingDuration(900, 20)).toBe(900)
    expect(enforceMinTrainingDuration(10, 0)).toBe(MIN_TRAINING_DAYS)
  })

  it('never finishes a started player job before day 30 even with massive compute', () => {
    let state = startTraining(richState(1201), {
      name: 'FastTrain',
      family: 'dense',
      paramsB: 1,
      computePriority: 100,
    })
    const job = state.player.trainingJob!
    const daily = computeSnapshot(state).pools.training
    expect(job.targetPfDays).toBeGreaterThanOrEqual(daily * MIN_TRAINING_DAYS * 0.5)
    expect(job.targetPfDays / Math.max(1e-9, daily)).toBeGreaterThanOrEqual(MIN_TRAINING_DAYS - 1e-6)

    for (let day = 0; day < MIN_TRAINING_DAYS - 1; day++) {
      const next = tickTraining(state)
      state = {
        ...next,
        day: state.day + 1,
        player: { ...next.player, cash: 5_000_000_000 },
      }
      expect(state.player.trainingJob).not.toBeNull()
      expect(state.player.trainingJob!.progressPfDays).toBeLessThan(
        state.player.trainingJob!.targetPfDays,
      )
    }
  })

  it('scales rival jobs so they also respect the 30-day floor', () => {
    const dailyThroughput = 40
    const rawTarget = 100
    const scaled = enforceMinTrainingDuration(rawTarget, dailyThroughput)
    expect(scaled).toBe(dailyThroughput * MIN_TRAINING_DAYS)

    const job: RivalTrainJob = {
      id: 'rt-test',
      name: 'RivalFast',
      family: 'dense',
      paramsB: 1,
      targetPfDays: scaled,
      progressPfDays: 0,
      modalities: ['text'],
      dataCoverage: 1,
      dataQuality: 70,
      includeSynthHQ: false,
      includeSynthLQ: false,
      synthLqShare: 0,
      trainShare: 0.82,
      totalMTok: 1_000,
      cashBurnPerDay: 0,
      cashSunk: 0,
    }

    let current = job
    for (let day = 0; day < MIN_TRAINING_DAYS - 1; day++) {
      current = progressRivalTrainingJob(current, dailyThroughput).job
      expect(current.progressPfDays).toBeLessThan(current.targetPfDays)
    }
    current = progressRivalTrainingJob(current, dailyThroughput).job
    expect(current.progressPfDays).toBeGreaterThanOrEqual(current.targetPfDays)
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
