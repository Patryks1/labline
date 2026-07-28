import { describe, expect, it } from 'vitest'
import {
  TERRAIN_KIND,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  WORLD_FORMAT_VERSION,
  WORLD_GENERATOR_VERSION_V3,
  compileRoadNetwork,
  createDynamicWorld,
  generateStaticWorldV4,
  generateStaticWorldV5,
  regenerateStaticWorld,
  smoothRoadCenterline,
  type StaticWorld,
  type WorldDescriptorV3,
} from './index'

function networkFixture(): StaticWorld {
  const width = 5
  const height = 5
  const transport = new Uint16Array(width * height)
  const road = (x: number, y: number, topology: number, roadClass: number = TRANSPORT_ROAD_CLASS.collector) => {
    transport[y * width + x] = topology | (roadClass << TRANSPORT_CLASS_SHIFT) | TRANSPORT_FLAGS.settlement
  }
  // Curved west -> south chain meeting an east/west arterial at a T junction.
  road(0, 1, 1 << 2)
  road(1, 1, (1 << 6) | (1 << 4))
  road(1, 2, (1 << 0) | (1 << 2) | (1 << 6), TRANSPORT_ROAD_CLASS.arterial)
  road(0, 2, 1 << 2, TRANSPORT_ROAD_CLASS.arterial)
  road(2, 2, 1 << 6, TRANSPORT_ROAD_CLASS.arterial)
  const descriptor: WorldDescriptorV3 = {
    formatVersion: WORLD_FORMAT_VERSION,
    generatorVersion: WORLD_GENERATOR_VERSION_V3,
    seed: 1, width, height, chunkSize: 2, cityCount: 2,
    landValueBase: 1, landValueCityPeak: 2, energyPricePerMWh: 1, waterCoverage: 0.02,
  }
  return {
    descriptor, transport, kind: new Uint8Array(width * height).fill(TERRAIN_KIND.empty),
    region: new Uint8Array(width * height), feature: new Uint16Array(width * height),
    variantMask: new Uint8Array(width * height), cities: [], regions: [], lakes: [], starterPads: [],
    staticHash: 'fixture', coverage: { water: 0, urban: 0, forest: 0 },
  }
}

describe('compiled road network', () => {
  it('creates stable maximal chains, junctions, lanes, connectors, and per-tile access', () => {
    const world = networkFixture()
    const left = compileRoadNetwork(world, 'left')
    expect(compileRoadNetwork(world, 'left')).toBe(left)
    expect(left.segments).toHaveLength(3)
    const controlled = left.junctions.find((junction) => junction.tileId === 11)!
    expect(controlled.hasStopLines).toBe(controlled.signalized)
    expect(typeof controlled.hasCrosswalks).toBe('boolean')
    expect(left.segments.some((segment) => segment.points.length === 3)).toBe(true)
    expect(left.lanes.length).toBeGreaterThan(left.segments.length * 2)
    expect(left.connectors.every((connector) => connector.fromLaneId !== connector.toLaneId)).toBe(true)
    expect(left.nearestSegmentByTile[24]).toBeGreaterThanOrEqual(0)
    expect(left.accessDistanceByTile[24]).toBeGreaterThan(0)
    expect(left.chunks.size).toBeGreaterThan(1)

    const right = compileRoadNetwork(world, 'right')
    expect(right).not.toBe(left)
    expect(right.lanes[0]!.lateralOffset).toBe(-left.lanes[0]!.lateralOffset)
  })

  it('fits bounded corners and removes redundant diagonal triangle shortcuts', () => {
    const corner = smoothRoadCenterline([
      { tileId: 0 as never, x: 0.5, y: 1.5, elevation: 0 },
      { tileId: 1 as never, x: 1.5, y: 1.5, elevation: 0 },
      { tileId: 2 as never, x: 1.5, y: 2.5, elevation: 0 },
    ])
    expect(corner.length).toBeGreaterThan(3)
    expect(corner.every((point) => point.x >= 0.5 && point.x <= 1.5)).toBe(true)
    expect(corner.every((point) => point.y >= 1.5 && point.y <= 2.5)).toBe(true)

    const world = networkFixture()
    // Add west->south-east while the same endpoints already have the
    // west->centre->south-east orthogonal route.
    world.transport![5] |= 1 << 3
    world.transport![11] |= 1 << 7
    const network = compileRoadNetwork(world)
    const diagonal = network.segments.some((segment) =>
      segment.tileIds.some((tile, index) => tile === 5 && segment.tileIds[index + 1] === 11),
    )
    expect(diagonal).toBe(false)
  })

  it('retains the compiled snapshot across unrelated world revisions', () => {
    const world = createDynamicWorld(networkFixture())
    const initial = compileRoadNetwork(world)
    const initialRoadRevision = world.roadRevision
    const nonRoad = world.beginBatch().patchTerrain(24 as never, { feature: 7 }).commit()
    expect(nonRoad.committed).toBe(true)
    expect(world.revision).toBeGreaterThan(initial.revision)
    expect(world.roadRevision).toBe(initialRoadRevision)
    expect(compileRoadNetwork(world)).toBe(initial)

    const roadTile = 5 as never
    const packed = world.getTransport(roadTile)
    world.beginBatch().patchTerrain(roadTile, { transport: packed & ~0xff }).commit()
    expect(world.roadRevision).toBe(initialRoadRevision + 1)
    expect(compileRoadNetwork(world)).not.toBe(initial)
  })
})

