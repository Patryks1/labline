import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { placeBuilding } from './map'
import {
  CHIP_DESIGN_AREA_BUDGET,
  scoreChipDesign,
  setChipDesignFocus,
  startFabCampaign,
  toggleChipDesignTech,
} from './silicon'

describe('chip architecture design', () => {
  it('makes training and inference focus meaningfully different', () => {
    const training = scoreChipDesign('training', [])
    const inference = scoreChipDesign('inference', [])
    expect(training.trainingMult).toBeGreaterThan(inference.trainingMult)
    expect(inference.inferenceMult).toBeGreaterThan(training.inferenceMult)
    expect(inference.powerMult).toBeLessThan(training.powerMult)
  })

  it('enforces research gates and the die-area budget', () => {
    let state = createGame({
      seed: 7_201,
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const locked = toggleChipDesignTech(state, 'hbm_fabric')
    expect(locked.player.fab.designTechIds).toEqual([])

    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...state.player.researchUnlocked,
          'si_arch',
          'si_hbm_stack',
          'si_chiplets',
          'si_photonic_io',
        ],
      },
    }
    state = toggleChipDesignTech(state, 'matrix_array')
    state = toggleChipDesignTech(state, 'hbm_fabric')
    state = toggleChipDesignTech(state, 'chiplet_mesh')
    expect(scoreChipDesign('balanced', state.player.fab.designTechIds).usedArea).toBe(
      CHIP_DESIGN_AREA_BUDGET,
    )
    const overflow = toggleChipDesignTech(state, 'optical_io')
    expect(overflow.player.fab.designTechIds).toEqual(state.player.fab.designTechIds)
  })

  it('freezes the selected architecture when a completed fab starts a campaign', () => {
    let state = createGame({
      seed: 7_202,
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 2_000_000_000,
        researchUnlocked: [...state.player.researchUnlocked, 'si_arch'],
      },
    }
    const open = state.map.tiles.find(
      (tile) => tile.kind === 'empty' && (tile.owner === 'neutral' || tile.owner === 'player'),
    )!
    state = placeBuilding(state, open.x, open.y, 'fab')
    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === open.x && tile.y === open.y
            ? { ...tile, buildingProgress: tile.buildingTarget }
            : tile,
        ),
      },
    }
    state = setChipDesignFocus(state, 'training')
    state = toggleChipDesignTech(state, 'matrix_array')
    const started = startFabCampaign(state)
    expect(started.player.fab.phase).toBe('architecture')
    expect(started.player.fab.designFocus).toBe('training')
    expect(started.player.fab.designTechIds).toEqual(['matrix_array'])
    expect(started.player.fab.designPerfPerWatt).toBeGreaterThan(2.2)
  })
})
