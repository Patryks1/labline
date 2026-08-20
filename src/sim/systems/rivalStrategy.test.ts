import { describe, expect, it } from 'vitest'
import { getResearchNode } from '../balance/research'
import { DEFAULT_TRAINING_NUMERICS } from '../balance/trainingPrecision'
import { createGame } from '../createGame'
import type { RivalControllerState } from '../types'
import {
  advanceRivalStrategy,
  campusPlanFromProjection,
  chooseRivalDcSize,
  chooseRivalScaleCandidate,
  chooseRivalServePrecision,
  chooseRivalTrainingNumerics,
  planRivalResearchPath,
  projectRivalTrainingInfrastructure,
  rivalActionSeed,
  RIVAL_SCALE_LADDER_PARAMS_B,
  type RivalInfraUnitCosts,
  type RivalScalePlanningContext,
} from './rivalStrategy'

const TEST_UNIT_COSTS: RivalInfraUnitCosts = {
  rackPf: 7.912,
  rackPrice: 313_500,
  interconnectCostPerMw: 52_000_000 / 14,
  generationCostPerMw: 48_000_000 / 18,
  hallCash: { small: 128_000_000, medium: 520_000_000, large: 2_450_000_000 },
  hallRacks: { small: 96, medium: 288, large: 960 },
}

/** Rich hyperscale lab that can justify climbing past the 22B rung. */
function richScaleContext(
  overrides: Partial<RivalScalePlanningContext> = {},
): RivalScalePlanningContext {
  return {
    archetype: 'hyperscale',
    researchUnlocked: ['dense_basics', 'moe_routing', 'opt_mixed'],
    currentParamsB: 34,
    currentCapability: 18,
    frontierCapability: 32,
    corpusMTok: 2_500_000,
    cash: 4_000_000_000,
    dailyOperatingBurn: 200_000,
    expectedTrainPfPerDay: 120,
    totalPf: 200,
    trainEfficiency: 1,
    researchMult: 1.15,
    numerics: DEFAULT_TRAINING_NUMERICS,
    activationCheckpointing: true,
    availableHbmGb: 80_000,
    availableSystemRamGb: 64_000,
    pue: 1.25,
    hostingUtilization: 0.4,
    marketShare: 0.12,
    inferenceAllocation: 0.35,
    dataQuality: 1,
    mixWeights: { code: 0.35, math: 0.25, web: 0.4 },
    modalityComputeMult: 1,
    isCatchUpChallenger: true,
    rackCapacityBays: 288,
    racksUsed: 40,
    mwSupplyCapacity: 80,
    mwDemand: 25,
    unitCosts: TEST_UNIT_COSTS,
    ...overrides,
  }
}

