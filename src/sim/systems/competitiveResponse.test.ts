import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { Model, SimState } from '../types'
import {
  advanceCatchUpCampaign,
  competitiveCatchUpSnapshot,
  queueRivalMarketOrders,
} from './sharedMarkets'
import { computeValuation } from './victory'
import { progressRivalTrainingJob, rivalCatchUpScaleTarget } from './rivals'

function dominantPlayer(state: SimState, playerShare = 0.74): SimState {
  const ranked = [...state.rivals].toSorted(
    (a, b) => (b.marketShare ?? 0) - (a.marketShare ?? 0),
  )
  const second = ranked[0] ?? state.rivals[1] ?? state.rivals[0]
  const shares: Record<string, number> = { player: playerShare }
  for (const rival of state.rivals) {
    shares[rival.id] = rival.id === second?.id ? 0.18 : 0.08
  }
  return {
    ...state,
    lastMarket: {
      ...state.lastMarket,
      sharesByLab: { ...state.lastMarket.sharesByLab, ...shares },
    },
    player: {
      ...state.player,
      finance: { ...state.player.finance, totalShare: playerShare },
    },
    rivals: state.rivals.map((rival) => ({
      ...rival,
      marketShare: rival.id === second?.id ? 0.18 : 0.08,
    })),
  }
}

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

  it('nominates the strongest challenger without same-day auto-activation', () => {
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
    expect(response.active).toBe(false)
    expect(response.eligible).toBe(true)
    expect(response.pressure).toBeGreaterThan(0.2)
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
    expect(response.eligible).toBe(false)
  })

  it('raises stale-flagship pressure without a guaranteed same-day arm', () => {
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
    expect(response.eligible).toBe(true)
    expect(response.active).toBe(false)
    expect(response.rivalId).not.toBeNull()
  })

  it('does not arm catch-up on the same day for every seed', () => {
    let armed = 0
    for (let seed = 1; seed <= 48; seed++) {
      const next = advanceCatchUpCampaign(dominantPlayer(createGame(seed)))
      if (next.catchUpCampaign) armed += 1
    }
    expect(armed).toBeLessThan(48)
    const once = dominantPlayer(createGame(91))
    expect(advanceCatchUpCampaign(once).catchUpCampaign).toEqual(
      advanceCatchUpCampaign(once).catchUpCampaign,
    )
  })

  it('eventually arms a challenger while domination holds', () => {
    let state = dominantPlayer(createGame(91))
    let armedDay: number | null = null
    for (let day = 1; day <= 160; day++) {
      state = advanceCatchUpCampaign({ ...state, day })
      if (state.catchUpCampaign) {
        armedDay = day
        break
      }
    }
    expect(armedDay).not.toBeNull()
    expect(competitiveCatchUpSnapshot(state).active).toBe(true)
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
    const preview = competitiveCatchUpSnapshot(dominant)
    if (!preview.rivalId) throw new Error('expected a selected challenger')
    const armed = {
      ...dominant,
      catchUpCampaign: { rivalId: preview.rivalId, armedDay: 1 },
    }
    const response = competitiveCatchUpSnapshot(armed)
    if (!response.rivalId) throw new Error('expected a selected challenger')
    const targetIndex = armed.rivals.findIndex((rival) => rival.id === response.rivalId)
    const scheduled = { ...armed, day: 70 + targetIndex }
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
