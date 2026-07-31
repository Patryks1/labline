import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { ComputeContract, SimState } from '../types'
import { computeSnapshot } from './compute'
import { powerBalance } from './facilities'
import { resolvePlayerPowerMw } from './map'
import { fleetStats } from './racks'

/** Cloud-first starts have no owned racks; seed a live hall + fleet for local MW tests. */
function withOwnedFleet(state: SimState, racks = 32): SimState {
  // Compact V5 worlds hide the legacy tile array; recreate the historical fixture shape.
  if (state.map.storage === 'compact') {
    state = createGame({
      config: { ...state.config, seed: state.seed },
      legacyMapFixture: true,
    })
  }
  const empties = state.map.tiles.filter(
    (tile) =>
      tile.kind === 'empty' &&
      tile.owner === 'neutral' &&
      tile.regionId !== 'void',
  )
  const hall = empties[0]
  const sub = empties[1]
  if (!hall) return state
  const tiles = state.map.tiles.map((tile) => {
    if (tile.x === hall.x && tile.y === hall.y) {
      return {
        ...tile,
        kind: 'dc' as const,
        owner: 'player' as const,
        name: 'Power test hall',
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 512,
        racksUsed: racks,
        powered: true,
        capex: 1,
        opexPerDay: 1_000,
        landValue: 0,
      }
    }
    if (sub && tile.x === sub.x && tile.y === sub.y) {
      return {
        ...tile,
        kind: 'substation' as const,
        owner: 'player' as const,
        name: 'Power test substation',
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: 80,
        capex: 1,
        opexPerDay: 500,
        landValue: 0,
      }
    }
    return tile
  })
  return {
    ...state,
    map: { ...state.map, tiles },
    player: {
      ...state.player,
      chips: [],
      rackFleet: [
        {
          id: 'power-test-fleet',
          skuId: 'rack_h100',
          x: hall.x,
          y: hall.y,
          count: racks,
          status: 'live',
          daysLeft: 0,
          paidEach: 165_000,
          rackUnits: 1,
        },
      ],
      rackDesigns: state.player.rackDesigns ?? [],
      deployedRacks: state.player.deployedRacks ?? [],
      moduleStock: state.player.moduleStock ?? [],
      allocation: { training: 0.1, inference: 0.8, research: 0.1 },
    },
  }
}

