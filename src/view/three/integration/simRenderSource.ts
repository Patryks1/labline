import type { BuildableKind, MapTile, SimState, TileKind } from '../../../sim/types'
import {
  DISTRICT_KIND,
  TERRAIN_KIND,
  WORLD_GENERATOR_VERSION_V4,
  WORLD_GENERATOR_VERSION_V5,
  WORLD_GENERATOR_VERSION_V6,
  WORLD_CHANGE_FLAGS,
  compileRoadNetwork,
  type DynamicWorld,
  type Facility,
  type MunicipalPowerPlant,
  type RoadNetworkCompileSource,
  type RoadNetworkSnapshot,
  type TileId as WorldTileId,
} from '../../../sim/world'
import {
  AUTHORED_INDUSTRIAL_ARCHETYPES,
  AUTHORED_RESIDENTIAL_ARCHETYPES,
  AUTHORED_TERRAIN_ARCHETYPES,
  AUTHORED_URBAN_ARCHETYPES,
  AUTHORED_VEGETATION_ARCHETYPES,
  AuthoredSceneryArchetype,
  FacilityArchetype,
  IntegrationArchetype,
  RoadPropArchetype,
  MunicipalPowerArchetype,
  SceneryArchetype,
  SingleBuildingArchetype,
} from './artDirectedRegistry'
import {
  planUrbanParcels,
  type UrbanParcel,
  type UrbanParcelPlan,
} from './urbanParcelPlanner'
import {
  DefaultArchetype,
  LodTier,
  RenderBiome,
  SurfaceFlag,
  SurfaceKind,
  type ChunkId,
  type RenderBiomeId,
  type RenderInstance,
  type RenderMunicipalPowerPlant,
  type SurfaceTexel,
  type TileId,
  type ViewportRenderSource,
} from '../v2'

export const MAP_TILE_SIZE = 1.05
export const RENDER_CHUNK_SIZE = 32
export const MAX_RETAINED_CHUNKS = 96
export const MAX_RETAINED_CHUNK_LAYERS = MAX_RETAINED_CHUNKS * 3

const PLAYER_COLOR = 0x3dffc0
const NEUTRAL_FACILITY_COLOR = 0x8f9aa2
const DEFAULT_RIVAL_COLOR = 0xff6b4a

const SCENERY_COLORS = {
  tree: 0x3f7047,
  house: 0xc9b790,
  cityA: 0x9ca8b8,
  cityB: 0x7e8b9d,
  warehouse: 0x8e8171,
} as const

export interface RenderSourceDelta {
  readonly replaceSource: boolean
  readonly entireSurface: boolean
  readonly surfaceTileIds: readonly TileId[]
  readonly chunkIds: readonly ChunkId[]
  readonly journalBacklog: number
}

export interface RenderUiDelta {
  readonly surfaceTileIds: readonly TileId[]
}

type SelectedTile = { x: number; y: number } | null

interface CachedChunk {
  revision: number
  records: readonly RenderInstance[]
}

interface LegacyCampusProjection {
  readonly id: string
  readonly anchorId: number
  readonly anchor: MapTile
  readonly renderTileId: number
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/**
 * Read-only renderer projection over the canonical simulation state. It never
 * places, advances, or otherwise mutates player/rival facilities; both owners
 * are projected through the same facilityInstance() path.
 */
export class SimViewportRenderSource implements ViewportRenderSource {
  readonly width: number
  readonly height: number
  readonly tileSize = MAP_TILE_SIZE
  readonly chunkSize: number
  readonly chunksWide: number
  readonly chunksHigh: number
  readonly useHeightfieldRoadMeshes: boolean

  private state: SimState
  private readonly compactWorld: DynamicWorld | undefined
  private journalSequence: number
  private selectedTileId: TileId | null
  private readonly chunkRevisions: Uint32Array
  private readonly surfaceRevisions: Uint32Array
  private readonly chunkCache = new Map<string, CachedChunk>()
  private readonly chunkLru = new Map<ChunkId, true>()
  private legacyTilesById: Array<MapTile | undefined>
  private legacySignatures: string[]
  private legacyCampuses: Map<string, LegacyCampusProjection>
  private regionIndexById = new Map<string, number>()
  private rivalColors = new Map<string, number>()
  private rivalColorSignature = ''
  private chunkPreparationMs = 0
  private roadNetworkRevisionValue = 0
  private readonly roadRevisionState = { value: 0 }
  private readonly roadCompileSource?: RoadNetworkCompileSource
  private roadNetworkSnapshot?: RoadNetworkSnapshot
  private urbanParcelPlan?: UrbanParcelPlan
  private urbanParcelsByChunk?: ReadonlyMap<ChunkId, readonly UrbanParcel[]>

  constructor(
    state: SimState,
    selectedTile: SelectedTile = null,
    _buildMode: BuildableKind | null = null,
  ) {
    this.state = state
    this.width = state.map.width
    this.height = state.map.height
    this.compactWorld = state.map.storage === 'compact' ? state.map.world : undefined
    this.useHeightfieldRoadMeshes =
      this.compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V4 ||
      this.compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5 ||
      this.compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6
    this.chunkSize = this.compactWorld?.descriptor.chunkSize ?? RENDER_CHUNK_SIZE
    this.chunksWide = Math.ceil(this.width / this.chunkSize)
    this.chunksHigh = Math.ceil(this.height / this.chunkSize)
    this.chunkRevisions = new Uint32Array(this.chunksWide * this.chunksHigh)
    this.surfaceRevisions = new Uint32Array(this.chunksWide * this.chunksHigh)
    this.journalSequence = this.compactWorld?.sequence ?? 0
    this.selectedTileId = selectedToId(selectedTile, this.width, this.height)
    this.legacyTilesById = this.compactWorld ? [] : indexLegacyTiles(state)
    this.legacySignatures = this.legacyTilesById.map(legacyVisualSignature)
    this.legacyCampuses = indexLegacyCampuses(this.legacyTilesById)
    this.rebuildRegionIndex()
    this.rebuildRivalColors()
    if (this.compactWorld) {
      const revisionState = this.roadRevisionState
      this.roadCompileSource = {
        staticWorld: this.compactWorld.staticWorld,
        get revision() { return revisionState.value },
        getTransport: (id) => this.compactWorld!.getTransport(id),
        getTileElevation: (x, y) => this.compactWorld!.getTileElevation(x, y),
      }
    }
  }

  isCompatible(state: SimState): boolean {
    const nextWorld = state.map.storage === 'compact' ? state.map.world : undefined
    return (
      state.map.width === this.width &&
      state.map.height === this.height &&
      nextWorld === this.compactWorld &&
      (nextWorld?.descriptor.chunkSize ?? RENDER_CHUNK_SIZE) === this.chunkSize
    )
  }

  updateState(state: SimState): RenderSourceDelta {
    if (!this.isCompatible(state)) return emptyDelta(true)

    const previousState = this.state
    this.state = state
    const surfaceTileIds = new Set<TileId>()
    const chunkIds = new Set<ChunkId>()
    let entireSurface = false
    let journalBacklog = 0

    if (state.map.regions !== previousState.map.regions) {
      this.rebuildRegionIndex()
      entireSurface = true
    }

    if (this.rebuildRivalColors()) {
      this.invalidateAllChunks(chunkIds)
    }

    if (this.compactWorld) {
      const changes = this.compactWorld.changesSince(this.journalSequence)
      this.journalSequence = changes.nextSequence
      if (changes.kind === 'reset') {
        this.invalidateUrbanParcelPlan()
        entireSurface = true
        this.invalidateAllChunks(chunkIds)
        this.bumpAllSurfaceRevisions()
        this.roadNetworkRevisionValue++
        this.roadRevisionState.value = this.roadNetworkRevisionValue
        this.roadNetworkSnapshot = undefined
      } else {
        journalBacklog = changes.changes.length
        if (changes.changes.length > 0) this.invalidateUrbanParcelPlan()
        for (const change of changes.changes) {
          for (const tileId of change.tileIds) {
            surfaceTileIds.add(tileId as TileId)
            // Environment placement reads the complete one-cell halo for hard
            // clearances. Invalidate every dependent chunk, including the
            // diagonal chunk at a boundary corner.
            for (const affectedId of this.tileAndNeighbors(tileId)) {
              const affectedChunk = this.chunkIdForTile(affectedId)
              chunkIds.add(affectedChunk)
              this.invalidateChunk(affectedChunk)
            }
          }
          for (const chunkId of change.chunkIds) {
            chunkIds.add(chunkId as ChunkId)
            this.invalidateChunk(chunkId as ChunkId)
            if ((change.flags & WORLD_CHANGE_FLAGS.terrain) !== 0) {
              this.bumpSurfaceRevision(chunkId as ChunkId)
              this.roadNetworkRevisionValue++
              this.roadRevisionState.value = this.roadNetworkRevisionValue
              this.roadNetworkSnapshot = undefined
            }
          }
        }
      }
    } else if (state.map.tiles !== previousState.map.tiles) {
      const nextTiles = indexLegacyTiles(state)
      const nextSignatures = nextTiles.map(legacyVisualSignature)
      const affectedCampuses = new Set<string>()
      for (let tileId = 0; tileId < nextSignatures.length; tileId++) {
        if (nextSignatures[tileId] === this.legacySignatures[tileId]) continue
        const previousCampusId = this.legacyTilesById[tileId]?.campusId
        const nextCampusId = nextTiles[tileId]?.campusId
        if (previousCampusId) affectedCampuses.add(previousCampusId)
        if (nextCampusId) affectedCampuses.add(nextCampusId)
        const previousKind = this.legacyTilesById[tileId]?.kind
        const nextKind = nextTiles[tileId]?.kind
        const roadTopologyChanged =
          previousKind !== nextKind && (previousKind === 'road' || nextKind === 'road')
        for (const affectedId of this.tileAndCardinalNeighbors(tileId)) {
          surfaceTileIds.add(affectedId)
          const chunkId = this.chunkIdForTile(affectedId)
          chunkIds.add(chunkId)
          this.invalidateChunk(chunkId)
          if (roadTopologyChanged) this.bumpSurfaceRevision(chunkId)
        }
      }
      const nextCampuses = indexLegacyCampuses(nextTiles)
      for (const campusId of affectedCampuses) {
        const previousCampus = this.legacyCampuses.get(campusId)
        const nextCampus = nextCampuses.get(campusId)
        for (const campus of [previousCampus, nextCampus]) {
          if (!campus) continue
          const chunkId = this.chunkIdForTile(campus.renderTileId)
          chunkIds.add(chunkId)
          this.invalidateChunk(chunkId)
        }
      }
      this.legacyTilesById = nextTiles
      this.legacySignatures = nextSignatures
      this.legacyCampuses = nextCampuses
    }

    return {
      replaceSource: false,
      entireSurface,
      surfaceTileIds: entireSurface ? [] : [...surfaceTileIds],
      chunkIds: [...chunkIds],
      journalBacklog,
    }
  }

