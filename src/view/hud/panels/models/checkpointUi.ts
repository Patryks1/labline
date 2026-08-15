import type {
  TrainingCheckpointBranchDirection,
  TrainingCheckpointCandidate,
} from "../../../../sim/types";
import type { PendingCheckpointEvaluation } from "../../../../sim/balance/checkpointEvaluation";

export type CheckpointVisibility = "stealth" | "internal" | "public";

export type CheckpointUiStatus =
  | "training"
  | "candidate"
  | "evaluating"
  | "reviewed"
  | "promoted"
  | "discarded";

export type CheckpointReviewMode =
  "internal" | "nda_external" | "partner_pilot";

export type CheckpointBranchDirection = TrainingCheckpointBranchDirection;

export interface CheckpointActionGate {
  enabled: boolean;
  reason?: string;
  label?: string;
}

export interface CheckpointBenchmarkUi {
  suiteLabel: string;
  metricLabel: string;
  score: number;
  low: number;
  high: number;
  /** Confidence that the interval contains the checkpoint's latent score. */
  confidence: number;
  accuracy?: number;
  rivalBest?: number;
  rivalName?: string;
  /** Persisted same-metric target-minus-rival delta from the report. */
  rivalDelta?: number;
}

export interface CheckpointReviewUi {
  status: "none" | "queued" | "running" | "complete";
  mode: CheckpointReviewMode;
  verdict?: "advance" | "hold" | "reject" | "inconclusive";
  headline?: string;
  summary?: string;
  strengths?: string[];
  risks?: string[];
  /** Estimated chance that outside review leaks private information (0-1). */
  leakRisk?: number;
}

export interface CheckpointEvidenceMetricUi {
  id: string;
  label: string;
  score: number;
  low: number;
  high: number;
  contaminationSignal: number;
  rival?: {
    name: string;
    score: number;
    delta: number;
    rank: number;
    fieldSize: number;
  };
}

export interface CheckpointEvidenceSuiteUi {
  id: string;
  label: string;
  accuracy: number;
  confidence: number;
  metrics: CheckpointEvidenceMetricUi[];
}

export interface CheckpointEvidenceReviewUi {
  id: string;
  panel: "internal" | "external" | "partner";
  focus: string;
  score: number;
  confidence: number;
  /** Reviewer-specific calibration offset persisted by the blind panel. */
  calibration: number;
  verdict: string;
  strengths: string[];
  concerns: string[];
}

export interface CheckpointEvidenceReportUi {
  id: string;
  day: number;
  mode: CheckpointReviewMode;
  totalCost: number;
  accuracy: number;
  confidence: number;
  leakRisk: number;
  contaminationRisk: number;
  leakOutcome: "none" | "rumor" | "identity_leak";
  flags: string[];
  suites: CheckpointEvidenceSuiteUi[];
  reviews: CheckpointEvidenceReviewUi[];
}

/** UI-only boundary. ModelsPanel can adapt simulation contracts into this shape. */
export interface CheckpointUiRecord {
  id: string;
  sourceJobId: string;
  label: string;
  day: number;
  milestone: number;
  progress: number;
  stage: string;
  kind: "milestone" | "manual";
  branchDirection?: CheckpointBranchDirection;
  parentCheckpointId?: string;
  visibility: CheckpointVisibility;
  status: CheckpointUiStatus;
  confidence: number;
  evaluationScore: {
    /** Measured/noisy report only. Never adapt the candidate model's latent truth. */
    label?: string;
    estimate?: number;
    low?: number;
    high?: number;
  };
  reportCount: number;
  pendingEvaluations: Array<{
    id: string;
    mode: CheckpointReviewMode;
    readyDay: number;
    totalCost: number;
    accuracy: number;
    confidence: number;
    leakRisk: number;
  }>;
  retainedModel?: {
    id: string;
    name: string;
    status: "internal" | "public";
  };
  evidenceReports: CheckpointEvidenceReportUi[];
  benchmark?: CheckpointBenchmarkUi;
  review?: CheckpointReviewUi;
  actions: {
    benchmark: CheckpointActionGate;
    review: CheckpointActionGate;
    promote: CheckpointActionGate;
    discard: CheckpointActionGate;
    fork: CheckpointActionGate;
    rollback: CheckpointActionGate;
  };
}

export function checkpointStatusLabel(status: CheckpointUiStatus): string {
  if (status === "training") return "Training";
  if (status === "candidate") return "Candidate";
  if (status === "evaluating") return "Evaluating";
  if (status === "reviewed") return "Reviewed";
  if (status === "promoted") return "Promoted";
  return "Discarded";
}

