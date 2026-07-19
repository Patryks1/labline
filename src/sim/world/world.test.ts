import { describe, expect, it } from 'vitest'
import {
  TERRAIN_KIND,
  WorldChangeJournal,
  applyCityGrowth,
  beginWorldBatch,
  chunkIdForTile,
  createDynamicWorld,
  generateStaticWorldV2,
  planCityGrowth,
  staticWorldByteLength,
  tileCoords,
  tileId,
  type Facility,
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
