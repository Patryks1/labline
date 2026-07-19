import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ViewportChunkManager } from './chunks'
import { TrafficLayer } from './trafficLayer'
import {
  LodTier,
  SurfaceKind,
  type ChunkId,
  type SurfaceTexel,
  type ViewportRenderSource,
} from './types'

describe('TrafficLayer', () => {
  it('projects deterministic traffic without mutating its simulation source', () => {
    const chunks = new ViewportChunkManager(8, 4, 4, 4)
    const firstSource = roadSource()
    const secondSource = roadSource()
    const first = new TrafficLayer()
    const second = new TrafficLayer()

    first.update(new Set<ChunkId>([1, 0]), chunks, firstSource.source)
    second.update(new Set<ChunkId>([0, 1]), chunks, secondSource.source)

    expect(first.stats.vehicles).toBeGreaterThan(0)
    expect(first.stats).toEqual(second.stats)
    expect(trafficSnapshot(first)).toEqual(trafficSnapshot(second))
    expect(firstSource.readSurface).toHaveBeenCalled()
    expect(firstSource.getChunkRevision).toHaveBeenCalled()
    expect(firstSource.state).toEqual({ reads: firstSource.readSurface.mock.calls.length })

    first.dispose()
    second.dispose()
  })

  it('animates through shader time without rebuilding or updating instance matrices per frame', () => {
    const chunks = new ViewportChunkManager(8, 4, 4, 4)
    const fixture = roadSource()
    const traffic = new TrafficLayer()
    const visible = new Set<ChunkId>([0, 1])
    traffic.update(visible, chunks, fixture.source)
    const meshes = trafficMeshes(traffic)
    expect(meshes).toHaveLength(2)

    const versions = meshes.map((mesh) => mesh.instanceMatrix.version)
    const matrices = meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))
    const meshIdentities = [...meshes]
    const readsAfterProjection = fixture.readSurface.mock.calls.length

    traffic.setFrame(1.25)
    traffic.setFrame(9.5)
    traffic.update(new Set<ChunkId>([1, 0]), chunks, fixture.source)

    expect(trafficMeshes(traffic)).toEqual(meshIdentities)
    expect(trafficMeshes(traffic).map((mesh) => mesh.instanceMatrix.version)).toEqual(versions)
    expect(trafficMeshes(traffic).map((mesh) => Array.from(mesh.instanceMatrix.array))).toEqual(
      matrices,
    )
    expect(fixture.readSurface).toHaveBeenCalledTimes(readsAfterProjection)
    for (const mesh of meshes) {
      expect(mesh.instanceMatrix.usage).toBe(THREE.StaticDrawUsage)
      expect(mesh.geometry.getAttribute('trafficPhase')).toBeInstanceOf(
        THREE.InstancedBufferAttribute,
      )
      expect(mesh.geometry.getAttribute('trafficSpeed')).toBeInstanceOf(
        THREE.InstancedBufferAttribute,
      )
    }

    traffic.dispose()
  })
})

function roadSource(): {
  source: ViewportRenderSource
  state: { reads: number }
  readSurface: ReturnType<typeof vi.fn>
  getChunkRevision: ReturnType<typeof vi.fn>
} {
  const state = { reads: 0 }
  const readSurface = vi.fn((_tileId: number, out: SurfaceTexel) => {
    state.reads++
    out.kind = SurfaceKind.road
    out.neighborMask = 0b1010
    out.region = 0
    out.flags = 0
  })
  const getChunkRevision = vi.fn((_chunkId: ChunkId) => 7)
  const source: ViewportRenderSource = Object.freeze({
    width: 8,
    height: 4,
    tileSize: 1.05,
    readSurface,
    getChunkInstances: () => Object.freeze([]),
    getChunkRevision,
    prepareChunk: (_chunkId: ChunkId, _tier: LodTier) => undefined,
  })
  return { source, state, readSurface, getChunkRevision }
}

function trafficMeshes(traffic: TrafficLayer): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = []
  traffic.root.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) meshes.push(object)
  })
  return meshes.sort((a, b) => a.name.localeCompare(b.name))
}

function trafficSnapshot(traffic: TrafficLayer): unknown {
  return trafficMeshes(traffic).map((mesh) => ({
    name: mesh.name,
    matrices: Array.from(mesh.instanceMatrix.array),
    colors: Array.from(mesh.instanceColor?.array ?? []),
    phases: Array.from(mesh.geometry.getAttribute('trafficPhase').array),
    speeds: Array.from(mesh.geometry.getAttribute('trafficSpeed').array),
  }))
}
