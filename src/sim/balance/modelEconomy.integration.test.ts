import { describe, expect, it } from 'vitest'
import type { MarketOffer, Model } from '../types'
import { buildScaledModel } from './modelBuild'
import {
  launchReferenceApiCostPerMTok,
  targetUtilizedApiCostPerMTok,
} from './unitEconomics'
import { segmentShares } from '../systems/marketScore'

function model(paramsB: number, id = `m-${paramsB}`): Model {
  return buildScaledModel({
    id,
    name: id,
    paramsB,
    family: 'dense',
    day: 1,
    dataCoverage: 20,
    dataQuality: 80,
    postTrain: 'none',
  })
}

function offer(source: Model, labId: string): MarketOffer {
  return {
    labId,
    modelId: source.id,
    capability: source.capability,
    reliability: source.quality.reliability,
    safety: source.quality.safety,
    brandTrust: 60,
    apiPrice: source.apiPricePerMTok ?? source.suggestedApiPrice ?? 1,
    subPrice: 20,
    latencyScore: 75,
    tokPerSec: source.serviceProfile?.interactiveTokPerSec ?? 30,
    modalities: source.modalities,
    isOpenWeights: false,
    benchmarks: source.benchmarks,
  }
}

describe('model economy integration bands', () => {
  it('keeps general capability monotonic and size-capped across five scales', () => {
    const scales = [0.07, 0.7, 7, 70, 405].map((paramsB) => model(paramsB))
    for (let index = 1; index < scales.length; index++) {
      expect(scales[index]!.capability).toBeGreaterThan(
        scales[index - 1]!.capability,
      )
    }
    expect(scales[0]!.capability).toBeGreaterThanOrEqual(3)
    expect(scales[0]!.capability).toBeLessThanOrEqual(15)
    expect(scales[2]!.capability).toBeGreaterThanOrEqual(10)
    expect(scales[2]!.capability).toBeLessThanOrEqual(40)
    expect(scales[3]!.capability).toBeGreaterThanOrEqual(30)
    expect(scales[3]!.capability).toBeLessThanOrEqual(82)
    expect(scales[4]!.capability).toBeGreaterThanOrEqual(45)
    expect(scales[4]!.capability).toBeLessThanOrEqual(94)
  })

  it('does not let extreme tuning turn 70M into a frontier generalist', () => {
    const tiny = buildScaledModel({
      id: 'tiny-maxed',
      name: 'Tiny maxed',
      paramsB: 0.07,
      family: 'dense',
      day: 1,
      dataCoverage: 100,
      dataQuality: 100,
      postTrain: 'tools',
      researchUnlocked: [
        'dense_basics',
        'align_sft',
        'align_rlhf',
        'align_process',
        'domain_coding',
        'domain_agents',
        'opt_mixed',
        'opt_checkpoint',
      ],
    })
    const broad = buildScaledModel({
      id: 'broad-700b',
      name: 'Broad 700B',
      paramsB: 700,
      family: 'dense',
      day: 1,
      dataCoverage: 6,
      dataQuality: 70,
    })
    expect(tiny.capability).toBeLessThanOrEqual(35)
    expect(tiny.capability).toBeLessThan(broad.capability)
  })

  it('makes smaller dense endpoints faster and cheaper to serve', () => {
    const small = model(0.7, 'small')
    const medium = model(7, 'medium')
    const large = model(70, 'large')
    expect(small.serviceProfile!.interactiveTokPerSec).toBeGreaterThan(
      medium.serviceProfile!.interactiveTokPerSec,
    )
    expect(medium.serviceProfile!.interactiveTokPerSec).toBeGreaterThan(
      large.serviceProfile!.interactiveTokPerSec,
    )
    expect(launchReferenceApiCostPerMTok(small)).toBeLessThan(
      launchReferenceApiCostPerMTok(medium),
    )
    expect(launchReferenceApiCostPerMTok(medium)).toBeLessThan(
      launchReferenceApiCostPerMTok(large),
    )
  })

  it('keeps the same scoring and fallback pricing rules for player and rivals', () => {
    const checkpoint = model(7, 'parity-model')
    const shares = segmentShares(
      [offer(checkpoint, 'player'), offer(checkpoint, 'rival-a')],
      'indie_api',
    )
    expect(shares[0]).toBeCloseTo(0.5, 10)
    expect(shares[1]).toBeCloseTo(0.5, 10)

    const sameAgain = model(7, 'rival-build')
    expect(sameAgain.capability).toBeCloseTo(checkpoint.capability, 10)
    expect(sameAgain.suggestedApiPrice ?? 0).toBeCloseTo(
      checkpoint.suggestedApiPrice ?? 0,
      10,
    )
  })

  it('allows low utilization to erase margin despite respecting the floor', () => {
    const quote = targetUtilizedApiCostPerMTok({
      opsDay: 620,
      capacityMTok: 1_000,
      referenceCostPerMTok: 5,
      bandwidthPerMTok: 0.025,
    })
    const defaultList = (620 / 1_000 + 0.025) * 2.2
    const actualCostAt35Pct = 620 / 350 + 0.025
    const actualCostAt85Pct = 620 / 850 + 0.025
    expect(defaultList).toBeGreaterThanOrEqual(quote.blended)
    expect((defaultList - actualCostAt35Pct) / defaultList).toBeLessThan(0)
    expect((defaultList - actualCostAt85Pct) / defaultList).toBeGreaterThan(0.35)
  })
})
