import type { MapTile, SimState, TileKind, TileOwner } from '../types'
import { tileCoords, tileId } from '../world/ids'
import {
  TERRAIN_KIND_NAME,
  TRANSPORT_CLASS_MASK,
  type Facility,
  type FacilityQuery,
  type MunicipalPowerPlant,
  type TileId,
  type WorldOwnerId,
} from '../world/types'
import type { WorldMutationBatch } from '../world/dynamicWorld'
import type { DynamicWorld } from '../world/dynamicWorld'

type FacilityData = {
  name?: string
  note?: string
  dcSize?: MapTile['dcSize']
  hqSize?: MapTile['hqSize']
  constructionExpedited?: boolean
}

type FacilityTileCache = {
  revision: number
  queries: Map<string, MapTile[]>
}

const facilityTileCaches = new WeakMap<DynamicWorld, FacilityTileCache>()

type CompletedFacilityCache = {
  revision: number
  completed: readonly Facility[]
  completedByOwner: ReadonlyMap<WorldOwnerId, readonly Facility[]>
  allByOwner: ReadonlyMap<WorldOwnerId, readonly Facility[]>
  underConstruction: readonly Facility[]
}

const completedFacilityCaches = new WeakMap<DynamicWorld, CompletedFacilityCache>()
const EMPTY_FACILITIES: readonly Facility[] = Object.freeze([])

/**
 * Build the commissioned-facility view once per compact-world revision.
 * Compute, power, campus and market helpers all need this same immutable set;
 * without a shared boundary a single daily tick rescanned 10k facilities more
 * than twenty times.
 */
function completedFacilityCache(
  state: Pick<SimState, 'map'>,
): CompletedFacilityCache | undefined {
  const world = state.map.world
  if (state.map.storage !== 'compact' || !world) return undefined
  const cached = completedFacilityCaches.get(world)
  if (cached?.revision === world.revision) return cached

  const completed: Facility[] = []
  const underConstruction: Facility[] = []
  const mutableCompletedByOwner = new Map<WorldOwnerId, Facility[]>()
  const mutableAllByOwner = new Map<WorldOwnerId, Facility[]>()
  world.forEachFacility({}, (facility) => {
    const allOwned = mutableAllByOwner.get(facility.ownerId)
    if (allOwned) allOwned.push(facility)
    else mutableAllByOwner.set(facility.ownerId, [facility])
    const building =
      facility.constructionTarget > 0 &&
      facility.constructionProgress < facility.constructionTarget
    if (building) {
      underConstruction.push(facility)
      return
    }
    completed.push(facility)
    const owned = mutableCompletedByOwner.get(facility.ownerId)
    if (owned) owned.push(facility)
    else mutableCompletedByOwner.set(facility.ownerId, [facility])
  })
  const completedByOwner = new Map<WorldOwnerId, readonly Facility[]>()
  for (const [ownerId, facilities] of mutableCompletedByOwner) {
    completedByOwner.set(ownerId, Object.freeze(facilities))
  }
  const allByOwner = new Map<WorldOwnerId, readonly Facility[]>()
  for (const [ownerId, facilities] of mutableAllByOwner) {
    allByOwner.set(ownerId, Object.freeze(facilities))
  }
  const next: CompletedFacilityCache = {
    revision: world.revision,
    completed: Object.freeze(completed),
    completedByOwner,
    allByOwner,
    underConstruction: Object.freeze(underConstruction),
  }
  completedFacilityCaches.set(world, next)
  return next
}

/** All completed compact facilities, or undefined for a legacy map. */
export function compactCompletedFacilities(
  state: Pick<SimState, 'map'>,
): readonly Facility[] | undefined {
  return completedFacilityCache(state)?.completed
}

/** Completed compact facilities for one lab, sharing the all-world scan. */
export function compactCompletedFacilitiesForOwner(
  state: Pick<SimState, 'map'>,
  ownerId: WorldOwnerId,
): readonly Facility[] | undefined {
  const cache = completedFacilityCache(state)
  return cache ? (cache.completedByOwner.get(ownerId) ?? EMPTY_FACILITIES) : undefined
}

