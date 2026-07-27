import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ArchetypeRegistry } from './archetypes'
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

  it('interpolates fixed-step endpoints without rebuilding meshes every frame', () => {
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
      expect(mesh.geometry.getAttribute('trafficDelta')).toBeInstanceOf(
        THREE.InstancedBufferAttribute,
      )
      expect(mesh.geometry.getAttribute('trafficYawDelta')).toBeInstanceOf(
        THREE.InstancedBufferAttribute,
      )
    }

    traffic.dispose()
  })

  it('favors major v3 roads and aligns vehicles to diagonal topology tangents', () => {
    const chunks = new ViewportChunkManager(8, 4, 4, 4)
    const local = new TrafficLayer()
    const highway = new TrafficLayer()
    const diagonal = new TrafficLayer()
    const visible = new Set<ChunkId>([0, 1])

    local.update(visible, chunks, transportSource(0x01_44))
    highway.update(visible, chunks, transportSource(0x04_44))
    diagonal.update(visible, chunks, transportSource(0x03_22))

    expect(local.stats.vehicles).toBeGreaterThan(0)
    expect(highway.stats.vehicles).toBeGreaterThan(local.stats.vehicles)
    const body = trafficMeshes(diagonal).find((mesh) => mesh.name === 'traffic-bodies')!
    expect(body.frustumCulled).toBe(false)
    const first = new THREE.Matrix4()
    body.getMatrixAt(0, first)
    const elements = first.elements
    const forwardScale = Math.hypot(elements[0]!, elements[2]!)
    expect(Math.abs(elements[0]!) / forwardScale).toBeCloseTo(Math.SQRT1_2, 4)
    expect(Math.abs(elements[2]!) / forwardScale).toBeCloseTo(Math.SQRT1_2, 4)

    local.dispose()
    highway.dispose()
    diagonal.dispose()
  })

  it('batches deterministic authored variants without mutating registry geometry', () => {
    const fallback = new THREE.BoxGeometry(1, 1, 1)
    const authored = new THREE.TetrahedronGeometry(0.3)
    authored.setAttribute('color', new THREE.Float32BufferAttribute(
      new Array(authored.getAttribute('position').count * 3).fill(0),
      3,
    ))
    const registry = geometryRegistry([
      [5, fallback],
      [300, fallback],
      [473, authored],
    ])
    const chunks = new ViewportChunkManager(8, 4, 4, 4)
    const first = new TrafficLayer(registry)
    const second = new TrafficLayer(registry)
    const visible = new Set<ChunkId>([0, 1])
    const source = transportSource(0x04_44)
    first.update(visible, chunks, source)
    second.update(visible, chunks, source)

    expect(first.stats.instances).toBe(first.stats.vehicles)
    expect(first.stats.drawCalls).toBe(1)
    expect(trafficMeshes(first).map((mesh) => mesh.name)).toEqual(['traffic-authored-473'])
    expect(trafficSnapshot(first)).toEqual(trafficSnapshot(second))
    const mesh = trafficMeshes(first)[0]!
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(false)
    expect(mesh.instanceColor).not.toBeNull()
    expect(Math.max(...mesh.instanceColor!.array)).toBeGreaterThan(0.1)
    expect(mesh.geometry).not.toBe(authored)
    expect(authored.getAttribute('trafficDelta')).toBeUndefined()
    const registryDisposed = vi.fn()
    authored.addEventListener('dispose', registryDisposed)

    first.dispose()
    second.dispose()
    expect(registryDisposed).not.toHaveBeenCalled()
  })

  it('keeps procedural cars when catalog entries still alias fallback geometry', () => {
    const fallback = new THREE.BoxGeometry(1, 1, 1)
    const registry = geometryRegistry([
      [5, fallback],
      [300, fallback],
      [473, fallback],
    ])
    const traffic = new TrafficLayer(registry)
    traffic.update(
      new Set<ChunkId>([0, 1]),
      new ViewportChunkManager(8, 4, 4, 4),
      transportSource(0x04_44),
    )

    expect(trafficMeshes(traffic).map((mesh) => mesh.name)).toEqual([
      'traffic-bodies',
      'traffic-cabins',
    ])
    expect(traffic.stats.instances).toBe(traffic.stats.vehicles * 2)
    traffic.dispose()
  })

  it('uses varied procedural body proportions, glass tints, and paint colors', () => {
    const width = 32
    const height = 16
    const source: ViewportRenderSource = {
      width,
      height,
      tileSize: 1.05,
      readSurface(_tileId, out) {
        out.kind = SurfaceKind.road
        out.neighborMask = 0b1010
        out.region = 0
        out.flags = 0
        out.transport = undefined
      },
      getChunkInstances: () => [],
      getChunkRevision: () => 1,
    }
    const traffic = new TrafficLayer()
    traffic.update(
      new Set<ChunkId>([0, 1]),
      new ViewportChunkManager(width, height, 16, 8),
      source,
    )
    const body = trafficMeshes(traffic).find((mesh) => mesh.name === 'traffic-bodies')!
    const cabin = trafficMeshes(traffic).find((mesh) => mesh.name === 'traffic-cabins')!
    const uniqueColors = (mesh: THREE.InstancedMesh) => {
      const colors = mesh.instanceColor!.array
      const values = new Set<string>()
      for (let index = 0; index < mesh.count; index++) {
        values.add(Array.from(colors.slice(index * 3, index * 3 + 3)).map((value) => value.toFixed(3)).join(':'))
      }
      return values.size
    }
    const proportions = new Set<string>()
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    for (let index = 0; index < body.count; index++) {
      body.getMatrixAt(index, matrix)
      matrix.decompose(position, quaternion, scale)
      proportions.add(`${scale.x.toFixed(2)}:${scale.y.toFixed(2)}:${scale.z.toFixed(2)}`)
    }

    expect(body.count).toBeGreaterThan(100)
    expect(uniqueColors(body)).toBeGreaterThan(10)
    expect(uniqueColors(cabin)).toBeGreaterThanOrEqual(5)
    expect(proportions.size).toBeGreaterThanOrEqual(6)
    traffic.dispose()
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

function transportSource(packedTransport: number): ViewportRenderSource {
  return Object.freeze({
    width: 8,
    height: 4,
    tileSize: 1.05,
    readSurface: (_tileId: number, out: SurfaceTexel) => {
      out.kind = SurfaceKind.grass
      out.neighborMask = packedTransport & 0xff
      out.region = 0
      out.flags = 0
      out.transport = packedTransport
    },
    getChunkInstances: () => Object.freeze([]),
    getChunkRevision: () => 1,
    getSurfaceRevision: () => 1,
  })
}

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
    deltas: Array.from(mesh.geometry.getAttribute('trafficDelta').array),
    yawDeltas: Array.from(mesh.geometry.getAttribute('trafficYawDelta').array),
  }))
}
