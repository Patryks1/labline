import { chargeExpense } from "../systems/financeLedger";
import { computeSnapshot } from "../systems/compute";
import { labTrainPf } from "../systems/labCompute";
import { hashSeed, seededId } from "../rng";
import type { LabId, ModelCapabilities, SimState } from "../types";
import {
  emptyPostTrain,
  findRun,
  labIdsOf,
  lineageIdForRun,
  safeModifiers,
  upsertCheckpoint,
} from "./checkpoints";
import { defaultTiers } from "./thinking";
import { cashPerPfDayEstimate } from "./compute";
import { TRAINING_V4 } from "./constants";
import { releaseReservation, reserveTokens } from "./dataBridge";
import { pushTrainingFeed } from "./feed";
import { forecastDesign, utilForLab } from "./forecast";
import {
  applyIncidentChoice,
  conservativeChoice,
  firstChoice,
  unresolvedIncident,
} from "./incidents";
import { drawEpsilon, isCatastrophic, realizeGap, rollIncident } from "./outcome";
import {
  capabilityFromGap,
  domainVectorFor,
  overallCapability,
} from "./scaling";
import { persistBaseCheckpointName } from "./naming";
import { emptyTrainingState, trainingStateOf, withTrainingState } from "./state";
import type {
  Checkpoint,
  ComputeSource,
  LossSample,
  ModelDesign,
  PostTrainRecord,
  StartResult,
  TrainingRun,
} from "./types";

const MAX_CONCURRENT_RUNS = 4;
const MAX_LOSS_SAMPLES = 60;
const OCCUPIED: TrainingRun["status"][] = [
  "running",
  "queued",
  "paused",
  "awaiting_decision",
];

export function cloudShareFor(source: ComputeSource): number {
  if (source === "cloud") return 1;
  if (source === "mixed") return 0.5;
  return 0;
}

/** Jobs that draw from the lab training PF pool (runs and post-train recipes). */
export type TrainingPfContender = {
  id: string;
  design: { compute: { priority?: number; pfPerDay?: number } };
};

/** Default recipe priority: same as an uncapped priority-1 run. */
export const RECIPE_TRAIN_PRIORITY = 1;

function runPriority(run: TrainingPfContender): number {
  return Math.max(1, run.design.compute.priority ?? 1);
}

function runPfCap(run: TrainingPfContender): number {
  const cap = run.design.compute.pfPerDay;
  if (Number.isFinite(cap) && cap > 0) return cap;
  return Number.POSITIVE_INFINITY;
}

export function recipeTrainContender(id: string): TrainingPfContender {
  return { id, design: { compute: { priority: RECIPE_TRAIN_PRIORITY } } };
}

export function trainingPfContenders(
  state: SimState,
  labId: LabId,
  extra: readonly TrainingPfContender[] = [],
): TrainingPfContender[] {
  const training = trainingStateOf(state, labId);
  const runs = training.runs
    .filter((run) => run.status === "running" || run.status === "queued")
    .map((run) => ({ id: run.id, design: run.design }));
  const recipes = training.recipes
    .filter((recipe) => recipe.status === "running")
    .map((recipe) => recipeTrainContender(recipe.id));
  return [...runs, ...recipes, ...extra];
}

/**
 * Split `trainPf` by priority, then cap each run at its requested `pfPerDay`.
 * Leftover after every cap is unused. Missing `pfPerDay` is uncapped (priority split of the pool).
 */
