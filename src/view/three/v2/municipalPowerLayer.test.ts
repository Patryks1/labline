import { describe, expect, it } from 'vitest'
import { MunicipalPowerLayer } from './municipalPowerLayer'
import type { ViewportRenderSource } from './types'

describe('municipal power effects', () => {
  it('projects one solar shimmer instance per authoritative panel tile', () => {
    const layer = new MunicipalPowerLayer()
    const source = {
      width: 64,
      getMunicipalPowerPlants: () => [{
        id: 1,
        kind: 'solar' as const,
        tileX: 3,
        tileY: 3,
        x: 3,
        y: 0,
        z: 3,
        phase: 0.5,
        footprintTileIds: [66, 67, 68],
        panels: [
          { tileId: 66, x: 2, y: 0, z: 1, yaw: 0 },
          { tileId: 67, x: 3, y: 0, z: 1, yaw: 0 },
          { tileId: 68, x: 4, y: 0, z: 1, yaw: 0 },
        ],
      }],
    } as unknown as ViewportRenderSource
    const chunks = {
      chunkBounds: () => ({ minX: 0, minY: 0, maxX: 32, maxY: 32 }),
    }

    layer.update(new Set([0]), chunks as never, source)

    const shimmer = layer.root.getObjectByName('municipal-solar-shimmer')
    expect(shimmer?.type).toBe('Mesh')
    expect((shimmer as { count?: number }).count).toBe(3)
    layer.dispose()
  })
})
