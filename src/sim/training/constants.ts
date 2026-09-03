import type { CapabilityDomain, ModelProductPreset } from "../types";
import type {
  ArchFamily,
  PostTrainStageKind,
  TierBudget,
  TrainPrecision,
  TrainingUnlock,
} from "./types";

/**
 * Kaplan-style irreducible loss, parameter term, data term, and the
 * capability-from-gap exponent. N is raw parameter count (not billions);
 * D is token count.
 */
const SCALING = {
  E: 1.69,
  A: 406.4,
  B: 410.7,
  alpha: 0.34,
  beta: 0.28,
  capK: 1.45,
} as const;

/** MoE effective-parameter exponent and extra unique-data demand. */
const MOE = {
  nEffExponent: 0.35,
  dataRequirementMult: 1.2,
} as const;

/** Hard capability walls after `100 · exp(−capK · g)`, plus research `ceilingLift`. */
const CEILINGS = {
  dense: 82,
  moe: 89,
  specialist: 90,
  omni: 94,
  omniVerified: 97,
} as const;

/**
 * Bytes per parameter including optimizer state (Adam-style moments + weights).
 * Used only for train HBM residency, not serving.
 */
const TRAIN_BYTES_PER_PARAM: Record<TrainPrecision, number> = {
  fp32: 16,
  fp16_mixed: 12,
  bf16_mixed: 12,
  fp8_hybrid: 8,
  fp6: 7,
  nvfp4: 6,
};

const PRECISION_THROUGHPUT: Record<TrainPrecision, number> = {
  fp32: 0.5,
  fp16_mixed: 0.9,
  bf16_mixed: 1.0,
  fp8_hybrid: 1.8,
  fp6: 2.2,
  nvfp4: 2.7,
};

/** Added to Kaplan gap. BF16 stays 0 so era-0 calibration bands still hold. */
const PRECISION_PENALTY: Record<TrainPrecision, number> = {
  fp32: -0.01,
  fp16_mixed: 0.025,
  bf16_mixed: 0,
  fp8_hybrid: 0.07,
  fp6: 0.11,
  nvfp4: 0.16,
};

const PRECISION_SIGMA_MULT: Record<TrainPrecision, number> = {
  fp32: 0.85,
  fp16_mixed: 1.18,
  bf16_mixed: 1,
  fp8_hybrid: 1.35,
  fp6: 1.55,
  nvfp4: 1.8,
};

/** Context window stops in thousands of tokens. Default / always-free is 4k. */
export const CONTEXT_STOPS = [4, 8, 16, 32, 128, 256, 500, 1024, 10240, 102400] as const;

export const CONTEXT_UNLOCK_BANDS: ReadonlyArray<{
  maxK: number;
  unlock: TrainingUnlock | null;
}> = [
  { maxK: 4, unlock: null },
  { maxK: 32, unlock: "context_32k" },
  { maxK: 256, unlock: "long_context" },
  { maxK: 1024, unlock: "context_1m" },
  { maxK: 10240, unlock: "context_10m" },
  { maxK: 102400, unlock: "context_100m" },
];

const CONTEXT = {
  baseK: 4,
  trainCostExp: 0.18,
  trainHbmExp: 0.12,
  serveCostExp: 0.12,
  stops: CONTEXT_STOPS,
  unlocks: CONTEXT_UNLOCK_BANDS,
} as const;

/** Calendar-day floor vs cluster throughput: clamp(scale · (N_total_B / 7)^exp, min, max). */
const PACE_FLOOR = {
  scale: 8,
  exponent: 0.3,
  minDays: 3,
  maxDays: 120,
  referenceParamsB: 7,
} as const;

const ARCH_COST: Record<ArchFamily, number> = {
  dense: 1,
  moe: 1.1,
};

const MODALITY_COST: Record<ModelProductPreset, number> = {
  language: 1,
  vision_language: 1.25,
  audio: 1.15,
  image_generation: 1.3,
  video_generation: 1.8,
  omni: 2.2,
};

/** Distill: student gap vs teacher, own scaling-law gap, and compute discount. */
const DISTILL = {
  gapMargin: 0.05,
  ownGapFloor: 0.6,
  computeMult: 0.2,
} as const;

/** Outcome noise: g_actual = g_forecast · (1+ε), ε ~ N(0, σ) clamped ±clampSigmas. */
const RNG = {
  sigmaBase: 0.06,
  clampSigmas: 2.5,
  catastrophicMax: 0.02,
  moeUntested: 1.25,
  scaleJump: 0.15,
} as const;

const INCIDENTS = {
  autoResolveDays: 5,
  maxPerRun: 2,
} as const;

/** PF-days at 7B active; scaled by (N_active_B / 7)^sizeExponent · dataScale(tokens). */
const POST_TRAIN = {
  sizeExponent: 0.75,
  referenceParamsB: 7,
  baseStagePfDays: {
    instruct: 3,
    preference: 5,
    reasoning: 12,
    agentic: 8,
  } satisfies Record<PostTrainStageKind, number>,
  tierBudgets: [1, 2, 4, 8, 12, 20, 100] as const satisfies readonly TierBudget[],
  tierLiftK: 4,
  maxLiftCore: 12,
  maxLiftDefault: 4,
} as const;

