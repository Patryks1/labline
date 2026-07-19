import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { SimState, TileKind } from '../types'
import { dcBayUsage } from './dcRacks'
import { fleetStats } from './racks'

function withHall(kind: TileKind): SimState {
  const state = createGame(97_201)
  const site = state.map.tiles.find(
    (tile) => tile.kind === 'empty' && tile.owner === 'neutral' && tile.regionId !== 'void',
  )!
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
    expect(dcBayUsage(state, state.player.rackFleet[0]!.x, state.player.rackFleet[0]!.y).flopsLive)
      .toBeCloseTo(17)
    expect(fleetStats(state).flopsPf).toBeCloseTo(17)
  })

  it.each(['dc_m', 'dc_l'] as const)('doubles PF and throughput for %s campuses', (kind) => {
    const state = withHall(kind)
    const install = state.player.rackFleet[0]!
    expect(dcBayUsage(state, install.x, install.y).flopsLive).toBeCloseTo(34)
    expect(fleetStats(state).flopsPf).toBeCloseTo(34)
    expect(fleetStats(state).tokPerSec).toBe(56_000)
  })
})
