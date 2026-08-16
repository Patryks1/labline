import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildScaledModel } from '../balance/modelBuild'
import { buildSaveFile, parseSave, serializeSave } from '../save'
import type { SimState } from '../types'
import { createDataManifest } from './dataAssets'
import {
  enqueueAllDataPrunes,
  enqueueDataPrune,
  ensureLabData,
  estimateAllDataPrunes,
  estimateDataPrune,
  estimateDataPruneAudit,
  enqueueProcess,
  purchaseDataPruneAudit,
  researchPoolForTech,
  tickData,
} from './data'

function game(): SimState {
  const state = createGame({
    seed: 441,
    labName: 'Prune Lab',
    difficulty: 'easy',
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  })
  const configured: SimState = {
    ...state,
    player: {
      ...state.player,
      // Prune jobs need researchers; HQ-first starts with an empty headcount.
      staff: {
        researcher: 3,
        data_processor: state.player.staff?.data_processor ?? 0,
        engineer: Math.max(2, state.player.staff?.engineer ?? 0),
        ops: state.player.staff?.ops ?? 0,
      },
      allocation: { training: 0.1, inference: 0.1, research: 0.8 },
    },
    computeLeases: [
      {
        id: 'prune-test-compute',
        rivalId: state.rivals[0]!.id,
        playerSells: false,
        pf: 100,
        pricePerPfDay: 100,
        daysLeft: 30,
        daysTotal: 30,
        status: 'active' as const,
        from: 'rival' as const,
      },
    ],
  }
  return purchaseDataPruneAudit(configured)
}

