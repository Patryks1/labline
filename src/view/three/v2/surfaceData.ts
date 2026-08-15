import * as THREE from 'three'
import { clampByte, tileCoords, type SurfaceTexel, type TileId } from './types'

/** R-channel marker. Values below it retain the exact v2 RGBA layout. */
export const SURFACE_TRANSPORT_MODE = 0x80
const SURFACE_TRANSPORT_VISUAL_SHIFT = 4
const SURFACE_TRANSPORT_VISUAL_MASK = 0x70

/** Pack the road class and bridge flag into the three spare R-channel bits. */
function transportVisualCode(transport: number): number {
  const style = (transport >>> 8) & 0xff
  const roadClass = Math.max(1, style & 0x07)
  const bridge = (style & 0x08) !== 0 ? 0x04 : 0
  return ((roadClass - 1) & 0x03) | bridge
}

function decodedTransportStyle(encodedKind: number): number {
  const visual = (encodedKind & SURFACE_TRANSPORT_VISUAL_MASK) >>> SURFACE_TRANSPORT_VISUAL_SHIFT
  const roadClass = (visual & 0x03) + 1
  const bridge = (visual & 0x04) !== 0 ? 0x08 : 0
  return roadClass | bridge
}

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
    const hasTransport = texel.transport !== undefined && texel.transport !== 0
    const kind = hasTransport
      ? SURFACE_TRANSPORT_MODE |
        (transportVisualCode(texel.transport!) << SURFACE_TRANSPORT_VISUAL_SHIFT) |
        (clampByte(texel.kind) & 0x0f)
      : clampByte(texel.kind)
    const mask = hasTransport
      ? clampByte(texel.transport! & 0xff)
      : clampByte(texel.neighborMask) & 0x0f
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
    const encodedKind = this.data[offset]!
    const hasTransport = (encodedKind & SURFACE_TRANSPORT_MODE) !== 0
    out.kind = hasTransport ? encodedKind & 0x0f : encodedKind
    out.neighborMask = this.data[offset + 1]!
    out.region = this.data[offset + 2]!
    out.flags = this.data[offset + 3]!
    out.transport = hasTransport
      ? out.neighborMask | (decodedTransportStyle(encodedKind) << 8)
      : undefined
    return out
  }

  /** Fill the CPU mirror without creating one object per tile. */
  fill(read: (tileId: TileId, out: SurfaceTexel) => void): void {
    const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let tileId = 0; tileId < this.tileCount; tileId++) {
      out.transport = undefined
      read(tileId, out)
      const offset = tileId * 4
      const hasTransport = out.transport !== undefined && out.transport !== 0
      this.data[offset] = hasTransport
        ? SURFACE_TRANSPORT_MODE |
          (transportVisualCode(out.transport!) << SURFACE_TRANSPORT_VISUAL_SHIFT) |
          (clampByte(out.kind) & 0x0f)
        : clampByte(out.kind)
      this.data[offset + 1] = hasTransport
        ? clampByte(out.transport! & 0xff)
        : clampByte(out.neighborMask) & 0x0f
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

/** Independent immutable R8 biome layer; keeps the packed RGBA surface contract intact. */
export class SurfaceBiomeTexture {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  readonly texture: THREE.DataTexture

  constructor(width: number, height: number, read?: (tileId: TileId) => number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError(`Invalid biome dimensions ${width}x${height}`)
    }
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height)
    if (read) {
      for (let tileId = 0; tileId < this.data.length; tileId++) {
        this.data[tileId] = clampByte(read(tileId))
      }
    }
    this.texture = new THREE.DataTexture(
      this.data,
      width,
      height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    )
    this.texture.name = 'map-biome-state-r8'
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.generateMipmaps = false
    this.texture.flipY = false
    this.texture.unpackAlignment = 1
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
