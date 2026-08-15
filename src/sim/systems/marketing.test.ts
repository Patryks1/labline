import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { MarketingChannels, Model, SimState } from '../types'
import {
  BRAND_GAIN_DAILY_CAP,
  applyDailyMarketing,
  computeMarketingOutcome,
  spendSaturation,
} from './marketing'
import { tickMarket } from './market'
import { tickOrg } from './org'
import { resetDayLedgerCosts } from './financeLedger'

function withMarketing(
  state: SimState,
  perDay: number,
  channels?: Partial<MarketingChannels>,
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      marketingSpendPerDay: perDay,
      // Keep the stored revenue multiple consistent so tickOrg's daily rebase
      // preserves the requested spend (fresh games have a $100k revenue basis).
      marketingRevenueMultiple: Math.min(5, perDay / 100_000),
      marketingChannels: {
        web: perDay,
        billboards: 0,
        restaurants: 0,
        enterprise: 0,
        ...channels,
      },
    },
  }
}

function releasedModel(id: string, capability: number): Model {
  return {
    id,
    name: id,
    family: 'dense',
    paramsB: 10,
    capability,
    release: 'released',
    shipped: true,
  } as Model
}

describe('marketing outcome', () => {
  it('higher spend monotonically increases acquisitions until saturation', () => {
    const spends = [50_000, 100_000, 200_000, 400_000, 800_000, 1_600_000]
    const acquisitions = spends.map(
      (spend) =>
        computeMarketingOutcome(withMarketing(createGame(700), spend))
          .acquiredCustomers,
    )
    for (let i = 1; i < acquisitions.length; i++) {
      expect(acquisitions[i]).toBeGreaterThan(acquisitions[i - 1]!)
    }
    // Diminishing marginal returns: an equal +$100k step buys fewer customers
    // once the channel audience is close to saturation.
    const base = createGame(700)
    const earlyStep =
      computeMarketingOutcome(withMarketing(base, 150_000)).acquiredCustomers -
      computeMarketingOutcome(withMarketing(base, 50_000)).acquiredCustomers
    const lateStep =
      computeMarketingOutcome(withMarketing(base, 1_050_000)).acquiredCustomers -
      computeMarketingOutcome(withMarketing(base, 950_000)).acquiredCustomers
    expect(lateStep).toBeLessThan(earlyStep)
  })

  it('very large spend has visible but bounded effect', () => {
    const base = createGame(701)
    const small = computeMarketingOutcome(withMarketing(base, 100_000))
    const mid = computeMarketingOutcome(withMarketing(base, 1_000_000))
    const huge = computeMarketingOutcome(withMarketing(base, 100_000_000))
    const absurd = computeMarketingOutcome(withMarketing(base, 1e12))
    expect(mid.acquiredCustomers).toBeGreaterThan(small.acquiredCustomers)
    expect(huge.acquiredCustomers).toBeGreaterThan(mid.acquiredCustomers)
    // 100× the spend cannot deliver anywhere near 100× the customers
    expect(huge.acquiredCustomers).toBeLessThan(mid.acquiredCustomers * 4)
    // Audience bound: web caps at capacity / CAC × fit × appeal × brand factor
    expect(absurd.acquiredCustomers).toBeLessThan(120_000)
    expect(Number.isFinite(absurd.acquiredCustomers)).toBe(true)
  })

  it('spend saturation is monotonic and tends to 1 for tiny spend', () => {
    expect(spendSaturation(0, 1_000_000)).toBe(1)
    expect(spendSaturation(1, 1_000_000)).toBeCloseTo(1, 3)
    const values = [0.1, 0.5, 1, 2, 5, 20].map((x) =>
      spendSaturation(x * 1_000_000, 1_000_000),
    )
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]!)
    }
  })

  it('charges marketing spend exactly once, through market settlement', () => {
    let state = withMarketing(createGame(702), 300_000)
    state = resetDayLedgerCosts(state)

    // The marketing system itself never moves cash
    const applied = applyDailyMarketing(state)
    expect(applied.player.cash).toBe(state.player.cash)

    // Market settlement bills it once via dayMarketing
    const cashBefore = state.player.cash
    const settled = tickMarket(state)
    expect(settled.player.finance.dayMarketing).toBeCloseTo(300_000, 5)
    const marketOnlyDelta =
      settled.player.finance.dayRevenue -
      (settled.player.finance.dayEnergyCost +
        settled.player.finance.dayWageCost +
        settled.player.finance.dayMarketing +
        settled.player.finance.dayBuildingOpex +
        (settled.player.computeLeaseCostToday ?? 0))
    expect(settled.player.cash).toBeCloseTo(cashBefore + marketOnlyDelta, 0)
  })

  it('is the single writer of campaign brand gain in the org settlement', () => {
    const state = withMarketing(createGame(703), 500_000)
    const brandBefore = state.player.brandTrust
    const projected = computeMarketingOutcome(state)
    expect(projected.brandGain).toBeGreaterThan(0)

    const next = tickOrg(state)
    const outcome = next.player.marketingOutcome
    expect(outcome).toBeTruthy()
    expect(outcome!.day).toBe(state.day)
    expect(outcome!.brandGain).toBeCloseTo(projected.brandGain, 10)
    // The entire brand delta is exactly the outcome's brand gain — no second writer
    const delta = next.player.brandTrust - brandBefore
    expect(delta).toBeCloseTo(
      Math.min(100 - brandBefore, outcome!.brandGain),
      10,
    )
  })

  it('caps brand gain for normal campaigns and exceptional global campaigns', () => {
    const state = createGame(704)
    const normal = computeMarketingOutcome(withMarketing(state, 100_000))
    expect(normal.brandGain).toBeGreaterThan(0)
    expect(normal.brandGain).toBeLessThan(1)

    const global = computeMarketingOutcome(
      withMarketing(state, 50_000_000, {
        web: 12_500_000,
        billboards: 12_500_000,
        restaurants: 12_500_000,
        enterprise: 12_500_000,
      }),
    )
    expect(global.brandGain).toBe(BRAND_GAIN_DAILY_CAP)
    expect(BRAND_GAIN_DAILY_CAP).toBeGreaterThanOrEqual(2)
    expect(BRAND_GAIN_DAILY_CAP).toBeLessThanOrEqual(3)
  })

  it('service failures offset campaign brand gain', () => {
    const state = withMarketing(createGame(705), 500_000)
    const clean = computeMarketingOutcome(state)
    const pained = computeMarketingOutcome({
      ...state,
      player: { ...state.player, servicePain: 0.5 },
    })
    expect(pained.brandGain).toBeLessThan(clean.brandGain)
    expect(pained.brandGain).toBeCloseTo(clean.brandGain * 0.4, 5)
  })

  it('SOTA models improve campaign conversion', () => {
    const base = withMarketing(createGame(706), 400_000)
    const frontier = {
      ...base,
      player: { ...base.player, models: [releasedModel('flagship', 95)] },
      rivals: base.rivals.map((rival) => ({ ...rival, models: [] })),
    }
    const laggard = {
      ...base,
      player: { ...base.player, models: [] },
      rivals: base.rivals.map((rival, index) =>
        index === 0
          ? { ...rival, models: [releasedModel('rival-frontier', 95)] }
          : { ...rival, models: [] },
      ),
    }
    const sotaOutcome = computeMarketingOutcome(frontier)
    const weakOutcome = computeMarketingOutcome(laggard)
    expect(sotaOutcome.acquiredCustomers).toBeGreaterThan(
      weakOutcome.acquiredCustomers * 1.5,
    )
    // Better conversion lowers effective CAC on the same spend
    expect(sotaOutcome.effectiveCac).toBeLessThan(weakOutcome.effectiveCac)
  })

  it('routes enterprise spend to enterprise leads and billboards to market expansion', () => {
    const state = withMarketing(createGame(707), 1_000_000, {
      web: 0,
      billboards: 500_000,
      restaurants: 0,
      enterprise: 500_000,
    })
    const outcome = computeMarketingOutcome(state)
    const enterprise = outcome.channelBreakdown.enterprise
    expect(enterprise.enterpriseLeads).toBeGreaterThan(
      enterprise.effectiveAcquisitions * 0.8,
    )
    expect(outcome.channelBreakdown.billboards.marketExpansion).toBeGreaterThan(
      outcome.channelBreakdown.enterprise.marketExpansion * 10,
    )
  })
})
