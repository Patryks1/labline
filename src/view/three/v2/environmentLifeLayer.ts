import * as THREE from 'three'
import type { ArchetypeRegistry } from './archetypes'
import type { ViewportChunkManager } from './chunks'
import {
  SurfaceKind,
  type ChunkId,
  type SurfaceTexel,
  type ViewportRenderSource,
} from './types'

export const MAX_BOATS_PER_CHUNK = 12
export const MAX_BUOYS_PER_CHUNK = 20

const BOAT_COLORS = [0xc85c46, 0x315f86, 0xe8b44b, 0xe7e3d5] as const
const BUOY_COLORS = [0xf36b21, 0xff7a1a, 0xe95816] as const

export interface EnvironmentLifeLayerStats {
  boats: number
  buoys: number
  instances: number
  drawCalls: number
  triangles: number
}

interface LakeLife {
  x: number
  y: number
  z: number
  yaw: number
  phase: number
  drift: number
  color: number
  modelId: number
}

interface LifeTimeState {
  value: number
}

/**
 * Sparse, deterministic lake decoration derived from the read-only surface
 * projection. All motion is shader-side, leaving instance buffers static.
 */
export class EnvironmentLifeLayer {
  readonly root = new THREE.Group()
  stats: EnvironmentLifeLayerStats = emptyStats()

  private readonly time: LifeTimeState = { value: 0 }
  private readonly boatMaterial = createLifeMaterial('boat-hulls', 0.035, this.time)
  private readonly sailMaterial = createLifeMaterial('boat-sails', 0.035, this.time, 0xd6a75e)
  private readonly buoyMaterial = createLifeMaterial('buoy-orange-bodies', 0.025, this.time)
  private readonly buoyDarkMaterial = createLifeMaterial('buoy-collars-and-masts', 0.025, this.time, 0x5a3926)
  private readonly buoyFlagMaterial = createLifeMaterial('buoy-orange-flags', 0.025, this.time, 0xff7a1a)
  private readonly buoyLightMaterial = createLifeMaterial('buoy-marker-lights', 0.025, this.time, 0xffc45b)
  private readonly meshes: THREE.InstancedMesh[] = []
  private readonly boatGeometry = new Map<number, THREE.BufferGeometry>()
  private signature = ''
  private disposed = false

  constructor(registry?: Pick<ArchetypeRegistry, 'has' | 'get'>) {
    this.root.name = 'visible-lake-life'
    if (registry) {
      collectLoadedGeometry(registry, BOAT_ARCHETYPES, BOAT_FALLBACK_ARCHETYPE, this.boatGeometry)
    }
  }

  /** Refresh authored boat geometry without replacing the world projection. */
  refreshAuthoredGeometry(registry: Pick<ArchetypeRegistry, 'has' | 'get'>): void {
    this.assertLive()
    this.boatGeometry.clear()
    collectLoadedGeometry(registry, BOAT_ARCHETYPES, BOAT_FALLBACK_ARCHETYPE, this.boatGeometry)
    this.clearMeshes()
    this.signature = ''
  }

  update(
    visibleChunks: ReadonlySet<ChunkId>,
    chunks: ViewportChunkManager,
    source: ViewportRenderSource,
  ): void {
    this.assertLive()
    const ordered = [...visibleChunks].sort((a, b) => a - b)
    const nextSignature = ordered
      .map(
        (chunkId) =>
          `${chunkId}:${source.getSurfaceRevision?.(chunkId) ?? source.getChunkRevision(chunkId)}`,
      )
      .join(',')
    if (nextSignature === this.signature) return
    this.signature = nextSignature

    const boats: LakeLife[] = []
    const buoys: LakeLife[] = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (const chunkId of ordered) {
      const bounds = chunks.chunkBounds(chunkId)
      let chunkBoats = 0
      let chunkBuoys = 0
      for (let y = bounds.minY; y < bounds.maxY; y++) {
        for (let x = bounds.minX; x < bounds.maxX; x++) {
          texel.transport = undefined
          source.readSurface(y * source.width + x, texel)
          if (texel.kind !== SurfaceKind.lake || texel.transport !== undefined) continue
          const interior = (texel.neighborMask & 0x0f) === 0x0f
          if (interior && chunkBoats < MAX_BOATS_PER_CHUNK && selectsCell(x, y, 97, 11)) {
            boats.push(lifeAt(x, y, source.tileSize, 0x4f1bbcdc, BOAT_COLORS, BOAT_ARCHETYPES, source.getWaterElevation?.(x, y) ?? source.getTileElevation?.(x, y) ?? 0))
            chunkBoats++
          } else if (!interior && chunkBuoys < MAX_BUOYS_PER_CHUNK && selectsCell(x, y, 31, 7)) {
            buoys.push(lifeAt(x, y, source.tileSize, 0xa133a5d9, BUOY_COLORS, BUOY_ARCHETYPES, source.getWaterElevation?.(x, y) ?? source.getTileElevation?.(x, y) ?? 0))
            chunkBuoys++
          }
        }
      }
    }
    this.rebuild(boats, buoys)
  }

