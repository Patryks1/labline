import { CAPABILITY_DOMAINS } from "../balance/modelCapabilities";
import { emptyBenchmarks } from "../balance/benchmarks";
import { normalizeModelEvaluations } from "../balance/evaluationSuites";
import { buildModelProductProfile } from "../balance/modelProduct";
import {
  FALLBACK_COST_PER_MTOK,
  blendApiPrice,
  suggestApiInOut,
} from "../balance/pricing";
import { precisionComputeMult } from "../balance/tokenServe";
import { serviceProfileForModel } from "../balance/trainingV3";
import { seededId } from "../rng";
import type {
  CapabilityDomain,
  LabId,
  Model,
  ModelCapabilities,
  ModelEconomics,
  ModelFamily,
  ModelIO,
  Modality,
  NativeWeightPrecision,
  PostTrainStage,
  QualityAxes,
  ServePrecision,
  SimState,
} from "../types";
import { TRAINING_V4 } from "./constants";
import { contextServeCost } from "./compute";
import { baselineModifiers, modifiersForLab } from "./modifiers";
import { trainingStateOf, withTrainingState } from "./state";
import { servedThinkingCostMult, servedThinkingLatencyMult, canonicalizeTierBudget } from "./thinking";
import type {
  Architecture,
  Checkpoint,
  Endpoint,
  EndpointMember,
  PostTrainStageKind,
  ThinkingTier,
  TrainPrecision,
  TrainingModifiers,
  TrainingUnlock,
} from "./types";

const TEXT_DOMAINS: CapabilityDomain[] = [
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "tools",
];

const MODALITY_DOMAINS: CapabilityDomain[] = ["vision", "audio", "video"];

const CASCADE_SIZE_WEIGHTS = [0.6, 0.3, 0.1];

const POST_TRAIN_RANK: Record<PostTrainStageKind, Exclude<PostTrainStage, "none">> = {
  instruct: "sft",
  preference: "rlhf",
  reasoning: "process",
  agentic: "tools",
};

const POST_TRAIN_ORDER: PostTrainStageKind[] = [
  "instruct",
  "preference",
  "reasoning",
  "agentic",
];

export function safeModifiers(state: SimState, labId: LabId): TrainingModifiers {
  let mods = baselineModifiers();
  try {
    mods = modifiersForLab(state, labId);
  } catch {
    mods = baselineModifiers();
  }
  const research =
    labId === state.playerLabId
      ? state.player.researchUnlocked
      : (state.rivals.find((rival) => rival.id === labId)?.researchUnlocked ?? []);
  const extra: TrainingUnlock[] = [];
  for (const unlock of ["router_domain", "router_cascade"] as const) {
    if (research.includes(unlock) && !mods.unlocks.includes(unlock)) {
      extra.push(unlock);
    }
  }
  return extra.length > 0 ? { ...mods, unlocks: [...mods.unlocks, ...extra] } : mods;
}

export function nativePrecisionFromArch(
  precision: TrainPrecision,
): NativeWeightPrecision {
  if (precision === "fp32") return "fp32";
  if (precision === "fp16_mixed") return "fp16";
  if (precision === "fp8_hybrid") return "fp8";
  if (precision === "fp6") return "fp6";
  if (precision === "nvfp4") return "nvfp4";
  return "bf16";
}

export function servePrecisionFromArch(precision: TrainPrecision): ServePrecision {
  return nativePrecisionFromArch(precision);
}

/** Packed weight bytes per parameter for serving HBM (V4 table). */
export function bytesPerServeParam(precision: ServePrecision | NativeWeightPrecision): number {
  if (precision === "fp32") return 4;
  if (precision === "fp16" || precision === "bf16") return 2;
  if (precision === "fp8" || precision === "int8") return 1;
  if (precision === "fp6") return 0.75;
  if (precision === "nvfp4" || precision === "int4") return 0.5;
  if (precision === "ternary_1_58") return 0.2;
  return 2;
}

