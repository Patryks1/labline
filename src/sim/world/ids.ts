import type { ChunkId, TileId, WorldDescriptor } from './types'

function requireInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`)
}

export function tileId(x: number, y: number, width: number, height?: number): TileId {
  requireInteger(x, 'x')
  requireInteger(y, 'y')
  requireInteger(width, 'width')
  if (width <= 0 || x < 0 || x >= width || y < 0 || (height !== undefined && y >= height)) {
    throw new RangeError(`tile coordinates (${x}, ${y}) are outside ${width}x${height ?? '?'}`)
  }
  return (y * width + x) as TileId
}

export function tileCoords(id: TileId, width: number): { x: number; y: number } {
  requireInteger(id, 'tile id')
  requireInteger(width, 'width')
  if (id < 0 || width <= 0) throw new RangeError('tile id and width must be non-negative')
  return { x: id % width, y: Math.floor(id / width) }
}

export function isTileIdInWorld(id: number, world: Pick<WorldDescriptor, 'width' | 'height'>): id is TileId {
  return Number.isSafeInteger(id) && id >= 0 && id < world.width * world.height
}

export function chunkColumns(width: number, chunkSize: number): number {
  requireInteger(width, 'width')
  requireInteger(chunkSize, 'chunk size')
  if (width <= 0 || chunkSize <= 0) throw new RangeError('width and chunk size must be positive')
  return Math.ceil(width / chunkSize)
}

export function chunkId(
  chunkX: number,
  chunkY: number,
  width: number,
  height: number,
  chunkSize = 32,
): ChunkId {
  requireInteger(chunkX, 'chunk x')
  requireInteger(chunkY, 'chunk y')
  const columns = chunkColumns(width, chunkSize)
  const rows = Math.ceil(height / chunkSize)
  if (chunkX < 0 || chunkY < 0 || chunkX >= columns || chunkY >= rows) {
    throw new RangeError(`chunk coordinates (${chunkX}, ${chunkY}) are outside ${columns}x${rows}`)
  }
  return (chunkY * columns + chunkX) as ChunkId
}

export function chunkIdForTile(id: TileId, descriptor: WorldDescriptor): ChunkId {
  const { x, y } = tileCoords(id, descriptor.width)
  return chunkId(
    Math.floor(x / descriptor.chunkSize),
    Math.floor(y / descriptor.chunkSize),
    descriptor.width,
    descriptor.height,
    descriptor.chunkSize,
  )
}

export function chunkCoords(
  id: ChunkId,
  width: number,
  chunkSize = 32,
): { chunkX: number; chunkY: number } {
  requireInteger(id, 'chunk id')
  const columns = chunkColumns(width, chunkSize)
  if (id < 0) throw new RangeError('chunk id must be non-negative')
  return { chunkX: id % columns, chunkY: Math.floor(id / columns) }
}

export function tileBoundsForChunk(
  id: ChunkId,
  descriptor: WorldDescriptor,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const { chunkX, chunkY } = chunkCoords(id, descriptor.width, descriptor.chunkSize)
  const minX = chunkX * descriptor.chunkSize
  const minY = chunkY * descriptor.chunkSize
  return {
    minX,
    minY,
    maxX: Math.min(descriptor.width, minX + descriptor.chunkSize),
    maxY: Math.min(descriptor.height, minY + descriptor.chunkSize),
  }
}

export function cardinalNeighborIds(id: TileId, descriptor: WorldDescriptor): TileId[] {
  const { x, y } = tileCoords(id, descriptor.width)
  const result: TileId[] = []
  if (y > 0) result.push((id - descriptor.width) as TileId)
  if (x + 1 < descriptor.width) result.push((id + 1) as TileId)
  if (y + 1 < descriptor.height) result.push((id + descriptor.width) as TileId)
  if (x > 0) result.push((id - 1) as TileId)
  return result
}
