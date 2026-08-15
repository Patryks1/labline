import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { roundTripState } from '../save'
import { tileCoords } from '../world'
import { autoArrangeRacksInDc, moveRackInDc, rackLayoutOnDc } from './dcRacks'

describe('manual rack layout persistence', () => {
  it('round-trips an exact manual bay move through a v11 save', () => {
    let state = createGame({
      seed: 10011,
      difficulty: 'easy',
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const rival = state.rivals[0]!
    const facility = state.map.world!.queryFacilities({ ownerId: rival.id, kind: 'dc' })[0]!
    const { x, y } = tileCoords(facility.anchor, state.map.width)
    state.map.world!.beginBatch().updateFacility(facility.id, { ownerId: state.playerLabId }).commit()
    state = {
      ...state,
      player: {
        ...state.player,
        rackFleet: [{
          id: 'manual-install', skuId: 'rack_h100', facilityId: facility.id,
          x, y, count: 2, rackUnits: 1, status: 'live', daysLeft: 0, paidEach: 1,
        }],
      },
    }

    state = moveRackInDc(state, x, y, 'manual-install:rack:0002', 35)
    expect(state.player.rackFleet[0]!.bayStarts).toEqual([0, 35])
    const beforeLayout = rackLayoutOnDc(state, x, y)!.layout

    const restored = roundTripState(state)
    expect(restored.player.rackFleet[0]!.facilityId).toBe(facility.id)
    expect(restored.player.rackFleet[0]!.bayStarts).toEqual([0, 35])
    expect(rackLayoutOnDc(restored, x, y)!.layout).toEqual(beforeLayout)

    const arranged = autoArrangeRacksInDc(restored, x, y)
    expect(arranged.player.rackFleet[0]!.bayStarts).toEqual([0, 1])
  })
})
