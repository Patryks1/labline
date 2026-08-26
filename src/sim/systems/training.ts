import { aggregateEffects } from "./research";
import type {
  BenchmarkScores,
  BenchmarkSuiteId,
  Model,
  PostTrainRiskPlan,
  PostTrainStage,
  QualityAxes,
  SimState,
  StartTrainingOpts,
  TrainMode,
  TrainingBenchmarkRequest,
  TrainingBenchmarkPending,
  TrainingBenchmarkSnapshot,
  TrainingBenchmarkSuiteResult,
  TrainingCheckpointBranchDirection,
  TrainingCampaignChoiceEffects,
  TrainingCheckpointCandidate,
  TrainingComputeFormat,
  TrainingFailureRecord,
  TrainingJob,
  TrainingNumerics,
  PostTrainGym,
  PostTrainGymKind,
  PrivateEvaluationJob,
  SpecializationFocus,
  ReasoningEffort,
  ModelProductProfile,
  EffortRecipe,
  EffortTrainProgress,
} from "../types";
import {
  gymUnlocked,
  normalizePostTrainGyms,
  trainingGymDomainExtras,
  trainingGymLatentLift,
} from "../balance/modelStudio";
import { chargeExpense } from "./financeLedger";
import {
  checkpointTouchesModel,
  reconcileCheckpointOwnership,
} from "./checkpointOwnership";
import { computeSnapshot } from "./compute";
import type { ComputeSnapshot } from "./compute";
import { mwPerPf } from "./computeMarket";
import {
  normalizeDataQuality,
  bentCapabilityCeiling,
  scaleIntelligence,
  scoresFromScale,
} from "../balance/modelScaling";
import { getResearchNode } from "../balance/research";
import { attachModelToEmptyPlans, updatePlan } from "./plans";
import { scheduleReleaseEvaluations } from "./evaluations";
import {
  deriveModelCapabilities,
  matureModelIo,
  modalityExperienceCounts,
  modalityMaturity,
  type GenerativeModality,
} from "../balance/modelCapabilities";
import {
  DATA_MIX_DEFS,
  blendDistilledCapability,
  clampDistillTeacherShare,
  distillFromTeacher,
  DISTILL_RETENTION,
  estimateTrainingEconomics,
  formatParams,
  fundedTrainingMaturity,
  pacedTrainingPfPerDay,
  sizeGate,
  trainCostPfDays,
} from "../balance/training";
import {
  allocateTrainingHardwarePools,
  allocateWeightedTrainingCompute,
  DEFAULT_TRAINING_NUMERICS,
  estimateTrainingMemoryGb,
  LEGACY_TRAINING_NUMERICS,
  nativeWeightPrecisionForNumerics,
  trainingNumericsEconomicsProfile,
  validateTrainingNumerics,
} from "../balance/trainingPrecision";
import type { TrainingHardwarePool } from "../balance/trainingPrecision";
import {
  analyzeTrainingData,
  backboneFromFamily,
  ioForPreset,
  migrateLegacyProductPreset,
  presetFromFamily,
  rollTrainingOutcome,
  serviceProfileForModel,
  trainingDataModalityRequirements,
} from "../balance/trainingV3";
import {
  freezeTrainingPlan,
  frozenResearchIds,
  inferComputeSource,
  trainingOutcomeSeed,
} from "../balance/trainingPlan";
import { trainingFitsPlacementDomain } from "../balance/placementDomains";
import {
  DEFAULT_RECIPE_ALIGN_SHARE,
  applyRecipeOutcome,
  recipeOutcomeSignals,
} from "../balance/trainingRecipe";
import { createRng, hashSeed, seededId } from "../rng";
import {
  applyTrainingCampaignChoice,
  boundedVerifiedRecursiveCapabilityBonus,
  createTrainingCampaignEvent,
  crossedTrainingCampaignMilestone,
  dutyScientistCampaignChoice,
  TRAINING_CAMPAIGN_MILESTONES,
} from "../balance/trainingCampaign";
import { clampTrainingCampaignIntervention } from "../balance/trainingCampaignIntervention";
import { appendFeedEvents } from "./feed";
import {
  benchmarkEffortRecipe,
  benchmarkEffortRecipes,
  estimateBenchmarkRun,
} from "../balance/benchmarkCost";

/** @deprecated Fixed PF targets replace calendar extensions. */
export const TRAINING_EXTENSION_DAYS = 10;
export const TRAINING_BENCHMARK_MIN_PROGRESS = 0.1;
/** @deprecated The unified scheduler allows concurrent private evaluation work. */
export const TRAINING_BENCHMARK_COOLDOWN_DAYS = 0;
export const TRAINING_BENCHMARK_MIN_SPEND = 50_000;
export const TRAINING_BENCHMARK_MAX_SPEND = 150_000;

export interface TrainingBenchmarkSuiteOption {
  id: BenchmarkSuiteId;
  label: string;
  description: string;
  minSpend: number;
  referenceSpend: number;
  maxSpend: number;
}

const TRAINING_BENCHMARK_SUITE_OPTIONS: Record<
  BenchmarkSuiteId,
  TrainingBenchmarkSuiteOption
> = {
  language: {
    id: "language",
    label: "Language & reasoning",
    description: "Knowledge, coding, reasoning, tools, and safety evaluations.",
    minSpend: TRAINING_BENCHMARK_MIN_SPEND,
    referenceSpend: 100_000,
    maxSpend: TRAINING_BENCHMARK_MAX_SPEND,
  },
  image_generation: {
    id: "image_generation",
    label: "Image generation",
    description: "Prompt alignment, visual quality, control, and image safety.",
    minSpend: TRAINING_BENCHMARK_MIN_SPEND,
    referenceSpend: 110_000,
    maxSpend: TRAINING_BENCHMARK_MAX_SPEND,
  },
  video_generation: {
    id: "video_generation",
    label: "Video generation",
    description:
      "Temporal coherence, motion, control, quality, and video safety.",
    minSpend: TRAINING_BENCHMARK_MIN_SPEND,
    referenceSpend: 140_000,
    maxSpend: TRAINING_BENCHMARK_MAX_SPEND,
  },
  audio_generation: {
    id: "audio_generation",
    label: "Audio generation",
    description:
      "Intelligibility, naturalness, consistency, realtime, and safety.",
    minSpend: TRAINING_BENCHMARK_MIN_SPEND,
    referenceSpend: 110_000,
    maxSpend: TRAINING_BENCHMARK_MAX_SPEND,
  },
  omni_overview: {
    id: "omni_overview",
    label: "Omni integration",
    description:
      "Cross-modal language, tools, image, video, audio, and safety.",
    minSpend: TRAINING_BENCHMARK_MIN_SPEND,
    referenceSpend: 150_000,
    maxSpend: TRAINING_BENCHMARK_MAX_SPEND,
  },
};

/** Product-aware private suites. Generation-only checkpoints never get text evals. */
export function eligibleTrainingBenchmarkSuites(
  job: Pick<TrainingJob, "family" | "productPreset" | "io">,
): TrainingBenchmarkSuiteOption[] {
  const preset = job.productPreset ?? presetFromFamily(job.family);
  const io = job.io ?? ioForPreset(preset);
  const outputEnabled = (modality: keyof typeof io.outputs) =>
    (io.outputs[modality] ?? 0) > 0;
  const ids: BenchmarkSuiteId[] = [];
  const add = (id: BenchmarkSuiteId) => {
    if (!ids.includes(id)) ids.push(id);
  };

  // Put the native product suite first so legacy one-click calls remain useful.
  if (preset === "omni" || job.family === "omni") add("omni_overview");
  else if (
    outputEnabled("video") ||
    preset === "video_generation" ||
    job.family === "video"
  )
    add("video_generation");
  else if (
    outputEnabled("image") ||
    preset === "image_generation" ||
    job.family === "diffusion"
  )
    add("image_generation");
  else if (outputEnabled("audio") || preset === "audio")
    add("audio_generation");
  else if (outputEnabled("text")) add("language");

  if (outputEnabled("text")) add("language");
  if (outputEnabled("image")) add("image_generation");
  if (outputEnabled("video")) add("video_generation");
  if (outputEnabled("audio")) add("audio_generation");
  if (preset === "omni" || job.family === "omni") add("omni_overview");
  return ids.map((id) => TRAINING_BENCHMARK_SUITE_OPTIONS[id]);
}

/** Displayable measurement quality for the paid sample size. */
export function trainingBenchmarkAccuracyForSpend(spend: number): {
  accuracy: number;
  confidence: number;
  inaccuracy: number;
} {
  const normalized = Math.max(
    0,
    Math.min(
      1,
      (spend - TRAINING_BENCHMARK_MIN_SPEND) /
        (TRAINING_BENCHMARK_MAX_SPEND - TRAINING_BENCHMARK_MIN_SPEND),
    ),
  );
  const accuracy = 0.65 + normalized * 0.25;
  return {
    accuracy,
    confidence: 0.72 + normalized * 0.24,
    inaccuracy: 1 - accuracy,
  };
}

/** Concrete sample size used to turn paid study depth into real inference work. */
export function trainingBenchmarkTasksPerMetric(spend: number): number {
  const normalized = Math.max(
    0,
    Math.min(
      1,
      (spend - TRAINING_BENCHMARK_MIN_SPEND) /
        (TRAINING_BENCHMARK_MAX_SPEND - TRAINING_BENCHMARK_MIN_SPEND),
    ),
  );
  return Math.round(200 + normalized * 1_000);
}
import {
  apiHostingCostFloor,
  boundedApiListCostPerMTok,
  birthApiUnitCostPerMTok,
  blendApiPrice,
  clampApiListToHostingFloor,
  splitBlendedApiPrice,
  suggestApiInOut,
} from "../balance/pricing";
import {
  DATA_DOMAIN_META,
  DATA_DOMAINS,
  applySynthQualityTax,
  defaultDataWeights,
  lqSynthCapabilityMult,
  normalizeDomainStock,
  normalizeWeights,
  recommendedTrainingDataMTok,
} from "../balance/data";
import {
  modelNativeVramGb,
  modelTrainVramGb,
  modelVramGb,
} from "../balance/racks";
import { syntheticTeacherGenerationEconomics } from "../balance/syntheticTeacherEffort";
import { fleetStats, resolveRackSku } from "./racks";
import { modelCanCurateDataDomain } from "./modelEligibility";
import { isLivePublicModel } from "../modelRelease";
import type {
  DataDomain,
  DataMix,
  LabData,
  SyntheticFillRecord,
  TrainingDataPlan,
} from "../types";
import {
  consumeForTraining,
  ensureLabData,
  formatMix,
  formatTokens,
  minDataMTokForParams,
  newDataSinceModel,
  specialistDomainBoost,
  totalProcessed,
} from "./data";
import type { ConsumeResult } from "./data";
import {
  createDataManifest,
  manifestDomainExposureMTok,
  trainingDataEvidenceFromManifest,
} from "./dataAssets";
import { modelStackModifiers, sanitizeModelStack } from "../balance/modelStack";
import {
  alignmentDataWeights,
  applyEffortLiftFromRecipe,
  branchFocusPreset,
  buildModelProductProfile,
  capBaseChatWeights,
  DEFAULT_POST_TRAIN_SHARE,
  postTrainStagesFromResearch,
  splitTrainingTokens,
  effortBoardsFor,
  focusMagnitude,
  focusToMix,
  foundationDataWeights,
  productProfileFromModel,
  withServedRecipe,
  withDefaultRecipe,
  withEffortRecipePatch,
  migrateEffortRecipes,
  INSTANT_EFFORT_ID,
  MAX_TRAINED_EFFORTS,
  DEFAULT_EFFORT_HEAD_SHARE,
  EFFORT_HEAD_SHARE_MAX,
  clampThinkingTokenMult,
  clampCapabilityBias,
  clampEffortTrainShare,
  effortTrainTargetPfDays,
  effortQualityFromTrain,
  effortFundedPfFromQuality,
  effortCashCost,
  effortReasoningUnlocked,
  gymQualityByKind,
  allocateEffortHeadPf,
  normalizeEffortRecipe,
  defaultEffortIdOf,
  modelSupportsEffortHeads,
  resolveEffortTrainingOutcome,
} from "../balance/modelProduct";
import {
  normalizeModelEvaluations,
  SUITE_METRICS,
} from "../balance/evaluationSuites";
import {
  syntheticTrainingProfile,
  teacherSyntheticHeadroomMTok,
} from "../balance/syntheticTraining";
import {
  completedPostTrainStages,
  mergePostTrainStageEffectiveness,
  postTrainFailureRisk,
  postTrainEffectProfile,
  resolvedPostTrainStageEffectiveness,
  postTrainStageEffectiveness,
  postTrainStageQuote,
  studioPostTrainTargetPfDays,
} from "../balance/postTraining";

const POST_TRAIN_ORDER: PostTrainStage[] = [
  "none",
  "sft",
  "rlhf",
  "process",
  "tools",
];

type TrainingFamily = StartTrainingOpts["family"];
type TrainingBackbone = NonNullable<StartTrainingOpts["backbone"]>;
type TrainingProductPreset = NonNullable<StartTrainingOpts["productPreset"]>;

export interface TrainingUnlockEligibility {
  ok: boolean;
  reason?: string;
  researchNodeId?: string;
}

export interface TrainingArchitectureValidation {
  ok: boolean;
  reason?: string;
}

/** Shared UI/backend validation for architecture fields that cannot be advisory. */
export function trainingArchitectureValidation(opts: {
  backbone: TrainingBackbone;
  paramsB: number;
  activeParamsB?: number;
  mode?: TrainMode;
}): TrainingArchitectureValidation {
  if (opts.backbone !== "moe" || opts.mode === "continue") return { ok: true };
  const active = opts.activeParamsB;
  if (active == null || !Number.isFinite(active) || active <= 0) {
    return {
      ok: false,
      reason: "MoE needs active parameters (e.g. 8B active of 120B total).",
    };
  }
  if (active > opts.paramsB) {
    return { ok: false, reason: "Active params cannot exceed total MoE size." };
  }
  return { ok: true };
}

/**
 * One unlock policy for the UI and the authoritative training action. Product
 * research gates the native product; sparse topology is an independent gate.
 */
export function trainingUnlockEligibility(opts: {
  family: TrainingFamily;
  backbone: TrainingBackbone;
  productPreset: TrainingProductPreset;
  researchUnlocked: readonly string[];
}): TrainingUnlockEligibility {
  const unlocked = new Set(opts.researchUnlocked);
  if (opts.backbone === "moe" && !unlocked.has("moe_basics")) {
    return {
      ok: false,
      reason: "Unlock Sparse Basics before MoE training.",
      researchNodeId: "moe_basics",
    };
  }

  const requiredProductResearch =
    opts.productPreset === "omni" || opts.family === "omni"
      ? (["mm_omni", "Omni Stack"] as const)
      : opts.productPreset === "video_generation" || opts.family === "video"
        ? (["mm_video", "Video Temporal Models"] as const)
        : opts.productPreset === "image_generation" ||
            opts.family === "diffusion" ||
            opts.backbone === "diffusion"
          ? (["mm_diff", "Latent Diffusion"] as const)
          : opts.productPreset === "audio" ||
              opts.productPreset === "vision_language"
            ? (["mm_vision", "Vision Encoders"] as const)
            : null;
  if (requiredProductResearch && !unlocked.has(requiredProductResearch[0])) {
    return {
      ok: false,
      reason: `Unlock ${requiredProductResearch[1]} first.`,
      researchNodeId: requiredProductResearch[0],
    };
  }
  return { ok: true };
}

function applyDomainFloor(
  weights: Record<DataDomain, number>,
  domain: DataDomain,
  floor: number,
): Record<DataDomain, number> {
  const normalized = normalizeWeights(weights);
  if (normalized[domain] + 1e-9 >= floor) return normalized;
  const otherTotal = Math.max(1e-9, 1 - normalized[domain]);
  const scale = (1 - floor) / otherTotal;
  return Object.fromEntries(
    DATA_DOMAINS.map((candidate) => [
      candidate,
      candidate === domain ? floor : normalized[candidate] * scale,
    ]),
  ) as Record<DataDomain, number>;
}

/** Product-aware recipe used whenever custom mixture engineering is locked. */
export function defaultTrainingDataWeights(
  family: TrainingFamily,
  productPreset: TrainingProductPreset,
): Record<DataDomain, number> {
  let weights = defaultDataWeights(family);
  for (const [domain, floor] of Object.entries(
    trainingDataModalityRequirements(family, productPreset),
  ) as [DataDomain, number][]) {
    weights = applyDomainFloor(weights, domain, floor);
  }
  return weights;
}

function actualConsumedDomainWeights(
  consumed: Partial<Record<DataDomain, number>>,
): { totalMTok: number; weights: Record<DataDomain, number> } {
  const totalMTok = DATA_DOMAINS.reduce(
    (sum, domain) => sum + Math.max(0, consumed[domain] ?? 0),
    0,
  );
  return {
    totalMTok,
    weights: Object.fromEntries(
      DATA_DOMAINS.map((domain) => [
        domain,
        totalMTok > 0 ? Math.max(0, consumed[domain] ?? 0) / totalMTok : 0,
      ]),
    ) as Record<DataDomain, number>,
  };
}

/** True when a player campaign incident is waiting; the daily clock must not advance. */
export function playerHasPendingTrainingDecision(state: SimState): boolean {
  return playerTrainingJobs(state).some(
    (job) => !job.failed && job.pendingCampaignEvent != null,
  );
}

function gymsLinkedToJob(state: SimState, job: TrainingJob): PostTrainGym[] {
  const gyms = normalizePostTrainGyms(state.player.postTrainGyms);
  const attached = job.attachedGymKinds;
  if (attached && attached.length > 0) {
    return gyms.filter((gym) => attached.includes(gym.kind));
  }
  return gyms;
}

function jobNeedsLinkedPostTrain(job: TrainingJob): boolean {
  if (job.failed || job.paused || job.pendingCampaignEvent) return false;
  if (job.postTrainPhaseResolved) return false;
  if (job.postTrain !== "none") return false;
  return (
    job.pendingPostTrainPhase === true ||
    job.progressPfDays + 1e-9 >= job.targetPfDays
  );
}

/** Read concurrent jobs while honoring direct legacy `trainingJob` mutations in old saves/tests. */
export function playerTrainingJobs(state: SimState): TrainingJob[] {
  const jobs = state.player.trainingJobs ?? [];
  const legacy = state.player.trainingJob;
  if (!legacy) return jobs;
  return [legacy, ...jobs.filter((job) => job.id !== legacy.id)];
}

export function withTrainingJobs(
  state: SimState,
  jobs: TrainingJob[],
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      trainingJobs: jobs,
      trainingJob: jobs[0] ?? null,
    },
  };
}

