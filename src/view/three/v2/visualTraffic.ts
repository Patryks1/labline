import type {
  DirectedLane,
  LaneConnector,
  RoadNetworkPoint,
  RoadNetworkSnapshot,
} from '../../../sim/world'

export const TRAFFIC_STEP_SECONDS = 0.1
export const BALANCED_LOGICAL_VEHICLES = 1_024
export const BALANCED_VISIBLE_VEHICLES = 320
export const QUALITY_LOGICAL_VEHICLES = 2_048
export const QUALITY_VISIBLE_VEHICLES = 640

export interface VisualTrafficPose {
  x: number
  y: number
  z: number
  yaw: number
}

export interface VisualTrafficVehicle {
  readonly id: number
  readonly route: number[]
  readonly colorIndex: number
  readonly modelChoice: number
  /** Stable 0..1 activation order within the road chunk that spawned it. */
  readonly densityRank: number
  routeIndex: number
  distance: number
  speed: number
  arrived: boolean
  connectorDistance: number | null
  continuationCount: number
  previous: VisualTrafficPose
  current: VisualTrafficPose
}

export interface VisualTrafficStats {
  steps: number
  utilizationRefreshes: number
}

interface LaneMetrics {
  cumulative: Float32Array
  length: number
}

interface ConnectorMetrics extends LaneMetrics {
  points: readonly RoadNetworkPoint[]
}

interface SpawnCandidate {
  readonly lane: DirectedLane
  readonly id: number
  readonly load: number
}

/**
 * Small, deterministic render-only lane simulation. Its state is deliberately
 * not serialised: the canonical daily congestion snapshot is the only traffic
 * state owned by gameplay.
 */
export class VisualTrafficSimulation {
  readonly vehicles: VisualTrafficVehicle[]
  readonly network: RoadNetworkSnapshot
  readonly stats: VisualTrafficStats = { steps: 0, utilizationRefreshes: 0 }
  interpolation = 0
  lastFrameSteps = 0

  private readonly laneMetrics = new Map<number, LaneMetrics>()
  private readonly connectorByPair = new Map<string, LaneConnector>()
  private readonly connectorMetrics = new Map<string, ConnectorMetrics>()
  private readonly adjacency: readonly number[][]
  private readonly orderedVehicles: VisualTrafficVehicle[]
  private readonly aheadByLane: Float64Array
  private readonly vehiclesBySegment = new Map<string, Set<VisualTrafficVehicle>>()
  private readonly vehicleSegment = new Map<number, string>()
  private readonly segmentIndexById = new Map<string, number>()
  private readonly segmentRoadClassById = new Map<string, number>()
  private readonly utilization = new Map<number, number>()
  private readonly tileSize: number
  private lastTime: number | null = null
  private accumulator = 0
  private tick = 0

  constructor(
    network: RoadNetworkSnapshot,
    visibleChunkIds: ReadonlySet<number>,
    tileSize: number,
    segmentUtilization: ReadonlyMap<number, number> = new Map(),
    maxVisible = BALANCED_VISIBLE_VEHICLES,
  ) {
    this.network = network
    this.tileSize = tileSize
    for (const [segmentIndex, load] of segmentUtilization) this.utilization.set(segmentIndex, load)
    for (const lane of network.lanes) {
      this.laneMetrics.set(lane.index, metricsFor(lane.points))
    }
    this.adjacency = laneAdjacency(network)
    for (const connector of network.connectors) {
      const key = `${connector.fromLaneId}>${connector.toLaneId}`
      this.connectorByPair.set(key, connector)
      const from = network.lanes.find((lane) => lane.id === connector.fromLaneId)
      const to = network.lanes.find((lane) => lane.id === connector.toLaneId)
      const junction = network.junctions.find((candidate) => candidate.id === connector.junctionId)
      if (from && to) this.connectorMetrics.set(key, metricsForConnector(from, to, junction))
    }
    this.vehicles = this.spawn(visibleChunkIds, segmentUtilization, maxVisible)
    this.orderedVehicles = this.vehicles.slice()
    this.aheadByLane = new Float64Array(network.lanes.length)
    for (const segment of network.segments) {
      this.vehiclesBySegment.set(segment.id, new Set())
      this.segmentIndexById.set(segment.id, segment.index)
      this.segmentRoadClassById.set(segment.id, segment.roadClass)
    }
    for (const vehicle of this.vehicles) this.syncVehicleSegment(vehicle)
  }