/** All compact facilities for an owner, including work in progress. */
export function compactFacilitiesForOwner(
  state: Pick<SimState, 'map'>,
  ownerId: WorldOwnerId,
): readonly Facility[] | undefined {
  const cache = completedFacilityCache(state)
  return cache ? (cache.allByOwner.get(ownerId) ?? EMPTY_FACILITIES) : undefined
}

/** Work-in-progress facilities sharing the same revision scan. */
export function compactUnderConstructionFacilities(
  state: Pick<SimState, 'map'>,
): readonly Facility[] | undefined {
  return completedFacilityCache(state)?.underConstruction
}

function facilityQueryKey(query: FacilityQuery): string {
  return [
    query.ownerId ?? '*',
    query.kind ?? '*',
    query.regionIndex ?? '*',
    query.chunkId ?? '*',
    query.underConstruction === undefined ? '*' : query.underConstruction ? '1' : '0',
  ].join('|')
}

function facilityData(facility: Facility): FacilityData {
  return (facility.data ?? {}) as FacilityData
}

export function usesCompactWorld(state: Pick<SimState, 'map'>): boolean {
  return state.map.storage === 'compact' && state.map.world !== undefined
}

function emptyLandValue(state: Pick<SimState, 'config' | 'map'>, x: number, y: number): number {
  const world = state.map.world
  if (world && Number(world.descriptor.generatorVersion) >= 3) {
    let settlementInfluence = 0
    for (const city of world.staticWorld.cities) {
      const distance = Math.hypot(x - city.cx, y - city.cy)
      const reach = Math.max(4, city.radius * 3.5)
      const proximity = Math.max(0, 1 - distance / reach)
      const tierWeight = city.tier === 'village'
        ? 0.38
        : city.tier === 'town'
          ? 0.56
          : city.tier === 'satellite'
            ? 0.78
            : 1
      settlementInfluence = Math.max(settlementInfluence, proximity * proximity * tierWeight)
    }
    const id = tileId(x, y, world.descriptor.width, world.descriptor.height)
    const directTransport = (world.getTransport(id) & TRANSPORT_CLASS_MASK) !== 0
    const adjacentTransport = directTransport || cardinalTransportNeighbor(world, id)
    const transportMultiplier = directTransport ? 1.2 : adjacentTransport ? 1.1 : 1
    const regionIndex = world.staticWorld.region[id]
    const latency = regionIndex === undefined
      ? undefined
      : world.staticWorld.regions[regionIndex]?.latencyToMarket
    // Latency is already a stable generated regional input (lower is better),
    // so it can safely add a modest location premium without inventing traffic.
    const regionalMultiplier = latency === undefined ? 1 : 0.9 + (1 - latency) * 0.2
    return Math.floor(
      (state.config.landValueBase + state.config.landValueCityPeak * settlementInfluence) *
      transportMultiplier * regionalMultiplier,
    )
  }
  let nearest = Number.POSITIVE_INFINITY
  let radius = 1
  for (const city of state.map.cities ?? []) {
    const distance = Math.hypot(x - city.cx, y - city.cy)
    if (distance < nearest) {
      nearest = distance
      radius = Math.max(1, city.radius)
    }
  }
  if (!Number.isFinite(nearest)) return state.config.landValueBase
  const influence = Math.max(0, 1 - nearest / Math.max(4, radius * 3.5))
  return Math.floor(
    state.config.landValueBase + state.config.landValueCityPeak * influence * influence,
  )
}

function cardinalTransportNeighbor(world: DynamicWorld, id: TileId): boolean {
  const width = world.descriptor.width
  const { x, y } = tileCoords(id, width)
  return (y > 0 && (world.getTransport((id - width) as TileId) & TRANSPORT_CLASS_MASK) !== 0) ||
    (x + 1 < width && (world.getTransport((id + 1) as TileId) & TRANSPORT_CLASS_MASK) !== 0) ||
    (y + 1 < world.descriptor.height && (world.getTransport((id + width) as TileId) & TRANSPORT_CLASS_MASK) !== 0) ||
    (x > 0 && (world.getTransport((id - 1) as TileId) & TRANSPORT_CLASS_MASK) !== 0)
}

