// V4-DELETE: superseded by `runViewModel.ts` (WS-K). Keep until Phase 2 cuts over.
import type { PostTrainStage, SimState, TrainingJob } from "../../sim/types";
import {
  canReleaseTrainingJob,
  playerTrainingJobs,
  playerTrainingResourcePlan,
  trainingMinimumStatus,
  type TrainingResourceAllocation,
} from "../../sim/systems/training";
import { computeSnapshot } from "../../sim/systems/compute";
import {
  classifyTrainingStatus,
  trainingRemainingTime,
} from "./panels/models/trainingPresentation";

export type TrainingStageKey =
  "base" | Exclude<PostTrainStage, "none"> | "review";

export type TrainingActivityTone =
  "neutral" | "positive" | "warning" | "danger";

export type TrainingActivityAction =
  | {
      kind: "open-run";
      label: string;
      jobId: string;
    }
  | {
      kind: "decide";
      label: "Decide";
      jobId: string;
    }
  | {
      kind: "resume";
      label: "Resume";
      jobId: string;
    }
  | {
      kind: "recover";
      label: "Recover";
      jobId: string;
      checkpointId: string;
    };

export interface TrainingJobViewModel {
  id: string;
  name: string;
  job: TrainingJob;
  stage: TrainingStageKey;
  stageLabel: string;
  stageProgress: number;
  computeProgress: number;
  statusLabel: string;
  statusTone: TrainingActivityTone;
  issueLabel?: string;
  issueTone?: Exclude<TrainingActivityTone, "neutral">;
  etaDays: number | null;
  etaLabel: string;
  allocatedPf: number;
  primaryAction: TrainingActivityAction;
  /** Lower values are more urgent. Ties are resolved by job id. */
  urgency: number;
}

export interface TrainingActivityViewModel {
  jobs: TrainingJobViewModel[];
  activeCount: number;
  issueCount: number;
  readyCount: number;
  decideCount: number;
  blockedCount: number;
  summary: string;
  liveAnnouncement: string;
}

export interface TrainingViewResourceOverrides {
  resource?: TrainingResourceAllocation;
}

/**
 * Read concurrent player jobs while honoring legacy saves that only populated
 * `trainingJob`. The simulation's playerTrainingJobs function also de-dupes a
 * legacy mirror, so every HUD surface observes the same job list.
 */
export function normalizeTrainingJobs(state: SimState): TrainingJob[] {
  return playerTrainingJobs(state);
}

/** Select a stable representative for guidance copy and non-list surfaces. */
export function selectPrimaryTrainingJob(
  jobs: readonly TrainingJob[],
): TrainingJob | undefined {
  return [...jobs].toSorted(compareTrainingJobs).at(0);
}

function compareTrainingJobs(a: TrainingJob, b: TrainingJob): number {
  const urgency = trainingJobUrgency(a) - trainingJobUrgency(b);
  return urgency || a.id.localeCompare(b.id);
}

function trainingJobUrgency(job: TrainingJob): number {
  if (job.failed) return 0;
  if (job.pendingCampaignEvent) return 1;
  if (job.stallReason) return 2;
  if (job.paused) return 3;
  const minimum = trainingMinimumStatus(job);
  if (minimum.completeReady) return 4;
  if (minimum.launchReady) return 5;
  return 6;
}

