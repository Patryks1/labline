import { BENCHMARK_DEFS } from '../balance/benchmarks'
import { createRng, hashSeed } from '../rng'
import type {
  BenchmarkScores,
  EvaluationKind,
  EvaluationRun,
  LabId,
  Model,
  ModelReview,
  ReviewAudience,
  SimState,
} from '../types'
import { buildBenchmarkEvent } from './benchmarkEvent'
import { HISTORY_LIMITS } from './history'

const clamp = (value: number, low = 0, high = 100) =>
  Math.max(low, Math.min(high, Number.isFinite(value) ? value : low))

const REVIEW_AUDIENCES: ReviewAudience[] = [
  'consumer',
  'developers',
  'scientists',
  'creators',
  'enterprise',
]

function modelFor(
  state: SimState,
  modelId: string,
  labId: LabId = state.playerLabId,
): Model | undefined {
  if (labId === state.playerLabId) {
    return state.player.models.find((model) => model.id === modelId)
  }
  return state.rivals
    .find((rival) => rival.id === labId)
    ?.models.find((model) => model.id === modelId)
}

function brandFor(state: SimState, labId: LabId): number {
  return labId === state.playerLabId
    ? state.player.brandTrust
    : (state.rivals.find((rival) => rival.id === labId)?.brandTrust ?? 0)
}

function activeSeasonId(state: SimState): string {
  return (
    state.benchmarkSeasons.find(
      (season) => season.active && state.day >= season.opensDay && state.day <= season.closesDay,
    )?.id ??
    state.benchmarkSeasons.toSorted((a, b) => b.opensDay - a.opensDay)[0]?.id ??
    'season-foundations'
  )
}

function evaluationDelay(kind: EvaluationKind): number {
  if (kind === 'internal') return 0
  if (kind === 'public') return 3
  if (kind === 'blind_audit') return 14
  return 30
}

function evaluationConfidence(kind: EvaluationKind): number {
  if (kind === 'internal') return 0.58
  if (kind === 'public') return 0.76
  if (kind === 'blind_audit') return 0.9
  return 0.84
}

export function scheduleEvaluation(
  state: SimState,
  modelId: string,
  kind: EvaluationKind,
  delay = evaluationDelay(kind),
  labId: LabId = state.playerLabId,
): SimState {
  if (!modelFor(state, modelId, labId)) return state
  const id = `eval-${kind}-${state.day}-${labId}-${modelId}`
  if (state.evaluations.some((evaluation) => evaluation.id === id)) return state
  const publishDay = state.day + Math.max(0, Math.floor(delay))
  const run: EvaluationRun = {
    id,
    labId,
    modelId,
    seasonId: activeSeasonId(state),
    kind,
    scheduledDay: state.day,
    publishDay,
    scores: {},
    confidence: evaluationConfidence(kind),
    contaminationFlags: [],
    published: false,
  }
  return { ...state, evaluations: [...state.evaluations, run] }
}

export function scheduleReleaseEvaluations(
  state: SimState,
  modelId: string,
  labId: LabId = state.playerLabId,
): SimState {
  let next = state
  for (const kind of ['internal', 'public', 'blind_audit', 'real_world'] as const) {
    next = scheduleEvaluation(next, modelId, kind, evaluationDelay(kind), labId)
  }
  return next
}

function scoreEvaluation(state: SimState, run: EvaluationRun, model: Model): Partial<BenchmarkScores> {
  const rng = createRng(hashSeed(state.seed, run.id, run.publishDay))
  const noise =
    run.kind === 'internal' ? 4 : run.kind === 'real_world' ? 3.5 : run.kind === 'blind_audit' ? 2 : 1.25
  const scores: Partial<BenchmarkScores> = {}
  for (const benchmark of BENCHMARK_DEFS) {
    let value = model.benchmarks[benchmark.id] ?? 0
    value += rng.range(-noise, noise)
    if (run.kind === 'real_world') {
      value = value * 0.82 + model.quality.reliability * 0.18
    }
    scores[benchmark.id] = Math.round(clamp(value) * 10) / 10
  }
  return scores
}