export function setTrainingLabs(
  state: SimState,
  jobId: string,
  kinds: readonly PostTrainGymKind[],
): SimState {
  const jobs = playerTrainingJobs(state);
  if (!jobs.some((job) => job.id === jobId)) {
    return {
      ...state,
      alerts: [
        {
          id: `labs-missing-${state.day}-${jobId}`,
          day: state.day,
          severity: "warn" as const,
          message: "Training run not found.",
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }
  const attachedGymKinds = [...new Set(kinds)].filter((kind) =>
    gymUnlocked(kind, state.player.researchUnlocked),
  );
  return withTrainingJobs(
    state,
    jobs.map((job) => (job.id === jobId ? { ...job, attachedGymKinds } : job)),
  );
}

function playerTrainingHardwareGeneration(
  state: SimState,
  format: TrainingComputeFormat,
): number {
  let generation = 0;
  for (const rack of state.player.rackFleet ?? []) {
    if (rack.status !== "live" || rack.count <= 0) continue;
    const accelerator = resolveRackSku(
      rack.skuId,
      state.player.rackDesigns ?? [],
    ).accelerator;
    if (accelerator && !accelerator.supportedTrainingFormats.includes(format))
      continue;
    generation = Math.max(generation, accelerator?.generation ?? 1);
  }
  for (const contract of state.computeContracts) {
    if (
      contract.buyerLabId !== state.playerLabId ||
      contract.status !== "active" ||
      contract.pf <= 0 ||
      (contract.availableDay != null && state.day < contract.availableDay)
    )
      continue;
    if (
      contract.supportedTrainingFormats &&
      !contract.supportedTrainingFormats.includes(format)
    )
      continue;
    generation = Math.max(generation, contract.acceleratorGeneration ?? 1);
  }
  return Math.max(generation, 1);
}

function playerTrainingHardwarePools(
  state: SimState,
  availableTrainingPf: number,
): TrainingHardwarePool[] {
  const capacityByGeneration = new Map<number, number>();
  let catalogLocalPf = 0;
  for (const rack of state.player.rackFleet ?? []) {
    if (rack.status !== "live" || rack.count <= 0) continue;
    const sku = resolveRackSku(rack.skuId, state.player.rackDesigns ?? []);
    const capacity = Math.max(0, sku.flopsPf * rack.count);
    const generation = sku.accelerator?.generation ?? 1;
    catalogLocalPf += capacity;
    capacityByGeneration.set(
      generation,
      (capacityByGeneration.get(generation) ?? 0) + capacity,
    );
  }

  // Include legacy blueprint deployments as conservative generation-1 PF.
  const aggregateLocalPf = Math.max(0, fleetStats(state).flopsPf);
  const legacyLocalPf = Math.max(0, aggregateLocalPf - catalogLocalPf);
  if (legacyLocalPf > 0) {
    capacityByGeneration.set(
      1,
      (capacityByGeneration.get(1) ?? 0) + legacyLocalPf,
    );
  }

  const remoteContracts = state.computeContracts.filter(
    (contract) =>
      contract.buyerLabId === state.playerLabId &&
      contract.status === "active" &&
      contract.pf > 0 &&
      (contract.availableDay == null || state.day >= contract.availableDay),
  );
  const bilateralInboundPf = state.computeLeases
    .filter((lease) => {
      if (lease.status !== "active" || lease.pf <= 0) return false;
      const buyerLabId =
        lease.buyerLabId ??
        (lease.playerSells ? lease.rivalId : state.playerLabId);
      return buyerLabId === state.playerLabId;
    })
    .reduce((sum, lease) => sum + lease.pf, 0);
  const localBasis = [...capacityByGeneration.values()].reduce(
    (sum, pf) => sum + pf,
    0,
  );
  const remoteBasis = remoteContracts.reduce(
    (sum, contract) => sum + contract.pf,
    0,
  );
  const basis = localBasis + remoteBasis + bilateralInboundPf;
  if (basis <= 0) {
    return [
      {
        id: "fallback-gen1",
        rawPf: Math.max(0, availableTrainingPf),
        hardwareGeneration: 1,
      },
    ];
  }
  return [
    ...[...capacityByGeneration.entries()].map(([generation, pf]) => ({
      id: `local-gen-${generation}`,
      rawPf: Math.max(0, availableTrainingPf) * (pf / basis),
      hardwareGeneration: generation,
    })),
    ...remoteContracts.map((contract) => ({
      id: `contract-${contract.id}`,
      rawPf: Math.max(0, availableTrainingPf) * (contract.pf / basis),
      hardwareGeneration: contract.acceleratorGeneration ?? 1,
      supportedTrainingFormats: contract.supportedTrainingFormats,
    })),
    ...(bilateralInboundPf > 0
      ? [
          {
            id: "bilateral-leases",
            rawPf:
              Math.max(0, availableTrainingPf) * (bilateralInboundPf / basis),
            hardwareGeneration: 1,
          },
        ]
      : []),
  ];
}

export interface TrainingResourceAllocation {
  rawPf: number;
  effectivePf: number;
  computeShare: number;
  ramAllocatedGb: number;
  ramRequiredGb: number;
  ramReady: boolean;
  systemRamAllocatedGb: number;
  systemRamRequiredGb: number;
  systemRamReady: boolean;
  bottleneck: "none" | "hbm" | "system_ram" | "both";
}

export interface PlayerTrainingResourcePlan {
  trainingRamGb: number;
  trainingSystemRamGb: number;
  trainingAllocationShare: number;
  jobs: Record<string, TrainingResourceAllocation>;
  /** Player-paid private evals share this exact PF/HBM allocator. */
  privateEvaluations: Record<string, TrainingResourceAllocation>;
  safetyCampaign?: TrainingResourceAllocation;
}

function liveTrainingDaysRemaining(
  job: TrainingJob,
  effectivePf: number,
  progressPfDays = job.progressPfDays,
  _daysElapsed = job.daysElapsed ?? 0,
): number {
  const remainingPfDays = Math.max(0, job.targetPfDays - progressPfDays);
  const usefulPfPerDay = Math.min(
    Math.max(0, effectivePf),
    pacedTrainingPfPerDay(job.targetPfDays, job.minCalendarDays),
  );
  const computeDays =
    remainingPfDays <= 1e-9
      ? 0
      : usefulPfPerDay > 1e-9
        ? remainingPfDays / usefulPfPerDay
        : Number.POSITIVE_INFINITY;
  return computeDays;
}

function trainingStallReason(
  state: SimState,
  snap: ComputeSnapshot,
  resources: PlayerTrainingResourcePlan,
  resource: TrainingResourceAllocation | undefined,
): string {
  if (resource && resource.bottleneck !== "none") {
    if (resource.bottleneck === "system_ram") {
      return `Training system RAM blocked: ${resource.systemRamRequiredGb.toFixed(0)} GB needed, ${resource.systemRamAllocatedGb.toFixed(0)} GB assigned from the ${Math.round(resources.trainingAllocationShare * 100)}% Training allocation.`;
    }
    if (resource.bottleneck === "both") {
      return `Training memory blocked: ${resource.ramRequiredGb.toFixed(0)} GB HBM and ${resource.systemRamRequiredGb.toFixed(0)} GB system RAM needed; ${resource.ramAllocatedGb.toFixed(0)} GB HBM and ${resource.systemRamAllocatedGb.toFixed(0)} GB system RAM assigned.`;
    }
    return `Training HBM blocked: ${resource.ramRequiredGb.toFixed(0)} GB needed, ${resource.ramAllocatedGb.toFixed(0)} GB assigned from the ${Math.round(resources.trainingAllocationShare * 100)}% Training allocation.`;
  }
  if (state.player.allocation.training <= 1e-9) {
    return "Training compute blocked: zero PF is allocated to Training.";
  }
  if (snap.mwAvailable <= 1e-9 || snap.powerDerate <= 1e-9) {
    return "Training compute power-blocked: no powered PF is available.";
  }
  if (snap.pools.training <= 1e-9) {
    return "Training compute blocked: the Training pool has zero effective PF.";
  }
  if (resource && resource.rawPf <= 1e-9) {
    return "Training format blocked: no allocated accelerator supports this training format.";
  }
  return "Training compute blocked: zero effective PF was allocated to this run.";
}

/** The configured Training slice owns the same share of accelerator RAM as PF. */
export function trainingAllocationShare(state: SimState): number {
  const allocation = state.player.allocation;
  const total =
    Math.max(0, allocation.training) +
    Math.max(0, allocation.inference) +
    Math.max(0, allocation.research);
  return total > 1e-9 ? Math.max(0, allocation.training) / total : 0.34;
}

export function trainingRamBudgetGb(
  state: SimState,
  snap = computeSnapshot(state),
): number {
  return snap.trainingRamGb ?? snap.vramGb * trainingAllocationShare(state);
}

/** A distributed job must fit wholly in one low-latency execution domain. */
function trainingMemoryDomainFit(
  state: SimState,
  snap: ComputeSnapshot,
  hbmRequiredGb: number,
  systemRamRequiredGb: number,
): { hbmReady: boolean; systemRamReady: boolean; ready: boolean } {
  const share = trainingAllocationShare(state);
  const localHbm = snap.localVramGb * share;
  const remoteHbm = snap.remoteVramGb * share;
  const localSystemRam = snap.localSystemRamGb * share;
  const remoteSystemRam = snap.remoteSystemRamGb * share;
  const localHbmReady = localHbm + 1e-9 >= hbmRequiredGb;
  const remoteHbmReady = remoteHbm + 1e-9 >= hbmRequiredGb;
  const localSystemReady = localSystemRam + 1e-9 >= systemRamRequiredGb;
  const remoteSystemReady = remoteSystemRam + 1e-9 >= systemRamRequiredGb;
  return {
    hbmReady: localHbmReady || remoteHbmReady,
    systemRamReady: localSystemReady || remoteSystemReady,
    ready:
      (localHbmReady && localSystemReady) ||
      (remoteHbmReady && remoteSystemReady),
  };
}

function jobTrainingRamGb(state: SimState, job: TrainingJob): number {
  return modelTrainVramGb(
    job.targetParamsB,
    job.activeParamsB,
    job.family,
    job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
    state.player.researchUnlocked.includes("opt_checkpoint"),
  );
}

function trainingMemoryForModel(
  state: SimState,
  model: {
    paramsB: number;
    activeParamsB?: number;
    family?: string;
    trainingNumerics?: TrainingNumerics;
  },
) {
  return estimateTrainingMemoryGb({
    paramsB: model.paramsB,
    activeParamsB: model.activeParamsB,
    family: model.family,
    numerics: model.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
    activationCheckpointing:
      state.player.researchUnlocked.includes("opt_checkpoint"),
  });
}

function jobTrainingSystemRamGb(state: SimState, job: TrainingJob): number {
  return trainingMemoryForModel(state, {
    paramsB: job.targetParamsB,
    activeParamsB: job.activeParamsB,
    family: job.family,
    trainingNumerics: job.trainingNumerics ?? job.numerics,
  }).requiredSystemRamGb;
}

export interface ProspectiveTrainingRamFit {
  ready: boolean;
  trainingRamGb: number;
  candidateAllocatedGb: number;
  candidateRequiredGb: number;
  blockerName?: string;
  blockerAllocatedGb?: number;
  blockerRequiredGb?: number;
  candidateSystemRamAllocatedGb: number;
  candidateSystemRamRequiredGb: number;
  blockerResource?: "HBM" | "system RAM";
}

/** Check the post-launch priority split so a new run cannot evict another run. */
export function trainingRamFitForNewJob(
  state: SimState,
  candidateRequiredGb: number,
  candidatePriority: number,
  snap = computeSnapshot(state),
  candidateSystemRamRequiredGb = Math.max(16, candidateRequiredGb * 0.15),
): ProspectiveTrainingRamFit {
  const safetyModel = state.player.safetyCampaign
    ? state.player.models.find(
        (model) => model.id === state.player.safetyCampaign!.modelId,
      )
    : undefined;
  const requests = [
    ...playerTrainingJobs(state)
      .filter(
        (job) =>
          !job.paused &&
          !job.failed &&
          (job.computePriority ?? 50) > 0 &&
          !job.pendingCampaignEvent,
      )
      .map((job) => ({
        id: job.id,
        name: job.name,
        weight: job.computePriority ?? 50,
        requiredGb: jobTrainingRamGb(state, job),
        systemRamRequiredGb: jobTrainingSystemRamGb(state, job),
      })),
    ...(safetyModel
      ? [
          {
            id: "__safety_campaign__",
            name: `${safetyModel.name} safety`,
            weight: 50,
            requiredGb: modelTrainVramGb(
              safetyModel.paramsB,
              safetyModel.activeParamsB,
              safetyModel.family,
              safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
              state.player.researchUnlocked.includes("opt_checkpoint"),
            ),
            systemRamRequiredGb: trainingMemoryForModel(state, safetyModel)
              .requiredSystemRamGb,
          },
        ]
      : []),
    {
      id: "__candidate__",
      name: "New run",
      weight: Math.max(0, candidatePriority),
      requiredGb: Math.max(0, candidateRequiredGb),
      systemRamRequiredGb: Math.max(0, candidateSystemRamRequiredGb),
    },
  ];
  const trainingRamGb = trainingRamBudgetGb(state, snap);
  const allocations = allocateWeightedTrainingCompute(trainingRamGb, requests);
  const systemRamGb = snap.systemRamGb * trainingAllocationShare(state);
  const systemAllocations = allocateWeightedTrainingCompute(
    systemRamGb,
    requests,
  );
  const hbmBlocker = requests.find(
    (request) =>
      (allocations[request.id]?.rawPf ?? 0) + 1e-9 < request.requiredGb,
  );
  const systemBlocker = requests.find(
    (request) =>
      (systemAllocations[request.id]?.rawPf ?? 0) + 1e-9 <
      request.systemRamRequiredGb,
  );
  const domainBlocker = requests.find(
    (request) =>
      !trainingMemoryDomainFit(
        state,
        snap,
        request.requiredGb,
        request.systemRamRequiredGb,
      ).ready,
  );
  const blocker = hbmBlocker ?? systemBlocker ?? domainBlocker;
  const domainFit = domainBlocker
    ? trainingMemoryDomainFit(
        state,
        snap,
        domainBlocker.requiredGb,
        domainBlocker.systemRamRequiredGb,
      )
    : undefined;
  return {
    ready: !hbmBlocker && !systemBlocker && !domainBlocker,
    trainingRamGb,
    candidateAllocatedGb: allocations.__candidate__?.rawPf ?? 0,
    candidateRequiredGb,
    blockerName: blocker?.name,
    blockerAllocatedGb: blocker
      ? (allocations[blocker.id]?.rawPf ?? 0)
      : undefined,
    blockerRequiredGb:
      hbmBlocker?.requiredGb ??
      systemBlocker?.systemRamRequiredGb ??
      (domainFit?.hbmReady
        ? domainBlocker?.systemRamRequiredGb
        : domainBlocker?.requiredGb),
    candidateSystemRamAllocatedGb: systemAllocations.__candidate__?.rawPf ?? 0,
    candidateSystemRamRequiredGb,
    blockerResource: hbmBlocker
      ? "HBM"
      : systemBlocker
        ? "system RAM"
        : domainBlocker
          ? domainFit?.hbmReady
            ? "system RAM"
            : "HBM"
          : undefined,
  };
}

function privateEvaluationTargetPf(job: PrivateEvaluationJob): number | null {
  const target =
    job.kind === "training_benchmark"
      ? job.pending.workload?.computePfDays
      : job.pending.quote.computePfDays;
  return target != null && Number.isFinite(target) ? Math.max(0, target) : null;
}

function privateEvaluationModel(
  state: SimState,
  job: PrivateEvaluationJob,
  trainingJobs: readonly TrainingJob[],
): {
  hbmGb: number;
  systemRamGb: number;
  numerics: TrainingNumerics;
} | null {
  if (job.kind === "training_benchmark") {
    const trainingJob = trainingJobs.find(
      (candidate) => candidate.id === job.subjectId,
    );
    if (!trainingJob) return null;
    const hbmGb = modelVramGb(
      trainingJob.targetParamsB,
      trainingJob.activeParamsB,
      trainingJob.family,
    );
    return {
      hbmGb,
      systemRamGb: Math.max(16, hbmGb * 0.15),
      numerics:
        trainingJob.trainingNumerics ??
        trainingJob.numerics ??
        LEGACY_TRAINING_NUMERICS,
    };
  }
  const model =
    job.kind === "checkpoint_evaluation"
      ? (state.player.trainingCheckpoints ?? []).find(
          (candidate) => candidate.id === job.subjectId,
        )?.model
      : state.player.models.find((candidate) => candidate.id === job.subjectId);
  if (!model) return null;
  const hbmGb = modelNativeVramGb(model);
  return {
    hbmGb,
    systemRamGb: Math.max(16, hbmGb * 0.15),
    numerics: model.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
  };
}

/**
 * Divide both training PF and its reserved RAM with the same priority weights.
 * RAM is a hard gate; compatible compute is reallocated away from blocked jobs.
 */
export function playerTrainingResourcePlan(
  state: SimState,
  snap = computeSnapshot(state),
): PlayerTrainingResourcePlan {
  const jobs = playerTrainingJobs(state);
  const safetyModel = state.player.safetyCampaign
    ? state.player.models.find(
        (model) => model.id === state.player.safetyCampaign!.modelId,
      )
    : undefined;
  const privateEvaluationRequests = (state.player.privateEvaluationJobs ?? [])
    .flatMap((job) => {
      const targetPf = privateEvaluationTargetPf(job);
      const model = privateEvaluationModel(state, job, jobs);
      const progress = Math.max(0, job.pending.computeProgressPfDays ?? 0);
      if (targetPf == null || !model || progress + 1e-9 >= targetPf) return [];
      return [
        {
          id: job.id,
          weight: 50,
          eligible: true,
          numerics: model.numerics,
          ramRequiredGb: model.hbmGb,
          systemRamRequiredGb: model.systemRamGb,
        },
      ];
    });
  const requests = [
    ...jobs.map((job) => ({
      id: job.id,
      weight: job.computePriority ?? 50,
      eligible:
        !job.paused &&
        !job.failed &&
        !job.pendingCampaignEvent,
      numerics:
        job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
      ramRequiredGb: jobTrainingRamGb(state, job),
      systemRamRequiredGb: jobTrainingSystemRamGb(state, job),
    })),
    ...(safetyModel
      ? [
          {
            id: "__safety_campaign__",
            weight: 50,
            eligible: true,
            numerics: safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
            ramRequiredGb: modelTrainVramGb(
              safetyModel.paramsB,
              safetyModel.activeParamsB,
              safetyModel.family,
              safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
              state.player.researchUnlocked.includes("opt_checkpoint"),
            ),
            systemRamRequiredGb: trainingMemoryForModel(state, safetyModel)
              .requiredSystemRamGb,
          },
        ]
      : []),
    ...privateEvaluationRequests,
  ];
  const trainingRamGb = trainingRamBudgetGb(state, snap);
  const ramAllocations = allocateWeightedTrainingCompute(
    trainingRamGb,
    requests,
  );
  const domainFits = Object.fromEntries(
    requests.map((request) => [
      request.id,
      trainingMemoryDomainFit(
        state,
        snap,
        request.ramRequiredGb,
        request.systemRamRequiredGb,
      ),
    ]),
  ) as Record<string, ReturnType<typeof trainingMemoryDomainFit>>;
  const ramReady = Object.fromEntries(
    requests.map((request) => [
      request.id,
      request.eligible !== false &&
        domainFits[request.id]!.hbmReady &&
        domainFits[request.id]!.ready &&
        (ramAllocations[request.id]?.rawPf ?? 0) + 1e-9 >=
          request.ramRequiredGb,
    ]),
  ) as Record<string, boolean>;
  const trainingSystemRamGb = snap.systemRamGb * trainingAllocationShare(state);
  const systemRamAllocations = allocateWeightedTrainingCompute(
    trainingSystemRamGb,
    requests,
  );
  const systemRamReady = Object.fromEntries(
    requests.map((request) => [
      request.id,
      request.eligible !== false &&
        domainFits[request.id]!.systemRamReady &&
        domainFits[request.id]!.ready &&
        (systemRamAllocations[request.id]?.rawPf ?? 0) + 1e-9 >=
          request.systemRamRequiredGb,
    ]),
  ) as Record<string, boolean>;
  const computeAllocations = allocateTrainingHardwarePools(
    playerTrainingHardwarePools(state, snap.pools.training),
    requests.map((request) => ({
      id: request.id,
      weight: request.weight,
      eligible:
        request.eligible !== false &&
        ramReady[request.id] &&
        systemRamReady[request.id],
      numerics: request.numerics,
    })),
  );
  const allocationFor = (
    id: string,
    ramRequiredGb: number,
    systemRamRequiredGb: number,
  ): TrainingResourceAllocation => {
    const compute = computeAllocations[id];
    const ram = ramAllocations[id];
    const systemRam = systemRamAllocations[id];
    const hbmOk = ramReady[id] ?? false;
    const hostOk = systemRamReady[id] ?? false;
    return {
      rawPf: compute?.rawPf ?? 0,
      effectivePf: compute?.effectivePf ?? 0,
      computeShare: compute?.share ?? 0,
      ramAllocatedGb: ram?.rawPf ?? 0,
      ramRequiredGb,
      ramReady: ramReady[id] ?? false,
      systemRamAllocatedGb: systemRam?.rawPf ?? 0,
      systemRamRequiredGb,
      systemRamReady: hostOk,
      bottleneck: hbmOk
        ? hostOk
          ? "none"
          : "system_ram"
        : hostOk
          ? "hbm"
          : "both",
    };
  };
  const safetyRequest = requests.find(
    (request) => request.id === "__safety_campaign__",
  );

  return {
    trainingRamGb,
    trainingSystemRamGb,
    trainingAllocationShare: trainingAllocationShare(state),
    jobs: Object.fromEntries(
      jobs.map((job) => {
        return [
          job.id,
          allocationFor(
            job.id,
            jobTrainingRamGb(state, job),
            jobTrainingSystemRamGb(state, job),
          ),
        ];
      }),
    ),
    privateEvaluations: Object.fromEntries(
      privateEvaluationRequests.map((request) => [
        request.id,
        allocationFor(
          request.id,
          request.ramRequiredGb,
          request.systemRamRequiredGb,
        ),
      ]),
    ),
    safetyCampaign: safetyRequest
      ? allocationFor(
          safetyRequest.id,
          safetyRequest.ramRequiredGb,
          safetyRequest.systemRamRequiredGb,
        )
      : undefined,
  };
}

type TrainableStage = "base" | Exclude<PostTrainStage, "none">;

/**
 * Rare unrecoverable recipe failures. Routine hardware interruptions are
 * already absorbed by achieved utilization/checkpoint overhead and should not
 * destroy an otherwise healthy run.
 */
export function trainingStageFailurePlan(
  job: Pick<TrainingJob, "id" | "outcomeSeed" | "outcomeRisk"> &
    Partial<TrainingJob>,
  stage: TrainableStage,
  context?: {
    researchUnlocked?: readonly string[];
    models?: readonly Model[];
    day?: number;
  },
): { willFail: boolean; atFraction: number; probability: number } {
  if (stage !== "base") {
    const frozen = job.postTrainRiskPlan;
    if (frozen?.stage === stage) {
      return {
        willFail: frozen.willFail,
        atFraction: frozen.atFraction,
        probability: frozen.probability,
      };
    }
    const plan = createPostTrainRiskPlan(
      job as TrainingJob,
      stage,
      context?.researchUnlocked ?? [],
      context?.models ?? [],
      context?.day ?? 0,
    );
    return {
      willFail: plan.willFail,
      atFraction: plan.atFraction,
      probability: plan.probability,
    };
  }
  const rng = createRng(
    hashSeed(job.outcomeSeed ?? 0, job.id, stage, "stage-failure-v1"),
  );
  const baseRisk =
    job.outcomeRisk === "high"
      ? 0.1
      : job.outcomeRisk === "medium"
        ? 0.04
        : 0.015;
  const willFail = rng.next() < baseRisk * (stage === "base" ? 1 : 0.65);
  return {
    willFail,
    atFraction: 0.18 + rng.next() * 0.7,
    probability: baseRisk,
  };
}

/** Freeze one explainable hidden roll when a post-training stage begins. */
export function createPostTrainRiskPlan(
  job: TrainingJob,
  stage: Exclude<PostTrainStage, "none">,
  researchUnlocked: readonly string[],
  models: readonly Model[],
  day: number,
  startFraction = 0,
): PostTrainRiskPlan {
  const assessment = postTrainFailureRisk({
    job,
    stage,
    researchUnlocked,
    models,
  });
  const rng = createRng(
    hashSeed(
      job.outcomeSeed ?? 0,
      job.id,
      stage,
      job.postTrainRecoveryAttempt ?? 0,
      job.postTrainStageRuns?.[stage] ?? 0,
      "posttrain-stage-failure-v2",
    ),
  );
  const survivedFraction = Math.max(0, Math.min(0.98, startFraction));
  const probability = Math.max(
    0.008,
    assessment.probability * (1 - survivedFraction * 0.55),
  );
  const band: PostTrainRiskPlan["band"] =
    probability < 0.055
      ? "low"
      : probability < 0.12
        ? "guarded"
        : probability < 0.22
          ? "high"
          : "critical";
  return {
    stage,
    probability,
    band,
    willFail: rng.next() < probability,
    atFraction:
      survivedFraction + (1 - survivedFraction) * (0.2 + rng.next() * 0.65),
    startFraction: survivedFraction || undefined,
    factors: [
      ...assessment.factors,
      ...(survivedFraction > 0 ? ["checkpoint recovery attempt"] : []),
    ],
    createdDay: day,
    seedVersion: 2,
  };
}

function estimateJobDailyThroughput(
  state: SimState,
  opts: {
    numerics: NonNullable<TrainingJob["trainingNumerics"]>;
    computePriority: number;
    reservedPf?: number;
    concurrentJobs: number;
  },
): number {
  const snap = computeSnapshot(state);
  const concurrent = Math.max(1, opts.concurrentJobs);
  const hardwarePools = playerTrainingHardwarePools(state, snap.pools.training);
  const allocations = allocateTrainingHardwarePools(hardwarePools, [
    {
      id: "__new_job__",
      weight: opts.computePriority,
      eligible: true,
      numerics: opts.numerics,
    },
    ...Array.from({ length: concurrent - 1 }, (_, index) => ({
      id: `__peer_${index}__`,
      weight: 50,
      eligible: true,
      numerics: DEFAULT_TRAINING_NUMERICS,
    })),
  ]);
  return Math.max(0, allocations.__new_job__?.effectivePf ?? 0);
}

/**
 * Observed training loss. The signal is intentionally less tidy than the
 * underlying learning curve: seeded jitter, two-sided spikes and short
 * divergence/recovery episodes sit on top of a long-run improving trend.
 * Deterministic per (job, stage, day) via seeded RNG — never Math.random.
 */
export function trainingLoss(
  job: Pick<TrainingJob, "id" | "outcomeSeed" | "targetParamsB"> &
    Partial<
      Pick<
        TrainingJob,
        | "trainingNumerics"
        | "numerics"
        | "dataPlan"
        | "dataQualityUsed"
        | "integratedMethods"
        | "outcomeRisk"
        | "effectiveDataRatio"
        | "repeatedDataEpochs"
      >
    >,
  stage: TrainableStage,
  progress: number,
  day: number,
  previousObservedLoss?: number,
): number {
  const precision = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
  );
  const rawProgress = Math.max(0, progress);
  // Beyond the recommended target, optimization can continue but its visible
  // loss improvement must flatten quickly. This mirrors the bounded maturity
  // curve used for finalized capability instead of drawing an artificial flat
  // line while the player is still spending compute.
  const p =
    rawProgress <= 1
      ? rawProgress
      : 1 + 0.18 * (1 - Math.exp(-(rawProgress - 1) / 0.75));

  const weights = Object.values(job.dataPlan?.weights ?? {}).filter(
    (weight): weight is number => Number.isFinite(weight) && weight > 0,
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const diversity =
    weights.length <= 1 || weightTotal <= 0
      ? weights.length === 1
        ? 0
        : 0.65
      : -weights.reduce((entropy, weight) => {
          const share = weight / weightTotal;
          return entropy + share * Math.log(share);
        }, 0) / Math.log(weights.length);
  const quality = Math.max(0, Math.min(1, (job.dataQualityUsed ?? 70) / 100));
  const repeatPressure = Math.max(0, (job.repeatedDataEpochs ?? 1) - 1);
  const dataRatio = job.effectiveDataRatio;
  const dataRatioRisk =
    dataRatio == null
      ? 0
      : Math.min(0.22, Math.max(0, 1 - dataRatio) * 0.18) +
        Math.min(0.18, Math.max(0, dataRatio - 8) * 0.018);
  const qualityGap = 0.7 - quality;
  const diversityGap = 0.65 - diversity;
  const chatShare =
    stage === "base"
      ? job.dataPlan?.weights?.chat ?? 0
      : (job.dataPlan?.postTrainWeights?.chat ??
        job.dataPlan?.weights?.chat ??
        0);
  const chatInBase = Math.max(0, chatShare - 0.08);
  const postTrainMTok = job.dataPlan?.postTrainMTok ?? 0;
  const alignmentStarve =
    stage === "base"
      ? 0
      : Math.max(0, 0.18 - chatShare) * 1.4 +
        Math.max(0, 12 - postTrainMTok) * 0.018;

  // This terminal band is derived from scale and the data recipe. Typical
  // jobs settle visibly in the high-threes/low-fours without a magic target.
  const baseBand =
    3.45 +
    Math.log10(Math.max(1, job.targetParamsB)) * 0.18 +
    qualityGap * 1.2 +
    diversityGap * 0.55 +
    Math.min(0.45, repeatPressure * 0.09) +
    chatInBase * 2.1 +
    alignmentStarve;
  const baseStart =
    baseBand + 5.15 + Math.log10(Math.max(1, job.targetParamsB)) * 0.28;
  const postStageAdjustment =
    stage === "rlhf" || stage === "process"
      ? -0.18
      : stage === "tools"
        ? 0.08
        : -0.08;
  const postSpike =
    stage === "base" ? 0 : 0.55 * Math.exp(-9 * p) * (0.55 + chatShare);
  const trend =
    stage === "base"
      ? baseBand +
        (baseStart - baseBand) * Math.exp(-2.6 * p - 1.15 * p * p) -
        0.08 * p
      : baseBand +
        postStageAdjustment -
        0.14 * p * (0.45 + chatShare) +
        (0.72 + baseBand * 0.08) * Math.exp(-6.2 * p) +
        postSpike;

  const stableOptimizationMethods = new Set([
    "opt_mixed",
    "opt_te_fp8",
    "opt_overlap_comm",
    "opt_grad_accum",
    "data_eval",
  ]);
  const stabilityResearch = (job.integratedMethods ?? []).filter((method) =>
    stableOptimizationMethods.has(method),
  ).length;
  const outcomeRisk =
    job.outcomeRisk === "high" ? 0.28 : job.outcomeRisk === "medium" ? 0.12 : 0;
  const volatility = Math.max(
    0.45,
    precision.lossVolatilityMultiplier *
      (1 +
        Math.max(0, qualityGap) * 0.55 +
        Math.max(0, 0.65 - diversity) * 0.45 +
        Math.max(0, diversity - 0.65) *
          0.55 *
          Math.pow(Math.max(0, 1 - p), 1.5) +
        Math.min(0.35, repeatPressure * 0.07) +
        dataRatioRisk +
        Math.max(0, precision.stabilityRisk) +
        outcomeRisk) *
      Math.max(0.72, 1 - stabilityResearch * 0.055),
  );

  const rng = createRng(
    hashSeed(job.outcomeSeed ?? 0, job.id, stage, day, "loss-v3"),
  );
  const prev =
    previousObservedLoss == null || !Number.isFinite(previousObservedLoss)
      ? trend
      : previousObservedLoss;
  // Mean-revert toward today's trend; residual carries day-to-day wobble.
  const residual =
    (prev - trend) * 0.56 + rng.range(-0.032, 0.032) * volatility;
  let observed = trend + residual;

  // A block seed makes instability persist for several samples: the curve
  // first diverges, then recovers and can briefly undershoot its trend.
  const episodeLength = 9;
  const episodeIndex = Math.floor(day / episodeLength);
  const episodePhase = ((day % episodeLength) + episodeLength) % episodeLength;
  const episodeRng = createRng(
    hashSeed(
      job.outcomeSeed ?? 0,
      job.id,
      stage,
      episodeIndex,
      "loss-divergence-v1",
    ),
  );
  if (episodeRng.next() < Math.min(0.34, 0.1 * volatility)) {
    const amplitude = episodeRng.range(0.055, 0.14) * volatility;
    const episodeShape =
      episodePhase <= 3
        ? episodePhase / 3
        : episodePhase <= 6
          ? (6 - episodePhase) / 3
          : -(episodePhase - 6) / 6;
    observed *= 1 + amplitude * episodeShape;
  }

  // Optimizer shocks go both ways; negative spikes model lucky batches or a
  // recovered learning-rate step rather than forcing every wobble upward.
  if (rng.next() < Math.min(0.32, 0.16 * volatility)) {
    const direction = rng.next() < 0.58 ? 1 : -1;
    observed *= 1 + direction * rng.range(0.015, 0.055) * volatility;
  }
  const floor = baseBand * 0.82;
  return Math.max(floor, Math.round(observed * 1000) / 1000);
}

export function observedLoss(job: TrainingJob): number | null {
  const history = job.lossHistory ?? [];
  if (!history.length) return null;
  return history[history.length - 1]!.loss;
}

export const LOSS_PLATEAU_WINDOW = 6;
export const LOSS_PLATEAU_TOLERANCE = 0.04;

/**
 * Detect a flat recent loss curve without relying on wall-clock randomness.
 * A plateau needs a full same-stage window, little end-to-end improvement,
 * and no large excursion hidden inside that window.
 */
export function detectLossPlateau(
  job: Pick<TrainingJob, "lossHistory">,
  tolerance: number = LOSS_PLATEAU_TOLERANCE,
): boolean {
  const history = job.lossHistory ?? [];
  const stage = history.at(-1)?.stage;
  if (!stage) return false;
  const recent = history
    .filter((point) => point.stage === stage && Number.isFinite(point.loss))
    .slice(-LOSS_PLATEAU_WINDOW);
  if (recent.length < LOSS_PLATEAU_WINDOW) return false;
  const losses = recent.map((point) => point.loss);
  const improvement = losses[0]! - losses.at(-1)!;
  const excursion = Math.max(...losses) - Math.min(...losses);
  const allowed = Math.max(0, tolerance);
  return Math.abs(improvement) <= allowed && excursion <= allowed * 2.5;
}

/** Minimum compute fraction before Launch now / keep-internal is available. */
export const MIN_LAUNCH_PROGRESS_FRAC = 0.05;

export function trainingMinimumStatus(job: TrainingJob): {
  ok: boolean;
  reason?: string;
  computeReady: boolean;
  calendarReady: boolean;
  completeReady: boolean;
  plateaued: boolean;
  earlyReleaseReady: boolean;
  launchReady: boolean;
  calendarRemaining: number;
} {
  if (job.failed)
    return {
      ok: false,
      reason: "This run failed and cannot be released.",
      computeReady: false,
      calendarReady: false,
      completeReady: false,
      plateaued: false,
      earlyReleaseReady: false,
      launchReady: false,
      calendarRemaining: 0,
    };
  const progressFrac = job.progressPfDays / Math.max(job.targetPfDays, 1e-9);
  const computeReady = job.progressPfDays + 1e-9 >= job.targetPfDays;
  // PF is authoritative. Legacy calendar fields are telemetry only.
  const calendarRemaining = 0;
  const calendarReady = true;
  const plateaued = detectLossPlateau(job);
  const completeReady = computeReady;
  const launchReady =
    job.progressPfDays > 0 && progressFrac + 1e-12 >= MIN_LAUNCH_PROGRESS_FRAC;
  // Anytime launch: plateau is informational; maturity penalties handle quality.
  const earlyReleaseReady = launchReady && !completeReady;
  if (!launchReady) {
    return {
      ok: false,
      reason: `Train at least ${Math.round(MIN_LAUNCH_PROGRESS_FRAC * 100)}% of the compute target before launching.`,
      computeReady,
      calendarReady,
      completeReady,
      plateaued,
      earlyReleaseReady,
      launchReady,
      calendarRemaining,
    };
  }
  if (!completeReady) {
    return {
      ok: false,
      reason: plateaued
        ? "Loss has plateaued; launch now ships a degraded checkpoint."
        : "Launch now available — capability and benchmarks scale with completed compute.",
      computeReady,
      calendarReady,
      completeReady,
      plateaued,
      earlyReleaseReady,
      launchReady,
      calendarRemaining,
    };
  }
  return {
    ok: true,
    computeReady,
    calendarReady,
    completeReady,
    plateaued,
    earlyReleaseReady,
    launchReady,
    calendarRemaining,
  };
}

export function canReleaseTrainingJob(job: TrainingJob): {
  ok: boolean;
  reason?: string;
  releaseKind?: "complete" | "early";
} {
  if (job.pendingCampaignEvent) {
    return {
      ok: false,
      reason: `Resolve the ${job.pendingCampaignEvent.title} training decision first.`,
    };
  }

  if (
    job.postTrain !== "none" &&
    job.postTrainProgress + 1e-9 < job.postTrainTarget
  ) {
    return {
      ok: false,
      reason: `Finish ${job.postTrain.toUpperCase()} compute before finalizing this checkpoint.`,
    };
  }
  const status = trainingMinimumStatus(job);
  if (status.completeReady) return { ok: true, releaseKind: "complete" };
  if (status.launchReady || status.earlyReleaseReady) {
    return { ok: true, releaseKind: "early" };
  }
  return { ok: false, reason: status.reason };
}

/**
 * Continuous maturity haircut for anytime launch.
 * Capability / benchmarks / reliability track √(progress/target), with a light
 * additional factor when funded calendar days are still below the recommendation.
 */
export function earlyReleasePenalty(
  job: Pick<
    TrainingJob,
    | "progressPfDays"
    | "targetPfDays"
    | "recommendedPfDays"
    | "daysElapsed"
    | "minCalendarDays"
  >,
): {
  progress: number;
  calendarProgress: number;
  capabilityMultiplier: number;
  benchmarkMultiplier: number;
  reliabilityMultiplier: number;
} {
  const progress = Math.max(
    0,
    Math.min(
      1,
      job.progressPfDays /
        Math.max(job.recommendedPfDays ?? job.targetPfDays, 1e-9),
    ),
  );
  const calendarProgress = 1;
  const maturity = Math.sqrt(progress);
  return {
    progress,
    calendarProgress,
    capabilityMultiplier: 0.45 + maturity * 0.55,
    benchmarkMultiplier: 0.35 + maturity * 0.65,
    reliabilityMultiplier: 0.3 + maturity * 0.7,
  };
}

export function extendTraining(
  state: SimState,
  jobId: string,
  _days: number = TRAINING_EXTENSION_DAYS,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.failed) return state;
  return withAlert(
    state,
    "warn",
    `${job.name} has a fixed PF target. Finish it or start a versioned continuation from a checkpoint.`,
  );
}

export function appendLossPoint(
  job: TrainingJob,
  stage: TrainableStage,
  progress: number,
  day: number,
): TrainingJob["lossHistory"] {
  const history = job.lossHistory ?? [];
  const previous = [...history]
    .reverse()
    .find((point) => point.stage === stage)?.loss;
  const next = [
    ...history,
    {
      day,
      stage,
      progress,
      loss: trainingLoss(job, stage, progress, day, previous),
    },
  ];
  return next.slice(-64);
}

function postTrainRecoveryCheckpoint(
  state: SimState,
  job: TrainingJob,
  stage: Exclude<PostTrainStage, "none">,
  failureFraction: number,
): TrainingCheckpointCandidate | undefined {
  const failedStageIndex = POST_TRAIN_ORDER.indexOf(stage);
  const checkpointStageIndex = (candidate: TrainingCheckpointCandidate) =>
    candidate.stage === "base" ? 0 : POST_TRAIN_ORDER.indexOf(candidate.stage);
  return [...(state.player.trainingCheckpoints ?? [])]
    .filter((checkpoint) => {
      if (
        checkpoint.sourceJobId !== job.id ||
        checkpoint.status === "discarded"
      )
        return false;
      const stageIndex = checkpointStageIndex(checkpoint);
      if (stageIndex < 0 || stageIndex > failedStageIndex) return false;
      if (checkpoint.stage === "base") {
        return checkpoint.telemetry.progress + 1e-9 >= 1;
      }
      if (stageIndex < failedStageIndex) return true;
      return checkpoint.telemetry.stageProgress + 1e-9 < failureFraction;
    })
    .sort((a, b) => {
      const stageDelta = checkpointStageIndex(b) - checkpointStageIndex(a);
      if (stageDelta !== 0) return stageDelta;
      const progressDelta =
        b.telemetry.stageProgress - a.telemetry.stageProgress;
      if (Math.abs(progressDelta) > 1e-9) return progressDelta;
      return b.capturedDay - a.capturedDay || b.id.localeCompare(a.id);
    })[0];
}

/** The exact snapshot accepted by the one-click failed-run recovery action. */
export function eligiblePostTrainRecoveryCheckpoint(
  state: SimState,
  jobId: string,
): TrainingCheckpointCandidate | undefined {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === jobId,
  );
  const checkpointId =
    job?.failureRecord?.recoveryCheckpointId ??
    job?.failureRecoveryCheckpointId;
  if (!job?.failed || job.failureStage === "base" || !checkpointId)
    return undefined;
  return (state.player.trainingCheckpoints ?? []).find(
    (checkpoint) =>
      checkpoint.id === checkpointId &&
      checkpoint.sourceJobId === job.id &&
      checkpoint.status !== "discarded",
  );
}

function failTrainingJob(
  job: TrainingJob,
  stage: TrainableStage,
  day: number,
  failureFraction: number,
  recoveryCheckpoint?: TrainingCheckpointCandidate,
): TrainingJob {
  const risk =
    stage === "base" || job.postTrainRiskPlan?.stage !== stage
      ? undefined
      : job.postTrainRiskPlan;
  const failureKind: TrainingFailureRecord["kind"] =
    stage === "base"
      ? "numerical_divergence"
      : stage === "sft"
        ? "supervision_collapse"
        : stage === "rlhf"
          ? "preference_collapse"
          : stage === "process"
            ? "reward_model_collapse"
            : "tool_policy_collapse";
  const probability =
    risk?.probability ?? trainingStageFailurePlan(job, stage).probability;
  const riskBand: TrainingFailureRecord["riskBand"] =
    risk?.band ??
    (probability < 0.025
      ? "low"
      : probability < 0.065
        ? "guarded"
        : probability < 0.12
          ? "high"
          : "critical");
  const stageProgress = Math.max(0, Math.min(1, failureFraction));
  return {
    ...job,
    failed: true,
    failureStage: stage,
    failureDay: day,
    failureReason:
      stage === "base"
        ? "Loss diverged during base training. This checkpoint is unrecoverable."
        : recoveryCheckpoint
          ? `The ${stage.toUpperCase()} stage destabilized at ${Math.round((risk?.atFraction ?? 0) * 100)}%. Recover by branching from immutable checkpoint ${recoveryCheckpoint.model.name}; spent compute is not refunded.`
          : `The ${stage.toUpperCase()} stage destabilized. No eligible pre-failure checkpoint exists, so this run cannot be recovered.`,
    failureRecord: {
      kind: failureKind,
      stage,
      day,
      progressPfDays: job.progressPfDays,
      stageProgress,
      probability,
      riskBand,
      factors: [...(risk?.factors ?? ["recipe-level optimizer variance"])],
      recoveryCheckpointId: recoveryCheckpoint?.id,
    },
    failureRecoveryCheckpointId: recoveryCheckpoint?.id,
    paused: true,
    stallReason: recoveryCheckpoint
      ? "Post-training failed — recover from the saved checkpoint or delete this run."
      : "Training failed — no recovery checkpoint; delete this run.",
  };
}

/**
 * Hard per-domain cap (MTok) for training-data radar drags. Without synthetic
 * expansion the drag stops at the owned real corpus; with expansion the recipe
 * may oversubscribe real stock with generated tokens, hard-capped at 8× the
 * domain's real + synthetic (e.g. distill teacher) base.
 */
export function trainingDataDomainCapMTok(
  realAvailableMTok: number,
  syntheticAvailableMTok: number,
  syntheticMultiplier: number,
): number {
  const real = Math.max(0, realAvailableMTok);
  if (!(syntheticMultiplier > 0)) return real;
  const base = real + Math.max(0, syntheticAvailableMTok);
  return Math.min(base * (1 + syntheticMultiplier), base * 8);
}

/**
 * Corpus volume attributed to live training jobs, per domain. Pretrain data
 * attribution is read-only, so this is the authoritative reservation input
 * for recipe planning: a new run should not plan on tokens another active job
 * already claimed. Failed jobs release their attribution.
 */
export function trainingDataReservedMTokByDomain(
  state: SimState,
): Partial<Record<DataDomain, number>> {
  const reserved: Partial<Record<DataDomain, number>> = {};
  for (const job of playerTrainingJobs(state)) {
    if (job.failed) continue;
    for (const [domain, volume] of Object.entries(job.dataConsumed ?? {})) {
      const key = domain as DataDomain;
      reserved[key] = (reserved[key] ?? 0) + Math.max(0, volume ?? 0);
    }
  }
  return reserved;
}

/**
 * Distill: the selected teacher doubles as the synthetic generator, so the
 * recipe may oversubscribe the owned corpus even without Synthetic Generators
 * research. Top up per-domain shortfalls with teacher-generated tokens (bounded
 * by the shared radar cap against the teacher's corpus headroom) and record
 * provenance so finalize's syntheticTrainingProfile math keys off the teacher.
 */
function fillDistillTeacherSynthetic(
  consume: ConsumeResult,
  opts: {
    teacher: Model;
    labData: LabData;
    weights: Record<DataDomain, number>;
    requestedTotalMTok: number;
    syntheticMultiplier: number;
    frontierCapability: number;
    paramsB: number;
    effortIds?: Partial<Record<DataDomain, string>>;
  },
): ConsumeResult {
  const { teacher } = opts;
  const multiplier = Math.max(0, opts.syntheticMultiplier);
  if (multiplier <= 0) return consume;
  const headroom = teacherSyntheticHeadroomMTok({
    teacher,
    frontierCapability: opts.frontierCapability,
  });
  const consumed = { ...consume.consumed };
  const domainQuality = { ...consume.domainQuality };
  const lowQualityShareByDomain = { ...consume.lowQualityShareByDomain };
  const provenance: SyntheticFillRecord[] = [];
  let generationComputePfDays = 0;
  let generationCashCost = 0;
  for (const domain of DATA_DOMAINS) {
    const want = Math.max(0, opts.requestedTotalMTok * opts.weights[domain]);
    const prior = consumed[domain] ?? 0;
    const short = want - prior;
    if (short <= 0.01) continue;
    const stock = normalizeDomainStock(opts.labData.stocks[domain]);
    const realAvailable = Math.max(
      0,
      stock.processed - stock.fromSynthHQ - stock.fromSynthLQ,
    );
    const cap = trainingDataDomainCapMTok(
      realAvailable,
      headroom[domain],
      multiplier,
    );
    const fill = Math.min(short, Math.max(0, cap - prior));
    if (fill <= 0.01) continue;
    const generation = syntheticTeacherGenerationEconomics({
      model: teacher,
      domain,
      effortId: opts.effortIds?.[domain],
      acceptedMTok: fill,
    });
    const quality = Math.min(
      92,
      48 + generation.effectiveDomainCapability * 0.55,
    );
    const qualityTier = quality >= 58 ? ("hq" as const) : ("lq" as const);
    consumed[domain] = prior + fill;
    domainQuality[domain] =
      ((domainQuality[domain] ?? consume.qualityUsed) * prior +
        quality * fill) /
      Math.max(0.01, prior + fill);
    lowQualityShareByDomain[domain] =
      qualityTier === "lq" ? fill / Math.max(0.01, prior + fill) : 0;
    generationComputePfDays += generation.computePfDays;
    generationCashCost += generation.cashCost;
    provenance.push({
      domain,
      teacherModelId: teacher.id,
      teacherName: teacher.name,
      teacherEffortId: generation.effortId,
      teacherEffortName: generation.effortName,
      teacherThinkingTokenMult: generation.thinkingTokenMultiplier,
      teacherEffortQuality: generation.effortQuality,
      billedTokenMultiplier: generation.billedTokenMultiplier,
      teacherComputeIntensityMultiplier:
        generation.computeIntensityMultiplier,
      generatedTokenMTok: generation.generatedTokenMTok,
      generationComputePfDays: generation.computePfDays,
      generationCashCost: generation.cashCost,
      volumeMTok: fill,
      quality,
      qualityTier,
    });
  }
  if (!provenance.length) return consume;
  const actualVolume = Object.values(consumed).reduce(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  let qualityAcc = 0;
  for (const domain of DATA_DOMAINS) {
    const volume = consumed[domain] ?? 0;
    if (volume > 0) {
      qualityAcc += (domainQuality[domain] ?? consume.qualityUsed) * volume;
    }
  }
  const trainShare = consume.plan.trainShare;
  const teacherSynthMTok = provenance.reduce(
    (sum, record) => sum + record.volumeMTok,
    0,
  );
  const synthHqUnits =
    (consume.synthHqUnits ?? 0) +
    provenance
      .filter((record) => record.qualityTier === "hq")
      .reduce((sum, record) => sum + record.volumeMTok, 0);
  const synthLqUnits =
    (consume.synthLqUnits ?? 0) +
    provenance
      .filter((record) => record.qualityTier === "lq")
      .reduce((sum, record) => sum + record.volumeMTok, 0);
  const syntheticProvenance = [
    ...(consume.syntheticProvenance ?? []),
    ...provenance,
  ];
  return {
    ...consume,
    plan: {
      ...consume.plan,
      totalMTok: actualVolume,
      totalUnits: actualVolume,
      syntheticProvenance,
    },
    consumed,
    coverage: Math.min(
      30,
      actualVolume / Math.max(1, minDataMTokForParams(opts.paramsB)),
    ),
    qualityUsed: applySynthQualityTax(
      actualVolume > 0 ? qualityAcc / actualVolume : consume.qualityUsed,
      actualVolume > 0
        ? (consume.syntheticUnits + teacherSynthMTok) / actualVolume
        : 0,
      actualVolume > 0 ? synthLqUnits / actualVolume : 0,
    ),
    syntheticUnits: consume.syntheticUnits + teacherSynthMTok,
    synthHqUnits,
    synthLqUnits,
    synthLqShare: actualVolume > 0 ? synthLqUnits / actualVolume : 0,
    cashCost: consume.cashCost + generationCashCost,
    syntheticGenerationPfDays:
      (consume.syntheticGenerationPfDays ?? 0) +
      generationComputePfDays,
    trainMTok: actualVolume * trainShare,
    verifyMTok: actualVolume * (1 - trainShare),
    domainQuality,
    lowQualityShareByDomain,
    syntheticProvenance,
  };
}

export function estimateTrainingCost(
  state: SimState,
  opts: Pick<
    StartTrainingOpts,
    "paramsB" | "family" | "backbone" | "activeParamsB" | "mode" | "teacherId"
  >,
): number {
  const teacher = opts.teacherId
    ? state.player.models.find((m) => m.id === opts.teacherId)
    : undefined;
  const mode = opts.mode === "distill" ? "distill" : "pretrain";
  return trainCostPfDays({
    paramsB: opts.paramsB,
    family: opts.family,
    backbone: opts.backbone,
    trainEfficiency: state.player.trainEfficiency,
    activeParamsB: opts.activeParamsB,
    mode,
    teacherParamsB: teacher?.paramsB,
  });
}

export function startTraining(
  state: SimState,
  opts: StartTrainingOpts,
): SimState {
  const existingJobs = playerTrainingJobs(state);
  let numerics = opts.trainingNumerics ?? DEFAULT_TRAINING_NUMERICS;

  const mode = opts.mode ?? "pretrain";
  const dataMix: DataMix = opts.dataMix ?? "web";
  let family = opts.family;
  let backbone = opts.backbone ?? backboneFromFamily(family);
  let productPreset = opts.productPreset ?? presetFromFamily(family);
  let io = opts.io ?? ioForPreset(productPreset);
  let paramsB = opts.paramsB;
  let activeParamsB = opts.activeParamsB;
  let continueFromId: string | undefined;
  let continueLineageId: string | undefined;
  let continuationBase: Model | undefined;
  let baseContinueCap = 0;

  if (mode === "continue") {
    if (!opts.continueFromId) {
      return withAlert(state, "warn", "Pick a model to continue training.");
    }
    const privateCheckpoint = opts.continueFromCheckpointId
      ? (state.player.trainingCheckpoints ?? []).find(
          (candidate) =>
            candidate.id === opts.continueFromCheckpointId &&
            candidate.status !== "discarded",
        )
      : undefined;
    const base = privateCheckpoint
      ? privateCheckpoint.model
      : state.player.models.find((m) => m.id === opts.continueFromId);
    if (!base) return withAlert(state, "warn", "Base model not found.");
    continuationBase = base;
    family = base.family;
    backbone = base.backbone ?? backboneFromFamily(base.family);
    productPreset = migrateLegacyProductPreset(
      base.productPreset ?? presetFromFamily(base.family),
      base.io,
    );
    io = base.io ?? ioForPreset(productPreset, base.capability);
    paramsB = base.paramsB;
    activeParamsB = base.activeParamsB;
    continueFromId = base.id;
    continueLineageId = base.lineageId ?? base.id;
    // A continuation refines weights and data; it cannot silently swap the
    // checkpoint's architecture, stack, topology, or numerical recipe.
    numerics = base.trainingNumerics ?? DEFAULT_TRAINING_NUMERICS;
    if (
      !privateCheckpoint &&
      existingJobs.some((candidate) => {
        if (candidate.failed || !candidate.continueFromId) return false;
        const candidateSource = state.player.models.find(
          (model) => model.id === candidate.continueFromId,
        );
        const candidateLineage =
          candidate.continueLineageId ??
          candidateSource?.lineageId ??
          candidate.continueFromId;
        return candidateLineage === continueLineageId;
      })
    ) {
      return withAlert(
        state,
        "warn",
        `${base.name} already has a continuation run in progress.`,
      );
    }
    if (
      privateCheckpoint &&
      existingJobs.some(
        (candidate) =>
          candidate.parentCheckpointId === privateCheckpoint.id &&
          candidate.branchDirection === (opts.branchDirection ?? "general"),
      )
    ) {
      return withAlert(
        state,
        "warn",
        "That checkpoint already has this branch direction in progress.",
      );
    }
    baseContinueCap = base.capability;
  }

  const numericsCheck = validateTrainingNumerics({
    hardwareGeneration: playerTrainingHardwareGeneration(
      state,
      numerics.computeFormat,
    ),
    numerics,
    researchUnlocked: state.player.researchUnlocked,
    family,
    enforceResearch: !(mode === "continue" && opts.trainingNumerics == null),
  });
  if (!numericsCheck.ok) return withAlert(state, "warn", numericsCheck.reason);

  const modelStack =
    mode === "continue"
      ? [...(continuationBase?.modelStack ?? [])]
      : sanitizeModelStack(
          opts.modelStack ?? [],
          state.player.researchUnlocked,
          family,
        );
  const stackModifiers = modelStackModifiers(modelStack, family);

  const unlockEligibility = trainingUnlockEligibility({
    family,
    backbone,
    productPreset,
    researchUnlocked: state.player.researchUnlocked,
  });
  if (!unlockEligibility.ok) {
    return withAlert(
      state,
      "warn",
      unlockEligibility.reason ?? "Research the selected model product first.",
    );
  }

  if (mode !== "continue") {
    const gate = sizeGate(paramsB, family, state.player.researchUnlocked);
    if (!gate.ok)
      return withAlert(state, "warn", gate.reason ?? "Invalid size.");
  }

  // Dense is free at game start; other families need research unlocks
  // Family unlocks only (not size tiers) — size is free, limited by compute/time
  if (
    family === "dense" &&
    !state.player.researchUnlocked.includes("dense_basics")
  ) {
    // Should not happen — dense_basics is starter unlock; allow train anyway
  }

  const architectureValidation = trainingArchitectureValidation({
    backbone,
    paramsB,
    activeParamsB,
    mode,
  });
  if (!architectureValidation.ok) {
    return withAlert(
      state,
      "warn",
      architectureValidation.reason ?? "Invalid training architecture.",
    );
  }
  if (backbone !== "moe") {
    activeParamsB = undefined;
  }

  let teacherId: string | undefined;
  /** Distill: share of signal from teacher (rest = your processed corpus). */
  let distillTeacherShare = 0;
  if (mode === "distill") {
    if (!opts.teacherId) {
      return withAlert(state, "warn", "Pick a teacher model for distillation.");
    }
    const teacher = state.player.models.find((m) => m.id === opts.teacherId);
    if (!teacher) return withAlert(state, "warn", "Teacher model not found.");
    if (paramsB > teacher.paramsB * 1.15) {
      return withAlert(
        state,
        "warn",
        "Student should not greatly exceed teacher size. Use a larger teacher or smaller student.",
      );
    }
    teacherId = teacher.id;
    distillTeacherShare = clampDistillTeacherShare(opts.distillTeacherShare);
  }

  let target = 0;

  // Consume processed corpus according to player's domain mix + volume.
  // Distill: only the *own-corpus* share is drawn from stocks; teacher signal is free.
  const selfDataShare = mode === "distill" ? 1 - distillTeacherShare : 1;
  const mixUnlocked =
    state.player.researchUnlocked.includes("data_mix") ||
    Boolean(opts.continueFromCheckpointId);
  const specialistsUnlocked =
    state.player.researchUnlocked.includes("data_specialists") ||
    !!aggregateEffects(state.player.researchUnlocked).unlockCorpusSpecialists;
  const minMTok = minDataMTokForParams(paramsB);
  const continueBaseModel = mode === "continue" ? continuationBase : undefined;
  const priorDataMTok = continueBaseModel?.dataTokensUsedMTok ?? 0;
  const priorWatermark =
    continueBaseModel?.dataWatermarkMTok ?? priorDataMTok ?? 0;
  const newSince = newDataSinceModel(state, continueBaseModel);

  const rawPlanTotal =
    opts.dataPlan?.totalMTok ??
    opts.dataPlan?.totalUnits ??
    (mode === "continue"
      ? Math.max(1, newSince) // continue defaults to new data only
      : recommendedTrainingDataMTok({
          paramsB,
          activeParamsB,
          family,
          backbone,
          trainShare: opts.dataPlan?.trainShare,
        }));

  // Volume is player-chosen (MTok). Pretrain reuses full corpus; continue uses new delta.
  const requestedTotal = Math.max(
    1,
    rawPlanTotal * (mode === "distill" ? Math.max(0.15, selfDataShare) : 1),
  );
  const tokenSplit = splitTrainingTokens(
    requestedTotal,
    opts.dataPlan?.postTrainShare ??
      (opts.dataPlan?.postTrainMTok != null
        ? opts.dataPlan.postTrainMTok / requestedTotal
        : DEFAULT_POST_TRAIN_SHARE),
  );
  const volumeMTok = tokenSplit.baseMTok;
  void minMTok;

  const recipeWeights = defaultTrainingDataWeights(family, productPreset);
  const foundationWeights = foundationDataWeights(recipeWeights);
  const continueMix = continuationBase?.dataPlan?.weights
    ? normalizeWeights({
        ...recipeWeights,
        ...continuationBase.dataPlan.weights,
      })
    : recipeWeights;
  const specializeWeights = opts.specializationFocus
    ? focusToMix(
        opts.specializationFocus,
        mode === "pretrain" ? foundationWeights : continueMix,
      )
    : undefined;
  const lockedWeights =
    specializeWeights ??
    (mode === "pretrain" ? foundationWeights : recipeWeights);
  const dataPlan: TrainingDataPlan = {
    totalUnits: volumeMTok,
    totalMTok: volumeMTok,
    trainShare:
      opts.dataPlan?.trainShare ?? (mode === "continue" ? 0.88 : 0.82),
    weights: capBaseChatWeights(
      normalizeWeights(
        mixUnlocked
          ? (opts.dataPlan?.weights ?? lockedWeights)
          : lockedWeights,
      ),
    ),
    allowSynthetic: opts.dataPlan?.allowSynthetic ?? true,
    includeSynthHQ: opts.dataPlan?.includeSynthHQ ?? true,
    includeSynthLQ: opts.dataPlan?.includeSynthLQ ?? false,
    domainModels: specialistsUnlocked ? opts.dataPlan?.domainModels : undefined,
    syntheticTeacherIds: opts.dataPlan?.syntheticTeacherIds
      ? { ...opts.dataPlan.syntheticTeacherIds }
      : undefined,
    syntheticTeacherEffortIds: opts.dataPlan?.syntheticTeacherEffortIds
      ? { ...opts.dataPlan.syntheticTeacherEffortIds }
      : undefined,
    syntheticMultiplier: opts.dataPlan?.syntheticMultiplier,
  };
  let consume = consumeForTraining(state, dataPlan, paramsB, family, dataMix, {
    mode:
      mode === "continue"
        ? "continue"
        : mode === "distill"
          ? "distill"
          : "pretrain",
    priorWatermarkMTok: mode === "continue" ? priorWatermark : undefined,
  });
  if (!consume.ok) {
    return withAlert(
      state,
      "warn",
      consume.reason ?? "Insufficient training data.",
    );
  }

  const planWeights = normalizeWeights(consume.plan.weights);
  if (mode === "distill" && teacherId && dataPlan.allowSynthetic) {
    const teacher = state.player.models.find((m) => m.id === teacherId);
    if (teacher) {
      consume = fillDistillTeacherSynthetic(consume, {
        teacher,
        labData: ensureLabData(state),
        weights: planWeights,
        requestedTotalMTok: volumeMTok,
        syntheticMultiplier: dataPlan.syntheticMultiplier ?? 0,
        frontierCapability: Math.max(
          teacher.capability,
          ...state.player.models
            .filter(isLivePublicModel)
            .map((model) => model.capability),
          ...state.rivals.flatMap((rival) =>
            rival.models
              .filter(isLivePublicModel)
              .map((model) => model.capability),
          ),
        ),
        paramsB,
        effortIds: dataPlan.syntheticTeacherEffortIds,
      });
    }
  }
  // Concurrent runs can share a name, family and start day. Give each recipe
  // an independently addressable deterministic ID, then probe past any live
  // or retained run identity (including canceled campaigns with checkpoints).
  // This avoids the old same-day collision without adding a save migration.
  const occupiedRunIds = new Set([
    ...existingJobs.map((candidate) => candidate.id),
    ...(state.player.trainingCheckpoints ?? []).map(
      (candidate) => candidate.sourceJobId,
    ),
    ...state.player.models
      .map((model) => model.sourceTrainingJobId)
      .filter((id): id is string => Boolean(id)),
  ]);
  let runOrdinal = existingJobs.length;
  let jobId: string;
  do {
    jobId = seededId(
      "job",
      state.seed,
      state.day,
      state.player.models.length,
      runOrdinal,
      opts.name,
      family,
      backbone,
      productPreset,
      paramsB,
      activeParamsB ?? 0,
      mode,
    );
    runOrdinal += 1;
  } while (occupiedRunIds.has(jobId));
  const manifestSnapshot = createDataManifest({
    data: consume.nextData,
    consumed: consume.consumed,
    totalMTok: consume.trainMTok + consume.verifyMTok,
    day: state.day,
    seed: state.seed,
    runId: jobId,
  });
  const attributedConsumed = manifestDomainExposureMTok(
    manifestSnapshot.manifest,
  );
  // The authoritative gate measures the mix backed by selected assets, after
  // stock shortages and synthetic fill. Requested sliders and legacy stock
  // summaries cannot make a media model valid without matching provenance.
  const actualData = actualConsumedDomainWeights(attributedConsumed);
  for (const [domain, floor] of Object.entries(
    trainingDataModalityRequirements(family, productPreset),
  ) as [DataDomain, number][]) {
    const actualShare = actualData.weights[domain];
    if (actualShare + 1e-9 < floor) {
      const actualPct = Math.round(actualShare * 1000) / 10;
      return withAlert(
        state,
        "warn",
        `${DATA_DOMAIN_META[domain].label} models need at least ${Math.round(floor * 100)}% actual ${domain} data; this run could attribute ${actualPct}% (${(attributedConsumed[domain] ?? 0).toFixed(1)} MTok).`,
      );
    }
  }
  const dataAnalysis = analyzeTrainingData({
    paramsB,
    activeParamsB,
    family,
    backbone,
    productPreset,
    io,
    plan: { ...consume.plan, weights: planWeights },
    data: ensureLabData(state),
    actualMTok: consume.trainMTok + consume.verifyMTok,
    quality: consume.qualityUsed,
    lqShare: consume.synthLqShare,
    manifest: manifestSnapshot.manifest,
  });
  // Formula v2 charges the actual train tokens at C≈6ND. Held-out verification
  // is forward-only (≈2ND), so data quality changes outcomes rather than making
  // physical work disappear. The earlier estimate only exists for preflight UI.
  const trainingEconomics = estimateTrainingEconomics({
    paramsB,
    family,
    backbone,
    trainEfficiency: state.player.trainEfficiency,
    activeParamsB,
    mode,
    teacherParamsB: teacherId
      ? state.player.models.find((model) => model.id === teacherId)?.paramsB
      : undefined,
    distillTeacherShare,
    trainingTokensMTok: consume.trainMTok,
    verificationTokensMTok: consume.verifyMTok,
    modalityComputeMult: dataAnalysis.modalityComputeMult,
    trainCostMult: stackModifiers.trainCostMult,
    dataCost: consume.cashCost,
    numerics,
  });
  target = trainingEconomics.targetPfDays;
  target += consume.syntheticGenerationPfDays ?? 0;

  const needVram = modelTrainVramGb(
    paramsB,
    activeParamsB,
    backbone === "moe" ? "moe" : family,
    numerics,
    state.player.researchUnlocked.includes("opt_checkpoint"),
  );
  const requiredSystemRam = estimateTrainingMemoryGb({
    paramsB,
    activeParamsB,
    family: backbone === "moe" ? "moe" : family,
    numerics,
    activationCheckpointing:
      state.player.researchUnlocked.includes("opt_checkpoint"),
  }).requiredSystemRamGb;
  const placement = computeSnapshot(state);
  const haveVram = placement.vramGb;
  const trainingRam = trainingRamBudgetGb(state, placement);
  const computePriority = Math.max(
    0,
    Math.min(100, opts.computePriority ?? 50),
  );
  const ramFit = trainingRamFitForNewJob(
    state,
    needVram,
    computePriority,
    placement,
    requiredSystemRam,
  );
  // Priority zero is an intentionally dormant queued run. It reserves no PF
  // or RAM until the player raises its priority, so lack of a live placement
  // must not prevent creating it.
  if (computePriority > 0 && !ramFit.ready) {
    return withAlert(
      state,
      "warn",
      `Training RAM is a hard limit (${ramFit.blockerResource ?? "memory"}): ${ramFit.blockerName ?? "New run"} needs ${(ramFit.blockerRequiredGb ?? needVram).toFixed(0)} GB after splitting the ${Math.round(trainingAllocationShare(state) * 100)}% Training allocation. Add memory, raise Training allocation, pause another run, or change priorities.`,
    );
  }
  if (computePriority > 0) {
    const domainGate = trainingFitsPlacementDomain({
      requiredHbmGb: needVram,
      requiredHostRamGb: requiredSystemRam,
      snapshot: placement,
    });
    if (!domainGate.ok) {
      return withAlert(
        state,
        "warn",
        domainGate.reason ??
          "Training must fit in one local or cloud placement domain; memory cannot be pooled.",
      );
    }
  }

  const reservedPf = Math.max(0, opts.reservedPf ?? 0);
  const initialEffectivePf = estimateJobDailyThroughput(state, {
    numerics,
    computePriority,
    reservedPf,
    concurrentJobs:
      existingJobs.filter((candidate) => !candidate.paused && !candidate.failed)
        .length + 1,
  });

  // Even tiny runs incur cluster setup, checkpointing, orchestration and eval
  // overhead. Preserve physical PF scaling while preventing zero-cost jobs.
  const {
    setupCost,
    dataCost,
    cashBurnPerDay,
    upfrontCash: cashSunk,
  } = trainingEconomics;
  if (state.player.cash < cashSunk) {
    return withAlert(
      state,
      "warn",
      `Need $${(cashSunk / 1e6).toFixed(1)}M upfront (cluster + synthetic fill).`,
    );
  }
  const recommendedPfDays = target;
  const minCalendarDays =
    paramsB >= 1_000 ? trainingEconomics.minCalendarDays : 0;
  const initialUsefulPf = Math.min(
    initialEffectivePf,
    pacedTrainingPfPerDay(target, minCalendarDays),
  );

  const integratedMethods =
    mode === "continue"
      ? [
          ...new Set([
            ...(continuationBase?.integratedMethods ?? []),
            ...state.player.researchUnlocked,
          ]),
        ].sort()
      : [...state.player.researchUnlocked].sort();
  const outcomeSeed = trainingOutcomeSeed({
    worldSeed: state.seed,
    companyId: state.playerLabId,
    planId: jobId,
    backbone,
    productPreset,
    createdDay: state.day,
  });
  const plan = freezeTrainingPlan({
    id: `plan-${jobId}`,
    companyId: state.playerLabId,
    name: opts.name,
    productPreset,
    backbone,
    totalParamsB: paramsB,
    activeParamsB,
    trainingNumerics: numerics,
    dataRecipe: consume.plan,
    computePlan: {
      source: inferComputeSource({
        localPf: placement.localFleetPf,
        remotePf: placement.remoteFlopsPf,
      }),
      reservedPf,
      computePriority,
      activationCheckpointing: integratedMethods.includes("opt_checkpoint"),
    },
    teacherModelId: teacherId,
    distillationShare: mode === "distill" ? distillTeacherShare : 0,
    integratedResearchIds: integratedMethods,
    outcomeSeed,
    createdDay: state.day,
  });

  const job: TrainingJob = {
    id: jobId,
    name: opts.name,
    plan,
    family,
    backbone,
    productPreset,
    io,
    targetParamsB: paramsB,
    activeParamsB,
    targetPfDays: target,
    progressPfDays: 0,
    energyMwDays: 0,
    energyMWh: 0,
    daysRemaining:
      initialUsefulPf > 1e-9
        ? target / initialUsefulPf
        : Number.POSITIVE_INFINITY,
    minCalendarDays,
    daysElapsed: 0,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    completedPostTrainStages: continueFromId
      ? [...(continuationBase?.completedPostTrainStages ?? [])]
      : [],
    postTrainStageEffectiveness: continueFromId
      ? { ...(continuationBase?.postTrainStageEffectiveness ?? {}) }
      : {},
    postTrainStageRuns: continueFromId
      ? {
          ...(continuationBase?.postTrainStageRuns ??
            Object.fromEntries(
              (continuationBase?.completedPostTrainStages ?? []).map(
                (stage) => [stage, 1],
              ),
            )),
        }
      : {},
    postTrainStagesCompletedThisRun: [],
    postTrainDaysElapsed: 0,
    mode,
    teacherId,
    distillTeacherShare: mode === "distill" ? distillTeacherShare : undefined,
    continueFromId,
    continueLineageId,
    parentCheckpointId: opts.continueFromCheckpointId,
    branchDirection: opts.branchDirection,
    lifecycle:
      opts.lifecycle ??
      (mode === "pretrain"
        ? "foundation"
        : opts.specializationFocus
          ? "specialized"
          : undefined),
    specializationFocus: opts.specializationFocus,
    lineageId:
      continueLineageId ?? seededId("lineage", state.seed, jobId, opts.name),
    dataMix,
    dataPlan: {
      ...consume.plan,
      weights: actualData.weights,
      syntheticMultiplier: dataPlan.syntheticMultiplier,
      uniqueMTok: dataAnalysis.uniqueMTok,
      repeatedMTok: dataAnalysis.repeatedMTok,
      postTrainWeights:
        opts.dataPlan?.postTrainWeights ??
        alignmentDataWeights(
          actualData.weights as Record<DataDomain, number>,
        ),
      postTrainMTok: tokenSplit.postTrainMTok,
      postTrainShare: tokenSplit.postTrainShare,
    },
    dataConsumed: attributedConsumed,
    dataCoverage: consume.coverage,
    dataQualityUsed: consume.qualityUsed,
    syntheticUnits: consume.syntheticUnits,
    synthLqShare: consume.synthLqShare ?? 0,
    trainShare: consume.plan.trainShare,
    trainMTok: consume.trainMTok,
    verifyMTok: consume.verifyMTok,
    priorDataMTok,
    cashBurnPerDay,
    cashSunk,
    recommendedPfDays,
    extensionDays: 0,
    awaitingDecision: false,
    economics: {
      setupCost,
      dataCost,
      trainingCostAccrued: 0,
    },
    benchmarkSnapshots: [],
    lastBenchmarkDay: undefined,
    outcomeSeed,
    outcomeRisk: dataAnalysis.risk,
    campaignMilestonesReached: [],
    campaignEventHistory: [],
    campaignModifiers: {
      capabilityDelta: 0,
      reliabilityDelta: 0,
      safetyDelta: 0,
      breakthroughBias: 0,
      stumbleRisk: 0,
      dataQualityDelta: 0,
      verifiedRecursiveCapabilityBonus: boundedVerifiedRecursiveCapabilityBonus(
        family,
        continuationBase?.verifiedRecursiveCapabilityBonus,
      ),
    },
    effectiveDataRatio: dataAnalysis.effectiveDataRatio,
    repeatedDataEpochs: dataAnalysis.repeatedEpochs,
    modalityComputeMult: dataAnalysis.modalityComputeMult,
    dataManifestId: manifestSnapshot.manifest.id,
    dataEvidence: trainingDataEvidenceFromManifest(manifestSnapshot.manifest),
    integratedMethods,
    modelStack,
    attachedGymKinds: (opts.attachedGymKinds ?? []).filter((kind) =>
      gymUnlocked(kind, state.player.researchUnlocked),
    ),
    dataQualityByDomain: Object.fromEntries(
      Object.entries(consume.domainQuality ?? {}).filter(
        ([domain]) => (actualData.weights[domain as DataDomain] ?? 0) > 0,
      ),
    ),
    lowQualityShareByDomain: Object.fromEntries(
      Object.entries(consume.lowQualityShareByDomain ?? {}).filter(
        ([domain]) => (actualData.weights[domain as DataDomain] ?? 0) > 0,
      ),
    ),
    syntheticProvenance: consume.syntheticProvenance,
    trainingFormulaVersion: 2,
    trainingNumerics: numerics,
    computePriority,
    reservedPf,
    minimumDevices: Math.max(1, Math.ceil(needVram / 80)),
    preemptible: true,
    failed: false,
    // Continue / branch jobs must carry effort heads from the base checkpoint
    // so Think/Deep (and custom heads) stay served and trainable.
    productProfile:
      mode === "continue"
        ? cloneProductProfileForContinue(continuationBase?.productProfile)
        : undefined,
    lossHistory: [
      {
        day: state.day,
        stage: "base",
        progress: 0,
        loss: trainingLoss(
          {
            id: jobId,
            outcomeSeed: hashSeed(
              state.seed,
              state.day,
              opts.name,
              paramsB,
              family,
              "train-outcome",
            ),
            targetParamsB: paramsB,
            trainingNumerics: numerics,
          },
          "base",
          0,
          state.day,
        ),
      },
    ],
  };

  void baseContinueCap;

  const sizeLabel =
    backbone === "moe"
      ? `${formatParams(paramsB)} total / ${formatParams(activeParamsB ?? 0)} active`
      : formatParams(paramsB);

  const vramNote = ` · training RAM ${needVram.toFixed(0)}/${trainingRam.toFixed(0)} GB allocated`;

  const modeLabel =
    mode === "distill"
      ? "Distillation"
      : mode === "continue"
        ? "Continue-train"
        : "Training";

  const mixLabel = formatMix(consume.plan.weights);
  const synthNote =
    consume.syntheticUnits > 0.5
      ? ` · +${formatTokens(consume.syntheticUnits)} synth fill`
      : "";
  const dataNote = ` · ${formatTokens(consume.trainMTok + consume.verifyMTok)} data (train ${Math.round(consume.plan.trainShare * 100)}%/verify ${Math.round((1 - consume.plan.trainShare) * 100)}%)`;

  const started = {
    ...chargeExpense(
      {
        ...state,
        player: {
          ...state.player,
          data: manifestSnapshot.data,
          trainingJobs: [...existingJobs, job],
          trainingJob: existingJobs[0] ?? job,
        },
      },
      cashSunk,
      "training",
    ),
    alerts: [
      {
        id: `train-start-${job.id}`,
        day: state.day,
        severity: haveVram < needVram ? ("warn" as const) : ("info" as const),
        message: `${modeLabel}: ${opts.name} (${sizeLabel}${
          mode === "distill"
            ? `, teacher ${Math.round(distillTeacherShare * 100)}% / own ${Math.round((1 - distillTeacherShare) * 100)}%`
            : ""
        }${
          mode === "continue" && priorDataMTok > 0
            ? `, prior ${formatTokens(priorDataMTok)}`
            : ""
        }${dataNote} [${mixLabel}] Q${consume.qualityUsed.toFixed(0)}, ~${target.toFixed(0)} PF-d, $${(cashSunk / 1e6).toFixed(1)}M)${synthNote}${vramNote}`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
  return appendFeedEvents(started, [
    {
      id: `feed-training-start-${job.id}`,
      day: state.day,
      category: "models",
      title: `${modeLabel} started: ${opts.name}`,
      body: `${sizeLabel} run scheduled for ~${target.toFixed(0)} PF-days using ${formatTokens(consume.trainMTok + consume.verifyMTok)} MTok of data (${Math.round(consume.coverage * 100)}% coverage).`,
      source: state.player.name,
      tone: "research",
      entityId: job.id,
      kind: "training_started",
    },
  ]);
}

function withAlert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `a-${state.day}-${message.slice(0, 16)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

/** Resolve an explainable in-run incident or discovery. */
export function resolveTrainingCampaignEvent(
  state: SimState,
  jobId: string,
  choiceId: string,
  customEffects?: TrainingCampaignChoiceEffects,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  const event = job?.pendingCampaignEvent;
  const selected = event?.choices.find((choice) => choice.id === choiceId);
  if (!job || !event || (!selected && !customEffects)) {
    return withAlert(
      state,
      "warn",
      "Training campaign decision is no longer available.",
    );
  }
  const effects = clampTrainingCampaignIntervention(
    event.kind,
    customEffects ?? selected?.effects ?? {},
  );
  const label = selected?.label ?? "Custom intervention";
  const description = selected?.description ?? "Player-authored intervention.";
  const researchersRequired = Math.max(0, effects.minResearchers ?? 0);
  const researchers = state.player.staff?.researcher ?? 0;
  if (researchers < researchersRequired) {
    return withAlert(
      state,
      "warn",
      `${label} needs ${researchersRequired} researchers; ${researchers} are staffed.`,
    );
  }
  const cost = Math.max(0, effects.cashCost ?? 0);
  if (state.player.cash + 1e-9 < cost) {
    return withAlert(
      state,
      "warn",
      `Need $${cost.toLocaleString("en-US")} for ${label}.`,
    );
  }
  let next = state;
  if ((effects.progressRollbackFraction ?? 0) > 0) {
    next = createManualTrainingCheckpoint(next, {
      sourceJobId: job.id,
      label: `${job.name} · pre-rollback`,
    });
  }
  const resolved = applyTrainingCampaignChoice(
    job,
    choiceId,
    next.day,
    false,
    customEffects,
  );
  if (!resolved) return state;
  next = withTrainingJobs(
    cost > 0 ? chargeExpense(next, cost, "training") : next,
    playerTrainingJobs(next).map((candidate) =>
      candidate.id === job.id ? resolved : candidate,
    ),
  );
  return withAlert(
    next,
    effects.stumbleRisk && effects.stumbleRisk > 0 ? "warn" : "info",
    `${job.name}: ${label}. ${description}`,
  );
}

/**
 * Spend the spider's reserved alignment mix and attached gyms as soon as
 * the base run hits its target. No modal — the recipe already named the data.
 */
export function beginLinkedPostTrain(state: SimState, jobId: string): SimState {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === jobId,
  );
  if (!job || job.failed) return state;
  if (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget) {
    return state;
  }
  const weights = job.dataPlan.postTrainWeights
    ? normalizeWeights(job.dataPlan.postTrainWeights)
    : alignmentDataWeights(normalizeWeights(job.dataPlan.weights));
  const volume = Math.max(0, job.dataPlan.postTrainMTok ?? 0);
  const cleared: TrainingJob = {
    ...job,
    pendingPostTrainPhase: false,
    postTrainPhaseResolved: true,
    stallReason: null,
    dataPlan: {
      ...job.dataPlan,
      postTrainWeights: weights,
      postTrainMTok: volume,
    },
  };
  let next = withTrainingJobs(
    state,
    playerTrainingJobs(state).map((candidate) =>
      candidate.id === job.id ? cleared : candidate,
    ),
  );
  if (volume > 0) {
    const consume = consumeForTraining(
      next,
      {
        ...cleared.dataPlan,
        totalMTok: volume,
        totalUnits: volume,
        weights,
        trainShare: 0.9,
      },
      job.targetParamsB,
      job.family,
      job.dataMix,
      { mode: "pretrain" },
    );
    if (consume.ok) {
      next = {
        ...next,
        player: {
          ...next.player,
          data: consume.nextData,
        },
      };
      if (consume.cashCost > 0) {
        next = chargeExpense(next, consume.cashCost, "training");
      }
      const jobs = playerTrainingJobs(next).map((candidate) => {
        if (candidate.id !== job.id) return candidate;
        const consumed = { ...candidate.dataConsumed };
        for (const domain of DATA_DOMAINS) {
          consumed[domain] =
            (consumed[domain] ?? 0) + (consume.consumed[domain] ?? 0);
        }
        return {
          ...candidate,
          dataConsumed: consumed,
          dataQualityUsed:
            (candidate.dataQualityUsed + consume.qualityUsed) / 2,
        };
      });
      next = withTrainingJobs(next, jobs);
    }
  }
  const firstStage = postTrainStagesFromResearch(
    next.player.researchUnlocked,
  )[0];
  if (!firstStage) {
    const gymNote =
      (job.attachedGymKinds?.length ?? 0) > 0
        ? " Attached gyms wait on SFT."
        : "";
    return withAlert(
      next,
      "info",
      volume > 0
        ? `${job.name} reserved ${volume.toFixed(0)} MTok of alignment data.${gymNote} Unlock SFT in Labs to spend it.`
        : `${job.name} finished its base run.${gymNote} Unlock SFT in Labs to start alignment.`,
    );
  }
  const started = selectPostTrain(next, job.id, firstStage);
  const startedJob = playerTrainingJobs(started).find(
    (candidate) => candidate.id === job.id,
  );
  if (startedJob && startedJob.postTrain === firstStage) {
    return withAlert(
      started,
      "info",
      `${job.name} started ${firstStage.toUpperCase()} on the reserved alignment mix${
        (job.attachedGymKinds?.length ?? 0) > 0 ? " and attached gyms" : ""
      }.`,
    );
  }
  return started;
}

/** @deprecated Alignment now starts from the recipe; skip still clears a stuck save. */
export function resolvePostTrainPhase(
  state: SimState,
  jobId: string,
  decision: {
    kind: "start" | "skip";
    postTrainWeights?: Partial<Record<DataDomain, number>>;
    postTrainMTok?: number;
  },
): SimState {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === jobId,
  );
  if (!job || job.failed) return withAlert(state, "warn", "Run not found.");
  if (decision.kind === "skip") {
    return withTrainingJobs(
      state,
      playerTrainingJobs(state).map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              pendingPostTrainPhase: false,
              postTrainPhaseResolved: true,
              stallReason: null,
            }
          : candidate,
      ),
    );
  }
  let next = state;
  if (decision.postTrainWeights || decision.postTrainMTok != null) {
    next = withTrainingJobs(
      state,
      playerTrainingJobs(state).map((candidate) =>
        candidate.id !== job.id
          ? candidate
          : {
              ...candidate,
              dataPlan: {
                ...candidate.dataPlan,
                postTrainWeights:
                  decision.postTrainWeights ??
                  candidate.dataPlan.postTrainWeights,
                postTrainMTok:
                  decision.postTrainMTok ?? candidate.dataPlan.postTrainMTok,
              },
            },
      ),
    );
  }
  return beginLinkedPostTrain(next, jobId);
}

export function advancePostTrain(state: SimState, jobId?: string): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobId
    ? jobs.find((candidate) => candidate.id === jobId)
    : jobs[0];
  if (!job) return state;
  const idx = POST_TRAIN_ORDER.indexOf(job.postTrain);
  if (idx < 0 || idx >= POST_TRAIN_ORDER.length - 1) return state;
  if (!trainingMinimumStatus(job).ok) return state;
  if (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget)
    return state;

  const nextStage = POST_TRAIN_ORDER[idx + 1]!;
  if (
    nextStage === "rlhf" &&
    !state.player.researchUnlocked.includes("align_rlhf")
  ) {
    return withAlert(
      state,
      "warn",
      "Unlock RLHF Pipeline for preference training.",
    );
  }
  if (
    nextStage === "process" &&
    !state.player.researchUnlocked.includes("align_process")
  ) {
    return withAlert(state, "warn", "Unlock Process Reward Models first.");
  }

  return selectPostTrain(
    state,
    job.id,
    nextStage as Exclude<PostTrainStage, "none">,
  );
}

/** Start a specific researched post-training stage from a completed checkpoint. */
export function selectPostTrain(
  state: SimState,
  jobId: string,
  nextStage: Exclude<PostTrainStage, "none">,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || !trainingMinimumStatus(job).ok) return state;
  const completedInThisRun = job.postTrainStagesCompletedThisRun ?? [];
  if (
    completedInThisRun.includes(nextStage) ||
    (job.mode !== "continue" &&
      completedPostTrainStages(job).includes(nextStage))
  ) {
    return withAlert(
      state,
      "warn",
      `${nextStage.toUpperCase()} has already been applied in this model version. Continue-train a new version to refresh it with diminishing returns.`,
    );
  }
  if (job.postTrain !== "none" && job.postTrainProgress < job.postTrainTarget) {
    return withAlert(
      state,
      "warn",
      "Finish the current post-training compute first.",
    );
  }
  if (
    nextStage === "rlhf" &&
    !state.player.researchUnlocked.includes("align_rlhf")
  ) {
    return withAlert(
      state,
      "warn",
      "Unlock RLHF Pipeline for preference training.",
    );
  }
  if (
    nextStage === "process" &&
    !state.player.researchUnlocked.includes("align_process")
  ) {
    return withAlert(state, "warn", "Unlock Process Reward Models first.");
  }
  const quote = postTrainStageQuote(
    job,
    nextStage,
    gymsLinkedToJob(state, job),
  );
  if (state.player.cash + 1e-9 < quote.cash) {
    return withAlert(
      state,
      "warn",
      `Need $${quote.cash.toLocaleString("en-US")} plus gym compute to start ${nextStage.toUpperCase()}. Fund Labs or raise cash.`,
    );
  }
  const staged: TrainingJob = {
    ...job,
    postTrain: nextStage,
    postTrainProgress: 0,
    postTrainTarget: quote.pfDays,
    postTrainDaysElapsed: 0,
    economics: {
      setupCost: job.economics?.setupCost ?? 0,
      dataCost: job.economics?.dataCost ?? 0,
      trainingCostAccrued:
        (job.economics?.trainingCostAccrued ?? 0) + quote.cash,
    },
    awaitingDecision: false,
    paused: false,
    stallReason: null,
    postTrainRiskPlan: undefined,
    failureRecoveryCheckpointId: undefined,
  };
  const updated: TrainingJob = {
    ...staged,
    postTrainRiskPlan: createPostTrainRiskPlan(
      staged,
      nextStage,
      state.player.researchUnlocked,
      state.player.models,
      state.day,
    ),
  };
  const charged = chargeExpense(state, quote.cash, "training");
  return withTrainingJobs(
    charged,
    jobs.map((candidate) => (candidate.id === job.id ? updated : candidate)),
  );
}

function recordCompletedPostTrainPass(
  job: TrainingJob,
  stage: Exclude<PostTrainStage, "none">,
  earnedEffectiveness: number,
): Pick<
  TrainingJob,
  | "completedPostTrainStages"
  | "postTrainStageEffectiveness"
  | "postTrainStageRuns"
  | "postTrainStagesCompletedThisRun"
> {
  const priorRuns =
    job.postTrainStageRuns?.[stage] ??
    (job.postTrainStageEffectiveness?.[stage] != null ? 1 : 0);
  return {
    completedPostTrainStages: [
      ...new Set([...(job.completedPostTrainStages ?? []), stage]),
    ],
    postTrainStageEffectiveness: {
      ...(job.postTrainStageEffectiveness ?? {}),
      [stage]: mergePostTrainStageEffectiveness(
        job.postTrainStageEffectiveness?.[stage],
        earnedEffectiveness,
        priorRuns,
      ),
    },
    postTrainStageRuns: {
      ...(job.postTrainStageRuns ?? {}),
      [stage]: priorRuns + 1,
    },
    postTrainStagesCompletedThisRun: [
      ...new Set([...(job.postTrainStagesCompletedThisRun ?? []), stage]),
    ],
  };
}

/** Cancel an unfinished or failed run. Upfront costs and consumed data remain spent. */
export function cancelTraining(state: SimState, jobId: string): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) return state;
  const remainingJobs = jobs.filter((candidate) => candidate.id !== jobId);
  const queueWithoutJobBenchmarks = (
    state.player.privateEvaluationJobs ?? []
  ).filter(
    (evaluation) =>
      !(
        evaluation.kind === "training_benchmark" &&
        evaluation.subjectId === jobId
      ),
  );
  const affectedCheckpointIds = new Set(
    (state.player.trainingCheckpoints ?? [])
      .filter(
        (checkpoint) =>
          checkpoint.sourceJobId === jobId ||
          checkpoint.id === job.parentCheckpointId,
      )
      .map((checkpoint) => checkpoint.id),
  );
  const ownership = reconcileCheckpointOwnership({
    checkpoints: state.player.trainingCheckpoints ?? [],
    privateEvaluationJobs: queueWithoutJobBenchmarks,
    models: state.player.models,
    jobs: remainingJobs,
    affectedCheckpointIds,
  });
  const withoutJob = withTrainingJobs(state, remainingJobs);
  const cascaded: SimState = {
    ...withoutJob,
    player: {
      ...withoutJob.player,
      trainingCheckpoints: ownership.checkpoints,
      privateEvaluationJobs: ownership.privateEvaluationJobs,
    },
  };
  const cascadeNote =
    ownership.removedCheckpointIds.length > 0
      ? ` Removed ${ownership.removedCheckpointIds.length} unowned checkpoint${ownership.removedCheckpointIds.length === 1 ? "" : "s"} and cancelled their private studies without refund.`
      : "";
  return withAlert(
    cascaded,
    job.failed ? "info" : "warn",
    job.failed
      ? `Deleted failed ${job.name} run.${cascadeNote}`
      : `Cancelled ${job.name}. Consumed data and $${(job.cashSunk / 1e6).toFixed(2)}M upfront cost were not recovered.${cascadeNote}`,
  );
}

/** Finish job → internal (private) model. Not on the market until released. */
export function keepInternal(state: SimState, jobId?: string): SimState {
  return finalizeJob(state, "internal", jobId);
}

/** Finish job and release publicly (plans/API eligible). */
export function releaseFromJob(
  state: SimState,
  jobId?: string,
  opts?: { list?: boolean },
): SimState {
  return finalizeJob(state, "released", jobId, true, opts);
}

/** Stop a plateaued run after its calendar gate and release its current checkpoint. */
export function releaseTrainingEarly(
  state: SimState,
  jobId: string,
  opts?: { list?: boolean },
): SimState {
  return finalizeJob(state, "released", jobId, true, opts);
}

/** Cheat surface: finish compute and post-training while preserving the release decision. */
export function completeTrainingJobsNow(state: SimState): SimState {
  const jobs = playerTrainingJobs(state);
  const active = jobs.filter((job) => !job.failed);
  if (active.length === 0) return state;
  const completed = jobs.map((job) => {
    if (job.failed) return job;
    const completedJob: TrainingJob = {
      ...job,
      progressPfDays: Math.max(
        job.progressPfDays,
        job.targetPfDays,
        job.recommendedPfDays ?? 0,
      ),
      daysElapsed: job.daysElapsed ?? 0,
      postTrainProgress: Math.max(job.postTrainProgress, job.postTrainTarget),
      postTrainDaysElapsed: job.postTrainDaysElapsed,
      awaitingDecision: false,
      paused: false,
      stallReason: null,
    };
    const pass =
      completedJob.postTrain === "none" || completedJob.postTrainTarget <= 0
        ? null
        : recordCompletedPostTrainPass(
            job,
            completedJob.postTrain,
            postTrainStageEffectiveness({
              job: completedJob,
              stage: completedJob.postTrain,
              researchUnlocked: state.player.researchUnlocked,
              models: state.player.models,
              progress: completedJob.postTrainProgress,
              daysElapsed: completedJob.postTrainDaysElapsed,
              gyms: state.player.postTrainGyms,
              tools: state.player.toolSkills,
            }),
          );
    const accountedJob = pass ? { ...completedJob, ...pass } : completedJob;
    const completedStages = completedPostTrainStages(accountedJob);
    return {
      ...accountedJob,
      completedPostTrainStages: completedStages,
      postTrainStageEffectiveness: resolvedPostTrainStageEffectiveness(
        accountedJob,
        state.player.researchUnlocked,
        state.player.models,
        state.player.postTrainGyms,
        state.player.toolSkills,
      ),
    };
  });
  return withAlert(
    withTrainingJobs(state, completed),
    "info",
    `${active.length} training run${active.length === 1 ? "" : "s"} completed — choose release or keep internal.`,
  );
}

function benchmarkSuiteLatentScore(
  job: TrainingJob,
  suiteId: BenchmarkSuiteId,
  capability: number,
  safety: number,
  gyms?: readonly PostTrainGym[],
): number {
  const preset = job.productPreset ?? presetFromFamily(job.family);
  const io = job.io ?? ioForPreset(preset, capability);
  const dataQuality = Math.max(1, Math.min(100, job.dataQualityUsed ?? 50));
  const gymLift = trainingGymLatentLift(gyms, job.attachedGymKinds);
  const output = (modality: keyof typeof io.outputs) =>
    Math.max(0, Math.min(100, io.outputs[modality] ?? 0));
  switch (suiteId) {
    case "image_generation":
      return (
        capability * 0.32 +
        output("image") * 0.3 +
        dataQuality * 0.28 +
        safety * 0.1
      );
    case "video_generation":
      return (
        capability * 0.28 +
        output("video") * 0.34 +
        dataQuality * 0.28 +
        safety * 0.1
      );
    case "audio_generation":
      return (
        capability * 0.3 +
        output("audio") * 0.32 +
        dataQuality * 0.28 +
        safety * 0.1
      );
    case "omni_overview": {
      const enabledOutputs = (["text", "image", "video", "audio"] as const)
        .map(output)
        .filter((score) => score > 0);
      const outputAverage =
        enabledOutputs.reduce((sum, score) => sum + score, 0) /
        Math.max(1, enabledOutputs.length);
      return (
        capability * 0.32 +
        outputAverage * 0.3 +
        dataQuality * 0.23 +
        safety * 0.15
      );
    }
    case "language":
    default:
      return capability * 0.72 + dataQuality * 0.18 + safety * 0.1 + gymLift;
  }
}

function paidBenchmarkSuiteResult(
  job: TrainingJob,
  suiteId: BenchmarkSuiteId,
  spend: number,
  progress: number,
  stage: TrainableStage,
  latentCapability: number,
  latentSafety: number,
  gyms?: readonly PostTrainGym[],
): TrainingBenchmarkSuiteResult {
  const measurement = trainingBenchmarkAccuracyForSpend(spend);
  const latent = benchmarkSuiteLatentScore(
    job,
    suiteId,
    latentCapability,
    latentSafety,
    gyms,
  );
  // Spend is intentionally excluded from the seed. Buying a larger sample
  // shrinks the same deterministic measurement error instead of rerolling it.
  const rng = createRng(
    hashSeed(
      job.outcomeSeed ?? 0,
      job.id,
      Math.round(progress * 1_000_000),
      stage,
      suiteId,
      "paid-benchmark-v1",
    ),
  );
  const signedError = rng.range(-1, 1) * measurement.inaccuracy;
  const score = Math.max(1, Math.min(100, latent * (1 + signedError)));
  const halfWidth = score * measurement.inaccuracy;
  return {
    suiteId,
    spend,
    score,
    accuracy: measurement.accuracy,
    confidence: measurement.confidence,
    inaccuracy: measurement.inaccuracy,
    low: Math.max(0, score - halfWidth),
    high: Math.min(100, score + halfWidth),
  };
}

/**
 * Deterministic progress-scaled noisy checkpoint evaluation. Mid-run
 * benchmarks are directional, not an oracle for final quality. Paid sample
 * size improves measurement accuracy and narrows the displayed interval.
 */
export function resolveTrainingBenchmarkEvaluation(
  state: SimState,
  job: TrainingJob,
  progressFrac: number,
  stage: TrainableStage,
  pending: NonNullable<TrainingJob["pendingBenchmark"]>,
): TrainingBenchmarkSnapshot {
  const loss = pending.capturedLoss ?? observedLoss(job) ?? 8.4;
  const precision = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
  );
  const latentCapability = Math.max(
    1,
    Math.min(
      100,
      (100 - loss * 8) *
        Math.min(1, 0.35 + progressFrac * 0.75) *
        precision.qualityCeilingMultiplier +
        trainingGymLatentLift(
          state.player.postTrainGyms,
          job.attachedGymKinds,
        ) *
          0.35,
    ),
  );
  const latentSafety = Math.max(
    1,
    Math.min(100, latentCapability * 0.85 + progressFrac * 8),
  );
  const selectedRecipe = benchmarkEffortRecipe(
    { productProfile: productProfileForJob(state, job) },
    pending.effortRecipeId ?? INSTANT_EFFORT_ID,
  );
  const eligible = eligibleTrainingBenchmarkSuites(job);
  const fallbackSuite = eligible[0]?.id ?? "language";
  const suiteIds =
    pending.suiteIds && pending.suiteIds.length > 0
      ? [...pending.suiteIds]
      : [fallbackSuite];
  const fallbackSpend =
    eligible.find((option) => option.id === suiteIds[0])?.referenceSpend ??
    100_000;
  const spendPerSuite = pending.spendPerSuite ?? fallbackSpend;
  const measurement = trainingBenchmarkAccuracyForSpend(spendPerSuite);
  const benchmarkRng = createRng(
    hashSeed(
      job.outcomeSeed ?? 0,
      job.id,
      Math.round(pending.progress * 1_000_000),
      `benchmark-v3-${stage}`,
    ),
  );
  const inaccuracy = measurement.inaccuracy;
  const noisyScore = (latent: number, preferredSign: -1 | 1): number => {
    const error = inaccuracy * (0.55 + benchmarkRng.next() * 0.45);
    const positiveFits = latent * (1 + error) <= 100;
    const negativeFits = latent * (1 - error) >= 1;
    const sign =
      preferredSign > 0 ? (positiveFits ? 1 : -1) : negativeFits ? -1 : 1;
    return latent * (1 + sign * error);
  };
  // Measure the untouched checkpoint once. Every effort view must branch
  // from this same noisy base so selecting Max cannot contaminate Instant or
  // apply the selected recipe twice.
  const baseCapability = noisyScore(
    latentCapability,
    benchmarkRng.next() < 0.5 ? -1 : 1,
  );
  const baseSafety = noisyScore(
    latentSafety,
    benchmarkRng.next() < 0.5 ? -1 : 1,
  );
  const measuredBaseBenches: BenchmarkScores = {
    mmlu: baseCapability,
    coding: baseCapability,
    math: baseCapability,
    vision: 0,
    law: baseCapability * 0.6,
    health: baseCapability * 0.6,
    science: baseCapability,
    multilingual: baseCapability * 0.7,
    agents: baseCapability * 0.7,
    safety: baseSafety,
    personality: job.productProfile?.personality ?? 0,
  };
  const selectedResult = selectedRecipe
    ? applyEffortLiftFromRecipe(
        baseCapability,
        measuredBaseBenches,
        selectedRecipe,
      )
    : { capability: baseCapability, benchmarks: measuredBaseBenches };
  const capability = selectedResult.capability;
  const safety = selectedResult.benchmarks.safety;
  const suiteResults: Partial<
    Record<BenchmarkSuiteId, TrainingBenchmarkSuiteResult>
  > = {};
  for (const suiteId of suiteIds) {
    const baseResult = paidBenchmarkSuiteResult(
      job,
      suiteId,
      spendPerSuite,
      pending.progress,
      stage,
      latentCapability,
      latentSafety,
      state.player.postTrainGyms,
    );
    const effortCompatible =
      suiteId === "language" || suiteId === "omni_overview";
    if (!selectedRecipe || !effortCompatible) {
      suiteResults[suiteId] = baseResult;
      continue;
    }
    const selectedSuiteScore = applyEffortLiftFromRecipe(
      baseResult.score,
      {
        ...measuredBaseBenches,
        mmlu: baseResult.score,
        coding: baseResult.score,
        math: baseResult.score,
        science: baseResult.score,
        agents: baseResult.score,
      },
      selectedRecipe,
    ).capability;
    const halfWidth = selectedSuiteScore * baseResult.inaccuracy;
    suiteResults[suiteId] = {
      ...baseResult,
      score: selectedSuiteScore,
      low: Math.max(0, selectedSuiteScore - halfWidth),
      high: Math.min(100, selectedSuiteScore + halfWidth),
    };
  }
  const resultValues = Object.values(suiteResults).filter(
    (result): result is TrainingBenchmarkSuiteResult => result != null,
  );
  const suiteScore =
    resultValues.reduce((sum, result) => sum + result.score, 0) /
    Math.max(1, resultValues.length);
  const confidence = measurement.confidence;
  const interval = inaccuracy;
  const effortBoards = effortBoardsFor(
    {
      capability: baseCapability,
      benchmarks: measuredBaseBenches,
      productProfile: productProfileForJob(state, job),
    },
    null,
  );
  return {
    day: state.day,
    progress: progressFrac,
    capability,
    safety,
    suite: Math.round(suiteScore * 10) / 10,
    confidence,
    inaccuracy: interval,
    capabilityLow: capability * (1 - interval),
    capabilityHigh: capability * (1 + interval),
    safetyLow: safety * (1 - interval),
    safetyHigh: safety * (1 + interval),
    suiteIds,
    spendPerSuite,
    totalCost: pending.totalCost ?? spendPerSuite * suiteIds.length,
    accuracy: measurement.accuracy,
    suiteResults,
    effortCapabilities: Object.fromEntries(
      effortBoards.map((board) => [board.id, board.capability]),
    ),
    effortBoards,
    effortRecipeId: selectedRecipe?.id ?? INSTANT_EFFORT_ID,
    workload: pending.workload,
  };
}

export interface TrainingBenchmarkQuote {
  model: Model;
  effortRecipe: EffortRecipe;
  workload: ReturnType<typeof estimateBenchmarkRun>;
  sampleCost: number;
  inferenceCost: number;
  totalCost: number;
}

/** One canonical live/scheduler quote for a paid mid-run benchmark. */
export function quoteTrainingBenchmark(
  state: SimState,
  job: TrainingJob,
  request: TrainingBenchmarkRequest,
): TrainingBenchmarkQuote {
  const model = {
    ...buildModelFromJob(state, job, "internal", false),
    productProfile: productProfileForJob(state, job),
  };
  const effortRecipeId = request.effortRecipeId ?? INSTANT_EFFORT_ID;
  const effortRecipe = benchmarkEffortRecipes(model).find(
    (recipe) => recipe.id === effortRecipeId,
  );
  if (!effortRecipe) {
    throw new Error(
      `The ${effortRecipeId} effort recipe is not trained for ${job.name}.`,
    );
  }
  const hasTextSuite = request.suiteIds.some(
    (suiteId) => suiteId === "language" || suiteId === "omni_overview",
  );
  if (effortRecipe.kind !== "instant" && !hasTextSuite) {
    throw new Error(
      "Reasoning effort can only be selected for text or omni benchmark tasks.",
    );
  }
  const workload = estimateBenchmarkRun(
    model,
    request.suiteIds.flatMap((suiteId) =>
      SUITE_METRICS[suiteId].map((metric) => metric.id),
    ),
    effortRecipe.id,
    {
      priceIn: Math.max(
        0,
        model.apiPriceInPerMTok ??
          model.suggestedApiPriceIn ??
          model.apiPricePerMTok ??
          model.suggestedApiPrice ??
          0,
      ),
      priceOut: Math.max(
        0,
        model.apiPriceOutPerMTok ??
          model.suggestedApiPriceOut ??
          model.apiPricePerMTok ??
          model.suggestedApiPrice ??
          0,
      ),
    },
    trainingBenchmarkTasksPerMetric(request.spendPerSuite),
    state.player.servingEfficiency,
  );
  const sampleCost = request.spendPerSuite * request.suiteIds.length;
  const inferenceCost = workload.tokenCost;
  return {
    model,
    effortRecipe,
    workload,
    sampleCost,
    inferenceCost,
    totalCost: sampleCost + inferenceCost,
  };
}

/** Queue a private checkpoint benchmark in the unified concurrent scheduler. */
export function benchmarkTrainingJob(
  state: SimState,
  jobId: string,
  request?: TrainingBenchmarkRequest,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.failed) return state;
  const recommended = Math.max(1e-9, job.recommendedPfDays ?? job.targetPfDays);
  const progressFrac = job.progressPfDays / recommended;
  if (progressFrac < TRAINING_BENCHMARK_MIN_PROGRESS) {
    return withAlert(
      state,
      "warn",
      "Benchmarks unlock after 10% of recommended training.",
    );
  }
  const eligible = eligibleTrainingBenchmarkSuites(job);
  const eligibleById = new Map(eligible.map((option) => [option.id, option]));
  const primary = eligible[0];
  if (!primary) {
    return withAlert(
      state,
      "warn",
      `${job.name} has no eligible benchmark suites.`,
    );
  }
  const suiteIds = request?.suiteIds ? [...request.suiteIds] : [primary.id];
  const spendPerSuite = request?.spendPerSuite ?? primary.referenceSpend;
  if (suiteIds.length === 0) {
    return withAlert(state, "warn", "Select at least one benchmark suite.");
  }
  if (new Set(suiteIds).size !== suiteIds.length) {
    return withAlert(
      state,
      "warn",
      "Each benchmark suite can only be selected once.",
    );
  }
  const unknown = suiteIds.find(
    (suiteId) => !Object.hasOwn(TRAINING_BENCHMARK_SUITE_OPTIONS, suiteId),
  );
  if (unknown) {
    return withAlert(
      state,
      "warn",
      `Unknown benchmark suite: ${String(unknown)}.`,
    );
  }
  const irrelevant = suiteIds.find((suiteId) => !eligibleById.has(suiteId));
  if (irrelevant) {
    return withAlert(
      state,
      "warn",
      `${TRAINING_BENCHMARK_SUITE_OPTIONS[irrelevant].label} is not relevant to ${job.name}.`,
    );
  }
  if (!Number.isFinite(spendPerSuite)) {
    return withAlert(state, "warn", "Benchmark spend must be a finite amount.");
  }
  const outsideSpendBounds = suiteIds.find((suiteId) => {
    const option = eligibleById.get(suiteId)!;
    return spendPerSuite < option.minSpend || spendPerSuite > option.maxSpend;
  });
  if (outsideSpendBounds) {
    const option = eligibleById.get(outsideSpendBounds)!;
    return withAlert(
      state,
      "warn",
      `${option.label} spend must be $${option.minSpend.toLocaleString("en-US")}–$${option.maxSpend.toLocaleString("en-US")}.`,
    );
  }
  const effortRecipeId = request?.effortRecipeId ?? INSTANT_EFFORT_ID;
  let quote: TrainingBenchmarkQuote;
  try {
    quote = quoteTrainingBenchmark(state, job, {
      suiteIds,
      spendPerSuite,
      effortRecipeId,
    });
  } catch (cause) {
    return withAlert(
      state,
      "warn",
      cause instanceof Error ? cause.message : "Benchmark quote failed.",
    );
  }
  const { effortRecipe, workload, inferenceCost, totalCost } = quote;
  if (state.player.cash + 1e-9 < totalCost) {
    return withAlert(
      state,
      "warn",
      `Need $${totalCost.toLocaleString("en-US")} to run ${suiteIds.length} benchmark suite${suiteIds.length === 1 ? "" : "s"}.`,
    );
  }
  const measurement = trainingBenchmarkAccuracyForSpend(spendPerSuite);
  const stage: TrainableStage =
    job.postTrain === "none" ? "base" : job.postTrain;
  const sequence = Math.max(
    0,
    job.benchmarkSequence ?? job.benchmarkSnapshots?.length ?? 0,
  );
  const pending: TrainingBenchmarkPending = {
    id: seededId(
      "training-benchmark",
      state.seed,
      job.id,
      sequence,
      state.day,
      suiteIds.join(","),
    ),
    startedDay: state.day,
    readyDay: state.day + 2,
    progress: progressFrac,
    stage,
    suiteIds,
    spendPerSuite,
    totalCost,
    accuracy: measurement.accuracy,
    confidence: measurement.confidence,
    capturedLoss: observedLoss(job) ?? undefined,
    effortRecipeId: effortRecipe.id,
    workload,
    inferenceCost,
    computeProgressPfDays: 0,
  };
  const updated: TrainingJob = {
    ...job,
    // Legacy mirror for older UI/save consumers. The queue is authoritative.
    pendingBenchmark: job.pendingBenchmark ?? pending,
    benchmarkSequence: sequence + 1,
    lastBenchmarkDay: state.day,
  };
  const charged = chargeExpense(state, totalCost, "training");
  const withUpdatedJob = withTrainingJobs(
    charged,
    jobs.map((candidate) => (candidate.id === job.id ? updated : candidate)),
  );
  return withAlert(
    {
      ...withUpdatedJob,
      player: {
        ...withUpdatedJob.player,
        privateEvaluationJobs: [
          ...(withUpdatedJob.player.privateEvaluationJobs ?? []),
          {
            id: pending.id,
            kind: "training_benchmark" as const,
            subjectId: job.id,
            scheduledDay: state.day,
            readyDay: pending.readyDay,
            pending,
          },
        ],
      },
    },
    "info",
    `Benchmark started for ${job.name}: ${suiteIds.length} suite${suiteIds.length === 1 ? "" : "s"}, ${effortRecipe.name}, $${totalCost.toLocaleString("en-US")}, ${workload.computePfDays.toFixed(2)} PF-days at ${Math.round(measurement.accuracy * 100)}% measurement accuracy — earliest results in 2 days.`,
  );
}

function checkpointCandidateAtMilestone(
  state: SimState,
  job: TrainingJob,
  milestone: number,
  options?: {
    id?: string;
    modelId?: string;
    kind?: "milestone" | "manual";
    customLabel?: string;
    branchDirection?: TrainingCheckpointBranchDirection;
    parentCheckpointId?: string;
    ordinal?: number;
    captureCurrent?: boolean;
  },
): TrainingCheckpointCandidate {
  const ordinal =
    options?.ordinal ??
    Math.max(
      1,
      TRAINING_CAMPAIGN_MILESTONES.findIndex(
        (candidate) => Math.abs(candidate - milestone) < 1e-9,
      ) + 1,
    );
  const id =
    options?.id ??
    seededId("training-checkpoint", state.seed, job.id, milestone);
  const modelId =
    options?.modelId ??
    seededId("checkpoint-model", state.seed, job.id, milestone);
  const lineageId =
    job.lineageId ??
    job.continueLineageId ??
    seededId("lineage", state.seed, job.id, job.name);
  // Normally the tick captures exactly at the milestone. For legacy/in-flight
  // saves that recorded reached milestones before candidates existed, manual
  // capture reconstructs the missing earlier progress point from the persisted
  // curve instead of mislabelling today's later weights as that checkpoint.
  const capturedProgressPfDays = options?.captureCurrent
    ? job.progressPfDays
    : Math.min(job.progressPfDays, job.targetPfDays * milestone);
  const elapsedRatio =
    job.progressPfDays > 1e-9 ? capturedProgressPfDays / job.progressPfDays : 0;
  const snapshotJob: TrainingJob = options?.captureCurrent
    ? { ...job }
    : {
        ...job,
        progressPfDays: capturedProgressPfDays,
        daysElapsed: Math.min(
          job.daysElapsed ?? 0,
          Math.max(0, Math.round((job.daysElapsed ?? 0) * elapsedRatio)),
        ),
        energyMWh: Math.max(
          0,
          (job.energyMWh ?? (job.energyMwDays ?? 0) * 24) * elapsedRatio,
        ),
        energyMwDays: Math.max(0, (job.energyMwDays ?? 0) * elapsedRatio),
        lossHistory: (job.lossHistory ?? []).filter(
          (point) =>
            point.stage !== "base" || point.progress <= milestone + 1e-9,
        ),
      };
  const progress = Math.max(
    0,
    Math.min(
      1,
      snapshotJob.progressPfDays / Math.max(1e-9, snapshotJob.targetPfDays),
    ),
  );
  const built = buildModelFromJob(state, snapshotJob, "internal");
  const milestoneLabel = Math.round(milestone * 100);
  const stage: TrainingCheckpointCandidate["stage"] =
    options?.captureCurrent && snapshotJob.postTrain !== "none"
      ? snapshotJob.postTrain
      : "base";
  const stageProgress =
    stage === "base"
      ? progress
      : Math.max(
          0,
          Math.min(
            1,
            snapshotJob.postTrainProgress /
              Math.max(1e-9, snapshotJob.postTrainTarget),
          ),
        );
  const model: Model = {
    ...built,
    id: modelId,
    lineageId,
    parentModelId: job.continueFromId,
    checkpointCandidateId: id,
    sourceTrainingJobId: job.id,
    checkpointProgress: progress,
    name: options?.customLabel?.trim() || `${built.name} · C${milestoneLabel}`,
    release: "internal",
    shipped: false,
    releaseDay: state.day,
    trainingLossHistory: [...(built.trainingLossHistory ?? [])],
    trainingBenchmarkSnapshots: [...(built.trainingBenchmarkSnapshots ?? [])],
  };
  return {
    id,
    sourceJobId: job.id,
    lineageId,
    sourceModelId: job.continueFromId,
    ordinal,
    kind: options?.kind ?? "milestone",
    customLabel: options?.customLabel?.trim() || undefined,
    branchDirection:
      options?.branchDirection ?? job.branchDirection ?? "general",
    parentCheckpointId: options?.parentCheckpointId ?? job.parentCheckpointId,
    milestone,
    capturedDay: state.day,
    stage,
    status: "stealth",
    model,
    telemetry: {
      progressPfDays: snapshotJob.progressPfDays,
      targetPfDays: snapshotJob.targetPfDays,
      progress,
      daysElapsed: snapshotJob.daysElapsed ?? 0,
      stage,
      stageProgress,
      loss: observedLoss(snapshotJob),
      energyMWh: Math.max(
        0,
        snapshotJob.energyMWh ?? (snapshotJob.energyMwDays ?? 0) * 24,
      ),
      trainingNumerics: snapshotJob.trainingNumerics ?? snapshotJob.numerics,
    },
  };
}

function appendTrainingCheckpoint(
  state: SimState,
  job: TrainingJob,
  milestone: number,
): { state: SimState; candidate?: TrainingCheckpointCandidate } {
  const existing = state.player.trainingCheckpoints ?? [];
  const id = seededId("training-checkpoint", state.seed, job.id, milestone);
  if (existing.some((candidate) => candidate.id === id)) return { state };
  const candidate = checkpointCandidateAtMilestone(state, job, milestone);
  return {
    candidate,
    state: {
      ...state,
      player: {
        ...state.player,
        trainingCheckpoints: [...existing, candidate],
      },
    },
  };
}

/**
 * Write the latest earned campaign checkpoint into the stealth registry.
 * This does not pause/finalize the source job or expose the weights to any
 * ordinary model-fleet consumer.
 */
export function captureTrainingCheckpoint(
  state: SimState,
  jobId: string,
): SimState {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === jobId,
  );
  if (!job || job.failed) {
    return withAlert(state, "warn", "Active training campaign not found.");
  }
  const progress = job.progressPfDays / Math.max(1e-9, job.targetPfDays);
  const reached = new Set(job.campaignMilestonesReached ?? []);
  const existingCheckpointIds = new Set(
    (state.player.trainingCheckpoints ?? []).map((candidate) => candidate.id),
  );
  const milestone = [...TRAINING_CAMPAIGN_MILESTONES]
    .reverse()
    .find(
      (candidate) =>
        reached.has(candidate) &&
        candidate <= progress + 1e-9 &&
        !existingCheckpointIds.has(
          seededId("training-checkpoint", state.seed, job.id, candidate),
        ),
    );
  if (milestone == null) {
    const reachedAny = TRAINING_CAMPAIGN_MILESTONES.some(
      (candidate) => reached.has(candidate) && candidate <= progress + 1e-9,
    );
    return withAlert(
      state,
      "warn",
      reachedAny
        ? `${job.name}'s earned checkpoints are already in stealth review.`
        : `Save a snapshot from this run when you want a weight file. Incidents at ${Math.round(TRAINING_CAMPAIGN_MILESTONES[0] * 100)}% do not create files automatically.`,
    );
  }
  const result = appendTrainingCheckpoint(state, job, milestone);
  if (!result.candidate) {
    return withAlert(
      state,
      "warn",
      `${job.name}'s ${Math.round(milestone * 100)}% checkpoint is already in stealth review.`,
    );
  }
  return withAlert(
    result.state,
    "info",
    `${job.name}'s ${Math.round(milestone * 100)}% checkpoint entered stealth review. Training continues.`,
  );
}

export interface CreateManualTrainingCheckpointRequest {
  sourceJobId: string;
  label?: string;
  branchDirection?: TrainingCheckpointBranchDirection;
}

/** Stable identity for the exact current weights, shared by direct run actions. */
export function currentManualTrainingCheckpointId(
  state: SimState,
  jobId: string,
): string | undefined {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === jobId,
  );
  if (
    !job ||
    job.failed ||
    (job.progressPfDays <= 1e-9 && job.postTrainProgress <= 1e-9)
  ) {
    return undefined;
  }
  const stage: TrainableStage =
    job.postTrain === "none" ? "base" : job.postTrain;
  return seededId(
    "training-checkpoint-manual",
    state.seed,
    job.id,
    stage,
    Math.round(job.progressPfDays * 1_000_000),
    Math.round(job.postTrainProgress * 1_000_000),
  );
}

/** Capture the exact current weights; repeated clicks at unchanged weights dedupe. */
export function createManualTrainingCheckpoint(
  state: SimState,
  request: CreateManualTrainingCheckpointRequest,
): SimState {
  const job = playerTrainingJobs(state).find(
    (candidate) => candidate.id === request.sourceJobId,
  );
  if (!job || job.failed)
    return withAlert(state, "warn", "Active training campaign not found.");
  if (job.progressPfDays <= 1e-9 && job.postTrainProgress <= 1e-9) {
    return withAlert(
      state,
      "warn",
      "Allocate compute before capturing a manual checkpoint.",
    );
  }
  const id = currentManualTrainingCheckpointId(state, job.id)!;
  const existing = state.player.trainingCheckpoints ?? [];
  if (existing.some((candidate) => candidate.id === id)) {
    return withAlert(
      state,
      "warn",
      "These exact weights are already in the checkpoint archive.",
    );
  }
  const baseProgress = Math.max(
    0,
    Math.min(1, job.progressPfDays / Math.max(1e-9, job.targetPfDays)),
  );
  const ordinal =
    existing.filter((candidate) => candidate.sourceJobId === job.id).length + 1;
  const candidate = checkpointCandidateAtMilestone(state, job, baseProgress, {
    id,
    modelId: seededId("checkpoint-model-manual", state.seed, id),
    kind: "manual",
    customLabel: request.label,
    branchDirection: request.branchDirection ?? job.branchDirection,
    parentCheckpointId: job.parentCheckpointId,
    ordinal,
    captureCurrent: true,
  });
  return withAlert(
    {
      ...state,
      player: {
        ...state.player,
        trainingCheckpoints: [...existing, candidate],
      },
    },
    "info",
    `${candidate.model.name} captured from the current weights. Training continues.`,
  );
}

export interface ForkTrainingCheckpointRequest {
  checkpointId: string;
  direction: TrainingCheckpointBranchDirection;
  label?: string;
  weights?: Partial<Record<DataDomain, number>>;
  specializationFocus?: SpecializationFocus;
}

function branchDataWeights(
  candidate: TrainingCheckpointCandidate,
  direction: TrainingCheckpointBranchDirection,
): Record<DataDomain, number> {
  const source = normalizeWeights(
    candidate.model.dataPlan?.weights ??
      defaultTrainingDataWeights(
        candidate.model.family,
        candidate.model.productPreset ??
          presetFromFamily(candidate.model.family),
      ),
  );
  const boost = (domains: readonly DataDomain[], multiplier: number) => {
    for (const domain of domains) source[domain] *= multiplier;
  };
  if (direction === "chat") boost(["chat"], 2.4);
  if (direction === "code") boost(["code", "math"], 2.1);
  if (direction === "cyber") {
    boost(["code"], 2.2);
    boost(["law", "chat"], 1.55);
  }
  if (direction === "agents") boost(["code", "chat"], 1.8);
  if (direction === "reasoning") boost(["math", "science"], 2.2);
  if (direction === "safety") boost(["law", "health", "chat"], 1.8);
  return normalizeWeights(source);
}

/** Start a normal, data-consuming continuation from explicit private weights. */
export function forkTrainingCheckpoint(
  state: SimState,
  request: ForkTrainingCheckpointRequest,
): SimState {
  const checkpoint = (state.player.trainingCheckpoints ?? []).find(
    (candidate) => candidate.id === request.checkpointId,
  );
  if (!checkpoint || checkpoint.status === "discarded") {
    return withAlert(state, "warn", "Usable checkpoint not found.");
  }
  const source = checkpoint.model;
  const explicitFocus = request.specializationFocus;
  const focus =
    explicitFocus ??
    (request.direction !== "general" && request.direction !== "custom"
      ? branchFocusPreset(request.direction)
      : undefined);
  const specialized = focusMagnitude(focus) > 0.12;
  const sourceMix = normalizeWeights(
    source.dataPlan?.weights ??
      defaultTrainingDataWeights(
        source.family,
        source.productPreset ?? presetFromFamily(source.family),
      ),
  );
  const focusedMix =
    explicitFocus && specialized ? focusToMix(explicitFocus, sourceMix) : undefined;
  return startTraining(state, {
    name: request.label?.trim() || source.name,
    family: source.family,
    backbone: source.backbone,
    productPreset: source.productPreset,
    io: source.io,
    paramsB: source.paramsB,
    activeParamsB: source.activeParamsB,
    mode: "continue",
    continueFromId: source.id,
    continueFromCheckpointId: checkpoint.id,
    branchDirection: request.direction,
    lifecycle: specialized ? "specialized" : undefined,
    specializationFocus: specialized ? focus : undefined,
    dataPlan: {
      totalUnits: Math.max(1, newDataSinceModel(state, source)),
      totalMTok: Math.max(1, newDataSinceModel(state, source)),
      trainShare: 0.88,
      weights: request.weights
        ? normalizeWeights({
            ...branchDataWeights(checkpoint, request.direction),
            ...request.weights,
          })
        : (focusedMix ?? branchDataWeights(checkpoint, request.direction)),
      allowSynthetic: false,
    },
  });
}

export interface RollbackTrainingJobToCheckpointRequest {
  jobId: string;
  checkpointId: string;
}

export interface RecoverFailedPostTrainRequest {
  jobId: string;
  checkpointId: string;
}

/**
 * Recover a destructive post-training failure as a distinct immutable branch.
 * The failed job, spent PF/data/cash and evidence stay in history; the child
 * reuses the saved weights and recipe snapshot, then reruns only the failed
 * stage with a fresh, frozen recovery-attempt risk plan.
 */
export function recoverFailedPostTrainFromCheckpoint(
  state: SimState,
  request: RecoverFailedPostTrainRequest,
): SimState {
  const jobs = playerTrainingJobs(state);
  const failedJob = jobs.find((job) => job.id === request.jobId);
  const checkpoint = (state.player.trainingCheckpoints ?? []).find(
    (candidate) => candidate.id === request.checkpointId,
  );
  if (
    !failedJob?.failed ||
    failedJob.failureStage == null ||
    failedJob.failureStage === "base"
  ) {
    return withAlert(
      state,
      "warn",
      "Only a failed post-training run can be recovered.",
    );
  }
  if (
    !checkpoint ||
    checkpoint.status === "discarded" ||
    checkpoint.sourceJobId !== failedJob.id ||
    failedJob.failureRecoveryCheckpointId !== checkpoint.id
  ) {
    return withAlert(
      state,
      "warn",
      "Recovery requires the eligible immutable pre-failure checkpoint.",
    );
  }
  if (
    failedJob.recoveryChildJobId ||
    jobs.some((job) => job.recoveredFromJobId === failedJob.id)
  ) {
    return withAlert(
      state,
      "warn",
      "This failed run already has a recovery branch.",
    );
  }
  const attempt = Math.max(1, (failedJob.postTrainRecoveryAttempt ?? 0) + 1);
  const recoveryId = seededId(
    "posttrain-recovery",
    state.seed,
    failedJob.id,
    checkpoint.id,
    attempt,
  );
  if (jobs.some((job) => job.id === recoveryId)) {
    return withAlert(state, "warn", "This recovery attempt already exists.");
  }
  const recoveryStage = failedJob.failureStage;
  const resumeFraction =
    checkpoint.stage === recoveryStage
      ? Math.max(0, Math.min(0.98, checkpoint.telemetry.stageProgress))
      : 0;
  const checkpointCompleted = (
    checkpoint.model.completedPostTrainStages ?? []
  ).filter((stage) => stage !== recoveryStage);
  const checkpointCompletedSet = new Set(checkpointCompleted);
  const completedThisRun = (
    failedJob.postTrainStagesCompletedThisRun ?? []
  ).filter((stage) => checkpointCompletedSet.has(stage));
  const checkpointStageIndex =
    checkpoint.stage === "base"
      ? 0
      : POST_TRAIN_ORDER.indexOf(checkpoint.stage);
  const restoredLossHistory = (failedJob.lossHistory ?? []).filter((point) => {
    if (point.stage === "base") return true;
    const pointStageIndex = POST_TRAIN_ORDER.indexOf(point.stage);
    if (pointStageIndex < checkpointStageIndex) return true;
    return (
      pointStageIndex === checkpointStageIndex &&
      point.progress <= checkpoint.telemetry.stageProgress + 1e-9
    );
  });
  const postTrainTarget = Math.max(
    1e-9,
    failedJob.postTrainTarget ||
      studioPostTrainTargetPfDays(
        failedJob,
        recoveryStage,
        failedJob.targetParamsB,
        state.player.postTrainGyms,
      ),
  );
  const stagedChild: TrainingJob = {
    ...failedJob,
    id: recoveryId,
    name: `${failedJob.name} recovery ${attempt}`,
    progressPfDays: failedJob.targetPfDays,
    energyMwDays: 0,
    energyMWh: 0,
    daysRemaining: undefined,
    daysElapsed: 0,
    completedPostTrainStages: checkpointCompleted,
    postTrainStageEffectiveness: {
      ...(checkpoint.model.postTrainStageEffectiveness ?? {}),
    },
    postTrainStageRuns: { ...(checkpoint.model.postTrainStageRuns ?? {}) },
    postTrainStagesCompletedThisRun: completedThisRun,
    postTrain: recoveryStage,
    postTrainProgress: postTrainTarget * resumeFraction,
    postTrainTarget,
    postTrainDaysElapsed: 0,
    postTrainRiskPlan: undefined,
    postTrainRecoveryAttempt: attempt,
    recoveredFromJobId: failedJob.id,
    recoveryCheckpointId: checkpoint.id,
    recoveryChildJobId: undefined,
    parentCheckpointId: checkpoint.id,
    productProfile:
      cloneProductProfileForContinue(checkpoint.model.productProfile) ??
      failedJob.productProfile,
    benchmarkSnapshots: [],
    pendingBenchmark: undefined,
    benchmarkSequence: 0,
    lastBenchmarkDay: undefined,
    pendingCampaignEvent: undefined,
    failed: false,
    failureStage: undefined,
    failureDay: undefined,
    failureReason: undefined,
    failureRecord: undefined,
    failureRecoveryCheckpointId: undefined,
    paused: false,
    stallReason: null,
    cashSunk: 0,
    economics: {
      setupCost: 0,
      dataCost: 0,
      trainingCostAccrued: 0,
    },
    lossHistory: restoredLossHistory,
  };
  stagedChild.postTrainRiskPlan = createPostTrainRiskPlan(
    stagedChild,
    recoveryStage,
    state.player.researchUnlocked,
    state.player.models,
    state.day,
    resumeFraction,
  );
  const nextJobs = jobs.map((job) =>
    job.id === failedJob.id
      ? { ...job, recoveryChildJobId: stagedChild.id }
      : job,
  );
  return withAlert(
    withTrainingJobs(state, [...nextJobs, stagedChild]),
    "warn",
    `${failedJob.name}: recovery branch started from ${checkpoint.model.name}. Prior compute, data and cash remain spent; ${recoveryStage.toUpperCase()} resumes from ${Math.round(resumeFraction * 100)}% without consuming the corpus twice.`,
  );
}

/**
 * Safe rollback semantics: branch from immutable weights, never rewind spent
 * optimizer state or refund compute/data. The source run pauses only if the
 * child launch succeeds.
 */
export function rollbackTrainingJobToCheckpoint(
  state: SimState,
  request: RollbackTrainingJobToCheckpointRequest,
): SimState {
  const sourceJob = playerTrainingJobs(state).find(
    (job) => job.id === request.jobId,
  );
  const checkpoint = (state.player.trainingCheckpoints ?? []).find(
    (candidate) => candidate.id === request.checkpointId,
  );
  if (sourceJob?.failed && sourceJob.failureStage !== "base") {
    return recoverFailedPostTrainFromCheckpoint(state, request);
  }
  if (
    !sourceJob ||
    !checkpoint ||
    checkpoint.status === "discarded" ||
    checkpoint.sourceJobId !== sourceJob.id
  ) {
    return withAlert(
      state,
      "warn",
      "Rollback requires an immutable checkpoint from this active run.",
    );
  }
  const beforeIds = new Set(playerTrainingJobs(state).map((job) => job.id));
  const branched = forkTrainingCheckpoint(state, {
    checkpointId: checkpoint.id,
    direction: checkpoint.branchDirection ?? "general",
    label: checkpoint.customLabel,
  });
  const launched = playerTrainingJobs(branched).some(
    (job) => !beforeIds.has(job.id),
  );
  if (!launched) return branched;
  return withTrainingJobs(
    branched,
    playerTrainingJobs(branched).map((job) =>
      job.id === sourceJob.id
        ? {
            ...job,
            paused: true,
            stallReason: "Paused after checkpoint branch.",
          }
        : job,
    ),
  );
}

/** Retain stealth weights as an internal model without ending their source run. */
export function promoteTrainingCheckpoint(
  state: SimState,
  checkpointId: string,
): SimState {
  const checkpoints = state.player.trainingCheckpoints ?? [];
  const checkpoint = checkpoints.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (!checkpoint) return withAlert(state, "warn", "Checkpoint not found.");
  if (checkpoint.status === "discarded") {
    return withAlert(
      state,
      "warn",
      "Discarded checkpoint weights cannot be retained.",
    );
  }
  const pendingEvaluation = (state.player.privateEvaluationJobs ?? []).find(
    (job) =>
      job.kind === "checkpoint_evaluation" && job.subjectId === checkpoint.id,
  );
  if (pendingEvaluation) {
    return withAlert(
      state,
      "warn",
      `Stealth evaluation is still running until day ${pendingEvaluation.readyDay}.`,
    );
  }
  if (
    checkpoint.status === "promoted" ||
    state.player.models.some((model) => model.id === checkpoint.model.id)
  ) {
    return withAlert(
      state,
      "warn",
      "Checkpoint is already retained internally.",
    );
  }
  const retained: Model = {
    ...checkpoint.model,
    release: "internal",
    shipped: false,
    trainingLossHistory: [...(checkpoint.model.trainingLossHistory ?? [])],
    trainingBenchmarkSnapshots: [
      ...(checkpoint.model.trainingBenchmarkSnapshots ?? []),
    ],
    checkpointEvaluations: [...(checkpoint.evaluations ?? [])],
  };
  return withAlert(
    {
      ...state,
      player: {
        ...state.player,
        models: [...state.player.models, retained],
        trainingCheckpoints: checkpoints.map((candidate) =>
          candidate.id === checkpointId
            ? {
                ...candidate,
                status: "promoted" as const,
                promotedModelId: retained.id,
                promotedDay: state.day,
              }
            : candidate,
        ),
      },
    },
    "info",
    `${checkpoint.model.name} retained as an internal checkpoint. Its source campaign continues.`,
  );
}

/** Permanently delete an unpromoted stealth candidate and its private evidence. */
export function discardTrainingCheckpoint(
  state: SimState,
  checkpointId: string,
): SimState {
  const checkpoints = state.player.trainingCheckpoints ?? [];
  const checkpoint = checkpoints.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (!checkpoint) return withAlert(state, "warn", "Checkpoint not found.");
  if (
    checkpoint.status === "promoted" ||
    state.player.models.some(
      (model) =>
        model.id === checkpoint.model.id ||
        model.id === checkpoint.promotedModelId,
    )
  ) {
    return withAlert(
      state,
      "warn",
      "Retained checkpoints must be managed from the model fleet.",
    );
  }
  if (checkpoint.status === "discarded") {
    return withAlert(state, "warn", "Checkpoint is already discarded.");
  }
  const hasActiveChild = playerTrainingJobs(state).some(
    (job) => job.parentCheckpointId === checkpoint.id,
  );
  const hasArchivedChild = checkpoints.some(
    (candidate) =>
      candidate.id !== checkpoint.id &&
      candidate.parentCheckpointId === checkpoint.id &&
      candidate.status !== "discarded",
  );
  const hasFinalizedChild = state.player.models.some(
    (model) => model.parentModelId === checkpoint.model.id,
  );
  if (hasActiveChild || hasArchivedChild || hasFinalizedChild) {
    return withAlert(
      state,
      "warn",
      "Cannot discard checkpoint weights while a child branch or version depends on them.",
    );
  }
  const ownership = reconcileCheckpointOwnership({
    checkpoints: checkpoints.map((candidate) =>
      candidate.id === checkpoint.id
        ? {
            ...candidate,
            status: "discarded" as const,
            discardedDay: state.day,
          }
        : candidate,
    ),
    privateEvaluationJobs: state.player.privateEvaluationJobs ?? [],
    models: state.player.models,
    jobs: playerTrainingJobs(state),
    affectedCheckpointIds: new Set([checkpoint.id]),
  });
  const cancelled = ownership.cancelledEvaluationJobIds.length;
  return withAlert(
    {
      ...state,
      player: {
        ...state.player,
        trainingCheckpoints: ownership.checkpoints,
        privateEvaluationJobs: ownership.privateEvaluationJobs,
      },
    },
    "info",
    `${checkpoint.model.name} checkpoint deleted with its private reports and reviews.${
      cancelled > 0
        ? ` Cancelled ${cancelled} queued private stud${cancelled === 1 ? "y" : "ies"} without refund.`
        : ""
    }`,
  );
}

/** @deprecated use releaseFromJob / keepInternal */
export function shipModel(state: SimState): SimState {
  return releaseFromJob(state);
}

function finalizeJob(
  state: SimState,
  release: "internal" | "released",
  jobId?: string,
  _allowEarlyRelease: boolean = false,
  opts?: { list?: boolean },
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobId
    ? jobs.find((candidate) => candidate.id === jobId)
    : jobs[0];
  if (!job || job.failed) return state;
  const pendingPrivateBenchmarks = (
    state.player.privateEvaluationJobs ?? []
  ).filter(
    (evaluation) =>
      evaluation.kind === "training_benchmark" &&
      evaluation.subjectId === job.id,
  );
  if (pendingPrivateBenchmarks.length > 0) {
    const readyDay = Math.max(
      ...pendingPrivateBenchmarks.map((evaluation) => evaluation.readyDay),
    );
    return withAlert(
      state,
      "warn",
      `${job.name} has ${pendingPrivateBenchmarks.length} private benchmark run${pendingPrivateBenchmarks.length === 1 ? "" : "s"} in flight (latest result day ${readyDay}).`,
    );
  }
  const releaseGate = canReleaseTrainingJob(job);
  const isEarlyRelease = releaseGate.releaseKind === "early";
  // Anytime launch: public and internal ship once min progress is met.
  // Calendar / plateau are recommendations enforced only via maturity haircuts.
  if (!releaseGate.ok) {
    return withAlert(
      state,
      "warn",
      releaseGate.reason ??
        (release === "released"
          ? "Cannot release yet."
          : "Training has not reached the minimum launch progress."),
    );
  }
  const list = release === "released" && opts?.list !== false;
  const model = buildModelFromJob(state, job, release, list);
  // A continuation is a new immutable checkpoint/version. Keep the source in
  // the fleet so plans, API customers, teachers, and historical economics do
  // not silently move to different weights.
  const models = [...state.player.models, model];
  let pricing = { ...state.player.pricing };

  let brand = state.player.brandTrust;
  if (release === "released") {
    pricing = {
      ...pricing,
      activeModelId: pricing.activeModelId ?? model.id,
    };
    // Capability floor tracks the early millions-era band (~5–10). Only
    // under-trained / broken releases take the flop brand hit.
    if (model.quality.reliability < 35 || model.capability < 5) {
      brand = Math.max(10, brand - 8);
    } else if (model.quality.reliability > 60 && model.capability > 40) {
      brand = Math.min(100, brand + 4);
    }
  }

  const newsLine =
    job.mode === "continue"
      ? `Day ${state.day}: Continued ${model.name} → cap ${model.capability.toFixed(0)}`
      : release === "released"
        ? `Day ${state.day}: Released ${model.name} (${formatParams(model.paramsB)}, cap ${model.capability.toFixed(0)})`
        : `Day ${state.day}: Internal checkpoint ${model.name} (${formatParams(model.paramsB)}) — private`;
  const outcomeLine = model.outcome
    ? `${model.outcome.kind === "breakthrough" ? "Breakthrough" : model.outcome.kind === "stumble" ? "Training stumble" : "Training result"}: ${(model.outcome.yieldMultiplier * 100).toFixed(1)}% optimization yield. ${model.outcome.explanation}`
    : "";

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      trainingJobs: jobs.filter((candidate) => candidate.id !== job.id),
      trainingJob: jobs.find((candidate) => candidate.id !== job.id) ?? null,
      models,
      trainingCheckpoints: (state.player.trainingCheckpoints ?? []).map(
        (checkpoint) =>
          checkpoint.sourceJobId === job.id &&
          checkpoint.sourceOwnershipRevoked !== true
            ? { ...checkpoint, ownerModelId: model.id }
            : checkpoint,
      ),
      pricing,
      brandTrust: brand,
    },
    news: [
      outcomeLine ? `Day ${state.day}: ${model.name} — ${outcomeLine}` : "",
      newsLine,
      ...state.news,
    ]
      .filter(Boolean)
      .slice(0, 20),
    alerts: [
      {
        id: `done-${model.id}-${state.day}`,
        day: state.day,
        severity:
          release === "released" && model.quality.reliability < 40
            ? ("warn" as const)
            : ("info" as const),
        message:
          job.mode === "continue"
            ? `${model.name} continue-train complete (cap ${model.capability.toFixed(0)}).`
            : release === "internal"
              ? `${model.name} kept internal. Use as distillation teacher or release later.`
              : isEarlyRelease
                ? `Released ${model.name} early at ${Math.round((job.progressPfDays / Math.max(job.targetPfDays, 1e-9)) * 100)}% compute — capability and benchmarks are degraded.`
                : model.quality.reliability < 40
                  ? `Released ${model.name} — rough quality. Expect churn.`
                  : `Released ${model.name}. ${outcomeLine} Set API price and assign to Plans.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    onboardingStep: Math.max(
      state.onboardingStep,
      release === "released" ? 2 : 1,
    ),
  };

  if (release === "released") {
    if (list) next = attachModelToEmptyPlans(next, model.id);
    next = scheduleReleaseEvaluations(next, model.id);
  }
  return appendFeedEvents(next, [
    {
      id: `feed-training-complete-${model.id}-${state.day}`,
      day: state.day,
      category: "models",
      title:
        release === "released"
          ? `Model released: ${model.name}`
          : `Checkpoint captured: ${model.name}`,
      body: `${release === "released" ? "Public endpoint" : "Private checkpoint"} at capability ${model.capability.toFixed(0)} from ${formatParams(model.paramsB)}. ${outcomeLine || "Training completed with no special outcome."}`,
      source: state.player.name,
      tone: release === "released" ? "positive" : "research",
      entityId: model.id,
      kind: release === "released" ? "model_released" : "training_checkpoint",
    },
  ]);
}

/** Release an existing internal model to the public product surface. */
export function releaseModel(
  state: SimState,
  modelId: string,
  opts?: { list?: boolean },
): SimState {
  const idx = state.player.models.findIndex((m) => m.id === modelId);
  if (idx < 0) return state;
  const m = state.player.models[idx]!;
  if (m.release === "released")
    return withAlert(state, "warn", "Already released.");

  // Ensure public models carry own in/out list (don't silently share lab default)
  let listIn = m.apiPriceInPerMTok;
  let listOut = m.apiPriceOutPerMTok;
  let listBlend = m.apiPricePerMTok;
  const hosting = apiHostingCostFloor(state, computeSnapshot(state), m);
  if (listIn == null || listOut == null) {
    listIn = m.suggestedApiPriceIn ?? m.costApiPriceIn;
    listOut = m.suggestedApiPriceOut ?? m.costApiPriceOut;
  }
  const listed = clampApiListToHostingFloor(
    listIn ?? hosting.costIn,
    listOut ?? hosting.costOut,
    hosting,
  );
  listIn = listed.priceIn;
  listOut = listed.priceOut;
  listBlend = Math.round(blendApiPrice(listIn, listOut) * 1000) / 1000;

  const models = state.player.models.slice();
  models[idx] = {
    ...m,
    release: "released",
    shipped: true,
    releaseDay: state.day,
    commerciallyOffered: opts?.list !== false,
    apiPriceInPerMTok: listIn,
    apiPriceOutPerMTok: listOut,
    apiPricePerMTok: listBlend,
    costApiPriceIn: hosting.costIn,
    costApiPriceOut: hosting.costOut,
  };

  let brand = state.player.brandTrust;
  if (m.quality.reliability < 35) brand = Math.max(10, brand - 5);
  else if (m.capability > 40) brand = Math.min(100, brand + 3);

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      models,
      brandTrust: brand,
      pricing: {
        ...state.player.pricing,
        activeModelId: state.player.pricing.activeModelId ?? m.id,
      },
    },
    news: [
      `Day ${state.day}: Released ${m.name} to market.`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `rel-${m.id}`,
        day: state.day,
        severity: "info" as const,
        message: `${m.name} is public. Set per-model API price and plan access.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    onboardingStep: Math.max(state.onboardingStep, 2),
  };
  if (opts?.list !== false) {
    next = attachModelToEmptyPlans(next, m.id);
  }
  next = scheduleReleaseEvaluations(next, m.id);
  return appendFeedEvents(next, [
    {
      id: `feed-model-release-${m.id}-${state.day}`,
      day: state.day,
      category: "models",
      title: `Model released: ${m.name}`,
      body: `Public endpoint at capability ${m.capability.toFixed(0)}; pricing and plan routing can now turn the checkpoint into demand.`,
      source: state.player.name,
      tone: "positive",
      entityId: m.id,
      kind: "model_released",
    },
  ]);
}

function stripModelFromProductSurface(
  pricing: SimState["player"]["pricing"],
  remainingLive: Model[],
  modelId: string,
): SimState["player"]["pricing"] {
  let next = { ...pricing };
  if (next.activeModelId === modelId) {
    const nextActive =
      remainingLive.find((model) => isLivePublicModel(model))?.id ??
      remainingLive[0]?.id ??
      null;
    next = { ...next, activeModelId: nextActive };
  }
  const plans = next.plans.map((plan) => ({
    ...plan,
    modelIds: plan.modelIds.filter((id) => id !== modelId),
  }));
  return {
    ...next,
    apiModelIds: next.apiModelIds?.filter((id) => id !== modelId),
    apiServePrecisionByModel: Object.fromEntries(
      Object.entries(next.apiServePrecisionByModel ?? {}).filter(
        ([id]) => id !== modelId,
      ),
    ),
    plans,
  };
}

/** Take a public model off the live fleet without deleting trainable weights. */
export function archiveModel(state: SimState, modelId: string): SimState {
  const idx = state.player.models.findIndex((model) => model.id === modelId);
  if (idx < 0) return withAlert(state, "warn", "Model not found.");
  const current = state.player.models[idx]!;
  if (current.archived) {
    return withAlert(state, "warn", `${current.name} is already archived.`);
  }
  if (!isLivePublicModel(current)) {
    return withAlert(
      state,
      "warn",
      "Only public models can be archived. Delete an internal checkpoint instead.",
    );
  }
  if (state.player.safetyCampaign?.modelId === modelId) {
    return withAlert(
      state,
      "warn",
      `Finish or cancel ${current.name}'s active safety campaign before archiving it.`,
    );
  }

  const models = state.player.models.slice();
  models[idx] = { ...current, archived: true };
  const remainingLive = models.filter((model) => isLivePublicModel(model));
  const pricing = stripModelFromProductSurface(
    state.player.pricing,
    remainingLive,
    modelId,
  );

  return {
    ...state,
    player: {
      ...state.player,
      models,
      pricing,
    },
    alerts: [
      {
        id: `archive-model-${modelId}-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message: `Archived ${current.name}. Off the public fleet — train or distill anytime, or restore to serve again.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

/** Put an archived model back on the public serving fleet. */
export function restoreArchivedModel(state: SimState, modelId: string): SimState {
  const idx = state.player.models.findIndex((model) => model.id === modelId);
  if (idx < 0) return withAlert(state, "warn", "Model not found.");
  const current = state.player.models[idx]!;
  if (!current.archived) {
    return withAlert(state, "warn", `${current.name} is not archived.`);
  }

  const models = state.player.models.slice();
  const restored = {
    ...current,
    archived: false,
    release: "released" as const,
    shipped: true,
    commerciallyOffered: true,
  };
  models[idx] = restored;

  let pricing = { ...state.player.pricing };
  if (!pricing.activeModelId) {
    pricing = { ...pricing, activeModelId: restored.id };
  }
  if (pricing.apiModelIds) {
    pricing = {
      ...pricing,
      apiModelIds: [...new Set([...pricing.apiModelIds, restored.id])],
    };
  }

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      models,
      pricing,
    },
    alerts: [
      {
        id: `restore-model-${modelId}-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message: `Restored ${current.name} to the public fleet.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
  next = attachModelToEmptyPlans(next, restored.id);
  return next;
}

/** Delete a model checkpoint (cannot delete while training job targets it). */
export function deleteModel(state: SimState, modelId: string): SimState {
  const m = state.player.models.find((x) => x.id === modelId);
  if (!m) return withAlert(state, "warn", "Model not found.");
  const inUse = playerTrainingJobs(state).some(
    (job) =>
      // A private branch owns its immutable parent snapshot independently of
      // the fleet row. Ordinary fleet continuations still block deletion.
      (job.continueFromId === modelId && job.parentCheckpointId == null) ||
      job.teacherId === modelId ||
      (job.dataPlan?.domainModels &&
        Object.values(job.dataPlan.domainModels).includes(modelId)) ||
      (job.dataPlan?.syntheticTeacherIds &&
        Object.values(job.dataPlan.syntheticTeacherIds).includes(modelId)),
  );
  if (inUse) {
    return withAlert(
      state,
      "warn",
      "Cannot delete — in use by the active training job.",
    );
  }

  const models = state.player.models.filter((x) => x.id !== modelId);
  const jobs = playerTrainingJobs(state);
  const affectedCheckpointIds = new Set(
    (state.player.trainingCheckpoints ?? [])
      .filter((checkpoint) => checkpointTouchesModel(checkpoint, m))
      .map((checkpoint) => checkpoint.id),
  );
  const checkpointsForDeletion = (state.player.trainingCheckpoints ?? []).map(
    (checkpoint) =>
      checkpoint.model.id === modelId || checkpoint.promotedModelId === modelId
        ? {
            ...checkpoint,
            ownerModelId: undefined,
            sourceOwnershipRevoked: true,
          }
        : checkpoint,
  );
  const ownership = reconcileCheckpointOwnership({
    checkpoints: checkpointsForDeletion,
    privateEvaluationJobs: state.player.privateEvaluationJobs ?? [],
    models,
    jobs,
    affectedCheckpointIds,
  });
  const pricing = stripModelFromProductSurface(
    state.player.pricing,
    models,
    modelId,
  );

  return {
    ...state,
    player: {
      ...state.player,
      models,
      trainingCheckpoints: ownership.checkpoints,
      privateEvaluationJobs: ownership.privateEvaluationJobs,
      pricing,
    },
    // Unpublished runs cannot produce evidence after their weights are gone.
    // Published evaluation/review history remains part of the market record.
    evaluations: state.evaluations.filter(
      (evaluation) =>
        evaluation.published ||
        evaluation.modelId !== modelId ||
        (evaluation.labId ?? state.playerLabId) !== state.playerLabId,
    ),
    alerts: [
      {
        id: `del-model-${modelId}-${state.day}`,
        day: state.day,
        severity: "info" as const,
        message: `Deleted model ${m.name}.${
          ownership.removedCheckpointIds.length > 0
            ? ` Removed ${ownership.removedCheckpointIds.length} unowned checkpoint${ownership.removedCheckpointIds.length === 1 ? "" : "s"} and cancelled their private studies without refund.`
            : ownership.downgradedCheckpointIds.length > 0
              ? ` ${ownership.downgradedCheckpointIds.length} checkpoint${ownership.downgradedCheckpointIds.length === 1 ? "" : "s"} returned to stealth because another concrete owner remains.`
              : ""
        }`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

function cloneProductProfileForContinue(
  profile: ModelProductProfile | undefined,
): ModelProductProfile | undefined {
  if (!profile) return undefined;
  const recipes = migrateEffortRecipes(profile).map((recipe) => ({ ...recipe }));
  return {
    ...profile,
    focus: { ...profile.focus },
    effortRecipes: recipes,
    effortPolicies: profile.effortPolicies?.map((policy) => ({ ...policy })),
    servedEfforts: profile.servedEfforts
      ? [...profile.servedEfforts]
      : undefined,
    defaultEffortId: defaultEffortIdOf({ ...profile, effortRecipes: recipes }),
  };
}

function continueBaseProductProfile(
  state: SimState,
  job: TrainingJob,
): ModelProductProfile | undefined {
  if (!job.continueFromId && !job.parentCheckpointId) return undefined;
  const fromModel = job.continueFromId
    ? state.player.models.find((model) => model.id === job.continueFromId)
    : undefined;
  if (fromModel?.productProfile) return fromModel.productProfile;
  const checkpoints = state.player.trainingCheckpoints ?? [];
  if (job.parentCheckpointId) {
    const byId = checkpoints.find(
      (candidate) => candidate.id === job.parentCheckpointId,
    );
    if (byId?.model.productProfile) return byId.model.productProfile;
  }
  if (job.continueFromId) {
    const byModelId = checkpoints.find(
      (candidate) => candidate.model.id === job.continueFromId,
    );
    if (byModelId?.model.productProfile) return byModelId.model.productProfile;
  }
  return undefined;
}

function productProfileForJob(
  state: SimState,
  job: TrainingJob,
): ModelProductProfile {
  if (job.productProfile) return job.productProfile;
  const inherited = cloneProductProfileForContinue(
    continueBaseProductProfile(state, job),
  );
  if (inherited) return inherited;
  return buildModelProductProfile({
    lifecycle: job.lifecycle,
    focus: job.specializationFocus,
    branchDirection: job.branchDirection,
    postTrain: job.postTrain,
    completedPostTrainStages: job.completedPostTrainStages,
    postTrainStageEffectiveness: job.postTrainStageEffectiveness,
    chatShare: job.dataPlan?.weights?.chat ?? 0,
    chatQuality: job.dataQualityUsed ?? 50,
    gyms: state.player.postTrainGyms,
    stackIds: job.modelStack,
    researchUnlocked: state.player.researchUnlocked,
    family: job.family,
    backbone: job.backbone,
    reasoningEnabled: job.completedPostTrainStages?.includes("process"),
    outcomeSeed: job.outcomeSeed,
    existing: job.productProfile,
  });
}

export function setDefaultEffort(
  state: SimState,
  id: string,
  effort: ReasoningEffort | string,
): SimState {
  const recipeId = effort === "low" ? INSTANT_EFFORT_ID : String(effort);
  return patchProductProfile(state, id, (profile) =>
    withDefaultRecipe(profile, recipeId),
  );
}

export function setServedEffort(
  state: SimState,
  id: string,
  effort: ReasoningEffort | string,
  served: boolean,
): SimState {
  const recipeId = effort === "low" ? INSTANT_EFFORT_ID : String(effort);
  return patchProductProfile(state, id, (profile) =>
    withServedRecipe(profile, recipeId, served),
  );
}

export type StartEffortTrainingRequest = {
  id: string;
  name?: string;
  thinkingTokenMult?: number;
  trainPfDays?: number;
  recipeId?: string;
  capabilityBias?: number;
  trainComputeShare?: number;
};

function standaloneEffortTrainingJob(input: {
  state: SimState;
  model: Model;
  profile: ModelProductProfile;
  recipe: EffortRecipe;
  cash: number;
}): TrainingJob {
  const { state, model, profile, recipe, cash } = input;
  const dataPlan = model.dataPlan ?? {
    totalUnits: 0,
    totalMTok: 0,
    trainShare: 0.9,
    weights: defaultDataWeights(model.family),
  };
  const targetPfDays = Math.max(1, recipe.targetPfDays ?? 1);
  const progressPfDays = Math.max(0, recipe.progressPfDays ?? 0);
  const id = seededId(
    "effort-job",
    state.seed,
    model.id,
    recipe.id,
    String(Math.round(targetPfDays * 1_000)),
  );
  return {
    id,
    name: `${model.name} · ${recipe.name} head`,
    family: model.family,
    backbone: model.backbone,
    productPreset: model.productPreset,
    io: model.io,
    targetParamsB: model.paramsB,
    activeParamsB: model.activeParamsB,
    targetPfDays,
    recommendedPfDays: targetPfDays,
    progressPfDays,
    energyMwDays: 0,
    energyMWh: 0,
    daysRemaining: Number.POSITIVE_INFINITY,
    minCalendarDays: 0,
    daysElapsed: 0,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    completedPostTrainStages: [
      ...(model.completedPostTrainStages ?? []),
    ],
    postTrainStageEffectiveness: {
      ...(model.postTrainStageEffectiveness ?? {}),
    },
    postTrainStageRuns: { ...(model.postTrainStageRuns ?? {}) },
    postTrainStagesCompletedThisRun: [],
    postTrainDaysElapsed: 0,
    postTrainPhaseResolved: true,
    mode: "continue",
    continueFromId: model.id,
    continueLineageId: model.lineageId,
    lineageId: model.lineageId,
    lifecycle: profile.lifecycle,
    specializationFocus: { ...profile.focus },
    productProfile: profile,
    effortTrain: effortTrainSnapshot(recipe),
    effortOnlySourceModelId: model.id,
    effortOnlyRecipeId: recipe.id,
    dataMix: model.dataMix ?? "web",
    dataPlan: { ...dataPlan, weights: { ...dataPlan.weights } },
    dataConsumed: {},
    dataCoverage: model.dataCoverage ?? 1,
    dataQualityUsed: model.dataQualityUsed ?? 50,
    syntheticUnits: 0,
    trainShare: dataPlan.trainShare ?? 0.9,
    trainMTok: 0,
    verifyMTok: 0,
    cashBurnPerDay: 0,
    cashSunk: cash,
    outcomeSeed:
      recipe.outcomeSeed ??
      hashSeed(state.seed, model.id, recipe.id, "effort-head-outcome-v1"),
    campaignMilestonesReached: [],
    campaignEventHistory: [],
    campaignModifiers: {
      capabilityDelta: 0,
      reliabilityDelta: 0,
      safetyDelta: 0,
      breakthroughBias: 0,
      stumbleRisk: 0,
      dataQualityDelta: 0,
      verifiedRecursiveCapabilityBonus: 0,
    },
    economics: {
      setupCost: cash,
      dataCost: 0,
      trainingCostAccrued: 0,
    },
    benchmarkSnapshots: [],
    trainingFormulaVersion: 2,
    trainingNumerics: DEFAULT_TRAINING_NUMERICS,
    computePriority: 50,
    reservedPf: 0,
    paused: false,
    preemptible: true,
    lossHistory: [],
  };
}

export function setEffortHeadComputeShare(
  state: SimState,
  id: string,
  recipeId: string,
  share: number,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === id);
  const model = state.player.models.find((candidate) => candidate.id === id);
  if (!job && !model) return withAlert(state, "warn", "Model not found.");
  if (
    recipeId !== INSTANT_EFFORT_ID &&
    !effortReasoningUnlocked(state.player.researchUnlocked)
  ) {
    return withAlert(
      state,
      "warn",
      "Process Reward research is required to train extra effort heads.",
    );
  }
  const paramsB = job?.targetParamsB ?? model?.paramsB ?? 1;
  const gymQuality = gymQualityByKind(state.player.postTrainGyms, "math");
  const nextShare = clampEffortTrainShare(share);
  return patchProductProfile(state, id, (profile) => {
    const recipes = migrateEffortRecipes(profile);
    const recipe = recipes.find((item) => item.id === recipeId);
    if (!recipe) return profile;
    const required = effortTrainTargetPfDays({
      paramsB,
      thinkingTokenMult:
        recipe.kind === "instant" ? 1 : recipe.thinkingTokenMult,
      gymQuality,
      researchUnlocked: state.player.researchUnlocked,
    });
    return withEffortRecipePatch(profile, recipeId, {
      trainComputeShare: nextShare,
      targetPfDays:
        nextShare > 0
          ? Math.max(recipe.targetPfDays ?? 0, required)
          : recipe.targetPfDays ?? 0,
    });
  });
}

export function setEffortHeadCapabilityBias(
  state: SimState,
  id: string,
  recipeId: string,
  bias: number,
): SimState {
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === id);
  const model = state.player.models.find((candidate) => candidate.id === id);
  if (!job && !model) return withAlert(state, "warn", "Model not found.");
  if (
    recipeId !== INSTANT_EFFORT_ID &&
    !effortReasoningUnlocked(state.player.researchUnlocked)
  ) {
    return withAlert(
      state,
      "warn",
      "Process Reward research is required to train extra effort heads.",
    );
  }
  return patchProductProfile(state, id, (profile) =>
    withEffortRecipePatch(profile, recipeId, {
      capabilityBias: clampCapabilityBias(bias),
    }),
  );
}

export function startEffortTraining(
  state: SimState,
  request: StartEffortTrainingRequest,
): SimState {
  const continueId = request.recipeId?.trim();
  const continuingInstant = continueId === INSTANT_EFFORT_ID;
  if (
    !continuingInstant &&
    !effortReasoningUnlocked(state.player.researchUnlocked)
  ) {
    return withAlert(
      state,
      "warn",
      "Process Reward research is required to train extra effort heads.",
    );
  }
  const jobs = playerTrainingJobs(state);
  const job = jobs.find((candidate) => candidate.id === request.id);
  const model = state.player.models.find((candidate) => candidate.id === request.id);
  if (
    model &&
    jobs.some((candidate) => candidate.effortOnlySourceModelId === model.id)
  ) {
    return withAlert(
      state,
      "warn",
      `${model.name} already has an effort head in the Training queue.`,
    );
  }
  const effortSubject = job ?? model;
  if (effortSubject && !modelSupportsEffortHeads(effortSubject)) {
    return withAlert(
      state,
      "warn",
      "This model has no generated-text reasoning path to train.",
    );
  }
  const paramsB = job?.targetParamsB ?? model?.paramsB ?? 1;
  const profile = job
    ? productProfileForJob(state, job)
    : model
      ? productProfileFromModel(
          model,
          state.player.postTrainGyms,
          state.player.researchUnlocked,
        )
      : null;
  if (!profile) return withAlert(state, "warn", "Model not found.");
  const recipes = migrateEffortRecipes(profile);
  const existing = continueId
    ? recipes.find((recipe) => recipe.id === continueId)
    : undefined;
  if (continueId && !existing) {
    return withAlert(state, "warn", "Effort head not found.");
  }
  const name = (request.name ?? existing?.name ?? "").trim().slice(0, 24);
  if (!name) return withAlert(state, "warn", "Name the effort head.");
  if (
    !existing &&
    recipes.filter((recipe) => recipe.kind === "trained").length >=
      MAX_TRAINED_EFFORTS
  ) {
    return withAlert(state, "warn", "At most three trained effort heads.");
  }
  const thinkingTokenMult =
    existing?.kind === "instant"
      ? 1
      : clampThinkingTokenMult(
          request.thinkingTokenMult ?? existing?.thinkingTokenMult ?? 2.2,
        );
  const capabilityBias = clampCapabilityBias(
    request.capabilityBias ?? existing?.capabilityBias,
  );
  const gymQuality = gymQualityByKind(state.player.postTrainGyms, "math");
  const required = effortTrainTargetPfDays({
    paramsB,
    thinkingTokenMult,
    gymQuality,
    researchUnlocked: state.player.researchUnlocked,
  });
  const funded = Math.max(1, request.trainPfDays ?? required);
  const cash = effortCashCost(Math.min(funded, required * 1.4), paramsB);
  if (state.player.cash + 1e-9 < cash) {
    return withAlert(
      state,
      "warn",
      `Need $${cash.toLocaleString("en-US")} to train ${name}.`,
    );
  }
  const liveOnJob = Boolean(job);
  const priorShare = existing?.trainComputeShare ?? 0;
  const share = clampEffortTrainShare(
    request.trainComputeShare != null
      ? request.trainComputeShare
      : priorShare > 0
        ? priorShare
        : DEFAULT_EFFORT_HEAD_SHARE,
  );
  const charged = chargeExpense(state, cash, "training");
  if (existing) {
    const nextTarget = liveOnJob
      ? (existing.targetPfDays ?? 0) + funded
      : (existing.progressPfDays ?? 0) + funded;
    const nextTrainPf = existing.trainPfDays;
    const nextProgress = existing.progressPfDays ?? 0;
    const nextRecipe = normalizeEffortRecipe({
      ...existing,
      name,
      thinkingTokenMult,
      capabilityBias,
      trainComputeShare: liveOnJob
        ? Math.max(share, existing.trainComputeShare ?? 0)
        : EFFORT_HEAD_SHARE_MAX,
      trainCash: existing.trainCash + cash,
      targetPfDays: nextTarget,
      trainPfDays: nextTrainPf,
      progressPfDays: nextProgress,
      quality:
        existing.kind === "instant"
          ? existing.quality
          : existing.quality,
      trained: existing.kind === "instant" ? true : existing.trained,
      served: existing.served,
      outcomeSeed:
        existing.outcomeSeed ??
        hashSeed(
          job?.outcomeSeed ?? state.seed,
          request.id,
          existing.id,
          "effort-head-outcome-v1",
        ),
    });
    const updateProfile = (current: ModelProductProfile) => {
      // Preserve every other head (Think / Deep / custom) untouched.
      const nextRecipes = migrateEffortRecipes(current).map((recipe) =>
        recipe.id === existing.id ? nextRecipe : recipe,
      );
      return {
        ...current,
        effortRecipes: nextRecipes,
        defaultEffortId:
          nextRecipe.trained && nextRecipe.kind !== "instant"
            ? nextRecipe.id
            : current.defaultEffortId,
      };
    };
    if (job) return patchProductProfile(charged, request.id, updateProfile);
    const nextProfile = updateProfile(profile);
    const queued = standaloneEffortTrainingJob({
      state: charged,
      model: model!,
      profile: nextProfile,
      recipe: nextRecipe,
      cash,
    });
    return withTrainingJobs(
      {
        ...charged,
        player: {
          ...charged.player,
          models: charged.player.models.map((candidate) =>
            candidate.id === model!.id
              ? { ...candidate, productProfile: nextProfile }
              : candidate,
          ),
        },
      },
      [...jobs, queued],
    );
  }
  const recipeId = seededId(
    "effort",
    state.seed,
    request.id,
    name,
    String(thinkingTokenMult),
  );
  const nextRecipe = normalizeEffortRecipe({
    id: recipeId,
    name,
    kind: "trained",
    thinkingTokenMult,
    capabilityBias,
    trainComputeShare: liveOnJob ? share : EFFORT_HEAD_SHARE_MAX,
    trainPfDays: 0,
    trainCash: cash,
    trained: false,
    quality: 0,
    served: false,
    progressPfDays: 0,
    targetPfDays: funded,
    outcomeSeed: hashSeed(
      job?.outcomeSeed ?? state.seed,
      request.id,
      recipeId,
      "effort-head-outcome-v1",
    ),
  });
  const updateProfile = (current: ModelProductProfile): ModelProductProfile => ({
    ...current,
    effortRecipes: [...migrateEffortRecipes(current), nextRecipe],
  });
  if (job) return patchProductProfile(charged, request.id, updateProfile);
  const nextProfile = updateProfile(profile);
  const queued = standaloneEffortTrainingJob({
    state: charged,
    model: model!,
    profile: nextProfile,
    recipe: nextRecipe,
    cash,
  });
  return withTrainingJobs(
    {
      ...charged,
      player: {
        ...charged.player,
        models: charged.player.models.map((candidate) =>
          candidate.id === model!.id
            ? { ...candidate, productProfile: nextProfile }
            : candidate,
        ),
      },
    },
    [...jobs, queued],
  );
}

export function listReleasedModel(
  state: SimState,
  request: {
    modelId: string;
    sell: boolean;
    apiIn?: number | null;
    apiOut?: number | null;
    planIds?: readonly string[];
  },
): SimState {
  const model = state.player.models.find(
    (candidate) => candidate.id === request.modelId,
  );
  if (!model || (model.release !== "released" && !model.shipped)) {
    return withAlert(state, "warn", "Release the model before listing it.");
  }
  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      models: state.player.models.map((candidate) =>
        candidate.id === request.modelId
          ? { ...candidate, commerciallyOffered: request.sell }
          : candidate,
      ),
    },
  };
  if (!request.sell) {
    return setModelApiInOut(next, request.modelId, null, null);
  }
  const listApi = request.apiIn != null || request.apiOut != null;
  next = listApi
    ? setModelApiInOut(
        next,
        request.modelId,
        request.apiIn ?? null,
        request.apiOut ?? null,
      )
    : setModelApiInOut(next, request.modelId, null, null);
  if (listApi) {
    const apiIds = next.player.pricing.apiModelIds ?? [];
    if (!apiIds.includes(request.modelId)) {
      next = {
        ...next,
        player: {
          ...next.player,
          pricing: {
            ...next.player.pricing,
            apiModelIds: [...apiIds, request.modelId],
            activeModelId: next.player.pricing.activeModelId ?? request.modelId,
          },
        },
      };
    }
  }
  for (const planId of request.planIds ?? []) {
    const plan = next.player.pricing.plans.find((item) => item.id === planId);
    if (!plan || plan.modelIds.includes(request.modelId)) continue;
    next = updatePlan(next, planId, {
      modelIds: [...plan.modelIds, request.modelId],
    });
  }
  return next;
}

function patchProductProfile(
  state: SimState,
  id: string,
  patch: (profile: ModelProductProfile) => ModelProductProfile,
): SimState {
  const jobs = playerTrainingJobs(state).map((job) => {
    if (job.id !== id) return job;
    return { ...job, productProfile: patch(productProfileForJob(state, job)) };
  });

  const models = state.player.models.map((model) => {
    if (model.id !== id) return model;
    const profile = productProfileFromModel(
      model,
      state.player.postTrainGyms,
      state.player.researchUnlocked,
    );
    return { ...model, productProfile: patch(profile) };
  });

  const withJobs = withTrainingJobs(state, jobs);
  return {
    ...withJobs,
    player: {
      ...withJobs.player,
      models,
    },
  };
}

export function setModelApiPrice(
  state: SimState,
  modelId: string,
  price: number | null,
): SimState {
  // Blended single price → split into in/out using same mix as global defaults
  const snap = computeSnapshot(state);
  const models = state.player.models.map((m) => {
    if (m.id !== modelId) return m;
    const hosting = apiHostingCostFloor(state, snap, m);
    if (price === null) {
      return {
        ...m,
        apiPricePerMTok: null,
        apiPriceInPerMTok: null,
        apiPriceOutPerMTok: null,
        costApiPriceIn: hosting.costIn,
        costApiPriceOut: hosting.costOut,
      };
    }
    const split = splitBlendedApiPrice(Math.max(0, price));
    const listed = clampApiListToHostingFloor(
      split.priceIn,
      split.priceOut,
      hosting,
    );
    return {
      ...m,
      apiPriceInPerMTok: listed.priceIn,
      apiPriceOutPerMTok: listed.priceOut,
      apiPricePerMTok: blendApiPrice(listed.priceIn, listed.priceOut),
      costApiPriceIn: hosting.costIn,
      costApiPriceOut: hosting.costOut,
    };
  });
  return { ...state, player: { ...state.player, models } };
}

export function setModelApiInOut(
  state: SimState,
  modelId: string,
  priceIn: number | null,
  priceOut: number | null,
): SimState {
  const snap = computeSnapshot(state);
  const models = state.player.models.map((m) => {
    if (m.id !== modelId) return m;
    const hosting = apiHostingCostFloor(state, snap, m);
    if (priceIn === null && priceOut === null) {
      return {
        ...m,
        apiPriceInPerMTok: null,
        apiPriceOutPerMTok: null,
        apiPricePerMTok: null,
        costApiPriceIn: hosting.costIn,
        costApiPriceOut: hosting.costOut,
      };
    }
    const listed = clampApiListToHostingFloor(
      priceIn ?? m.apiPriceInPerMTok ?? hosting.costIn,
      priceOut ?? m.apiPriceOutPerMTok ?? hosting.costOut,
      hosting,
    );
    return {
      ...m,
      apiPriceInPerMTok: listed.priceIn,
      apiPriceOutPerMTok: listed.priceOut,
      apiPricePerMTok: blendApiPrice(listed.priceIn, listed.priceOut),
      costApiPriceIn: hosting.costIn,
      costApiPriceOut: hosting.costOut,
    };
  });
  return { ...state, player: { ...state.player, models } };
}

/** Apply markup % to current canonical unit cost → list prices. */
export function applyModelApiMarkup(
  state: SimState,
  modelId: string,
  markupPct: number,
): SimState {
  const m = state.player.models.find((x) => x.id === modelId);
  if (!m) return state;
  const snap = computeSnapshot(state);
  const hosting = apiHostingCostFloor(state, snap, m);
  const listCostBasis = boundedApiListCostPerMTok(m, hosting.blended);
  const sug = suggestApiInOut({
    costPerMTokBase: listCostBasis,
    paramsB: m.paramsB,
    activeParamsB: m.activeParamsB,
    family: m.family,
    inferCostMult: m.inferCostMult,
    capability: m.capability,
    markupPct,
  });
  const listed = clampApiListToHostingFloor(sug.priceIn, sug.priceOut, hosting);
  const models = state.player.models.map((model) =>
    model.id === modelId
      ? {
          ...model,
          costApiPriceIn: hosting.costIn,
          costApiPriceOut: hosting.costOut,
          suggestedApiPriceIn: listed.priceIn,
          suggestedApiPriceOut: listed.priceOut,
          suggestedApiPrice: blendApiPrice(listed.priceIn, listed.priceOut),
        }
      : model,
  );
  return setModelApiInOut(
    { ...state, player: { ...state.player, models } },
    modelId,
    listed.priceIn,
    listed.priceOut,
  );
}

function buildModelFromJob(
  state: SimState,
  job: TrainingJob,
  release: "internal" | "released",
  list = release === "released",
): Model {
  const modelResearchUnlocked = frozenResearchIds(job);
  const effects = aggregateEffects(modelResearchUnlocked);
  const family = job.family;
  const backbone = job.backbone ?? backboneFromFamily(family);
  const stackModifiers = modelStackModifiers(job.modelStack ?? [], family);
  const precision = trainingNumericsEconomicsProfile(
    job.trainingNumerics ?? job.numerics ?? DEFAULT_TRAINING_NUMERICS,
  );
  const paramsB = job.targetParamsB;
  const activeParamsB =
    backbone === "moe" ? (job.activeParamsB ?? paramsB * 0.1) : undefined;
  const teacher = job.teacherId
    ? state.player.models.find((m) => m.id === job.teacherId)
    : undefined;
  // Private candidates are resolvable only by an explicit branch reference;
  // they never enter ordinary fleet, teacher, serving, or revenue selectors.
  const privateContinueBase = job.parentCheckpointId
    ? (state.player.trainingCheckpoints ?? []).find(
        (candidate) =>
          candidate.id === job.parentCheckpointId &&
          candidate.model.id === job.continueFromId,
      )?.model
    : undefined;
  const continueBase =
    privateContinueBase ??
    (job.continueFromId
      ? state.player.models.find((model) => model.id === job.continueFromId)
      : undefined);
  const verifiedRecursiveCapabilityBonus =
    boundedVerifiedRecursiveCapabilityBonus(
      family,
      job.campaignModifiers?.verifiedRecursiveCapabilityBonus ??
        continueBase?.verifiedRecursiveCapabilityBonus,
    );
  const modelContext =
    continueBase &&
    !state.player.models.some((model) => model.id === continueBase.id)
      ? [...state.player.models, continueBase]
      : state.player.models;
  const postProfile = postTrainEffectProfile(
    job,
    state.player.researchUnlocked,
    modelContext,
    state.player.postTrainGyms,
    state.player.toolSkills,
  );
  const investmentMaturity = fundedTrainingMaturity(job);
  const completedPostStages = completedPostTrainStages(job);
  const resolvedStageEffectiveness = resolvedPostTrainStageEffectiveness(
    job,
    state.player.researchUnlocked,
    modelContext,
    state.player.postTrainGyms,
    state.player.toolSkills,
  );
  const hasCompletedPostStage = (stage: Exclude<PostTrainStage, "none">) =>
    completedPostStages.includes(stage) &&
    postProfile.stageEffectiveness[stage] > 0;
  const effectivePostTrainStage: PostTrainStage = hasCompletedPostStage("tools")
    ? "tools"
    : hasCompletedPostStage("process")
      ? "process"
      : hasCompletedPostStage("rlhf")
        ? "rlhf"
        : hasCompletedPostStage("sft")
          ? "sft"
          : "none";
  const reasoningTrained =
    stackModifiers.reasoningEnabled ||
    hasCompletedPostStage("process") ||
    hasCompletedPostStage("tools");
  const legacyMix = DATA_MIX_DEFS[job.dataMix ?? "web"];
  // Domain recipe effects
  const weights = job.dataPlan?.weights ?? {};
  let domainCap = 0;
  let domainCoding = 0;
  let domainMath = 0;
  let domainScience = 0;
  let domainChat = 0;
  let domainSafety = 0;
  let domainLaw = 0;
  let domainHealth = 0;
  let domainVision = 0;
  let domainVideo = 0;
  let domainAudio = 0;
  for (const d of DATA_DOMAINS) {
    const w = weights[d] ?? 0;
    if (w <= 0) continue;
    const m = DATA_DOMAIN_META[d];
    domainCap += m.capability * w;
    domainCoding += m.coding * w;
    domainMath += m.math * w;
    domainScience += m.science * w;
    domainChat += m.chat * w;
    domainSafety += m.safety * w;
    domainLaw += m.law * w;
    domainHealth += m.health * w;
    domainVision += m.vision * w;
    domainVideo += m.video * w;
    domainAudio += m.audio * w;
  }
  const coverage = job.effectiveDataRatio ?? job.dataCoverage ?? 1;
  const dataQ = (job.dataQualityUsed ?? 50) / 100;
  const mix = {
    capability: domainCap + legacyMix.capability * 0.15,
    coding: domainCoding + legacyMix.coding * 0.2,
    chat: domainChat + legacyMix.chat * 0.2,
    safety: domainSafety + legacyMix.safety * 0.2,
    math: domainMath + legacyMix.math * 0.15,
    science: domainScience,
  };

  // ── Shared scale formula: params × data volume × quality × mix ──
  const dataQualityNorm = normalizeDataQuality({
    labDataQuality: state.player.dataQuality,
    jobQualityUsed:
      (job.dataQualityUsed ?? 50) +
      (job.campaignModifiers?.dataQualityDelta ?? 0),
  });
  const researchMult =
    1 +
    Math.min(0.12, (effects.capabilityBonus ?? 0) * 0.015) +
    ((family === "moe" || job.backbone === "moe") &&
    modelResearchUnlocked.includes("moe_hier")
      ? 0.04
      : 0);
  // √ progress so mid-run launches inherit a soft scale ceiling before the
  // explicit earlyReleasePenalty haircut compounds capability/benchmarks.
  const trainComplete = Math.sqrt(
    Math.min(
      1,
      job.progressPfDays /
        Math.max(1e-9, job.recommendedPfDays ?? job.targetPfDays),
    ),
  );

  const overtrainCapBonus = effects.overtrainCapBonus ?? 0;
  let scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    backbone,
    dataCoverage: coverage,
    dataQuality: dataQualityNorm,
    mixWeights: weights,
    researchMult:
      (family === "moe" || job.backbone === "moe") &&
      !modelResearchUnlocked.includes("moe_routing")
        ? researchMult * 0.55
        : researchMult,
    trainComplete,
    postTrainStrength: postProfile.scaleStrength,
    reasoningEnabled: reasoningTrained,
    overtrainCapBonus,
    verifiedRecursiveCapabilityBonus,
    teacherCapability: job.mode === "distill" ? teacher?.capability : undefined,
    teacherParamsB: job.mode === "distill" ? teacher?.paramsB : undefined,
  });

  let capability = scale.capability + mix.capability * 0.35;

  // Continue-train: modest lift from prior, still gated by size×data scale
  if (job.mode === "continue" && continueBase) {
    const lift =
      1.2 +
      trainComplete * 2.5 +
      mix.capability * 0.35 +
      (coverage - 0.5) * 1.5;
    const maxLift = Math.max(2, scale.capability * 0.12);
    capability = clamp(
      Math.min(
        scale.capability + 2,
        continueBase.capability + Math.min(maxLift, lift),
      ),
    );
  }

  const postIdx = postProfile.alignmentEquivalent;
  const rlhfMult = 1 + (effects.rlhfQuality ?? 0);
  const safetyBase =
    14 +
    scale.intelligence * 35 +
    (effects.safetyBonus ?? 0) * 2 +
    postIdx * 6 * rlhfMult +
    mix.safety;
  const reliabilityBase =
    18 +
    scale.intelligence * 40 +
    postIdx * 9 * rlhfMult +
    (effects.safetyBonus ?? 0);
  let chat = Math.min(100, capability * 0.88 + postIdx * 4 + mix.chat);
  let coding = Math.min(
    100,
    capability * 0.9 +
      (modelResearchUnlocked.includes("moe_special") ? 4 : 0) +
      mix.coding * 0.7,
  );
  let reasoning = Math.min(
    100,
    capability * 0.95 +
      (reasoningTrained
        ? 4 * Math.min(1, postProfile.alignmentEquivalent)
        : 0) +
      mix.math * 0.34 +
      mix.science * 0.18,
  );

  const quality: QualityAxes = {
    reasoning: clamp(reasoning),
    coding: clamp(coding),
    chat: clamp(chat),
    image: clamp(
      (family === "diffusion" || family === "omni" ? capability * 0.75 : 5) +
        domainVision * 0.5,
    ),
    video: clamp(
      (family === "video" || family === "omni"
        ? capability * 0.65
        : domainVideo * 0.35) +
        domainVideo * 0.4,
    ),
    safety: clamp(safetyBase + domainLaw * 0.12 + domainHealth * 0.1),
    reliability: clamp(reliabilityBase + dataQ * 6),
  };

  if (job.mode === "continue" && continueBase) {
    quality.reasoning = clamp(
      continueBase.quality.reasoning + mix.math * 0.35 + 1.5,
    );
    quality.coding = clamp(continueBase.quality.coding + mix.coding * 0.4 + 1);
    quality.chat = clamp(continueBase.quality.chat + mix.chat * 0.35 + 0.8);
    quality.safety = clamp(continueBase.quality.safety + mix.safety * 0.25);
    quality.reliability = clamp(continueBase.quality.reliability + 1.5);
    quality.image = continueBase.quality.image;
    quality.video = continueBase.quality.video;
  }

  if (job.mode !== "continue") {
    // Removing the raw-pretrain launch clamps is itself an earned benefit.
    // Scale the relief continuously from the exact zero-work baseline instead
    // of letting a stage label remove every clamp immediately.
    const postMaturity = Math.min(1, postProfile.alignmentEquivalent);
    quality.reliability = Math.min(
      quality.reliability,
      26 + (100 - 26) * postMaturity,
    );
    quality.safety = Math.min(quality.safety, 20 + (100 - 20) * postMaturity);
    quality.chat = quality.chat * (0.75 + 0.25 * postMaturity);
  }

  // Distill path: blend your corpus (self scale) with teacher signal.
  // Teacher transfer follows the size-gap retention curve (distillRetentionFor):
  // 1T → 1B keeps ~30–40% of teacher capability, modulated by data and RNG.
  const distillTeacherShare =
    job.mode === "distill"
      ? clampDistillTeacherShare(job.distillTeacherShare)
      : 0;
  const distillSelfShare = 1 - distillTeacherShare;
  const distillDataFactor = Math.max(
    0,
    Math.min(
      1,
      ((job.dataQualityUsed ?? 60) / 100) *
        (1 - (job.synthLqShare ?? 0) * 0.5),
    ),
  );
  const distillRng01 =
    job.mode === "distill" && teacher
      ? createRng(
          hashSeed(
            job.outcomeSeed ?? 0,
            job.id,
            teacher.id,
            "distill-retention-v2",
          ),
        ).next()
      : 0.5;
  let distillRetention = DISTILL_RETENTION;
  if (job.mode === "distill" && teacher) {
    // Self branch: size × your processed data only.
    const selfCap = scale.capability + mix.capability * 0.35;
    const transfer = blendDistilledCapability({
      studentCapability: selfCap,
      studentScaleCap: Math.max(
        scale.capability,
        teacher.capability * 0.75,
      ),
      studentParamsB: paramsB,
      teacherCapability: teacher.capability,
      teacherParamsB: teacher.paramsB,
      teacherShare: distillTeacherShare,
      dataFactor: distillDataFactor,
      rng01: distillRng01,
    });
    distillRetention = transfer.retention;
    capability = clamp(transfer.capability);
    quality.safety = clamp(
      teacher.quality.safety * 0.75 * distillTeacherShare +
        quality.safety * distillSelfShare +
        mix.safety * 0.12,
    );
    quality.reliability = clamp(
      teacher.quality.reliability * 0.75 * distillTeacherShare +
        quality.reliability * distillSelfShare,
    );
    quality.reasoning = clamp(
      capability * 0.95 * distillTeacherShare +
        quality.reasoning * distillSelfShare +
        mix.math * 0.15,
    );
    quality.coding = clamp(
      capability * 0.9 * distillTeacherShare +
        quality.coding * distillSelfShare +
        mix.coding * 0.25,
    );
    quality.chat = clamp(
      capability * 0.85 * distillTeacherShare +
        quality.chat * distillSelfShare +
        mix.chat * 0.2,
    );
  }

  let inferCostMult = 1;
  let tokPerSecMult = 0.7;
  const sparseBackbone = backbone === "moe";
  if (sparseBackbone) {
    inferCostMult = (effects.moeInferMult as number | undefined) ?? 1.1;
    // active size drives serve cost
    const active = activeParamsB ?? paramsB * 0.1;
    inferCostMult *= Math.pow(active / Math.max(paramsB * 0.08, 0.1), 0.3);
    tokPerSecMult =
      (family === "omni" ? 0.35 : 0.85) *
      Math.pow(7 / Math.max(active, 0.5), 0.15);
    if (!modelResearchUnlocked.includes("moe_serve")) {
      tokPerSecMult *= 0.55;
    }
  } else if (family === "dense") {
    inferCostMult = (effects.denseInferMult as number | undefined) ?? 1;
    tokPerSecMult = 0.75 * Math.pow(7 / Math.max(paramsB, 0.5), 0.12);
  } else if (family === "video") {
    inferCostMult = 2.5;
    tokPerSecMult = 0.25;
  } else if (family === "diffusion") {
    inferCostMult = 1.4;
    tokPerSecMult = 0.4;
  } else if (family === "omni") {
    inferCostMult = 1;
    tokPerSecMult = 0.35;
  }

  // Large dense models slower / costlier to serve
  if (!sparseBackbone && paramsB > 70) {
    inferCostMult *= 1 + Math.log10(paramsB / 70) * 0.35;
    tokPerSecMult *= 1 / (1 + Math.log10(paramsB / 70) * 0.4);
  }
  inferCostMult *= stackModifiers.hostingMult;
  tokPerSecMult *= stackModifiers.speedMult;

  const baseJobIo =
    job.io ?? ioForPreset(job.productPreset ?? presetFromFamily(family));
  const jobIo = postProfile.toolsEnabled
    ? { ...baseJobIo, tools: Math.max(1, baseJobIo.tools) }
    : baseJobIo;
  const modalities: Model["modalities"] = [];
  for (const modality of ["text", "image", "audio", "video"] as const) {
    if (
      (jobIo.inputs[modality] ?? 0) > 0 ||
      (jobIo.outputs[modality] ?? 0) > 0
    ) {
      modalities.push(modality);
    }
  }
  if (jobIo.tools > 0) modalities.push("tools");
  if (modalities.length === 0) modalities.push("text");

  // Per-lab modality experience: first-generation audio/image/video models
  // reach only a fraction of their theoretical modality ceiling.
  const modalityExperience = modalityExperienceCounts(state.player.models);
  const maturity: Partial<Record<GenerativeModality, number>> = {};
  for (const modality of ["image", "audio", "video"] as const) {
    if (modalities.includes(modality)) {
      maturity[modality] = modalityMaturity(modalityExperience[modality]);
    }
  }
  if (maturity.image != null)
    quality.image = clamp(quality.image * maturity.image);
  if (maturity.video != null)
    quality.video = clamp(quality.video * maturity.video);

  // Research extras (small — cannot max small models)
  const extras: Partial<BenchmarkScores> = {};
  for (const id of modelResearchUnlocked) {
    const b = getResearchNode(id).effects.benchmarkBoost;
    if (!b) continue;
    for (const [k, v] of Object.entries(b) as [
      keyof BenchmarkScores,
      number,
    ][]) {
      extras[k] = (extras[k] ?? 0) + Math.min(4, v * 0.45);
    }
  }
  // Domain mix extras (specialty, not free general scale)
  extras.coding =
    (extras.coding ?? 0) + Math.min(5, domainCoding * 0.35 + mix.coding * 0.25);
  extras.math =
    (extras.math ?? 0) + Math.min(6, domainMath * 0.42 + mix.math * 0.18);
  extras.science =
    (extras.science ?? 0) +
    Math.min(6, domainScience * 0.42 + domainMath * 0.08);
  extras.mmlu =
    (extras.mmlu ?? 0) + Math.min(3, mix.capability * 0.2 + domainChat * 0.08);
  extras.safety = (extras.safety ?? 0) + Math.min(4, mix.safety * 0.25);
  extras.law = (extras.law ?? 0) + Math.min(6, domainLaw * 0.4);
  extras.health = (extras.health ?? 0) + Math.min(6, domainHealth * 0.4);
  extras.vision = (extras.vision ?? 0) + Math.min(6, domainVision * 0.4);
  extras.agents =
    (extras.agents ?? 0) + Math.min(4, domainCoding * 0.12 + domainChat * 0.1);

  // Specialist curators: extra domain eval lift (research-gated)
  const spec = job.dataPlan?.domainModels;
  if (spec && state.player.researchUnlocked.includes("data_specialists")) {
    for (const d of DATA_DOMAINS) {
      const mid = spec[d];
      if (!mid) continue;
      const m = state.player.models.find((x) => x.id === mid);
      if (!m || !modelCanCurateDataDomain(m, d)) continue;
      const boost = specialistDomainBoost(m, d) / 22; // 0–1
      if (d === "code") {
        extras.coding = (extras.coding ?? 0) + Math.min(4, boost * 5);
        extras.agents = (extras.agents ?? 0) + Math.min(2, boost * 2);
      }
      if (d === "math")
        extras.math = (extras.math ?? 0) + Math.min(5, boost * 6);
      if (d === "science")
        extras.science = (extras.science ?? 0) + Math.min(5, boost * 6);
      if (d === "law") extras.law = (extras.law ?? 0) + Math.min(5, boost * 6);
      if (d === "health")
        extras.health = (extras.health ?? 0) + Math.min(5, boost * 6);
      if (d === "chat")
        extras.mmlu = (extras.mmlu ?? 0) + Math.min(2.5, boost * 3);
      if (d === "image" || d === "video")
        extras.vision = (extras.vision ?? 0) + Math.min(4, boost * 5);
    }
  }

  const gymExtras = trainingGymDomainExtras(
    state.player.postTrainGyms,
    job.attachedGymKinds,
  );
  for (const [key, value] of Object.entries(gymExtras) as [
    keyof BenchmarkScores,
    number,
  ][]) {
    extras[key] = (extras[key] ?? 0) + value;
  }

  // Recompute scale at final capability-influencing state for benches
  scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    backbone,
    dataCoverage: coverage,
    dataQuality: dataQualityNorm,
    mixWeights: weights,
    researchMult:
      (family === "moe" || job.backbone === "moe") &&
      !modelResearchUnlocked.includes("moe_routing")
        ? researchMult * 0.55
        : researchMult,
    trainComplete,
    postTrainStrength: postProfile.scaleStrength,
    reasoningEnabled: reasoningTrained,
    overtrainCapBonus,
    verifiedRecursiveCapabilityBonus,
    teacherCapability: job.mode === "distill" ? teacher?.capability : undefined,
    teacherParamsB: job.mode === "distill" ? teacher?.paramsB : undefined,
  });

  let benchmarks = scoresFromScale({
    scale,
    quality,
    family,
    unlocked: state.player.researchUnlocked,
    postTrain: effectivePostTrainStage,
    extras,
    reasoningEnabled: reasoningTrained,
    toolsEnabled: postProfile.toolsEnabled || jobIo.tools > 0,
    imageDataQualityFactor:
      (job.dataQualityByDomain?.image ?? job.dataQualityUsed ?? 50) / 100,
    healthLowQualityShare:
      job.lowQualityShareByDomain?.health ?? job.synthLqShare ?? 0,
    scienceDataQuality: job.dataQualityByDomain?.science ?? job.dataQualityUsed,
    chatDataQuality: job.dataQualityByDomain?.chat ?? job.dataQualityUsed,
  });

  // Keep capability consistent with scale (domain mix only mild nudge)
  if (job.mode !== "distill" && job.mode !== "continue") {
    capability = clamp(scale.capability + mix.capability * 0.35);
  }

  // Low-quality synthetic pollution — same rule as rivals (shared scale path)
  const lqShare = job.synthLqShare ?? 0;
  if (lqShare > 0.02) {
    const mult = lqSynthCapabilityMult(lqShare);
    capability = clamp(capability * mult);
    quality.reliability = clamp(quality.reliability * (1 - lqShare * 0.25));
    quality.safety = clamp(quality.safety * (1 - lqShare * 0.2));
    for (const k of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [k]: clamp(benchmarks[k]! * (1 - lqShare * 0.15)),
      };
    }
  }

  if (stackModifiers.capabilityBonus > 0) {
    const bonus = stackModifiers.capabilityBonus;
    capability = clamp(capability + bonus);
    quality.reasoning = clamp(quality.reasoning + bonus * 0.9);
    quality.coding = clamp(quality.coding + bonus * 0.8);
    quality.chat = clamp(quality.chat + bonus * 0.5);
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: clamp(benchmarks[key]! + bonus * 0.55),
      };
    }
  }

  const recipeSignals = recipeOutcomeSignals({
    totalMTok:
      Math.max(0, job.trainMTok ?? 0) +
      Math.max(0, job.verifyMTok ?? 0) +
      Math.max(0, job.dataPlan?.postTrainMTok ?? 0),
    paramsB,
    family,
    backbone,
    activeParamsB,
    postTrainShare:
      job.dataPlan?.postTrainShare ?? DEFAULT_RECIPE_ALIGN_SHARE,
    trainShare: job.trainShare ?? 0.82,
  });
  const recipeApplied = applyRecipeOutcome({
    capability,
    quality,
    signals: recipeSignals,
    continueMode: job.mode === "continue",
  });
  capability = recipeApplied.capability;
  Object.assign(quality, recipeApplied.quality);

  if (job.mode === "distill" && teacher) {
    const d = distillFromTeacher({
      teacherCapability: teacher.capability,
      teacherBenchmarks: teacher.benchmarks,
      studentScaleCap: Math.max(scale.capability, teacher.capability * 0.75),
      targetRetention: distillRetention,
    });
    const tShare = distillTeacherShare;
    const sShare = distillSelfShare;
    const benchTransfer = Math.min(0.88, distillRetention + 0.1);
    for (const k of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      const fromTeacher = d.benchmarks[k];
      const fromSelf = benchmarks[k];
      const teacherV =
        fromTeacher != null
          ? Math.min(
              (teacher.benchmarks[k] ?? fromTeacher) * benchTransfer,
              fromTeacher,
            )
          : fromSelf;
      // Blend: teacher-heavy → near 80% teacher benches; corpus-heavy → your scale benches
      benchmarks = {
        ...benchmarks,
        [k]: clamp(fromSelf * sShare + teacherV * tShare),
      };
    }
  }

  const outcome = rollTrainingOutcome({
    seed: job.outcomeSeed ?? hashSeed(state.seed, job.id, "train-outcome"),
    quality:
      (job.dataQualityUsed ?? 50) +
      (job.campaignModifiers?.dataQualityDelta ?? 0),
    verifyShare: 1 - (job.trainShare ?? 0.82),
    engineers: state.player.staff?.engineer ?? 0,
    researchCount: frozenResearchIds(job).length,
    day: state.day,
    breakthroughBias:
      (effects.trainingBreakthroughBias ?? 0) +
      (job.campaignModifiers?.breakthroughBias ?? 0),
    stumbleRisk:
      (effects.trainingStumbleRisk ?? 0) +
      (job.campaignModifiers?.stumbleRisk ?? 0) +
      Math.max(0, precision.lossVolatilityMultiplier - 1) * 0.08,
  });
  // Serious failures destroy most of the run, but the checkpoint still retains
  // a residual floor so the model remains a usable (bad) artifact.
  if (outcome.kind === "failure") {
    capability = Math.max(
      3,
      capability * Math.max(0.35, outcome.yieldMultiplier),
    );
  } else {
    capability = clamp(
      capability +
        outcome.capabilityDelta +
        (job.campaignModifiers?.capabilityDelta ?? 0),
    );
  }
  capability = Math.min(
    capability,
    bentCapabilityCeiling(scale.capabilityCeiling) *
      precision.qualityCeilingMultiplier,
  );
  quality.reliability = clamp(
    quality.reliability +
      outcome.reliabilityDelta +
      (job.campaignModifiers?.reliabilityDelta ?? 0),
  );
  quality.safety = clamp(
    quality.safety +
      Math.min(2, outcome.reliabilityDelta * 0.25) -
      (effects.trainingSafetyPenalty ?? 0) +
      (job.campaignModifiers?.safetyDelta ?? 0),
  );
  for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
    benchmarks = {
      ...benchmarks,
      [key]: clamp(
        benchmarks[key]! +
          outcome.capabilityDelta * 0.45 +
          (job.campaignModifiers?.capabilityDelta ?? 0) * 0.35,
      ),
    };
  }

  const syntheticTeacherWeights = new Map<string, number>();
  for (const item of job.syntheticProvenance ?? []) {
    if (!item.teacherModelId) continue;
    syntheticTeacherWeights.set(
      item.teacherModelId,
      (syntheticTeacherWeights.get(item.teacherModelId) ?? 0) + item.volumeMTok,
    );
  }
  const weightedTeacher = [...syntheticTeacherWeights.entries()].reduce(
    (acc, [modelId, volume]) => {
      const source = state.player.models.find((model) => model.id === modelId);
      return source
        ? {
            capability: acc.capability + source.capability * volume,
            reliability: acc.reliability + source.quality.reliability * volume,
            volume: acc.volume + volume,
          }
        : acc;
    },
    { capability: 0, reliability: 0, volume: 0 },
  );
  const syntheticTeacherCapability =
    weightedTeacher.volume > 0
      ? weightedTeacher.capability / weightedTeacher.volume
      : 0;
  const syntheticTeacherReliability =
    weightedTeacher.volume > 0
      ? weightedTeacher.reliability / weightedTeacher.volume
      : 0;
  const frontierCapability = Math.max(
    syntheticTeacherCapability,
    ...state.player.models
      .filter(isLivePublicModel)
      .map((model) => model.capability),
    ...state.rivals.flatMap((rival) =>
      rival.models.filter(isLivePublicModel).map((model) => model.capability),
    ),
  );
  const syntheticProfile = syntheticTrainingProfile({
    realMTok: Math.max(
      0,
      recipeSignals.totalMTok - (job.syntheticUnits ?? 0),
    ),
    syntheticMTok: job.syntheticUnits ?? 0,
    teacherCapability: syntheticTeacherCapability,
    frontierCapability,
    teacherReliability: syntheticTeacherReliability,
    dataQuality: job.dataQualityUsed ?? state.player.dataQuality,
    computePfDays: job.progressPfDays,
    seed: `${job.id}:${state.seed}`,
  });
  const effectiveSyntheticVolume =
    syntheticProfile.realMTok + syntheticProfile.effectiveSyntheticMTok;
  if (
    syntheticProfile.totalMTok > 0 &&
    effectiveSyntheticVolume + 1e-9 < syntheticProfile.totalMTok
  ) {
    const effectiveCoverage =
      coverage * (effectiveSyntheticVolume / syntheticProfile.totalMTok);
    const effectiveScale = scaleIntelligence({
      paramsB,
      activeParamsB,
      family,
      backbone,
      dataCoverage: effectiveCoverage,
      dataQuality: dataQualityNorm,
      mixWeights: weights,
      researchMult:
        (family === "moe" || job.backbone === "moe") &&
        !modelResearchUnlocked.includes("moe_routing")
          ? researchMult * 0.55
          : researchMult,
      trainComplete,
      postTrainStrength: postProfile.scaleStrength,
      reasoningEnabled: reasoningTrained,
      overtrainCapBonus,
      verifiedRecursiveCapabilityBonus,
      teacherCapability:
        job.mode === "distill" ? teacher?.capability : undefined,
      teacherParamsB: job.mode === "distill" ? teacher?.paramsB : undefined,
    });
    scale = effectiveScale;
    capability = Math.min(capability, effectiveScale.capability);
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: Math.min(benchmarks[key]!, effectiveScale.benchCeilings[key]),
      };
    }
  }
  if (syntheticTeacherCapability > 0 && syntheticProfile.syntheticShare > 0) {
    const effectiveSyntheticShare =
      syntheticProfile.effectiveSyntheticMTok /
      Math.max(
        1e-9,
        syntheticProfile.realMTok + syntheticProfile.effectiveSyntheticMTok,
      );
    const imitationTarget =
      syntheticTeacherCapability * syntheticProfile.imitationRetention;
    capability = clamp(
      capability +
        Math.max(0, imitationTarget - capability) * effectiveSyntheticShare,
    );
    const benchmarkLift =
      effectiveSyntheticShare * 3 + syntheticProfile.benchmarkOverfit * 6;
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: clamp(benchmarks[key]! + benchmarkLift),
      };
    }
    quality.reliability = clamp(
      quality.reliability - syntheticProfile.benchmarkOverfit * 18,
    );
    quality.chat = clamp(quality.chat - syntheticProfile.benchmarkOverfit * 10);
  }

  // Precision cannot invent parameter/data/architecture headroom. Apply this
  // after all stochastic and synthetic lifts so no later path bypasses it.
  capability = Math.min(
    capability,
    bentCapabilityCeiling(scale.capabilityCeiling) *
      precision.qualityCeilingMultiplier,
  );
  for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
    benchmarks = {
      ...benchmarks,
      [key]: Math.min(
        benchmarks[key]!,
        scale.benchCeilings[key] * precision.qualityCeilingMultiplier,
      ),
    };
  }

  // The generic scale ceiling above deliberately cannot price in product
  // integration. Restore a small, separately bounded agents lift from earned
  // tool-training evidence after that clamp. This is exactly zero for a merely
  // selected stage and grows continuously with the frozen stage result.
  const earnedToolsBenchmarkLift = postProfile.stageEffectiveness.tools * 5;
  if (earnedToolsBenchmarkLift > 0) {
    benchmarks.agents = Math.min(
      100,
      scale.benchCeilings.agents * precision.qualityCeilingMultiplier + 5,
      benchmarks.agents + earnedToolsBenchmarkLift,
    );
  }

  // Deliberately funding compute past the original recommendation earns a
  // visible but asymptotic optimization gain inside the same hard architecture
  // wall. Only distillation or verified omni recursion can move that wall.
  if (investmentMaturity.extraSignal > 0) {
    const matureCapabilityCeiling =
      bentCapabilityCeiling(scale.capabilityCeiling) *
      precision.qualityCeilingMultiplier;
    capability = Math.min(
      matureCapabilityCeiling,
      clamp(capability + investmentMaturity.capabilityGain),
    );
    quality.reliability = clamp(
      quality.reliability + investmentMaturity.reliabilityGain,
    );
    quality.reasoning = clamp(
      quality.reasoning + investmentMaturity.capabilityGain * 0.55,
    );
    quality.coding = clamp(
      quality.coding + investmentMaturity.capabilityGain * 0.45,
    );
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: Math.min(
          100,
          scale.benchCeilings[key] * precision.qualityCeilingMultiplier +
            investmentMaturity.ceilingGain,
          clamp(benchmarks[key]! + investmentMaturity.benchmarkGain),
        ),
      };
    }
  }

  // Immature modality experience caps the modality-linked benchmark last, so
  // the achieved score is the theoretical score times lab maturity.
  if (maturity.image != null && maturity.image < 1) {
    benchmarks = {
      ...benchmarks,
      vision: clamp((benchmarks.vision ?? 0) * maturity.image),
    };
  }

  // A plateau permits stopping; it does not manufacture the work that was
  // skipped. This explicit maturity haircut compounds the scale formula's
  // progress ceiling and is exactly neutral for a completed run.
  const releasePenalty = earlyReleasePenalty(job);
  if (releasePenalty.progress < 1 || releasePenalty.calendarProgress < 1) {
    capability = clamp(capability * releasePenalty.capabilityMultiplier);
    for (const key of Object.keys(quality) as (keyof QualityAxes)[]) {
      quality[key] = clamp(
        quality[key] *
          (key === "reliability"
            ? releasePenalty.reliabilityMultiplier
            : releasePenalty.capabilityMultiplier),
      );
    }
    for (const key of Object.keys(benchmarks) as (keyof BenchmarkScores)[]) {
      benchmarks = {
        ...benchmarks,
        [key]: clamp(benchmarks[key]! * releasePenalty.benchmarkMultiplier),
      };
    }
  }
  inferCostMult *= precision.inferenceCostMultiplier;

  // Seed list prices from campus hosting cost. Suggested quotes stay inside
  // the bounded launch envelope; the stored floor and listed prices cannot
  // go below what it costs to host this size on the current fleet.
  const birthModel = {
    id: `birth-${job.id}`,
    paramsB,
    activeParamsB,
    family,
    inferCostMult,
    tokPerSecMult,
  };
  const birthSnap = computeSnapshot(state);
  const hosting = apiHostingCostFloor(state, birthSnap, birthModel);
  const birthCostBasis = birthApiUnitCostPerMTok(state, birthSnap, birthModel);
  const apiSug = suggestApiInOut({
    costPerMTokBase: birthCostBasis,
    paramsB,
    activeParamsB,
    family,
    inferCostMult,
    capability,
    markupPct: state.player.pricing.apiMarkupPct ?? 120,
  });
  const listed = clampApiListToHostingFloor(
    apiSug.priceIn,
    apiSug.priceOut,
    hosting,
  );

  const continueCompute =
    (continueBase?.continueCompute ?? 0) +
    (job.mode === "continue" ? job.progressPfDays : 0);

  // Every checkpoint version gets a fresh compute-derived launch price.
  // The source version keeps its own custom list unchanged.
  const listIn = listed.priceIn;
  const listOut = listed.priceOut;
  const listBlend = Math.round(blendApiPrice(listIn, listOut) * 1000) / 1000;

  const productPreset = job.productPreset ?? presetFromFamily(family);
  const finalNumerics =
    job.trainingNumerics ?? job.numerics ?? continueBase?.trainingNumerics;
  const nativeWeightPrecision = finalNumerics
    ? nativeWeightPrecisionForNumerics(finalNumerics)
    : continueBase?.nativeWeightPrecision;
  const serviceProfile = serviceProfileForModel({
    paramsB,
    activeParamsB,
    family,
    backbone,
    productPreset,
    io: jobIo,
    modalities,
    tokPerSecMult,
    capability,
    trainingNumerics: finalNumerics,
    nativeWeightPrecision,
  });
  const capabilities = deriveModelCapabilities({
    finalCapability: capability,
    trainComputePfDays: job.progressPfDays,
    effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage ?? 0,
    dataQuality: job.dataQualityUsed ?? state.player.dataQuality,
    domainWeights: weights,
    io: jobIo,
    family,
    postTrain: effectivePostTrainStage,
    postTrainStrength: postProfile.scaleStrength,
    quality,
    modalityMaturity: maturity,
  });

  const sourceRevision = continueBase?.revision ?? 1;
  const modelId = `model-${state.day}-${job.id}`;
  const lineageId =
    continueBase?.lineageId ??
    continueBase?.id ??
    job.lineageId ??
    seededId("lineage", state.seed, job.id, job.name);
  const revision = continueBase
    ? Math.max(
        sourceRevision,
        ...state.player.models
          .filter((model) => (model.lineageId ?? model.id) === lineageId)
          .map((model) => model.revision ?? 1),
      ) + 1
    : 1;
  const rootName = (continueBase?.name ?? job.name)
    .replace(/\s+(?:v\d+|0\.\d+)$/i, "")
    .replace(/\s+·\s+C\d+$/i, "")
    .trim();
  const versionLabel = `0.${revision}`;
  const versionName = continueBase ? `${rootName} ${versionLabel}` : job.name;

  const productProfile = buildModelProductProfile({
    lifecycle: job.lifecycle,
    focus: job.specializationFocus,
    branchDirection: job.branchDirection,
    postTrain: effectivePostTrainStage,
    completedPostTrainStages: completedPostStages,
    postTrainStageEffectiveness: {
      ...(continueBase?.postTrainStageEffectiveness ?? {}),
      ...resolvedStageEffectiveness,
    },
    chatShare: job.dataPlan?.weights?.chat ?? 0,
    chatQuality: job.dataQualityByDomain?.chat ?? job.dataQualityUsed ?? 50,
    gyms: state.player.postTrainGyms,
    stackIds: job.modelStack,
    researchUnlocked: state.player.researchUnlocked,
    family,
    backbone,
    reasoningEnabled: reasoningTrained,
    outcomeSeed: job.outcomeSeed,
    existing: job.productProfile ?? continueBase?.productProfile,
  });
  benchmarks = { ...benchmarks, personality: productProfile.personality };

  return normalizeModelEvaluations({
    id: modelId,
    lineageId,
    parentModelId: continueBase?.id,
    sourceTrainingJobId: job.id,
    name: versionName,
    family,
    paramsB,
    activeParamsB,
    backbone,
    productPreset,
    io: matureModelIo(
      {
        inputs: Object.fromEntries(
          Object.keys(jobIo.inputs).map((key) => [key, capability]),
        ),
        outputs: Object.fromEntries(
          Object.keys(jobIo.outputs).map((key) => [key, capability]),
        ),
        tools: (() => {
          const baseline = baseJobIo.tools > 0 ? capability * 0.35 : 0;
          if (!postProfile.toolsEnabled) return baseline;
          const trainedTarget =
            capability * (0.45 + postProfile.scaleStrength * 0.4);
          return (
            baseline +
            (trainedTarget - baseline) * postProfile.stageEffectiveness.tools
          );
        })(),
      },
      maturity,
    ),
    capability,
    verifiedRecursiveCapabilityBonus,
    capabilities,
    modalities,
    quality,
    benchmarks,
    productProfile,
    postTrain: effectivePostTrainStage,
    completedPostTrainStages: completedPostStages,
    postTrainStageEffectiveness: {
      ...(continueBase?.postTrainStageEffectiveness ?? {}),
      ...resolvedStageEffectiveness,
    },
    postTrainStageRuns: {
      ...(continueBase?.postTrainStageRuns ?? {}),
      ...(job.postTrainStageRuns ?? {}),
    },
    trainingLossHistory: [...(job.lossHistory ?? [])],
    trainingBenchmarkSnapshots: [...(job.benchmarkSnapshots ?? [])],
    trainComputeSpent:
      (continueBase?.trainComputeSpent ?? 0) + job.progressPfDays,
    economics: (() => {
      const trainingInitialCost = Math.max(
        0,
        job.economics?.setupCost ?? 0,
      );
      const trainingDataCost = Math.max(0, job.economics?.dataCost ?? 0);
      const trainingDailyCost = Math.max(
        0,
        job.economics?.trainingCostAccrued ?? 0,
      );
      return {
        lifetimeApiRevenue: 0,
        lifetimeSubRevenue: 0,
        lifetimeEnterpriseRevenue: 0,
        lifetimeServingCost: 0,
        lifetimeNet: -(
          trainingInitialCost + trainingDataCost + trainingDailyCost
        ),
        trainingInitialCost,
        trainingDataCost,
        trainingDailyCost,
      };
    })(),
    releaseDay: state.day,
    shipped: release === "released",
    release,
    commerciallyOffered: list,
    tokPerSecMult,
    inferCostMult,
    serviceProfile,
    apiPricePerMTok: listBlend,
    apiPriceInPerMTok: listIn,
    apiPriceOutPerMTok: listOut,
    suggestedApiPrice: listBlend,
    suggestedApiPriceIn: listIn,
    suggestedApiPriceOut: listOut,
    costApiPriceIn: hosting.costIn,
    costApiPriceOut: hosting.costOut,
    distilled: job.mode === "distill" || !!continueBase?.distilled,
    teacherId: job.teacherId ?? continueBase?.teacherId,
    distillTeacherShare:
      job.mode === "distill"
        ? distillTeacherShare
        : continueBase?.distillTeacherShare,
    trainMode: job.mode,
    dataMix: job.dataMix,
    dataPlan: job.dataPlan,
    dataConsumed: job.dataConsumed,
    dataCoverage: job.dataCoverage,
    dataQualityUsed: job.dataQualityUsed,
    dataTokensUsedMTok:
      (continueBase?.dataTokensUsedMTok ?? 0) +
      (job.trainMTok ?? 0) +
      (job.verifyMTok ?? 0),
    // Watermark at lab corpus size so continue only uses data collected after this train
    dataWatermarkMTok: totalProcessed(ensureLabData(state)),
    dataTrainMTok: job.trainMTok,
    dataVerifyMTok: job.verifyMTok,
    continueCompute,
    effectiveDataRatio: job.effectiveDataRatio ?? job.dataCoverage,
    repeatedDataEpochs: job.repeatedDataEpochs ?? 1,
    outcome,
    openWeights: false,
    dataManifestId: job.dataManifestId ?? continueBase?.dataManifestId,
    integratedMethods:
      job.integratedMethods ?? continueBase?.integratedMethods ?? [],
    modelStack: job.modelStack ?? continueBase?.modelStack ?? [],
    reasoningEnabled: reasoningTrained,
    revision,
    versionLabel,
    checkpointEvaluations: [],
    safetyTraining: continueBase?.safetyTraining,
    dataQualityByDomain:
      job.dataQualityByDomain ?? continueBase?.dataQualityByDomain,
    lowQualityShareByDomain:
      job.lowQualityShareByDomain ?? continueBase?.lowQualityShareByDomain,
    syntheticProvenance:
      job.syntheticProvenance ?? continueBase?.syntheticProvenance,
    syntheticMultiplier:
      job.syntheticUnits > 0
        ? syntheticProfile.syntheticMultiplier
        : (continueBase?.syntheticMultiplier ?? 0),
    syntheticShare:
      job.syntheticUnits > 0
        ? syntheticProfile.syntheticShare
        : (continueBase?.syntheticShare ?? 0),
    benchmarkOverfit: Math.max(
      continueBase?.benchmarkOverfit ?? 0,
      syntheticProfile.benchmarkOverfit,
    ),
    trainingNumerics: finalNumerics,
    nativeWeightPrecision,
    trainingFormulaVersion: job.trainingFormulaVersion ?? 2,
  });
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function beginReadyLinkedPostTrain(state: SimState): SimState {
  let next = state;
  for (const job of playerTrainingJobs(next)) {
    if (jobNeedsLinkedPostTrain(job)) {
      next = beginLinkedPostTrain(next, job.id);
    }
  }
  return next;
}