export function familyFromArch(arch: Architecture): ModelFamily {
  if (arch.preset === "omni") return "omni";
  if (arch.preset === "video_generation") return "video";
  if (arch.preset === "image_generation") return "diffusion";
  if (arch.backbone === "moe") return "moe";
  return "dense";
}

export function modalitySetOf(arch: Architecture): string {
  const mods = new Set<string>([...arch.inputs, ...arch.outputs]);
  return [...mods].sort().join(",");
}

export function hasTextIo(arch: Architecture): boolean {
  return arch.inputs.includes("text") || arch.outputs.includes("text");
}

export function archCoversDomain(arch: Architecture, domain: CapabilityDomain): boolean {
  if (domain === "vision") {
    return arch.inputs.includes("image") || arch.outputs.includes("image");
  }
  if (domain === "audio") {
    return arch.inputs.includes("audio") || arch.outputs.includes("audio");
  }
  if (domain === "video") {
    return arch.inputs.includes("video") || arch.outputs.includes("video");
  }
  return hasTextIo(arch);
}

export function unionTiers(members: readonly ThinkingTier[][]): ThinkingTier[] {
  const byBudget = new Map<ThinkingTier["budget"], boolean>();
  for (const list of members) {
    for (const tier of list) {
      const budget = canonicalizeTierBudget(tier.budget);
      byBudget.set(budget, (byBudget.get(budget) ?? false) || tier.served);
    }
  }
  return TRAINING_V4.postTrain.tierBudgets.map((budget) => ({
    budget,
    served: byBudget.get(budget) ?? false,
  })).filter((tier) => byBudget.has(tier.budget));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emptyEconomics(): ModelEconomics {
  return {
    lifetimeApiRevenue: 0,
    lifetimeSubRevenue: 0,
    lifetimeEnterpriseRevenue: 0,
    lifetimeServingCost: 0,
    lifetimeNet: 0,
    trainingInitialCost: 0,
    trainingDataCost: 0,
    trainingDailyCost: 0,
  };
}

function copyCapabilities(caps: ModelCapabilities): ModelCapabilities {
  return {
    domains: { ...caps.domains },
    factuality: caps.factuality,
    steerability: caps.steerability,
    robustness: caps.robustness,
    safety: caps.safety,
    reliability: caps.reliability,
  };
}

function zeroCapabilities(): ModelCapabilities {
  const domains = {} as Record<CapabilityDomain, number>;
  for (const domain of CAPABILITY_DOMAINS) domains[domain] = 0;
  return {
    domains,
    factuality: 0,
    steerability: 0,
    robustness: 0,
    safety: 0,
    reliability: 0,
  };
}

export function overallCapability(domains: Record<CapabilityDomain, number>): number {
  const multimodal = MODALITY_DOMAINS.filter((domain) => (domains[domain] ?? 0) > 0);
  const mmEach = multimodal.length > 0 ? 0.1 / multimodal.length : 0;
  const weights: Record<CapabilityDomain, number> = {
    language: 0.25,
    reasoning: 0.2,
    code: 0.15,
    math: 0.1,
    science: 0.1,
    tools: 0.1,
    vision: multimodal.includes("vision") ? mmEach : 0,
    audio: multimodal.includes("audio") ? mmEach : 0,
    video: multimodal.includes("video") ? mmEach : 0,
  };
  let sum = 0;
  let weight = 0;
  for (const domain of CAPABILITY_DOMAINS) {
    const w = weights[domain] ?? 0;
    if (w <= 0) continue;
    sum += (domains[domain] ?? 0) * w;
    weight += w;
  }
  return weight > 0 ? clampScore(sum / weight) : 0;
}

export function maxServedBudget(tiers: readonly ThinkingTier[]): number {
  let max = 1;
  for (const tier of tiers) {
    if (!tier.served) continue;
    const budget = canonicalizeTierBudget(tier.budget);
    if (budget > max) max = budget;
  }
  return max;
}

export function tierLift(
  domain: CapabilityDomain,
  budget: number,
  rlEffect: number,
): number {
  const k = TRAINING_V4.postTrain.tierLiftK;
  const maxLift = TRAINING_V4.maxLiftByDomain[domain];
  return rlEffect * (1 - Math.exp(-(Math.max(1, budget) - 1) / k)) * maxLift;
}

function applyServedTierLift(
  caps: ModelCapabilities,
  tiers: readonly ThinkingTier[],
  rlEffect: number,
): ModelCapabilities {
  const budget = maxServedBudget(tiers);
  const next = copyCapabilities(caps);
  for (const domain of CAPABILITY_DOMAINS) {
    next.domains[domain] = clampScore(
      next.domains[domain] + tierLift(domain, budget, rlEffect),
    );
  }
  return next;
}

function memberCheckpoints(
  state: SimState,
  endpoint: Endpoint,
): { member: EndpointMember; checkpoint: Checkpoint }[] {
  const training = trainingStateOf(state, endpoint.labId);
  const rows: { member: EndpointMember; checkpoint: Checkpoint }[] = [];
  for (const member of endpoint.members) {
    const checkpoint = training.checkpoints.find((c) => c.id === member.checkpointId);
    if (checkpoint) rows.push({ member, checkpoint });
  }
  return rows;
}

export function primaryMember(endpoint: Endpoint): EndpointMember | undefined {
  return (
    endpoint.members.find((member) => member.role === "primary") ??
    endpoint.members[0]
  );
}

export function misrouteFraction(routerQuality: number): number {
  return TRAINING_V4.endpoints.misrouteBase * (1 - Math.max(0, Math.min(1, routerQuality)));
}

export function compositeCapabilitiesWithQuality(
  state: SimState,
  endpoint: Endpoint,
  routerQuality: number,
): ModelCapabilities {
  const rows = memberCheckpoints(state, endpoint);
  if (rows.length === 0) return zeroCapabilities();
  const primary =
    rows.find((row) => row.member.role === "primary") ?? rows[0]!;
  if (endpoint.policy === "single" || rows.length === 1) {
    return copyCapabilities(primary.checkpoint.truth);
  }

  const rq = Math.max(0, Math.min(1, routerQuality));
  const misroute = misrouteFraction(rq);
  const domains = {} as Record<CapabilityDomain, number>;

  if (endpoint.policy === "domain") {
    for (const domain of CAPABILITY_DOMAINS) {
      const listed = rows.filter((row) => row.member.domains?.includes(domain));
      const pool = listed.length > 0 ? listed : [primary];
      const peak = Math.max(...pool.map((row) => row.checkpoint.truth.domains[domain] ?? 0));
      domains[domain] = clampScore(peak * (1 - misroute));
    }
  } else if (endpoint.policy === "cascade") {
    const extra =
      TRAINING_V4.endpoints.cascadeEscalation *
      Math.max(0, rows.length - 1) *
      (1 - rq);
    const penalty = Math.min(1, misroute + extra);
    for (const domain of CAPABILITY_DOMAINS) {
      const peak = Math.max(...rows.map((row) => row.checkpoint.truth.domains[domain] ?? 0));
      domains[domain] = clampScore(peak * (1 - penalty));
    }
  } else {
    for (const domain of TEXT_DOMAINS) {
      domains[domain] = primary.checkpoint.truth.domains[domain] ?? 0;
    }
    for (const domain of MODALITY_DOMAINS) {
      const covering = rows.filter((row) => archCoversDomain(row.checkpoint.arch, domain));
      if (covering.length === 0) {
        domains[domain] = 0;
      } else {
        domains[domain] = Math.max(
          ...covering.map((row) => row.checkpoint.truth.domains[domain] ?? 0),
        );
      }
    }
  }

  const facts = rows.map((row) => row.checkpoint.truth);
  return {
    domains,
    factuality: mean(facts.map((c) => c.factuality)),
    steerability: mean(facts.map((c) => c.steerability)),
    robustness: mean(facts.map((c) => c.robustness)),
    safety: mean(facts.map((c) => c.safety)),
    reliability: mean(facts.map((c) => c.reliability)),
  };
}

export function compositeCapabilities(
  state: SimState,
  endpoint: Endpoint,
): ModelCapabilities {
  return compositeCapabilitiesWithQuality(
    state,
    endpoint,
    safeModifiers(state, endpoint.labId).routerQuality,
  );
}

export function endpointHbmGB(state: SimState, endpoint: Endpoint): number {
  const rows = memberCheckpoints(state, endpoint);
  const bytes = bytesPerServeParam(endpoint.precision);
  let paramsB = 0;
  for (const row of rows) paramsB += row.checkpoint.arch.totalParamsB;
  return paramsB * bytes * 1.15;
}

export function endpointCostMultiplier(state: SimState, endpoint: Endpoint): number {
  const rows = memberCheckpoints(state, endpoint);
  if (endpoint.policy !== "cascade" || rows.length < 2) return 1;
  const sorted = [...rows].sort(
    (a, b) => a.checkpoint.arch.totalParamsB - b.checkpoint.arch.totalParamsB,
  );
  const n = Math.min(sorted.length, CASCADE_SIZE_WEIGHTS.length);
  const raw = CASCADE_SIZE_WEIGHTS.slice(0, n);
  const weightSum = raw.reduce((sum, w) => sum + w, 0);
  const primary =
    rows.find((row) => row.member.role === "primary") ?? rows[0]!;
  const denom = Math.max(1e-9, primary.checkpoint.arch.totalParamsB);
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    weighted += (raw[i]! / weightSum) * sorted[i]!.checkpoint.arch.totalParamsB;
  }
  return weighted / denom;
}

