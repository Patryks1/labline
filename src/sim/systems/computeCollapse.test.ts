import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { ComputeContract, Model, SimState, TrainingJob } from '../types'
import {
  OUTBOUND_LOCAL_RESIDUAL_SHARE,
  computeSnapshot,
} from './compute'
import { setAutomationPolicies } from './automation'
import { tickAutomation } from './automation'

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

function withRemoteContract(state: SimState, pf: number): SimState {
  const contract: ComputeContract = {
    id: 'collapse-cloud',
    providerId: 'cloud-northstar',
    providerName: 'Northstar Compute',
    buyerLabId: state.playerLabId,
    sellerLabId: 'cloud-northstar',
    kind: 'on_demand',
    regionId: state.labs[state.playerLabId]!.regionId,
    pf,
    pricePerPfDay: 100,
    daysLeft: 30,
    daysTotal: 30,
    interruptionRisk: 0,
    terminationFee: 0,
    status: 'active',
    signedDay: state.day,
  }
  return {
    ...state,
    computeContracts: [contract],
    computeLeases: [],
    player: {
      ...state.player,
      rackFleet: [],
      chips: [],
      deployedRacks: [],
    },
  }
}

describe('compute capacity collapse fixes', () => {
  it('keeps train/research remote PF when serve memory does not fit remote', () => {
    const base = createGame(91_001)
    const model = releasedModel('huge-serve', 800)
    let state = withRemoteContract(base, 4)
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        pricing: {
          ...state.player.pricing,
          activeModelId: model.id,
          apiModelIds: [model.id],
        },
        allocation: { training: 0.4, inference: 0.4, research: 0.2 },
        utilCap: 0.5,
      },
      lastMarket: {
        ...state.lastMarket,
        demandPf: 0,
        servedPf: 0,
      },
    }
    const snap = computeSnapshot(state)
    expect(snap.remoteFlopsPf).toBeGreaterThan(0)
    expect(snap.fullRawPool).toBeGreaterThan(0.05)
    expect(snap.pools.training).toBeGreaterThan(0.05)
    // Inference may be 0 when remote cannot fit serve weights; train must remain.
  })

  it('floors utilCap so zero util cannot wipe all pools', () => {
    const base = createGame(91_002)
    const state = withRemoteContract(
      {
        ...base,
        player: { ...base.player, utilCap: 0, allocation: { training: 0.5, inference: 0.3, research: 0.2 } },
      },
      24,
    )
    const snap = computeSnapshot(state)
    expect(snap.effectiveUtil).toBeGreaterThanOrEqual(0.2)
    expect(snap.effectiveFlopsPf).toBeGreaterThan(0)
  })

  it('retains residual local capacity when outbound would otherwise consume all', () => {
    const created = createGame(91_003)
    // Place live racks without a hall layout so fleetStats counts full install.
    const x = 10
    const y = 10
    const state: SimState = {
      ...created,
      computeContracts: [],
      computeLeases: [
        {
          id: 'sell-all',
          rivalId: created.rivals[0]?.id ?? 'rival-a',
          pf: 10_000,
          pricePerPfDay: 1,
          daysLeft: 30,
          daysTotal: 30,
          from: 'player',
          playerSells: true,
          status: 'active',
          sellerLabId: created.playerLabId,
          buyerLabId: created.rivals[0]?.id ?? 'rival-a',
        },
      ],
      player: {
        ...created.player,
        utilCap: 0.5,
        allocation: { training: 0.5, inference: 0.3, research: 0.2 },
        rackFleet: [
          {
            id: 'lease-fleet',
            skuId: 'rack_h100',
            x,
            y,
            count: 8,
            status: 'live',
            daysLeft: 0,
            paidEach: 165_000,
            rackUnits: 1,
          },
        ],
      },
    }
    const snap = computeSnapshot(state)
    expect(OUTBOUND_LOCAL_RESIDUAL_SHARE).toBeGreaterThan(0)
    expect(snap.localFleetPf).toBeGreaterThan(0)
    expect(snap.leasedOutPf).toBeGreaterThan(snap.localFleetPf)
    expect(snap.pools.training).toBeGreaterThan(0)
  })

  it('keeps training pool under high serve demand when allocation requests training', () => {
    const base = createGame(91_004)
    const model = releasedModel('busy-serve', 7)
    let state = withRemoteContract(base, 100)
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        pricing: {
          ...state.player.pricing,
          activeModelId: model.id,
          apiModelIds: [model.id],
        },
        allocation: { training: 0.4, inference: 0.35, research: 0.25 },
        utilCap: 0.55,
      },
      lastMarket: {
        ...state.lastMarket,
        demandPf: 10_000,
        servedPf: 10_000,
        capacityPf: 50,
      },
    }
    const snap = computeSnapshot(state)
    expect(snap.fullRawPool).toBeGreaterThan(0.05)
    expect(snap.pools.training).toBeGreaterThan(0.05)
  })

  it('automation treats trainingJobs as active training', () => {
    const base = createGame(91_005)
    const job = {
      id: 'job-1',
      name: 'Run',
      family: 'dense',
      targetParamsB: 7,
      progressPfDays: 1,
      targetPfDays: 100,
      paused: false,
    } as TrainingJob
    let state = withRemoteContract(base, 50)
    state = setAutomationPolicies(state, {
      allocation: { enabled: true, inferenceHeadroom: 0.2 },
    })
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: null,
        trainingJobs: [job],
        allocation: { training: 0.5, inference: 0.3, research: 0.2 },
      },
      lastMarket: {
        ...state.lastMarket,
        demandPf: 200,
        capacityPf: 50,
      },
    }
    state = tickAutomation(state)
    // Without trainingJobs detection, automation would push nearly all remainder
    // away from training under high demand; with it, training keeps weight.
    expect(state.player.allocation.training).toBeGreaterThan(0.12)
    expect(state.player.allocation.inference).toBeLessThan(0.85)
  })
})
