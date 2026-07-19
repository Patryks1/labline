import {
  cardinalNeighborIds,
  chunkIdForTile,
  isTileIdInWorld,
  tileCoords,
  tileId,
} from './ids'
import { WorldChangeJournal } from './journal'
import {
  TERRAIN_KIND,
  WORLD_CHANGE_FLAGS,
  WORLD_FORMAT_VERSION,
  type ChunkId,
  type CityRuntimeState,
  type DynamicWorldSnapshotV2,
  type Facility,
  type FacilityAggregate,
  type FacilityQuery,
  type StaticWorld,
  type TerrainKind,
  type TerrainOverride,
  type TileId,
  type TileView,
  type WorldBatchCommit,
  type WorldChange,
  type WorldChangesSince,
  type WorldMetrics,
  type WorldOwnerId,
} from './types'

type MutableAggregate = {
  count: number
  occupiedTiles: number
  underConstruction: number
  rackCapacity: number
  racksUsed: number
  mwCapacity: number
  mwGeneration: number
  capex: number
  opexPerDay: number
}

const EMPTY_AGGREGATE: FacilityAggregate = Object.freeze({
  count: 0,
  occupiedTiles: 0,
  underConstruction: 0,
  rackCapacity: 0,
  racksUsed: 0,
  mwCapacity: 0,
  mwGeneration: 0,
  capex: 0,
  opexPerDay: 0,
})

function mutableAggregate(): MutableAggregate {
  return { ...EMPTY_AGGREGATE }
}

function addToAggregate(target: MutableAggregate, facility: Facility, direction: 1 | -1): void {
  const stats = facility.stats
  target.count += direction
  target.occupiedTiles += facility.footprint.length * direction
  target.underConstruction +=
    (facility.constructionTarget > 0 && facility.constructionProgress < facility.constructionTarget
      ? 1
      : 0) * direction
  target.rackCapacity += (stats?.rackCapacity ?? 0) * direction
  target.racksUsed += (stats?.racksUsed ?? 0) * direction
  target.mwCapacity += (stats?.mwCapacity ?? 0) * direction
  target.mwGeneration += (stats?.mwGeneration ?? 0) * direction
  target.capex += (stats?.capex ?? 0) * direction
  target.opexPerDay += (stats?.opexPerDay ?? 0) * direction
}

function freezeAggregate(source: MutableAggregate): FacilityAggregate {
  return Object.freeze({ ...source })
}

