import { describe, expect, it } from 'vitest'
import { defaultPostTrainGyms } from '../balance/modelStudio'
import { buildScaledModel } from '../balance/modelBuild'
import { createGame } from '../createGame'
import { emptyTrainingState, withTrainingState } from '../training/state'
import type {
  DataPruneJob,
  PlanDayStats,
  PlanModelUsage,
  SimState,
  SynthGenJob,
} from '../types'
import { computeSnapshot } from './compute'
import {
  buildComputeBreakdown,
  researchComputeUsage,
  servePoolLoad,
  trainPoolLoad,
} from './computeBreakdown'
import { startTraining } from './training'

function withSynth(state: SimState, share: number): SimState {
  const job: SynthGenJob = {
    id: 'synth-test',
    domain: 'chat',
    modelId: 'teacher',
    modelName: 'Teacher',
    targetMTok: 0,
    progressMTok: 0,
    continuous: true,
    researchShare: share,
    qualityTier: 'lq',
  }
  return {
    ...state,
    player: {
      ...state.player,
      data: { ...state.player.data, synthQueue: [job] },
    },
  }
}

function withPrune(state: SimState, share: number): SimState {
  const job: DataPruneJob = {
    id: 'prune-test',
    domain: 'chat',
    rawRemaining: 10,
    processedRemaining: 10,
    rawTotal: 10,
    processedTotal: 10,
    cashPerMTok: 1,
    pfDaysPerMTok: 0.1,
    researchersRequired: 1,
    engineersRequired: 1,
    researchShare: share,
    qualityBefore: 40,
  }
  return {
    ...state,
    player: {
      ...state.player,
      data: { ...state.player.data, pruneQueue: [job] },
    },
  }
}

function withGymDraw(state: SimState, share: number): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      postTrainGyms: defaultPostTrainGyms().map((gym) =>
        gym.kind === 'code'
          ? {
              ...gym,
              tier: 1,
              assignedResearchers: 2,
              researchShare: share,
            }
          : gym,
      ),
    },
  }
}

describe('researchComputeUsage', () => {
  it('treats an idle lab as unused research PF', () => {
    const state = createGame(8_401)
    const usage = researchComputeUsage(state)

    expect(usage.usedPf).toBe(0)
    expect(usage.slices).toEqual([])
    expect(usage.poolPf).toBeGreaterThan(0)
    expect(usage.powerMw).toBe(0)
  })

  it('counts synthetic generation as research-pool use', () => {
    const idle = createGame(8_402)
    const active = withSynth(idle, 0.25)
    const idleUsage = researchComputeUsage(idle)
    const usage = researchComputeUsage(active)

    expect(usage.usedPf).toBeGreaterThan(idleUsage.usedPf)
    expect(usage.usedPf).toBeCloseTo(usage.poolPf * 0.25, 8)
    expect(usage.slices).toEqual([
      expect.objectContaining({ id: 'synthetic', short: 'synth', share: 0.25 }),
    ])
    expect(buildComputeBreakdown(active).research.utilizationLabel).toBe(
      'Synthetic data',
    )
    expect(buildComputeBreakdown(active).research.summary).toMatch(/Synthetic data/)
    expect(buildComputeBreakdown(idle).research.utilizationLabel).toBe('Idle')
  })

  it('counts corpus audits, gyms, and safety alongside tech/pods', () => {
    let state = withPrune(createGame(8_403), 0.08)
    state = withGymDraw(state, 0.2)
    state = {
      ...state,
      player: {
        ...state.player,
        staff: { researcher: 4, engineer: 2, data_processor: 2, ops: 0 },
        safetyCampaign: {
          id: 'safety-test',
          modelId: 'm1',
          modelName: 'Pilot',
          intensity: 'standard',
          assignedResearchers: 2,
          minimumResearchers: 2,
          targetTrainingPfDays: 10,
          targetResearchPfDays: 8,
          progressTrainingPfDays: 0,
          progressResearchPfDays: 0,
          cashBudget: 1_000_000,
          cashSpent: 0,
          safetyDataMTok: 0,
          safetyDataQuality: 70,
          startDay: 1,
        },
        activeResearch: {
          nodeId: 'dense_basics',
          progressPfDays: 1,
          daysSpent: 1,
        },
      },
    }
    const usage = researchComputeUsage(state)
    const ids = usage.slices.map((slice) => slice.id)

    expect(ids).toContain('tree')
    expect(ids).toContain('prune')
    expect(ids).toContain('gyms')
    expect(ids).toContain('safety')
    expect(usage.usedPf).toBeGreaterThan(0)
    expect(usage.usedPf).toBeLessThanOrEqual(usage.poolPf + 1e-9)
    expect(buildComputeBreakdown(state).research.utilization).toBeGreaterThan(0)
  })

  it('does not treat leftover tech capacity as used while only synth is running', () => {
    const usage = researchComputeUsage(withSynth(createGame(8_404), 0.3))
    expect(usage.slices.map((slice) => slice.id)).toEqual(['synthetic'])
    expect(usage.idlePf).toBeGreaterThan(0)
    expect(usage.techAvailablePf).toBeGreaterThan(usage.usedPf)
  })
})

