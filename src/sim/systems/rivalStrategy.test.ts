import { describe, expect, it } from 'vitest'
import { getResearchNode } from '../balance/research'
import { createGame } from '../createGame'
import type { RivalControllerState } from '../types'
import {
  advanceRivalStrategy,
  chooseRivalServePrecision,
  chooseRivalTrainingNumerics,
  planRivalResearchPath,
  rivalActionSeed,
} from './rivalStrategy'

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
    expect(chooseRivalTrainingNumerics(template, 'dense').computeFormat).toBe('fp16_mixed')

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
