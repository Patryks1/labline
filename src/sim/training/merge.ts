import { CAPABILITY_DOMAINS } from "../balance/modelCapabilities";
import { chargeExpense } from "../systems/financeLedger";
import { createRng, hashSeed, seededId } from "../rng";
import type { ModelCapabilities, SimState } from "../types";
import { findCheckpoint, safeModifiers } from "./checkpoints";
import { TRAINING_V4 } from "./constants";
import { pushTrainingFeed } from "./feed";
import { baselineModifiers, hasUnlock } from "./modifiers";
import { archCeiling } from "./scaling";
import { trainingStateOf, withTrainingState } from "./state";
import type {
  Checkpoint,
  CheckpointStage,
  PostTrainRecord,
  PostTrainStageKind,
  StartResult,
} from "./types";

const MERGE_CASH = 250_000;
const READY = new Set(["kept", "released", "stealth"]);
const STAGES: PostTrainStageKind[] = ["instruct", "preference", "reasoning", "agentic"];
const MERGE_PARAM_TOLERANCE = 0.05;

/** True when two parameter counts are within 5% (same-family merge). */
export function mergeParamDeltaOk(a: number, b: number): boolean {
  const denom = Math.max(a, b, 1e-9);
  return Math.abs(a - b) / denom <= MERGE_PARAM_TOLERANCE;
}

function fail(state: SimState, reason: string): { state: SimState; result: StartResult } {
  return { state, result: { ok: false, reason } };
}

/** Same-family merge eligibility (arch, unlock, status). */
export function canMerge(
  state: SimState,
  aId: string,
  bId: string,
): { ok: boolean; reason?: string } {
  if (aId === bId) return { ok: false, reason: "Need two distinct checkpoints." };
  const a = findCheckpoint(state, aId);
  const b = findCheckpoint(state, bId);
  if (!a || !b) return { ok: false, reason: "Checkpoint missing." };
  if (a.labId !== b.labId) return { ok: false, reason: "Checkpoints must share a lab." };
  if (!READY.has(a.checkpoint.status) || !READY.has(b.checkpoint.status)) {
    return { ok: false, reason: "Both checkpoints must be stealth, kept, or released." };
  }
  if (a.checkpoint.arch.backbone !== b.checkpoint.arch.backbone) {
    return { ok: false, reason: "Backbones must match." };
  }
  if (!mergeParamDeltaOk(a.checkpoint.arch.totalParamsB, b.checkpoint.arch.totalParamsB)) {
    return { ok: false, reason: "Parameter counts differ by more than 5%." };
  }
  if (a.checkpoint.arch.preset !== b.checkpoint.arch.preset) {
    return { ok: false, reason: "Presets must match." };
  }
  if (!hasUnlock(safeModifiers(state, a.labId), "merge")) {
    return { ok: false, reason: "Merge research is still locked." };
  }
  return { ok: true };
}

function higherStage(a: CheckpointStage, b: CheckpointStage): CheckpointStage {
  return a === "post" || b === "post" ? "post" : "base";
}

function unionPostTrain(a: PostTrainRecord, b: PostTrainRecord): PostTrainRecord {
  const stages: PostTrainRecord["stages"] = {};
  for (const key of STAGES) {
    const left = a.stages[key];
    const right = b.stages[key];
    if (!left && !right) continue;
    if (!left) {
      stages[key] = { ...right! };
      continue;
    }
    if (!right) {
      stages[key] = { ...left };
      continue;
    }
    const pick = left.effect >= right.effect ? left : right;
    stages[key] = { ...pick };
  }
  const safetyFocus =
    a.safetyFocus == null
      ? b.safetyFocus
      : b.safetyFocus == null
        ? a.safetyFocus
        : Math.max(a.safetyFocus, b.safetyFocus);
  return { stages, safetyFocus };
}

