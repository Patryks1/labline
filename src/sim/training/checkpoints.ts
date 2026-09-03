import type { LabId, SimState } from "../types";
import { seededId } from "../rng";
import { baselineModifiers, modifiersForLab } from "./modifiers";
import { capabilityFromGap, domainVectorFor } from "./scaling";
import { trainingStateOf, withTrainingState } from "./state";
import { defaultTiers } from "./thinking";
import { persistBaseCheckpointName } from "./naming";
import type { Checkpoint, TrainingRun, TrainingState } from "./types";

export function safeModifiers(state: SimState, labId: LabId) {
  try {
    return modifiersForLab(state, labId);
  } catch {
    return baselineModifiers();
  }
}

export function labIdsOf(state: SimState): LabId[] {
  return [state.playerLabId, ...(state.rivals ?? []).map((rival) => rival.id)];
}

/** Snapshot version from run progress. 25% → `0.25`, complete → `1.0`. */
export function snapshotVersion(progress: number): string {
  const progressPct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  if (progressPct >= 100) return "1.0";
  return `0.${String(progressPct).padStart(2, "0")}`;
}

export function findCheckpoint(
  state: SimState,
  checkpointId: string,
): { labId: LabId; checkpoint: Checkpoint; training: TrainingState } | null {
  for (const labId of labIdsOf(state)) {
    const training = trainingStateOf(state, labId);
    const checkpoint = training.checkpoints.find((row) => row.id === checkpointId);
    if (checkpoint) return { labId, checkpoint, training };
  }
  return null;
}

export function findRun(
  state: SimState,
  runId: string,
): { labId: LabId; run: TrainingRun; training: TrainingState } | null {
  for (const labId of labIdsOf(state)) {
    const training = trainingStateOf(state, labId);
    const run = training.runs.find((row) => row.id === runId);
    if (run) return { labId, run, training };
  }
  return null;
}

export function emptyPostTrain() {
  return { stages: {} };
}

/** Lineage id the final checkpoint will use, so mid-run snapshots share it. */
export function lineageIdForRun(run: TrainingRun, checkpoints: Checkpoint[]): string {
  const mode = run.design.mode;
  if (mode.kind === "continue") {
    const parent = checkpoints.find((row) => row.id === mode.parentCheckpointId);
    return parent?.lineageId ?? seededId("lineage", run.id);
  }
  return seededId("lineage", run.id);
}

export function isAutoCheckpointId(id: string): boolean {
  return id.startsWith("ckpt-auto-");
}

const LIVE_RUN_STATUS = new Set(["running", "queued", "paused", "awaiting_decision"]);

/** Why this checkpoint cannot be discarded right now. Historical lineage does not count. */
export function discardBlockReason(
  training: TrainingState,
  checkpoint: Pick<Checkpoint, "id" | "status">,
): string | undefined {
  if (checkpoint.status !== "stealth" && checkpoint.status !== "kept") {
    return "Only stealth or kept checkpoints can be discarded.";
  }
  return liveUsesOfCheckpoint(training, checkpoint.id)[0];
}

function liveUsesOfCheckpoint(training: TrainingState, checkpointId: string): string[] {
  const reasons: string[] = [];
  for (const endpoint of training.endpoints) {
    if (endpoint.status === "retired") continue;
    if (endpoint.members.some((member) => member.checkpointId === checkpointId)) {
      reasons.push("Sunset or retire the live endpoint first.");
      break;
    }
  }
  for (const recipe of training.recipes) {
    if (recipe.status !== "running") continue;
    if (recipe.checkpointId === checkpointId) {
      reasons.push("A post-training recipe is still using these weights.");
      break;
    }
  }
  for (const run of training.runs) {
    if (!LIVE_RUN_STATUS.has(run.status)) continue;
    if (run.parentCheckpointId === checkpointId || run.teacherCheckpointId === checkpointId) {
      reasons.push("A training run still depends on these weights.");
      break;
    }
    const mode = run.design.mode;
    if (mode.kind === "continue" && mode.parentCheckpointId === checkpointId) {
      reasons.push("A training run still depends on these weights.");
      break;
    }
    if (mode.kind === "distill" && mode.teacherCheckpointId === checkpointId) {
      reasons.push("A training run still depends on these weights.");
      break;
    }
  }
  for (const gym of training.gyms) {
    if (gym.teacherCheckpointId === checkpointId) {
      reasons.push("A gym still uses these weights as its teacher.");
      break;
    }
  }
  return reasons;
}

