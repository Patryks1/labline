import { describe, expect, it } from 'vitest'
import { inferenceCapacityMTok } from '../balance/serveCompute'
import { createGame } from '../createGame'
import type { ComputeContract, Model, SimState } from '../types'
import { computeSnapshot } from './compute'
import { servingPlacementNeed } from './servingPlacement'

function releasedModel(id: string, paramsB: number): Model {
  return {
    id,
    name: id,
    family: 'dense',
    backbone: 'dense',
    paramsB,
    activeParamsB: paramsB,
    inferCostMult: 1,
    tokPerSecMult: 1,
    release: 'released',
    shipped: true,
  } as Model
}

function localServingState(
  models: Model[],
  chipCount: number,
  precision: 'fp16' | 'int4' = 'fp16',
): SimState {
  const created = createGame(88_410 + models.length + chipCount)
  const active = models[0]!
  return {
    ...created,
    computeContracts: [],
    computeLeases: [],
    player: {
      ...created.player,
      models,
      chips: [{ defId: 'gen2', count: chipCount, arriving: [] }],
      rackFleet: [],
      deployedRacks: [],
      pricing: {
        ...created.player.pricing,
        activeModelId: active.id,
        apiModelIds: models.map((model) => model.id),
        apiServePrecisionByModel: Object.fromEntries(
          models.map((model) => [model.id, precision]),
        ),
        plans: created.player.pricing.plans.map((plan) => ({
          ...plan,
          enabled: false,
          modelIds: [],
        })),
      },
    },
    lastMarket: {
      ...created.lastMarket,
      demandPf: 0,
      servedPf: 0,
      capacityPf: 0,
      playerDemandMTok: 0,
    },
  }
}

function capacity(state: SimState): number {
  const model = state.player.models[0]!
  return inferenceCapacityMTok(
    computeSnapshot(state),
    model,
    state.player.servingEfficiency,
  )
}

describe('local serving memory derating', () => {
  it('admits no local tokens until the full deployment fits in HBM', () => {
    const model = releasedModel('dense-100b', 100)
    const short = localServingState([model], 1)
    const fit = localServingState([model], 3)

    expect(servingPlacementNeed(short).hbmNeedGb).toBeGreaterThan(80)
    expect(computeSnapshot(short).rawFlopsPf).toBeGreaterThan(0)
    expect(computeSnapshot(short).serveMemFit).toBe(0)
    expect(capacity(short)).toBe(0)
    expect(capacity(fit)).toBeGreaterThan(0)
    expect(computeSnapshot(fit).serveMemFit).toBe(1)
  })

  it('makes host RAM a separate derating constraint for many resident products', () => {
    const models = Array.from({ length: 20 }, (_, index) =>
      releasedModel(`small-${index}`, 0.1),
    )
    const ramShort = localServingState(models, 2)
    const ramFit = localServingState(models, 3)
    const need = servingPlacementNeed(ramShort)

    expect(need.hbmNeedGb).toBeLessThanOrEqual(160)
    expect(need.systemRamNeedGb).toBeGreaterThan(256)
    expect(computeSnapshot(ramShort).vramDerateServe).toBe(1)
    expect(computeSnapshot(ramShort).serveMemFit).toBe(0)
    expect(capacity(ramShort)).toBe(0)
    expect(capacity(ramFit)).toBeGreaterThan(0)
    expect(computeSnapshot(ramFit).serveMemFit).toBe(1)
  })

  it('allows quantization to restore a deployment that cannot fit at FP16', () => {
    const model = releasedModel('quantized-100b', 100)
    const fp16 = localServingState([model], 1, 'fp16')
    const int4 = localServingState([model], 1, 'int4')

    expect(servingPlacementNeed(int4).hbmNeedGb).toBeLessThan(
      servingPlacementNeed(fp16).hbmNeedGb,
    )
    expect(capacity(fp16)).toBe(0)
    expect(capacity(int4)).toBeGreaterThan(capacity(fp16))
  })

  it('keeps off-site provider PF usable when the local deployment cannot fit', () => {
    const model = releasedModel('cloud-100b', 100)
    const localOnly = localServingState([model], 1)
    const contract: ComputeContract = {
      id: 'memory-isolated-cloud',
      providerId: 'cloud-northstar',
      providerName: 'Northstar Compute',
      buyerLabId: localOnly.playerLabId,
      sellerLabId: 'cloud-northstar',
      kind: 'on_demand',
      regionId: localOnly.labs[localOnly.playerLabId]!.regionId,
      pf: 10,
      pricePerPfDay: 120,
      daysLeft: 30,
      daysTotal: 30,
      interruptionRisk: 0,
      terminationFee: 0,
      status: 'active',
      signedDay: localOnly.day,
    }
    const cloud = {
      ...localOnly,
      computeContracts: [contract],
    }

    // Local weights cannot fit at all; the provider contract brings a
    // separately provisioned accelerator-memory envelope that can host them.
    expect(capacity(localOnly)).toBe(0)
    expect(computeSnapshot(cloud).pools.inference).toBeGreaterThan(0)
    expect(capacity(cloud)).toBeGreaterThan(capacity(localOnly))
  })
})
