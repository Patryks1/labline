import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import { computeSnapshot } from './systems/compute'
import { tickMany } from './tick'
import { startTraining, shipModel, tickTraining } from './systems/training'
import { labResearchDayProgress, startResearch, tickResearch } from './systems/research'
import { orderRacksIntoDc } from './systems/dcRacks'
import { tickSharedMarkets } from './systems/sharedMarkets'
import { createRivals } from './systems/rivals'
import { resolvePlayerPowerMw } from './systems/map'
import { onsiteGenerationUpkeepDay } from './systems/facilities'
import { ECONOMY } from './balance/economy'
import type { SimState, SiteCapacity } from './types'

/** Give a bootstrapped lab for unit tests (player starts empty in real games). */
function withCompute(s: SimState, racks = 64): SimState {
  // These unit fixtures directly edit the legacy tile array. New campaigns use
  // compact V5 worlds, so explicitly recreate the historical fixture shape.
  if (s.map.storage === 'compact') {
    s = createGame({ config: { ...s.config, seed: s.seed }, legacyMapFixture: true })
  }
  const empties = s.map.tiles.filter(
    (t) => t.kind === 'empty' && t.owner === 'neutral' && t.regionId !== 'void',
  )
  const dc = empties[0]
  const sub = empties[1]
  const tiles = s.map.tiles.map((t) => {
    if (dc && t.x === dc.x && t.y === dc.y) {
      return {
        ...t,
        kind: 'dc' as const,
        owner: 'player' as const,
        name: 'Test hall',
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 512,
        racksUsed: racks,
        capex: 1,
        opexPerDay: 1000,
        landValue: 0,
      }
    }
    if (sub && t.x === sub.x && t.y === sub.y) {
      return {
        ...t,
        kind: 'substation' as const,
        owner: 'player' as const,
        name: 'Test power',
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: 40,
        capex: 1,
        opexPerDay: 500,
        landValue: 0,
      }
    }
    return t
  })
  if (!dc) return s
  return {
    ...s,
    map: { ...s.map, tiles },
    player: {
      ...s.player,
      chips: [],
      rackFleet: [
        {
          id: 'test-fleet',
          skuId: 'rack_h100',
          x: dc.x,
          y: dc.y,
          count: racks,
          status: 'live',
          daysLeft: 0,
          paidEach: 165_000,
          rackUnits: 1,
        },
      ],
      rackDesigns: s.player.rackDesigns ?? [],
      deployedRacks: s.player.deployedRacks ?? [],
      moduleStock: s.player.moduleStock ?? [],
    },
  }
}

