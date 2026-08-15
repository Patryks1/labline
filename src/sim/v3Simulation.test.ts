import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import {
  analyzeApiPricing,
  analyzePlanPricing,
  fullyLoadedApiCostFloor,
} from './balance/pricing'
import { modelTrainVramGb } from './balance/racks'
import { trainCostPfDays } from './balance/training'
import {
  analyzeTrainingData,
  forecastTrainingV3,
  ioForPreset,
  serviceProfileForModel,
} from './balance/trainingV3'
import { createEmptyLabData, DATA_DOMAINS } from './balance/data'
import { queueResourceOrder, tickSharedMarkets } from './systems/sharedMarkets'
import type { DataDomain, DataManifest, TrainingDataPlan } from './types'

const diverseWeights = Object.fromEntries(
  DATA_DOMAINS.map((domain) => [domain, 1 / DATA_DOMAINS.length]),
) as Record<DataDomain, number>

function plan(totalMTok: number, over: Partial<TrainingDataPlan> = {}): TrainingDataPlan {
  return {
    totalUnits: totalMTok,
    totalMTok,
    trainShare: 0.82,
    weights: diverseWeights,
    allowSynthetic: false,
    ...over,
  }
}

describe('simulation v3 shared rules', () => {
  it('keeps unique HQ optimization data useful through the frontier region after verification holdout', () => {
    const trainShare = 0.82
    const strongRawMTok = 6_000 / trainShare
    const frontierRawMTok = 20_000 / trainShare
    const strong = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: plan(strongRawMTok, { trainShare }),
      actualMTok: strongRawMTok,
      quality: 100,
    })
    const frontier = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: plan(frontierRawMTok, { trainShare }),
      actualMTok: frontierRawMTok,
      quality: 100,
    })
    expect(strong.holdoutRetention).toBe(trainShare)
    expect(strong.effectiveDataRatio).toBeCloseTo(6, 2)
    expect(frontier.effectiveDataRatio).toBeCloseTo(20, 2)
    expect(frontier.effectiveMTok).toBeGreaterThan(strong.effectiveMTok)
    expect(frontier.warnings.join(' ')).not.toMatch(/overtrain|memorization/i)
  })

  it('flags repeated epochs, low verification, and LQ-heavy synthetic recipes', () => {
    const analysis = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: plan(9_000, { uniqueMTok: 1_000, repeatedMTok: 8_000, trainShare: 0.94 }),
      actualMTok: 9_000,
      quality: 75,
      lqShare: 0.3,
    })
    expect(analysis.repeatedEpochs).toBe(9)
    expect(analysis.risk).toBe('high')
    expect(analysis.warnings.join(' ')).toMatch(/eight corpus epochs/i)
    expect(analysis.warnings.join(' ')).toMatch(/low-quality synthetic/i)
    expect(analysis.warnings.join(' ')).toMatch(/verification/i)
  })

  it('uses manifest provenance to separate equal-quality corpora', () => {
    const manifest = (over: Partial<DataManifest>): DataManifest => ({
      id: 'manifest',
      assetIds: ['asset'],
      domainWeights: diverseWeights,
      uniqueMTok: 6_000,
      repeatedMTok: 0,
      effectiveQuality: 80,
      contaminationRisk: 0.03,
      effectiveDiversity: 0.85,
      effectiveFreshness: 0.9,
      syntheticShare: 0.05,
      syntheticGenerationDepth: 1,
      humanAnchorShare: 0.96,
      rightsRisk: 0.08,
      effectiveTrainingValue: 0.8,
      createdDay: 1,
      ...over,
    })
    const strong = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: plan(6_000),
      actualMTok: 6_000,
      quality: 80,
      manifest: manifest({}),
    })
    const recursive = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: plan(6_000),
      actualMTok: 6_000,
      quality: 80,
      manifest: manifest({
        contaminationRisk: 0.55,
        effectiveDiversity: 0.35,
        effectiveFreshness: 0.3,
        syntheticShare: 0.7,
        syntheticGenerationDepth: 5,
        humanAnchorShare: 0.2,
        rightsRisk: 0.72,
        effectiveTrainingValue: 0.32,
      }),
    })

    expect(strong.effectiveMTok).toBeGreaterThan(recursive.effectiveMTok * 2)
    expect(strong.risk).not.toBe('high')
    expect(recursive.risk).toBe('high')
    expect(recursive.warnings.join(' ')).toMatch(/internally repetitive/i)
    expect(recursive.warnings.join(' ')).toMatch(/synthetic lineage/i)
    expect(recursive.warnings.join(' ')).toMatch(/rights exposure/i)
  })

  it('uses manifest-attributed unique volume instead of the requested plan volume', () => {
    const analysis = analyzeTrainingData({
      paramsB: 1,
      family: 'dense',
      plan: plan(6_000, { uniqueMTok: 6_000 }),
      actualMTok: 6_000,
      quality: 80,
      manifest: {
        id: 'short-manifest',
        assetIds: ['small-lot'],
        domainWeights: diverseWeights,
        uniqueMTok: 1_000,
        repeatedMTok: 5_000,
        effectiveQuality: 80,
        contaminationRisk: 0.04,
        effectiveTrainingValue: 0.8,
        createdDay: 1,
      },
    })

    expect(analysis.uniqueMTok).toBe(1_000)
    expect(analysis.repeatedEpochs).toBe(6)
    expect(analysis.warnings.join(' ')).toMatch(/past four useful epochs/i)
  })

  it('uses MoE total parameters for memory and active-weighted parameters for compute', () => {
    const moeCost = trainCostPfDays({
      paramsB: 1_000,
      activeParamsB: 32,
      family: 'moe',
      trainEfficiency: 1,
      trainingTokensMTok: 6_000_000,
    })
    const denseEquivalentCost = trainCostPfDays({
      // Formula v2: 32B active path plus a bounded 10% systems overhead.
      paramsB: 35.2,
      family: 'dense',
      trainEfficiency: 1,
      trainingTokensMTok: 6_000_000,
    })
    expect(moeCost / denseEquivalentCost).toBeGreaterThan(0.95)
    expect(moeCost / denseEquivalentCost).toBeLessThan(1.2)
    expect(modelTrainVramGb(1_000, 32, 'moe')).toBeGreaterThan(
      modelTrainVramGb(32, undefined, 'dense') * 10,
    )
  })

  it('requires balanced modality data for omni and charges media-heavy compute', () => {
    const labData = createEmptyLabData()
    for (const domain of DATA_DOMAINS) {
      labData.stocks[domain].processed = 20_000
      labData.stocks[domain].quality = 100
    }
    const missing = forecastTrainingV3({
      spec: {
        name: 'Omni-missing',
        backbone: 'dense',
        productPreset: 'omni',
        paramsB: 1,
        io: ioForPreset('omni'),
        dataPlan: plan(10_000, {
          weights: { chat: 0.9, image: 0.1, audio: 0, video: 0 },
        }),
        mode: 'pretrain',
      },
      labData,
      dataQuality: 1,
      trainEfficiency: 1,
      trainPoolPf: 10,
    })
    const balanced = forecastTrainingV3({
      spec: {
        name: 'Omni-balanced',
        backbone: 'dense',
        productPreset: 'omni',
        paramsB: 1,
        io: ioForPreset('omni'),
        dataPlan: plan(10_000, {
          weights: { chat: 0.25, code: 0.05, image: 0.25, audio: 0.2, video: 0.25 },
        }),
        mode: 'pretrain',
      },
      labData,
      dataQuality: 1,
      trainEfficiency: 1,
      trainPoolPf: 10,
    })
    expect(missing.warnings.join(' ')).toMatch(/audio data|video data/i)
    expect(balanced.modalityComputeMult).toBeGreaterThan(3)
    expect(balanced.targetPfDays).toBeGreaterThan(missing.targetPfDays)
  })

  it('separates interactive single-stream speed from fleet throughput', () => {
    const small = serviceProfileForModel({
      paramsB: 7,
      family: 'dense',
      tokPerSecMult: 0.75,
      capability: 45,
    })
    const frontier = serviceProfileForModel({
      paramsB: 400,
      family: 'dense',
      tokPerSecMult: 0.5,
      capability: 90,
    })
    expect(small.interactiveTokPerSec).toBeGreaterThan(frontier.interactiveTokPerSec)
    expect(small.timeToFirstTokenMs).toBeLessThan(frontier.timeToFirstTokenMs)
  })

  it('clears oversubscribed shared data once, deterministically, with partial fills', () => {
    const run = () => {
      let state = createGame(919)
      const offer = state.dataMarket.offers[0]!
      state = {
        ...state,
        dataMarket: {
          ...state.dataMarket,
          offers: state.dataMarket.offers.map((entry) =>
            entry.id === offer.id
              ? { ...entry, mTokLeft: 10, mTokTotal: 10, lotMTok: 8, cash: 80 }
              : entry,
          ),
        },
      }
      state = queueResourceOrder(state, {
        labId: state.playerLabId,
        kind: 'data',
        resourceId: offer.id,
        quantity: 8,
        maxUnitPrice: 12,
      })
      state = queueResourceOrder(state, {
        labId: state.rivals[0]!.id,
        kind: 'data',
        resourceId: offer.id,
        quantity: 8,
        maxUnitPrice: 12,
      })
      return tickSharedMarkets(state)
    }
    const first = run()
    const second = run()
    const offerId = first.dataMarket.offers[0]!.id
    const fills = first.worldMarkets.fills.filter(
      (fill) => fill.kind === 'data' && fill.resourceId === offerId,
    )
    expect(fills.reduce((sum, fill) => sum + fill.quantity, 0)).toBe(10)
    expect(fills.some((fill) => fill.quantity > 0 && fill.quantity < 8)).toBe(true)
    expect(first.dataMarket.offers[0]!.mTokLeft).toBe(0)
    expect(second.worldMarkets.fills.slice(0, 2)).toEqual(first.worldMarkets.fills.slice(0, 2))
  })

  it('uses shared pricing thresholds for API and plans', () => {
    // Extreme premium vs peers still collapses demand; moderate premiums are "expensive".
    const collapse = analyzeApiPricing({
      price: 80,
      marginalCost: 2,
      capability: 60,
      featureScore: 20,
      peers: [{ price: 10, capability: 60, featureScore: 20 }],
    })
    expect(collapse.primary).toBe('demand_collapse')
    const expensive = analyzeApiPricing({
      price: 30,
      marginalCost: 2,
      capability: 60,
      featureScore: 20,
      peers: [{ price: 10, capability: 60, featureScore: 20 }],
    })
    expect(expensive.primary).toBe('expensive')
    const planStatus = analyzePlanPricing({
      price: 20,
      includedMTokPerMonth: 100,
      expectedUtilization: 0.75,
      marginalCostPerMTok: 0.3,
      capability: 60,
      featureScore: 20,
      peers: [{ price: 20, includedMTokPerMonth: 100, capability: 60, featureScore: 20 }],
    })
    expect(planStatus.primary).toBe('unsustainable_plan')
  })

  it('uses the live fully loaded API cost floor when the model served tokens', () => {
    const floor = fullyLoadedApiCostFloor({
      dayCogs: 73_600_000,
      dayMTok: 375_860,
      marginalCostPerMTok: 0.038,
    })
    expect(floor.source).toBe('live')
    expect(floor.blended).toBeCloseTo(73_600_000 / 375_860, 5)
    expect(floor.costIn).toBeLessThanOrEqual(floor.costOut)
  })

  it('falls back to marginal API cost before there is live serving history', () => {
    const floor = fullyLoadedApiCostFloor({
      dayCogs: 0,
      dayMTok: 0,
      marginalCostPerMTok: 0.42,
    })
    expect(floor.source).toBe('marginal')
    expect(floor.blended).toBe(0.42)
    expect(floor.costIn).toBeLessThanOrEqual(floor.costOut)
  })

  it('quality-adjusts API demand diagnostics for capability and endpoint speed', () => {
    const peers = [{
      price: 10,
      capability: 60,
      featureScore: 20,
      tokPerSec: 1_000,
    }]
    const full = analyzeApiPricing({
      price: 10,
      marginalCost: 2,
      capability: 60,
      featureScore: 20,
      tokPerSec: 1_000,
      peers,
    })
    const quantizedSlow = analyzeApiPricing({
      price: 10,
      marginalCost: 2,
      capability: 35,
      featureScore: 20,
      tokPerSec: 80,
      peers,
    })
    expect(full.primary).toBe('fair')
    expect(quantizedSlow.ratioToPeer).toBeGreaterThan(full.ratioToPeer ?? 0)
    expect(['expensive', 'demand_collapse']).toContain(quantizedSlow.primary)
  })
})
