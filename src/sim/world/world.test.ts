import { describe, expect, it } from 'vitest'
import {
  BIOME_KIND,
  TERRAIN_KIND,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  TRANSPORT_TOPOLOGY_MASK,
  WorldChangeJournal,
  applyCityGrowth,
  beginWorldBatch,
  chunkIdForTile,
  createDynamicWorld,
  generateStaticWorldV2,
  generateStaticWorldV3,
  generateStaticWorldV4,
  getBiome,
  getCornerElevation,
  getTileElevation,
  getTileSlope,
  getWaterElevation,
  regenerateStaticWorld,
  planCityGrowth,
  staticWorldByteLength,
  staticWorldV3Hash,
  staticWorldV4Hash,
  tileCoords,
  tileId,
  type Facility,
  type StaticCity,
} from './index'

function testWorld(size = 96) {
  return generateStaticWorldV2({ seed: 417, width: size, height: size, cityCount: 3 })
}

function facility(id: string, ownerId: string, anchor: ReturnType<typeof tileId>): Facility {
  return {
    id,
    ownerId,
    kind: 'dc',
    anchor,
    footprint: [anchor],
    level: 1,
    constructionProgress: 0.5,
    constructionTarget: 1,
    stats: { rackCapacity: 160, mwCapacity: 24 },
  }
}

describe('compact ids', () => {
  it('round-trips tile ids and derives stable chunks', () => {
    const world = testWorld(64)
    const id = tileId(37, 42, 64, 64)
    expect(tileCoords(id, 64)).toEqual({ x: 37, y: 42 })
    expect(chunkIdForTile(id, world.descriptor)).toBe(3)
    expect(() => tileId(64, 1, 64, 64)).toThrow(RangeError)
  })
})

describe('dynamic world batches and indexes', () => {
  it('commits player and rival facilities through the same indexed path', () => {
    const staticWorld = testWorld()
    const world = createDynamicWorld(staticWorld)
    const playerTile = staticWorld.starterPads[0] ?? tileId(0, 0, 96, 96)
    const rivalTile = staticWorld.starterPads[1] ?? tileId(1, 0, 96, 96)
    const batch = beginWorldBatch(world)
    batch.addFacility(facility('player-dc', 'player', playerTile))
    batch.addFacility(facility('rival-dc', 'rival_nova', rivalTile))
    const result = batch.commit()

    expect(result.committed).toBe(true)
    expect(world.getFacilityAt(playerTile)?.id).toBe('player-dc')
    expect(world.queryFacilities({ ownerId: 'player' }).map((item) => item.id)).toEqual([
      'player-dc',
    ])
    expect(world.queryFacilities({ ownerId: 'rival_nova' }).map((item) => item.id)).toEqual([
      'rival-dc',
    ])
    expect(world.metrics.facilities.count).toBe(2)
    expect(world.metrics.byOwner.get('player')?.rackCapacity).toBe(160)

    const visited: string[] = []
    world.forEachFacility({ underConstruction: true }, (item) => visited.push(item.id))
    expect(visited.sort()).toEqual(['player-dc', 'rival-dc'])
  })

  it('validates the whole occupancy transaction before changing state', () => {
    const staticWorld = testWorld(64)
    const world = createDynamicWorld(staticWorld)
    const anchor = tileId(2, 2, 64, 64)
    const batch = world.beginBatch()
    batch.addFacility(facility('a', 'player', anchor))
    batch.addFacility(facility('b', 'rival_nova', anchor))
    expect(() => batch.commit()).toThrow(/collide/)
    expect(world.facilitiesById.size).toBe(0)
    expect(world.occupancy.size).toBe(0)
    expect(world.revision).toBe(0)
  })
})