  setFrame(timeSeconds: number, paused: boolean): boolean {
    this.lastFrameSteps = 0
    if (this.lastTime === null || timeSeconds < this.lastTime) {
      this.lastTime = timeSeconds
      this.interpolation = 0
      return false
    }
    const elapsed = Math.min(0.5, Math.max(0, timeSeconds - this.lastTime))
    this.lastTime = timeSeconds
    if (paused) return false
    this.accumulator += elapsed
    let changed = false
    while (this.accumulator >= TRAFFIC_STEP_SECONDS) {
      this.step()
      this.accumulator -= TRAFFIC_STEP_SECONDS
      changed = true
      this.lastFrameSteps++
    }
    this.interpolation = this.accumulator / TRAFFIC_STEP_SECONDS
    return changed
  }

  /** Applies a new canonical daily load snapshot without rebuilding lane topology or routes. */
  refreshUtilization(utilization: ReadonlyMap<number, number>): void {
    this.utilization.clear()
    for (const [segmentIndex, load] of utilization) this.utilization.set(segmentIndex, load)
    for (const vehicle of this.vehicles) {
      const lane = this.network.lanes[vehicle.route[vehicle.routeIndex]!]!
      const segmentIndex = this.segmentIndexById.get(lane.segmentId) ?? -1
      vehicle.speed = speedFor(lane, clamp(utilization.get(segmentIndex) ?? 0.2, 0, 2), vehicle.id)
    }
    this.stats.utilizationRefreshes++
  }

  /** Deterministic segment-indexed query used by viewport projection. */
  vehiclesInSegments(segmentIds: ReadonlySet<string>): VisualTrafficVehicle[] {
    const result: VisualTrafficVehicle[] = []
    for (const segmentId of segmentIds) {
      for (const vehicle of this.vehiclesBySegment.get(segmentId) ?? []) {
        if (this.isDensityEligible(vehicle, segmentId)) result.push(vehicle)
      }
    }
    return result.sort((a, b) => a.id - b.id)
  }

  private isDensityEligible(vehicle: VisualTrafficVehicle, segmentId: string): boolean {
    const segmentIndex = this.segmentIndexById.get(segmentId) ?? -1
    const load = clamp(this.utilization.get(segmentIndex) ?? 0.2, 0, 2)
    const roadClass = this.segmentRoadClassById.get(segmentId) ?? 1
    return vehicle.densityRank <= densityFor(roadClass, load)
  }

  private spawn(
    visibleChunks: ReadonlySet<number>,
    utilization: ReadonlyMap<number, number>,
    maxVisible: number,
  ): VisualTrafficVehicle[] {
    const allLanes = this.network.lanes
    const segmentById = new Map(this.network.segments.map((segment) => [segment.id, segment]))
    const lanesBySegment = new Map<string, DirectedLane[]>()
    for (const lane of allLanes) {
      const lanes = lanesBySegment.get(lane.segmentId) ?? []
      lanes.push(lane)
      lanesBySegment.set(lane.segmentId, lanes)
    }
    const chunkCandidates = [...visibleChunks]
      .sort((a, b) => a - b)
      .map((chunkId) => {
        const candidates: SpawnCandidate[] = []
        for (const segmentId of this.network.chunks.get(chunkId)?.segmentIds ?? []) {
          const segment = segmentById.get(segmentId)
          if (!segment) continue
          const load = clamp(utilization.get(segment.index) ?? 0.2, 0, 2)
          const attempts = Math.min(4, Math.max(1, Math.ceil(segment.length / 5)))
          for (const lane of lanesBySegment.get(segmentId) ?? []) {
            for (let slot = 0; slot < attempts; slot++) {
              const id = hash(lane.index, slot, this.network.revision)
              if (unit(id) <= 0.94) candidates.push({ lane, id, load })
            }
          }
        }
        candidates.sort((a, b) =>
          hash(a.id, chunkId, 0x51ed) - hash(b.id, chunkId, 0x51ed) || a.id - b.id,
        )
        return candidates
      })
      .filter((candidates) => candidates.length > 0)
    // A global lane can be indexed by more than one chunk. Round-robin chunks
    // for spatial coverage, but instantiate each deterministic lane slot once.
    const used = new Set<number>()
    const cursors = new Uint32Array(chunkCandidates.length)
    const vehicles: VisualTrafficVehicle[] = []
    let progressed = true
    while (vehicles.length < maxVisible && progressed) {
      progressed = false
      for (let chunkIndex = 0; chunkIndex < chunkCandidates.length; chunkIndex++) {
        const candidates = chunkCandidates[chunkIndex]!
        while (cursors[chunkIndex]! < candidates.length) {
          const candidate = candidates[cursors[chunkIndex]!]!
          const densityRank = candidates.length <= 1
            ? 0
            : cursors[chunkIndex]! / (candidates.length - 1)
          cursors[chunkIndex]++
          if (used.has(candidate.id)) continue
          used.add(candidate.id)
          const target = chooseReachableTarget(
            candidate.lane.index, allLanes, this.adjacency, candidate.id,
          )
          const route = target === null
            ? [candidate.lane.index]
            : findRoute(this.adjacency, candidate.lane.index, target)
          if (route.length < 2) continue
          const metric = this.laneMetrics.get(candidate.lane.index)!
          const distance = metric.length * unit(hash(candidate.id, 17, 5)) * 0.72
          const pose = this.pose(candidate.lane, distance)
          vehicles.push({
            id: candidate.id,
            route,
            colorIndex: hash(candidate.id, 3, 7),
            modelChoice: hash(candidate.id, 11, 13),
            densityRank,
            routeIndex: 0,
            distance,
            speed: speedFor(candidate.lane, candidate.load, candidate.id),
            arrived: false,
            connectorDistance: null,
            continuationCount: 0,
            previous: { ...pose },
            current: pose,
          })
          progressed = true
          break
        }
        if (vehicles.length >= maxVisible) break
      }
    }
    return vehicles.sort((a, b) => a.id - b.id)
  }

