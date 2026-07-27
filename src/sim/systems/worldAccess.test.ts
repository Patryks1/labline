import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { TERRAIN_KIND, type Facility, type TileId } from '../world'
import { selectionFootprintTiles } from './worldAccess'

describe('selectionFootprintTiles', () => {
  it('returns the complete facility footprint when any occupied cell is selected', () => {
    const state = createGame({
      seed: 2048,
      advanced: { mapWidth: 48, mapHeight: 48, cityCount: 2, rivalCount: 1 },
    })
    const world = state.map.world!
    let footprint: TileId[] | undefined
    for (let y = 1; y < state.map.height - 1 && !footprint; y++) {
      for (let x = 1; x < state.map.width - 2; x++) {
        const first = (y * state.map.width + x) as TileId
        const second = (first + 1) as TileId
        if ([first, second].every((id) =>
          world.getKind(id) === TERRAIN_KIND.empty &&
          world.getTransport(id) === 0 &&
          !world.getFacilityAt(id))) {
          footprint = [first, second]
          break
        }
      }
    }
    expect(footprint).toBeDefined()
    const facility: Facility = {
      id: 'selection-footprint-test',
      kind: 'dc_m',
      ownerId: 'player',
      anchor: footprint![0]!,
      footprint: footprint!,
      level: 1,
      constructionProgress: 1,
      constructionTarget: 1,
      powered: true,
    }
    world.beginBatch().addFacility(facility).commit()

    const selected = footprint![1]!
    expect(selectionFootprintTiles(
      state,
      selected % state.map.width,
      Math.floor(selected / state.map.width),
    ).map((tile) => [tile.x, tile.y])).toEqual(
      footprint!.map((id) => [id % state.map.width, Math.floor(id / state.map.width)]),
    )
  })

  it('keeps ordinary selectable terrain as a single-cell footprint', () => {
    const state = createGame({
      seed: 99,
      advanced: { mapWidth: 32, mapHeight: 32, cityCount: 2, rivalCount: 1 },
    })
    const world = state.map.world!
    const id = world.staticWorld.kind.findIndex((kind, index) =>
      kind === TERRAIN_KIND.empty && world.getTransport(index as TileId) === 0)
    const x = id % state.map.width
    const y = Math.floor(id / state.map.width)

    expect(selectionFootprintTiles(state, x, y).map((tile) => [tile.x, tile.y])).toEqual([[x, y]])
  })
})
