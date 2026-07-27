import * as THREE from 'three'
import type { RoadNetworkSnapshot } from '../../../sim/world'
import type { VisualTrafficVehicle } from './visualTraffic'
import {
  BALANCED_LOGICAL_VEHICLES,
  BALANCED_VISIBLE_VEHICLES,
  VisualTrafficSimulation,
} from './visualTraffic'
import type { ArchetypeRegistry } from './archetypes'
import type { ViewportChunkManager } from './chunks'
import {
  SurfaceKind,
  type ChunkId,
  type SurfaceTexel,
  type ViewportRenderSource,
} from './types'

const BODY_COLORS = [
  0x2d6fbd, 0x55a0d8, 0x9f3045, 0xd54f43, 0xf1eee4, 0xc8cdd3, 0x737b84,
  0xe1a12c, 0x3f936d, 0x6f55a0, 0xa86e43, 0x8e9a66, 0xe1c899, 0xe77832,
  0x31949c, 0xb83f70, 0x6da64d, 0xd7dce3,
] as const
const CABIN_COLORS = [0x8aa7b8, 0x617784, 0xa7b5bb, 0x4d626f, 0x7893a0] as const
const MAX_VEHICLES_PER_CHUNK = 192

export interface TrafficLayerStats {
  vehicles: number
  instances: number
  drawCalls: number
  triangles: number
}

interface TrafficVehicle {
  x: number
  y: number
  z: number
  yaw: number
  color: number
  modelId: number
  state?: VisualTrafficVehicle
}

interface TrafficTimeState {
  value: number
}

/**
 * Visual traffic consumes the immutable lane graph and canonical congestion,
 * but never writes simulation state. Motion advances at a deterministic 10 Hz;
 * the shader interpolates endpoint buffers at render frequency.
 */
export class TrafficLayer {
  readonly root = new THREE.Group()
  stats: TrafficLayerStats = { vehicles: 0, instances: 0, drawCalls: 0, triangles: 0 }

  private readonly bodyMaterial = createTrafficMaterial('body', 0.35, 0.45)
  private readonly cabinMaterial = createTrafficMaterial('cabin', 0.28, 0.35)
  private readonly authoredMaterial = createTrafficMaterial('authored', 0.42, 0.18)
  private readonly timeStates: TrafficTimeState[]
  private readonly authoredGeometry = new Map<number, THREE.BufferGeometry>()
  private body: THREE.InstancedMesh | null = null
  private cabin: THREE.InstancedMesh | null = null
  private signature = ''
  private simulationKey = ''
  private simulation: VisualTrafficSimulation | null = null
  private displayedVehicleIds = new Set<number>()
  private projectedVisibleChunks = new Set<ChunkId>()
  private projectionChunks: ViewportChunkManager | null = null
  private projectionNetwork: RoadNetworkSnapshot | null = null
  private rosterKey = ''
  private paused = false
  private readonly maxLogical: number
  private readonly maxVisible: number

  constructor(
    registry?: Pick<ArchetypeRegistry, 'has' | 'get'>,
    limits: { logical?: number; visible?: number } = {},
  ) {
    this.maxLogical = Math.max(0, limits.logical ?? BALANCED_LOGICAL_VEHICLES)
    this.maxVisible = Math.max(0, limits.visible ?? BALANCED_VISIBLE_VEHICLES)
    this.root.name = 'visible-road-traffic'
    if (registry) {
      for (const id of VEHICLE_ARCHETYPES) {
        const geometry = loadedGeometry(registry, id, VEHICLE_FALLBACK_ARCHETYPE)
        if (geometry) this.authoredGeometry.set(id, geometry)
      }
    }
    this.timeStates = [
      this.bodyMaterial.userData.trafficTime as TrafficTimeState,
      this.cabinMaterial.userData.trafficTime as TrafficTimeState,
      this.authoredMaterial.userData.trafficTime as TrafficTimeState,
    ]
  }