function checkpointReferenced(training: TrainingState, checkpointId: string): boolean {
  return liveUsesOfCheckpoint(training, checkpointId).length > 0;
}

function replaceCheckpoint(
  state: SimState,
  labId: LabId,
  checkpointId: string,
  patch: (checkpoint: Checkpoint) => Checkpoint,
): SimState {
  const training = trainingStateOf(state, labId);
  return withTrainingState(state, labId, {
    ...training,
    checkpoints: training.checkpoints.map((row) =>
      row.id === checkpointId ? patch(row) : row,
    ),
  });
}

function dropOldestAuto(training: TrainingState, exceptId: string): TrainingState {
  const autoCount = training.checkpoints.filter((row) => isAutoCheckpointId(row.id)).length;
  if (autoCount <= 6) return training;
  const autos = training.checkpoints
    .filter(
      (row) =>
        isAutoCheckpointId(row.id) &&
        row.id !== exceptId &&
        row.status === "stealth" &&
        !checkpointReferenced(training, row.id),
    )
    .sort((a, b) => a.createdDay - b.createdDay || a.id.localeCompare(b.id));
  const oldest = autos[0];
  if (!oldest) return training;
  return {
    ...training,
    checkpoints: training.checkpoints.map((row) =>
      row.id === oldest.id ? { ...row, status: "discarded" as const } : row,
    ),
  };
}

/** Immutable snapshot of current run weights + hidden truth. */
export function snapshotCheckpoint(
  state: SimState,
  runId: string,
  opts?: { name?: string; auto?: boolean },
): { state: SimState; checkpointId: string | null } {
  const found = findRun(state, runId);
  if (!found) return { state, checkpointId: null };
  const { labId, run, training } = found;
  if (
    run.status !== "running" &&
    run.status !== "paused" &&
    run.status !== "awaiting_decision"
  ) {
    return { state, checkpointId: null };
  }
  if (run.progress < 0.05) return { state, checkpointId: null };

  const progressPct = Math.round(run.progress * 100);
  const id = seededId(opts?.auto ? "ckpt-auto" : "ckpt", run.id, progressPct, opts?.name);
  if (training.checkpoints.some((row) => row.id === id)) {
    return { state, checkpointId: id };
  }

  const mods = run.modifiersFrozen;
  const gapAt = run.forecast.loss.gap + 3 * (1 - run.progress) ** 1.4;
  const cap = capabilityFromGap(gapAt, run.design.arch, mods);
  const truth = domainVectorFor(cap, run.design.arch, run.forecast.effectiveData.domainMix, mods);
  const mode = run.design.mode;
  const parentId = mode.kind === "continue" ? mode.parentCheckpointId : undefined;
  const checkpoint: Checkpoint = {
    id,
    labId,
    lineageId: lineageIdForRun(run, training.checkpoints),
    parentId,
    runId: run.id,
    name: opts?.name ?? persistBaseCheckpointName(run.design.name),
    version: snapshotVersion(run.progress),
    stage: "base",
    status: "stealth",
    arch: {
      ...run.design.arch,
      inputs: [...run.design.arch.inputs],
      outputs: [...run.design.arch.outputs],
    },
    createdDay: state.day,
    progressAtSnapshot: run.progress,
    truth,
    trainingSummary: {
      pfDays: run.pfDaysDone,
      effectiveMTok: run.forecast.effectiveData.effectiveMTok * run.progress,
      loss: run.forecast.loss.loss + 3 * (1 - run.progress) ** 1.4,
      gap: gapAt,
      dataMix: run.forecast.effectiveData.domainMix,
      syntheticShare: run.forecast.effectiveData.syntheticShare,
    },
    postTrain: emptyPostTrain(),
    tiers: defaultTiers(),
    endpointIds: [],
  };

  let nextTraining: TrainingState = {
    ...training,
    checkpoints: [...training.checkpoints, checkpoint],
    runs: training.runs.map((row) =>
      row.id === run.id ? { ...row, checkpointIds: [...row.checkpointIds, id] } : row,
    ),
  };
  if (opts?.auto) nextTraining = dropOldestAuto(nextTraining, id);
  return { state: withTrainingState(state, labId, nextTraining), checkpointId: id };
}