function effortHeadLoss(
  job: TrainingJob,
  recipe: EffortRecipe,
  progress: number,
  day: number,
): number {
  return trainingLoss(
    {
      ...job,
      id: `${job.id}::effort::${recipe.id}`,
      targetParamsB:
        job.targetParamsB *
        (recipe.kind === "instant"
          ? 0.55
          : 0.35 + Math.max(1, recipe.thinkingTokenMult) * 0.12),
    },
    recipe.kind === "instant" ? "base" : "process",
    progress,
    day,
    recipe.loss,
  );
}

function effortTrainSnapshot(recipe: EffortRecipe): EffortTrainProgress {
  return {
    recipeId: recipe.id,
    name: recipe.name,
    thinkingTokenMult: recipe.thinkingTokenMult,
    progressPfDays: recipe.progressPfDays ?? 0,
    targetPfDays: recipe.targetPfDays ?? 0,
    cashSunk: recipe.trainCash,
    loss: recipe.loss,
    capabilityBias: recipe.capabilityBias,
    trainComputeShare: recipe.trainComputeShare,
  };
}

export function applyEffortHeadTick(
  state: SimState,
  job: TrainingJob,
  allocatedPf: number,
  day: number,
): { job: TrainingJob; remainderPf: number } {
  if (allocatedPf <= 1e-12) return { job, remainderPf: allocatedPf };
  const profile = productProfileForJob(state, job);
  const recipes = migrateEffortRecipes(profile);
  const { remainderPf, byId } = allocateEffortHeadPf(recipes, allocatedPf);
  const gymQuality = gymQualityByKind(state.player.postTrainGyms, "math");
  let changed = false;
  let defaultEffortId = profile.defaultEffortId;
  const nextRecipes = recipes.map((recipe) => {
    const pf = byId[recipe.id] ?? 0;
    if (pf <= 1e-12) return recipe;
    changed = true;
    const thinkingTokenMult =
      recipe.kind === "instant" ? 1 : recipe.thinkingTokenMult;
    const required = effortTrainTargetPfDays({
      paramsB: job.targetParamsB,
      thinkingTokenMult,
      gymQuality,
      researchUnlocked: state.player.researchUnlocked,
    });
    const priorFunded =
      recipe.kind === "instant"
        ? recipe.trainPfDays
        : Math.max(
            recipe.trainPfDays,
            effortFundedPfFromQuality(recipe.quality, required),
          );
    const funded = priorFunded + pf;
    const targetPfDays = Math.max(1e-9, recipe.targetPfDays ?? required);
    const progressPfDays = Math.min(
      targetPfDays,
      (recipe.progressPfDays ?? 0) + pf,
    );
    let quality =
      recipe.kind === "instant"
        ? recipe.quality
        : effortQualityFromTrain(funded, required);
    const completed = progressPfDays + 1e-9 >= targetPfDays;
    const trained = recipe.kind === "instant" || recipe.trained || completed;
    const becameTrained = !recipe.trained && trained && recipe.kind !== "instant";
    if (becameTrained) defaultEffortId = recipe.id;
    const loss = effortHeadLoss(
      job,
      { ...recipe, trainPfDays: funded, progressPfDays, targetPfDays, quality },
      progressPfDays / Math.max(1e-9, targetPfDays),
      day,
    );
    const sourceModel = job.continueFromId
      ? state.player.models.find((model) => model.id === job.continueFromId)
      : undefined;
    const reliability =
      sourceModel?.quality.reliability ??
      Math.max(
        0,
        Math.min(
          100,
          (job.dataQualityUsed ?? 50) * 0.45 + (100 - loss * 8) * 0.55,
        ),
      );
    const outcome =
      completed && recipe.kind !== "instant"
        ? resolveEffortTrainingOutcome({
            recipeId: recipe.id,
            thinkingTokenMult: recipe.thinkingTokenMult,
            progressPfDays,
            targetPfDays,
            requiredPfDays: required,
            finalLoss: loss,
            dataQuality: job.dataQualityUsed ?? 50,
            reliability,
            outcomeSeed:
              recipe.outcomeSeed ??
              hashSeed(
                job.outcomeSeed ?? state.seed,
                job.id,
                recipe.id,
                "effort-head-outcome-v1",
              ),
            capabilityBias: recipe.capabilityBias,
          })
        : null;
    if (outcome) quality = outcome.quality;
    return normalizeEffortRecipe({
      ...recipe,
      trainPfDays: funded,
      progressPfDays,
      targetPfDays,
      quality,
      trained,
      served: becameTrained
        ? true
        : trained
          ? recipe.served || recipe.kind === "instant"
          : recipe.served,
      loss,
      finalLoss: outcome?.finalLoss ?? recipe.finalLoss,
      outcomeSeed:
        outcome?.outcomeSeed ??
        recipe.outcomeSeed ??
        hashSeed(
          job.outcomeSeed ?? state.seed,
          job.id,
          recipe.id,
          "effort-head-outcome-v1",
        ),
      optimizationYield:
        outcome?.optimizationYield ?? recipe.optimizationYield,
      realizedLiftPct: outcome?.realizedLiftPct ?? recipe.realizedLiftPct,
    });
  });
  if (!changed) return { job, remainderPf: allocatedPf };
  const inflight = nextRecipes.find(
    (recipe) =>
      clampEffortTrainShare(recipe.trainComputeShare) > 1e-9 &&
      (recipe.progressPfDays ?? 0) + 1e-9 < (recipe.targetPfDays ?? 0),
  );
  return {
    remainderPf,
    job: {
      ...job,
      productProfile: { ...profile, effortRecipes: nextRecipes, defaultEffortId },
      effortTrain: inflight ? effortTrainSnapshot(inflight) : undefined,
    },
  };
}

