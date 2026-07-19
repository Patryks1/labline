import { describe, expect, it } from 'vitest'
import { MapSurfaceLayer } from './surfaceLayer'
import { SurfaceDataTexture } from './surfaceData'
import type { SurfaceTexel } from './types'

describe('RGBA8 surface data', () => {
  it('encodes exact categorical channels and masks cardinal bits', () => {
    const surface = new SurfaceDataTexture(4, 3)
    surface.set(6, { kind: 3, neighborMask: 31, region: 211, flags: 37 })
    const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    surface.get(6, out)

    expect(out).toEqual({ kind: 3, neighborMask: 15, region: 211, flags: 37 })
    expect([...surface.data.slice(24, 28)]).toEqual([3, 15, 211, 37])
    surface.dispose()
  })

  it('emits compact component update ranges merged by dirty row span', () => {
    const surface = new SurfaceDataTexture(4, 3)
    surface.set(0, { kind: 1, neighborMask: 2, region: 3, flags: 4 })
    surface.set(2, { kind: 2, neighborMask: 3, region: 4, flags: 5 })
    surface.set(9, { kind: 3, neighborMask: 4, region: 5, flags: 6 })
    const upload = surface.commitUpdates()

    expect(upload.ranges).toEqual([
      { start: 0, count: 12, row: 0 },
      { start: 36, count: 4, row: 2 },
    ])
    expect(upload.bytes).toBe(16)
    expect(upload.tiles).toBe(3)
    expect(surface.texture.updateRanges).toEqual([
      { start: 0, count: 12 },
      { start: 36, count: 4 },
    ])
    expect(surface.commitUpdates().ranges).toEqual([])
    surface.dispose()
  })

  it('uses one four-vertex/two-triangle map surface', () => {
    const layer = new MapSurfaceLayer({ width: 1000, height: 1000, tileSize: 1.05 })
    expect(layer.geometry.getAttribute('position').count).toBe(4)
    expect(layer.geometry.index?.count).toBe(6)
    expect(layer.mesh.frustumCulled).toBe(true)
    expect(layer.data.data.byteLength).toBe(4_000_000)
    layer.dispose()
  })
})
