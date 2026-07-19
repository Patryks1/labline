import { describe, expect, it } from 'vitest'
import type { GameConfig } from './balance/gameConfig'
import { createGame } from './createGame'
import { tickCityGrowth } from './systems/cityGrowth'
import {
  TERRAIN_KIND,
  createDynamicWorld,
  encodeCityFeature,
  planCityGrowth,
  tileId,
  type StaticCity,
  type StaticWorld,
} from './world'

const CONFIG: GameConfig = {
  labName: 'Growth Lab',
  difficulty: 'normal',
  seed: 7_707,
  mapWidth: 128,
  mapHeight: 128,
  cityCount: 8,
  rivalCount: 2,
  economyMult: 1,
  researchCostMult: 1,
  startingCashMult: 1,
  landValueBase: 2_500_000,
  landValueCityPeak: 28_000_000,
}

function overlappingCitiesWorld(base: StaticWorld): StaticWorld {
  const centers = [
    [31, 32],
    [16, 16],
    [112, 16],
    [16, 112],
    [112, 112],
    [64, 16],
    [64, 112],
    [33, 32],
  ] as const
  const kind = new Uint8Array(base.kind.length)
  const feature = new Uint16Array(base.feature.length)
  const region = new Uint8Array(base.region.length)
  const variantMask = new Uint8Array(base.variantMask.length)
  const cities: StaticCity[] = centers.map(([cx, cy], index) => {
    const source = base.cities[index]!
    const city = Object.freeze({
      ...source,
      index,
      id: `overlap_${index}`,
      name: `Overlap ${index}`,
      cx,
      cy,
      radius: 1,
      population: 100_000,
    })
    const anchor = tileId(cx, cy, base.descriptor.width, base.descriptor.height)
    kind[anchor] = TERRAIN_KIND.city
    feature[anchor] = encodeCityFeature(index)
    return city
  })
  return {
    ...base,
    kind,
    feature,
    region,
    variantMask,
    cities: Object.freeze(cities),
    lakes: Object.freeze([]),
    starterPads: Object.freeze([]),
    staticHash: 'overlapping-growth-test',
    coverage: Object.freeze({ water: 0, urban: cities.length / kind.length, forest: 0 }),
  }
}

describe('atomic city growth reservations', () => {
  it('claims an overlapping frontier tile once and accounts population from committed claims', () => {
    const initial = createGame({ config: CONFIG })
    const staticWorld = overlappingCitiesWorld(initial.map.world!.staticWorld)
    const world = createDynamicWorld(staticWorld)
    const cities = staticWorld.cities.map((city, index) => ({
      ...initial.map.cities![index]!,
      id: city.id,
      name: city.name,
      cx: city.cx,
      cy: city.cy,
      radius: city.radius,
      population: city.population,
    }))
    const state = {
      ...initial,
      day: 7,
      map: { ...initial.map, world, worldRevision: world.revision, cities },
    }

    const first = planCityGrowth(world, 0, state.day)
    const second = planCityGrowth(world, 7, state.day)
    const rawOverlap = first.tiles.filter((tile) =>
      second.tiles.some((candidate) => candidate.tileId === tile.tileId),
    )
    expect(rawOverlap).toHaveLength(1)

    const next = tickCityGrowth(state)
    const claims = [...world.terrainOverrides.values()].filter(
      (override) =>
        override.feature === encodeCityFeature(0) ||
        override.feature === encodeCityFeature(7),
    )
    expect(claims).toHaveLength(first.tiles.length + second.tiles.length - rawOverlap.length)
    expect(new Set(claims.map((claim) => claim.tileId)).size).toBe(claims.length)

    const runtime0 = world.cityRuntime.get(0)!
    const runtime7 = world.cityRuntime.get(7)!
    const populationDelta =
      runtime0.population - staticWorld.cities[0]!.population +
      runtime7.population - staticWorld.cities[7]!.population
    expect(populationDelta).toBe(claims.length * 1_350)
    expect(runtime0.growthEvents).toBe(1)
    expect(runtime7.growthEvents).toBe(1)
    expect(next.map.cities![0]!.population).toBe(runtime0.population)
    expect(next.map.cities![7]!.population).toBe(runtime7.population)
    expect(next.map.worldRevision).toBe(world.revision)
  })
})