describe('layered rival strategy', () => {
  it('uses stable lab/action-local decision seeds', () => {
    const a = rivalActionSeed(44, 'rival_nova', 3, 90, 'tactical', 'pricing')
    const b = rivalActionSeed(44, 'rival_nova', 3, 90, 'tactical', 'pricing')
    const otherAction = rivalActionSeed(
      44,
      'rival_nova',
      3,
      90,
      'tactical',
      'marketing',
    )
    const otherLab = rivalActionSeed(44, 'rival_open', 3, 90, 'tactical', 'pricing')
    expect(a).toBe(b)
    expect(a).not.toBe(otherAction)
    expect(a).not.toBe(otherLab)
  })

  it('plans a legal topological prerequisite path with strategic utility', () => {
    const state = createGame(721)
    const rival = {
      ...state.rivals.find((candidate) => candidate.archetype === 'efficiency')!,
      researchUnlocked: ['dense_basics'],
      researchQueue: [],
      activeResearch: null,
      lastUnserved: 0.35,
    }
    const strategy: RivalControllerState = {
      ...advanceRivalStrategy(rival, state),
      goal: 'improve_efficiency',
      plan: [],
    }
    const path = planRivalResearchPath(rival, strategy, state.seed)
    expect(path.length).toBeGreaterThan(0)

    const satisfied = new Set(rival.researchUnlocked)
    for (const nodeId of path) {
      const node = getResearchNode(nodeId)
      expect(node.prereqs.every((prereq) => satisfied.has(prereq))).toBe(true)
      satisfied.add(nodeId)
    }
  })

  it('persists bounded goals, beliefs, plans, and revisions across ticks', () => {
    const state = createGame(722)
    const rival = state.rivals[0]!
    const first = advanceRivalStrategy(rival, state)
    const second = advanceRivalStrategy(
      { ...rival, strategy: first },
      { ...state, day: state.day + 1 },
    )
    expect(first.profileId).toBe(rival.archetype)
    expect(first.plan.length).toBeGreaterThan(0)
    expect(second.lastOperationalDay).toBe(state.day + 1)
    expect(second.decisionRevision).toBeGreaterThanOrEqual(first.decisionRevision)
    expect(second.memory.length).toBeLessThanOrEqual(32)
  })

  it('uses researched quantization under pressure but preserves safety posture', () => {
    const state = createGame(723)
    const efficiency = {
      ...state.rivals.find((candidate) => candidate.archetype === 'efficiency')!,
      researchUnlocked: ['dense_basics', 'sys_batching', 'sys_quant', 'sys_fp8'],
      lastUnserved: 0.4,
    }
    expect(chooseRivalServePrecision(efficiency)).toBe('int4')
    expect(
      chooseRivalServePrecision({
        ...efficiency,
        archetype: 'safety',
      }),
    ).toBe('int8')
    expect(
      chooseRivalServePrecision({
        ...efficiency,
        researchUnlocked: ['dense_basics'],
      }),
    ).toBe('fp16')
  })

  it('chooses training numerics only when both research and hardware support them', () => {
    const state = createGame(724)
    const template = state.rivals.find((candidate) => candidate.archetype === 'efficiency')!
    expect(chooseRivalTrainingNumerics(template, 'dense').computeFormat).toBe('fp32')

    const fp8Ready = {
      ...template,
      researchUnlocked: [
        ...template.researchUnlocked,
        'opt_mixed',
        'opt_fp8_train',
      ],
    }
    expect(chooseRivalTrainingNumerics(fp8Ready, 'dense')).toMatchObject({
      computeFormat: 'fp8_hybrid',
      nativeWeightFormat: 'float',
    })

    const ternaryReady = {
      ...fp8Ready,
      researchUnlocked: [...fp8Ready.researchUnlocked, 'dense_bitnet'],
    }
    expect(chooseRivalTrainingNumerics(ternaryReady, 'dense')).toMatchObject({
      computeFormat: 'bf16_mixed',
      nativeWeightFormat: 'ternary_1_58',
    })

    const blackwellReady = {
      ...fp8Ready,
      researchUnlocked: [...fp8Ready.researchUnlocked, 'opt_nvfp4_train'],
      rackFleet: [
        {
          id: 'rival-b200',
          skuId: 'rack_b200',
          x: 0,
          y: 0,
          count: 1,
          status: 'live' as const,
          daysLeft: 0,
          paidEach: 1,
          rackUnits: 1,
        },
      ],
    }
    expect(chooseRivalTrainingNumerics(blackwellReady, 'dense').computeFormat).toBe('nvfp4')
  })
})

