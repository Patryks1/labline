/** Numeric identifiers keep render-side indexing allocation-free. */
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

/** Alpha-channel bit flags in the RGBA8 surface-state texture. */
export const SurfaceFlag = {
  playerOwned: 1 << 0,
  rivalOwned: 1 << 1,
  selected: 1 << 2,
  constructing: 1 << 3,
  buildable: 1 << 4,
  powered: 1 << 5,
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
  /** Cardinal auto-tile mask: N=1, E=2, S=4, W=8. */
  neighborMask: number
  /** Region/palette index, 0..255. */
  region: number
  /** SurfaceFlag bit field. */
  flags: number
}

export interface RenderInstance {
  entityId: EntityId
  archetypeId: ArchetypeId
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

/**
 * The renderer deliberately consumes a read-only projection of the world.
 * Player and rival facilities use the same instance shape and code path; the
 * simulation remains the sole owner of placement and progression rules.
 */
export interface ViewportRenderSource {
  readonly width: number
  readonly height: number
  readonly tileSize: number

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
