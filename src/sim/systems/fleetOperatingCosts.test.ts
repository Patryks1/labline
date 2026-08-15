import { describe, expect, it } from 'vitest'
import { ECONOMY } from '../balance/economy'
import { getChipDef } from '../balance/chips'
import { getRackSku } from '../balance/rackSkus'
import { createGame } from '../createGame'
import type { LabId, RackInstall, SimState } from '../types'
import { tileCoords } from '../world/ids'
import { calculateFleetVariableOpex } from './fleetOperatingCosts'
import { labHallEquipmentOpexDay } from './dataHallConstruction'
import {
  labBuildingOpex,
  labFacilityShellOpex,
  labFleetVariableOpex,
} from './map'
import { tickMarket } from './market'

const liveRack = (id: string, count: number, x = 0, y = 0): RackInstall => ({
  id,
  skuId: 'rack_h100',
  x,
  y,
  count,
  status: 'live',
  daysLeft: 0,
  paidEach: 313_500,
  rackUnits: 1,
})

function withLegacyFacility(ownerId: LabId, rackCount: number): SimState {
  const state = createGame({ seed: 9_301, legacyMapFixture: true })
  const index = state.map.tiles.findIndex(
    (tile) => tile.owner === 'neutral' && tile.kind === 'empty',
  )
  const original = state.map.tiles[index]!
  const tiles = state.map.tiles.slice()
  tiles[index] = {
    ...original,
    owner: ownerId,
    kind: 'dc',
    name: 'Parity hall',
    buildingProgress: 1,
    buildingTarget: 1,
    rackCapacity: 160,
    racksUsed: rackCount,
    opexPerDay: 95_000,
    powered: true,
  }
  const rack = liveRack(`rack-${ownerId}`, rackCount, original.x, original.y)
  return {
    ...state,
    map: { ...state.map, tiles },
    player: {
      ...state.player,
      chips: [],
      rackFleet: ownerId === state.playerLabId ? [rack] : [],
    },
    rivals: state.rivals.map((rival) => ({
      ...rival,
      chips: 0,
      flopsPf: 0,
      rackFleet: rival.id === ownerId ? [rack] : [],
    })),
  }
}

function withCompactFacility(ownerId: LabId, rackCount: number): SimState {
  const state = createGame(9_302)
  const rival = state.rivals[0]!
  const world = state.map.world!
  const facility = world.queryFacilities({ ownerId: rival.id })[0]!
  const { x, y } = tileCoords(facility.anchor, world.descriptor.width)
  if (ownerId !== rival.id) {
    world.beginBatch().replaceFacility({ ...facility, ownerId }).commit()
  }
  const rack = liveRack(`rack-${ownerId}`, rackCount, x, y)
  return {
    ...state,
    map: { ...state.map, worldRevision: world.revision },
    player: {
      ...state.player,
      chips: [],
      rackFleet: ownerId === state.playerLabId ? [rack] : [],
    },
    rivals: state.rivals.map((candidate) => ({
      ...candidate,
      chips: 0,
      flopsPf: 0,
      rackFleet: candidate.id === ownerId ? [rack] : [],
    })),
  }
}

describe('controller-neutral fleet operating costs', () => {
  it('prices physical devices and MW once, ignoring ordered inventory', () => {
    const settled = calculateFleetVariableOpex({
      rackFleet: [
        liveRack('live', 2),
        { ...liveRack('ordered', 5), status: 'ordered' },
      ],
      looseAccelerators: [
        { count: 3, mwPerDevice: getChipDef('gen2').mwPerChip },
      ],
    })
    const expectedDevices = 2 * 8 + 3
    const expectedMw =
      2 * getRackSku('rack_h100').mw + 3 * getChipDef('gen2').mwPerChip

    expect(settled.deviceCount).toBe(expectedDevices)
    expect(settled.mw).toBeCloseTo(expectedMw, 12)
    expect(settled.totalOpexDay).toBeCloseTo(
      expectedDevices * ECONOMY.rackOpexPerGpuDay +
        expectedMw * ECONOMY.rackOpexPerMwDay,
      8,
    )
  })

  it.each([
    ['legacy', withLegacyFacility],
    ['compact', withCompactFacility],
  ] as const)('%s maps charge identical player and rival facilities/fleets equally', (_, factory) => {
    const player = factory('player', 2)
    const rivalId = player.rivals[0]!.id
    const rival = factory(rivalId, 2)

    expect(labFacilityShellOpex(player, 'player')).toBeCloseTo(
      labFacilityShellOpex(rival, rivalId),
      8,
    )
    expect(labFleetVariableOpex(player, 'player')).toBeCloseTo(
      labFleetVariableOpex(rival, rivalId),
      8,
    )
    expect(labBuildingOpex(player, 'player')).toBeCloseTo(
      labBuildingOpex(rival, rivalId),
      8,
    )
  })

  it('charges the same variable opex for identical loose gen-2 chip fleets', () => {
    const player = withLegacyFacility('player', 0)
    const rivalId = player.rivals[0]!.id
    const rival = withLegacyFacility(rivalId, 0)
    player.player.chips = [{ defId: 'gen2', count: 24, arriving: [] }]
    rival.rivals[0] = { ...rival.rivals[0]!, chips: 24 }

    expect(labFleetVariableOpex(player, 'player')).toBeCloseTo(
      labFleetVariableOpex(rival, rivalId),
      8,
    )
  })

  it.each([
    ['legacy', withLegacyFacility],
    ['compact', withCompactFacility],
  ] as const)('%s maps keep an empty hall cheaper than a full hall', (_, factory) => {
    const empty = factory('player', 0)
    const full = factory('player', 12)
    const shell = labFacilityShellOpex(empty, 'player')
    const hallEquipment = labHallEquipmentOpexDay(empty, 'player')
    const fleet = labFleetVariableOpex(full, 'player')

    expect(labBuildingOpex(empty, 'player')).toBeCloseTo(shell + hallEquipment, 8)
    expect(labBuildingOpex(full, 'player')).toBeCloseTo(shell + hallEquipment + fleet, 8)
    expect(labBuildingOpex(full, 'player')).toBeGreaterThan(
      labBuildingOpex(empty, 'player'),
    )
  })

  it('settles combined shell and fleet opex into finance exactly once', () => {
    const playerState = withLegacyFacility('player', 2)
    const rivalId = playerState.rivals[0]!.id
    const rivalState = withLegacyFacility(rivalId, 2)
    const playerExpected = labBuildingOpex(playerState, 'player')
    const rivalExpected = labBuildingOpex(rivalState, rivalId)

    const playerSettled = tickMarket(playerState)
    const rivalSettled = tickMarket(rivalState).rivals[0]!
    expect(playerSettled.player.finance.dayBuildingOpex).toBeCloseTo(playerExpected, 8)
    expect(rivalSettled.finance?.dayBuildingOpex).toBeCloseTo(rivalExpected, 8)
    expect(playerSettled.player.finance.dayTotalOut).toBeCloseTo(
      playerSettled.player.finance.dayEnergyCost +
        playerSettled.player.finance.dayWageCost +
        playerSettled.player.finance.dayMarketing +
        playerExpected +
        (playerSettled.player.computeLeaseCostToday ?? 0),
      8,
    )
    expect(rivalSettled.finance?.dayTotalOut).toBeCloseTo(
      (rivalSettled.finance?.dayEnergyCost ?? 0) +
        (rivalSettled.finance?.dayWageCost ?? 0) +
        (rivalSettled.finance?.dayMarketing ?? 0) +
        rivalExpected +
        (rivalSettled.computeLeaseCostToday ?? 0),
      8,
    )
  })
})
