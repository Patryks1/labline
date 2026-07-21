import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildScaledModel } from '../balance/modelBuild'
import type { SimState } from '../types'
import {
  safetyCampaignEstimate,
  startSafetyCampaign,
  tickSafetyCampaign,
} from './safetyCampaigns'
import { startTraining, tickTraining } from './training'

function campaignState(): SimState {
  const initial = createGame(819)
  const model = buildScaledModel({
    id: 'safe-model',
    name: 'Sentinel',
    paramsB: 1,
    family: 'dense',
    day: initial.day,
    dataCoverage: 2,
    dataQuality: 75,
    postTrain: 'rlhf',
    shipped: true,
    release: 'released',
  })
  const tiles = initial.map.tiles.map((tile) => {
    if (tile.x === 2 && tile.y === 2) {
      return {
        ...tile,
        kind: 'dc' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 512,
        racksUsed: 0,
        mwCapacity: 80,
        opexPerDay: 72_000,
      }
    }
    if (tile.x === 3 && tile.y === 2) {
      return {
        ...tile,
        kind: 'substation' as const,
        owner: 'player' as const,
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: 80,
        opexPerDay: 15_000,
      }
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
      staff: {
        researcher: 10,
        data_processor: initial.player.staff?.data_processor ?? 1,
        engineer: initial.player.staff?.engineer ?? 3,
        ops: initial.player.staff?.ops ?? 1,
      },
      rackFleet: [{
        id: 'safe-fleet', skuId: 'rack_h100', x: 2, y: 2, count: 64,
        status: 'live', daysLeft: 0, paidEach: 165_000, rackUnits: 1,
      }],
      allocation: { training: 0.45, inference: 0.1, research: 0.45 },
      pricing: { ...initial.player.pricing, activeModelId: model.id },
    },
  }
}

describe('repeatable safety campaigns', () => {
  it('reports the research gate and shares compute with concurrent base training', () => {
    const locked = createGame(818)
    const missingModel = safetyCampaignEstimate(locked, 'missing', 'targeted')
    expect(missingModel.ok).toBe(false)

    const started = startSafetyCampaign(campaignState(), {
      modelId: 'safe-model', intensity: 'targeted', researchers: 6,
    })
    expect(started.player.safetyCampaign?.modelId).toBe('safe-model')
    const concurrent = startTraining(started, {
      name: 'Concurrent', family: 'dense', paramsB: 0.4,
    })
    expect(concurrent.player.trainingJob?.name).toBe('Concurrent')
    const advanced = tickTraining(concurrent)
    expect(advanced.player.trainingJob?.progressPfDays).toBeGreaterThan(0)
    expect(advanced.player.safetyCampaign?.modelId).toBe('safe-model')
  })

  it('runs multiple model jobs concurrently at an equal, slower compute share', () => {
    const started = startTraining(campaignState(), { name: 'Alpha', family: 'dense', paramsB: 70 })
    // Compare allocated work rather than completion-capped progress: a deliberately
    // undertrained 70B v2 recipe can otherwise finish inside a single tick.
    const first = {
      ...started,
      player: {
        ...started.player,
        trainingJob: started.player.trainingJob
          ? { ...started.player.trainingJob, targetPfDays: 1_000 }
          : null,
        trainingJobs: started.player.trainingJobs?.map((job) => ({
          ...job,
          targetPfDays: 1_000,
        })),
      },
    }
    const soloProgress = tickTraining(first).player.trainingJob!.progressPfDays
    const withSecond = startTraining(first, { name: 'Beta', family: 'dense', paramsB: 70 })
    const parallel = {
      ...withSecond,
      player: {
        ...withSecond.player,
        trainingJob: withSecond.player.trainingJob
          ? { ...withSecond.player.trainingJob, targetPfDays: 1_000 }
          : null,
        trainingJobs: withSecond.player.trainingJobs?.map((job) => ({
          ...job,
          targetPfDays: 1_000,
        })),
      },
    }
    expect(parallel.player.trainingJobs).toHaveLength(2)
    const advanced = tickTraining(parallel)
    expect(advanced.player.trainingJobs?.[0]?.progressPfDays).toBeCloseTo(advanced.player.trainingJobs?.[1]?.progressPfDays ?? -1)
    expect(advanced.player.trainingJobs?.[0]?.progressPfDays ?? 0).toBeLessThan(soloProgress)
  })

  it('updates the same model id as a new revision', () => {
    let state = startSafetyCampaign(campaignState(), {
      modelId: 'safe-model', intensity: 'targeted', researchers: 8,
    })
    const originalId = state.player.models[0]!.id
    const originalRevision = state.player.models[0]!.revision ?? 1
    const originalSafety = state.player.models[0]!.benchmarks.safety
    for (let day = 0; day < 120 && state.player.safetyCampaign; day += 1) {
      state = tickSafetyCampaign({ ...state, day: state.day + 1 })
    }
    expect(state.player.safetyCampaign).toBeNull()
    expect(state.player.models[0]!.id).toBe(originalId)
    expect(state.player.models[0]!.revision).toBe(originalRevision + 1)
    expect(state.player.models[0]!.benchmarks.safety).toBeGreaterThan(originalSafety)
    expect(state.player.models[0]!.safetyTraining?.revisions).toHaveLength(1)
  })
})
