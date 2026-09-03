import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Model } from '../../sim/types'
import type { CheckpointEvaluationReport } from '../../sim/balance/checkpointEvaluation'
import {
  buildModelProductProfile,
  instantRecipe,
} from '../../sim/balance/modelProduct'
import {
  releaseEffortRecipes,
} from './ReleaseCelebration'
import { measuredReleaseEvidence, releasedModelForEvent, diffNewLiveEndpointIds } from './releaseReview'

const releaseSource = readFileSync(
  fileURLToPath(new URL('./ReleaseCelebration.tsx', import.meta.url)),
  'utf8',
)

function model(id: string, name: string, capability: number): Model {
  return {
    id,
    name,
    family: 'dense',
    paramsB: 8,
    capability,
    modalities: ['text'],
    quality: {
      reasoning: capability,
      coding: capability,
      chat: capability,
      image: 0,
      video: 0,
      safety: capability,
      reliability: capability,
    },
    benchmarks: { mmlu: capability },
    benchmarkSuites: { language: { mmlu: capability } },
    checkpointEvaluations: [],
    postTrain: 'none',
    trainComputeSpent: 10,
    releaseDay: 20,
    shipped: true,
    release: 'released',
    tokPerSecMult: 1,
    inferCostMult: 1,
    assignedPodIds: [],
    pilots: [],
    checkpoints: [],
    domainForecasts: {},
    confidence: 0.8,
    integratedMethods: [],
    dataManifestId: null,
  } as unknown as Model
}

function report(modelId: string): CheckpointEvaluationReport {
  return {
    id: `report-${modelId}`,
    modelId,
    modelName: 'New',
    scheduledDay: 18,
    completedDay: 20,
    request: { suiteIds: ['language'], budgetTier: 'standard', mode: 'nda_external' },
    quote: {
      suiteIds: ['language'],
      budgetTier: 'standard',
      mode: 'nda_external',
      spendPerSuite: 100_000,
      suiteCost: 100_000,
      panelCost: 95_000,
      totalCost: 195_000,
      durationDays: 8,
      reviewerCount: 6,
      accuracy: 0.79,
      confidence: 0.85,
      leakRisk: 0.02,
      contaminationRisk: 0.04,
    },
    overallScore: 63.2,
    confidence: 0.85,
    contaminationRisk: 0.04,
    leakRisk: 0.02,
    leakOutcome: 'none',
    flags: [],
    suites: [{
      suiteId: 'language',
      label: 'Language and reasoning',
      score: 63.2,
      low: 59.1,
      high: 67.3,
      accuracy: 0.79,
      confidence: 0.85,
      metrics: [{
        metricId: 'mmlu',
        label: 'Knowledge',
        score: 64,
        low: 59,
        high: 69,
        contaminationSignal: 0.04,
        rival: {
          modelId: 'rival',
          modelName: 'Frontier',
          labName: 'Rival',
          score: 68,
          delta: -4,
          rank: 2,
          fieldSize: 5,
        },
      }],
    }],
    reviews: [],
  }
}

describe('release review evidence', () => {
  it('keys a release by exact model id when revisions share a name', () => {
    const old = model('old', 'New', 99)
    const released = model('new', 'New', 60)

    expect(releasedModelForEvent([old, released], 'new', 'New')).toBe(released)
  })

  it('does not fall back to latent benchmark suites when no report exists', () => {
    const released = model('new', 'New', 99)

    expect(measuredReleaseEvidence(released, ['language'])).toBeNull()
  })

  it('uses only a report attached to the exact released model', () => {
    const released = model('new', 'New', 99)
    released.checkpointEvaluations = [report('old'), report('new')]

    const evidence = measuredReleaseEvidence(released, ['language'])

    expect(evidence?.report.modelId).toBe('new')
    expect(evidence?.suite.score).toBe(63.2)
    expect(evidence?.metrics[0]?.rival?.delta).toBe(-4)
    expect(evidence?.rankLabel).toBe('#2')
  })
})

describe('release celebration listing dialog', () => {
  function releasedWithThinking(): Model {
    return {
      ...model('spark-1', 'Spark', 62),
      commerciallyOffered: false,
      tokPerSecMult: 1,
      suggestedApiPriceIn: 0.8,
      suggestedApiPriceOut: 3.2,
      productProfile: buildModelProductProfile({
        completedPostTrainStages: ['process'],
        chatShare: 0.2,
        chatQuality: 60,
        reasoningEnabled: true,
        researchUnlocked: ['align_process'],
        existing: {
          lifecycle: 'reasoning',
          focus: {
            coding: 0,
            science: 0,
            research: 0,
            personality: 0,
            chat: 0,
          },
          personality: 40,
          tokenEfficiency: 50,
          defaultEffortId: 'high',
          effortRecipes: [
            { ...instantRecipe(), served: true },
            {
              id: 'high',
              name: 'Think',
              kind: 'trained',
              thinkingTokenMult: 4,
              trainPfDays: 8,
              trainCash: 1,
              trained: true,
              quality: 0.8,
              served: true,
              capabilityBias: 0.6,
              trainComputeShare: 0.1,
            },
          ],
        },
      }),
    } as Model
  }

  it('lists Instant for an Instant-only release', () => {
    const released = {
      ...model('spark-0', 'Spark', 50),
      productProfile: buildModelProductProfile({
        chatShare: 0.2,
        chatQuality: 50,
        reasoningEnabled: false,
      }),
    } as Model
    const heads = releaseEffortRecipes(released)
    expect(heads.map((recipe) => recipe.name)).toEqual(['Instant'])
    expect(heads[0]?.kind).toBe('instant')
  })

  it('lists Instant and trained thinking heads for a process-trained release', () => {
    const released = releasedWithThinking()
    const heads = releaseEffortRecipes(released)
    expect(heads.map((recipe) => recipe.name)).toEqual(['Instant', 'Think'])
    expect(heads[1]?.thinkingTokenMult).toBe(4)
  })

  it('keeps listing chrome to API, plans, and peers', () => {
    expect(releaseSource).toContain('isV4ProjectedModel')
    expect(releaseSource).toContain('API listing')
    expect(releaseSource).toContain('data-testid="release-comparable-peers"')
    expect(releaseSource).not.toContain('sm:max-h-36')
    expect(releaseSource).not.toContain('Measured evidence')
    expect(releaseSource).not.toContain('Sell this model')
    expect(releaseSource).not.toContain('Public on evals')
    expect(releaseSource).not.toContain('Hosting floor from energy')
    expect(releaseSource).not.toContain('Release without selling')
    expect(releaseSource).not.toContain("Don't list")
  })
})

describe('V4 live endpoint celebration', () => {
  it('fires once per new live endpoint id', () => {
    const seen = new Set<string>(['ep-old'])
    const endpoints = [
      { id: 'ep-old', status: 'live' as const },
      { id: 'ep-new', status: 'live' as const },
      { id: 'ep-sunset', status: 'sunset' as const },
    ]
    expect(diffNewLiveEndpointIds(seen, endpoints)).toEqual(['ep-new'])
    const next = new Set(seen)
    for (const id of diffNewLiveEndpointIds(seen, endpoints)) next.add(id)
    expect(diffNewLiveEndpointIds(next, endpoints)).toEqual([])
  })
})
