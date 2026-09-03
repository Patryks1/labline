import {
  campaignYearsElapsed,
  rivalEraParamCeilingB,
} from "../balance/rivalScale";
import { DATA_DOMAINS } from "../balance/data";
import { publicFrontierParamsB } from "../systems/rivals";
import type { DataDomain, LabId, RivalLab, SimState } from "../types";
import { keepCheckpoint, safeModifiers } from "./checkpoints";
import { maxContextKForUnlocks } from "./compute";
import { TRAINING_V4 } from "./constants";
import { availableDomainTokens } from "./dataBridge";
import { createEndpoint, sunsetEndpoint } from "./endpoints";
import { hasUnlock } from "./modifiers";
import { startRun, trainPfForLab } from "./run";
import { trainingStateOf } from "./state";
import type { DataAllocation, ModelDesign, StartResult, TrainPrecision } from "./types";

const ACTIVE = new Set(["running", "queued", "paused", "awaiting_decision"]);
const LIVE_ENDPOINT_CAP = 3;

/**
 * Cadence is 120–400 days. Aggressive archetypes and later eras sit closer to
 * 120; safety / early-era labs sit closer to 400. A rival with an in-flight
 * run, or whose last completed run is younger than this cadence, returns null.
 */
export function rivalTrainCadenceDays(state: SimState, rival: RivalLab): number {
  const agg = aggressivenessOf(rival);
  const years = campaignYearsElapsed(state.day);
  return Math.min(400, Math.max(120, 400 - agg * 220 - years * 18));
}

function aggressivenessOf(rival: RivalLab): number {
  switch (rival.archetype) {
    case "hyperscale":
      return 1;
    case "efficiency":
      return 0.7;
    case "multimodal":
      return 0.55;
    case "open_weights":
      return 0.45;
    case "safety":
      return 0.25;
    default:
      return 0.5;
  }
}

function eraCeilingB(state: SimState, rival: RivalLab): number {
  try {
    return rivalEraParamCeilingB({
      day: state.day,
      archetype: rival.archetype,
      publicFrontierParamsB: publicFrontierParamsB(state),
    });
  } catch {
    const era = state.calendar?.era ?? state.progression?.era ?? "cloud_startup";
    if (era === "cloud_startup") return 7;
    if (era === "scaling_specialization") return 70;
    if (era === "platform_competition") return 400;
    return 1000;
  }
}

function lastTrainedDay(state: SimState, rivalId: LabId): number | null {
  const training = trainingStateOf(state, rivalId);
  let latest: number | null = null;
  for (const run of training.runs) {
    if (run.status !== "completed" && run.status !== "failed") continue;
    latest = latest == null ? run.startDay : Math.max(latest, run.startDay);
  }
  return latest;
}

function rivalModelName(rival: RivalLab, paramsB: number, gen: number): string {
  const base = rival.name.split(" ")[0] ?? rival.name;
  switch (rival.archetype) {
    case "open_weights":
      return `Lattice-${Math.max(1, Math.round(paramsB))}B`;
    case "efficiency":
      return `Sparse-${gen}`;
    case "multimodal":
      return `Chroma-${gen}`;
    case "safety":
      return `Aegis-${gen}`;
    default:
      return `${base}-${gen}`;
  }
}

function dataMixFor(state: SimState, rivalId: LabId, totalMTok: number): DataAllocation {
  const available = availableDomainTokens(state, rivalId);
  const domains = DATA_DOMAINS.filter((domain) => (available[domain]?.uniqueMTok ?? 0) > 0);
  const domainMTok: Partial<Record<DataDomain, number>> = {};
  if (domains.length === 0) {
    domainMTok.chat = totalMTok;
    return { domainMTok, holdoutShare: 0.05 };
  }
  const language = domains.includes("chat") ? "chat" : domains[0]!;
  const rest = domains.filter((domain) => domain !== language);
  domainMTok[language] = totalMTok * 0.8;
  if (rest.length === 0) {
    domainMTok[language] = totalMTok;
  } else {
    const each = (totalMTok * 0.2) / rest.length;
    for (const domain of rest) domainMTok[domain] = each;
  }
  return { domainMTok, holdoutShare: 0.05 };
}

function safeCreateEndpoint(
  state: SimState,
  labId: LabId,
  input: { name: string; checkpointId: string },
): { state: SimState; result: StartResult } {
  try {
    return createEndpoint(state, labId, input);
  } catch {
    return { state, result: { ok: false, reason: "endpoint unavailable" } };
  }
}

