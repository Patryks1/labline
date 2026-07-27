import { describe, expect, it } from 'vitest'
import {
  BIOME_KIND,
  TERRAIN_KIND,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_DIRECTION,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  applyCityGrowth,
  createDynamicWorld,
  encodeCityFeature,
  planCityGrowth,
  tileCoords,
  tileId,
  type StaticWorld,
  type WorldDescriptor,
} from './world'

const WIDTH = 12
const HEIGHT = 12

function fixture(version: 3 | 4 | 5 = 4): StaticWorld {
  const kind = new Uint8Array(WIDTH * HEIGHT)
  const region = new Uint8Array(WIDTH * HEIGHT)
  const feature = new Uint16Array(WIDTH * HEIGHT)
  const variantMask = new Uint8Array(WIDTH * HEIGHT)
  const transport = new Uint16Array(WIDTH * HEIGHT)
  const center = tileId(5, 5, WIDTH, HEIGHT)
  const road = tileId(5, 6, WIDTH, HEIGHT)
  kind[center] = TERRAIN_KIND.city
  feature[center] = encodeCityFeature(0)
  transport[road] =
    (TRANSPORT_ROAD_CLASS.collector << TRANSPORT_CLASS_SHIFT) |
    TRANSPORT_FLAGS.settlement

  const reliefDescriptor = {
    formatVersion: 2 as const,
    seed: 37,
    width: WIDTH,
    height: HEIGHT,
    chunkSize: 8,
    cityCount: 1,
    landValueBase: 2_500_000,
    landValueCityPeak: 28_000_000,
    energyPricePerMWh: 80,
    waterCoverage: 0,
    elevationScale: 0.01,
    seaLevel: 0,
    terrainAlgorithmVersion: 1 as const,
    biomeVersion: 1 as const,
  }
  const descriptor: WorldDescriptor = version === 5
    ? { ...reliefDescriptor, generatorVersion: 5, transportAlgorithmVersion: 2 }
    : version === 4
    ? {
        ...reliefDescriptor,
        generatorVersion: 4,
      }
    : {
        formatVersion: 2,
        generatorVersion: 3,
        seed: 37,
        width: WIDTH,
        height: HEIGHT,
        chunkSize: 8,
        cityCount: 1,
        landValueBase: 2_500_000,
        landValueCityPeak: 28_000_000,
        energyPricePerMWh: 80,
        waterCoverage: 0,
      }

  return {
    descriptor,
    kind,
    region,
    feature,
    variantMask,
    transport,
    elevation: new Int16Array((WIDTH + 1) * (HEIGHT + 1)),
    biome: new Uint8Array(WIDTH * HEIGHT),
    cities: [{
      index: 0,
      id: 'settlement_0',
      name: 'Settlement 0',
      cx: 5,
      cy: 5,
      radius: 2,
      population: 100_000,
      powerRadius: 4,
      powerBuyMw: 5,
      powerBuyPriceMult: 1,
      industry: 'mixed',
      talentWageMult: 1,
      tier: 'metro',
      regionIndex: 0,
      growth: { rate: 1, directionX: 1, directionY: 0, irregularity: 0.5 },
    }],
    regions: [{
      index: 0,
      id: 'region_0',
      name: 'Region 0',
      originX: 0,
      originY: 0,
      width: WIDTH,
      height: HEIGHT,
      energyPriceMult: 1,
      latencyToMarket: 0.2,
      regulationRisk: 0.1,
    }],
    lakes: [],
    starterPads: [],
    staticHash: `growth-v${version}`,
    coverage: { water: 0, urban: 1 / kind.length, forest: 0 },
  }
}

function setTileSteep(world: StaticWorld, x: number, y: number): void {
  const elevation = world.elevation!
  elevation[y * (WIDTH + 1) + x] = 25
}

