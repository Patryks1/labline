import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { RivalLab } from '../types'
import {
  acceptComputeOffer,
  minComputeLeasePricePerPfDay,
  playerLeaseNetPf,
  rivalNeedsLeaseRevenue,
  signPlayerComputeSale,
  tickComputeMarket,
} from './computeMarket'
import { updateLab } from './labEngine'

function withSparePlayerCompute(state: ReturnType<typeof createGame>) {
  return {
    ...state,
    player: {
      ...state.player,
      chips: [{ defId: 'gen3', count: 12, arriving: [] }],
      models: [],
      trainingJob: null,
      allocation: { training: 0, inference: 0, research: 0 },
    },
  }
}

describe('rival compute leasing', () => {
  it('only treats rivals with short runway or a thin cash reserve as needing lease revenue', () => {
    const base = createGame(9201).rivals[0]!
    const healthy: RivalLab = {
      ...base,
      cash: 500_000_000,
      finance: {
        ...base.finance!,
        dayNet: 2_000_000,
        dayTotalOut: 1_000_000,
        runwayDays: Number.POSITIVE_INFINITY,
      },
    }
    const stressed: RivalLab = {
      ...healthy,
      cash: 20_000_000,
      finance: {
        ...healthy.finance!,
        dayNet: -1_000_000,
        dayTotalOut: 1_000_000,
        runwayDays: 20,
      },
    }

    expect(rivalNeedsLeaseRevenue(healthy)).toBe(false)
    expect(rivalNeedsLeaseRevenue(stressed)).toBe(true)
  })

  it('creates a periodic incoming offer for a cash-stressed rival with spare compute', () => {
    const created = createGame(9202)
    const target = created.rivals[0]!
    const stressed: RivalLab = {
      ...target,
      cash: 12_000_000,
      flopsPf: 2_000,
      models: [],
      allocation: { training: 0.05, inference: 0.05, research: 0.9 },
      finance: {
        ...target.finance!,
        cash: 12_000_000,
        dayNet: -2_000_000,
        dayTotalOut: 2_000_000,
        runwayDays: 6,
      },
    }
    const base = {
      ...created,
      rivals: [stressed, ...created.rivals.slice(1)],
      labs: {},
      computeLeases: [],
    }

    const contacted = Array.from({ length: 8 }, (_, offset) =>
      tickComputeMarket({ ...base, day: created.day + offset }),
    ).find((state) =>
      state.computeLeases.some(
        (lease) => lease.rivalId === stressed.id && lease.status === 'offer',
      ),
    )

    const offer = contacted?.computeLeases.find((lease) => lease.rivalId === stressed.id)
    expect(offer).toBeDefined()
    expect(offer?.from).toBe('rival')
    expect(offer?.playerSells).toBe(false)
    expect(offer?.note).toContain('raising cash')
  })

  it('retires legacy pending player proposals', () => {
    const state = createGame(9203)
    const rival = state.rivals[0]!
    const next = tickComputeMarket({
      ...state,
      computeLeases: [
        {
          id: 'legacy-player-proposal',
          rivalId: rival.id,
          playerSells: false,
          pf: 10,
          pricePerPfDay: 200,
          daysLeft: 21,
          daysTotal: 21,
          status: 'offer',
          from: 'player',
        },
      ],
    })

    expect(next.computeLeases.some((lease) => lease.id === 'legacy-player-proposal')).toBe(false)
  })

  it('expires stale rival quotes and rejects stale acceptance', () => {
    const state = createGame(92031)
    const rival = state.rivals[0]!
    const offer = {
      id: `offer-1-${rival.id}`,
      rivalId: rival.id,
      playerSells: false,
      pf: 10,
      pricePerPfDay: 200,
      daysLeft: 21,
      daysTotal: 21,
      status: 'offer' as const,
      from: 'rival' as const,
      dayStarted: 1,
    }
    const stale = { ...state, day: 9, computeLeases: [offer] }

    const rejected = acceptComputeOffer(stale, offer.id)
    expect(rejected.computeLeases).toHaveLength(0)
    expect(rejected.alerts[0]?.message).toContain('expired')

    const expired = tickComputeMarket(stale)
    expect(expired.computeLeases).toHaveLength(0)
  })

  it('retires imported rival quotes whose age cannot be established', () => {
    const state = createGame(92032)
    const rival = state.rivals[0]!
    const unknownAgeOffer = {
      id: 'legacy-rival-quote',
      rivalId: rival.id,
      playerSells: false,
      pf: 10,
      pricePerPfDay: 200,
      daysLeft: 21,
      daysTotal: 21,
      status: 'offer' as const,
      from: 'rival' as const,
    }

    const rejected = acceptComputeOffer(
      { ...state, day: 100, computeLeases: [unknownAgeOffer] },
      unknownAgeOffer.id,
    )
    expect(rejected.computeLeases).toHaveLength(0)
    expect(rejected.alerts[0]?.message).toContain('expired')

    const expired = tickComputeMarket({
      ...state,
      day: 100,
      computeLeases: [unknownAgeOffer],
    })
    expect(expired.computeLeases).toHaveLength(0)
  })

  it('signs a negotiated capacity sale and reserves the sold PF immediately', () => {
    const created = withSparePlayerCompute(createGame(9204))
    const rival = created.rivals[0]!
    const funded = updateLab(created, rival.id, (lab) => ({ ...lab, cash: 1_000_000_000 }))
    const price = minComputeLeasePricePerPfDay(funded) * 1.15

    const signed = signPlayerComputeSale(funded, {
      rivalId: rival.id,
      pf: 2,
      pricePerPfDay: price,
      termDays: 90,
      note: 'Negotiated seller test.',
    })

    const lease = signed.computeLeases.find(
      (candidate) => candidate.rivalId === rival.id && candidate.playerSells,
    )
    expect(lease).toMatchObject({
      status: 'active',
      from: 'player',
      pf: 2,
      daysLeft: 90,
    })
    expect(playerLeaseNetPf(signed)).toBe(-2)
  })

  it('settles outbound capacity revenue daily and charges the rival buyer', () => {
    const created = withSparePlayerCompute(createGame(9205))
    const rival = created.rivals[0]!
    const funded = updateLab(created, rival.id, (lab) => ({ ...lab, cash: 1_000_000_000 }))
    const price = minComputeLeasePricePerPfDay(funded) * 1.2
    const signed = signPlayerComputeSale(funded, {
      rivalId: rival.id,
      pf: 2,
      pricePerPfDay: price,
      termDays: 30,
    })
    const buyerCashBefore = signed.rivals.find((candidate) => candidate.id === rival.id)!.cash

    const settled = tickComputeMarket(signed)

    expect(settled.player.computeLeaseIncomeToday).toBeCloseTo(2 * price)
    expect(settled.rivals.find((candidate) => candidate.id === rival.id)!.cash).toBeCloseTo(
      buyerCashBefore - 2 * price,
    )
    expect(
      settled.computeLeases.find(
        (candidate) => candidate.rivalId === rival.id && candidate.playerSells,
      )?.daysLeft,
    ).toBe(29)
  })
})