export function allocateTrainingPf(
  trainPf: number,
  runs: readonly TrainingPfContender[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const run of runs) out[run.id] = 0;
  if (!(trainPf > 0) || runs.length === 0) return out;

  let remaining = trainPf;
  const open = new Set(runs.map((run) => run.id));
  const byId = new Map(runs.map((run) => [run.id, run]));

  for (let guard = 0; guard < runs.length + 2 && remaining > 1e-12 && open.size > 0; guard++) {
    const active = [...open];
    const weightSum = active.reduce((sum, id) => sum + runPriority(byId.get(id)!), 0);
    if (!(weightSum > 0)) break;
    let cappedThisRound = false;
    let nextRemaining = remaining;
    for (const id of active) {
      const run = byId.get(id)!;
      const share = remaining * (runPriority(run) / weightSum);
      const room = Math.max(0, runPfCap(run) - (out[id] ?? 0));
      const take = Math.min(room, share);
      out[id] = (out[id] ?? 0) + take;
      nextRemaining -= take;
      if (room - take <= 1e-9) {
        open.delete(id);
        cappedThisRound = true;
      }
    }
    remaining = Math.max(0, nextRemaining);
    if (!cappedThisRound) break;
  }
  return out;
}

export function allocateLabTrainingPf(
  state: SimState,
  labId: LabId,
  extra: readonly TrainingPfContender[] = [],
): Record<string, number> {
  return allocateTrainingPf(trainPfForLab(state, labId), trainingPfContenders(state, labId, extra));
}

export function trainPfForLab(state: SimState, labId: LabId): number {
  try {
    if (labId === state.playerLabId) {
      return Math.max(0, computeSnapshot(state).pools.training);
    }
    const rival = state.rivals.find((row) => row.id === labId);
    if (!rival) return 0;
    const raw = labTrainPf({
      flopsPf: rival.flopsPf ?? 0,
      utilCap: rival.utilCap ?? 0.5,
      allocation: rival.allocation ?? { training: 0.34, inference: 0.33, research: 0.33 },
      servingEfficiency: rival.servingEfficiency,
      dataGenResearchShare: rival.data?.dataGenResearchShare,
    });
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  } catch {
    return 0;
  }
}

function clampPriority(priority: number): number {
  if (!Number.isFinite(priority)) return 1;
  return Math.min(5, Math.max(1, Math.round(priority)));
}

function occupiedCount(runs: readonly TrainingRun[]): number {
  return runs.filter((run) => OCCUPIED.includes(run.status)).length;
}

function bumpMinorVersion(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return "1.1";
  return `${match[1]}.${Number(match[2]) + 1}`;
}

function scalePostTrain(record: PostTrainRecord, mult: number): PostTrainRecord {
  const stages: PostTrainRecord["stages"] = {};
  for (const key of ["instruct", "preference", "reasoning", "agentic"] as const) {
    const row = record.stages[key];
    if (!row) continue;
    stages[key] = { ...row, effect: row.effect * mult };
  }
  return {
    stages,
    safetyFocus:
      record.safetyFocus != null ? record.safetyFocus * mult : undefined,
  };
}

function maxCapabilities(a: ModelCapabilities, b: ModelCapabilities): ModelCapabilities {
  const domains = { ...a.domains };
  for (const key of Object.keys(b.domains) as Array<keyof typeof b.domains>) {
    domains[key] = Math.max(a.domains[key] ?? 0, b.domains[key] ?? 0);
  }
  return {
    domains,
    factuality: Math.max(a.factuality, b.factuality),
    robustness: Math.max(a.robustness, b.robustness),
    steerability: Math.max(a.steerability, b.steerability),
    safety: Math.max(a.safety, b.safety),
    reliability: Math.max(a.reliability, b.reliability),
  };
}

function appendLoss(curve: LossSample[], sample: LossSample): LossSample[] {
  const next = [...curve, sample];
  if (next.length <= MAX_LOSS_SAMPLES) return next;
  const last = next.length - 1;
  const out: LossSample[] = [];
  for (let i = 0; i < MAX_LOSS_SAMPLES; i++) {
    const idx = Math.round((i / (MAX_LOSS_SAMPLES - 1)) * last);
    const row = next[idx];
    if (row && out[out.length - 1] !== row) out.push(row);
  }
  return out;
}

function lossAtProgress(run: TrainingRun, progress: number): number {
  const { E } = TRAINING_V4.scaling;
  const gap = run.forecast.loss.gap;
  const raw = E + (gap + 3) * (1 - progress) ** 1.4 + gap;
  const end = E + gap;
  const target = run.forecast.loss.loss;
  return raw + (target - end);
}

