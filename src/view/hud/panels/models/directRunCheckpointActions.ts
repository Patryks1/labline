import type {
  SimState,
  TrainingCheckpointBranchDirection,
  TrainingCheckpointCandidate,
} from "../../../../sim/types";
import {
  currentManualTrainingCheckpointId,
  playerTrainingJobs,
} from "../../../../sim/systems/training";
import { num } from "../../format";

export interface DirectRunCheckpointRequest {
  sourceJobId: string;
  label: string;
  branchDirection: TrainingCheckpointBranchDirection;
}

/** Player-facing defaults for a one-click snapshot from the live run card. */
export function directRunCheckpointRequest(
  state: SimState,
  jobId: string,
): DirectRunCheckpointRequest | undefined {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === jobId,
  );
  if (
    !job ||
    job.failed ||
    (job.progressPfDays <= 1e-9 && job.postTrainProgress <= 1e-9)
  ) {
    return undefined;
  }
  const baseRatio =
    job.progressPfDays / Math.max(1e-9, job.targetPfDays);
  const stage = job.postTrain === "none" ? "base" : job.postTrain;
  const stageRatio =
    stage === "base"
      ? baseRatio
      : job.postTrainProgress / Math.max(1e-9, job.postTrainTarget);
  const progressLabel =
    stage === "base" && baseRatio > 1 + 1e-9
      ? baseRatio < 10
        ? `${baseRatio.toFixed(2)}× funded`
        : `${num(job.progressPfDays, 1)} PF invested`
      : `${Math.round(Math.max(0, stageRatio) * 100)}%`;
  return {
    sourceJobId: job.id,
    label: `${job.name} · ${stage === "base" ? "Base" : stage.toUpperCase()} ${progressLabel}`,
    branchDirection: job.branchDirection ?? "general",
  };
}

/**
 * Resolve exact current weights into the canonical checkpoint archive.
 * Zustand writes synchronously, so readState observes the candidate created by
 * createCheckpoint without guessing from array order or a stale render.
 */
export function ensureCurrentRunCheckpoint({
  state,
  jobId,
  createCheckpoint,
  readState,
}: {
  state: SimState;
  jobId: string;
  createCheckpoint: (request: DirectRunCheckpointRequest) => void;
  readState: () => SimState;
}): TrainingCheckpointCandidate | undefined {
  const checkpointId = currentManualTrainingCheckpointId(state, jobId);
  const request = directRunCheckpointRequest(state, jobId);
  if (!checkpointId || !request) return undefined;

  const existing = (state.player.trainingCheckpoints ?? []).find(
    (candidate) => candidate.id === checkpointId,
  );
  if (existing) return existing;

  createCheckpoint(request);
  return (readState().player.trainingCheckpoints ?? []).find(
    (candidate) => candidate.id === checkpointId,
  );
}