  updateUi(selectedTile: SelectedTile, _buildMode: BuildableKind | null): RenderUiDelta {
    const nextSelected = selectedToId(selectedTile, this.width, this.height)
    const changed = new Set<TileId>()
    if (nextSelected !== this.selectedTileId) {
      if (this.selectedTileId !== null) changed.add(this.selectedTileId)
      if (nextSelected !== null) changed.add(nextSelected)
      this.selectedTileId = nextSelected
    }
    return { surfaceTileIds: [...changed] }
  }

  readSurface(tileId: TileId, out: SurfaceTexel): void {
    out.transport = undefined
    if (tileId < 0 || tileId >= this.width * this.height) {
      out.kind = SurfaceKind.grass
      out.neighborMask = 0
      out.region = 0
      out.flags = 0
      return
    }

    if (this.compactWorld) {
      const world = this.compactWorld
      const tileView = world.getTileView(tileId as never) as ReturnType<DynamicWorld['getTileView']> & {
        readonly transport?: number
      }
      const transportWorld = world as DynamicWorld & {
        getTransport?(id: Parameters<DynamicWorld['getTileView']>[0]): number
        staticWorld: DynamicWorld['staticWorld'] & { readonly transport?: Uint16Array }
      }
      const facilityId = world.occupancy.get(tileId as never)
      const facility = facilityId ? world.facilitiesById.get(facilityId) : undefined
      const override = world.terrainOverrides.get(tileId as never)
      const terrain = override?.kind ?? world.staticWorld.kind[tileId] ?? TERRAIN_KIND.empty
      const ownerId = facility?.ownerId ?? override?.ownerId ?? 'neutral'
      out.kind = facility ? SurfaceKind.facility : compactSurfaceKind(terrain)
      out.neighborMask =
        terrain === TERRAIN_KIND.road || terrain === TERRAIN_KIND.lake
          ? world.getVariantMask(tileId as never) & 0x0f
          : (override?.variantMask ?? world.staticWorld.variantMask[tileId] ?? 0) & 0x0f
      out.region = world.staticWorld.region[tileId] ?? 0
      out.flags = this.surfaceFlags(
        tileId,
        ownerId,
        facility,
      )
      const transport = transportWorld.getTransport?.(tileId as never)
        ?? transportWorld.staticWorld.transport?.[tileId]
        ?? tileView.transport
      if (transport !== undefined && transport !== 0) {
        out.transport = transport >>> 0
        out.neighborMask = transport & 0xff
      }
      return
    }

    const tile = this.legacyTilesById[tileId]
    if (!tile) {
      out.kind = SurfaceKind.grass
      out.neighborMask = 0
      out.region = 0
      out.flags = 0
      return
    }
    const facility = isFacilityKind(tile.kind) ? tile : undefined
    out.kind = facility ? SurfaceKind.facility : legacySurfaceKind(tile.kind)
    out.neighborMask = this.legacyNeighborMask(tileId, tile.kind)
    out.region = this.regionIndexById.get(tile.regionId) ?? 0
    out.flags = this.surfaceFlags(
      tileId,
      tile.owner,
      facility,
    )
  }

  getChunkInstances(chunkId: ChunkId, tier: LodTier): readonly RenderInstance[] | null {
    if (chunkId < 0 || chunkId >= this.chunkRevisions.length) return []
    const revision = this.getChunkRevision(chunkId)
    // Instance transforms/IDs are tier-invariant; only registry geometry
    // changes. Share one canonical snapshot across all three GPU tiers.
    const key = `${chunkId}`
    const cached = this.chunkCache.get(key)
    if (cached?.revision === revision) {
      this.touchChunk(chunkId)
      return cached.records
    }

    const records = this.compactWorld
      ? this.buildCompactChunk(chunkId, tier)
      : this.buildLegacyChunk(chunkId, tier)
    this.chunkCache.set(key, { revision, records })
    this.touchChunk(chunkId)
    return records
  }

  /** Exposed for perf instrumentation and bounded-cache regression tests. */
  get cachedChunkLayerCount(): number {
    return this.chunkCache.size
  }

  get cachedChunkCount(): number {
    return this.chunkLru.size
  }

  getChunkRevision(chunkId: ChunkId): number {
    return this.chunkRevisions[chunkId] ?? 0
  }

  getSurfaceRevision(chunkId: ChunkId): number {
    return this.surfaceRevisions[chunkId] ?? 0
  }

  getRoadNetworkRevision(): number {
    return this.roadNetworkRevisionValue
  }

  getRoadNetwork(): RoadNetworkSnapshot | undefined {
    if (!this.roadCompileSource) return undefined
    const drivingSide = this.state.config.drivingSide ?? 'left'
    if (!this.roadNetworkSnapshot || this.roadNetworkSnapshot.revision !== this.roadNetworkRevisionValue ||
      this.roadNetworkSnapshot.drivingSide !== drivingSide) {
      this.roadNetworkSnapshot = compileRoadNetwork(this.roadCompileSource, drivingSide)
    }
    return this.roadNetworkSnapshot
  }

  getTransportRuntimeState() {
    return this.state.transport
  }

  getMunicipalPowerPlants(): readonly RenderMunicipalPowerPlant[] {
    if (!this.compactWorld) return []
    return (this.compactWorld.staticWorld.municipalPowerPlants ?? []).map((plant) => {
      let elevation = Number.NEGATIVE_INFINITY
      for (const id of plant.footprint) {
        elevation = Math.max(elevation, this.getTileElevation(id % this.width, Math.floor(id / this.width)))
      }
      const orientation = (plant.layout?.orientationQuarterTurns ?? 0) * Math.PI * 0.5
      const bounds = this.tileFootprintBounds(plant.footprint)
      const centerX = (bounds.minX + bounds.maxX) * 0.5
      const centerY = (bounds.minY + bounds.maxY) * 0.5
      const panels = (plant.layout?.panelTileIds ?? []).map((tileId) => {
        const x = tileId % this.width
        const y = Math.floor(tileId / this.width)
        return Object.freeze({
          tileId,
          x: x * MAP_TILE_SIZE,
          y: this.getTileElevation(x, y) + 0.015,
          z: y * MAP_TILE_SIZE,
          yaw: orientation,
        })
      })
      return Object.freeze({
        id: stableStringId(plant.id),
        kind: plant.kind,
        tileX: centerX,
        tileY: centerY,
        x: centerX * MAP_TILE_SIZE,
        y: (Number.isFinite(elevation) ? elevation : 0) + 0.015,
        z: centerY * MAP_TILE_SIZE,
        yaw: orientation,
        phase: plant.animationPhase * Math.PI * 2,
        footprintTileIds: plant.footprint,
        panels: Object.freeze(panels),
      })
    })
  }

  isSimulationPaused(): boolean {
    return this.state.paused
  }

  prepareChunk(chunkId: ChunkId, tier: LodTier): void {
    // At most 32x32 logical cells are projected here. The stable cache makes
    // prefetch idempotent and ensures getChunkInstances is allocation-free.
    const startedAt = performance.now()
    this.getChunkInstances(chunkId, tier)
    this.chunkPreparationMs += performance.now() - startedAt
  }

  /** Include synchronous source projection in the renderer's 2 ms work gate. */
  consumeChunkPreparationMs(): number {
    const elapsed = this.chunkPreparationMs
    this.chunkPreparationMs = 0
    return elapsed
  }

  isSelectable(x: number, y: number): boolean {
    const tileId = idAt(x, y, this.width, this.height)
    if (tileId === null) return false
    if (this.compactWorld) {
      const facility = this.compactWorld.getFacilityAt(tileId as never)
      if (facility) return true
      if (this.compactTransport(tileId) !== 0) return false
      if (this.compactWorld.staticWorld.district?.[tileId] === DISTRICT_KIND.municipalCampus) return true
      const owner = this.compactWorld.getOwner(tileId as never)
      if (owner !== 'neutral') return true
      const kind = this.compactWorld.getKind(tileId as never)
      return kind === TERRAIN_KIND.empty || kind === TERRAIN_KIND.forest ||
        kind === TERRAIN_KIND.park || kind === TERRAIN_KIND.house ||
        kind === TERRAIN_KIND.city || kind === TERRAIN_KIND.warehouse
    }
    const tile = this.legacyTilesById[tileId]
    return !!tile && tile.kind !== 'road' && tile.kind !== 'lake'
  }

  getSelectionFootprint(x: number, y: number): readonly { x: number; y: number }[] | undefined {
    const tileId = idAt(x, y, this.width, this.height)
    if (tileId === null) return undefined
    const plant = this.compactWorld?.staticWorld.municipalPowerPlants?.find((candidate) =>
      candidate.footprint.includes(tileId as WorldTileId),
    )
    if (plant) {
      return plant.footprint.map((id) => ({ x: id % this.width, y: Math.floor(id / this.width) }))
    }
    if (!this.usesUrbanParcels()) return undefined
    const footprint = this.getUrbanParcelPlan().footprintForTile(tileId)
    if (footprint.length === 0) return undefined
    return footprint.map((id) => ({ x: id % this.width, y: Math.floor(id / this.width) }))
  }

