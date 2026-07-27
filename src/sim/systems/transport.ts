import type { SimState, TransportRuntimeState } from '../types'
import { compileRoadNetwork, type RoadNetworkSnapshot } from '../world/roadNetwork'
import { usesCompactWorld } from './worldAccess'

const MIN_ACCESS = 0.75
const ASSIGNMENT_PASSES = 3

interface DemandEndpoint {
  id: string
  segment: number
  weight: number
  cityId?: string
  facilityId?: string
  regionId?: string
}

interface HeapEntry { node: number; cost: number }

class MinHeap {
  private readonly values: HeapEntry[] = []
  get size(): number { return this.values.length }
  push(value: HeapEntry): void {
    let index = this.values.push(value) - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.values[parent]!.cost <= value.cost) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = value
  }
  pop(): HeapEntry | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last || this.values.length === 0) return first
    let index = 0
    while (true) {
      const left = index * 2 + 1
      if (left >= this.values.length) break
      const right = left + 1
      const child = right < this.values.length && this.values[right]!.cost < this.values[left]!.cost ? right : left
      if (this.values[child]!.cost >= last.cost) break
      this.values[index] = this.values[child]!
      index = child
    }
    this.values[index] = last
    return first
  }
}

function emptyTransport(day: number, revision = 0): TransportRuntimeState {
  return {
    version: 1,
    day,
    networkRevision: revision,
    segmentLoads: [],
    junctionLoads: [],
    regionCongestion: {},
    cityAccess: {},
    facilityAccess: {},
  }
}

function endpointsFor(state: SimState, network: RoadNetworkSnapshot): DemandEndpoint[] {
  const world = state.map.world!
  const regions = world.staticWorld.regions
  const endpoints: DemandEndpoint[] = []
  for (const terminal of network.terminals) {
    if (terminal.kind !== 'settlement' || terminal.cityIndex === undefined || !terminal.segmentId) continue
    const segment = network.segments.findIndex((candidate) => candidate.id === terminal.segmentId)
    const city = state.map.cities?.[terminal.cityIndex] ?? world.staticWorld.cities[terminal.cityIndex]
    if (segment < 0 || !city) continue
    endpoints.push({
      id: terminal.id,
      segment,
      weight: Math.max(40, city.population / 120),
      cityId: city.id,
      regionId: regions[city.regionIndex ?? terminal.cityIndex % Math.max(1, regions.length)]?.id,
    })
  }
  for (const facility of world.queryFacilities()) {
    const segment = network.nearestSegmentByTile[facility.anchor] ?? -1
    if (segment < 0) continue
    const city = nearestCity(state, facility.anchor)
    endpoints.push({
      id: `facility:${facility.id}`,
      segment,
      weight: 80 + facility.footprint.length * 15 + (facility.constructionProgress < facility.constructionTarget ? 100 : 0),
      facilityId: facility.id,
      regionId: city?.regionId,
    })
  }
  return endpoints.sort((a, b) => a.id.localeCompare(b.id))
}

function nearestCity(state: SimState, tileId: number): { id: string; regionId?: string } | undefined {
  const width = state.map.width
  const x = tileId % width
  const y = Math.floor(tileId / width)
  let best: { id: string; regionId?: string; distance: number } | undefined
  for (const city of state.map.cities ?? []) {
    const distance = Math.hypot(city.cx - x, city.cy - y)
    if (!best || distance < best.distance) {
      const region = state.map.regions[city.regionIndex ?? 0]
      best = { id: city.id, regionId: region?.id, distance }
    }
  }
  return best
}

function segmentAdjacency(network: RoadNetworkSnapshot): number[][] {
  const byId = new Map(network.segments.map((segment) => [segment.id, segment.index]))
  const adjacent = Array.from({ length: network.segments.length }, () => new Set<number>())
  for (const junction of network.junctions) {
    const indexes = junction.segmentIds.map((id) => byId.get(id)).filter((value): value is number => value !== undefined)
    for (const a of indexes) for (const b of indexes) if (a !== b) adjacent[a]!.add(b)
  }
  return adjacent.map((values) => [...values].sort((a, b) => a - b))
}