  private step(): void {
    this.tick++
    this.stats.steps++
    const ordered = this.orderedVehicles
    ordered.sort((a, b) =>
      a.route[a.routeIndex]! - b.route[b.routeIndex]! || b.distance - a.distance || a.id - b.id,
    )
    this.aheadByLane.fill(Number.NaN)
    const ahead = this.aheadByLane
    for (const vehicle of ordered) {
      if (vehicle.arrived) continue
      copyPose(vehicle.previous, vehicle.current)
      const laneIndex = vehicle.route[vehicle.routeIndex]!
      const lane = this.network.lanes[laneIndex]!
      const metrics = this.laneMetrics.get(laneIndex)!
      if (vehicle.routeIndex === vehicle.route.length - 1 &&
        vehicle.distance + vehicle.speed * TRAFFIC_STEP_SECONDS >= metrics.length - 1e-5) {
        const outgoing = this.adjacency[laneIndex] ?? []
        if (outgoing.length > 0) {
          const choice = hash(vehicle.id, vehicle.continuationCount++, this.network.revision)
          const next = outgoing[choice % outgoing.length]!
          // Discard completed history so indefinitely circulating traffic has
          // bounded memory while preserving a connector-continuous next leg.
          vehicle.route.splice(0, vehicle.route.length, laneIndex, next)
          vehicle.routeIndex = 0
          vehicle.arrived = false
        }
      }
      const nextLaneIndex = vehicle.route[vehicle.routeIndex + 1]
      const connectorKey = nextLaneIndex === undefined
        ? null
        : `${lane.id}>${this.network.lanes[nextLaneIndex]!.id}`
      const transition = connectorKey === null ? undefined : this.connectorMetrics.get(connectorKey)

      if (vehicle.connectorDistance !== null && nextLaneIndex !== undefined && transition) {
        const advanced = vehicle.connectorDistance + vehicle.speed * TRAFFIC_STEP_SECONDS
        if (advanced < transition.length - 1e-5) {
          vehicle.connectorDistance = advanced
          this.posePointsInto(vehicle.current, transition.points, transition, advanced)
          this.syncVehicleSegment(vehicle)
          continue
        }
        vehicle.routeIndex++
        vehicle.connectorDistance = null
        vehicle.distance = Math.max(0, advanced - transition.length)
        const activeLane = this.network.lanes[nextLaneIndex]!
        const activeMetrics = this.laneMetrics.get(activeLane.index)!
        vehicle.distance = Math.min(vehicle.distance, activeMetrics.length)
        this.poseInto(vehicle.current, activeLane, vehicle.distance)
        ahead[activeLane.index] = vehicle.distance
        this.syncVehicleSegment(vehicle)
        continue
      }
      const frontDistance = ahead[laneIndex]!
      const headwayLimit = Number.isNaN(frontDistance)
        ? Infinity
        : Math.max(0, frontDistance - 0.34 / this.tileSize)
      const connector = nextLaneIndex === undefined
        ? undefined
        : this.connectorByPair.get(`${lane.id}>${this.network.lanes[nextLaneIndex]!.id}`)
      const signalLimit = connector && !signalGreen(connector, this.tick)
        ? Math.max(0, metrics.length - 0.16)
        : Infinity
      const desired = Math.min(
        vehicle.distance + vehicle.speed * TRAFFIC_STEP_SECONDS,
        headwayLimit,
        signalLimit,
      )
      vehicle.distance = Math.max(vehicle.distance, desired)
      if (vehicle.distance >= metrics.length - 1e-5 && nextLaneIndex !== undefined && signalLimit === Infinity) {
        const overflow = Math.max(0, vehicle.distance - metrics.length)
        if (transition && transition.length > 1e-5) {
          vehicle.distance = metrics.length
          vehicle.connectorDistance = Math.min(overflow, transition.length)
          this.posePointsInto(vehicle.current, transition.points, transition, vehicle.connectorDistance)
          this.syncVehicleSegment(vehicle)
          continue
        }
        vehicle.routeIndex++
        vehicle.distance = overflow
      }
      const activeLane = this.network.lanes[vehicle.route[vehicle.routeIndex]!]!
      const activeMetrics = this.laneMetrics.get(activeLane.index)!
      // A completed A-to-B trip remains at its destination until the visible
      // projection is rebuilt; it never reverses or silently U-turns.
      vehicle.distance = Math.min(vehicle.distance, activeMetrics.length)
      this.poseInto(vehicle.current, activeLane, vehicle.distance)
      if (vehicle.routeIndex === vehicle.route.length - 1 &&
        vehicle.distance >= activeMetrics.length - 1e-5) vehicle.arrived = true
      ahead[activeLane.index] = vehicle.distance
      this.syncVehicleSegment(vehicle)
    }
  }

