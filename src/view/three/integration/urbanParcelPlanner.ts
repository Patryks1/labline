import {
  TERRAIN_KIND,
  cityIndexFromFeature,
  type StaticCity,
  type StaticWorld,
  type TileId,
} from '../../../sim/world'

export type UrbanParcelClass = 'small' | 'normal' | 'skyscraper'
export type UrbanParcelStyle = 'suburban' | 'core'

export interface UrbanParcel {
  /** Stable render-only identity. The anchor is always the lowest footprint tile ID. */
  readonly id: string
  readonly anchorTileId: TileId
  readonly footprintTileIds: readonly TileId[]
  readonly width: 1 | 2
  readonly height: 1 | 2
  readonly size: 1 | 2 | 4
  readonly class: UrbanParcelClass
  readonly style: UrbanParcelStyle
  readonly cityIndex: number
  readonly featureId: number
}

export interface UrbanParcelPlan {
  readonly parcels: readonly UrbanParcel[]
  readonly parcelByTile: ReadonlyMap<TileId, UrbanParcel>
  parcelForTile(tileId: number): UrbanParcel | undefined
  footprintForTile(tileId: number): readonly TileId[]
}

export interface UrbanParcelPlanOptions {
  /**
   * Optional complete render traversal. Ordering is deliberately discarded so
   * chunk enumeration cannot affect parcel boundaries. Omit to plan the world.
   */
  readonly tileIds?: Iterable<number>
  /** Live facility occupancy (or another render-only exclusion layer). */
  readonly excludedTileIds?: Iterable<number>
  /** Optional live-layer readers used by render projections over DynamicWorld. */
  readonly kindAt?: (tileId: TileId) => number
  readonly transportAt?: (tileId: TileId) => number
  readonly districtAt?: (tileId: TileId) => number
  readonly featureAt?: (tileId: TileId) => number
}

interface EligibleTile {
  readonly id: number
  readonly featureId: number
  readonly cityIndex: number
  readonly style: UrbanParcelStyle
}

interface Shape {
  readonly width: 1 | 2
  readonly height: 1 | 2
}

const EMPTY_FOOTPRINT: readonly TileId[] = Object.freeze([])
const TOWER_SHAPES: readonly Shape[] = Object.freeze([
  Object.freeze({ width: 2, height: 2 }),
  Object.freeze({ width: 2, height: 1 }),
  Object.freeze({ width: 1, height: 2 }),
])

/**
 * Creates a deterministic, derived parcel index without writing to any world
 * layer. Houses and ordinary urban buildings stay one tile; only compatible
 * core-city cells can be combined into a rectangular skyscraper footprint.
 */
export function planUrbanParcels(
  world: StaticWorld,
  options: UrbanParcelPlanOptions = {},
): UrbanParcelPlan {
  const { width, height, seed } = world.descriptor
  const tileCount = width * height
  const included = collectTileMask(tileCount, options.tileIds)
  const excluded = collectTileMask(tileCount, options.excludedTileIds, false)
  const cities = new Map(world.cities.map((city) => [city.index, city] as const))
  const eligibleById = new Map<number, EligibleTile>()

  for (let id = 0; id < tileCount; id++) {
    if (!included[id] || excluded[id]) continue
    const tileId = id as TileId
    const terrain = options.kindAt?.(tileId) ?? world.kind[id]
    if (terrain !== TERRAIN_KIND.city && terrain !== TERRAIN_KIND.house) continue
    const transport = options.transportAt?.(tileId) ?? world.transport?.[id] ?? 0
    const district = options.districtAt?.(tileId) ?? world.district?.[id] ?? 0
    if (transport !== 0 || district === 2) continue
    const featureId = options.featureAt?.(tileId) ?? world.feature[id] ?? 0
    const cityIndex = cityIndexFromFeature(featureId)
    if (cityIndex === undefined) continue
    const city = cities.get(cityIndex)
    if (!city) continue
    eligibleById.set(id, {
      id,
      featureId,
      cityIndex,
      style: parcelStyle(world, city, id, terrain, district),
    })
  }

  const assigned = new Uint8Array(tileCount)
  const parcels: UrbanParcel[] = []
  const towerCandidates = [...eligibleById.values()]
    .filter((tile) => tile.style === 'core' &&
      (options.kindAt?.(tile.id as TileId) ?? world.kind[tile.id]) === TERRAIN_KIND.city)
    .filter((tile) => isTowerCandidate(cities.get(tile.cityIndex)!, tile.id, seed))
    .sort((a, b) => {
      const priority = mix32(a.id ^ seed) - mix32(b.id ^ seed)
      return priority || a.id - b.id
    })

  for (const candidate of towerCandidates) {
    if (assigned[candidate.id]) continue
    const shapeOffset = mix32(candidate.id ^ seed ^ 0x9e37_79b9) % TOWER_SHAPES.length
    for (let index = 0; index < TOWER_SHAPES.length; index++) {
      const shape = TOWER_SHAPES[(shapeOffset + index) % TOWER_SHAPES.length]!
      const footprint = compatibleFootprint(candidate, shape, width, height, eligibleById, assigned)
      if (!footprint) continue
      parcels.push(createParcel(candidate, footprint, shape, 'skyscraper'))
      for (const id of footprint) assigned[id] = 1
      break
    }
  }

  for (const tile of [...eligibleById.values()].sort((a, b) => a.id - b.id)) {
    if (assigned[tile.id]) continue
    const tileId = tile.id as TileId
    parcels.push(createParcel(
      tile,
      [tileId],
      { width: 1, height: 1 },
      (options.kindAt?.(tile.id as TileId) ?? world.kind[tile.id]) === TERRAIN_KIND.house ||
        tile.style === 'suburban' ? 'small' : 'normal',
    ))
    assigned[tile.id] = 1
  }

  parcels.sort((a, b) => a.anchorTileId - b.anchorTileId)
  const parcelByTile = new Map<TileId, UrbanParcel>()
  for (const parcel of parcels) {
    for (const tileId of parcel.footprintTileIds) parcelByTile.set(tileId, parcel)
  }
  const frozenParcels = Object.freeze(parcels)
  return Object.freeze({
    parcels: frozenParcels,
    parcelByTile,
    parcelForTile: (tileId: number) => parcelByTile.get(tileId as TileId),
    footprintForTile: (tileId: number) => parcelByTile.get(tileId as TileId)?.footprintTileIds ?? EMPTY_FOOTPRINT,
  })
}