export function tickTraining(state: SimState): SimState {
  state = beginReadyLinkedPostTrain(state);
  const jobs = playerTrainingJobs(state);
  if (!jobs.length) return state;

  const snap = computeSnapshot(state);
  const resources = playerTrainingResourcePlan(state, snap);
  const isActive = (job: TrainingJob) => {
    return (
      !job.failed &&
      !job.paused &&
      !job.pendingCampaignEvent &&
      (job.computePriority ?? 50) > 0
    );
  };
  const totalBurn = jobs.reduce(
    (sum, job) => sum + (isActive(job) ? (job.cashBurnPerDay ?? 0) : 0),
    0,
  );
  let nextState =
    totalBurn > 0 ? chargeExpense(state, totalBurn, "training") : state;

  const tickAlerts: Array<{
    id: string;
    day: number;
    severity: "info" | "warn" | "danger";
    message: string;
  }> = [];
  // Campaign decisions are intentionally non-blocking for the simulation.
  // If the player ignores one for five days, the duty-scientist (AFK) recipe
  // is applied automatically (including its real cash cost when affordable).
  const campaignResolvedJobs = jobs.map((job) => {
    const event = job.pendingCampaignEvent;
    if (!event || state.day < event.decisionDeadlineDay) return job;
    const duty = dutyScientistCampaignChoice(event);
    const cost = Math.max(0, duty.effects.cashCost ?? 0);
    const qualified =
      nextState.player.cash + 1e-9 >= cost &&
      (nextState.player.staff?.researcher ?? 0) >=
        (duty.effects.minResearchers ?? 0);
    const selected = qualified
      ? duty
      : event.choices.find(
          (choice) =>
            nextState.player.cash + 1e-9 >=
              Math.max(0, choice.effects.cashCost ?? 0) &&
            (nextState.player.staff?.researcher ?? 0) >=
              (choice.effects.minResearchers ?? 0),
        );
    if (!selected) {
      tickAlerts.push({
        id: `train-campaign-unfunded-${job.id}-${state.day}`,
        day: state.day,
        severity: "warn",
        message: `${job.name}: ${event.title} closed with no intervention; the planned recipe resumes.`,
      });
      return {
        ...job,
        pendingCampaignEvent: undefined,
        campaignEventHistory: [
          ...(job.campaignEventHistory ?? []),
          {
            ...event,
            selectedChoiceId: "stay-planned",
            resolvedDay: state.day,
            autoResolved: true,
          },
        ].slice(-16),
      };
    }
    const selectedCost = Math.max(0, selected.effects.cashCost ?? 0);
    if (selectedCost > 0 && nextState.player.cash + 1e-9 >= selectedCost) {
      nextState = chargeExpense(nextState, selectedCost, "training");
    }
    if ((selected.effects.progressRollbackFraction ?? 0) > 0) {
      nextState = createManualTrainingCheckpoint(nextState, {
        sourceJobId: job.id,
        label: `${job.name} · pre-rollback`,
      });
    }
    const resolved = applyTrainingCampaignChoice(
      job,
      selected.id,
      state.day,
      true,
    );
    tickAlerts.push({
      id: `train-campaign-auto-${job.id}-${state.day}`,
      day: state.day,
      severity: "warn",
      message: `${job.name}: ${event.title} auto-resolved with the safe default (${selected.label}).`,
    });
    return resolved ?? job;
  });
  const nextJobs = campaignResolvedJobs.map((job) => {
    if (job.failed) return job;
    const active = isActive(job);
    const daysElapsed = (job.daysElapsed ?? 0) + (active ? 1 : 0);
    const resource = resources.jobs[job.id];
    const trainPool = resource?.effectivePf ?? 0;
    const allocatedPf = active ? Math.max(0, trainPool) : 0;
    const telemetry = (
      progressPfDays = job.progressPfDays,
      elapsed = daysElapsed,
      consumedPf = allocatedPf,
    ) => {
      const energyMwDays =
        (job.energyMwDays ?? 0) + Math.max(0, consumedPf) * mwPerPf();
      return {
        energyMwDays,
        energyMWh: energyMwDays * 24,
        daysRemaining: liveTrainingDaysRemaining(
          job,
          allocatedPf,
          progressPfDays,
          elapsed,
        ),
      };
    };
    const economics = {
      setupCost: job.economics?.setupCost ?? 0,
      dataCost: job.economics?.dataCost ?? 0,
      trainingCostAccrued:
        (job.economics?.trainingCostAccrued ?? 0) +
        (active ? (job.cashBurnPerDay ?? 0) : 0),
    };
    const stallReason = job.paused
      ? "Paused"
      : trainPool <= 1e-9
        ? trainingStallReason(state, snap, resources, resource)
        : null;
    if (job.paused) {
      return {
        ...job,
        ...telemetry(),
        economics,
        daysElapsed,
        stallReason,
      };
    }
    if (job.pendingCampaignEvent) {
      return {
        ...job,
        ...telemetry(),
        economics,
        daysElapsed,
        stallReason: `Campaign decision: ${job.pendingCampaignEvent.title}`,
      };
    }
    if (resource && (!resource.ramReady || !resource.systemRamReady)) {
      return {
        ...job,
        ...telemetry(),
        economics,
        daysElapsed,
        stallReason,
      };
    }
    if (job.effortOnlySourceModelId && job.effortOnlyRecipeId) {
      const profile = productProfileForJob(state, job);
      const originalRecipes = migrateEffortRecipes(profile);
      const targetRecipe = originalRecipes.find(
        (recipe) => recipe.id === job.effortOnlyRecipeId,
      );
      if (!targetRecipe) {
        return {
          ...job,
          ...telemetry(job.progressPfDays, daysElapsed, 0),
          economics,
          daysElapsed,
          paused: true,
          stallReason: "Effort recipe missing from this fitting run.",
        };
      }
      const remaining = Math.max(
        0,
        (targetRecipe.targetPfDays ?? job.targetPfDays) -
          (targetRecipe.progressPfDays ?? job.progressPfDays),
      );
      const consumedPf = Math.min(allocatedPf, remaining);
      const isolatedProfile: ModelProductProfile = {
        ...profile,
        effortRecipes: originalRecipes.map((recipe) => ({
          ...recipe,
          trainComputeShare:
            recipe.id === targetRecipe.id ? EFFORT_HEAD_SHARE_MAX : 0,
        })),
      };
      const headed = applyEffortHeadTick(
        state,
        { ...job, productProfile: isolatedProfile },
        consumedPf / EFFORT_HEAD_SHARE_MAX,
        state.day,
      ).job;
      const updatedTarget = migrateEffortRecipes(headed.productProfile).find(
        (recipe) => recipe.id === targetRecipe.id,
      );
      const nextRecipes = originalRecipes.map((recipe) =>
        recipe.id === targetRecipe.id && updatedTarget
          ? { ...updatedTarget, trainComputeShare: EFFORT_HEAD_SHARE_MAX }
          : recipe,
      );
      const progressPfDays = Math.min(
        job.targetPfDays,
        updatedTarget?.progressPfDays ?? job.progressPfDays,
      );
      return {
        ...headed,
        ...telemetry(progressPfDays, daysElapsed, consumedPf),
        economics,
        daysElapsed,
        progressPfDays,
        productProfile: {
          ...profile,
          effortRecipes: nextRecipes,
          defaultEffortId: headed.productProfile?.defaultEffortId ??
            profile.defaultEffortId,
        },
        effortTrain: updatedTarget
          ? effortTrainSnapshot(updatedTarget)
          : job.effortTrain,
        stallReason,
      };
    }
    const headed = applyEffortHeadTick(state, job, allocatedPf, state.day);
    const working = headed.job;
    const remainderPf = headed.remainderPf;
    const usefulBasePf = Math.min(
      remainderPf,
      pacedTrainingPfPerDay(working.targetPfDays, working.minCalendarDays),
    );
    const proposedBaseProgress = Math.min(
      working.targetPfDays,
      working.progressPfDays + usefulBasePf,
    );
    const imminentCampaignMilestone =
      working.postTrain === "none" &&
      working.progressPfDays < working.targetPfDays
        ? crossedTrainingCampaignMilestone(
            working,
            working.progressPfDays / Math.max(1e-9, working.targetPfDays),
            proposedBaseProgress / Math.max(1e-9, working.targetPfDays),
          )
        : null;
    if (working.progressPfDays < working.targetPfDays) {
      const nextProgress = proposedBaseProgress;
      const campaignMilestone = imminentCampaignMilestone;
      const baseFailurePlan = trainingStageFailurePlan(working, "base");
      const failureProgress = working.targetPfDays * baseFailurePlan.atFraction;
      const crossesFailure =
        baseFailurePlan.willFail &&
        working.progressPfDays < failureProgress &&
        nextProgress >= failureProgress;
      const campaignProgress = campaignMilestone
        ? Math.min(
            nextProgress,
            working.targetPfDays * campaignMilestone.milestone,
          )
        : Number.POSITIVE_INFINITY;
      // A destructive crossing wins if it occurs before (or exactly at) a
      // campaign decision. Large daily allocations cannot skip the failure.
      if (crossesFailure && failureProgress <= campaignProgress + 1e-9) {
        const consumedPf = Math.max(0, failureProgress - working.progressPfDays);
        return failTrainingJob(
          {
            ...working,
            ...telemetry(failureProgress, daysElapsed, consumedPf),
            economics,
            daysElapsed,
            progressPfDays: failureProgress,
            lossHistory: appendLossPoint(
              working,
              "base",
              baseFailurePlan.atFraction,
              state.day,
            ),
          },
          "base",
          state.day,
          baseFailurePlan.atFraction,
        );
      }
      if (campaignMilestone) {
        // Stop at the checkpoint even when a small run could cross several
        // milestones in one daily allocation. This preserves every decision
        // and only meters the compute consumed before the checkpoint.
        const checkpointProgress = Math.min(
          nextProgress,
          working.targetPfDays * campaignMilestone.milestone,
        );
        const checkpointCompute = Math.max(
          0,
          checkpointProgress - working.progressPfDays,
        );
        const event = createTrainingCampaignEvent(
          working,
          campaignMilestone.milestone,
          campaignMilestone.index,
          state.day,
        );
        tickAlerts.push({
          id: `train-campaign-${working.id}-${campaignMilestone.index}`,
          day: state.day,
          severity: event.severity === "opportunity" ? "info" : "warn",
          message: `${working.name}: ${event.title}. Craft an intervention within 5 days. Weights are not saved unless you snapshot or roll back.`,
        });
        return {
          ...working,
          ...telemetry(checkpointProgress, daysElapsed, checkpointCompute),
          economics,
          daysElapsed,
          progressPfDays: checkpointProgress,
          pendingCampaignEvent: event,
          campaignMilestonesReached: [
            ...(working.campaignMilestonesReached ?? []),
            campaignMilestone.milestone,
          ],
          lossHistory: appendLossPoint(
            working,
            "base",
            campaignMilestone.milestone,
            state.day,
          ),
        };
      }
      return {
        ...working,
        ...telemetry(nextProgress, daysElapsed, usefulBasePf),
        economics,
        daysElapsed,
        stallReason,
        progressPfDays: nextProgress,
        lossHistory: appendLossPoint(
          working,
          "base",
          nextProgress / Math.max(1e-9, working.targetPfDays),
          state.day,
        ),
      };
    }
    if (
      working.postTrain !== "none" &&
      working.postTrainProgress + 1e-9 < working.postTrainTarget
    ) {
      const postTrainStage = working.postTrain;
      // New stage selections persist this plan immediately. Legacy in-flight
      // saves get one deterministic plan here and keep it on every return.
      const postTrainRiskPlan =
        working.postTrainRiskPlan?.stage === postTrainStage
          ? working.postTrainRiskPlan
          : createPostTrainRiskPlan(
              working,
              postTrainStage,
              state.player.researchUnlocked,
              state.player.models,
              state.day,
              working.postTrainProgress / Math.max(1e-9, working.postTrainTarget),
            );
      const postTrainJob: TrainingJob = { ...working, postTrainRiskPlan };
      const postTrainDaysElapsed = (postTrainJob.postTrainDaysElapsed ?? 0) + 1;
      const nextProgress = Math.min(
        postTrainJob.postTrainTarget,
        postTrainJob.postTrainProgress + Math.max(0, remainderPf),
      );
      const stageCompleted =
        nextProgress + 1e-9 >= postTrainJob.postTrainTarget;
      const effectiveness = stageCompleted
        ? postTrainStageEffectiveness({
            job: {
              ...postTrainJob,
              postTrainProgress: nextProgress,
              postTrainDaysElapsed,
            },
            stage: postTrainStage,
            researchUnlocked: state.player.researchUnlocked,
            models: state.player.models,
            progress: nextProgress,
            daysElapsed: postTrainDaysElapsed,
            gyms: state.player.postTrainGyms,
            tools: state.player.toolSkills,
          })
        : undefined;
      const failureProgress =
        postTrainJob.postTrainTarget * postTrainRiskPlan.atFraction;
      if (
        postTrainRiskPlan.willFail &&
        postTrainJob.postTrainProgress < failureProgress &&
        nextProgress >= failureProgress
      ) {
        const failureFraction = postTrainRiskPlan.atFraction;
        const recoveryCheckpoint = postTrainRecoveryCheckpoint(
          state,
          postTrainJob,
          postTrainStage,
          failureFraction,
        );
        const consumedPf = Math.max(
          0,
          failureProgress - postTrainJob.postTrainProgress,
        );
        return failTrainingJob(
          {
            ...postTrainJob,
            ...telemetry(working.progressPfDays, daysElapsed, consumedPf),
            economics,
            daysElapsed,
            postTrainProgress: failureProgress,
            postTrainDaysElapsed,
            lossHistory: appendLossPoint(
              postTrainJob,
              postTrainStage,
              failureFraction,
              state.day,
            ),
          },
          postTrainStage,
          state.day,
          failureFraction,
          recoveryCheckpoint,
        );
      }
      const completedPass =
        stageCompleted && effectiveness != null
          ? recordCompletedPostTrainPass(
              postTrainJob,
              postTrainStage,
              effectiveness,
            )
          : null;
      const finishedStages =
        completedPass?.completedPostTrainStages ??
        postTrainJob.completedPostTrainStages;
      const finishedEffectiveness =
        completedPass?.postTrainStageEffectiveness ??
        postTrainJob.postTrainStageEffectiveness;
      const finishedStageRuns =
        completedPass?.postTrainStageRuns ?? postTrainJob.postTrainStageRuns;
      const finishedThisRun =
        completedPass?.postTrainStagesCompletedThisRun ??
        postTrainJob.postTrainStagesCompletedThisRun;
      return {
        ...postTrainJob,
        ...telemetry(),
        economics,
        daysElapsed,
        postTrainProgress: nextProgress,
        postTrainDaysElapsed,
        completedPostTrainStages: finishedStages,
        postTrainStageEffectiveness: finishedEffectiveness,
        postTrainStageRuns: finishedStageRuns,
        postTrainStagesCompletedThisRun: finishedThisRun,
        lossHistory: appendLossPoint(
          postTrainJob,
          postTrainStage,
          nextProgress / Math.max(1e-9, postTrainJob.postTrainTarget),
          state.day,
        ),
      };
    }
    // A completed target is a releasable checkpoint, not an automatic compute
    // cutoff. If the player leaves priority on this run, keep investing its
    // allocated PF into the same weights. fundedTrainingMaturity() converts
    // this cumulative spend into sharply diminishing gains at finalization and
    // clamps them inside the architecture's hard capability wall.
    if (active && remainderPf > 1e-9) {
      const nextProgress = working.progressPfDays + Math.max(0, remainderPf);
      return {
        ...working,
        ...telemetry(nextProgress),
        economics,
        daysElapsed,
        progressPfDays: nextProgress,
        stallReason: null,
        lossHistory: appendLossPoint(
          working,
          "base",
          nextProgress / Math.max(1e-9, working.targetPfDays),
          state.day,
        ),
      };
    }
    return {
      ...working,
      ...telemetry(),
      economics,
      daysElapsed,
      stallReason,
    };
  });
  const completedEffortJobs = nextJobs.filter(
    (job) =>
      job.effortOnlySourceModelId &&
      job.effortOnlyRecipeId &&
      job.progressPfDays + 1e-9 >= job.targetPfDays,
  );
  const completedEffortJobIds = new Set(
    completedEffortJobs.map((job) => job.id),
  );
  const installedModels = nextState.player.models.map((model) => {
    const completed = completedEffortJobs.find(
      (job) => job.effortOnlySourceModelId === model.id,
    );
    if (!completed?.effortOnlyRecipeId) return model;
    const trainedRecipe = migrateEffortRecipes(
      completed.productProfile,
    ).find((recipe) => recipe.id === completed.effortOnlyRecipeId);
    if (!trainedRecipe) return model;
    const current = productProfileFromModel(
      model,
      nextState.player.postTrainGyms,
      nextState.player.researchUnlocked,
    );
    const recipes = migrateEffortRecipes(current).map((recipe) =>
      recipe.id === trainedRecipe.id ? trainedRecipe : recipe,
    );
    tickAlerts.push({
      id: `effort-head-complete-${completed.id}-${state.day}`,
      day: state.day,
      severity: "info",
      message: `${model.name}: ${trainedRecipe.name} finished at ${trainedRecipe.thinkingTokenMult.toFixed(1)}x generated tokens (loss ${(trainedRecipe.finalLoss ?? trainedRecipe.loss ?? 0).toFixed(2)}).`,
    });
    return {
      ...model,
      productProfile: {
        ...current,
        effortRecipes: recipes,
        defaultEffortId: trainedRecipe.trained
          ? trainedRecipe.id
          : current.defaultEffortId,
      },
    };
  });
  const stateWithInstalledEfforts: SimState = {
    ...nextState,
    player: { ...nextState.player, models: installedModels },
  };
  let next = beginReadyLinkedPostTrain(
    withTrainingJobs(
      stateWithInstalledEfforts,
      nextJobs.filter((job) => !completedEffortJobIds.has(job.id)),
    ),
  );
  const newlyFailed = nextJobs.filter(
    (job) => job.failed && !jobs.find((before) => before.id === job.id)?.failed,
  );
  const milestoneEvents = nextJobs.flatMap((job) => {
    const before = jobs.find((candidate) => candidate.id === job.id);
    const prior = new Set(before?.campaignMilestonesReached ?? []);
    return (job.campaignMilestonesReached ?? [])
      .filter((milestone) => !prior.has(milestone))
      .map((milestone) => ({
        id: `feed-training-milestone-${job.id}-${Math.round(milestone * 100)}-${state.day}`,
        day: state.day,
        category: "models" as const,
        title: `Training milestone: ${job.name} at ${Math.round(milestone * 100)}%`,
        body: job.pendingCampaignEvent?.title
          ? `${job.pendingCampaignEvent.title} — a campaign decision is now waiting in the training queue.`
          : `${job.name} crossed a deterministic checkpoint in its training process.`,
        source: state.player.name,
        tone: "research" as const,
        entityId: job.id,
        kind: "training_milestone",
      }));
  });
  const failureEvents = newlyFailed.map((job) => ({
    id: `feed-training-failed-${job.id}-${state.day}`,
    day: state.day,
    category: "models" as const,
    title: `Training failure: ${job.name}`,
    body: `The ${job.failureStage === "base" ? "base" : `${job.failureStage?.toUpperCase()} post-training`} stage destabilized; recover from an eligible immutable checkpoint or retire the run.`,
    source: state.player.name,
    tone: "danger" as const,
    entityId: job.id,
    kind: "training_failed",
  }));
  // Cash was already charged via chargeExpense on nextState.
  const settled = {
    ...next,
    alerts: [
      ...newlyFailed.map((job) => ({
        id: `train-failed-${job.id}-${state.day}`,
        day: state.day,
        severity: "danger" as const,
        message: `${job.name} failed during ${job.failureStage === "base" ? "base training" : `${job.failureStage?.toUpperCase()} post-training`}.${
          job.failureRecoveryCheckpointId
            ? " Recover from its eligible immutable checkpoint; spent work is not refunded."
            : " No eligible checkpoint exists, so the run must be deleted."
        }`,
      })),
      ...tickAlerts,
      ...nextState.alerts,
    ].slice(0, 40),
  };
  return appendFeedEvents(settled, [...milestoneEvents, ...failureEvents]);
}

export { formatParams, trainCostPfDays };
