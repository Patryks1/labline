import {
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  TRANSPORT_TOPOLOGY_MASK,
  type StaticCity,
  type StaticWorld,
  type TileId,
  type TransportRoadClass,
} from './types'
import type { DrivingSide } from '../balance/gameConfig'

export type { DrivingSide } from '../balance/gameConfig'
export type RoadTurn = 'left' | 'straight' | 'right'

export interface RoadClassProfile {
  readonly roadClass: TransportRoadClass
  readonly lanesPerDirection: number
  readonly speedLimit: number
  readonly capacityPerDay: number
  readonly halfWidth: number
  readonly shoulderWidth: number
}

export interface RoadNetworkPoint {
  readonly tileId: TileId
  readonly x: number
  readonly y: number
  readonly elevation: number
}

export interface RoadSegment {
  readonly index: number
  readonly id: string
  readonly fromJunctionId: string | null
  readonly toJunctionId: string | null
  readonly tileIds: readonly TileId[]
  readonly points: readonly RoadNetworkPoint[]
  readonly roadClass: TransportRoadClass
  readonly flags: number
  readonly bridge: boolean
  readonly length: number
  readonly profile: RoadClassProfile
}

export interface RoadJunctionPort {
  readonly segmentId: string
  readonly tileId: TileId
  readonly headingX: number
  readonly headingY: number
}

export interface RoadJunction {
  readonly index: number
  readonly id: string
  readonly tileId: TileId
  readonly x: number
  readonly y: number
  readonly elevation: number
  readonly segmentIds: readonly string[]
  readonly ports: readonly RoadJunctionPort[]
  readonly signalized: boolean
  readonly hasCrosswalks: boolean
  readonly hasStopLines: boolean
}

export interface DirectedLane {
  readonly index: number
  readonly id: string
  readonly segmentId: string
  readonly direction: 'forward' | 'reverse'
  readonly laneIndex: number
  readonly fromJunctionId: string | null
  readonly toJunctionId: string | null
  readonly lateralOffset: number
  readonly speedLimit: number
  readonly points: readonly RoadNetworkPoint[]
}

export interface LaneConnector {
  readonly id: string
  readonly junctionId: string
  readonly fromLaneId: string
  readonly toLaneId: string
  readonly turn: RoadTurn
  readonly signalGroup: number | null
}

export interface RoadTerminal {
  readonly id: string
  readonly kind: 'settlement' | 'gateway' | 'network-end'
  readonly tileId: TileId
  readonly cityIndex?: number
  readonly segmentId: string | null
  readonly junctionId: string | null
}

export interface RoadChunkIndex {
  readonly segmentIds: readonly string[]
  readonly junctionIds: readonly string[]
  readonly terminalIds: readonly string[]
}

export interface RoadNetworkSnapshot {
  readonly revision: number
  readonly width: number
  readonly height: number
  readonly chunkSize: number
  readonly chunksWide: number
  readonly drivingSide: DrivingSide
  readonly profiles: Readonly<Record<TransportRoadClass, RoadClassProfile>>
  readonly segments: readonly RoadSegment[]
  readonly junctions: readonly RoadJunction[]
  readonly lanes: readonly DirectedLane[]
  readonly connectors: readonly LaneConnector[]
  readonly terminals: readonly RoadTerminal[]
  readonly chunks: ReadonlyMap<number, RoadChunkIndex>
  /** Segment index for a road tile, or the nearest road segment for non-road tiles. */
  readonly nearestSegmentByTile: Int32Array
  /** Manhattan distance to the nearest compiled road tile; 0xffff means unreachable. */
  readonly accessDistanceByTile: Uint16Array
}

export interface RoadNetworkCompileSource {
  readonly staticWorld: StaticWorld
  readonly revision?: number
  /** Revision of packed road cells only; avoids recompiles for unrelated world changes. */
  readonly roadRevision?: number
  getTransport?(tileId: TileId): number
  getTileElevation?(x: number, y: number): number
}