describe('bounded change journal', () => {
  it('returns deltas at the boundary and reset semantics once history is stale', () => {
    const journal = new WorldChangeJournal(2)
    const append = (revision: number) =>
      journal.append({
        revision,
        flags: 1,
        tileIds: [],
        chunkIds: [],
        facilityIds: [],
        cityIndexes: [],
      })
    append(1)
    append(2)
    append(3)
    expect(journal.changesSince(1).kind).toBe('delta')
    expect(journal.changesSince(0)).toEqual({
      kind: 'reset',
      reason: 'history-evicted',
      nextSequence: 3,
    })
    expect(journal.changesSince(4).kind).toBe('reset')
  })
})

describe('numeric generator v2', () => {
  it('is deterministic for the complete compact layer set', () => {
    const a = testWorld(128)
    const b = testWorld(128)
    const c = generateStaticWorldV2({ seed: 418, width: 128, height: 128, cityCount: 3 })
    expect(a.staticHash).toBe(b.staticHash)
    expect(a.kind).toEqual(b.kind)
    expect(a.staticHash).not.toBe(c.staticHash)
  })

  it('retains the established hash for the compatibility fixture', () => {
    expect(testWorld(128).staticHash).toBe('dd88d09b')
  })

  it('keeps a 1000x1000 base world at five bytes per tile with scaled cities and lakes', () => {
    const world = generateStaticWorldV2({ seed: 9001, width: 1000, height: 1000 })
    expect(staticWorldByteLength(world)).toBe(5_000_000)
    expect(world.descriptor.cityCount).toBeGreaterThanOrEqual(12)
    expect(world.coverage.water).toBeGreaterThanOrEqual(0.04)
    expect(world.coverage.water).toBeLessThanOrEqual(0.1)
    expect(world.coverage.urban).toBeGreaterThanOrEqual(0.04)
    expect(world.coverage.urban).toBeLessThanOrEqual(0.12)
    expect(Math.max(...world.cities.map((city) => city.radius))).toBeGreaterThanOrEqual(42)
    expect(Math.min(...world.cities.map((city) => city.radius))).toBeLessThanOrEqual(20)
    expect(world.lakes[0]?.tileCount).toBeGreaterThanOrEqual(8_000)
  }, 20_000)
})