export function sunsetDemandMultiplier(endpoint: Endpoint, day: number): number | undefined {
  if (endpoint.status === "retired") return 0;
  if (endpoint.status !== "sunset" || !endpoint.sunset) return undefined;
  const { startDay, drainDays } = endpoint.sunset;
  if (drainDays <= 0) return 0;
  const elapsed = Math.max(0, day - startDay);
  return Math.max(0, Math.min(1, 1 - elapsed / drainDays));
}

function ioFromArch(arch: Architecture, caps: ModelCapabilities): ModelIO {
  const skillFor = (modality: "text" | "image" | "audio" | "video"): number => {
    if (modality === "text") return caps.domains.language;
    if (modality === "image") return caps.domains.vision;
    if (modality === "audio") return caps.domains.audio;
    return caps.domains.video;
  };
  const inputs: ModelIO["inputs"] = {};
  const outputs: ModelIO["outputs"] = {};
  for (const modality of arch.inputs) inputs[modality] = skillFor(modality);
  for (const modality of arch.outputs) outputs[modality] = skillFor(modality);
  return { inputs, outputs, tools: caps.domains.tools };
}

function modalitiesFromIo(io: ModelIO): Modality[] {
  const modalities: Modality[] = [];
  for (const modality of ["text", "image", "audio", "video"] as const) {
    if ((io.inputs[modality] ?? 0) > 0 || (io.outputs[modality] ?? 0) > 0) {
      modalities.push(modality);
    }
  }
  if (io.tools > 0) modalities.push("tools");
  if (modalities.length === 0) modalities.push("text");
  return modalities;
}