describe('research duty vs usage', () => {
  it('engages research MW when synthetic work is queued', () => {
    const idle = createGame(8_405)
    const active = withSynth(idle, 0.4)
    expect(computeSnapshot(idle).mwBreakdown.research).toBe(0)
    expect(researchComputeUsage(active).usedPf).toBeGreaterThan(0)
    expect(researchComputeUsage(idle).usedPf).toBe(0)
  })
})

function released(id: string, name: string, paramsB: number, capability: number) {
  const model = buildScaledModel({
    id,
    name,
    paramsB,
    family: 'dense',
    day: 1,
    dataCoverage: 30,
    dataQuality: 75,
  })
  return {
    ...model,
    capability,
    release: 'released' as const,
    shipped: true,
    commerciallyOffered: true,
  }
}

function usage(
  modelId: string,
  name: string,
  dayMTok: number,
  dayInferPf: number,
  share = 1,
): PlanModelUsage {
  return { modelId, name, dayMTok, dayInferPf, share, costPerMTok: 0.1 }
}

function planDay(partial: {
  planId: string
  name: string
  subscribers: number
  dayMTok: number
  dayInferPf: number
  modelUsage?: PlanModelUsage[]
  isFree?: boolean
}): PlanDayStats {
  return {
    planId: partial.planId,
    name: partial.name,
    subscribers: partial.subscribers,
    dayRevenue: 0,
    dayCogs: 0,
    allocatedComputeCostDay: 0,
    dayMTok: partial.dayMTok,
    dayInferPf: partial.dayInferPf,
    computePfPerSubscriber:
      partial.subscribers > 0 ? partial.dayInferPf / partial.subscribers : 0,
    modelUsage: partial.modelUsage,
    costPerSubDay: 0,
    marginPerSubMonth: 0,
    isFree: partial.isFree ?? false,
    usageRate: 0.6,
  }
}

function withLiveServing(seed: number): SimState {
  const base = createGame(seed)
  const alpha = released('model-alpha', 'Alpha', 8, 62)
  const beta = released('model-beta', 'Beta', 70, 88)
  const plans = base.player.pricing.plans.map((plan) => {
    if (plan.id === 'plan-plus') {
      return {
        ...plan,
        modelIds: [alpha.id],
        servePrecision: 'int8' as const,
        servePrecisionByModel: { [alpha.id]: 'int8' as const },
      }
    }
    if (plan.id === 'plan-pro') {
      return {
        ...plan,
        modelIds: [beta.id],
        servePrecision: 'fp16' as const,
        servePrecisionByModel: { [beta.id]: 'fp16' as const },
      }
    }
    return { ...plan, enabled: false, modelIds: [] }
  })
  return {
    ...base,
    player: {
      ...base.player,
      models: [alpha, beta],
      pricing: {
        ...base.player.pricing,
        activeModelId: alpha.id,
        apiModelIds: [alpha.id, beta.id],
        apiVsSubPriority: 0.5,
        apiServePrecisionByModel: {
          [alpha.id]: 'fp8',
          [beta.id]: 'fp16',
        },
        plans,
      },
    },
    lastMarket: {
      ...base.lastMarket,
      capacityPf: 100,
      servedPf: 70,
      apiPoolPf: 50,
      subPoolPf: 50,
      apiVsSubPriority: 0.5,
      apiDayMTok: 7,
      servedMTok: 40,
      playerDemandMTok: 40,
      apiModelUsage: [
        usage(alpha.id, alpha.name, 5, 10, 0.67),
        usage(beta.id, beta.name, 2, 5, 0.33),
      ],
      planStats: [
        planDay({
          planId: 'plan-plus',
          name: 'Plus',
          subscribers: 1_200,
          dayMTok: 18,
          dayInferPf: 20,
          modelUsage: [usage(alpha.id, alpha.name, 18, 20, 1)],
        }),
        planDay({
          planId: 'plan-pro',
          name: 'Pro',
          subscribers: 80,
          dayMTok: 12,
          dayInferPf: 15,
          modelUsage: [usage(beta.id, beta.name, 12, 15, 1)],
        }),
      ],
    },
  }
}

