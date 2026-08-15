import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ArchetypeRegistry } from './archetypes'
import { ViewportChunkManager } from './chunks'
import {
  EnvironmentLifeLayer,
  MAX_BOATS_PER_CHUNK,
  MAX_BUOYS_PER_CHUNK,
} from './environmentLifeLayer'
import {
  SurfaceKind,
  type ChunkId,
  type SurfaceTexel,
  type ViewportRenderSource,
} from './types'

describe('EnvironmentLifeLayer', () => {
  it('deterministically projects boats on lake interiors and orange buoys at lake edges', () => {
    const chunks = new ViewportChunkManager(64, 64, 32, 4)
    const firstFixture = lakeSource(64, 64)
    const secondFixture = lakeSource(64, 64)
    const first = new EnvironmentLifeLayer()
    const second = new EnvironmentLifeLayer()

    first.update(new Set<ChunkId>([3, 0, 2, 1]), chunks, firstFixture.source)
    second.update(new Set<ChunkId>([0, 1, 2, 3]), chunks, secondFixture.source)

    expect(first.stats.boats).toBeGreaterThan(0)
    expect(first.stats.buoys).toBeGreaterThan(0)
    expect(first.stats).toEqual(second.stats)
    expect(lifeSnapshot(first)).toEqual(lifeSnapshot(second))
    expect(firstFixture.readSurface).toHaveBeenCalledTimes(64 * 64)
    expect(firstFixture.state).toEqual({ reads: 64 * 64 })

    first.dispose()
    second.dispose()
  })

  it('keeps animation in uniforms and rebuilds only for visible surface changes', () => {
    const chunks = new ViewportChunkManager(64, 64, 32, 4)
    const fixture = lakeSource(64, 64)
    const layer = new EnvironmentLifeLayer()
    const visible = new Set<ChunkId>([0, 1])
    layer.update(visible, chunks, fixture.source)
    const meshes = lifeMeshes(layer)
    const identities = [...meshes]
    const versions = meshes.map((mesh) => mesh.instanceMatrix.version)
    const matrices = meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))
    const reads = fixture.readSurface.mock.calls.length

    layer.setFrame(1.5)
    layer.setFrame(8.25)
    layer.update(new Set<ChunkId>([1, 0]), chunks, fixture.source)

    expect(lifeMeshes(layer)).toEqual(identities)
    expect(meshes.map((mesh) => mesh.instanceMatrix.version)).toEqual(versions)
    expect(meshes.map((mesh) => Array.from(mesh.instanceMatrix.array))).toEqual(matrices)
    expect(fixture.readSurface).toHaveBeenCalledTimes(reads)
    for (const mesh of meshes) {
      expect(mesh.instanceMatrix.usage).toBe(THREE.StaticDrawUsage)
      expect(mesh.geometry.getAttribute('lifePhase')).toBeInstanceOf(THREE.InstancedBufferAttribute)
      expect(mesh.geometry.getAttribute('lifeDrift')).toBeInstanceOf(THREE.InstancedBufferAttribute)
      expect((mesh.material as THREE.Material).userData.lifeTime.value).toBe(8.25)
    }

    fixture.revisions[0] = 2
    layer.update(visible, chunks, fixture.source)
    expect(fixture.readSurface.mock.calls.length).toBeGreaterThan(reads)
    expect(lifeMeshes(layer)).not.toEqual(identities)
    layer.dispose()
  })

  it('bounds density per chunk, follows visibility, and disposes GPU resources', () => {
    const chunks = new ViewportChunkManager(256, 256, 256, 1)
    const fixture = lakeSource(256, 256, 2)
    const layer = new EnvironmentLifeLayer()
    layer.update(new Set<ChunkId>([0]), chunks, fixture.source)

    expect(layer.stats.boats).toBe(MAX_BOATS_PER_CHUNK)
    expect(layer.stats.buoys).toBe(MAX_BUOYS_PER_CHUNK)
    expect(layer.stats.instances).toBe(MAX_BOATS_PER_CHUNK * 2 + MAX_BUOYS_PER_CHUNK * 5)
    expect(layer.stats.drawCalls).toBe(7)
    expect(layer.stats.triangles).toBeGreaterThan(0)

    const geometries = lifeMeshes(layer).map((mesh) => mesh.geometry)
    const disposed = geometries.map(() => vi.fn())
    geometries.forEach((geometry, index) => geometry.addEventListener('dispose', disposed[index]!))
    layer.update(new Set(), chunks, fixture.source)
    expect(layer.stats).toEqual({ boats: 0, buoys: 0, instances: 0, drawCalls: 0, triangles: 0 })
    expect(layer.root.children).toHaveLength(0)
    disposed.forEach((listener) => expect(listener).toHaveBeenCalledOnce())

    layer.dispose()
    expect(() => layer.setFrame(1)).toThrow(/disposed/)
  })

  it('uses authored boats but always keeps the detailed orange buoy silhouette', () => {
    const boatFallback = new THREE.BoxGeometry(1, 1, 1)
    const duckFallback = new THREE.ConeGeometry(0.2, 0.4, 4)
    const boat = new THREE.TetrahedronGeometry(0.25)
    const duck = new THREE.OctahedronGeometry(0.15)
    const registry = geometryRegistry([
      [209, boatFallback],
      [301, boatFallback],
      [484, boat],
      [1, duckFallback],
      [302, duckFallback],
      [488, duck],
    ])
    const chunks = new ViewportChunkManager(64, 64, 32, 4)
    const fixture = lakeSource(64, 64)
    const first = new EnvironmentLifeLayer(registry)
    const second = new EnvironmentLifeLayer(registry)
    const visible = new Set<ChunkId>([0, 1, 2, 3])
    first.update(visible, chunks, fixture.source)
    second.update(visible, chunks, fixture.source)

    expect(first.stats.instances).toBe(first.stats.boats + first.stats.buoys * 5)
    expect(first.stats.drawCalls).toBe(6)
    expect(lifeMeshes(first).map((mesh) => mesh.name)).toEqual([
      'lake-life-authored-boat-484',
      'lake-life-buoy-collars',
      'lake-life-buoy-marker-lights',
      'lake-life-buoy-masts',
      'lake-life-buoy-orange-bodies',
      'lake-life-buoy-small-flags',
    ])
    expect(lifeSnapshot(first)).toEqual(lifeSnapshot(second))
    expect(lifeMeshes(first).every((mesh) => mesh.instanceMatrix.usage === THREE.StaticDrawUsage)).toBe(true)
    expect(boat.getAttribute('lifePhase')).toBeUndefined()
    expect(duck.getAttribute('lifeDrift')).toBeUndefined()
    const boatDisposed = vi.fn()
    const duckDisposed = vi.fn()
    boat.addEventListener('dispose', boatDisposed)
    duck.addEventListener('dispose', duckDisposed)

    first.dispose()
    second.dispose()
    expect(boatDisposed).not.toHaveBeenCalled()
    expect(duckDisposed).not.toHaveBeenCalled()
  })

  it('keeps compound procedural life while catalog geometry is still aliased', () => {
    const boatFallback = new THREE.BoxGeometry(1, 1, 1)
    const duckFallback = new THREE.ConeGeometry(0.2, 0.4, 4)
    const registry = geometryRegistry([
      [209, boatFallback],
      [301, boatFallback],
      [1, duckFallback],
      [302, duckFallback],
    ])
    const layer = new EnvironmentLifeLayer(registry)
    const fixture = lakeSource(64, 64)
    layer.update(
      new Set<ChunkId>([0, 1, 2, 3]),
      new ViewportChunkManager(64, 64, 32, 4),
      fixture.source,
    )

    expect(lifeMeshes(layer).map((mesh) => mesh.name)).toEqual([
      'lake-life-boat-hulls',
      'lake-life-boat-sails',
      'lake-life-buoy-collars',
      'lake-life-buoy-marker-lights',
      'lake-life-buoy-masts',
      'lake-life-buoy-orange-bodies',
      'lake-life-buoy-small-flags',
    ])
    expect(layer.stats.instances).toBe(layer.stats.boats * 2 + layer.stats.buoys * 5)
    layer.dispose()
  })
})