  getCornerElevation(x: number, y: number): number {
    return this.compactWorld?.getCornerElevation(x, y) ?? 0
  }

  getTileElevation(x: number, y: number): number {
    return this.compactWorld?.getTileElevation(x, y) ?? 0
  }

  getWaterElevation(x: number, y: number): number {
    return this.compactWorld?.getWaterElevation(x, y) ?? 0
  }

  getBiome(x: number, y: number) {
    if (this.compactWorld?.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V4 &&
      this.compactWorld?.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V5 &&
      this.compactWorld?.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V6) {
      return RenderBiome.plains
    }
    return this.compactWorld.getBiome(x, y)
  }

  private buildCompactChunk(chunkId: ChunkId, tier: LodTier): readonly RenderInstance[] {
    const world = this.compactWorld!
    const records: RenderInstance[] = []
    const bounds = this.chunkBounds(chunkId)
    const roadNetwork = this.getRoadNetwork()
    for (const plant of world.staticWorld.municipalPowerPlants ?? []) {
      records.push(...this.municipalPowerInstancesForChunk(plant, chunkId))
    }
    for (const facility of world.queryFacilities({ chunkId: chunkId as never })) {
      if (this.facilityRenderChunk(facility) === chunkId) {
        records.push(this.facilityInstance(facility))
      }
    }
    if (this.usesUrbanParcels()) {
      for (const parcel of this.getUrbanParcelsByChunk().get(chunkId) ?? []) {
        records.push(this.urbanParcelInstance(parcel))
      }
    }
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        const tileId = y * this.width + x
        const facility = world.getFacilityAt(tileId as never)
        if (facility) continue
        if (world.staticWorld.district?.[tileId] === DISTRICT_KIND.municipalCampus ||
          world.staticWorld.district?.[tileId] === DISTRICT_KIND.greenBuffer) continue
        // V3 transport overlays can cross populated terrain. The surface owns
        // the road cell so an underlying house/city prop cannot protrude.
        if (this.compactTransport(tileId) !== 0) continue
        const terrain = world.getKind(tileId as never)
        const tileKind = compactTileKind(terrain)
        if (this.usesUrbanParcels() && this.getUrbanParcelPlan().parcelForTile(tileId)) continue
        const variantMask = world.getVariantMask(tileId as never)
        const scenery = sceneryInstance(
          tileId,
          x,
          y,
          tileKind,
          tier,
          variantMask,
          world.staticWorld.feature[tileId] ?? 0,
          this.getTileElevation(x, y),
          this.getBiome(x, y),
          world.descriptor.seed,
          isBroadEnvironmentKind(tileKind) ? this.hasEnvironmentClearance(x, y) : true,
        )
        if (scenery && !this.decorationOverlapsRoad(scenery, tileId, tileKind, roadNetwork)) {
          records.push(scenery)
        }
      }
    }
    if (roadNetwork) records.push(...roadPropInstancesForChunk(
      roadNetwork,
      chunkId,
      (x, y) => this.getTileElevation(
        Math.max(0, Math.min(this.width - 1, Math.floor(x))),
        Math.max(0, Math.min(this.height - 1, Math.floor(y))),
      ),
    ))
    return records
  }

  private usesUrbanParcels(): boolean {
    return this.compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5 ||
      this.compactWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6
  }

  private invalidateUrbanParcelPlan(): void {
    this.urbanParcelPlan = undefined
    this.urbanParcelsByChunk = undefined
  }

  private getUrbanParcelPlan(): UrbanParcelPlan {
    if (this.urbanParcelPlan) return this.urbanParcelPlan
    const world = this.compactWorld!
    this.urbanParcelPlan = planUrbanParcels(world.staticWorld, {
      excludedTileIds: world.occupancy.keys(),
      kindAt: (id) => world.getKind(id),
      transportAt: (id) => this.compactTransport(id),
      districtAt: (id) => world.staticWorld.district?.[id] ?? 0,
      featureAt: (id) => world.staticWorld.feature[id] ?? 0,
    })
    return this.urbanParcelPlan
  }

  private getUrbanParcelsByChunk(): ReadonlyMap<ChunkId, readonly UrbanParcel[]> {
    if (this.urbanParcelsByChunk) return this.urbanParcelsByChunk
    const mutable = new Map<ChunkId, UrbanParcel[]>()
    for (const parcel of this.getUrbanParcelPlan().parcels) {
      const chunkId = this.urbanParcelRenderChunk(parcel)
      const parcels = mutable.get(chunkId)
      if (parcels) parcels.push(parcel)
      else mutable.set(chunkId, [parcel])
    }
    this.urbanParcelsByChunk = mutable
    return mutable
  }

  private urbanParcelRenderChunk(parcel: UrbanParcel): ChunkId {
    const anchorX = parcel.anchorTileId % this.width
    const anchorY = Math.floor(parcel.anchorTileId / this.width)
    const centerX = anchorX + (parcel.width - 1) * 0.5
    const centerY = anchorY + (parcel.height - 1) * 0.5
    return (
      Math.floor(centerY / this.chunkSize) * this.chunksWide +
      Math.floor(centerX / this.chunkSize)
    ) as ChunkId
  }

  private urbanParcelInstance(parcel: UrbanParcel): RenderInstance {
    const world = this.compactWorld!
    const anchorX = parcel.anchorTileId % this.width
    const anchorY = Math.floor(parcel.anchorTileId / this.width)
    const random = mix32((parcel.anchorTileId + 1) ^ Math.imul(world.descriptor.seed, 0x9e37_79b1))
    let archetypeId: number
    if (parcel.class === 'skyscraper') {
      archetypeId = SingleBuildingArchetype.skyscraper
    } else if (parcel.class === 'small') {
      const choice = random % 10
      archetypeId = parcel.style === 'suburban' && choice < 6
        ? SingleBuildingArchetype.detachedHouse
        : choice < 8 ? SingleBuildingArchetype.smallShop : SingleBuildingArchetype.rowhouse
    } else {
      archetypeId = (random & 3) === 0
        ? SingleBuildingArchetype.officeTower
        : SingleBuildingArchetype.midRise
    }
    return {
      entityId: stableStringId(parcel.id),
      pickTileId: parcel.anchorTileId,
      archetypeId,
      x: (anchorX + (parcel.width - 1) * 0.5) * MAP_TILE_SIZE,
      y: this.foundationElevation(parcel.footprintTileIds) + 0.015,
      z: (anchorY + (parcel.height - 1) * 0.5) * MAP_TILE_SIZE,
      // Rectangular parcel scaling must stay aligned with its authoritative
      // footprint; a quarter turn would visually spill a 2x1 tower into its
      // neighbours. Square lots can use all four cardinal orientations.
      yaw: parcel.width === parcel.height
        ? (random & 3) * Math.PI * 0.5
        : (random & 1) * Math.PI,
      scaleX: parcel.width * MAP_TILE_SIZE * 0.92,
      scaleY: 0.94 + ((random >>> 8) & 0x3f) / 640,
      scaleZ: parcel.height * MAP_TILE_SIZE * 0.92,
      color: 0xffffff,
    }
  }

  /**
   * A settlement archetype is a complete one-cell kit, not just its central
   * building. Trees, benches and fences near its edge can therefore cross a
   * road even when the owning tile is beside (rather than on) that road.
   * Compare the selected kit's complete footprint with the live road mesh.
   */
  private decorationOverlapsRoad(
    instance: RenderInstance,
    tileId: number,
    kind: TileKind,
    network: RoadNetworkSnapshot | undefined,
  ): boolean {
    if (kind === 'road' || kind === 'lake' || !network) return false
    return decorationOverlapsRoadFootprint(
      instance,
      tileId,
      network,
      (id) => this.compactWorld!.getKind(id as never),
      (id) => this.compactTransport(id),
    )
  }

  private buildLegacyChunk(chunkId: ChunkId, tier: LodTier): readonly RenderInstance[] {
    const records: RenderInstance[] = []
    const bounds = this.chunkBounds(chunkId)
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        const tileId = y * this.width + x
        const tile = this.legacyTilesById[tileId]
        if (!tile) continue
        if (isFacilityKind(tile.kind)) {
          const campus = tile.campusId ? this.legacyCampuses.get(tile.campusId) : undefined
          if (campus) {
            if (campus.renderTileId === tileId) records.push(this.legacyFacilityInstance(campus))
          } else if (tile.campusRole !== 'pad') {
            records.push(this.legacyFacilityInstance({
              id: `legacy-${tileId}`,
              anchorId: tileId,
              anchor: tile,
              renderTileId: tileId,
              minX: tile.x,
              minY: tile.y,
              maxX: tile.x,
              maxY: tile.y,
            }))
          }
          continue
        }
        const variantMask =
          tile.kind === 'road' || tile.kind === 'lake'
            ? this.legacyNeighborMask(tileId, tile.kind)
            : 0
        const clearance = isBroadEnvironmentKind(tile.kind)
          ? this.hasLegacyEnvironmentClearance(x, y)
          : true
        const scenery = sceneryInstance(
          tileId,
          x,
          y,
          tile.kind,
          tier,
          variantMask,
          0,
          0,
          RenderBiome.plains,
          this.state.seed,
          clearance,
        )
        if (scenery) records.push(scenery)
      }
    }
    return records
  }

  private facilityInstance(facility: Facility): RenderInstance {
    const { minX, minY, maxX, maxY } = this.facilityBounds(facility)
    const size = facilitySize(facility.kind, facility.data)
    const progress = constructionScale(facility.constructionProgress, facility.constructionTarget)
    const width = Math.max(1, maxX - minX + 1)
    const height = Math.max(1, maxY - minY + 1)
    return {
      entityId: stableStringId(facility.id),
      pickTileId: facility.anchor,
      archetypeId: facility.constructionTarget > 0 && facility.constructionProgress < facility.constructionTarget
        ? AuthoredSceneryArchetype.constructionShell
        : facilityArchetypeFor(facility.kind, size),
      x: ((minX + maxX) * 0.5) * MAP_TILE_SIZE,
      y: this.foundationElevation(facility.footprint) + 0.015,
      z: ((minY + maxY) * 0.5) * MAP_TILE_SIZE,
      yaw: 0,
      scaleX: width * MAP_TILE_SIZE * 0.82,
      scaleY: (0.82 + facility.level * 0.12) * progress,
      scaleZ: height * MAP_TILE_SIZE * 0.82,
      color: this.ownerColor(facility.ownerId),
    }
  }

  private municipalPowerInstance(plant: MunicipalPowerPlant): RenderInstance {
    let elevation = Number.NEGATIVE_INFINITY
    for (const id of plant.footprint) {
      elevation = Math.max(elevation, this.getTileElevation(id % this.width, Math.floor(id / this.width)))
    }
    const equipmentTileId = plant.layout?.equipmentTileId
    const equipmentX = equipmentTileId === undefined ? plant.cx + 0.5 : equipmentTileId % this.width
    const equipmentY = equipmentTileId === undefined ? plant.cy + 0.5 : Math.floor(equipmentTileId / this.width)
    const bounds = this.tileFootprintBounds(plant.footprint)
    const centerX = (bounds.minX + bounds.maxX) * 0.5
    const centerY = (bounds.minY + bounds.maxY) * 0.5
    const usesPanelArray = plant.kind === 'solar' && (plant.layout?.panelTileIds.length ?? 0) > 0
    return {
      entityId: stableStringId(plant.id),
      pickTileId: usesPanelArray ? equipmentTileId : plant.footprint[0],
      archetypeId: usesPanelArray
        ? IntegrationArchetype.grid
        : MunicipalPowerArchetype[plant.kind],
      x: (usesPanelArray ? equipmentX : centerX) * MAP_TILE_SIZE,
      y: (Number.isFinite(elevation) ? elevation : 0) + 0.015,
      z: (usesPanelArray ? equipmentY : centerY) * MAP_TILE_SIZE,
      yaw: plant.layout
        ? plant.layout.orientationQuarterTurns * Math.PI * 0.5
        : plant.animationPhase * Math.PI * 2,
      scaleX: MAP_TILE_SIZE,
      scaleY: MAP_TILE_SIZE,
      scaleZ: MAP_TILE_SIZE,
      color: plant.kind === 'coal' ? 0x706b62 : plant.kind === 'wind' ? 0xe7ece9 :
        plant.kind === 'solar' ? 0x527aa0 : 0xc8d0c9,
    }
  }

  private municipalSolarPanelInstance(plant: MunicipalPowerPlant, tileId: TileId): RenderInstance {
    const x = tileId % this.width
    const y = Math.floor(tileId / this.width)
    return {
      entityId: stableStringId(`${plant.id}:panel:${tileId}`),
      pickTileId: plant.layout?.equipmentTileId ?? plant.footprint[0],
      archetypeId: MunicipalPowerArchetype.solar,
      x: x * MAP_TILE_SIZE,
      y: this.getTileElevation(x, y) + 0.015,
      z: y * MAP_TILE_SIZE,
      yaw: (plant.layout?.orientationQuarterTurns ?? 0) * Math.PI * 0.5,
      scaleX: 0.82,
      scaleY: 0.72,
      scaleZ: 0.82,
      color: 0x527aa0,
    }
  }

  private municipalPowerInstancesForChunk(
    plant: MunicipalPowerPlant,
    chunkId: ChunkId,
  ): readonly RenderInstance[] {
    const records: RenderInstance[] = []
    const equipmentTileId = plant.layout?.equipmentTileId
    const equipmentChunk = equipmentTileId === undefined
      ? this.municipalPowerRenderChunk(plant)
      : this.chunkIdForTile(equipmentTileId)
    if (equipmentChunk === chunkId) records.push(this.municipalPowerInstance(plant))
    if (plant.kind === 'solar') {
      for (const tileId of plant.layout?.panelTileIds ?? []) {
        if (this.chunkIdForTile(tileId) === chunkId) {
          records.push(this.municipalSolarPanelInstance(plant, tileId))
        }
      }
    }
    return records
  }

  private municipalPowerRenderChunk(plant: MunicipalPowerPlant): ChunkId {
    const bounds = this.tileFootprintBounds(plant.footprint)
    const centerX = (bounds.minX + bounds.maxX) * 0.5
    const centerY = (bounds.minY + bounds.maxY) * 0.5
    return Math.floor(centerY / this.chunkSize) * this.chunksWide +
      Math.floor(centerX / this.chunkSize)
  }

  private tileFootprintBounds(footprint: readonly number[]) {
    let minX = this.width
    let minY = this.height
    let maxX = 0
    let maxY = 0
    for (const tileId of footprint) {
      const x = tileId % this.width
      const y = Math.floor(tileId / this.width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    return { minX, minY, maxX, maxY }
  }

  /** Own a multi-tile prop from one deterministic centroid chunk only. */
  private facilityRenderChunk(facility: Facility): ChunkId {
    const { minX, minY, maxX, maxY } = this.facilityBounds(facility)
    const centerX = Math.round((minX + maxX) * 0.5)
    const centerY = Math.round((minY + maxY) * 0.5)
    return (
      Math.floor(centerY / this.chunkSize) * this.chunksWide +
      Math.floor(centerX / this.chunkSize)
    )
  }

  private foundationElevation(footprint: readonly number[]): number {
    let max = Number.NEGATIVE_INFINITY
    for (const tileId of footprint) {
      const x = tileId % this.width
      const y = Math.floor(tileId / this.width)
      max = Math.max(max, this.getTileElevation(x, y))
    }
    return Number.isFinite(max) ? max : 0
  }

  private facilityBounds(facility: Facility) {
    let minX = this.width
    let minY = this.height
    let maxX = 0
    let maxY = 0
    for (const tileId of facility.footprint) {
      const x = tileId % this.width
      const y = Math.floor(tileId / this.width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    return { minX, minY, maxX, maxY }
  }

  /**
   * Broad scenery kits (groves, parks and ground-detail clusters) must retain
   * a full cell of breathing room around hard surfaces.  This is deliberately
   * evaluated from authoritative world layers rather than rendered geometry,
   * so chunk order and LOD can never make a tree appear on a shoulder.
   */
  private hasEnvironmentClearance(x: number, y: number): boolean {
    const world = this.compactWorld!
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue
        const id = idAt(x + ox, y + oy, this.width, this.height)
        if (id === null) continue
        if (this.compactTransport(id) !== 0 || world.getFacilityAt(id as never)) return false
        const kind = world.getKind(id as never)
        if (
          kind === TERRAIN_KIND.road ||
          kind === TERRAIN_KIND.lake ||
          kind === TERRAIN_KIND.house ||
          kind === TERRAIN_KIND.city ||
          kind === TERRAIN_KIND.warehouse
        ) return false
      }
    }
    return true
  }

  private hasLegacyEnvironmentClearance(x: number, y: number): boolean {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue
        const id = idAt(x + ox, y + oy, this.width, this.height)
        if (id === null) continue
        const tile = this.legacyTilesById[id]
        if (!tile) continue
        if (
          tile.kind === 'road' || tile.kind === 'lake' || tile.kind === 'house' ||
          tile.kind === 'city' || tile.kind === 'warehouse' || isFacilityKind(tile.kind)
        ) return false
      }
    }
    return true
  }

  private legacyFacilityInstance(campus: LegacyCampusProjection): RenderInstance {
    const { anchor: tile } = campus
    const size = facilitySize(tile.kind, { dcSize: tile.dcSize, hqSize: tile.hqSize })
    const progress = constructionScale(tile.buildingProgress, tile.buildingTarget)
    const width = Math.max(1, campus.maxX - campus.minX + 1)
    const height = Math.max(1, campus.maxY - campus.minY + 1)
    return {
      entityId: tile.campusId ? stableStringId(tile.campusId) : campus.anchorId + 0x4000_0000,
      pickTileId: campus.anchorId,
      archetypeId: tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget
        ? AuthoredSceneryArchetype.constructionShell
        : facilityArchetypeFor(tile.kind, size),
      x: ((campus.minX + campus.maxX) * 0.5) * MAP_TILE_SIZE,
      y: 0.015,
      z: ((campus.minY + campus.maxY) * 0.5) * MAP_TILE_SIZE,
      yaw: 0,
      scaleX: width * MAP_TILE_SIZE * 0.82,
      scaleY: (0.82 + tile.level * 0.12) * progress,
      scaleZ: height * MAP_TILE_SIZE * 0.82,
      color: this.ownerColor(tile.owner),
    }
  }

  private ownerColor(ownerId: string): number {
    if (ownerId === 'player') return PLAYER_COLOR
    if (ownerId === 'neutral') return NEUTRAL_FACILITY_COLOR
    return this.rivalColors.get(ownerId) ?? DEFAULT_RIVAL_COLOR
  }

  private surfaceFlags(
    tileId: TileId,
    ownerId: string,
    facility: Facility | MapTile | undefined,
  ): number {
    let flags = 0
    if (ownerId === 'player') flags |= SurfaceFlag.playerOwned
    else if (ownerId !== 'neutral') flags |= SurfaceFlag.rivalOwned
    if (tileId === this.selectedTileId) flags |= SurfaceFlag.selected
    if (facility) {
      const progress = 'constructionProgress' in facility
        ? facility.constructionProgress
        : facility.buildingProgress
      const target = 'constructionTarget' in facility
        ? facility.constructionTarget
        : facility.buildingTarget
      if (target > 0 && progress < target) flags |= SurfaceFlag.constructing
      if (facility.powered !== false) flags |= SurfaceFlag.powered
    }
    return flags
  }

  private legacyNeighborMask(tileId: number, kind: TileKind): number {
    if (kind !== 'road' && kind !== 'lake') return 0
    const x = tileId % this.width
    const y = Math.floor(tileId / this.width)
    let mask = 0
    if (y > 0 && this.legacyTilesById[tileId - this.width]?.kind === kind) mask |= 1
    if (x + 1 < this.width && this.legacyTilesById[tileId + 1]?.kind === kind) mask |= 2
    if (y + 1 < this.height && this.legacyTilesById[tileId + this.width]?.kind === kind) mask |= 4
    if (x > 0 && this.legacyTilesById[tileId - 1]?.kind === kind) mask |= 8
    return mask
  }

  private chunkBounds(chunkId: number) {
    const chunkX = chunkId % this.chunksWide
    const chunkY = Math.floor(chunkId / this.chunksWide)
    return {
      minX: chunkX * this.chunkSize,
      maxX: Math.min(this.width, (chunkX + 1) * this.chunkSize),
      minY: chunkY * this.chunkSize,
      maxY: Math.min(this.height, (chunkY + 1) * this.chunkSize),
    }
  }

  private compactTransport(tileId: number): number {
    const world = this.compactWorld
    if (!world) return 0
    const transportWorld = world as DynamicWorld & {
      getTransport?(id: Parameters<DynamicWorld['getTileView']>[0]): number
      staticWorld: DynamicWorld['staticWorld'] & { readonly transport?: Uint16Array }
    }
    return transportWorld.getTransport?.(tileId as never)
      ?? transportWorld.staticWorld.transport?.[tileId]
      ?? 0
  }

  private chunkIdForTile(tileId: number): ChunkId {
    const x = tileId % this.width
    const y = Math.floor(tileId / this.width)
    return Math.floor(y / this.chunkSize) * this.chunksWide + Math.floor(x / this.chunkSize)
  }

  private tileAndCardinalNeighbors(tileId: number): number[] {
    const x = tileId % this.width
    const y = Math.floor(tileId / this.width)
    const result = [tileId]
    if (y > 0) result.push(tileId - this.width)
    if (x + 1 < this.width) result.push(tileId + 1)
    if (y + 1 < this.height) result.push(tileId + this.width)
    if (x > 0) result.push(tileId - 1)
    return result
  }

  private tileAndNeighbors(tileId: number): number[] {
    const x = tileId % this.width
    const y = Math.floor(tileId / this.width)
    const result: number[] = []
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const id = idAt(x + ox, y + oy, this.width, this.height)
        if (id !== null) result.push(id)
      }
    }
    return result
  }

  private invalidateChunk(chunkId: ChunkId): void {
    if (chunkId < 0 || chunkId >= this.chunkRevisions.length) return
    this.chunkRevisions[chunkId] = (this.chunkRevisions[chunkId] ?? 0) + 1
    this.chunkCache.delete(`${chunkId}`)
  }

  private bumpSurfaceRevision(chunkId: ChunkId): void {
    if (chunkId < 0 || chunkId >= this.surfaceRevisions.length) return
    this.surfaceRevisions[chunkId] = (this.surfaceRevisions[chunkId] ?? 0) + 1
  }

  private bumpAllSurfaceRevisions(): void {
    for (let chunkId = 0; chunkId < this.surfaceRevisions.length; chunkId++) {
      this.bumpSurfaceRevision(chunkId)
    }
  }

  private touchChunk(chunkId: ChunkId): void {
    this.chunkLru.delete(chunkId)
    this.chunkLru.set(chunkId, true)
    while (this.chunkLru.size > MAX_RETAINED_CHUNKS) {
      const oldest = this.chunkLru.keys().next().value as ChunkId | undefined
      if (oldest === undefined) return
      this.chunkLru.delete(oldest)
      this.chunkCache.delete(`${oldest}`)
    }
  }

  private invalidateAllChunks(output: Set<ChunkId>): void {
    for (let chunkId = 0; chunkId < this.chunkRevisions.length; chunkId++) {
      output.add(chunkId)
      this.invalidateChunk(chunkId)
    }
  }

  private rebuildRegionIndex(): void {
    this.regionIndexById = new Map(
      this.state.map.regions.map((region, index) => [region.id, Math.min(255, index)]),
    )
  }

  /** Returns true when a color change requires facility instance rebuilds. */
  private rebuildRivalColors(): boolean {
    const signature = this.state.rivals.map((rival) => `${rival.id}:${rival.color}`).join('|')
    if (signature === this.rivalColorSignature) return false
    const changed = this.rivalColorSignature !== ''
    this.rivalColorSignature = signature
    this.rivalColors = new Map(this.state.rivals.map((rival) => [rival.id, rival.color]))
    return changed
  }
}

