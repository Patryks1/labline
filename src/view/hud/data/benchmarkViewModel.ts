import {
  buildBenchmarkSuites,
  normalizeModelEvaluations,
  SUITE_METRICS,
} from '../../../sim/balance/evaluationSuites'
import type {
  BenchmarkMetricId,
  BenchmarkSuiteId,
  BenchmarkSuiteScores,
  EvaluationProfile,
  Model,
} from '../../../sim/types'

export type BenchmarkViewContext =
  | { kind: 'public' }
  | {
      kind: 'private-evidence'
      scores?: Partial<Record<BenchmarkMetricId, number>>
      profile?: EvaluationProfile
    }

export interface BenchmarkViewModel {
  suiteId: BenchmarkSuiteId
  metrics: typeof SUITE_METRICS[BenchmarkSuiteId]
  scores: Partial<Record<BenchmarkMetricId, number>>
  profile: EvaluationProfile
  source: BenchmarkViewContext['kind']
}

export interface PublicBenchmarkData {
  suites: BenchmarkSuiteScores
  profile: EvaluationProfile
}

/**
 * Build the one public benchmark projection used by leaderboard, comparison,
 * and released-model cards. Legacy models are normalized here; consumers do
 * not read persisted suite fields directly.
 */
export function buildPublicBenchmarkData(model: Model): PublicBenchmarkData {
  const normalized = normalizeModelEvaluations(model)
  const normalizedSuites = normalized.benchmarkSuites
  const generated =
    normalizedSuites && Object.keys(normalizedSuites).length > 0
      ? {
          suites: normalizedSuites,
          profile: normalized.evaluationProfile ?? {},
        }
      : buildBenchmarkSuites(normalized)
  return {
    suites: generated.suites,
    profile: generated.profile,
  }
}

export function benchmarkMetricsForSuite(suiteId: BenchmarkSuiteId) {
  return SUITE_METRICS[suiteId]
}

export function publicBenchmarkScores(
  model: Model,
  suiteId: BenchmarkSuiteId,
): Partial<Record<BenchmarkMetricId, number>> {
  return buildPublicBenchmarkData(model).suites[suiteId] ?? {}
}

export function publicBenchmarkScore(
  model: Model,
  suiteId: BenchmarkSuiteId,
  metricId: BenchmarkMetricId,
): number | undefined {
  const score = publicBenchmarkScores(model, suiteId)[metricId]
  return Number.isFinite(score) ? score : undefined
}

export function publicBenchmarkSuiteIds(model: Model): BenchmarkSuiteId[] {
  return Object.keys(buildPublicBenchmarkData(model).suites) as BenchmarkSuiteId[]
}

/**
 * Canonical presentation adapter for benchmark charts.
 *
 * Public model cards use the shared evaluation-suite policy. Private checkpoint
 * evidence must be passed explicitly by its owner; this function never falls
 * back to a model's public capability/benchmark fields for that context.
 */
export function buildBenchmarkViewModel(
  model: Model,
  suiteId: BenchmarkSuiteId,
  context: BenchmarkViewContext,
): BenchmarkViewModel {
  if (context.kind === 'private-evidence') {
    return {
      suiteId,
      metrics: benchmarkMetricsForSuite(suiteId),
      scores: context.scores ?? {},
      profile: context.profile ?? {},
      source: context.kind,
    }
  }

  const generated = buildPublicBenchmarkData(model)
  return {
    suiteId,
    metrics: benchmarkMetricsForSuite(suiteId),
    scores: generated.suites[suiteId] ?? {},
    profile: generated.profile,
    source: context.kind,
  }
}
