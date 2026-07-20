import { describe, expect, it } from 'vitest'
import {
  familyServeMult,
  estimateServingWorkload,
  modelServeCostMult,
  mtokPerDayFromTps,
  sizeTokMult,
  tokensPerDayCapacity,
  tokensPerSecForSku,
} from './tokenServe'

const dense400 = {
  paramsB: 0.4,
  activeParamsB: 0.4,
  family: 'dense' as const,
  inferCostMult: 1,
  tokPerSecMult: 1,
}

const dense7 = {
  paramsB: 7,
  activeParamsB: 7,
  family: 'dense' as const,
  inferCostMult: 1,
  tokPerSecMult: 1,
}

const dense1 = {
  paramsB: 1,
  activeParamsB: 1,
  family: 'dense' as const,
  inferCostMult: 1,
  tokPerSecMult: 0.75,
}

const moe70 = {
  paramsB: 70,
  activeParamsB: 8,
  family: 'moe' as const,
  inferCostMult: 1,
  tokPerSecMult: 1,
}

const omni7 = {
  paramsB: 7,
  activeParamsB: 7,
  family: 'omni' as const,
  inferCostMult: 1,
  tokPerSecMult: 1,
}

describe('tokenServe', () => {
  it('family multipliers count MoE routing overhead after active experts', () => {
    expect(familyServeMult('moe')).toBe(1.08)
    expect(familyServeMult('dense')).toBe(1)
    expect(familyServeMult('omni')).toBe(1.5)
  })

  it('400M has much higher sizeTokMult than 7B', () => {
    expect(sizeTokMult(dense400)).toBeGreaterThan(sizeTokMult(dense7) * 2.5)
  })

  it('400M costs much less to serve than 7B', () => {
    const c400 = modelServeCostMult(dense400)
    const c7 = modelServeCostMult(dense7)
    expect(c400).toBeLessThan(c7 * 0.45)
  })

  it('omni is more expensive than dense at same params', () => {
    expect(modelServeCostMult(omni7)).toBeGreaterThan(modelServeCostMult(dense7) * 1.3)
  })

  it('MoE uses active params (cheaper than dense 70B)', () => {
    const dense70 = { ...dense7, paramsB: 70, activeParamsB: 70 }
    expect(modelServeCostMult(moe70)).toBeLessThan(modelServeCostMult(dense70))
  })

  it('converts effective PF-days directly into model-specific capacity', () => {
    const cap = tokensPerDayCapacity({
      effectivePfDays: 96 * 0.989 * 0.7,
      model: dense400,
      servingEfficiency: 0.55,
      inferenceShare: 1,
    })
    expect(cap).toBeGreaterThan(120_000)
    expect(cap).toBeLessThan(10_000_000)
  })

  it('one H100-class device supports at least 2,000 full 20M-token users', () => {
    const capacityMTokPerDay = tokensPerDayCapacity({
      // H100 BF16 dense peak after a conservative 70% online efficiency.
      effectivePfDays: 0.989 * 0.7,
      model: dense1,
      servingEfficiency: 1,
      inferenceShare: 1,
    })
    const fullAllowanceUsers = capacityMTokPerDay / (20 / 30)

    expect(fullAllowanceUsers).toBeGreaterThan(2_000)
  })

  it('puts 70.6B daily tokens on a 1B model in single-digit PF', () => {
    const estimate = estimateServingWorkload({
      model: dense1,
      inputMTok: 70_600 * 0.7,
      outputMTok: 70_600 * 0.3,
      servingEfficiency: 1,
    })

    expect(estimate.physicalPfDays).toBeGreaterThan(1.6)
    expect(estimate.physicalPfDays).toBeLessThan(1.75)
    expect(estimate.physicalPfDays / 0.35).toBeLessThan(5)
  })

  it('reports context, precision, and HBM constraints explicitly', () => {
    const bf16 = estimateServingWorkload({
      model: dense7,
      inputMTok: 100,
      outputMTok: 20,
      precision: 'bf16',
      avgInputTokens: 16_384,
      concurrentRequests: 32,
      batchSize: 8,
      hbmGb: 8,
    })
    const fp8 = estimateServingWorkload({
      model: dense7,
      inputMTok: 100,
      outputMTok: 20,
      precision: 'fp8',
    })

    expect(bf16.fitsHbm).toBe(false)
    expect(bf16.bottleneck).toBe('hbm_capacity')
    expect(fp8.physicalPfDays).toBeLessThan(bf16.physicalPfDays)
    expect(fp8.weightMemoryGb).toBeLessThan(bf16.weightMemoryGb)
  })

  it('SKU tok scales with model size', () => {
    const sku = { tokPerSec: 2200 }
    const t400 = tokensPerSecForSku(sku, dense400, 1)
    const t7 = tokensPerSecForSku(sku, dense7, 1)
    expect(t400).toBeGreaterThan(t7 * 2)
    expect(mtokPerDayFromTps(t400)).toBeGreaterThan(mtokPerDayFromTps(t7))
  })
})