function bandLabel(realized: number, p10: number, p90: number): string {
  if (realized < p10) return "below";
  if (realized > p90) return "above";
  return "inside";
}

function persistTraining(state: SimState, labId: LabId): SimState {
  if (labId === state.playerLabId) {
    if (state.player.training) return state;
    return withTrainingState(state, labId, emptyTrainingState());
  }
  const rival = state.rivals.find((row) => row.id === labId);
  if (rival?.training) return state;
  return withTrainingState(state, labId, emptyTrainingState());
}

function replaceRun(state: SimState, labId: LabId, run: TrainingRun): SimState {
  const training = trainingStateOf(state, labId);
  return withTrainingState(state, labId, {
    ...training,
    runs: training.runs.map((row) => (row.id === run.id ? run : row)),
  });
}

function demandPressureOf(state: SimState): number {
  const raw = state.lastMarket?.unservedRatio;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
}

function deductCash(state: SimState, labId: LabId, amount: number): SimState {
  if (!(amount > 0)) return state;
  if (labId === state.playerLabId) return chargeExpense(state, amount, "training");
  return {
    ...state,
    rivals: state.rivals.map((rival) =>
      rival.id === labId ? { ...rival, cash: Math.max(0, rival.cash - amount) } : rival,
    ),
  };
}

function finalizeRun(state: SimState, labId: LabId, runId: string): SimState {
  const found = findRun(state, runId);
  if (!found) return state;
  const run = found.run;
  const training = found.training;
  const mods = run.modifiersFrozen;
  const sigma = run.forecast.capability.sigma * run.sigmaMult;
  const epsilon = drawEpsilon(run.seed, sigma);

  if (isCatastrophic(run.seed, run)) {
    const failed: TrainingRun = {
      ...run,
      status: "failed",
      progress: Math.min(1, run.progress),
      failureReason: "Catastrophic training failure. Last checkpoint retained.",
    };
    let next = replaceRun(state, labId, failed);
    next = releaseReservation(next, run.id);
    return pushTrainingFeed(next, {
      title: `${run.design.name} failed`,
      body: "Catastrophic training failure. Last checkpoint retained.",
      labId,
      kind: "run_failed",
      entityId: run.id,
      tone: "danger",
      alert: {
        severity: "danger",
        message: `${run.design.name} suffered a catastrophic failure.`,
      },
    });
  }

  const gap = realizeGap(run.forecast.loss.gap, epsilon, run.gapDelta);
  const cap = capabilityFromGap(gap, run.design.arch, mods);
  let truth = domainVectorFor(cap, run.design.arch, run.forecast.effectiveData.domainMix, mods);
  let postTrain = emptyPostTrain();
  let version = "1.0";
  let parentId: string | undefined;
  const mode = run.design.mode;
  const teacherId = mode.kind === "distill" ? mode.teacherCheckpointId : undefined;
  const parentCkptId = mode.kind === "continue" ? mode.parentCheckpointId : undefined;

  if (parentCkptId) {
    const parent = training.checkpoints.find((row) => row.id === parentCkptId);
    if (parent) {
      truth = maxCapabilities(parent.truth, truth);
      postTrain = parent.postTrain;
      version = bumpMinorVersion(parent.version);
      parentId = parent.id;
    }
  }
  if (teacherId) {
    const teacher = training.checkpoints.find((row) => row.id === teacherId);
    if (teacher) {
      postTrain = scalePostTrain(teacher.postTrain, 0.5);
    }
  }

  const checkpointId = seededId("ckpt-final", run.id);
  const checkpoint: Checkpoint = {
    id: checkpointId,
    labId,
    lineageId: lineageIdForRun(run, training.checkpoints),
    parentId,
    runId: run.id,
    name: persistBaseCheckpointName(run.design.name),
    version,
    stage: "base",
    status: "stealth",
    arch: {
      ...run.design.arch,
      inputs: [...run.design.arch.inputs],
      outputs: [...run.design.arch.outputs],
    },
    createdDay: state.day,
    progressAtSnapshot: 1,
    truth,
    trainingSummary: {
      pfDays: run.pfDaysDone,
      effectiveMTok: run.forecast.effectiveData.effectiveMTok,
      loss: TRAINING_V4.scaling.E + gap,
      gap,
      dataMix: run.forecast.effectiveData.domainMix,
      syntheticShare: run.forecast.effectiveData.syntheticShare,
      distilledFrom: teacherId,
    },
    postTrain,
    tiers: defaultTiers(),
    endpointIds: [],
  };

  const realized = overallCapability(truth);
  const band = bandLabel(realized, run.forecast.capability.p10, run.forecast.capability.p90);
  const completed: TrainingRun = {
    ...run,
    status: "completed",
    progress: 1,
    etaDays: 0,
    finalCheckpointId: checkpointId,
    checkpointIds: run.checkpointIds.includes(checkpointId)
      ? run.checkpointIds
      : [...run.checkpointIds, checkpointId],
  };

  let next = replaceRun(state, labId, completed);
  next = upsertCheckpoint(next, labId, checkpoint, run.id);
  const slice = trainingStateOf(next, labId);
  next = withTrainingState(next, labId, {
    ...slice,
    biggestTrainedParamsB: Math.max(slice.biggestTrainedParamsB, run.design.arch.totalParamsB),
    moeRunsCompleted:
      run.design.arch.backbone === "moe" ? slice.moeRunsCompleted + 1 : slice.moeRunsCompleted,
  });
  next = releaseReservation(next, run.id);
  return pushTrainingFeed(next, {
    title: `${run.design.name} completed`,
    body: `Landed ${band} forecast band.`,
    labId,
    kind: "run_completed",
    entityId: run.id,
    tone: band === "below" ? "warning" : "positive",
    alert: {
      severity: band === "below" ? "warn" : "info",
      message: `${run.design.name} landed ${band} the forecast band.`,
    },
  });
}

