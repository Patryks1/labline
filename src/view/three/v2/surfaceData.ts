import * as THREE from 'three'
import { clampByte, tileCoords, type SurfaceTexel, type TileId } from './types'

export interface SurfaceUpdateRange {
  /** Component offset, matching Three.js Texture.addUpdateRange. */
  start: number
  /** Component count, always a multiple of four for RGBA8. */
  count: number
  row: number
}

export interface SurfaceUploadBatch {
  ranges: readonly SurfaceUpdateRange[]
  bytes: number
  tiles: number
}

interface DirtySpan {
  minX: number
  maxX: number
}

/**
 * CPU mirror and partial-upload coordinator for the one-texel-per-tile RGBA8
 * state texture. The texture remains nearest-filtered because its channels are
 * categorical data, not artwork.
 */
export class SurfaceDataTexture {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  readonly texture: THREE.DataTexture

  private readonly dirtyRows = new Map<number, DirtySpan>()
  private dirtyTiles = 0

  constructor(width: number, height: number, data?: Uint8Array) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`Invalid surface dimensions ${width}x${height}`)
    }
    const expected = width * height * 4
    if (data && data.length !== expected) {
      throw new RangeError(`Surface buffer has ${data.length} bytes; expected ${expected}`)
    }

    this.width = width
    this.height = height
    this.data = data ?? new Uint8Array(expected)
    this.texture = new THREE.DataTexture(
      this.data,
      width,
      height,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    )
    this.texture.name = 'map-surface-state-rgba8'
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.texture.unpackAlignment = 1
    // With no update ranges, the initial upload is the complete texture.
    this.texture.needsUpdate = true
  }

  get tileCount(): number {
    return this.width * this.height
  }

  set(tileId: TileId, texel: SurfaceTexel): boolean {
    this.assertTileId(tileId)
    const offset = tileId * 4
    const kind = clampByte(texel.kind)
    const mask = clampByte(texel.neighborMask) & 0x0f
    const region = clampByte(texel.region)
    const flags = clampByte(texel.flags)
    if (
      this.data[offset] === kind &&
      this.data[offset + 1] === mask &&
      this.data[offset + 2] === region &&
      this.data[offset + 3] === flags
    ) {
      return false
    }

    this.data[offset] = kind
    this.data[offset + 1] = mask
    this.data[offset + 2] = region
    this.data[offset + 3] = flags
    const { x, y } = tileCoords(tileId, this.width)
    const span = this.dirtyRows.get(y)
    if (span) {
      span.minX = Math.min(span.minX, x)
      span.maxX = Math.max(span.maxX, x)
    } else {
      this.dirtyRows.set(y, { minX: x, maxX: x })
    }
    this.dirtyTiles++
    return true
  }

  get(tileId: TileId, out: SurfaceTexel): SurfaceTexel {
    this.assertTileId(tileId)
    const offset = tileId * 4
    out.kind = this.data[offset]!
    out.neighborMask = this.data[offset + 1]!
    out.region = this.data[offset + 2]!
    out.flags = this.data[offset + 3]!
    return out
  }

  /** Fill the CPU mirror without creating one object per tile. */
  fill(read: (tileId: TileId, out: SurfaceTexel) => void): void {
    const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let tileId = 0; tileId < this.tileCount; tileId++) {
      read(tileId, out)
      const offset = tileId * 4
      this.data[offset] = clampByte(out.kind)
      this.data[offset + 1] = clampByte(out.neighborMask) & 0x0f
      this.data[offset + 2] = clampByte(out.region)
      this.data[offset + 3] = clampByte(out.flags)
    }
    this.markAllForUpload()
  }

  /**
   * Convert dirty row spans into Three.js r185 component ranges. Three merges
   * adjacent ranges and clears them after the renderer performs texSubImage2D.
   */
  commitUpdates(): SurfaceUploadBatch {
    if (this.dirtyRows.size === 0) return { ranges: [], bytes: 0, tiles: 0 }

    const ranges: SurfaceUpdateRange[] = []
    const rows = [...this.dirtyRows.entries()].sort((a, b) => a[0] - b[0])
    let bytes = 0
    for (const [row, span] of rows) {
      const start = (row * this.width + span.minX) * 4
      const count = (span.maxX - span.minX + 1) * 4
      this.texture.addUpdateRange(start, count)
      ranges.push({ start, count, row })
      bytes += count
    }
    this.texture.needsUpdate = true
    const tiles = this.dirtyTiles
    this.dirtyRows.clear()
    this.dirtyTiles = 0
    return { ranges, bytes, tiles }
  }

  /** Force the next renderer upload to replace the full backing texture. */
  markAllForUpload(): SurfaceUploadBatch {
    this.dirtyRows.clear()
    this.dirtyTiles = 0
    this.texture.clearUpdateRanges()
    this.texture.needsUpdate = true
    return {
      ranges: [{ start: 0, count: this.data.length, row: 0 }],
      bytes: this.data.length,
      tiles: this.tileCount,
    }
  }

  dispose(): void {
    this.texture.dispose()
  }

  private assertTileId(tileId: TileId): void {
    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= this.tileCount) {
      throw new RangeError(`Tile ${tileId} is outside 0..${this.tileCount - 1}`)
    }
  }
}
