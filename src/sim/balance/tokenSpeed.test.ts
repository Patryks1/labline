import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from './benchmarks'
import { serviceProfileForModel } from './trainingV3'
import { offerUtility, scoreOfferFactors } from '../systems/marketScore'
import type { MarketOffer } from '../types'
import {
  TOKEN_SPEED_BRAND_THRESHOLD,
  TOKEN_SPEED_KNEE,
  planTokenSpeedDissatisfaction,
  tokenSpeedBrandPressure,
  tokenSpeedSatisfaction,
  tokenThroughputScore,
} from './tokenSpeed'

function offerAtSpeed(tokPerSec: number): MarketOffer {
  return {
    labId: 'lab',
    modelId: 'm',
    capability: 70,
    reliability: 70,
    safety: 70,
    brandTrust: 60,
    apiPrice: 8,
    subPrice: 20,
    latencyScore: 70,
    tokPerSec,
    modalities: ['text', 'tools'],
    isOpenWeights: false,
    benchmarks: {
      ...emptyBenchmarks(),
      mmlu: 70,
      coding: 70,
      agents: 60,
    },
  }
}

describe('token-speed satisfaction knee', () => {
  it('places the inflection at 30 tok/s with a severe-but-nonzero floor', () => {
    expect(tokenSpeedSatisfaction(TOKEN_SPEED_KNEE)).toBeCloseTo(0.5, 5)
    expect(tokenSpeedSatisfaction(10)).toBeGreaterThan(0.05)
    expect(tokenSpeedSatisfaction(10)).toBeLessThan(0.12)
    expect(tokenSpeedSatisfaction(20)).toBeLessThan(tokenSpeedSatisfaction(30) - 0.2)
    expect(tokenSpeedSatisfaction(45)).toBeGreaterThan(0.85)
    expect(tokenThroughputScore(0)).toBeGreaterThan(0)
    expect(tokenThroughputScore(120)).toBeGreaterThan(tokenThroughputScore(60))
    expect(tokenThroughputScore(200) - tokenThroughputScore(120)).toBeLessThan(
      tokenThroughputScore(60) - tokenThroughputScore(30),
    )
    expect(tokenThroughputScore(80_000)).toBeLessThanOrEqual(50)
  })

  it('penalizes offer utility below the knee without zeroing demand', () => {
    const at10 = offerUtility(offerAtSpeed(10), 'indie_api')
    const at20 = offerUtility(offerAtSpeed(20), 'indie_api')
    const at30 = offerUtility(offerAtSpeed(30), 'indie_api')
    const at45 = offerUtility(offerAtSpeed(45), 'indie_api')
    expect(at10).toBeLessThan(at20)
    expect(at20).toBeLessThan(at30)
    expect(at45).toBeGreaterThan(at30)
    expect(at10).toBeGreaterThan(-20)
    const speed10 = scoreOfferFactors(offerAtSpeed(10), 'indie_api').speed
    const speed45 = scoreOfferFactors(offerAtSpeed(45), 'indie_api').speed
    expect(speed10).toBeGreaterThan(0)
    expect(speed10).toBeLessThan(speed45)
    expect(speed45).toBeLessThanOrEqual(100)
  })

  it('adds plan dissatisfaction only below 30 tok/s, with free users half as sensitive', () => {
    expect(planTokenSpeedDissatisfaction(45, false)).toBe(0)
    expect(planTokenSpeedDissatisfaction(30, false)).toBe(0)
    expect(planTokenSpeedDissatisfaction(20, false)).toBeGreaterThan(0.08)
    expect(planTokenSpeedDissatisfaction(10, false)).toBeGreaterThan(
      planTokenSpeedDissatisfaction(20, false),
    )
    expect(planTokenSpeedDissatisfaction(10, true)).toBeLessThan(
      planTokenSpeedDissatisfaction(10, false) * 0.6,
    )
    expect(planTokenSpeedDissatisfaction(0, false)).toBeLessThan(0.6)
  })

  it('applies brand pressure only when a stream is well below 15 tok/s', () => {
    expect(tokenSpeedBrandPressure(45)).toBeLessThan(0.01)
    expect(tokenSpeedBrandPressure(TOKEN_SPEED_BRAND_THRESHOLD)).toBeLessThan(0.12)
    expect(tokenSpeedBrandPressure(8)).toBeGreaterThan(tokenSpeedBrandPressure(15))
    expect(tokenSpeedBrandPressure(0)).toBeLessThan(0.4)
  })

  it('gives a 2T MoE offer higher utility than a 2T dense twin via tok/s', () => {
    const denseTps = serviceProfileForModel({
      paramsB: 2000,
      family: 'dense',
      tokPerSecMult: 1,
      capability: 78,
    }).interactiveTokPerSec
    const moeTps = serviceProfileForModel({
      paramsB: 2000,
      activeParamsB: 100,
      family: 'moe',
      backbone: 'moe',
      tokPerSecMult: 1,
      capability: 78,
    }).interactiveTokPerSec
    expect(denseTps).toBeLessThan(TOKEN_SPEED_KNEE)
    expect(moeTps).toBeGreaterThan(TOKEN_SPEED_KNEE)
    const dense = offerUtility(offerAtSpeed(denseTps), 'startup_api')
    const moe = offerUtility(offerAtSpeed(moeTps), 'startup_api')
    expect(moe).toBeGreaterThan(dense)
  })
})