  setFrame(timeSeconds: number): void {
    this.assertLive()
    this.time.value = timeSeconds
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearMeshes()
    this.boatMaterial.dispose()
    this.sailMaterial.dispose()
    this.buoyMaterial.dispose()
    this.buoyDarkMaterial.dispose()
    this.buoyFlagMaterial.dispose()
    this.buoyLightMaterial.dispose()
    this.root.clear()
    this.stats = emptyStats()
  }

  private rebuild(boats: readonly LakeLife[], buoys: readonly LakeLife[]): void {
    this.clearMeshes()
    let triangles = 0
    if (boats.length > 0) {
      if (this.boatGeometry.size > 0) {
        triangles += this.addAuthoredMeshes('boat', boats, this.boatGeometry, this.boatMaterial)
      } else {
        triangles += this.addMesh(
        'lake-life-boat-hulls',
        new THREE.ConeGeometry(0.14, 0.42, 4).rotateX(Math.PI / 2).translate(0, 0.07, 0),
        this.boatMaterial,
        boats,
      )
      const sail = new THREE.BufferGeometry()
      sail.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([
          0, 0.08, 0,
          0, 0.34, 0,
          0.19, 0.1, 0,
        ], 3),
      )
      sail.setIndex([0, 2, 1])
      sail.computeVertexNormals()
      triangles += this.addMesh('lake-life-boat-sails', sail, this.sailMaterial, boats)
      }
    }
    if (buoys.length > 0) {
      triangles += this.addMesh(
        'lake-life-buoy-orange-bodies',
        new THREE.SphereGeometry(0.105, 10, 6).scale(1, 1.12, 1).translate(0, 0.105, 0),
        this.buoyMaterial,
        buoys,
      )
      triangles += this.addMesh(
        'lake-life-buoy-collars',
        new THREE.TorusGeometry(0.09, 0.018, 5, 10).rotateX(Math.PI / 2).translate(0, 0.12, 0),
        this.buoyDarkMaterial,
        buoys,
      )
      triangles += this.addMesh(
        'lake-life-buoy-masts',
        new THREE.CylinderGeometry(0.012, 0.016, 0.24, 6).translate(0, 0.285, 0),
        this.buoyDarkMaterial,
        buoys,
      )
      const flag = new THREE.BufferGeometry()
      flag.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0.39, 0, 0, 0.30, 0, 0.15, 0.35, 0,
      ], 3))
      flag.setIndex([0, 1, 2])
      flag.computeVertexNormals()
      triangles += this.addMesh('lake-life-buoy-small-flags', flag, this.buoyFlagMaterial, buoys)
      triangles += this.addMesh(
        'lake-life-buoy-marker-lights',
        new THREE.SphereGeometry(0.025, 6, 4).translate(0, 0.415, 0),
        this.buoyLightMaterial,
        buoys,
      )
    }
    this.stats = {
      boats: boats.length,
      buoys: buoys.length,
      instances:
        boats.length * (this.boatGeometry.size > 0 ? 1 : 2) +
        buoys.length * 5,
      drawCalls: this.meshes.length,
      triangles,
    }
  }

  private addMesh(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    life: readonly LakeLife[],
  ): number {
    const mesh = createLifeMesh(name, geometry, material, life)
    this.meshes.push(mesh)
    this.root.add(mesh)
    return triangleCount(geometry) * life.length
  }

  private addAuthoredMeshes(
    family: 'boat',
    life: readonly LakeLife[],
    available: ReadonlyMap<number, THREE.BufferGeometry>,
    material: THREE.Material,
  ): number {
    let triangles = 0
    for (const [modelId, batch] of groupByModel(life, available)) {
      // The registry remains the owner. Clone before attaching instance
      // attributes so rebuild/disposal cannot invalidate another renderer.
      const geometry = available.get(modelId)!.clone()
      triangles += this.addMesh(`lake-life-authored-${family}-${modelId}`, geometry, material, batch)
    }
    return triangles
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.meshes.length = 0
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('EnvironmentLifeLayer has been disposed')
  }
}

