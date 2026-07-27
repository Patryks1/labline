import { describe, expect, it } from 'vitest'
import type { GameConfig } from './balance/gameConfig'
import { createGame } from './createGame'
import { tickCityGrowth } from './systems/cityGrowth'
import { compactTileAt } from './systems/worldAccess'
import {
  TERRAIN_KIND,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_FLAGS,
  TRANSPORT_ROAD_CLASS,
  applyCityGrowth,
  cityGrowthInterval,
  createDynamicWorld,
  encodeCityFeature,
  generateStaticWorldV3,
  planCityGrowth,
  tileCoords,
  tileId,
  type CityTier,
  type Facility,
  type StaticWorld,
  type TileId,
} from './world'

const CONFIG: GameConfig = {
  labName: 'V3 Growth Lab',
  difficulty: 'normal',
  seed: 37,
  mapWidth: 128,
  mapHeight: 128,
  cityCount: 8,
  rivalCount: 0,
  economyMult: 1,
  researchCostMult: 1,
  startingCashMult: 1,
  landValueBase: 2_500_000,
  landValueCityPeak: 28_000_000,
}

function fixture(tier: CityTier = 'metro', withTransport = true): StaticWorld {
  const width = 12
  const height = 12
  const kind = new Uint8Array(width * height)
  const region = new Uint8Array(width * height)
  const feature = new Uint16Array(width * height)
  const variantMask = new Uint8Array(width * height)
  const transport = new Uint16Array(width * height)
  const center = tileId(5, 5, width, height)
  const existingRoad = tileId(5, 6, width, height)
  kind[center] = TERRAIN_KIND.city
  feature[center] = encodeCityFeature(0)
  if (withTransport) {
    transport[existingRoad] =
      (TRANSPORT_ROAD_CLASS.collector << TRANSPORT_CLASS_SHIFT) |
      TRANSPORT_FLAGS.settlement
  }
  // Nearby water must never become an ordinary growth parcel.
  kind[tileId(6, 5, width, height)] = TERRAIN_KIND.lake
  return {
    descriptor: {
      formatVersion: 2,
      generatorVersion: 3,
      seed: 37,
      width,
      height,
      chunkSize: 8,
      cityCount: 1,
      landValueBase: CONFIG.landValueBase,
      landValueCityPeak: CONFIG.landValueCityPeak,
      energyPricePerMWh: 80,
      waterCoverage: 0,
    },
    kind,
    region,
    feature,
    variantMask,
    transport,
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
      tier,
      regionIndex: 0,
      growth: { rate: tier === 'metro' ? 1 : 0.34, directionX: 1, directionY: 0, irregularity: 0.5 },
    }],
    regions: [{
      index: 0,
      id: 'region_0',
      name: 'Region 0',
      originX: 0,
      originY: 0,
      width,
      height,
      energyPriceMult: 1,
      latencyToMarket: 0.2,
      regulationRisk: 0.1,
    }],
    lakes: [],
    starterPads: [],
    staticHash: `v3-growth-${tier}-${withTransport}`,
    coverage: { water: 1 / kind.length, urban: 1 / kind.length, forest: 0 },
  }
}

function protectedFacility(anchor: TileId): Facility {
  return {
    id: 'protected',
    kind: 'hq',
    ownerId: 'player',
    anchor,
    footprint: [anchor],
    level: 1,
    constructionProgress: 1,
    constructionTarget: 1,
  }
}

