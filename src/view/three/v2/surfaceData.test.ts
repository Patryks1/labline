import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MapSurfaceLayer } from './surfaceLayer'
import { SurfaceBiomeTexture, SurfaceDataTexture } from './surfaceData'
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

  it('packs v3 transport topology and visual style without changing RGBA8 size', () => {
    const surface = new SurfaceDataTexture(2, 1)
    const packedTransport = 0x2c_d5
    surface.set(1, {
      kind: 4,
      neighborMask: 0,
      region: 177,
      flags: 5,
      transport: packedTransport,
    })
    const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    surface.get(1, out)

    expect([...surface.data.slice(4, 8)]).toEqual([0xf4, 0xd5, 177, 5])
    expect(out).toEqual({
      kind: 4,
      neighborMask: 0xd5,
      region: 177,
      flags: 5,
      transport: 0x0c_d5,
    })
    expect(surface.data).toBeInstanceOf(Uint8Array)
    expect(surface.data.byteLength).toBe(8)
    surface.dispose()
  })

  it('stores biome IDs in an independent R8 texture without consuming region or transport bits', () => {
    const surface = new SurfaceDataTexture(2, 1)
    const biomes = new SurfaceBiomeTexture(2, 1, (tileId) => tileId === 0 ? 2 : 5)
    surface.set(1, {
      kind: 4,
      neighborMask: 0,
      region: 177,
      flags: 5,
      transport: 0x0c_d5,
    })

    expect([...biomes.data]).toEqual([2, 5])
    expect([...surface.data.slice(4, 8)]).toEqual([0xf4, 0xd5, 177, 5])
    expect(biomes.texture.format).toBe(THREE.RedFormat)
    expect(biomes.texture.name).toBe('map-biome-state-r8')
    biomes.dispose()
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

  it('bounds terrain allocation to one canonical-lattice chunk on a 1000x1000 map', () => {
    const layer = new MapSurfaceLayer({ width: 1000, height: 1000, tileSize: 1.05 })
    expect(layer.geometry.getAttribute('position').count).toBe(33 * 33)
    expect(layer.geometry.index?.count).toBe(32 * 32 * 6)
    expect(layer.geometry.index?.array).toBeInstanceOf(Uint16Array)
    expect(layer.mesh.frustumCulled).toBe(true)
    expect(layer.data.data.byteLength).toBe(4_000_000)
    expect(layer.biomeData.data.byteLength).toBe(1_000_000)
    layer.dispose()
  })
})
