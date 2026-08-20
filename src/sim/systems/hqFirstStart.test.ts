import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { BASE_REMOTE_TEAM_SEATS, emptyStaff } from '../balance/staff'
import {
  TERRAIN_KIND,
  WORLD_GENERATOR_VERSION_V7,
  generateStaticWorldV7,
  type TileId,
} from '../world'
import { canPlaceBuilding, placeBuilding } from './map'
import {
  hireStaff,
  playerHqStaffCap,
  playerStaff,
  staffTotal,
} from './staff'
import { mapTileAtAny, usesCompactWorld } from './worldAccess'
import { tileCoords } from '../world/ids'
import { buildObjectives } from '../../view/hud/objectives'
import type { SimState } from '../types'

function findHqSpot(state: SimState): { x: number; y: number } {
  const world = state.map.world!
  const width = world.descriptor.width
  const candidates: TileId[] = [
    ...world.staticWorld.starterPads,
  ]
  // Prefer feature-tagged urban empty lots (in-city parcels).
  for (let id = 0; id < world.staticWorld.kind.length; id++) {
    if (world.staticWorld.kind[id] !== TERRAIN_KIND.empty) continue
    const feature = world.staticWorld.feature[id]!
    if (feature > 0 && (feature & 0x8000) === 0) candidates.unshift(id as TileId)
  }
  for (const id of candidates) {
    const { x, y } = tileCoords(id, width)
    if (canPlaceBuilding(state, x, y, 'hq').ok) return { x, y }
  }
  throw new Error('No placeable HQ spot')
}

describe('HQ-first start', () => {
  it('starts with zero staff, zero remote seats, and a starter HQ grant', () => {
    const state = createGame(42_101)
    expect(BASE_REMOTE_TEAM_SEATS).toBe(0)
    expect(staffTotal(state.player.staff)).toBe(0)
    expect(playerHqStaffCap(state)).toBe(0)
    expect(state.player.starterHqGrant).toBe(true)
    expect(state.player.cloudCredits).toBe(3_000_000)
    expect(state.computeContracts.some((c) => c.pf > 0 && c.status === 'active')).toBe(true)
    expect(state.alerts.some((a) => a.id === 'welcome' && a.message.includes('free HQ grant'))).toBe(true)
  })

  it('carves empty urban lots inside V7 cities while keeping feature tags', () => {
    const world = generateStaticWorldV7({
      seed: 0x71a7,
      width: 160,
      height: 144,
      cityCount: 3,
      waterCoverage: 0.055,
    })
    expect(world.descriptor.generatorVersion).toBe(WORLD_GENERATOR_VERSION_V7)
    if (world.descriptor.generatorVersion !== WORLD_GENERATOR_VERSION_V7) {
      throw new Error('expected a V7 descriptor')
    }
    expect(world.descriptor.settlementAlgorithmVersion).toBe(7)
    let urbanEmpty = 0
    let urbanBuilt = 0
    for (let id = 0; id < world.kind.length; id++) {
      const feature = world.feature[id]!
      if (feature === 0 || (feature & 0x8000) !== 0) continue
      if (world.kind[id] === TERRAIN_KIND.empty) urbanEmpty++
      if (world.kind[id] === TERRAIN_KIND.city || world.kind[id] === TERRAIN_KIND.house) urbanBuilt++
    }
    expect(urbanEmpty).toBeGreaterThan(20)
    expect(urbanBuilt).toBeGreaterThan(urbanEmpty)
  })

  it('places the free starter HQ instantly and unlocks desks', () => {
    let state = createGame(42_102)
    expect(usesCompactWorld(state)).toBe(true)
    const { x, y } = findHqSpot(state)
    const check = canPlaceBuilding(state, x, y, 'hq')
    expect(check.ok).toBe(true)
    expect(check.totalCash).toBe(0)
    expect(check.buildCash).toBe(0)
    expect(check.landCash).toBe(0)

    state = placeBuilding(state, x, y, 'hq')
    expect(state.player.starterHqGrant).toBe(false)
    expect(playerHqStaffCap(state)).toBe(12)
    const tile = mapTileAtAny(state, x, y)!
    expect(tile.kind).toBe('hq')
    expect(tile.buildingProgress).toBeGreaterThanOrEqual(tile.buildingTarget)
  })

  it('gates onboarding: place HQ → hire researchers before cloud guidance', () => {
    let state = createGame(42_103)
    const first = buildObjectives(state, true)
    expect(first[0]?.id).toBe('place-hq')

    const { x, y } = findHqSpot(state)
    state = placeBuilding(state, x, y, 'hq')
    const afterHq = buildObjectives(state, true)
    expect(afterHq[0]?.id).toBe('hire-researchers')

    const city = state.map.cities![0]!
    state = {
      ...state,
      map: {
        ...state.map,
        cities: [
          {
            ...city,
            talentAvailable: {
              ...(city.talentAvailable ?? emptyStaff()),
              researcher: 5,
            },
          },
          ...state.map.cities!.slice(1),
        ],
      },
    }
    state = hireStaff(state, city.id, 'researcher', 1)
    expect(playerStaff(state).researcher).toBe(1)
    const afterHire = buildObjectives(state, true)
    expect(afterHire.some((o) => o.id === 'place-hq' || o.id === 'hire-researchers')).toBe(false)
  })
})