function route(
  network: RoadNetworkSnapshot,
  adjacent: readonly number[][],
  from: number,
  to: number,
  previousFlow: Float64Array,
): number[] {
  if (from === to) return [from]
  const count = network.segments.length
  const costs = new Float64Array(count)
  costs.fill(Infinity)
  const before = new Int32Array(count)
  before.fill(-1)
  const heap = new MinHeap()
  costs[from] = 0
  heap.push({ node: from, cost: 0 })
  while (heap.size > 0) {
    const current = heap.pop()!
    if (current.cost !== costs[current.node]) continue
    if (current.node === to) break
    for (const next of adjacent[current.node]!) {
      const segment = network.segments[next]!
      const utilization = previousFlow[next]! / Math.max(1, segment.profile.capacityPerDay)
      const congestion = 1 + 0.85 * Math.min(4, utilization * utilization)
      const edgeCost = segment.length / Math.max(1, segment.profile.speedLimit) * congestion + (segment.bridge ? 0.04 : 0)
      const candidate = current.cost + edgeCost
      if (candidate >= costs[next]!) continue
      costs[next] = candidate
      before[next] = current.node
      heap.push({ node: next, cost: candidate })
    }
  }
  if (!Number.isFinite(costs[to])) return []
  const path: number[] = []
  for (let node = to; node >= 0; node = before[node]!) {
    path.push(node)
    if (node === from) break
  }
  return path.reverse()
}

function assignment(state: SimState, network: RoadNetworkSnapshot): Float64Array {
  const endpoints = endpointsFor(state, network)
  const adjacent = segmentAdjacency(network)
  let previous = new Float64Array(network.segments.length)
  if (endpoints.length < 2) return previous
  for (let pass = 0; pass < ASSIGNMENT_PASSES; pass++) {
    const next = new Float64Array(network.segments.length)
    for (let index = 0; index < endpoints.length; index++) {
      const origin = endpoints[index]!
      const trips = Math.min(3, endpoints.length - 1)
      for (let offset = 1; offset <= trips; offset++) {
        const destination = endpoints[(index + offset * 7 + state.seed % endpoints.length) % endpoints.length]!
        if (origin === destination) continue
        const demand = Math.max(1, Math.min(origin.weight, destination.weight) / trips)
        for (const segment of route(network, adjacent, origin.segment, destination.segment, previous)) next[segment] += demand
      }
    }
    previous = next
  }
  return previous
}

function accessForSegment(network: RoadNetworkSnapshot, flow: Float64Array, segmentIndex: number): number {
  if (segmentIndex < 0) return MIN_ACCESS
  const segment = network.segments[segmentIndex]
  if (!segment) return MIN_ACCESS
  const utilization = flow[segmentIndex]! / Math.max(1, segment.profile.capacityPerDay)
  const pressure = Math.min(1, Math.max(0, utilization - 0.45) / 1.35)
  return Math.max(MIN_ACCESS, 1 - pressure * 0.25)
}