export function keepCheckpoint(state: SimState, checkpointId: string): SimState {
  const found = findCheckpoint(state, checkpointId);
  if (!found || found.checkpoint.status !== "stealth") return state;
  return replaceCheckpoint(state, found.labId, checkpointId, (row) => ({
    ...row,
    status: "kept",
  }));
}

export function discardCheckpoint(state: SimState, checkpointId: string): SimState {
  const found = findCheckpoint(state, checkpointId);
  if (!found) return state;
  if (found.checkpoint.status !== "stealth" && found.checkpoint.status !== "kept") {
    return state;
  }
  if (checkpointReferenced(found.training, checkpointId)) return state;
  return replaceCheckpoint(state, found.labId, checkpointId, (row) => ({
    ...row,
    status: "discarded",
  }));
}

export function renameCheckpoint(
  state: SimState,
  checkpointId: string,
  name: string,
): SimState {
  const found = findCheckpoint(state, checkpointId);
  if (!found) return state;
  const trimmed = name.trim();
  if (!trimmed) return state;
  return replaceCheckpoint(state, found.labId, checkpointId, (row) => ({
    ...row,
    name: trimmed,
  }));
}

export function checkpointById(state: SimState, id: string): Checkpoint | undefined {
  return findCheckpoint(state, id)?.checkpoint;
}

/**
 * Lineage walk: ancestors from root → … → `checkpointId` (inclusive), then
 * descendants of `checkpointId` in breadth-first order (excluding self).
 */
export function lineageOf(state: SimState, checkpointId: string): Checkpoint[] {
  const found = findCheckpoint(state, checkpointId);
  if (!found) return [];
  const { training, checkpoint } = found;
  const byId = new Map(training.checkpoints.map((row) => [row.id, row]));
  const ancestors: Checkpoint[] = [];
  const seen = new Set<string>();
  let cursor: Checkpoint | undefined = checkpoint;
  while (cursor) {
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    ancestors.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  ancestors.reverse();

  const descendants: Checkpoint[] = [];
  const queue: string[] = [checkpoint.id];
  const visited = new Set<string>([checkpoint.id]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = training.checkpoints
      .filter((row) => row.parentId === current && !visited.has(row.id))
      .sort((a, b) => a.createdDay - b.createdDay || a.id.localeCompare(b.id));
    for (const child of children) {
      visited.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return [...ancestors, ...descendants];
}

export function upsertCheckpoint(
  state: SimState,
  labId: LabId,
  checkpoint: Checkpoint,
  runId?: string,
): SimState {
  const training = trainingStateOf(state, labId);
  const exists = training.checkpoints.some((row) => row.id === checkpoint.id);
  const checkpoints = exists
    ? training.checkpoints.map((row) => (row.id === checkpoint.id ? checkpoint : row))
    : [...training.checkpoints, checkpoint];
  const runs = runId
    ? training.runs.map((row) =>
        row.id === runId && !row.checkpointIds.includes(checkpoint.id)
          ? { ...row, checkpointIds: [...row.checkpointIds, checkpoint.id] }
          : row,
      )
    : training.runs;
  return withTrainingState(state, labId, { ...training, checkpoints, runs });
}
