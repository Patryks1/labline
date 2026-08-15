import type { CityTier } from '../world'
import type { SimState } from '../types'

/**
 * A read-only, derived view of one city's municipal power balance.
 *
 * City power contracts are commitments made by the city (outflow), while
 * power-export contracts are contracted generation supplied into the city.
 * This view is intentionally not part of SimState and is never persisted.
 */
export interface CityStats {
  cityId: string
  cityIndex: number
  cityName: string
  tier: CityTier | undefined
  population: number
  municipalCapacityMw: number
  municipalDemandMw: number
  cityPowerContractMw: number
  cityPowerContractCount: number
  powerExportContractMw: number
  powerExportContractCount: number
  availableSupplyMw: number
  totalObligationMw: number
  reserveMw: number
  /** (available supply - total obligation) / total obligation; zero if obligation is zero. */
  reserveMargin: number
}

interface CityPowerAccumulator {
  municipalCapacityMw: number
  cityPowerContractMw: number
  cityPowerContractCount: number
  powerExportContractMw: number
  powerExportContractCount: number
}

function emptyAccumulator(): CityPowerAccumulator {
  return {
    municipalCapacityMw: 0,
    cityPowerContractMw: 0,
    cityPowerContractCount: 0,
    powerExportContractMw: 0,
    powerExportContractCount: 0,
  }
}

function tierDemandFloor(tier: CityTier | undefined): number {
  if (tier === 'metro') return 220
  if (tier === 'satellite') return 105
  if (tier === 'town') return 52
  return 24
}

/**
 * Derive every city's current power balance in O(cities + plants + contracts).
 * Compact runtime populations are canonical; legacy maps use MapCity.population.
 */
export function deriveCityStats(state: Pick<SimState, 'map' | 'cityPowerContracts' | 'powerExportContracts'>): CityStats[] {
  const world = state.map.storage === 'compact' ? state.map.world : undefined
  const staticCities = world?.staticWorld.cities
  const compatibilityCities = state.map.cities ?? []
  const cities = staticCities ?? compatibilityCities.map((city, index) => ({ ...city, index }))
  const cityIndexById = new Map<string, number>()
  const accumulatorByIndex = new Map<number, CityPowerAccumulator>()

  for (const city of cities) {
    cityIndexById.set(city.id, city.index)
    accumulatorByIndex.set(city.index, emptyAccumulator())
  }

  for (const plant of world?.staticWorld.municipalPowerPlants ?? []) {
    const accumulator = accumulatorByIndex.get(plant.cityIndex)
    if (accumulator) accumulator.municipalCapacityMw += plant.capacityMw
  }

  for (const contract of state.cityPowerContracts ?? []) {
    if (contract.daysLeft <= 0) continue
    const cityIndex = cityIndexById.get(contract.cityId)
    if (cityIndex === undefined) continue
    const accumulator = accumulatorByIndex.get(cityIndex)!
    accumulator.cityPowerContractMw += contract.mw
    accumulator.cityPowerContractCount++
  }

  for (const contract of state.powerExportContracts ?? []) {
    if (contract.daysLeft <= 0) continue
    const cityIndex = cityIndexById.get(contract.cityId)
    if (cityIndex === undefined) continue
    const accumulator = accumulatorByIndex.get(cityIndex)!
    accumulator.powerExportContractMw += contract.mw
    accumulator.powerExportContractCount++
  }

  return cities.map((city) => {
    const accumulator = accumulatorByIndex.get(city.index)!
    const population = world?.cityRuntime.get(city.index)?.population ?? city.population
    // Instantaneous MW demand only: tier floor vs population load. powerBuyMw
    // is the utility's external contract capacity, not demand — never mix it in.
    const municipalDemandMw = Math.max(
      tierDemandFloor(city.tier),
      population / 1_500,
    )
    const availableSupplyMw = accumulator.municipalCapacityMw + accumulator.powerExportContractMw
    const totalObligationMw = municipalDemandMw + accumulator.cityPowerContractMw
    const reserveMw = availableSupplyMw - totalObligationMw
    return {
      cityId: city.id,
      cityIndex: city.index,
      cityName: city.name,
      tier: city.tier,
      population,
      municipalCapacityMw: accumulator.municipalCapacityMw,
      municipalDemandMw,
      cityPowerContractMw: accumulator.cityPowerContractMw,
      cityPowerContractCount: accumulator.cityPowerContractCount,
      powerExportContractMw: accumulator.powerExportContractMw,
      powerExportContractCount: accumulator.powerExportContractCount,
      availableSupplyMw,
      totalObligationMw,
      reserveMw,
      reserveMargin: totalObligationMw === 0 ? 0 : reserveMw / totalObligationMw,
    }
  })
}

/** Derive the canonical stats view and select a city by its stable world index. */
export function cityStatsForIndex(
  state: Pick<SimState, 'map' | 'cityPowerContracts' | 'powerExportContracts'>,
  cityIndex: number,
): CityStats | undefined {
  return deriveCityStats(state).find((stats) => stats.cityIndex === cityIndex)
}
