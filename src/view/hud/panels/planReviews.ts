import { planAllowanceMTokPerMonth } from '../../../sim/systems/plans'
import { splitBlendedApiPrice } from '../../../sim/balance/pricing'
import type { Model, SimState, SubPlan } from '../../../sim/types'

export interface PlanReviewMetric {
  label: string
  value: number
}

export interface PlanAudienceReview {
  id: 'enterprise' | 'youtuber' | 'scientist' | 'coder' | 'public'
  label: string
  summary: string
  score: number
  metrics: PlanReviewMetric[]
}

export interface PlanReviewGroup {
  reviewId: string
  reviewKind: 'plan'
  reviewName: string
  planId: string
  planName: string
  pricePerMonth: number
  apiPriceInPerMTok: null
  apiPriceOutPerMTok: null
  modelNames: string[]
  reviews: PlanAudienceReview[]
}

export interface ApiReviewGroup {
  reviewId: string
  reviewKind: 'api'
  reviewName: string
  modelId: string
  pricePerMonth: null
  apiPriceInPerMTok: number
  apiPriceOutPerMTok: number
  modelNames: string[]
  reviews: PlanAudienceReview[]
}

export type AudienceReviewGroup = PlanReviewGroup | ApiReviewGroup

interface ModelReviewScores {
  capability: number
  coding: number
  image: number
  video: number
  audio: number
  media: number
  intelligence: number
  speed: number
  practice: number
  overfit: number
}

const clamp = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))

function average(models: Model[], score: (model: Model) => number): number {
  if (models.length === 0) return 0
  return models.reduce((sum, model) => sum + score(model), 0) / models.length
}

function planModels(state: SimState, plan: SubPlan): Model[] {
  const released = state.player.models.filter(
    (model) => model.release === 'released' || model.shipped,
  )
  const byId = new Map(released.map((model) => [model.id, model]))
  const assigned = [...new Set(plan.modelIds)]
    .map((id) => byId.get(id))
    .filter((model): model is Model => model != null)
  if (assigned.length > 0) return assigned
  const active = released.find((model) => model.id === state.player.pricing.activeModelId)
  return active ? [active] : released.slice(0, 1)
}

function reviewSummary(
  reviewer: PlanAudienceReview['id'],
  scores: Record<string, number>,
  reviewKind: AudienceReviewGroup['reviewKind'],
): string {
  if (scores.overfit >= 12) {
    if (reviewer === 'enterprise') return 'The benchmark sheet looks strong, but pilot results are less reliable.'
    if (reviewer === 'youtuber') return 'Great benchmark demos, though longer real projects expose brittle behavior.'
    if (reviewer === 'scientist') return 'Synthetic-heavy training appears to inflate benchmarks beyond field performance.'
    if (reviewer === 'coder') return 'The coding scores look better than the model feels on real repositories.'
    return 'Polished benchmark results do not consistently carry into everyday use.'
  }
  if (reviewer === 'enterprise') {
    if (scores.capability < 48) return 'The contract price is hard to defend at this capability level.'
    if (scores.price < 45) return 'Capable, but procurement will push back on the price.'
    return 'Strong capability at a price procurement can justify.'
  }
  if (reviewer === 'youtuber') {
    if (scores.media < 45) return 'The demos need better image and video output before this feels exciting.'
    if (scores.coding < 45) return 'Creative tools look promising, but the coding demo falls apart.'
    if (scores.price < 45) return 'Great demo material, though the price weakens the recommendation.'
    return 'A convincing creator package with useful coding and media chops.'
  }
  if (reviewer === 'scientist') {
    if (scores.intelligence < 50) return 'The general-intelligence evidence is too shallow for serious research work.'
    if (scores.capability < 55) return 'Interesting reasoning, but overall capability still limits research use.'
    return 'The intelligence profile is credible enough for demanding research workflows.'
  }
  if (reviewer === 'coder') {
    if (scores.coding < 50) return 'Coding performance needs another iteration before developers should pay.'
    if (scores.speed < 50) return 'The answers are useful, but latency breaks the coding flow.'
    if (scores.price < 45) return 'Fast and capable, but poor bang for buck for everyday coding.'
    return 'Fast coding performance and fair pricing make this easy to recommend.'
  }
  if (scores.speed < 50) return 'It feels slow in everyday use, even when the answer is good.'
  if (scores.price < 45) {
    return reviewKind === 'api'
      ? 'The API price is the main reason developers will look elsewhere.'
      : 'The monthly price is the main reason to skip this plan.'
  }
  if (scores.media < 45) return 'Text is usable, but image and audio features feel behind.'
  return reviewKind === 'api'
    ? 'Quick, affordable, and versatile enough to build on.'
    : 'Quick, affordable, and versatile enough for everyday users.'
}