interface RoadPropLookup {
  readonly segments: ReadonlyMap<string, RoadNetworkSnapshot['segments'][number]>
  readonly junctions: ReadonlyMap<string, RoadNetworkSnapshot['junctions'][number]>
}

const roadPropLookups = new WeakMap<RoadNetworkSnapshot, RoadPropLookup>()

function roadPropLookup(network: RoadNetworkSnapshot): RoadPropLookup {
  const cached = roadPropLookups.get(network)
  if (cached) return cached
  const lookup = {
    segments: new Map(network.segments.map(segment => [segment.id, segment])),
    junctions: new Map(network.junctions.map(junction => [junction.id, junction])),
  }
  roadPropLookups.set(network, lookup)
  return lookup
}

/**
 * Project canonical road furniture into the same chunk-instancing path as the
 * rest of the environment. Stable compiler IDs make placement independent of
 * viewport order, and the compiler's chunk index prevents a world-wide scan.
 */
export function roadPropInstancesForChunk(
  network: RoadNetworkSnapshot,
  chunkId: ChunkId,
  elevationAt: (logicalX: number, logicalY: number) => number = () => 0,
): readonly RenderInstance[] {
  const chunk = network.chunks.get(chunkId)
  if (!chunk) return []
  const lookup = roadPropLookup(network)
  const result: RenderInstance[] = []
  const owns = (x: number, y: number) =>
    Math.floor(y / network.chunkSize) * network.chunksWide + Math.floor(x / network.chunkSize) === chunkId
  const add = (
    key: string,
    archetypeId: number,
    x: number,
    y: number,
    yaw: number,
    scaleX = 1,
    scaleY = 1,
    scaleZ = 1,
  ) => {
    if (!owns(x, y)) return
    result.push({
      entityId: stableStringId(`road-prop:${key}`),
      archetypeId,
      // Compiler points use tile centres (n + 0.5); render-world tile anchors
      // use integer coordinates. Missing this conversion shifted furniture
      // half a tile diagonally, frequently back onto the carriageway.
      x: (x - 0.5) * MAP_TILE_SIZE,
      y: elevationAt(x, y) + 0.04,
      z: (y - 0.5) * MAP_TILE_SIZE,
      yaw,
      scaleX,
      scaleY,
      scaleZ,
      color: 0xffffff,
    })
  }

  for (const junctionId of chunk.junctionIds) {
    const junction = lookup.junctions.get(junctionId)
    if (!junction?.signalized) continue
    const maxHalfWidth = Math.max(
      0.25,
      ...junction.segmentIds.map(id => lookup.segments.get(id)?.profile.halfWidth ?? 0),
    )
    for (let portIndex = 0; portIndex < junction.ports.length; portIndex++) {
      const port = junction.ports[portIndex]!
      const side = network.drivingSide === 'left' ? 1 : -1
      const normalX = -port.headingY * side
      const normalY = port.headingX * side
      const along = maxHalfWidth * 1.58
      const lateral = maxHalfWidth + 0.16
      const x = junction.x + port.headingX * along + normalX * lateral
      const y = junction.y + port.headingY * along + normalY * lateral
      // Model forward is +X. Signal faces traffic approaching the junction.
      const yaw = Math.atan2(-port.headingY, -port.headingX)
      add(`${junction.id}:signal:${portIndex}`, RoadPropArchetype.trafficLight, x, y, yaw, 0.82, 0.82, 0.82)
    }
  }

  for (const segmentId of chunk.segmentIds) {
    const segment = lookup.segments.get(segmentId)
    if (!segment || segment.points.length < 2) continue
    const points = segment.points
    for (let index = 1; index < points.length - 1; index++) {
      const point = points[index]!
      const previous = points[index - 1]!
      const next = points[index + 1]!
      const dx = next.x - previous.x
      const dy = next.y - previous.y
      const length = Math.hypot(dx, dy) || 1
      const tangentX = dx / length
      const tangentY = dy / length
      const normalX = -tangentY
      const normalY = tangentX
      const yaw = Math.atan2(tangentY, tangentX)
      const roadside = segment.profile.halfWidth + segment.profile.shoulderWidth + 0.14

      // Urban lighting is intentionally sparse, alternates verges, and stays
      // at least two tiles clear of junction furniture and crossing paint.
      const lampSpacing = segment.roadClass >= 3 ? 12 : 18
      const lampPhase = stableStringId(segment.id) % lampSpacing
      if (segment.roadClass >= 2 && segment.roadClass < 4
        && index >= 2 && index <= points.length - 3
        && index % lampSpacing === lampPhase) {
        const side = (Math.floor(index / lampSpacing) & 1) === 0 ? 1 : -1
        add(`${segment.id}:lamp:${index}`, SceneryArchetype.roadLamp,
          point.x + normalX * roadside * side, point.y + normalY * roadside * side, yaw)
      }

      // Gateway signs are kept away from junction polygons and occur at most
      // twice per high-class segment.
      if (segment.roadClass >= 3 && (index === 1 || index === points.length - 2)) {
        const side = network.drivingSide === 'left' ? -1 : 1
        add(`${segment.id}:sign:${index}`, RoadPropArchetype.roadSign,
          point.x + normalX * roadside * side, point.y + normalY * roadside * side, yaw, 0.9, 0.9, 0.9)
      }

      // Long authored sections give highways a continuous silhouette while
      // remaining a single instanced draw for the archetype and LOD.
      if (segment.roadClass === 4 && index % 3 === stableStringId(segment.id) % 3) {
        for (const side of [-1, 1]) add(`${segment.id}:guardrail:${index}:${side}`,
          RoadPropArchetype.highwayGuardrail,
          point.x + normalX * roadside * side,
          point.y + normalY * roadside * side,
          yaw,
          Math.min(1.25, Math.max(0.75, length)),
          1,
          1,
        )
      }
    }
  }
  return result
}