function safeSunsetEndpoint(state: SimState, endpointId: string, drainDays: number): SimState {
  try {
    return sunsetEndpoint(state, endpointId, drainDays);
  } catch {
    return state;
  }
}

/** Next rival design, or null when the rival is not training this era. */
export function rivalDesignFor(state: SimState, rivalId: LabId): ModelDesign | null {
  try {
    return rivalDesignForUnsafe(state, rivalId);
  } catch {
    return null;
  }
}

function rivalDesignForUnsafe(state: SimState, rivalId: LabId): ModelDesign | null {
  const rival = state.rivals.find((row) => row.id === rivalId);
  if (!rival) return null;
  const training = trainingStateOf(state, rivalId);
  if (training.runs.some((run) => ACTIVE.has(run.status))) return null;
  const cadence = rivalTrainCadenceDays(state, rival);
  const last = lastTrainedDay(state, rivalId);
  if (last != null && state.day - last < cadence) return null;

  const ceiling = eraCeilingB(state, rival);
  const paramsB = Math.min(ceiling, Math.max(7, training.biggestTrainedParamsB * 2));
  const mods = safeModifiers(state, rivalId);
  const moe = hasUnlock(mods, "moe");
  const precision: TrainPrecision = hasUnlock(mods, "nvfp4_train")
    ? "nvfp4"
    : hasUnlock(mods, "fp6_train")
      ? "fp6"
      : hasUnlock(mods, "fp8_train")
        ? "fp8_hybrid"
        : hasUnlock(mods, "bf16_train")
          ? "bf16_mixed"
          : hasUnlock(mods, "fp16_train")
            ? "fp16_mixed"
            : "fp32";
  const tokensMTok = 20 * paramsB * 1000;
  const trainPf = trainPfForLab(state, rivalId);
  const pfPerDay = Math.max(0.01, trainPf * 0.6);
  if (!Number.isFinite(pfPerDay) || pfPerDay <= 0) return null;
  const gen = 1 + training.runs.filter((run) => run.status === "completed").length;
  return {
    id: `design-rival-${rivalId}-${state.day}`,
    name: rivalModelName(rival, paramsB, gen),
    goal: "flagship",
    arch: {
      backbone: moe ? "moe" : "dense",
      totalParamsB: paramsB,
      activeParamsB: moe ? paramsB * 0.1 : paramsB,
      precision,
      preset: "language",
      inputs: ["text"],
      outputs: ["text"],
      contextK: maxContextKForUnlocks(mods.unlocks),
    },
    data: dataMixFor(state, rivalId, tokensMTok),
    mode: { kind: "pretrain" },
    compute: { pfPerDay, priority: 3, source: "local" },
    createdDay: state.day,
  };
}

function autoReleaseCompleted(state: SimState, rivalId: LabId): SimState {
  const training = trainingStateOf(state, rivalId);
  let next = state;
  for (const run of training.runs) {
    if (run.status !== "completed" || !run.finalCheckpointId) continue;
    const checkpoint = trainingStateOf(next, rivalId).checkpoints.find(
      (row) => row.id === run.finalCheckpointId,
    );
    if (!checkpoint || checkpoint.status !== "stealth") continue;
    next = keepCheckpoint(next, checkpoint.id);
    const released = safeCreateEndpoint(next, rivalId, {
      name: run.design.name,
      checkpointId: checkpoint.id,
    });
    if (released.result.ok) {
      next = released.state;
    }
  }
  const live = trainingStateOf(next, rivalId)
    .endpoints.filter((endpoint) => endpoint.status === "live")
    .sort((a, b) => a.releaseDay - b.releaseDay || a.id.localeCompare(b.id));
  if (live.length > LIVE_ENDPOINT_CAP) {
    const extra = live.length - LIVE_ENDPOINT_CAP;
    for (let i = 0; i < extra; i++) {
      const oldest = live[i];
      if (oldest) {
        next = safeSunsetEndpoint(next, oldest.id, TRAINING_V4.endpoints.sunsetDrainDays);
      }
    }
  }
  return next;
}

/** Advance rival V4 training (designs, runs, recipes, endpoints) for this tick. */
export function tickRivalTraining(state: SimState): SimState {
  let next = state;
  let changed = false;
  for (const rival of state.rivals ?? []) {
    const before = next;
    try {
      const design = rivalDesignFor(next, rival.id);
      if (design) {
        const started = startRun(next, rival.id, design);
        if (started.result.ok) next = started.state;
      }
      next = autoReleaseCompleted(next, rival.id);
    } catch {
      // Planning must not stall the rest of the V4 tick.
    }
    if (next !== before) changed = true;
  }
  return changed ? next : state;
}
