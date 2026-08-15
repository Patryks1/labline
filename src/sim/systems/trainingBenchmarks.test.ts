import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { BenchmarkSuiteId, SimState, TrainingJob } from '../types'
import {
  TRAINING_BENCHMARK_MAX_SPEND,
  TRAINING_BENCHMARK_MIN_SPEND,
  benchmarkTrainingJob,
  eligibleTrainingBenchmarkSuites,
  startTraining,
  trainingBenchmarkAccuracyForSpend,
} from './training'
import { tickCheckpointEvaluations } from './checkpointEvaluations'

function benchmarkable(seed = 12_300): SimState {
  const started = startTraining(createGame(seed), {
    name: 'Private Eval',
    family: 'dense',
    paramsB: 1,
  })
  const job = started.player.trainingJob!
  const ready: TrainingJob = {
    ...job,
    progressPfDays: job.targetPfDays * 0.5,
    paused: true,
    cashBurnPerDay: 0,
  }
  return {
    ...started,
    player: {
      ...started.player,
      cash: 10_000_000,
      trainingJobs: [ready],
      trainingJob: ready,
    },
  }
}

function resolveBenchmark(
  state: SimState,
  suiteIds: BenchmarkSuiteId[],
  spendPerSuite: number,
) {
  const jobId = state.player.trainingJob!.id
  const scheduled = benchmarkTrainingJob(state, jobId, {
    suiteIds,
    spendPerSuite,
  })
  const pending = scheduled.player.trainingJob!.pendingBenchmark!
  const resolved = tickCheckpointEvaluations({ ...scheduled, day: pending.readyDay })
  return {
    scheduled,
    snapshot: resolved.player.trainingJob!.benchmarkSnapshots!.at(-1)!,
  }
}