describe('compute fabric', () => {
  it('starts cloud-first — remote capacity but no owned chips or player buildings', () => {
    const g = createGame(1)
    const snap = computeSnapshot(g)
    expect(snap.utilCap).toBeLessThan(0.55)
    expect(snap.chipCount).toBeGreaterThan(0)
    expect(snap.effectiveFlopsPf).toBeGreaterThan(0)
    expect(g.player.chips.length).toBe(0)
    expect(g.player.rackFleet).toEqual([])
    expect(g.map.tiles.some((t) => t.owner === 'player')).toBe(false)
  })

  it('city power contracts deliver through commissioned interconnect MW', () => {
    let s = withCompute(createGame(2), 64)
    const city = s.map.cities?.[0]
    expect(city).toBeTruthy()
    // Place a grid connector near the city so contracted MW has a physical path.
    const near = s.map.tiles.find(
      (t) =>
        t.owner === 'player' ||
        (t.kind === 'empty' &&
          city &&
          Math.max(Math.abs(t.x - city.cx), Math.abs(t.y - city.cy)) <= city.powerRadius),
    )
    if (near && near.owner !== 'player') {
      s = {
        ...s,
        map: {
          ...s.map,
          tiles: s.map.tiles.map((t) =>
            t.x === near.x && t.y === near.y
              ? {
                  ...t,
                  kind: 'substation' as const,
                  owner: 'player' as const,
                  buildingProgress: 1,
                  buildingTarget: 1,
                  mwCapacity: 25,
                  mwGeneration: 0,
                }
              : t,
          ),
        },
      }
    }
    // Strip every other interconnect so this connector is the exact ceiling.
    s = {
      ...s,
      map: {
        ...s.map,
        tiles: s.map.tiles.map((t) =>
          t.owner === 'player'
            ? {
                ...t,
                mwCapacity: near && t.x === near.x && t.y === near.y ? 25 : 0,
                mwGeneration: near && t.x === near.x && t.y === near.y ? 0 : 2,
              }
            : t,
        ),
      },
      cityPowerContracts: [
        {
          id: 'test-c',
          cityId: city!.id,
          cityName: city!.name,
          mw: 25,
          pricePerMWh: 80,
          daysLeft: 60,
          daysTotal: 60,
        },
      ],
    }
    const noContract = resolvePlayerPowerMw(
      { ...s, cityPowerContracts: [] },
      40,
    )
    const withContract = resolvePlayerPowerMw(s, 40)
    expect(noContract.mwContractImport).toBe(0)
    expect(withContract.mwContractImport).toBe(25)
    expect(withContract.mwAvailable).toBe(noContract.mwAvailable)
  })

  it('commissioned site capacity powers the player resolver and invalidates the compute cache', () => {
    let state = withCompute(createGame(2_026), 64)
    state = {
      ...state,
      computeContracts: [],
      computeLeases: [],
      siteCapacities: state.siteCapacities.filter(
        (capacity) => capacity.labId !== state.playerLabId,
      ),
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.owner === 'player'
            ? { ...tile, mwCapacity: 0, mwGeneration: 0 }
            : tile,
        ),
      },
      player: { ...state.player, computeContracts: [] },
    }

    const powerLimited = computeSnapshot(state)
    const capacity: SiteCapacity = {
      id: 'player-commissioned-site',
      projectId: 'player-commissioned-project',
      labId: state.playerLabId,
      route: 'colocation',
      regionId: state.map.activeRegionId,
      siteMw: 2,
      firmMw: 2,
      commissionedDay: state.day,
      status: 'active',
    }
    const commissioned = {
      ...state,
      siteCapacities: [...state.siteCapacities, capacity],
    }
    const power = resolvePlayerPowerMw(commissioned, powerLimited.mwDemand)
    const powered = computeSnapshot(commissioned)

    expect(power.mwInterconnect).toBeGreaterThanOrEqual(2)
    expect(power.mwAvailable).toBeGreaterThanOrEqual(powerLimited.mwDemand)
    expect(powered.powerDerate).toBeGreaterThan(powerLimited.powerDerate)
    expect(powered.effectiveFlopsPf).toBeGreaterThan(powerLimited.effectiveFlopsPf)
  })

  it('leased-in PF boosts train pool even when local power is short', () => {
    let s = withCompute(createGame(3), 80)
    // No interconnect / gen — local power starved
    s = {
      ...s,
      map: {
        ...s.map,
        tiles: s.map.tiles.map((t) =>
          t.owner === 'player' ? { ...t, mwCapacity: 0, mwGeneration: 0 } : t,
        ),
      },
      player: {
        ...s.player,
        allocation: { training: 0.8, inference: 0.1, research: 0.1 },
      },
      computeLeases: [
        {
          id: 'lease-in',
          rivalId: s.rivals[0]!.id,
          playerSells: false,
          pf: 40,
          pricePerPfDay: 100,
          daysLeft: 20,
          daysTotal: 20,
          status: 'active',
          from: 'rival',
        },
      ],
    }
    const snap = computeSnapshot(s)
    expect(snap.pools.training).toBeGreaterThan(1)
  })

  it('throttles when demand exceeds power', () => {
    let s = withCompute(createGame(1), 200)
    const tiles = s.map.tiles.map((t) =>
      t.kind === 'substation' ? { ...t, mwCapacity: 0.01, mwGeneration: 0 } : t,
    )
    s = { ...s, map: { ...s.map, tiles } }
    const snap = computeSnapshot(s)
    expect(snap.throttled).toBe(true)
    expect(snap.powerDerate).toBeLessThan(1)
  })
})

