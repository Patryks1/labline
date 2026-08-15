import { cardinalNeighborIds, tileCoords } from './ids'
import { DynamicWorld, type WorldMutationBatch } from './dynamicWorld'
import { encodeCityFeature } from './generator'
import {
  BIOME_KIND,
  TERRAIN_KIND,
  TERRAIN_VARIANT_RIVER,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_DIRECTION,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  type TerrainKind,
  type TileId,
  type WorldBatchCommit,
} from './types'

export interface CityGrowthOptions {
  readonly maxTiles?: number
  readonly populationPerTile?: number
  /** V3 scheduler reservation set; ignored by the exact v2 planner. */
  readonly reserved?: ReadonlySet<TileId>
}

export interface CityGrowthTile {
  readonly tileId: TileId
  readonly kind: TerrainKind
  /** V3 projects distinguish redevelopment from newly claimed frontier. */
  readonly mode?: 'parcel' | 'infill' | 'transport' | 'bridge'
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

type SettlementTier = 'metro' | 'satellite' | 'town' | 'village'

type V3City = {
  readonly tier?: SettlementTier
  readonly growth?: { readonly rate?: number }
}

function isV3(world: DynamicWorld): boolean {
  return Number(world.descriptor.generatorVersion) >= 3
}

function isV4(world: DynamicWorld): boolean {
  return Number(world.descriptor.generatorVersion) >= 4
}

function isV5(world: DynamicWorld): boolean {
  return Number(world.descriptor.generatorVersion) >= 5
}

function isV7(world: DynamicWorld): boolean {
  return Number(world.descriptor.generatorVersion) >= 7
}

const MAX_LOCAL_ROAD_GRADE = 0.18

function v4TileGradeAllowed(world: DynamicWorld, id: TileId): boolean {
  if (!isV4(world)) return true
  const { x, y } = tileCoords(id, world.descriptor.width)
  return world.getTileSlope(x, y) <= MAX_LOCAL_ROAD_GRADE
}

function v4DenseGrowthAllowed(world: DynamicWorld, id: TileId): boolean {
  if (!isV4(world)) return true
  const { x, y } = tileCoords(id, world.descriptor.width)
  const biome = world.getBiome(x, y)
  return biome !== BIOME_KIND.alpine && biome !== BIOME_KIND.wetland
}

function isDenseGrowthKind(kind: TerrainKind): boolean {
  return kind === TERRAIN_KIND.city || kind === TERRAIN_KIND.warehouse
}

function v4TransportEdgeAllowed(world: DynamicWorld, from: TileId, to: TileId): boolean {
  if (!isV4(world)) return true
  const a = tileCoords(from, world.descriptor.width)
  const b = tileCoords(to, world.descriptor.width)
  return Math.abs(world.getTileElevation(a.x, a.y) - world.getTileElevation(b.x, b.y)) <= MAX_LOCAL_ROAD_GRADE
}

function settlementTier(world: DynamicWorld, cityIndex: number): SettlementTier {
  return ((world.staticWorld.cities[cityIndex] as V3City | undefined)?.tier ?? 'metro')
}

function hasTransport(world: DynamicWorld, id: TileId): boolean {
  return (world.getTransport(id) & TRANSPORT_CLASS_MASK) !== 0
}

function isGrowthRoadApproach(world: DynamicWorld, id: TileId): boolean {
  if (world.getKind(id) === TERRAIN_KIND.lake) return false
  const transport = world.getTransport(id)
  if ((transport & TRANSPORT_FLAGS.settlement) === 0) return false
  const roadClass = (transport & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
  return roadClass === TRANSPORT_ROAD_CLASS.local || roadClass === TRANSPORT_ROAD_CLASS.collector
}

function isRiverWater(world: DynamicWorld, id: TileId): boolean {
  return world.getKind(id) === TERRAIN_KIND.lake &&
    (world.getVariantMask(id) & TERRAIN_VARIANT_RIVER) !== 0
}

function isProtected(world: DynamicWorld, id: TileId): boolean {
  return world.getFacilityAt(id) !== undefined || world.getOwner(id) !== 'neutral'
}

function isSettlementKind(kind: TerrainKind): boolean {
  return kind === TERRAIN_KIND.city || kind === TERRAIN_KIND.house ||
    kind === TERRAIN_KIND.warehouse || kind === TERRAIN_KIND.park
}

function densityUpgrade(kind: TerrainKind): TerrainKind | undefined {
  if (kind === TERRAIN_KIND.house || kind === TERRAIN_KIND.warehouse) return TERRAIN_KIND.city
  if (kind === TERRAIN_KIND.park) return TERRAIN_KIND.house
  return undefined
}

const stagedTransport = new WeakMap<WorldMutationBatch, Map<TileId, number>>()

function transportInBatch(world: DynamicWorld, batch: WorldMutationBatch, id: TileId): number {
  return stagedTransport.get(batch)?.get(id) ?? world.getTransport(id)
}

function patchTransport(batch: WorldMutationBatch, id: TileId, transport: number): void {
  let writes = stagedTransport.get(batch)
  if (!writes) {
    writes = new Map()
    stagedTransport.set(batch, writes)
  }
  writes.set(id, transport)
  batch.patchTerrain(id, { transport })
}

function cardinalTransportBits(
  from: TileId,
  to: TileId,
  width: number,
): { readonly outgoing: number; readonly reciprocal: number } {
  const delta = to - from
  if (delta === -width) return { outgoing: TRANSPORT_DIRECTION.north, reciprocal: TRANSPORT_DIRECTION.south }
  if (delta === 1) return { outgoing: TRANSPORT_DIRECTION.east, reciprocal: TRANSPORT_DIRECTION.west }
  if (delta === width) return { outgoing: TRANSPORT_DIRECTION.south, reciprocal: TRANSPORT_DIRECTION.north }
  if (delta === -1) return { outgoing: TRANSPORT_DIRECTION.west, reciprocal: TRANSPORT_DIRECTION.east }
  throw new Error('transport topology requires cardinal neighbors')
}

function stageLocalTransport(
  world: DynamicWorld,
  batch: WorldMutationBatch,
  id: TileId,
  flags = TRANSPORT_FLAGS.settlement,
): void {
  let transport =
    (TRANSPORT_ROAD_CLASS.local << TRANSPORT_CLASS_SHIFT) |
    flags
  for (const neighbor of cardinalNeighborIds(id, world.descriptor)) {
    const neighborTransport = transportInBatch(world, batch, neighbor)
    if ((neighborTransport & TRANSPORT_CLASS_MASK) === 0) continue
    if (!v4TransportEdgeAllowed(world, id, neighbor)) continue
    const bits = cardinalTransportBits(id, neighbor, world.descriptor.width)
    transport |= bits.outgoing
    patchTransport(batch, neighbor, neighborTransport | bits.reciprocal)
  }
  patchTransport(batch, id, transport)
}

interface GrowthBridgeCandidate {
  readonly water: readonly TileId[]
  readonly landing: TileId
}

const CARDINAL_STEPS = Object.freeze([
  Object.freeze({ dx: 0, dy: -1 }),
  Object.freeze({ dx: 1, dy: 0 }),
  Object.freeze({ dx: 0, dy: 1 }),
  Object.freeze({ dx: -1, dy: 0 }),
])

function steppedTile(
  world: DynamicWorld,
  id: TileId,
  dx: number,
  dy: number,
): TileId | undefined {
  const { x, y } = tileCoords(id, world.descriptor.width)
  const nextX = x + dx
  const nextY = y + dy
  if (nextX < 0 || nextY < 0 || nextX >= world.descriptor.width || nextY >= world.descriptor.height) {
    return undefined
  }
  return (nextY * world.descriptor.width + nextX) as TileId
}

function riverChannelApproximatelyPerpendicular(
  world: DynamicWorld,
  water: readonly TileId[],
  crossingDx: number,
): boolean {
  let parallel = 0
  let perpendicular = 0
  for (const id of water) {
    for (const step of CARDINAL_STEPS) {
      const neighbor = steppedTile(world, id, step.dx, step.dy)
      if (neighbor === undefined || !isRiverWater(world, neighbor)) continue
      if ((step.dx === 0) === (crossingDx === 0)) parallel++
      else perpendicular++
    }
  }
  return perpendicular > parallel
}

function hasAdjacentExistingBridge(world: DynamicWorld, water: readonly TileId[]): boolean {
  const span = new Set(water)
  return water.some((id) => cardinalNeighborIds(id, world.descriptor).some((neighbor) =>
    !span.has(neighbor) && (world.getTransport(neighbor) & TRANSPORT_FLAGS.bridge) !== 0,
  ))
}

function collectGrowthBridgeCandidates(
  world: DynamicWorld,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  reserved: ReadonlySet<TileId>,
): GrowthBridgeCandidate[] {
  if (!isV7(world)) return []
  const candidates = new Map<string, GrowthBridgeCandidate>()
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const approach = (y * world.descriptor.width + x) as TileId
      if (!isGrowthRoadApproach(world, approach)) continue
      for (const { dx, dy } of CARDINAL_STEPS) {
        const first = steppedTile(world, approach, dx, dy)
        if (first === undefined || !isRiverWater(world, first)) continue
        const water: TileId[] = [first]
        let landing = steppedTile(world, first, dx, dy)
        if (landing !== undefined && isRiverWater(world, landing)) {
          water.push(landing)
          landing = steppedTile(world, landing, dx, dy)
        }
        if (water.some((id) => reserved.has(id) || isProtected(world, id) || hasTransport(world, id))) continue
        if (landing === undefined || isRiverWater(world, landing) ||
            reserved.has(landing) || !canGrowInto(world, landing) || hasTransport(world, landing) ||
            !v4TileGradeAllowed(world, landing)) continue
        if (cardinalNeighborIds(landing, world.descriptor).some((neighbor) => hasTransport(world, neighbor))) continue
        const path = [approach, ...water, landing]
        if (path.some((id, index) => index > 0 && !v4TransportEdgeAllowed(world, path[index - 1]!, id))) continue
        if (!riverChannelApproximatelyPerpendicular(world, water, dx)) continue
        if (hasAdjacentExistingBridge(world, water)) continue
        const key = `${water.join(',')}:${landing}`
        candidates.set(key, Object.freeze({ water: Object.freeze(water), landing }))
      }
    }
  }
  return [...candidates.values()]
}