/** Materialize a single compatibility tile, never a full compact world. */
export function compactTileAt(
  state: Pick<SimState, 'config' | 'map'>,
  x: number,
  y: number,
): MapTile | undefined {
  const world = state.map.world
  if (!world || x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) {
    return undefined
  }
  const id = tileId(x, y, world.descriptor.width, world.descriptor.height)
  const view = world.getTileView(id)
  const facility = view.facility
  const region = world.staticWorld.regions[view.regionIndex]
  const data = facility ? facilityData(facility) : undefined
  const isAnchor = facility?.anchor === id
  // V3 transport is an overlay over the ecological/land-use terrain. The
  // compatibility MapTile must nevertheless expose it as a road so placement
  // and legacy callers cannot buy/build on the right-of-way.
  const terrainKind = !facility && (view.transport & TRANSPORT_CLASS_MASK) !== 0
    ? 'road'
    : (TERRAIN_KIND_NAME[view.kind] ?? 'empty')
  const kind = (facility?.kind ?? terrainKind) as TileKind
  const cityIndex = view.feature > 0 && (view.feature & 0x8000) === 0 ? view.feature - 1 : -1
  const cityId = cityIndex >= 0 ? world.staticWorld.cities[cityIndex]?.id : undefined
  const stats = facility?.stats
  return {
    x,
    y,
    regionId: region?.id ?? 'void',
    kind,
    owner: view.ownerId as TileOwner,
    name: facility
      ? isAnchor
        ? (data?.name ?? facility.kind)
        : `${data?.name ?? facility.kind} pad`
      : terrainKind === 'empty'
        ? ''
        : terrainKind,
    level: facility?.level ?? 1,
    buildingProgress: facility?.constructionProgress ?? (terrainKind === 'empty' ? 0 : 1),
    buildingTarget: facility?.constructionTarget ?? (terrainKind === 'empty' ? 0 : 1),
    constructionExpedited: data?.constructionExpedited,
    rackCapacity: isAnchor ? (stats?.rackCapacity ?? 0) : 0,
    racksUsed: isAnchor ? (stats?.racksUsed ?? 0) : 0,
    mwCapacity: isAnchor ? (stats?.mwCapacity ?? 0) : 0,
    mwGeneration: isAnchor ? (stats?.mwGeneration ?? 0) : 0,
    capex: isAnchor ? (stats?.capex ?? 0) : 0,
    opexPerDay: isAnchor ? (stats?.opexPerDay ?? 0) : 0,
    note: isAnchor ? (data?.note ?? '') : `Footprint pad for ${data?.name ?? facility?.kind ?? ''}`,
    landValue: facility || terrainKind !== 'empty' ? 0 : emptyLandValue(state, x, y),
    cityId,
    powered: facility?.powered,
    forSale: facility?.forSale,
    listPrice: facility?.listPrice,
    campusId: facility?.id,
    campusRole: facility ? (isAnchor ? 'anchor' : 'pad') : undefined,
    dcSize: data?.dcSize,
    hqSize: data?.hqSize,
  }
}

export function mapTileAtAny(
  state: Pick<SimState, 'config' | 'map'>,
  x: number,
  y: number,
): MapTile | undefined {
  if (state.map.storage === 'compact' && state.map.world) return compactTileAt(state, x, y)
  if (x < 0 || y < 0 || x >= state.map.width || y >= state.map.height) return undefined
  const index = y * state.map.width + x
  const direct = state.map.tiles[index]
  if (direct?.x === x && direct.y === y) return direct
  return state.map.tiles.find((tile) => tile.x === x && tile.y === y)
}

