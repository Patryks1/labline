import type {
  DataMix,
  ModelBackbone,
  ModelFamily,
  TrainMode,
  TrainingNumerics,
} from "../types";
import { ECONOMY } from "./economy";
import {
  trainingNumericsEconomicsProfile,
  type TrainingNumericsEconomicsProfile,
} from "./trainingPrecision";
import { activeBalanceTuning } from "./tuning";
import { MODEL_SYSTEMS_WORK_MULTIPLIER } from "./computeCalibration";

/** One petaflop-day is 10^15 FLOP/s for 86,400 seconds. */
export const FLOPS_PER_PF_DAY = 8.64e19;

/**
 * Simulation time compression. Training still scales from physical 6ND work,
 * but two real calendar days of cluster work resolve in one game day. This
 * keeps the physical model playable without making frontier runs a short
 * product-cycle decision.
 */
export const TRAINING_CALENDAR_COMPRESSION = 2;

/** Modern dense compute-optimal reference, not a minimum or a cost clamp. */
export const COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER = 20;

/**
 * Existing campaign recipes historically call 6 tokens/parameter "strong".
 * Keep that progression anchor explicit and separate from the physical 20N
 * reference so save pacing does not silently redefine compute-optimal work.
 */
export const GAMEPLAY_STRONG_TOKENS_PER_PARAMETER = 6;

export type TrainingFormulaVersion = 1 | 2;

export interface TrainingRunEstimate {
  computeParamsB: number;
  trainingTokensMTok: number;
  verificationTokensMTok: number;
  trainingPfDays: number;
  verificationPfDays: number;
  physicalPfDays: number;
  gamePfDays: number;
}

export interface TrainingEconomicsEstimate extends TrainingRunEstimate {
  targetPfDays: number;
  minCalendarDays: number;
  setupCost: number;
  dataCost: number;
  upfrontCash: number;
  cashBurnPerDay: number;
  precision: TrainingNumericsEconomicsProfile;
}

export function minimumTrainingCalendarDays(opts: {
  paramsB: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  mode?: TrainMode;
  trainingTokensMTok?: number;
  verificationTokensMTok?: number;
}): number {
  const paramsB = Math.max(0.001, opts.paramsB);
  if (paramsB >= 1_000) {
    // Trillion-scale runs stop being embarrassingly parallel. Optimizer-state
    // synchronization, checkpoint I/O and the input pipeline impose a real
    // active-day floor even when the player can throw extreme PF at the job.
    // Parameters and actual corpus volume each contribute half of the 100–150d
    // default band: a thin 1T recipe starts at 100d, while larger models trained
    // on a strong (6 tokens/parameter) corpus approach 150d.
    const scaleSignal = Math.max(
      0,
      Math.min(1, Math.log10(paramsB / 1_000) / Math.log10(30)),
    );
    const totalTokensMTok = Math.max(
      0,
      (opts.trainingTokensMTok ?? 0) + (opts.verificationTokensMTok ?? 0),
    );
    const tokensPerParameter = totalTokensMTok / (paramsB * 1_000);
    const dataSignal = Math.max(
      0,
      Math.min(1, tokensPerParameter / GAMEPLAY_STRONG_TOKENS_PER_PARAMETER),
    );
    return Math.round(100 + (50 * (scaleSignal + dataSignal)) / 2);
  }
  const scaleDays = 18 + 12 * Math.log10(paramsB);
  const familyMult =
    opts.family === "video"
      ? 1.3
      : opts.family === "omni"
        ? 1.2
        : opts.family === "diffusion"
          ? 1.12
          : opts.backbone === "moe" || opts.family === "moe"
            ? 1.08
            : 1;
  const modeMult =
    opts.mode === "continue" ? 0.65 : opts.mode === "distill" ? 0.8 : 1;
  return Math.ceil(
    Math.max(14, Math.min(100, scaleDays * familyMult * modeMult)),
  );
}

/**
 * Useful base-training PF that may be credited in one active day. A zero floor
 * keeps the historical PF-only behaviour used by sub-trillion jobs.
 */
export function pacedTrainingPfPerDay(
  targetPfDays: number,
  minCalendarDays?: number,
): number {
  const target = Math.max(0, targetPfDays);
  const days = Math.max(0, minCalendarDays ?? 0);
  return days > 0 ? target / days : Number.POSITIVE_INFINITY;
}

