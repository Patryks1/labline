import type {
  Model,
  PrivateEvaluationJob,
  TrainingCheckpointCandidate,
  TrainingJob,
} from "../types";

/**
 * A source/ancestor model can identify which archive a checkpoint belongs to,
 * but it does not own the descendant weights. Ownership requires a concrete
 * weight-bearing model or an active job that still depends on the snapshot.
 */
export function checkpointHasConcreteOwner(
  checkpoint: TrainingCheckpointCandidate,
  models: readonly Model[],
  jobs: readonly TrainingJob[],
): boolean {
  // `discarded` is a legacy tombstone from saves written before Discard became
  // a true deletion. It never owns weights and is pruned with its queue.
  if (checkpoint.status === "discarded") return false;
  const exactModelId = checkpoint.promotedModelId ?? checkpoint.model.id;
  const sourceMayOwn = checkpoint.sourceOwnershipRevoked !== true;
  return (
    (sourceMayOwn && jobs.some((job) => job.id === checkpoint.sourceJobId)) ||
    jobs.some((job) => job.parentCheckpointId === checkpoint.id) ||
    models.some(
      (model) =>
        model.id === exactModelId ||
        (sourceMayOwn && model.id === checkpoint.ownerModelId) ||
        model.parentModelId === checkpoint.model.id,
    )
  );
}

/** Whether deleting this model invalidates one of the checkpoint's owners/roots. */
export function checkpointTouchesModel(
  checkpoint: TrainingCheckpointCandidate,
  model: Model,
): boolean {
  return (
    checkpoint.promotedModelId === model.id ||
    checkpoint.model.id === model.id ||
    checkpoint.sourceModelId === model.id ||
    checkpoint.ownerModelId === model.id ||
    model.parentModelId === checkpoint.model.id
  );
}

export interface CheckpointOwnershipResult {
  checkpoints: TrainingCheckpointCandidate[];
  privateEvaluationJobs: PrivateEvaluationJob[];
  removedCheckpointIds: string[];
  downgradedCheckpointIds: string[];
  cancelledEvaluationJobIds: string[];
}

/**
 * Reconcile a selected ownership boundary. With no affected-ID set this also
 * acts as save repair and drops every orphaned candidate.
 */
export function reconcileCheckpointOwnership(input: {
  checkpoints: readonly TrainingCheckpointCandidate[];
  privateEvaluationJobs: readonly PrivateEvaluationJob[];
  models: readonly Model[];
  jobs: readonly TrainingJob[];
  affectedCheckpointIds?: ReadonlySet<string>;
}): CheckpointOwnershipResult {
  const removedCheckpointIds: string[] = [];
  const downgradedCheckpointIds: string[] = [];
  const checkpoints: TrainingCheckpointCandidate[] = [];

  for (const checkpoint of input.checkpoints) {
    const affected =
      input.affectedCheckpointIds == null ||
      input.affectedCheckpointIds.has(checkpoint.id);
    if (!affected) {
      checkpoints.push(checkpoint);
      continue;
    }
    if (!checkpointHasConcreteOwner(checkpoint, input.models, input.jobs)) {
      removedCheckpointIds.push(checkpoint.id);
      continue;
    }

    const ownerStillExists = input.models.some(
      (model) => model.id === checkpoint.ownerModelId,
    );
    const normalizedCheckpoint = ownerStillExists
      ? checkpoint
      : { ...checkpoint, ownerModelId: undefined };
    const promotedModelId =
      normalizedCheckpoint.promotedModelId ?? normalizedCheckpoint.model.id;
    const promotedStillExists = input.models.some(
      (model) => model.id === promotedModelId,
    );
    if (
      normalizedCheckpoint.status === "promoted" &&
      !promotedStillExists
    ) {
      downgradedCheckpointIds.push(normalizedCheckpoint.id);
      checkpoints.push({
        ...normalizedCheckpoint,
        status: "stealth",
        promotedModelId: undefined,
        promotedDay: undefined,
      });
      continue;
    }
    if (
      normalizedCheckpoint.status === "promoted" &&
      normalizedCheckpoint.promotedModelId == null &&
      promotedStillExists
    ) {
      checkpoints.push({ ...normalizedCheckpoint, promotedModelId });
      continue;
    }
    checkpoints.push(normalizedCheckpoint);
  }

  const removed = new Set(removedCheckpointIds);
  const cancelledEvaluationJobIds: string[] = [];
  const privateEvaluationJobs = input.privateEvaluationJobs.filter((job) => {
    const cancel =
      (job.kind === "checkpoint_evaluation" && removed.has(job.subjectId)) ||
      (job.kind === "released_model_evaluation" &&
        !input.models.some((model) => model.id === job.subjectId));
    if (cancel) cancelledEvaluationJobIds.push(job.id);
    return !cancel;
  });

  return {
    checkpoints,
    privateEvaluationJobs,
    removedCheckpointIds,
    downgradedCheckpointIds,
    cancelledEvaluationJobIds,
  };
}