function qualityFromCaps(caps: ModelCapabilities): QualityAxes {
  return {
    reasoning: caps.domains.reasoning,
    coding: caps.domains.code,
    chat: caps.domains.language,
    image: caps.domains.vision,
    video: caps.domains.video,
    safety: caps.safety,
    reliability: caps.reliability,
  };
}

function benchmarksFromCaps(caps: ModelCapabilities, personality: number) {
  return {
    ...emptyBenchmarks(),
    mmlu: caps.domains.language * 0.55 + caps.domains.reasoning * 0.45,
    coding: caps.domains.code,
    math: caps.domains.math,
    vision: caps.domains.vision,
    law: caps.domains.language,
    health: caps.domains.science,
    science: caps.domains.science,
    multilingual: caps.domains.language,
    agents: caps.domains.tools,
    safety: caps.safety,
    personality,
  };
}

function highestPostTrain(checkpoint: Checkpoint): {
  stage: PostTrainStage;
  completed: Exclude<PostTrainStage, "none">[];
  effectiveness: Partial<Record<Exclude<PostTrainStage, "none">, number>>;
} {
  const completed: Exclude<PostTrainStage, "none">[] = [];
  const effectiveness: Partial<Record<Exclude<PostTrainStage, "none">, number>> = {};
  let stage: PostTrainStage = "none";
  for (const kind of POST_TRAIN_ORDER) {
    const record = checkpoint.postTrain.stages[kind];
    if (!record || (record.runs <= 0 && record.effect <= 0)) continue;
    const mapped = POST_TRAIN_RANK[kind];
    completed.push(mapped);
    effectiveness[mapped] = record.effect;
    stage = mapped;
  }
  return { stage, completed, effectiveness };
}

