import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../balance/economy'
import { createGame } from '../createGame'
import { emptyStaff } from '../balance/staff'
import {
  applyForDebt,
  bankingProducts,
  buyBackEquity,
  capitalSnapshot,
} from './capital'
import { bankCreditSnapshot } from './loans'
import { placeBuilding } from './map'
import { ensureCityTalent, hireStaff, playerStaff } from './staff'
import { usesCompactWorld } from './worldAccess'
import { tileCoords } from '../world/ids'
import {
  marketingBudgetCeiling,
  marketingReach,
  setMarketing,
  setMarketingChannel,
  tickOrg,
} from './org'
import { rivalMarketingBudgetTarget, tickRivals } from './rivals'
import { tickVictory } from './victory'

describe('company systems', () => {
  it('hires local candidates immediately without a next-day talent order', () => {
    let state = createGame(9101)
    // HQ-first: seats require a completed HQ (starter grant places one for free).
    if (usesCompactWorld(state) && state.map.world) {
      let placed = false
      for (const pad of state.map.world.staticWorld.starterPads) {
        const { x, y } = tileCoords(pad, state.map.world.descriptor.width)
        const next = placeBuilding(state, x, y, 'hq')
        if (!next.player.starterHqGrant) {
          state = next
          placed = true
          break
        }
      }
      expect(placed).toBe(true)
    } else {
      const empty = state.map.tiles.find((t) => t.kind === 'empty' && t.owner === 'neutral')
      expect(empty).toBeDefined()
      state = placeBuilding(state, empty!.x, empty!.y, 'hq')
    }
    expect(state.player.starterHqGrant).toBe(false)
    const city = ensureCityTalent(state.map.cities![0]!)
    state = {
      ...state,
      map: {
        ...state.map,
        cities: [
          {
            ...city,
            talentAvailable: { ...city.talentAvailable!, researcher: 10 },
          },
          ...state.map.cities!.slice(1),
        ],
      },
      player: {
        ...state.player,
        staff: emptyStaff(),
        talent: 0,
      },
    }
    const beforeCash = state.player.cash
    const beforeOrders = state.worldMarkets.orders.length
    const next = hireStaff(state, city.id, 'researcher', 2)
    expect(playerStaff(next).researcher).toBe(2)
    expect(next.player.cash).toBeLessThan(beforeCash)
    expect(next.worldMarkets.orders).toHaveLength(beforeOrders)
    expect(next.map.cities![0]!.talentAvailable!.researcher).toBe(8)
  })

  it('tracks channel-specific marketing reach and bills the combined budget', () => {
    let state = createGame(9102)
    state = setMarketingChannel(state, 'web', 100_000)
    state = setMarketingChannel(state, 'billboards', 50_000)
    state = setMarketingChannel(state, 'restaurants', 75_000)
    state = setMarketingChannel(state, 'enterprise', 25_000)
    expect(state.player.marketingSpendPerDay).toBe(250_000)
    const reach = marketingReach(state)
    expect(reach.webVisits).toBeGreaterThan(0)
    expect(reach.billboardImpressions).toBeGreaterThan(reach.webVisits)
    expect(reach.restaurantTrials).toBeGreaterThan(0)
    expect(reach.enterpriseLeads).toBeGreaterThan(0)
    expect(tickOrg(state).player.brandTrust).toBeGreaterThan(state.player.brandTrust)
  })

  it('keeps a revenue-relative growth allocation as daily revenue changes', () => {
    const created = createGame(9107)
    let state = {
      ...created,
      player: {
        ...created.player,
        cash: 10_000_000_000,
        finance: {
          ...created.player.finance,
          dayRevenue: 100_000_000,
          valuation: 1_000_000_000_000,
        },
      },
    }
    expect(marketingBudgetCeiling(state)).toBe(500_000_000)
    state = setMarketing(state, 300_000_000)
    expect(state.player.marketingRevenueMultiple).toBe(3)
    const priorWebShare = state.player.marketingChannels!.web / state.player.marketingSpendPerDay

    state = {
      ...state,
      player: {
        ...state.player,
        finance: { ...state.player.finance, dayRevenue: 200_000_000 },
      },
    }
    state = tickOrg(state)
    expect(state.player.marketingSpendPerDay).toBe(600_000_000)
    expect(state.player.marketingRevenueMultiple).toBe(3)
    expect(state.player.marketingChannels!.web / state.player.marketingSpendPerDay).toBeCloseTo(
      priorWebShare,
    )

    state = setMarketing(state, 0)
    expect(state.player.marketingRevenueMultiple).toBe(0)
    expect(tickOrg(state).player.marketingSpendPerDay).toBe(0)
  })

  it('gives rivals a competitive but cash-bounded marketing target', () => {
    const state = createGame(9108)
    const rival = {
      ...state.rivals[0]!,
      cash: 1_000_000_000,
      dayRevenue: 20_000_000,
      finance: { ...state.rivals[0]!.finance!, valuation: 10_000_000_000 },
    }
    const quiet = rivalMarketingBudgetTarget(rival, 0)
    const contested = rivalMarketingBudgetTarget(rival, 8_000_000)
    expect(quiet).toBeGreaterThan(850_000)
    expect(contested).toBeGreaterThanOrEqual(quiet)
    expect(contested).toBeLessThanOrEqual(rival.cash * 0.02)
  })

  it('moves every solvent rival into the competitive marketing loop', () => {
    const created = createGame(9109)
    const state = {
      ...created,
      player: { ...created.player, marketingSpendPerDay: 5_000_000 },
    }
    const next = tickRivals(state)
    const solvent = next.rivals.filter((rival) => rival.cash > 0)
    expect(solvent.length).toBeGreaterThan(0)
    expect(solvent.every((rival) => (rival.marketingSpendPerDay ?? 0) > 0)).toBe(true)
    expect(solvent.every((rival) => {
      const channels = rival.marketingChannels
      if (!channels) return false
      const total = Object.values(channels).reduce((sum, spend) => sum + spend, 0)
      return Math.abs(total - (rival.marketingSpendPerDay ?? 0)) < 1
    })).toBe(true)
  })

  it('repurchases outside equity for cash and restores founder ownership', () => {
    let state = createGame(9103)
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 1_000_000_000,
        finance: { ...state.player.finance, cash: 1_000_000_000, valuation: 100_000_000 },
      },
    }
    const investor = state.player.capital!.capTable.find((stake) => stake.kind === 'investor')!
    const before = capitalSnapshot(state).founderOwnership
    const next = buyBackEquity(state, investor.holderId, 0.01)
    expect(capitalSnapshot(next).founderOwnership).toBeCloseTo(before + 0.01)
    expect(next.player.cash).toBeLessThan(state.player.cash)
    expect(next.player.capital!.capTable.reduce((sum, stake) => sum + stake.ownership, 0)).toBeCloseTo(1)
  })

  it('ends the run when founder ownership falls below five percent', () => {
    let state = createGame(9104)
    const capTable = state.player.capital!.capTable.map((stake) =>
      stake.kind === 'founder'
        ? { ...stake, ownership: 0.049 }
        : stake.kind === 'investor'
          ? { ...stake, ownership: stake.ownership + 0.626 }
          : stake,
    )
    state = {
      ...state,
      player: {
        ...state.player,
        capital: { ...state.player.capital!, capTable },
      },
    }
    const next = tickVictory(state)
    expect(next.victory.outcome).toBe('lost')
    expect(next.victory.reason).toContain('no longer yours')
  })

  it('ends the run when cash falls below the shared bankrupt floor', () => {
    const state = createGame(9104)
    const bankrupt = {
      ...state,
      player: {
        ...state.player,
        cash: ECONOMY.victory.bankruptCash - 1,
        finance: {
          ...state.player.finance,
          cash: ECONOMY.victory.bankruptCash - 1,
        },
      },
    }
    const next = tickVictory(bankrupt)
    expect(ECONOMY.victory.bankruptCash).toBe(-500_000_000)
    expect(next.victory.outcome).toBe('lost')
    expect(next.paused).toBe(true)
  })

  it('scales venture banking capacity and rates with company value', () => {
    const low = createGame(9105)
    const high = {
      ...low,
      player: {
        ...low.player,
        brandTrust: 80,
        finance: {
          ...low.player.finance,
          valuation: 5_000_000_000,
          dayNet: 1_000_000,
        },
      },
    }
    const lowVenture = bankingProducts(low).find((product) => product.kind === 'venture_debt')!
    const highVenture = bankingProducts(high).find((product) => product.kind === 'venture_debt')!
    expect(highVenture.max).toBeGreaterThan(lowVenture.max)
    expect(highVenture.apr).toBeLessThan(lowVenture.apr)
  })

  it('counts typed facilities against the shared bank credit line', () => {
    let state = createGame(9106)
    state = {
      ...state,
      player: {
        ...state.player,
        finance: { ...state.player.finance, valuation: 1_000_000_000 },
      },
    }
    const before = bankCreditSnapshot(state)
    const financed = applyForDebt(state, 'venture_debt', 50_000_000)
    const after = bankCreditSnapshot(financed)
    expect(after.outstanding).toBeGreaterThan(before.outstanding)
    expect(after.available).toBeLessThan(before.available)
  })
})
