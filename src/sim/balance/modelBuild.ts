/**
 * Shared model construction from the scale formula.
 * Player finalize + rival training both call this so capability/data hits match.
 */
import type {
  BenchmarkScores,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelIO,
  ModelProductPreset,
  Modality,
  PostTrainStage,
  QualityAxes,
  TrainingNumerics,
} from "../types";
import {
  bentCapabilityCeiling,
  capabilityCeiling,
  postTrainStrength,
  scaleIntelligence,
  scoresFromScale,
  type ScaleInputs,
} from "./modelScaling";
import { lqSynthCapabilityMult } from "./data";
import {
  matureModelIo,
  modalityMaturity,
  type GenerativeModality,
} from "./modelCapabilities";
import {
  inferReasoningEnabled,
  normalizeModelEvaluations,
} from "./evaluationSuites";
import { FALLBACK_COST_PER_MTOK, suggestApiInOut } from "./pricing";
import {
  buildModelProductProfile,
  postTrainStagesFromResearch,
} from "./modelProduct";
import {
  backboneFromFamily,
  ioForPreset,
  presetFromFamily,
  rollTrainingOutcome,
  serviceProfileForModel,
} from "./trainingV3";
import {
  nativeWeightPrecisionForNumerics,
  trainingNumericsEconomicsProfile,
} from "./trainingPrecision";
import { getResearchNode } from "./research";
import {
  DEFAULT_RECIPE_ALIGN_SHARE,
  DEFAULT_RECIPE_TRAIN_SHARE,
  applyRecipeOutcome,
  recipeOutcomeSignals,
} from "./trainingRecipe";

