import { describe, expect, it } from 'vitest'
import type { GameConfig } from '../balance/gameConfig'
import { createGame } from '../createGame'
import {
  constructionFastTrackQuote,
  fastTrackConstruction,
} from './facilities'
import { placeBuilding } from './map'

function fundedLegacyGame(seed: number) {
  const created = createGame({ seed, legacyMapFixture: true })
  return {
    ...created,
    player: { ...created.player, cash: 2_000_000_000 },
  }
}

function largeConfig(seed: number): GameConfig {
  return {
    labName: 'Fast Track Lab',
    difficulty: 'normal',
    seed,
    mapWidth: 1_000,
    mapHeight: 1_000,
    cityCount: 8,
    rivalCount: 5,
    economyMult: 1,
    researchCostMult: 1,
    startingCashMult: 1,
    landValueBase: 2_500_000,
    landValueCityPeak: 28_000_000,
  }
}

describe('construction fast-track', () => {
  it('charges a one-time 50% premium and halves remaining legacy construction', () => {
    let state = fundedLegacyGame(9_101)
    const open = state.map.tiles.find(
      (tile) =>
        tile.kind === 'empty' &&
        tile.regionId !== 'void' &&
        (tile.owner === 'neutral' || tile.owner === 'player'),
    )!
    state = placeBuilding(state, open.x, open.y, 'dc')
    const before = state.map.tiles.find((tile) => tile.x === open.x && tile.y === open.y)!
    const cashBefore = state.player.cash
    const quote = constructionFastTrackQuote(state, open.x, open.y)

    expect(quote).toMatchObject({ eligible: true, remainingDays: 42, acceleratedDays: 21 })
    expect(quote.cost).toBe(Math.floor(before.capex * 0.5))

    state = fastTrackConstruction(state, open.x, open.y)
    const accelerated = state.map.tiles.find((tile) => tile.x === open.x && tile.y === open.y)!
    expect(accelerated.buildingTarget).toBe(21)
    expect(accelerated.constructionExpedited).toBe(true)
    expect(accelerated.capex).toBe(before.capex + quote.cost)
    expect(state.player.cash).toBe(cashBefore - quote.cost)

    const cashAfter = state.player.cash
    state = fastTrackConstruction(state, open.x, open.y)
    expect(state.player.cash).toBe(cashAfter)
  })

  it('uses the minimum schedule when halving a short remaining window', () => {
    let state = fundedLegacyGame(9_102)
    const open = state.map.tiles.find(
      (tile) =>
        tile.kind === 'empty' &&
        tile.regionId !== 'void' &&
        (tile.owner === 'neutral' || tile.owner === 'player'),
    )!
    state = placeBuilding(state, open.x, open.y, 'dc')
    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === open.x && tile.y === open.y
            ? { ...tile, buildingProgress: 25 }
            : tile,
        ),
      },
    }

    const quote = constructionFastTrackQuote(state, open.x, open.y)
    expect(quote).toMatchObject({ eligible: true, remainingDays: 17, acceleratedDays: 15 })
    state = fastTrackConstruction(state, open.x, open.y)
    const accelerated = state.map.tiles.find((tile) => tile.x === open.x && tile.y === open.y)!
    expect(accelerated.buildingTarget).toBe(40)
  })

  it('updates compact-world construction through the indexed facility record', () => {
    const created = createGame({ config: largeConfig(9_103) })
    let state = {
      ...created,
      player: { ...created.player, cash: 2_000_000_000 },
    }
    const world = state.map.world!
    const pad = world.staticWorld.starterPads.find(
      (id) => world.getFacilityAt(id) === undefined && world.getKind(id) === 0,
    )!
    const x = pad % state.map.width
    const y = Math.floor(pad / state.map.width)
    state = placeBuilding(state, x, y, 'dc')
    const before = state.map.world!.getFacilityAt(pad)!
    const cashBefore = state.player.cash

    state = fastTrackConstruction(state, x, y)
    const accelerated = state.map.world!.getFacilityAt(pad)!
    expect(accelerated.constructionTarget).toBe(21)
    expect(accelerated.data?.constructionExpedited).toBe(true)
    const premium = Math.floor((before.stats?.capex ?? 0) * 0.5)
    expect(accelerated.stats?.capex).toBe((before.stats?.capex ?? 0) + premium)
    expect(state.player.cash).toBe(cashBefore - premium)
  })
})
