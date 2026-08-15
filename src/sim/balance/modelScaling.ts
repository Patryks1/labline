/**
 * Shared intelligence scaling: parameter size × data volume × data quality × mix.
 * Used by player training finalize AND rivals so everyone plays by the same rules.
 *
 * Design goals:
 * - Early sub-1B models land ~5–10 capability (millions-era, not mid-pack)
 * - ~7B with a good early recipe is teens–mid-20s; ~70B is mid-pack (~45–65)
 * - Late research + reasoning + overtrain lets tiny models punch up to ~35
 * - Multi-hundred-B / T-scale + great data + research approaches ceiling
 * - Wrong mix (all code / no chat) hurts general benches; helps specialists
 * - Under-trained big models stay dumb (data is a real gate)
 */
import type {
  BenchmarkId,
  BenchmarkScores,
  ModelBackbone,
  ModelFamily,
  QualityAxes,
} from "../types";
import {
  applyBenchmarkPolicy,
  inferReasoningEnabled,
} from "./evaluationSuites";
import { activeBalanceTuning } from "./tuning";
// training.ts does not import modelScaling (verified: it pulls only types,
// economy, trainingPrecision, and a pricing re-export), so this is acyclic.
import {
  COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER,
  distillRetentionFor,
  GAMEPLAY_STRONG_TOKENS_PER_PARAMETER,
} from "./training";
import {
  architectureAdjustedDataCoverage,
  architectureBlueprintId,
  architecturePretrainingCapabilityCap,
  type ArchitectureBlueprintId,
} from "./architectureFrontiers";

function emptyBenchmarks(): BenchmarkScores {
  return {
    mmlu: 0,
    coding: 0,
    math: 0,
    vision: 0,
    law: 0,
    health: 0,
    science: 0,
    multilingual: 0,
    agents: 0,
    safety: 0,
  };
}

/** Capability / bench score bounds (game units 0–100). */
export const SCALE = {
  /** Low floor so early millions-param models can score ~5–10 TOPS. */
  CAP_FLOOR: 3,
  CAP_CEIL: 94,
  /** Soft asymptotic bench ceiling even with perfect setup */
  BENCH_HARD_CEIL: 96,
} as const;

/**
 * Compute-intensity (overtrain) headroom. Early game is tight; research raises
 * the hard cap so long runs on smaller models can punch above size late-game.
 */
export const OVERTRAIN = {
  /** Campaign progression anchor retained for existing balance/save pacing. */
  STRONG_COVERAGE: GAMEPLAY_STRONG_TOKENS_PER_PARAMETER,
  /** Physical dense compute-optimal reference used by modern comparisons. */
  COMPUTE_OPTIMAL_COVERAGE: COMPUTE_OPTIMAL_TOKENS_PER_PARAMETER,
  /** Capability points available from overtrain with no research unlocks. */
  BASE_CAP: 1.5,
  /** Absolute ceiling on overtrain contribution (with full research). */
  MAX_CAP: 8,
  /** Diminishing-returns scale for coverage beyond STRONG_COVERAGE. */
  INTENSITY_SCALE: 9,
  /** Absolute capability points per unit of (researchMult - 1). */
  RESEARCH_RAW_WEIGHT: 100,
  /** Absolute capability points from process-reward / reasoning stack. */
  REASONING_RAW: 8,
  /** Ceiling technology weight on (researchMult - 1); was 24. */
  RESEARCH_CEILING_WEIGHT: 48,
  /** Ceiling technology points from reasoning; was 4. */
  REASONING_CEILING: 8,
} as const;

/** Bend capability past ~52 so high-end gains cost progressively more scale. */
export function progressionBend(capability: number, steepness: number): number {
  if (!(steepness > 0) || capability <= 52) return capability;
  return 52 + (capability - 52) / (1 + ((capability - 52) / 42) * steepness);
}