/** Reserve data, freeze modifiers, snapshot a forecast, and enqueue a run. */
export function startRun(
  state: SimState,
  labId: LabId,
  design: ModelDesign,
): { state: SimState; result: StartResult } {
  let next = persistTraining(state, labId);
  let forecast;
  try {
    forecast = forecastDesign(next, labId, design);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Forecast failed.";
    return { state, result: { ok: false, reason: message } };
  }
  if (forecast.blockers.length > 0) {
    return {
      state,
      result: { ok: false, reason: forecast.blockers.map((row) => row.message).join("; ") },
    };
  }
  const days = forecast.compute.days;
  const burnPerDay =
    Number.isFinite(days) && days > 0 ? forecast.compute.cashEstimate / days : 0;
  if (labId === next.playerLabId && next.player.cash + 1e-9 < burnPerDay * 3) {
    return { state, result: { ok: false, reason: "Need at least 3 days of forecast burn in cash." } };
  }
  const training = trainingStateOf(next, labId);
  if (occupiedCount(training.runs) >= MAX_CONCURRENT_RUNS) {
    return { state, result: { ok: false, reason: "At most 4 concurrent runs per lab." } };
  }

  const clamped: ModelDesign = {
    ...design,
    compute: { ...design.compute, priority: clampPriority(design.compute.priority) },
  };
  const id = seededId("run", labId, next.day, clamped.id, clamped.name);
  const trainPf = trainPfForLab(next, labId);
  const mode = clamped.mode;
  const parentCheckpointId = mode.kind === "continue" ? mode.parentCheckpointId : undefined;
  const teacherCheckpointId = mode.kind === "distill" ? mode.teacherCheckpointId : undefined;
  const run: TrainingRun = {
    id,
    labId,
    design: clamped,
    forecast,
    modifiersFrozen: safeModifiers(next, labId),
    seed: hashSeed(next.seed, id),
    status: trainPf > 0 ? "running" : "queued",
    startDay: next.day,
    progress: 0,
    pfDaysDone: 0,
    pfDaysTotal: forecast.compute.totalPfDays,
    cashSpent: 0,
    etaDays: forecast.compute.days,
    incidents: [],
    sigmaMult: 1,
    costMult: 1,
    gapDelta: 0,
    checkpointIds: [],
    autoCheckpointEvery: 0,
    lossCurve: [],
    parentCheckpointId,
    teacherCheckpointId,
  };
  next = withTrainingState(next, labId, {
    ...trainingStateOf(next, labId),
    runs: [...trainingStateOf(next, labId).runs, run],
  });
  next = reserveTokens(next, id, clamped.data);
  next = pushTrainingFeed(next, {
    title: `Training run started`,
    body: `${clamped.name} is ${run.status === "queued" ? "queued" : "running"}.`,
    labId,
    kind: "run_started",
    entityId: id,
    tone: "neutral",
    alert: { severity: "info", message: `${clamped.name} training ${run.status}.` },
  });
  return { state: next, result: { ok: true, id } };
}