const MAX_LIFT_BY_DOMAIN: Record<CapabilityDomain, number> = {
  language: POST_TRAIN.maxLiftDefault,
  reasoning: POST_TRAIN.maxLiftCore,
  code: POST_TRAIN.maxLiftCore,
  math: POST_TRAIN.maxLiftCore,
  science: POST_TRAIN.maxLiftCore,
  vision: POST_TRAIN.maxLiftDefault,
  video: POST_TRAIN.maxLiftDefault,
  audio: POST_TRAIN.maxLiftDefault,
  tools: POST_TRAIN.maxLiftDefault,
};

const EVALS = {
  quick: { cash: 0, days: 1, sigma: 4, leakRisk: 0 },
  suite: {
    cashMin: 50_000,
    cashMax: 150_000,
    daysMin: 2,
    daysMax: 5,
    sigmaStart: 2.5,
    sigmaEnd: 1.5,
    leakRisk: 0,
  },
  audit: { cash: 400_000, days: 7, sigma: 1, leakRisk: 0.1 },
} as const;

/** Campus ladder 0–3. Values are the V4 contract table for workstream C. */
const GYMS = {
  tiers: [
    { tier: 0, quality: 0, tasksPerDay: 12, upgradeCash: 5_000_000, upgradeDays: 7 },
    { tier: 1, quality: 0.45, tasksPerDay: 40, upgradeCash: 20_000_000, upgradeDays: 14 },
    { tier: 2, quality: 0.7, tasksPerDay: 120, upgradeCash: 80_000_000, upgradeDays: 21 },
    { tier: 3, quality: 0.92, tasksPerDay: 320, upgradeCash: 0, upgradeDays: 0 },
  ],
} as const;

const ENDPOINTS = {
  misrouteBase: 0.06,
  cascadeEscalation: 0.04,
  sunsetDrainDays: 30,
  /** Hosted API/plan demand retained after the player open-sources weights. */
  openWeightsHostedDemandMult: 0.88,
  /** Plan attractiveness retained when the plan's best model is open-weight. */
  openWeightsPlanAttractMult: 0.92,
} as const;

export const OPEN_WEIGHTS_HOSTED_DEMAND_MULT = ENDPOINTS.openWeightsHostedDemandMult;
export const OPEN_WEIGHTS_PLAN_ATTRACT_MULT = ENDPOINTS.openWeightsPlanAttractMult;

const MERGE = {
  bonus: 1.5,
  regressionRisk: 0.15,
} as const;

/**
 * Era-0 dense bf16, 20 tokens/param, no research. Capability scores the
 * workstream-A implementation must hit within `tolerance`.
 */
export const CALIBRATION_BANDS = [
  { paramsB: 0.07, tokensPerParam: 20, expected: 6, tolerance: 1.5 },
  { paramsB: 1, tokensPerParam: 20, expected: 26, tolerance: 2 },
  { paramsB: 7, tokensPerParam: 20, expected: 48, tolerance: 2 },
  { paramsB: 70, tokensPerParam: 20, expected: 69, tolerance: 2 },
  { paramsB: 400, tokensPerParam: 20, expected: 80, tolerance: 2 },
  { paramsB: 1000, tokensPerParam: 20, expected: 82, tolerance: 1 },
  { paramsB: 70, tokensPerParam: 1, expected: 50, tolerance: 3 },
] as const;

export const TRAINING_V4 = {
  /** 6ND FLOPs; 1 PF-day = 10^15 FLOP/s × 86400 s. */
  compute: {
    flopFactor: 6,
    flopsPerPfDay: 8.64e19,
    paramsPerBillion: 1e9,
    holdoutMultiplier: 2,
  },
  scaling: SCALING,
  moe: MOE,
  ceilings: CEILINGS,
  precision: {
    throughput: PRECISION_THROUGHPUT,
    penalty: PRECISION_PENALTY,
    sigmaMult: PRECISION_SIGMA_MULT,
    trainBytesPerParam: TRAIN_BYTES_PER_PARAM,
  },
  context: CONTEXT,
  /** epochFactor(epochs) = 1 + epochLog2Coef · log2(epochs) on unique tokens. */
  data: {
    epochLog2Coef: 0.55,
    tokensPerParamOptimal: 20,
  },
  paceFloor: PACE_FLOOR,
  archCost: ARCH_COST,
  modalityCost: MODALITY_COST,
  distill: DISTILL,
  rng: RNG,
  incidents: INCIDENTS,
  postTrain: POST_TRAIN,
  maxLiftByDomain: MAX_LIFT_BY_DOMAIN,
  evals: EVALS,
  gyms: GYMS,
  endpoints: ENDPOINTS,
  merge: MERGE,
  calibrationBands: CALIBRATION_BANDS,
} as const;
