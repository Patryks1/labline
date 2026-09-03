// V4-DELETE: superseded by src/sim/training/evaluate.ts (Phase 2 cutover).
import {
  createPendingCheckpointEvaluation,
  resolveCheckpointEvaluation,
  validateCheckpointEvaluationRequest,
  type CheckpointEvaluationReport,
  type CheckpointEvaluationRequest,
  type PendingCheckpointEvaluation,
} from "../balance/checkpointEvaluation";
import { hashSeed } from "../rng";
import type {
  PrivateEvaluationJob,
  SimState,
  TrainingBenchmarkPending,
  TrainingJob,
} from "../types";
import { isLivePublicModel } from "../modelRelease";
import { chargeExpense } from "./financeLedger";
import {
  playerTrainingJobs,
  playerTrainingResourcePlan,
  resolveTrainingBenchmarkEvaluation,
  withTrainingJobs,
} from "./training";

function withAlert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `checkpoint-eval-${severity}-${state.day}-${message.slice(0, 24)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export const MAX_CHECKPOINT_EVALUATIONS = 16;

/** Stable evidence seed for an immutable checkpoint; never a paid-study reroll. */
function checkpointEvidenceSeed(state: SimState, checkpointId: string): number {
  return hashSeed(state.seed, checkpointId, "checkpoint-evidence-v2");
}

function queuedCheckpointEvaluations(
  state: SimState,
  checkpointId: string,
): number {
  return (state.player.privateEvaluationJobs ?? []).filter(
    (job) =>
      job.kind === "checkpoint_evaluation" &&
      job.subjectId === checkpointId,
  ).length;
}

function queuedReleasedModelEvaluations(
  state: SimState,
  modelId: string,
): number {
  return (state.player.privateEvaluationJobs ?? []).filter(
    (job) =>
      job.kind === "released_model_evaluation" &&
      job.subjectId === modelId,
  ).length;
}

function releasedModelEvidenceSeed(state: SimState, modelId: string): number {
  return hashSeed(state.seed, modelId, "released-model-eval-v1");
}

/** Queue paid private work. Multiple studies may run concurrently. */
export function scheduleCheckpointEvaluation(
  state: SimState,
  checkpointId: string,
  request: CheckpointEvaluationRequest,
): SimState {
  const checkpoints = state.player.trainingCheckpoints ?? [];
  const checkpoint = checkpoints.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (!checkpoint)
    return withAlert(state, "warn", "Stealth checkpoint not found.");
  if (checkpoint.status === "discarded") {
    return withAlert(
      state,
      "warn",
      "Discarded checkpoint weights cannot begin an evaluation.",
    );
  }
  const completedReports = checkpoint.evaluations?.length ?? 0;
  const queuedReports = queuedCheckpointEvaluations(state, checkpoint.id);
  if (completedReports + queuedReports >= MAX_CHECKPOINT_EVALUATIONS) {
    return withAlert(
      state,
      "warn",
      `This checkpoint already has the maximum ${MAX_CHECKPOINT_EVALUATIONS} persisted or scheduled studies.`,
    );
  }
  const errors = validateCheckpointEvaluationRequest(checkpoint.model, request);
  if (errors.length) return withAlert(state, "warn", errors.join(" "));
  const seed = checkpointEvidenceSeed(state, checkpoint.id);
  const sequence = completedReports + queuedReports;
  const pending = createPendingCheckpointEvaluation(
    checkpoint.model,
    request,
    seed,
    state.day,
    sequence,
  );
  if (state.player.cash + 1e-9 < pending.quote.totalCost) {
    return withAlert(
      state,
      "warn",
      `Need $${pending.quote.totalCost.toLocaleString("en-US")} for this stealth evaluation.`,
    );
  }
  const queueEntry: PrivateEvaluationJob = {
    id: pending.id,
    kind: "checkpoint_evaluation",
    subjectId: checkpoint.id,
    scheduledDay: pending.scheduledDay,
    readyDay: pending.readyDay,
    pending,
  };
  const charged = chargeExpense(state, pending.quote.totalCost, "training");
  return withAlert(
    {
      ...charged,
      player: {
        ...charged.player,
        privateEvaluationJobs: [
          ...(charged.player.privateEvaluationJobs ?? []),
          queueEntry,
        ],
        trainingCheckpoints: checkpoints.map((candidate) =>
          candidate.id === checkpoint.id
            ? {
                ...candidate,
                // Compatibility mirror only; the global queue is authoritative.
                pendingEvaluation:
                  candidate.pendingEvaluation ?? pending,
              }
            : candidate,
        ),
      },
    },
    "info",
    `${checkpoint.model.name} entered ${request.mode.replaceAll("_", " ")} evaluation: ${request.suiteIds.length} suite${request.suiteIds.length === 1 ? "" : "s"}, ${Math.round(pending.quote.accuracy * 100)}% measurement accuracy, ${Math.max(0, pending.quote.computePfDays ?? 0).toFixed(2)} PF-days; earliest results in ${pending.quote.durationDays} days.`,
  );
}

/** Queue a paid measured study of a released (or internal) fleet model. */
export function scheduleReleasedModelEvaluation(
  state: SimState,
  modelId: string,
  request: CheckpointEvaluationRequest,
): SimState {
  const model = state.player.models.find((candidate) => candidate.id === modelId);
  if (!model) return withAlert(state, "warn", "Model is not in the fleet.");
  const completedReports = model.checkpointEvaluations?.length ?? 0;
  const queuedReports = queuedReleasedModelEvaluations(state, model.id);
  if (completedReports + queuedReports >= MAX_CHECKPOINT_EVALUATIONS) {
    return withAlert(
      state,
      "warn",
      `This model already has the maximum ${MAX_CHECKPOINT_EVALUATIONS} persisted or scheduled studies.`,
    );
  }
  const errors = validateCheckpointEvaluationRequest(model, request);
  if (errors.length) return withAlert(state, "warn", errors.join(" "));
  const seed = releasedModelEvidenceSeed(state, model.id);
  const sequence = completedReports + queuedReports;
  const pending = createPendingCheckpointEvaluation(
    model,
    request,
    seed,
    state.day,
    sequence,
  );
  if (state.player.cash + 1e-9 < pending.quote.totalCost) {
    return withAlert(
      state,
      "warn",
      `Need $${pending.quote.totalCost.toLocaleString("en-US")} for this evaluation.`,
    );
  }
  const queueEntry: PrivateEvaluationJob = {
    id: pending.id,
    kind: "released_model_evaluation",
    subjectId: model.id,
    scheduledDay: pending.scheduledDay,
    readyDay: pending.readyDay,
    pending,
  };
  const charged = chargeExpense(state, pending.quote.totalCost, "training");
  return withAlert(
    {
      ...charged,
      player: {
        ...charged.player,
        privateEvaluationJobs: [
          ...(charged.player.privateEvaluationJobs ?? []),
          queueEntry,
        ],
      },
    },
    "info",
    `${model.name} entered ${request.mode.replaceAll("_", " ")} evaluation: ${request.suiteIds.length} suite${request.suiteIds.length === 1 ? "" : "s"}, ${Math.round(pending.quote.accuracy * 100)}% measurement accuracy, ${Math.max(0, pending.quote.computePfDays ?? 0).toFixed(2)} PF-days; earliest results in ${pending.quote.durationDays} days.`,
  );
}

function mirrorCheckpointPending(
  queue: readonly PrivateEvaluationJob[],
  checkpointId: string,
): PendingCheckpointEvaluation | undefined {
  return queue.find(
    (job) =>
      job.kind === "checkpoint_evaluation" &&
      job.subjectId === checkpointId,
  )?.pending as PendingCheckpointEvaluation | undefined;
}

function mirrorTrainingPending(
  queue: readonly PrivateEvaluationJob[],
  jobId: string,
): TrainingBenchmarkPending | undefined {
  return queue.find(
    (job) => job.kind === "training_benchmark" && job.subjectId === jobId,
  )?.pending as TrainingBenchmarkPending | undefined;
}

function legacyQueue(state: SimState): PrivateEvaluationJob[] {
  const queue = [...(state.player.privateEvaluationJobs ?? [])];
  const known = new Set(queue.map((job) => job.id));
  for (const job of playerTrainingJobs(state)) {
    const pending = job.pendingBenchmark;
    if (!pending || known.has(pending.id)) continue;
    queue.push({
      id: pending.id,
      kind: "training_benchmark",
      subjectId: job.id,
      scheduledDay: pending.startedDay,
      readyDay: pending.readyDay,
      pending,
    });
    known.add(pending.id);
  }
  for (const checkpoint of state.player.trainingCheckpoints ?? []) {
    const pending = checkpoint.pendingEvaluation;
    if (!pending || known.has(pending.id)) continue;
    queue.push({
      id: pending.id,
      kind: "checkpoint_evaluation",
      subjectId: checkpoint.id,
      scheduledDay: pending.scheduledDay,
      readyDay: pending.readyDay,
      pending,
    });
    known.add(pending.id);
  }
  return queue;
}

/** Resolve every due item; concurrent jobs never overwrite one another. */
export function tickCheckpointEvaluations(state: SimState): SimState {
  const queue = legacyQueue(state);
  const resources = playerTrainingResourcePlan(state);
  const advanced = queue.map((job): PrivateEvaluationJob => {
    const target =
      job.kind === "training_benchmark"
        ? job.pending.workload?.computePfDays
        : job.pending.quote.computePfDays;
    // Legacy saves are calendar-only. Do not invent physical work after sale.
    if (target == null || !Number.isFinite(target)) return job;
    const progress = Math.min(
      Math.max(0, target),
      Math.max(0, job.pending.computeProgressPfDays ?? 0) +
        Math.max(
          0,
          resources.privateEvaluations[job.id]?.effectivePf ?? 0,
        ),
    );
    return {
      ...job,
      pending: { ...job.pending, computeProgressPfDays: progress },
    } as PrivateEvaluationJob;
  });
  const computeComplete = (job: PrivateEvaluationJob): boolean => {
    const target =
      job.kind === "training_benchmark"
        ? job.pending.workload?.computePfDays
        : job.pending.quote.computePfDays;
    return (
      target == null ||
      !Number.isFinite(target) ||
      (job.pending.computeProgressPfDays ?? 0) + 1e-9 >= Math.max(0, target)
    );
  };
  const due = advanced.filter(
    (job) => state.day >= job.readyDay && computeComplete(job),
  );
  const remaining = advanced.filter(
    (job) => state.day < job.readyDay || !computeComplete(job),
  );
  if (due.length === 0) {
    const jobs = playerTrainingJobs(state).map((job) => ({
      ...job,
      pendingBenchmark: mirrorTrainingPending(remaining, job.id),
    }));
    const checkpoints = (state.player.trainingCheckpoints ?? []).map(
      (checkpoint) => ({
        ...checkpoint,
        pendingEvaluation: mirrorCheckpointPending(remaining, checkpoint.id),
      }),
    );
    return withTrainingJobs({
      ...state,
      player: {
        ...state.player,
        privateEvaluationJobs: remaining,
        trainingCheckpoints: checkpoints,
      },
    }, jobs);
  }

  let trainingJobs = playerTrainingJobs(state);
  let checkpoints = [...(state.player.trainingCheckpoints ?? [])];
  const completedByCheckpoint = new Map<string, CheckpointEvaluationReport[]>();
  const completedByReleasedModel = new Map<string, CheckpointEvaluationReport[]>();
  const rumorNames: string[] = [];
  const identityNames: string[] = [];
  const completionAlerts: SimState["alerts"] = [];

  for (const queued of due) {
    if (queued.kind === "training_benchmark") {
      const index = trainingJobs.findIndex((job) => job.id === queued.subjectId);
      if (index < 0) continue;
      const job = trainingJobs[index]!;
      const snapshot = resolveTrainingBenchmarkEvaluation(
        state,
        job,
        queued.pending.progress,
        queued.pending.stage,
        queued.pending,
      );
      const updated: TrainingJob = {
        ...job,
        benchmarkSnapshots: [...(job.benchmarkSnapshots ?? []), snapshot].slice(
          -32,
        ),
      };
      trainingJobs = trainingJobs.map((candidate, candidateIndex) =>
        candidateIndex === index ? updated : candidate,
      );
      completionAlerts.push({
        id: `train-benchmark-${queued.id}-${state.day}`,
        day: state.day,
        severity: "info",
        message: `${job.name} benchmark: ${(snapshot.suiteIds ?? []).length} suite${(snapshot.suiteIds ?? []).length === 1 ? "" : "s"} at ${Math.round((snapshot.accuracy ?? 0) * 100)}% measurement accuracy; capability ${snapshot.capability.toFixed(1)} [${(snapshot.capabilityLow ?? snapshot.capability).toFixed(1)}–${(snapshot.capabilityHigh ?? snapshot.capability).toFixed(1)}].`,
      });
      continue;
    }

    if (queued.kind === "released_model_evaluation") {
      const model = state.player.models.find(
        (candidate) => candidate.id === queued.subjectId,
      );
      if (!model) continue;
      const existingReports = [
        ...(model.checkpointEvaluations ?? []),
        ...(completedByReleasedModel.get(model.id) ?? []),
      ];
      if (existingReports.length >= MAX_CHECKPOINT_EVALUATIONS) continue;
      const pending = queued.pending;
      const report = resolveCheckpointEvaluation({
        model,
        rivals: state.rivals.flatMap((rival) =>
          rival.models
            .filter(isLivePublicModel)
            .map((rivalModel) => ({ model: rivalModel, labName: rival.name })),
        ),
        request: pending.request,
        reportSequence: pending.sequence,
        seed: releasedModelEvidenceSeed(state, model.id),
        scheduledDay: pending.scheduledDay,
        completedDay: state.day,
      });
      completedByReleasedModel.set(model.id, [
        ...(completedByReleasedModel.get(model.id) ?? []),
        report,
      ]);
      completionAlerts.push({
        id: `released-eval-${queued.id}-${state.day}`,
        day: state.day,
        severity: "info",
        message: `${model.name} evaluation: ${pending.request.suiteIds.length} suite${pending.request.suiteIds.length === 1 ? "" : "s"} at ${Math.round(report.quote.accuracy * 100)}% measurement accuracy.`,
      });
      continue;
    }

    const index = checkpoints.findIndex(
      (checkpoint) => checkpoint.id === queued.subjectId,
    );
    if (index < 0) continue;
    const checkpoint = checkpoints[index]!;
    if ((checkpoint.evaluations?.length ?? 0) >= MAX_CHECKPOINT_EVALUATIONS)
      continue;
    const pending = queued.pending;
    const report = resolveCheckpointEvaluation({
      model: checkpoint.model,
      rivals: state.rivals.flatMap((rival) =>
        rival.models
          .filter(isLivePublicModel)
          .map((model) => ({ model, labName: rival.name })),
      ),
      request: pending.request,
      reportSequence: pending.sequence,
      seed: checkpointEvidenceSeed(state, checkpoint.id),
      scheduledDay: pending.scheduledDay,
      completedDay: state.day,
    });
    checkpoints = checkpoints.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? {
            ...candidate,
            evaluations: [...(candidate.evaluations ?? []), report],
          }
        : candidate,
    );
    completedByCheckpoint.set(checkpoint.id, [
      ...(completedByCheckpoint.get(checkpoint.id) ?? []),
      report,
    ]);
    const promotedModel = checkpoint.promotedModelId
      ? state.player.models.find(
          (model) => model.id === checkpoint.promotedModelId,
        )
      : undefined;
    const alreadyPublic =
      Boolean(promotedModel && isLivePublicModel(promotedModel));
    if (!alreadyPublic && report.leakOutcome === "rumor")
      rumorNames.push(checkpoint.model.name);
    if (!alreadyPublic && report.leakOutcome === "identity_leak")
      identityNames.push(checkpoint.model.name);
  }

  trainingJobs = trainingJobs.map((job) => ({
    ...job,
    pendingBenchmark: mirrorTrainingPending(remaining, job.id),
  }));
  checkpoints = checkpoints.map((checkpoint) => ({
    ...checkpoint,
    pendingEvaluation: mirrorCheckpointPending(remaining, checkpoint.id),
  }));

  let next = withTrainingJobs(
    {
      ...state,
      player: {
        ...state.player,
        privateEvaluationJobs: remaining,
        trainingCheckpoints: checkpoints,
        models: state.player.models.map((model) => {
          const candidate = checkpoints.find(
            (checkpoint) => checkpoint.promotedModelId === model.id,
          );
          const reports = [
            ...(candidate ? (completedByCheckpoint.get(candidate.id) ?? []) : []),
            ...(completedByReleasedModel.get(model.id) ?? []),
          ];
          return reports.length
            ? {
                ...model,
                checkpointEvaluations: [
                  ...(model.checkpointEvaluations ?? []),
                  ...reports,
                ],
              }
            : model;
        }),
      },
    },
    trainingJobs,
  );
  next = {
    ...next,
    alerts: [...completionAlerts, ...next.alerts].slice(0, 40),
  };
  if (rumorNames.length > 0) {
    next = {
      ...next,
      news: [
        `Day ${state.day}: Industry rumors point to an unidentified model undergoing private trials.`,
        ...next.news,
      ].slice(0, 20),
      alerts: [
        {
          id: `checkpoint-eval-rumor-${state.day}`,
          day: state.day,
          severity: "warn" as const,
          message:
            "A stealth evaluation produced market rumors, but your lab identity remains concealed.",
        },
        ...next.alerts,
      ].slice(0, 40),
    };
  }
  if (identityNames.length > 0) {
    next = {
      ...next,
      news: [
        `Day ${state.day}: A private testing partner linked an unreleased checkpoint to ${state.player.name}.`,
        ...next.news,
      ].slice(0, 20),
      alerts: [
        {
          id: `checkpoint-eval-identity-${state.day}`,
          day: state.day,
          severity: "danger" as const,
          message:
            "A reviewer leaked the identity of a stealth checkpoint. The weights remain private.",
        },
        ...next.alerts,
      ].slice(0, 40),
    };
  }
  return next;
}
