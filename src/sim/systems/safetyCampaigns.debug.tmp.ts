
import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildScaledModel } from '../balance/modelBuild'
import type { SimState } from '../types'
import { computeSnapshot } from './compute'
import { startSafetyCampaign, tickSafetyCampaign } from './safetyCampaigns'

function campaignState(): SimState {
  const initial = createGame(819)
  const model = buildScaledModel({
    id: 'safe-model', name: 'Sentinel', paramsB: 1, family: 'dense', day: initial.day,
    dataCoverage: 2, dataQuality: 75, postTrain: 'rlhf', shipped: true, release: 'released',
  })
  const tiles = initial.map.tiles.map((tile) => {
    if (tile.x === 2 && tile.y === 2) {
      return { ...tile, kind: 'dc' as const, owner: 'player' as const, buildingProgress: 1, buildingTarget: 1, rackCapacity: 512, racksUsed: 0, mwCapacity: 80, opexPerDay: 72_000 }
    }
    if (tile.x === 3 && tile.y === 2) {
      return { ...tile, kind: 'substation' as const, owner: 'player' as const, buildingProgress: 1, buildingTarget: 1, mwCapacity: 80, opexPerDay: 15_000 }
    }
    return tile
  })
  return {
    ...initial,
    map: { ...initial.map, tiles },
    player: {
      ...initial.player,
      cash: 1e9,
      models: [model],
      researchUnlocked: [...initial.player.researchUnlocked, 'align_rlhf'],
      staff: { researcher: 10, data_processor: initial.player.staff?.data_processor ?? 1, engineer: initial.player.staff?.engineer ?? 3, ops: initial.player.staff?.ops ?? 1 },
      rackFleet: [{ id: 'safe-fleet', skuId: 'rack_h100', x: 2, y: 2, count: 64, status: 'live', daysLeft: 0, paidEach: 165_000, rackUnits: 1 }],
      allocation: { training: 0.45, inference: 0.1, research: 0.45 },
      pricing: { ...initial.player.pricing, activeModelId: model.id },
    },
  }
}

describe('debug', () => {
  it('prints pools and progress', () => {
    const base = campaignState()
    const snap = computeSnapshot(base)
    console.log('pools', snap.pools)
    let state = startSafetyCampaign(base, { modelId: 'safe-model', intensity: 'targeted', researchers: 8 })
    console.log('campaign', state.player.safetyCampaign)
    const after = tickSafetyCampaign({ ...state, day: state.day + 1 })
    console.log('after pools', computeSnapshot(after).pools)
    console.log('after campaign', after.player.safetyCampaign)
    expect(true).toBe(true)
  })
})