function modelScores(
  models: Model[],
  serviceHealth: number,
): ModelReviewScores {
  const capability = clamp(average(models, (model) => model.capability))
  const coding = clamp(
    average(
      models,
      (model) => model.capabilities?.domains.code ?? model.benchmarks.coding ?? model.quality.coding,
    ),
  )
  const image = clamp(
    average(models, (model) => model.capabilities?.domains.vision ?? model.quality.image),
  )
  const video = clamp(
    average(models, (model) => model.capabilities?.domains.video ?? model.quality.video),
  )
  const audio = clamp(
    average(models, (model) => model.capabilities?.domains.audio ?? model.quality.chat * 0.55),
  )
  const media = clamp(image * 0.42 + video * 0.36 + audio * 0.22)
  const intelligence = clamp(
    average(models, (model) => {
      const domains = model.capabilities?.domains
      return domains
        ? model.capability * 0.34 + domains.reasoning * 0.26 + domains.math * 0.2 + domains.science * 0.2
        : model.capability * 0.45 + model.benchmarks.mmlu * 0.25 + model.benchmarks.math * 0.15 + model.benchmarks.science * 0.15
    }),
  )
  const rawSpeed = average(
    models,
    (model) => model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult,
  )
  const speed = clamp((35 + Math.log2(Math.max(1, rawSpeed) / 20) * 19) * serviceHealth)
  const overfit = clamp(average(models, (model) => (model.benchmarkOverfit ?? 0) * 100))
  const practice = clamp(capability - overfit * 0.28)
  return { capability, coding, image, video, audio, media, intelligence, speed, practice, overfit }
}

function buildAudienceReviews(
  models: Model[],
  price: number,
  serviceHealth: number,
  reviewKind: AudienceReviewGroup['reviewKind'],
): PlanAudienceReview[] {
  const scores = { ...modelScores(models, serviceHealth), price: clamp(price) }
  const definitions: Array<{
    id: PlanAudienceReview['id']
    label: string
    metrics: PlanReviewMetric[]
    score: number
  }> = [
    {
      id: 'enterprise',
      label: 'Enterprise review',
      metrics: [{ label: 'Price', value: scores.price }, { label: 'Capability', value: scores.capability }, { label: 'Practice', value: scores.practice }],
      score: scores.capability * 0.42 + scores.practice * 0.2 + scores.price * 0.38,
    },
    {
      id: 'youtuber',
      label: 'YouTuber review',
      metrics: [
        { label: 'Coding', value: scores.coding },
        { label: 'Image', value: scores.image },
        { label: 'Video', value: scores.video },
        { label: 'Price', value: scores.price },
        { label: 'Capability', value: scores.capability },
        { label: 'Practice', value: scores.practice },
      ],
      score: scores.coding * 0.18 + scores.media * 0.28 + scores.price * 0.2 + scores.capability * 0.19 + scores.practice * 0.15,
    },
    {
      id: 'scientist',
      label: 'Scientist review',
      metrics: [{ label: 'General intelligence', value: scores.intelligence }, { label: 'Capability', value: scores.capability }, { label: 'Practice', value: scores.practice }],
      score: scores.intelligence * 0.55 + scores.capability * 0.25 + scores.practice * 0.2,
    },
    {
      id: 'coder',
      label: 'Coder review',
      metrics: [{ label: 'Coding', value: scores.coding }, { label: 'Price', value: scores.price }, { label: 'Speed', value: scores.speed }, { label: 'Practice', value: scores.practice }],
      score: scores.coding * 0.4 + scores.price * 0.18 + scores.speed * 0.22 + scores.practice * 0.2,
    },
    {
      id: 'public',
      label: 'Public review',
      metrics: [{ label: 'Speed', value: scores.speed }, { label: 'Price', value: scores.price }, { label: 'Image', value: scores.image }, { label: 'Audio', value: scores.audio }, { label: 'Practice', value: scores.practice }],
      score: scores.speed * 0.32 + scores.price * 0.3 + scores.media * 0.2 + scores.practice * 0.18,
    },
  ]

  return definitions.map((review) => ({
    ...review,
    score: clamp(review.score),
    summary: reviewSummary(review.id, scores, reviewKind),
  }))
}