export interface FundedTrainingMaturity {
  /** PF spend relative to the originally recommended run. */
  fundedRatio: number;
  /** Additional spend beyond the original recommendation. */
  extraRatio: number;
  /** Bounded 0-1 signal with sharply diminishing returns. */
  extraSignal: number;
  /** Capability points earned from deliberately extending the run. */
  capabilityGain: number;
  /** Benchmark points earned from deliberately extending the run. */
  benchmarkGain: number;
  /** Reliability points earned from longer validation/integration. */
  reliabilityGain: number;
  /** Small extra ceiling headroom; training cannot substitute for a new architecture. */
  ceilingGain: number;
}

/**
 * Quality earned by funding a run past its original recommendation. The first
 * extra block matters, but repeated extensions asymptote quickly so players
 * cannot turn a fixed architecture into a new technology generation.
 */
export function fundedTrainingMaturity(opts: {
  progressPfDays: number;
  targetPfDays: number;
  recommendedPfDays?: number;
}): FundedTrainingMaturity {
  const recommendation = Math.max(
    1e-9,
    opts.recommendedPfDays ?? opts.targetPfDays,
  );
  const fundedRatio = Math.max(0, opts.progressPfDays) / recommendation;
  const extraRatio = Math.max(0, fundedRatio - 1);
  const extraSignal = 1 - Math.exp(-extraRatio / 0.75);
  return {
    fundedRatio,
    extraRatio,
    extraSignal,
    capabilityGain: 5.5 * extraSignal,
    benchmarkGain: 4.25 * extraSignal,
    reliabilityGain: 3 * extraSignal,
    ceilingGain: 4 * extraSignal,
  };
}

export const PARAM_PRESETS = [
  { label: "7M", paramsB: 0.007 },
  { label: "70M", paramsB: 0.07 },
  { label: "125M", paramsB: 0.125 },
  { label: "400M", paramsB: 0.4 },
  { label: "1B", paramsB: 1 },
  { label: "1.5B", paramsB: 1.5 },
  { label: "3B", paramsB: 3 },
  { label: "7B", paramsB: 7 },
  { label: "13B", paramsB: 13 },
  { label: "22B", paramsB: 22 },
  { label: "34B", paramsB: 34 },
  { label: "70B", paramsB: 70 },
  { label: "110B", paramsB: 110 },
  { label: "180B", paramsB: 180 },
  { label: "235B", paramsB: 235 },
  { label: "405B", paramsB: 405 },
  { label: "671B", paramsB: 671 },
  { label: "1T", paramsB: 1000 },
  { label: "1.8T", paramsB: 1800 },
  { label: "3T", paramsB: 3000 },
  { label: "5T", paramsB: 5000 },
  { label: "7T", paramsB: 7000 },
  { label: "10T", paramsB: 10_000 },
  { label: "13T", paramsB: 13_000 },
  { label: "20T", paramsB: 20_000 },
  { label: "30T", paramsB: 30_000 },
] as const;

export function formatParams(paramsB: number): string {
  if (paramsB >= 1000) return `${(paramsB / 1000).toFixed(2)}T`;
  if (paramsB >= 1) return `${paramsB.toFixed(2)}B`;
  if (paramsB >= 0.001) return `${(paramsB * 1000).toFixed(2)}M`;
  return `${(paramsB * 1e6).toFixed(2)}K`;
}

/** Legacy v1 dense curve retained solely for existing saves and replays. */
function legacyDensePfDays(paramsB: number): number {
  const n = Math.max(0.001, paramsB);
  // Flatter than real Chinchilla so frontier jobs stay playable.
  // Approx: 1B≈4, 7B≈22, 70B≈140, 405B≈520, 500B≈600, 1T≈1000 (then / trainEfficiency)
  return 3.9 * Math.pow(n, 0.76);
}

/**
 * MoE: total params drive most of train cost (all experts updated),
 * active params drive a smaller share (routing / critical path).
 */
function legacyMoePfDays(totalB: number, activeB: number): number {
  const t = Math.max(0.01, totalB);
  const a = Math.max(0.001, Math.min(activeB, t));
  const effective = a + (t - a) * 0.2;
  return legacyDensePfDays(effective) * 1.08;
}

/**
 * Approximate parameters participating in one MoE token's training work.
 * Active experts dominate FLOPs; inactive experts add routing, balancing and
 * communication overhead. Total parameters remain the basis for memory.
 */
export const DEFAULT_MOE_ACTIVE_PATH_OVERHEAD = 0.1;