describe('servePoolLoad', () => {
  it('reports pool used/allocated from lastMarket PF and splits API vs subs', () => {
    const state = withLiveServing(8_410)
    const load = servePoolLoad(state)
    expect(load.allocatedPf).toBeCloseTo(100, 8)
    expect(load.usedPf).toBeCloseTo(70, 8)
    expect(load.fill).toBeCloseTo(0.7, 8)
    expect(load.apiUsedPf + load.subUsedPf).toBeCloseTo(70, 8)
    expect(load.apiUsedPf / load.subUsedPf).toBeCloseTo(15 / 35, 5)
    expect(load.idlePf).toBeCloseTo(30, 8)
    expect(load.warn).toBe(false)
  })

  it('keeps per-model allocated vs used and hover mix aligned with planStats + apiModelUsage', () => {
    const state = withLiveServing(8_411)
    const breakdown = buildComputeBreakdown(state)
    const load = breakdown.load.serve
    const alpha = load.models.find((row) => row.modelId === 'model-alpha')
    const beta = load.models.find((row) => row.modelId === 'model-beta')

    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(alpha!.usedPf).toBeCloseTo(30, 8)
    expect(alpha!.apiUsedPf).toBeCloseTo(10, 8)
    expect(alpha!.subUsedPf).toBeCloseTo(20, 8)
    expect(beta!.usedPf).toBeCloseTo(20, 8)
    expect(beta!.apiUsedPf).toBeCloseTo(5, 8)
    expect(beta!.subUsedPf).toBeCloseTo(15, 8)
    expect(alpha!.allocatedPf).toBeGreaterThan(0)
    expect(beta!.allocatedPf).toBeGreaterThan(0)
    expect(alpha!.allocatedPf + beta!.allocatedPf).toBeCloseTo(100, 5)
    expect(alpha!.idlePf).toBeCloseTo(Math.max(0, alpha!.allocatedPf - 30), 8)
    expect(alpha!.unserved).toBe(alpha!.usedPf > alpha!.allocatedPf + 1e-9)
    expect(breakdown.serve.utilization).toBeCloseTo(load.fill, 8)

    const alphaApi = alpha!.planMix.find((entry) => entry.kind === 'api')
    const alphaPlus = alpha!.planMix.find((entry) => entry.planId === 'plan-plus')
    const betaPro = beta!.planMix.find((entry) => entry.planId === 'plan-pro')

    expect(alphaApi?.apiMTok).toBe(5)
    expect(alphaApi?.usedPf).toBeCloseTo(10, 8)
    expect(alphaApi?.precision).toBe('fp8')
    expect(alphaPlus?.subscribers).toBe(1_200)
    expect(alphaPlus?.usedPf).toBeCloseTo(20, 8)
    expect(alphaPlus?.shareOfModelSubPf).toBeCloseTo(1, 8)
    expect(alphaPlus?.precision).toBe('int8')
    expect(betaPro?.subscribers).toBe(80)
    expect(betaPro?.usedPf).toBeCloseTo(15, 8)
    expect(betaPro?.shareOfModelSubPf).toBeCloseTo(1, 8)
    expect(betaPro?.precision).toBe('fp16')
    expect(alpha!.planMix.some((entry) => entry.planId === 'plan-pro')).toBe(false)
  })

  it('marks a model unserved when used PF exceeds its allocated share', () => {
    const state = withLiveServing(8_412)
    const overloaded: SimState = {
      ...state,
      lastMarket: {
        ...state.lastMarket,
        servedPf: 400,
        apiModelUsage: [
          usage('model-alpha', 'Alpha', 200, 220, 1),
          usage('model-beta', 'Beta', 10, 10, 1),
        ],
        planStats: [
          planDay({
            planId: 'plan-plus',
            name: 'Plus',
            subscribers: 9_000,
            dayMTok: 80,
            dayInferPf: 90,
            modelUsage: [usage('model-alpha', 'Alpha', 80, 90, 1)],
          }),
          planDay({
            planId: 'plan-pro',
            name: 'Pro',
            subscribers: 80,
            dayMTok: 4,
            dayInferPf: 5,
            modelUsage: [usage('model-beta', 'Beta', 4, 5, 1)],
          }),
        ],
      },
    }
    const alpha = servePoolLoad(overloaded).models.find(
      (row) => row.modelId === 'model-alpha',
    )!
    expect(alpha.usedPf).toBeGreaterThan(alpha.allocatedPf)
    expect(alpha.fill).toBeGreaterThan(1)
    expect(alpha.unserved).toBe(true)
    expect(alpha.warn).toBe(true)
    expect(alpha.idlePf).toBe(0)
  })
})