function trainModeOf(checkpoint: Checkpoint): Model["trainMode"] {
  if (checkpoint.trainingSummary.distilledFrom) return "distill";
  if (checkpoint.parentId) return "continue";
  return "pretrain";
}

function sizeServeMults(arch: Architecture, family: ModelFamily): {
  tokPerSecMult: number;
  inferCostMult: number;
} {
  const paramsB = arch.totalParamsB;
  const activeParamsB = arch.activeParamsB;
  let inferCostMult = 1;
  let tokPerSecMult = 0.7;
  if (arch.backbone === "moe") {
    inferCostMult = 1.1 * Math.pow(activeParamsB / Math.max(paramsB * 0.08, 0.1), 0.3);
    tokPerSecMult =
      (family === "omni" ? 0.35 : 0.85) * Math.pow(7 / Math.max(activeParamsB, 0.5), 0.15);
  } else if (family === "dense") {
    tokPerSecMult = 0.75 * Math.pow(7 / Math.max(paramsB, 0.5), 0.12);
  } else if (family === "video") {
    inferCostMult = 2.5;
    tokPerSecMult = 0.25;
  } else if (family === "diffusion") {
    inferCostMult = 1.4;
    tokPerSecMult = 0.4;
  } else if (family === "omni") {
    tokPerSecMult = 0.35;
  }
  if (arch.backbone !== "moe" && paramsB > 70) {
    inferCostMult *= 1 + Math.log10(paramsB / 70) * 0.35;
    tokPerSecMult *= 1 / (1 + Math.log10(paramsB / 70) * 0.4);
  }
  return { tokPerSecMult, inferCostMult };
}

export function labModelsOf(state: SimState, labId: LabId): Model[] {
  if (labId === state.playerLabId) return state.player.models;
  return state.rivals.find((rival) => rival.id === labId)?.models ?? [];
}

export function withLabModels(state: SimState, labId: LabId, models: Model[]): SimState {
  if (labId === state.playerLabId) {
    return { ...state, player: { ...state.player, models } };
  }
  return {
    ...state,
    rivals: state.rivals.map((rival) =>
      rival.id === labId ? { ...rival, models } : rival,
    ),
  };
}

function mergeRuntime(previous: Model | undefined, next: Model): Model {
  if (!previous) return next;
  return {
    ...next,
    economics: previous.economics ?? next.economics,
    corpusDriftTotal: previous.corpusDriftTotal,
    corpusDriftLastDay: previous.corpusDriftLastDay,
  };
}

function rlEffectFor(
  state: SimState,
  endpoint: Endpoint | undefined,
  checkpoint: Checkpoint,
): number {
  const mods = safeModifiers(state, checkpoint.labId);
  const cps = endpoint
    ? memberCheckpoints(state, endpoint).map((row) => row.checkpoint)
    : [checkpoint];
  const effect = Math.max(
    0,
    ...cps.map((c) => c.postTrain.stages.reasoning?.effect ?? 0),
  );
  return effect * mods.rlQuality;
}

