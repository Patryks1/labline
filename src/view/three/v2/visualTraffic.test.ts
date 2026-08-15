import { describe, expect, it } from 'vitest'
import type { DirectedLane, RoadNetworkSnapshot, RoadSegment } from '../../../sim/world'
import type { TileId } from '../../../sim/world'
import { VisualTrafficSimulation, findRoute } from './visualTraffic'

describe('visual lane traffic', () => {
  it('finds directed A-to-B routes and cannot manufacture reverse edges', () => {
    const adjacency = [[1], [2], []] as const
    expect(findRoute(adjacency, 0, 2)).toEqual([0, 1, 2])
    expect(findRoute(adjacency, 2, 0)).toEqual([])
  })

  it('advances at 10 Hz, freezes while paused, and follows lanes forward', () => {
    const network = linearNetwork(24)
    const utilization = new Map(network.segments.map((segment) => [segment.index, 2]))
    const simulation = new VisualTrafficSimulation(network, new Set([0]), 1, utilization, 320)
    expect(simulation.vehicles.length).toBeGreaterThan(0)
    expect(simulation.vehicles.every((vehicle) => Math.abs(vehicle.current.z) < 1e-6)).toBe(true)
    expect(simulation.vehicles.every((vehicle) => vehicle.current.x >= 0 && vehicle.current.x <= 24)).toBe(true)

    simulation.setFrame(1, false)
    const initial = simulation.vehicles.map((vehicle) => ({ ...vehicle.current }))
    expect(simulation.setFrame(1.09, false)).toBe(false)
    expect(simulation.vehicles.map((vehicle) => vehicle.current)).toEqual(initial)

    expect(simulation.setFrame(1.11, false)).toBe(true)
    for (let index = 0; index < simulation.vehicles.length; index++) {
      const before = initial[index]!
      const after = simulation.vehicles[index]!.current
      expect(after.x).toBeGreaterThanOrEqual(before.x)
      expect(Math.abs(after.yaw)).toBeLessThan(1e-6)
    }

    const paused = simulation.vehicles.map((vehicle) => ({ ...vehicle.current }))
    simulation.setFrame(2, true)
    expect(simulation.vehicles.map((vehicle) => vehicle.current)).toEqual(paused)
  })

  it('is deterministic for identical network, visibility, and congestion', () => {
    const network = linearNetwork(24)
    const loads = new Map(network.segments.map((segment) => [segment.index, 0.8]))
    const first = new VisualTrafficSimulation(network, new Set([0]), 1.05, loads)
    const second = new VisualTrafficSimulation(network, new Set([0]), 1.05, loads)
    first.setFrame(0, false)
    second.setFrame(0, false)
    first.setFrame(0.45, false)
    second.setFrame(0.45, false)
    expect(first.vehicles).toEqual(second.vehicles)
  })

  it('distributes a capped logical pool across road chunks instead of starving later chunks', () => {
    const base = linearNetwork(48)
    const firstSegments = base.segments.slice(0, 24).map(segment => segment.id)
    const secondSegments = base.segments.slice(24).map(segment => segment.id)
    const network: RoadNetworkSnapshot = {
      ...base,
      chunksWide: 2,
      chunks: new Map([
        [0, { segmentIds: firstSegments, junctionIds: [], terminalIds: [] }],
        [1, { segmentIds: secondSegments, junctionIds: [], terminalIds: [] }],
      ]),
    }
    const loads = new Map(network.segments.map(segment => [segment.index, 0]))
    const simulation = new VisualTrafficSimulation(network, new Set([0, 1]), 1, loads, 2)

    expect(simulation.vehicles).toHaveLength(2)
    expect(simulation.vehiclesInSegments(new Set(firstSegments))).toHaveLength(1)
    expect(simulation.vehiclesInSegments(new Set(secondSegments))).toHaveLength(1)
  })

  it('refreshes daily utilization without rebuilding routes or topology', () => {
    const network = linearNetwork(24)
    const simulation = new VisualTrafficSimulation(network, new Set([0]), 1, new Map(), 320)
    const routes = simulation.vehicles.map((vehicle) => vehicle.route)
    const freeFlow = simulation.vehicles.map((vehicle) => vehicle.speed)

    simulation.refreshUtilization(new Map(network.segments.map((segment) => [segment.index, 2])))

    expect(simulation.network).toBe(network)
    expect(simulation.vehicles.map((vehicle) => vehicle.route)).toEqual(routes)
    expect(simulation.vehicles.every((vehicle, index) => vehicle.speed < freeFlow[index]!)).toBe(true)
    expect(simulation.stats.utilizationRefreshes).toBe(1)
  })

  it('does no fixed-step work while paused', () => {
    const simulation = new VisualTrafficSimulation(linearNetwork(24), new Set([0]), 1)
    simulation.setFrame(0, false)
    const before = simulation.vehicles.map((vehicle) => ({ ...vehicle.current }))

    expect(simulation.setFrame(10, true)).toBe(false)
    expect(simulation.lastFrameSteps).toBe(0)
    expect(simulation.stats.steps).toBe(0)
    expect(simulation.vehicles.map((vehicle) => vehicle.current)).toEqual(before)
  })

  it('crosses lateral lane gaps through connectors without teleporting', () => {
    const base = linearNetwork(24)
    const lanes = base.lanes.map((lane, index) => index === 1
      ? {
          ...lane,
          points: lane.points.map((point) => ({ ...point, y: point.y + 0.6 })),
        }
      : lane)
    const network: RoadNetworkSnapshot = { ...base, lanes }
    const simulation = new VisualTrafficSimulation(network, new Set([0]), 1, new Map(), 320)
    simulation.setFrame(0, false)

    for (let frame = 1; frame <= 50; frame++) {
      const before = simulation.vehicles.map((vehicle) => ({ ...vehicle.current }))
      simulation.setFrame(frame * 0.101, false)
      for (let index = 0; index < simulation.vehicles.length; index++) {
        const vehicle = simulation.vehicles[index]!
        const previous = before[index]!
        const displacement = Math.hypot(
          vehicle.current.x - previous.x,
          vehicle.current.z - previous.z,
        )
        expect(displacement).toBeLessThanOrEqual(vehicle.speed * 0.101 + 1e-4)
      }
    }
  })

  it('extends connected trips continuously instead of despawning at route destinations', () => {
    const base = linearNetwork(12)
    const lastLane = base.lanes.at(-1)!
    const firstLane = base.lanes[0]!
    const network: RoadNetworkSnapshot = {
      ...base,
      connectors: [...base.connectors, {
        id: 'connector:return-loop',
        junctionId: 'junction:return-loop',
        fromLaneId: lastLane.id,
        toLaneId: firstLane.id,
        turn: 'straight',
        signalGroup: null,
      }],
    }
    const simulation = new VisualTrafficSimulation(
      network,
      new Set([0]),
      1,
      new Map(network.segments.map((segment) => [segment.index, 2])),
      320,
    )
    simulation.setFrame(0, false)
    for (let frame = 1; frame <= 1_200; frame++) {
      simulation.setFrame(frame * 0.101, false)
    }

    expect(simulation.vehicles.some((vehicle) => vehicle.continuationCount > 0)).toBe(true)
    expect(simulation.vehicles.every((vehicle) => !vehicle.arrived)).toBe(true)
    expect(Math.max(...simulation.vehicles.map((vehicle) => vehicle.route.length))).toBeLessThanOrEqual(12)
  })
})