/**
 * Capability ceiling with the active progression bend applied. Precision
 * quality caps multiply this so lower-precision formats keep a strict
 * ordering even deep in the bent region.
 */
export function bentCapabilityCeiling(rawCeiling: number): number {
  return progressionBend(
    rawCeiling,
    activeBalanceTuning().progressionSteepness,
  );
}

export interface ScaleInputs {
  paramsB: number;
  activeParamsB?: number;
  family?: ModelFamily;
  /** Compute topology; product family remains authoritative for benchmark policy. */
  backbone?: ModelBackbone;
  /** Quality-weighted training tokens per total parameter (1, 6, 20, ...). */
  dataCoverage: number;
  /**
   * Data quality multiplier.
   * Player lab `dataQuality` is ~1.0 baseline; job qualityUsed is 0–100.
   * Pass a 0–1.4-ish effective quality (see `normalizeDataQuality`).
   */
  dataQuality: number;
  /**
   * Domain mix weights (should sum ~1). Empty → neutral balanced prior.
   */
  mixWeights?: Partial<Record<string, number>>;
  /** Research soft multiplier (1 = none, up to ~1.12) */
  researchMult?: number;
  /** Train completion 0–1 */
  trainComplete?: number;
  /** Post-train stage strength 0–1 */
  postTrainStrength?: number;
  /** Process-reward/reasoning stack is an earned route to more general headroom. */
  reasoningEnabled?: boolean;
  /**
   * Research-unlocked overtrain headroom (capability points beyond BASE_CAP).
   * Aggregated from `overtrainCapBonus` research effects; optional for old saves.
   */
  overtrainCapBonus?: number;
  /** Distillation may transfer capability that the student could not pretrain alone. */
  teacherCapability?: number;
  /**
   * Teacher size in billions of parameters. With `teacherCapability`, enables
   * the size-gap-aware distill ceiling via `distillRetentionFor`; without it
   * the ceiling falls back to the legacy flat 0.88 retention.
   */
  teacherParamsB?: number;
  /**
   * Independently verified capability retained from completed recursive
   * research loops. Only omni blueprints can use it, and the blueprint helper
   * bounds the gain. A research unlock by itself must not populate this value.
   */
  verifiedRecursiveCapabilityBonus?: number;
}

export interface ScaleResult {
  /** 0–1 size potential alone */
  paramPotential: number;
  /** 0–1.15 data volume × quality fit */
  dataFit: number;
  /** Coverage after the architecture's data-breadth demand; input remains raw. */
  architectureDataCoverage: number;
  /** 0.7–1.05 generalist mix efficiency */
  mixGeneral: number;
  /** Domain specialty 0–1 boosts */
  domainBoost: Record<string, number>;
  /** Combined 0–1 intelligence index before map to capability */
  intelligence: number;
  /** Earned overtrain / compute-intensity contribution (0..cap). */
  overtrain: number;
  /** Absolute research + reasoning + overtrain lift applied to raw capability. */
  techRawBonus: number;
  /** 0–100 capability score */
  capability: number;
  /** Enforced general-capability ceiling for this recipe. */
  capabilityCeiling: number;
  /** Per-benchmark soft ceilings given this scale (before research spikes) */
  benchCeilings: BenchmarkScores;
}

export interface CapabilityCeilingResult {
  capability: number;
  sizeBase: number;
  dataBonus: number;
  technologyBonus: number;
  distillationBonus: number;
  architectureBlueprint: ArchitectureBlueprintId;
  /** Gameplay blueprint wall applied to pretraining before teacher transfer. */
  blueprintCap: number;
  limitingFactor:
    | "parameters"
    | "data quality"
    | "technology"
    | "architecture blueprint"
    | "teacher";
}

/**
 * Hard general-capability headroom. Domain specialization is intentionally
 * excluded: a narrow corpus can win its benchmarks, but does not become free
 * general intelligence. This function is shared by player and rival builds.
 */