function validateFinite(value: number, label: string, minimum = 0): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be a finite number >= ${minimum}`)
  }
}

function freezeFacility(facility: Facility, world: StaticWorld): Facility {
  if (!facility.id.trim()) throw new Error('facility id must not be empty')
  if (!facility.kind.trim()) throw new Error('facility kind must not be empty')
  if (!isTileIdInWorld(facility.anchor, world.descriptor)) {
    throw new RangeError(`facility ${facility.id} anchor is outside the world`)
  }
  validateFinite(facility.level, 'facility level')
  validateFinite(facility.constructionProgress, 'construction progress')
  validateFinite(facility.constructionTarget, 'construction target')
  const footprint = [...new Set(facility.footprint)]
  if (footprint.length === 0 || !footprint.includes(facility.anchor)) {
    throw new Error(`facility ${facility.id} footprint must include its anchor`)
  }
  for (const id of footprint) {
    if (!isTileIdInWorld(id, world.descriptor)) {
      throw new RangeError(`facility ${facility.id} footprint contains an invalid tile`)
    }
  }
  const stats = facility.stats ? Object.freeze({ ...facility.stats }) : undefined
  if (stats) {
    for (const [key, value] of Object.entries(stats)) {
      if (value !== undefined) validateFinite(value, `facility stats.${key}`)
    }
  }
  return Object.freeze({
    ...facility,
    footprint: Object.freeze(footprint),
    stats,
    data: facility.data ? Object.freeze({ ...facility.data }) : undefined,
  })
}

function validateTerrainOverride(override: TerrainOverride, world: StaticWorld): TerrainOverride {
  if (!isTileIdInWorld(override.tileId, world.descriptor)) {
    throw new RangeError('terrain override tile is outside the world')
  }
  if (override.kind !== undefined && !Number.isInteger(override.kind)) {
    throw new RangeError('terrain kind must be an integer')
  }
  if (override.feature !== undefined && (!Number.isInteger(override.feature) || override.feature < 0 || override.feature > 0xffff)) {
    throw new RangeError('terrain feature must be a uint16')
  }
  if (
    override.variantMask !== undefined &&
    (!Number.isInteger(override.variantMask) || override.variantMask < 0 || override.variantMask > 0xff)
  ) {
    throw new RangeError('terrain variant mask must be a uint8')
  }
  return Object.freeze({ ...override })
}

function isNoopOverride(override: TerrainOverride, world: StaticWorld): boolean {
  const id = override.tileId
  return (
    (override.kind === undefined || override.kind === world.kind[id]) &&
    (override.feature === undefined || override.feature === world.feature[id]) &&
    (override.variantMask === undefined || override.variantMask === world.variantMask[id]) &&
    (override.ownerId === undefined || override.ownerId === 'neutral')
  )
}

function addIndex<K>(index: Map<K, Set<string>>, key: K, facilityId: string): void {
  let values = index.get(key)
  if (!values) {
    values = new Set()
    index.set(key, values)
  }
  values.add(facilityId)
}

function removeIndex<K>(index: Map<K, Set<string>>, key: K, facilityId: string): void {
  const values = index.get(key)
  if (!values) return
  values.delete(facilityId)
  if (values.size === 0) index.delete(key)
}

function intersects(values: readonly Set<string>[]): Set<string> {
  if (values.length === 0) return new Set()
  const sorted = [...values].sort((a, b) => a.size - b.size)
  const result = new Set(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!
    for (const id of result) if (!current.has(id)) result.delete(id)
  }
  return result
}

export interface CreateDynamicWorldOptions {
  readonly journalCapacity?: number
  readonly terrainOverrides?: readonly TerrainOverride[]
  readonly facilities?: readonly Facility[]
  readonly cities?: readonly CityRuntimeState[]
}

export type WorldMetricsListener = (metrics: WorldMetrics, change: WorldChange) => void

export class DynamicWorld {
  readonly staticWorld: StaticWorld
  readonly terrainOverrides = new Map<TileId, TerrainOverride>()
  readonly facilitiesById = new Map<string, Facility>()
  readonly occupancy = new Map<TileId, string>()
  readonly cityRuntime = new Map<number, CityRuntimeState>()

  private readonly byOwner = new Map<WorldOwnerId, Set<string>>()
  private readonly byKind = new Map<string, Set<string>>()
  private readonly byRegion = new Map<number, Set<string>>()
  private readonly byChunk = new Map<ChunkId, Set<string>>()
  private readonly metricOwners = new Map<WorldOwnerId, MutableAggregate>()
  private readonly metricKinds = new Map<string, MutableAggregate>()
  private readonly metricTotal = mutableAggregate()
  private readonly listeners = new Set<WorldMetricsListener>()
  private readonly journal: WorldChangeJournal
  private revisionValue = 0
  private metricsValue: WorldMetrics

  constructor(staticWorld: StaticWorld, options: CreateDynamicWorldOptions = {}) {
    this.staticWorld = staticWorld
    const size = staticWorld.descriptor.width * staticWorld.descriptor.height
    if (
      staticWorld.kind.length !== size ||
      staticWorld.region.length !== size ||
      staticWorld.feature.length !== size ||
      staticWorld.variantMask.length !== size
    ) {
      throw new Error('static world layer lengths do not match its descriptor')
    }
    this.journal = new WorldChangeJournal(options.journalCapacity)
    for (const city of staticWorld.cities) {
      this.cityRuntime.set(
        city.index,
        Object.freeze({
          cityIndex: city.index,
          population: city.population,
          growthEvents: 0,
          lastGrowthDay: 0,
        }),
      )
    }
    for (const city of options.cities ?? []) this.setInitialCity(city)
    for (const override of options.terrainOverrides ?? []) {
      const normalized = validateTerrainOverride(override, staticWorld)
      if (!isNoopOverride(normalized, staticWorld)) {
        this.terrainOverrides.set(normalized.tileId, normalized)
      }
    }
    for (const facility of options.facilities ?? []) {
      const normalized = freezeFacility(facility, staticWorld)
      if (this.facilitiesById.has(normalized.id)) throw new Error(`duplicate facility ${normalized.id}`)
      for (const id of normalized.footprint) {
        if (this.occupancy.has(id)) throw new Error(`facility footprint collision at tile ${id}`)
      }
      this.attachFacility(normalized)
    }
    this.metricsValue = this.buildMetrics()
  }

  get descriptor() {
    return this.staticWorld.descriptor
  }

  get revision(): number {
    return this.revisionValue
  }

  get sequence(): number {
    return this.journal.sequence
  }

  get metrics(): WorldMetrics {
    return this.metricsValue
  }

  beginBatch(): WorldMutationBatch {
    return new WorldMutationBatch(this)
  }

  changesSince(sequence: number): WorldChangesSince {
    return this.journal.changesSince(sequence)
  }

  onMetricsChanged(listener: WorldMetricsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getKind(id: TileId): TerrainKind {
    this.requireTile(id)
    return this.terrainOverrides.get(id)?.kind ?? (this.staticWorld.kind[id] as TerrainKind)
  }

  getOwner(id: TileId): WorldOwnerId {
    this.requireTile(id)
    const facilityId = this.occupancy.get(id)
    if (facilityId) return this.facilitiesById.get(facilityId)?.ownerId ?? 'neutral'
    return this.terrainOverrides.get(id)?.ownerId ?? 'neutral'
  }

  getFeature(id: TileId): number {
    this.requireTile(id)
    return this.terrainOverrides.get(id)?.feature ?? this.staticWorld.feature[id]!
  }

  getVariantMask(id: TileId): number {
    this.requireTile(id)
    const kind = this.getKind(id)
    const overrideMask = this.terrainOverrides.get(id)?.variantMask
    const high = (overrideMask ?? this.staticWorld.variantMask[id]!) & 0xf0
    if (kind !== TERRAIN_KIND.road && kind !== TERRAIN_KIND.lake) {
      return overrideMask ?? this.staticWorld.variantMask[id]!
    }
    const { x, y } = tileCoords(id, this.descriptor.width)
    let mask = 0
    if (y > 0 && this.getKind((id - this.descriptor.width) as TileId) === kind) mask |= 1
    if (x + 1 < this.descriptor.width && this.getKind((id + 1) as TileId) === kind) mask |= 2
    if (y + 1 < this.descriptor.height && this.getKind((id + this.descriptor.width) as TileId) === kind) mask |= 4
    if (x > 0 && this.getKind((id - 1) as TileId) === kind) mask |= 8
    return high | mask
  }

  getFacilityAt(id: TileId): Facility | undefined {
    this.requireTile(id)
    const facilityId = this.occupancy.get(id)
    return facilityId ? this.facilitiesById.get(facilityId) : undefined
  }

  getTileView(id: TileId): TileView {
    this.requireTile(id)
    const { x, y } = tileCoords(id, this.descriptor.width)
    return {
      id,
      x,
      y,
      chunkId: chunkIdForTile(id, this.descriptor),
      baseKind: this.staticWorld.kind[id] as TerrainKind,
      kind: this.getKind(id),
      regionIndex: this.staticWorld.region[id]!,
      feature: this.getFeature(id),
      variantMask: this.getVariantMask(id),
      ownerId: this.getOwner(id),
      facility: this.getFacilityAt(id),
    }
  }

  forEachTileInBounds(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (tile: TileView) => void,
  ): void {
    const x0 = Math.max(0, Math.floor(minX))
    const y0 = Math.max(0, Math.floor(minY))
    const x1 = Math.min(this.descriptor.width, Math.ceil(maxX))
    const y1 = Math.min(this.descriptor.height, Math.ceil(maxY))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        visit(this.getTileView(tileId(x, y, this.descriptor.width, this.descriptor.height)))
      }
    }
  }

  queryFacilities(query: FacilityQuery = {}): Facility[] {
    const candidates: Set<string>[] = []
    if (query.ownerId !== undefined) candidates.push(this.byOwner.get(query.ownerId) ?? new Set())
    if (query.kind !== undefined) candidates.push(this.byKind.get(query.kind) ?? new Set())
    if (query.regionIndex !== undefined) candidates.push(this.byRegion.get(query.regionIndex) ?? new Set())
    if (query.chunkId !== undefined) candidates.push(this.byChunk.get(query.chunkId) ?? new Set())
    const ids = candidates.length > 0 ? intersects(candidates) : new Set(this.facilitiesById.keys())
    const result: Facility[] = []
    for (const id of ids) {
      const facility = this.facilitiesById.get(id)
      if (!facility) continue
      if (
        query.underConstruction !== undefined &&
        (facility.constructionTarget > 0 && facility.constructionProgress < facility.constructionTarget) !==
          query.underConstruction
      ) {
        continue
      }
      result.push(facility)
    }
    result.sort((a, b) => a.id.localeCompare(b.id))
    return result
  }

  /**
   * Visit matching facilities without allocating or sorting an intermediate
   * result. This is intended for order-independent simulation reductions; use
   * queryFacilities when a stable id order is part of the caller's behavior.
   */
  forEachFacility(query: FacilityQuery, visit: (facility: Facility) => void): void {
    const candidates: Set<string>[] = []
    if (query.ownerId !== undefined) {
      const values = this.byOwner.get(query.ownerId)
      if (!values) return
      candidates.push(values)
    }
    if (query.kind !== undefined) {
      const values = this.byKind.get(query.kind)
      if (!values) return
      candidates.push(values)
    }
    if (query.regionIndex !== undefined) {
      const values = this.byRegion.get(query.regionIndex)
      if (!values) return
      candidates.push(values)
    }
    if (query.chunkId !== undefined) {
      const values = this.byChunk.get(query.chunkId)
      if (!values) return
      candidates.push(values)
    }

    let ids: Iterable<string> = this.facilitiesById.keys()
    if (candidates.length > 0) {
      let smallest = candidates[0]!
      for (let i = 1; i < candidates.length; i++) {
        if (candidates[i]!.size < smallest.size) smallest = candidates[i]!
      }
      ids = smallest
    }

    for (const id of ids) {
      if (candidates.some((values) => !values.has(id))) continue
      const facility = this.facilitiesById.get(id)
      if (!facility) continue
      if (
        query.underConstruction !== undefined &&
        (facility.constructionTarget > 0 && facility.constructionProgress < facility.constructionTarget) !==
          query.underConstruction
      ) {
        continue
      }
      visit(facility)
    }
  }

  toSnapshot(): DynamicWorldSnapshotV2 {
    return {
      formatVersion: WORLD_FORMAT_VERSION,
      descriptor: this.descriptor,
      staticHash: this.staticWorld.staticHash,
      terrainOverrides: [...this.terrainOverrides.values()].sort((a, b) => a.tileId - b.tileId),
      facilities: [...this.facilitiesById.values()].sort((a, b) => a.id.localeCompare(b.id)),
      cities: [...this.cityRuntime.values()].sort((a, b) => a.cityIndex - b.cityIndex),
    }
  }

  /** Internal commit boundary; callers mutate through WorldMutationBatch. */
  commitBatch(batch: WorldMutationBatch): WorldBatchCommit {
    return batch.applyTo(this)
  }

  requireTile(id: TileId): void {
    if (!isTileIdInWorld(id, this.descriptor)) throw new RangeError(`tile ${id} is outside the world`)
  }

  detachFacility(facility: Facility): void {
    this.facilitiesById.delete(facility.id)
    for (const id of facility.footprint) this.occupancy.delete(id)
    removeIndex(this.byOwner, facility.ownerId, facility.id)
    removeIndex(this.byKind, facility.kind, facility.id)
    for (const region of this.facilityRegions(facility)) removeIndex(this.byRegion, region, facility.id)
    for (const chunk of this.facilityChunks(facility)) removeIndex(this.byChunk, chunk, facility.id)
    addToAggregate(this.metricTotal, facility, -1)
    const ownerMetrics = this.metricOwners.get(facility.ownerId)
    if (ownerMetrics) {
      addToAggregate(ownerMetrics, facility, -1)
      if (ownerMetrics.count === 0) this.metricOwners.delete(facility.ownerId)
    }
    const kindMetrics = this.metricKinds.get(facility.kind)
    if (kindMetrics) {
      addToAggregate(kindMetrics, facility, -1)
      if (kindMetrics.count === 0) this.metricKinds.delete(facility.kind)
    }
  }

  attachFacility(facility: Facility): void {
    this.facilitiesById.set(facility.id, facility)
    for (const id of facility.footprint) this.occupancy.set(id, facility.id)
    addIndex(this.byOwner, facility.ownerId, facility.id)
    addIndex(this.byKind, facility.kind, facility.id)
    for (const region of this.facilityRegions(facility)) addIndex(this.byRegion, region, facility.id)
    for (const chunk of this.facilityChunks(facility)) addIndex(this.byChunk, chunk, facility.id)
    addToAggregate(this.metricTotal, facility, 1)
    let ownerMetrics = this.metricOwners.get(facility.ownerId)
    if (!ownerMetrics) {
      ownerMetrics = mutableAggregate()
      this.metricOwners.set(facility.ownerId, ownerMetrics)
    }
    addToAggregate(ownerMetrics, facility, 1)
    let kindMetrics = this.metricKinds.get(facility.kind)
    if (!kindMetrics) {
      kindMetrics = mutableAggregate()
      this.metricKinds.set(facility.kind, kindMetrics)
    }
    addToAggregate(kindMetrics, facility, 1)
  }

  normalizeFacility(facility: Facility): Facility {
    return freezeFacility(facility, this.staticWorld)
  }

  normalizeTerrain(override: TerrainOverride): TerrainOverride | undefined {
    const normalized = validateTerrainOverride(override, this.staticWorld)
    return isNoopOverride(normalized, this.staticWorld) ? undefined : normalized
  }

  finishCommit(
    flags: number,
    tileIds: Set<TileId>,
    facilityIds: Set<string>,
    cityIndexes: Set<number>,
  ): WorldBatchCommit {
    if (flags === 0) return { committed: false, revision: this.revisionValue }
    this.revisionValue++
    const sortedTiles = [...tileIds].sort((a, b) => a - b)
    const chunks = new Set<ChunkId>()
    for (const id of sortedTiles) chunks.add(chunkIdForTile(id, this.descriptor))
    this.metricsValue = this.buildMetrics()
    const change = this.journal.append({
      revision: this.revisionValue,
      flags,
      tileIds: sortedTiles,
      chunkIds: [...chunks].sort((a, b) => a - b),
      facilityIds: [...facilityIds].sort(),
      cityIndexes: [...cityIndexes].sort((a, b) => a - b),
    })
    for (const listener of this.listeners) {
      try {
        listener(this.metricsValue, change)
      } catch {
        // Observers are deliberately isolated from the committed world transaction.
      }
    }
    return { committed: true, revision: this.revisionValue, change }
  }

  private setInitialCity(city: CityRuntimeState): void {
    const base = this.staticWorld.cities[city.cityIndex]
    if (!base) throw new RangeError(`unknown city index ${city.cityIndex}`)
    validateFinite(city.population, 'city population')
    if (!Number.isSafeInteger(city.growthEvents) || city.growthEvents < 0) {
      throw new RangeError('city growth events must be a non-negative integer')
    }
    if (!Number.isSafeInteger(city.lastGrowthDay) || city.lastGrowthDay < 0) {
      throw new RangeError('city last growth day must be a non-negative integer')
    }
    this.cityRuntime.set(city.cityIndex, Object.freeze({ ...city }))
  }

  private facilityRegions(facility: Facility): Set<number> {
    const values = new Set<number>()
    for (const id of facility.footprint) values.add(this.staticWorld.region[id]!)
    return values
  }

  private facilityChunks(facility: Facility): Set<ChunkId> {
    const values = new Set<ChunkId>()
    for (const id of facility.footprint) values.add(chunkIdForTile(id, this.descriptor))
    return values
  }

  private buildMetrics(): WorldMetrics {
    return Object.freeze({
      revision: this.revisionValue,
      terrainOverrideCount: this.terrainOverrides.size,
      facilities: freezeAggregate(this.metricTotal),
      byOwner: new Map([...this.metricOwners].map(([key, value]) => [key, freezeAggregate(value)])),
      byKind: new Map([...this.metricKinds].map(([key, value]) => [key, freezeAggregate(value)])),
    })
  }
}

export class WorldMutationBatch {
  private readonly source: DynamicWorld
  private readonly facilityWrites = new Map<string, Facility | null>()
  private readonly terrainWrites = new Map<TileId, TerrainOverride | null>()
  private readonly cityWrites = new Map<number, CityRuntimeState>()
  private closed = false

  constructor(source: DynamicWorld) {
    this.source = source
  }

  addFacility(facility: Facility): this {
    this.requireOpen()
    if (this.currentFacility(facility.id)) throw new Error(`facility ${facility.id} already exists`)
    this.facilityWrites.set(facility.id, this.source.normalizeFacility(facility))
    return this
  }

  replaceFacility(facility: Facility): this {
    this.requireOpen()
    if (!this.currentFacility(facility.id)) throw new Error(`facility ${facility.id} does not exist`)
    this.facilityWrites.set(facility.id, this.source.normalizeFacility(facility))
    return this
  }

  updateFacility(
    facilityId: string,
    update: Partial<Omit<Facility, 'id'>> | ((current: Facility) => Facility),
  ): this {
    this.requireOpen()
    const current = this.currentFacility(facilityId)
    if (!current) throw new Error(`facility ${facilityId} does not exist`)
    const next = typeof update === 'function' ? update(current) : { ...current, ...update, id: facilityId }
    if (next.id !== facilityId) throw new Error('facility update cannot change its id')
    this.facilityWrites.set(facilityId, this.source.normalizeFacility(next))
    return this
  }

  removeFacility(facilityId: string): this {
    this.requireOpen()
    if (!this.currentFacility(facilityId)) throw new Error(`facility ${facilityId} does not exist`)
    this.facilityWrites.set(facilityId, null)
    return this
  }

  setTerrain(override: TerrainOverride): this {
    this.requireOpen()
    this.source.requireTile(override.tileId)
    this.terrainWrites.set(override.tileId, this.source.normalizeTerrain(override) ?? null)
    return this
  }

  patchTerrain(tile: TileId, patch: Omit<TerrainOverride, 'tileId'>): this {
    this.requireOpen()
    this.source.requireTile(tile)
    const staged = this.terrainWrites.has(tile)
      ? this.terrainWrites.get(tile)
      : this.source.terrainOverrides.get(tile)
    return this.setTerrain({ ...(staged ?? { tileId: tile }), ...patch, tileId: tile })
  }

  clearTerrain(tile: TileId): this {
    this.requireOpen()
    this.source.requireTile(tile)
    this.terrainWrites.set(tile, null)
    return this
  }

  updateCity(cityIndex: number, patch: Partial<Omit<CityRuntimeState, 'cityIndex'>>): this {
    this.requireOpen()
    const current = this.cityWrites.get(cityIndex) ?? this.source.cityRuntime.get(cityIndex)
    if (!current) throw new RangeError(`unknown city index ${cityIndex}`)
    const next = Object.freeze({ ...current, ...patch, cityIndex })
    validateFinite(next.population, 'city population')
    if (!Number.isSafeInteger(next.growthEvents) || next.growthEvents < 0) {
      throw new RangeError('city growth events must be a non-negative integer')
    }
    if (!Number.isSafeInteger(next.lastGrowthDay) || next.lastGrowthDay < 0) {
      throw new RangeError('city last growth day must be a non-negative integer')
    }
    this.cityWrites.set(cityIndex, next)
    return this
  }

  commit(): WorldBatchCommit {
    this.requireOpen()
    this.closed = true
    return this.source.commitBatch(this)
  }

  rollback(): void {
    this.requireOpen()
    this.closed = true
    this.facilityWrites.clear()
    this.terrainWrites.clear()
    this.cityWrites.clear()
  }

  applyTo(world: DynamicWorld): WorldBatchCommit {
    if (world !== this.source) throw new Error('batch belongs to a different world')
    this.validateOccupancy(world)
    let flags = 0
    const changedTiles = new Set<TileId>()
    const changedFacilities = new Set<string>()
    const changedCities = new Set<number>()

    for (const [id, next] of this.facilityWrites) {
      const previous = world.facilitiesById.get(id)
      if (previous) {
        world.detachFacility(previous)
        for (const tile of previous.footprint) changedTiles.add(tile)
      }
      if (next) {
        world.attachFacility(next)
        for (const tile of next.footprint) changedTiles.add(tile)
      }
      changedFacilities.add(id)
      flags |= WORLD_CHANGE_FLAGS.facility | WORLD_CHANGE_FLAGS.occupancy | WORLD_CHANGE_FLAGS.metrics
    }

    for (const [id, next] of this.terrainWrites) {
      const previous = world.terrainOverrides.get(id)
      if (next) world.terrainOverrides.set(id, next)
      else world.terrainOverrides.delete(id)
      if (previous === next || (previous === undefined && next === null)) continue
      changedTiles.add(id)
      for (const neighbor of cardinalNeighborIds(id, world.descriptor)) changedTiles.add(neighbor)
      flags |= WORLD_CHANGE_FLAGS.terrain | WORLD_CHANGE_FLAGS.metrics
    }

    for (const [index, state] of this.cityWrites) {
      world.cityRuntime.set(index, state)
      changedCities.add(index)
      flags |= WORLD_CHANGE_FLAGS.city
    }

    return world.finishCommit(flags, changedTiles, changedFacilities, changedCities)
  }

  private currentFacility(id: string): Facility | undefined {
    if (this.facilityWrites.has(id)) return this.facilityWrites.get(id) ?? undefined
    return this.source.facilitiesById.get(id)
  }

  private validateOccupancy(world: DynamicWorld): void {
    const released = new Set<TileId>()
    for (const id of this.facilityWrites.keys()) {
      const previous = world.facilitiesById.get(id)
      if (previous) for (const tile of previous.footprint) released.add(tile)
    }
    const staged = new Map<TileId, string>()
    for (const [facilityId, facility] of this.facilityWrites) {
      if (!facility) continue
      for (const tile of facility.footprint) {
        const existing = world.occupancy.get(tile)
        if (existing && existing !== facilityId && !released.has(tile)) {
          throw new Error(`facility ${facilityId} collides with ${existing} at tile ${tile}`)
        }
        const stagedOwner = staged.get(tile)
        if (stagedOwner && stagedOwner !== facilityId) {
          throw new Error(`facilities ${facilityId} and ${stagedOwner} collide at tile ${tile}`)
        }
        staged.set(tile, facilityId)
      }
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('world mutation batch is already closed')
  }
}

export function createDynamicWorld(
  staticWorld: StaticWorld,
  options: CreateDynamicWorldOptions = {},
): DynamicWorld {
  return new DynamicWorld(staticWorld, options)
}

export function beginWorldBatch(world: DynamicWorld): WorldMutationBatch {
  return world.beginBatch()
}
