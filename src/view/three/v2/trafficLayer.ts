import * as THREE from 'three'
import type { ViewportChunkManager } from './chunks'
import {
  SurfaceKind,
  type ChunkId,
  type SurfaceTexel,
  type ViewportRenderSource,
} from './types'

const BODY_COLORS = [0x3366cc, 0xcc3333, 0xeeeeee, 0x222222, 0xffaa22] as const
const CABIN_COLOR = 0x88aacc
const MAX_VEHICLES_PER_CHUNK = 192

export interface TrafficLayerStats {
  vehicles: number
  drawCalls: number
  triangles: number
}

interface TrafficVehicle {
  x: number
  z: number
  yaw: number
  phase: number
  speed: number
  color: number
}

interface TrafficTimeState {
  value: number
}

/**
 * Decorative traffic projected only from visible road terrain. It is entirely
 * read-only with respect to simulation state. Vehicle motion happens in the
 * vertex shader, so animation performs no per-frame instance-buffer writes.
 */
export class TrafficLayer {
  readonly root = new THREE.Group()
  stats: TrafficLayerStats = { vehicles: 0, drawCalls: 0, triangles: 0 }

  private readonly bodyMaterial = createTrafficMaterial('body', 0.35, 0.45)
  private readonly cabinMaterial = createTrafficMaterial('cabin', 0.28, 0.35)
  private readonly timeStates: TrafficTimeState[]
  private body: THREE.InstancedMesh | null = null
  private cabin: THREE.InstancedMesh | null = null
  private signature = ''

  constructor() {
    this.root.name = 'visible-road-traffic'
    this.timeStates = [
      this.bodyMaterial.userData.trafficTime as TrafficTimeState,
      this.cabinMaterial.userData.trafficTime as TrafficTimeState,
    ]
  }

  update(
    visibleChunks: ReadonlySet<ChunkId>,
    chunks: ViewportChunkManager,
    source: ViewportRenderSource,
  ): void {
    const ordered = [...visibleChunks].sort((a, b) => a - b)
    const nextSignature = ordered
      .map(
        (chunkId) =>
          `${chunkId}:${source.getSurfaceRevision?.(chunkId) ?? source.getChunkRevision(chunkId)}`,
      )
      .join(',')
    if (nextSignature === this.signature) return
    this.signature = nextSignature

    const vehicles: TrafficVehicle[] = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (const chunkId of ordered) {
      const bounds = chunks.chunkBounds(chunkId)
      let chunkVehicles = 0
      for (let y = bounds.minY; y < bounds.maxY; y++) {
        for (let x = bounds.minX; x < bounds.maxX; x++) {
          source.readSurface(y * source.width + x, texel)
          if (texel.kind !== SurfaceKind.road || bitCount4(texel.neighborMask) < 1) continue
          const vehicle = legacyVehicleAt(x, y, texel.neighborMask, source.tileSize)
          if (vehicle) {
            vehicles.push(vehicle)
            chunkVehicles++
          }
          // A per-chunk quota keeps density spatially stable as chunks enter
          // and leave the viewport; no global prefix can starve later chunks.
          if (chunkVehicles >= MAX_VEHICLES_PER_CHUNK) break
        }
        if (chunkVehicles >= MAX_VEHICLES_PER_CHUNK) break
      }
    }
    this.rebuild(vehicles)
  }

  setFrame(timeSeconds: number): void {
    for (const state of this.timeStates) state.value = timeSeconds
  }

  dispose(): void {
    this.clearMeshes()
    this.bodyMaterial.dispose()
    this.cabinMaterial.dispose()
    this.root.clear()
  }

  private rebuild(vehicles: readonly TrafficVehicle[]): void {
    this.clearMeshes()
    if (vehicles.length === 0) {
      this.stats = { vehicles: 0, drawCalls: 0, triangles: 0 }
      return
    }

    this.body = createVehicleMesh(
      'traffic-bodies',
      new THREE.BoxGeometry(0.22, 0.07, 0.11).translate(0, 0.09, 0),
      this.bodyMaterial,
      vehicles,
      false,
    )
    this.cabin = createVehicleMesh(
      'traffic-cabins',
      new THREE.BoxGeometry(0.1, 0.05, 0.08).translate(0, 0.14, 0),
      this.cabinMaterial,
      vehicles,
      true,
    )
    this.root.add(this.body, this.cabin)
    this.stats = {
      vehicles: vehicles.length,
      drawCalls: 2,
      triangles: vehicles.length * 24,
    }
  }

