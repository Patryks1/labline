import type { CapabilityDomain, DataDomain, ModelCapabilities, ModelIOModality } from "../types";
import { TRAINING_V4 } from "./constants";
import type { Architecture, LossBreakdown, TrainingModifiers } from "./types";

/** Forced gap when D_eff is missing or non-positive. */
const HUGE_GAP = 6;

const DOMAIN_KEYS: readonly CapabilityDomain[] = [
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "vision",
  "video",
  "audio",
  "tools",
];

const CORE_OVERALL_WEIGHT: Record<
  Exclude<CapabilityDomain, "vision" | "audio" | "video">,
  number
> = {
  language: 0.25,
  reasoning: 0.2,
  code: 0.15,
  math: 0.1,
  science: 0.1,
  tools: 0.1,
};

const MODALITY_OVERALL_BUDGET = 0.1;
const MODALITY_DOMAINS: readonly CapabilityDomain[] = ["vision", "audio", "video"];

const SPECIALIST_PRESETS = new Set(["audio", "image_generation", "video_generation"]);

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function paramsPerBillion(): number {
  return TRAINING_V4.compute.paramsPerBillion;
}

function mixShare(dataMix: Partial<Record<DataDomain, number>>, domain: DataDomain): number {
  let total = 0;
  let value = 0;
  for (const [key, raw] of Object.entries(dataMix)) {
    if (typeof raw !== "number" || !(raw > 0)) continue;
    total += raw;
    if (key === domain) value = raw;
  }
  return total > 0 ? value / total : 0;
}

function hasModality(arch: Architecture, modality: ModelIOModality): boolean {
  return arch.inputs.includes(modality) || arch.outputs.includes(modality);
}

/** Effective parameter count N_eff (raw params, not billions). Dense = N_total; MoE uses the nEffExponent mix. */
export function effectiveParams(arch: Architecture): number {
  const total = Math.max(0, arch.totalParamsB) * paramsPerBillion();
  if (arch.backbone !== "moe") return total;
  const active = Math.max(0, Math.min(arch.activeParamsB, arch.totalParamsB)) * paramsPerBillion();
  if (!(active > 0) || !(total > 0)) return 0;
  return active * (total / active) ** TRAINING_V4.moe.nEffExponent;
}

/**
 * Kaplan-style L(N_eff, D_eff) plus precision penalty → gap.
 *
 * `effectiveTokens` is RAW token count D (not millions). The data bridge already
 * folds MoE's ×1.2 unique-data demand into D_eff; this function does not apply
 * it again.
 */
export function lossFor(
  arch: Architecture,
  effectiveTokens: number,
  modifiers: TrainingModifiers,
): LossBreakdown {
  const { E, A, B, alpha, beta } = TRAINING_V4.scaling;
  const nEff = effectiveParams(arch);
  const dEff = effectiveTokens;
  const precisionPenalty =
    TRAINING_V4.precision.penalty[arch.precision] * modifiers.precisionPenaltyMult;

  if (!(dEff > 0)) {
    const paramTerm =
      nEff > 0 ? (A * modifiers.paramEfficiency) / nEff ** alpha : HUGE_GAP;
    return {
      nEff,
      dEff: Math.max(0, dEff),
      paramTerm,
      dataTerm: HUGE_GAP,
      loss: E + paramTerm + HUGE_GAP,
      precisionPenalty,
      gap: HUGE_GAP,
    };
  }

  const paramTerm = nEff > 0 ? (A * modifiers.paramEfficiency) / nEff ** alpha : HUGE_GAP;
  const dataTerm = (B * modifiers.dataEfficiency) / dEff ** beta;
  const loss = E + paramTerm + dataTerm;
  const gap = Math.max(0, loss - E + precisionPenalty);
  return { nEff, dEff, paramTerm, dataTerm, loss, precisionPenalty, gap };
}

/** `100 · exp(−capK · gap)` then min(archCeiling). */
export function capabilityFromGap(
  gap: number,
  arch: Architecture,
  modifiers: TrainingModifiers,
): number {
  const raw = 100 * Math.exp(-TRAINING_V4.scaling.capK * Math.max(0, gap));
  return Math.min(raw, archCeiling(arch, modifiers));
}

/**
 * Dense / MoE / specialist / omni / omni-verified wall plus `ceilingLift`.
 *
 * Verified omni (97) requires the omni preset, unlock `"verifier"`, and
 * `modalityBridge >= 1.2`. CeilingLift is additive; the result never exceeds 100.
 */