  private syncVehicleSegment(vehicle: VisualTrafficVehicle): void {
    const segmentId = this.network.lanes[vehicle.route[vehicle.routeIndex]!]!.segmentId
    const previous = this.vehicleSegment.get(vehicle.id)
    if (previous === segmentId) return
    if (previous !== undefined) this.vehiclesBySegment.get(previous)?.delete(vehicle)
    this.vehiclesBySegment.get(segmentId)?.add(vehicle)
    this.vehicleSegment.set(vehicle.id, segmentId)
  }

  private pose(lane: DirectedLane, distance: number): VisualTrafficPose {
    const metrics = this.laneMetrics.get(lane.index)!
    return this.posePoints(lane.points, metrics, distance)
  }

  private poseInto(target: VisualTrafficPose, lane: DirectedLane, distance: number): void {
    this.posePointsInto(target, lane.points, this.laneMetrics.get(lane.index)!, distance)
  }

  private posePointsInto(
    target: VisualTrafficPose,
    points: readonly RoadNetworkPoint[],
    metrics: LaneMetrics,
    distance: number,
  ): void {
    const clamped = clamp(distance, 0, metrics.length)
    let edge = 0
    while (edge + 1 < metrics.cumulative.length && metrics.cumulative[edge + 1]! < clamped) edge++
    const a = points[Math.min(edge, points.length - 1)]!
    const b = points[Math.min(edge + 1, points.length - 1)] ?? a
    const start = metrics.cumulative[edge] ?? 0
    const end = metrics.cumulative[Math.min(edge + 1, metrics.cumulative.length - 1)] ?? start
    const t = end > start ? (clamped - start) / (end - start) : 0
    const dx = b.x - a.x
    const dz = b.y - a.y
    target.x = (a.x + dx * t - 0.5) * this.tileSize
    target.y = a.elevation + (b.elevation - a.elevation) * t + 0.035
    target.z = (a.y + dz * t - 0.5) * this.tileSize
    target.yaw = Math.atan2(-dz, dx)
  }

  private posePoints(
    points: readonly RoadNetworkPoint[],
    metrics: LaneMetrics,
    distance: number,
  ): VisualTrafficPose {
    const clamped = clamp(distance, 0, metrics.length)
    let edge = 0
    while (edge + 1 < metrics.cumulative.length && metrics.cumulative[edge + 1]! < clamped) edge++
    const a = points[Math.min(edge, points.length - 1)]!
    const b = points[Math.min(edge + 1, points.length - 1)] ?? a
    const start = metrics.cumulative[edge] ?? 0
    const end = metrics.cumulative[Math.min(edge + 1, metrics.cumulative.length - 1)] ?? start
    const t = end > start ? (clamped - start) / (end - start) : 0
    const dx = b.x - a.x
    const dz = b.y - a.y
    return {
      // Road-network points use logical tile-centre coordinates (tile + 0.5),
      // while the Three world origin is the centre of tile 0.
      x: (a.x + dx * t - 0.5) * this.tileSize,
      y: a.elevation + (b.elevation - a.elevation) * t + 0.035,
      z: (a.y + dz * t - 0.5) * this.tileSize,
      yaw: Math.atan2(-dz, dx),
    }
  }
}

