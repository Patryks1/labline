import type {
  Allocation,
  CapitalStack,
  DataDomain,
  LabData,
  MapTile,
  Model,
  ModelBackbone,
  ModelIO,
  ModelIOModality,
  ModelProductPreset,
  ProductPricing,
  MarketingChannels,
  ResearchDisclosure,
  ResearchProgram,
  RivalLab,
  RivalTrainJob,
  SegmentId,
  SimState,
  TrainingProgram,
} from "../types";
import { isLivePublicModel } from "../modelRelease";
import { createRng, hashSeed } from "../rng";
import { BENCHMARK_DEFS } from "../balance/benchmarks";
import {
  composeRouterModel,
  publicRouterParts,
} from "../balance/modelRouter";
import { normalizeModelRouters } from "../balance/modelStudio";
import {
  createEmptyLabData,
  DATA_DOMAIN_META,
  DATA_DOMAINS,
  minDataMTokForParams,
  normalizeWeights,
  normalizeDomainStock,
  totalProcessed,
} from "../balance/data";
import {
  chooseRivalTrainingRecipeKnobs,
  planTrainingRecipe,
  usableStockByDomain,
} from "../balance/trainingRecipe";
import { buildScaledModel } from "../balance/modelBuild";
import {
  estimateTrainingEconomics,
  pacedTrainingPfPerDay,
} from "../balance/training";
import { ECONOMY } from "../balance/economy";
import {
  blendApiPrice,
  commercialModelKind,
  splitBlendedApiPrice,
} from "../balance/pricing";
import { getResearchNode } from "../balance/research";
import {
  analyzeTrainingData,
  ioForPreset,
  trainingDataModalityRequirements,
} from "../balance/trainingV3";
import {
  deriveModelCapabilities,
  estimateSyntheticQuality,
  modalityExperienceCounts,
  modalityMaturity,
  teacherCapabilityForDataDomain,
} from "../balance/modelCapabilities";
import {
  synthAcceptanceChances,
  synthTeacherActiveParamsB,
} from "../balance/syntheticGeneration";
import { labInferCapacityPf, labResearchPf, labTrainPf } from "./labCompute";
import { rivalEffectiveFlops } from "./computeMarket";
import {
  applyResearchEffectsToLab,
  canLabResearchNode,
  labResearchDayProgress,
  aggregateEffects,
  researchCashPerPf,
  researchDaysTarget,
  researchPfTargetForNode,
} from "./research";
import { consumeForLabData, synthTeacherFit } from "./data";
import {
  TERRAIN_KIND,
  tileCoords,
  tileId,
  type Facility,
  type TileId,
} from "../world";
import { commitWorldBatch, usesCompactWorld } from "./worldAccess";
import { dcFootprint, getBuildDef } from "./map";
import { scheduleReleaseEvaluations } from "./evaluations";
import { modelOfferApiPrice } from "./market";
import { releaseDueRivalComebacks } from "./rivalComeback";
import {
  appendDatasetAsset,
  createDataManifest,
  manifestDomainExposureMTok,
  mergeSyntheticDatasetAsset,
  syntheticDatasetAsset,
  trainingDataEvidenceFromManifest,
} from "./dataAssets";
import {
  collectTrafficData,
  dataProcessingThroughput,
  enqueueAutomaticProcessing,
  processDataJobs,
  syntheticGenerationMTokPerDay,
  updateDataQualityIndex,
} from "./dataRuntime";
import { fundRivalForCampus } from "./capital";
import { competitiveCatchUpSnapshot } from "./sharedMarkets";
import {
  applyRivalDailyMarketing,
} from "./marketing";
import { appendFeedEvents } from "./feed";
import { applyLabActionToTarget } from "./labActionKernel";
import {
  advanceRivalStrategy,
  allocationForRivalStrategy,
  chooseRivalDcSize,
  chooseRivalScaleCandidate,
  chooseRivalServePrecision,
  chooseRivalTrainingNumerics,
  planRivalResearchPath,
  RIVAL_MULTIMODAL_RESEARCH_LADDER,
  rivalActionRng,
  rivalTrainingHardwareGeneration,
} from "./rivalStrategy";
import {
  rivalEraDataComfortMult,
  rivalEraParamCeilingB,
  rivalMoeActiveRatio,
  rivalMoeAdoptionChance,
  applyRivalReleaseLuck,
  rivalReleaseLuckBonus,
} from "../balance/rivalScale";
import {
  highestPostTrainStage,
  postTrainStagesFromResearch,
} from "../balance/modelProduct";
import {
  DEFAULT_TRAINING_NUMERICS,
  estimateTrainingMemoryGb,
  LEGACY_TRAINING_NUMERICS,
  trainingFormatThroughput,
} from "../balance/trainingPrecision";
import { computeLabSnapshot } from "./labEngine";

/** Legacy compatibility marker; v3 never checks this as a release gate. */
export const RIVAL_FIRST_RELEASE_DAY = 1;

/** Competitive, affordable daily demand-generation target for a rival lab. */
export function rivalMarketingBudgetTarget(
  rival: RivalLab,
  playerSpendPerDay: number,
): number {
  const cash = Math.max(0, rival.cash);
  const revenue = Math.max(
    rival.dayRevenue ?? 0,
    rival.finance?.dayRevenue ?? 0,
  );
  const revenueBasis = Math.max(100_000, revenue);
  const archetypeFactor =
    rival.archetype === "hyperscale"
      ? 1.2
      : rival.archetype === "open_weights"
        ? 0.86
        : rival.archetype === "efficiency"
          ? 0.92
          : rival.archetype === "multimodal"
            ? 1.08
            : 1;
  const affordable = Math.max(35_000, revenueBasis * 0.1 * archetypeFactor);
  const competitive = Math.min(
    Math.max(0, playerSpendPerDay) * 0.7 * archetypeFactor,
    revenueBasis * 2,
  );
  return Math.min(cash * 0.02, Math.max(affordable, competitive));
}

/** Archetype-specific campaign mix, adjusted deterministically for competition. */
export function rivalMarketingChannels(
  rival: Pick<RivalLab, "archetype" | "marketShare">,
  spend: number,
  playerSpendPerDay: number,
): MarketingChannels {
  const mixes: Record<RivalLab["archetype"], MarketingChannels> = {
    hyperscale: { web: 0.24, billboards: 0.32, restaurants: 0.08, enterprise: 0.36 },
    open_weights: { web: 0.5, billboards: 0.08, restaurants: 0.16, enterprise: 0.26 },
    efficiency: { web: 0.46, billboards: 0.1, restaurants: 0.12, enterprise: 0.32 },
    multimodal: { web: 0.3, billboards: 0.2, restaurants: 0.25, enterprise: 0.25 },
    safety: { web: 0.34, billboards: 0.2, restaurants: 0.1, enterprise: 0.36 },
  };
  const base = mixes[rival.archetype];
  const pressure = Math.max(
    -0.12,
    Math.min(0.18, (Math.max(0, playerSpendPerDay) - Math.max(1, spend)) / Math.max(100_000, spend)),
  );
  const sharePressure = rival.marketShare < 0.08 ? 0.06 : 0;
  const weights = {
    web: Math.max(0.02, base.web + pressure * 0.35 + sharePressure),
    billboards: Math.max(0.02, base.billboards + pressure * 0.25),
    restaurants: Math.max(0.02, base.restaurants - pressure * 0.15),
    enterprise: Math.max(0.02, base.enterprise + pressure * 0.55 - sharePressure * 0.2),
  };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return {
    web: spend * weights.web / total,
    billboards: spend * weights.billboards / total,
    restaurants: spend * weights.restaurants / total,
    enterprise: spend * weights.enterprise / total,
  };
}

function relativeChange(next: number, prior: number): number {
  return Math.abs(next - prior) / Math.max(0.01, Math.abs(prior), 1);
}

function channelMixDistance(
  next: MarketingChannels | undefined,
  prior: MarketingChannels | undefined,
): number {
  if (!next || !prior) return next || prior ? 1 : 0;
  const totalNext = Object.values(next).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const totalPrior = Object.values(prior).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  return (['web', 'billboards', 'restaurants', 'enterprise'] as const).reduce(
    (distance, channel) =>
      distance +
      Math.abs(
        Math.max(0, next[channel]) / totalNext -
          Math.max(0, prior[channel]) / totalPrior,
      ),
    0,
  );
}

function rivalFeedEventsForDay(
  state: SimState,
  priorRivals: readonly RivalLab[],
  nextRivals: readonly RivalLab[],
) {
  return nextRivals.flatMap((rival) => {
    const prior = priorRivals.find((candidate) => candidate.id === rival.id);
    if (!prior) return [];
    const events: Array<{
      id: string;
      day: number;
      category: "rivals";
      title: string;
      body: string;
      source: string;
      tone: "neutral" | "positive" | "warning" | "danger" | "research";
      entityId: string;
      kind: string;
    }> = [];
    const priorModels = new Map(prior.models.map((model) => [model.id, model]));
    const released = rival.models.filter(
      (model) =>
        model.release === "released" &&
        model.shipped &&
        !priorModels.has(model.id),
    );
    for (const model of released.slice(0, 2)) {
      events.push({
        id: `feed-rival-release-${rival.id}-${model.id}-${state.day}`,
        day: state.day,
        category: "rivals",
        title: `${rival.name} ships ${model.name}`,
        body: `A ${model.paramsB.toFixed(1)}B ${model.family} model entered the public market at capability ${model.capability.toFixed(0)}.`,
        source: rival.name,
        tone: "positive",
        entityId: rival.id,
        kind: "rival_model_release",
      });
    }
    if (!prior.trainingJob && rival.trainingJob) {
      events.push({
        id: `feed-rival-training-start-${rival.id}-${state.day}`,
        day: state.day,
        category: "rivals",
        title: `${rival.name} starts ${rival.trainingJob.name}`,
        body: `${rival.archetype.replace('_', ' ')} controller committed ${rival.trainingJob.paramsB.toFixed(1)}B / ~${rival.trainingJob.targetPfDays.toFixed(0)} PF-days to a new run.`,
        source: rival.name,
        tone: "research",
        entityId: rival.id,
        kind: "rival_training_started",
      });
    }
    if (prior.trainingJob && !rival.trainingJob && released.length === 0) {
      events.push({
        id: `feed-rival-training-finished-${rival.id}-${state.day}`,
        day: state.day,
        category: "rivals",
        title: `${rival.name} completes a training run`,
        body: "Its controller closed the run and is now free to redirect compute, pricing, or the next research bet.",
        source: rival.name,
        tone: "research",
        entityId: rival.id,
        kind: "rival_training_completed",
      });
    }
    const priorPrice = prior.pricing.apiPricePerMTok;
    const nextPrice = rival.pricing.apiPricePerMTok;
    if (relativeChange(nextPrice, priorPrice) >= 0.025) {
      const direction = nextPrice < priorPrice ? "cuts" : "raises";
      events.push({
        id: `feed-rival-price-${rival.id}-${state.day}`,
        day: state.day,
        category: "rivals",
        title: `${rival.name} ${direction} API pricing`,
        body: `API list moved from $${priorPrice.toFixed(2)} to $${nextPrice.toFixed(2)} per MTok as its ${rival.archetype.replace('_', ' ')} strategy responds to competition.`,
        source: rival.name,
        tone: nextPrice < priorPrice ? "warning" : "neutral",
        entityId: rival.id,
        kind: "rival_price_change",
      });
    }
    const priorSpend = prior.marketingSpendPerDay ?? 0;
    const nextSpend = rival.marketingSpendPerDay ?? 0;
    if (
      relativeChange(nextSpend, priorSpend) >= 0.12 ||
      channelMixDistance(rival.marketingChannels, prior.marketingChannels) >= 0.12
    ) {
      const direction = nextSpend >= priorSpend ? "expands" : "pulls back";
      const outcome = rival.marketingOutcome;
      events.push({
        id: `feed-rival-campaign-${rival.id}-${state.day}`,
        day: state.day,
        category: "rivals",
        title: `${rival.name} ${direction} its campaign`,
        body: `${Math.round(nextSpend / 1000)}k/day across an archetype-led channel mix; expected reach is ${Math.round(outcome?.acquiredCustomers ?? 0).toLocaleString()} acquired customers with ${Math.round(outcome?.enterpriseLeads ?? 0).toLocaleString()} enterprise leads.`,
        source: rival.name,
        tone: "neutral",
        entityId: rival.id,
        kind: "rival_campaign_change",
      });
    }
    return events;
  });
}

function initialRivalCapital(name: string): CapitalStack {
  return {
    capTable: [
      {
        holderId: `${name}-founders`,
        holderName: "Founders",
        ownership: 0.75,
        votingPower: 0.82,
        kind: "founder",
      },
      {
        holderId: `${name}-investors`,
        holderName: "Seed investors",
        ownership: 0.2,
        votingPower: 0.16,
        kind: "investor",
      },
      {
        holderId: `${name}-options`,
        holderName: "Team option pool",
        ownership: 0.05,
        votingPower: 0.02,
        kind: "option_pool",
      },
    ],
    fundingRounds: [],
    debt: [],
    investorConfidence: 0.62,
    boardPressure: 0.14,
    founderControl: 0.82,
    pitchCooldownUntilDay: 0,
    pitchModelCooldowns: {},
    pitchHistory: [],
    restructuring: { active: false, daysLeft: 0, stage: "none" },
  };
}

function ensureRivalData(r: RivalLab): LabData {
  if (r.data?.stocks) {
    const stocks = { ...r.data.stocks };
    for (const d of DATA_DOMAINS) stocks[d] = normalizeDomainStock(stocks[d]);
    return {
      ...r.data,
      stocks,
      processQueue: r.data.processQueue ?? [],
      synthQueue: (r.data.synthQueue ?? []).map((j) => ({
        ...j,
        qualityTier: j.qualityTier ?? "hq",
      })),
    };
  }
  // Legacy scalar → empty 500 MTok starter
  return createEmptyLabData();
}

function rivalDataPriority(archetype: RivalLab["archetype"]): DataDomain[] {
  if (archetype === "multimodal") return ["image", "video", "audio", "chat"];
  if (archetype === "open_weights") return ["code", "math", "science", "chat"];
  if (archetype === "efficiency") return ["code", "math", "chat"];
  if (archetype === "safety") return ["law", "health", "science", "chat"];
  return ["chat", "code", "math", "science"];
}

/**
 * Strategy is expressed through corpus selection, not a hidden capability
 * multiplier. These recipes are also frozen into each run's data manifest so
 * evaluation can attribute specialist strengths to the evidence actually used.
 */
export function rivalTrainingWeights(
  archetype: RivalLab["archetype"],
): Partial<Record<DataDomain, number>> {
  if (archetype === "efficiency") {
    return {
      chat: 0.28,
      code: 0.36,
      math: 0.2,
      science: 0.1,
      image: 0.02,
      audio: 0.02,
      video: 0.02,
    };
  }
  if (archetype === "open_weights") {
    return {
      chat: 0.2,
      code: 0.3,
      math: 0.2,
      science: 0.2,
      image: 0.04,
      audio: 0.03,
      video: 0.03,
    };
  }
  if (archetype === "multimodal") {
    return {
      chat: 0.22,
      code: 0.1,
      math: 0.06,
      science: 0.06,
      image: 0.25,
      video: 0.17,
      audio: 0.14,
    };
  }
  if (archetype === "safety") {
    return {
      chat: 0.22,
      code: 0.08,
      math: 0.07,
      science: 0.18,
      law: 0.2,
      health: 0.2,
      image: 0.03,
      audio: 0.01,
      video: 0.01,
    };
  }
  return {
    chat: 0.24,
    code: 0.18,
    math: 0.13,
    science: 0.13,
    law: 0.06,
    health: 0.06,
    image: 0.09,
    audio: 0.05,
    video: 0.06,
  };
}

