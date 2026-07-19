import { cardinalNeighborIds, tileCoords } from './ids'
import { DynamicWorld, type WorldMutationBatch } from './dynamicWorld'
import { encodeCityFeature } from './generator'
import {
  TERRAIN_KIND,
  type TerrainKind,
  type TileId,
  type WorldBatchCommit,
} from './types'

export interface CityGrowthOptions {
  readonly maxTiles?: number
  readonly populationPerTile?: number
}

export interface CityGrowthTile {
  readonly tileId: TileId
  readonly kind: TerrainKind
}

export interface CityGrowthPlan {
  readonly cityIndex: number
  readonly day: number
  readonly growthEvent: number
  readonly tiles: readonly CityGrowthTile[]
  readonly populationDelta: number
}

function hash(value: number): number {
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  return (value ^ (value >>> 16)) >>> 0
}

function canGrowInto(world: DynamicWorld, id: TileId): boolean {
  if (world.getFacilityAt(id) || world.getOwner(id) !== 'neutral') return false
  const kind = world.getKind(id)
  return kind === TERRAIN_KIND.empty || kind === TERRAIN_KIND.forest
}

/** Returns only neutral, unoccupied frontier cells adjacent to the current city feature. */
export function collectCityFrontier(world: DynamicWorld, cityIndex: number): TileId[] {
  const city = world.staticWorld.cities[cityIndex]
  const runtime = world.cityRuntime.get(cityIndex)
  if (!city || !runtime) throw new RangeError(`unknown city index ${cityIndex}`)
  const feature = encodeCityFeature(cityIndex)
  const expansion = Math.ceil(Math.sqrt(runtime.growthEvents * 24 + 1)) + 3
  const radius = city.radius + expansion
  const minX = Math.max(0, city.cx - radius)
  const maxX = Math.min(world.descriptor.width - 1, city.cx + radius)
  const minY = Math.max(0, city.cy - radius)
  const maxY = Math.min(world.descriptor.height - 1, city.cy + radius)
  const frontier = new Set<TileId>()
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const id = (y * world.descriptor.width + x) as TileId
      if (world.getFeature(id) !== feature) continue
      for (const neighbor of cardinalNeighborIds(id, world.descriptor)) {
        if (canGrowInto(world, neighbor)) frontier.add(neighbor)
      }
    }
  }
  return [...frontier]
}

function growthKind(seed: number, ordinal: number): TerrainKind {
  const roll = hash(seed + ordinal * 0x9e3779b9) % 100
  if (ordinal % 6 === 0) return TERRAIN_KIND.road
  if (roll < 48) return TERRAIN_KIND.house
  if (roll < 76) return TERRAIN_KIND.city
  if (roll < 90) return TERRAIN_KIND.park
  return TERRAIN_KIND.warehouse
}

/** Deterministic plan; visibility and renderer residency never enter the calculation. */
export function planCityGrowth(
  world: DynamicWorld,
  cityIndex: number,
  day: number,
  options: CityGrowthOptions = {},
): CityGrowthPlan {
  const runtime = world.cityRuntime.get(cityIndex)
  if (!runtime) throw new RangeError(`unknown city index ${cityIndex}`)
  const maxTiles = options.maxTiles ?? 24
  if (!Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 24) {
    throw new RangeError('city growth may change between 1 and 24 tiles per event')
  }
  if (!Number.isSafeInteger(day) || day < 0) throw new RangeError('growth day must be non-negative')
  const event = runtime.growthEvents + 1
  const seed = world.descriptor.seed ^ Math.imul(cityIndex + 1, 0x45d9f3b) ^ Math.imul(event, 0x27d4eb2d)
  const frontier = collectCityFrontier(world, cityIndex)
  frontier.sort((a, b) => {
    const score = hash(seed ^ a) - hash(seed ^ b)
    return score || a - b
  })
  const selected = frontier.slice(0, maxTiles)
  const tiles = selected.map((id, index) => Object.freeze({ tileId: id, kind: growthKind(seed, index) }))
  return Object.freeze({
    cityIndex,
    day,
    growthEvent: event,
    tiles: Object.freeze(tiles),
    populationDelta: tiles.length * (options.populationPerTile ?? 1_350),
  })
}

export function stageCityGrowth(
  world: DynamicWorld,
  batch: WorldMutationBatch,
  plan: CityGrowthPlan,
): void {
  const runtime = world.cityRuntime.get(plan.cityIndex)
  if (!runtime) throw new RangeError(`unknown city index ${plan.cityIndex}`)
  if (plan.growthEvent !== runtime.growthEvents + 1) throw new Error('city growth plan is stale')
  if (plan.tiles.length > 24) throw new Error('city growth plan exceeds the 24-tile event limit')
  const feature = encodeCityFeature(plan.cityIndex)
  const seen = new Set<TileId>()
  for (const tile of plan.tiles) {
    if (seen.has(tile.tileId)) throw new Error('city growth plan contains duplicate tiles')
    seen.add(tile.tileId)
    if (!canGrowInto(world, tile.tileId)) {
      const { x, y } = tileCoords(tile.tileId, world.descriptor.width)
      throw new Error(`city growth cannot overwrite protected tile (${x}, ${y})`)
    }
    batch.setTerrain({ tileId: tile.tileId, kind: tile.kind, feature })
  }
  batch.updateCity(plan.cityIndex, {
    population: runtime.population + plan.populationDelta,
    growthEvents: plan.growthEvent,
    lastGrowthDay: plan.day,
  })
}

export function applyCityGrowth(world: DynamicWorld, plan: CityGrowthPlan): WorldBatchCommit {
  const batch = world.beginBatch()
  stageCityGrowth(world, batch, plan)
  return batch.commit()
}

export function isCityGrowthDue(world: DynamicWorld, cityIndex: number, day: number, interval = 7): boolean {
  const runtime = world.cityRuntime.get(cityIndex)
  if (!runtime) throw new RangeError(`unknown city index ${cityIndex}`)
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('growth interval must be positive')
  return day >= runtime.lastGrowthDay + interval
}