describe('numeric generator v4 terrain', () => {
  it('creates deterministic shared-corner elevation and biome layers', () => {
    const a = generateStaticWorldV4({ seed: 417, width: 128, height: 128, cityCount: 3 })
    const b = generateStaticWorldV4({ seed: 417, width: 128, height: 128, cityCount: 3 })
    expect(a.descriptor.generatorVersion).toBe(4)
    expect(a.elevation).toHaveLength(129 * 129)
    expect(a.biome).toHaveLength(128 * 128)
    expect(a.elevation).toEqual(b.elevation)
    expect(a.biome).toEqual(b.biome)
    expect(a.staticHash).toBe(b.staticHash)
    expect(a.staticHash).toBe('fac6a2a2')
    expect(regenerateStaticWorld(a.descriptor).staticHash).toBe(a.staticHash)
    expect(staticWorldByteLength(a)).toBe(128 * 128 * 8 + 129 * 129 * 2)
    expect(new Set(a.biome)).toContain(0)
    expect(Math.max(...a.elevation!)).toBeGreaterThan(Math.min(...a.elevation!))
  })

  it('provides flat compatibility accessors and terrain-aware V4 accessors', () => {
    const flat = generateStaticWorldV3({ seed: 19, width: 64, height: 64, cityCount: 2 })
    expect(getCornerElevation(flat, 10, 10)).toBe(0)
    expect(getTileElevation(flat, 10, 10)).toBe(0)
    expect(getTileSlope(flat, 10, 10)).toBe(0)
    expect(getBiome(flat, 10, 10)).toBe(0)

    const world = generateStaticWorldV4({ seed: 19, width: 64, height: 64, cityCount: 2 })
    const rural = world.kind.findIndex((kind, id) => kind === TERRAIN_KIND.empty && world.transport![id] === 0)
    const x = rural % world.descriptor.width
    const y = Math.floor(rural / world.descriptor.width)
    expect(Number.isFinite(getTileElevation(world, x, y))).toBe(true)
    expect(getTileSlope(world, x, y)).toBeGreaterThanOrEqual(0)
    const lake = world.kind.findIndex((kind) => kind === TERRAIN_KIND.lake)
    expect(getWaterElevation(world, lake % world.descriptor.width, Math.floor(lake / world.descriptor.width))).toBe(0)
  })

  it('includes elevation and biome bytes in the canonical fingerprint', () => {
    const world = generateStaticWorldV4({ seed: 73, width: 64, height: 64, cityCount: 2 })
    const elevation = world.elevation!.slice()
    elevation[0] = elevation[0]! + 1
    const layers = [world.kind, world.region, world.feature, world.variantMask, world.transport!, elevation, world.biome!]
    expect(staticWorldV4Hash(world.descriptor as Extract<typeof world.descriptor, { generatorVersion: 4 }>,
      layers, world.cities, world.regions, world.lakes, world.starterPads)).not.toBe(world.staticHash)
  })

  it('derives connected lake metadata and biomes from elevation', () => {
    const world = generateStaticWorldV4({ seed: 73, width: 128, height: 128, cityCount: 3 })
    const waterTiles = world.kind.reduce((count, kind) => count + (kind === TERRAIN_KIND.lake ? 1 : 0), 0)
    expect(world.lakes.reduce((count, lake) => count + lake.tileCount, 0)).toBe(waterTiles)
    expect(world.coverage.water).toBeCloseTo(world.descriptor.waterCoverage, 3)
    const validBiomes = new Set<number>(Object.values(BIOME_KIND))
    const seaLevel = world.descriptor.generatorVersion === 4 ? world.descriptor.seaLevel : 0
    for (let id = 0; id < world.kind.length; id++) {
      expect(validBiomes.has(world.biome![id]!)).toBe(true)
      if (world.kind[id] !== TERRAIN_KIND.lake) continue
      const x = id % world.descriptor.width
      const y = Math.floor(id / world.descriptor.width)
      expect(getCornerElevation(world, x, y)).toBeLessThanOrEqual(seaLevel)
      expect(getCornerElevation(world, x + 1, y)).toBeLessThanOrEqual(seaLevel)
      expect(getCornerElevation(world, x, y + 1)).toBeLessThanOrEqual(seaLevel)
      expect(getCornerElevation(world, x + 1, y + 1)).toBeLessThanOrEqual(seaLevel)
    }
  })

  it('forms clustered mountain ranges with coherent ridges and seed diversity', () => {
    const hashes = new Set<string>()
    const ridgeSignatures = new Set<string>()
    for (const seed of [17, 73, 417]) {
      const world = generateStaticWorldV4({ seed, width: 128, height: 128, cityCount: 3 })
      hashes.add(world.staticHash)
      const alpine = world.biome!.map((value) => value === BIOME_KIND.alpine ? 1 : 0)
      const alpineCount = alpine.reduce((count, value) => count + value, 0)
      let adjacent = 0
      let peakId = 0
      for (let id = 0; id < alpine.length; id++) {
        if (!alpine[id]) continue
        const x = id % world.descriptor.width
        const y = Math.floor(id / world.descriptor.width)
        if ((x > 0 && alpine[id - 1]) ||
          (x + 1 < world.descriptor.width && alpine[id + 1]) ||
          (y > 0 && alpine[id - world.descriptor.width]) ||
          (y + 1 < world.descriptor.height && alpine[id + world.descriptor.width])) adjacent++
        if (getTileElevation(world, x, y) > getTileElevation(
          world,
          peakId % world.descriptor.width,
          Math.floor(peakId / world.descriptor.width),
        )) peakId = id
      }
      expect(alpineCount, `seed ${seed}: mountain coverage`).toBeGreaterThan(128 * 128 * 0.008)
      expect(alpineCount, `seed ${seed}: bounded mountain coverage`).toBeLessThan(128 * 128 * 0.3)
      expect(adjacent / alpineCount, `seed ${seed}: ridge coherence`).toBeGreaterThan(0.9)
      ridgeSignatures.add(`${Math.floor((peakId % 128) / 16)}:${Math.floor(Math.floor(peakId / 128) / 16)}`)
    }
    expect(hashes).toHaveLength(3)
    expect(ridgeSignatures.size).toBeGreaterThan(1)
  })

  it('keeps layered V4 sandboxes robust from 20x20 through regional scale', () => {
    const steps = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const
    for (const size of [20, 24, 32, 48, 64, 96]) {
      for (const seed of [1, 3, 9, 17, 31]) {
        let world: ReturnType<typeof generateStaticWorldV4>
        try {
          world = generateStaticWorldV4({ seed, width: size, height: size, cityCount: 2 })
        } catch (error) {
          throw new Error(`${size} seed ${seed}: ${error instanceof Error ? error.message : String(error)}`)
        }
        const repeat = generateStaticWorldV4({ seed, width: size, height: size, cityCount: 2 })
        expect(repeat.staticHash, `${size} seed ${seed}: deterministic`).toBe(world.staticHash)
        expect(world.cities.filter((city) => city.tier === 'metro'), `${size} seed ${seed}: metros`).toHaveLength(2)
        expect(world.lakes.length, `${size} seed ${seed}: lakes`).toBeGreaterThan(0)
        expect(world.starterPads.length, `${size} seed ${seed}: starter pads`).toBeGreaterThan(0)
        expect(Math.max(...world.elevation!) - Math.min(...world.elevation!), `${size} seed ${seed}: relief`)
          .toBeGreaterThan(24)

        const transport = world.transport!
        const root = world.cities[0]!.cy * size + world.cities[0]!.cx
        const visited = new Uint8Array(transport.length)
        const queue = [root]
        visited[root] = 1
        while (queue.length > 0) {
          const id = queue.pop()!
          const x = id % size
          const y = Math.floor(id / size)
          for (let direction = 0; direction < steps.length; direction++) {
            if ((transport[id]! & (1 << direction)) === 0) continue
            const [dx, dy] = steps[direction]!
            const neighbor = (y + dy) * size + x + dx
            expect(transport[neighbor]! & (1 << ((direction + 4) & 7)), `${size} seed ${seed}: reciprocal`)
              .not.toBe(0)
            const roadClass = Math.max(
              (transport[id]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT,
              (transport[neighbor]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT,
            )
            const limit = roadClass === TRANSPORT_ROAD_CLASS.highway ? 0.06 :
              roadClass === TRANSPORT_ROAD_CLASS.arterial ? 0.09 :
                roadClass === TRANSPORT_ROAD_CLASS.collector ? 0.12 : 0.18
            expect(
              Math.abs(getTileElevation(world, x + dx, y + dy) - getTileElevation(world, x, y)) /
                Math.hypot(dx, dy),
              `${size} seed ${seed}: grade`,
            ).toBeLessThanOrEqual(limit + 1e-9)
            if (!visited[neighbor]) {
              visited[neighbor] = 1
              queue.push(neighbor)
            }
          }
        }
        for (const city of world.cities) {
          expect(visited[city.cy * size + city.cx], `${size} seed ${seed}: ${city.id} connected`).toBe(1)
        }
      }
    }
  }, 30_000)

  it('keeps settlements below exposed alpine terrain', () => {
    for (const seed of [17, 73, 417]) {
      const world = generateStaticWorldV4({ seed, width: 128, height: 128, cityCount: 3 })
      for (const city of world.cities) {
        const id = city.cy * world.descriptor.width + city.cx
        expect(world.biome![id], `seed ${seed}: ${city.id} biome`).not.toBe(BIOME_KIND.alpine)
        const seaLevel = world.descriptor.generatorVersion === 4 ? world.descriptor.seaLevel : 0
        expect(getTileElevation(world, city.cx, city.cy), `seed ${seed}: ${city.id} elevation`)
          .toBeLessThanOrEqual(seaLevel + 3.4 + 1e-9)
      }
    }
  })

  it('places settlements on buildable slopes and keeps connected road grades non-flat', () => {
    const world = generateStaticWorldV4({ seed: 417, width: 128, height: 128, cityCount: 3 })
    const transport = world.transport!
    const steps = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const
    let roadCount = 0
    let profiledEdges = 0
    const first = transport.findIndex((value) => ((value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) > 0)
    const visited = new Uint8Array(transport.length)
    const queue = [first]
    visited[first] = 1
    while (queue.length > 0) {
      const id = queue.pop()!
      const x = id % world.descriptor.width
      const y = Math.floor(id / world.descriptor.width)
      const value = transport[id]!
      roadCount++
      for (let direction = 0; direction < steps.length; direction++) {
        if ((value & (1 << direction)) === 0) continue
        const [dx, dy] = steps[direction]!
        const neighbor = (y + dy) * world.descriptor.width + x + dx
        expect(transport[neighbor]! & (1 << ((direction + 4) & 7))).not.toBe(0)
        const roadClass = Math.max(
          (value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT,
          (transport[neighbor]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT,
        )
        const limit = roadClass === TRANSPORT_ROAD_CLASS.highway ? 0.06 :
          roadClass === TRANSPORT_ROAD_CLASS.arterial ? 0.09 :
            roadClass === TRANSPORT_ROAD_CLASS.collector ? 0.12 : 0.18
        const grade = Math.abs(getTileElevation(world, x + dx, y + dy) - getTileElevation(world, x, y)) /
          Math.hypot(dx, dy)
        expect(grade).toBeLessThanOrEqual(limit + 1e-9)
        if (grade > 1e-6) profiledEdges++
        if (!visited[neighbor]) {
          visited[neighbor] = 1
          queue.push(neighbor)
        }
      }
    }
    const totalRoads = transport.reduce((count, value) =>
      count + (((value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) > 0 ? 1 : 0), 0)
    expect(roadCount).toBe(totalRoads)
    expect(profiledEdges).toBeGreaterThan(totalRoads / 4)
    for (let id = 0; id < world.feature.length; id++) {
      if (world.feature[id] === 0 || (world.feature[id]! & 0x8000) !== 0) continue
      expect(getTileSlope(world, id % world.descriptor.width, Math.floor(id / world.descriptor.width))).toBeLessThanOrEqual(0.16 + 1e-9)
    }
    for (const city of world.cities) expect(visited[city.cy * world.descriptor.width + city.cx]).toBe(1)
  })

  it('keeps every V4 settlement connected across representative terrain seeds', () => {
    const steps = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const
    // Seed 99 contains a mountain corridor with no legal 9% arterial route.
    for (const seed of [3, 17, 42, 73, 99, 417, 9001]) {
      const world = generateStaticWorldV4({ seed, width: 96, height: 96, cityCount: 3 })
      const transport = world.transport!
      const root = world.cities[0]!.cy * world.descriptor.width + world.cities[0]!.cx
      const visited = new Uint8Array(transport.length)
      const queue = [root]
      visited[root] = 1
      while (queue.length > 0) {
        const id = queue.pop()!
        const x = id % world.descriptor.width
        const y = Math.floor(id / world.descriptor.width)
        for (let direction = 0; direction < steps.length; direction++) {
          if ((transport[id]! & (1 << direction)) === 0) continue
          const [dx, dy] = steps[direction]!
          const neighbor = (y + dy) * world.descriptor.width + x + dx
          expect(transport[neighbor]! & (1 << ((direction + 4) & 7))).not.toBe(0)
          const roadClass = Math.max(
            (transport[id]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT,
            (transport[neighbor]! & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT,
          )
          const gradeLimit = roadClass === TRANSPORT_ROAD_CLASS.highway ? 0.06 :
            roadClass === TRANSPORT_ROAD_CLASS.arterial ? 0.09 :
              roadClass === TRANSPORT_ROAD_CLASS.collector ? 0.12 : 0.18
          expect(
            Math.abs(getTileElevation(world, x + dx, y + dy) - getTileElevation(world, x, y)) /
              Math.hypot(dx, dy),
            `seed ${seed}: road grade`,
          ).toBeLessThanOrEqual(gradeLimit + 1e-9)
          if (!visited[neighbor]) {
            visited[neighbor] = 1
            queue.push(neighbor)
          }
        }
      }
      for (const city of world.cities) {
        expect(visited[city.cy * world.descriptor.width + city.cx], `seed ${seed}: ${city.id}`).toBe(1)
      }
      const bridgeTiles = transport.reduce(
        (count, value) => count + ((value & TRANSPORT_FLAGS.bridge) !== 0 ? 1 : 0),
        0,
      )
      const roadTiles = transport.reduce(
        (count, value) => count + (((value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) > 0 ? 1 : 0),
        0,
      )
      expect(bridgeTiles, `seed ${seed}: bounded bridge footprint`).toBeLessThan(Math.max(17, roadTiles / 10))
    }
  }, 30_000)

  it('rejects malformed V4 terrain layer lengths at the dynamic boundary', () => {
    const world = generateStaticWorldV4({ seed: 19, width: 64, height: 64, cityCount: 2 })
    expect(() => createDynamicWorld({ ...world, elevation: world.elevation!.slice(1) })).toThrow(/layer lengths/)
    expect(() => createDynamicWorld({ ...world, biome: undefined })).toThrow(/layer lengths/)
  })
})

describe('numeric generator v3', () => {
  it('derives tiered regional settlements and a deterministic seven-byte world', () => {
    const a = generateStaticWorldV3({ seed: 417, width: 128, height: 128, cityCount: 3 })
    const b = generateStaticWorldV3({ seed: 417, width: 128, height: 128, cityCount: 3 })

    expect(a.descriptor.generatorVersion).toBe(3)
    expect(a.cities.filter((city) => city.tier === 'metro')).toHaveLength(3)
    expect(a.cities.some((city) => city.tier !== 'metro')).toBe(true)
    expect(a.cities.slice(3).every((city) => city.parentCityIndex !== undefined)).toBe(true)
    expect(a.cities.every((city) => city.regionIndex !== undefined && city.palette && city.growth)).toBe(true)
    expect(a.transport).toEqual(b.transport)
    expect(a.staticHash).toBe(b.staticHash)
    expect(a.staticHash).toBe('8f6a2ba2')
    expect(staticWorldByteLength(a)).toBe(128 * 128 * 7)
    expect(regenerateStaticWorld(a.descriptor).staticHash).toBe(a.staticHash)

    const base = a.cities[0]!
    const metadataMutations: StaticCity[] = [
      { ...base, tier: 'town' },
      { ...base, parentCityIndex: 1 },
      { ...base, regionIndex: base.regionIndex! + 1 },
      { ...base, palette: { ...base.palette!, accent: base.palette!.accent + 1 } },
      { ...base, growth: { ...base.growth!, rate: base.growth!.rate + 0.01 } },
      { ...base, growth: { ...base.growth!, directionX: base.growth!.directionX + 0.01 } },
      { ...base, growth: { ...base.growth!, directionY: base.growth!.directionY + 0.01 } },
      { ...base, growth: { ...base.growth!, irregularity: base.growth!.irregularity + 0.01 } },
    ]
    for (const changed of metadataMutations) {
      const changedCities = [changed, ...a.cities.slice(1)]
      expect(
        staticWorldV3Hash(
          a.descriptor,
          [a.kind, a.region, a.feature, a.variantMask, a.transport!],
          changedCities,
        ),
      ).not.toBe(a.staticHash)
    }
  })

  it('stores reciprocal 8-way topology separately from terrain and bounds bridges', () => {
    const world = generateStaticWorldV3({ seed: 9001, width: 160, height: 160, cityCount: 3 })
    const transport = world.transport!
    const steps = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const
    let roads = 0
    let diagonalRoads = 0
    let bridges = 0
    let roadOnNonRoadTerrain = 0
    for (let id = 0; id < transport.length; id++) {
      const value = transport[id]!
      const roadClass = (value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
      if (roadClass === TRANSPORT_ROAD_CLASS.none) continue
      roads++
      if (world.kind[id] !== TERRAIN_KIND.road) roadOnNonRoadTerrain++
      if ((value & TRANSPORT_FLAGS.bridge) !== 0) bridges++
      const x = id % world.descriptor.width
      const y = Math.floor(id / world.descriptor.width)
      for (let direction = 0; direction < 8; direction++) {
        if ((value & (1 << direction)) === 0) continue
        if ((direction & 1) === 1) diagonalRoads++
        const [dx, dy] = steps[direction]!
        const nx = x + dx
        const ny = y + dy
        expect(nx).toBeGreaterThanOrEqual(0)
        expect(ny).toBeGreaterThanOrEqual(0)
        expect(nx).toBeLessThan(world.descriptor.width)
        expect(ny).toBeLessThan(world.descriptor.height)
        const neighbor = transport[ny * world.descriptor.width + nx]!
        expect(neighbor & (1 << ((direction + 4) & 7))).not.toBe(0)
      }
      expect(value & TRANSPORT_TOPOLOGY_MASK).not.toBe(0)
    }
    expect(roads).toBeGreaterThan(0)
    expect(diagonalRoads).toBeGreaterThan(0)
    expect(roadOnNonRoadTerrain).toBe(roads)
    expect(bridges).toBeLessThan(roads / 10)
  })

  it('retains one connected transport component at representative world scales', () => {
    const cases = [
      { seed: 17, width: 64, height: 64, cityCount: 2 },
      { seed: 417, width: 128, height: 128, cityCount: 3 },
      { seed: 9001, width: 1000, height: 1000 },
    ] as const
    for (const options of cases) {
      const world = generateStaticWorldV3(options)
      const transport = world.transport!
      const first = transport.findIndex((value) => ((value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) > 0)
      expect(first).toBeGreaterThanOrEqual(0)
      const visited = new Uint8Array(transport.length)
      const queue = [first]
      visited[first] = 1
      let count = 0
      while (queue.length > 0) {
        const id = queue.pop()!
        count++
        const x = id % world.descriptor.width
        const y = Math.floor(id / world.descriptor.width)
        for (let direction = 0; direction < 8; direction++) {
          if ((transport[id]! & (1 << direction)) === 0) continue
          const [dx, dy] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]][direction]!
          const neighbor = (y + dy) * world.descriptor.width + x + dx
          if (!visited[neighbor]) {
            visited[neighbor] = 1
            queue.push(neighbor)
          }
        }
      }
      const roadCount = transport.reduce(
        (total, value) => total + (((value & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT) > 0 ? 1 : 0),
        0,
      )
      expect(count).toBe(roadCount)
    }
  }, 30_000)
})

describe('integrated city frontier growth', () => {
  it('is deterministic, capped, atomic, and refuses occupied land', () => {
    const staticWorld = testWorld(128)
    const world = createDynamicWorld(staticWorld)
    const first = planCityGrowth(world, 0, 7)
    expect(first.tiles.length).toBeGreaterThan(0)
    expect(first.tiles.length).toBeLessThanOrEqual(24)
    expect(planCityGrowth(world, 0, 7)).toEqual(first)

    const protectedTile = first.tiles[0]!.tileId
    world.beginBatch().addFacility(facility('protected', 'player', protectedTile)).commit()
    expect(() => applyCityGrowth(world, first)).toThrow(/protected tile/)
    expect(world.cityRuntime.get(0)?.growthEvents).toBe(0)
    world.beginBatch().removeFacility('protected').commit()

    const plan = planCityGrowth(world, 0, 7)
    const result = applyCityGrowth(world, plan)
    expect(result.committed).toBe(true)
    expect(world.cityRuntime.get(0)?.growthEvents).toBe(1)
    for (const changed of plan.tiles) {
      expect(world.getKind(changed.tileId)).not.toBe(TERRAIN_KIND.lake)
      expect(world.getOwner(changed.tileId)).toBe('neutral')
    }
  })
})