describe('v4 terrain-aware settlement growth', () => {
  it('excludes steep frontier and avoids dense alpine or wetland growth', () => {
    const staticWorld = fixture()
    setTileSteep(staticWorld, 5, 7)
    staticWorld.biome![tileId(4, 6, WIDTH, HEIGHT)] = BIOME_KIND.alpine
    staticWorld.biome![tileId(6, 6, WIDTH, HEIGHT)] = BIOME_KIND.wetland
    const world = createDynamicWorld(staticWorld)

    const plan = planCityGrowth(world, 0, 84)
    const steep = tileId(5, 7, WIDTH, HEIGHT)
    expect(plan.tiles.some((tile) => tile.tileId === steep)).toBe(false)
    for (const tile of plan.tiles) {
      const biome = world.getBiome(tileCoords(tile.tileId, WIDTH).x, tileCoords(tile.tileId, WIDTH).y)
      if (biome === BIOME_KIND.alpine || biome === BIOME_KIND.wetland) {
        expect(tile.kind).not.toBe(TERRAIN_KIND.city)
        expect(tile.kind).not.toBe(TERRAIN_KIND.warehouse)
      }
    }
  })

  it('expands across gentle plains and commits reciprocal local-road topology', () => {
    const world = createDynamicWorld(fixture())
    const plan = planCityGrowth(world, 0, 84)
    expect(plan.tiles.length).toBeGreaterThan(1)
    expect(plan.tiles[0]?.mode).toBe('transport')

    const road = plan.tiles[0]!
    const existing = tileId(5, 6, WIDTH, HEIGHT)
    applyCityGrowth(world, plan)
    const roadPosition = tileCoords(road.tileId, WIDTH)
    const existingPosition = tileCoords(existing, WIDTH)
    const roadBit = roadPosition.x < existingPosition.x
      ? TRANSPORT_DIRECTION.east
      : roadPosition.x > existingPosition.x
        ? TRANSPORT_DIRECTION.west
        : roadPosition.y < existingPosition.y
          ? TRANSPORT_DIRECTION.south
          : TRANSPORT_DIRECTION.north
    const reciprocal = roadBit === TRANSPORT_DIRECTION.east
      ? TRANSPORT_DIRECTION.west
      : roadBit === TRANSPORT_DIRECTION.west
        ? TRANSPORT_DIRECTION.east
        : roadBit === TRANSPORT_DIRECTION.south
          ? TRANSPORT_DIRECTION.north
          : TRANSPORT_DIRECTION.south
    expect(world.getTransport(road.tileId) & roadBit).not.toBe(0)
    expect(world.getTransport(existing) & reciprocal).not.toBe(0)
  })

  it('clears a forest kit when V5 growth claims its tile for a road corridor', () => {
    const staticWorld = fixture(5)
    const world = createDynamicWorld(staticWorld)
    const plan = planCityGrowth(world, 0, 84)
    const road = plan.tiles.find((tile) => tile.mode === 'transport')!
    staticWorld.kind[road.tileId] = TERRAIN_KIND.forest

    applyCityGrowth(world, plan)

    expect(world.getKind(road.tileId)).toBe(TERRAIN_KIND.empty)
    expect(world.getTransport(road.tileId) >> TRANSPORT_CLASS_SHIFT & 0x07)
      .toBe(TRANSPORT_ROAD_CLASS.local)
  })

  it('does not add a local transport edge above the 18% grade limit', () => {
    const staticWorld = fixture()
    // Leave the western candidate flat, raise the opposite edge of the
    // existing road so their tile-centre grade is 20%, and make the two other
    // road candidates locally too steep. There is then no valid extension.
    staticWorld.elevation![6 * (WIDTH + 1) + 6] = 40
    staticWorld.elevation![7 * (WIDTH + 1) + 6] = 40
    setTileSteep(staticWorld, 6, 6)
    setTileSteep(staticWorld, 5, 7)
    const world = createDynamicWorld(staticWorld)

    const plan = planCityGrowth(world, 0, 84)
    expect(plan.tiles.some((tile) => tile.mode === 'transport')).toBe(false)
  })

  it('produces deterministic plans without mutating immutable terrain layers', () => {
    const staticWorld = fixture()
    const elevationBefore = staticWorld.elevation!.slice()
    const biomeBefore = staticWorld.biome!.slice()
    const world = createDynamicWorld(staticWorld)
    const first = planCityGrowth(world, 0, 84)

    expect(planCityGrowth(world, 0, 84)).toEqual(first)
    expect(staticWorld.elevation).toEqual(elevationBefore)
    expect(staticWorld.biome).toEqual(biomeBefore)
  })

  it('keeps the v3 planner byte-for-byte independent of terrain annotations', () => {
    const plain = fixture(3)
    const annotated = fixture(3)
    setTileSteep(annotated, 5, 7)
    annotated.biome!.fill(BIOME_KIND.alpine)

    expect(planCityGrowth(createDynamicWorld(annotated), 0, 84)).toEqual(
      planCityGrowth(createDynamicWorld(plain), 0, 84),
    )
  })
})
