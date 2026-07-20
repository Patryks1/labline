import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { Model } from '../types'
import { competitiveCatchUpSnapshot, queueRivalMarketOrders } from './sharedMarkets'
import { computeValuation } from './victory'
import { progressRivalTrainingJob, rivalCatchUpScaleTarget } from './rivals'

describe('competitive catch-up response', () => {
  it('lets the selected challenger scale faster without exceeding its data bound', () => {
    const target = rivalCatchUpScaleTarget({
      baselineTargetParamsB: 1.3,
      currentParamsB: 1.1,
      comfortableParamsB: 1,
      capabilityGap: 32,
    })
    expect(target).toBeGreaterThan(2)
    expect(target).toBeLessThanOrEqual(2.5)
  })

  it('selects exactly the strongest challenger when the player is far ahead', () => {
    const state = createGame(91)
    const [first, second] = state.rivals
    if (!first || !second) throw new Error('expected at least two rivals')
    const dominant = {
      ...state,
      lastMarket: {
        ...state.lastMarket,
        sharesByLab: {
          ...state.lastMarket.sharesByLab,
          player: 0.74,
          [first.id]: 0.08,
          [second.id]: 0.18,
        },
      },
      rivals: state.rivals.map((rival) => ({
        ...rival,
        marketShare: rival.id === second.id ? 0.18 : 0.08,
      })),
    }

    const response = competitiveCatchUpSnapshot(dominant)
    expect(response.active).toBe(true)
    expect(response.rivalId).toBe(second.id)
    expect(response.shareGap).toBeCloseTo(0.56)
  })

  it('stays inactive while the market remains contestable', () => {
    const state = createGame(92)
    const response = competitiveCatchUpSnapshot({
      ...state,
      lastMarket: {
        ...state.lastMarket,
        sharesByLab: { ...state.lastMarket.sharesByLab, player: 0.46 },
      },
    })
    expect(response.active).toBe(false)
  })

  it('selects a challenger when the player public frontier is over 150 days old', () => {
    const state = createGame(925)
    const frontier = {
      id: 'player-stale-frontier',
      capability: 78,
      release: 'released',
      shipped: true,
      releaseDay: 1,
    } as Model
    const response = competitiveCatchUpSnapshot({
      ...state,
      day: 170,
      player: { ...state.player, models: [frontier] },
    })
    expect(response.frontierStaleAfterDays).toBeGreaterThanOrEqual(100)
    expect(response.frontierStaleAfterDays).toBeLessThanOrEqual(150)
    expect(response.frontierStale).toBe(true)
    expect(response.active).toBe(true)
    expect(response.rivalId).not.toBeNull()
  })

  it('never mints catch-up training progress beyond available physical work', () => {
    const job = {
      id: 'challenger-train',
      progressPfDays: 20,
      targetPfDays: 100,
    } as ReturnType<typeof createGame>['rivals'][number]['trainingJob']
    if (!job) throw new Error('expected job fixture')
    const advanced = progressRivalTrainingJob(job, 3.25)
    expect(advanced.workAppliedPfDays).toBe(3.25)
    expect(advanced.job.progressPfDays).toBe(23.25)
    expect(advanced.job.progressPfDays - job.progressPfDays).toBeLessThanOrEqual(3.25)
  })

  it('finances and queues accelerator demand for the selected challenger', () => {
    const state = createGame(94)
    const shares = Object.fromEntries(state.rivals.map((rival) => [rival.id, 0.04]))
    const dominant = {
      ...state,
      lastMarket: {
        ...state.lastMarket,
        sharesByLab: { ...shares, player: 0.8 },
      },
      player: {
        ...state.player,
        finance: { ...state.player.finance, totalShare: 0.8 },
      },
    }
    const response = competitiveCatchUpSnapshot(dominant)
    if (!response.rivalId) throw new Error('expected a selected challenger')
    const targetIndex = dominant.rivals.findIndex((rival) => rival.id === response.rivalId)
    const scheduled = { ...dominant, day: 70 + targetIndex }
    const before = scheduled.rivals[targetIndex]?.capital?.debt.length ?? 0

    const next = queueRivalMarketOrders(scheduled)
    const challenger = next.rivals.find((rival) => rival.id === response.rivalId)
    expect(challenger?.capital?.debt.length ?? 0).toBeGreaterThan(before)
    expect(
      next.worldMarkets.orders.some(
        (order) => order.labId === response.rivalId && order.kind === 'accelerator',
      ),
    ).toBe(true)
  })

  it('reprices valuation gradually when the capacity ceiling flips one day negative', () => {
    const state = createGame(93)
    const priorValue = 10_000_000_000
    const marked = computeValuation({
      ...state,
      player: {
        ...state.player,
        finance: {
          ...state.player.finance,
          valuation: priorValue,
          dayNet: -50_000_000,
          dayRevenue: 1_000_000,
        },
      },
    })
    expect(marked).toBeGreaterThanOrEqual(priorValue * 0.92)
  })
})