  private clearMeshes(): void {
    for (const mesh of [this.body, this.cabin]) {
      if (!mesh) continue
      this.root.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.body = null
    this.cabin = null
  }
}

function createTrafficMaterial(
  name: string,
  roughness: number,
  metalness: number,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: `traffic-${name}`,
    color: 0xffffff,
    vertexColors: true,
    roughness,
    metalness,
    fog: true,
  })
  const time: TrafficTimeState = { value: 0 }
  material.userData.trafficTime = time
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrafficTime = time
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        'attribute float trafficPhase;\nattribute float trafficSpeed;\nuniform float uTrafficTime;\nvoid main() {',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed.x += sin(uTrafficTime * trafficSpeed + trafficPhase) * 0.29;',
      )
  }
  material.customProgramCacheKey = () => 'labline-instanced-traffic-v1'
  return material
}

function createVehicleMesh(
  name: string,
  geometry: THREE.BoxGeometry,
  material: THREE.Material,
  vehicles: readonly TrafficVehicle[],
  cabin: boolean,
): THREE.InstancedMesh {
  const phases = new Float32Array(vehicles.length)
  const speeds = new Float32Array(vehicles.length)
  geometry.setAttribute('trafficPhase', new THREE.InstancedBufferAttribute(phases, 1))
  geometry.setAttribute('trafficSpeed', new THREE.InstancedBufferAttribute(speeds, 1))
  const mesh = new THREE.InstancedMesh(geometry, material, vehicles.length)
  mesh.name = name
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  mesh.frustumCulled = true
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const color = new THREE.Color()
  const yAxis = new THREE.Vector3(0, 1, 0)
  for (let index = 0; index < vehicles.length; index++) {
    const vehicle = vehicles[index]!
    position.set(vehicle.x, 0, vehicle.z)
    quaternion.setFromAxisAngle(yAxis, vehicle.yaw)
    matrix.compose(position, quaternion, scale)
    mesh.setMatrixAt(index, matrix)
    mesh.setColorAt(index, color.setHex(cabin ? CABIN_COLOR : vehicle.color))
    phases[index] = vehicle.phase
    speeds[index] = vehicle.speed
  }
  mesh.instanceMatrix.addUpdateRange(0, vehicles.length * 16)
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) {
    mesh.instanceColor.setUsage(THREE.StaticDrawUsage)
    mesh.instanceColor.addUpdateRange(0, vehicles.length * 3)
    mesh.instanceColor.needsUpdate = true
  }
  mesh.computeBoundingBox()
  mesh.computeBoundingSphere()
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.35
  return mesh
}

function legacyVehicleAt(
  x: number,
  y: number,
  mask: number,
  tileSize: number,
): TrafficVehicle | null {
  const random = rng(seed(x, y))
  if (random() <= 0.42) return null
  const color = BODY_COLORS[Math.floor(random() * BODY_COLORS.length)]!
  const northSouth = (mask & 0b0101) !== 0
  const eastWest = (mask & 0b1010) !== 0
  const alongX = eastWest && (!northSouth || random() > 0.45)
  const phase = random() * Math.PI * 2
  const speed = 0.8 + random() * 0.9
  return {
    x: x * tileSize,
    z: y * tileSize,
    yaw: alongX ? 0 : Math.PI / 2,
    phase,
    speed,
    color,
  }
}

function seed(x: number, y: number): number {
  return ((x * 73_856_093) ^ (y * 19_349_663)) >>> 0
}

function rng(initial: number): () => number {
  let value = initial
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0
    return value / 0xffff_ffff
  }
}

function bitCount4(mask: number): number {
  let value = mask & 0x0f
  let count = 0
  while (value !== 0) {
    value &= value - 1
    count++
  }
  return count
}