/** Generated municipal campuses are world structures, not player facilities. */
export function municipalPowerPlantAt(
  state: Pick<SimState, 'map'>,
  x: number,
  y: number,
): MunicipalPowerPlant | undefined {
  const world = state.map.storage === 'compact' ? state.map.world : undefined
  if (!world || x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) {
    return undefined
  }
  const id = tileId(x, y, world.descriptor.width, world.descriptor.height)
  return world.staticWorld.municipalPowerPlants?.find((plant) => plant.footprint.includes(id))
}

export function facilityAnchorTiles(
  state: SimState,
  query: FacilityQuery = {},
): MapTile[] {
  if (!usesCompactWorld(state)) {
    return state.map.tiles.filter((tile) => {
      if (tile.campusRole === 'pad') return false
      if (query.ownerId !== undefined && tile.owner !== query.ownerId) return false
      if (query.kind !== undefined && tile.kind !== query.kind) return false
      if (
        query.underConstruction !== undefined &&
        (tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget) !==
          query.underConstruction
      ) {
        return false
      }
      return tile.kind !== 'empty' && tile.owner !== 'neutral' || tile.mwCapacity > 0 || tile.mwGeneration > 0
    })
  }
  const world = state.map.world!
  let cache = facilityTileCaches.get(world)
  if (!cache || cache.revision !== world.revision) {
    cache = { revision: world.revision, queries: new Map() }
    facilityTileCaches.set(world, cache)
  }
  const key = facilityQueryKey(query)
  const cached = cache.queries.get(key)
  if (cached) return cached
  const tiles = world
    .queryFacilities(query)
    .map((facility) => {
      const { x, y } = tileCoords(facility.anchor, world.descriptor.width)
      return compactTileAt(state, x, y)
    })
    .filter((tile): tile is MapTile => tile !== undefined)
  cache.queries.set(key, tiles)
  return tiles
}

export function facilityFootprintTiles(state: SimState, facilityId: string): MapTile[] {
  if (!usesCompactWorld(state)) {
    return state.map.tiles.filter((tile) => tile.campusId === facilityId)
  }
  const world = state.map.world!
  const facility = world.facilitiesById.get(facilityId)
  if (!facility) return []
  return facility.footprint
    .map((id) => {
      const { x, y } = tileCoords(id, world.descriptor.width)
      return compactTileAt(state, x, y)
    })
    .filter((tile): tile is MapTile => tile !== undefined)
}

/** Resolve every logical cell represented by a selected building or campus. */
export function selectionFootprintTiles(
  state: SimState,
  x: number,
  y: number,
): MapTile[] {
  const municipal = municipalPowerPlantAt(state, x, y)
  if (municipal && state.map.world) {
    return municipal.footprint
      .map((id) => {
        const point = tileCoords(id, state.map.width)
        return mapTileAtAny(state, point.x, point.y)
      })
      .filter((tile): tile is MapTile => tile !== undefined)
  }
  const selected = mapTileAtAny(state, x, y)
  if (!selected) return []
  if (selected.campusId) {
    const footprint = facilityFootprintTiles(state, selected.campusId)
    if (footprint.length > 0) return footprint
  }
  return [selected]
}

export function compactTileIdAt(state: Pick<SimState, 'map'>, x: number, y: number): TileId | undefined {
  const world = state.map.world
  if (!world || x < 0 || y < 0 || x >= world.descriptor.width || y >= world.descriptor.height) {
    return undefined
  }
  return tileId(x, y, world.descriptor.width, world.descriptor.height)
}

/** Commit a compact mutation and publish a new map identity/revision. */
export function commitWorldBatch(state: SimState, batch: WorldMutationBatch): SimState {
  const result = batch.commit()
  if (!result.committed) return state
  return {
    ...state,
    map: {
      ...state.map,
      worldRevision: result.revision,
    },
  }
}

export function facilityDataPatch(
  facility: Facility,
  patch: FacilityData,
): Readonly<Record<string, unknown>> {
  return { ...(facility.data ?? {}), ...patch }
}
