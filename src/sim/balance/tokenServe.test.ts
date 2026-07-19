import { describe, expect, it } from 'vitest'
import {
  familyServeMult,
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
  it('family multipliers: moe 0.7, dense 1, omni 1.5', () => {
    expect(familyServeMult('moe')).toBe(0.7)
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

  it('96× H100-class 400M at 80% serve clears well past early demand', () => {
    // 96 * 2200 t/s hardware
    const hw = 96 * 2200
    const cap = tokensPerDayCapacity({
      hardwareTokPerSec: hw,
      model: dense400,
      servingEfficiency: 0.55,
      inferenceShare: 0.8,
      util: 0.48,
      powerDerate: 0.9,
      vramDerate: 1,
      systemRamDerate: 1,
      cpuDerate: 1,
    })
    // After 5× mult: full small hall + 400M clears well into 100k+ MTok/d
    expect(cap).toBeGreaterThan(120_000)
    expect(cap).toBeLessThan(2_000_000)
  })

  it('SKU tok scales with model size', () => {
    const sku = { tokPerSec: 2200 }
    const t400 = tokensPerSecForSku(sku, dense400, 1)
    const t7 = tokensPerSecForSku(sku, dense7, 1)
    expect(t400).toBeGreaterThan(t7 * 2)
    expect(mtokPerDayFromTps(t400)).toBeGreaterThan(mtokPerDayFromTps(t7))
  })
})