function audienceCapability(model: Model, audience: ReviewAudience): number {
  const vector = model.capabilities
  if (vector) {
    const domains = vector.domains
    if (audience === 'developers') return domains.code * 0.55 + domains.tools * 0.25 + domains.reasoning * 0.2
    if (audience === 'scientists') return domains.science * 0.5 + domains.math * 0.3 + vector.factuality * 0.2
    if (audience === 'creators') return domains.vision * 0.45 + domains.video * 0.35 + domains.audio * 0.2
    if (audience === 'enterprise') return domains.reasoning * 0.35 + domains.tools * 0.2 + vector.reliability * 0.45
    return domains.language * 0.5 + domains.vision * 0.2 + vector.steerability * 0.3
  }
  if (audience === 'developers') return model.benchmarks.coding * 0.65 + model.benchmarks.agents * 0.35
  if (audience === 'scientists') return model.benchmarks.science * 0.55 + model.benchmarks.math * 0.45
  if (audience === 'creators') return model.benchmarks.vision
  if (audience === 'enterprise') return model.capability * 0.55 + model.quality.reliability * 0.45
  return model.quality.chat * 0.55 + model.capability * 0.45
}

export interface MarketEvaluation {
  capability: number
  value: number
  productQuality: number
  trust: number
  overall: number
  factors: {
    price: number
    speed: number
    reliability: number
    brand: number
  }
}

/** Decomposable review utility used by both the review feed and UI inspectors. */
export function evaluateMarket(
  state: SimState,
  modelId: string,
  audience: ReviewAudience,
  labId: LabId = state.playerLabId,
): MarketEvaluation | null {
  const model = modelFor(state, modelId, labId)
  if (!model) return null
  const capability = clamp(audienceCapability(model, audience))
  const price = Math.max(0.01, model.apiPricePerMTok ?? model.suggestedApiPrice ?? 1)
  const referencePrice = Math.max(0.01, model.suggestedApiPrice ?? price)
  const priceFactor = clamp(50 - Math.log(price / referencePrice) * 22)
  const speedFactor = clamp(42 + Math.log1p(Math.max(0.01, model.tokPerSecMult) * 4) * 20)
  const reliability = clamp(model.quality.reliability)
  const brand = clamp(brandFor(state, labId))
  const value = clamp(capability * 0.58 + priceFactor * 0.3 + speedFactor * 0.12)
  const productQuality = clamp(reliability * 0.62 + speedFactor * 0.23 + model.quality.chat * 0.15)
  const trust = clamp(model.quality.safety * 0.45 + reliability * 0.35 + brand * 0.2)
  return {
    capability,
    value,
    productQuality,
    trust,
    overall: clamp(capability * 0.35 + value * 0.25 + productQuality * 0.22 + trust * 0.18),
    factors: { price: priceFactor, speed: speedFactor, reliability, brand },
  }
}

export function publishReview(
  state: SimState,
  modelId: string,
  audience: ReviewAudience,
  phase: ModelReview['phase'],
  labId: LabId = state.playerLabId,
): SimState {
  const model = modelFor(state, modelId, labId)
  const result = evaluateMarket(state, modelId, audience, labId)
  if (!model || !result) return state
  const id = `review-${phase}-${audience}-${labId}-${modelId}-${state.day}`
  if (state.reviews.some((review) => review.id === id)) return state
  const verdict =
    result.overall >= 78
      ? 'sets a new bar'
      : result.overall >= 64
        ? 'earns a strong recommendation'
        : result.overall >= 50
          ? 'is competitive for the price'
          : 'needs another iteration'
  const review: ModelReview = {
    id,
    labId,
    modelId,
    audience,
    capability: Math.round(result.capability * 10) / 10,
    value: Math.round(result.value * 10) / 10,
    productQuality: Math.round(result.productQuality * 10) / 10,
    trust: Math.round(result.trust * 10) / 10,
    publishedDay: state.day,
    phase,
    headline: `${model.name} ${verdict} for ${audience}.`,
  }
  return {
    ...state,
    reviews: [review, ...state.reviews].slice(0, HISTORY_LIMITS.reviews),
    news: [`Day ${state.day}: ${review.headline}`, ...state.news].slice(0, 64),
  }
}