function autoResolveIfDue(run: TrainingRun, day: number): TrainingRun {
  const pending = unresolvedIncident(run);
  if (!pending || day < pending.autoResolveDay) return run;
  const choice = conservativeChoice(pending);
  if (!choice) return run;
  const resolved = applyIncidentChoice(run, pending.id, choice.id);
  return resolved.status === "awaiting_decision" ? { ...resolved, status: "running" } : resolved;
}

function maybeRollIncident(
  state: SimState,
  labId: LabId,
  run: TrainingRun,
): { state: SimState; run: TrainingRun } {
  if (unresolvedIncident(run)) return { state, run };
  const incident = rollIncident(run, state.day);
  if (!incident) return { state, run };
  let nextRun: TrainingRun = { ...run, incidents: [...run.incidents, incident] };
  if (labId === state.playerLabId) {
    nextRun = { ...nextRun, status: "awaiting_decision" };
    const next = pushTrainingFeed(state, {
      title: incident.title,
      body: incident.body,
      labId,
      kind: "run_incident",
      entityId: run.id,
      tone: "warning",
      alert: { severity: "warn", message: `${run.design.name}: ${incident.title}` },
    });
    return { state: next, run: nextRun };
  }
  const choice = firstChoice(incident);
  if (choice) nextRun = applyIncidentChoice(nextRun, incident.id, choice.id);
  return { state, run: nextRun };
}

/** Advance running jobs; snapshot autos; resolve AFK incidents; finalize checkpoints. */
export function tickRuns(state: SimState): SimState {
  let next = state;
  let changed = false;
  for (const labId of labIdsOf(next)) {
    const training = trainingStateOf(next, labId);
    if (!training.runs.some((run) => OCCUPIED.includes(run.status))) continue;
    changed = true;
    try {
    const trainPf = trainPfForLab(next, labId);
    const util = utilForLab(next, labId);
    const started = training.runs.map((run) => {
      const due = OCCUPIED.includes(run.status) ? autoResolveIfDue(run, next.day) : run;
      return due.status === "queued" && trainPf > 0 ? { ...due, status: "running" as const } : due;
    });
    let labState = withTrainingState(next, labId, { ...training, runs: started });
    const shares = allocateLabTrainingPf(labState, labId);
    for (const run of started) {
      if (run.status !== "running") continue;
      const share = shares[run.id] ?? 0;
      const pfToday = share * util;
      const denom = Math.max(1e-12, run.pfDaysTotal);
      const rawInc = (pfToday * run.forecast.compute.throughput) / denom;
      const cap = 1 / Math.max(1e-6, run.forecast.compute.paceFloorDays);
      const increment = Math.min(rawInc, cap);
      const prevProgress = run.progress;
      const progress = Math.min(1, prevProgress + increment);
      const remaining = Math.max(0, 1 - progress);
      const rate = cashPerPfDayEstimate(labState.day, demandPressureOf(labState));
      const cashToday =
        pfToday * cloudShareFor(run.design.compute.source) * rate * run.costMult;
      if (cashToday > 0) labState = deductCash(labState, labId, cashToday);
      let advanced: TrainingRun = {
        ...run,
        progress,
        pfDaysDone: run.pfDaysDone + pfToday,
        etaDays: increment > 1e-12 ? remaining / increment : run.etaDays,
        cashSpent: run.cashSpent + cashToday,
        lossCurve: appendLoss(run.lossCurve, { progress, loss: lossAtProgress(run, progress) }),
      };
      labState = replaceRun(labState, labId, advanced);
      if (progress < 1) {
        const rolled = maybeRollIncident(labState, labId, advanced);
        labState = rolled.state;
        advanced = rolled.run;
        labState = replaceRun(labState, labId, advanced);
      }
      const latest = findRun(labState, advanced.id)?.run ?? advanced;
      if (latest.status === "running" && latest.progress >= 1 - 1e-9) {
        labState = finalizeRun(labState, labId, latest.id);
      }
    }
    next = labState;
    } catch {
      // A single lab must not abort the rest of the training tick.
    }
  }
  return changed ? next : state;
}