export function moeTrainingComputeParamsB(
  totalB: number,
  activeB: number,
  overhead: number = DEFAULT_MOE_ACTIVE_PATH_OVERHEAD,
): number {
  const total = Math.max(0.001, totalB);
  const active = Math.max(0.001, Math.min(activeB, total));
  const boundedOverhead = Math.max(0.05, Math.min(0.2, overhead));
  return Math.min(total, active * (1 + boundedOverhead));
}

/** Exact dense-transformer training work C ≈ 6ND, expressed in PF-days. */
export function denseTrainingPfDays(
  paramsB: number,
  trainingTokensMTok: number,
): number {
  const parameters = Math.max(0, paramsB) * 1e9;
  const tokens = Math.max(0, trainingTokensMTok) * 1e6;
  return (6 * parameters * tokens) / FLOPS_PER_PF_DAY;
}

/** Training-token volume for a dense 20N reference run, in millions of tokens. */
export function computeOptimalTrainingTokensMTok(
  paramsB: number,
  tokensPerParameter = COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER,
): number {
  return Math.max(0, paramsB) * 1_000 * Math.max(0, tokensPerParameter);
}

/** Exact C ~= 6ND work at the modern dense tokens/parameter reference. */
export function computeOptimalDensePfDays(
  paramsB: number,
  tokensPerParameter = COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER,
): number {
  return denseTrainingPfDays(
    paramsB,
    computeOptimalTrainingTokensMTok(paramsB, tokensPerParameter),
  );
}

/** Evaluation/verification is forward-only to first order: C ≈ 2ND. */
export function verificationPfDays(
  paramsB: number,
  verifyTokensMTok: number,
): number {
  const parameters = Math.max(0, paramsB) * 1e9;
  const tokens = Math.max(0, verifyTokensMTok) * 1e6;
  return (2 * parameters * tokens) / FLOPS_PER_PF_DAY;
}

export const TRAINING_MODALITY_COST = {
  text: 1,
  code: 1,
  law: 1,
  health: 1,
  chat: 1,
  audio: 2,
  image: 4,
  video: 12,
} as const;

export function modalityComputeMultiplier(
  weights?: Partial<Record<string, number>>,
): number {
  if (!weights) return 1;
  let total = 0;
  let weighted = 0;
  for (const [domain, raw] of Object.entries(weights)) {
    const share = Math.max(0, raw ?? 0);
    total += share;
    weighted +=
      share *
      (TRAINING_MODALITY_COST[domain as keyof typeof TRAINING_MODALITY_COST] ??
        1);
  }
  return total > 0 ? weighted / total : 1;
}

/** Linear PF multiplier for chosen volume; unlike v1 this is intentionally uncapped. */
export function trainingVolumeMultiplier(dataRatio: number): number {
  return Math.max(0, dataRatio) / GAMEPLAY_STRONG_TOKENS_PER_PARAMETER;
}

function legacyTrainingVolumeMultiplier(dataRatio: number): number {
  return Math.max(
    0.25,
    Math.min(4, Math.max(0, dataRatio) / GAMEPLAY_STRONG_TOKENS_PER_PARAMETER),
  );
}

function familyArchitectureComputeMultiplier(family: ModelFamily): number {
  if (family === "video") return 2.4;
  if (family === "diffusion") return 1.25;
  if (family === "omni") return 1.45 * 1.35;
  return 1;
}

function distillationComputeMultiplier(
  paramsB: number,
  teacherParamsB?: number,
): number {
  const teacher = Math.max(teacherParamsB ?? paramsB * 2, paramsB);
  const ratio = Math.min(1, paramsB / Math.max(teacher, 0.01));
  return 0.14 + 0.08 * ratio;
}

function legacyTrainCostPfDays(opts: {
  paramsB: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  trainEfficiency: number;
  activeParamsB?: number;
  mode?: "pretrain" | "distill";
  teacherParamsB?: number;
  dataRatio?: number;
  modalityComputeMult?: number;
}): number {
  let base: number;
  if (
    opts.backbone === "moe" ||
    (opts.backbone == null && opts.family === "moe")
  ) {
    base = legacyMoePfDays(
      opts.paramsB,
      opts.activeParamsB ?? opts.paramsB * 0.1,
    );
  } else {
    base = legacyDensePfDays(opts.paramsB);
  }
  base *= familyArchitectureComputeMultiplier(opts.family);
  if (opts.mode === "distill") {
    base *= distillationComputeMultiplier(opts.paramsB, opts.teacherParamsB);
  }
  base *= legacyTrainingVolumeMultiplier(opts.dataRatio ?? 6);
  base *= Math.max(0.8, Math.min(12, opts.modalityComputeMult ?? 1));
  const eff = Math.max(0.25, opts.trainEfficiency);
  return base / eff;
}

