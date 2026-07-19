import { describe, expect, it } from 'vitest'
import type { BenchmarkScores, QualityAxes } from '../types'
import { applyBenchmarkPolicy } from './evaluationSuites'

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
