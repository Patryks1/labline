import { RESEARCH_NODES, getResearchNode } from "../balance/research";
import type { LabId, ResearchNodeDef, RivalLab, SimState } from "../types";
import { TRAINING_V4 } from "./constants";
import type { TrainingModifiers, TrainingUnlock } from "./types";

const MULT_KEYS = [
  "paramEfficiency",
  "dataEfficiency",
  "computeThroughput",
  "stability",
  "precisionPenaltyMult",
  "postTrainEfficiency",
  "syntheticQuality",
  "distillEfficiency",
  "serveEfficiency",
  "hostingDiscount",
  "quantPenaltyMult",
  "modalityBridge",
] as const;

type MultKey = (typeof MULT_KEYS)[number];

const QUALITY_KEYS = ["rlQuality", "routerQuality", "verifierStrength"] as const;
type QualityKey = (typeof QUALITY_KEYS)[number];

export const TRAINING_UNLOCK_LABELS: Record<TrainingUnlock, string> = {
  moe: "MoE",
  omni: "Omni",
  vision: "Vision",
  audio: "Audio",
  video: "Video",
  context_32k: "32k context",
  long_context: "Long context",
  context_1m: "1M context",
  context_10m: "10M context",
  context_100m: "100M context",
  fp16_train: "FP16 train",
  bf16_train: "BF16 train",
  fp8_train: "FP8 train",
  fp6_train: "FP6 train",
  nvfp4_train: "NVFP4 train",
  distill: "Distill",
  merge: "Merge",
  thinking_tiers: "Thinking tiers",
  router_domain: "Domain router",
  router_cascade: "Cascade router",
  continued_pretrain: "Continued pretrain",
  verifier: "Verifier",
};

/** Baseline V4 modifiers: multipliers 1, additive ceilingLift 0, quality priors as documented. */
export function baselineModifiers(): TrainingModifiers {
  return {
    paramEfficiency: 1,
    dataEfficiency: 1,
    computeThroughput: 1,
    stability: 1,
    precisionPenaltyMult: 1,
    ceilingLift: 0,
    postTrainEfficiency: 1,
    rlQuality: 0.35,
    syntheticQuality: 1,
    verifierStrength: 0.2,
    distillEfficiency: 1,
    routerQuality: 0.5,
    serveEfficiency: 1,
    hostingDiscount: 1,
    quantPenaltyMult: 1,
    modalityBridge: 1,
    unlocks: [],
  };
}

function rankOf(ranks: Record<string, number>, id: string): number {
  const recorded = ranks[id];
  if (recorded != null && Number.isFinite(recorded) && recorded > 0) {
    return recorded;
  }
  return 1;
}

/**
 * Fold catalog nodes × ranks into modifiers.
 * Multiplicative fields: product of value^rank (missing value = 1).
 * ceilingLift: Σ value·rank.
 * rlQuality / routerQuality / verifierStrength: baseline + Σ value·rank, clamped [0, 1].
 * unlocks: union of node.effects.unlock.
 */
export function aggregateModifiers(
  nodes: ResearchNodeDef[],
  ranks: Record<string, number>,
): TrainingModifiers {
  const out = baselineModifiers();
  const unlocks = new Set<TrainingUnlock>();

  for (const node of nodes) {
    const rank = rankOf(ranks, node.id);
    const effects = node.effects;

    for (const key of MULT_KEYS) {
      const value = effects[key];
      if (value == null || value === 1) continue;
      out[key] *= value ** rank;
    }

    if (effects.ceilingLift) {
      out.ceilingLift += effects.ceilingLift * rank;
    }

    for (const key of QUALITY_KEYS) {
      const value = effects[key];
      if (value == null || value === 0) continue;
      out[key] += value * rank;
    }

    for (const unlock of effects.unlock ?? []) {
      unlocks.add(unlock);
    }
  }

  for (const key of QUALITY_KEYS) {
    out[key] = Math.min(1, Math.max(0, out[key]));
  }
  out.unlocks = [...unlocks];
  return out;
}

function ranksForUnlocked(
  unlocked: readonly string[],
  ranks: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of unlocked) {
    const recorded = ranks?.[id];
    out[id] =
      recorded != null && Number.isFinite(recorded) && recorded > 0 ? recorded : 1;
  }
  return out;
}

function nodesForIds(ids: readonly string[]): ResearchNodeDef[] {
  const out: ResearchNodeDef[] = [];
  for (const id of ids) {
    try {
      out.push(getResearchNode(id));
    } catch {
      // Unknown leftover ids (old saves / other workstreams) do not contribute.
    }
  }
  return out;
}