const roadJunctionsByTile = new WeakMap<RoadNetworkSnapshot, ReadonlyMap<number, RoadNetworkSnapshot['junctions'][number]>>()

/** @internal Footprint rejection shared by projection and focused regressions. */
export function decorationOverlapsRoadFootprint(
  instance: Pick<RenderInstance, 'archetypeId' | 'x' | 'z' | 'scaleX' | 'scaleZ'>,
  anchorTileId: number,
  network: RoadNetworkSnapshot,
  terrainKindAt: (tileId: number) => number,
  transportAt: (tileId: number) => number,
): boolean {
  if (anchorTileId < 0 || anchorTileId >= network.width * network.height) return false

  const centerX = instance.x / MAP_TILE_SIZE
  const centerY = instance.z / MAP_TILE_SIZE
  const [baseHalfX, baseHalfY] = decorationFootprintHalfExtents(instance.archetypeId)
  const halfX = baseHalfX * Math.abs(instance.scaleX ?? 1)
  const halfY = baseHalfY * Math.abs(instance.scaleZ ?? 1)
  const minX = centerX - halfX
  const maxX = centerX + halfX
  const minY = centerY - halfY
  const maxY = centerY + halfY
  const segmentIndexes = new Set<number>()

  let junctions = roadJunctionsByTile.get(network)
  if (!junctions) {
    junctions = new Map(network.junctions.map(junction => [junction.tileId, junction]))
    roadJunctionsByTile.set(network, junctions)
  }
  const segmentLookup = roadPropLookup(network).segments

  // The compiler's distance/nearest fields cheaply identify the road chain
  // relevant to a beside-road anchor. The local scan also covers overrides
  // made after generation and canonical road tiles without V3 transport.
  if (network.accessDistanceByTile[anchorTileId]! <= 1) {
    const nearest = network.nearestSegmentByTile[anchorTileId] ?? -1
    if (nearest >= 0) segmentIndexes.add(nearest)
  }
  const scanMinX = Math.max(0, Math.floor(minX) - 1)
  const scanMaxX = Math.min(network.width - 1, Math.ceil(maxX) + 1)
  const scanMinY = Math.max(0, Math.floor(minY) - 1)
  const scanMaxY = Math.min(network.height - 1, Math.ceil(maxY) + 1)
  for (let y = scanMinY; y <= scanMaxY; y++) {
    for (let x = scanMinX; x <= scanMaxX; x++) {
      const tileId = y * network.width + x
      const transport = transportAt(tileId)
      const canonicalRoad = terrainKindAt(tileId) === TERRAIN_KIND.road
      if (transport === 0 && !canonicalRoad) continue

      if (transport !== 0) {
        const segmentIndex = network.nearestSegmentByTile[tileId] ?? -1
        if (segmentIndex >= 0 && network.accessDistanceByTile[tileId] === 0) {
          segmentIndexes.add(segmentIndex)
        }
      }
      // Compatibility/override roads need not have a compiled segment. Their
      // canonical tile-centre footprint still must reject intersecting kits.
      if (canonicalRoad && distanceFromPointToAabb(x, y, minX, minY, maxX, maxY) <= 0.255) {
        return true
      }

      const junction = junctions.get(tileId)
      if (junction) {
        let maxHalfWidth = 0.21
        for (const id of junction.segmentIds) {
          const segment = segmentLookup.get(id)
          if (segment) maxHalfWidth = Math.max(maxHalfWidth, segment.profile.halfWidth)
        }
        // The surface layer renders both a 1.18x shoulder and a 1.45x
        // junction reach. Use that same circumscribed footprint here.
        const reach = maxHalfWidth * 1.18 * 1.45
        if (distanceFromPointToAabb(
          junction.x - 0.5,
          junction.y - 0.5,
          minX,
          minY,
          maxX,
          maxY,
        ) <= reach) return true
      }
    }
  }

  for (const index of segmentIndexes) {
    const segment = network.segments[index]
    if (!segment) continue
    const radius = segment.profile.halfWidth * 1.18
    for (let pointIndex = 1; pointIndex < segment.points.length; pointIndex++) {
      const a = segment.points[pointIndex - 1]!
      const b = segment.points[pointIndex]!
      if (segmentIntersectsAabb(
        a.x - 0.5,
        a.y - 0.5,
        b.x - 0.5,
        b.y - 0.5,
        minX - radius,
        minY - radius,
        maxX + radius,
        maxY + radius,
      )) return true
    }
  }
  return false
}

