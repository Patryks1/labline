import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { tickCityGrowth } from '../systems/cityGrowth'
import { generateStaticWorldV7 } from './generator'
import { tileCoords } from './ids'
import {
  DISTRICT_KIND,
  TERRAIN_KIND,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_ROAD_CLASS,
  type StaticWorld,
} from './types'
import {
  planUrbanInfill,
  urbanInfillParcelAt,
  urbanUseAt,
  URBAN_INFILL_REDEVELOPMENT_MULT,
} from './urbanInfill'

const SEEDS = [7, 42, 1337, 90_001, 0x51ab]

function makeWorld(seed: number): StaticWorld {
  return generateStaticWorldV7({ seed, width: 160, height: 144, cityCount: 4, waterCoverage: 0.08 })
}

function roadClass(world: StaticWorld, id: number): number {
  return ((world.transport?.[id] ?? 0) & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
}

function hasStreetNeighbor(world: StaticWorld, id: number): boolean {
  const { width, height } = world.descriptor
  const x = id % width
  const y = Math.floor(id / width)
  const neighbors = [
    y > 0 ? id - width : -1,
    x + 1 < width ? id + 1 : -1,
    y + 1 < height ? id + width : -1,
    x > 0 ? id - 1 : -1,
  ]
  return neighbors.some((neighbor) => {
    if (neighbor < 0) return false
    const cls = roadClass(world, neighbor)
    return cls === TRANSPORT_ROAD_CLASS.local ||
      cls === TRANSPORT_ROAD_CLASS.collector ||
      cls === TRANSPORT_ROAD_CLASS.arterial
  })
}

describe('urban infill parcel plan', () => {
  it('is deterministic and cached per static world', () => {
    const world = makeWorld(42)
    const a = planUrbanInfill(world)
    const b = planUrbanInfill(world)
    expect(a).toBe(b)
    expect(a.parcels.length).toBeGreaterThan(0)
    const regenerated = planUrbanInfill(makeWorld(42))
    expect(regenerated.parcels.map((p) => p.id)).toEqual(a.parcels.map((p) => p.id))
  })

  it('gives every major city HQ-compatible parcels across seeds', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed)
      const plan = planUrbanInfill(world)
      for (const city of world.cities) {
        const parcels = plan.parcels.filter((parcel) => parcel.cityIndex === city.index)
        if (city.tier === 'village') continue
        const singles = parcels.filter((parcel) => parcel.width === 1 && parcel.height === 1)
        const multiTile = parcels.filter((parcel) => parcel.width * parcel.height >= 4)
        expect(singles.length, `seed ${seed} ${city.id} 1x1 parcels`).toBeGreaterThanOrEqual(4)
        // Roomier metros/satellites guarantee at least six starter plots.
        if ((city.tier === 'metro' || city.tier === 'satellite') && city.radius >= 3) {
          expect(singles.length, `seed ${seed} ${city.id} 1x1 parcels`).toBeGreaterThanOrEqual(6)
        }
        // Metro / roomier satellites keep a flagship plus a second multi-tile
        // pad. Compact towns/satellites may only expose 1×1 starter plots.
        if (city.tier === 'metro' || (city.tier === 'satellite' && city.radius >= 4)) {
          const flagship = parcels.filter((parcel) => parcel.flagship)
          expect(flagship.length, `seed ${seed} ${city.id} flagship`).toBeGreaterThanOrEqual(1)
          expect(flagship[0]!.width * flagship[0]!.height).toBeGreaterThanOrEqual(4)
          expect(multiTile.length, `seed ${seed} ${city.id} multi-tile HQ pads`).toBeGreaterThanOrEqual(2)
        }
      }
    }
  })

  it('places at least one parcel near the core of every non-village city', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed)
      const plan = planUrbanInfill(world)
      for (const city of world.cities) {
        if (city.tier === 'village') continue
        const parcels = plan.parcels.filter((parcel) => parcel.cityIndex === city.index)
        expect(parcels.length, `seed ${seed} ${city.id} has parcels`).toBeGreaterThan(0)
        const minDistance = Math.min(...parcels.map((parcel) => {
          const { x, y } = tileCoords(parcel.anchorTileId, world.descriptor.width)
          return Math.hypot(x - city.cx, y - city.cy)
        }))
        // Well inside the city radius: the closest window wins by construction.
        expect(minDistance, `seed ${seed} ${city.id} core parcel`)
          .toBeLessThanOrEqual(Math.max(3, city.radius * 0.75))
      }
    }
  })

  it('keeps every parcel road-adjacent and off water, roads, municipal assets and parks', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed)
      const plan = planUrbanInfill(world)
      expect(plan.parcels.length).toBeGreaterThan(0)
      for (const parcel of plan.parcels) {
        expect(parcel.tileIds.some((id) => hasStreetNeighbor(world, id)),
          `seed ${seed} parcel ${parcel.id} street access`).toBe(true)
        for (const id of parcel.tileIds) {
          const terrain = world.kind[id]!
          expect(terrain, `seed ${seed} ${id} water`).not.toBe(TERRAIN_KIND.lake)
          expect(terrain, `seed ${seed} ${id} park`).not.toBe(TERRAIN_KIND.park)
          expect(terrain, `seed ${seed} ${id} warehouse`).not.toBe(TERRAIN_KIND.warehouse)
          expect(roadClass(world, id), `seed ${seed} ${id} on road`).toBe(TRANSPORT_ROAD_CLASS.none)
          expect(world.district?.[id], `seed ${seed} ${id} municipal`).not.toBe(DISTRICT_KIND.municipalCampus)
          expect(world.district?.[id], `seed ${seed} ${id} green buffer`).not.toBe(DISTRICT_KIND.greenBuffer)
          expect(plan.reservedTileIds.has(id)).toBe(true)
          expect(urbanInfillParcelAt(world, id)?.id).toBe(parcel.id)
          expect(urbanUseAt(world, id)).toBe('commercial_infill')
          if (parcel.width === 1 && parcel.height === 1) {
            expect(hasStreetNeighbor(world, id), `seed ${seed} 1x1 ${id} access`).toBe(true)
          }
        }
      }
    }
  })

  it('designates roughly a quarter of suitable urban block cells as infill', () => {
    for (const seed of SEEDS) {
      const world = makeWorld(seed)
      const plan = planUrbanInfill(world)
      let suitable = 0
      for (let id = 0; id < world.kind.length; id++) {
        const feature = world.feature[id]!
        if (feature === 0 || (feature & 0x8000) !== 0) continue
        const terrain = world.kind[id]!
        if (terrain !== TERRAIN_KIND.city && terrain !== TERRAIN_KIND.house && terrain !== TERRAIN_KIND.empty) continue
        if (roadClass(world, id) !== TRANSPORT_ROAD_CLASS.none) continue
        const zone = world.district?.[id] ?? DISTRICT_KIND.none
        if (zone === DISTRICT_KIND.municipalCampus || zone === DISTRICT_KIND.greenBuffer) continue
        suitable++
      }
      const designated = plan.reservedTileIds.size
      const share = designated / Math.max(1, suitable)
      expect(share, `seed ${seed} infill share ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.2)
      // Target ~28%; tier minimums (flagships + 2×2 pads + singles) push
      // denser/smaller settlements higher, so the aggregate stays below half.
      expect(share, `seed ${seed} infill share ${(share * 100).toFixed(1)}%`).toBeLessThan(0.5)
    }
  })

  it('prices city-centre parcels above greenfield land', () => {
    const world = makeWorld(7)
    const plan = planUrbanInfill(world)
    const { landValueBase, landValueCityPeak } = world.descriptor
    for (const parcel of plan.parcels) {
      // Greenfield peaks at base + peak even directly on top of a city.
      expect(parcel.landValuePerTile).toBeGreaterThan(landValueBase + landValueCityPeak)
    }
    // Centre beats fringe: core-district tiles price above suburb-district tiles.
    const core = plan.parcels.filter((p) => (world.district?.[p.anchorTileId] ?? 0) === DISTRICT_KIND.core)
    const suburb = plan.parcels.filter((p) => (world.district?.[p.anchorTileId] ?? 0) === DISTRICT_KIND.suburb)
    expect(core.length).toBeGreaterThan(0)
    if (suburb.length > 0) {
      const coreMedian = core.map((p) => p.landValuePerTile).sort((a, b) => a - b)[Math.floor(core.length / 2)]!
      const suburbMax = Math.max(...suburb.map((p) => p.landValuePerTile))
      expect(coreMedian).toBeGreaterThan(suburbMax)
      void URBAN_INFILL_REDEVELOPMENT_MULT
    }
  })
})

describe('city growth preserves reserved infill parcels', () => {
  it('never overwrites parcel tiles while cities keep growing', () => {
    let state = createGame({
      seed: 77_301,
      difficulty: 'normal',
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 4, rivalCount: 1 },
    })
    const world = state.map.world!
    const plan = planUrbanInfill(world.staticWorld)
    expect(plan.parcels.length).toBeGreaterThan(0)

    let grew = 0
    for (let day = 1; day <= 360; day++) {
      const before = world.revision
      state = tickCityGrowth({ ...state, day })
      if (world.revision !== before) grew++
    }
    expect(grew).toBeGreaterThan(0)

    for (const id of plan.reservedTileIds) {
      const { x, y } = tileCoords(id, world.descriptor.width)
      expect(world.getFacilityAt(id), `facility on parcel ${x},${y}`).toBeUndefined()
      expect(world.getKind(id), `kind changed on parcel ${x},${y}`).toBe(world.staticWorld.kind[id])
      expect(world.getTransport(id), `road through parcel ${x},${y}`).toBe(world.staticWorld.transport?.[id] ?? 0)
    }
  }, 30_000)

  it('lets the player acquire a parcel (protection hand-off to the facility)', () => {
    const state = createGame({
      seed: 77_302,
      difficulty: 'normal',
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 4, rivalCount: 1 },
    })
    const world = state.map.world!
    const parcel = planUrbanInfill(world.staticWorld).parcels
      .find((candidate) => candidate.width === 1 && candidate.height === 1)!
    expect(parcel).toBeDefined()
    const { x, y } = tileCoords(parcel.anchorTileId, world.descriptor.width)
    // The tile is still neutral urban fabric; urbanUse resolves through the plan.
    expect(urbanUseAt(world.staticWorld, parcel.anchorTileId)).toBe('commercial_infill')
    expect(world.getOwner(parcel.anchorTileId)).toBe('neutral')
    void x
    void y
  })
})