export const ROAD_CLASS_PROFILES: Readonly<Record<TransportRoadClass, RoadClassProfile>> = Object.freeze({
  [TRANSPORT_ROAD_CLASS.none]: Object.freeze({ roadClass: 0, lanesPerDirection: 0, speedLimit: 0, capacityPerDay: 0, halfWidth: 0, shoulderWidth: 0 }),
  [TRANSPORT_ROAD_CLASS.local]: Object.freeze({ roadClass: 1, lanesPerDirection: 1, speedLimit: 30, capacityPerDay: 700, halfWidth: 0.21, shoulderWidth: 0.025 }),
  [TRANSPORT_ROAD_CLASS.collector]: Object.freeze({ roadClass: 2, lanesPerDirection: 1, speedLimit: 50, capacityPerDay: 1_400, halfWidth: 0.25, shoulderWidth: 0.04 }),
  [TRANSPORT_ROAD_CLASS.arterial]: Object.freeze({ roadClass: 3, lanesPerDirection: 2, speedLimit: 70, capacityPerDay: 3_400, halfWidth: 0.34, shoulderWidth: 0.045 }),
  [TRANSPORT_ROAD_CLASS.highway]: Object.freeze({ roadClass: 4, lanesPerDirection: 2, speedLimit: 110, capacityPerDay: 5_600, halfWidth: 0.42, shoulderWidth: 0.08 }),
})

const STEPS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
] as const

type NormalizedSource = RoadNetworkCompileSource & { readonly identity: object }
const cache = new WeakMap<object, Map<string, RoadNetworkSnapshot>>()

function normalizeSource(source: StaticWorld | RoadNetworkCompileSource): NormalizedSource {
  if ('staticWorld' in source) return {
    staticWorld: source.staticWorld,
    identity: source as object,
    revision: source.roadRevision ?? source.revision,
    getTransport: source.getTransport ? (id) => source.getTransport!(id) : undefined,
    getTileElevation: source.getTileElevation ? (x, y) => source.getTileElevation!(x, y) : undefined,
  }
  return {
    staticWorld: source,
    identity: source,
    revision: 0,
    getTransport: (id) => source.transport?.[id] ?? 0,
    getTileElevation: (x, y) => staticTileElevation(source, x, y),
  }
}

function staticTileElevation(world: StaticWorld, x: number, y: number): number {
  if (!world.elevation) return 0
  const stride = world.descriptor.width + 1
  const scale = 'elevationScale' in world.descriptor ? world.descriptor.elevationScale : 0
  const nw = y * stride + x
  return (world.elevation[nw]! + world.elevation[nw + 1]! + world.elevation[nw + stride]! + world.elevation[nw + stride + 1]!) * scale / 4
}

