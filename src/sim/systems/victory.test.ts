import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../balance/economy'
import { createGame } from '../createGame'
import type { SimState } from '../types'
import { tickLoans } from './loans'
import { cashDistressStage, tickVictory } from './victory'

function withCash(state: SimState, cash: number): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      cash,
      finance: { ...state.player.finance, cash },
    },
  }
}

describe('cash distress ladder', () => {
  it('maps cash to warning stages', () => {
    expect(cashDistressStage(1)).toBe('stable')
    expect(cashDistressStage(0)).toBe('stable')
    expect(cashDistressStage(-1)).toBe('distressed')
    expect(cashDistressStage(-100_000_000)).toBe('distressed')
    expect(cashDistressStage(-100_000_001)).toBe('severe')
    expect(cashDistressStage(-250_000_000)).toBe('severe')
    expect(cashDistressStage(-250_000_001)).toBe('final')
    expect(cashDistressStage(-499_999_999)).toBe('final')
    expect(cashDistressStage(-500_000_000)).toBe('bankrupt')
    expect(cashDistressStage(-900_000_000)).toBe('bankrupt')
  })

  it('keeps playing between $0 and -$500M while surfacing stage alerts', () => {
    const severe = tickVictory(withCash(createGame(720), -150_000_000))
    expect(severe.victory.outcome).toBe('playing')
    expect(
      severe.alerts.some((a) => a.id.startsWith('cash-distress-severe-')),
    ).toBe(true)

    const final = tickVictory(withCash(createGame(721), -300_000_000))
    expect(final.victory.outcome).toBe('playing')
    expect(
      final.alerts.some((a) => a.id.startsWith('cash-distress-final-')),
    ).toBe(true)

    const distressed = tickVictory(withCash(createGame(722), -5_000_000))
    expect(distressed.victory.outcome).toBe('playing')
  })

  it('triggers game over at exactly the -$500M floor after settlement', () => {
    const floor = ECONOMY.victory.bankruptCash
    expect(floor).toBe(-500_000_000)

    const atFloor = tickVictory(withCash(createGame(723), floor))
    expect(atFloor.victory.outcome).toBe('lost')
    expect(atFloor.paused).toBe(true)

    const belowFloor = tickVictory(withCash(createGame(724), floor - 1))
    expect(belowFloor.victory.outcome).toBe('lost')

    const justAbove = tickVictory(withCash(createGame(725), floor + 1))
    expect(justAbove.victory.outcome).toBe('playing')
  })

  it('triggers bankruptcy after daily financing settlement pushes cash to the floor', () => {
    // Debt service settles before the victory check: a lab just above the
    // floor crosses it once the day's loan payment lands.
    const base = withCash(createGame(726), -498_000_000)
    const state: SimState = {
      ...base,
      player: {
        ...base.player,
        loans: [
          {
            id: 'loan-floor',
            offerId: 'growth',
            label: 'Growth facility',
            principal: 40_000_000,
            remaining: 60_000_000,
            dailyPayment: 3_000_000,
            daysLeft: 20,
            termDays: 30,
            takenDay: 1,
            interestTotal: 0.1,
          },
        ],
      },
    }
    const settled = tickLoans(state)
    expect(settled.player.cash).toBeLessThanOrEqual(-500_000_000)
    const next = tickVictory(settled)
    expect(next.victory.outcome).toBe('lost')
    expect(next.paused).toBe(true)
  })
})

describe('capacity-backed market dominance', () => {
  function dominantState(seed: number): SimState {
    const base = createGame(seed)
    return {
      ...base,
      day: 200,
      player: {
        ...base.player,
        finance: {
          ...base.player.finance,
          totalShare: 0.65,
          dayRevenue: 1_000_000,
          dayGrossProfit: 250_000,
        },
      },
      lastMarket: {
        ...base.lastMarket,
        sharesByLab: { ...base.lastMarket.sharesByLab, player: 0.65 },
        unservedRatio: 0.005,
        apiServeFrac: 0.998,
        subServeFrac: 0.998,
        demandPf: 70,
        capacityPf: 100,
      },
    }
  }

  it('tracks qualified days but does not award a one-day share spike', () => {
    const next = tickVictory(dominantState(730))
    expect(next.victory.outcome).toBe('playing')
    expect(next.victory.dominanceQualifiedDays).toBe(1)
  })

  it('resets the streak when demand cannot be served with headroom', () => {
    const base = dominantState(731)
    const overloaded: SimState = {
      ...base,
      victory: {
        ...base.victory,
        dominanceQualifiedDays: 179,
        lastDominanceQualifiedDay: 199,
      },
      lastMarket: {
        ...base.lastMarket,
        unservedRatio: 0.2,
        apiServeFrac: 0.75,
        subServeFrac: 0.85,
        demandPf: 120,
        capacityPf: 100,
      },
    }
    expect(tickVictory(overloaded).victory.dominanceQualifiedDays).toBe(0)
  })

  it('requires the full 180-day fulfilled-share streak for classic victory', () => {
    const base = dominantState(732)
    const classic = {
      ...base,
      config: undefined,
      victory: {
        ...base.victory,
        dominanceQualifiedDays: 179,
        lastDominanceQualifiedDay: 199,
      },
    } as unknown as SimState
    const next = tickVictory(classic)
    expect(next.victory.dominanceQualifiedDays).toBe(180)
    expect(next.victory.outcome).toBe('won')
  })
})