export function trainCostPfDays(opts: {
  paramsB: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  trainEfficiency: number;
  activeParamsB?: number;
  mode?: "pretrain" | "distill";
  teacherParamsB?: number;
  /**
   * Actual quality-weighted tokens per total parameter. Unspecified legacy
   * previews retain the campaign's 6:1 progression anchor; new physical
   * comparisons should call computeOptimalDensePfDays (20N) explicitly.
   */
  dataRatio?: number;
  /** Actual training tokens. Takes precedence over dataRatio. */
  trainingTokensMTok?: number;
  /** Held-out forward-only tokens. */
  verificationTokensMTok?: number;
  modalityComputeMult?: number;
  /** Version 1 is only for grandfathered saves/replays. New work defaults to v2. */
  formulaVersion?: TrainingFormulaVersion;
}): number {
  if (opts.formulaVersion === 1) return legacyTrainCostPfDays(opts);

  return estimateTrainingRun(opts).gamePfDays;
}

/**
 * Pure physical-work forecast shared by the recipe UI and job creation. The
 * returned physical PF-days are never time-compressed; gamePfDays applies the
 * campaign compression and researched algorithmic efficiency exactly once.
 */
export function estimateTrainingRun(opts: {
  paramsB: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  trainEfficiency: number;
  activeParamsB?: number;
  mode?: "pretrain" | "distill";
  teacherParamsB?: number;
  dataRatio?: number;
  trainingTokensMTok?: number;
  verificationTokensMTok?: number;
  modalityComputeMult?: number;
}): TrainingRunEstimate {
  const computeParamsB =
    opts.backbone === "moe" || (opts.backbone == null && opts.family === "moe")
      ? moeTrainingComputeParamsB(
          opts.paramsB,
          opts.activeParamsB ?? opts.paramsB * 0.1,
        )
      : Math.max(0.001, opts.paramsB);
  const trainingTokensMTok =
    opts.trainingTokensMTok ??
    Math.max(0, opts.paramsB) *
      1000 *
      Math.max(0, opts.dataRatio ?? GAMEPLAY_STRONG_TOKENS_PER_PARAMETER);

  let trainingPfDays = denseTrainingPfDays(computeParamsB, trainingTokensMTok);
  let heldOutPfDays = verificationPfDays(
    computeParamsB,
    opts.verificationTokensMTok ?? 0,
  );
  const architectureMult = familyArchitectureComputeMultiplier(opts.family);
  const modalityMult = Math.max(
    0.8,
    Math.min(12, opts.modalityComputeMult ?? 1),
  );
  trainingPfDays *=
    architectureMult * modalityMult * MODEL_SYSTEMS_WORK_MULTIPLIER;
  heldOutPfDays *=
    architectureMult * modalityMult * MODEL_SYSTEMS_WORK_MULTIPLIER;
  if (opts.mode === "distill") {
    const distillMult = distillationComputeMultiplier(
      opts.paramsB,
      opts.teacherParamsB,
    );
    trainingPfDays *= distillMult;
    heldOutPfDays *= distillMult;
  }

  const efficiency = Math.max(0.05, opts.trainEfficiency);
  const physicalPfDays = trainingPfDays + heldOutPfDays;
  return {
    computeParamsB,
    trainingTokensMTok,
    verificationTokensMTok: opts.verificationTokensMTok ?? 0,
    trainingPfDays,
    verificationPfDays: heldOutPfDays,
    physicalPfDays,
    gamePfDays: physicalPfDays / TRAINING_CALENDAR_COMPRESSION / efficiency,
  };
}

/**
 * Shared player forecast/start economics. Physical work comes only from the
 * actual train and verification token counts; quality affects outcomes, not
 * the bill. Setup reserves cluster/orchestration capacity without prepaying a
 * second full PF-scaled training bill.
 */
