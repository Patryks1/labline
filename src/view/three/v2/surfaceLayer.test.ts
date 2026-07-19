import { describe, expect, it } from 'vitest'
import { MapSurfaceLayer } from './surfaceLayer'

describe('MapSurfaceLayer road autotiling', () => {
  it('maps north and south mask bits to the matching map-row halves', () => {
    const surface = new MapSurfaceLayer({ width: 2, height: 2, tileSize: 1 })
    const shader = surface.material.fragmentShader

    expect(shader).toContain(
      'float north = bitSet(mask, 1.0) * step(p.y, 0.5)',
    )
    expect(shader).toContain(
      'float south = bitSet(mask, 4.0) * step(0.5, p.y)',
    )

    surface.dispose()
  })
})