export function checkpointStatusTone(
  status: CheckpointUiStatus,
): "neutral" | "positive" | "warning" | "danger" | "research" {
  if (status === "promoted") return "positive";
  if (status === "evaluating" || status === "reviewed") return "research";
  if (status === "candidate" || status === "training") return "warning";
  return status === "discarded" ? "danger" : "neutral";
}

export function visibilityLabel(visibility: CheckpointVisibility): string {
  if (visibility === "stealth") return "Stealth";
  if (visibility === "internal") return "Internal";
  return "Public";
}

export function confidenceLabel(confidence: number): string {
  const value = Math.max(0, Math.min(1, confidence));
  if (value >= 0.82) return "High confidence";
  if (value >= 0.58) return "Moderate confidence";
  return "Low confidence";
}

export function checkpointReviewModeLabel(mode: CheckpointReviewMode): string {
  if (mode === "internal") return "Internal red team";
  if (mode === "nda_external") return "NDA external panel";
  return "Partner pilot";
}

export function formatBenchmarkInterval(
  benchmark: Pick<CheckpointBenchmarkUi, "score" | "low" | "high">,
): string {
  return `${benchmark.score.toFixed(1)} · ${benchmark.low.toFixed(1)}–${benchmark.high.toFixed(1)}`;
}

export function checkpointRivalDelta(
  benchmark: Pick<
    CheckpointBenchmarkUi,
    "score" | "rivalBest" | "rivalDelta"
  >,
): number | null {
  if (benchmark.rivalDelta != null && Number.isFinite(benchmark.rivalDelta)) {
    return benchmark.rivalDelta;
  }
  return benchmark.rivalBest == null
    ? null
    : benchmark.score - benchmark.rivalBest;
}

function sortedCheckpointReports(candidate: TrainingCheckpointCandidate) {
  return [...(candidate.evaluations ?? [])].sort(
    (a, b) =>
      a.completedDay - b.completedDay || a.id.localeCompare(b.id),
  );
}

function reportVerdict(
  candidate: TrainingCheckpointCandidate,
): CheckpointReviewUi["verdict"] {
  const reviews = sortedCheckpointReports(candidate).flatMap(
    (report) => report.reviews,
  );
  if (!reviews.length) return "inconclusive";
  const value = reviews.reduce((sum, review) => {
    const verdictScore =
      review.verdict === "do_not_advance"
        ? -1
        : review.verdict === "mixed"
          ? 0
          : review.verdict === "promising"
            ? 1
            : 2;
    return sum + verdictScore * Math.max(0.05, review.confidence);
  }, 0) / reviews.reduce(
    (sum, review) => sum + Math.max(0.05, review.confidence),
    0,
  );
  if (value < -0.35) return "reject";
  if (value < 0.55) return "hold";
  return "advance";
}

function uniqueEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Strict UI boundary for private checkpoints. It deliberately never reads
 * candidate.model.capability, benchmarkSuites, benchmarks, or quality fields.
 */