describe('training and ship', () => {
  it('can train and ship a small dense model', () => {
    let s = withCompute(createGame(2))
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.9, inference: 0.05, research: 0.05 },
      },
    }
    s = startTraining(s, { name: 'Spark-1B', family: 'dense', paramsB: 1 })
    expect(s.player.trainingJob).not.toBeNull()

    for (let i = 0; i < 200; i++) {
      s = { ...s, day: s.day + 1 }
      s = tickTraining(s)
      if (
        s.player.trainingJob &&
        s.player.trainingJob.progressPfDays >= s.player.trainingJob.targetPfDays
      )
        break
    }
    expect(s.player.trainingJob!.progressPfDays).toBeGreaterThanOrEqual(
      s.player.trainingJob!.targetPfDays,
    )
    s = shipModel(s)
    expect(s.player.models.length).toBe(1)
    expect(s.player.models[0]!.capability).toBeGreaterThan(10)
    expect(s.player.models[0]!.benchmarks.coding).toBeGreaterThan(0)
    expect(s.player.pricing.plans.some((p) => p.modelIds.includes(s.player.models[0]!.id))).toBe(
      true,
    )
  })
})

describe('research', () => {
  it('scales progress with researchers and research compute', () => {
    const base = labResearchDayProgress({
      researchers: 1,
      engineers: 0,
      researchPf: 1,
      nodeId: 'sys_batching',
    })
    const moreStaff = labResearchDayProgress({
      researchers: 4,
      engineers: 0,
      researchPf: 1,
      nodeId: 'sys_batching',
    })
    const moreCompute = labResearchDayProgress({
      researchers: 1,
      engineers: 0,
      researchPf: 3,
      nodeId: 'sys_batching',
    })
    const both = labResearchDayProgress({
      researchers: 4,
      engineers: 0,
      researchPf: 3,
      nodeId: 'sys_batching',
    })
    expect(base).toBeGreaterThan(0)
    expect(moreStaff).toBeGreaterThan(base * 2)
    expect(moreCompute).toBeCloseTo(base * 3, 5)
    expect(both).toBeGreaterThan(moreStaff)
    expect(both).toBeGreaterThan(moreCompute)
  })

  it('completes batching and raises util', () => {
    let s = withCompute(createGame(3))
    // Need researchers + HQ desks gate satisfied via staff
    s = {
      ...s,
      player: {
        ...s.player,
        staff: { researcher: 2, data_processor: 1, engineer: 1, ops: 1 },
        talent: 1.5,
      },
    }
    const util0 = s.player.utilCap
    s = startResearch(s, 'sys_batching')
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
    }
    for (let i = 0; i < 40; i++) {
      s = { ...s, day: s.day + 1 }
      s = tickResearch(s)
      if (!s.player.activeResearch) break
    }
    expect(s.player.researchUnlocked).toContain('sys_batching')
    expect(s.player.utilCap).toBeGreaterThan(util0)
  })

  it('queues research and auto-starts next', () => {
    let s = withCompute(createGame(8))
    s = {
      ...s,
      player: {
        ...s.player,
        staff: { researcher: 3, data_processor: 1, engineer: 1, ops: 1 },
        talent: 1.5,
      },
    }
    s = startResearch(s, 'sys_batching')
    s = startResearch(s, 'data_clean')
    expect(s.player.activeResearch?.nodeId).toBe('sys_batching')
    expect(s.player.researchQueue).toContain('data_clean')
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.05, inference: 0.05, research: 0.9 },
      },
    }
    for (let i = 0; i < 80; i++) {
      s = { ...s, day: s.day + 1 }
      s = tickResearch(s)
    }
    expect(s.player.researchUnlocked).toContain('sys_batching')
    expect(s.player.researchUnlocked).toContain('data_clean')
  })
})

