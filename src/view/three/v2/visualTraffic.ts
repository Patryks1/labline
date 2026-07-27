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
  routeIndex: number
  distance: number
  speed: number
  arrived: boolean
  connectorDistance: number | null
  continuationCount: number
  previous: VisualTrafficPose
  current: VisualTrafficPose
}

interface LaneMetrics {
  cumulative: Float32Array
  length: number
}

interface ConnectorMetrics extends LaneMetrics {
  points: readonly RoadNetworkPoint[]
}

/**
 * Small, deterministic render-only lane simulation. Its state is deliberately
 * not serialised: the canonical daily congestion snapshot is the only traffic
 * state owned by gameplay.
 */
export class VisualTrafficSimulation {
  readonly vehicles: VisualTrafficVehicle[]
  readonly network: RoadNetworkSnapshot
  interpolation = 0

  private readonly laneMetrics = new Map<number, LaneMetrics>()
  private readonly connectorByPair = new Map<string, LaneConnector>()
  private readonly connectorMetrics = new Map<string, ConnectorMetrics>()
  private readonly adjacency: readonly number[][]
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
  }

  setFrame(timeSeconds: number, paused: boolean): boolean {
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
    }
    this.interpolation = this.accumulator / TRAFFIC_STEP_SECONDS
    return changed
  }

  private spawn(
    visibleChunks: ReadonlySet<number>,
    utilization: ReadonlyMap<number, number>,
    maxVisible: number,
  ): VisualTrafficVehicle[] {
    const visibleSegments = new Set<string>()
    for (const chunkId of [...visibleChunks].sort((a, b) => a - b)) {
      for (const id of this.network.chunks.get(chunkId)?.segmentIds ?? []) visibleSegments.add(id)
    }
    const candidates = this.network.lanes.filter((lane) => visibleSegments.has(lane.segmentId))
    const allLanes = this.network.lanes
    const segmentById = new Map(this.network.segments.map((segment) => [segment.id, segment]))
    const vehicles: VisualTrafficVehicle[] = []
    for (const lane of candidates) {
      if (vehicles.length >= maxVisible) break
      const segment = segmentById.get(lane.segmentId)!
      const load = clamp(utilization.get(segment.index) ?? 0.2, 0, 2)
      const density = (0.17 + segment.roadClass * 0.105) * (0.55 + load * 0.75)
      const attempts = Math.min(4, Math.max(1, Math.ceil(segment.length / 5)))
      for (let slot = 0; slot < attempts && vehicles.length < maxVisible; slot++) {
        const id = hash(lane.index, slot, this.network.revision)
        if (unit(id) > Math.min(0.94, density)) continue
        const target = chooseReachableTarget(lane.index, allLanes, this.adjacency, id)
        const route = target === null ? [lane.index] : findRoute(this.adjacency, lane.index, target)
        if (route.length < 2) continue
        const metric = this.laneMetrics.get(lane.index)!
        const distance = metric.length * unit(hash(id, 17, 5)) * 0.72
        const pose = this.pose(lane, distance)
        vehicles.push({
          id,
          route,
          colorIndex: hash(id, 3, 7),
          modelChoice: hash(id, 11, 13),
          routeIndex: 0,
          distance,
          speed: speedFor(lane, load, id),
          arrived: false,
          connectorDistance: null,
          continuationCount: 0,
          previous: { ...pose },
          current: pose,
        })
      }
    }
    return vehicles.sort((a, b) => a.id - b.id)
  }

  private step(): void {
    this.tick++
    const ordered = [...this.vehicles].sort((a, b) =>
      a.route[a.routeIndex]! - b.route[b.routeIndex]! || b.distance - a.distance || a.id - b.id,
    )
    const ahead = new Map<number, number>()
    for (const vehicle of ordered) {
      if (vehicle.arrived) continue
      vehicle.previous = { ...vehicle.current }
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
          vehicle.current = this.posePoints(transition.points, transition, advanced)
          continue
        }
        vehicle.routeIndex++
        vehicle.connectorDistance = null
        vehicle.distance = Math.max(0, advanced - transition.length)
        const activeLane = this.network.lanes[nextLaneIndex]!
        const activeMetrics = this.laneMetrics.get(activeLane.index)!
        vehicle.distance = Math.min(vehicle.distance, activeMetrics.length)
        vehicle.current = this.pose(activeLane, vehicle.distance)
        ahead.set(activeLane.index, vehicle.distance)
        continue
      }
      const frontDistance = ahead.get(laneIndex)
      const headwayLimit = frontDistance === undefined
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
          vehicle.current = this.posePoints(transition.points, transition, vehicle.connectorDistance)
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
      vehicle.current = this.pose(activeLane, vehicle.distance)
      if (vehicle.routeIndex === vehicle.route.length - 1 &&
        vehicle.distance >= activeMetrics.length - 1e-5) vehicle.arrived = true
      ahead.set(activeLane.index, vehicle.distance)
    }
  }

  private pose(lane: DirectedLane, distance: number): VisualTrafficPose {
    const metrics = this.laneMetrics.get(lane.index)!
    return this.posePoints(lane.points, metrics, distance)
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
