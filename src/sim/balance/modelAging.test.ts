import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from './benchmarks'
import { createGame } from '../createGame'
import type { Model, Modality, SimState } from '../types'
import { collectOffers, offerUtility } from '../systems/market'
import { syncLabIndex } from '../systems/labEngine'
import {
  MODEL_AGE_GRACE_DAYS,
  MODEL_AGE_PENALTY_CAP,
  MODEL_AGE_POINTS_PER_30_DAYS,
  agedMarketView,
  modelAgePenalty,
} from './modelAging'

function releasedTwin(id: string, releaseDay: number): Model {
  return {
    id,
    name: id,
    family: 'dense',
    paramsB: 70,
    capability: 72,
    modalities: ['text', 'tools'],
    quality: {
      reasoning: 70,
      coding: 70,
      chat: 70,
      image: 0,
      video: 0,
      safety: 70,
      reliability: 70,
    },
    benchmarks: {
      ...emptyBenchmarks(),
      mmlu: 70,
      coding: 72,
      math: 68,
      science: 65,
      agents: 60,
      safety: 70,
    },
    postTrain: 'rlhf',
    trainComputeSpent: 40,
    releaseDay,
    shipped: true,
    release: 'released',
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: 4,
    apiPriceInPerMTok: 1.5,
    apiPriceOutPerMTok: 6,
    suggestedApiPrice: 4,
    suggestedApiPriceIn: 1.5,
    suggestedApiPriceOut: 6,
    costApiPriceIn: 0.4,
    costApiPriceOut: 1.2,
    distilled: false,
    trainMode: 'pretrain',
  }
}

function withPublicTwins(state: SimState, releaseDay: number): SimState {
  const playerModel = releasedTwin('player-aged', releaseDay)
  const rival = state.rivals[0]!
  const next: SimState = {
    ...state,
    day: 400,
    player: {
      ...state.player,
      models: [playerModel],
      pricing: {
        ...state.player.pricing,
        activeModelId: playerModel.id,
        apiModelIds: [playerModel.id],
        plans: state.player.pricing.plans.map((plan) => ({
          ...plan,
          modelIds: [playerModel.id],
        })),
      },
    },
    rivals: state.rivals.map((entry, index) =>
      index === 0
        ? {
            ...rival,
            models: [releasedTwin('rival-aged', releaseDay)],
          }
        : { ...entry, models: [] },
    ),
  }
  return syncLabIndex(next)
}

describe('model age penalty curve', () => {
  it('stays at zero through the grace window, then ramps smoothly to a cap', () => {
    expect(modelAgePenalty(0)).toBe(0)
    expect(modelAgePenalty(MODEL_AGE_GRACE_DAYS)).toBe(0)
    expect(modelAgePenalty(MODEL_AGE_GRACE_DAYS + 0.5)).toBeGreaterThan(0)
    expect(modelAgePenalty(MODEL_AGE_GRACE_DAYS + 0.5)).toBeLessThan(0.05)

    const month = modelAgePenalty(MODEL_AGE_GRACE_DAYS + 30 + 22) -
      modelAgePenalty(MODEL_AGE_GRACE_DAYS + 22)
    expect(month).toBeCloseTo(MODEL_AGE_POINTS_PER_30_DAYS, 5)

    expect(modelAgePenalty(5_000)).toBe(MODEL_AGE_PENALTY_CAP)
    expect(modelAgePenalty(5_000)).toBe(modelAgePenalty(8_000))

    const a = modelAgePenalty(MODEL_AGE_GRACE_DAYS + 10)
    const b = modelAgePenalty(MODEL_AGE_GRACE_DAYS + 11)
    const c = modelAgePenalty(MODEL_AGE_GRACE_DAYS + 12)
    expect(b - a).toBeGreaterThan(0)
    expect(Math.abs(c - b - (b - a))).toBeLessThan(0.02)
  })

  it('decays benchmarks at 0.85× the capability penalty fraction', () => {
    const aged = agedMarketView(
      { capability: 80, benchmarks: { ...emptyBenchmarks(), coding: 80 }, releaseDay: 1 },
      1 + MODEL_AGE_GRACE_DAYS + 200,
    )
    expect(aged.capability).toBeLessThan(80)
    expect(aged.capability).toBeGreaterThan(80 - MODEL_AGE_PENALTY_CAP - 0.01)
    expect(aged.benchmarks.coding).toBeLessThan(80)
    expect(aged.benchmarks.coding).toBeGreaterThan(80 * 0.7)
  })
})

describe('market-facing aging parity', () => {
  it('ages player and rival offers identically', () => {
    const state = withPublicTwins(createGame(44_201), 150)
    const offers = collectOffers(state)
    const player = offers.find((offer) => offer.labId === 'player')!
    const rival = offers.find((offer) => offer.labId === state.rivals[0]!.id)!
    expect(player.capability).toBeCloseTo(rival.capability, 8)
    expect(player.benchmarks.coding).toBeCloseTo(rival.benchmarks.coding, 8)
    expect(player.capability).toBeLessThan(72)
  })

  it('keeps a 200-day-old model in the market (floors intact)', () => {
    const fresh = agedMarketView(
      { capability: 70, benchmarks: { ...emptyBenchmarks(), coding: 70 }, releaseDay: 400 },
      400,
    )
    const stale = agedMarketView(
      { capability: 70, benchmarks: { ...emptyBenchmarks(), coding: 70 }, releaseDay: 200 },
      400,
    )
    expect(stale.capability).toBeLessThan(fresh.capability)
    expect(stale.capability).toBeGreaterThan(55)
    const offer = {
      labId: 'lab',
      modelId: 'stale',
      capability: stale.capability,
      reliability: 70,
      safety: 70,
      brandTrust: 60,
      apiPrice: 6,
      subPrice: 20,
      latencyScore: 70,
      tokPerSec: 80,
      modalities: ['text', 'tools'] as Modality[],
      isOpenWeights: false,
      benchmarks: stale.benchmarks,
    }
    expect(offerUtility(offer, 'indie_api')).toBeGreaterThan(-15)
    expect(offerUtility(offer, 'startup_api')).toBeGreaterThan(-20)
  })
})