  update(
    visibleChunks: ReadonlySet<ChunkId>,
    chunks: ViewportChunkManager,
    source: ViewportRenderSource,
  ): void {
    const ordered = [...visibleChunks].sort((a, b) => a - b)
    const network = source.getRoadNetwork?.()
    const transport = source.getTransportRuntimeState?.()
    this.paused = source.isSimulationPaused?.() ?? false
    const nextSignature = ordered
      .map(
        (chunkId) =>
          `${chunkId}:${source.getSurfaceRevision?.(chunkId) ?? source.getChunkRevision(chunkId)}`,
      )
      .join(',') + `|road:${network?.revision ?? -1}`
    if (nextSignature === this.signature) return
    this.signature = nextSignature
    if (network && network.lanes.length > 0 && this.maxVisible > 0) {
      const utilization = new Map<number, number>()
      for (const load of transport?.segmentLoads ?? []) {
        utilization.set(load.segmentId, load.utilization)
      }
      const simulationKey = `${network.revision}:${network.drivingSide}`
      if (!this.simulation || this.simulationKey !== simulationKey) {
        this.simulationKey = simulationKey
        this.simulation = new VisualTrafficSimulation(
          network,
          new Set(network.chunks.keys()),
          source.tileSize,
          utilization,
          this.maxLogical,
        )
        this.displayedVehicleIds.clear()
        this.rosterKey = ''
      }
      this.projectedVisibleChunks = new Set(visibleChunks)
      this.projectionChunks = chunks
      this.projectionNetwork = network
      this.reconcileSimulationProjection()
      return
    }
    this.simulation = null
    this.displayedVehicleIds.clear()
    this.projectionChunks = null
    this.projectionNetwork = null
    this.rosterKey = ''

    const vehicles: TrafficVehicle[] = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (const chunkId of ordered) {
      const bounds = chunks.chunkBounds(chunkId)
      let chunkVehicles = 0
      for (let y = bounds.minY; y < bounds.maxY; y++) {
        for (let x = bounds.minX; x < bounds.maxX; x++) {
          texel.transport = undefined
          source.readSurface(y * source.width + x, texel)
          const packedTransport = texel.transport ?? 0
          const isTransport = packedTransport !== 0
          if (!isTransport && texel.kind !== SurfaceKind.road) continue
          const topology = isTransport
            ? packedTransport & 0xff
            : legacyMaskToClockwise(texel.neighborMask)
          if (bitCount8(topology) < 1) continue
          const roadClass = isTransport ? (packedTransport >>> 8) & 0x07 : 1
          const vehicle = vehicleAt(
            x,
            y,
            topology,
            roadClass,
            source.tileSize,
            source.getTileElevation?.(x, y) ?? 0,
          )
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
    const stepped = this.simulation?.setFrame(timeSeconds, this.paused) ?? false
    for (const state of this.timeStates) state.value = this.simulation?.interpolation ?? 0
    if (stepped) {
      this.reconcileSimulationProjection()
      for (const mesh of [this.body, this.cabin, ...this.authoredMeshes]) {
        if (mesh) uploadTrafficEndpoints(mesh)
      }
    }
  }

  dispose(): void {
    this.clearMeshes()
    this.bodyMaterial.dispose()
    this.cabinMaterial.dispose()
    this.authoredMaterial.dispose()
    this.root.clear()
  }

  private rebuild(vehicles: readonly TrafficVehicle[]): void {
    this.clearMeshes()
    if (vehicles.length === 0) {
      this.stats = { vehicles: 0, instances: 0, drawCalls: 0, triangles: 0 }
      return
    }

    if (this.authoredGeometry.size > 0) {
      let triangles = 0
      const batches = groupByModel(vehicles, this.authoredGeometry)
      for (const [modelId, batch] of batches) {
        // Instance attributes belong to the layer and are disposed on rebuild;
        // never mutate or dispose geometry owned by the shared registry.
        const geometry = this.authoredGeometry.get(modelId)!.clone()
        const mesh = createVehicleMesh(
          `traffic-authored-${modelId}`,
          geometry,
          this.authoredMaterial,
          batch,
          false,
          false,
        )
        this.root.add(mesh)
        this.authoredMeshes.push(mesh)
        triangles += triangleCount(geometry) * batch.length
      }
      this.stats = {
        vehicles: vehicles.length,
        instances: vehicles.length,
        drawCalls: this.authoredMeshes.length,
        triangles,
      }
      return
    }

    this.body = createVehicleMesh(
      'traffic-bodies',
      new THREE.BoxGeometry(0.22, 0.07, 0.11).translate(0, 0.09, 0),
      this.bodyMaterial,
      vehicles,
      false,
      true,
    )
    this.cabin = createVehicleMesh(
      'traffic-cabins',
      new THREE.BoxGeometry(0.1, 0.05, 0.08).translate(0, 0.14, 0),
      this.cabinMaterial,
      vehicles,
      true,
      true,
    )
    this.root.add(this.body, this.cabin)
    this.stats = {
      vehicles: vehicles.length,
      instances: vehicles.length * 2,
      drawCalls: 2,
      triangles: vehicles.length * 24,
    }
  }

  private reconcileSimulationProjection(): void {
    const simulation = this.simulation
    const chunks = this.projectionChunks
    const network = this.projectionNetwork
    if (!simulation || !chunks || !network) return
    const visibleSegmentIds = new Set<string>()
    for (const chunkId of this.projectedVisibleChunks) {
      for (const segmentId of network.chunks.get(chunkId)?.segmentIds ?? []) {
        visibleSegmentIds.add(segmentId)
      }
    }
    const haloSegmentIds = new Set<string>(visibleSegmentIds)
    for (const chunkId of trafficHaloChunks(this.projectedVisibleChunks, chunks)) {
      for (const segmentId of network.chunks.get(chunkId)?.segmentIds ?? []) {
        haloSegmentIds.add(segmentId)
      }
    }
    const laneSegment = (state: VisualTrafficVehicle) =>
      network.lanes[state.route[state.routeIndex]!]!.segmentId
    const byId = new Map(simulation.vehicles.map((vehicle) => [vehicle.id, vehicle]))
    const retained = [...this.displayedVehicleIds]
      .map((id) => byId.get(id))
      .filter((state): state is VisualTrafficVehicle =>
        !!state && haloSegmentIds.has(laneSegment(state)))
    const selected = new Map(retained.map((state) => [state.id, state]))
    const fill = (candidates: readonly VisualTrafficVehicle[]) => {
      for (const state of candidates) {
        if (selected.size >= this.maxVisible) break
        if (!selected.has(state.id)) selected.set(state.id, state)
      }
    }
    const stableVehicles = [...simulation.vehicles].sort((a, b) => a.id - b.id)
    fill(stableVehicles.filter((state) => visibleSegmentIds.has(laneSegment(state))))
    fill(stableVehicles.filter((state) => haloSegmentIds.has(laneSegment(state))))
    const ordered = [...selected.values()].sort((a, b) => a.id - b.id)
    const nextRosterKey = ordered.map((state) => state.id).join(',')
    this.displayedVehicleIds = new Set(selected.keys())
    if (nextRosterKey === this.rosterKey) return
    this.rosterKey = nextRosterKey
    this.rebuild(ordered.map((state): TrafficVehicle => {
      return {
        x: state.current.x,
        y: state.current.y,
        z: state.current.z,
        yaw: state.current.yaw,
        color: BODY_COLORS[state.colorIndex % BODY_COLORS.length]!,
        // Vehicle type is lifelong; changing road class must never morph a car
        // when an unrelated roster slot refreshes.
        modelId: VEHICLE_ARCHETYPES[state.modelChoice % VEHICLE_ARCHETYPES.length]!,
        state,
      }
    }))
  }

  private clearMeshes(): void {
    for (const mesh of [this.body, this.cabin, ...this.authoredMeshes]) {
      if (!mesh) continue
      this.root.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.body = null
    this.cabin = null
    this.authoredMeshes.length = 0
  }

  private readonly authoredMeshes: THREE.InstancedMesh[] = []
}

function createTrafficMaterial(
  name: string,
  roughness: number,
  metalness: number,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: `traffic-${name}`,
    color: 0xffffff,
    // Authored vehicle packs include dark baked vertex colors. Multiplying
    // instance paint by those colors made every body appear black. Instance
    // color remains active independently and is the authoritative paint tint.
    vertexColors: false,
    roughness,
    metalness,
    fog: true,
  })
  const interpolation: TrafficTimeState = { value: 0 }
  material.userData.trafficTime = interpolation
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrafficInterpolation = interpolation
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        'attribute vec3 trafficDelta;\nattribute float trafficYawDelta;\nattribute float trafficVisible;\nuniform float uTrafficInterpolation;\nvoid main() {',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed *= trafficVisible;\nfloat trafficYaw = trafficYawDelta * uTrafficInterpolation;\nmat2 trafficRotation = mat2(cos(trafficYaw), -sin(trafficYaw), sin(trafficYaw), cos(trafficYaw));\ntransformed.xz = trafficRotation * transformed.xz;\ntransformed += trafficDelta * uTrafficInterpolation;',
      )
  }
  material.customProgramCacheKey = () => 'labline-instanced-traffic-v2'
  return material
}