describe('generator V5 transport hierarchy', () => {
  it('is deterministic, regenerates exactly, and leaves the pinned V4 output unchanged', () => {
    const options = { seed: 417, width: 128, height: 128, cityCount: 3 }
    const legacy = generateStaticWorldV4(options)
    const a = generateStaticWorldV5(options)
    const b = generateStaticWorldV5(options)
    expect(legacy.staticHash).toBe('fac6a2a2')
    expect(a.descriptor.generatorVersion).toBe(5)
    expect(a.staticHash).toBe(b.staticHash)
    expect(regenerateStaticWorld(a.descriptor).staticHash).toBe(a.staticHash)
    const classes = new Set(a.transport!.map((value) => (value >> TRANSPORT_CLASS_SHIFT) & 0x07))
    expect(classes).toContain(TRANSPORT_ROAD_CLASS.local)
    expect(classes).toContain(TRANSPORT_ROAD_CLASS.collector)
    expect(classes).toContain(TRANSPORT_ROAD_CLASS.arterial)
    expect(classes).toContain(TRANSPORT_ROAD_CLASS.highway)
    for (const city of a.cities.filter((candidate) => candidate.tier !== 'metro')) {
      const center = city.cy * a.descriptor.width + city.cx
      expect((a.transport![center]! >> TRANSPORT_CLASS_SHIFT) & 0x07).not.toBe(TRANSPORT_ROAD_CLASS.highway)
    }
  }, 20_000)

  it('keeps generated corridors free of vegetation and non-junction diagonal crossings', () => {
    const steps = [
      [0, -1], [1, -1], [1, 0], [1, 1],
      [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ] as const
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV5({ seed, width: 96, height: 96, cityCount: 3 })
      const transport = world.transport!
      for (let id = 0; id < transport.length; id++) {
        const roadClass = (transport[id]! >> TRANSPORT_CLASS_SHIFT) & 0x07
        if (roadClass === TRANSPORT_ROAD_CLASS.none) continue
        expect([TERRAIN_KIND.forest, TERRAIN_KIND.park], `seed ${seed}: road environment ${id}`)
          .not.toContain(world.kind[id])
        const x = id % world.descriptor.width
        const y = Math.floor(id / world.descriptor.width)
        for (let direction = 0; direction < steps.length; direction++) {
          if ((transport[id]! & (1 << direction)) === 0) continue
          const [dx, dy] = steps[direction]!
          const neighbor = (y + dy) * world.descriptor.width + x + dx
          expect(transport[neighbor]! & (1 << ((direction + 4) & 7)), `seed ${seed}: reciprocal ${id}`)
            .not.toBe(0)
        }
      }
      for (let y = 0; y + 1 < world.descriptor.height; y++) {
        for (let x = 0; x + 1 < world.descriptor.width; x++) {
          const nw = y * world.descriptor.width + x
          const ne = nw + 1
          const sw = nw + world.descriptor.width
          const se = sw + 1
          const nwSe = (transport[nw]! & (1 << 3)) !== 0 && (transport[se]! & (1 << 7)) !== 0
          const neSw = (transport[ne]! & (1 << 5)) !== 0 && (transport[sw]! & (1 << 1)) !== 0
          expect(nwSe && neSw, `seed ${seed}: crossing at ${x},${y}`).toBe(false)
        }
      }
    }
  }, 20_000)

  it('builds reciprocal cardinal crossroads with deterministic, non-universal street controls', () => {
    const cardinal = [
      [0, -1, 0], [1, 0, 2], [0, 1, 4], [-1, 0, 6],
    ] as const
    const cardinalMask = cardinal.reduce((mask, entry) => mask | (1 << entry[2]), 0)
    let junctionCount = 0
    let signalCount = 0
    let crossingCount = 0
    for (const seed of [17, 73, 417, 9001]) {
      const world = generateStaticWorldV5({ seed, width: 96, height: 96, cityCount: 3 })
      const network = compileRoadNetwork(world)
      const towns = world.cities.filter((city) => city.tier === 'town')
      expect(towns.length, `seed ${seed}: generated towns`).toBeGreaterThan(0)
      for (const town of towns) {
        const center = town.cy * world.descriptor.width + town.cx
        const value = world.transport![center]!
        expect(value & 0xff, `seed ${seed}: ${town.id} cardinal-only centre`).toBe(cardinalMask)
        expect(value & TRANSPORT_FLAGS.settlement, `seed ${seed}: ${town.id} settlement flag`).not.toBe(0)
        expect((value >> TRANSPORT_CLASS_SHIFT) & 0x07, `seed ${seed}: ${town.id} road class`)
          .toBeGreaterThanOrEqual(TRANSPORT_ROAD_CLASS.collector)
        for (const [dx, dy, direction] of cardinal) {
          const neighbor = (town.cy + dy) * world.descriptor.width + town.cx + dx
          expect(
            world.transport![neighbor]! & (1 << ((direction + 4) & 7)),
            `seed ${seed}: ${town.id} reciprocal arm ${direction}`,
          ).not.toBe(0)
        }
        const junction = network.junctions.find((candidate) => candidate.tileId === center)
        expect(junction?.ports, `seed ${seed}: ${town.id} compiled cross street`).toHaveLength(4)
        expect(junction?.hasStopLines).toBe(junction?.signalized)
        junctionCount++
        if (junction?.signalized) signalCount++
        if (junction?.hasCrosswalks) crossingCount++
      }
    }
    expect(signalCount).toBeGreaterThan(0)
    expect(signalCount).toBeLessThan(junctionCount)
    expect(crossingCount).toBeGreaterThan(0)
    expect(crossingCount).toBeLessThan(junctionCount)
  }, 20_000)
})