describe('economy smoke', () => {
  it('runs 30 days without NaN cash', () => {
    let s = withCompute(createGame(4))
    s = startTraining(s, { name: 'Tiny', family: 'dense', paramsB: 1 })
    s = {
      ...s,
      player: {
        ...s.player,
        allocation: { training: 0.8, inference: 0.15, research: 0.05 },
      },
      paused: false,
    }
    for (let i = 0; i < 80; i++) {
      s = tickMany(s, 1)
      if (
        s.player.trainingJob &&
        s.player.trainingJob.progressPfDays >= s.player.trainingJob.targetPfDays
      ) {
        s = shipModel(s)
        break
      }
    }
    s = tickMany(s, 30)
    expect(Number.isFinite(s.player.cash)).toBe(true)
    expect(s.lastMarket.planStats).toBeDefined()
    const sum = Object.values(s.lastMarket.sharesByLab).reduce((a, b) => a + b, 0)
    expect(sum).toBeGreaterThan(0.9)
    expect(sum).toBeLessThan(1.1)
  })

  it('order racks into a hall spends cash', () => {
    let g = withCompute(createGame(5), 0)
    // empty fleet
    g = {
      ...g,
      player: { ...g.player, rackFleet: [] },
    }
    const dc = g.map.tiles.find((t) => t.kind === 'dc' && t.owner === 'player')!
    const cash = g.player.cash
    let s = orderRacksIntoDc(g, dc.x, dc.y, 'rack_h100', 8)
    expect(s.player.cash).toBeLessThan(cash)
    expect(s.worldMarkets.orders.some((order) => order.kind === 'accelerator')).toBe(true)
    s = tickSharedMarkets(s)
    expect(s.player.rackFleet.some((r) => r.status === 'ordered' && r.count === 8)).toBe(true)
  })

  it('reserves destination bays before shared-market rack orders clear', () => {
    let s = withCompute(createGame(51), 500)
    s = {
      ...s,
      labs: {
        ...s.labs,
        [s.playerLabId]: {
          ...s.labs[s.playerLabId]!,
          rackFleet: s.player.rackFleet,
        },
      },
    }
    const dc = s.map.tiles.find((tile) => tile.kind === 'dc' && tile.owner === 'player')!
    s = orderRacksIntoDc(s, dc.x, dc.y, 'rack_h100', 10)
    s = orderRacksIntoDc(s, dc.x, dc.y, 'rack_h100', 10)
    expect(s.worldMarkets.orders.filter((order) => order.kind === 'accelerator')).toHaveLength(1)

    s = tickSharedMarkets(s)
    const committed = s.player.rackFleet.reduce(
      (sum, install) => sum + install.count * Math.max(1, install.rackUnits || 1),
      0,
    )
    expect(committed).toBe(510)
    expect(computeSnapshot(s).racksUsed).toBeLessThanOrEqual(computeSnapshot(s).rackCap)
  })

  it('prices owned generation at 60% of equivalent grid energy', () => {
    const gridCost = 10 * 24 * ECONOMY.energyBasePrice
    const ownCost = onsiteGenerationUpkeepDay(10, ECONOMY.energyBasePrice)
    expect(ECONOMY.energyBasePrice).toBeGreaterThan(450)
    expect(ownCost).toBeCloseTo(gridCost * 0.6, 8)
    expect(ownCost).toBeLessThan(gridCost)
  })

  it('starts with default subscription plans', () => {
    const g = createGame(7)
    expect(g.player.pricing.plans.length).toBeGreaterThanOrEqual(2)
    expect(g.player.pricing.plans[0]!.usageMultiplier).toBeGreaterThan(0)
    expect(g.player.pricing.plans[0]!.pricePerMonth).toBe(0)
  })

  it('has five rival archetypes and no models at start', () => {
    const rivals = createRivals(9)
    expect(rivals.map((r) => r.archetype).sort()).toEqual(
      ['efficiency', 'hyperscale', 'multimodal', 'open_weights', 'safety'].sort(),
    )
    expect(rivals.every((r) => r.models.length === 0)).toBe(true)
  })

  it('map has three regions', () => {
    const g = createGame(6)
    expect(g.map.regions.length).toBe(3)
  })
})