function createVehicleMesh(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  vehicles: readonly TrafficVehicle[],
  cabin: boolean,
  profiled: boolean,
): THREE.InstancedMesh {
  const deltas = new Float32Array(vehicles.length * 3)
  const yawDeltas = new Float32Array(vehicles.length)
  const visible = new Float32Array(vehicles.length)
  visible.fill(1)
  geometry.setAttribute('trafficDelta', new THREE.InstancedBufferAttribute(deltas, 3))
  geometry.setAttribute('trafficYawDelta', new THREE.InstancedBufferAttribute(yawDeltas, 1))
  geometry.setAttribute('trafficVisible', new THREE.InstancedBufferAttribute(visible, 1))
  const mesh = new THREE.InstancedMesh(geometry, material, vehicles.length)
  mesh.name = name
  mesh.instanceMatrix.setUsage(vehicles.some((vehicle) => vehicle.state)
    ? THREE.DynamicDrawUsage
    : THREE.StaticDrawUsage)
  // These instances move independently after the creation-time bounds are
  // computed. A stale aggregate sphere can cull cars that are currently in
  // view, which looks exactly like despawning while the camera moves.
  mesh.frustumCulled = false
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const color = new THREE.Color()
  const yAxis = new THREE.Vector3(0, 1, 0)
  for (let index = 0; index < vehicles.length; index++) {
    const vehicle = vehicles[index]!
    const pose = vehicle.state?.previous
    position.set(pose?.x ?? vehicle.x, pose?.y ?? vehicle.y + 0.035, pose?.z ?? vehicle.z)
    quaternion.setFromAxisAngle(yAxis, pose?.yaw ?? vehicle.yaw)
    applyVehicleScale(scale, profiled ? (vehicle.state?.modelChoice ?? vehicle.modelId) : -1)
    matrix.compose(position, quaternion, scale)
    mesh.setMatrixAt(index, matrix)
    mesh.setColorAt(index, color.setHex(cabin
      ? CABIN_COLORS[(vehicle.state?.modelChoice ?? vehicle.modelId) % CABIN_COLORS.length]!
      : vehicle.color))
  }
  mesh.userData.trafficVehicles = vehicles
  mesh.userData.trafficProfiled = profiled
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
  // A roster refresh must preserve the current interpolation endpoint. Zeroed
  // deltas would pull every retained car back one fixed step for a frame.
  if (vehicles.some((vehicle) => vehicle.state)) uploadTrafficEndpoints(mesh)
  return mesh
}