export interface BuildScaledModelOpts {
  id: string;
  name: string;
  paramsB: number;
  activeParamsB?: number;
  family: ModelFamily;
  backbone?: ModelBackbone;
  productPreset?: ModelProductPreset;
  io?: ModelIO;
  modalities?: Modality[];
  day: number;
  /** 0–2+ coverage vs recommended volume */
  dataCoverage: number;
  /**
   * Quality: pass 0–1.4 normalized (lab ~1.0) OR 0–100 job quality.
   * Values &gt; 3 are treated as 0–100 scale.
   */
  dataQuality: number;
  researchUnlocked?: string[];
  researchMult?: number;
  postTrain?: PostTrainStage;
  trainComplete?: number;
  mixWeights?: Partial<Record<string, number>>;
  /** 0–1 fraction of train tokens that were low-quality synth */
  synthLqShare?: number;
  shipped?: boolean;
  release?: "internal" | "released";
  tokPerSecMult?: number;
  inferCostMult?: number;
  outcomeSeed?: number;
  engineers?: number;
  effectiveDataRatio?: number;
  repeatedDataEpochs?: number;
  openWeights?: boolean;
  trainingNumerics?: TrainingNumerics;
  /**
   * Previously completed models per generative modality for this lab. Feeds
   * the shared modalityMaturity curve so first-generation audio/image/video
   * models are immature. Defaults to 0 (first generation) per modality.
   */
  modalityExperience?: Partial<Record<GenerativeModality, number>>;
  /**
   * Canonical $/MTok cost basis for birth list prices. Prefer
   * `birthApiUnitCostPerMTok` from a live SimState when available.
   */
  costPerMTokBase?: number;
  trainShare?: number;
  postTrainShare?: number;
  /** Full selected envelope (base + align). Falls back to coverage × 1× params. */
  recipeTotalMTok?: number;
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeQuality(q: number): number {
  if (q > 3) return Math.max(0.25, Math.min(1.4, q / 70));
  return Math.max(0.25, Math.min(1.4, q));
}

/**
 * Build a Model using the same scaleIntelligence path as player training.
 * Under-data and LQ synth both reduce capability (risk training).
 */
export function buildScaledModel(opts: BuildScaledModelOpts): Model {
  const family = opts.family;
  const backbone = opts.backbone ?? backboneFromFamily(family);
  const activeParamsB =
    opts.activeParamsB ??
    (backbone === "moe" ? Math.max(0.1, opts.paramsB * 0.08) : undefined);
  // Post-training is earned work, never an implicit rival/player bonus.
  const postTrain = opts.postTrain ?? "none";
  const unlocked = opts.researchUnlocked ?? [];
  const researchMult = opts.researchMult ?? 1 + unlocked.length * 0.004;
  const lqShare = Math.max(0, Math.min(1, opts.synthLqShare ?? 0));
  const lqMult = lqSynthCapabilityMult(lqShare);
  const precision = trainingNumericsEconomicsProfile(opts.trainingNumerics);

  let overtrainCapBonus = 0;
  for (const id of unlocked) {
    overtrainCapBonus += getResearchNode(id).effects.overtrainCapBonus ?? 0;
  }

  const scaleIn: ScaleInputs = {
    paramsB: opts.paramsB,
    activeParamsB,
    family,
    backbone,
    dataCoverage: Math.max(0.05, opts.dataCoverage),
    dataQuality:
      normalizeQuality(opts.dataQuality) * (0.85 + 0.15 * (1 - lqShare)),
    mixWeights: opts.mixWeights ?? {
      chat: 0.4,
      code: 0.25,
      law: 0.08,
      health: 0.07,
      image: 0.1,
      audio: 0.05,
      video: 0.05,
    },
    researchMult:
      (family === "moe" || opts.backbone === "moe") && !unlocked.includes("moe_routing")
        ? researchMult * 0.55
        : researchMult,
    trainComplete: opts.trainComplete ?? 1,
    postTrainStrength: postTrainStrength(postTrain),
    reasoningEnabled: unlocked.includes("align_process"),
    overtrainCapBonus,
  };

  const scale = scaleIntelligence(scaleIn);
  // LQ synth regression applied on top of scale
  let capability = clamp(scale.capability * lqMult);

  const modalities: Modality[] = opts.modalities ?? ["text"];
  // Lab experience caps only the achievable modality ceiling: first-gen
  // audio/image/video models are immature even at full theoretical scale.
  const maturity: Partial<Record<GenerativeModality, number>> = {};
  for (const modality of ["image", "audio", "video"] as const) {
    if (modalities.includes(modality)) {
      maturity[modality] = modalityMaturity(opts.modalityExperience?.[modality] ?? 0);
    }
  }
  const trainShare = opts.trainShare ?? DEFAULT_RECIPE_TRAIN_SHARE;
  const postTrainShare = opts.postTrainShare ?? DEFAULT_RECIPE_ALIGN_SHARE;
  const recipeTotalMTok =
    opts.recipeTotalMTok ??
    Math.max(0, opts.dataCoverage) * Math.max(1, opts.paramsB) * 1000;
  const recipeApplied = applyRecipeOutcome({
    capability,
    quality: {
      reasoning: capability * 0.92,
      coding: capability * 0.88,
      chat: capability * 0.85,
      image: modalities.includes("image")
        ? capability * 0.75 * (maturity.image ?? 1)
        : 5,
      video: modalities.includes("video")
        ? capability * 0.6 * (maturity.video ?? 1)
        : 0,
      safety: Math.min(100, 45 + scale.intelligence * 40 - lqShare * 18),
      reliability: Math.min(100, 40 + scale.intelligence * 45 - lqShare * 22),
    },
    signals: recipeOutcomeSignals({
      totalMTok: recipeTotalMTok,
      paramsB: opts.paramsB,
      family,
      backbone,
      activeParamsB,
      postTrainShare,
      trainShare,
    }),
  });
  capability = recipeApplied.capability;
  const quality: QualityAxes = recipeApplied.quality;

  let benchmarks: BenchmarkScores = scoresFromScale({
    scale: { ...scale, capability },
    quality,
    family,
    unlocked,
    postTrain,
  });
  // Immature modality experience also caps the modality-linked benchmark.
  if (maturity.image != null && maturity.image < 1) {
    benchmarks = {
      ...benchmarks,
      vision: clamp(benchmarks.vision * maturity.image),
    };
  }
  // Soft bench hit from LQ pollution. Personality is a product axis, not capability.
  if (lqShare > 0.05) {
    const bHit = 1 - lqShare * 0.18;
    benchmarks = Object.fromEntries(
      Object.entries(benchmarks).map(([k, v]) => [
        k,
        k === "personality" ? v : clamp((v as number) * bHit),
      ]),
    ) as BenchmarkScores;
  }

  const outcome =
    opts.outcomeSeed == null
      ? undefined
      : rollTrainingOutcome({
          seed: opts.outcomeSeed,
          quality: normalizeQuality(opts.dataQuality) * 70,
          verifyShare: 1 - trainShare,
          engineers: opts.engineers ?? 0,
          researchCount: unlocked.length,
          day: opts.day,
        });
  if (outcome) {
    capability = clamp(capability + outcome.capabilityDelta);
    quality.reliability = clamp(quality.reliability + outcome.reliabilityDelta);
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      if (key === "personality") continue;
      benchmarks[key] = clamp(benchmarks[key] + outcome.capabilityDelta * 0.45);
    }
  }
  capability = Math.min(
    capability,
    bentCapabilityCeiling(capabilityCeiling(scaleIn).capability) *
      precision.qualityCeilingMultiplier,
  );
  for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
    benchmarks[key] = Math.min(
      benchmarks[key],
      scale.benchCeilings[key] * precision.qualityCeilingMultiplier,
    );
  }

  const moe = backbone === "moe";
  const inferCostMult =
    (opts.inferCostMult ?? (moe ? 0.75 : 1)) * precision.inferenceCostMultiplier;
  // Each model gets its own in/out list from size/family/capability costs.
  // Without a live campus snapshot use the rebalanced fallback (~5× old 0.28).
  const apiSug = suggestApiInOut({
    costPerMTokBase: opts.costPerMTokBase ?? FALLBACK_COST_PER_MTOK,
    paramsB: opts.paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    markupPct: 120,
    applyModelMult: true,
  });
  const preset = opts.productPreset ?? presetFromFamily(family);
  const chatShare = Number(opts.mixWeights?.chat ?? 0);
  const productProfile = buildModelProductProfile({
    postTrain,
    completedPostTrainStages: postTrainStagesFromResearch(unlocked),
    chatShare,
    chatQuality: quality.chat,
    researchUnlocked: unlocked,
    family,
    backbone,
    reasoningEnabled: inferReasoningEnabled({
      postTrain,
      integratedMethods: unlocked,
    }),
    outcomeSeed: opts.outcomeSeed,
  });
  benchmarks.personality = productProfile.personality;
  const serviceProfile = serviceProfileForModel({
    paramsB: opts.paramsB,
    activeParamsB,
    family,
    backbone,
    productPreset: preset,
    io: opts.io ?? ioForPreset(preset, capability),
    modalities,
    tokPerSecMult: opts.tokPerSecMult ?? (moe ? 0.9 : 0.7),
    capability,
  });

  return normalizeModelEvaluations({
    id: opts.id,
    name: opts.name,
    family,
    paramsB: opts.paramsB,
    activeParamsB,
    backbone,
    productPreset: preset,
    io: matureModelIo(opts.io ?? ioForPreset(preset, capability), maturity),
    capability,
    modalities,
    quality,
    benchmarks,
    productProfile,
    postTrain,
    completedPostTrainStages: postTrainStagesFromResearch(unlocked),
    trainComputeSpent: 20 * (opts.trainComplete ?? 1),
    releaseDay: opts.day,
    shipped: opts.shipped ?? true,
    release: opts.release ?? "released",
    tokPerSecMult: opts.tokPerSecMult ?? (moe ? 0.9 : 0.7),
    inferCostMult,
    serviceProfile,
    apiPricePerMTok: apiSug.blendedPrice,
    apiPriceInPerMTok: apiSug.priceIn,
    apiPriceOutPerMTok: apiSug.priceOut,
    suggestedApiPrice: apiSug.blendedPrice,
    suggestedApiPriceIn: apiSug.priceIn,
    suggestedApiPriceOut: apiSug.priceOut,
    costApiPriceIn: apiSug.costIn,
    costApiPriceOut: apiSug.costOut,
    distilled: false,
    trainMode: "pretrain",
    dataTokensUsedMTok: opts.dataCoverage * opts.paramsB * 1000,
    dataQualityUsed: normalizeQuality(opts.dataQuality) * 70,
    dataCoverage: opts.dataCoverage,
    effectiveDataRatio: opts.effectiveDataRatio ?? opts.dataCoverage,
    repeatedDataEpochs: opts.repeatedDataEpochs ?? 1,
    outcome,
    openWeights: opts.openWeights ?? false,
    trainingNumerics: opts.trainingNumerics,
    nativeWeightPrecision: opts.trainingNumerics
      ? nativeWeightPrecisionForNumerics(opts.trainingNumerics)
      : undefined,
  });
}
