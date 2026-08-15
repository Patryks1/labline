import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { tileCoords, tileId } from '../world/ids'
import {
  planUrbanInfill,
  urbanUseAt,
  URBAN_INFILL_REDEVELOPMENT_MULT,
} from '../world/urbanInfill'
import { canPlaceBuilding, isUrbanInfillCompatible } from './map'
import { mapTileAtAny, usesCompactWorld } from './worldAccess'
import type { BuildableKind, SimState } from '../types'

function game(): SimState {
  const state = createGame({
    seed: 88_401,
    difficulty: 'easy',
    advanced: { mapWidth: 128, mapHeight: 128, cityCount: 4, rivalCount: 0 },
  })
  // Placement zoning checks still require cash for build+land totals.
  return {
    ...state,
    player: { ...state.player, cash: Math.max(state.player.cash, 2_000_000_000) },
  }
}

function findInfillTile(
  state: SimState,
  predicate: (width: number, height: number) => boolean = () => true,
): { x: number; y: number; landValuePerTile: number } {
  const world = state.map.world!
  const parcel = planUrbanInfill(world.staticWorld).parcels.find((p) =>
    predicate(p.width, p.height),
  )
  expect(parcel, 'expected a commercial_infill parcel').toBeDefined()
  const { x, y } = tileCoords(parcel!.anchorTileId, world.descriptor.width)
  return { x, y, landValuePerTile: parcel!.landValuePerTile }
}

function findGreenfieldEmpty(state: SimState): { x: number; y: number } {
  const world = state.map.world!
  const width = world.descriptor.width
  const reserved = planUrbanInfill(world.staticWorld).reservedTileIds
  const candidates = [
    ...world.staticWorld.starterPads,
  ]
  // Sample a sparse grid so we don't scan the whole map with placement checks.
  for (let y = 2; y < world.descriptor.height - 2; y += 3) {
    for (let x = 2; x < width - 2; x += 3) {
      candidates.push(tileId(x, y, width, world.descriptor.height))
    }
  }
  for (const id of candidates) {
    if (reserved.has(id)) continue
    if (urbanUseAt(world.staticWorld, id) === 'commercial_infill') continue
    const { x, y } = tileCoords(id, width)
    const tile = mapTileAtAny(state, x, y)
    if (tile?.kind !== 'empty' || tile.owner !== 'neutral' || tile.regionId === 'void') continue
    if (canPlaceBuilding(state, x, y, 'dc').ok) return { x, y }
  }
  throw new Error('No greenfield empty tile')
}

describe('urban infill placement zoning', () => {
  it('classifies HQ / office / lab as urban-compatible and industrial as not', () => {
    const allowed: BuildableKind[] = ['hq', 'hq_m', 'hq_l', 'office', 'lab']
    const blocked: BuildableKind[] = [
      'dc',
      'dc_m',
      'dc_l',
      'fab',
      'gas',
      'nuclear',
      'solar',
      'cooling',
      'substation',
      'battery',
    ]
    for (const kind of allowed) expect(isUrbanInfillCompatible(kind)).toBe(true)
    for (const kind of blocked) expect(isUrbanInfillCompatible(kind)).toBe(false)
  })

  it('allows small HQ on commercial_infill and blocks data centres / industrial plant', () => {
    const state = game()
    expect(usesCompactWorld(state)).toBe(true)
    const { x, y } = findInfillTile(state, (w, h) => w === 1 && h === 1)
    const world = state.map.world!
    const id = tileId(x, y, world.descriptor.width, world.descriptor.height)
    expect(urbanUseAt(world.staticWorld, id)).toBe('commercial_infill')

    const hq = canPlaceBuilding(state, x, y, 'hq')
    expect(hq.ok).toBe(true)

    for (const kind of ['dc', 'fab', 'gas', 'solar'] as const) {
      const check = canPlaceBuilding(state, x, y, kind)
      expect(check.ok, `${kind} should be blocked on infill`).toBe(false)
      expect(check.reason).toMatch(/Commercial city parcels/i)
    }
  })

  it('still allows industrial builds on ordinary empty land', () => {
    const state = game()
    const { x, y } = findGreenfieldEmpty(state)
    expect(canPlaceBuilding(state, x, y, 'dc').ok).toBe(true)
    expect(canPlaceBuilding(state, x, y, 'solar').ok).toBe(true)
  })

  it('offers placeable in-city HQ spots near the core of every non-village city', () => {
    const state = game()
    const world = state.map.world!
    const plan = planUrbanInfill(world.staticWorld)
    const cities = world.staticWorld.cities.filter((city) => city.tier !== 'village')
    expect(cities.length).toBeGreaterThan(0)
    for (const city of cities) {
      const parcels = plan.parcels
        .filter((parcel) => parcel.cityIndex === city.index)
        .map((parcel) => {
          const { x, y } = tileCoords(parcel.anchorTileId, world.descriptor.width)
          return { parcel, x, y, distance: Math.hypot(x - city.cx, y - city.cy) }
        })
        .sort((a, b) => a.distance - b.distance)
      expect(parcels.length, `${city.id} has infill parcels`).toBeGreaterThan(0)
      // The nearest parcel sits well inside the city radius and takes an HQ.
      const core = parcels[0]!
      expect(core.distance, `${city.id} core parcel distance`)
        .toBeLessThanOrEqual(Math.max(3, city.radius * 0.75))
      const hq = canPlaceBuilding(state, core.x, core.y, 'hq')
      expect(hq.ok, `${city.id} core parcel placeable: ${hq.reason}`).toBe(true)
      // A multi-tile pad (when the city has one) accepts an HQ campus.
      const pad = parcels.find((candidate) =>
        candidate.parcel.width >= 2 && candidate.parcel.height >= 2)
      if (pad) {
        const hqM = canPlaceBuilding(state, pad.x, pad.y, 'hq_m')
        expect(hqM.ok, `${city.id} 2x2 pad accepts hq_m: ${hqM.reason}`).toBe(true)
      }
    }
  })

  it('prices commercial_infill purchases with the redevelopment premium', () => {
    const state = game()
    const { x, y, landValuePerTile } = findInfillTile(state, (w, h) => w === 1 && h === 1)
    const tile = mapTileAtAny(state, x, y)!
    expect(tile.landValue).toBeGreaterThanOrEqual(landValuePerTile)
    expect(landValuePerTile).toBeGreaterThan(
      state.config.landValueBase + state.config.landValueCityPeak,
    )
    // Parcel base already embeds URBAN_INFILL_REDEVELOPMENT_MULT vs raw peak.
    expect(URBAN_INFILL_REDEVELOPMENT_MULT).toBeGreaterThan(1)
    const withoutMult = Math.floor(landValuePerTile / URBAN_INFILL_REDEVELOPMENT_MULT)
    expect(landValuePerTile).toBeGreaterThan(withoutMult)
  })
})