export function archCeiling(arch: Architecture, modifiers: TrainingModifiers): number {
  let wall: number;
  if (arch.preset === "omni") {
    const verified =
      modifiers.unlocks.includes("verifier") && modifiers.modalityBridge >= 1.2;
    wall = verified ? TRAINING_V4.ceilings.omniVerified : TRAINING_V4.ceilings.omni;
  } else if (SPECIALIST_PRESETS.has(arch.preset)) {
    wall = TRAINING_V4.ceilings.specialist;
  } else if (arch.backbone === "moe") {
    wall = TRAINING_V4.ceilings.moe;
  } else {
    wall = TRAINING_V4.ceilings.dense;
  }
  return clamp(wall + modifiers.ceilingLift, 0, 100);
}

/** Domain vector from a scalar capability, architecture, and data mix. */
export function domainVectorFor(
  capability: number,
  arch: Architecture,
  dataMix: Partial<Record<DataDomain, number>>,
  modifiers: TrainingModifiers,
): ModelCapabilities {
  const ceiling = archCeiling(arch, modifiers);
  const cap = clamp(capability, 0, ceiling);
  const codeShare = mixShare(dataMix, "code");
  const mathShare = mixShare(dataMix, "math");
  const scienceShare = mixShare(dataMix, "science");
  const stemShare = codeShare + mathShare + scienceShare;
  const bridge = modifiers.modalityBridge;

  const affinity = (share: number) => 0.6 + 0.4 * Math.min(1, share / 0.15);
  const modalityScore = (enabled: boolean, share: number) => {
    if (!enabled) return 0;
    return cap * (0.5 + 0.5 * Math.min(1, share / 0.2)) * bridge;
  };

  const domains: Record<CapabilityDomain, number> = {
    language: cap,
    code: cap * affinity(codeShare),
    math: cap * affinity(mathShare),
    science: cap * affinity(scienceShare),
    reasoning: cap * (0.55 + 0.45 * Math.min(1, stemShare / 0.25)),
    vision: modalityScore(hasModality(arch, "image"), mixShare(dataMix, "image")),
    audio: modalityScore(hasModality(arch, "audio"), mixShare(dataMix, "audio")),
    video: modalityScore(hasModality(arch, "video"), mixShare(dataMix, "video")),
    tools: 0.5 * cap,
  };

  for (const key of DOMAIN_KEYS) {
    domains[key] = clamp(domains[key]!, 0, ceiling);
  }

  return {
    domains,
    factuality: clamp(0.9 * cap, 0, 100),
    robustness: clamp(0.85 * cap, 0, 100),
    steerability: clamp(0.55 * cap, 0, 100),
    safety: clamp(35 + 0.3 * cap, 0, 100),
    reliability: clamp(0.85 * cap, 0, 100),
  };
}

/**
 * Distill student gap: max(g_teacher + gapMargin, ownGapFloor · g_own / distillEfficiency).
 *
 * `distillEfficiency > 1` lowers the own-gap floor (student can get closer to
 * the teacher+margin wall). May cross the size floor, never the arch wall.
 */
export function distillGap(
  teacherGap: number,
  ownGap: number,
  modifiers: TrainingModifiers,
): number {
  const { gapMargin, ownGapFloor } = TRAINING_V4.distill;
  const efficiency = Math.max(1e-9, modifiers.distillEfficiency);
  const teacherFloor = teacherGap + gapMargin;
  const ownFloor = (ownGapFloor * ownGap) / efficiency;
  return Math.max(teacherFloor, ownFloor);
}

/**
 * Single 0–100 headline number for a capability vector: weighted mean over
 * supported domains (zero-valued modality domains are excluded). Used for
 * teacher-gap inversion, valuations, leaderboards and card headlines.
 */
export function overallCapability(truth: ModelCapabilities): number {
  let weighted = 0;
  let weight = 0;
  for (const [domain, w] of Object.entries(CORE_OVERALL_WEIGHT) as Array<
    [keyof typeof CORE_OVERALL_WEIGHT, number]
  >) {
    weighted += truth.domains[domain] * w;
    weight += w;
  }
  const liveModalities = MODALITY_DOMAINS.filter((domain) => truth.domains[domain] > 0);
  if (liveModalities.length > 0) {
    const each = MODALITY_OVERALL_BUDGET / liveModalities.length;
    for (const domain of liveModalities) {
      weighted += truth.domains[domain] * each;
      weight += each;
    }
  }
  return weight > 0 ? weighted / weight : 0;
}

/** Inverse of `capabilityFromGap` before ceilings: g = −ln(cap/100) / capK. */
export function gapFromCapability(capability: number): number {
  const cap = clamp(capability, 0.5, 99.9);
  return -Math.log(cap / 100) / TRAINING_V4.scaling.capK;
}
