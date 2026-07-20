import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { buildScaledModel } from '../../../sim/balance/modelBuild'
import { buildApiReviewGroups, buildAudienceReviewGroups, buildPlanReviewGroups } from './planReviews'

describe('plan audience reviews', () => {
  it('creates a distinct reviewer set for every enabled player plan', () => {
    const state = createGame(815)
    state.player.pricing.plans[1]!.enabled = false

    const groups = buildPlanReviewGroups(state)

    expect(groups.map((group) => group.planName)).toEqual(['Free', 'Pro'])
    expect(groups[0]!.reviews.map((review) => review.id)).toEqual([
      'enterprise',
      'youtuber',
      'scientist',
      'coder',
      'public',
    ])
    expect(groups[0]!.reviews.find((review) => review.id === 'coder')?.metrics.map((metric) => metric.label)).toEqual([
      'Coding',
      'Price',
      'Speed',
      'Practice',
    ])
    expect(groups[0]!.reviews.find((review) => review.id === 'youtuber')?.metrics.map((metric) => metric.label)).toEqual([
      'Coding',
      'Image',
      'Video',
      'Price',
      'Capability',
      'Practice',
    ])
    expect(groups[0]!.reviews.find((review) => review.id === 'public')?.metrics.map((metric) => metric.label)).toEqual([
      'Speed',
      'Price',
      'Image',
      'Audio',
      'Practice',
    ])
  })

  it('calls out benchmark overfit when synthetic-heavy models underperform in practice', () => {
    const state = createGame(816)
    const model = buildScaledModel({
      id: 'overfit-api', name: 'Benchmark Star', family: 'dense', paramsB: 1,
      day: 12, dataCoverage: 2, dataQuality: 85, modalities: ['text'],
    })
    model.benchmarkOverfit = 0.35
    state.player.models = [model]

    const reviews = buildApiReviewGroups(state)[0]!.reviews
    expect(reviews.every((review) => review.metrics.some((metric) => metric.label === 'Practice'))).toBe(true)
    expect(reviews.find((review) => review.id === 'scientist')?.summary).toContain('inflate benchmarks')
    expect(reviews.find((review) => review.id === 'coder')?.summary).toContain('real repositories')
  })

  it('adds one API review target for every released player model', () => {
    const state = createGame(816)
    const first = buildScaledModel({
      id: 'review-api-1',
      name: 'Spark',
      family: 'dense',
      paramsB: 1,
      day: 12,
      dataCoverage: 1,
      dataQuality: 72,
      modalities: ['text'],
    })
    const second = buildScaledModel({
      id: 'review-api-2',
      name: 'Canvas',
      family: 'diffusion',
      paramsB: 2,
      day: 13,
      dataCoverage: 1,
      dataQuality: 72,
      modalities: ['image'],
    })
    state.player.models = [first, second]

    const apiGroups = buildApiReviewGroups(state)
    const allGroups = buildAudienceReviewGroups(state)

    expect(apiGroups.map((group) => group.reviewName)).toEqual(['API · Spark', 'API · Canvas'])
    expect(apiGroups[0]!.modelNames).toEqual(['Spark'])
    expect(apiGroups[0]!.reviews).toHaveLength(5)
    expect(allGroups.slice(-2).map((group) => group.reviewId)).toEqual([
      'api:review-api-1',
      'api:review-api-2',
    ])
  })
})
