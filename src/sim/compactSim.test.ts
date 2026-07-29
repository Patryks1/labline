import { describe, expect, it } from 'vitest'
import type { GameConfig } from './balance/gameConfig'
import { createGame } from './createGame'
import { canPlaceBuilding, labFacilityEnergyTotals, placeBuilding } from './systems/map'
import { tickDay, tickMany } from './tick'
import { staticWorldByteLength, type TileId } from './world'
import {
  compactCompletedFacilitiesForOwner,
  compactUnderConstructionFacilities,
} from './systems/worldAccess'

function largeConfig(seed = 5_601): GameConfig {
  return {
    labName: 'Large Lab',
    difficulty: 'normal',
    seed,
    mapWidth: 1_000,
    mapHeight: 1_000,
    cityCount: 12,
    rivalCount: 5,
    economyMult: 1,
    researchCostMult: 1,
    startingCashMult: 1,
    landValueBase: 2_500_000,
    landValueCityPeak: 28_000_000,
  }
}

describe('compact million-tile simulation', () => {
  it('uses layered generator V7 for small new sandboxes too', () => {
    const state = createGame({
      seed: 5_600,
      advanced: { mapWidth: 48, mapHeight: 48, cityCount: 2, rivalCount: 1 },
    })
    expect(state.map.storage).toBe('compact')
    expect(state.map.world?.descriptor.generatorVersion).toBe(7)
    expect(state.map.world?.staticWorld.elevation).toHaveLength(49 * 49)
    expect(state.map.world?.staticWorld.biome).toHaveLength(48 * 48)
    expect(state.map.world?.staticWorld.lakes.length).toBeGreaterThan(0)
    expect(state.map.world?.staticWorld.transport?.some((cell) => cell !== 0)).toBe(true)
  })

  it('keeps static terrain compact and rivals in the shared facility index', () => {
    const state = createGame({ config: largeConfig() })
    expect(state.map.storage).toBe('compact')
    expect(state.map.tiles).toHaveLength(0)
    expect(state.map.world).toBeTruthy()
    // V6/V7 both retain the district byte introduced by explicit zoning.
    expect(staticWorldByteLength(state.map.world!.staticWorld)).toBe(11_004_002)
    for (const rival of state.rivals) {
      expect(state.map.world!.queryFacilities({ ownerId: rival.id }).length).toBeGreaterThan(0)
    }
  })

  it('routes player construction through the same indexed mutation gateway', () => {
    const created = createGame({ config: largeConfig(5_602) })
    const state = {
      ...created,
      player: {
        ...created.player,
        cash: 300_000_000,
        finance: { ...created.player.finance, cash: 300_000_000 },
      },
    }
    const world = state.map.world!
    const pad = world.staticWorld.starterPads.find(
      (id) => world.getFacilityAt(id) === undefined && world.getKind(id) === 0,
    )!
    const x = pad % state.map.width
    const y = Math.floor(pad / state.map.width)
    const next = placeBuilding(state, x, y, 'dc')
    const facilities = next.map.world!.queryFacilities({ ownerId: 'player', kind: 'dc' })
    expect(facilities).toHaveLength(1)
    expect(next.map.world!.getFacilityAt(pad)?.id).toBe(facilities[0]!.id)
    expect(next.map.worldRevision).toBeGreaterThan(state.map.worldRevision ?? 0)
  })

  it('allows a fab shell to be placed before accelerator research', () => {
    const created = createGame({
      config: { ...largeConfig(5_612), mapWidth: 128, mapHeight: 128, cityCount: 2 },
    })
    const state = {
      ...created,
      player: {
        ...created.player,
        cash: 1_500_000_000,
        researchUnlocked: created.player.researchUnlocked.filter((id) => id !== 'si_arch'),
      },
    }
    const world = state.map.world!
    const pad = world.staticWorld.starterPads.find(
      (id) => world.getFacilityAt(id) === undefined && world.getKind(id) === 0,
    )!
    const x = pad % state.map.width
    const y = Math.floor(pad / state.map.width)

    expect(canPlaceBuilding(state, x, y, 'fab').ok).toBe(true)
    const next = placeBuilding(state, x, y, 'fab')
    expect(next.map.world!.queryFacilities({ ownerId: 'player', kind: 'fab' })).toHaveLength(1)
  })

  it('grows every settlement offscreen on the staggered v3 cadence', () => {
    const a = tickMany(createGame({ config: largeConfig(5_603) }), 365)
    const b = tickMany(createGame({ config: largeConfig(5_603) }), 365)
    const snapshotsA = [...a.map.world!.cityRuntime.values()]
    const snapshotsB = [...b.map.world!.cityRuntime.values()]
    expect(snapshotsA.every((runtime) => {
      const tier = a.map.world!.staticWorld.cities[runtime.cityIndex]?.tier
      return runtime.growthEvents === (tier === 'village' ? 1 : tier === 'town' ? 2 : 4)
    })).toBe(true)
    expect(snapshotsA.every((city) => city.lastGrowthDay >= 336 && city.lastGrowthDay <= 363)).toBe(true)
    expect(snapshotsA).toEqual(snapshotsB)
    expect(a.map.world!.toSnapshot().terrainOverrides).toEqual(
      b.map.world!.toSnapshot().terrainOverrides,
    )
  })

  it('invalidates commissioned-facility rollups exactly on world revision', () => {
    let state = createGame({
      config: { ...largeConfig(5_609), mapWidth: 128, mapHeight: 128, cityCount: 2 },
    })
    const world = state.map.world!
    const anchor = world.staticWorld.starterPads.find(
      (id) => world.getFacilityAt(id) === undefined && world.getKind(id) === 0,
    )!
    world.beginBatch().addFacility({
      id: 'cache-invalidation-site',
      kind: 'solar',
      ownerId: 'player',
      anchor,
      footprint: [anchor],
      level: 1,
      constructionProgress: 0,
      constructionTarget: 2,
      stats: { mwGeneration: 8 },
    }).commit()
    state = { ...state, map: { ...state.map, worldRevision: world.revision } }

    expect(compactUnderConstructionFacilities(state)?.some(
      (facility) => facility.id === 'cache-invalidation-site',
    )).toBe(true)
    expect(labFacilityEnergyTotals(state, state.playerLabId).mwGeneration).toBe(0)

    world.beginBatch().updateFacility('cache-invalidation-site', {
      constructionProgress: 2,
    }).commit()
    state = { ...state, map: { ...state.map, worldRevision: world.revision } }

    expect(compactCompletedFacilitiesForOwner(state, state.playerLabId)?.some(
      (facility) => facility.id === 'cache-invalidation-site',
    )).toBe(true)
    expect(compactUnderConstructionFacilities(state)?.some(
      (facility) => facility.id === 'cache-invalidation-site',
    )).toBe(false)
    expect(labFacilityEnergyTotals(state, state.playerLabId).mwGeneration).toBe(8)
  })

  it('ticks a developed 10,000-facility world without dense tile storage', () => {
    let state = createGame({ config: largeConfig(5_604) })
    const world = state.map.world!
    const batch = world.beginBatch()
    let added = 0
    for (let id = 0; id < world.staticWorld.kind.length && added < 10_000; id++) {
      if (world.staticWorld.kind[id] !== 0 || world.getFacilityAt(id as TileId)) continue
      const ownerId =
        added % 3 === 0 ? 'player' : state.rivals[added % state.rivals.length]!.id
      batch.addFacility({
        id: `developed-${added}`,
        kind: added % 7 === 0 ? 'solar' : 'dc',
        ownerId,
        anchor: id as TileId,
        footprint: [id as TileId],
        level: 1,
        constructionProgress: 1,
        constructionTarget: 1,
        powered: true,
        stats:
          added % 7 === 0
            ? { mwGeneration: 8, opexPerDay: 12_000 }
            : { rackCapacity: 96, racksUsed: 0, opexPerDay: 90_000 },
      })
      added++
    }
    batch.commit()
    state = { ...state, map: { ...state.map, worldRevision: world.revision } }
    const started = performance.now()
    const next = tickDay(state)
    const elapsed = performance.now() - started
    expect(next.map.tiles).toHaveLength(0)
    expect(next.map.world!.facilitiesById.size).toBeGreaterThanOrEqual(10_000)
    // Broad CI guard only; controlled-hardware gates use the perf harness.
    expect(elapsed).toBeLessThan(250)
  })
})
