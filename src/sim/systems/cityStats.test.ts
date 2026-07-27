import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { CityPowerContract, PowerExportContract } from '../types'
import { cityStatsForIndex, deriveCityStats } from './cityStats'

function compactState(seed = 91_001) {
  return createGame({
    seed,
    difficulty: 'normal',
    advanced: { mapWidth: 128, mapHeight: 128, cityCount: 4, rivalCount: 1 },
  })
}

describe('derived city stats', () => {
  it('uses compact city runtime population as the canonical value', () => {
    const state = compactState()
    const city = state.map.world!.staticWorld.cities[0]!
    const runtime = state.map.world!.cityRuntime.get(city.index)!
    const population = runtime.population + 150_000
    state.map.world!.beginBatch().updateCity(city.index, { ...runtime, population }).commit()

    expect(state.map.cities![0]!.population).not.toBe(population)
    const stats = deriveCityStats(state)[0]!
    expect(stats.population).toBe(population)
    expect(stats.municipalDemandMw).toBe(Math.max(
      city.tier === 'metro' ? 220 : city.tier === 'satellite' ? 105 : city.tier === 'town' ? 52 : 24,
      population / 1_500,
      city.powerBuyMw * 24,
    ))
    expect(cityStatsForIndex(state, city.index)).toEqual(stats)
  })

  it('falls back to MapCity population for legacy maps', () => {
    const state = createGame({
      seed: 91_002,
      difficulty: 'normal',
      legacyMapFixture: true,
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    state.map.cities![0]!.population = 321_000
    expect(deriveCityStats(state)[0]).toMatchObject({ cityIndex: 0, population: 321_000 })
  })

  it('aggregates active contracts in their city-grid directions', () => {
    const state = compactState(91_003)
    const city = state.map.world!.staticWorld.cities[0]!
    const imports: CityPowerContract[] = [
      { id: 'commit-a', cityId: city.id, cityName: city.name, mw: 7, pricePerMWh: 1, daysLeft: 2, daysTotal: 2 },
      { id: 'expired', cityId: city.id, cityName: city.name, mw: 100, pricePerMWh: 1, daysLeft: 0, daysTotal: 2 },
      { id: 'commit-b', cityId: city.id, cityName: city.name, mw: 5, pricePerMWh: 1, daysLeft: 1, daysTotal: 2 },
    ]
    const exports: PowerExportContract[] = [
      { id: 'supply', cityId: city.id, cityName: city.name, mw: 19, pricePerMWh: 1, daysLeft: 3, daysTotal: 3, signedDay: 1 },
    ]
    state.cityPowerContracts = imports
    state.powerExportContracts = exports

    const stats = deriveCityStats(state)[0]!
    expect(stats).toMatchObject({
      cityPowerContractMw: 12,
      cityPowerContractCount: 2,
      powerExportContractMw: 19,
      powerExportContractCount: 1,
      availableSupplyMw: stats.municipalCapacityMw + 19,
      totalObligationMw: stats.municipalDemandMw + 12,
    })
    expect(stats.reserveMw).toBe(stats.availableSupplyMw - stats.totalObligationMw)
    expect(stats.reserveMargin).toBe(stats.reserveMw / stats.totalObligationMw)
  })

  it('returns stable city-indexed aggregation regardless of contract ordering', () => {
    const state = compactState(91_004)
    const cities = state.map.world!.staticWorld.cities
    state.cityPowerContracts = cities.flatMap((city, index) => [
      { id: `a-${index}`, cityId: city.id, cityName: city.name, mw: index + 1, pricePerMWh: 1, daysLeft: 2, daysTotal: 2 },
      { id: `b-${index}`, cityId: city.id, cityName: city.name, mw: index + 3, pricePerMWh: 1, daysLeft: 2, daysTotal: 2 },
    ])
    state.powerExportContracts = cities.map((city, index) => ({
      id: `e-${index}`, cityId: city.id, cityName: city.name, mw: index + 8,
      pricePerMWh: 1, daysLeft: 2, daysTotal: 2, signedDay: 1,
    }))
    const forward = deriveCityStats(state)
    const reversed = deriveCityStats({
      ...state,
      cityPowerContracts: [...state.cityPowerContracts].reverse(),
      powerExportContracts: [...state.powerExportContracts].reverse(),
    })

    expect(reversed).toEqual(forward)
    expect(forward.map((stats) => stats.cityIndex)).toEqual(cities.map((city) => city.index))
  })
})