/** Hard cap on overtrain points; research raises this from BASE_CAP toward MAX_CAP. */
export function overtrainCap(overtrainCapBonus = 0): number {
  return Math.min(
    OVERTRAIN.MAX_CAP,
    OVERTRAIN.BASE_CAP + Math.max(0, overtrainCapBonus),
  );
}

/**
 * Diminishing compute-intensity score from the campaign's 6:1 progression
 * anchor. This is a gameplay bonus, not a claim that 6N is compute-optimal;
 * the physical reference is COMPUTE_OPTIMAL_COVERAGE (20N).
 * Returns earned capability points in [0, overtrainCap].
 */
export function overtrainBonus(
  dataCoverage: number,
  overtrainCapBonus = 0,
): number {
  const excess = Math.max(0, dataCoverage - OVERTRAIN.STRONG_COVERAGE);
  const intensity = 1 - Math.exp(-excess / OVERTRAIN.INTENSITY_SCALE);
  return intensity * overtrainCap(overtrainCapBonus);
}

export function capabilityCeiling(input: ScaleInputs): CapabilityCeilingResult {
  const architectureBlueprint = architectureBlueprintId(input);
  const blueprintCap = architecturePretrainingCapabilityCap(input);
  const architectureDataCoverage = architectureAdjustedDataCoverage(input);
  const potential = paramScalePotential(
    input.paramsB,
    input.activeParamsB,
    input.family,
    input.backbone,
  );
  // Early tiny ceilings sit near ~8–12 so the raw score leads, not the cap.
  const sizeBase = 4 + potential * 84;
  const quality = Math.max(0.3, Math.min(1.4, input.dataQuality));
  // Data remains meaningful but secondary to technology headroom.
  const qualityBonus = Math.max(0, quality - 0.92) * 12;
  const volumeBonus = Math.max(
    0,
    Math.min(3.2, Math.log2(Math.max(1, architectureDataCoverage)) * 1.05),
  );
  const dataBonus = qualityBonus + volumeBonus;
  const research = Math.max(0.9, Math.min(1.14, input.researchMult ?? 1));
  const unlockedOvertrain = overtrainCap(input.overtrainCapBonus ?? 0);
  const technologyBonus =
    Math.max(0, research - 1) * OVERTRAIN.RESEARCH_CEILING_WEIGHT +
    (input.reasoningEnabled ? OVERTRAIN.REASONING_CEILING : 0) +
    unlockedOvertrain;
  const uncappedPretrainedCeiling = Math.min(
    97,
    sizeBase + dataBonus + technologyBonus,
  );
  // Gameplay architecture wall: ordinary scale, data, and research can reach
  // this cap but cannot cross it. Teacher transfer is intentionally evaluated
  // after this line, so distillation remains a distinct way past the wall.
  const pretrainedCeiling = Math.min(blueprintCap, uncappedPretrainedCeiling);
  // Size-gap-aware retention when the teacher size is known (a slightly
  // generous +0.1 planning estimate, capped); flat 0.88 fallback otherwise.
  const teacherRetention =
    input.teacherCapability != null && input.teacherParamsB != null
      ? Math.min(
          0.88,
          distillRetentionFor({
            teacherParamsB: input.teacherParamsB,
            studentParamsB: input.paramsB,
            dataFactor: 0.6,
            rng01: 0.5,
          }) + 0.1,
        )
      : 0.88;
  const teacherTarget =
    Math.max(0, input.teacherCapability ?? 0) * teacherRetention;
  const distillationBonus = Math.max(0, teacherTarget - pretrainedCeiling);
  const capability = Math.min(97, pretrainedCeiling + distillationBonus);
  const limitingFactor =
    distillationBonus > 0
      ? "teacher"
      : uncappedPretrainedCeiling > blueprintCap
        ? "architecture blueprint"
        : quality < 1.08
          ? "data quality"
          : technologyBonus < 2
            ? "technology"
            : "parameters";
  return {
    capability,
    sizeBase,
    dataBonus,
    technologyBonus,
    distillationBonus,
    architectureBlueprint,
    blueprintCap,
    limitingFactor,
  };
}