function uploadTrafficEndpoints(mesh: THREE.InstancedMesh): void {
  const vehicles = mesh.userData.trafficVehicles as readonly TrafficVehicle[] | undefined
  if (!vehicles) return
  const delta = mesh.geometry.getAttribute('trafficDelta') as THREE.InstancedBufferAttribute
  const yawDelta = mesh.geometry.getAttribute('trafficYawDelta') as THREE.InstancedBufferAttribute
  const visible = mesh.geometry.getAttribute('trafficVisible') as THREE.InstancedBufferAttribute
  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3(1, 1, 1)
  const yAxis = new THREE.Vector3(0, 1, 0)
  for (let index = 0; index < vehicles.length; index++) {
    const vehicle = vehicles[index]!
    const state = vehicle.state
    if (!state) continue
    const dx = state.current.x - state.previous.x
    const dz = state.current.z - state.previous.z
    const cos = Math.cos(state.previous.yaw)
    const sin = Math.sin(state.previous.yaw)
    position.set(state.previous.x, state.previous.y, state.previous.z)
    quaternion.setFromAxisAngle(yAxis, state.previous.yaw)
    applyVehicleScale(scale, mesh.userData.trafficProfiled ? state.modelChoice : -1)
    matrix.compose(position, quaternion, scale)
    mesh.setMatrixAt(index, matrix)
    // Shader translation occurs before instance rotation, so store the world
    // endpoint delta in the instance's local coordinate system.
    delta.setXYZ(index, cos * dx - sin * dz, state.current.y - state.previous.y, sin * dx + cos * dz)
    yawDelta.setX(index, shortestAngle(state.current.yaw - state.previous.yaw))
    // Terminal vehicles remain visible at their destination; connected routes
    // are extended by the simulation before arrival and continue smoothly.
    visible.setX(index, 1)
  }
  delta.needsUpdate = true
  yawDelta.needsUpdate = true
  visible.needsUpdate = true
  mesh.instanceMatrix.needsUpdate = true
}