function annualGrowthRate(world: DynamicWorld, cityIndex: number): number {
  const city = world.staticWorld.cities[cityIndex] as V3City | undefined
  const explicit = city?.growth?.rate
  if (explicit !== undefined && Number.isFinite(explicit)) {
    // Descriptor rate is relative (metro ~= 1), anchored to 1.5% annually.
    return Math.max(0.005, Math.min(0.025, 0.015 * explicit))
  }
  switch (settlementTier(world, cityIndex)) {
    case 'metro': return 0.015
    case 'satellite': return 0.0123
    case 'town': return 0.0087
    case 'village': return 0.0051
  }
}

function v3ScanBounds(world: DynamicWorld, cityIndex: number) {
  const city = world.staticWorld.cities[cityIndex]!
  const runtime = world.cityRuntime.get(cityIndex)!
  const expansion = Math.ceil(Math.sqrt(runtime.growthEvents * 24 + 1)) + 4
  const radius = city.radius + expansion
  return {
    minX: Math.max(0, city.cx - radius),
    maxX: Math.min(world.descriptor.width - 1, city.cx + radius),
    minY: Math.max(0, city.cy - radius),
    maxY: Math.min(world.descriptor.height - 1, city.cy + radius),
  }
}

/**
 * V3 growth is a small transport-led project rather than a shuffled frontier.
 * It first redevelops suitable cells, then extends one connected road cell and
 * only claims parcels served by that extension or the existing network.
 */