/**
 * Effective size for scaling curves.
 *
 * Sparse experts add useful specialized capacity, but an inactive parameter
 * cannot contribute like one exercised on every token. Count the active path
 * fully and the remaining expert bank partially, with routing overhead keeping
 * the result below an equally sized dense model.
 */
export function effectiveScaleParamsB(
  paramsB: number,
  activeParamsB?: number,
  family?: ModelFamily,
  backbone?: ModelBackbone,
): number {
  const n = Math.max(0.001, paramsB);
  if (backbone === "moe" || (backbone == null && family === "moe")) {
    const active = Math.max(0.001, Math.min(n, activeParamsB ?? n * 0.1));
    const partialExpertCapacity = active + (n - active) * 0.35;
    return Math.min(
      n * 0.9,
      partialExpertCapacity * moeRoutingCapacityMultiplier(n, active),
    );
  }
  return n;
}

/**
 * Extremely sparse routes are playable, but cannot exploit a huge expert bank
 * as effectively as a healthy active path. Two percent is the no-penalty knee,
 * not a launch gate; below it capability falls continuously with sqrt(route).
 */
export function moeRoutingCapacityMultiplier(
  totalParamsB: number,
  activeParamsB: number,
): number {
  const total = Math.max(0.001, totalParamsB);
  const activeFraction =
    Math.max(0.001, Math.min(total, activeParamsB)) / total;
  return Math.max(0.35, Math.min(1, Math.sqrt(activeFraction / 0.02)));
}

/**
 * Asymptotic size potential 0–~0.92 from parameter count.
 *
 * Steep sigmoid (width ~0.55 decades) keeps sub-1B potential tiny so early
 * meta is won by scale; late tech adds absolute points on top.
 *
 * Rough targets (perfect data still multiplies):
 *  70M → 0.015 · 1B → 0.06 · 7B → 0.23 · 70B → 0.65 · 405B → 0.88 · 1T → 0.92
 */
export function paramScalePotential(
  paramsB: number,
  activeParamsB?: number,
  family?: ModelFamily,
  backbone?: ModelBackbone,
): number {
  const n = effectiveScaleParamsB(paramsB, activeParamsB, family, backbone);
  // log10 of parameter count in millions
  const u = Math.log10(Math.max(n, 1e-5) * 1000);
  // Sigmoid centered near ~30B (u≈4.5); narrow width crushes sub-1B potential.
  const pot = 1 / (1 + Math.exp(-(u - 4.5) / 0.55));
  return Math.max(0.015, Math.min(0.93, pot));
}

/**
 * Normalize assorted quality signals into ~0.35–1.35.
 * - `labDataQuality` ~1.0 baseline (player.stat)
 * - `jobQualityUsed` 0–100 from consumed packs
 */
export function normalizeDataQuality(opts: {
  labDataQuality?: number;
  jobQualityUsed?: number;
}): number {
  const lab = opts.labDataQuality ?? 1;
  const job =
    opts.jobQualityUsed != null
      ? Math.max(0, Math.min(1, opts.jobQualityUsed / 100))
      : 0.55;
  // Blend lab flywheel with pack quality
  const raw = 0.35 + lab * 0.35 + job * 0.45;
  return Math.max(0.3, Math.min(1.4, raw));
}

/**
 * Data volume × quality gate.
 * Coverage is quality-weighted tokens per parameter. 1N is the viability
 * floor, 6N preserves the existing strong campaign recipe, and 20N is the
 * modern dense compute-optimal reference. Underfeeding hurts hard.
 */