function applyVehicleScale(target: THREE.Vector3, choice: number): void {
  if (choice < 0) {
    target.set(1, 1, 1)
    return
  }
  switch (choice % 6) {
    case 0: target.set(0.78, 0.9, 0.88); break // compact
    case 1: target.set(1, 0.96, 1); break // sedan
    case 2: target.set(1.14, 1.02, 1); break // estate
    case 3: target.set(1.04, 1.24, 1.05); break // SUV
    case 4: target.set(1.18, 1.34, 1.08); break // van
    default: target.set(1.1, 1.08, 1.03); break // pickup / utility
  }
}

function trafficHaloChunks(
  visible: ReadonlySet<ChunkId>,
  chunks: ViewportChunkManager,
): Set<ChunkId> {
  const result = new Set<ChunkId>()
  for (const chunkId of visible) {
    const chunkX = chunkId % chunks.chunksWide
    const chunkY = Math.floor(chunkId / chunks.chunksWide)
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const x = chunkX + ox
        const y = chunkY + oy
        if (x < 0 || y < 0 || x >= chunks.chunksWide || y >= chunks.chunksHigh) continue
        result.add((y * chunks.chunksWide + x) as ChunkId)
      }
    }
  }
  return result
}

function shortestAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value))
}

function vehicleAt(
  x: number,
  y: number,
  topology: number,
  roadClass: number,
  tileSize: number,
  elevation: number,
): TrafficVehicle | null {
  const random = rng(seed(x, y))
  // Major routes read as busy without flooding local residential streets.
  const placementChance = roadClass >= 4 ? 0.88 : roadClass === 3 ? 0.76 : roadClass === 2 ? 0.58 : 0.38
  if (random() > placementChance) return null
  const color = BODY_COLORS[Math.floor(random() * BODY_COLORS.length)]!
  const yaw = topologyTangent(topology, random())
  const variants = roadClass >= 3 ? MAJOR_VEHICLE_ARCHETYPES : LOCAL_VEHICLE_ARCHETYPES
  const modelId = variants[Math.floor(random() * variants.length)]!
  return {
    x: x * tileSize,
    y: elevation,
    z: y * tileSize,
    yaw,
    color,
    modelId,
  }
}

const VEHICLE_FALLBACK_ARCHETYPE = 5
const VEHICLE_ARCHETYPES = [300, 473, 474, 475, 476, 477, 478, 479, 480, 481, 482, 483] as const
const LOCAL_VEHICLE_ARCHETYPES = [473, 474, 475, 476, 477, 478, 483] as const
const MAJOR_VEHICLE_ARCHETYPES = VEHICLE_ARCHETYPES

function loadedGeometry(
  registry: Pick<ArchetypeRegistry, 'has' | 'get'>,
  id: number,
  fallbackId: number,
): THREE.BufferGeometry | null {
  if (!registry.has(id)) return null
  const geometry = registry.get(id).geometry.near
  if (!geometry) return null
  if (registry.has(fallbackId) && geometry === registry.get(fallbackId).geometry.near) return null
  return geometry
}

function groupByModel(
  vehicles: readonly TrafficVehicle[],
  available: ReadonlyMap<number, THREE.BufferGeometry>,
): Map<number, TrafficVehicle[]> {
  const ids = [...available.keys()].sort((a, b) => a - b)
  const batches = new Map<number, TrafficVehicle[]>()
  for (const vehicle of vehicles) {
    const modelId = available.has(vehicle.modelId)
      ? vehicle.modelId
      : ids[(vehicle.state?.id ?? seed(
        Math.round(vehicle.x * 100),
        Math.round(vehicle.z * 100),
      )) % ids.length]!
    const batch = batches.get(modelId) ?? []
    batch.push(vehicle)
    batches.set(modelId, batch)
  }
  return batches
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3
}

/** Pick a connected capsule tangent; opposite directions share orientation. */
function topologyTangent(topology: number, choice: number): number {
  const candidates: number[] = []
  if ((topology & (4 | 64)) !== 0) candidates.push(0)
  if ((topology & (1 | 16)) !== 0) candidates.push(Math.PI / 2)
  if ((topology & (2 | 32)) !== 0) candidates.push(Math.PI / 4)
  if ((topology & (8 | 128)) !== 0) candidates.push(-Math.PI / 4)
  return candidates[Math.min(candidates.length - 1, Math.floor(choice * candidates.length))] ?? 0
}

function legacyMaskToClockwise(mask: number): number {
  return (mask & 1) | ((mask & 2) << 1) | ((mask & 4) << 2) | ((mask & 8) << 3)
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

function bitCount8(mask: number): number {
  let value = mask & 0xff
  let count = 0
  while (value !== 0) {
    value &= value - 1
    count++
  }
  return count
}