describe('v3 settlement projects', () => {
  it('produces a connected project on a generated v3 settlement', () => {
    const world = createDynamicWorld(generateStaticWorldV3({
      seed: 911,
      width: 128,
      height: 128,
      cityCount: 3,
    }))
    const plan = planCityGrowth(world, 0, cityGrowthInterval(world, 0))
    expect(plan.tiles.length).toBeGreaterThan(0)
    expect(plan.tiles[0]?.mode).toBe('transport')
    expect(plan.tiles.every((tile) => world.getFacilityAt(tile.tileId) === undefined)).toBe(true)
  })

  it('is deterministic, transport-led, capped, and keeps road terrain independent', () => {
    const world = createDynamicWorld(fixture())
    const first = planCityGrowth(world, 0, 84)
    expect(planCityGrowth(world, 0, 84)).toEqual(first)
    expect(first.tiles.length).toBeGreaterThan(0)
    expect(first.tiles.length).toBeLessThanOrEqual(24)
    expect(first.tiles[0]?.mode).toBe('transport')

    const road = first.tiles[0]!
    const underlyingKind = world.getKind(road.tileId)
    expect(underlyingKind).not.toBe(TERRAIN_KIND.road)
    applyCityGrowth(world, first)
    expect(world.getKind(road.tileId)).toBe(underlyingKind)
    expect(world.getTransport(road.tileId) & TRANSPORT_CLASS_MASK).toBe(
      TRANSPORT_ROAD_CLASS.local << TRANSPORT_CLASS_SHIFT,
    )
    expect(world.getTransport(road.tileId) & TRANSPORT_FLAGS.settlement).not.toBe(0)

    for (const parcel of first.tiles.filter((tile) => tile.mode === 'parcel')) {
      const neighbors = [
        tileId(Math.max(0, tileCoords(parcel.tileId, 12).x - 1), tileCoords(parcel.tileId, 12).y, 12, 12),
        tileId(Math.min(11, tileCoords(parcel.tileId, 12).x + 1), tileCoords(parcel.tileId, 12).y, 12, 12),
        tileId(tileCoords(parcel.tileId, 12).x, Math.max(0, tileCoords(parcel.tileId, 12).y - 1), 12, 12),
        tileId(tileCoords(parcel.tileId, 12).x, Math.min(11, tileCoords(parcel.tileId, 12).y + 1), 12, 12),
      ]
      expect(neighbors.some((id) => world.getTransport(id) !== 0)).toBe(true)
    }
  })

  it('refuses facilities, owned/reserved cells, and water', () => {
    const world = createDynamicWorld(fixture())
    const initial = planCityGrowth(world, 0, 84)
    const facilityTile = initial.tiles[0]!.tileId
    const ownedTile = initial.tiles[1]?.tileId
    world.beginBatch()
      .addFacility(protectedFacility(facilityTile))
      .setTerrain(ownedTile === undefined
        ? { tileId: tileId(4, 5, 12, 12), ownerId: 'player' }
        : { tileId: ownedTile, ownerId: 'player' })
      .commit()
    const reserved = new Set<TileId>([tileId(4, 6, 12, 12)])
    const plan = planCityGrowth(world, 0, 84, { reserved })
    expect(plan.tiles.some((tile) => tile.tileId === facilityTile)).toBe(false)
    if (ownedTile !== undefined) expect(plan.tiles.some((tile) => tile.tileId === ownedTile)).toBe(false)
    expect(plan.tiles.some((tile) => reserved.has(tile.tileId))).toBe(false)
    expect(plan.tiles.some((tile) => world.getKind(tile.tileId) === TERRAIN_KIND.lake)).toBe(false)
  })

  it('uses tier cadence and keeps population growth in the intended annual range', () => {
    expect(cityGrowthInterval(createDynamicWorld(fixture('metro')), 0)).toBe(84)
    expect(cityGrowthInterval(createDynamicWorld(fixture('satellite')), 0)).toBe(84)
    expect(cityGrowthInterval(createDynamicWorld(fixture('town')), 0)).toBe(168)
    expect(cityGrowthInterval(createDynamicWorld(fixture('village')), 0)).toBe(336)

    const world = createDynamicWorld(fixture('metro'))
    const plan = planCityGrowth(world, 0, 84)
    const annualized = plan.populationDelta / 100_000 * 365 / 84
    expect(annualized).toBeGreaterThanOrEqual(0.005)
    expect(annualized).toBeLessThanOrEqual(0.025)

    const base = createGame({ config: CONFIG })
    const mapCity = { ...base.map.cities![0]!, ...world.staticWorld.cities[0] }
    const state = {
      ...base,
      map: { ...base.map, width: 12, height: 12, world, worldRevision: world.revision, cities: [mapCity] },
    }
    expect(tickCityGrowth({ ...state, day: 83 }).map.worldRevision).toBe(world.revision)
    expect(world.cityRuntime.get(0)?.growthEvents).toBe(0)
    tickCityGrowth({ ...state, day: 84 })
    expect(world.cityRuntime.get(0)?.growthEvents).toBe(1)
  })
})

describe('v3 land economics', () => {
  it('adds a transport premium without changing v2 valuation paths', () => {
    const base = createGame({ config: CONFIG })
    const connectedWorld = createDynamicWorld(fixture('metro', true))
    const disconnectedWorld = createDynamicWorld(fixture('metro', false))
    const x = 4
    const y = 6
    const connected = compactTileAt({
      config: base.config,
      map: { ...base.map, width: 12, height: 12, world: connectedWorld, storage: 'compact' },
    }, x, y)!
    const disconnected = compactTileAt({
      config: base.config,
      map: { ...base.map, width: 12, height: 12, world: disconnectedWorld, storage: 'compact' },
    }, x, y)!
    expect(connected.kind).toBe('empty')
    expect(connected.landValue).toBeGreaterThan(disconnected.landValue)
    const road = compactTileAt({
      config: base.config,
      map: { ...base.map, width: 12, height: 12, world: connectedWorld, storage: 'compact' },
    }, 5, 6)!
    expect(road.kind).toBe('road')
    expect(road.landValue).toBe(0)
  })
})