/** Deterministic daily transport assignment. It never observes renderer state. */
export function tickTransport(state: SimState): SimState {
  if (!usesCompactWorld(state)) return { ...state, transport: emptyTransport(state.day) }
  const world = state.map.world!
  const network = compileRoadNetwork(world, state.config.drivingSide ?? 'left')
  const flow = assignment(state, network)
  const junctionLoads = network.junctions.map((junction) => {
    let pressure = 0
    for (const segmentId of junction.segmentIds) {
      const segment = network.segments.find((candidate) => candidate.id === segmentId)
      if (!segment) continue
      pressure = Math.max(pressure, Math.min(1, flow[segment.index]! / Math.max(1, segment.profile.capacityPerDay)))
    }
    return { junctionId: junction.index, queuePressure: pressure }
  })
  const endpoints = endpointsFor(state, network)
  const cityAccess: Record<string, number> = {}
  const facilityAccess: Record<string, number> = {}
  const regionValues = new Map<string, number[]>()
  for (const endpoint of endpoints) {
    const access = accessForSegment(network, flow, endpoint.segment)
    if (endpoint.cityId) cityAccess[endpoint.cityId] = access
    if (endpoint.facilityId) facilityAccess[endpoint.facilityId] = access
    if (endpoint.regionId) regionValues.set(endpoint.regionId, [...(regionValues.get(endpoint.regionId) ?? []), 1 - access])
  }
  const regionCongestion: Record<string, number> = {}
  for (const [region, values] of regionValues) regionCongestion[region] = values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    ...state,
    transport: {
      version: 1,
      day: state.day,
      networkRevision: network.revision,
      segmentLoads: network.segments.map((segment) => {
        const segmentFlow = flow[segment.index]!
        const utilization = segmentFlow / Math.max(1, segment.profile.capacityPerDay)
        return {
          segmentId: segment.index,
          flow: segmentFlow,
          capacity: segment.profile.capacityPerDay,
          utilization,
          travelTimeMult: 1 + 0.85 * Math.min(4, utilization * utilization),
        }
      }),
      junctionLoads,
      regionCongestion,
      cityAccess,
      facilityAccess,
    },
  }
}

export function facilityTransportAccess(state: SimState, facilityId: string): number {
  return Math.max(MIN_ACCESS, Math.min(1, state.transport?.facilityAccess[facilityId] ?? 1))
}

/** Access used by legacy/global equipment orders which do not store a destination. */
export function transportDeliveryAccess(state: SimState): number {
  const values = Object.values(state.transport?.facilityAccess ?? {})
  if (values.length === 0) return 1
  return Math.max(MIN_ACCESS, Math.min(1, values.reduce((sum, value) => sum + value, 0) / values.length))
}

export function transportAccessFactorAt(state: SimState, tileId: number): number {
  if (!usesCompactWorld(state)) return 1
  const network = compileRoadNetwork(state.map.world!, state.config.drivingSide ?? 'left')
  const segment = network.nearestSegmentByTile[tileId] ?? -1
  const load = state.transport?.segmentLoads[segment]
  if (!load) return 1
  const pressure = Math.min(1, Math.max(0, load.utilization - 0.45) / 1.35)
  const distance = network.accessDistanceByTile[tileId] ?? 0xffff
  const distancePenalty = Math.min(0.08, Math.max(0, distance - 1) * 0.012)
  return Math.max(MIN_ACCESS, Math.min(1, 1 - pressure * 0.25 - distancePenalty))
}

export function transportRoadClassAt(state: SimState, tileId: number): RoadNetworkSnapshot['segments'][number]['roadClass'] | 0 {
  if (!usesCompactWorld(state)) return 0
  const network = compileRoadNetwork(state.map.world!, state.config.drivingSide ?? 'left')
  const segmentIndex = network.nearestSegmentByTile[tileId] ?? -1
  return network.segments[segmentIndex]?.roadClass ?? 0
}

export function transportRegionalCongestionAt(state: SimState, tileId: number): number {
  const nearest = nearestCity(state, tileId)
  return Math.max(0, Math.min(1, nearest?.regionId ? state.transport?.regionCongestion[nearest.regionId] ?? 0 : 0))
}

export function transportCityGrowthMultiplier(state: SimState, cityId: string): number {
  const access = Math.max(MIN_ACCESS, Math.min(1, state.transport?.cityAccess[cityId] ?? 1))
  return 0.9 + ((access - MIN_ACCESS) / (1 - MIN_ACCESS)) * 0.12
}

export function transportLandValueMultiplier(state: SimState, tileId: number): number {
  const access = transportAccessFactorAt(state, tileId)
  return 0.88 + ((access - MIN_ACCESS) / (1 - MIN_ACCESS)) * 0.16
}

export function transportLogisticsOpexSurcharge(baseOpex: number, access: number): number {
  const normalized = Math.max(MIN_ACCESS, Math.min(1, access))
  return Math.min(baseOpex * 0.08, baseOpex * (1 / normalized - 1) * 0.25)
}
