import { describe, expect, it } from 'vitest'
import type { Model } from '../types'
import { instantRecipe } from './modelProduct'
import { estimateBenchmarkTaskCost } from './benchmarkCost'

function model(): Model {
  return {
    id: 'bench-cost', name: 'Bench Cost', family: 'dense', paramsB: 8,
    capability: 60, modalities: ['text'], releaseDay: 1,
    quality: { reasoning: 60, coding: 60, chat: 60, image: 20, video: 10, safety: 70, reliability: 65 },
    benchmarks: { mmlu: 60, coding: 60, math: 60, vision: 20, law: 50, health: 50, science: 60, multilingual: 50, agents: 55, safety: 70, personality: 50 },
    productProfile: {
      lifecycle: 'aligned', focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 50, tokenEfficiency: 50, defaultEffortId: 'instant',
      effortRecipes: [
        instantRecipe(),
        { id: 'max', name: 'Max', kind: 'trained', thinkingTokenMult: 100,
          trainPfDays: 100, trainCash: 1_000_000, trained: true, quality: 0.9,
          served: true, capabilityBias: 0.5 },
      ],
    },
    postTrain: 'process', release: 'released', shipped: true,
    inferCostMult: 1, tokPerSecMult: 1,
    apiPricePerMTok: 8, apiPriceInPerMTok: 2, apiPriceOutPerMTok: 20,
    suggestedApiPrice: 8, suggestedApiPriceIn: 2, suggestedApiPriceOut: 20,
  } as Model
}

describe('benchmark task economics', () => {
  it('keeps input fixed while 100x effort increases billed output, PF and latency', () => {
    const source = model()
    const prices = { priceIn: 2, priceOut: 20 }
    const instant = estimateBenchmarkTaskCost(source, 'math', 'instant', prices)
    const max = estimateBenchmarkTaskCost(source, 'math', 'max', prices)

    expect(max.inputTokens).toBe(instant.inputTokens)
    expect(max.billedGeneratedTokens).toBeGreaterThan(instant.billedGeneratedTokens * 50)
    expect(max.cost).toBeGreaterThan(instant.cost * 10)
    expect(max.computePfDays).toBeGreaterThan(instant.computePfDays * 10)
    expect(max.computeIntensityMultiplier).toBeCloseTo(2.75, 6)
    expect(max.estimatedLatencyMs).toBeGreaterThan(instant.estimatedLatencyMs)
    expect(max.estimatedTokensPerSecond).toBeLessThan(instant.estimatedTokensPerSecond)
  })

  it('uses native media list pricing instead of token-equivalent output prices', () => {
    const source = { ...model(), apiPricePerImage: 0.42 }
    const image = estimateBenchmarkTaskCost(
      source,
      'aesthetics',
      'max',
      { priceIn: 2, priceOut: 20 },
    )
    expect(image.billingBasis).toBe('image')
    expect(image.cost).toBe(0.42)
    expect(image.tokenMultiplier).toBe(1)
  })

  it('rejects an unknown effort instead of silently quoting Instant', () => {
    expect(() =>
      estimateBenchmarkTaskCost(
        model(),
        'math',
        'not-trained',
        { priceIn: 2, priceOut: 20 },
      ),
    ).toThrow(/Unknown or untrained benchmark effort recipe/)
  })
})