function modelApiRates(state: SimState, model: Model): { input: number; output: number } {
  const pricing = state.player.pricing
  const blended = model.apiPricePerMTok ?? model.suggestedApiPrice ?? pricing.apiPricePerMTok
  const split = splitBlendedApiPrice(blended)
  return {
    input: Math.max(
      0,
      model.apiPriceInPerMTok ?? model.suggestedApiPriceIn ?? pricing.apiPriceInPerMTok ?? split.priceIn,
    ),
    output: Math.max(
      0,
      model.apiPriceOutPerMTok ?? model.suggestedApiPriceOut ?? pricing.apiPriceOutPerMTok ?? split.priceOut,
    ),
  }
}

export function buildPlanReviewGroups(state: SimState): PlanReviewGroup[] {
  return state.player.pricing.plans
    .filter((plan) => plan.enabled)
    .map((plan) => {
      const models = planModels(state, plan)
      const stats = state.lastMarket.planStats.find((item) => item.planId === plan.id)
      const allowance = planAllowanceMTokPerMonth(plan)
      const serviceHealth = Math.max(0.25, (stats?.serveFraction ?? 1) * (1 - state.player.servicePain * 0.55))
      const price = plan.pricePerMonth <= 0
        ? 100
        : clamp(82 - Math.log1p(plan.pricePerMonth / Math.max(0.25, allowance)) * 17)

      return {
        reviewId: `plan:${plan.id}`,
        reviewKind: 'plan' as const,
        reviewName: plan.name,
        planId: plan.id,
        planName: plan.name,
        pricePerMonth: plan.pricePerMonth,
        apiPriceInPerMTok: null,
        apiPriceOutPerMTok: null,
        modelNames: models.map((model) => model.name),
        reviews: buildAudienceReviews(models, price, serviceHealth, 'plan'),
      }
    })
}

export function buildApiReviewGroups(state: SimState): ApiReviewGroup[] {
  const serviceHealth = Math.max(0.25, 1 - state.player.servicePain * 0.55)
  return state.player.models
    .filter((model) => model.release === 'released' || model.shipped)
    .map((model) => {
      const rates = modelApiRates(state, model)
      const blendedPrice = rates.input * 0.3 + rates.output * 0.7
      const priceScore = clamp(94 - Math.log1p(blendedPrice) * 18)
      return {
        reviewId: `api:${model.id}`,
        reviewKind: 'api' as const,
        reviewName: `API · ${model.name}`,
        modelId: model.id,
        pricePerMonth: null,
        apiPriceInPerMTok: rates.input,
        apiPriceOutPerMTok: rates.output,
        modelNames: [model.name],
        reviews: buildAudienceReviews([model], priceScore, serviceHealth, 'api'),
      }
    })
}

export function buildAudienceReviewGroups(state: SimState): AudienceReviewGroup[] {
  return [...buildPlanReviewGroups(state), ...buildApiReviewGroups(state)]
}
