import { describe, expect, it } from 'vitest'
import type { BenchmarkScores, Model, QualityAxes } from '../types'
import { applyBenchmarkPolicy, evaluationMarketsForModel, normalizeModelEvaluations } from './evaluationSuites'

const scores = (value = 90): BenchmarkScores => ({
  mmlu: value,
  coding: value,
  math: value,
  vision: value,
  law: value,
  health: value,
  science: value,
  multilingual: value,
  agents: value,
  safety: value,
})

const quality: QualityAxes = {
  reasoning: 90,
  coding: 90,
  chat: 90,
  image: 90,
  video: 90,
  safety: 90,
  reliability: 90,
}

describe('central benchmark policy', () => {
  it('moves non-reasoning code and math ceilings from 40 to 60 with intelligence', () => {
    const small = applyBenchmarkPolicy({
      scores: scores(), intelligence: 0.35, capability: 90, family: 'moe', quality,
      reasoningEnabled: false, toolsEnabled: true,
    })
    const scaled = applyBenchmarkPolicy({
      scores: scores(), intelligence: 0.8, capability: 90, family: 'moe', quality,
      reasoningEnabled: false, toolsEnabled: true,
    })
    expect(small.coding).toBe(40)
    expect(small.math).toBe(40)
    expect(scaled.coding).toBe(60)
    expect(scaled.math).toBe(60)
    expect(scaled.science).toBe(40)
  })

  it('removes the non-reasoning ceiling after reasoning training', () => {
    const result = applyBenchmarkPolicy({
      scores: scores(), intelligence: 0.35, capability: 90, family: 'moe', quality,
      reasoningEnabled: true, toolsEnabled: true, scienceDataQuality: 100,
    })
    expect(result.coding).toBe(90)
    expect(result.math).toBe(90)
    expect(result.science).toBeGreaterThan(40)
    expect(result.agents).toBe(90)
  })

  it('applies dense vision and tools gates', () => {
    const dense = applyBenchmarkPolicy({
      scores: scores(), intelligence: 0.8, capability: 90, family: 'dense', quality,
      reasoningEnabled: true, toolsEnabled: false, imageDataQualityFactor: 0.6,
    })
    const diffusion = applyBenchmarkPolicy({
      scores: scores(), intelligence: 0.8, capability: 90, family: 'diffusion', quality,
      reasoningEnabled: true, toolsEnabled: true, imageDataQualityFactor: 0.1,
    })
    expect(dense.vision).toBe(46)
    expect(dense.agents).toBe(35)
    expect(diffusion.vision).toBe(90)
    expect(diffusion.agents).toBe(25)
  })

  it('penalizes low-quality health evidence nonlinearly', () => {
    const curated = applyBenchmarkPolicy({
      scores: scores(80), intelligence: 0.8, capability: 80, family: 'moe', quality,
      reasoningEnabled: true, toolsEnabled: true, healthLowQualityShare: 0.1,
    })
    const lowQuality = applyBenchmarkPolicy({
      scores: scores(80), intelligence: 0.8, capability: 80, family: 'moe', quality,
      reasoningEnabled: true, toolsEnabled: true, healthLowQualityShare: 1,
    })
    expect(curated.health).toBe(80)
    expect(lowQuality.health).toBeCloseTo(44)
  })
})

describe('public modality eval markets', () => {
  const checkpoint = (family: Model['family'], productPreset: Model['productPreset']): Model =>
    normalizeModelEvaluations({
      id: `${family}-${productPreset}`,
      name: productPreset ?? family,
      family,
      backbone: family === 'diffusion' || family === 'video' ? 'diffusion' : 'dense',
      productPreset,
      io: productPreset === 'omni'
        ? { inputs: { text: 60, image: 60, audio: 60, video: 60 }, outputs: { text: 60, image: 60, audio: 60, video: 60 }, tools: 60 }
        : productPreset === 'image_generation'
          ? { inputs: { text: 60 }, outputs: { image: 60 }, tools: 0 }
          : { inputs: { text: 60 }, outputs: { text: 60 }, tools: 0 },
      paramsB: 7,
      capability: 60,
      modalities: productPreset === 'omni' ? ['text', 'image', 'audio', 'video', 'tools'] : productPreset === 'image_generation' ? ['text', 'image'] : ['text'],
      quality,
      benchmarks: scores(60),
      postTrain: 'rlhf',
      releaseDay: 1,
      shipped: true,
      release: 'released',
      tokPerSecMult: 0.7,
      inferCostMult: 1,
      trainComputeSpent: 1,
    } as Model)

  it('cross-lists omni across language, image, video, and audio boards', () => {
    expect(evaluationMarketsForModel(checkpoint('omni', 'omni'))).toEqual([
      'language', 'image', 'video', 'audio',
    ])
    expect(evaluationMarketsForModel(checkpoint('diffusion', 'image_generation'))).toEqual(['image'])
  })
})