function roadClass(value: number): TransportRoadClass {
  return ((value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) as TransportRoadClass
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

function hashPath(path: readonly number[]): string {
  let hash = 0x811c9dc5
  for (const value of path) {
    hash ^= value & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (value >>> 8) & 0xff
    hash = Math.imul(hash, 0x01000193)
    hash ^= (value >>> 16) & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Stable per-junction feature roll; generation order and camera visibility never affect it. */
function junctionFeatureRoll(tile: number, seed: number, salt: number): number {
  let hash = (tile ^ Math.imul(seed | 0, 0x9e3779b1) ^ salt) | 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x1_0000_0000
}

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values)
}

/**
 * Fit a bounded quadratic curve through a grid centreline. Unlike a uniform
 * Catmull-Rom spline this cannot overshoot the two incident road cells, which
 * is important for 45/90/135 degree procedural turns and narrow roads.
 */
export function smoothRoadCenterline(
  points: readonly RoadNetworkPoint[],
  subdivisions = 4,
): readonly RoadNetworkPoint[] {
  if (points.length < 3) return freezeArray([...points])
  const result: RoadNetworkPoint[] = [points[0]!]
  const steps = Math.max(2, Math.floor(subdivisions))
  const append = (point: RoadNetworkPoint) => {
    const last = result.at(-1)
    if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 1e-6) result.push(point)
  }
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1]!
    const corner = points[index]!
    const b = points[index + 1]!
    const inX = corner.x - a.x
    const inY = corner.y - a.y
    const outX = b.x - corner.x
    const outY = b.y - corner.y
    const inLength = Math.hypot(inX, inY) || 1
    const outLength = Math.hypot(outX, outY) || 1
    const inUnitX = inX / inLength
    const inUnitY = inY / inLength
    const outUnitX = outX / outLength
    const outUnitY = outY / outLength
    const alignment = inUnitX * outUnitX + inUnitY * outUnitY
    if (alignment > 0.999) {
      append(corner)
      continue
    }
    // Limit the tangent cut to less than half either edge. This establishes a
    // useful minimum radius while keeping the curve inside its logical tiles.
    const cut = Math.min(0.38, inLength * 0.38, outLength * 0.38)
    const entry = {
      tileId: corner.tileId,
      x: corner.x - inUnitX * cut,
      y: corner.y - inUnitY * cut,
      elevation: corner.elevation + (a.elevation - corner.elevation) * (cut / inLength),
    }
    const exit = {
      tileId: corner.tileId,
      x: corner.x + outUnitX * cut,
      y: corner.y + outUnitY * cut,
      elevation: corner.elevation + (b.elevation - corner.elevation) * (cut / outLength),
    }
    append(Object.freeze(entry))
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      const inverse = 1 - t
      append(Object.freeze({
        tileId: corner.tileId,
        x: inverse * inverse * entry.x + 2 * inverse * t * corner.x + t * t * exit.x,
        y: inverse * inverse * entry.y + 2 * inverse * t * corner.y + t * t * exit.y,
        elevation: inverse * inverse * entry.elevation + 2 * inverse * t * corner.elevation + t * t * exit.elevation,
      }))
    }
  }
  append(points.at(-1)!)
  return freezeArray(result)
}

function lanePoints(points: readonly RoadNetworkPoint[], offset: number): readonly RoadNetworkPoint[] {
  const centerline = smoothRoadCenterline(points)
  return freezeArray(centerline.map((point, index) => {
    const previous = centerline[Math.max(0, index - 1)]!
    const next = centerline[Math.min(centerline.length - 1, index + 1)]!
    const dx = next.x - previous.x
    const dy = next.y - previous.y
    const length = Math.hypot(dx, dy) || 1
    return Object.freeze({ ...point, x: point.x - dy / length * offset, y: point.y + dx / length * offset })
  }))
}

/**
 * Compile packed transport cells into the canonical lane graph shared by the
 * renderer and transport simulation. Results are cached by world identity,
 * revision, and driving side; the source is never mutated.
 */
