import { describe, expect, it } from 'vitest'
import { createGame } from '../sim/createGame'
import { tileCoords } from '../sim/world'
import { useGameStore } from './gameStore'

describe('facility market store actions', () => {
  it('submits and withdraws a cash-backed unsolicited bid', () => {
    const state = createGame({
      seed: 819,
      difficulty: 'easy',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const before = state.player.cash
    useGameStore.setState({ state })

    useGameStore.getState().submitFacilityOffer(facility.id, 1_000_000)
    const offered = useGameStore.getState().state
    expect(offered.player.cash).toBe(before - 1_000_000)
    expect(offered.facilityMarket!.offers.at(-1)).toMatchObject({ status: 'pending', escrow: 1_000_000 })

    useGameStore.getState().withdrawFacilityOffer(offered.facilityMarket!.offers.at(-1)!.id)
    expect(useGameStore.getState().state.player.cash).toBe(before)
    expect(useGameStore.getState().state.facilityMarket!.offers.at(-1)!.status).toBe('withdrawn')
  })

  it('uses the compatibility action to buy a listed hall now', () => {
    const state = createGame({
      seed: 821,
      difficulty: 'easy',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, { forSale: true, listPrice: 1_000_000 }).commit()
    useGameStore.setState({
      state: {
        ...state,
        player: { ...state.player, cash: 2_000_000 },
        labs: { ...state.labs, [state.playerLabId]: { ...state.labs[state.playerLabId]!, cash: 2_000_000 } },
      },
    })

    useGameStore.getState().buyRivalDataCenter(x, y)

    expect(useGameStore.getState().state.map.world!.facilitiesById.get(facility.id)!.ownerId).toBe(state.playerLabId)
    expect(useGameStore.getState().state.facilityMarket!.offers.at(-1)!.status).toBe('accepted')
  })
})
