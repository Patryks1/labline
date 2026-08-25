import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import type { PowerEfficiencySample } from './types'
import { tileId } from './world/ids'
import {
  POWER_EFFICIENCY_HISTORY_DAYS,
  powerBalance,
  recordPowerEfficiencyDay,
} from './systems/facilities'
import { computeSnapshot } from './systems/compute'
import { tickDay } from './tick'
import { roundTripState } from './save'

describe('power generation breakdown', () => {
  it('splits completed on-site generation by facility kind', () => {
    const created = createGame(81_510)
    const world = created.map.world
    if (!world) throw new Error('Expected a compact world')
    const sites = []
    for (let y = 1; y < created.map.height; y += 1) {
      for (let x = 1; x < created.map.width; x += 1) {
        const id = tileId(x, y, created.map.width, created.map.height)
        if (!world.getFacilityAt(id)) sites.push(id)
        if (sites.length === 3) break
      }
      if (sites.length === 3) break
    }
    world
      .beginBatch()
      .addFacility({
        id: 'test-solar-gen',
        kind: 'solar',
        ownerId: 'player',
        anchor: sites[0]!,
        footprint: [sites[0]!],
        level: 1,
        constructionProgress: 1,
        constructionTarget: 1,
        stats: { mwGeneration: 40 },
      })
      .addFacility({
        id: 'test-gas-gen',
        kind: 'gas',
        ownerId: 'player',
        anchor: sites[1]!,
        footprint: [sites[1]!],
        level: 1,
        constructionProgress: 1,
        constructionTarget: 1,
        stats: { mwGeneration: 60 },
      })
      .addFacility({
        id: 'test-gas-wip',
        kind: 'gas',
        ownerId: 'player',
        anchor: sites[2]!,
        footprint: [sites[2]!],
        level: 1,
        constructionProgress: 0,
        constructionTarget: 1,
        stats: { mwGeneration: 25 },
      })
      .commit()
    const state = {
      ...created,
      map: { ...created.map, worldRevision: world.revision },
    }

    const balance = powerBalance(state)
    expect(balance.genBySourceMw.solarMw).toBeCloseTo(40)
    // The under-construction peaker does not generate yet.
    expect(balance.genBySourceMw.gasMw).toBeCloseTo(60)
    expect(balance.genBySourceMw.nuclearMw).toBe(0)
    const bySourceTotal =
      balance.genBySourceMw.solarMw +
      balance.genBySourceMw.gasMw +
      balance.genBySourceMw.nuclearMw +
      balance.genBySourceMw.otherMw
    expect(bySourceTotal).toBeCloseTo(balance.genMw)
  })
})

describe('recordPowerEfficiencyDay', () => {
  it('appends a finite sample and replaces a same-day sample', () => {
    const state = createGame(7_777)
    const sampled = recordPowerEfficiencyDay(state)
    const history = sampled.player.powerEfficiencyHistory ?? []
    expect(history).toHaveLength(1)
    expect(history[0]?.day).toBe(state.day)
    expect(Number.isFinite(history[0]?.pfPerMw)).toBe(true)
    expect(history[0]?.pfPerMw).toBeGreaterThanOrEqual(0)

    const resampled = recordPowerEfficiencyDay(sampled)
    expect(resampled.player.powerEfficiencyHistory).toHaveLength(1)
  })

  it('keeps only the newest window of samples', () => {
    const state = createGame(7_778)
    const seeded: PowerEfficiencySample[] = Array.from({ length: 40 }, (_, i) => ({
      day: state.day - 40 + i,
      pfPerMw: 50,
    }))
    const bounded = recordPowerEfficiencyDay({
      ...state,
      player: { ...state.player, powerEfficiencyHistory: seeded },
    })
    const history = bounded.player.powerEfficiencyHistory ?? []
    expect(history).toHaveLength(POWER_EFFICIENCY_HISTORY_DAYS)
    expect(history[history.length - 1]?.day).toBe(state.day)
  })

  it('records one sample per daily tick', () => {
    const next = tickDay(createGame(9_001))
    const history = next.player.powerEfficiencyHistory ?? []
    expect(history).toHaveLength(1)
    expect(history[0]?.day).toBe(next.day)
  })

  it('keeps cloud PF out of the local MW denominator while retaining combined effective PF', () => {
    const state = createGame(9_002)
    const snap = computeSnapshot(state)
    const sampled = recordPowerEfficiencyDay(state)
    const sample = sampled.player.powerEfficiencyHistory?.[0]
    expect(sample?.cloudPf).toBeCloseTo(snap.remoteFlopsPf, 8)
    expect(sample?.combinedEffectivePf).toBeCloseTo(snap.effectiveFlopsPf, 8)
    expect(sample?.cloudEffectivePf).toBeCloseTo(snap.remoteEffectiveFlopsPf, 8)
    expect(sample?.pfPerMw).toBe(
      snap.mwDemand > 1e-6
        ? (snap.rawFlopsPf - snap.remoteFlopsPf) / snap.mwDemand
        : 0,
    )
  })
})

describe('save normalization of powerEfficiencyHistory', () => {
  it('drops corrupt samples, clamps negatives, and bounds to the window', () => {
    const state = createGame(5_505)
    state.player.powerEfficiencyHistory = [
      ...Array.from({ length: 40 }, (_, i) => ({ day: 10 + i, pfPerMw: 5 })),
      { day: 50, pfPerMw: -4 },
      { day: 51, pfPerMw: Number.NaN },
      null,
    ] as unknown as PowerEfficiencySample[]

    const back = roundTripState(state)
    const history = back.player.powerEfficiencyHistory ?? []
    expect(history).toHaveLength(30)
    expect(history.every((sample) => Number.isFinite(sample.pfPerMw))).toBe(true)
    expect(history.every((sample) => sample.pfPerMw >= 0)).toBe(true)
    expect(history[0]?.day).toBe(21)
    expect(history[history.length - 1]).toEqual({ day: 50, pfPerMw: 0 })
  })
})