function collectTileMask(tileCount: number, values?: Iterable<number>, defaultValue = true): Uint8Array {
  const result = new Uint8Array(tileCount)
  if (!values) {
    if (defaultValue) result.fill(1)
    return result
  }
  for (const id of values) {
    if (!Number.isInteger(id) || id < 0 || id >= tileCount) {
      throw new RangeError(`parcel tile ID ${id} is outside the world`)
    }
    result[id] = 1
  }
  return result
}

function parcelStyle(
  world: StaticWorld,
  city: StaticCity,
  id: number,
  terrain: number,
  district: number,
): UrbanParcelStyle {
  if (terrain === TERRAIN_KIND.house || district === 1) return 'suburban'
  const x = id % world.descriptor.width
  const y = Math.floor(id / world.descriptor.width)
  return Math.hypot(x - city.cx, y - city.cy) <= Math.max(2, city.radius * 0.68)
    ? 'core'
    : 'suburban'
}

function isTowerCandidate(city: StaticCity, id: number, seed: number): boolean {
  const threshold = city.tier === 'metro' ? 78 : city.tier === 'satellite' ? 55 : city.tier === 'town' ? 28 : 10
  return mix32(id ^ seed ^ Math.imul(city.index + 1, 0x45d9_f3b)) % 100 < threshold
}

function compatibleFootprint(
  anchor: EligibleTile,
  shape: Shape,
  worldWidth: number,
  worldHeight: number,
  eligibleById: ReadonlyMap<number, EligibleTile>,
  assigned: Uint8Array,
): TileId[] | undefined {
  const anchorX = anchor.id % worldWidth
  const anchorY = Math.floor(anchor.id / worldWidth)
  if (anchorX + shape.width > worldWidth || anchorY + shape.height > worldHeight) return undefined
  const footprint: TileId[] = []
  for (let oy = 0; oy < shape.height; oy++) {
    for (let ox = 0; ox < shape.width; ox++) {
      const id = (anchorY + oy) * worldWidth + anchorX + ox
      const tile = eligibleById.get(id)
      if (
        assigned[id] || !tile || tile.featureId !== anchor.featureId ||
        tile.style !== 'core' || tile.cityIndex !== anchor.cityIndex
      ) return undefined
      footprint.push(id as TileId)
    }
  }
  return footprint
}

function createParcel(
  tile: EligibleTile,
  footprint: TileId[],
  shape: Shape,
  parcelClass: UrbanParcelClass,
): UrbanParcel {
  footprint.sort((a, b) => a - b)
  const frozenFootprint = Object.freeze(footprint)
  return Object.freeze({
    id: `urban-parcel:${tile.featureId}:${frozenFootprint[0]}`,
    anchorTileId: frozenFootprint[0]!,
    footprintTileIds: frozenFootprint,
    width: shape.width,
    height: shape.height,
    size: frozenFootprint.length as 1 | 2 | 4,
    class: parcelClass,
    style: tile.style,
    cityIndex: tile.cityIndex,
    featureId: tile.featureId,
  })
}

function mix32(input: number): number {
  let value = input >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb_352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846c_a68b)
  value ^= value >>> 16
  return value >>> 0
}
