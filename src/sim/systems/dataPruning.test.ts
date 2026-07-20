import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { SimState } from '../types'
import {
  enqueueAllDataPrunes,
  enqueueDataPrune,
  ensureLabData,
  estimateAllDataPrunes,
  estimateDataPrune,
  estimateDataPruneAudit,
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

  it('reserves research compute, charges cash, and permanently discards low-quality stock', () => {
    let state = game()
    const beforeStock = ensureLabData(state).stocks.code
    const beforeProcessed = beforeStock.processed
    const beforeQuality = beforeStock.quality
    const beforeCash = state.player.cash

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
})