function createLifeMaterial(
  name: string,
  driftScale: number,
  time: LifeTimeState,
  color = 0xffffff,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name,
    color,
    vertexColors: color === 0xffffff,
    roughness: 0.78,
    metalness: 0,
    flatShading: true,
    fog: true,
    side: name === 'boat-sails' || name === 'buoy-orange-flags' ? THREE.DoubleSide : THREE.FrontSide,
  })
  material.userData.lifeTime = time
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLifeTime = time
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        'attribute float lifePhase;\nattribute float lifeDrift;\nuniform float uLifeTime;\nvoid main() {',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nfloat lifeWave = uLifeTime * 0.32 + lifePhase;\ntransformed.x += sin(lifeWave) * lifeDrift * ${driftScale.toFixed(3)};\ntransformed.z += cos(lifeWave * 0.83) * lifeDrift * ${(driftScale * 0.7).toFixed(3)};\ntransformed.y += sin(uLifeTime * 0.72 + lifePhase) * 0.018;`,
      )
  }
  material.customProgramCacheKey = () => `labline-environment-life-${name}-v1`
  return material
}

function createLifeMesh(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  life: readonly LakeLife[],
): THREE.InstancedMesh {
  const phases = new Float32Array(life.length)
  const drifts = new Float32Array(life.length)
  geometry.setAttribute('lifePhase', new THREE.InstancedBufferAttribute(phases, 1))
  geometry.setAttribute('lifeDrift', new THREE.InstancedBufferAttribute(drifts, 1))
  const mesh = new THREE.InstancedMesh(geometry, material, life.length)
  mesh.name = name
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const rotation = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const color = new THREE.Color()
  const yAxis = new THREE.Vector3(0, 1, 0)
  for (let index = 0; index < life.length; index++) {
    const item = life[index]!
    position.set(item.x, item.y + 0.025, item.z)
    rotation.setFromAxisAngle(yAxis, item.yaw)
    matrix.compose(position, rotation, scale)
    mesh.setMatrixAt(index, matrix)
    if ((material as THREE.MeshStandardMaterial).vertexColors) mesh.setColorAt(index, color.setHex(item.color))
    phases[index] = item.phase
    drifts[index] = item.drift
  }
  mesh.instanceMatrix.addUpdateRange(0, life.length * 16)
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.StaticDrawUsage)
    mesh.instanceColor.addUpdateRange(0, life.length * 3)
    mesh.instanceColor.needsUpdate = true
  }
  mesh.computeBoundingBox()
  mesh.computeBoundingSphere()
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.1
  return mesh
}

function lifeAt(
  x: number,
  y: number,
  tileSize: number,
  salt: number,
  colors: readonly number[],
  modelIds: readonly number[],
  elevation: number,
): LakeLife {
  const random = rng(seed(x, y, salt))
  return {
    x: (x + (random() - 0.5) * 0.42) * tileSize,
    y: elevation,
    z: (y + (random() - 0.5) * 0.42) * tileSize,
    yaw: random() * Math.PI * 2,
    phase: random() * Math.PI * 2,
    drift: 0.65 + random() * 0.7,
    color: colors[Math.floor(random() * colors.length)]!,
    modelId: modelIds[Math.floor(random() * modelIds.length)]!,
  }
}

const BOAT_FALLBACK_ARCHETYPE = 209
const BOAT_ARCHETYPES = [301, 484, 485, 486, 487] as const
const BUOY_ARCHETYPES = [0] as const

function collectLoadedGeometry(
  registry: Pick<ArchetypeRegistry, 'has' | 'get'>,
  ids: readonly number[],
  fallbackId: number,
  out: Map<number, THREE.BufferGeometry>,
): void {
  const fallback = registry.has(fallbackId) ? registry.get(fallbackId).geometry.near : null
  for (const id of ids) {
    if (!registry.has(id)) continue
    const geometry = registry.get(id).geometry.near
    if (geometry && geometry !== fallback) out.set(id, geometry)
  }
}

function groupByModel(
  life: readonly LakeLife[],
  available: ReadonlyMap<number, THREE.BufferGeometry>,
): Map<number, LakeLife[]> {
  const ids = [...available.keys()].sort((a, b) => a - b)
  const batches = new Map<number, LakeLife[]>()
  for (const item of life) {
    const modelId = available.has(item.modelId)
      ? item.modelId
      : ids[seed(Math.round(item.x * 100), Math.round(item.z * 100), 0x85ebca6b) % ids.length]!
    const batch = batches.get(modelId) ?? []
    batch.push(item)
    batches.set(modelId, batch)
  }
  return batches
}

function selectsCell(x: number, y: number, modulus: number, residue: number): boolean {
  return seed(x, y, 0x9e3779b9) % modulus === residue
}

function seed(x: number, y: number, salt: number): number {
  let value = ((x * 73_856_093) ^ (y * 19_349_663) ^ salt) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
  return (value ^ (value >>> 16)) >>> 0
}

function rng(initial: number): () => number {
  let value = initial
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0
    return value / 0xffff_ffff
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3
}

function emptyStats(): EnvironmentLifeLayerStats {
  return { boats: 0, buoys: 0, instances: 0, drawCalls: 0, triangles: 0 }
}