export function rivalProductTrainingWeights(
  archetype: RivalLab["archetype"],
  family: Model["family"],
  productPreset: ModelProductPreset,
): Record<DataDomain, number> {
  let weights = normalizeWeights(rivalTrainingWeights(archetype));
  for (const [domain, floor] of Object.entries(
    trainingDataModalityRequirements(family, productPreset),
  ) as [DataDomain, number][]) {
    if (weights[domain] + 1e-9 >= floor) continue;
    const other = Math.max(1e-9, 1 - weights[domain]);
    const scale = (1 - floor) / other;
    weights = Object.fromEntries(
      DATA_DOMAINS.map((candidate) => [
        candidate,
        candidate === domain ? floor : weights[candidate] * scale,
      ]),
    ) as Record<DataDomain, number>;
  }
  return weights;
}

export function rivalMediaDataShortfall(opts: {
  family: Model["family"];
  productPreset: ModelProductPreset;
  consumed: Partial<Record<DataDomain, number>>;
}): { domain: DataDomain; requiredShare: number; actualShare: number } | null {
  const usable = Object.values(opts.consumed).reduce(
    (sum, value) => sum + Math.max(0, value ?? 0),
    0,
  );
  for (const [domain, requiredShare] of Object.entries(
    trainingDataModalityRequirements(opts.family, opts.productPreset),
  ) as [DataDomain, number][]) {
    const actualShare =
      usable > 0 ? Math.max(0, opts.consumed[domain] ?? 0) / usable : 0;
    if (actualShare + 1e-9 < requiredShare) {
      return { domain, requiredShare, actualShare };
    }
  }
  return null;
}

export interface RivalModelBet {
  family: Model["family"];
  backbone: ModelBackbone;
  productPreset: ModelProductPreset;
  io: ModelIO;
  modalities: Model["modalities"];
  activeParamsRatio?: number;
  label: string;
}

/** Native product endpoints this checkpoint can actually return. */
export function rivalRoutableModalities(
  model: Pick<Model, "family" | "productPreset" | "io" | "modalities">,
): ModelIOModality[] {
  const io =
    model.io ??
    ioForPreset(
      model.productPreset ??
        (model.family === "diffusion"
          ? "image_generation"
          : model.family === "video"
            ? "video_generation"
            : model.family === "omni"
              ? "omni"
              : "language"),
    );
  const modalities = (["text", "image", "audio", "video"] as const).filter(
    (modality) => (io.outputs[modality] ?? 0) > 0,
  );
  return modalities.length > 0 ? modalities : ["text"];
}