describe('rival scale ladder and infrastructure (workstream 6)', () => {
  it('exposes the full parameter ladder from 22B into the multi-T band', () => {
    expect(RIVAL_SCALE_LADDER_PARAMS_B[0]).toBe(22)
    expect(RIVAL_SCALE_LADDER_PARAMS_B).toContain(405)
    expect(RIVAL_SCALE_LADDER_PARAMS_B[RIVAL_SCALE_LADDER_PARAMS_B.length - 1]).toBe(
      5_000,
    )
  })

  it('respects an era ceiling when listing candidates', () => {
    const decision = chooseRivalScaleCandidate(
      richScaleContext({ currentParamsB: 34, maxParamsB: 120 }),
      { family: 'dense', backbone: 'dense' },
    )
    expect(decision.candidates.every((c) => c.paramsB <= 120 * 1.001)).toBe(true)
  })

  it('evaluates ladder sizes beyond 22B when resources justify a climb', () => {
    const decision = chooseRivalScaleCandidate(richScaleContext(), {
      family: 'dense',
      backbone: 'dense',
    })
    const sizes = decision.candidates.map((c) => c.paramsB)
    expect(sizes.some((p) => p > 22)).toBe(true)
    expect(sizes).toEqual(expect.arrayContaining([70, 110, 180]))
    // Catch-up hyperscale with deep corpus/cash should plan above the entry rung.
    expect(decision.planned?.paramsB).toBeGreaterThan(22)
    expect(decision.planned?.utility).toBeGreaterThan(0)
    expect(decision.planned?.affordable).toBe(true)
    expect(decision.planned?.fitsRiskStrategy).toBe(true)
  })

  it('projects PF, HBM, power, data, and rack demand before training starts', () => {
    const ctx = richScaleContext({
      availableHbmGb: 2_000,
      availableSystemRamGb: 1_500,
      mwSupplyCapacity: 10,
      mwDemand: 9,
      hostingUtilization: 0.85,
    })
    const decision = chooseRivalScaleCandidate(ctx, {
      family: 'dense',
      backbone: 'dense',
    })
    const target = decision.planned ?? decision.candidates.at(-1)
    expect(target).toBeTruthy()
    const projection = projectRivalTrainingInfrastructure(ctx, target!)
    expect(projection.requiredFleetPf).toBeGreaterThan(0)
    expect(projection.trainingPfDays).toBeGreaterThan(0)
    expect(projection.requiredHbmGb).toBeGreaterThan(0)
    expect(projection.requiredSystemRamGb).toBeGreaterThan(0)
    expect(projection.requiredMw).toBeGreaterThan(0)
    expect(projection.dataRequiredMTok).toBeGreaterThan(0)
    expect(projection.projectedRackDemand).toBeGreaterThanOrEqual(ctx.racksUsed)
    expect(Object.keys(projection.dataRequiredByDomain).length).toBeGreaterThan(0)
    expect(projection.triggers.length).toBeGreaterThan(0)

    const campus = campusPlanFromProjection({
      day: 120,
      decisionRevision: 2,
      archetype: ctx.archetype,
      projection,
    })
    expect(campus.targetParamsB).toBe(projection.paramsB)
    expect(campus.projectedHbmGb).toBe(projection.requiredHbmGb)
    expect(campus.projectedMwDemand).toBe(projection.requiredMw)
    expect(campus.projectedDataMTok).toBe(projection.dataRequiredMTok)
    expect(['dc', 'dc_m', 'dc_l']).toContain(campus.dcSize)
  })

  it('selects dc / dc_m / dc_l from projected bay demand', () => {
    expect(chooseRivalDcSize(50, 'efficiency')).toBe('dc')
    expect(chooseRivalDcSize(100, 'efficiency')).toBe('dc')
    expect(chooseRivalDcSize(300, 'efficiency')).toBe('dc')
    expect(chooseRivalDcSize(100, 'efficiency', 1)).toBe('dc_m')
    expect(chooseRivalDcSize(300, 'efficiency', 1)).toBe('dc_m')
    expect(chooseRivalDcSize(300, 'efficiency', 2)).toBe('dc_l')
    // Hyperscalers build one tier ahead once they already have a live hall.
    expect(chooseRivalDcSize(60, 'hyperscale')).toBe('dc')
    expect(chooseRivalDcSize(60, 'hyperscale', 1)).toBe('dc_m')
    expect(chooseRivalDcSize(180, 'hyperscale', 2)).toBe('dc_l')
  })

  it('never selects a candidate that fails the HBM memory gate', () => {
    const ctx = richScaleContext({
      availableHbmGb: 50,
      availableSystemRamGb: 40,
    })
    const decision = chooseRivalScaleCandidate(ctx, {
      family: 'dense',
      backbone: 'dense',
    })
    for (const candidate of decision.candidates) {
      if (!candidate.memoryFitsNow) {
        expect(decision.selected?.paramsB).not.toBe(candidate.paramsB)
      }
    }
    if (decision.selected) {
      expect(decision.selected.memoryFitsNow).toBe(true)
    }
    // With near-zero HBM, larger builds stay planned (build-ahead) not selected.
    if (decision.planned && !decision.planned.memoryFitsNow) {
      expect(decision.selected).toBeNull()
      expect(decision.heldReason).toBe('memory')
    }
  })

  it('rejects data-starved candidates via the risk strategy gate', () => {
    const ctx = richScaleContext({
      archetype: 'safety',
      currentParamsB: 22,
      isCatchUpChallenger: false,
      corpusMTok: 5_000,
      cash: 800_000_000,
    })
    const decision = chooseRivalScaleCandidate(ctx, {
      family: 'dense',
      backbone: 'dense',
    })
    for (const candidate of decision.candidates) {
      expect(candidate.dataShortfallRisk).toBeGreaterThan(0.5)
      expect(candidate.fitsRiskStrategy).toBe(false)
    }
    expect(decision.planned).toBeNull()
    expect(decision.selected).toBeNull()
    expect(decision.heldReason).toBe('no_positive_utility')
  })

  it('is deterministic for a fixed planning context', () => {
    const ctx = richScaleContext()
    const topology = { family: 'dense' as const, backbone: 'dense' as const }
    const a = chooseRivalScaleCandidate(ctx, topology)
    const b = chooseRivalScaleCandidate(ctx, topology)
    expect(a.candidates.map((c) => [c.paramsB, c.utility, c.affordable])).toEqual(
      b.candidates.map((c) => [c.paramsB, c.utility, c.affordable]),
    )
    expect(a.selected?.paramsB).toBe(b.selected?.paramsB)
    expect(a.planned?.paramsB).toBe(b.planned?.paramsB)
    expect(a.heldReason).toBe(b.heldReason)

    const target = a.planned!
    const p1 = projectRivalTrainingInfrastructure(ctx, target)
    const p2 = projectRivalTrainingInfrastructure(ctx, target)
    expect(p1).toEqual(p2)
    expect(
      campusPlanFromProjection({
        day: 40,
        decisionRevision: 1,
        archetype: 'hyperscale',
        projection: p1,
      }),
    ).toEqual(
      campusPlanFromProjection({
        day: 40,
        decisionRevision: 1,
        archetype: 'hyperscale',
        projection: p2,
      }),
    )
  })
})
