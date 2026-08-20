import { describe, expect, it } from 'vitest'
import type { BenchmarkScores, MarketOffer } from '../types'
import {
  priceBandCompetitionBonus,
  segmentOfferQuality,
  segmentShares,
} from './marketScore'

const benches = (patch: Partial<BenchmarkScores>): BenchmarkScores => ({
  mmlu: 50,
  coding: 50,
  math: 50,
  vision: 20,
  law: 45,
  health: 45,
  science: 50,
  multilingual: 50,
  agents: 45,
  safety: 60,
  personality: 45,
  ...patch,
})

const generalist: MarketOffer = {
  labId: 'general',
  modelId: 'general-58b',
  capability: 58,
  reliability: 88,
  safety: 90,
  brandTrust: 82,
  apiPrice: 5,
  subPrice: 45,
  latencyScore: 75,
  tokPerSec: 50,
  modalities: ['text', 'tools'],
  isOpenWeights: false,
  benchmarks: benches({
    mmlu: 70,
    coding: 60,
    math: 60,
    agents: 65,
    safety: 90,
    personality: 75,
    multilingual: 65,
  }),
}

const codeSpecialist: MarketOffer = {
  labId: 'specialist',
  modelId: 'code-7b',
  capability: 44,
  reliability: 90,
  safety: 70,
  brandTrust: 50,
  apiPrice: 0.45,
  subPrice: 20,
  latencyScore: 95,
  tokPerSec: 100,
  modalities: ['text', 'tools'],
  isOpenWeights: true,
  benchmarks: benches({
    mmlu: 50,
    coding: 95,
    math: 75,
    agents: 92,
    safety: 70,
    personality: 35,
    multilingual: 35,
  }),
}

describe('specialist market demand', () => {
  it('lets an efficient narrow model win target API work without winning enterprise', () => {
    expect(segmentOfferQuality(codeSpecialist, 'indie_api')).toBeGreaterThan(
      segmentOfferQuality(generalist, 'indie_api'),
    )

    const indie = segmentShares([generalist, codeSpecialist], 'indie_api')
    const enterprise = segmentShares(
      [generalist, codeSpecialist],
      'enterprise',
    )
    expect(indie[1]).toBeGreaterThan(indie[0])
    expect(enterprise[0]).toBeGreaterThan(enterprise[1])

    const samePriceGeneralist = { ...generalist, apiPrice: 1 }
    const samePriceSpecialist = { ...codeSpecialist, apiPrice: 1 }
    expect(
      priceBandCompetitionBonus(
        samePriceSpecialist,
        [samePriceGeneralist],
        'indie_api',
      ),
    ).toBeGreaterThan(0)
  })
})