function metricsForConnector(
  from: DirectedLane,
  to: DirectedLane,
  junction: RoadNetworkSnapshot['junctions'][number] | undefined,
): ConnectorMetrics {
  const start = from.points.at(-1)!
  const end = to.points[0]!
  const control = junction
    ? { tileId: junction.tileId, x: junction.x, y: junction.y, elevation: junction.elevation }
    : {
        tileId: start.tileId,
        x: (start.x + end.x) * 0.5,
        y: (start.y + end.y) * 0.5,
        elevation: (start.elevation + end.elevation) * 0.5,
      }
  const points: RoadNetworkPoint[] = []
  for (let step = 0; step <= 6; step++) {
    const t = step / 6
    const inverse = 1 - t
    points.push(Object.freeze({
      tileId: control.tileId,
      x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
      y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
      elevation: inverse * inverse * start.elevation + 2 * inverse * t * control.elevation + t * t * end.elevation,
    }))
  }
  return { points: Object.freeze(points), ...metricsFor(points) }
}

function metricsFor(points: readonly RoadNetworkPoint[]): LaneMetrics {
  const cumulative = new Float32Array(points.length)
  let length = 0
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!
    const b = points[index]!
    length += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative[index] = length
  }
  return { cumulative, length }
}

function laneAdjacency(network: RoadNetworkSnapshot): readonly number[][] {
  const byId = new Map(network.lanes.map((lane) => [lane.id, lane.index]))
  const adjacency: number[][] = Array.from({ length: network.lanes.length }, () => [])
  for (const connector of network.connectors) {
    const from = byId.get(connector.fromLaneId)
    const to = byId.get(connector.toLaneId)
    if (from === undefined || to === undefined) continue
    adjacency[from]!.push(to)
  }
  for (const next of adjacency) next.sort((a, b) => a - b)
  return adjacency
}

function chooseReachableTarget(
  start: number,
  lanes: readonly DirectedLane[],
  adjacency: readonly (readonly number[])[],
  seed: number,
): number | null {
  if (lanes.length < 2) return null
  for (let attempt = 0; attempt < Math.min(16, lanes.length); attempt++) {
    const target = lanes[hash(seed, attempt, 29) % lanes.length]!.index
    if (target !== start && findRoute(adjacency, start, target).length > 1) return target
  }
  return adjacency[start]?.[0] ?? null
}

export function findRoute(adjacency: readonly (readonly number[])[], start: number, target: number): number[] {
  if (start === target) return [start]
  const previous = new Int32Array(adjacency.length)
  previous.fill(-2)
  previous[start] = -1
  const queue = new Int32Array(adjacency.length)
  let read = 0
  let write = 0
  queue[write++] = start
  while (read < write && previous[target] === -2) {
    const current = queue[read++]!
    for (const next of adjacency[current] ?? []) {
      if (previous[next] !== -2) continue
      previous[next] = current
      queue[write++] = next
      if (next === target) break
    }
  }
  if (previous[target] === -2) return []
  const path: number[] = []
  for (let cursor = target; cursor >= 0; cursor = previous[cursor]!) path.push(cursor)
  return path.reverse()
}

function signalGreen(connector: LaneConnector, tick: number): boolean {
  if (connector.signalGroup === null) return true
  const phase = tick % 120
  const start = connector.signalGroup * 40
  const local = (phase - start + 120) % 120
  return local < 28 // 2.8 s green, then yellow/all-red before the next group.
}

function speedFor(lane: DirectedLane, utilization: number, id: number): number {
  const freeFlowTilesPerSecond = 0.32 + lane.speedLimit / 125
  const congestion = 1 / (1 + Math.max(0, utilization - 0.45) * 0.75)
  return freeFlowTilesPerSecond * congestion * (0.9 + unit(hash(id, 41, 3)) * 0.18)
}

function densityFor(roadClass: number, utilization: number): number {
  return Math.min(0.94, (0.17 + roadClass * 0.105) * (0.55 + utilization * 0.75))
}

function hash(a: number, b: number, c: number): number {
  let value = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b)
  value = Math.imul(value ^ b, 0xc2b2ae35)
  return (value ^ c ^ (value >>> 16)) >>> 0
}

function unit(value: number): number {
  return value / 0xffff_ffff
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function copyPose(target: VisualTrafficPose, source: VisualTrafficPose): void {
  target.x = source.x
  target.y = source.y
  target.z = source.z
  target.yaw = source.yaw
}
