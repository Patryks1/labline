import type { BenchmarkSuiteId, Model } from '../../sim/types'
import type {
  CheckpointEvaluationReport,
  CheckpointMetricEvaluation,
  CheckpointSuiteEvaluation,
} from '../../sim/balance/checkpointEvaluation'

export interface MeasuredReleaseEvidence {
  report: CheckpointEvaluationReport
  suite: CheckpointSuiteEvaluation
  metrics: CheckpointMetricEvaluation[]
  rankLabel: string
}

/** A release event with an ID must never fall through to a same-name revision. */
export function releasedModelForEvent(
  models: readonly Model[],
  releaseModelId: string | undefined,
  releaseName: string,
): Model | undefined {
  return releaseModelId != null
    ? models.find((model) => model.id === releaseModelId)
    : models.find((model) => model.name === releaseName)
}

/**
 * Build the release review from retained blind-panel measurements only.
 * Latent capability and benchmark suites are deliberately not accepted here.
 */
export function measuredReleaseEvidence(
  model: Model | undefined,
  preferredSuiteIds: readonly BenchmarkSuiteId[],
): MeasuredReleaseEvidence | null {
  if (!model) return null
  const reports = (model.checkpointEvaluations ?? [])
    .filter((report) => report.modelId === model.id)
    .sort((a, b) => b.completedDay - a.completedDay || b.id.localeCompare(a.id))
  const report = reports[0]
  if (!report) return null
  const suite =
    preferredSuiteIds
      .map((suiteId) => report.suites.find((candidate) => candidate.suiteId === suiteId))
      .find((candidate): candidate is CheckpointSuiteEvaluation => candidate != null) ??
    report.suites[0]
  if (!suite) return null

  const ranks = suite.metrics
    .map((metric) => metric.rival?.rank)
    .filter((rank): rank is number => rank != null && rank > 0)
    .sort((a, b) => a - b)
  const rankLabel = ranks.length
    ? `#${Math.round(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length)}`
    : '—'

  return {
    report,
    suite,
    metrics: suite.metrics,
    rankLabel,
  }
}