export function dataFitScore(coverage: number, dataQuality: number): number {
  const c = Math.max(0, coverage);
  // Hybrid curve: 1:1 is viable, 6:1 strong, ~20:1 frontier.
  // Unique high-quality data is never punished; marginal value simply falls.
  const vol =
    c <= 0
      ? 0.08
      : c < 1
        ? 0.18 + Math.pow(Math.max(0.02, c), 0.72) * 0.62
        : c < 6
          ? 0.8 + ((c - 1) / 5) * 0.2
          : c < 20
            ? 1 + ((c - 6) / 14) * 0.12
            : Math.min(1.16, 1.12 + Math.log2(1 + (c - 20) / 20) * 0.025);
  const q = Math.max(0.3, Math.min(1.35, dataQuality));
  // Big models with trash data: quality bites harder via product
  return Math.max(0.1, Math.min(1.18, vol * (0.42 + q * 0.58)));
}

/** Entropy-style generalist mix score + domain specialty boosts. */
export function mixFit(weights?: Partial<Record<string, number>>): {
  general: number;
  domainBoost: Record<string, number>;
  /** 0–1 strength of a corpus dominated by its largest one or two domains. */
  specialization: number;
  /** Fractional loss applied to general capability (hard-capped at 50%). */
  generalPenalty: number;
  dominantDomains: string[];
} {
  const keys = [
    "code",
    "math",
    "science",
    "law",
    "health",
    "chat",
    "image",
    "video",
    "audio",
  ] as const;
  const w: Record<string, number> = {};
  let sum = 0;
  for (const k of keys) {
    const v = Math.max(0, weights?.[k] ?? 0);
    w[k] = v;
    sum += v;
  }
  if (sum <= 1e-9) {
    // Neutral prior — slightly chat-weighted generalist
    return {
      general: 1,
      domainBoost: {
        code: 0.15,
        math: 0.1,
        science: 0.1,
        chat: 0.2,
        law: 0.1,
        health: 0.1,
        image: 0.08,
      },
      specialization: 0,
      generalPenalty: 0,
      dominantDomains: [],
    };
  }
  for (const k of keys) w[k] = (w[k] ?? 0) / sum;

  // Shannon entropy normalized by log(n)
  let ent = 0;
  for (const k of keys) {
    const p = w[k] ?? 0;
    if (p > 1e-9) ent -= p * Math.log(p);
  }
  const entMax = Math.log(keys.length);
  const diversity = entMax > 0 ? ent / entMax : 1;
  const ranked = [...keys].sort((a, b) => w[b]! - w[a]!);
  const topTwoMass = (w[ranked[0]!] ?? 0) + (w[ranked[1]!] ?? 0);
  // Narrowing starts just before 60%, then eases smoothly toward the cap.
  // Smoothstep keeps small recipe changes from causing a discontinuous cliff.
  const concentration = Math.max(0, Math.min(1, (topTwoMass - 0.58) / 0.42));
  const specialization =
    concentration * concentration * (3 - 2 * concentration);
  const generalPenalty = Math.min(0.5, specialization * 0.5);
  const general = (1 + diversity * 0.05) * (1 - generalPenalty);
  const dominantDomains = ranked
    .slice(0, 2)
    .filter((domain) => (w[domain] ?? 0) >= 0.18);

  const domainBoost: Record<string, number> = {};
  for (const k of keys) {
    const share = w[k] ?? 0;
    const dominantLift = dominantDomains.includes(k)
      ? specialization * Math.sqrt(share) * 0.45
      : 0;
    domainBoost[k] = Math.min(1, share * 1.65 + dominantLift);
  }
  return {
    general: Math.max(0.5, Math.min(1.08, general)),
    domainBoost,
    specialization,
    generalPenalty,
    dominantDomains,
  };
}

/**
 * Full intelligence scaling — single source of truth for capability.
 */