function ensureBenchmarkSeason(state: SimState): SimState {
  if (!state.calendar.isTechnologyDay) return state
  if (state.benchmarkSeasons.some((season) => season.opensDay === state.day)) return state
  const previous = state.benchmarkSeasons.toSorted((a, b) => b.opensDay - a.opensDay)[0]
  const seasons = state.benchmarkSeasons.map((season) => ({ ...season, active: false }))
  seasons.push({
    id: `season-${state.calendar.year}-frontier`,
    name: `Frontier Methods ${state.calendar.year}`,
    version: (previous?.version ?? 0) + 1,
    opensDay: state.day,
    closesDay: state.day + (state.calendar.year % 4 === 0 ? 365 : 364),
    difficulty: Math.min(0.95, (previous?.difficulty ?? 0.4) + 0.035),
    hiddenTasks: true,
    active: true,
  })
  return { ...state, benchmarkSeasons: seasons }
}

export function tickEvaluations(state: SimState): SimState {
  let next = ensureBenchmarkSeason(state)
  const publishedPublicModels: { model: Model; labId: LabId; run: EvaluationRun }[] = []
  const due: EvaluationRun[] = []
  const evaluations = next.evaluations.map((run) => {
    if (run.published || run.publishDay > next.day) return run
    const labId = run.labId ?? next.playerLabId
    const model = modelFor(next, run.modelId, labId)
    if (!model) return { ...run, published: true }
    const resolved = { ...run, scores: scoreEvaluation(next, run, model), published: true }
    due.push(resolved)
    return resolved
  })
  next = { ...next, evaluations }

  for (const run of due) {
    const labId = run.labId ?? next.playerLabId
    if (run.kind === 'public') {
      const publicModel = modelFor(next, run.modelId, labId)
      if (publicModel) publishedPublicModels.push({ model: publicModel, labId, run })
      for (const audience of REVIEW_AUDIENCES) {
        next = publishReview(next, run.modelId, audience, 'launch', labId)
      }
    } else if (run.kind === 'real_world') {
      for (const audience of REVIEW_AUDIENCES) {
        next = publishReview(next, run.modelId, audience, 'field_30', labId)
      }
    }
  }
  for (const published of publishedPublicModels) {
    const event = buildBenchmarkEvent(next, published.model, next.day, published.run.scores)
    const labName =
      published.labId === next.playerLabId
        ? next.player.name
        : (next.rivals.find((rival) => rival.id === published.labId)?.name ?? 'Rival')
    next = {
      ...next,
      lastBenchmarkEvent:
        published.labId === next.playerLabId ? event : next.lastBenchmarkEvent,
      news: [
        `Day ${next.day}: Independent benchmark — ${labName}: ${event.headline}`,
        ...next.news,
      ].slice(0, 64),
    }
  }
  if (next.calendar.isReviewDay) {
    for (const model of next.player.models.filter((item) => item.release === 'released' || item.shipped)) {
      for (const audience of REVIEW_AUDIENCES) {
        next = publishReview(next, model.id, audience, 'quarterly', next.playerLabId)
      }
    }
    for (const rival of next.rivals) {
      for (const model of rival.models.filter((item) => item.release === 'released' || item.shipped)) {
        for (const audience of REVIEW_AUDIENCES) {
          next = publishReview(next, model.id, audience, 'quarterly', rival.id)
        }
      }
    }
  }
  return next
}