function mergeTruth(
  a: Checkpoint,
  b: Checkpoint,
  bonus: number,
  rng: { next(): number },
): ModelCapabilities {
  const wall = Math.max(
    archCeiling(a.arch, baselineModifiers()),
    archCeiling(b.arch, baselineModifiers()),
  );
  const domains = { ...a.truth.domains };
  for (const key of CAPABILITY_DOMAINS) {
    domains[key] = Math.min(
      wall,
      Math.max(a.truth.domains[key] ?? 0, b.truth.domains[key] ?? 0) + bonus,
    );
  }
  if (rng.next() < TRAINING_V4.merge.regressionRisk) {
    const pick = CAPABILITY_DOMAINS[Math.floor(rng.next() * CAPABILITY_DOMAINS.length)]!;
    domains[pick] = Math.max(0, (domains[pick] ?? 0) - 4);
  }
  return {
    domains,
    factuality: Math.min(100, Math.max(a.truth.factuality, b.truth.factuality) + bonus),
    robustness: Math.min(100, Math.max(a.truth.robustness, b.truth.robustness) + bonus),
    steerability: Math.min(100, Math.max(a.truth.steerability, b.truth.steerability) + bonus),
    safety: Math.min(100, Math.max(a.truth.safety, b.truth.safety)),
    reliability: Math.min(100, Math.max(a.truth.reliability, b.truth.reliability) + bonus),
  };
}

/** Merge two checkpoints into a child checkpoint (bonus 1.5, regression risk 0.15). */
export function mergeCheckpoints(
  state: SimState,
  aId: string,
  bId: string,
  name: string,
): { state: SimState; result: StartResult } {
  const gate = canMerge(state, aId, bId);
  if (!gate.ok) return fail(state, gate.reason ?? "Cannot merge.");
  const a = findCheckpoint(state, aId)!;
  const b = findCheckpoint(state, bId)!;
  const labId = a.labId;
  if (labId === state.playerLabId && state.player.cash + 1e-9 < MERGE_CASH) {
    return fail(state, "Need $250k to merge.");
  }
  const rng = createRng(hashSeed(state.seed, aId, bId, "merge", state.day));
  const id = seededId("ckpt-merge", labId, state.day, aId, bId, name);
  const larger = a.checkpoint.arch.totalParamsB >= b.checkpoint.arch.totalParamsB ? a.checkpoint : b.checkpoint;
  const checkpoint: Checkpoint = {
    id,
    labId,
    lineageId: a.checkpoint.lineageId,
    parentId: a.checkpoint.id,
    name: name.trim() || `${a.checkpoint.name}+${b.checkpoint.name}`,
    version: "1.0m",
    stage: higherStage(a.checkpoint.stage, b.checkpoint.stage),
    status: "stealth",
    arch: {
      ...larger.arch,
      inputs: [...larger.arch.inputs],
      outputs: [...larger.arch.outputs],
    },
    createdDay: state.day,
    progressAtSnapshot: 1,
    truth: mergeTruth(a.checkpoint, b.checkpoint, TRAINING_V4.merge.bonus, rng),
    trainingSummary: {
      pfDays: a.checkpoint.trainingSummary.pfDays + b.checkpoint.trainingSummary.pfDays,
      effectiveMTok:
        a.checkpoint.trainingSummary.effectiveMTok + b.checkpoint.trainingSummary.effectiveMTok,
      loss: Math.min(a.checkpoint.trainingSummary.loss, b.checkpoint.trainingSummary.loss),
      gap: Math.min(a.checkpoint.trainingSummary.gap, b.checkpoint.trainingSummary.gap),
      dataMix: { ...a.checkpoint.trainingSummary.dataMix },
      syntheticShare: Math.max(
        a.checkpoint.trainingSummary.syntheticShare,
        b.checkpoint.trainingSummary.syntheticShare,
      ),
      mergedFrom: [aId, bId],
    },
    postTrain: unionPostTrain(a.checkpoint.postTrain, b.checkpoint.postTrain),
    tiers: a.checkpoint.tiers.map((tier) => ({ ...tier })),
    endpointIds: [],
  };
  const training = trainingStateOf(state, labId);
  let next = withTrainingState(state, labId, {
    ...training,
    checkpoints: [...training.checkpoints, checkpoint],
  });
  if (labId === next.playerLabId) next = chargeExpense(next, MERGE_CASH, "training");
  next = pushTrainingFeed(next, {
    title: `Merged ${checkpoint.name}`,
    body: "Soup merge complete. Regression risk applied from seed.",
    labId,
    kind: "merge_complete",
    entityId: id,
    tone: "positive",
  });
  return { state: next, result: { ok: true, id } };
}
