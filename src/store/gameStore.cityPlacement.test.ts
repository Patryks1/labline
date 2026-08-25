import { describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { canPlaceBuilding } from '../sim/systems/map'
import { mapTileAtAny } from '../sim/systems/worldAccess'
import { planUrbanInfill } from '../sim/world/urbanInfill'
import { tileCoords } from '../sim/world/ids'
import { useGameStore } from './gameStore'

describe('map placement store callback', () => {
  it('routes an eligible city infill click through the authoritative placement check', () => {
    const initial = createGame({
      seed: 88_401,
      difficulty: 'easy',
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 4, rivalCount: 0 },
    })
    const world = initial.map.world!
    const parcel = planUrbanInfill(world.staticWorld).parcels.find((candidate) => {
      const { x, y } = tileCoords(candidate.anchorTileId, world.descriptor.width)
      return canPlaceBuilding(initial, x, y, 'hq').ok
    })
    expect(parcel).toBeDefined()
    const { x, y } = tileCoords(parcel!.anchorTileId, world.descriptor.width)

    useGameStore.setState({
      phase: 'playing',
      state: { ...initial, player: { ...initial.player, cash: 2_000_000_000 } },
      buildMode: 'hq',
      selectedTile: null,
    })
    useGameStore.getState().selectTile(x, y)

    const placed = mapTileAtAny(useGameStore.getState().state, x, y)
    expect(placed?.kind).toBe('hq')
    expect(useGameStore.getState().selectedTile).toEqual({ x, y })
  })
})

