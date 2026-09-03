import type { BenchmarkSuiteId, Model, SimState } from '../../sim/types'
import type {
  CheckpointEvaluationReport,
  CheckpointMetricEvaluation,
  CheckpointSuiteEvaluation,
} from '../../sim/balance/checkpointEvaluation'
import { publicScores } from '../../sim/training/evaluate'
import { trainingStateOf } from '../../sim/training/state'
import type { Endpoint } from '../../sim/training/types'
import { sizeLabel } from './panels/models/viewModels/selectors'

export interface MeasuredReleaseEvidence {
  report: CheckpointEvaluationReport
  suite: CheckpointSuiteEvaluation
  metrics: CheckpointMetricEvaluation[]
  rankLabel: string
}

export interface EndpointCelebrationFacts {
  endpoint: Endpoint
  sizeLabel: string
  overall?: number
  memberCount: number
  isRouter: boolean
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

export function liveEndpointsOf(state: SimState): Endpoint[] {
  return trainingStateOf(state, state.playerLabId).endpoints.filter(
    (endpoint) => endpoint.status === 'live',
  )
}

/** Ids of live endpoints that were not in the previously seen set. */
export function diffNewLiveEndpointIds(
  seen: ReadonlySet<string>,
  endpoints: readonly Pick<Endpoint, 'id' | 'status'>[],
): string[] {
  return endpoints
    .filter((endpoint) => endpoint.status === 'live' && !seen.has(endpoint.id))
    .map((endpoint) => endpoint.id)
}

export function endpointCelebrationFacts(
  state: SimState,
  endpoint: Endpoint,
): EndpointCelebrationFacts {
  const training = trainingStateOf(state, state.playerLabId)
  const primary =
    endpoint.members.find((member) => member.role === 'primary') ?? endpoint.members[0]
  const checkpoint = training.checkpoints.find((row) => row.id === primary?.checkpointId)
  let overall: number | undefined
  try {
    overall = publicScores(state, endpoint.id).overall
  } catch {
    overall = undefined
  }
  return {
    endpoint,
    sizeLabel: checkpoint ? sizeLabel(checkpoint.arch) : '—',
    overall,
    memberCount: endpoint.members.length,
    isRouter: endpoint.policy !== 'single' || endpoint.members.length > 1,
  }
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
