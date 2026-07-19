import { describe, expect, it } from 'vitest'
import { benchmarkSync, isHeavyPerfEnabled, measureMemory } from './perfHarness'
import {
  FIXTURE_TILE_KIND,
  WORLD_FIXTURE_SPECS,
  countFixtureKinds,
  createWorldFixture,
  estimateFixtureBaseLayerBytes,
  fixtureFingerprint,
  fixtureTileAt,
  forEachFixtureTileInBounds,
  type FixtureId,
} from './worldFixtures'

function assertFixtureExpectations(id: FixtureId) {
  const world = createWorldFixture(id)
  const counts = countFixtureKinds(world)
  const expected = world.spec.expected
  expect(world.kinds).toHaveLength(world.spec.width * world.spec.height)
  expect(world.regions).toHaveLength(world.kinds.length)
  expect(world.variants).toHaveLength(world.kinds.length)
  expect(world.owners).toHaveLength(world.kinds.length)
  expect(estimateFixtureBaseLayerBytes(world)).toBeLessThanOrEqual(expected.maxBaseLayerBytes)
  if (expected.minCityTiles != null) {
    expect(counts[FIXTURE_TILE_KIND.city]).toBeGreaterThanOrEqual(expected.minCityTiles)
  }
  if (expected.minLakeTiles != null) {
    expect(counts[FIXTURE_TILE_KIND.lake]).toBeGreaterThanOrEqual(expected.minLakeTiles)
  }
  if (expected.minFacilities != null) {
    expect(world.facilities.length).toBeGreaterThanOrEqual(expected.minFacilities)
  }
  return world
}

describe('deterministic world fixtures', () => {
  it('declares cheap 64/256 fixtures and opt-in 1000² fixtures', () => {
    expect(WORLD_FIXTURE_SPECS['baseline-64']).toMatchObject({ width: 64, height: 64, heavy: false })
    expect(WORLD_FIXTURE_SPECS['dense-metro-256']).toMatchObject({
      width: 256,
      height: 256,
      heavy: false,
    })
    expect(WORLD_FIXTURE_SPECS['large-lake-256']).toMatchObject({
      width: 256,
      height: 256,
      heavy: false,
    })
    expect(WORLD_FIXTURE_SPECS['mixed-1000']).toMatchObject({
      width: 1_000,
      height: 1_000,
      heavy: true,
    })
    expect(WORLD_FIXTURE_SPECS['developed-1000']).toMatchObject({
      width: 1_000,
      height: 1_000,
      heavy: true,
    })
  })

  it('generates the 64² baseline byte-for-byte deterministically', () => {
    const first = assertFixtureExpectations('baseline-64')
    const second = createWorldFixture('baseline-64')
    expect(fixtureFingerprint(first)).toBe(fixtureFingerprint(second))
    expect(first.kinds).toEqual(second.kinds)
    expect(first.facilities).toEqual(second.facilities)
  })

  it('covers the dense metro and contiguous-lake structural cases cheaply', () => {
    assertFixtureExpectations('dense-metro-256')
    assertFixtureExpectations('large-lake-256')
  })

  it('supports viewport-bound iteration without materializing tile objects', () => {
    const world = createWorldFixture('baseline-64')
    const visited: number[] = []
    forEachFixtureTileInBounds(world, { minX: 4, minY: 5, maxX: 11, maxY: 9 }, (tile) => {
      visited.push(tile.y * world.spec.width + tile.x)
    })
    expect(visited).toHaveLength(8 * 5)
    expect(fixtureTileAt(world, 4, 5)).toBeDefined()
    expect(fixtureTileAt(world, -1, 5)).toBeUndefined()
    expect(fixtureTileAt(world, 64, 5)).toBeUndefined()
  })
})

describe.runIf(isHeavyPerfEnabled())('opt-in million-tile fixtures', () => {
  for (const id of ['mixed-1000', 'developed-1000'] as const) {
    it(`${id} stays compact and satisfies its stress profile`, () => {
      const measured = measureMemory(() =>
        benchmarkSync(id, () => createWorldFixture(id), {
          warmupIterations: 0,
          iterations: 1,
        }),
      )
      const world = measured.value.value
      expect(measured.value.stats.max).toBeLessThan(10_000)
      expect(estimateFixtureBaseLayerBytes(world)).toBe(4_000_000)
      assertFixtureExpectations(id)
    })
  }
})