function normalizeRivalReleaseMilestones(
  rival: Pick<RivalLab, "models" | "releaseMilestones">,
): NonNullable<RivalLab["releaseMilestones"]> {
  const milestones = (rival.releaseMilestones ?? []).map((milestone) => ({
    ...milestone,
  }));
  const seen = new Set(
    milestones.map(
      (milestone) => `${milestone.productPreset}:${milestone.backbone}`,
    ),
  );
  for (const model of rival.models) {
    if (model.release !== "released" && !model.shipped) continue;
    const productPreset =
      model.productPreset ??
      (model.family === "diffusion"
        ? "image_generation"
        : model.family === "video"
          ? "video_generation"
          : model.family === "omni"
            ? "omni"
            : "language");
    const backbone =
      model.backbone ??
      (model.family === "moe"
        ? "moe"
        : model.family === "diffusion" || model.family === "video"
          ? "diffusion"
          : "dense");
    const key = `${productPreset}:${backbone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    milestones.push({
      productPreset,
      backbone,
      modelId: model.id,
      releaseDay: model.releaseDay,
    });
  }
  return milestones;
}

/**
 * Choose a product and a parameter topology independently. Multimodal labs
 * deliberately ship each newly unlocked product line before converging on an
 * omni product, then revisit omni on a sparse backbone once MoE is available.
 */
export function rivalNextModelBet(
  rival: Pick<
    RivalLab,
    "archetype" | "researchUnlocked" | "models" | "releaseMilestones"
  >,
): RivalModelBet {
  const unlocked = new Set(rival.researchUnlocked);
  const released = rival.models.filter(
    (model) => isLivePublicModel(model),
  );
  const milestones = rival.releaseMilestones ?? [];
  const hasPreset = (preset: ModelProductPreset, backbone?: ModelBackbone) =>
    milestones.some(
      (milestone) =>
        milestone.productPreset === preset &&
        (backbone == null || milestone.backbone === backbone),
    ) ||
    released.some(
      (model) =>
        (model.productPreset ??
          (model.family === "diffusion"
            ? "image_generation"
            : model.family === "video"
              ? "video_generation"
              : model.family === "omni"
                ? "omni"
                : "language")) === preset &&
        (backbone == null ||
          (model.backbone ??
            (model.family === "moe"
              ? "moe"
              : model.family === "diffusion" || model.family === "video"
                ? "diffusion"
                : "dense")) === backbone),
    );
  const bet = (
    family: Model["family"],
    backbone: ModelBackbone,
    productPreset: ModelProductPreset,
    modalities: Model["modalities"],
    label: string,
    activeParamsRatio?: number,
  ): RivalModelBet => ({
    family,
    backbone,
    productPreset,
    io: ioForPreset(productPreset),
    modalities,
    label,
    activeParamsRatio,
  });

  if (rival.archetype === "multimodal") {
    if (unlocked.has("mm_vision") && !hasPreset("audio")) {
      return bet("dense", "dense", "audio", ["text", "audio"], "audio product");
    }
    if (unlocked.has("mm_diff") && !hasPreset("image_generation")) {
      return bet(
        "diffusion",
        "diffusion",
        "image_generation",
        ["text", "image"],
        "image generator",
      );
    }
    if (unlocked.has("mm_video") && !hasPreset("video_generation")) {
      return bet(
        "video",
        "diffusion",
        "video_generation",
        ["text", "image", "video"],
        "video generator",
      );
    }
    if (unlocked.has("mm_omni") && !hasPreset("omni", "dense")) {
      return bet(
        "omni",
        "dense",
        "omni",
        ["text", "image", "audio", "video", "tools"],
        "dense omni product",
      );
    }
    if (
      unlocked.has("mm_omni") &&
      unlocked.has("moe_basics") &&
      !hasPreset("omni", "moe")
    ) {
      return bet(
        "omni",
        "moe",
        "omni",
        ["text", "image", "audio", "video", "tools"],
        "sparse omni product",
        0.12,
      );
    }
    if (unlocked.has("mm_omni")) {
      const useMoe = unlocked.has("moe_basics");
      return bet(
        "omni",
        useMoe ? "moe" : "dense",
        "omni",
        ["text", "image", "audio", "video", "tools"],
        useMoe ? "sparse omni iteration" : "omni iteration",
        useMoe ? 0.12 : undefined,
      );
    }
    if (unlocked.has("mm_video"))
      return bet(
        "video",
        "diffusion",
        "video_generation",
        ["text", "image", "video"],
        "video iteration",
      );
    if (unlocked.has("mm_diff"))
      return bet(
        "diffusion",
        "diffusion",
        "image_generation",
        ["text", "image"],
        "image iteration",
      );
    if (unlocked.has("mm_vision"))
      return bet(
        "dense",
        "dense",
        "audio",
        ["text", "audio"],
        "audio iteration",
      );
  }

  if (rival.archetype === "efficiency" && unlocked.has("moe_basics")) {
    return bet(
      "moe",
      "moe",
      "language",
      ["text", "tools"],
      "efficient MoE",
      0.08,
    );
  }
  return bet("dense", "dense", "language", ["text", "tools"], "language model");
}

/** Controller policy only: all pools still draw from the same physical PF. */
export function rivalAllocationPolicy(
  archetype: RivalLab["archetype"],
  state: { training: boolean; hasModel: boolean; overload: boolean },
): Allocation {
  let training = 0.35;
  let inference = 0.35;
  let research = 0.3;
  if (!state.hasModel && !state.training) {
    training = 0.2;
    research = 0.55;
    inference = 0.25;
  } else if (state.training) {
    training = 0.55;
    research = 0.2;
    inference = 0.25;
  } else if (state.overload) {
    training = 0.15;
    research = 0.15;
    inference = 0.7;
  } else if (state.hasModel) {
    training = 0.28;
    research = 0.27;
    inference = 0.45;
  }
  // These are planning preferences, not extra resource yields.
  if (archetype === "open_weights") research += 0.08;
  if (archetype === "hyperscale") training += 0.08;
  if (archetype === "efficiency") research += 0.05;
  const total = training + inference + research;
  return {
    training: training / total,
    inference: inference / total,
    research: research / total,
  };
}

/** Frontier controllers deliberately risk a larger dense pilot; others stay conservative. */
export function rivalDenseScaleTarget(
  archetype: RivalLab["archetype"],
  comfortableParamsB: number,
  forecastSignal: number,
): number {
  const signal = Math.max(0, Math.min(1, forecastSignal));
  const multiplier =
    archetype === "hyperscale" ? 1.1 + signal * 0.4 : 0.55 + signal * 0.35;
  return Math.min(
    archetype === "hyperscale" ? 2 : 1.5,
    comfortableParamsB * multiplier,
  );
}

/** One financed challenger can make larger, data-bounded jumps toward SOTA. */
export function rivalCatchUpScaleTarget(input: {
  baselineTargetParamsB: number;
  currentParamsB: number;
  comfortableParamsB: number;
  capabilityGap: number;
  maxParamsB?: number;
}): number {
  const gap = Math.max(0, Math.min(40, input.capabilityGap));
  const gapGrowth = 1 + gap * 0.035;
  const capitalTarget = Math.max(0.05, input.currentParamsB) * gapGrowth;
  const dataBound = Math.max(
    input.currentParamsB * 1.1,
    Math.max(0.05, input.comfortableParamsB) * 2.5,
  );
  const ceiling = Math.max(8, input.maxParamsB ?? 240);
  return Math.min(
    ceiling,
    Math.max(input.baselineTargetParamsB, Math.min(capitalTarget, dataBound)),
  );
}

export function publicFrontierParamsB(state: SimState): number {
  let best = 0;
  for (const model of state.player.models) {
    if (isLivePublicModel(model)) best = Math.max(best, model.paramsB);
  }
  for (const rival of state.rivals) {
    for (const model of rival.models) {
      if (isLivePublicModel(model)) best = Math.max(best, model.paramsB);
    }
  }
  return best;
}

/** Exact research inputs used by the player scaling and train-cost paths. */
export function rivalResearchTrainingModifiers(
  unlocked: readonly string[],
  family: Model["family"],
  backbone?: ModelBackbone,
): {
  trainEfficiency: number;
  researchMult: number;
  overtrainCapBonus: number;
} {
  const effects = aggregateEffects([...unlocked]);
  return {
    trainEfficiency: Math.min(
      1.5,
      ECONOMY.startingTrainEfficiency + 0.05 + (effects.trainEfficiency ?? 0),
    ),
    researchMult:
      1 +
      Math.min(0.12, (effects.capabilityBonus ?? 0) * 0.015) +
      ((backbone === "moe" || (backbone == null && family === "moe")) &&
      unlocked.includes("moe_hier")
        ? 0.04
        : 0),
    overtrainCapBonus: effects.overtrainCapBonus ?? 0,
  };
}

function rivalTargetSegments(archetype: RivalLab["archetype"]): SegmentId[] {
  if (archetype === "open_weights") return ["indie_api", "science"];
  if (archetype === "efficiency") return ["indie_api", "startup_api"];
  if (archetype === "multimodal") return ["creative", "consumer"];
  if (archetype === "safety") return ["enterprise", "legal", "healthcare"];
  return ["startup_api", "enterprise"];
}

function rivalResearchDisclosure(
  archetype: RivalLab["archetype"],
): ResearchDisclosure {
  if (archetype === "open_weights") return "published";
  if (archetype === "efficiency") return "licensed";
  return "secret";
}

/** Hosted-service positioning; free/local open-model usage is an outside option. */
export function rivalHostedServicePriceMultiplier(
  archetype: RivalLab["archetype"],
  capabilityGap: number,
): number {
  if (archetype === "efficiency") return 0.35;
  if (archetype === "open_weights") return 0.55;
  if (capabilityGap > 4) return 1.25;
  if (capabilityGap > -2) return 1.05;
  if (capabilityGap > -10) return 0.82;
  return 0.65;
}

function rivalLabSiteCount(state: SimState, labId: string): number {
  if (usesCompactWorld(state)) {
    return state.map
      .world!.queryFacilities({ ownerId: labId, underConstruction: false })
      .filter(
        (facility) =>
          facility.kind === "lab" ||
          facility.kind === "lab_m" ||
          facility.kind === "lab_l",
      ).length;
  }
  return state.map.tiles.filter(
    (tile) =>
      tile.owner === labId &&
      tile.kind === "lab" &&
      tile.buildingProgress >= tile.buildingTarget,
  ).length;
}

function rivalTrainPf(
  r: RivalLab,
  state?: SimState,
  effectiveFlopsPf?: number,
): number {
  const flops =
    effectiveFlopsPf ?? (state ? rivalEffectiveFlops(state, r) : r.flopsPf);
  return labTrainPf({
    flopsPf: flops,
    utilCap: r.utilCap,
    allocation: r.allocation,
    servingEfficiency: r.servingEfficiency,
    dataGenResearchShare: r.data?.dataGenResearchShare,
  });
}

function rivalTrainingMemoryReady(
  rival: RivalLab,
  job: Pick<
    RivalTrainJob,
    "paramsB" | "activeParamsB" | "family" | "trainingNumerics"
  >,
  physical: ReturnType<typeof computeLabSnapshot>,
): boolean {
  const allocationTotal =
    Math.max(0, rival.allocation.training) +
    Math.max(0, rival.allocation.inference) +
    Math.max(0, rival.allocation.research);
  const trainingShare =
    allocationTotal > 1e-9
      ? Math.max(0, rival.allocation.training) / allocationTotal
      : 0.34;
  const memory = estimateTrainingMemoryGb({
    paramsB: job.paramsB,
    activeParamsB: job.activeParamsB,
    family: job.family,
    numerics: job.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
    activationCheckpointing: rival.researchUnlocked.includes("opt_checkpoint"),
  });
  const fits = (hbmGb: number, systemRamGb: number) =>
    hbmGb * trainingShare + 1e-9 >= memory.requiredHbmGb &&
    systemRamGb * trainingShare + 1e-9 >= memory.requiredSystemRamGb;
  // WAN-separated provider and local clusters are distinct placement domains;
  // their memory cannot be summed to make one indivisible model fit.
  return (
    fits(physical.localVramGb, physical.localSystemRamGb) ||
    fits(physical.remoteVramGb, physical.remoteSystemRamGb)
  );
}

/**
 * Apply at most the numerics-adjusted useful work available this tick. The
 * caller conserves the raw PF pool before converting it through the job's
 * hardware-supported format; catch-up policy never mints raw compute.
 */
export function progressRivalTrainingJob(
  job: RivalTrainJob,
  availableEffectivePfDays: number,
): { job: RivalTrainJob; workAppliedPfDays: number } {
  const remaining = Math.max(0, job.targetPfDays - job.progressPfDays);
  const usefulPfLimit = pacedTrainingPfPerDay(
    job.targetPfDays,
    job.minCalendarDays,
  );
  const workAppliedPfDays = Math.min(
    remaining,
    usefulPfLimit,
    Math.max(
      0,
      Number.isFinite(availableEffectivePfDays) ? availableEffectivePfDays : 0,
    ),
  );
  return {
    job: {
      ...job,
      progressPfDays: job.progressPfDays + workAppliedPfDays,
      daysElapsed:
        (job.daysElapsed ?? 0) +
        (availableEffectivePfDays > 0 && !job.paused ? 1 : 0),
    },
    workAppliedPfDays,
  };
}

function rivalResearchPf(
  r: RivalLab,
  state?: SimState,
  effectiveFlopsPf?: number,
): number {
  const flops =
    effectiveFlopsPf ?? (state ? rivalEffectiveFlops(state, r) : r.flopsPf);
  // Engineers raise effective util like the player
  const eng = r.staff?.engineer ?? 0;
  const engUtil = Math.min(0.14, eng * 0.012);
  return labResearchPf({
    flopsPf: flops,
    utilCap: Math.min(0.98, r.utilCap * (1 + engUtil)),
    allocation: r.allocation,
    servingEfficiency: r.servingEfficiency,
    dataGenResearchShare: r.data?.dataGenResearchShare,
  });
}

/** Exported for market — same abstract infer pool as train/research (+ leases). */
export function rivalInferCapacityPfShared(
  r: RivalLab,
  state?: SimState,
): number {
  const flops = state ? rivalEffectiveFlops(state, r) : r.flopsPf;
  return labInferCapacityPf({
    flopsPf: flops,
    utilCap: r.utilCap,
    allocation: r.allocation,
    servingEfficiency: r.servingEfficiency,
    dataGenResearchShare: r.data?.dataGenResearchShare,
  });
}

/** Difficulty → how hard rivals push (subtle, not instant). */
function rivalDifficultyPace(difficulty: SimState["config"]["difficulty"]): {
  researchSpeed: number;
  /** Days between possible "release" cadence checks */
  releaseCadence: number;
  riskTolerance: number;
  forecastNoise: number;
} {
  switch (difficulty) {
    case "easy":
      return {
        researchSpeed: 1,
        releaseCadence: 21,
        riskTolerance: 0.28,
        forecastNoise: 0.2,
      };
    case "hard":
      return {
        researchSpeed: 1,
        releaseCadence: 9,
        riskTolerance: 0.72,
        forecastNoise: 0.1,
      };
    default:
      return {
        researchSpeed: 1,
        releaseCadence: 14,
        riskTolerance: 0.5,
        forecastNoise: 0.15,
      };
  }
}

function avgBench(m: Model): number {
  const vals = BENCHMARK_DEFS.map((d) => m.benchmarks[d.id] ?? 0);
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
}

function rivalPricing(api: number): ProductPricing {
  const plusIncluded = ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth;
  const proIncluded = plusIncluded * 5;
  const apiSplit = splitBlendedApiPrice(api);
  return {
    apiPricePerMTok: api,
    apiPriceInPerMTok: apiSplit.priceIn,
    apiPriceOutPerMTok: apiSplit.priceOut,
    apiMarkupPct: 100,
    apiVsSubPriority: ECONOMY.defaultApiVsSubPriority,
    activeModelId: null,
    enterpriseContractBonus: 0,
    plans: [
      {
        id: "rival-plus",
        name: "Plus",
        pricePerMonth: 20,
        usageMultiplier: 1,
        includedMTokPerMonth: plusIncluded,
        usageRate: null,
        modelIds: [],
        servePrecision: "fp32",
        enabled: true,
      },
      {
        id: "rival-pro",
        name: "Pro",
        pricePerMonth: 45,
        usageMultiplier: 5,
        includedMTokPerMonth: proIncluded,
        usageRate: null,
        modelIds: [],
        servePrecision: "fp32",
        enabled: true,
      },
    ],
    subPlusPrice: 20,
    subProPrice: 45,
    plusIncludedMTok: plusIncluded,
    proIncludedMTok: proIncluded,
  };
}

export function rivalListedApiPrice(
  pricing: ProductPricing,
  model: Model,
): number {
  return modelOfferApiPrice(pricing, model);
}

function modelPriceValue(model: Model): number {
  return Math.max(
    5,
    model.capability * 0.72 +
      model.quality.reliability * 0.18 +
      rivalRoutableModalities(model).length * 2.5,
  );
}

/** Quality-adjusted median of comparable player and rival native endpoints. */
function rivalPeerApiAnchor(
  state: SimState,
  rivalId: string,
  model: Model,
): number | null {
  const kind = commercialModelKind(model);
  const ownValue = modelPriceValue(model);
  const normalized: number[] = [];
  for (const peer of state.player.models) {
    if (!isLivePublicModel(peer)) continue;
    if (commercialModelKind(peer) !== kind) continue;
    normalized.push(
      rivalListedApiPrice(state.player.pricing, peer) *
        (ownValue / modelPriceValue(peer)),
    );
  }
  for (const rival of state.rivals) {
    if (rival.id === rivalId) continue;
    const peer =
      rival.models.find(
        (candidate) => candidate.id === rival.pricing.activeModelId,
      ) ??
      rival.models.find((candidate) => commercialModelKind(candidate) === kind);
    if (!peer || commercialModelKind(peer) !== kind) continue;
    normalized.push(
      rivalListedApiPrice(rival.pricing, peer) *
        (ownValue / modelPriceValue(peer)),
    );
  }
  if (normalized.length === 0) return null;
  normalized.sort((a, b) => a - b);
  const mid = Math.floor(normalized.length / 2);
  return normalized.length % 2 === 1
    ? normalized[mid]!
    : (normalized[mid - 1]! + normalized[mid]!) / 2;
}

/** Keep legacy top-level tier prices and the enabled nested offers identical. */
export function synchronizeRivalPlanPrices(
  pricing: ProductPricing,
): ProductPricing {
  const plusPrice = Math.max(0, pricing.subPlusPrice);
  const proPrice = Math.max(plusPrice, pricing.subProPrice);
  return {
    ...pricing,
    subPlusPrice: plusPrice,
    subProPrice: proPrice,
    plans: pricing.plans.map((plan, index) => {
      const isPro =
        plan.id.toLowerCase().includes("pro") ||
        plan.name.toLowerCase().includes("pro") ||
        index > 0;
      return {
        ...plan,
        pricePerMonth: isPro ? proPrice : plusPrice,
      };
    }),
  };
}

/**
 * Keep serving plans referentially valid when the bounded rival fleet evicts an
 * older checkpoint. Existing routes retain their policy, but an unavailable or
 * no-longer-compatible primary is replaced by the best retained native model.
 */
function reconcileRivalPricingFleet(
  pricing: ProductPricing,
  models: readonly Model[],
): ProductPricing {
  const retainedIds = new Set(models.map((model) => model.id));
  const activeModelId =
    pricing.activeModelId && retainedIds.has(pricing.activeModelId)
      ? pricing.activeModelId
      : (models[0]?.id ?? null);
  const bestForModality = (modality: ModelIOModality) =>
    models
      .filter((model) => rivalRoutableModalities(model).includes(modality))
      .toSorted(
        (a, b) => b.capability - a.capability || b.releaseDay - a.releaseDay,
      )[0];

  return {
    ...pricing,
    activeModelId,
    apiModelIds: pricing.apiModelIds?.filter((modelId) =>
      retainedIds.has(modelId),
    ),
    apiServePrecisionByModel: pricing.apiServePrecisionByModel
      ? Object.fromEntries(
          Object.entries(pricing.apiServePrecisionByModel).filter(([modelId]) =>
            retainedIds.has(modelId),
          ),
        )
      : undefined,
    plans: pricing.plans.map((plan) => {
      const exposedModelIds = new Set(
        plan.modelIds.filter((modelId) => retainedIds.has(modelId)),
      );
      if (activeModelId) exposedModelIds.add(activeModelId);
      const modalityRoutes: NonNullable<typeof plan.modalityRoutes> = {};
      const servePrecisionByModel = Object.fromEntries(
        Object.entries(plan.servePrecisionByModel ?? {}).filter(([modelId]) =>
          retainedIds.has(modelId),
        ),
      );

      for (const modality of ["text", "image", "audio", "video"] as const) {
        const route = plan.modalityRoutes?.[modality];
        if (!route) continue;
        const routedPrimary = models.find(
          (model) =>
            model.id === route.primaryModelId &&
            rivalRoutableModalities(model).includes(modality),
        );
        const primary = routedPrimary ?? bestForModality(modality);
        if (!primary) continue;
        const fallback = models.find(
          (model) =>
            model.id === route.fallbackModelId &&
            model.id !== primary.id &&
            rivalRoutableModalities(model).includes(modality),
        );
        modalityRoutes[modality] = {
          ...route,
          primaryModelId: primary.id,
          fallbackModelId: fallback?.id ?? null,
        };
        exposedModelIds.add(primary.id);
        if (fallback) exposedModelIds.add(fallback.id);
        servePrecisionByModel[primary.id] = route.precision;
      }

      return {
        ...plan,
        modelIds: [...exposedModelIds],
        servePrecisionByModel,
        modalityRoutes,
      };
    }),
  };
}

/** Liquid seed reserve added after each rival's initial accelerator purchase. */
export const RIVAL_STARTING_CASH_RESERVE = 100_000_000;

export function createRivals(
  seed: number,
  count = 5,
  regionIds: string[] = ["west", "heartland", "north"],
  playerStartingValue = ECONOMY.startingCash,
  difficulty: SimState["config"]["difficulty"] = "normal",
): RivalLab[] {
  const rng = createRng(seed + 99);
  const regionAt = (i: number) =>
    regionIds[i % regionIds.length] ?? regionIds[0] ?? "west";
  const all: Omit<RivalLab, "dataMTok" | "dataQuality" | "domainMTok">[] = [
    {
      id: "rival_nova",
      name: "NovaScale",
      archetype: "hyperscale",
      cash: 4_200_000_000,
      chips: 2000,
      flopsPf: 800,
      utilCap: 0.55,
      servingEfficiency: 0.45,
      allocation: { training: 0.5, inference: 0.35, research: 0.15 },
      researchUnlocked: ["dense_basics"],
      models: [],
      pricing: {
        ...rivalPricing(12),
        activeModelId: null,
        subPlusPrice: 20,
        subProPrice: 45,
        enterpriseContractBonus: 0.2,
      },
      brandTrust: 62,
      activeResearch: null,
      researchProgress: 0,
      marketShare: 0.28,
      regionId: regionAt(0),
      color: 0x4da3ff,
    },
    {
      id: "rival_open",
      name: "OpenLattice",
      archetype: "open_weights",
      cash: 480_000_000,
      chips: 400,
      flopsPf: 160,
      utilCap: 0.48,
      servingEfficiency: 0.4,
      allocation: { training: 0.4, inference: 0.2, research: 0.4 },
      researchUnlocked: ["dense_basics"],
      models: [],
      pricing: {
        ...rivalPricing(0.8),
        activeModelId: null,
        subPlusPrice: 0,
        subProPrice: 0,
        enterpriseContractBonus: 0,
      },
      brandTrust: 70,
      activeResearch: null,
      researchProgress: 0,
      marketShare: 0.18,
      regionId: regionAt(1),
      color: 0xa0a8b8,
    },
    {
      id: "rival_sparse",
      name: "Sparseform",
      archetype: "efficiency",
      cash: 1_100_000_000,
      chips: 900,
      flopsPf: 380,
      utilCap: 0.5,
      servingEfficiency: 0.42,
      allocation: { training: 0.35, inference: 0.4, research: 0.25 },
      researchUnlocked: ["dense_basics"],
      models: [],
      pricing: {
        ...rivalPricing(5.5),
        activeModelId: null,
        subPlusPrice: 15,
        subProPrice: 30,
        enterpriseContractBonus: 0,
      },
      brandTrust: 52,
      activeResearch: null,
      researchProgress: 0,
      marketShare: 0.15,
      regionId: regionAt(2),
      color: 0x3dffc0,
    },
    {
      id: "rival_chroma",
      name: "Chroma Studio",
      archetype: "multimodal",
      cash: 720_000_000,
      chips: 500,
      flopsPf: 200,
      utilCap: 0.46,
      servingEfficiency: 0.38,
      allocation: { training: 0.45, inference: 0.35, research: 0.2 },
      researchUnlocked: ["dense_basics"],
      models: [],
      pricing: {
        ...rivalPricing(9),
        activeModelId: null,
        subPlusPrice: 22,
        subProPrice: 48,
        enterpriseContractBonus: 0,
      },
      brandTrust: 58,
      activeResearch: null,
      researchProgress: 0,
      marketShare: 0.12,
      regionId: regionAt(0),
      color: 0xff6b4a,
    },
    {
      id: "rival_aegis",
      name: "Aegis Labs",
      archetype: "safety",
      cash: 980_000_000,
      chips: 450,
      flopsPf: 180,
      utilCap: 0.5,
      servingEfficiency: 0.4,
      allocation: { training: 0.3, inference: 0.35, research: 0.35 },
      researchUnlocked: ["dense_basics"],
      models: [],
      pricing: {
        ...rivalPricing(14),
        activeModelId: null,
        subPlusPrice: 28,
        subProPrice: 60,
        enterpriseContractBonus: 0.5,
      },
      brandTrust: 78,
      activeResearch: null,
      researchProgress: 0,
      marketShare: 0.12,
      regionId: regionAt(1),
      color: 0xb07cff,
    },
  ];
  void rng;
  // Retained in the public constructor for save/API compatibility. Difficulty
  // affects controller policy in tickRivals, never starting resource yields.
  void difficulty;
  return all
    .slice(0, Math.max(1, Math.min(all.length, count)))
    .map((r, index) => {
      // Difficulty changes forecasting, planning cadence, and risk tolerance in
      // rivalDifficultyPace; it never changes underlying starting resources.
      const valueRng = createRng(hashSeed(seed, r.id, "starting-value"));
      const [lo, hi] = [0.8, 1.25];
      const targetValue = playerStartingValue * valueRng.range(lo, hi);
      const assetShare =
        r.archetype === "hyperscale"
          ? 0.58
          : r.archetype === "efficiency"
            ? 0.48
            : r.archetype === "open_weights"
              ? 0.32
              : 0.42;
      const chips = Math.max(
        24,
        Math.floor((targetValue * assetShare) / 313_500),
      );
      // Every lab buys the same accelerator generation from the shared market.
      // Efficiency is earned through architecture, systems, and serving policy;
      // it must not receive more raw PF per chip.
      const flopsPf = chips * 0.7;
      const operatingCash = Math.max(0, targetValue - chips * 313_500);
      const cash = RIVAL_STARTING_CASH_RESERVE + operatingCash;
      // Same 500 MTok starter corpus as the player — data-limited early game
      const data = createEmptyLabData();
      const dataMTok = totalProcessed(data);
      const staff = {
        researcher:
          r.archetype === "hyperscale" ? 3 : r.archetype === "safety" ? 2 : 1,
        data_processor: 1,
        engineer: r.archetype === "hyperscale" ? 2 : 1,
        ops: 1,
      };
      const leadProfiles = [
        {
          name: "Dr. Sanaa Okafor",
          focus: "scaling" as const,
          specialties: { reasoning: 0.84, science: 0.7 },
          traits: ["frontier planner", "decisive coordinator"],
        },
        {
          name: "Ilya Navarro",
          focus: "data" as const,
          specialties: { code: 0.86, math: 0.75 },
          traits: ["open methods", "careful verifier"],
        },
        {
          name: "Dr. Meilin Park",
          focus: "systems" as const,
          specialties: { code: 0.82, tools: 0.8 },
          traits: ["efficiency hunter", "systems pragmatist"],
        },
        {
          name: "Amara Bell",
          focus: "exploration" as const,
          specialties: { vision: 0.88, video: 0.82, audio: 0.72 },
          traits: ["multimodal intuition", "creative director"],
        },
        {
          name: "Dr. Tomas Varga",
          focus: "evals" as const,
          specialties: { science: 0.78, reasoning: 0.76 },
          traits: ["trust specialist", "methodical reviewer"],
        },
      ];
      const leadProfile = leadProfiles[index] ?? leadProfiles[0]!;
      const leadId = `lead-${r.id}-founding`;
      return {
        ...r,
        pricing: synchronizeRivalPlanPrices(r.pricing),
        cash,
        chips,
        flopsPf,
        data,
        dataMTok,
        dataQuality: 0.95,
        domainMTok: {
          chat: data.stocks.chat.processed,
          code: data.stocks.code.processed,
        },
        trainingJob: null,
        researchQueue: [],
        trainPreferSynthHQ: true,
        trainAllowSynthLQ: false,
        // Start lean — must hire like the player; hyperscalers a bit ahead
        staff,
        researchLeads: [
          {
            id: leadId,
            name: leadProfile.name,
            skills: {
              algorithms: r.archetype === "hyperscale" ? 0.86 : 0.76,
              systems: r.archetype === "efficiency" ? 0.9 : 0.72,
              dataEvals:
                r.archetype === "safety" || r.archetype === "open_weights"
                  ? 0.88
                  : 0.7,
              leadership: 0.76,
            },
            specialties: leadProfile.specialties,
            traits: leadProfile.traits,
            reputation: 58 + index * 2,
            morale: 78,
            salaryPerDay: 3_000 + index * 150,
          },
        ],
        researchPods: [
          {
            id: `pod-${r.id}-founding`,
            name: `${r.name} Founding Pod`,
            leadId,
            focus: leadProfile.focus,
            researchers: staff.researcher,
            engineers: staff.engineer,
            dataStaff: staff.data_processor,
            assignmentId: null,
          },
        ],
        researchPrograms: [],
        trainingPrograms: [],
        researchDaysSpent: 0,
        capital: initialRivalCapital(r.id),
      } satisfies RivalLab;
    });
}

export function tickRivals(state: SimState): SimState {
  const news: string[] = [];
  const rivalBoost = state.activeEvents.reduce(
    (m, e) => m + (e.effects.rivalBoost ?? 0),
    0,
  );
  const pace = rivalDifficultyPace(state.config?.difficulty ?? "normal");
  const playerCap = state.player.models.reduce(
    (best, model) =>
      Math.max(
        best,
        isLivePublicModel(model) ? model.capability : 0,
      ),
    0,
  );
  const playerApi = state.player.pricing.apiPricePerMTok;
  const playerShare = state.player.finance.totalShare;
  const unserved = state.lastMarket.unservedRatio;
  const competitiveResponse = competitiveCatchUpSnapshot(state);

  const rivals = state.rivals.map((unboundedRival) => {
    try {
    const r = boundRivalTrainingHistory(unboundedRival);
    // Physical facilities/contracts do not change while this controller plans
    // its day. Resolve that expensive compact-world snapshot once, while still
    // applying the evolving allocation/staff fields from `next` below.
    const physicalCompute = computeLabSnapshot(state, r.id);
    const effectiveFlopsPf = physicalCompute.rawFlopsPf;
    let next: RivalLab = {
      ...r,
      pricing: synchronizeRivalPlanPrices(r.pricing),
      models: r.models.map((m) => ({
        ...m,
        quality: { ...m.quality },
        benchmarks: { ...m.benchmarks },
      })),
      releaseMilestones: normalizeRivalReleaseMilestones(r),
      financialComeback: r.financialComeback
        ? {
            ...r.financialComeback,
            researchUnlocked: r.financialComeback.researchUnlocked
              ? [...r.financialComeback.researchUnlocked]
              : undefined,
            modalityExperience: r.financialComeback.modalityExperience
              ? { ...r.financialComeback.modalityExperience }
              : undefined,
          }
        : undefined,
      researchUnlocked: [...r.researchUnlocked],
      researchQueue: [...(r.researchQueue ?? [])],
      researchLeads: (r.researchLeads ?? []).map((lead) => ({
        ...lead,
        skills: { ...lead.skills },
        specialties: { ...lead.specialties },
        traits: [...lead.traits],
      })),
      researchPods: (r.researchPods ?? []).map((pod) => ({ ...pod })),
      researchPrograms: (r.researchPrograms ?? []).map((program) => ({
        ...program,
        evidence: program.evidence.map((item) => ({ ...item })),
      })),
      trainingPrograms: (r.trainingPrograms ?? []).map((program) => ({
        ...program,
        targetSegments: [...program.targetSegments],
        assignedPodIds: [...program.assignedPodIds],
        pilots: program.pilots.map((pilot) => ({ ...pilot })),
        checkpoints: program.checkpoints.map((checkpoint) => ({
          ...checkpoint,
        })),
        domainForecasts: { ...program.domainForecasts },
        integratedMethods: [...program.integratedMethods],
      })),
      data: ensureRivalData(r),
      trainingJob: r.trainingJob ? { ...r.trainingJob } : null,
      trainPreferSynthHQ: r.trainPreferSynthHQ ?? true,
      trainAllowSynthLQ: r.trainAllowSynthLQ ?? false,
      strategy: r.strategy
        ? {
            ...r.strategy,
            beliefs: { ...r.strategy.beliefs },
            plan: [...r.strategy.plan],
            memory: r.strategy.memory.map((record) => ({ ...record })),
            cooldowns: { ...r.strategy.cooldowns },
          }
        : undefined,
    };
    next.strategy = advanceRivalStrategy(next, state);
    const strategy = next.strategy;
    const synthRng = rivalActionRng(
      state.seed,
      next.id,
      strategy.decisionRevision,
      state.day,
      "operational",
      "synthetic-data",
    );
    const pricingRng = rivalActionRng(
      state.seed,
      next.id,
      strategy.decisionRevision,
      state.day,
      "tactical",
      "pricing",
    );
    const trainingRng = rivalActionRng(
      state.seed,
      next.id,
      strategy.decisionRevision,
      state.day,
      "strategic",
      "training",
    );
    const releaseRng = rivalActionRng(
      state.seed,
      next.id,
      strategy.decisionRevision,
      state.day,
      "strategic",
      "release",
    );
    let data = next.data!;
    const isCatchUpChallenger =
      competitiveResponse.active && competitiveResponse.rivalId === next.id;

    // ── Allocation AI (same three pools as player) ──
    {
      const baseAllocation = rivalAllocationPolicy(next.archetype, {
        training: !!next.trainingJob,
        hasModel: next.models.length > 0,
        overload: (next.lastUnserved ?? 0) > 0.15,
      });
      next = applyLabActionToTarget(next, {
        kind: "set_allocation",
        allocation: allocationForRivalStrategy(baseAllocation, strategy),
      });
      if (isCatchUpChallenger && next.trainingJob) {
        next = applyLabActionToTarget(next, {
          kind: "set_allocation",
          allocation: { training: 0.68, inference: 0.22, research: 0.1 },
        });
      }
    }

    // ── Shared data runtime; archetype changes priorities, never yields ──
    const share = state.lastMarket.sharesByLab[r.id] ?? next.marketShare;
    const collection = collectTrafficData({
      data,
      servedMTok: (state.lastMarket.industryServedMTok ?? 0) * share,
      demandMTok: (state.lastMarket.industryDemandMTok ?? 0) * share,
      brandTrust: next.brandTrust,
      dataFlywheel: aggregateEffects(next.researchUnlocked).dataFlywheel ?? 0,
      segments: state.segments,
    });
    data = collection.data;
    data.dayProcessed = 0;
    data.daySynthMTok = 0;
    next.brandTrust = collection.brandTrust;
    data = enqueueAutomaticProcessing({
      data,
      day: state.day,
      labId: next.id,
      dataQuality: next.dataQuality,
      staff: next.staff,
      priorityDomains: rivalDataPriority(next.archetype),
    });
    const dataEffects = aggregateEffects(next.researchUnlocked);
    const processing = processDataJobs({
      data,
      cash: next.cash,
      throughputMTok: dataProcessingThroughput({
        staff: next.staff,
        researchPf: rivalResearchPf(next, state, effectiveFlopsPf),
        labSites: rivalLabSiteCount(state, next.id),
        dataFlywheel: dataEffects.dataFlywheel ?? 0,
      }),
      dataQuality: next.dataQuality,
      staff: next.staff,
      day: state.day,
    });
    data = processing.data;
    next.cash = processing.cash;
    next.dataMTok = totalProcessed(data);
    next.domainMTok = {
      chat: data.stocks.chat.processed,
      code: data.stocks.code.processed,
    };
    next.data = data;

    // ── Research tree — same gates/cost/staff/compute rules as player ──
    {
      const staff = next.staff ?? {
        researcher: 0,
        data_processor: 0,
        engineer: 0,
        ops: 0,
      };
      const researchers = staff.researcher ?? 0;
      const engineers = staff.engineer ?? 0;
      const licensedPlayerMethods = new Set(
        (state.player.researchPrograms ?? [])
          .filter((program) => program.disclosure === "licensed")
          .map((program) => program.methodId),
      );
      const baseCostMult = state.config?.researchCostMult ?? 1;
      // Base research PF from allocation × util (engineers already in util).
      // Once Synthetic Generators is unlocked and a capable teacher exists,
      // rivals distill their own data every day (same rules as the player).
      const synthEligible =
        next.researchUnlocked.includes("data_synth") &&
        next.models[0] != null &&
        next.models[0].capability >= 38;
      const totalResearchPf =
        rivalResearchPf(next, state, effectiveFlopsPf) *
        pace.researchSpeed *
        (1 + rivalBoost);
      const synthShare = synthEligible ? 0.35 : 0;
      const baseRPf = totalResearchPf * (1 - synthShare);

      // Pick / continue active research
      if (!next.activeResearch) {
        if (next.archetype === "multimodal") {
          const productPath = planRivalResearchPath(next, strategy, state.seed);
          const productTarget = productPath.at(-1);
          if (
            productTarget &&
            RIVAL_MULTIMODAL_RESEARCH_LADDER.includes(
              productTarget as (typeof RIVAL_MULTIMODAL_RESEARCH_LADDER)[number],
            )
          ) {
            next = applyLabActionToTarget(next, {
              kind: "queue_research",
              nodeId: productTarget,
            });
            const preferred = new Set(productPath);
            next.researchQueue = [
              ...productPath.filter((nodeId) =>
                next.researchQueue?.includes(nodeId),
              ),
              ...(next.researchQueue ?? []).filter(
                (nodeId) => !preferred.has(nodeId),
              ),
            ];
          }
        }
        let queuedNodeId = next.researchQueue?.find(
          (nodeId) =>
            canLabResearchNode(next.researchUnlocked, researchers, nodeId).ok,
        );
        // A deep queued node can become temporarily unrunnable after strategy
        // or staffing changes. Keep it deferred, but continue filling the
        // queue with an independently runnable product path instead of letting
        // one staff gate freeze the entire lab.
        if (!queuedNodeId) {
          const path =
            (next.researchQueue?.length ?? 0) === 0 && strategy.plan.length > 0
              ? strategy.plan
              : planRivalResearchPath(next, strategy, state.seed);
          const target = path.at(-1);
          if (target) {
            next = applyLabActionToTarget(next, {
              kind: "queue_research",
              nodeId: target,
            });
          }
          queuedNodeId = next.researchQueue?.find(
            (nodeId) =>
              canLabResearchNode(next.researchUnlocked, researchers, nodeId).ok,
          );
        }
        if (queuedNodeId && baseRPf > 0.02) {
          const queuedNode = getResearchNode(queuedNodeId);
          next.activeResearch = queuedNode.id;
          next.researchQueue = (next.researchQueue ?? []).filter(
            (nodeId) => nodeId !== queuedNode.id,
          );
          next.strategy = {
            ...strategy,
            plan: strategy.plan.filter((nodeId) => nodeId !== queuedNode.id),
          };
          next.researchProgress = 0;
          next.researchDaysSpent = 0;
          const pod = (next.researchPods ?? []).find(
            (candidate) => candidate.assignmentId == null,
          );
          if (pod) {
            const program: ResearchProgram = {
              id: `research-${next.id}-${queuedNode.id}-${state.day}`,
              methodId: queuedNode.id,
              podId: pod.id,
              phase: "hypothesis",
              evidence: [],
              insightProgress: 0,
              engineeringProgress: 0,
              computeShare: next.allocation.research,
              disclosure: "secret",
            };
            next.researchPrograms = [...(next.researchPrograms ?? []), program];
            next.researchPods = (next.researchPods ?? []).map((candidate) =>
              candidate.id === pod.id
                ? { ...candidate, assignmentId: program.id }
                : candidate,
            );
          }
        }
      }

      if (next.activeResearch) {
        const node = getResearchNode(next.activeResearch);
        // Player-owned licenses remain learnable, but patent workarounds and
        // negotiation add a meaningful research burden for every rival.
        const costMult =
          baseCostMult * (licensedPlayerMethods.has(node.id) ? 1.45 : 1);
        const gate = canLabResearchNode(
          next.researchUnlocked,
          researchers,
          next.activeResearch,
        );
        // Same progress formula as player (researchers + engineers + PF)
        const uncappedProgress = gate.ok
          ? labResearchDayProgress({
              researchers,
              engineers,
              researchPf: baseRPf,
              nodeId: next.activeResearch,
              labResearchMult: 1,
            })
          : 0;
        const cashRate = researchCashPerPf(node);
        const dayProg = Math.min(
          uncappedProgress,
          cashRate > 0 ? Math.max(0, next.cash / cashRate) : uncappedProgress,
        );
        next.cash = Math.max(0, next.cash - dayProg * cashRate);
        next.researchProgress = (next.researchProgress ?? 0) + dayProg;
        next.researchDaysSpent = (next.researchDaysSpent ?? 0) + 1;

        // Same completion rules as player: PF target + calendar floor
        // (extra researchers compress calendar floor)
        const pfTarget = researchPfTargetForNode(node, costMult);
        const daysTarget = researchDaysTarget(node, researchers);
        const activeProgram = (next.researchPrograms ?? []).find(
          (program) =>
            program.methodId === next.activeResearch &&
            program.phase !== "complete",
        );
        if (activeProgram) {
          const progress = Math.min(
            1,
            (next.researchProgress ?? 0) / Math.max(0.001, pfTarget),
          );
          const phase: ResearchProgram["phase"] =
            progress < 0.15
              ? "hypothesis"
              : progress < 0.4
                ? "pilot"
                : progress < 0.7
                  ? "validation"
                  : "integration";
          next.researchPrograms = (next.researchPrograms ?? []).map(
            (program) =>
              program.id === activeProgram.id
                ? {
                    ...program,
                    phase,
                    insightProgress: Math.min(1, progress * 1.35),
                    engineeringProgress: Math.max(0, (progress - 0.35) / 0.65),
                    computeShare: next.allocation.research,
                  }
                : program,
          );
        }
        if (
          gate.ok &&
          next.researchProgress >= pfTarget &&
          (next.researchDaysSpent ?? 0) >= daysTarget
        ) {
          if (!next.researchUnlocked.includes(node.id)) {
            next.researchUnlocked = [...next.researchUnlocked, node.id];
            news.push(
              `Day ${state.day}: ${next.name} unlocks ${node.name.replace(/_/g, " ")}.`,
            );
          }
          // Full shared effect apply (util, serve, data quality, brand…)
          const applied = applyResearchEffectsToLab(
            {
              utilCap: next.utilCap,
              servingEfficiency: next.servingEfficiency,
              brandTrust: next.brandTrust,
              dataQuality: next.dataQuality,
            },
            node.effects,
          );
          next = {
            ...next,
            utilCap: applied.utilCap,
            servingEfficiency: applied.servingEfficiency,
            brandTrust: applied.brandTrust,
            dataQuality: applied.dataQuality ?? next.dataQuality,
          };
          if (activeProgram) {
            const disclosure = rivalResearchDisclosure(next.archetype);
            next.researchPrograms = (next.researchPrograms ?? []).map(
              (program) =>
                program.id === activeProgram.id
                  ? {
                      ...program,
                      phase: "complete",
                      insightProgress: 1,
                      engineeringProgress: 1,
                      disclosure,
                      evidence: [
                        ...program.evidence,
                        {
                          id: `evidence-${program.id}-${state.day}`,
                          strength: Math.min(1, 0.55 + researchers * 0.04),
                          source: "pilot",
                          day: state.day,
                        },
                      ],
                    }
                  : program,
            );
            next.researchPods = (next.researchPods ?? []).map((pod) =>
              pod.assignmentId === activeProgram.id
                ? { ...pod, assignmentId: null }
                : pod,
            );
            if (disclosure !== "secret") {
              news.push(
                `Day ${state.day}: ${next.name} ${disclosure === "published" ? "publishes" : "licenses"} ${node.name}.`,
              );
            }
          }
          next.researchProgress = 0;
          next.researchDaysSpent = 0;
          next.activeResearch = null;
        }
      }

      // Optional synth gen once unlocked (same rules as player)
      if (synthEligible && next.models[0]) {
        const teacher = next.models[0];
        const wantHQ =
          next.trainPreferSynthHQ !== false && teacher.capability >= 40;
        const tier: "hq" | "lq" = wantHQ ? "hq" : "lq";
        // Rivals may risk LQ when desperate for volume
        const useLq =
          next.trainAllowSynthLQ ||
          (totalProcessed(data) < minDataMTokForParams(3) &&
            synthRng.range(0, 1) < 0.35);
        const finalTier = useLq && !wantHQ ? "lq" : tier;
        const ranked = rivalDataPriority(next.archetype)
          .map((domain) => ({
            domain,
            fit: synthTeacherFit(teacher, domain),
          }))
          .sort((left, right) => right.fit.overallFit - left.fit.overallFit);
        const chosen = ranked[0] ?? {
          domain: "chat" as DataDomain,
          fit: synthTeacherFit(teacher, "chat"),
        };
        const dom = chosen.domain;
        const researchPf =
          rivalResearchPf(next, state, effectiveFlopsPf) * synthShare;
        const attempted = syntheticGenerationMTokPerDay({
          domain: dom,
          teacherDomainCapability: teacherCapabilityForDataDomain(teacher, dom),
          teacherReliability: teacher.quality.reliability,
          researchPf,
          tier: finalTier,
          activeParamsB: synthTeacherActiveParamsB(teacher),
          family: teacher.family,
        });
        const fit = chosen.fit;
        const chances = synthAcceptanceChances({
          domain: dom,
          domainCapability: fit.domainCapability,
          overallFit: fit.overallFit,
          modalityFit: fit.modalityFit,
          toolFit: fit.toolFit,
          reliability: teacher.quality.reliability,
          researchPf,
        });
        const useful = attempted * chances.usefulChance;
        const hq = useful * chances.hqChance;
        const lq = useful - hq;
        const step = useful;
        if (step > 1e-4) {
          const st = normalizeDomainStock(data.stocks[dom]);
          // One canonical lineage per lab/domain/tier. Retired teacher models
          // remain in bounded provenance instead of creating an unbounded
          // asset and ever-larger manifest snapshot every generation.
          const syntheticAssetId = `dataset-${next.id}-${dom}-${finalTier}`;
          const priorSynthetic = data.assets?.find(
            (asset) => asset.id === syntheticAssetId,
          );
          const generationDepth =
            1 +
            (data.assets ?? []).filter(
              (asset) =>
                asset.id !== syntheticAssetId &&
                asset.source === "synthetic" &&
                asset.synthetic?.teacherModelIds.includes(teacher.id) &&
                (asset.domainWeights[dom] ?? 0) > 0,
            ).length;
          const syntheticAsset = syntheticDatasetAsset({
            id: syntheticAssetId,
            name: `${next.name} ${DATA_DOMAIN_META[dom].label} synthetic lineage`,
            domain: dom,
            volumeMTok: step,
            quality: 0,
            teacherModelId: teacher.id,
            tier: finalTier,
            day: state.day,
            provenance: { generationDepth },
          });
          const syntheticQuality = estimateSyntheticQuality({
            domain: dom,
            teacherDomainCapability: teacherCapabilityForDataDomain(
              teacher,
              dom,
            ),
            provenance: syntheticAsset.synthetic!,
          }).quality;
          const processedBefore = st.processed;
          st.processed += step;
          st.fromSynth += step;
          st.fromSynthHQ += hq;
          st.fromSynthLQ += lq;
          st.quality =
            st.processed > 0
              ? (st.quality * processedBefore + syntheticQuality * step) /
                st.processed
              : syntheticQuality;
          data.stocks[dom] = st;
          data = appendDatasetAsset(
            data,
            mergeSyntheticDatasetAsset(priorSynthetic, {
              ...syntheticAsset,
              quality: syntheticQuality,
            }),
          );
          data.daySynthMTok += step;
          data.dayProcessed += step;
          data.lifetimeProcessed += step;
          data.lifetimeCollected += step;
        }
      }
      next.dataQuality = updateDataQualityIndex(next.dataQuality, data);
      next.dataMTok = totalProcessed(data);
      next.domainMTok = {
        chat: data.stocks.chat.processed,
        code: data.stocks.code.processed,
      };
      next.data = data;
    }

    if (next.archetype === "safety") {
      const pm = state.player.models.find(
        (m) =>
          m.id === state.player.pricing.activeModelId &&
          isLivePublicModel(m),
      );
      if (pm && pm.quality.safety < 45) {
        next.brandTrust = Math.min(100, next.brandTrust + 0.15);
      }
    }

    // ── Pricing AI: react to own quality, player price, share, flops ──
    {
      const m =
        next.models.find((model) => model.id === next.pricing.activeModelId) ??
        next.models[0];
      if (m && strategy.lastTacticalDay === state.day) {
        const targetGrossMargin =
          next.archetype === "open_weights"
            ? 0.12
            : next.archetype === "efficiency"
              ? 0.42
              : next.archetype === "hyperscale"
                ? 0.38
                : 0.32;
        const sustainableCostIn =
          Math.max(0.01, m.costApiPriceIn ?? 0.1) / (1 - targetGrossMargin);
        const sustainableCostOut =
          Math.max(0.01, m.costApiPriceOut ?? 0.4) / (1 - targetGrossMargin);
        const costFloor = blendApiPrice(sustainableCostIn, sustainableCostOut);
        const capGap = m.capability - (playerCap || m.capability * 0.9);
        // Stronger than player → premium; weaker → discount; open weights stay cheap
        let targetMult = rivalHostedServicePriceMultiplier(
          next.archetype,
          capGap,
        );
        if (unserved > 0.15 && playerShare > 0.08) targetMult *= 0.92; // undercut overloaded player
        if (share < 0.06 && m.capability > 8) targetMult *= 0.9; // buy share
        // Flop discount only for broken/under-trained; early millions-era is ~5–10.
        if (m.quality.reliability < 35 || m.capability < 5) targetMult *= 0.75; // flop discount
        if (next.archetype === "safety" && m.quality.safety > 60)
          targetMult *= 1.08;

        const peerAnchor = rivalPeerApiAnchor(state, next.id, m);
        const anchor = Math.max(
          0.05,
          peerAnchor ?? (playerApi || next.pricing.apiPricePerMTok),
        );
        let target = Math.max(
          costFloor,
          anchor *
            targetMult *
            (1 + pricingRng.range(-pace.forecastNoise, pace.forecastNoise)),
        );
        if (next.archetype === "open_weights") target = Math.min(target, 1.4);
        // Smooth move toward target
        const current = Math.max(0.01, next.pricing.apiPricePerMTok);
        const proposed = current * 0.78 + target * 0.22;
        // Tactical repricing is deliberately gradual: no more than 8% per
        // review, even when a competitor or cost shock moves abruptly.
        const blended = Math.max(
          current * 0.92,
          Math.min(current * 1.08, proposed),
        );
        // The policy must reach the actual offer. Previously only the lab
        // default moved while this model kept its launch suggestion, so every
        // market and milestone ignored ten years of rival pricing decisions.
        const list = splitBlendedApiPrice(blended);
        const listIn = Math.max(sustainableCostIn, list.priceIn);
        const listOut = Math.max(sustainableCostOut, list.priceOut);
        const nextPlusPrice = Math.max(
          0,
          next.pricing.subPlusPrice * 0.9 +
            Math.min(80, 8 + m.capability * 0.55) * 0.1,
        );
        const generosity =
          next.archetype === "hyperscale"
            ? 1.35
            : next.archetype === "efficiency"
              ? 1.2
              : next.archetype === "open_weights"
                ? 1.5
                : 1;
        const plusIncluded =
          ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth * generosity;
        const nextProPrice = Math.max(nextPlusPrice, nextPlusPrice * 2.25);
        const servePrecision = chooseRivalServePrecision(next);
        // Rival offers face the same premium-tier scrutiny as the player:
        // above $180/mo, customers expect at least 20× entry-tier usage.
        const proIncluded = plusIncluded * (nextProPrice > 180 ? 20 : 5);
        next.pricing = {
          ...next.pricing,
          subPlusPrice: nextPlusPrice,
          subProPrice: nextProPrice,
          plusIncludedMTok: plusIncluded,
          proIncludedMTok: proIncluded,
          plans: [
            {
              ...(next.pricing.plans[0] ?? rivalPricing(blended).plans[0]!),
              pricePerMonth: nextPlusPrice,
              includedMTokPerMonth: plusIncluded,
              usageMultiplier:
                plusIncluded /
                (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth),
              modelIds: next.models.map((model) => model.id),
              servePrecision,
            },
            {
              ...(next.pricing.plans[1] ?? rivalPricing(blended).plans[1]!),
              pricePerMonth: nextProPrice,
              includedMTokPerMonth: proIncluded,
              usageMultiplier:
                proIncluded /
                (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth),
              modelIds: next.models.map((model) => model.id),
              servePrecision,
            },
          ],
        };
        next = applyLabActionToTarget(next, {
          kind: "set_api_price",
          modelId: m.id,
          input: listIn,
          output: listOut,
        });
        next = applyLabActionToTarget(next, {
          kind: "set_api_precision",
          modelId: m.id,
          precision: servePrecision,
        });
        for (const modality of ["text", "image", "audio", "video"] as const) {
          const primary = next.models
            .filter((model) =>
              rivalRoutableModalities(model).includes(modality),
            )
            .toSorted(
              (a, b) =>
                b.capability - a.capability || b.releaseDay - a.releaseDay,
            )[0];
          if (!primary) continue;
          for (const plan of next.pricing.plans) {
            next = applyLabActionToTarget(next, {
              kind: "configure_plan_route",
              planId: plan.id,
              route: {
                modality,
                primaryModelId: primary.id,
                fallbackModelId: null,
                premiumShare: 1,
                precision: servePrecision,
              },
            });
          }
        }
      }
    }

    // ── Multi-day training job (same scale formula + data coverage as player) ──
    const cadence =
      pace.releaseCadence +
      (hashSeed(state.seed, next.id, "release-cadence") % 3);
    const canStartTrain = rivalTrainPf(next, state, effectiveFlopsPf) > 0.02;
    const corpus = totalProcessed(next.data!);
    next.dataMTok = corpus;

    // Progress active job with train PF
    if (next.trainingJob) {
      let job = { ...next.trainingJob };
      const burn = job.cashBurnPerDay ?? 0;
      const memoryReady = rivalTrainingMemoryReady(next, job, physicalCompute);
      const canFund = memoryReady;
      if (canFund && burn > 0) {
        next.cash = Math.max(0, next.cash - Math.min(burn, next.cash));
      }
      const trainingNumerics = job.trainingNumerics ?? LEGACY_TRAINING_NUMERICS;
      job.trainingNumerics = trainingNumerics;
      const formatThroughput = trainingFormatThroughput(
        rivalTrainingHardwareGeneration(next),
        trainingNumerics,
      );
      const baseTrainPf = canFund
        ? rivalTrainPf(next, state, effectiveFlopsPf) *
          pace.researchSpeed *
          formatThroughput
        : 0;
      job = progressRivalTrainingJob(job, job.paused ? 0 : baseTrainPf).job;
      const program = (next.trainingPrograms ?? []).find(
        (candidate) => candidate.id === job.id,
      );
      if (program) {
        const completion =
          job.progressPfDays / Math.max(0.001, job.targetPfDays);
        const existing = new Set(
          program.checkpoints.map((checkpoint) => checkpoint.progress),
        );
        const reached = [0.25, 0.5, 0.75].filter(
          (threshold) => completion >= threshold && !existing.has(threshold),
        );
        if (reached.length > 0) {
          const stability =
            job.outcomeRisk === "high"
              ? 0.58
              : job.outcomeRisk === "medium"
                ? 0.72
                : 0.84;
          next.trainingPrograms = (next.trainingPrograms ?? []).map(
            (candidate) =>
              candidate.id === job.id
                ? {
                    ...candidate,
                    confidence: Math.min(
                      0.92,
                      candidate.confidence + reached.length * 0.07,
                    ),
                    checkpoints: [
                      ...candidate.checkpoints,
                      ...reached.map((threshold) => ({
                        id: `checkpoint-${job.id}-${threshold}`,
                        progress: threshold,
                        day: state.day,
                        stability,
                        reusable: true,
                        trainingNumerics,
                      })),
                    ],
                  }
                : candidate,
          );
        }
      }
      if (job.progressPfDays >= job.targetPfDays) {
        // Finalize via shared buildScaledModel (data shortfall / LQ → capability hit)
        const gen =
          1 +
          Math.floor(
            Math.max(0, state.day - RIVAL_FIRST_RELEASE_DAY) /
              Math.max(10, cadence),
          );
        const baseName = next.name.split(" ")[0] ?? next.name;
        const newName =
          next.archetype === "open_weights"
            ? `Lattice-${Math.max(1, Math.round(job.paramsB))}B`
            : next.archetype === "efficiency"
              ? `Sparse-${gen}`
              : next.archetype === "multimodal"
                ? `Chroma-${gen}`
                : next.archetype === "safety"
                  ? `Aegis-${gen}`
                  : `${baseName}-${gen}.${releaseRng.int(0, 9)}`;

        const completedProgram = (next.trainingPrograms ?? []).find(
          (candidate) => candidate.id === job.id,
        );
        const runManifest = completedProgram?.dataManifestId
          ? next.data?.manifests?.find(
              (manifest) => manifest.id === completedProgram.dataManifestId,
            )
          : undefined;
        const completedProductPreset =
          job.productPreset ??
          (job.family === "diffusion"
            ? "image_generation"
            : job.family === "video"
              ? "video_generation"
              : job.family === "omni"
                ? "omni"
                : "language");
        const completedIo = job.io ?? ioForPreset(completedProductPreset);
        const runWeights =
          runManifest?.domainWeights ??
          rivalProductTrainingWeights(
            next.archetype,
            job.family,
            completedProductPreset,
          );
        const trainingModifiers = rivalResearchTrainingModifiers(
          next.researchUnlocked,
          job.family,
          job.backbone,
        );
        const modalityExperience = modalityExperienceCounts(next.models);
        const modalityMaturityByDomain = Object.fromEntries(
          (["image", "audio", "video"] as const)
            .filter((modality) => job.modalities.includes(modality))
            .map((modality) => [
              modality,
              modalityMaturity(modalityExperience[modality]),
            ]),
        );
        let released = buildScaledModel({
          id: `${next.id}-r${state.day}`,
          name: newName,
          paramsB: job.paramsB,
          activeParamsB: job.activeParamsB,
          family: job.family,
          backbone: job.backbone,
          productPreset: completedProductPreset,
          io: completedIo,
          modalities: job.modalities,
          day: state.day,
          dataCoverage: job.effectiveDataRatio ?? job.dataCoverage,
          dataQuality: job.dataQuality,
          mixWeights: runWeights,
          trainShare: job.trainShare,
          postTrainShare: job.postTrainShare,
          recipeTotalMTok:
            (job.totalMTok ?? 0) + (job.postTrainMTok ?? 0),
          researchUnlocked: next.researchUnlocked,
          researchMult: trainingModifiers.researchMult,
          postTrain: highestPostTrainStage(
            postTrainStagesFromResearch(next.researchUnlocked),
          ),
          synthLqShare: job.synthLqShare,
          outcomeSeed:
            job.outcomeSeed ??
            hashSeed(state.seed, next.id, job.id, "train-outcome"),
          engineers: next.staff?.engineer ?? 0,
          effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage,
          repeatedDataEpochs: job.repeatedDataEpochs ?? 1,
          openWeights: next.archetype === "open_weights",
          trainingNumerics,
          modalityExperience,
          shipped: true,
          release: "released",
        });
        released = applyRivalReleaseLuck(
          released,
          rivalReleaseLuckBonus(releaseRng.next(), releaseRng.next()),
        );
        released = {
          ...released,
          trainComputeSpent: job.progressPfDays,
          trainingNumerics,
          capabilities: deriveModelCapabilities({
            finalCapability: released.capability,
            trainComputePfDays: job.progressPfDays,
            effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage,
            dataQuality: job.dataQuality,
            domainWeights: runWeights,
            io: completedIo,
            family: released.family,
            postTrain: released.postTrain,
            quality: released.quality,
            modalityMaturity: modalityMaturityByDomain,
          }),
        };
        if (completedProgram) {
          released = {
            ...released,
            dataManifestId: completedProgram.dataManifestId ?? undefined,
            integratedMethods: [...completedProgram.integratedMethods],
          };
          next.trainingPrograms = (next.trainingPrograms ?? []).map(
            (candidate) =>
              candidate.id === job.id
                ? {
                    ...candidate,
                    confidence: 0.95,
                    checkpoints: candidate.checkpoints.some(
                      (checkpoint) => checkpoint.progress >= 1,
                    )
                      ? candidate.checkpoints
                      : [
                          ...candidate.checkpoints,
                          {
                            id: `checkpoint-${job.id}-final`,
                            progress: 1,
                            day: state.day,
                            stability:
                              job.outcomeRisk === "high"
                                ? 0.58
                                : job.outcomeRisk === "medium"
                                  ? 0.72
                                  : 0.84,
                            reusable: true,
                            trainingNumerics,
                          },
                        ],
                  }
                : candidate,
          );
        }

        const undertrained =
          (job.effectiveDataRatio ?? job.dataCoverage) < 0.75;
        const outcomeNote = released.outcome
          ? ` · ${released.outcome.kind} ${(released.outcome.yieldMultiplier * 100).toFixed(1)}% yield`
          : "";
        if (undertrained) {
          next.brandTrust = Math.max(
            15,
            next.brandTrust - 2 - releaseRng.range(0, 3),
          );
          news.push(
            `Day ${state.day}: ${next.name} ships ${released.name} under-data (${Math.round(job.dataCoverage * 100)}% coverage) — cap ${released.capability.toFixed(0)}${outcomeNote}.`,
          );
        } else if (next.models.length === 0) {
          news.push(
            `Day ${state.day}: ${next.name} enters with ${released.name} (cap ${released.capability.toFixed(0)}, ${job.paramsB.toFixed(1)}B · ${Math.round(job.dataCoverage * 100)}% data${outcomeNote}).`,
          );
        } else {
          news.push(
            `Day ${state.day}: ${next.name} ships ${released.name} (cap ${released.capability.toFixed(0)}${outcomeNote}).`,
          );
        }

        const productPreset = released.productPreset ?? "language";
        const backbone = released.backbone ?? "dense";
        if (
          !(next.releaseMilestones ?? []).some(
            (milestone) =>
              milestone.productPreset === productPreset &&
              milestone.backbone === backbone,
          )
        ) {
          next.releaseMilestones = [
            ...(next.releaseMilestones ?? []),
            {
              productPreset,
              backbone,
              modelId: released.id,
              releaseDay: state.day,
            },
          ];
        }
        next.models = [released, ...next.models.slice(0, 3)];
        next.pricing = reconcileRivalPricingFleet(
          { ...next.pricing, activeModelId: released.id },
          next.models,
        );
        next.trainingJob = null;
      } else {
        next.trainingJob = job;
      }
    } else if (!next.trainingJob) {
      const cadenceHit = state.day % cadence === 0;
      const startRoll =
        next.models.length === 0
          ? (isCatchUpChallenger && competitiveResponse.frontierStale) ||
            trainingRng.range(0, 1) < 0.55
          : (isCatchUpChallenger && competitiveResponse.frontierStale) ||
            (cadenceHit &&
              (isCatchUpChallenger || trainingRng.range(0, 1) < 0.45));
      const wantStart = canStartTrain && startRoll;
      if (wantStart) {
      // Start a new job sized for available data (risk under-train like player)
      const prev = next.models[0];
      let family: Model["family"] = "dense";
      let backbone: ModelBackbone = "dense";
      let productPreset: ModelProductPreset = "language";
      let io: ModelIO = ioForPreset("language");
      let modalities: Model["modalities"] = ["text"];
      let activeParamsB: number | undefined;

      // Comfortable size at 1:1 tokens:params given corpus
      const comfortable = Math.max(0.05, corpus / 1000);
      const eraCeiling = rivalEraParamCeilingB({
        day: state.day,
        archetype: next.archetype,
        publicFrontierParamsB: publicFrontierParamsB(state),
      });
      let paramsB: number;
      let organicParamsB: number | undefined;
      if (!prev) {
        // First model: small (≤~0.5B with 500 MTok) unless they risk
        if (next.archetype === "open_weights")
          paramsB = Math.min(1.2, comfortable * 0.9);
        else if (
          next.archetype === "efficiency" &&
          next.researchUnlocked.includes("moe_basics")
        ) {
          family = "moe";
          paramsB = Math.min(4, comfortable * 2.5);
          activeParamsB = Math.max(0.1, paramsB * 0.08);
        } else if (next.archetype === "multimodal") {
          family = "diffusion";
          modalities = ["text", "image"];
          paramsB = Math.min(1.5, comfortable * 0.85);
        } else {
          paramsB = rivalDenseScaleTarget(
            next.archetype,
            comfortable,
            trainingRng.range(0, 1),
          );
        }
        // Risk: try bigger than data supports (~1B with thin data)
        if (trainingRng.range(0, 1) < 0.22 + pace.riskTolerance * 0.16) {
          paramsB = Math.min(
            3,
            Math.max(paramsB, comfortable * (1.2 + trainingRng.range(0, 0.8))),
          );
        }
      } else {
        family =
          next.archetype === "efficiency" &&
          next.researchUnlocked.includes("moe_basics")
            ? "moe"
            : prev.family;
        modalities = prev.modalities;
        const growth =
          next.archetype === "hyperscale"
            ? 1.16 + trainingRng.range(0, 0.16) * pace.researchSpeed
            : 1.08 + trainingRng.range(0, 0.12) * pace.researchSpeed;
        paramsB = Math.min(eraCeiling, prev.paramsB * growth);
        organicParamsB = paramsB;
        if (isCatchUpChallenger) {
          paramsB = rivalCatchUpScaleTarget({
            baselineTargetParamsB: paramsB,
            currentParamsB: prev.paramsB,
            comfortableParamsB: comfortable,
            capabilityGap: competitiveResponse.capabilityGap,
            maxParamsB: eraCeiling,
          });
        }
        const comfortMult = rivalEraDataComfortMult(
          state.day,
          isCatchUpChallenger,
        );
        paramsB = Math.min(
          paramsB,
          Math.max(prev.paramsB * 1.05, comfortable * comfortMult),
        );
        paramsB = Math.min(paramsB, eraCeiling);
        if (family === "moe") {
          activeParamsB =
            prev.family === "moe"
              ? Math.min(paramsB * 0.15, (prev.activeParamsB ?? 1) * 1.1)
              : Math.max(0.1, paramsB * 0.08);
        }
      }

      const modelBet = rivalNextModelBet(next);
      family = modelBet.family;
      backbone = modelBet.backbone;
      productPreset = modelBet.productPreset;
      io = modelBet.io;
      modalities = modelBet.modalities;
      if (prev && organicParamsB != null) {
        const prevPreset =
          prev.productPreset ??
          (prev.family === "diffusion"
            ? "image_generation"
            : prev.family === "video"
              ? "video_generation"
              : prev.family === "omni"
                ? "omni"
                : "language");
        if (productPreset !== prevPreset) {
          paramsB = Math.min(paramsB, organicParamsB);
        }
      }
      const hasMoeResearch = next.researchUnlocked.includes("moe_basics");
      const canSparse =
        productPreset === "language" ||
        productPreset === "omni" ||
        productPreset === "vision_language";
      const moeChance = canSparse
        ? rivalMoeAdoptionChance(next.archetype, paramsB, hasMoeResearch)
        : 0;
      if (
        moeChance >= 1 ||
        (moeChance > 0 && trainingRng.range(0, 1) < moeChance)
      ) {
        family = family === "omni" ? "omni" : "moe";
        backbone = "moe";
        const ratio =
          modelBet.activeParamsRatio ??
          rivalMoeActiveRatio(next.archetype, trainingRng.range(0, 1));
        activeParamsB = Math.max(0.1, paramsB * ratio);
      } else {
        activeParamsB = modelBet.activeParamsRatio
          ? Math.max(0.1, paramsB * modelBet.activeParamsRatio)
          : activeParamsB;
      }

      if (
        prev &&
        (productPreset === "language" ||
          productPreset === "omni" ||
          productPreset === "vision_language") &&
        (next.archetype !== "multimodal" ||
          (next.releaseMilestones ?? []).some(
            (milestone) => milestone.productPreset === "omni",
          ))
      ) {
        try {
        const hallS = getBuildDef("dc");
        const hallM = getBuildDef("dc_m");
        const hallL = getBuildDef("dc_l");
        const trainPf = rivalTrainPf(next, state, effectiveFlopsPf);
        const scaleDecision = chooseRivalScaleCandidate(
          {
            archetype: next.archetype,
            researchUnlocked: next.researchUnlocked,
            currentParamsB: prev.paramsB,
            currentActiveParamsB: prev.activeParamsB,
            currentCapability: prev.capability,
            frontierCapability: Math.max(
              playerCap,
              prev.capability,
            ),
            corpusMTok: corpus,
            cash: next.cash,
            dailyOperatingBurn: Math.max(
              50_000,
              next.finance?.dayTotalOut ?? 80_000,
            ),
            expectedTrainPfPerDay: Math.max(0.05, trainPf),
            totalPf: Math.max(0.05, effectiveFlopsPf),
            trainEfficiency: next.trainEfficiency ?? 1,
            researchMult: 1.08,
            numerics: DEFAULT_TRAINING_NUMERICS,
            activationCheckpointing:
              next.researchUnlocked.includes("opt_checkpoint"),
            availableHbmGb: physicalCompute.vramGb,
            availableSystemRamGb: physicalCompute.systemRamGb,
            pue: next.pue ?? 1.25,
            hostingUtilization: Math.min(
              1.4,
              (next.lastDemandPf ?? 0) / Math.max(0.05, next.lastCapacityPf ?? 1),
            ),
            marketShare: share,
            inferenceAllocation: next.allocation.inference,
            dataQuality: Math.max(0.25, Math.min(1.4, next.dataQuality || 1)),
            mixWeights: rivalProductTrainingWeights(
              next.archetype,
              family,
              productPreset,
            ),
            modalityComputeMult: 1,
            isCatchUpChallenger,
            maxParamsB: eraCeiling,
            rackCapacityBays: Math.max(
              0,
              (next.rackFleet ?? []).reduce(
                (sum, install) =>
                  sum + (install.status === "live" ? install.count : 0),
                0,
              ),
            ),
            racksUsed: Math.max(
              0,
              (next.rackFleet ?? []).reduce(
                (sum, install) =>
                  sum + (install.status === "live" ? install.count : 0),
                0,
              ),
            ),
            mwSupplyCapacity: physicalCompute.powerMw,
            mwDemand: physicalCompute.powerMw,
            unitCosts: {
              rackPf: Math.max(
                1,
                physicalCompute.installedLocalPf /
                  Math.max(
                    1,
                    (next.rackFleet ?? []).reduce(
                      (sum, install) =>
                        sum + (install.status === "live" ? install.count : 0),
                      0,
                    ),
                  ),
              ),
              rackPrice: 313_500,
              interconnectCostPerMw: 52_000_000 / 14,
              generationCostPerMw: 48_000_000 / 18,
              hallCash: {
                small: hallS.cash,
                medium: hallM.cash,
                large: hallL.cash,
              },
              hallRacks: {
                small: hallS.rack ?? 96,
                medium: hallM.rack ?? 288,
                large: hallL.rack ?? 960,
              },
            },
          },
          { family, backbone },
        );
        const ladderPick = scaleDecision.selected;
        const growthTarget = paramsB;
        if (
          ladderPick &&
          ladderPick.paramsB > prev.paramsB * 1.02 &&
          ladderPick.paramsB <= Math.max(growthTarget, prev.paramsB * 1.28) * 1.001
        ) {
          paramsB = Math.min(eraCeiling, ladderPick.paramsB);
          if (ladderPick.activeParamsB != null) {
            activeParamsB = ladderPick.activeParamsB;
          }
        }
        const comfortMult = rivalEraDataComfortMult(
          state.day,
          isCatchUpChallenger,
        );
        paramsB = Math.min(
          paramsB,
          Math.max(prev.paramsB * 1.05, comfortable * comfortMult),
          eraCeiling,
        );
        } catch (error) {
          console.error(
            `[tickRivals] scale ladder failed for ${next.id} on day ${state.day}:`,
            error,
          );
        }
      }

      const dataNeed = minDataMTokForParams(paramsB);
      const useHQ =
        next.trainPreferSynthHQ !== false &&
        next.researchUnlocked.includes("data_synth");
      const useLQ =
        !!next.trainAllowSynthLQ ||
        (corpus < dataNeed * 0.55 && trainingRng.range(0, 1) < 0.4);

      const recipeKnobs = chooseRivalTrainingRecipeKnobs(
        next.archetype,
        trainingRng,
        { isCatchUp: isCatchUpChallenger },
      );
      const plannedRecipe = planTrainingRecipe({
        paramsB,
        family,
        backbone,
        activeParamsB,
        weights: rivalProductTrainingWeights(
          next.archetype,
          family,
          productPreset,
        ),
        usableByDomain: usableStockByDomain(next.data!.stocks),
        postTrainShare: recipeKnobs.postTrainShare,
        trainShare: recipeKnobs.trainShare,
        volumePolicy: recipeKnobs.volumePolicy,
        allowSynthetic: useHQ || useLQ,
        includeSynthHQ: useHQ,
        includeSynthLQ: useLQ,
      });
      const recipe = consumeForLabData(
        next.data!,
        plannedRecipe.dataPlan,
        paramsB,
        family,
        {
          hasSynthResearch: next.researchUnlocked.includes("data_synth"),
        },
      );
      const usable = Object.values(recipe.consumed).reduce(
        (s, v) => s + (v ?? 0),
        0,
      );
      const jobId = `rt-${next.id}-${state.day}`;
      const manifestSnapshot = createDataManifest({
        data,
        consumed: recipe.consumed,
        totalMTok: usable,
        day: state.day,
        seed: state.seed,
        runId: jobId,
      });
      const attributedConsumed = manifestDomainExposureMTok(
        manifestSnapshot.manifest,
      );
      const mediaShortfall = rivalMediaDataShortfall({
        family,
        productPreset,
        consumed: attributedConsumed,
      });
      const dataAnalysis = analyzeTrainingData({
        paramsB,
        family,
        backbone,
        productPreset,
        io,
        plan: recipe.plan,
        data: next.data!,
        actualMTok: usable,
        quality: recipe.qualityUsed,
        lqShare: recipe.synthLqShare,
        manifest: manifestSnapshot.manifest,
      });
      // Risk under-train: may start even if usable < need
      if (mediaShortfall) {
        if (
          state.day % 7 ===
          hashSeed(state.seed, next.id, "train-media-news") % 7
        ) {
          news.push(
            `Day ${state.day}: ${next.name} holds ${productPreset.replace(/_/g, " ")} training — ${Math.round(mediaShortfall.actualShare * 100)}% actual ${mediaShortfall.domain} data, ${Math.round(mediaShortfall.requiredShare * 100)}% required.`,
          );
        }
      } else if (usable < dataNeed * 0.25 && paramsB > 0.3) {
        if (state.day % 7 === hashSeed(state.seed, next.id, "train-news") % 7) {
          news.push(
            `Day ${state.day}: ${next.name} holds training — only ${Math.round(usable)}/${Math.round(dataNeed)} MTok.`,
          );
        }
      } else {
        const trainingModifiers = rivalResearchTrainingModifiers(
          next.researchUnlocked,
          family,
          backbone,
        );
        const trainingNumerics = chooseRivalTrainingNumerics(next, family);
        const trainShare = Math.max(
          0.4,
          Math.min(0.95, recipe.plan.trainShare),
        );
        const economics = estimateTrainingEconomics({
          paramsB,
          activeParamsB,
          family,
          backbone,
          trainEfficiency: trainingModifiers.trainEfficiency,
          trainingTokensMTok: usable * trainShare,
          verificationTokensMTok: usable * (1 - trainShare),
          modalityComputeMult: dataAnalysis.modalityComputeMult,
          dataCost: recipe.cashCost,
          numerics: trainingNumerics,
        });
        const scaledTargetPf = economics.targetPfDays;
        const cashSunk = economics.upfrontCash;
        const cashBurnPerDay = economics.cashBurnPerDay;
        const memoryReady = rivalTrainingMemoryReady(
          next,
          {
            paramsB,
            activeParamsB,
            family,
            trainingNumerics,
          },
          physicalCompute,
        );
        if (!memoryReady) {
          if (
            state.day % 7 ===
            hashSeed(state.seed, next.id, "train-memory-news") % 7
          ) {
            news.push(
              `Day ${state.day}: ${next.name} delays training — the run does not fit in accelerator HBM and host RAM.`,
            );
          }
          return next;
        }
        if (next.cash < cashSunk) {
          const prevPreset =
            prev?.productPreset ??
            (prev?.family === "diffusion"
              ? "image_generation"
              : prev?.family === "video"
                ? "video_generation"
                : prev?.family === "omni"
                  ? "omni"
                  : "language");
          const newProductPilot =
            !!prev && productPreset !== prevPreset && paramsB < 16;
          if (!newProductPilot) {
            if (
              state.day % 7 ===
              hashSeed(state.seed, next.id, "train-news") % 7
            ) {
              news.push(
                `Day ${state.day}: ${next.name} delays training — insufficient cash.`,
              );
            }
            return next;
          }
        }
        next.cash = Math.max(0, next.cash - Math.min(cashSunk, next.cash));

        const job: RivalTrainJob = {
          id: jobId,
          name: `${next.name.split(" ")[0]}-train`,
          family,
          backbone,
          productPreset,
          io,
          paramsB,
          activeParamsB,
          targetPfDays: scaledTargetPf,
          progressPfDays: 0,
          minCalendarDays: paramsB >= 1_000 ? economics.minCalendarDays : 0,
          daysElapsed: 0,
          modalities,
          dataCoverage: recipe.coverage,
          dataQuality: recipe.qualityUsed,
          includeSynthHQ: useHQ,
          includeSynthLQ: useLQ,
          synthLqShare: recipe.synthLqShare ?? 0,
          trainShare: recipe.plan.trainShare,
          postTrainShare: plannedRecipe.postTrainShare,
          postTrainMTok: plannedRecipe.alignMTok,
          totalMTok: usable,
          outcomeSeed: hashSeed(
            state.seed,
            next.id,
            state.day,
            paramsB,
            family,
            "train-outcome",
          ),
          outcomeRisk: dataAnalysis.risk,
          effectiveDataRatio: dataAnalysis.effectiveDataRatio,
          repeatedDataEpochs: dataAnalysis.repeatedEpochs,
          modalityComputeMult: dataAnalysis.modalityComputeMult,
          dataManifestId: manifestSnapshot.manifest.id,
          dataEvidence: trainingDataEvidenceFromManifest(
            manifestSnapshot.manifest,
          ),
          cashSunk,
          cashBurnPerDay,
          trainingNumerics,
          computePriority:
            next.archetype === "hyperscale"
              ? 82
              : next.archetype === "efficiency"
                ? 72
                : 64,
          reservedPf: 0,
          paused: false,
        };
        const manifestId = manifestSnapshot.manifest.id;
        data = manifestSnapshot.data;
        next.data = data;
        const trainingProgram: TrainingProgram = {
          id: job.id,
          objective: `${next.archetype.replace("_", " ")} model generation`,
          targetSegments: rivalTargetSegments(next.archetype),
          assignedPodIds: [],
          pilots: [],
          checkpoints: [],
          domainForecasts: {},
          confidence: 0.38,
          integratedMethods: [...next.researchUnlocked],
          dataManifestId: manifestId,
        };
        next.trainingPrograms = [
          ...(next.trainingPrograms ?? []),
          trainingProgram,
        ];
        next.trainingJob = job;
        next.allocation = {
          training: 0.55,
          inference: next.models.length ? 0.3 : 0.2,
          research: next.models.length ? 0.15 : 0.25,
        };
        if (recipe.coverage < 0.7) {
          news.push(
            `Day ${state.day}: ${next.name} starts a risky ${paramsB.toFixed(1)}B train at ${Math.round(recipe.coverage * 100)}% data coverage.`,
          );
        }
      }
      }
    }

    // Rivals run the same growth loop as the player. Budgets scale with their
    // value and cash, react to the player's spend, and adjust gradually.
    const marketingTarget = rivalMarketingBudgetTarget(
      next,
      state.player.marketingSpendPerDay,
    );
    const marketingSpendPerDay = Math.max(
      0,
      (next.marketingSpendPerDay ?? marketingTarget) * 0.7 +
        marketingTarget * 0.3,
    );
    next.marketingSpendPerDay = marketingSpendPerDay;
    const rivalRevenueBasis = Math.max(
      100_000,
      next.dayRevenue ?? 0,
      next.finance?.dayRevenue ?? 0,
    );
    next.marketingRevenueMultiple = marketingSpendPerDay / rivalRevenueBasis;
    next.marketingChannels = rivalMarketingChannels(
      next,
      marketingSpendPerDay,
      state.player.marketingSpendPerDay,
    );
    // Rival campaigns settle before market offers are scored. Cash remains
    // charged exactly once by tickMarket's operating settlement.
    next = applyRivalDailyMarketing(state, next);

    return {
      ...next,
      pricing: synchronizeRivalPlanPrices(next.pricing),
    };
    } catch (error) {
      console.error(
        `[tickRivals] ${unboundedRival.id} failed on day ${state.day}:`,
        error,
      );
      return unboundedRival;
    }
  });

  // Grow rival campuses on the shared map (visible DCs + gen + grid draws)
  let s: SimState = {
    ...state,
    rivals,
    news: [...news, ...state.news].slice(0, 48),
  };
  s = appendFeedEvents(
    s,
    rivalFeedEventsForDay(state, state.rivals, rivals),
  );
  s = expandRivalCampuses(s);
  s = releaseDueRivalComebacks(s);
  const priorModels = new Set(
    state.rivals.flatMap((rival) =>
      rival.models.map((model) => `${rival.id}:${model.id}`),
    ),
  );
  for (const rival of s.rivals) {
    for (const model of rival.models) {
      if (
        isLivePublicModel(model) &&
        !priorModels.has(`${rival.id}:${model.id}`)
      ) {
        s = scheduleReleaseEvaluations(s, model.id, rival.id);
      }
    }
  }
  return s;
}

/**
 * Rival portfolios retain four public models, so keeping every superseded run
 * and manifest makes immutable snapshots grow quadratically: each new
 * manifest names every dataset asset accumulated so far. Keep the recent
 * evidence trail plus every manifest still referenced by a surviving model or
 * the active run. Aggregate corpus stocks/assets remain authoritative, so this
 * removes reporting history rather than data inventory.
 */
export const RIVAL_TRAINING_HISTORY_LIMIT = 12;

export function boundRivalTrainingHistory(rival: RivalLab): RivalLab {
  const programs = rival.trainingPrograms ?? [];
  const manifests = rival.data?.manifests ?? [];
  if (
    programs.length <= RIVAL_TRAINING_HISTORY_LIMIT &&
    manifests.length <= RIVAL_TRAINING_HISTORY_LIMIT
  ) {
    return rival;
  }

  const requiredProgramIds = new Set<string>();
  if (rival.trainingJob?.id) requiredProgramIds.add(rival.trainingJob.id);
  const requiredManifestIds = new Set(
    rival.models
      .map((model) => model.dataManifestId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const program of programs) {
    if (
      program.dataManifestId &&
      requiredManifestIds.has(program.dataManifestId)
    ) {
      requiredProgramIds.add(program.id);
    }
  }

  const recentIds = new Set(
    programs.slice(-RIVAL_TRAINING_HISTORY_LIMIT).map((program) => program.id),
  );
  const keptPrograms = programs.filter(
    (program) =>
      recentIds.has(program.id) || requiredProgramIds.has(program.id),
  );
  for (const program of keptPrograms) {
    if (program.dataManifestId) requiredManifestIds.add(program.dataManifestId);
  }
  const keptManifests = manifests.filter((manifest) =>
    requiredManifestIds.has(manifest.id),
  );

  if (
    keptPrograms.length === programs.length &&
    keptManifests.length === manifests.length
  ) {
    return rival;
  }
  return {
    ...rival,
    trainingPrograms: keptPrograms,
    data: rival.data ? { ...rival.data, manifests: keptManifests } : rival.data,
  };
}

type RivalCampusBuildKind = "dc" | "dc_m" | "dc_l" | "substation" | "solar" | "gas" | "hq";

function isRivalHallKind(
  kind: RivalCampusBuildKind,
): kind is "dc" | "dc_m" | "dc_l" {
  return kind === "dc" || kind === "dc_m" || kind === "dc_l";
}

function rivalCampusHunger(input: {
  hqCount: number;
  dcCount: number;
  lastUnserved: number;
  cash: number;
  smallHallCash: number;
}): number {
  if (input.hqCount === 0 || input.dcCount === 0) return 1;
  return Math.min(
    0.92,
    0.28 +
      Math.min(0.45, input.lastUnserved * 1.8) +
      (input.cash >= input.smallHallCash * 0.8 && input.dcCount < 4 ? 0.16 : 0),
  );
}

function rivalHallKindForExpansion(
  rival: RivalLab,
  dcCount: number,
): "dc" | "dc_m" | "dc_l" {
  const demand =
    rival.campusPlan?.projectedRackDemand ??
    Math.max(24, rival.chips ?? 0);
  return chooseRivalDcSize(demand, rival.archetype, dcCount);
}

function spendRivalCash(
  state: SimState,
  labId: RivalLab["id"],
  amount: number,
): SimState {
  const cashOf = (cash: number) => cash - amount;
  const rivals = state.rivals.map((rival) =>
    rival.id === labId
      ? {
          ...rival,
          cash: cashOf(rival.cash),
          finance: rival.finance
            ? { ...rival.finance, cash: cashOf(rival.cash) }
            : rival.finance,
        }
      : rival,
  );
  const indexed = state.labs?.[labId];
  const labs = indexed
    ? {
        ...state.labs,
        [labId]: {
          ...indexed,
          cash: cashOf(indexed.cash),
          finance: { ...indexed.finance, cash: cashOf(indexed.cash) },
        },
      }
    : state.labs;
  return { ...state, rivals, labs };
}

function rivalDcSizeLabel(
  kind: RivalCampusBuildKind,
): "small" | "medium" | "large" | undefined {
  if (kind === "dc_l") return "large";
  if (kind === "dc_m") return "medium";
  if (kind === "dc") return "small";
  return undefined;
}

/**
 * Rivals claim empty land, densify halls, and add substations / generation so
 * they pull more shared-grid MW as the game progresses (and show on the map).
 */
export function expandRivalCampuses(state: SimState): SimState {
  if (usesCompactWorld(state)) return expandCompactRivalCampuses(state);
  // Copy the row-major container once, then copy only records that change.
  // Rival AI and player systems continue to operate on the same MapTile
  // semantics without allocating a second million-object world every day.
  const tiles = state.map.tiles.slice();
  let next = state;
  const news: string[] = [];
  const econ = state.config.economyMult ?? 1;
  const smallHallCash = Math.floor(getBuildDef("dc").cash * econ);
  const ownedByRival = new Map<string, MapTile[]>();
  const emptyByRegion = new Map<string, MapTile[]>();
  for (const tile of tiles) {
    if (tile.owner !== "neutral" && tile.owner !== "player") {
      // Pending projects still occupy a campus and satisfy the corresponding
      // capacity plan. Counting only commissioned sites made rivals queue
      // duplicate HQs and halls while the first one was visibly being built.
      const owned = ownedByRival.get(tile.owner);
      if (owned) owned.push(tile);
      else ownedByRival.set(tile.owner, [tile]);
    } else if (tile.owner === "neutral" && tile.kind === "empty") {
      const empty = emptyByRegion.get(tile.regionId);
      if (empty) empty.push(tile);
      else emptyByRegion.set(tile.regionId, [tile]);
    }
  }

  const tileIndexAt = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= state.map.width || y >= state.map.height)
      return -1;
    const index = y * state.map.width + x;
    const tile = tiles[index];
    return tile?.x === x && tile.y === y ? index : -1;
  };

  for (let ri = 0; ri < next.rivals.length; ri++) {
    let r = next.rivals[ri]!;
    const rng = rivalActionRng(
      state.seed,
      r.id,
      r.strategy?.decisionRevision ?? 0,
      state.day,
      "strategic",
      "campus-expansion",
    );
    // Capital projects are weekly policy decisions. Difficulty affects policy
    // quality elsewhere, never the construction cost or completion time.
    if (state.day % 7 !== hashSeed(state.seed, r.id, "capex-day") % 7) continue;
    const owned = ownedByRival.get(r.id) ?? [];
    const dcs = owned.filter(
      (t) => t.kind === "dc" || t.kind === "dc_m" || t.kind === "dc_l",
    );
    const hqs = owned.filter(
      (t) => t.kind === "hq" || t.kind === "hq_m" || t.kind === "hq_l",
    );
    const hunger = rivalCampusHunger({
      hqCount: hqs.length,
      dcCount: dcs.length,
      lastUnserved: r.lastUnserved ?? 0,
      cash: r.cash,
      smallHallCash,
    });
    if (rng.range(0, 1) > hunger) continue;
    const gens = owned.filter(
      (t) => t.kind === "solar" || t.kind === "gas" || t.kind === "nuclear",
    );
    const feeds = owned.filter(
      (t) => t.kind === "substation" || t.kind === "battery",
    );

    // New building near an existing campus or in the rival's home region.
    // Racks are deliberately left empty: accelerators must clear the shared market.
    const anchors =
      owned.length > 0
        ? owned
        : (emptyByRegion.get(r.regionId) ?? []).filter((t) => {
            const index = tileIndexAt(t.x, t.y);
            const live = index >= 0 ? tiles[index] : undefined;
            return live?.kind === "empty" && live.owner === "neutral";
          });
    if (anchors.length === 0) continue;
    const anchor = anchors[rng.int(0, anchors.length - 1)]!;
    const candidates: { x: number; y: number }[] = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        const index = tileIndexAt(x, y);
        const t = index >= 0 ? tiles[index] : undefined;
        if (t && t.kind === "empty" && t.owner === "neutral")
          candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) continue;
    const spot = candidates[rng.int(0, candidates.length - 1)]!;
    const si = tileIndexAt(spot.x, spot.y);
    if (si < 0) continue;

    const needPower = dcs.length > feeds.length + gens.length;
    const needGen = dcs.length > 0 && gens.length < Math.ceil(dcs.length / 2);
    let kind: RivalCampusBuildKind = "dc";
    if (hqs.length === 0) kind = "hq";
    else if (needGen && rng.range(0, 1) < 0.45)
      kind = rng.range(0, 1) < 0.55 ? "solar" : "gas";
    else if (needPower && rng.range(0, 1) < 0.5) kind = "substation";
    else if (dcs.length === 0) kind = "dc";
    else
      kind =
        rng.range(0, 1) < 0.65
          ? "dc"
          : rng.range(0, 1) < 0.5
            ? "substation"
            : "solar";

    const t = { ...tiles[si]! };
    const def = getBuildDef(kind);
    const totalCash =
      Math.floor(def.cash * econ) + Math.max(0, t.landValue);
    if (r.cash < totalCash) {
      next = fundRivalForCampus(next, r.id, totalCash + def.opexPerDay * 20);
      r = next.rivals[ri]!;
    }
    if (r.cash < totalCash) continue;
    next = spendRivalCash(next, r.id, totalCash);
    r = next.rivals[ri]!;
    t.owner = r.id;
    t.kind = kind;
    t.buildingProgress = 0;
    t.buildingTarget = def.days;
    t.name =
      isRivalHallKind(kind)
        ? `${r.name} Hall`
        : kind === "hq"
          ? `${r.name} HQ`
          : kind === "substation"
            ? `${r.name} Grid`
            : kind === "solar"
              ? `${r.name} Solar`
              : `${r.name} Peaker`;
    if (kind === "hq") {
      t.opexPerDay = def.opexPerDay;
      t.note =
        "Rival headquarters under construction; desks gate future hiring.";
    } else if (isRivalHallKind(kind)) {
      t.rackCapacity = def.rack ?? 0;
      t.racksUsed = 0;
      t.opexPerDay = def.opexPerDay;
      t.dcSize = rivalDcSizeLabel(kind);
      t.note =
        "Rival data hall under construction; racks are purchased separately.";
    } else if (kind === "substation") {
      t.mwCapacity = def.mw ?? 0;
      t.opexPerDay = def.opexPerDay;
      t.note = "Rival interconnect under construction on the regional grid.";
    } else if (kind === "solar") {
      t.mwGeneration = def.gen ?? 0;
      t.opexPerDay = def.opexPerDay;
      t.note = "Rival on-site generation under construction.";
    } else {
      t.mwGeneration = def.gen ?? 0;
      t.opexPerDay = def.opexPerDay;
      t.note = "Rival peaker under construction for firm power.";
    }
    tiles[si] = t;
    if (state.day % 11 === hashSeed(state.seed, r.id, "campus-news") % 11) {
      news.push(
        `Day ${state.day}: ${r.name} starts construction on ${t.name}.`,
      );
    }
  }

  return {
    ...next,
    map: { ...next.map, tiles },
    news: [...news, ...next.news].slice(0, 48),
  };
}

function claimFacilityFootprint(
  claimed: Set<TileId>,
  facility: Facility,
  world: NonNullable<SimState["map"]["world"]>,
) {
  const width = world.descriptor.width;
  const height = world.descriptor.height;
  const cells =
    facility.footprint.length > 0 ? facility.footprint : [facility.anchor];
  for (const cell of cells) {
    claimed.add(cell);
    const { x, y } = tileCoords(cell, width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        claimed.add(tileId(nx, ny, width, height));
      }
    }
  }
}

function expandCompactRivalCampuses(state: SimState): SimState {
  const world = state.map.world!;
  const batch = world.beginBatch();
  const claimed = new Set<TileId>();
  let next = state;
  const news: string[] = [];
  let changed = false;
  const econ = state.config.economyMult ?? 1;
  const smallHallCash = Math.floor(getBuildDef("dc").cash * econ);
  const width = world.descriptor.width;
  const height = world.descriptor.height;

  const available = (id: TileId): boolean =>
    !claimed.has(id) &&
    world.getFacilityAt(id) === undefined &&
    world.getOwner(id) === "neutral" &&
    world.getKind(id) === TERRAIN_KIND.empty;

  const footprintAt = (
    origin: TileId,
    kind: RivalCampusBuildKind,
  ): TileId[] | undefined => {
    const { x, y } = tileCoords(origin, width);
    const cells: TileId[] = [];
    for (const { dx, dy } of dcFootprint(kind)) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return undefined;
      const id = tileId(nx, ny, width, height);
      if (!available(id)) return undefined;
      cells.push(id);
    }
    return cells;
  };

  const nearbyFootprint = (
    anchor: TileId,
    kind: RivalCampusBuildKind,
    rng: ReturnType<typeof createRng>,
  ): { origin: TileId; cells: TileId[] } | undefined => {
    const { x: ax, y: ay } = tileCoords(anchor, width);
    const radius = dcFootprint(kind).length > 1 ? 6 : 2;
    const candidates: { origin: TileId; cells: TileId[] }[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = ax + dx;
        const y = ay + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const origin = tileId(x, y, width, height);
        const cells = footprintAt(origin, kind);
        if (cells) candidates.push({ origin, cells });
      }
    }
    return candidates.length > 0
      ? candidates[rng.int(0, candidates.length - 1)]
      : undefined;
  };

  const regionalFootprint = (
    regionId: string,
    kind: RivalCampusBuildKind,
    rng: ReturnType<typeof createRng>,
  ): { origin: TileId; cells: TileId[] } | undefined => {
    const region = world.staticWorld.regions.find(
      (entry) => entry.id === regionId,
    );
    const minX = region?.originX ?? 0;
    const minY = region?.originY ?? 0;
    const maxX = Math.min(width, minX + (region?.width ?? width));
    const maxY = Math.min(height, minY + (region?.height ?? height));
    for (let attempt = 0; attempt < 320; attempt++) {
      const x = rng.int(minX, Math.max(minX, maxX - 1));
      const y = rng.int(minY, Math.max(minY, maxY - 1));
      const origin = tileId(x, y, width, height);
      const cells = footprintAt(origin, kind);
      if (cells) return { origin, cells };
    }
    return undefined;
  };

  for (let ri = 0; ri < next.rivals.length; ri++) {
    let rival = next.rivals[ri]!;
    const rng = rivalActionRng(
      state.seed,
      rival.id,
      rival.strategy?.decisionRevision ?? 0,
      state.day,
      "strategic",
      "campus-expansion",
    );
    if (state.day % 7 !== hashSeed(state.seed, rival.id, "capex-day") % 7)
      continue;
    // Include active builds so a weekly planning tick does not start duplicate
    // HQ or compute projects before the existing one completes.
    const owned = world.queryFacilities({ ownerId: rival.id });
    for (const existing of owned)
      claimFacilityFootprint(claimed, existing, world);
    const dcs = owned.filter(
      (facility) =>
        facility.kind === "dc" ||
        facility.kind === "dc_m" ||
        facility.kind === "dc_l",
    );
    const hqs = owned.filter(
      (facility) =>
        facility.kind === "hq" ||
        facility.kind === "hq_m" ||
        facility.kind === "hq_l",
    );
    const hunger = rivalCampusHunger({
      hqCount: hqs.length,
      dcCount: dcs.length,
      lastUnserved: rival.lastUnserved ?? 0,
      cash: rival.cash,
      smallHallCash,
    });
    if (rng.range(0, 1) > hunger) continue;
    const gens = owned.filter(
      (facility) =>
        facility.kind === "solar" ||
        facility.kind === "gas" ||
        facility.kind === "nuclear",
    );
    const feeds = owned.filter(
      (facility) =>
        facility.kind === "substation" || facility.kind === "battery",
    );

    const needPower = dcs.length > feeds.length + gens.length;
    const needGen = dcs.length > 0 && gens.length < Math.ceil(dcs.length / 2);
    let kind: RivalCampusBuildKind = "dc";
    if (hqs.length === 0) kind = "hq";
    else if (needGen && rng.range(0, 1) < 0.45)
      kind = rng.range(0, 1) < 0.55 ? "solar" : "gas";
    else if (needPower && rng.range(0, 1) < 0.5) kind = "substation";
    else if (dcs.length === 0) kind = "dc";
    else if (rng.range(0, 1) < 0.65)
      kind = rivalHallKindForExpansion(rival, dcs.length);
    else
      kind = rng.range(0, 1) < 0.5 ? "substation" : "solar";

    const isHall = kind === "dc" || kind === "dc_m" || kind === "dc_l";
    const hint =
      owned.length > 0
        ? owned[rng.int(0, owned.length - 1)]!.anchor
        : undefined;
    let site =
      hint === undefined
        ? regionalFootprint(rival.regionId, kind, rng)
        : nearbyFootprint(hint, kind, rng);
    if (!site && isHall && kind !== "dc") {
      kind = "dc";
      site =
        hint === undefined
          ? regionalFootprint(rival.regionId, kind, rng)
          : nearbyFootprint(hint, kind, rng);
    }
    if (!site) continue;

    const def = getBuildDef(kind);
    const totalCash = Math.floor(def.cash * econ);
    if (rival.cash < totalCash) {
      next = fundRivalForCampus(next, rival.id, totalCash + def.opexPerDay * 20);
      rival = next.rivals[ri]!;
    }
    if (rival.cash < totalCash) continue;
    next = spendRivalCash(next, rival.id, totalCash);
    rival = next.rivals[ri]!;

    let stats: NonNullable<Facility["stats"]>;
    let note: string;
    if (kind === "hq") {
      stats = { opexPerDay: def.opexPerDay };
      note = "Rival headquarters under construction; desks gate future hiring.";
    } else if (isHall) {
      stats = {
        rackCapacity: def.rack ?? 0,
        racksUsed: 0,
        opexPerDay: def.opexPerDay,
      };
      note =
        "Rival data hall under construction; racks are purchased separately.";
    } else if (kind === "substation") {
      stats = { mwCapacity: def.mw ?? 0, opexPerDay: def.opexPerDay };
      note = "Rival interconnect under construction on the regional grid.";
    } else if (kind === "solar") {
      stats = { mwGeneration: def.gen ?? 0, opexPerDay: def.opexPerDay };
      note = "Rival on-site generation under construction.";
    } else {
      stats = { mwGeneration: def.gen ?? 0, opexPerDay: def.opexPerDay };
      note = "Rival peaker under construction for firm power.";
    }
    const name = isHall
      ? `${rival.name} Hall`
      : kind === "hq"
        ? `${rival.name} HQ`
        : kind === "substation"
          ? `${rival.name} Grid`
          : kind === "solar"
            ? `${rival.name} Solar`
            : `${rival.name} Peaker`;
    const facility: Facility = {
      id: `rival-${rival.id}-${state.day}-${site.origin}`,
      kind,
      ownerId: rival.id,
      anchor: site.origin,
      footprint: site.cells,
      level: 1,
      constructionProgress: 0,
      constructionTarget: def.days,
      powered: isHall ? false : undefined,
      stats,
      data: { name, note, dcSize: rivalDcSizeLabel(kind) },
    };
    batch.addFacility(facility);
    claimFacilityFootprint(claimed, facility, world);
    changed = true;
    if (state.day % 11 === hashSeed(state.seed, rival.id, "campus-news") % 11) {
      news.push(
        `Day ${state.day}: ${rival.name} starts construction on ${name}.`,
      );
    }
  }

  if (!changed) {
    batch.rollback();
    return next;
  }
  const committed = commitWorldBatch(next, batch);
  return {
    ...committed,
    news: [...news, ...committed.news].slice(0, 48),
  };
}


/** Flatten public player + rival models for the public leaderboard UI. */
export function collectLeaderboardModels(state: SimState): {
  labId: string;
  labName: string;
  color: number;
  model: Model;
  isPlayer: boolean;
  kind: "model" | "router";
}[] {
  const rows: {
    labId: string;
    labName: string;
    color: number;
    model: Model;
    isPlayer: boolean;
    kind: "model" | "router";
  }[] = [];
  for (const m of state.player.models) {
    // Internal and stealth checkpoints are deliberately absent. Their latent
    // scores are only visible through paid, noisy checkpoint-evaluation reports.
    if (!isLivePublicModel(m)) continue;
    rows.push({
      labId: "player",
      labName: state.player.name,
      color: 0x3dffc0,
      model: m,
      isPlayer: true,
      kind: "model",
    });
  }
  for (const router of normalizeModelRouters(state.player.modelRouters)) {
    if (router.id !== state.player.activeModelRouterId) continue;
    const composed = composeRouterModel(
      router,
      publicRouterParts(router, state.player.models),
    );
    if (!composed) continue;
    rows.push({
      labId: "player",
      labName: state.player.name,
      color: 0x3dffc0,
      model: composed,
      isPlayer: true,
      kind: "router",
    });
  }
  for (const r of state.rivals) {
    for (const m of r.models) {
      rows.push({
        labId: r.id,
        labName: r.name,
        color: r.color,
        model: m,
        isPlayer: false,
        kind: "model",
      });
    }
  }
  return rows.sort((a, b) => {
    const ca = a.model.capability + avgBench(a.model) * 0.15;
    const cb = b.model.capability + avgBench(b.model) * 0.15;
    return cb - ca;
  });
}