/**
 * Project a checkpoint (optionally wrapped by an endpoint/router) onto the
 * legacy market-facing `Model` shape. Pure; does not mutate state.
 */
export function modelFromCheckpoint(
  state: SimState,
  checkpoint: Checkpoint,
  endpoint?: Endpoint,
): Model {
  const id = endpoint?.id ?? seededId("model", checkpoint.id);
  const existing = labModelsOf(state, checkpoint.labId).find((model) => model.id === id);
  const family = familyFromArch(checkpoint.arch);
  const nativeWeightPrecision = nativePrecisionFromArch(checkpoint.arch.precision);
  const servePrecision = endpoint?.precision ?? servePrecisionFromArch(checkpoint.arch.precision);
  const rawCaps = endpoint
    ? compositeCapabilities(state, endpoint)
    : copyCapabilities(checkpoint.truth);
  const tiers = endpoint?.tiers ?? checkpoint.tiers;
  const lifted = applyServedTierLift(
    rawCaps,
    tiers,
    rlEffectFor(state, endpoint, checkpoint),
  );
  const capability = overallCapability(lifted.domains);
  const io = ioFromArch(checkpoint.arch, lifted);
  const modalities = modalitiesFromIo(io);
  const quality = qualityFromCaps(lifted);
  const post = highestPostTrain(checkpoint);
  const reasoningEnabled = tiers.some((tier) => tier.budget > 1 && tier.served);
  const productProfile = buildModelProductProfile({
    postTrain: post.stage,
    completedPostTrainStages: post.completed,
    postTrainStageEffectiveness: post.effectiveness,
    chatShare: checkpoint.trainingSummary.dataMix.chat ?? 0,
    chatQuality: lifted.domains.language,
    family,
    backbone: checkpoint.arch.backbone,
    reasoningEnabled,
    existing: existing?.productProfile,
  });
  const { tokPerSecMult: sizeTok, inferCostMult: sizeCost } = sizeServeMults(
    checkpoint.arch,
    family,
  );
  const costMult = endpoint ? endpointCostMultiplier(state, endpoint) : 1;
  const thinkCost = servedThinkingCostMult(tiers);
  const thinkLatency = servedThinkingLatencyMult(tiers);
  const tokPerSecMult =
    sizeTok / Math.max(0.2, precisionComputeMult(servePrecision)) / thinkLatency;
  const inferCostMult =
    sizeCost *
    precisionComputeMult(servePrecision) *
    costMult *
    thinkCost *
    contextServeCost(checkpoint.arch.contextK);
  const pricing = suggestApiInOut({
    costPerMTokBase: FALLBACK_COST_PER_MTOK,
    paramsB: checkpoint.arch.totalParamsB,
    activeParamsB: checkpoint.arch.activeParamsB,
    family,
    inferCostMult,
    capability,
    markupPct: 120,
    applyModelMult: true,
  });
  const priceIn = endpoint?.pricing.inPerMTok ?? null;
  const priceOut = endpoint?.pricing.outPerMTok ?? null;
  const live = endpoint == null || endpoint.status === "live" || endpoint.status === "sunset";
  const retired = endpoint?.status === "retired";
  const serviceProfile = serviceProfileForModel({
    paramsB: checkpoint.arch.totalParamsB,
    activeParamsB: checkpoint.arch.activeParamsB,
    family,
    backbone: checkpoint.arch.backbone,
    productPreset: checkpoint.arch.preset,
    io,
    modalities,
    tokPerSecMult,
    capability,
    nativeWeightPrecision,
  });
  const model: Model = {
    id,
    lineageId: checkpoint.lineageId,
    parentModelId: checkpoint.parentId,
    name: endpoint?.name ?? checkpoint.name,
    family,
    paramsB: checkpoint.arch.totalParamsB,
    activeParamsB: checkpoint.arch.activeParamsB,
    contextK: checkpoint.arch.contextK ?? TRAINING_V4.context.baseK,
    backbone: checkpoint.arch.backbone,
    productPreset: checkpoint.arch.preset,
    io,
    capability,
    capabilities: lifted,
    modalities,
    quality,
    benchmarks: benchmarksFromCaps(lifted, productProfile.personality),
    productProfile,
    postTrain: post.stage,
    completedPostTrainStages: post.completed,
    postTrainStageEffectiveness: post.effectiveness,
    trainComputeSpent: checkpoint.trainingSummary.pfDays,
    economics: existing?.economics ?? emptyEconomics(),
    releaseDay: endpoint?.releaseDay ?? checkpoint.createdDay,
    shipped: true,
    release: "released",
    archived: retired,
    commerciallyOffered: live && !retired,
    tokPerSecMult,
    inferCostMult,
    serviceProfile,
    apiPricePerMTok:
      priceIn == null && priceOut == null ? null : blendApiPrice(priceIn ?? pricing.priceIn, priceOut ?? pricing.priceOut),
    apiPriceInPerMTok: priceIn,
    apiPriceOutPerMTok: priceOut,
    suggestedApiPrice: pricing.blendedPrice,
    suggestedApiPriceIn: pricing.priceIn,
    suggestedApiPriceOut: pricing.priceOut,
    costApiPriceIn: pricing.costIn,
    costApiPriceOut: pricing.costOut,
    distilled: !!checkpoint.trainingSummary.distilledFrom,
    teacherId: checkpoint.trainingSummary.distilledFrom,
    trainMode: trainModeOf(checkpoint),
    openWeights: endpoint?.openWeights ?? false,
    reasoningEnabled,
    revision: existing?.revision ?? 1,
    versionLabel: checkpoint.version,
    nativeWeightPrecision,
    endpointId: endpoint?.id,
    v4CheckpointId: (endpoint ? primaryMember(endpoint)?.checkpointId : undefined) ?? checkpoint.id,
    routerMembers:
      endpoint && endpoint.policy !== "single"
        ? endpoint.members.map((member) => member.checkpointId)
        : endpoint
          ? [checkpoint.id]
          : undefined,
    sunsetDemandMult: endpoint ? sunsetDemandMultiplier(endpoint, state.day) : undefined,
  };
  return mergeRuntime(existing, normalizeModelEvaluations(model));
}