export function compileRoadNetwork(
  source: StaticWorld | RoadNetworkCompileSource,
  drivingSide: DrivingSide = 'left',
): RoadNetworkSnapshot {
  const normalized = normalizeSource(source)
  const revision = normalized.revision ?? 0
  const cacheKey = `${revision}:${drivingSide}`
  const cached = cache.get(normalized.identity)?.get(cacheKey)
  if (cached) return cached

  const world = normalized.staticWorld
  const { width, height, chunkSize } = world.descriptor
  const size = width * height
  const values = new Uint16Array(size)
  const topology = new Uint8Array(size)
  for (let id = 0; id < size; id++) values[id] = normalized.getTransport?.(id as TileId) ?? world.transport?.[id] ?? 0
  for (let id = 0; id < size; id++) {
    if (roadClass(values[id]!) === TRANSPORT_ROAD_CLASS.none) continue
    const x = id % width
    const y = Math.floor(id / width)
    const packedTopology = values[id]! & TRANSPORT_TOPOLOGY_MASK
    for (let direction = 0; direction < STEPS.length; direction++) {
      if ((packedTopology & (1 << direction)) === 0) continue
      const [dx, dy] = STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const nextId = ny * width + nx
      if (roadClass(values[nextId]!) === 0) continue
      if ((values[nextId]! & (1 << ((direction + 4) & 7))) === 0) continue
      topology[id] = topology[id]! | (1 << direction)
    }
  }
  // Procedural routes can reuse an existing road and leave a diagonal shortcut
  // across an already-connected orthogonal corner. That produces triangular
  // loops and, when both diagonals exist in a 2x2 block, a crossing without a
  // junction. Remove only redundant/crossing diagonal edges, symmetrically;
  // cardinal connectivity and isolated intentional diagonals are preserved.
  const unlink = (id: number, direction: number) => {
    if ((topology[id]! & (1 << direction)) === 0) return
    const x = id % width
    const y = Math.floor(id / width)
    const [dx, dy] = STEPS[direction]!
    const next = (y + dy) * width + x + dx
    topology[id] &= ~(1 << direction)
    topology[next] &= ~(1 << ((direction + 4) & 7))
  }
  const connected = (a: number, b: number) => {
    const ax = a % width
    const ay = Math.floor(a / width)
    const bx = b % width
    const by = Math.floor(b / width)
    const dx = bx - ax
    const dy = by - ay
    const direction = STEPS.findIndex(([sx, sy]) => sx === dx && sy === dy)
    return direction >= 0 && (topology[a]! & (1 << direction)) !== 0
  }
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const nw = y * width + x
      const ne = nw + 1
      const sw = nw + width
      const se = sw + 1
      if (connected(nw, se) && ((connected(nw, ne) && connected(ne, se)) ||
        (connected(nw, sw) && connected(sw, se)))) unlink(nw, 3)
      if (connected(ne, sw) && ((connected(ne, nw) && connected(nw, sw)) ||
        (connected(ne, se) && connected(se, sw)))) unlink(ne, 5)
      if (connected(nw, se) && connected(ne, sw)) {
        const nwClass = Math.min(roadClass(values[nw]!), roadClass(values[se]!))
        const neClass = Math.min(roadClass(values[ne]!), roadClass(values[sw]!))
        if (nwClass >= neClass) unlink(ne, 5)
        else unlink(nw, 3)
      }
    }
  }
  const connectedNeighbors = (id: number): number[] => {
    const result: number[] = []
    const x = id % width
    const y = Math.floor(id / width)
    for (let direction = 0; direction < STEPS.length; direction++) {
      if ((topology[id]! & (1 << direction)) === 0) continue
      const [dx, dy] = STEPS[direction]!
      const nx = x + dx
      const ny = y + dy
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) result.push(ny * width + nx)
    }
    return result.sort((a, b) => a - b)
  }
  const degree = (id: number) => {
    let bits = topology[id]!
    let count = 0
    while (bits !== 0) { bits &= bits - 1; count++ }
    return count
  }

  const node = new Uint8Array(size)
  for (let id = 0; id < size; id++) if (degree(id) !== 2 && roadClass(values[id]!) > 0) node[id] = 1
  const visited = new Set<string>()
  const paths: number[][] = []
  const walk = (start: number, next: number): number[] => {
    const path = [start]
    let previous = start
    let current = next
    visited.add(edgeKey(start, next))
    while (true) {
      path.push(current)
      if (node[current]) break
      const options = connectedNeighbors(current).filter((candidate) => candidate !== previous)
      if (options.length === 0) break
      const following = options[0]!
      const key = edgeKey(current, following)
      if (visited.has(key)) break
      visited.add(key)
      previous = current
      current = following
      if (current === start) { path.push(current); break }
    }
    return path
  }
  for (let id = 0; id < size; id++) {
    if (!node[id]) continue
    for (const next of connectedNeighbors(id)) if (!visited.has(edgeKey(id, next))) paths.push(walk(id, next))
  }
  for (let id = 0; id < size; id++) {
    for (const next of connectedNeighbors(id)) {
      if (!visited.has(edgeKey(id, next))) paths.push(walk(id, next))
    }
  }

  const junctionByTile = new Map<number, RoadJunction>()
  const pointAt = (id: number): RoadNetworkPoint => {
    const x = id % width
    const y = Math.floor(id / width)
    return Object.freeze({ tileId: id as TileId, x: x + 0.5, y: y + 0.5, elevation: normalized.getTileElevation?.(x, y) ?? staticTileElevation(world, x, y) })
  }
  const segments: RoadSegment[] = paths.map((rawPath, index) => {
    const reverse = rawPath[0]! > rawPath[rawPath.length - 1]!
    const path = reverse ? [...rawPath].reverse() : [...rawPath]
    let segmentClass = TRANSPORT_ROAD_CLASS.local as TransportRoadClass
    let flags = 0
    let length = 0
    for (let i = 0; i < path.length; i++) {
      segmentClass = Math.max(segmentClass, roadClass(values[path[i]!]!)) as TransportRoadClass
      flags |= values[path[i]!]! & ~TRANSPORT_TOPOLOGY_MASK
      if (i > 0) {
        const a = path[i - 1]!
        const b = path[i]!
        length += Math.hypot((b % width) - (a % width), Math.floor(b / width) - Math.floor(a / width))
      }
    }
    const first = path[0]!
    const last = path[path.length - 1]!
    const id = `road:${first}:${last}:${hashPath(path)}`
    return Object.freeze({
      index, id,
      fromJunctionId: node[first] ? `junction:${first}` : null,
      toJunctionId: node[last] ? `junction:${last}` : null,
      tileIds: freezeArray(path.map((value) => value as TileId)),
      points: freezeArray(path.map(pointAt)),
      roadClass: segmentClass,
      flags,
      bridge: (flags & TRANSPORT_FLAGS.bridge) !== 0,
      length,
      profile: ROAD_CLASS_PROFILES[segmentClass],
    })
  })

  const incident = new Map<number, RoadSegment[]>()
  for (const segment of segments) {
    for (const tile of [segment.tileIds[0], segment.tileIds[segment.tileIds.length - 1]]) {
      if (tile === undefined || !node[tile]) continue
      const list = incident.get(tile) ?? []
      list.push(segment)
      incident.set(tile, list)
    }
  }
  const junctions: RoadJunction[] = [...incident.entries()].sort((a, b) => a[0] - b[0]).map(([tile, entries], index) => {
    const point = pointAt(tile)
    const ports = entries.map((segment): RoadJunctionPort => {
      const atStart = segment.tileIds[0] === tile
      const other = atStart ? segment.points[1] ?? segment.points[0]! : segment.points[segment.points.length - 2] ?? segment.points.at(-1)!
      const length = Math.hypot(other.x - point.x, other.y - point.y) || 1
      return Object.freeze({ segmentId: segment.id, tileId: tile as TileId, headingX: (other.x - point.x) / length, headingY: (other.y - point.y) / length })
    }).sort((a, b) => Math.atan2(a.headingY, a.headingX) - Math.atan2(b.headingY, b.headingX) || a.segmentId.localeCompare(b.segmentId))
    const value = values[tile]!
    // Signal eligibility belongs to the junction tile. A segment may upgrade
    // to a highway far outside town, but that must not suppress signals at a
    // settlement collector that happens to share the same maximal chain.
    const junctionClass = roadClass(value)
    const streetControlEligible = entries.length >= 3
      && (value & TRANSPORT_FLAGS.settlement) !== 0
      && junctionClass >= TRANSPORT_ROAD_CLASS.collector
      && junctionClass < TRANSPORT_ROAD_CLASS.highway
    // Four-way junctions are more likely to be controlled than T junctions,
    // but not every town block needs a forest of signals and poles.
    const signalChance = entries.length >= 4 ? 0.58 : 0.3
    const signalized = streetControlEligible
      && junctionFeatureRoll(tile, world.descriptor.seed, 0x51a7) < signalChance
    // Crossings are an independent seeded feature: some unsignalized town
    // junctions still get zebra stripes, and repeated seeds remain identical.
    const hasCrosswalks = streetControlEligible
      && junctionFeatureRoll(tile, world.descriptor.seed, 0xc2055) < 0.62
    const junction = Object.freeze({
      index, id: `junction:${tile}`, tileId: tile as TileId, x: point.x, y: point.y, elevation: point.elevation,
      segmentIds: freezeArray(entries.map((entry) => entry.id).sort()), ports: freezeArray(ports), signalized,
      hasCrosswalks, hasStopLines: signalized,
    })
    junctionByTile.set(tile, junction)
    return junction
  })

  const lanes: DirectedLane[] = []
  for (const segment of segments) {
    const laneWidth = segment.profile.halfWidth / segment.profile.lanesPerDirection
    for (const direction of ['forward', 'reverse'] as const) {
      const basePoints = direction === 'forward' ? segment.points : [...segment.points].reverse()
      const side = drivingSide === 'left' ? 1 : -1
      for (let laneIndex = 0; laneIndex < segment.profile.lanesPerDirection; laneIndex++) {
        const offset = side * (laneIndex + 0.5) * laneWidth
        lanes.push(Object.freeze({
          index: lanes.length, id: `lane:${segment.id}:${direction}:${laneIndex}`, segmentId: segment.id,
          direction, laneIndex,
          fromJunctionId: direction === 'forward' ? segment.fromJunctionId : segment.toJunctionId,
          toJunctionId: direction === 'forward' ? segment.toJunctionId : segment.fromJunctionId,
          lateralOffset: offset, speedLimit: segment.profile.speedLimit,
          points: lanePoints(basePoints, offset),
        }))
      }
    }
  }
  const incoming = new Map<string, DirectedLane[]>()
  const outgoing = new Map<string, DirectedLane[]>()
  for (const lane of lanes) {
    if (lane.toJunctionId) incoming.set(lane.toJunctionId, [...(incoming.get(lane.toJunctionId) ?? []), lane])
    if (lane.fromJunctionId) outgoing.set(lane.fromJunctionId, [...(outgoing.get(lane.fromJunctionId) ?? []), lane])
  }
  const connectors: LaneConnector[] = []
  for (const junction of junctions) {
    for (const from of incoming.get(junction.id) ?? []) {
      for (const to of outgoing.get(junction.id) ?? []) {
        if (from.segmentId === to.segmentId) continue
        const a0 = from.points[Math.max(0, from.points.length - 2)]!
        const a1 = from.points.at(-1)!
        const b1 = to.points[Math.min(1, to.points.length - 1)]!
        const ax = a1.x - a0.x
        const ay = a1.y - a0.y
        const bx = b1.x - a1.x
        const by = b1.y - a1.y
        const cross = ax * by - ay * bx
        const dot = ax * bx + ay * by
        const turn: RoadTurn = Math.abs(cross) <= Math.abs(dot) * 0.35 ? 'straight' : cross < 0 ? 'left' : 'right'
        connectors.push(Object.freeze({
          id: `connector:${junction.tileId}:${from.index}:${to.index}`, junctionId: junction.id,
          fromLaneId: from.id, toLaneId: to.id, turn,
          signalGroup: junction.signalized ? (turn === 'straight' ? 0 : turn === 'left' ? 1 : 2) : null,
        }))
      }
    }
  }

  const segmentAtTile = new Int32Array(size)
  segmentAtTile.fill(-1)
  for (const segment of segments) for (const id of segment.tileIds) if (segmentAtTile[id] < 0) segmentAtTile[id] = segment.index
  const nearestSegmentByTile = segmentAtTile.slice()
  const accessDistanceByTile = new Uint16Array(size)
  accessDistanceByTile.fill(0xffff)
  const queue = new Int32Array(size)
  let read = 0
  let write = 0
  for (let id = 0; id < size; id++) if (segmentAtTile[id]! >= 0) { accessDistanceByTile[id] = 0; queue[write++] = id }
  while (read < write) {
    const id = queue[read++]!
    const x = id % width
    const y = Math.floor(id / width)
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const next = ny * width + nx
      if (accessDistanceByTile[next]! !== 0xffff) continue
      accessDistanceByTile[next] = Math.min(0xfffe, accessDistanceByTile[id]! + 1)
      nearestSegmentByTile[next] = nearestSegmentByTile[id]!
      queue[write++] = next
    }
  }

  const terminals: RoadTerminal[] = []
  const addTerminal = (kind: RoadTerminal['kind'], id: string, tile: number, cityIndex?: number) => {
    const segmentIndex = nearestSegmentByTile[tile] ?? -1
    const segment = segmentIndex >= 0 ? segments[segmentIndex] : undefined
    terminals.push(Object.freeze({ id, kind, tileId: tile as TileId, cityIndex, segmentId: segment?.id ?? null, junctionId: node[tile] ? `junction:${tile}` : null }))
  }
  for (const city of world.cities) {
    const center = Math.max(0, Math.min(size - 1, city.cy * width + city.cx))
    addTerminal('settlement', `terminal:city:${city.index}`, center, city.index)
    if (city.tier !== 'metro') continue
    const gateway = nearestRegionalTile(city, values, width, height)
    if (gateway >= 0) addTerminal('gateway', `terminal:gateway:${city.index}`, gateway, city.index)
  }
  for (const junction of junctions) if (degree(junction.tileId) === 1) addTerminal('network-end', `terminal:end:${junction.tileId}`, junction.tileId)

  const chunkMutable = new Map<number, { segments: Set<string>; junctions: Set<string>; terminals: Set<string> }>()
  const chunksWide = Math.ceil(width / chunkSize)
  const chunkFor = (tile: number) => Math.floor(Math.floor(tile / width) / chunkSize) * chunksWide + Math.floor((tile % width) / chunkSize)
  const chunkEntry = (chunk: number) => {
    let entry = chunkMutable.get(chunk)
    if (!entry) { entry = { segments: new Set(), junctions: new Set(), terminals: new Set() }; chunkMutable.set(chunk, entry) }
    return entry
  }
  for (const segment of segments) for (const tile of segment.tileIds) chunkEntry(chunkFor(tile)).segments.add(segment.id)
  for (const junction of junctions) chunkEntry(chunkFor(junction.tileId)).junctions.add(junction.id)
  for (const terminal of terminals) chunkEntry(chunkFor(terminal.tileId)).terminals.add(terminal.id)
  const chunks = new Map<number, RoadChunkIndex>()
  for (const [chunk, entry] of chunkMutable) chunks.set(chunk, Object.freeze({
    segmentIds: freezeArray([...entry.segments].sort()), junctionIds: freezeArray([...entry.junctions].sort()), terminalIds: freezeArray([...entry.terminals].sort()),
  }))

  const snapshot: RoadNetworkSnapshot = Object.freeze({
    revision, width, height, chunkSize, chunksWide, drivingSide, profiles: ROAD_CLASS_PROFILES,
    segments: freezeArray(segments), junctions: freezeArray(junctions), lanes: freezeArray(lanes),
    connectors: freezeArray(connectors), terminals: freezeArray(terminals), chunks,
    nearestSegmentByTile, accessDistanceByTile,
  })
  let sourceCache = cache.get(normalized.identity)
  if (!sourceCache) { sourceCache = new Map(); cache.set(normalized.identity, sourceCache) }
  sourceCache.set(cacheKey, snapshot)
  return snapshot
}

function nearestRegionalTile(city: StaticCity, values: Uint16Array, width: number, height: number): number {
  let best = -1
  let bestScore = Infinity
  const radius = Math.max(2, Math.ceil(city.radius * 1.8))
  for (let y = Math.max(0, city.cy - radius); y <= Math.min(height - 1, city.cy + radius); y++) {
    for (let x = Math.max(0, city.cx - radius); x <= Math.min(width - 1, city.cx + radius); x++) {
      const id = y * width + x
      if ((values[id]! & TRANSPORT_FLAGS.regional) === 0) continue
      const distance = Math.abs(Math.hypot(x - city.cx, y - city.cy) - city.radius)
      if (distance < bestScore || (distance === bestScore && id < best)) { best = id; bestScore = distance }
    }
  }
  return best
}
