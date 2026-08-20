import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { ActiveLoan, FinanceDaySnapshot, SimState } from '../types'
import {
  bailoutOffer,
  interestForDraw,
  isBailoutEligible,
  liquidityRunwayDays,
  takeLoan,
  tickLoans,
  trailingDailyCashBurn,
} from './loans'

function activeLoan(overrides: Partial<ActiveLoan> = {}): ActiveLoan {
  return {
    id: 'loan-test',
    offerId: 'growth',
    label: 'Test loan',
    principal: 10_000_000,
    remaining: 50_000_000,
    dailyPayment: 3_000_000,
    daysLeft: 20,
    termDays: 30,
    takenDay: 1,
    interestTotal: 0.1,
    ...overrides,
  }
}

/** 14 daily closes stepping from (endCash + 13×dailyBurn) down to endCash. */
function burnHistory(
  endCash: number,
  dailyBurn: number,
  endDay: number,
): FinanceDaySnapshot[] {
  return Array.from({ length: 14 }, (_, i) => ({
    day: endDay - 13 + i,
    cash: endCash + (13 - i) * dailyBurn,
    revenue: 0,
    productCogs: 0,
    opex: dailyBurn,
    energy: 0,
    net: -dailyBurn,
    share: 0,
    servedMTok: 0,
    demandMTok: 0,
    effectivePf: 0,
    valuation: 80_000_000,
  }))
}

function flatHistory(cash: number, endDay: number): FinanceDaySnapshot[] {
  return burnHistory(cash, 0, endDay)
}

function withPlayer(
  state: SimState,
  patch: Partial<SimState['player']>,
  financePatch: Partial<SimState['player']['finance']> = {},
  financeHistory?: SimState['financeHistory'],
): SimState {
  return {
    ...state,
    ...(financeHistory ? { financeHistory } : {}),
    player: {
      ...state.player,
      ...patch,
      finance: { ...state.player.finance, ...financePatch },
    },
  }
}

describe('emergency bailout (liquidity-based)', () => {
  it('eligibility requires negative cash, not P&L or short runway', () => {
    const base = createGame(710)
    const badPnl = withPlayer(
      base,
      { cash: 30_000_000 },
      { dayNet: -20_000_000 },
      flatHistory(30_000_000, base.day),
    )
    expect(isBailoutEligible(badPnl)).toBe(false)

    const burning = withPlayer(
      base,
      { cash: 30_000_000 },
      { dayNet: 5_000_000 },
      burnHistory(30_000_000, 2_000_000, base.day),
    )
    expect(liquidityRunwayDays(burning)).toBeLessThan(20)
    expect(isBailoutEligible(burning)).toBe(false)

    const thin = withPlayer(
      base,
      { cash: 5_000_000 },
      {},
      flatHistory(5_000_000, base.day),
    )
    expect(isBailoutEligible(thin)).toBe(false)

    const broke = withPlayer(
      base,
      { cash: -1 },
      { dayNet: 5_000_000, dayRevenue: 1_000_000, valuation: 80_000_000 },
      [],
    )
    expect(isBailoutEligible(broke)).toBe(true)
  })

  it('negative cash is eligible only when the business is recoverable', () => {
    const base = createGame(711)
    const recoverable = withPlayer(
      base,
      { cash: -50_000_000, loans: [] },
      { dayNet: -1_000_000, dayRevenue: 0, valuation: 80_000_000 },
      [],
    )
    expect(isBailoutEligible(recoverable)).toBe(true)

    const doomed = withPlayer(
      base,
      {
        cash: -50_000_000,
        loans: [activeLoan({ remaining: 10_000_000_000 })],
        capital: { ...base.player.capital!, debt: [] },
      },
      { dayNet: -1_000_000, dayRevenue: 0, valuation: 0 },
      [],
    )
    expect(isBailoutEligible(doomed)).toBe(false)
  })

  it('never offers a second bailout while one is open', () => {
    const base = createGame(712)
    const state = withPlayer(
      base,
      {
        cash: -2_000_000,
        loans: [activeLoan({ offerId: 'bailout' })],
      },
      { dayNet: -1_000_000, dayRevenue: 1_000_000, valuation: 80_000_000 },
      burnHistory(-2_000_000, 1_000_000, base.day),
    )
    expect(isBailoutEligible(state)).toBe(false)
    expect(bailoutOffer(state)).toBeNull()
  })

  it('does not offer a bailout while cash is still non-negative', () => {
    const base = createGame(713)
    const state = withPlayer(
      base,
      { cash: 2_000_000 },
      { dayNet: -1_000_000 },
      burnHistory(2_000_000, 1_000_000, base.day),
    )
    expect(bailoutOffer(state)).toBeNull()
  })

  it('restores ~45 days runway when cash is already negative', () => {
    const base = createGame(714)
    const state = withPlayer(
      base,
      {
        cash: -20_000_000,
        loans: [],
      },
      { dayNet: -1_000_000, valuation: 80_000_000 },
      burnHistory(-20_000_000, 1_000_000, base.day),
    )
    const offer = bailoutOffer(state)
    expect(offer).not.toBeNull()
    const next = takeLoan(state, 'bailout')
    const burn = Math.max(1, trailingDailyCashBurn(next))
    const runwayAfter = next.player.cash / burn
    expect(runwayAfter).toBeGreaterThanOrEqual(40)
    expect(runwayAfter).toBeLessThanOrEqual(45)
  })
})

describe('cash independence from P&L', () => {
  it('cash continues below zero unclamped through loan settlement', () => {
    const base = createGame(715)
    const state = withPlayer(base, {
      cash: 1_000_000,
      loans: [
        activeLoan({
          remaining: 50_000_000,
          dailyPayment: 3_000_000,
          daysLeft: 20,
        }),
      ],
    })
    const next = tickLoans(state)
    expect(next.player.cash).toBeCloseTo(-2_000_000, 5)
    expect(next.player.finance.cash).toBeCloseTo(-2_000_000, 5)

    // Day two amortizes the remaining balance over the remaining term —
    // cash still falls deeper below zero, never clamped.
    const secondPayment = 47_000_000 / 19
    const deeper = tickLoans(next)
    expect(deeper.player.cash).toBeCloseTo(-2_000_000 - secondPayment, 5)
    expect(deeper.player.finance.cash).toBeCloseTo(
      -2_000_000 - secondPayment,
      5,
    )
  })

  it('credit becomes expensive for distressed labs', () => {
    const base = createGame(716)
    const calm = withPlayer(base, { cash: 50_000_000 })
    const distressed = withPlayer(base, { cash: -120_000_000 })
    expect(interestForDraw(distressed, 10_000_000, 30)).toBeGreaterThan(
      interestForDraw(calm, 10_000_000, 30),
    )
  })
})
