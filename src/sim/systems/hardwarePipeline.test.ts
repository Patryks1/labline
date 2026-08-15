import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import { runTickSystem } from '../tick'
import { constructionCrewBonus, canPlaceBuilding, placeBuilding } from '../systems/map'
import { facilityAnchorTiles } from '../systems/worldAccess'
import { tickDay } from '../tick'
import type { RackInstall, SimState } from '../types'
import type { DataSupplierContract } from '../types'

/** Fresh game where the player has built and completed `count` solar fields. */
function gameWithCompletedFacilities(count: number): {
  state: SimState
  placed: { x: number; y: number }[]
} {
  let state = createGame({
    seed: 10011,
    difficulty: 'easy',
    advanced: { mapWidth: 100, mapHeight: 100, cityCount: 4, rivalCount: 2 },
  })
  state = { ...state, player: { ...state.player, cash: 1e10 } }
  const placed: { x: number; y: number }[] = []
  outer: for (let y = 1; y < state.map.height - 2; y++) {
    for (let x = 1; x < state.map.width - 2; x++) {
      if (placed.length >= count) break outer
      if (!canPlaceBuilding(state, x, y, 'solar').ok) continue
      state = placeBuilding(state, x, y, 'solar')
      placed.push({ x, y })
    }
  }
  if (placed.length < count) throw new Error(`only placed ${placed.length}/${count}`)
  // Solar takes 11 days at the base rate; crews only speed this up.
  for (let d = 0; d < 12 && count > 0; d++) state = tickDay(state)
  return { state, placed }
}

describe('construction crews accelerate builds', () => {
  it('scales with completed facilities and caps at +3', () => {
    expect(constructionCrewBonus(gameWithCompletedFacilities(0).state)).toBe(0)
    expect(constructionCrewBonus(gameWithCompletedFacilities(3).state)).toBe(1)
    expect(constructionCrewBonus(gameWithCompletedFacilities(6).state)).toBe(2)
    expect(constructionCrewBonus(gameWithCompletedFacilities(12).state)).toBe(3)
  })

  it('advances construction faster once the org has facilities', () => {
    let { state } = gameWithCompletedFacilities(3)
    const crew = constructionCrewBonus(state)
    expect(crew).toBe(1)
    // Start one more solar field with the crew in place.
    let anchor: { x: number; y: number } | null = null
    outer: for (let y = 1; y < state.map.height - 2; y++) {
      for (let x = 1; x < state.map.width - 2; x++) {
        if (!canPlaceBuilding(state, x, y, 'solar').ok) continue
        state = placeBuilding(state, x, y, 'solar')
        anchor = { x, y }
        break outer
      }
    }
    expect(anchor).not.toBeNull()
    const { x, y } = anchor!
    const findProgress = (s: SimState) =>
      facilityAnchorTiles(s, { ownerId: 'player' }).find(
        (t) => t.kind === 'solar' && t.x === x && t.y === y,
      )?.buildingProgress
    state = tickDay(state)
    const mid = findProgress(state)
    expect(mid).toBeDefined()
    state = tickDay(state)
    const after = findProgress(state)
    expect(after).toBeDefined()
    // Compact-world builds advance at transportAccess × (1 + crew) per day,
    // with access in [0.75, 1] — so the delta must beat the old flat 1/day.
    const delta = after! - mid!
    expect(delta).toBeGreaterThan(1.4)
    expect(delta).toBeLessThanOrEqual(1 + crew + 1e-9)
  })
})

describe('save load normalizes stranded legacy statuses', () => {
  it('re-queues racks stuck on a retired status as ordered', () => {
    const state0 = createGame({
      seed: 10011,
      difficulty: 'easy',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const hall = state0.map.world!.queryFacilities({ ownerId: state0.rivals[0]!.id })[0]!
    const state = {
      ...state0,
      player: {
        ...state0.player,
        rackFleet: [
          {
            id: 'legacy-install',
            skuId: 'rack_h100',
            facilityId: hall.id,
            x: 0,
            y: 0,
            count: 2,
            // Simulates a pre-migration save with a retired status value.
            status: 'installing' as RackInstall['status'],
            daysLeft: 5,
            paidEach: 1,
            rackUnits: 1,
          },
        ],
      },
    }
    const restored = roundTripState(state)
    expect(restored.player.rackFleet[0]!.status).toBe('ordered')
  })

  it('maps retired pending supplier negotiations onto offered', () => {
    const state = createGame({
      seed: 42,
      difficulty: 'easy',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const contract = {
      id: 'dsc-legacy',
      supplierId: 'sup-1',
      supplierName: 'Legacy Desk',
      domainMix: { chat: 1 },
      quality: 60,
      dailyDeliveryMTok: 10,
      dailyPrice: 1000,
      termDays: 30,
      daysRemaining: 30,
      acceptedDay: state.day,
      status: 'pending' as DataSupplierContract['status'],
      deliveredMTok: 0,
    } satisfies DataSupplierContract
    const withContract: SimState = {
      ...state,
      player: { ...state.player, dataSupplierContracts: [contract] },
    }
    const restored = roundTripState(withContract)
    expect(restored.player.dataSupplierContracts![0]!.status).toBe('offered')
  })
})

describe('runTickSystem isolates daily system failures', () => {
  const base = createGame({
    seed: 7,
    difficulty: 'easy',
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  })

  it('skips a throwing system, keeps state, and posts one sticky alert', () => {
    const boom = (): SimState => {
      throw new Error('corrupt field')
    }
    const first = runTickSystem(base, 'tickBoom', boom)
    expect(first.day).toBe(base.day)
    const alerts = first.alerts.filter((a) => a.id === 'sysfail-tickBoom')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.severity).toBe('danger')
    // A second failure does not spam another alert.
    const second = runTickSystem(first, 'tickBoom', boom)
    expect(second.alerts.filter((a) => a.id === 'sysfail-tickBoom')).toHaveLength(1)
  })

  it('lets later systems keep running after a failure', () => {
    const failed = runTickSystem(base, 'tickBoom', () => {
      throw new Error('nope')
    })
    const continued = runTickSystem(failed, 'tickFine', (s) => ({
      ...s,
      tick: s.tick + 1,
    }))
    expect(continued.tick).toBe(base.tick + 1)
  })
})
