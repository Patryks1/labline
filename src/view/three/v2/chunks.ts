import {
  chunkCoords,
  chunkIdAt,
  type ChunkId,
  type TileBounds,
} from './types'

export const DEFAULT_CHUNK_SIZE = 32
export const DEFAULT_RETAINED_CHUNKS = 96

export interface ChunkSelection {
  visible: ReadonlySet<ChunkId>
  prefetch: ReadonlySet<ChunkId>
  resident: ReadonlySet<ChunkId>
  addedVisible: readonly ChunkId[]
  removedVisible: readonly ChunkId[]
  evicted: readonly ChunkId[]
}

interface ResidentRecord {
  lastTouched: number
}

/** Select visible 32x32 chunks plus one non-rendered prefetch ring. */
export class ViewportChunkManager {
  readonly mapWidth: number
  readonly mapHeight: number
  readonly chunkSize: number
  readonly chunksWide: number
  readonly chunksHigh: number
  readonly maxRetained: number

  private visibleSet = new Set<ChunkId>()
  private readonly residentRecords = new Map<ChunkId, ResidentRecord>()
  private clock = 0

  constructor(
    mapWidth: number,
    mapHeight: number,
    chunkSize = DEFAULT_CHUNK_SIZE,
    maxRetained = DEFAULT_RETAINED_CHUNKS,
  ) {
    if (mapWidth < 1 || mapHeight < 1 || chunkSize < 1) {
      throw new RangeError('Map and chunk dimensions must be positive')
    }
    this.mapWidth = Math.floor(mapWidth)
    this.mapHeight = Math.floor(mapHeight)
    this.chunkSize = Math.floor(chunkSize)
    this.chunksWide = Math.ceil(this.mapWidth / this.chunkSize)
    this.chunksHigh = Math.ceil(this.mapHeight / this.chunkSize)
    this.maxRetained = Math.max(1, Math.floor(maxRetained))
  }

  update(bounds: TileBounds): ChunkSelection {
    this.clock++
    const nextVisible = this.selectVisible(bounds)
    const requestedPrefetch = this.selectPrefetch(nextVisible)
    const prefetchCapacity = Math.max(0, this.maxRetained - nextVisible.size)
    const nextPrefetch =
      requestedPrefetch.size <= prefetchCapacity
        ? requestedPrefetch
        : new Set([...requestedPrefetch].sort((a, b) => a - b).slice(0, prefetchCapacity))
    const addedVisible = difference(nextVisible, this.visibleSet)
    const removedVisible = difference(this.visibleSet, nextVisible)
    const protectedIds = new Set<ChunkId>([...nextVisible, ...nextPrefetch])

    for (const id of protectedIds) {
      const record = this.residentRecords.get(id)
      if (record) record.lastTouched = this.clock
      else this.residentRecords.set(id, { lastTouched: this.clock })
    }

    const evicted: ChunkId[] = []
    if (this.residentRecords.size > this.maxRetained) {
      const candidates = [...this.residentRecords.entries()]
        .filter(([id]) => !protectedIds.has(id))
        .sort((a, b) => a[1].lastTouched - b[1].lastTouched)
      for (const [id] of candidates) {
        if (this.residentRecords.size <= this.maxRetained) break
        this.residentRecords.delete(id)
        evicted.push(id)
      }
    }

    this.visibleSet = nextVisible
    return {
      visible: new Set(nextVisible),
      prefetch: new Set(nextPrefetch),
      resident: new Set(this.residentRecords.keys()),
      addedVisible,
      removedVisible,
      evicted,
    }
  }

  chunkBounds(chunkId: ChunkId): TileBounds {
    const { chunkX, chunkY } = chunkCoords(chunkId, this.chunksWide)
    if (chunkX < 0 || chunkY < 0 || chunkX >= this.chunksWide || chunkY >= this.chunksHigh) {
      throw new RangeError(`Chunk ${chunkId} is outside the map`)
    }
    return {
      minX: chunkX * this.chunkSize,
      maxX: Math.min(this.mapWidth, (chunkX + 1) * this.chunkSize),
      minY: chunkY * this.chunkSize,
      maxY: Math.min(this.mapHeight, (chunkY + 1) * this.chunkSize),
    }
  }

  private selectVisible(bounds: TileBounds): Set<ChunkId> {
    const minX = Math.max(0, Math.min(this.mapWidth, bounds.minX))
    const maxX = Math.max(0, Math.min(this.mapWidth, bounds.maxX))
    const minY = Math.max(0, Math.min(this.mapHeight, bounds.minY))
    const maxY = Math.max(0, Math.min(this.mapHeight, bounds.maxY))
    const result = new Set<ChunkId>()
    if (maxX <= minX || maxY <= minY) return result

    const firstX = Math.floor(minX / this.chunkSize)
    const lastX = Math.floor((Math.ceil(maxX) - 1) / this.chunkSize)
    const firstY = Math.floor(minY / this.chunkSize)
    const lastY = Math.floor((Math.ceil(maxY) - 1) / this.chunkSize)
    for (let chunkY = firstY; chunkY <= lastY; chunkY++) {
      for (let chunkX = firstX; chunkX <= lastX; chunkX++) {
        result.add(chunkIdAt(chunkX, chunkY, this.chunksWide))
      }
    }
    return result
  }

  private selectPrefetch(visible: ReadonlySet<ChunkId>): Set<ChunkId> {
    const result = new Set<ChunkId>()
    for (const id of visible) {
      const { chunkX, chunkY } = chunkCoords(id, this.chunksWide)
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = chunkX + dx
          const y = chunkY + dy
          if (x < 0 || y < 0 || x >= this.chunksWide || y >= this.chunksHigh) continue
          const neighbor = chunkIdAt(x, y, this.chunksWide)
          if (!visible.has(neighbor)) result.add(neighbor)
        }
      }
    }
    return result
  }
}

function difference(a: ReadonlySet<ChunkId>, b: ReadonlySet<ChunkId>): ChunkId[] {
  const result: ChunkId[] = []
  for (const id of a) if (!b.has(id)) result.push(id)
  return result
}