export function checkpointUiRecordFromCandidate(
  candidate: TrainingCheckpointCandidate,
  options: {
    promotedModelPublic?: boolean;
    promotedModelId?: string;
    promotedModelName?: string;
    sourceJobActive?: boolean;
    pendingEvaluation?: PendingCheckpointEvaluation;
    pendingEvaluations?: PendingCheckpointEvaluation[];
  } = {},
): CheckpointUiRecord {
  type CheckpointCandidateExtras = {
    kind?: "milestone" | "manual";
    customLabel?: string;
    branchDirection?: CheckpointBranchDirection;
    parentCheckpointId?: string;
  };
  const extras = candidate as TrainingCheckpointCandidate &
    CheckpointCandidateExtras;
  const reports = sortedCheckpointReports(candidate);
  const report = reports.at(-1);
  const selectedSuite = report?.suites.find((suite) =>
    suite.metrics.some((metric) => metric.rival != null),
  ) ?? report?.suites[0];
  const selectedMetric = selectedSuite?.metrics.find(
    (metric) => metric.rival != null,
  ) ?? selectedSuite?.metrics[0];
  const pendingEvaluations = options.pendingEvaluations ?? [
    ...(options.pendingEvaluation ? [options.pendingEvaluation] : []),
    ...(!options.pendingEvaluation && candidate.pendingEvaluation
      ? [candidate.pendingEvaluation]
      : []),
  ];
  const pending = pendingEvaluations[0];
  const isPromoted = candidate.status === "promoted";
  const visibility: CheckpointVisibility = options.promotedModelPublic
    ? "public"
    : isPromoted
      ? "internal"
      : "stealth";
  const status: CheckpointUiStatus =
    candidate.status === "discarded"
      ? "discarded"
      : isPromoted
        ? "promoted"
        : pending
          ? "evaluating"
          : report
            ? "reviewed"
            : "candidate";
  const canEvaluate =
    candidate.status !== "discarded" &&
    reports.length + pendingEvaluations.length < 16;
  const canPromote = candidate.status === "stealth" && pending == null;
  const canDiscard = candidate.status === "stealth" && pending == null;
  const reportReviews = reports.flatMap((item) => item.reviews);
  const strengths = uniqueEvidence(
    reportReviews.flatMap((review) => review.strengths),
  );
  const concerns = uniqueEvidence([
    ...reportReviews.flatMap((review) => review.concerns),
    ...reports.flatMap((item) => item.flags),
  ]);
  const observations = selectedSuite && selectedMetric
    ? reports.flatMap((item) => {
        const suite = item.suites.find(
          (candidateSuite) => candidateSuite.suiteId === selectedSuite.suiteId,
        );
        const metric = suite?.metrics.find(
          (candidateMetric) =>
            candidateMetric.metricId === selectedMetric.metricId,
        );
        return suite && metric ? [{ suite, metric }] : [];
      })
    : [];
  const consensusWeight = observations.reduce(
    (sum, observation) =>
      sum + Math.max(0.01, observation.suite.accuracy * observation.suite.confidence),
    0,
  );
  const weighted = (select: (observation: (typeof observations)[number]) => number) =>
    consensusWeight <= 0
      ? undefined
      : observations.reduce(
          (sum, observation) =>
            sum +
            select(observation) *
              Math.max(
                0.01,
                observation.suite.accuracy * observation.suite.confidence,
              ),
          0,
        ) / consensusWeight;
  const consensusScore = weighted((observation) => observation.metric.score);
  const consensusLow = weighted((observation) => observation.metric.low);
  const consensusHigh = weighted((observation) => observation.metric.high);
  const consensusAccuracy = weighted(
    (observation) => observation.suite.accuracy,
  );
  const consensusConfidence = weighted(
    (observation) => observation.suite.confidence,
  );
  const evidenceReports: CheckpointEvidenceReportUi[] = reports.map((item) => ({
    id: item.id,
    day: item.completedDay,
    mode: item.request.mode,
    totalCost: item.quote.totalCost,
    accuracy: item.quote.accuracy,
    confidence: item.confidence,
    leakRisk: item.leakRisk,
    contaminationRisk: item.contaminationRisk,
    leakOutcome: item.leakOutcome,
    flags: [...item.flags],
    suites: item.suites.map((suite) => ({
      id: suite.suiteId,
      label: suite.label,
      accuracy: suite.accuracy,
      confidence: suite.confidence,
      metrics: suite.metrics.map((metric) => ({
        id: metric.metricId,
        label: metric.label,
        score: metric.score,
        low: metric.low,
        high: metric.high,
        contaminationSignal: metric.contaminationSignal,
        rival: metric.rival
          ? {
              name: metric.rival.modelName,
              score: metric.rival.score,
              delta: metric.rival.delta,
              rank: metric.rival.rank,
              fieldSize: metric.rival.fieldSize,
            }
          : undefined,
      })),
    })),
    reviews: item.reviews.map((reviewer) => ({
      id: reviewer.reviewerId,
      panel: reviewer.panel,
      focus: reviewer.focus,
      score: reviewer.score,
      confidence: reviewer.confidence,
      calibration: reviewer.bias,
      verdict: reviewer.verdict,
      strengths: [...reviewer.strengths],
      concerns: [...reviewer.concerns],
    })),
  }));
  const review: CheckpointReviewUi | undefined = pending
    ? {
        status: "running",
        mode: pending.request.mode,
        headline: `Results due day ${pending.readyDay}`,
        summary: `${pending.quote.reviewerCount} blind reviewers · ${Math.round(pending.quote.accuracy * 100)}% expected measurement accuracy.`,
        leakRisk: pending.quote.leakRisk,
      }
    : report
      ? {
          status: "complete",
          mode: report.request.mode,
          verdict: reportVerdict(candidate),
          headline: `${reports.length} report${reports.length === 1 ? "" : "s"} · weighted consensus`,
          summary:
            report.leakOutcome === "identity_leak"
              ? "The review exposed this lab's identity; weights remain private."
              : report.leakOutcome === "rumor"
                ? "The review created an unattributed market rumor; weights remain private."
                : `Completed day ${report.completedDay} with ${Math.round(report.confidence * 100)}% report confidence.`,
          strengths: strengths.slice(0, 3),
          risks: concerns.slice(0, 3),
          leakRisk: report.leakRisk,
        }
      : undefined;

  return {
    id: candidate.id,
    sourceJobId: candidate.sourceJobId,
    label: extras.customLabel ?? report?.modelName ?? candidate.model.name,
    day: candidate.capturedDay,
    milestone: candidate.milestone,
    progress: candidate.telemetry.progress,
    stage: candidate.stage,
    kind: extras.kind ?? "milestone",
    branchDirection: extras.branchDirection,
    parentCheckpointId: extras.parentCheckpointId,
    visibility,
    status,
    confidence: consensusConfidence ?? pending?.quote.confidence ?? 0,
    evaluationScore: {
      label: selectedMetric?.label,
      estimate: consensusScore,
      low: consensusLow,
      high: consensusHigh,
    },
    reportCount: reports.length,
    pendingEvaluations: pendingEvaluations.map((evaluation) => ({
      id: evaluation.id,
      mode: evaluation.request.mode,
      readyDay: evaluation.readyDay,
      totalCost: evaluation.quote.totalCost,
      accuracy: evaluation.quote.accuracy,
      confidence: evaluation.quote.confidence,
      leakRisk: evaluation.quote.leakRisk,
    })),
    retainedModel:
      options.promotedModelId && options.promotedModelName
        ? {
            id: options.promotedModelId,
            name: options.promotedModelName,
            status: options.promotedModelPublic ? "public" : "internal",
          }
        : undefined,
    evidenceReports,
    benchmark:
      selectedSuite && selectedMetric
        ? {
            suiteLabel: selectedSuite.label,
            metricLabel: selectedMetric.label,
            score: consensusScore ?? selectedMetric.score,
            low: consensusLow ?? selectedMetric.low,
            high: consensusHigh ?? selectedMetric.high,
            confidence: consensusConfidence ?? selectedSuite.confidence,
            accuracy: consensusAccuracy ?? selectedSuite.accuracy,
            rivalBest: selectedMetric.rival?.score,
            rivalName: selectedMetric.rival?.modelName,
            rivalDelta: selectedMetric.rival?.delta,
          }
        : undefined,
    review,
    actions: {
      benchmark: {
        enabled: canEvaluate,
        reason:
          candidate.status === "discarded"
            ? "Discarded weights cannot be evaluated."
            : !canEvaluate
              ? "This checkpoint already has the maximum 16 scheduled or persisted studies."
              : undefined,
        label: report ? "Re-evaluate" : "Run benchmark",
      },
      review: {
        enabled: canEvaluate,
        reason:
          candidate.status === "discarded"
            ? "Discarded weights cannot be reviewed."
            : !canEvaluate
              ? "This checkpoint already has the maximum 16 scheduled or persisted studies."
              : undefined,
        label: report ? "New panel review" : "Commission review",
      },
      promote: {
        enabled: canPromote,
        reason:
          candidate.status === "promoted"
            ? "Checkpoint already retained internally."
            : candidate.status === "discarded"
              ? "Discarded weights cannot be promoted."
              : pending
                ? `Evaluation still running until day ${pending.readyDay}.`
                : undefined,
        label: "Promote internal",
      },
      discard: {
        enabled: canDiscard,
        reason:
          candidate.status === "promoted"
            ? "Manage retained weights from the model fleet."
            : candidate.status === "discarded"
              ? "Checkpoint already discarded."
              : pending
                ? `Evaluation still running until day ${pending.readyDay}.`
                : undefined,
      },
      fork: {
        enabled: candidate.status !== "discarded",
        reason:
          candidate.status === "discarded"
            ? "Discarded weights cannot seed a new branch."
            : undefined,
        label: "Fork direction",
      },
      rollback: {
        enabled:
          candidate.status !== "discarded" && options.sourceJobActive === true,
        reason:
          candidate.status === "discarded"
            ? "Discarded weights cannot be restored."
            : !options.sourceJobActive
              ? "Rollback requires the original training run to still be active."
              : undefined,
        label: "Restore as branch",
      },
    },
  };
}