export function scaleIntelligence(input: ScaleInputs): ScaleResult {
  const paramPotential = paramScalePotential(
    input.paramsB,
    input.activeParamsB,
    input.family,
    input.backbone,
  );
  const architectureDataCoverage = architectureAdjustedDataCoverage(input);
  const dataFit = dataFitScore(architectureDataCoverage, input.dataQuality);
  const { general: mixGeneral, domainBoost } = mixFit(input.mixWeights);
  const research = Math.max(0.9, Math.min(1.14, input.researchMult ?? 1));
  // Allow deep early-launch haircuts; floor keeps near-zero progress from
  // collapsing intelligence entirely (explicit earlyReleasePenalty still applies).
  const complete = Math.max(0.2, Math.min(1, input.trainComplete ?? 1));
  const post = Math.max(0, Math.min(1, input.postTrainStrength ?? 0.35));
  const capBonus = input.overtrainCapBonus ?? 0;
  const overtrain = overtrainBonus(architectureDataCoverage, capBonus);

  // Core product: size × data × mix. Post-train / research are soft (can't invent scale).
  let intelligence =
    paramPotential * dataFit * mixGeneral * research * (0.88 + complete * 0.12);
  // Post-train alignment lifts a bit but never past size×data ceiling
  intelligence = Math.min(
    paramPotential * 1.12 * Math.min(1.15, dataFit),
    intelligence * (1 + post * 0.08),
  );
  intelligence = Math.max(0.03, Math.min(0.96, intelligence));

  // Tech is the dominant late-game lever: research + reasoning + earned overtrain
  // add absolute points (overtrain hard-capped; research unlocks a higher cap).
  const techRawBonus =
    Math.max(0, research - 1) * OVERTRAIN.RESEARCH_RAW_WEIGHT +
    (input.reasoningEnabled ? OVERTRAIN.REASONING_RAW : 0) +
    overtrain;
  const rawCapability =
    SCALE.CAP_FLOOR +
    (SCALE.CAP_CEIL - SCALE.CAP_FLOOR) * intelligence +
    techRawBonus;
  const ceiling = capabilityCeiling(input);
  // Post-ceiling progression bend: gains past ~52 get progressively harder,
  // asymptoting at 52 + 42/steepness (94 at the default steepness of 1).
  // No-op when progressionSteepness is 0 (legacy curve restored).
  const steepness = activeBalanceTuning().progressionSteepness;
  const capability = progressionBend(
    Math.min(rawCapability, ceiling.capability),
    steepness,
  );

  const benchCeilings = benchCeilingsFromIntelligence(
    intelligence,
    domainBoost,
    input.family,
  );
  // Bend each bench ceiling with the same curve so benchmarks track capability.
  for (const id of Object.keys(benchCeilings) as BenchmarkId[]) {
    benchCeilings[id] = progressionBend(benchCeilings[id]!, steepness);
  }

  return {
    paramPotential,
    dataFit,
    architectureDataCoverage,
    mixGeneral,
    domainBoost,
    intelligence,
    overtrain,
    techRawBonus,
    capability: clamp100(capability),
    capabilityCeiling: ceiling.capability,
    benchCeilings,
  };
}

/** Per-eval difficulty & domain affinity (higher difficulty → slower climb). */
const BENCH_META: Record<
  BenchmarkId,
  { floor: number; ceil: number; difficulty: number; domains: string[] }
> = {
  mmlu: {
    floor: 10,
    ceil: 96,
    difficulty: 1.05,
    domains: ["chat", "code", "law", "health"],
  },
  coding: { floor: 8, ceil: 95, difficulty: 1.12, domains: ["code"] },
  math: { floor: 7, ceil: 94, difficulty: 1.2, domains: ["math"] },
  vision: { floor: 4, ceil: 93, difficulty: 1.15, domains: ["image", "video"] },
  law: { floor: 6, ceil: 94, difficulty: 1.18, domains: ["law"] },
  health: { floor: 6, ceil: 94, difficulty: 1.2, domains: ["health"] },
  science: { floor: 8, ceil: 95, difficulty: 1.1, domains: ["science"] },
  multilingual: { floor: 9, ceil: 94, difficulty: 1.0, domains: ["chat"] },
  agents: { floor: 5, ceil: 93, difficulty: 1.25, domains: ["code", "chat"] },
  safety: {
    floor: 12,
    ceil: 96,
    difficulty: 0.9,
    domains: ["law", "health", "chat"],
  },
};