function decorationFootprintHalfExtents(archetypeId: number): readonly [number, number] {
  // Authored town kits deliberately vary beyond the nominal tile silhouette;
  // their peripheral trees, benches and fences are part of the same mesh.
  if (AUTHORED_RESIDENTIAL_ARCHETYPES.includes(archetypeId as never) ||
    AUTHORED_URBAN_ARCHETYPES.includes(archetypeId as never) ||
    AUTHORED_INDUSTRIAL_ARCHETYPES.includes(archetypeId as never)) return [0.58, 0.58]
  return [0.5, 0.5]
}

function distanceFromPointToAabb(
  x: number,
  y: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  const dx = Math.max(minX - x, 0, x - maxX)
  const dy = Math.max(minY - y, 0, y - maxY)
  return Math.hypot(dx, dy)
}

function segmentIntersectsAabb(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  let lower = 0
  let upper = 1
  const dx = x1 - x0
  const dy = y1 - y0
  for (const [p, q] of [
    [-dx, x0 - minX], [dx, maxX - x0],
    [-dy, y0 - minY], [dy, maxY - y0],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const ratio = q / p
    if (p < 0) lower = Math.max(lower, ratio)
    else upper = Math.min(upper, ratio)
    if (lower > upper) return false
  }
  return true
}

function emptyDelta(replaceSource: boolean): RenderSourceDelta {
  return {
    replaceSource,
    entireSurface: false,
    surfaceTileIds: [],
    chunkIds: [],
    journalBacklog: 0,
  }
}

function selectedToId(selected: SelectedTile, width: number, height: number): TileId | null {
  if (!selected) return null
  return idAt(selected.x, selected.y, width, height)
}

function idAt(x: number, y: number, width: number, height: number): TileId | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    return null
  }
  return y * width + x
}

function indexLegacyTiles(state: SimState): Array<MapTile | undefined> {
  const indexed = new Array<MapTile | undefined>(state.map.width * state.map.height)
  for (const tile of state.map.tiles) {
    const id = idAt(tile.x, tile.y, state.map.width, state.map.height)
    if (id !== null) indexed[id] = tile
  }
  return indexed
}

function indexLegacyCampuses(
  tiles: readonly (MapTile | undefined)[],
): Map<string, LegacyCampusProjection> {
  const grouped = new Map<string, Array<{ tileId: number; tile: MapTile }>>()
  for (let tileId = 0; tileId < tiles.length; tileId++) {
    const tile = tiles[tileId]
    if (!tile?.campusId || !isFacilityKind(tile.kind)) continue
    const cells = grouped.get(tile.campusId) ?? []
    cells.push({ tileId, tile })
    grouped.set(tile.campusId, cells)
  }

  const campuses = new Map<string, LegacyCampusProjection>()
  for (const [id, cells] of grouped) {
    const anchorCell = cells.find(({ tile }) => tile.campusRole === 'anchor') ?? cells[0]!
    const minX = Math.min(...cells.map(({ tile }) => tile.x))
    const minY = Math.min(...cells.map(({ tile }) => tile.y))
    const maxX = Math.max(...cells.map(({ tile }) => tile.x))
    const maxY = Math.max(...cells.map(({ tile }) => tile.y))
    const centerX = (minX + maxX) * 0.5
    const centerY = (minY + maxY) * 0.5
    let renderTileId = anchorCell.tileId
    let bestDistance = Infinity
    for (const cell of cells) {
      const distance = (cell.tile.x - centerX) ** 2 + (cell.tile.y - centerY) ** 2
      if (distance < bestDistance) {
        bestDistance = distance
        renderTileId = cell.tileId
      }
    }
    campuses.set(id, {
      id,
      anchorId: anchorCell.tileId,
      anchor: anchorCell.tile,
      renderTileId,
      minX,
      minY,
      maxX,
      maxY,
    })
  }
  return campuses
}

function legacyVisualSignature(tile: MapTile | undefined): string {
  if (!tile) return ''
  return [
    tile.kind,
    tile.owner,
    tile.level,
    tile.buildingProgress,
    tile.buildingTarget,
    tile.powered === false ? 0 : 1,
    tile.campusId ?? '',
    tile.campusRole ?? '',
    tile.dcSize ?? '',
    tile.hqSize ?? '',
    tile.regionId,
  ].join(':')
}

function compactSurfaceKind(kind: number): number {
  switch (kind) {
    case TERRAIN_KIND.road: return SurfaceKind.road
    case TERRAIN_KIND.city: return SurfaceKind.city
    case TERRAIN_KIND.lake: return SurfaceKind.lake
    case TERRAIN_KIND.park: return SurfaceKind.park
    case TERRAIN_KIND.forest: return SurfaceKind.forest
    case TERRAIN_KIND.house: return SurfaceKind.house
    case TERRAIN_KIND.warehouse: return SurfaceKind.warehouse
    default: return SurfaceKind.grass
  }
}

