import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from './benchmarks'
import { offerUtility, segmentShares } from '../systems/marketScore'
import type { MarketOffer } from '../types'
import {
  BASELINE_DOMAIN_HEAT,
  DOMAIN_HEAT_MAX,
  DOMAIN_HEAT_MIN,
  nextDomainHeat,
  offerDomainHeatBonus,
  segmentDomainHeatMultiplier,
} from './domainHeat'

function offerWith(benchmarks: Partial<MarketOffer['benchmarks']>): MarketOffer {
  return {
    labId: 'lab',
    modelId: 'm',
    capability: 70,
    reliability: 70,
    safety: 70,
    brandTrust: 60,
    apiPrice: 6,
    subPrice: 20,
    latencyScore: 70,
    tokPerSec: 80,
    modalities: ['text', 'tools'],
    isOpenWeights: false,
    benchmarks: { ...emptyBenchmarks(), mmlu: 55, ...benchmarks },
  }
}

describe('domain heat pulse', () => {
  it('starts at 2026 coding/research defaults and stays inside the clamp', () => {
    expect(BASELINE_DOMAIN_HEAT.coding).toBeCloseTo(1.35)
    expect(BASELINE_DOMAIN_HEAT.agents).toBeCloseTo(1.25)
    expect(BASELINE_DOMAIN_HEAT.science).toBeCloseTo(1.2)
    let heat = nextDomainHeat(undefined, 1, 99, 'cloud_startup')
    for (let day = 2; day <= 400; day += 1) {
      heat = nextDomainHeat(heat, day, 99, 'scaling_specialization')
    }
    for (const value of Object.values(heat)) {
      expect(value).toBeGreaterThanOrEqual(DOMAIN_HEAT_MIN)
      expect(value).toBeLessThanOrEqual(DOMAIN_HEAT_MAX)
    }
    const late = nextDomainHeat(heat, 2200, 99, 'power_limited_frontier')
    expect(late.science ?? 1).toBeGreaterThan(1.05)
  })

  it('is deterministic per seed and mean-reverting', () => {
    const a = nextDomainHeat(undefined, 40, 7, 'cloud_startup')
    const b = nextDomainHeat(undefined, 40, 7, 'cloud_startup')
    expect(a).toEqual(b)
    const other = nextDomainHeat(undefined, 40, 8, 'cloud_startup')
    expect(other.coding).not.toBe(a.coding)
  })

  it('swells coding-weighted segments without zeroing others', () => {
    const heat = { coding: 1.5, agents: 1.3, science: 1.1, math: 1.05, vision: 0.85 }
    const indie = segmentDomainHeatMultiplier(
      { coding: 0.45, mmlu: 0.25, math: 0.15, agents: 0.15 },
      heat,
    )
    const creative = segmentDomainHeatMultiplier(
      { vision: 0.55, mmlu: 0.15, multilingual: 0.1, safety: 0.1, agents: 0.1 },
      heat,
    )
    expect(indie).toBeGreaterThan(creative)
    expect(creative).toBeGreaterThan(0.7)
  })

  it('gives coding specialists a bounded bonus while leaving non-coding shares alive', () => {
    const heat = { coding: 1.5, agents: 1.35, science: 1.1, vision: 0.8 }
    const coder = offerWith({ coding: 88, agents: 70, math: 60, vision: 20, mmlu: 55 })
    const vision = offerWith({ coding: 28, agents: 20, math: 25, vision: 88, mmlu: 50 })
    const general = offerWith({ coding: 55, agents: 50, math: 50, vision: 50, mmlu: 58 })
    expect(offerDomainHeatBonus(coder.benchmarks, heat)).toBeGreaterThan(
      offerDomainHeatBonus(vision.benchmarks, heat),
    )
    expect(Math.abs(offerDomainHeatBonus(coder.benchmarks, heat))).toBeLessThanOrEqual(0.8)
    const coderU = offerUtility(coder, 'startup_api', { domainHeat: heat, frontier: 72 })
    const visionU = offerUtility(vision, 'startup_api', { domainHeat: heat, frontier: 72 })
    expect(coderU).toBeGreaterThan(visionU)
    const shares = segmentShares(
      [
        { ...coder, labId: 'coder' },
        { ...vision, labId: 'vision' },
        { ...general, labId: 'general' },
      ],
      'startup_api',
      undefined,
      72,
      heat,
    )
    expect(shares[0]!).toBeGreaterThan(shares[1]!)
    expect(shares[1]!).toBeGreaterThan(0.08)
    expect(shares[2]!).toBeGreaterThan(0.12)
  })
})
