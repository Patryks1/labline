import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { MapTile, Model, SimState } from '../types'
import {
  deployRackBatchAcrossHalls,
  fleetHostSnapshot,
  fillAllAvailableRackBays,
  modelHostNeed,
  quoteRackDeployment,
} from './hosting'
import { createDefaultHallLayout } from './dataHallLayouts'

function blankTile(x: number, y: number, regionId = 'city_0'): MapTile {
  return {
    x,
    y,
    kind: 'empty',
    owner: 'neutral',
    level: 1,
    buildingProgress: 0,
    buildingTarget: 0,
    name: '',
    racksUsed: 0,
    rackCapacity: 0,
    mwCapacity: 0,
    mwGeneration: 0,
    capex: 0,
    opexPerDay: 0,
    note: '',
    landValue: 1,
    regionId,
  }
}

function hallTile(
  x: number,
  y: number,
  opts: { rackCapacity: number; buildingProgress: number; buildingTarget?: number },
): MapTile {
  return {
    ...blankTile(x, y),
    kind: 'dc',
    owner: 'player',
    campusRole: 'anchor',
    rackCapacity: opts.rackCapacity,
    buildingProgress: opts.buildingProgress,
    buildingTarget: opts.buildingTarget ?? 30,
    name: `Hall ${x},${y}`,
  }
}

function withLegacyHalls(
  seed: number,
  halls: MapTile[],
  extras?: Partial<SimState>,
): SimState {
  const created = createGame(seed)
  const tiles = [
    ...halls,
    ...Array.from({ length: 8 }, (_, i) => blankTile(20 + i, 20)),
  ]
  return {
    ...created,
    ...extras,
    map: {
      ...created.map,
      storage: 'legacy',
      world: undefined,
      worldRevision: 0,
      width: Math.max(created.map.width, 40),
      height: Math.max(created.map.height, 40),
      tiles,
    },
    player: {
      ...created.player,
      ...(extras?.player ?? {}),
      cash: extras?.player?.cash ?? 1_000_000_000_000_000,
      chips: [],
      deployedRacks: [],
      rackFleet: [],
    },
  }
}

function releasedModel(id: string, paramsB: number, activeParamsB = paramsB): Model {
  return {
    id,
    name: id,
    family: activeParamsB < paramsB ? 'moe' : 'dense',
    backbone: activeParamsB < paramsB ? 'moe' : 'dense',
    paramsB,
    activeParamsB,
    inferCostMult: 1,
    release: 'released',
    shipped: true,
  } as Model
}

describe('grounded hosting requirements', () => {
  it('scales the minimum replica PF linearly with active parameters', () => {
    const seven = modelHostNeed(releasedModel('dense-7', 7))
    const fourteen = modelHostNeed(releasedModel('dense-14', 14))
    const moeSmall = modelHostNeed(releasedModel('moe-small', 70, 8))
    const moeLarge = modelHostNeed(releasedModel('moe-large', 700, 8))

    expect(fourteen.hostPf).toBeCloseTo(seven.hostPf * 2, 12)
    expect(moeLarge.hostPf).toBeCloseTo(moeSmall.hostPf, 12)
    expect(moeLarge.vramGb).toBeGreaterThan(moeSmall.vramGb * 5)
  })

  it('adds simultaneous model replica floors instead of sharing cross-model batching', () => {
    const first = releasedModel('first', 2)
    const second = releasedModel('second', 3)
    const created = createGame(91_117)
    const state: SimState = {
      ...created,
      player: {
        ...created.player,
        models: [first, second],
        pricing: {
          ...created.player.pricing,
          activeModelId: first.id,
          apiModelIds: [first.id, second.id],
        },
      },
      lastMarket: {
        ...created.lastMarket,
        demandPf: 0,
        servedPf: 0,
        capacityPf: 0,
      },
    }
    const snapshot = fleetHostSnapshot(state)
    const minimumSum = snapshot.models.reduce((sum, model) => sum + model.hostPf, 0)

    expect(snapshot.models).toHaveLength(2)
    expect(snapshot.pfNeed).toBeCloseTo(minimumSum, 12)
    expect(snapshot.computeCoverage).toBeGreaterThanOrEqual(0)
    expect(snapshot.vramCoverage).toBeGreaterThanOrEqual(0)
  })
})

describe('fillAllAvailableRackBays', () => {
  it('does not synthesize order capacity from a legacy hall bay rating', () => {
    const firstHall = hallTile(2, 2, { rackCapacity: 4, buildingProgress: 30 })
    const secondHall = hallTile(4, 2, { rackCapacity: 3, buildingProgress: 30 })
    const constructionSite = hallTile(6, 2, { rackCapacity: 11, buildingProgress: 3 })
    const state = withLegacyHalls(82_441, [firstHall, secondHall, constructionSite])

    const filled = fillAllAvailableRackBays(state)

    expect(filled.worldMarkets.orders).toHaveLength(state.worldMarkets.orders.length)
    expect(
      filled.worldMarkets.orders.some(
        (order) =>
          order.kind === 'accelerator' &&
          order.destination?.x === constructionSite.x &&
          order.destination?.y === constructionSite.y,
      ),
    ).toBe(false)
    expect(filled.alerts[0]?.message).toContain('physical rack placements')
  })

  it('caps a multi-hall deployment by aggregate market supply', () => {
    const halls = [
      hallTile(2, 2, { rackCapacity: 6, buildingProgress: 30 }),
      hallTile(4, 2, { rackCapacity: 6, buildingProgress: 30 }),
    ]
    const created = createGame(73_112)
    const unplanned = withLegacyHalls(73_112, halls, {
      player: { ...created.player, cash: 10_000_000_000 },
      worldMarkets: {
        ...created.worldMarkets,
        accelerators: {
          ...created.worldMarkets.accelerators,
          rack_h100: {
            ...created.worldMarkets.accelerators.rack_h100!,
            available: 2,
          },
        },
      },
    })
    const dataHallLayouts = Object.fromEntries(halls.map((hall) => {
      const facilityId = `facility:${hall.x},${hall.y}`
      const base = createDefaultHallLayout(facilityId, 'hall-small-v1', [], hall.rackCapacity)
      const cabinets = Array.from({ length: 6 }, (_, index) => ({
        id: `reserved:${facilityId}:${index}`,
        kind: 'rack' as const,
        catalogId: 'rack_h100',
        x: 20 + index * 7,
        z: 20,
        rotation: 0 as const,
        reserved: true,
        purchasePrice: 0,
      }))
      return [facilityId, { ...base, objects: [...base.objects, ...cabinets] }]
    }))
    const state = { ...unplanned, dataHallLayouts }
    const targets = halls.map((site) => ({ x: site.x, y: site.y }))
    const quote = quoteRackDeployment(state, 'rack_h100', targets)

    expect(quote.plannedCabinets).toBe(12)
    expect(quote.maxRacks).toBe(2)
    expect(quote.canFillPlanned).toBe(false)

    const deployed = deployRackBatchAcrossHalls(state, 'rack_h100', targets, 99)
    const reserved = deployed.player.rackFleet
      .filter((install) => install.skuId === 'rack_h100' && install.status === 'ordered')
      .reduce((sum, install) => sum + install.count, 0)
    expect(reserved).toBe(2)
  })
})