/**
 * Cheapest-first topological walk used when a rival has no persisted unlock list.
 * Live rivals start at ["dense_basics"] in createRivals and tick more via
 * planRivalResearchPath / canLabResearchNode — this fallback approximates that
 * same cheapest-available grant curve from campaign day when the list is missing.
 */
export function eraDefaultResearchIds(day: number): string[] {
  const years = Math.max(0, (Math.max(1, day) - 1) / 365);
  const count = Math.min(40, Math.max(1, Math.round(1 + years * 4.5)));
  const unlocked = new Set<string>(["dense_basics"]);
  const picked: string[] = ["dense_basics"];
  while (picked.length < count) {
    const available = RESEARCH_NODES.filter(
      (node) =>
        !unlocked.has(node.id) &&
        node.prereqs.every((prereq) => unlocked.has(prereq)) &&
        !node.exclusiveWith?.some((other) => unlocked.has(other)),
    ).sort(
      (a, b) => a.costPfDays - b.costPfDays || a.id.localeCompare(b.id),
    );
    const next = available[0];
    if (!next) break;
    unlocked.add(next.id);
    picked.push(next.id);
  }
  return picked;
}

function rivalUnlockIds(state: SimState, rival: RivalLab): string[] {
  const listed = rival.researchUnlocked;
  if (listed == null || listed.length === 0) {
    return eraDefaultResearchIds(state.day);
  }
  return listed;
}

/** Research, staff, and unlock chips folded into modifiers for this lab. */
export function modifiersForLab(state: SimState, labId: LabId): TrainingModifiers {
  if (labId === state.playerLabId) {
    const unlocked = state.player.researchUnlocked;
    return aggregateModifiers(
      nodesForIds(unlocked),
      ranksForUnlocked(unlocked, state.player.researchRanks),
    );
  }
  const rival = state.rivals.find((candidate) => candidate.id === labId);
  if (!rival) return baselineModifiers();
  const unlocked = rivalUnlockIds(state, rival);
  return aggregateModifiers(nodesForIds(unlocked), ranksForUnlocked(unlocked, undefined));
}

export function hasUnlock(m: TrainingModifiers, u: TrainingUnlock): boolean {
  return m.unlocks.includes(u);
}

function formatTimes(value: number): string {
  const text = value.toFixed(2).replace(/\.?0+$/, "");
  return `×${text}`;
}

const MULT_LABELS: Record<MultKey, string> = {
  paramEfficiency: "Param efficiency",
  dataEfficiency: "Data efficiency",
  computeThroughput: "Throughput",
  stability: "σ",
  precisionPenaltyMult: "Precision penalty",
  postTrainEfficiency: "Post-train",
  syntheticQuality: "Synthetic",
  distillEfficiency: "Distill",
  serveEfficiency: "Serve",
  hostingDiscount: "Hosting",
  quantPenaltyMult: "Quant penalty",
  modalityBridge: "Modality",
};

const QUALITY_LABELS: Record<QualityKey, string> = {
  rlQuality: "RL quality",
  routerQuality: "Router quality",
  verifierStrength: "Verifier",
};

/** Human-readable chips for an aggregated modifier bag. */
export function describeModifiers(m: TrainingModifiers): string[] {
  const baseline = baselineModifiers();
  const lines: string[] = [];
  for (const key of MULT_KEYS) {
    if (Math.abs(m[key] - baseline[key]) < 1e-9) continue;
    lines.push(`${MULT_LABELS[key]} ${formatTimes(m[key])}`);
  }
  if (m.ceilingLift !== 0) {
    const lift = m.ceilingLift.toFixed(1).replace(/\.0$/, "");
    lines.push(`Ceiling +${lift}`);
  }
  for (const key of QUALITY_KEYS) {
    if (Math.abs(m[key] - baseline[key]) < 1e-9) continue;
    lines.push(`${QUALITY_LABELS[key]} ${m[key].toFixed(2)}`);
  }
  if (m.unlocks.length > 0) {
    lines.push(
      `Unlocks: ${m.unlocks.map((id) => TRAINING_UNLOCK_LABELS[id]).join(", ")}`,
    );
  }
  return lines;
}

/**
 * Research = X× compute headline:
 * paramEfficiency^(−1/α) · dataEfficiency^(−1/β) · computeThroughput.
 */
export function computeEquivalent(m: TrainingModifiers): number {
  const { alpha, beta } = TRAINING_V4.scaling;
  const param = Math.max(1e-6, m.paramEfficiency);
  const data = Math.max(1e-6, m.dataEfficiency);
  return param ** (-1 / alpha) * data ** (-1 / beta) * m.computeThroughput;
}
