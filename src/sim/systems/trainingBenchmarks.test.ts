import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { BenchmarkSuiteId, SimState, TrainingJob } from '../types'
import {
  TRAINING_BENCHMARK_MAX_SPEND,
  TRAINING_BENCHMARK_MIN_SPEND,
  benchmarkTrainingJob,
  eligibleTrainingBenchmarkSuites,
  playerTrainingResourcePlan,
  resolveTrainingBenchmarkEvaluation,
  startTraining,
  trainingBenchmarkAccuracyForSpend,
} from './training'
import { instantRecipe } from '../balance/modelProduct'
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

    const pending = scheduled.player.trainingJob!.pendingBenchmark!
    expect(pending.inferenceCost).toBeGreaterThan(0)
    expect(scheduled.player.cash).toBeCloseTo(beforeCash - pending.totalCost!, 6)
    expect(scheduled.player.trainingJob!.pendingBenchmark).toMatchObject({
      suiteIds: ['language'],
      spendPerSuite: 100_000,
      accuracy: 0.775,
      confidence: 0.84,
      effortRecipeId: 'instant',
    })
    expect(pending.totalCost).toBeGreaterThan(100_000)
    expect(pending.workload?.taskCount).toBeGreaterThan(0)
    expect(pending.workload?.computePfDays).toBeGreaterThan(0)
    expect(snapshot).toMatchObject({
      suiteIds: ['language'],
      spendPerSuite: 100_000,
      accuracy: 0.775,
      effortRecipeId: 'instant',
    })
    expect(snapshot.totalCost).toBeCloseTo(pending.totalCost!, 6)
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
      suiteIds: ['language', 'image_generation', 'omni_overview'],
    })
    expect(scheduled.player.trainingJob!.pendingBenchmark!.totalCost).toBeGreaterThan(150_000)
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
    const charged = second.player.privateEvaluationJobs!.reduce(
      (sum, queued) =>
        sum +
        (queued.kind === 'training_benchmark'
          ? (queued.pending.totalCost ?? 0)
          : 0),
      0,
    )
    expect(second.player.cash).toBeCloseTo(base.player.cash - charged, 6)

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
      effortRecipeId: 'instant',
    })
    expect(scheduled.player.trainingJob!.pendingBenchmark!.totalCost).toBeGreaterThan(100_000)
  })

  it('requires both the calendar window and completed shared Training PF', () => {
    const base = benchmarkable(12_314)
    const scheduled = benchmarkTrainingJob(base, base.player.trainingJob!.id, {
      suiteIds: ['language'],
      spendPerSuite: 150_000,
    })
    const queued = scheduled.player.privateEvaluationJobs![0]!
    const waiting = tickCheckpointEvaluations({
      ...scheduled,
      day: queued.readyDay,
      player: {
        ...scheduled.player,
        allocation: { training: 0, inference: 0.7, research: 0.3 },
      },
    })
    expect(waiting.player.privateEvaluationJobs).toHaveLength(1)
    expect(waiting.player.privateEvaluationJobs![0]!.pending.computeProgressPfDays).toBe(0)

    let advanced = {
      ...waiting,
      player: {
        ...waiting.player,
        allocation: { training: 0.7, inference: 0.2, research: 0.1 },
      },
    }
    for (let day = 0; day < 20 && advanced.player.privateEvaluationJobs!.length; day += 1) {
      advanced = tickCheckpointEvaluations({ ...advanced, day: advanced.day + 1 })
    }
    expect(advanced.player.privateEvaluationJobs).toEqual([])
    expect(advanced.player.trainingJob!.benchmarkSnapshots).toHaveLength(1)
  })

  it('private benchmark work reduces a live training run allocation', () => {
    const paused = benchmarkable(12_315)
    const activeJob = { ...paused.player.trainingJob!, paused: false }
    const active = {
      ...paused,
      player: { ...paused.player, trainingJobs: [activeJob], trainingJob: activeJob },
    }
    const soloPf = playerTrainingResourcePlan(active).jobs[activeJob.id]!.effectivePf
    const scheduled = benchmarkTrainingJob(active, activeJob.id, {
      suiteIds: ['language'],
      spendPerSuite: 150_000,
    })
    const shared = playerTrainingResourcePlan(scheduled)
    const queuedId = scheduled.player.privateEvaluationJobs![0]!.id
    expect(shared.privateEvaluations[queuedId]!.effectivePf).toBeGreaterThan(0)
    expect(shared.jobs[activeJob.id]!.effectivePf).toBeLessThan(soloPf)
  })

  it('automatic public and rival evaluations never reserve player Training PF', () => {
    const paused = benchmarkable(12_317)
    const activeJob = { ...paused.player.trainingJob!, paused: false }
    const active = {
      ...paused,
      player: { ...paused.player, trainingJobs: [activeJob], trainingJob: activeJob },
    }
    const solo = playerTrainingResourcePlan(active)
    const automatic = {
      ...active,
      evaluations: [
        ...(active.evaluations ?? []),
        {
          id: 'public-auto', modelId: 'rival-model', labId: 'rival-a',
          seasonId: 'public-season', kind: 'public' as const,
          scheduledDay: active.day, publishDay: active.day + 2,
          scores: {}, confidence: 0.8, contaminationFlags: [], published: false,
        },
      ],
    }
    const withAutomatic = playerTrainingResourcePlan(automatic)
    expect(withAutomatic.privateEvaluations).toEqual({})
    expect(withAutomatic.jobs[activeJob.id]!.effectivePf).toBe(
      solo.jobs[activeJob.id]!.effectivePf,
    )
  })

  it('rejects unknown effort instead of silently falling back to Instant', () => {
    const state = benchmarkable(12_316)
    const rejected = benchmarkTrainingJob(state, state.player.trainingJob!.id, {
      suiteIds: ['language'],
      spendPerSuite: 100_000,
      effortRecipeId: 'not-trained',
    })
    expect(rejected.player.privateEvaluationJobs ?? []).toHaveLength(0)
    expect(rejected.player.cash).toBe(state.player.cash)
  })

  it('measures one base snapshot and applies the selected effort exactly once', () => {
    const base = benchmarkable(12_318)
    const sourceJob = base.player.trainingJob!
    const job: TrainingJob = {
      ...sourceJob,
      productProfile: {
        ...sourceJob.productProfile!,
        defaultEffortId: 'instant',
        effortRecipes: [
          instantRecipe(),
          {
            id: 'max',
            name: 'Max',
            kind: 'trained',
            thinkingTokenMult: 100,
            trainPfDays: 100,
            trainCash: 1_000_000,
            trained: true,
            quality: 1,
            served: true,
            realizedLiftPct: 0.2,
          },
        ],
      },
    }
    const state = {
      ...base,
      player: {
        ...base.player,
        trainingJobs: [job],
        trainingJob: job,
      },
    }
    const schedule = (effortRecipeId: 'instant' | 'max') =>
      benchmarkTrainingJob(state, job.id, {
        suiteIds: ['language'],
        spendPerSuite: 100_000,
        effortRecipeId,
      })
    const resolve = (effortRecipeId: 'instant' | 'max') => {
      const scheduled = schedule(effortRecipeId)
      const scheduledJob = scheduled.player.trainingJob!
      return resolveTrainingBenchmarkEvaluation(
        scheduled,
        scheduledJob,
        0.5,
        'base',
        scheduledJob.pendingBenchmark!,
      )
    }
    const instant = resolve('instant')
    const max = resolve('max')
    const instantBoard = instant.effortBoards!.find(
      (board) => board.id === 'instant',
    )!
    const maxBoard = instant.effortBoards!.find((board) => board.id === 'max')!

    expect(max.effortBoards).toEqual(instant.effortBoards)
    expect(max.effortCapabilities).toEqual(instant.effortCapabilities)
    expect(instant.capability).toBeCloseTo(instantBoard.capability, 10)
    expect(max.capability).toBeCloseTo(maxBoard.capability, 10)
    expect(max.capability).toBeGreaterThan(instant.capability)
    expect(max.capability).toBeLessThanOrEqual(instantBoard.capability * 1.2)
    expect(max.suiteResults!.language!.score).toBeGreaterThan(
      instant.suiteResults!.language!.score,
    )
  })
})