export function estimateTrainingEconomics(opts: {
  paramsB: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  trainEfficiency: number;
  activeParamsB?: number;
  mode?: TrainMode;
  teacherParamsB?: number;
  distillTeacherShare?: number;
  trainingTokensMTok: number;
  verificationTokensMTok: number;
  modalityComputeMult?: number;
  trainCostMult?: number;
  dataCost?: number;
  numerics?: TrainingNumerics;
}): TrainingEconomicsEstimate {
  const precision = trainingNumericsEconomicsProfile(opts.numerics);
  const run = estimateTrainingRun({
    paramsB: opts.paramsB,
    family: opts.family,
    backbone: opts.backbone,
    trainEfficiency: opts.trainEfficiency,
    activeParamsB: opts.activeParamsB,
    mode: opts.mode === "distill" ? "distill" : "pretrain",
    teacherParamsB: opts.teacherParamsB,
    trainingTokensMTok: opts.trainingTokensMTok,
    verificationTokensMTok: opts.verificationTokensMTok,
    modalityComputeMult: opts.modalityComputeMult,
  });
  const modeMult =
    opts.mode === "continue"
      ? 0.55
      : opts.mode === "distill"
        ? 0.9 +
          (1 -
            Math.max(0.05, Math.min(0.95, opts.distillTeacherShare ?? 0.72))) *
            0.45
        : 1;
  const tuning = activeBalanceTuning();
  const costMult =
    modeMult *
    Math.max(0.05, opts.trainCostMult ?? 1) *
    precision.trainingWorkMultiplier *
    tuning.trainingWorkMult;
  const scale = (value: number) => value * costMult;
  const targetPfDays = scale(run.gamePfDays);
  const minCalendarDays =
    minimumTrainingCalendarDays(opts) * tuning.trainingCalendarMult;
  // Cluster reservation is intentionally 25× the legacy 0.08 baseline.
  const setupCost = Math.max(
    1_000,
    Math.floor(
      targetPfDays *
        ECONOMY.trainUpfrontPerPfDay *
        2 *
        precision.upfrontCashMultiplier,
    ),
  );
  const dataCost = Math.max(0, Math.floor(opts.dataCost ?? 0));
  const totalTokens = Math.max(
    0,
    opts.trainingTokensMTok + opts.verificationTokensMTok,
  );
  const cashBurnPerDay = Math.floor(
    ECONOMY.trainCashBurnPerPfDay *
      Math.sqrt(Math.max(1, opts.paramsB)) *
      (1 + Math.log10(Math.max(10, totalTokens)) * 0.08) *
      precision.dailyCashMultiplier *
      tuning.trainingCostMult,
  );
  return {
    ...run,
    trainingPfDays: scale(run.trainingPfDays),
    verificationPfDays: scale(run.verificationPfDays),
    physicalPfDays: scale(run.physicalPfDays),
    gamePfDays: targetPfDays,
    targetPfDays,
    minCalendarDays,
    setupCost,
    dataCost,
    upfrontCash: setupCost + dataCost,
    cashBurnPerDay,
    precision,
  };
}

/**
 * Target student intelligence as fraction of teacher when fully teacher-weighted.
 * Kept exported for existing callers; `distillRetentionFor` supersedes this flat
 * constant for new work (size-gap aware, modulated by data quality and RNG).
 */
export const DISTILL_RETENTION = 0.8;

/**
 * Size-gap distillation retention: how much teacher capability a student keeps.
 * 1T → 1B lands ≈ 0.35 (mid 30–40% band); modulated by data and RNG.
 */
export function distillRetentionFor(input: {
  teacherParamsB: number;
  studentParamsB: number;
  /** 0–1: effective data quality/coverage factor for the student run. */
  dataFactor: number;
  /** 0–1 deterministic RNG draw. */
  rng01: number;
}): number {
  const gap = Math.log10(
    Math.max(1, input.teacherParamsB) / Math.max(0.05, input.studentParamsB),
  );
  const base = 0.86 - 0.17 * gap;
  const data = (Math.max(0, Math.min(1, input.dataFactor)) - 0.5) * 0.12;
  const rng = (Math.max(0, Math.min(1, input.rng01)) - 0.5) * 0.12;
  const tuned =
    (base + data + rng) * activeBalanceTuning().distillRetentionMult;
  return Math.max(0.25, Math.min(0.88, tuned));
}

/** Clamp distill teacher-share (own corpus = 1 − share). */
export function clampDistillTeacherShare(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0.72;
  return Math.max(0.05, Math.min(0.95, n));
}

/**
 * Apply distillation quality from teacher signal.
 * Default retention ≈ 0.80 when fully teacher-weighted; lower if caller reduces it.
 * Pure helper — used by training finalize and unit tests.
 */
