import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from '../balance/benchmarks'
import { createGame } from '../createGame'
import type { MarketOffer, Model, SimState } from '../types'
import {
  OUTSIDE_OPTION_PROVIDER_ID,
  offerUtility,
  settleSegmentProviderShares,
  tickMarket,
} from './market'
import { deriveDemandSegments } from './productPortfolio'

function releasedModel(id: string, capability: number, reliability: number): Model {
  return {
    id,
    name: id,
    family: 'dense',
    paramsB: 7,
    capability,
    modalities: ['text', 'tools'],
    quality: {
      reasoning: capability,
      coding: capability,
      chat: capability,
      image: 0,
      video: 0,
      safety: reliability,
      reliability,
    },
    benchmarks: {
      ...emptyBenchmarks(),
      mmlu: capability,
      coding: capability,
      math: capability,
      science: capability,
      law: capability,
      health: capability,
      safety: reliability,
      agents: capability,
    },
    postTrain: 'rlhf',
    trainComputeSpent: 20,
    releaseDay: 1,
    shipped: true,
    release: 'released',
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: null,
    apiPriceInPerMTok: null,
    apiPriceOutPerMTok: null,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 0.7,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: 'pretrain',
  }
}

function stateWithBadPlayerAndStrongRivals(): SimState {
  const state = createGame(7_701)
  const playerModel = {
    ...releasedModel('player-bad', 8, 8),
    apiPriceInPerMTok: 500_000,
    apiPriceOutPerMTok: 1_000_000,
  }
  return {
    ...state,
    segments: state.segments.map((segment) => ({
      ...segment,
      providerShares: { player: 0.9, [OUTSIDE_OPTION_PROVIDER_ID]: 0.1 },
    })),
    player: {
      ...state.player,
      brandTrust: 8,
      models: [playerModel],
      pricing: {
        ...state.player.pricing,
        activeModelId: playerModel.id,
        apiPricePerMTok: 850_000,
        apiPriceInPerMTok: 500_000,
        apiPriceOutPerMTok: 1_000_000,
        plans: state.player.pricing.plans.map((plan) => ({
          ...plan,
          pricePerMonth: plan.pricePerMonth <= 0 ? 0 : 500_000,
          modelIds: [playerModel.id],
        })),
      },
    },
    rivals: state.rivals.map((rival, index) => ({
      ...rival,
      models: [releasedModel(`rival-${index}`, 72 - index, 82)],
      pricing: {
        ...rival.pricing,
        apiPricePerMTok: 3 + index * 0.2,
        subPlusPrice: 20 + index,
      },
    })),
  }
}

function baseOffer(overrides: Partial<MarketOffer> = {}): MarketOffer {
  return {
    labId: 'lab',
    modelId: 'model',
    capability: 60,
    reliability: 70,
    safety: 70,
    brandTrust: 60,
    apiPrice: 4,
    subPrice: 20,
    latencyScore: 75,
    tokPerSec: 80,
    modalities: ['text', 'tools'],
    isOpenWeights: false,
    benchmarks: { ...emptyBenchmarks(), coding: 60, agents: 55, mmlu: 60 },
    ...overrides,
  }
}

describe('authoritative segment switching inertia', () => {
  it('moves sticky segments more slowly than consumer and developer segments', () => {
    const state = createGame(7_700)
    const friction = new Map(
      deriveDemandSegments(state).map((segment) => [segment.id, segment.switchingFriction]),
    )
    const prior = { incumbent: 0.9, challenger: 0.05, [OUTSIDE_OPTION_PROVIDER_ID]: 0.05 }
    const target = { incumbent: 0.05, challenger: 0.85, [OUTSIDE_OPTION_PROVIDER_ID]: 0.1 }
    const retained = (segmentId: Parameters<typeof friction.get>[0]) =>
      settleSegmentProviderShares(prior, target, friction.get(segmentId)!).incumbent!

    expect(retained('science')).toBeGreaterThan(retained('indie_api'))
    expect(retained('enterprise')).toBeGreaterThan(retained('consumer'))
    expect(retained('legal')).toBeGreaterThan(retained('consumer'))
    expect(retained('healthcare')).toBeGreaterThan(retained('consumer'))

    for (const segmentId of friction.keys()) {
      const shares = settleSegmentProviderShares(prior, target, friction.get(segmentId)!)
      expect(Object.values(shares).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12)
      expect(Object.values(shares).every((share) => share >= 0)).toBe(true)
    }
  })

  it('persists inertia in live player, rival, and outside-option settlement', () => {
    const settled = tickMarket(stateWithBadPlayerAndStrongRivals())
    const playerShare = (id: SimState['segments'][number]['id']) =>
      settled.segments.find((segment) => segment.id === id)!.providerShares!.player ?? 0

    expect(playerShare('science')).toBeGreaterThan(playerShare('indie_api'))
    expect(playerShare('enterprise')).toBeGreaterThan(playerShare('consumer'))
    expect(playerShare('legal')).toBeGreaterThan(playerShare('consumer'))
    expect(playerShare('healthcare')).toBeGreaterThan(playerShare('consumer'))

    for (const segment of settled.segments) {
      const shares = segment.providerShares!
      expect(shares[OUTSIDE_OPTION_PROVIDER_ID]).toBeGreaterThanOrEqual(0)
      expect(Object.values(shares).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 10)
    }
    expect(
      Object.values(settled.lastMarket.sharesByLab).reduce((sum, share) => sum + share, 0),
    ).toBeCloseTo(1, 10)
    expect(settled.lastMarket.sharesByLab[OUTSIDE_OPTION_PROVIDER_ID]).toBeGreaterThan(0)
  })

  it('keeps capability, reliability, price, and latency demand monotonic', () => {
    const frontier = 75
    const utility = (offer: MarketOffer) => offerUtility(offer, 'startup_api', { frontier })
    const baseline = utility(baseOffer())

    expect(utility(baseOffer({ capability: 70 }))).toBeGreaterThan(baseline)
    expect(utility(baseOffer({ reliability: 90 }))).toBeGreaterThan(baseline)
    expect(utility(baseOffer({ apiPrice: 40 }))).toBeLessThan(baseline)
    expect(utility(baseOffer({ latencyScore: 25, tokPerSec: 15 }))).toBeLessThan(baseline)
  })
})
