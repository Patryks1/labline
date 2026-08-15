import { describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { expandRivalCampuses } from '../sim/systems/rivals'
import {
  assertFacilityOwnershipInvariants,
  assertSharedLabInvariants,
  assertVisibilityIndependent,
  observePlayerPower,
  runFacilityOwnershipDifferential,
  runSharedLabDifferential,
} from './sharedSimulation'

describe('player/rival shared simulation invariants', () => {
  it('keeps compute allocation, research effects, and inference behavior differential-free', () => {
    const result = runSharedLabDifferential()
    expect(result.observations.length).toBeGreaterThan(4)
    expect(result.failures).toEqual([])
    expect(() => assertSharedLabInvariants(result)).not.toThrow()
  })

  it('accounts for equivalent player and rival facilities identically on the shared grid', () => {
    const result = runFacilityOwnershipDifferential(
      createGame({ seed: 3_117, legacyMapFixture: true }),
    )
    expect(result.failures).toEqual([])
    expect(() => assertFacilityOwnershipInvariants(result)).not.toThrow()
    const last = result.observations.at(-1)
    expect(last?.playerOwned.industryDcCount).toBe(last?.rivalOwned.industryDcCount)
    expect(last?.playerOwned.gridDemandMw).toBe(last?.rivalOwned.gridDemandMw)
  })

  it('keeps player power finite and bounded as demand crosses private headroom', () => {
    const result = runFacilityOwnershipDifferential(
      createGame({ seed: 5_901, legacyMapFixture: true }),
    )
    const observations = observePlayerPower(result.playerOwnedState, [5, 30, 60, 120])
    for (const observation of observations) {
      expect(Number.isFinite(observation.power.mwAvailable)).toBe(true)
      expect(observation.power.mwAvailable).toBeGreaterThan(0)
      expect(observation.power.mwGridImport).toBeGreaterThanOrEqual(0)
      expect(observation.power.industryDcCount).toBeGreaterThanOrEqual(2)
    }
    expect(observations.at(-1)?.power.gridCapped).toBe(true)
  })

  it('makes rival expansion deterministic, visibility-independent, and non-destructive to player sites', () => {
    const prepared = runFacilityOwnershipDifferential(
      createGame({ seed: 8_813, legacyMapFixture: true }),
    ).playerOwnedState
    const state = {
      ...prepared,
      day: 80,
      rivals: prepared.rivals.map((rival) => ({ ...rival, chips: 50_000, flopsPf: 8_000 })),
    }
    const fingerprint = (result: ReturnType<typeof expandRivalCampuses>) =>
      result.map.tiles
        .filter((tile) => tile.owner !== 'neutral')
        .map((tile) => `${tile.x},${tile.y}:${tile.owner}:${tile.kind}:${tile.racksUsed}`)
        .sort()
        .join('|')
    expect(() =>
      assertVisibilityIndependent(
        state,
        expandRivalCampuses,
        (input, visibility) =>
          ({ ...input, __testVisibility: visibility }) as typeof input,
        fingerprint,
      ),
    ).not.toThrow()

    const expanded = expandRivalCampuses(state)
    const playerBefore = state.map.tiles.filter((tile) => tile.owner === 'player')
    for (const before of playerBefore) {
      const after = expanded.map.tiles.find((tile) => tile.x === before.x && tile.y === before.y)
      expect(after).toMatchObject({
        owner: 'player',
        kind: before.kind,
        racksUsed: before.racksUsed,
      })
    }
  })
})