export function distillFromTeacher(opts: {
  teacherCapability: number;
  teacherBenchmarks: Record<string, number>;
  studentScaleCap: number;
  /** Target fraction of teacher (default DISTILL_RETENTION = 0.80) */
  targetRetention?: number;
}): {
  capability: number;
  retention: number;
  benchmarks: Record<string, number>;
} {
  // Floor relaxed 0.35 → 0.25 so the size-gap `distillRetentionFor` curve is not clipped.
  const retention = Math.max(
    0.25,
    Math.min(0.92, opts.targetRetention ?? DISTILL_RETENTION),
  );
  // Slight pull from student scale so tiny students cannot exceed ~80% of a giant teacher
  // while still staying in the 0.72–0.88 band for typical same-family distill.
  const scalePull = Math.min(
    1,
    Math.max(0.92, opts.studentScaleCap / Math.max(opts.teacherCapability, 1)),
  );
  const capability = Math.min(
    100,
    Math.max(1, opts.teacherCapability * retention * (0.96 + 0.04 * scalePull)),
  );
  const actualRetention = capability / Math.max(opts.teacherCapability, 1e-6);
  const benchmarks: Record<string, number> = {};
  for (const [k, v] of Object.entries(opts.teacherBenchmarks)) {
    benchmarks[k] = Math.min(
      100,
      Math.max(0, v * retention * (0.97 + 0.03 * scalePull)),
    );
  }
  return { capability, retention: actualRetention, benchmarks };
}

/** Data mix modifiers applied at model finalize. */
export const DATA_MIX_DEFS: Record<
  DataMix,
  {
    label: string;
    blurb: string;
    coding: number;
    math: number;
    chat: number;
    safety: number;
    capability: number;
  }
> = {
  web: {
    label: "Web crawl",
    blurb: "Broad internet mix. Balanced, cheap.",
    coding: 0,
    math: 0,
    chat: 1,
    safety: -1,
    capability: 0,
  },
  code: {
    label: "Code-heavy",
    blurb: "Repos, issues, docs. Strong coding benches.",
    coding: 8,
    math: 2,
    chat: -2,
    safety: 0,
    capability: 1,
  },
  math: {
    label: "STEM / math",
    blurb: "Papers + problem sets. Reasoning & science.",
    coding: 2,
    math: 9,
    chat: -1,
    safety: 1,
    capability: 2,
  },
  curated: {
    label: "Curated HQ",
    blurb: "Human-filtered. Costly, safer, stickier chat.",
    coding: 3,
    math: 3,
    chat: 5,
    safety: 6,
    capability: 3,
  },
  synthetic: {
    label: "Synthetic",
    blurb: "Model-generated. Fast & cheap; weaker long-tail.",
    coding: 1,
    math: 1,
    chat: 0,
    safety: -2,
    capability: -1,
  },
};

export { suggestedApiPricePerMTok, suggestApiInOut } from "./pricing";

/**
 * Soft guidance: racks (or chip-equivalents) for healthy train ETA.
 * Tuned to hall-scale fleets (tens–low thousands), not real datacenter counts.
 */
export function recommendedChips(paramsB: number, family: ModelFamily): number {
  const n = family === "moe" ? paramsB * 0.55 : paramsB;
  if (n < 1) return 12;
  if (n < 7) return 48;
  if (n < 30) return 96;
  if (n < 80) return 160;
  if (n < 200) return 220;
  if (n < 500) return 280;
  if (n < 900) return 400;
  return 600;
}

export function recommendedRacks(paramsB: number, family: ModelFamily): number {
  return recommendedChips(paramsB, family);
}

/**
 * Soft validation only — **no research size caps**.
 * Scale is limited by train PF-days, VRAM, power, and inference capacity.
 * Family unlocks (MoE / multimodal) are checked separately in startTraining.
 */
export function sizeGate(
  paramsB: number,
  _family?: ModelFamily,
  _unlocked?: string[],
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(paramsB) || paramsB < 0.001) {
    return { ok: false, reason: "Minimum size is 1M parameters." };
  }
  return { ok: true };
}

/** @deprecated size no longer research-gated; kept for callers */
export function moeActiveGate(
  _activeParamsB: number,
  _unlocked: string[],
): { ok: boolean; reason?: string } {
  return { ok: true };
}

export function estimateTrainDays(pfDays: number, trainPoolPf: number): number {
  if (trainPoolPf <= 0.001) return Infinity;
  return Math.ceil(pfDays / trainPoolPf);
}