describe('low-quality data pruning', () => {
  it('charges for a time-limited audit before revealing actionable prune volumes', () => {
    const audited = game()
    const locked = {
      ...audited,
      player: {
        ...audited.player,
        data: { ...ensureLabData(audited), pruneAuditValidUntilDay: undefined },
      },
    }
    const quote = estimateDataPruneAudit(locked)
    const beforeCash = locked.player.cash
    const before = estimateDataPrune(locked, 'code')
    const next = purchaseDataPruneAudit(locked)

    expect(quote.ok).toBe(true)
    expect(before.ok).toBe(false)
    expect(before.reason).toContain('Run corpus audit')
    expect(next.player.cash).toBeCloseTo(beforeCash - quote.cashCost, 5)
    expect(estimateDataPruneAudit(next).unlocked).toBe(true)
    expect(estimateDataPrune(next, 'code').ok).toBe(true)
  })

  it('previews real cash, PF-day, token, and researcher requirements', () => {
    const state = game()
    const estimate = estimateDataPrune(state, 'code')

    expect(estimate.ok).toBe(true)
    expect(estimate.processedMTok).toBeGreaterThan(0)
    expect(estimate.totalMTok).toBeGreaterThan(0)
    expect(estimate.cashCost).toBeGreaterThan(0)
    expect(estimate.pfDays).toBeGreaterThan(0)
    expect(estimate.researchersRequired).toBeGreaterThanOrEqual(1)
    expect(estimate.availableResearchPf).toBeGreaterThan(0)
  })

  it('refuses to queue without the required researchers and explains why', () => {
    const state = game()
    state.player.staff = {
      researcher: 0,
      data_processor: state.player.staff?.data_processor ?? 0,
      engineer: state.player.staff?.engineer ?? 0,
      ops: state.player.staff?.ops ?? 0,
    }

    const estimate = estimateDataPrune(state, 'code')
    const next = enqueueDataPrune(state, 'code')

    expect(estimate.ok).toBe(false)
    expect(estimate.reason).toContain('researchers')
    expect(ensureLabData(next).pruneQueue).toHaveLength(0)
    expect(next.alerts[0]?.message).toContain('researchers')
  })

  it('requires data-engineer capacity before an audit can enter the queue', () => {
    const state = game()
    state.player.staff = {
      researcher: 3,
      data_processor: state.player.staff?.data_processor ?? 0,
      engineer: 0,
      ops: state.player.staff?.ops ?? 0,
    }

    const estimate = estimateDataPrune(state, 'code')
    const next = enqueueDataPrune(state, 'code')

    expect(estimate.engineersRequired).toBeGreaterThan(0)
    expect(estimate.reason).toContain('data engineers')
    expect(ensureLabData(next).pruneQueue).toHaveLength(0)
  })

  it('reserves research compute, charges cash, and permanently discards low-quality stock', () => {
    let state = game()
    const beforeStock = ensureLabData(state).stocks.code
    const beforeProcessed = beforeStock.processed
    const beforeQuality = beforeStock.quality
    const beforeCash = state.player.cash
    const beforeAssetCode = ensureLabData(state).assets.reduce(
      (sum, asset) =>
        sum + asset.volumeMTok * Math.max(0, asset.domainWeights.code ?? 0),
      0,
    )

    state = enqueueDataPrune(state, 'code')
    const queued = ensureLabData(state).pruneQueue[0]
    expect(queued).toBeDefined()
    expect(researchPoolForTech(state)).toBeCloseTo(0.92, 5)

    state = tickData({ ...state, day: state.day + 1 })
    const afterData = ensureLabData(state)
    const remaining = afterData.pruneQueue[0]
      ? afterData.pruneQueue[0].rawRemaining + afterData.pruneQueue[0].processedRemaining
      : 0

    expect(remaining).toBeLessThan(queued!.rawRemaining + queued!.processedRemaining)
    expect(afterData.stocks.code.processed).toBeLessThan(beforeProcessed)
    expect(afterData.stocks.code.quality).toBeGreaterThan(beforeQuality)
    expect(state.player.cash).toBeLessThan(beforeCash)

    const afterAssetCode = afterData.assets.reduce(
      (sum, asset) =>
        sum + asset.volumeMTok * Math.max(0, asset.domainWeights.code ?? 0),
      0,
    )
    expect(beforeAssetCode - afterAssetCode).toBeCloseTo(
      beforeProcessed - afterData.stocks.code.processed,
      8,
    )
    expect(afterAssetCode).toBeLessThanOrEqual(
      afterData.stocks.code.processed + 1e-8,
    )

    const { manifest } = createDataManifest({
      data: afterData,
      consumed: { code: beforeProcessed },
      totalMTok: beforeProcessed,
      day: state.day,
      seed: state.seed,
      runId: 'post-prune-integrity',
    })
    expect(manifest.uniqueMTok).toBeLessThanOrEqual(
      afterData.stocks.code.processed + 1e-8,
    )
    expect(manifest.repeatedMTok).toBeGreaterThan(0)
  })

  it('can preview and queue every eligible domain in one action', () => {
    const state = game()
    const estimate = estimateAllDataPrunes(state)
    const next = enqueueAllDataPrunes(state)

    expect(estimate.ok).toBe(true)
    expect(estimate.domains.length).toBeGreaterThan(1)
    expect(ensureLabData(next).pruneQueue.map((job) => job.domain)).toEqual(estimate.domains)
    expect(researchPoolForTech(next)).toBeLessThan(1)
  })

  it('uses finite researcher and engineer slots across concurrent audits', () => {
    let state = game()
    state.player.staff = {
      researcher: 3,
      data_processor: state.player.staff?.data_processor ?? 0,
      engineer: 1,
      ops: state.player.staff?.ops ?? 0,
    }
    state = enqueueDataPrune(state, 'code')
    state = enqueueDataPrune(state, 'math')
    const before = ensureLabData(state).pruneQueue.map(
      (job) => job.rawRemaining + job.processedRemaining,
    )
    const estimateBase = game()
    const withEngineers = (engineer: number): SimState => ({
      ...estimateBase,
      player: {
        ...estimateBase.player,
        staff: {
          researcher: 3,
          data_processor: estimateBase.player.staff?.data_processor ?? 0,
          engineer,
          ops: estimateBase.player.staff?.ops ?? 0,
        },
      },
    })
    const oneEngineerEstimate = estimateAllDataPrunes(withEngineers(1))
    const twoEngineerEstimate = estimateAllDataPrunes(withEngineers(2))

    const next = tickData({ ...state, day: state.day + 1 })
    const after = ensureLabData(next).pruneQueue.map(
      (job) => job.rawRemaining + job.processedRemaining,
    )
    expect(after[0]).toBeLessThan(before[0]!)
    expect(after[1]).toBe(before[1])
    expect(oneEngineerEstimate.estimatedDays).toBeGreaterThan(
      twoEngineerEstimate.estimatedDays,
    )
  })

  it('preserves a negative company ledger across consecutive unaffordable prune days', () => {
    const queued = enqueueDataPrune(game(), 'code')
    let state: SimState = {
      ...queued,
      player: { ...queued.player, cash: -25_000 },
    }
    const initialQueue = ensureLabData(state).pruneQueue
    state = tickData({ ...state, day: state.day + 1 })
    expect(state.player.cash).toBe(-25_000)
    expect(ensureLabData(state).pruneQueue).toEqual(initialQueue)
    state = tickData({ ...state, day: state.day + 1 })
    expect(state.player.cash).toBe(-25_000)
    expect(ensureLabData(state).pruneQueue).toEqual(initialQueue)
  })

  it('applies bounded drift to every model once per 20-day review while hygiene is unsafe', () => {
    const base = game()
    const model = buildScaledModel({
      id: 'drift-model',
      name: 'Drift model',
      paramsB: 1,
      family: 'dense',
      day: base.day,
      dataCoverage: 3,
      dataQuality: 78,
      postTrain: 'tools',
      release: 'internal',
      shipped: false,
    })
    const dirtyData = ensureLabData(base)
    dirtyData.stocks.code.raw = 2_000
    const dirty = {
      ...base,
      player: { ...base.player, models: [model], data: dirtyData },
    }
    const beforeReview = tickData({ ...dirty, day: 19 })
    expect(beforeReview.player.models[0]!.capability).toBe(model.capability)

    const drifted = tickData({ ...beforeReview, day: 20 })
    const afterOne = drifted.player.models[0]!
    expect(afterOne.capability).toBeLessThan(model.capability)
    expect(afterOne.corpusDriftTotal).toBeGreaterThan(0)

    const retried = tickData(drifted)
    expect(retried.player.models[0]!.capability).toBe(afterOne.capability)

    const betweenReviews = tickData({ ...drifted, day: 21 })
    expect(betweenReviews.player.models[0]!.capability).toBe(afterOne.capability)

    const nextReview = tickData({ ...betweenReviews, day: 40 })
    expect(nextReview.player.models[0]!.capability).toBeLessThan(afterOne.capability)
  })

  it('keeps a modest early corpus auditable and cleanable without a cash deadlock', () => {
    const initial = createGame({
      seed: 442,
      labName: 'Early Data Lab',
      difficulty: 'easy',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const audit = estimateDataPruneAudit(initial)
    expect(audit.ok).toBe(true)
    expect(audit.cashCost).toBeLessThan(initial.player.cash * 0.01)

    const data = ensureLabData(initial)
    data.autoProcess = false
    data.stocks.code.raw = 12
    let state = purchaseDataPruneAudit({
      ...initial,
      player: { ...initial.player, data },
    })
    state = enqueueDataPrune(state, 'code')
    // Pruning is intentionally staff/compute-gated, but ordinary cleaning is
    // available before the player has staffed a full research operation.
    state = {
      ...state,
      player: {
        ...state.player,
        data: { ...ensureLabData(state), pruneQueue: [] },
      },
    }
    state = enqueueProcess(state, 'code', 12, 68)
    const beforeCash = state.player.cash
    const cleaned = tickData({ ...state, day: state.day + 1 })
    const cleanedData = ensureLabData(cleaned)
    expect(cleaned.player.cash).toBeGreaterThan(0)
    expect(cleaned.player.cash).toBeLessThan(beforeCash)
    expect(cleanedData.stocks.code.raw).toBe(0)
    expect(cleanedData.stocks.code.processed).toBeGreaterThan(0)
  })

  it('makes prune estimates agree with queued job rates and actual cash consumption', () => {
    let state = game()
    const estimate = estimateDataPrune(state, 'code')
    state = enqueueDataPrune(state, 'code')
    const queued = ensureLabData(state).pruneQueue[0]!
    const beforeCash = state.player.cash
    const beforeRemaining = queued.rawRemaining + queued.processedRemaining

    expect(queued.engineersRequired).toBe(estimate.engineersRequired)
    expect(queued.cashPerMTok).toBeCloseTo(
      estimate.cashCost / estimate.totalMTok,
      12,
    )
    expect(queued.pfDaysPerMTok).toBeCloseTo(
      estimate.pfDays / estimate.totalMTok,
      12,
    )

    const next = tickData({ ...state, day: state.day + 1 })
    const after = ensureLabData(next).pruneQueue[0]
    const afterRemaining = after
      ? after.rawRemaining + after.processedRemaining
      : 0
    const removed = beforeRemaining - afterRemaining
    expect(removed).toBeGreaterThan(0)
    expect(beforeCash - next.player.cash).toBeCloseTo(
      removed * queued.cashPerMTok,
      5,
    )
  })

  it('leaves the lab with a measurably cleaner corpus than an untreated path', () => {
    let untreated = game()
    let pruned = game()
    const baselineQuality = untreated.player.dataQuality
    pruned = enqueueDataPrune(pruned, 'code')

    for (let day = 2; day <= 21; day += 1) {
      untreated = tickData({ ...untreated, day })
      pruned = tickData({ ...pruned, day })
    }

    expect(ensureLabData(pruned).pruneQueue).toHaveLength(0)
    expect(pruned.player.dataQuality).toBeGreaterThan(
      untreated.player.dataQuality,
    )
    expect(pruned.player.dataQuality).toBeGreaterThan(baselineQuality)
    expect(ensureLabData(pruned).stocks.code.quality).toBeGreaterThan(
      ensureLabData(untreated).stocks.code.quality,
    )
  })

  it('degrades dirty models on 20-day reviews, stays bounded, and survives save/reload idempotently', () => {
    const base = game()
    const model = buildScaledModel({
      id: 'bounded-drift-model',
      name: 'Bounded drift model',
      paramsB: 1,
      family: 'dense',
      day: base.day,
      dataCoverage: 3,
      dataQuality: 78,
      postTrain: 'tools',
      release: 'released',
      shipped: true,
    })
    const dirtyData = ensureLabData(base)
    dirtyData.autoProcess = false
    dirtyData.processQueue = []
    dirtyData.stocks.code.raw = 50_000
    let state: SimState = {
      ...base,
      player: {
        ...base.player,
        cash: 0,
        data: dirtyData,
        models: [model],
      },
    }
    const initialCapability = model.capability
    for (let day = 2; day <= 60; day += 1) {
      state = tickData({ ...state, day })
    }
    const drifted = state.player.models[0]!
    expect(drifted.capability).toBeLessThan(initialCapability)
    expect(drifted.corpusDriftTotal).toBeGreaterThan(0)
    expect(drifted.corpusDriftTotal).toBeLessThanOrEqual(0.24 + 1e-9)

    const reloaded = parseSave(
      serializeSave(buildSaveFile(state, '1')),
    ).state
    const sameDay = tickData(reloaded)
    expect(sameDay.player.models[0]!.capability).toBe(drifted.capability)

    const nextDay = tickData({ ...reloaded, day: reloaded.day + 1 })
    expect(nextDay.player.models[0]!.capability).toBe(drifted.capability)
    const nextReview = tickData({ ...nextDay, day: 80 })
    expect(nextReview.player.models[0]!.capability).toBeLessThan(
      drifted.capability,
    )
    expect(nextReview.player.models[0]!.corpusDriftTotal).toBeLessThanOrEqual(
      0.24 + 1e-9,
    )
  })

  it('migrates prune jobs without engineer tracking and still applies the legacy one-engineer fallback', () => {
    const queued = enqueueDataPrune(game(), 'code')
    const raw = JSON.parse(
      serializeSave(buildSaveFile(queued, '1')),
    ) as { state: { player: { data: { pruneQueue: Array<Record<string, unknown>> } } } }
    delete raw.state.player.data.pruneQueue[0]!.engineersRequired
    const restored = parseSave(JSON.stringify(raw)).state
    const legacyJob = ensureLabData(restored).pruneQueue[0]!
    expect(legacyJob.engineersRequired).toBeUndefined()

    const next = tickData({ ...restored, day: restored.day + 1 })
    const remaining = ensureLabData(next).pruneQueue[0]
    expect(remaining).toBeDefined()
    expect(
      remaining!.rawRemaining + remaining!.processedRemaining,
    ).toBeLessThan(legacyJob.rawRemaining + legacyJob.processedRemaining)
  })
})