function linearNetwork(count: number): RoadNetworkSnapshot {
  const segments: RoadSegment[] = []
  const lanes: DirectedLane[] = []
  for (let index = 0; index < count; index++) {
    const points = [
      { tileId: index as TileId, x: index + 0.5, y: 0.5, elevation: 0 },
      { tileId: (index + 1) as TileId, x: index + 1.5, y: 0.5, elevation: 0 },
    ]
    segments.push({
      index,
      id: `segment:${index}`,
      fromJunctionId: `junction:${index}`,
      toJunctionId: `junction:${index + 1}`,
      tileIds: [index as TileId, (index + 1) as TileId],
      points,
      roadClass: 4,
      flags: 0,
      bridge: false,
      length: 1,
      profile: {
        roadClass: 4,
        lanesPerDirection: 2,
        speedLimit: 110,
        capacityPerDay: 5_600,
        halfWidth: 0.42,
        shoulderWidth: 0.08,
      },
    })
    lanes.push({
      index,
      id: `lane:${index}`,
      segmentId: `segment:${index}`,
      direction: 'forward',
      laneIndex: 0,
      fromJunctionId: `junction:${index}`,
      toJunctionId: `junction:${index + 1}`,
      lateralOffset: 0.1,
      speedLimit: 110,
      points,
    })
  }
  return {
    revision: 7,
    width: count + 1,
    height: 1,
    chunkSize: 32,
    chunksWide: 1,
    drivingSide: 'left',
    profiles: {} as RoadNetworkSnapshot['profiles'],
    segments,
    junctions: [],
    lanes,
    connectors: lanes.slice(0, -1).map((lane, index) => ({
      id: `connector:${index}`,
      junctionId: `junction:${index + 1}`,
      fromLaneId: lane.id,
      toLaneId: lanes[index + 1]!.id,
      turn: 'straight',
      signalGroup: null,
    })),
    terminals: [],
    chunks: new Map([[0, {
      segmentIds: segments.map((segment) => segment.id),
      junctionIds: [],
      terminalIds: [],
    }]]),
    nearestSegmentByTile: new Int32Array(count + 1),
    accessDistanceByTile: new Uint16Array(count + 1),
  }
}
