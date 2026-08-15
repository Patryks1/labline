import { describe, expect, it } from 'vitest'
import type { DataDomain } from '../types'
import {
  createEmptyLabData,
  DATA_DOMAINS,
  defaultDataWeights,
  DOMAIN_LISTING_WEIGHT,
  DOMAIN_PRICE_MULT,
  generateDataMarketOffers,
  minDataMTokForParams,
  minimumTrainingDataMTok,
  recommendedDataMTok,
  recommendedTrainingDataMTok,
  trainingDataParameterBasisB,
} from './data'

describe('starter data foundation', () => {
  it('starts with 500 MTok rebalanced toward code/math/science', () => {
    const data = createEmptyLabData()
    const total = Object.values(data.stocks).reduce(
      (sum, stock) => sum + stock.processed,
      0,
    )

    expect(total).toBe(500)
    expect(data.stocks.chat.processed).toBe(80)
    expect(data.stocks.code.processed).toBe(180)
    expect(data.stocks.math.processed).toBe(90)
    expect(data.stocks.science.processed).toBe(80)
    expect(data.stocks.image.processed).toBe(40)
    expect(data.stocks.law.processed).toBe(15)
    expect(data.stocks.health.processed).toBe(15)
    expect(data.stocks.audio.processed).toBe(0)
    expect(data.stocks.video.processed).toBe(0)
  })

  it('can feed a minimum 125M run but remains below the strong target', () => {
    const total = Object.values(createEmptyLabData().stocks).reduce(
      (sum, stock) => sum + stock.processed,
      0,
    )

    expect(total).toBeGreaterThanOrEqual(minDataMTokForParams(0.125))
    expect(total).toBeLessThan(recommendedDataMTok(0.125, 'dense'))
  })

  it('softens chat-heavy default dense mix weights', () => {
    const w = defaultDataWeights('dense')
    expect(w.chat).toBeLessThan(0.36)
    expect(w.code).toBeGreaterThan(w.chat * 0.5)
    const sum = Object.values(w).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
  })
})

describe('architecture-aware training data targets', () => {
  it('uses routed MoE capacity and includes the verification holdout', () => {
    const spec = {
      paramsB: 13,
      activeParamsB: 0.07,
      family: 'moe' as const,
      backbone: 'moe' as const,
      trainShare: 0.8,
    }

    expect(trainingDataParameterBasisB(spec)).toBeCloseTo(2.656, 6)
    expect(minimumTrainingDataMTok(spec)).toBe(3_320)
    expect(recommendedTrainingDataMTok(spec)).toBe(19_920)
    expect(21_430).toBeGreaterThan(recommendedTrainingDataMTok(spec))
  })

  it('raises the raw corpus target as more data is reserved for verification', () => {
    const base = {
      paramsB: 13,
      activeParamsB: 0.07,
      family: 'moe' as const,
      backbone: 'moe' as const,
    }
    const tenPercentVerify = recommendedTrainingDataMTok({
      ...base,
      trainShare: 0.9,
    })
    const twentyPercentVerify = recommendedTrainingDataMTok({
      ...base,
      trainShare: 0.8,
    })

    expect(twentyPercentVerify).toBeGreaterThan(tenPercentVerify)
    expect(recommendedTrainingDataMTok({
      paramsB: 13,
      family: 'dense',
      backbone: 'dense',
      trainShare: 0.8,
    })).toBe(97_500)
  })
})

describe('market media weighting and pricing', () => {
  it('listing weights sum to 1 with audio+video in the 35–45% band', () => {
    const total = DATA_DOMAINS.reduce(
      (sum, domain) => sum + DOMAIN_LISTING_WEIGHT[domain],
      0,
    )
    expect(total).toBeCloseTo(1, 10)
    const av = DOMAIN_LISTING_WEIGHT.audio + DOMAIN_LISTING_WEIGHT.video
    expect(av).toBeGreaterThanOrEqual(0.35)
    expect(av).toBeLessThanOrEqual(0.45)
  })

  it('audio + video make up roughly 35–45% of generated listings', () => {
    let av = 0
    let total = 0
    for (let seed = 1; seed <= 60; seed++) {
      const offers = generateDataMarketOffers(seed, 10, [], 14)
      total += offers.length
      av += offers.filter(
        (offer) => offer.domain === 'audio' || offer.domain === 'video',
      ).length
    }
    const share = av / total
    expect(share).toBeGreaterThan(0.33)
    expect(share).toBeLessThan(0.47)
  })

  it('stays deterministic per (seed, day) and covers all nine domains', () => {
    const first = generateDataMarketOffers(42, 30, ['Rival Co'], 12)
    const second = generateDataMarketOffers(42, 30, ['Rival Co'], 12)
    expect(first).toEqual(second)

    const seen = new Set<DataDomain>()
    for (let seed = 1; seed <= 40; seed++) {
      for (const offer of generateDataMarketOffers(seed, 10, [], 14)) {
        seen.add(offer.domain)
      }
    }
    expect(seen.size).toBe(DATA_DOMAINS.length)
  })

  it('prices video ≈3× and audio ≈2× the typical text-domain rate', () => {
    const textDomains: DataDomain[] = [
      'code',
      'math',
      'science',
      'law',
      'health',
      'chat',
    ]
    const typical =
      textDomains.reduce((sum, domain) => sum + DOMAIN_PRICE_MULT[domain], 0) /
      textDomains.length
    expect(DOMAIN_PRICE_MULT.video / typical).toBeGreaterThan(2.8)
    expect(DOMAIN_PRICE_MULT.video / typical).toBeLessThan(3.3)
    expect(DOMAIN_PRICE_MULT.audio / typical).toBeGreaterThan(1.8)
    expect(DOMAIN_PRICE_MULT.audio / typical).toBeLessThan(2.2)
  })

  it('media multipliers flow through to generated listing prices', () => {
    // Same quality band + day → unit price ratio tracks DOMAIN_PRICE_MULT.
    const unitPrice = (offer: { cash: number; lotMTok: number }): number =>
      offer.cash / Math.max(1, offer.lotMTok)
    let video = 0
    let chat = 0
    for (let seed = 1; seed <= 60; seed++) {
      for (const offer of generateDataMarketOffers(seed, 10, [], 14)) {
        if (offer.qualityBand !== 'standard' || offer.mTokLeft <= 0) continue
        if (offer.domain === 'video') video += unitPrice(offer)
        if (offer.domain === 'chat') chat += unitPrice(offer)
      }
    }
    expect(video).toBeGreaterThan(0)
    expect(chat).toBeGreaterThan(0)
    expect(video / chat).toBeGreaterThan(3)
  })
})
