/** Numeric identifiers keep render-side indexing allocation-free. */
import type { TransportRuntimeState } from '../../../sim/types'
import type { RoadNetworkSnapshot } from '../../../sim/world'

export type TileId = number
export type ChunkId = number
export type EntityId = number
export type ArchetypeId = number

export const SurfaceKind = {
  grass: 0,
  road: 1,
  city: 2,
  lake: 3,
  park: 4,
  forest: 5,
  house: 6,
  warehouse: 7,
  facility: 8,
} as const

export type SurfaceKindId = (typeof SurfaceKind)[keyof typeof SurfaceKind]

/** V4 biome IDs mirror the immutable simulation layer without coupling view types to sim. */
export const RenderBiome = {
  plains: 0,
  forest: 1,
  arid: 2,
  wetland: 3,
  alpine: 4,
  coast: 5,
  meadow: 6,
  boreal: 7,
  scrubland: 8,
} as const

export type RenderBiomeId = (typeof RenderBiome)[keyof typeof RenderBiome]

/** Alpha-channel bit flags in the RGBA8 surface-state texture. */
export const SurfaceFlag = {
  playerOwned: 1 << 0,
  rivalOwned: 1 << 1,
  selected: 1 << 2,
  constructing: 1 << 3,
  buildable: 1 << 4,
  powered: 1 << 5,
} as const

/** Low byte topology order used by compact-world v3 transport data. */
export const TransportTopology = {
  north: 1 << 0,
  northEast: 1 << 1,
  east: 1 << 2,
  southEast: 1 << 3,
  south: 1 << 4,
  southWest: 1 << 5,
  west: 1 << 6,
  northWest: 1 << 7,
} as const

/** Bits in the transport visual byte (packed transport bits 8..15). */
export const TransportVisual = {
  classMask: 0b111,
  none: 0,
  local: 1,
  collector: 2,
  arterial: 3,
  highway: 4,
  bridge: 1 << 3,
  settlement: 1 << 4,
  regional: 1 << 5,
} as const

export const LodTier = {
  near: 'near',
  mid: 'mid',
  far: 'far',
} as const

export type LodTier = (typeof LodTier)[keyof typeof LodTier]

export const LOD_TIERS: readonly LodTier[] = [LodTier.near, LodTier.mid, LodTier.far]

export interface SurfaceTexel {
  /** Numeric SurfaceKind value. */
  kind: number
  /** Legacy cardinal mask, or v3 8-way transport topology. */
  neighborMask: number
  /** Region/palette index, 0..255. */
  region: number
  /** SurfaceFlag bit field. */
  flags: number
  /** Optional packed v3 transport: topology low 8 bits, visual style next 8. */
  transport?: number
}

export interface RenderInstance {
  entityId: EntityId
  archetypeId: ArchetypeId
  /** Logical cell selected when this visible instance is clicked. */
  pickTileId?: TileId
  /** World-space position. */
  x: number
  y: number
  z: number
  /** Rotation around world up, in radians. */
  yaw: number
  scaleX: number
  scaleY: number
  scaleZ: number
  /** Linear RGB packed as 0xRRGGBB. */
  color: number
}

export interface RenderMunicipalPowerPlant {
  readonly id: number
  readonly kind: 'coal' | 'wind' | 'solar' | 'nuclear'
  readonly tileX: number
  readonly tileY: number
  readonly x: number
  readonly y: number
  readonly z: number
  readonly phase: number
  /** Authoritative generator-owned campus footprint, used for visibility. */
  readonly footprintTileIds: readonly TileId[]
  /** Authoritative V6 solar panel transforms; empty for legacy campuses. */
  readonly panels: readonly {
    readonly tileId: TileId
    readonly x: number
    readonly y: number
    readonly z: number
    readonly yaw: number
  }[]
}

/**
 * The renderer deliberately consumes a read-only projection of the world.
 * Player and rival facilities use the same instance shape and code path; the
 * simulation remains the sole owner of placement and progression rules.
 */
export interface ViewportRenderSource {
  readonly width: number
  readonly height: number
  readonly tileSize: number

  /** True only for worlds that should render transport as physical ribbons. */
  readonly useHeightfieldRoadMeshes?: boolean

  /** Shared immutable transport graph used by road rendering and traffic. */
  getRoadNetwork?(): RoadNetworkSnapshot | undefined

  /** Changes only when packed transport topology changes. */
  getRoadNetworkRevision?(): number

  /** Canonical daily congestion used only to tune visual traffic density/speed. */
  getTransportRuntimeState?(): Readonly<TransportRuntimeState> | undefined

  /** Immutable V5 utility campuses used by the shader-driven effects layer. */
  getMunicipalPowerPlants?(): readonly RenderMunicipalPowerPlant[]

  /** Simulation pause freezes the fixed-step visual traffic clock. */
  isSimulationPaused?(): boolean

  /** World-space Y at a shared terrain corner. Coordinates are 0..width/height. */
  getCornerElevation?(x: number, y: number): number

  /** World-space Y at a tile centre. Flat compatibility sources return zero. */
  getTileElevation?(x: number, y: number): number

  /** Stable water plane for the connected lake containing this tile. */
  getWaterElevation?(x: number, y: number): number

  /** Immutable biome classification. Flat V2/V3 compatibility sources use plains. */
  getBiome?(x: number, y: number): RenderBiomeId

  /** Derived render-only footprint, such as a multi-tile ambient skyscraper. */
  getSelectionFootprint?(x: number, y: number): readonly { x: number; y: number }[] | undefined

  /** Write one tile's four numeric channels into a reusable output object. */
  readSurface(tileId: TileId, out: SurfaceTexel): void

  /**
   * Return a stable chunk snapshot, or null while it is being prepared.
   * Implementations should return the same array identity until the revision
   * changes so the renderer can avoid rebuilding instance buffers.
   */
  getChunkInstances(chunkId: ChunkId, tier: LodTier): readonly RenderInstance[] | null

  /** Monotonic per-chunk revision shared by player and rival mutations. */
  getChunkRevision(chunkId: ChunkId): number

  /** Optional terrain-topology revision for surface-derived decoration. */
  getSurfaceRevision?(chunkId: ChunkId): number

  /** Optional non-blocking request used for the visible set and prefetch ring. */
  prepareChunk?(chunkId: ChunkId, tier: LodTier): void
}

export interface TileBounds {
  /** Inclusive minimum and exclusive maximum tile coordinates. */
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function tileIdAt(x: number, y: number, width: number): TileId {
  return y * width + x
}

export function tileCoords(tileId: TileId, width: number): { x: number; y: number } {
  return { x: tileId % width, y: Math.floor(tileId / width) }
}

export function chunkIdAt(chunkX: number, chunkY: number, chunksWide: number): ChunkId {
  return chunkY * chunksWide + chunkX
}

export function chunkCoords(
  chunkId: ChunkId,
  chunksWide: number,
): { chunkX: number; chunkY: number } {
  return {
    chunkX: chunkId % chunksWide,
    chunkY: Math.floor(chunkId / chunksWide),
  }
}

export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}