export function trainingStageLabel(stage: TrainingStageKey): string {
  if (stage === "base") return "Training";
  if (stage === "review") return "Review";
  return stage.toUpperCase();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function stageForJob(
  job: TrainingJob,
  completeReady: boolean,
): TrainingStageKey {
  if (job.failed && job.failureStage && job.failureStage !== "base") {
    return job.failureStage;
  }
  const postTrain = job.postTrain;
  const postTrainActive =
    postTrain !== "none" && job.postTrainProgress + 1e-9 < job.postTrainTarget;
  if (postTrainActive) return postTrain;
  return completeReady ? "review" : "base";
}

function stageProgressForJob(
  job: TrainingJob,
  stage: TrainingStageKey,
): number {
  if (stage === "review") return 1;
  if (stage === "base") {
    return clamp01(job.progressPfDays / Math.max(job.targetPfDays, 1e-9));
  }
  return clamp01(job.postTrainProgress / Math.max(job.postTrainTarget, 1e-9));
}

function issueForJob({
  job,
  stage,
  status,
  completeReady,
}: {
  job: TrainingJob;
  stage: TrainingStageKey;
  status: ReturnType<typeof classifyTrainingStatus>;
  completeReady: boolean;
}): { label?: string; tone?: Exclude<TrainingActivityTone, "neutral"> } {
  if (job.failed) {
    return {
      label:
        job.failureReason ??
        job.failureRecord?.factors.at(0) ??
        `Run failed during ${trainingStageLabel(stage).toLowerCase()}.`,
      tone: "danger",
    };
  }
  if (job.pendingCampaignEvent) {
    return {
      label: `Decision: ${job.pendingCampaignEvent.title}`,
      tone:
        job.pendingCampaignEvent.severity === "critical" ? "danger" : "warning",
    };
  }
  if (status.diagnosticStall) {
    return { label: status.diagnosticStall, tone: "danger" };
  }
  if (status.powerBlocked || status.memoryBlocked || status.unstable) {
    return { label: status.statusLabel, tone: "danger" };
  }
  if (job.stallReason) {
    return { label: job.stallReason, tone: "warning" };
  }
  if (job.paused) {
    return { label: "Paused", tone: "warning" };
  }
  if (job.pendingBenchmark) {
    return { label: "Benchmark in progress", tone: "warning" };
  }
  if (status.statusLabel === "Plateaued") {
    return { label: "Loss plateaued · review the run", tone: "warning" };
  }
  if (completeReady && stage === "review") {
    return { label: "Ready for release review", tone: "positive" };
  }
  return {};
}

function actionForJob(
  job: TrainingJob,
  completeReady: boolean,
  launchReady: boolean,
  releaseGate: ReturnType<typeof canReleaseTrainingJob>,
): TrainingActivityAction {
  if (
    job.failed &&
    job.failureStage &&
    job.failureStage !== "base" &&
    job.failureRecoveryCheckpointId &&
    !job.recoveryChildJobId
  ) {
    return {
      kind: "recover",
      label: "Recover",
      jobId: job.id,
      checkpointId: job.failureRecoveryCheckpointId,
    };
  }
  if (job.pendingCampaignEvent) {
    return { kind: "decide", label: "Decide", jobId: job.id };
  }
  if (completeReady) {
    return {
      kind: "open-run",
      label: releaseGate.ok ? "Review release" : "Review run",
      jobId: job.id,
    };
  }
  if (job.paused) {
    return { kind: "resume", label: "Resume", jobId: job.id };
  }
  if (launchReady) {
    return { kind: "open-run", label: "Review launch", jobId: job.id };
  }
  return { kind: "open-run", label: "View run", jobId: job.id };
}

function etaForJob(
  job: TrainingJob,
  stage: TrainingStageKey,
  stageProgress: number,
  allocatedPf: number,
  completeReady: boolean,
): { days: number | null; label: string } {
  if (job.failed) return { days: null, label: "Failed" };
  if (job.pendingCampaignEvent) return { days: null, label: "Decision due" };
  if (job.paused) return { days: null, label: "Paused" };
  if (stage === "review" && completeReady)
    return { days: null, label: "Ready" };

  const target = stage === "base" ? job.targetPfDays : job.postTrainTarget;
  const remaining = Math.max(0, target * (1 - stageProgress));
  const { etaDays } = trainingRemainingTime(
    stage === "base"
      ? {
          targetPfDays: job.targetPfDays,
          progressPfDays: job.progressPfDays,
          allocatedPf,
          minCalendarDays: job.minCalendarDays,
        }
      : {
          targetPfDays: remaining,
          progressPfDays: 0,
          allocatedPf,
        },
  );
  if (etaDays === Infinity) return { days: null, label: "Stalled" };
  return {
    days: etaDays,
    label: `~${Math.max(0, Math.ceil(etaDays))}d`,
  };
}

export function buildTrainingJobViewModel(
  job: TrainingJob,
  { resource }: TrainingViewResourceOverrides = {},
): TrainingJobViewModel {
  const minimum = trainingMinimumStatus(job);
  const stage = stageForJob(job, minimum.completeReady);
  const stageProgress = stageProgressForJob(job, stage);
  const computeProgress = clamp01(
    job.progressPfDays / Math.max(job.targetPfDays, 1e-9),
  );
  const allocatedPf = resource?.effectivePf ?? 0;
  const status = classifyTrainingStatus({
    failed: job.failed,
    paused: job.paused,
    stallReason: job.stallReason,
    resources: resource,
    completeReady: minimum.completeReady,
    plateaued: minimum.plateaued,
    launchReady: minimum.launchReady,
  });
  const issue = issueForJob({
    job,
    stage,
    status,
    completeReady: minimum.completeReady,
  });
  const releaseGate = canReleaseTrainingJob(job);
  const eta = etaForJob(
    job,
    stage,
    stageProgress,
    allocatedPf,
    minimum.completeReady,
  );
  const tone: TrainingActivityTone =
    job.failed ||
    status.memoryBlocked ||
    status.powerBlocked ||
    status.incompatible ||
    status.unstable
      ? "danger"
      : minimum.completeReady
        ? "positive"
        : "warning";

  return {
    id: job.id,
    name: job.name,
    job,
    stage,
    stageLabel: trainingStageLabel(stage),
    stageProgress,
    computeProgress,
    statusLabel: status.statusLabel,
    statusTone: tone,
    issueLabel: issue.label,
    issueTone: issue.tone,
    etaDays: eta.days,
    etaLabel: eta.label,
    allocatedPf,
    primaryAction: actionForJob(
      job,
      minimum.completeReady,
      minimum.launchReady,
      releaseGate,
    ),
    urgency: job.failed
      ? 0
      : job.pendingCampaignEvent
        ? 1
        : issue.tone === "danger"
          ? 2
          : job.paused
            ? 3
            : minimum.completeReady
              ? 4
              : minimum.launchReady
                ? 5
                : 6,
  };
}

export function sortTrainingJobViewModels(
  jobs: readonly TrainingJobViewModel[],
): TrainingJobViewModel[] {
  return [...jobs].toSorted(
    (a, b) => a.urgency - b.urgency || a.id.localeCompare(b.id),
  );
}

export function buildTrainingActivity(
  state: SimState,
): TrainingActivityViewModel {
  const jobs = normalizeTrainingJobs(state);
  if (jobs.length === 0) {
    return {
      jobs: [],
      activeCount: 0,
      issueCount: 0,
      readyCount: 0,
      decideCount: 0,
      blockedCount: 0,
      summary: "No model training runs",
      liveAnnouncement: "No model training runs are active.",
    };
  }

  const snapshot = computeSnapshot(state);
  const resources = playerTrainingResourcePlan(state, snapshot);
  const viewModels = sortTrainingJobViewModels(
    jobs.map((job) =>
      buildTrainingJobViewModel(job, { resource: resources.jobs[job.id] }),
    ),
  );
  const issueCount = viewModels.filter(
    (job) => job.issueTone === "danger" || job.issueTone === "warning",
  ).length;
  const readyCount = viewModels.filter(
    (job) => job.statusLabel === "Ready",
  ).length;
  const decideCount = viewModels.filter(
    (job) => job.job.pendingCampaignEvent,
  ).length;
  const blockedCount = viewModels.filter(
    (job) =>
      job.statusTone === "danger" &&
      !job.job.failed &&
      !job.job.pendingCampaignEvent,
  ).length;
  const activeCount = viewModels.filter(
    (job) => !job.job.failed && job.statusLabel !== "Ready",
  ).length;
  const lead = viewModels[0]!;
  const parts = [
    `${viewModels.length} run${viewModels.length === 1 ? "" : "s"}`,
  ];
  if (decideCount > 0) parts.push(`${decideCount} decide`);
  if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
  if (readyCount > 0) parts.push(`${readyCount} ready`);
  if (activeCount > 0 && decideCount + blockedCount + readyCount === 0) {
    parts.push(`${lead.stageLabel} ${Math.round(lead.stageProgress * 100)}%`);
  }
  const liveAnnouncement = viewModels
    .map(
      (job) =>
        `${job.name}: ${job.stageLabel} ${Math.round(job.stageProgress * 100)}%, ${job.statusLabel}${job.issueLabel ? `, ${job.issueLabel}` : ""}`,
    )
    .join(". ");

  return {
    jobs: viewModels,
    activeCount,
    issueCount,
    readyCount,
    decideCount,
    blockedCount,
    summary: parts.join(" · "),
    liveAnnouncement,
  };
}
