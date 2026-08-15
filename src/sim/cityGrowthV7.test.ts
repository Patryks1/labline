import { describe, expect, it } from 'vitest'
import {
  TERRAIN_KIND,
  TERRAIN_VARIANT_RIVER,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_DIRECTION,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  applyCityGrowth,
  createDynamicWorld,
  encodeCityFeature,
  planCityGrowth,
  tileId,
  type StaticWorld,
} from './world'

const WIDTH = 10
const HEIGHT = 10

function fixture(version: 6 | 7 = 7, span: 1 | 2 = 1): StaticWorld {
  const kind = new Uint8Array(WIDTH * HEIGHT)
  const region = new Uint8Array(WIDTH * HEIGHT)
  const feature = new Uint16Array(WIDTH * HEIGHT)
  const variantMask = new Uint8Array(WIDTH * HEIGHT)
  const transport = new Uint16Array(WIDTH * HEIGHT)
  const center = tileId(2, 5, WIDTH, HEIGHT)
  kind[center] = TERRAIN_KIND.city
  feature[center] = encodeCityFeature(0)
  transport[tileId(3, 5, WIDTH, HEIGHT)] =
    (TRANSPORT_ROAD_CLASS.collector << TRANSPORT_CLASS_SHIFT) |
    TRANSPORT_FLAGS.settlement

  for (let x = 4; x < 4 + span; x++) {
    for (const y of [4, 5, 6]) {
      const id = tileId(x, y, WIDTH, HEIGHT)
      kind[id] = TERRAIN_KIND.lake
      variantMask[id] = TERRAIN_VARIANT_RIVER
    }
  }

  const descriptor = {
    formatVersion: 2 as const,
    generatorVersion: version,
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
    transportAlgorithmVersion: 2 as const,
    settlementAlgorithmVersion: 5 as const,
    municipalCampusAlgorithmVersion: 2 as const,
    cityStatsModelVersion: 1 as const,
    ...(version === 7 ? { riverAlgorithmVersion: 1 as const } : {}),
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
      index: 0, id: 'city_0', name: 'River City', cx: 2, cy: 5, radius: 2,
      population: 100_000, powerRadius: 4, powerBuyMw: 5, powerBuyPriceMult: 1,
      industry: 'mixed', talentWageMult: 1, tier: 'metro', regionIndex: 0,
      growth: { rate: 1, directionX: 1, directionY: 0, irregularity: 0.5 },
    }],
    regions: [{
      index: 0, id: 'region_0', name: 'Region 0', originX: 0, originY: 0,
      width: WIDTH, height: HEIGHT, energyPriceMult: 1, latencyToMarket: 0.2,
      regulationRisk: 0.1,
    }],
    lakes: [],
    starterPads: [],
    staticHash: `growth-river-v${version}-${span}`,
    coverage: { water: span * 3 / kind.length, urban: 1 / kind.length, forest: 0 },
  } as StaticWorld
}

describe('v7 river-aware settlement growth', () => {
  it.each([1, 2] as const)('plans and applies a deterministic %i-tile river bridge', (span) => {
    const world = createDynamicWorld(fixture(7, span))
    const plan = planCityGrowth(world, 0, 84)
    expect(planCityGrowth(world, 0, 84)).toEqual(plan)
    const bridges = plan.tiles.filter((tile) => tile.mode === 'bridge')
    expect(bridges).toHaveLength(span)
    expect(plan.tiles[span]?.mode).toBe('transport')

    applyCityGrowth(world, plan)
    for (const bridge of bridges) {
      expect(world.getKind(bridge.tileId)).toBe(TERRAIN_KIND.lake)
      expect(world.getTransport(bridge.tileId) & TRANSPORT_FLAGS.bridge).not.toBe(0)
    }
    const approach = tileId(3, 5, WIDTH, HEIGHT)
    const landing = tileId(4 + span, 5, WIDTH, HEIGHT)
    expect(world.getTransport(approach) & TRANSPORT_DIRECTION.east).not.toBe(0)
    expect(world.getTransport(landing) & TRANSPORT_DIRECTION.west).not.toBe(0)
    expect(world.getTransport(landing) & TRANSPORT_FLAGS.bridge).toBe(0)
  })

  it('does not bridge unmarked water or alter the v6 growth path', () => {
    const unmarked = fixture()
    unmarked.variantMask.fill(0)
    expect(planCityGrowth(createDynamicWorld(unmarked), 0, 84).tiles.some((tile) => tile.mode === 'bridge')).toBe(false)
    expect(planCityGrowth(createDynamicWorld(fixture(6)), 0, 84).tiles.some((tile) => tile.mode === 'bridge')).toBe(false)
  })

  it('rejects a crossing along the channel and a landing that would make a loop', () => {
    const alongChannel = fixture(7, 2)
    for (const y of [4, 6]) {
      for (const x of [4, 5]) {
        alongChannel.kind[tileId(x, y, WIDTH, HEIGHT)] = TERRAIN_KIND.empty
        alongChannel.variantMask[tileId(x, y, WIDTH, HEIGHT)] = 0
      }
    }
    expect(planCityGrowth(createDynamicWorld(alongChannel), 0, 84).tiles.some((tile) => tile.mode === 'bridge')).toBe(false)

    const loop = fixture()
    loop.transport![tileId(6, 5, WIDTH, HEIGHT)] =
      (TRANSPORT_ROAD_CLASS.local << TRANSPORT_CLASS_SHIFT) | TRANSPORT_FLAGS.settlement
    expect(planCityGrowth(createDynamicWorld(loop), 0, 84).tiles.some((tile) => tile.mode === 'bridge')).toBe(false)
  })

  it('rejects an adjacent duplicate bridge and excessive approach grade', () => {
    const duplicate = fixture()
    duplicate.transport![tileId(4, 4, WIDTH, HEIGHT)] =
      (TRANSPORT_ROAD_CLASS.local << TRANSPORT_CLASS_SHIFT) |
      TRANSPORT_FLAGS.settlement |
      TRANSPORT_FLAGS.bridge
    expect(planCityGrowth(createDynamicWorld(duplicate), 0, 84).tiles.some((tile) => tile.mode === 'bridge')).toBe(false)

    const steep = fixture()
    for (const [x, y] of [[4, 5], [5, 5], [4, 6], [5, 6]] as const) {
      steep.elevation![y * (WIDTH + 1) + x] = 100
    }
    expect(planCityGrowth(createDynamicWorld(steep), 0, 84).tiles.some((tile) => tile.mode === 'bridge')).toBe(false)
  })
})