function domainAffinity(
  domains: string[],
  boost: Record<string, number>,
): number {
  if (domains.length === 0) return 0.5;
  let s = 0;
  for (const d of domains) s += boost[d] ?? 0.12;
  return Math.max(0.2, Math.min(1.15, 0.35 + s / domains.length));
}

/**
 * Soft ceiling per bench given intelligence — 70B good data should not sit at 95.
 * Uses power curve so early scale is slow, late scale approaches ceil.
 */
export function benchCeilingsFromIntelligence(
  intelligence: number,
  domainBoost: Record<string, number> = {},
  family?: ModelFamily,
): BenchmarkScores {
  const out = emptyBenchmarks();
  const intel = Math.max(0.02, Math.min(0.98, intelligence));
  for (const id of Object.keys(BENCH_META) as BenchmarkId[]) {
    const meta = BENCH_META[id]!;
    let aff = domainAffinity(meta.domains, domainBoost);
    if (
      id === "vision" &&
      (family === "diffusion" || family === "omni" || family === "video")
    ) {
      aff = Math.max(aff, 0.95);
    }
    if (id === "vision" && family === "dense") {
      aff *= 0.35;
    }
    // Effective progress along 0–1 with difficulty
    const x = Math.pow(intel * (0.5 + 0.5 * aff), meta.difficulty);
    // Approach ceiling asymptotically — never quite hard-caps without perfect intel
    const approach = 1 - Math.exp(-2.4 * x);
    const score = meta.floor + (meta.ceil - meta.floor) * approach;
    out[id] = clamp100(Math.min(SCALE.BENCH_HARD_CEIL, score));
  }
  return out;
}

/**
 * Final benchmark scores from scale + quality axes + research/post-train nudges.
 * Research/domain nudges are **small** and still clamped to a soft headroom above ceiling.
 */