export function projectEndpointsToModels(state: SimState, labId: LabId): SimState {
  const training = trainingStateOf(state, labId);
  const previous = labModelsOf(state, labId);
  const kept = previous.filter((model) => !model.endpointId);
  const projected: Model[] = [];
  for (const endpoint of training.endpoints) {
    const primaryId = primaryMember(endpoint)?.checkpointId;
    const checkpoint = training.checkpoints.find((c) => c.id === primaryId);
    if (!checkpoint) continue;
    const prev = previous.find((model) => model.id === endpoint.id);
    projected.push(mergeRuntime(prev, modelFromCheckpoint(state, checkpoint, endpoint)));
  }
  return withLabModels(state, labId, [...kept, ...projected]);
}

export function findEndpoint(
  state: SimState,
  endpointId: string,
): { labId: LabId; endpoint: Endpoint } | undefined {
  const labs: LabId[] = [state.playerLabId, ...state.rivals.map((rival) => rival.id)];
  for (const labId of labs) {
    const endpoint = trainingStateOf(state, labId).endpoints.find((e) => e.id === endpointId);
    if (endpoint) return { labId, endpoint };
  }
  return undefined;
}

export function withEndpoint(
  state: SimState,
  labId: LabId,
  endpointId: string,
  patch: (endpoint: Endpoint) => Endpoint,
): SimState {
  const training = trainingStateOf(state, labId);
  const next = {
    ...training,
    endpoints: training.endpoints.map((endpoint) =>
      endpoint.id === endpointId ? patch(endpoint) : endpoint,
    ),
  };
  return projectEndpointsToModels(withTrainingState(state, labId, next), labId);
}