function compactTileKind(kind: number): TileKind {
  switch (kind) {
    case TERRAIN_KIND.road: return 'road'
    case TERRAIN_KIND.city: return 'city'
    case TERRAIN_KIND.lake: return 'lake'
    case TERRAIN_KIND.park: return 'park'
    case TERRAIN_KIND.forest: return 'forest'
    case TERRAIN_KIND.house: return 'house'
    case TERRAIN_KIND.warehouse: return 'warehouse'
    default: return 'empty'
  }
}

function legacySurfaceKind(kind: TileKind): number {
  switch (kind) {
    case 'road': return SurfaceKind.road
    case 'city': return SurfaceKind.city
    case 'lake': return SurfaceKind.lake
    case 'park': return SurfaceKind.park
    case 'forest': return SurfaceKind.forest
    case 'house': return SurfaceKind.house
    case 'warehouse': return SurfaceKind.warehouse
    default: return SurfaceKind.grass
  }
}

function isSceneryKind(kind: TileKind): boolean {
  return (
    kind === 'road' ||
    kind === 'city' ||
    kind === 'lake' ||
    kind === 'park' ||
    kind === 'forest' ||
    kind === 'house' ||
    kind === 'warehouse'
  )
}

function isFacilityKind(kind: TileKind): boolean {
  return kind !== 'empty' && !isSceneryKind(kind)
}

function isBroadEnvironmentKind(kind: TileKind): boolean {
  return kind === 'empty' || kind === 'forest' || kind === 'park'
}

function sceneryInstance(
  tileId: number,
  x: number,
  y: number,
  kind: TileKind,
  _tier: LodTier,
  neighborMask = 0,
  settlementDensity = 0,
  terrainY = 0,
  biome: RenderBiomeId = RenderBiome.plains,
  worldSeed = 0,
  hasEnvironmentClearance = true,
): RenderInstance | null {
  const random = mix32((tileId + 1) ^ Math.imul(worldSeed, 0x9e37_79b1))
  const yaw = hashUnit(random ^ 0x7f4a_7c15) * Math.PI * 2
  const base = {
    entityId: tileId + 1,
    pickTileId: tileId,
    x: x * MAP_TILE_SIZE,
    y: terrainY + 0.012,
    z: y * MAP_TILE_SIZE,
    yaw,
  }
  if (kind === 'forest') {
    if (!hasEnvironmentClearance || !acceptsNaturalSpacing(worldSeed, x, y)) return null
    const jitter = naturalJitter(worldSeed, x, y)
    const size = 0.68 + hashUnit(random ^ 0x1656_67b1) * 0.2
    const family = vegetationFamilyForBiome(biome)
    const variant = naturalSpeciesIndex(worldSeed, x, y, biome, family.length)
    return {
      ...base,
      archetypeId: family[variant]!,
      x: (x + jitter.x) * MAP_TILE_SIZE,
      z: (y + jitter.y) * MAP_TILE_SIZE,
      scaleX: size * (0.94 + hashUnit(random ^ 0x68bc_21eb) * 0.12),
      scaleY: 0.74 + hashUnit(random ^ 0x02e5_be93) * 0.3,
      scaleZ: size * (0.94 + hashUnit(random ^ 0x967a_889b) * 0.12),
      color: SCENERY_COLORS.tree,
    }
  }
  if (kind === 'empty') {
    if (!hasEnvironmentClearance) return null
    const roll = Math.floor(hashUnit(random ^ 0xa511_e9b3) * 1024)
    const vegetation = vegetationFamilyForBiome(biome)
    const patchDensity = naturalPatchDensity(worldSeed, x, y, biome)
    const vegetationThreshold = Math.round(biomeVegetationThreshold(biome) * patchDensity)
    if (roll < vegetationThreshold && acceptsNaturalSpacing(worldSeed, x, y)) {
      const jitter = naturalJitter(worldSeed, x, y)
      const size = 0.62 + hashUnit(random ^ 0x27d4_eb2f) * 0.22
      return {
        ...base,
        x: (x + jitter.x) * MAP_TILE_SIZE,
        z: (y + jitter.y) * MAP_TILE_SIZE,
        archetypeId: vegetation[naturalSpeciesIndex(worldSeed, x, y, biome, vegetation.length)]!,
        scaleX: size,
        scaleY: 0.7 + hashUnit(random ^ 0x85eb_ca6b) * 0.32,
        scaleZ: size * (0.92 + hashUnit(random ^ 0xc2b2_ae35) * 0.16),
        color: SCENERY_COLORS.tree,
      }
    }
    const detailThreshold = biomeDetailThreshold(biome)
    const detailRoll = Math.floor(hashUnit(random ^ 0xd1b5_4a35) * 1024)
    const common = {
      ...base,
      color: 0xffffff,
      scaleX: 0.8 + ((random >>> 10) & 0x7f) / 300,
      scaleY: 0.86 + ((random >>> 17) & 0x7f) / 420,
      scaleZ: 0.8 + ((random >>> 24) & 0x7f) / 300,
    }
    if (detailRoll < detailThreshold && acceptsGroundDetailSpacing(worldSeed, x, y)) {
      const details = terrainFamilyForBiome(biome)
      const detail = selectNaturalGroundDetail(details, worldSeed, x, y, biome)
      const jitter = naturalJitter(worldSeed ^ 0x3c6e_f372, x, y)
      return {
        ...common,
        x: (x + jitter.x) * MAP_TILE_SIZE,
        z: (y + jitter.y) * MAP_TILE_SIZE,
        archetypeId: detail,
        scaleX: isRockDetail(detail) ? common.scaleX * 0.72 : common.scaleX,
        scaleY: isRockDetail(detail) ? common.scaleY * 0.68 : common.scaleY,
        scaleZ: isRockDetail(detail) ? common.scaleZ * 0.72 : common.scaleZ,
      }
    }
  }
  if (kind === 'house') {
    const variant = (((neighborMask >>> 4) & 0x0f) + settlementDensity + random) % AUTHORED_RESIDENTIAL_ARCHETYPES.length
    return {
      ...base,
      archetypeId: AUTHORED_RESIDENTIAL_ARCHETYPES[variant]!,
      scaleX: 0.98,
      scaleY: 0.94 + ((random >>> 12) & 0x7f) / 900,
      scaleZ: 0.98,
      color: SCENERY_COLORS.house,
    }
  }
  if (kind === 'city') {
    const district = (((neighborMask >>> 4) & 0x0f) + settlementDensity + random) % AUTHORED_URBAN_ARCHETYPES.length
    const height = 0.92 + ((random >>> 8) & 0xff) / 720
    return {
      ...base,
      archetypeId: AUTHORED_URBAN_ARCHETYPES[district]!,
      scaleX: 0.98,
      scaleY: height,
      scaleZ: 0.98,
      color: (random & 1) === 0 ? SCENERY_COLORS.cityA : SCENERY_COLORS.cityB,
    }
  }
  if (kind === 'warehouse') {
    const variant = (((neighborMask >>> 4) & 0x0f) + settlementDensity + random) % AUTHORED_INDUSTRIAL_ARCHETYPES.length
    return {
      ...base,
      archetypeId: AUTHORED_INDUSTRIAL_ARCHETYPES[variant]!,
      scaleX: 0.98,
      scaleY: 0.96,
      scaleZ: 0.98,
      color: SCENERY_COLORS.warehouse,
    }
  }
  if (kind === 'park') {
    if (!hasEnvironmentClearance) return null
    return {
      ...base,
      archetypeId: SceneryArchetype.park,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      color: 0xffffff,
    }
  }
  if (kind === 'lake') {
    const interior = (neighborMask & 0x0f) === 0x0f
    if (interior && (random & 3) !== 0) return null
    return {
      ...base,
      archetypeId: interior ? SceneryArchetype.lakeInterior : SceneryArchetype.lakeEdge,
      yaw: interior ? yaw : lakeEdgeYaw(neighborMask),
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      color: 0xffffff,
    }
  }
  if (kind === 'road') {
    if (((x + y) & 3) !== 0 && (random & 0xff) < 159) return null
    const eastConnected = (neighborMask & 2) !== 0
    const southConnected = (neighborMask & 4) !== 0
    return {
      ...base,
      archetypeId: SceneryArchetype.roadLamp,
      x: (x + (eastConnected ? -0.32 : 0.32)) * MAP_TILE_SIZE,
      z: (y + (southConnected ? -0.32 : 0.32)) * MAP_TILE_SIZE,
      yaw: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      color: 0xffffff,
    }
  }
  return null
}

const FOREST_VEGETATION = [414, 415, 416, 417, 418, 419, 420, 421, 429, 430, 431] as const
const ARID_VEGETATION = [424, 425, 426, 428] as const
const WETLAND_VEGETATION = [418, 419, 422, 423, 427, 429, 431] as const
const ALPINE_VEGETATION = [414, 415, 416, 424, 428, 430] as const
const COAST_VEGETATION = [422, 423, 426, 427, 429] as const
const MEADOW_VEGETATION = [418, 419, 421, 422, 427, 429, 431] as const
const BOREAL_VEGETATION = [414, 415, 416, 420, 428, 430] as const
const SCRUBLAND_VEGETATION = [424, 425, 426, 427, 428, 431] as const
const FOREST_DETAILS = [403, 407, 408, 411, 412, 413] as const
const ARID_DETAILS = [402, 404, 406, 413] as const
const WETLAND_DETAILS = [403, 409, 410, 412] as const
const ALPINE_DETAILS = [404, 405, 407, 413] as const
const COAST_DETAILS = [401, 404, 409, 410, 412] as const
const MEADOW_DETAILS = [403, 408, 409, 411, 412] as const
const BOREAL_DETAILS = [403, 404, 407, 408, 413] as const
const SCRUBLAND_DETAILS = [402, 404, 406, 411, 413] as const

