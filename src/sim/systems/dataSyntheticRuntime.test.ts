import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from '../balance/benchmarks'
import {
  estimateSyntheticQuality,
  teacherCapabilityForDataDomain,
} from '../balance/modelCapabilities'
import { createGame } from '../createGame'
import type { Model } from '../types'
import { startSynthGen, synthTeacherFreshness, tickData } from './data'

function teacher(): Model {
  return {
    id: 'teacher-domain-runtime',
    name: 'Domain Teacher',
    family: 'dense',
    paramsB: 7,
    capability: 72,
    capabilities: {
      domains: {
        language: 78,
        reasoning: 60,
        code: 32,
        math: 28,
        science: 35,
        vision: 18,
        video: 8,
        audio: 12,
        tools: 30,
      },
      factuality: 64,
      steerability: 70,
      robustness: 62,
      safety: 72,
      reliability: 75,
    },
    modalities: ['text'],
    quality: {
      reasoning: 65,
      coding: 40,
      chat: 74,
      image: 10,
      video: 5,
      safety: 72,
      reliability: 75,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: 'rlhf',
    trainComputeSpent: 80,
    releaseDay: 1,
    shipped: true,
    release: 'released',
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: 2,
    apiPriceInPerMTok: 1,
    apiPriceOutPerMTok: 3,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: 'pretrain',
  }
}

describe('synthetic data runtime', () => {
  it('prices generated quality from the teacher domain and persisted provenance', () => {
    let state = createGame(702)
    const model = teacher()
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, 'data_synth'],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    }
    state = startSynthGen(state, {
      domain: 'chat',
      modelId: model.id,
      targetMTok: 5,
      researchShare: 0.5,
      qualityTier: 'hq',
    })
    state = tickData(state)

    const asset = state.player.data.assets.find((item) => item.source === 'synthetic')
    expect(asset?.synthetic).toBeDefined()
    const expected = estimateSyntheticQuality({
      domain: 'chat',
      teacherDomainCapability: teacherCapabilityForDataDomain(model, 'chat'),
      provenance: asset!.synthetic!,
    })
    expect(asset?.quality).toBeCloseTo(expected.quality, 8)
    expect(asset!.quality).toBeLessThanOrEqual(model.capabilities!.domains.language)
    expect(state.player.data.stocks.chat.quality).toBeLessThanOrEqual(
      model.capabilities!.domains.language,
    )
  })

  it('runs continuously and degrades corpus quality when a stronger frontier teacher appears', () => {
    const model = teacher()
    const frontier = {
      ...teacher(),
      id: 'frontier-teacher',
      name: 'Frontier Teacher',
      capability: 95,
      capabilities: {
        ...teacher().capabilities!,
        domains: { ...teacher().capabilities!.domains, language: 98 },
      },
    }
    let state = createGame(703)
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, 'data_synth'],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [{ ...state.rivals[0]!, models: [frontier] }],
    }
    state = startSynthGen(state, {
      domain: 'chat',
      modelId: model.id,
      researchShare: 0.35,
      qualityTier: 'hq',
    })
    expect(state.player.data.synthQueue[0]?.continuous).toBe(true)
    state = tickData(state)
    const first = state.player.data.synthQueue[0]?.progressMTok ?? 0
    state = tickData({ ...state, day: state.day + 1 })
    expect(state.player.data.synthQueue[0]?.progressMTok).toBeGreaterThan(first)
    expect(synthTeacherFreshness(state, model, 'chat').freshness).toBeLessThan(1)
    const asset = state.player.data.assets.find((item) => item.source === 'synthetic')
    expect(asset?.freshness).toBeLessThan(1)
  })
})
