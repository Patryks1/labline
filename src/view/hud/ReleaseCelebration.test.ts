import { describe, expect, it } from 'vitest'
import type { Model } from '../../sim/types'
import type { CheckpointEvaluationReport } from '../../sim/balance/checkpointEvaluation'
import { measuredReleaseEvidence, releasedModelForEvent } from './releaseReview'

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