describe('trainPoolLoad', () => {
  it('uses train/safety PF burn over the train pool instead of a binary in-use flag', () => {
    const idle = createGame(8_420)
    expect(trainPoolLoad(idle).fill).toBe(0)
    expect(trainPoolLoad(idle).jobs).toEqual([])
    expect(buildComputeBreakdown(idle).train.utilization).toBe(0)

    const running = startTraining(
      { ...idle, player: { ...idle.player, cash: 5_000_000_000 } },
      { name: 'Pilot', family: 'dense', paramsB: 1, computePriority: 80 },
    )
    const load = trainPoolLoad(running)
    expect(load.jobs).toHaveLength(1)
    expect(load.jobs[0]?.name).toMatch(/Pilot/)
    expect(load.usedPf).toBeGreaterThan(0)
    expect(load.poolPf).toBeGreaterThan(0)
    expect(load.fill).toBeCloseTo(load.usedPf / load.poolPf, 8)
    expect(buildComputeBreakdown(running).train.utilization).toBeCloseTo(
      load.fill,
      8,
    )
    expect(buildComputeBreakdown(running).train.lines.some((line) => line.label === 'Pilot' || line.label.includes('Pilot'))).toBe(true)
  })

  it('treats an unblocked FP32 job as occupying the train pool, not leaving format-derated PF idle', () => {
    const idle = createGame(8_421)
    const running = startTraining(
      { ...idle, player: { ...idle.player, cash: 5_000_000_000 } },
      { name: 'Occupancy', family: 'dense', paramsB: 1, computePriority: 80 },
    )
    const load = trainPoolLoad(running)
    const breakdown = buildComputeBreakdown(running)

    expect(load.jobs).toHaveLength(1)
    expect(load.usedPf).toBeGreaterThan(0)
    expect(load.fill).toBeGreaterThan(0.98)
    expect(load.idlePf).toBeLessThan(0.001)
    expect(load.usefulPf).toBeGreaterThan(0)
    expect(load.usefulPf).toBeLessThan(load.usedPf * 0.7)
    expect(breakdown.train.utilization).toBeCloseTo(load.fill, 8)
    expect(breakdown.train.utilizationLabel).toBe('In use')
    expect(breakdown.train.lines.some((line) => line.label === 'Idle')).toBe(false)
    expect(
      breakdown.train.lines.some((line) => line.label === 'Useful burn'),
    ).toBe(true)
  })

  it('counts a running V4 post-train recipe against the train pool', () => {
    const idle = createGame(8_422)
    const state = withTrainingState(idle, idle.playerLabId, {
      ...emptyTrainingState(),
      recipes: [
        {
          id: 'recipe-v4',
          labId: idle.playerLabId,
          checkpointId: 'ck',
          stages: ['instruct'],
          safetyFocus: 0,
          gymIds: [],
          budgetPfDays: 4,
          dataUse: {
            instructionMTok: 1,
            preferenceMTok: 0,
            verifiableTasks: 0,
            toolTrajectories: 0,
          },
          startDay: 1,
          progress: 0.2,
          pfDaysDone: 0.5,
          status: 'running',
          forecast: {
            pfDays: 4,
            days: 8,
            cash: 60_000,
            deltas: {},
            unlocksTiers: false,
            adequacy: {},
            warnings: [],
          },
          seed: 1,
        },
      ],
    })
    const load = trainPoolLoad(state)
    expect(load.jobs.some((job) => job.id === 'recipe-v4')).toBe(true)
    expect(load.usedPf).toBeGreaterThan(0)
    expect(load.fill).toBeGreaterThan(0)
    const breakdown = buildComputeBreakdown(state)
    expect(breakdown.train.utilizationLabel).toBe('In use')
    expect(
      breakdown.train.lines.some((line) => line.label.includes('Post-train')),
    ).toBe(true)
  })
})

describe('research load hover consumers', () => {
  it('exposes the same research-pool consumers as the Research Pool tile', () => {
    const state = withGymDraw(withSynth(createGame(8_430), 0.25), 0.2)
    const breakdown = buildComputeBreakdown(state)
    expect(breakdown.load.research.slices.map((slice) => slice.id).sort()).toEqual(
      researchComputeUsage(state).slices.map((slice) => slice.id).sort(),
    )
    expect(breakdown.research.utilization).toBeCloseTo(
      breakdown.load.research.poolPf > 0
        ? breakdown.load.research.usedPf / breakdown.load.research.poolPf
        : 0,
      8,
    )
    expect(breakdown.research.lines.some((line) => line.label === 'Synthetic data')).toBe(
      true,
    )
    expect(breakdown.research.lines.some((line) => line.label === 'Post-train gyms')).toBe(
      true,
    )
  })
})

