import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../balance/economy'
import { createGame } from '../createGame'
import { hashSeed } from '../rng'
import { fundRivalForCampus } from './capital'
import { updateLab } from './labEngine'
import { BUILD_DEFS } from './map'
import { PLAN_SEAT_CONVERSION } from './market'
import { quoteCapacityEconomics } from './infrastructureEconomics'
import {
  PROVIDER_RATE_MULTIPLIER,
  quoteComputeContract,
} from './computeContracts'
import { expandRivalCampuses } from './rivals'
import { usesCompactWorld } from './worldAccess'

describe('campus and demand economy', () => {
  it('makes larger halls more expensive per bay and per day', () => {
    const small = BUILD_DEFS.find((def) => def.kind === 'dc')!
    const medium = BUILD_DEFS.find((def) => def.kind === 'dc_m')!
    const large = BUILD_DEFS.find((def) => def.kind === 'dc_l')!
    expect(small.cash / small.rack!).toBeLessThan(medium.cash / medium.rack!)
    expect(medium.cash / medium.rack!).toBeLessThan(large.cash / large.rack!)
    expect(small.opexPerDay / small.rack!).toBeLessThan(
      medium.opexPerDay / medium.rack!,
    )
    expect(medium.opexPerDay / medium.rack!).toBeLessThan(
      large.opexPerDay / large.rack!,
    )
  })

  it('tilts demand toward seats instead of unbounded API tokens', () => {
    expect(PLAN_SEAT_CONVERSION).toBeGreaterThanOrEqual(0.03)
    expect(ECONOMY.defaultApiVsSubPriority).toBeLessThanOrEqual(0.5)
    expect(ECONOMY.apiBaseMTokPerUserDay).toBeLessThan(0.04)
    expect(ECONOMY.facilityOpexMultiplier).toBeGreaterThan(1)
  })

  it('makes a filled owned campus beat escalated cloud by year 2, while idle owned loses', () => {
    const state = { ...createGame(8_820), day: 730 }
    const northstar = state.worldMarkets.cloudProviders.find(
      (provider) => provider.id === 'cloud-northstar',
    )!
    const quote = quoteComputeContract(state, {
      providerId: northstar.id,
      buyerLabId: state.playerLabId,
      kind: 'on_demand',
      pf: 24,
      termDays: 30,
    })
    const cloudPrice = quote.contract.pricePerPfDay
    expect(cloudPrice).toBeGreaterThan(
      northstar.basePricePerPfDay * PROVIDER_RATE_MULTIPLIER,
    )
    const high = quoteCapacityEconomics(state, {
      utilization: 0.75,
      cloudPricePerPfDay: cloudPrice,
    })
    expect(high.route).toBe('owned')
    expect(high.paybackMonths).toBeGreaterThan(0)
    expect(high.paybackMonths).toBeLessThanOrEqual(84)
    expect(high.ownedAnnualOperatingPerPf).toBeLessThan(high.cloudAnnualCostPerPf)
    const idle = quoteCapacityEconomics(state, {
      utilization: 0.28,
      cloudPricePerPfDay: cloudPrice,
    })
    expect(idle.route).toBe('cloud')
  })

  it('lets a cash-poor rival break ground after selling equity or taking a loan', () => {
    let state = createGame(8_813)
    expect(usesCompactWorld(state)).toBe(true)
    const rival = state.rivals[0]!
    const capexOffset = hashSeed(state.seed, rival.id, 'capex-day') % 7
    const firstCapexDay = capexOffset === 0 ? 7 : capexOffset
    state = expandRivalCampuses({ ...state, day: firstCapexDay })
    const afterHq = state.rivals.find((candidate) => candidate.id === rival.id)!
    const hqCount = state.map.world!.queryFacilities({ ownerId: rival.id }).filter(
      (facility) =>
        facility.kind === 'hq' ||
        facility.kind === 'hq_m' ||
        facility.kind === 'hq_l',
    ).length
    expect(hqCount).toBeGreaterThan(0)

    state = updateLab(state, rival.id, (lab) => ({
      ...lab,
      cash: 2_000_000,
      finance: { ...lab.finance, cash: 2_000_000 },
    }))
    const hallCash = BUILD_DEFS.find((def) => def.kind === 'dc')!.cash
    state = fundRivalForCampus(state, rival.id, hallCash)
    state = expandRivalCampuses({ ...state, day: firstCapexDay + 7 })
    const afterHall = state.rivals.find((candidate) => candidate.id === rival.id)!
    const halls = state.map.world!.queryFacilities({ ownerId: rival.id }).filter(
      (facility) =>
        facility.kind === 'dc' ||
        facility.kind === 'dc_m' ||
        facility.kind === 'dc_l',
    )
    expect(halls.length).toBeGreaterThan(0)
    const financed =
      (afterHall.capital?.fundingRounds.length ?? 0) +
      (afterHall.capital?.debt.length ?? 0)
    expect(financed).toBeGreaterThan(0)
    expect(afterHq.cash).toBeGreaterThan(2_000_000)
  })
})