describe('power accounting invariants', () => {
  it('uses snapshot MW demand directly in powerBalance without re-discounting', () => {
    const state = withOwnedFleet(createGame(91_301))
    const snap = computeSnapshot(state)
    const balance = powerBalance(state)
    expect(balance.demandMw).toBeCloseTo(Math.max(0, snap.mwDemand), 10)
  })

  it('keeps sold outbound capacity on the seller electric bill and does not invent free PF', () => {
    let state = withOwnedFleet(createGame(91_302))
    const fleet = fleetStats(state)
    expect(fleet.flopsPf).toBeGreaterThan(1)

    const before = computeSnapshot(state)
    const sellPf = Math.max(0.5, before.rawFlopsPf * 0.25)
    const contract: ComputeContract = {
      id: 'power-outbound-duty',
      providerId: 'cloud-northstar',
      providerName: 'Northstar Compute',
      buyerLabId: state.rivals[0]!.id,
      sellerLabId: state.playerLabId,
      kind: 'rival_resale',
      regionId: state.rivals[0]!.regionId,
      pf: sellPf,
      pricePerPfDay: 500,
      daysLeft: 30,
      daysTotal: 30,
      interruptionRisk: 0,
      terminationFee: 0,
      status: 'active',
      signedDay: state.day,
    }
    state = {
      ...state,
      computeContracts: [...(state.computeContracts ?? []), contract],
      lastMarket: {
        ...state.lastMarket,
        servedPf: Math.max(0, state.lastMarket.servedPf ?? 0),
      },
    }
    const after = computeSnapshot(state)

    // Seller still hosts/powers the sold residual; demand should not collapse to idle-only.
    expect(after.mwDemand).toBeGreaterThan(before.mwDemand * 0.5)
    // Outbound is committed from already-derated hosted capacity, so raw local+remote
    // never exceeds the pre-sale hosted residual plus remote.
    expect(after.rawFlopsPf).toBeLessThanOrEqual(before.rawFlopsPf + 1e-6)
  })

  it('charges local MW only for the local share of served work when remote capacity exists', () => {
    const state = withOwnedFleet(createGame(91_303))
    const fleet = fleetStats(state)
    const localPf = Math.max(1e-6, fleet.flopsPf)
    const remotePf = localPf
    const servedPf = localPf * 0.8
    const contract: ComputeContract = {
      id: 'power-inbound-duty',
      providerId: 'cloud-northstar',
      providerName: 'Northstar Compute',
      buyerLabId: state.playerLabId,
      sellerLabId: state.rivals[0]!.id,
      kind: 'on_demand',
      regionId: state.rivals[0]!.regionId,
      pf: remotePf,
      pricePerPfDay: 500,
      daysLeft: 30,
      daysTotal: 30,
      interruptionRisk: 0,
      terminationFee: 0,
      status: 'active',
      signedDay: state.day,
    }

    const idleState = {
      ...state,
      lastMarket: { ...state.lastMarket, servedPf: 0 },
    }
    const mixedState = {
      ...state,
      computeContracts: [...(state.computeContracts ?? []), contract],
      lastMarket: { ...state.lastMarket, servedPf },
    }
    const localOnlyState = {
      ...state,
      lastMarket: { ...state.lastMarket, servedPf },
    }

    const idle = computeSnapshot(idleState)
    const mixed = computeSnapshot(mixedState)
    const localOnly = computeSnapshot(localOnlyState)

    // Remote work must not push local campus draw all the way to the local-only serve bill.
    expect(mixed.mwDemand).toBeLessThan(localOnly.mwDemand - 1e-6)
    expect(mixed.mwDemand).toBeGreaterThan(idle.mwDemand - 1e-6)
    expect(mixed.rawFlopsPf).toBeGreaterThan(localOnly.rawFlopsPf + remotePf * 0.5)
  })

  it('exposes generation and contracted interconnect as headroom while importing only demand', () => {
    let state = withOwnedFleet(createGame(91_304), 1)
    const substation = state.map.tiles.find(
      (tile) => tile.owner === 'player' && tile.kind === 'substation',
    )
    const solarSite = state.map.tiles.find(
      (tile) => tile.kind === 'empty' && tile.owner === 'neutral',
    )
    if (!substation || !solarSite) throw new Error('Expected power test sites')

    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === solarSite.x && tile.y === solarSite.y
            ? {
                ...tile,
                kind: 'solar' as const,
                owner: 'player' as const,
                buildingProgress: 1,
                buildingTarget: 1,
                mwGeneration: 3,
              }
            : tile,
        ),
      },
      cityPowerContracts: [
        {
          id: 'firm-city-supply',
          cityId: 'test-city',
          cityName: 'Test City',
          mw: 5,
          pricePerMWh: 70,
          daysLeft: 30,
          daysTotal: 30,
        },
      ],
    }

    const idleHeadroom = resolvePlayerPowerMw(state, 0)
    const dispatched = resolvePlayerPowerMw(state, 6)

    expect(idleHeadroom.mwGeneration).toBeCloseTo(3, 8)
    expect(idleHeadroom.mwAvailable).toBeGreaterThanOrEqual(8)
    expect(idleHeadroom.mwGridImport).toBe(0)
    expect(dispatched.mwGeneration).toBeCloseTo(3, 8)
    expect(dispatched.mwCityContractImport).toBeCloseTo(3, 8)
    expect(dispatched.mwGridImport).toBeCloseTo(3, 8)
    expect(dispatched.mwAvailable).toBeGreaterThanOrEqual(8)
  })

  it('reports zero physical availability when no supply exists', () => {
    const created = createGame(91_305)
    const state = {
      ...created,
      map: {
        ...created.map,
        storage: 'legacy' as const,
        world: undefined,
        tiles: [],
      },
      siteCapacities: [],
      cityPowerContracts: [],
      energyContracts: [],
    }

    expect(resolvePlayerPowerMw(state, 4).mwAvailable).toBe(0)
  })
})
