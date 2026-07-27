import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MUNICIPAL_POWER_BY_KIND, transformMunicipalAnchor } from '../assets/municipalPowerLayouts'
import { ViewportChunkManager } from './chunks'
import { MunicipalPowerLayer } from './municipalPowerLayer'
import { LodTier, type ChunkId, type ViewportRenderSource } from './types'

describe('MunicipalPowerLayer', () => {
  it('uses yaw-transformed descriptor anchors and LOD-aware effect density', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const source = powerSource('wind', Math.PI / 2)
    const visible = new Set<ChunkId>([0])
    const layer = new MunicipalPowerLayer()
    layer.update(visible, chunks, source, LodTier.near)

    expect(layer.stats).toMatchObject({ plants: 1, instances: 3, drawCalls: 1 })
    expect(layer.stats.triangles).toBeGreaterThan(0)
    const mesh = layer.root.children[0] as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    mesh.getMatrixAt(0, matrix)
    const actual = new THREE.Vector3().setFromMatrixPosition(matrix)
    const expected = transformMunicipalAnchor(
      [2, 0.25, 2], Math.PI / 2, MUNICIPAL_POWER_BY_KIND.wind.effects[0]!.position,
    )
    expect(expected).toEqual(expect.arrayContaining([
      expect.closeTo(1.58, 5), expect.closeTo(1.29, 5), expect.closeTo(2.48, 5),
    ]))
    expect(actual.toArray()).toEqual(expect.arrayContaining(expected.map(value => expect.closeTo(value, 5))))

    layer.update(visible, chunks, source, LodTier.far)
    expect(layer.stats).toMatchObject({ plants: 1, instances: 1, drawCalls: 1 })
    layer.dispose()
  })

  it('batches deterministic vapor and reports zero stats when no campus is visible', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const layer = new MunicipalPowerLayer()
    layer.update(new Set<ChunkId>([0]), chunks, powerSource('nuclear', 0), LodTier.mid)
    expect(layer.stats).toMatchObject({ plants: 1, instances: 4, drawCalls: 1 })
    const first = Array.from((layer.root.children[0] as THREE.InstancedMesh).instanceMatrix.array)
    layer.update(new Set<ChunkId>(), chunks, powerSource('nuclear', 0), LodTier.mid)
    expect(layer.stats).toEqual({ plants: 0, instances: 0, drawCalls: 0, triangles: 0 })
    layer.update(new Set<ChunkId>([0]), chunks, powerSource('nuclear', 0), LodTier.mid)
    expect(Array.from((layer.root.children[0] as THREE.InstancedMesh).instanceMatrix.array)).toEqual(first)
    layer.dispose()
  })
})

function powerSource(kind: 'wind' | 'nuclear', phase: number): ViewportRenderSource {
  return {
    width: 8,
    height: 8,
    tileSize: 1,
    getMunicipalPowerPlants: () => [{ id: 1, kind, tileX: 1, tileY: 1, x: 2, y: 0.25, z: 2, phase }],
    readSurface: () => undefined,
    getChunkInstances: () => [],
    getChunkRevision: () => 0,
  }
}
