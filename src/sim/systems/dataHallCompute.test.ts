import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { SimState, TileKind } from '../types'
import { dcBayUsage } from './dcRacks'
import { createDefaultHallLayout } from './dataHallLayouts'
import { fleetStats } from './racks'

function withHall(kind: TileKind): SimState {
  // Legacy tile array so hall kind mutations stay authoritative for fleetStats.
  const state = createGame({ seed: 97_201, legacyMapFixture: true })
  const site = state.map.tiles.find(
    (tile) => tile.kind === 'empty' && tile.owner === 'neutral' && tile.regionId !== 'void',
  )
  if (!site) throw new Error('No empty site for hall fixture')
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === site.x && tile.y === site.y
          ? {
              ...tile,
              kind,
              owner: 'player' as const,
              buildingProgress: 1,
              buildingTarget: 1,
              campusRole: 'anchor' as const,
              rackCapacity: 96,
              racksUsed: 10,
              powered: true,
            }
          : tile,
      ),
    },
    player: {
      ...state.player,
      chips: [],
      deployedRacks: [],
      rackFleet: [
        {
          id: `hall-${kind}`,
          skuId: 'rack_h200',
          x: site.x,
          y: site.y,
          count: 10,
          status: 'live',
          daysLeft: 0,
          paidEach: 418_000,
          rackUnits: 1,
        },
      ],
    },
  }
}

describe('large data-hall compute fabric', () => {
  it('keeps small halls at rack-rated PF', () => {
    const state = withHall('dc')
    const rated = 10 * 7.912 // rack_h200 SKU × count
    expect(dcBayUsage(state, state.player.rackFleet[0]!.x, state.player.rackFleet[0]!.y).flopsLive)
      .toBeCloseTo(rated)
    expect(fleetStats(state).flopsPf).toBeCloseTo(rated)
  })

  it.each(['dc_m', 'dc_l'] as const)('keeps identical rack silicon at rated PF in a %s campus', (kind) => {
    const state = withHall(kind)
    const install = state.player.rackFleet[0]!
    const rated = 10 * 7.912
    expect(dcBayUsage(state, install.x, install.y).flopsLive).toBeCloseTo(rated)
    expect(fleetStats(state).flopsPf).toBeCloseTo(rated)
    expect(fleetStats(state).tokPerSec).toBeGreaterThan(0)
  })

  it('never resurrects placed but disconnected racks at partial throughput', () => {
    const base = withHall('dc')
    const install = base.player.rackFleet[0]!
    const facilityId = 'disconnected-fixture-hall'
    const unitIds = Array.from({ length: install.count }, (_, index) => `${install.id}:unit:${String(index + 1).padStart(4, '0')}`)
    const layout = createDefaultHallLayout(facilityId, 'hall-small-v1', [], 96)
    const disconnected = {
      ...layout,
      objects: [
        ...layout.objects,
        ...unitIds.map((unitId, index) => ({
          id: `rack:${unitId}`,
          kind: 'rack' as const,
          catalogId: install.skuId,
          rackUnitId: unitId,
          x: 8 + index * 5,
          z: 24,
          rotation: 0 as const,
          purchasePrice: 0,
        })),
      ],
      analysis: {
        ...layout.analysis,
        operationalRackUnitIds: [],
        offlineRackUnitIds: unitIds,
        throughputMultiplier: 0.55,
      },
    }
    const state: SimState = {
      ...base,
      map: {
        ...base.map,
        tiles: base.map.tiles.map((tile) => tile.x === install.x && tile.y === install.y ? { ...tile, campusId: facilityId } : tile),
      },
      player: {
        ...base.player,
        rackFleet: [{ ...install, facilityId, unitIds }],
      },
      dataHallLayouts: { [facilityId]: disconnected },
    }
    expect(fleetStats(state).flopsPf).toBe(0)
    expect(fleetStats(state).tokPerSec).toBe(0)
  })
})
