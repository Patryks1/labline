import { cityTalentCapacity } from '../balance/staff'
import type { SimState, StaffHeadcount } from '../types'
import {
  cityGrowthInterval,
  isCityGrowthDue,
  planCityGrowth,
  stageCityGrowth,
  type CityGrowthPlan,
  type TileId,
} from '../world'
import { planUrbanInfill } from '../world/urbanInfill'
import { commitWorldBatch, usesCompactWorld } from './worldAccess'
import { transportCityGrowthMultiplier } from './transport'

function growAvailable(
  available: StaffHeadcount | undefined,
  previous: StaffHeadcount | undefined,
  next: StaffHeadcount,
): StaffHeadcount | undefined {
  if (!available) return available
  return {
    researcher: Math.min(next.researcher, available.researcher + Math.max(0, next.researcher - (previous?.researcher ?? 0))),
    data_processor: Math.min(next.data_processor, available.data_processor + Math.max(0, next.data_processor - (previous?.data_processor ?? 0))),
    engineer: Math.min(next.engineer, available.engineer + Math.max(0, next.engineer - (previous?.engineer ?? 0))),
    ops: Math.min(next.ops, available.ops + Math.max(0, next.ops - (previous?.ops ?? 0))),
  }
}

/**
 * Resolve cross-city frontier overlap before staging the shared batch. City
 * order and each plan's tile order are already deterministic, so first claim
 * wins deterministically without introducing renderer/visibility state.
 */
export function reserveCityGrowthPlan(
  plan: CityGrowthPlan,
  reserved: Set<TileId>,
): CityGrowthPlan {
  const tiles = plan.tiles.filter((tile) => !reserved.has(tile.tileId))
  for (const tile of tiles) reserved.add(tile.tileId)
  if (tiles.length === plan.tiles.length) return plan
  const populationPerTile =
    plan.tiles.length > 0 ? plan.populationDelta / plan.tiles.length : 0
  return Object.freeze({
    ...plan,
    tiles: Object.freeze(tiles),
    populationDelta: tiles.length * populationPerTile,
  })
}

/**
 * Deterministic, visibility-independent metro growth. All cities share one
 * atomic world mutation so renderer residency can never affect simulation.
 */
export function tickCityGrowth(state: SimState): SimState {
  if (!usesCompactWorld(state)) return state
  const world = state.map.world!
  // V2 retains its weekly offset exactly. V3 checks each settlement monthly,
  // with a deterministic day-of-cycle offset, then applies its tier interval.
  const v3 = Number(world.descriptor.generatorVersion) >= 3
  const cadence = v3 ? 28 : 7
  const due = world.staticWorld.cities.filter((city) => {
    const interval = cityGrowthInterval(world, city.index)
    return state.day % cadence === city.index % cadence &&
      isCityGrowthDue(world, city.index, state.day, interval)
  })
  if (due.length === 0) return state

  const batch = world.beginBatch()
  // Reserved commercial-infill parcels survive growth until a facility takes
  // them (acquired tiles are protected by their facility anyway).
  const reserved = new Set<TileId>(planUrbanInfill(world.staticWorld).reservedTileIds)
  for (const city of due) {
    const plan = planCityGrowth(world, city.index, state.day, {
      maxTiles: 24,
      reserved: v3 ? reserved : undefined,
    })
    const reservedPlan = reserveCityGrowthPlan(plan, reserved)
    stageCityGrowth(world, batch, Object.freeze({
      ...reservedPlan,
      populationDelta:
        reservedPlan.populationDelta * transportCityGrowthMultiplier(state, city.id),
    }))
  }
  const committed = commitWorldBatch(state, batch)
  const cities = (committed.map.cities ?? []).map((city, index) => {
    const runtime = world.cityRuntime.get(index)
    if (!runtime || runtime.population === city.population) return city
    const talentCapacity = cityTalentCapacity(runtime.population, city.industry)
    return {
      ...city,
      population: runtime.population,
      powerBuyMw: Math.max(city.powerBuyMw, 3.5 + city.radius * 1.5 + runtime.population / 220_000),
      talentAvailable: growAvailable(city.talentAvailable, city.talentCapacity, talentCapacity),
      talentCapacity,
    }
  })
  return {
    ...committed,
    map: { ...committed.map, cities },
  }
}

/** Current metro population relative to the immutable generated baseline. */
export function cityPopulationDemandMultiplier(state: SimState): number {
  if (!usesCompactWorld(state)) return 1
  const world = state.map.world!
  let base = 0
  let current = 0
  for (const city of world.staticWorld.cities) {
    base += city.population
    current += world.cityRuntime.get(city.index)?.population ?? city.population
  }
  return base > 0 ? Math.max(1, Math.min(1.5, current / base)) : 1
}
