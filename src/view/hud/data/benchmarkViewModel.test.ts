import { describe, expect, it } from 'vitest'
import type { Model } from '../../../sim/types'
import {
  benchmarkMetricsForSuite,
  buildBenchmarkViewModel,
  buildPublicBenchmarkData,
  publicBenchmarkScore,
  publicBenchmarkScores,
} from './benchmarkViewModel'

function fixtureModel(): Model {
  return {
    family: 'dense',
    capability: 60,
    quality: {
      reasoning: 55,
      coding: 58,
      chat: 62,
      image: 35,
      video: 20,
      safety: 70,
      reliability: 65,
    },
    benchmarks: {
      mmlu: 72,
      coding: 68,
      math: 64,
      vision: 30,
      law: 55,
      health: 60,
      science: 50,
      multilingual: 58,
      agents: 40,
      safety: 70,
    },
    modalities: ['text'],
  } as Model
}

describe('buildBenchmarkViewModel', () => {
  it('uses the canonical public evaluation suite and profile', () => {
    const model = fixtureModel()

    const view = buildBenchmarkViewModel(model, 'language', { kind: 'public' })

    expect(view.source).toBe('public')
    expect(view.metrics.length).toBeGreaterThan(0)
    expect(view.profile.mmlu).toBeDefined()
    expect(view.scores.mmlu).toBeDefined()
  })

  it('keeps private evidence explicit instead of falling back to public model fields', () => {
    const model = fixtureModel()

    const view = buildBenchmarkViewModel(
      { ...model, benchmarks: { ...model.benchmarks, mmlu: 99 } },
      'language',
      { kind: 'private-evidence' },
    )

    expect(view.source).toBe('private-evidence')
    expect(view.scores).toEqual({})
    expect(view.profile).toEqual({})
  })

  it('normalizes legacy models and returns an empty projection for missing suites or metrics', () => {
    const model = fixtureModel()

    expect(buildPublicBenchmarkData(model).suites.language).toBeDefined()
    expect(publicBenchmarkScore(model, 'language', 'mmlu')).toBeDefined()
    expect(publicBenchmarkScores(model, 'video_generation')).toEqual({})
    expect(
      publicBenchmarkScore(model, 'video_generation', 'visual_quality'),
    ).toBeUndefined()
    expect(benchmarkMetricsForSuite('video_generation')).toHaveLength(6)
  })

  it('provides deterministic public peer scores through the same adapter', () => {
    const baseline = fixtureModel()
    const peer = {
      ...fixtureModel(),
      capability: 82,
      benchmarks: { ...fixtureModel().benchmarks, mmlu: 88 },
    } as Model
    const scores = [baseline, peer].map((model) =>
      publicBenchmarkScore(model, 'language', 'mmlu') ?? 0,
    )

    expect(scores[1]).toBeGreaterThan(scores[0]!)
    expect([...scores].sort((a, b) => b - a)).toEqual([scores[1], scores[0]])
  })

  it('uses only explicitly supplied private evidence and profile', () => {
    const model = fixtureModel()
    const view = buildBenchmarkViewModel(model, 'language', {
      kind: 'private-evidence',
      scores: { mmlu: 12 },
      profile: {
        mmlu: {
          ceiling: 20,
          positive: 'Measured evidence',
          penalty: 'Private interval',
        },
      },
    })

    expect(view.scores).toEqual({ mmlu: 12 })
    expect(view.profile.mmlu?.ceiling).toBe(20)
    expect(view.scores.mmlu).not.toBe(model.benchmarks.mmlu)
  })
})
