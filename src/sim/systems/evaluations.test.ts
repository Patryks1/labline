import { describe, expect, it } from 'vitest'
import { emptyBenchmarks } from '../balance/benchmarks'
import { createGame } from '../createGame'
import type { Model, SimState } from '../types'
import {
  evaluateMarket,
  scheduleReleaseEvaluations,
  tickEvaluations,
} from './evaluations'
import { collectQuarterlyLabSnapshots } from './progression'

function withReleasedModel(): SimState {
  const state = createGame(501)
  const scores = emptyBenchmarks()
  for (const key of Object.keys(scores) as (keyof typeof scores)[]) scores[key] = 68
  const model: Model = {
    id: 'model-eval',
    name: 'Proofline',
    family: 'dense',
    paramsB: 7,
    capability: 66,
    modalities: ['text', 'tools'],
    quality: { reasoning: 72, coding: 76, chat: 64, image: 5, video: 2, safety: 70, reliability: 74 },
    benchmarks: { ...scores, coding: 78, math: 75, science: 73, agents: 72 },
    postTrain: 'rlhf',
    trainComputeSpent: 50,
    releaseDay: 1,
    shipped: true,
    release: 'released',
    tokPerSecMult: 0.8,
    inferCostMult: 1,
    apiPricePerMTok: 2,
    apiPriceInPerMTok: 1,
    apiPriceOutPerMTok: 3,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.3,
    costApiPriceOut: 0.9,
    distilled: false,
    trainMode: 'pretrain',
  }
  state.player.models = [model]
  return state
}

describe('delayed evaluation and reviews', () => {
  it('schedules internal, public, blind, and field reports separately', () => {
    const state = scheduleReleaseEvaluations(withReleasedModel(), 'model-eval')
    expect(state.evaluations.map((run) => run.publishDay - state.day)).toEqual([0, 3, 14, 30])
    expect(state.evaluations.every((run) => !run.published)).toBe(true)
  })

  it('publishes deterministically on each due date', () => {
    const base = scheduleReleaseEvaluations(withReleasedModel(), 'model-eval')
    const a = tickEvaluations({ ...base, day: 4 })
    const b = tickEvaluations({ ...base, day: 4 })
    expect(a.evaluations).toEqual(b.evaluations)
    expect(a.evaluations.find((run) => run.kind === 'public')?.published).toBe(true)
    expect(a.reviews.filter((review) => review.phase === 'launch')).toHaveLength(5)
  })

  it('uses the same delayed evaluation and review pipeline for rivals', () => {
    const base = withReleasedModel()
    const rivalId = base.rivals[0]!.id
    const model = base.player.models[0]!
    base.player.models = []
    base.rivals[0] = { ...base.rivals[0]!, models: [model] }

    let state = scheduleReleaseEvaluations(base, model.id, rivalId)
    expect(state.evaluations).toHaveLength(4)
    expect(state.evaluations.every((run) => run.labId === rivalId)).toBe(true)

    state = tickEvaluations({ ...state, day: 4 })
    expect(
      state.reviews.filter(
        (review) => review.labId === rivalId && review.phase === 'launch',
      ),
    ).toHaveLength(5)
    expect(state.lastBenchmarkEvent).toBeNull()

    state = tickEvaluations({ ...state, day: 31 })
    expect(
      state.reviews.filter(
        (review) => review.labId === rivalId && review.phase === 'field_30',
      ),
    ).toHaveLength(5)
  })

  it('publishes every concurrent lab result without losing the player reveal', () => {
    let state = withReleasedModel()
    const rival = state.rivals[0]!
    const rivalModel = {
      ...state.player.models[0]!,
      id: 'model-rival-eval',
      name: 'Rival Proofline',
    }
    state.rivals[0] = { ...rival, models: [rivalModel] }
    state = scheduleReleaseEvaluations(state, 'model-eval')
    state = scheduleReleaseEvaluations(state, rivalModel.id, rival.id)

    state = tickEvaluations({ ...state, day: 4 })

    expect(state.lastBenchmarkEvent?.modelId).toBe('model-eval')
    expect(state.news.some((entry) => entry.includes(state.player.name))).toBe(true)
    expect(state.news.some((entry) => entry.includes(rival.name))).toBe(true)
    expect(
      state.reviews.filter((review) => review.phase === 'launch'),
    ).toHaveLength(10)
  })

  it('feeds rival blind-audit scores into the same milestone snapshot', () => {
    const state = withReleasedModel()
    const rival = state.rivals[0]!
    const model = state.player.models[0]!
    state.player.models = []
    state.rivals[0] = { ...rival, models: [model] }
    state.evaluations = [
      {
        id: 'rival-blind-proof',
        labId: rival.id,
        modelId: model.id,
        seasonId: 'season-foundations',
        kind: 'blind_audit',
        scheduledDay: 1,
        publishDay: 14,
        scores: Object.fromEntries(
          Object.keys(model.benchmarks).map((key) => [key, 42]),
        ),
        confidence: 0.9,
        contaminationFlags: [],
        published: true,
      },
    ]

    const snapshot = collectQuarterlyLabSnapshots(state).find(
      (entry) => entry.labId === rival.id,
    )
    expect(snapshot?.independentCapability).toBe(42)
  })

  it('decomposes value and penalizes a higher price', () => {
    const state = withReleasedModel()
    const cheap = evaluateMarket(state, 'model-eval', 'developers')!
    state.player.models[0] = { ...state.player.models[0]!, apiPricePerMTok: 8 }
    const expensive = evaluateMarket(state, 'model-eval', 'developers')!
    expect(expensive.capability).toBe(cheap.capability)
    expect(expensive.value).toBeLessThan(cheap.value)
    expect(expensive.factors.price).toBeLessThan(cheap.factors.price)
  })
})
