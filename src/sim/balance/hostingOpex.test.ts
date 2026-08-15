import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { Model, ServePrecision, SimState } from '../types'
import { servingPlacementNeed } from '../systems/servingPlacement'
import { hostedModelOpexDay, HOSTING_MIN_REPLICAS } from './hostingOpex'

function hostedState(precision: ServePrecision): SimState {
  const created = createGame(98_601)
  const model = {
    id: 'resident-70b',
    name: 'Resident 70B',
    family: 'dense',
    backbone: 'dense',
    paramsB: 70,
    activeParamsB: 70,
    capability: 60,
    inferCostMult: 1,
    tokPerSecMult: 1,
    release: 'released',
    shipped: true,
  } as Model
  return {
    ...created,
    player: {
      ...created.player,
      models: [model],
      pricing: {
        ...created.player.pricing,
        activeModelId: model.id,
        apiModelIds: [model.id],
        apiServePrecisionByModel: { [model.id]: precision },
        plans: created.player.pricing.plans.map((plan) => ({
          ...plan,
          enabled: false,
          modelIds: [],
        })),
      },
    },
    lastMarket: {
      ...created.lastMarket,
      playerDemandMTok: 100,
    },
  }
}

describe('hosted model residency opex', () => {
  it('prices actual routed precision, KV/workspace, and redundant replicas', () => {
    const fp16 = hostedState('fp16')
    const int4 = hostedState('int4')
    const fp16Placement = servingPlacementNeed(fp16).placements[0]!
    const fp16Cost = hostedModelOpexDay(fp16, 0)
    const int4Cost = hostedModelOpexDay(int4, 0)

    expect(fp16Cost.models).toHaveLength(1)
    expect(fp16Cost.models[0]!.precision).toBe('fp16')
    expect(fp16Cost.models[0]!.replicas).toBe(HOSTING_MIN_REPLICAS)
    expect(fp16Cost.models[0]!.residentGb).toBeCloseTo(
      fp16Placement.memory.residentMemoryGb * HOSTING_MIN_REPLICAS,
      12,
    )
    expect(int4Cost.models[0]!.residentGb).toBeLessThan(
      fp16Cost.models[0]!.residentGb,
    )
    expect(int4Cost.residencyDay).toBeLessThan(fp16Cost.residencyDay)
  })
})