/** @internal Deterministic biome palette used by chunk projection and focused tests. */
export function vegetationFamilyForBiome(biome: number): readonly number[] {
  switch (biome) {
    case RenderBiome.forest: return FOREST_VEGETATION
    case RenderBiome.arid: return ARID_VEGETATION
    case RenderBiome.wetland: return WETLAND_VEGETATION
    case RenderBiome.alpine: return ALPINE_VEGETATION
    case RenderBiome.coast: return COAST_VEGETATION
    case RenderBiome.meadow: return MEADOW_VEGETATION
    case RenderBiome.boreal: return BOREAL_VEGETATION
    case RenderBiome.scrubland: return SCRUBLAND_VEGETATION
    default:
      return AUTHORED_VEGETATION_ARCHETYPES
  }
}

/** @internal Deterministic ground-detail palette used by chunk projection and focused tests. */
export function terrainFamilyForBiome(biome: number): readonly number[] {
  switch (biome) {
    case RenderBiome.forest: return FOREST_DETAILS
    case RenderBiome.arid: return ARID_DETAILS
    case RenderBiome.wetland: return WETLAND_DETAILS
    case RenderBiome.alpine: return ALPINE_DETAILS
    case RenderBiome.coast: return COAST_DETAILS
    case RenderBiome.meadow: return MEADOW_DETAILS
    case RenderBiome.boreal: return BOREAL_DETAILS
    case RenderBiome.scrubland: return SCRUBLAND_DETAILS
    default: return AUTHORED_TERRAIN_ARCHETYPES
  }
}

/** Thresholds are out of 1024 stable hash values; no viewport state affects density. */
export function biomeVegetationThreshold(biome: number): number {
  if (biome === RenderBiome.forest) return 310
  if (biome === RenderBiome.wetland) return 138
  if (biome === RenderBiome.boreal) return 265
  if (biome === RenderBiome.meadow) return 112
  if (biome === RenderBiome.scrubland) return 54
  return 0
}

export function biomeDetailThreshold(biome: number): number {
  if (biome === RenderBiome.forest) return 52
  if (biome === RenderBiome.wetland) return 38
  if (biome === RenderBiome.alpine) return 62
  if (biome === RenderBiome.arid) return 46
  if (biome === RenderBiome.coast) return 35
  if (biome === RenderBiome.meadow) return 48
  if (biome === RenderBiome.boreal) return 44
  if (biome === RenderBiome.scrubland) return 55
  return 18
}

/** Smooth deterministic density field: broad patches, soft edges and clearings. */
export function naturalPatchDensity(seed: number, x: number, y: number, biome: number): number {
  if (biome !== RenderBiome.forest && biome !== RenderBiome.wetland &&
    biome !== RenderBiome.boreal && biome !== RenderBiome.meadow &&
    biome !== RenderBiome.scrubland) return 0
  const broad = valueNoise(seed ^ 0x6a09_e667, x / 23, y / 23)
  const local = valueNoise(seed ^ 0xbb67_ae85, x / 8, y / 8)
  const combined = broad * 0.68 + local * 0.32
  const biomeBias = biome === RenderBiome.forest ? 0.12
    : biome === RenderBiome.boreal ? 0.04
      : biome === RenderBiome.meadow ? -0.18
        : biome === RenderBiome.scrubland ? -0.24 : -0.08
  // Smoothstep turns the middle of the field into recognizable forest edges
  // while preserving occasional enclosed clearings.
  const edge = smooth01((combined + biomeBias - 0.34) / 0.48)
  return edge * edge * (3 - 2 * edge) * 1.32
}

/**
 * One stable jittered candidate per tile with local conflict rejection. This
 * is a compact Poisson-like sampler: it avoids rows and near-collisions while
 * requiring no retained point set or viewport-dependent generation.
 */
export function acceptsNaturalSpacing(seed: number, x: number, y: number): boolean {
  const point = naturalJitter(seed, x, y)
  const priority = coordinateHash(seed ^ 0x510e_527f, x, y)
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue
      const other = naturalJitter(seed, x + ox, y + oy)
      const dx = ox + other.x - point.x
      const dy = oy + other.y - point.y
      if (dx * dx + dy * dy >= 0.62 * 0.62) continue
      const otherPriority = coordinateHash(seed ^ 0x510e_527f, x + ox, y + oy)
      if (otherPriority > priority || (otherPriority === priority && (oy < 0 || (oy === 0 && ox < 0)))) {
        return false
      }
    }
  }
  return true
}

function acceptsGroundDetailSpacing(seed: number, x: number, y: number): boolean {
  return acceptsNaturalSpacing(seed ^ 0xa54f_f53a, x, y)
}

function naturalJitter(seed: number, x: number, y: number): { x: number; y: number } {
  const hash = coordinateHash(seed ^ 0x1f83_d9ab, x, y)
  return {
    x: (hashUnit(hash) - 0.5) * 0.42,
    y: (hashUnit(hash ^ 0x5be0_cd19) - 0.5) * 0.42,
  }
}

function naturalSpeciesIndex(seed: number, x: number, y: number, biome: number, count: number): number {
  const grove = coordinateHash(seed ^ Math.imul(biome + 1, 0x45d9_f3b), Math.floor(x / 6), Math.floor(y / 6))
  const local = coordinateHash(seed ^ 0x243f_6a88, x, y)
  // Most trees follow their grove's dominant family; roughly one quarter are
  // stable edge/understory variants so stands do not become monocultures.
  return (local & 3) === 0 ? local % count : grove % count
}

function selectNaturalGroundDetail(
  details: readonly number[],
  seed: number,
  x: number,
  y: number,
  biome: number,
): number {
  const hash = coordinateHash(seed ^ 0x3c6e_f372, x, y)
  const rockChance = biome === RenderBiome.alpine ? 0.16 : biome === RenderBiome.arid ? 0.07 : 0.018
  const rocks = details.filter(isRockDetail)
  const soft = details.filter(detail => !isRockDetail(detail))
  if (rocks.length > 0 && hashUnit(hash ^ 0x9b05_688c) < rockChance) return rocks[hash % rocks.length]!
  const palette = soft.length > 0 ? soft : details
  return palette[hash % palette.length]!
}

/** @internal exported for focused density/rock-budget tests. */
export function isRockDetail(archetypeId: number): boolean {
  return archetypeId === SceneryArchetype.groundRock ||
    archetypeId === SceneryArchetype.forestRocky ||
    archetypeId === AuthoredSceneryArchetype.pebbleGroup ||
    archetypeId === AuthoredSceneryArchetype.graniteOutcrop ||
    archetypeId === AuthoredSceneryArchetype.sandstoneOutcrop ||
    archetypeId === AuthoredSceneryArchetype.hillBoulders
}

function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = smooth01(x - x0)
  const ty = smooth01(y - y0)
  const nw = hashUnit(coordinateHash(seed, x0, y0))
  const ne = hashUnit(coordinateHash(seed, x0 + 1, y0))
  const sw = hashUnit(coordinateHash(seed, x0, y0 + 1))
  const se = hashUnit(coordinateHash(seed, x0 + 1, y0 + 1))
  const north = nw + (ne - nw) * tx
  const south = sw + (se - sw) * tx
  return north + (south - north) * ty
}

function coordinateHash(seed: number, x: number, y: number): number {
  return mix32(seed ^ Math.imul(x, 0x1e35_a7bd) ^ Math.imul(y, 0x94d0_49bb))
}

function hashUnit(hash: number): number {
  return (hash >>> 0) / 0x1_0000_0000
}

function smooth01(value: number): number {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

function lakeEdgeYaw(neighborMask: number): number {
  if ((neighborMask & 1) === 0) return 0
  if ((neighborMask & 2) === 0) return -Math.PI / 2
  if ((neighborMask & 4) === 0) return Math.PI
  if ((neighborMask & 8) === 0) return Math.PI / 2
  return 0
}

function facilitySize(
  kind: string,
  data: Readonly<Record<string, unknown>> | { dcSize?: string; hqSize?: string } | undefined,
): 'small' | 'medium' | 'large' {
  const explicit = data?.dcSize ?? data?.hqSize
  if (explicit === 'medium' || explicit === 'large') return explicit
  if (kind === 'dc_l' || kind === 'hq_l') return 'large'
  if (kind === 'dc_m' || kind === 'hq_m') return 'medium'
  return 'small'
}

export function facilityArchetypeFor(
  kind: string,
  size: 'small' | 'medium' | 'large',
): number {
  if (kind === 'hq_l' || (kind === 'hq' && size === 'large')) return IntegrationArchetype.headquarters
  if (kind === 'hq_m' || (kind === 'hq' && size === 'medium')) {
    return FacilityArchetype.headquartersMedium
  }
  if (kind === 'hq') return FacilityArchetype.headquartersSmall
  if (kind === 'office') return FacilityArchetype.office
  if (kind === 'solar') return IntegrationArchetype.solar
  if (kind === 'substation') return IntegrationArchetype.grid
  if (kind === 'battery') return FacilityArchetype.battery
  if (kind === 'gas') return FacilityArchetype.gas
  if (kind === 'nuclear') return IntegrationArchetype.generation
  if (kind === 'fab') return IntegrationArchetype.fabrication
  if (kind === 'cooling') return IntegrationArchetype.campusSupport
  if (kind === 'lab') return FacilityArchetype.lab
  if (size === 'large') return DefaultArchetype.facilityLarge
  if (size === 'medium') return DefaultArchetype.facilityMedium
  return DefaultArchetype.facilitySmall
}

function constructionScale(progress: number, target: number): number {
  if (target <= 0 || progress >= target) return 1
  return Math.max(0.08, Math.min(1, progress / target))
}

function stableStringId(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function mix32(value: number): number {
  let result = value | 0
  result = Math.imul(result ^ (result >>> 16), 0x21f0aaad)
  result = Math.imul(result ^ (result >>> 15), 0x735a2d97)
  return (result ^ (result >>> 15)) >>> 0
}