function planV3CityGrowth(
  world: DynamicWorld,
  cityIndex: number,
  day: number,
  maxTiles: number,
  reserved: ReadonlySet<TileId>,
): CityGrowthPlan {
  const runtime = world.cityRuntime.get(cityIndex)!
  const feature = encodeCityFeature(cityIndex)
  const event = runtime.growthEvents + 1
  const seed = world.descriptor.seed ^ Math.imul(cityIndex + 1, 0x45d9f3b) ^ Math.imul(event, 0x27d4eb2d)
  const { minX, maxX, minY, maxY } = v3ScanBounds(world, cityIndex)
  const infill: TileId[] = []
  const frontier: TileId[] = []

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const id = (y * world.descriptor.width + x) as TileId
      if (reserved.has(id) || isProtected(world, id)) continue
      const kind = world.getKind(id)
      const ownSettlement = world.getFeature(id) === feature
      if (ownSettlement && !hasTransport(world, id) && densityUpgrade(kind) !== undefined &&
          v4TileGradeAllowed(world, id) && v4DenseGrowthAllowed(world, id) &&
          cardinalNeighborIds(id, world.descriptor).some((neighbor) => hasTransport(world, neighbor))) {
        infill.push(id)
      }
      if (!hasTransport(world, id) &&
          v4TileGradeAllowed(world, id) &&
          (kind === TERRAIN_KIND.empty || kind === TERRAIN_KIND.forest) &&
          cardinalNeighborIds(id, world.descriptor).some((neighbor) =>
            world.getFeature(neighbor) === feature || hasTransport(world, neighbor))) {
        frontier.push(id)
      }
    }
  }

  const score = (id: TileId) => hash(seed ^ id)
  infill.sort((a, b) => score(a) - score(b) || a - b)
  frontier.sort((a, b) => score(a) - score(b) || a - b)
  const tiles: CityGrowthTile[] = []

  // Reserve roughly a third of a project for infill. A project with frontier
  // space still starts with transport, maintaining connectivity by construction.
  const bridge = collectGrowthBridgeCandidates(world, minX, maxX, minY, maxY, reserved)
    .filter((candidate) => candidate.water.length + 1 <= maxTiles)
    .sort((a, b) =>
      a.water.length - b.water.length ||
      score(a.water[0]!) - score(b.water[0]!) ||
      a.landing - b.landing,
    )[0]
  const road = frontier.find((id) =>
    cardinalNeighborIds(id, world.descriptor).some((neighbor) =>
      hasTransport(world, neighbor) && v4TransportEdgeAllowed(world, id, neighbor)),
  )
  if (bridge !== undefined) {
    for (const id of bridge.water) {
      tiles.push(Object.freeze({ tileId: id, kind: TERRAIN_KIND.lake, mode: 'bridge' as const }))
    }
    tiles.push(Object.freeze({ tileId: bridge.landing, kind: world.getKind(bridge.landing), mode: 'transport' as const }))
  } else if (road !== undefined) {
    tiles.push(Object.freeze({ tileId: road, kind: world.getKind(road), mode: 'transport' as const }))
  }
  for (const id of infill.slice(0, Math.min(8, maxTiles - tiles.length))) {
    tiles.push(Object.freeze({ tileId: id, kind: densityUpgrade(world.getKind(id))!, mode: 'infill' as const }))
  }

  const selected = new Set(tiles.map((tile) => tile.tileId))
  const roadServed = (id: TileId) => cardinalNeighborIds(id, world.descriptor).some((neighbor) =>
    (hasTransport(world, neighbor) || tiles.some((tile) => tile.tileId === neighbor && tile.mode === 'transport')) &&
    v4TransportEdgeAllowed(world, id, neighbor))
  for (const id of frontier) {
    if (tiles.length >= maxTiles) break
    if (selected.has(id) || !roadServed(id)) continue
    const ordinal = tiles.length
    const kind = growthKind(seed, ordinal) === TERRAIN_KIND.road
      ? TERRAIN_KIND.house
      : growthKind(seed, ordinal)
    if (isDenseGrowthKind(kind) && !v4DenseGrowthAllowed(world, id)) continue
    selected.add(id)
    tiles.push(Object.freeze({ tileId: id, kind, mode: 'parcel' as const }))
  }

  const elapsedDays = Math.max(1, day - runtime.lastGrowthDay)
  const targetPopulation = Math.max(1, Math.round(runtime.population * annualGrowthRate(world, cityIndex) * elapsedDays / 365))
  return Object.freeze({
    cityIndex,
    day,
    growthEvent: event,
    tiles: Object.freeze(tiles),
    populationDelta: tiles.length > 0 ? targetPopulation : 0,
  })
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
  if (isV3(world)) return planV3CityGrowth(world, cityIndex, day, maxTiles, options.reserved ?? new Set())
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
  const plannedBridgeTiles = plan.tiles.filter((tile) => tile.mode === 'bridge')
  if (plannedBridgeTiles.length > 0) {
    const { minX, maxX, minY, maxY } = v3ScanBounds(world, plan.cityIndex)
    const matchesCandidate = collectGrowthBridgeCandidates(world, minX, maxX, minY, maxY, new Set())
      .some((candidate) =>
        candidate.water.length === plannedBridgeTiles.length &&
        candidate.water.every((id, index) => plannedBridgeTiles[index]?.tileId === id) &&
        plan.tiles.some((tile) => tile.mode === 'transport' && tile.tileId === candidate.landing),
      )
    if (!matchesCandidate) throw new Error('city growth plan contains an invalid river bridge')
  }
  const feature = encodeCityFeature(plan.cityIndex)
  const seen = new Set<TileId>()
  for (const tile of plan.tiles) {
    if (seen.has(tile.tileId)) throw new Error('city growth plan contains duplicate tiles')
    seen.add(tile.tileId)
    const validBridge = isV7(world) && tile.mode === 'bridge' &&
      !isProtected(world, tile.tileId) && isRiverWater(world, tile.tileId)
    const validInfill = isV3(world) && tile.mode === 'infill' &&
      !isProtected(world, tile.tileId) && world.getFeature(tile.tileId) === feature &&
      isSettlementKind(world.getKind(tile.tileId))
    if (!validBridge && !validInfill && !canGrowInto(world, tile.tileId)) {
      const { x, y } = tileCoords(tile.tileId, world.descriptor.width)
      throw new Error(`city growth cannot overwrite protected tile (${x}, ${y})`)
    }
    if (!validBridge && isV4(world) && (!v4TileGradeAllowed(world, tile.tileId) ||
        (isDenseGrowthKind(tile.kind) && !v4DenseGrowthAllowed(world, tile.tileId)))) {
      const { x, y } = tileCoords(tile.tileId, world.descriptor.width)
      throw new Error(`city growth cannot use unsuitable terrain (${x}, ${y})`)
    }
    if (validBridge) {
      stageLocalTransport(world, batch, tile.tileId, TRANSPORT_FLAGS.settlement | TRANSPORT_FLAGS.bridge)
    } else if (isV3(world) && tile.mode === 'transport') {
      // Transport is an independent overlay in v3. Keeping the underlying
      // empty/forest terrain makes bridge/road rendering and future land-use
      // changes independent rather than reverting to the v2 road tile kind.
      batch.patchTerrain(tile.tileId, {
        feature,
        // A V5 road owns the whole tile corridor. Clearing broad vegetation
        // here prevents a pre-existing forest kit from surviving beneath the
        // new transport overlay while retaining non-vegetation land uses.
        kind: isV5(world) && world.getKind(tile.tileId) === TERRAIN_KIND.forest
          ? TERRAIN_KIND.empty
          : world.getKind(tile.tileId),
      })
      stageLocalTransport(world, batch, tile.tileId)
    } else {
      batch.setTerrain({ tileId: tile.tileId, kind: tile.kind, feature })
    }
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

export function cityGrowthInterval(world: DynamicWorld, cityIndex: number): number {
  if (!isV3(world)) return 7
  switch (settlementTier(world, cityIndex)) {
    case 'metro':
    case 'satellite': return 84
    case 'town': return 168
    case 'village': return 336
  }
}