export function pauseRun(state: SimState, runId: string): SimState {
  const found = findRun(state, runId);
  if (!found) return state;
  if (found.run.status !== "running" && found.run.status !== "queued") return state;
  return replaceRun(state, found.labId, { ...found.run, status: "paused" });
}

export function resumeRun(state: SimState, runId: string): SimState {
  const found = findRun(state, runId);
  if (!found || found.run.status !== "paused") return state;
  const trainPf = trainPfForLab(state, found.labId);
  return replaceRun(state, found.labId, {
    ...found.run,
    status: trainPf > 0 ? "running" : "queued",
  });
}

export function cancelRun(state: SimState, runId: string): SimState {
  const found = findRun(state, runId);
  if (!found) return state;
  if (found.run.status === "completed" || found.run.status === "failed") return state;
  if (found.run.status === "cancelled") return state;
  let next = replaceRun(state, found.labId, { ...found.run, status: "cancelled" });
  next = releaseReservation(next, runId);
  return pushTrainingFeed(next, {
    title: `${found.run.design.name} cancelled`,
    body: "Reservation released. Checkpoints kept.",
    labId: found.labId,
    kind: "run_cancelled",
    entityId: runId,
    tone: "warning",
  });
}

export function setRunPriority(state: SimState, runId: string, priority: number): SimState {
  const found = findRun(state, runId);
  if (!found) return state;
  return replaceRun(state, found.labId, {
    ...found.run,
    design: {
      ...found.run.design,
      compute: { ...found.run.design.compute, priority: clampPriority(priority) },
    },
  });
}

export function setRunPfPerDay(state: SimState, runId: string, pfPerDay: number): SimState {
  const found = findRun(state, runId);
  if (!found) return state;
  const next = Number.isFinite(pfPerDay) ? Math.max(0, pfPerDay) : 0;
  return replaceRun(state, found.labId, {
    ...found.run,
    design: {
      ...found.run.design,
      compute: { ...found.run.design.compute, pfPerDay: next },
    },
  });
}

export function resolveIncident(
  state: SimState,
  runId: string,
  incidentId: string,
  choiceId: string,
): SimState {
  const found = findRun(state, runId);
  if (!found) return state;
  const applied = applyIncidentChoice(found.run, incidentId, choiceId);
  const nextRun: TrainingRun =
    applied.status === "awaiting_decision" ? { ...applied, status: "running" } : applied;
  return replaceRun(state, found.labId, nextRun);
}

/** True when any player run is `awaiting_decision`. */
export function hasPendingDecision(state: SimState): boolean {
  return trainingStateOf(state, state.playerLabId).runs.some(
    (run) => run.status === "awaiting_decision",
  );
}
