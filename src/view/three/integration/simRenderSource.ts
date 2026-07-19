import type { BuildableKind, MapTile, SimState, TileKind } from '../../../sim/types'
import {
  TERRAIN_KIND,
  WORLD_CHANGE_FLAGS,
  type DynamicWorld,
  type Facility,
} from '../../../sim/world'
import {
  FacilityArchetype,
  IntegrationArchetype,
  SceneryArchetype,
} from './artDirectedRegistry'
import {
  DefaultArchetype,
  LodTier,
  SurfaceFlag,
  SurfaceKind,
  type ChunkId,
  type RenderInstance,
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

  constructor(
    state: SimState,
    selectedTile: SelectedTile = null,
    _buildMode: BuildableKind | null = null,
  ) {
    this.state = state
    this.width = state.map.width
    this.height = state.map.height
    this.compactWorld = state.map.storage === 'compact' ? state.map.world : undefined
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
        entireSurface = true
        this.invalidateAllChunks(chunkIds)
        this.bumpAllSurfaceRevisions()
      } else {
        journalBacklog = changes.changes.length
        for (const change of changes.changes) {
          for (const tileId of change.tileIds) surfaceTileIds.add(tileId as TileId)
          for (const chunkId of change.chunkIds) {
            chunkIds.add(chunkId as ChunkId)
            this.invalidateChunk(chunkId as ChunkId)
            if ((change.flags & WORLD_CHANGE_FLAGS.terrain) !== 0) {
              this.bumpSurfaceRevision(chunkId as ChunkId)
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
    if (tileId < 0 || tileId >= this.width * this.height) {
      out.kind = SurfaceKind.grass
      out.neighborMask = 0
      out.region = 0
      out.flags = 0
      return
    }

    if (this.compactWorld) {
      const world = this.compactWorld
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
      const owner = this.compactWorld.getOwner(tileId as never)
      return owner !== 'neutral' || this.compactWorld.getKind(tileId as never) === TERRAIN_KIND.empty
    }
    const tile = this.legacyTilesById[tileId]
    return !!tile && !(isSceneryKind(tile.kind) && tile.owner === 'neutral')
  }

  private buildCompactChunk(chunkId: ChunkId, tier: LodTier): readonly RenderInstance[] {
    const world = this.compactWorld!
    const records: RenderInstance[] = []
    const bounds = this.chunkBounds(chunkId)
    for (const facility of world.queryFacilities({ chunkId: chunkId as never })) {
      if (this.facilityRenderChunk(facility) === chunkId) {
        records.push(this.facilityInstance(facility))
      }
    }
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        const tileId = y * this.width + x
        const facility = world.getFacilityAt(tileId as never)
        if (facility) continue
        const terrain = world.getKind(tileId as never)
        const variantMask =
          terrain === TERRAIN_KIND.road || terrain === TERRAIN_KIND.lake
            ? world.getVariantMask(tileId as never) & 0x0f
            : 0
        const scenery = sceneryInstance(
          tileId,
          x,
          y,
          compactTileKind(terrain),
          tier,
          variantMask,
        )
        if (scenery) records.push(scenery)
      }
    }
    return records
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
        const scenery = sceneryInstance(tileId, x, y, tile.kind, tier, variantMask)
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
      archetypeId: facilityArchetypeFor(facility.kind, size),
      x: ((minX + maxX) * 0.5) * MAP_TILE_SIZE,
      y: 0.015,
      z: ((minY + maxY) * 0.5) * MAP_TILE_SIZE,
      yaw: 0,
      scaleX: width * MAP_TILE_SIZE * 0.82,
      scaleY: (0.82 + facility.level * 0.12) * progress,
      scaleZ: height * MAP_TILE_SIZE * 0.82,
      color: this.ownerColor(facility.ownerId),
    }
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

  private legacyFacilityInstance(campus: LegacyCampusProjection): RenderInstance {
    const { anchor: tile } = campus
    const size = facilitySize(tile.kind, { dcSize: tile.dcSize, hqSize: tile.hqSize })
    const progress = constructionScale(tile.buildingProgress, tile.buildingTarget)
    const width = Math.max(1, campus.maxX - campus.minX + 1)
    const height = Math.max(1, campus.maxY - campus.minY + 1)
    return {
      entityId: tile.campusId ? stableStringId(tile.campusId) : campus.anchorId + 0x4000_0000,
      archetypeId: facilityArchetypeFor(tile.kind, size),
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

function sceneryInstance(
  tileId: number,
  x: number,
  y: number,
  kind: TileKind,
  _tier: LodTier,
  neighborMask = 0,
): RenderInstance | null {
  const random = mix32(tileId + 1)
  const yaw = ((random >>> 29) & 3) * (Math.PI / 2)
  const base = {
    entityId: tileId + 1,
    x: x * MAP_TILE_SIZE,
    y: 0.012,
    z: y * MAP_TILE_SIZE,
    yaw,
  }
  if (kind === 'forest') {
    const size = 0.94 + ((random >>> 8) & 0xff) / 2_800
    const variant = random % 3
    return {
      ...base,
      archetypeId:
        variant === 0
          ? DefaultArchetype.tree
          : variant === 1
            ? SceneryArchetype.forestBroadleaf
            : SceneryArchetype.forestMixed,
      scaleX: size,
      scaleY: 0.92 + ((random >>> 16) & 0xff) / 1_500,
      scaleZ: size,
      color: SCENERY_COLORS.tree,
    }
  }
  if (kind === 'house') {
    const variant = random % 3
    return {
      ...base,
      archetypeId:
        variant === 0
          ? DefaultArchetype.house
          : variant === 1
            ? SceneryArchetype.houseDuplex
            : SceneryArchetype.houseTerrace,
      scaleX: 0.98,
      scaleY: 0.94 + ((random >>> 12) & 0x7f) / 900,
      scaleZ: 0.98,
      color: SCENERY_COLORS.house,
    }
  }
  if (kind === 'city') {
    const district = random % 4
    const height = 0.92 + ((random >>> 8) & 0xff) / 720
    return {
      ...base,
      archetypeId:
        district === 0
          ? DefaultArchetype.cityTowerA
          : district === 1
            ? DefaultArchetype.cityTowerB
            : district === 2
              ? SceneryArchetype.cityDistrictC
              : SceneryArchetype.cityDistrictD,
      scaleX: 0.98,
      scaleY: height,
      scaleZ: 0.98,
      color: (random & 1) === 0 ? SCENERY_COLORS.cityA : SCENERY_COLORS.cityB,
    }
  }
  if (kind === 'warehouse') {
    return {
      ...base,
      archetypeId:
        (random & 1) === 0
          ? DefaultArchetype.warehouse
          : SceneryArchetype.warehouseContainers,
      scaleX: 0.98,
      scaleY: 0.96,
      scaleZ: 0.98,
      color: SCENERY_COLORS.warehouse,
    }
  }
  if (kind === 'park') {
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