function geometryRegistry(entries: readonly (readonly [number, THREE.BufferGeometry])[]): ArchetypeRegistry {
  const registry = new ArchetypeRegistry()
  const material = new THREE.MeshBasicMaterial()
  for (const [id, geometry] of entries) {
    registry.register({
      id,
      name: `test-${id}`,
      geometry: { near: geometry, mid: geometry, far: geometry },
      material: { near: material, mid: material, far: material },
    })
  }
  return registry
}

function lakeSource(width: number, height: number, edgeStride = 8): {
  source: ViewportRenderSource
  state: { reads: number }
  revisions: number[]
  readSurface: ReturnType<typeof vi.fn>
} {
  const state = { reads: 0 }
  const revisions = new Array(Math.ceil(width / 32) * Math.ceil(height / 32)).fill(1)
  const readSurface = vi.fn((tileId: number, out: SurfaceTexel) => {
    state.reads++
    const x = tileId % width
    out.kind = SurfaceKind.lake
    out.neighborMask = x % edgeStride === 0 ? 0b0111 : 0b1111
    out.region = 0
    out.flags = 0
    out.transport = undefined
  })
  const source: ViewportRenderSource = Object.freeze({
    width,
    height,
    tileSize: 1.05,
    readSurface,
    getChunkInstances: () => Object.freeze([]),
    getChunkRevision: (chunkId: ChunkId) => revisions[chunkId] ?? 1,
    getSurfaceRevision: (chunkId: ChunkId) => revisions[chunkId] ?? 1,
  })
  return { source, state, revisions, readSurface }
}

function lifeMeshes(layer: EnvironmentLifeLayer): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = []
  layer.root.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) meshes.push(object)
  })
  return meshes.sort((a, b) => a.name.localeCompare(b.name))
}

function lifeSnapshot(layer: EnvironmentLifeLayer): unknown {
  return lifeMeshes(layer).map((mesh) => ({
    name: mesh.name,
    matrices: Array.from(mesh.instanceMatrix.array),
    colors: Array.from(mesh.instanceColor?.array ?? []),
    phases: Array.from(mesh.geometry.getAttribute('lifePhase').array),
    drifts: Array.from(mesh.geometry.getAttribute('lifeDrift').array),
  }))
}
