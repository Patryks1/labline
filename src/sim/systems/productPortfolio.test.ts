import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from '../balance/benchmarks'
import { createGame } from '../createGame'
import type { Model, SimState } from '../types'
import {
  MAX_PROMOTED_PRODUCT_OFFERS,
  PRODUCT_CHANNELS,
  capPromotedOffers,
  deriveDemandSegments,
  deriveProductPortfolio,
  portfolioCapacitySplit,
} from './productPortfolio'

function releasedModel(
  id: string,
  input: {
    capability: number
    inferCostMult: number
    reliability: number
    safety?: number
    modalities?: Model['modalities']
    priceIn?: number
    priceOut?: number
  },
): Model {
  return {
    id,
    name: id,
    family: 'dense',
    paramsB: 7,
    capability: input.capability,
    modalities: input.modalities ?? ['text'],
    quality: {
      reasoning: input.capability,
      coding: input.capability,
      chat: input.capability,
      image: input.modalities?.includes('image') ? input.capability : 0,
      video: input.modalities?.includes('video') ? input.capability : 0,
      safety: input.safety ?? 70,
      reliability: input.reliability,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: 'rlhf',
    trainComputeSpent: 20,
    releaseDay: 1,
    shipped: true,
    release: 'released',
    tokPerSecMult: 1,
    inferCostMult: input.inferCostMult,
    apiPricePerMTok: null,
    apiPriceInPerMTok: input.priceIn ?? null,
    apiPriceOutPerMTok: input.priceOut ?? null,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 0.7,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: 'pretrain',
  }
}

function stateWithPortfolio(): SimState {
  const state = createGame(1_202)
  const efficient = releasedModel('efficient', {
    capability: 54,
    inferCostMult: 0.35,
    reliability: 72,
    priceIn: 0.4,
    priceOut: 1.6,
  })
  const frontier = releasedModel('frontier', {
    capability: 78,
    inferCostMult: 1.1,
    reliability: 88,
    safety: 90,
    modalities: ['text', 'image', 'video', 'tools'],
    priceIn: 1.5,
    priceOut: 5,
  })
  const internal = { ...frontier, id: 'internal-checkpoint', release: 'internal' as const, shipped: false }
  return {
    ...state,
    player: {
      ...state.player,
      models: [efficient, frontier, internal],
      pricing: {
        ...state.player.pricing,
        activeModelId: frontier.id,
        plans: state.player.pricing.plans.map((plan) => ({
          ...plan,
          modelIds:
            plan.id === 'plan-free'
              ? [efficient.id]
              : plan.id === 'plan-plus'
                ? [frontier.id]
                : [frontier.id, efficient.id],
        })),
      },
    },
  }
}

describe('derived product portfolio', () => {
  it('projects exactly the six supported promoted channels from models and plans', () => {
    const state = stateWithPortfolio()
    const portfolio = deriveProductPortfolio(state)

    expect(portfolio.promoted.map((offer) => offer.channel)).toEqual(PRODUCT_CHANNELS)
    expect(portfolio.promoted).toHaveLength(MAX_PROMOTED_PRODUCT_OFFERS)
    expect(new Set(portfolio.promoted.map((offer) => offer.channel)).size).toBe(6)
    expect(portfolio.missingChannels).toEqual([])
    expect(portfolio.internalModelIds).toEqual(['internal-checkpoint'])

    const free = portfolio.byChannel.free_assistant!
    expect(free.sourcePlanId).toBe('plan-free')
    expect(free.primaryModelId).toBe('efficient')
    expect(free.pricing.billingModel).toBe('free')
    expect(free.pricing.monthlyUsd).toBe(0)

    const creator = portfolio.byChannel.creator_developer!
    expect(creator.sourcePlanId).toBe('plan-pro')
    expect(creator.pricing.overageInputUsdPerMTok).toBe(1.5)
    expect(creator.modalities).toEqual(['text', 'image', 'video', 'tools'])

    const payg = portfolio.byChannel.payg_api!
    expect(payg.primaryModelId).toBe('frontier')
    expect(payg.pricing.inputUsdPerMTok).toBe(1.5)
    expect(payg.pricing.outputUsdPerMTok).toBe(5)

    const reserved = portfolio.byChannel.reserved_throughput_api!
    expect(reserved.delivery).toBe('reserved')
    expect(reserved.pricing.inputUsdPerMTok).toBeCloseTo(1.5 * 0.82)
    expect(reserved.pricing.minimumCommitmentUsd).toBeGreaterThanOrEqual(5_000)

    const enterprise = portfolio.byChannel.enterprise_dedicated!
    expect(enterprise.primaryModelId).toBe('frontier')
    expect(enterprise.delivery).toBe('dedicated')
    expect(enterprise.capacityPriority).toBe(1)
  })

  it('hard-caps and de-duplicates promotions by stable channel priority', () => {
    const offers = deriveProductPortfolio(stateWithPortfolio()).promoted
    const duplicate = { ...offers[0]!, id: 'duplicate-first' }
    const capped = capPromotedOffers([duplicate, ...offers, ...offers])

    expect(capped).toHaveLength(6)
    expect(capped[0]?.id).toBe('duplicate-first')
    expect(capped.map((offer) => offer.channel)).toEqual(PRODUCT_CHANNELS)
  })

  it('keeps internal models and unavailable endpoints outside the promoted set', () => {
    const state = createGame(1_203)
    const checkpoint = releasedModel('private-model', {
      capability: 70,
      inferCostMult: 1,
      reliability: 80,
    })
    checkpoint.release = 'internal'
    checkpoint.shipped = false
    state.player.models = [checkpoint]

    const portfolio = deriveProductPortfolio(state)
    expect(portfolio.promoted).toEqual([])
    expect(portfolio.missingChannels).toEqual(PRODUCT_CHANNELS)
    expect(portfolio.internalModelIds).toEqual(['private-model'])
  })

  it('is deterministic and exposes the existing settlement capacity split', () => {
    const state = stateWithPortfolio()
    expect(deriveProductPortfolio(state)).toEqual(deriveProductPortfolio(state))
    const split = portfolioCapacitySplit(state)
    expect(split.api + split.subscriptions).toBeCloseTo(1)
    expect(split.api).toBe(state.player.pricing.apiVsSubPriority)
  })
})

describe('authoritative demand segments', () => {
  it('enriches all nine live segment states with domain and switching needs', () => {
    const state = createGame(1_204)
    const scienceState = state.segments.find((segment) => segment.id === 'science')!
    scienceState.size = 123_456
    scienceState.usageIntensity = 7.5

    const segments = deriveDemandSegments(state)
    expect(segments).toHaveLength(9)
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(9)

    const science = segments.find((segment) => segment.id === 'science')!
    expect(science.currentUsers).toBe(123_456)
    expect(science.usefulTaskDemandPerUserDay).toBe(7.5)
    expect(science.priceSensitivity).toBe(0.55)
    expect(science.domainWeights.science).toBeGreaterThan(science.domainWeights.language ?? 0)
    expect(science.preferredChannels).toContain('reserved_throughput_api')
    expect(science.benchmarkWeights.science).toBeGreaterThan(0)

    const hobby = segments.find((segment) => segment.id === 'hobby')!
    const healthcare = segments.find((segment) => segment.id === 'healthcare')!
    expect(hobby.priceSensitivity).toBe(1.8)
    expect(healthcare.priceSensitivity).toBe(0.45)
    expect(healthcare.switchingFriction).toBeGreaterThan(hobby.switchingFriction)
    expect(healthcare.preferredChannels).toEqual(['enterprise_dedicated'])
  })
})