export function scoresFromScale(opts: {
  scale: ScaleResult;
  quality: QualityAxes;
  family: ModelFamily;
  unlocked?: string[];
  postTrain?: string;
  /** Extra absolute points from research/domain (capped) */
  extras?: Partial<Record<BenchmarkId, number>>;
  reasoningEnabled?: boolean;
  toolsEnabled?: boolean;
  imageDataQualityFactor?: number;
  healthLowQualityShare?: number;
  scienceDataQuality?: number;
  chatDataQuality?: number;
}): BenchmarkScores {
  const {
    scale,
    quality,
    family,
    unlocked = [],
    postTrain = "none",
    extras = {},
  } = opts;
  const has = (id: string) => unlocked.includes(id);
  const base = { ...scale.benchCeilings };

  // Quality axes slightly reshape within headroom (not a second free scale axis)
  const reshape = (id: BenchmarkId, delta: number) => {
    const headroom = Math.max(2, SCALE.BENCH_HARD_CEIL - base[id]);
    base[id] = clamp100(
      base[id] + Math.max(-8, Math.min(headroom * 0.35, delta)),
    );
  };

  reshape(
    "coding",
    (quality.coding - scale.capability) * 0.08 + (has("domain_coding") ? 4 : 0),
  );
  reshape(
    "math",
    (quality.reasoning - scale.capability) * 0.07 +
      (has("domain_math") ? 3.5 : 0),
  );
  reshape(
    "mmlu",
    (quality.reasoning + quality.chat - scale.capability * 2) * 0.04,
  );
  reshape(
    "vision",
    family === "dense"
      ? -6
      : (quality.image - 20) * 0.06 + (has("mm_vision") ? 4 : 0),
  );
  reshape("law", (quality.safety - 30) * 0.05 + (has("domain_law") ? 6 : 0));
  reshape(
    "health",
    (quality.safety - 30) * 0.05 + (has("domain_health") ? 6 : 0),
  );
  reshape(
    "science",
    (quality.reasoning - scale.capability) * 0.05 +
      (has("domain_science") ? 4 : 0),
  );
  reshape(
    "multilingual",
    (quality.chat - scale.capability) * 0.06 + (has("domain_multi") ? 5 : 0),
  );
  reshape(
    "agents",
    (quality.coding - scale.capability) * 0.05 +
      (postTrain === "tools" ? 5 : 0) +
      (has("domain_agents") ? 4 : 0),
  );
  reshape(
    "safety",
    (quality.safety - 40) * 0.12 +
      (has("align_redteam") ? 4 : 0) +
      (postTrain === "none" ? -8 : postTrain === "rlhf" ? 3 : 0),
  );

  // Research extras — hard-capped so unlocks don't max 7B models
  for (const id of Object.keys(base) as BenchmarkId[]) {
    const extra = Math.min(7, extras[id] ?? 0);
    const ceil = scale.benchCeilings[id] + 6;
    base[id] = clamp100(Math.min(ceil, base[id] + extra));
  }

  const reasoningEnabled =
    opts.reasoningEnabled ?? inferReasoningEnabled({ postTrain });
  if (reasoningEnabled) {
    base.math = clamp100(base.math + 8);
    base.coding = clamp100(base.coding + 5);
    base.science = clamp100(base.science + 4);
    base.agents = clamp100(base.agents + 8);
  }

  return applyBenchmarkPolicy({
    scores: base,
    intelligence: scale.intelligence,
    capability: scale.capability,
    family,
    quality,
    postTrain,
    reasoningEnabled,
    toolsEnabled:
      opts.toolsEnabled ?? (postTrain === "tools" || family === "omni"),
    imageDataQualityFactor: opts.imageDataQualityFactor,
    healthLowQualityShare: opts.healthLowQualityShare,
    scienceDataQuality: opts.scienceDataQuality,
    chatDataQuality: opts.chatDataQuality,
  });
}

/** Soft post-train strength 0–1 for scaling. */
export function postTrainStrength(postTrain: string): number {
  switch (postTrain) {
    case "tools":
      return 0.95;
    case "process":
      return 0.85;
    case "rlhf":
      return 0.7;
    case "sft":
      return 0.45;
    default:
      return 0.1;
  }
}

/** Max benchmark implied by model size and capability (debug/UI helper). */
export function modelBenchCeiling(
  model: {
    paramsB: number;
    activeParamsB?: number;
    family?: ModelFamily;
    backbone?: ModelBackbone;
    capability: number;
  },
  benchId: BenchmarkId,
): number {
  // Infer intelligence from capability map (inverse of linear map, approx)
  const intel = Math.max(
    0.03,
    Math.min(
      0.96,
      (model.capability - SCALE.CAP_FLOOR) / (SCALE.CAP_CEIL - SCALE.CAP_FLOOR),
    ),
  );
  // Prefer size potential when downstream post-training raised capability.
  const sizeIntel = paramScalePotential(
    model.paramsB,
    model.activeParamsB,
    model.family,
    model.backbone,
  );
  const use = Math.min(intel, sizeIntel * 1.15);
  const ceilings = benchCeilingsFromIntelligence(use, {}, model.family);
  return ceilings[benchId] + 4; // small headroom for post-training variance
}

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Debug / UI helper: expected mmlu band for a size with good data. */
export function expectedScoresPreview(
  paramsB: number,
  opts?: { coverage?: number; quality?: number; family?: ModelFamily },
): ScaleResult {
  return scaleIntelligence({
    paramsB,
    family: opts?.family ?? "dense",
    dataCoverage: opts?.coverage ?? 1,
    dataQuality: opts?.quality ?? 0.95,
    trainComplete: 1,
    postTrainStrength: 0.7,
  });
}
