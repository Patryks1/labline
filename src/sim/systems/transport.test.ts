import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import { tickChipDeliveries } from './chips'
import {
  tickTransport,
  transportAccessFactorAt,
  transportCityGrowthMultiplier,
  transportDeliveryAccess,
  transportLandValueMultiplier,
  transportLogisticsOpexSurcharge,
} from './transport'

function compactState(seed = 9_105) {
  return createGame({
    seed,
    advanced: { mapWidth: 48, mapHeight: 48, cityCount: 3, rivalCount: 1 },
  })
}

describe('canonical transport congestion', () => {
  it('produces a deterministic renderer-independent daily snapshot', () => {
    const state = compactState()
    const first = tickTransport(state)
    const second = tickTransport(state)
    expect(first.transport).toEqual(second.transport)
    expect(first.transport.day).toBe(state.day)
    expect(first.transport.segmentLoads.length).toBeGreaterThan(0)
    expect(first.transport.networkRevision).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(first.transport)).toBe(JSON.stringify(second.transport))
  })

  it('runs at most one shortest-path traversal per origin and assignment pass', () => {
    const diagnostics = { endpointCount: 0, demandRouteCount: 0, shortestPathTraversals: 0 }
    tickTransport(compactState(), diagnostics)
    expect(diagnostics.endpointCount).toBeGreaterThan(1)
    expect(diagnostics.shortestPathTraversals).toBeLessThanOrEqual(diagnostics.endpointCount * 3)
    expect(diagnostics.demandRouteCount).toBeGreaterThan(diagnostics.shortestPathTraversals)
  })

  it('keeps gameplay multipliers within their specified bounds', () => {
    const state = tickTransport(compactState(9_106))
    const sample = state.map.world!.staticWorld.starterPads[0] ?? 0
    expect(transportAccessFactorAt(state, sample)).toBeGreaterThanOrEqual(0.75)
    expect(transportAccessFactorAt(state, sample)).toBeLessThanOrEqual(1)
    expect(transportLandValueMultiplier(state, sample)).toBeGreaterThanOrEqual(0.88)
    expect(transportLandValueMultiplier(state, sample)).toBeLessThanOrEqual(1.04)
    const city = state.map.cities?.[0]
    if (city) {
      expect(transportCityGrowthMultiplier(state, city.id)).toBeGreaterThanOrEqual(0.9)
      expect(transportCityGrowthMultiplier(state, city.id)).toBeLessThanOrEqual(1.02)
    }
    expect(transportLogisticsOpexSurcharge(100, 0.75)).toBeLessThanOrEqual(8)
  })

  it('round-trips driving side and aggregate state without saving cars', () => {
    const state = tickTransport({
      ...compactState(9_107),
      config: { ...compactState(9_107).config, drivingSide: 'right' },
    })
    const loaded = roundTripState(state)
    expect(loaded.config.drivingSide).toBe('right')
    expect(loaded.transport).toEqual(state.transport)
    expect('vehicles' in loaded.transport).toBe(false)
  })

  it('advances destination-less equipment orders by deterministic access progress', () => {
    const created = compactState(9_108)
    const state = {
      ...created,
      transport: {
        ...created.transport,
        facilityAccess: { a: 0.75, b: 1 },
      },
      player: {
        ...created.player,
        chips: [{ defId: 'gen1', count: 0, arriving: [{ daysLeft: 2, count: 4 }] }],
      },
    }
    expect(transportDeliveryAccess(state)).toBe(0.875)
    const next = tickChipDeliveries(state)
    expect(next.player.chips[0]!.arriving[0]!.daysLeft).toBe(1.125)
  })
})