describe('paid training benchmarks', () => {
  it('offers only suites supported by checkpoint outputs', () => {
    const image = eligibleTrainingBenchmarkSuites({
      family: 'diffusion',
      productPreset: 'image_generation',
      io: {
        inputs: { text: 50, image: 20 },
        outputs: { image: 50 },
        tools: 0,
      },
    })
    expect(image.map((suite) => suite.id)).toEqual(['image_generation'])

    const audio = eligibleTrainingBenchmarkSuites({
      family: 'dense',
      productPreset: 'audio',
      io: {
        inputs: { text: 50, audio: 40 },
        outputs: { text: 50, audio: 35 },
        tools: 10,
      },
    })
    expect(audio.map((suite) => suite.id)).toEqual([
      'audio_generation',
      'language',
    ])

    const omni = eligibleTrainingBenchmarkSuites({
      family: 'omni',
      productPreset: 'omni',
      io: {
        inputs: { text: 50, image: 45, video: 40, audio: 40 },
        outputs: { text: 50, image: 40, video: 30, audio: 35 },
        tools: 35,
      },
    })
    expect(omni.map((suite) => suite.id)).toEqual([
      'omni_overview',
      'language',
      'image_generation',
      'video_generation',
      'audio_generation',
    ])
    for (const suite of omni) {
      expect(suite.minSpend).toBeGreaterThanOrEqual(50_000)
      expect(suite.referenceSpend).toBeGreaterThanOrEqual(suite.minSpend)
      expect(suite.referenceSpend).toBeLessThanOrEqual(150_000)
      expect(suite.maxSpend).toBe(150_000)
    }
  })

  it('deducts selected-suite cost once and persists the result table', () => {
    const state = benchmarkable()
    const beforeCash = state.player.cash
    const { scheduled, snapshot } = resolveBenchmark(
      state,
      ['language'],
      100_000,
    )

    expect(scheduled.player.cash).toBe(beforeCash - 100_000)
    expect(scheduled.player.trainingJob!.pendingBenchmark).toMatchObject({
      suiteIds: ['language'],
      spendPerSuite: 100_000,
      totalCost: 100_000,
      accuracy: 0.775,
      confidence: 0.84,
    })
    expect(snapshot).toMatchObject({
      suiteIds: ['language'],
      spendPerSuite: 100_000,
      totalCost: 100_000,
      accuracy: 0.775,
    })
    expect(snapshot.suiteResults?.language).toMatchObject({
      suiteId: 'language',
      spend: 100_000,
      accuracy: 0.775,
      confidence: 0.84,
    })
  })

  it('runs several eligible suites in one paid request', () => {
    const base = benchmarkable(12_304)
    const omniJob: TrainingJob = {
      ...base.player.trainingJob!,
      family: 'omni',
      productPreset: 'omni',
      io: {
        inputs: { text: 50, image: 45, video: 40, audio: 40 },
        outputs: { text: 50, image: 40, video: 30, audio: 35 },
        tools: 35,
      },
    }
    const state: SimState = {
      ...base,
      player: {
        ...base.player,
        trainingJobs: [omniJob],
        trainingJob: omniJob,
      },
    }
    const { scheduled, snapshot } = resolveBenchmark(
      state,
      ['language', 'image_generation', 'omni_overview'],
      50_000,
    )

    expect(scheduled.player.trainingJob!.pendingBenchmark).toMatchObject({
      totalCost: 150_000,
      suiteIds: ['language', 'image_generation', 'omni_overview'],
    })
    expect(Object.keys(snapshot.suiteResults!)).toEqual([
      'language',
      'image_generation',
      'omni_overview',
    ])
  })

  it('runs multiple benchmark jobs for one training run concurrently', () => {
    const base = benchmarkable(12_305)
    const jobId = base.player.trainingJob!.id
    const first = benchmarkTrainingJob(base, jobId, {
      suiteIds: ['language'],
      spendPerSuite: 50_000,
    })
    const second = benchmarkTrainingJob(first, jobId, {
      suiteIds: ['language'],
      spendPerSuite: 150_000,
    })
    expect(second.player.privateEvaluationJobs).toHaveLength(2)
    expect(new Set(second.player.privateEvaluationJobs!.map((job) => job.id)).size).toBe(2)
    expect(second.player.cash).toBe(base.player.cash - 200_000)

    const due = Math.max(...second.player.privateEvaluationJobs!.map((job) => job.readyDay))
    const resolved = tickCheckpointEvaluations({ ...second, day: due })
    expect(resolved.player.trainingJob!.benchmarkSnapshots).toHaveLength(2)
    expect(resolved.player.privateEvaluationJobs).toEqual([])
    expect(resolved.player.trainingJob!.pendingBenchmark).toBeUndefined()
  })

  it('makes a larger evaluation deterministically more accurate with a tighter interval', () => {
    const low = resolveBenchmark(
      benchmarkable(12_301),
      ['language'],
      TRAINING_BENCHMARK_MIN_SPEND,
    ).snapshot
    const high = resolveBenchmark(
      benchmarkable(12_301),
      ['language'],
      TRAINING_BENCHMARK_MAX_SPEND,
    ).snapshot
    const repeatedHigh = resolveBenchmark(
      benchmarkable(12_301),
      ['language'],
      TRAINING_BENCHMARK_MAX_SPEND,
    ).snapshot

    expect(high).toEqual(repeatedHigh)
    expect(high.accuracy).toBeGreaterThan(low.accuracy!)
    expect(high.inaccuracy).toBeLessThan(low.inaccuracy!)
    expect(high.suiteResults!.language!.inaccuracy).toBeLessThan(
      low.suiteResults!.language!.inaccuracy,
    )
    expect(trainingBenchmarkAccuracyForSpend(150_000).accuracy).toBeGreaterThan(
      trainingBenchmarkAccuracyForSpend(50_000).accuracy,
    )
  })

  it('rejects empty, duplicate, irrelevant, out-of-range, and unaffordable requests', () => {
    const base = benchmarkable(12_302)
    const jobId = base.player.trainingJob!.id
    const invalidRequests = [
      { suiteIds: [], spendPerSuite: 100_000 },
      { suiteIds: ['language', 'language'], spendPerSuite: 100_000 },
      { suiteIds: ['image_generation'], spendPerSuite: 100_000 },
      { suiteIds: ['language'], spendPerSuite: 49_999 },
      { suiteIds: ['language'], spendPerSuite: 150_001 },
    ] as const

    for (const request of invalidRequests) {
      const rejected = benchmarkTrainingJob(
        base,
        jobId,
        {
          ...request,
          suiteIds: [...request.suiteIds] as BenchmarkSuiteId[],
        },
      )
      expect(rejected.player.trainingJob!.pendingBenchmark).toBeUndefined()
      expect(rejected.player.cash).toBe(base.player.cash)
    }

    const poor = {
      ...base,
      player: { ...base.player, cash: 99_999 },
    }
    const rejected = benchmarkTrainingJob(poor, jobId, {
      suiteIds: ['language'],
      spendPerSuite: 100_000,
    })
    expect(rejected.player.trainingJob!.pendingBenchmark).toBeUndefined()
    expect(rejected.player.cash).toBe(99_999)
  })

  it('keeps the legacy one-click call useful by selecting the primary suite', () => {
    const state = benchmarkable(12_303)
    const jobId = state.player.trainingJob!.id
    const scheduled = benchmarkTrainingJob(state, jobId)

    expect(scheduled.player.trainingJob!.pendingBenchmark).toMatchObject({
      suiteIds: ['language'],
      spendPerSuite: 100_000,
      totalCost: 100_000,
    })
  })
})
