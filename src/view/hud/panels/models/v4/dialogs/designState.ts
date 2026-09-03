import { DATA_DOMAIN_META, DATA_DOMAINS } from "../../../../../../sim/balance/data";
import { availableDomainTokens } from "../../../../../../sim/training/dataBridge";
import {
  CONTEXT_STOPS,
  contextUnlockFor,
  maxContextKForUnlocks,
} from "../../../../../../sim/training/compute";
import { modifiersForLab } from "../../../../../../sim/training/modifiers";
import { stripStageSuffix } from "../../../../../../sim/training/naming";
import { defaultArchitecture, defaultDesign, trainingStateOf } from "../../../../../../sim/training/state";
import type {
  Architecture,
  Checkpoint,
  ComputeSource,
  DataAllocation,
  Forecast,
  ModelDesign,
  ModelGoal,
  TrainPrecision,
  TrainingUnlock,
} from "../../../../../../sim/training/types";
import type {
  DataDomain,
  ModelProductPreset,
  ServePrecision,
  SimState,
} from "../../../../../../sim/types";
import { continueRunName, generateUniqueModelName } from "../../../../modelNaming";

export const DESIGN_STEPS = [
  { id: "goal", label: "Type" },
  { id: "architecture", label: "Architecture" },
  { id: "data", label: "Data" },
  { id: "launch", label: "Launch" },
] as const;

export type DesignStep = (typeof DESIGN_STEPS)[number]["id"];

export function workflowSteps(design: ModelDesign): ReadonlyArray<(typeof DESIGN_STEPS)[number]> {
  if (design.mode.kind === "continue") {
    return DESIGN_STEPS.filter((step) => step.id !== "architecture");
  }
  return DESIGN_STEPS;
}

export const SIZE_STOPS = [0.07, 0.5, 1, 3, 7, 13, 30, 70, 180, 400, 1000, 2000] as const;
export const SIZE_MIN = 0.05;
export const SIZE_MAX = 2000;
export const SIZE_SLIDER_STOPS: ReadonlyArray<{ label: string; paramsB: number }> = [
  { label: "70M", paramsB: 0.07 },
  { label: "500M", paramsB: 0.5 },
  { label: "1B", paramsB: 1 },
  { label: "3B", paramsB: 3 },
  { label: "7B", paramsB: 7 },
  { label: "13B", paramsB: 13 },
  { label: "30B", paramsB: 30 },
  { label: "70B", paramsB: 70 },
  { label: "180B", paramsB: 180 },
  { label: "400B", paramsB: 400 },
  { label: "1T", paramsB: 1000 },
  { label: "2T", paramsB: 2000 },
];

export const TOKENS_PER_PARAM_PRESETS = [5, 20, 50, 100] as const;
export const TOKENS_PER_PARAM_FLOOR = TOKENS_PER_PARAM_PRESETS[0] ?? 5;
export const MOE_ACTIVE_MIN = 0.05;
export const MOE_ACTIVE_MAX = 0.35;
export const MOE_ACTIVE_DEFAULT = 0.1;
export const HOLDOUT_MIN = 0.01;
export const HOLDOUT_MAX = 0.1;
export { CONTEXT_STOPS };

export const PRECISION_CHIPS: ReadonlyArray<{
  id: TrainPrecision;
  label: string;
  unlock?: TrainingUnlock;
}> = [
  { id: "fp32", label: "FP32" },
  { id: "fp16_mixed", label: "FP16", unlock: "fp16_train" },
  { id: "bf16_mixed", label: "BF16", unlock: "bf16_train" },
  { id: "fp8_hybrid", label: "FP8", unlock: "fp8_train" },
  { id: "fp6", label: "FP6", unlock: "fp6_train" },
  { id: "nvfp4", label: "NVFP4", unlock: "nvfp4_train" },
];

export const PRESET_CHIPS: ReadonlyArray<{
  id: ModelProductPreset;
  label: string;
  unlock?: TrainingUnlock;
}> = [
  { id: "language", label: "Language" },
  { id: "vision_language", label: "Vision-language", unlock: "vision" },
  { id: "audio", label: "Audio", unlock: "audio" },
  { id: "image_generation", label: "Image gen", unlock: "vision" },
  { id: "video_generation", label: "Video gen", unlock: "video" },
  { id: "omni", label: "Omni", unlock: "omni" },
];

export const PRESET_IO: Record<
  ModelProductPreset,
  { inputs: Architecture["inputs"]; outputs: Architecture["outputs"] }
> = {
  language: { inputs: ["text"], outputs: ["text"] },
  vision_language: { inputs: ["text", "image"], outputs: ["text"] },
  audio: { inputs: ["text", "audio"], outputs: ["text", "audio"] },
  image_generation: { inputs: ["text", "image"], outputs: ["image"] },
  video_generation: { inputs: ["text", "image", "video"], outputs: ["video"] },
  omni: {
    inputs: ["text", "image", "audio", "video"],
    outputs: ["text", "image", "audio", "video"],
  },
};

export type AiTypeId = ModelProductPreset;

export const AI_TYPE_CARDS: ReadonlyArray<{
  id: AiTypeId;
  label: string;
  blurb: string;
  unlock?: TrainingUnlock;
}> = [
  {
    id: "language",
    label: "LLM",
    blurb: "Text in, text out. Optional image or video input.",
  },
  {
    id: "image_generation",
    label: "Image generation",
    blurb: "Prompt to image. Own image demand and evals.",
    unlock: "vision",
  },
  {
    id: "audio",
    label: "Music generation",
    blurb: "Audio in and out. Own audio demand and evals.",
    unlock: "audio",
  },
  {
    id: "video_generation",
    label: "Video generation",
    blurb: "Prompt to video. Own video demand and evals.",
    unlock: "video",
  },
  {
    id: "omni",
    label: "Omni",
    blurb: "Anything in, anything out. Own omni demand and evals.",
    unlock: "omni",
  },
];

export const LLM_INPUT_EXTRAS: ReadonlyArray<{
  id: "image" | "video";
  label: string;
  blurb: string;
  unlock: TrainingUnlock;
}> = [
  { id: "image", label: "Image input", blurb: "See images, still write text.", unlock: "vision" },
  { id: "video", label: "Video input", blurb: "See video, still write text.", unlock: "video" },
];

/** Workflow under the product type. Product IO lives on `arch.preset`. */
export const GOAL_CARDS: ReadonlyArray<{
  id: ModelGoal;
  label: string;
  blurb: string;
  unlock?: TrainingUnlock;
}> = [
  { id: "flagship", label: "Broad", blurb: "Pretrain across your corpus." },
  { id: "specialist", label: "Specialist", blurb: "Max one domain, like coding." },
  { id: "continue", label: "Continue", blurb: "Same base, more data. Mix stays on the spider.", unlock: "continued_pretrain" },
  { id: "distill", label: "Distill", blurb: "Student from a kept or released teacher.", unlock: "distill" },
];

export type ContinueFocus = "more_data" | DataDomain;

export const CONTINUE_INTENT_CARDS: ReadonlyArray<{
  id: ContinueFocus;
  label: string;
  blurb: string;
}> = [
  {
    id: "more_data",
    label: "More data",
    blurb: "Keep the current mix. Add more tokens to the checkpoint.",
  },
  ...DATA_DOMAINS.map((domain) => ({
    id: domain,
    label: DATA_DOMAIN_META[domain].label,
    blurb: `Fix ${DATA_DOMAIN_META[domain].label.toLowerCase()}. Extra tokens go into this domain.`,
  })),
];

export const UNLOCK_LABELS: Record<TrainingUnlock, string> = {
  moe: "Mixture of experts",
  omni: "Omni models",
  vision: "Vision",
  audio: "Audio",
  video: "Video",
  context_32k: "32k context",
  long_context: "Long context",
  context_1m: "Million-token context",
  context_10m: "10M context",
  context_100m: "100M context",
  fp16_train: "FP16 training",
  bf16_train: "BF16 training",
  fp8_train: "FP8 training",
  fp6_train: "FP6 training",
  nvfp4_train: "NVFP4 training",
  distill: "Distillation",
  merge: "Checkpoint merge",
  thinking_tiers: "Thinking tiers",
  router_domain: "Domain router",
  router_cascade: "Cascade router",
  continued_pretrain: "Continued pretraining",
  verifier: "Verifier",
};

/** Forecast blocker codes that do not match the unlock id 1:1. */
const BLOCKER_UNLOCK: Record<string, TrainingUnlock> = {
  locked_moe: "moe",
  locked_fp16: "fp16_train",
  locked_bf16: "bf16_train",
  locked_fp8: "fp8_train",
  locked_fp6: "fp6_train",
  locked_nvfp4: "nvfp4_train",
  locked_omni: "omni",
  locked_vision: "vision",
  locked_audio: "audio",
  locked_video: "video",
  locked_distill: "distill",
  locked_long_context: "long_context",
  locked_continued_pretrain: "continued_pretrain",
};

export function unlockFromBlockerCode(code: string): TrainingUnlock | null {
  const mapped = BLOCKER_UNLOCK[code];
  if (mapped) return mapped;
  if (!code.startsWith("locked_")) return null;
  const rest = code.slice("locked_".length);
  if (rest in UNLOCK_LABELS) return rest as TrainingUnlock;
  return null;
}

export function hasTrainingUnlock(state: SimState, unlock: TrainingUnlock): boolean {
  try {
    return modifiersForLab(state, state.playerLabId).unlocks.includes(unlock);
  } catch {
    return false;
  }
}

export function lockLabel(unlock: TrainingUnlock): string {
  return `Research ${UNLOCK_LABELS[unlock]} first`;
}

export function optionLockReason(
  unlock: TrainingUnlock | undefined,
  state: SimState,
): string | null {
  if (!unlock) return null;
  return hasTrainingUnlock(state, unlock) ? null : lockLabel(unlock);
}

export function goalLockReason(
  goal: ModelGoal,
  state: SimState,
  opts: PresetOpts = {},
): string | null {
  const checkpoints = trainingStateOf(state, state.playerLabId).checkpoints;
  if (goal === "distill" && !bestTeacher(checkpoints)) {
    return "Keep or release a checkpoint first.";
  }
  if (goal === "continue") {
    const parent =
      checkpointById(state, opts.parentCheckpointId)
      ?? bestContinueParent(checkpoints, opts.keepArch);
    if (!parent) {
      if (
        opts.keepArch
        && continueParentsFor(checkpoints).length > 0
        && continueParentsFor(checkpoints, opts.keepArch).length === 0
      ) {
        return "Keep or release a checkpoint of this type first.";
      }
      if (checkpoints.some((checkpoint) => CONTINUE_READY.has(checkpoint.status))) {
        return "Post-trained weights can only take more post-training.";
      }
      return "Keep or release a checkpoint first.";
    }
    if (parent.stage === "post") {
      return "Post-trained weights can only take more post-training.";
    }
  }
  if (goal === "multimodal") return optionLockReason("vision", state);
  if (goal === "omni") return optionLockReason("omni", state);
  const card = GOAL_CARDS.find((row) => row.id === goal);
  if (card?.unlock) {
    const research = optionLockReason(card.unlock, state);
    if (research) return research;
  }
  return null;
}

export const TRAIN_TO_SERVE: Record<TrainPrecision, ServePrecision> = {
  fp32: "fp32",
  fp16_mixed: "fp16",
  bf16_mixed: "bf16",
  fp8_hybrid: "fp8",
  fp6: "fp6",
  nvfp4: "nvfp4",
};

export const SERVE_BYTES_PER_PARAM: Record<ServePrecision, number> = {
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8: 1,
  fp6: 0.75,
  int8: 1,
  int4: 0.5,
  nvfp4: 0.5,
  ternary_1_58: 0.2,
};

export const QUANT_OPTIONS: ReadonlyArray<{
  id: ServePrecision;
  label: string;
  note: string;
}> = [
  { id: "fp8", label: "FP8", note: "gap +0.07 vs BF16" },
  { id: "fp6", label: "FP6", note: "gap +0.11 vs BF16" },
  { id: "int8", label: "INT8", note: "integer quant, small quality cost" },
  { id: "nvfp4", label: "NVFP4", note: "gap +0.16 vs BF16" },
];

export const CORE_EVAL_METRICS = [
  "overall",
  "language",
  "reasoning",
  "code",
  "math",
  "science",
] as const;

export interface DesignUiState {
  step: DesignStep;
  design: ModelDesign;
  tokensPerParam: number;
  launchError: string | null;
  nameDirty: boolean;
  continueFocus: ContinueFocus;
}

export type DesignAction =
  | {
      type: "hydrate";
      design: ModelDesign;
      tokensPerParam?: number;
      step?: DesignStep;
      nameDirty?: boolean;
      continueFocus?: ContinueFocus;
    }
  | { type: "setStep"; step: DesignStep }
  | { type: "applyPreset"; design: ModelDesign }
  | {
      type: "setContinueFocus";
      focus: ContinueFocus;
      domainMTok: Partial<Record<DataDomain, number>>;
    }
  | { type: "setSize"; totalParamsB: number }
  | { type: "setBackbone"; backbone: Architecture["backbone"] }
  | { type: "setActiveFraction"; fraction: number }
  | { type: "setPrecision"; precision: TrainPrecision }
  | { type: "setPreset"; preset: ModelProductPreset }
  | { type: "setAiType"; preset: ModelProductPreset; imageIn?: boolean; videoIn?: boolean }
  | { type: "setLlmInput"; extra: "image" | "video"; enabled: boolean }
  | { type: "setTeacher"; teacherCheckpointId: string; name?: string }
  | { type: "setTeacherSynthShare"; share: number }
  | { type: "setContext"; contextK: number }
  | { type: "setDomain"; domain: DataDomain; mtok: number }
  | { type: "setFocusDomain"; domain: DataDomain }
  | { type: "setTokensPerParam"; tokensPerParam: number }
  | { type: "setHoldout"; share: number }
  | { type: "setName"; name: string }
  | { type: "setPriority"; priority: number }
  | { type: "setSource"; source: ComputeSource }
  | { type: "setPfPerDay"; pfPerDay: number }
  | { type: "setLaunchError"; error: string | null };

export type DomainAvailability = Partial<
  Record<
    DataDomain,
    {
      uniqueMTok: number;
      quality: number;
      syntheticShare: number;
      syntheticDepth: number;
      verifiedShare: number;
    }
  >
>;

export function availableTokensOf(state: SimState): DomainAvailability {
  try {
    return availableDomainTokens(state, state.playerLabId);
  } catch {
    return {};
  }
}

export function snapSize(paramsB: number): number {
  const clamped = Math.min(SIZE_MAX, Math.max(SIZE_MIN, paramsB));
  let best: number = SIZE_STOPS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const stop of SIZE_STOPS) {
    const dist = Math.abs(Math.log(stop + 1e-9) - Math.log(clamped + 1e-9));
    if (dist < bestDist) {
      bestDist = dist;
      best = stop;
    }
  }
  return best;
}

export function clampActiveFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return MOE_ACTIVE_DEFAULT;
  return Math.min(MOE_ACTIVE_MAX, Math.max(MOE_ACTIVE_MIN, fraction));
}

export function activeFractionOf(arch: Architecture): number {
  if (arch.backbone !== "moe" || !(arch.totalParamsB > 0)) return 1;
  return clampActiveFraction(arch.activeParamsB / arch.totalParamsB);
}

export function withSize(arch: Architecture, totalParamsB: number): Architecture {
  const snapped = snapSize(totalParamsB);
  if (arch.backbone === "moe") {
    return {
      ...arch,
      totalParamsB: snapped,
      activeParamsB: snapped * activeFractionOf(arch),
    };
  }
  return { ...arch, totalParamsB: snapped, activeParamsB: snapped };
}

export function withBackbone(
  arch: Architecture,
  backbone: Architecture["backbone"],
  fraction = MOE_ACTIVE_DEFAULT,
): Architecture {
  if (backbone === "dense") {
    return { ...arch, backbone: "dense", activeParamsB: arch.totalParamsB };
  }
  const f = clampActiveFraction(fraction);
  return { ...arch, backbone: "moe", activeParamsB: arch.totalParamsB * f };
}

export function withPreset(arch: Architecture, preset: ModelProductPreset): Architecture {
  const io = PRESET_IO[preset];
  return { ...arch, preset, inputs: io.inputs, outputs: io.outputs };
}

export function withLlmInputs(
  arch: Architecture,
  extras: { image?: boolean; video?: boolean },
): Architecture {
  const inputs: Architecture["inputs"] = ["text"];
  if (extras.image) inputs.push("image");
  if (extras.video) inputs.push("video");
  const preset: ModelProductPreset = extras.image || extras.video ? "vision_language" : "language";
  return { ...arch, preset, inputs, outputs: ["text"] };
}

export function aiTypeOf(arch: Architecture): AiTypeId {
  if (arch.preset === "vision_language") return "language";
  return arch.preset;
}

export function llmInputEnabled(arch: Architecture, extra: "image" | "video"): boolean {
  if (aiTypeOf(arch) !== "language") return false;
  return arch.inputs.includes(extra);
}

export function aiTypeLockReason(type: AiTypeId, state: SimState): string | null {
  const card = AI_TYPE_CARDS.find((row) => row.id === type);
  return optionLockReason(card?.unlock, state);
}

export function overlayProduct(arch: Architecture, product: Architecture): Architecture {
  return {
    ...arch,
    preset: product.preset,
    inputs: [...product.inputs],
    outputs: [...product.outputs],
  };
}

export function specialistFocusFor(
  arch: Architecture,
  available: DomainAvailability,
): DataDomain {
  if (arch.preset === "image_generation") return "image";
  if (arch.preset === "audio") return "audio";
  if (arch.preset === "video_generation") return "video";
  return focusedDomain(available);
}

export function focusMixOnDomain(
  domainMTok: Partial<Record<DataDomain, number>>,
  domain: DataDomain,
): Partial<Record<DataDomain, number>> {
  const total = sumDomainMTok(domainMTok);
  return total > 0 ? { [domain]: total } : { [domain]: 0 };
}

export function specialistDomainOf(
  domainMTok: Partial<Record<DataDomain, number>>,
): DataDomain | undefined {
  const entries = DATA_DOMAINS.filter((domain) => (domainMTok[domain] ?? 0) > 0);
  return entries.length === 1 ? entries[0] : undefined;
}

function clampShare(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const DEFAULT_TEACHER_SYNTH_SHARE = 0.5;

export function tokensToMTok(tokensPerParam: number, totalParamsB: number): number {
  return Math.max(0, tokensPerParam) * Math.max(0, totalParamsB) * 1000;
}

/** Unique tokens ÷ parameters. 1 tok/param on a 7B model is 7,000 MTok. */
export function maxTokensPerParam(uniqueMTok: number, totalParamsB: number): number {
  const denom = Math.max(0, totalParamsB) * 1000;
  if (!(denom > 0)) return 0;
  return Math.max(0, uniqueMTok) / denom;
}

export function affordableTokPerParam(
  uniqueMTok: number,
  totalParamsB: number,
  presets: readonly number[] = TOKENS_PER_PARAM_PRESETS,
): number {
  const floor = presets[0] ?? TOKENS_PER_PARAM_FLOOR;
  const cap = maxTokensPerParam(uniqueMTok, totalParamsB);
  let best = floor;
  for (const preset of presets) {
    if (preset <= cap + 1e-9) best = preset;
  }
  return best;
}

export function formatTokPerParam(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) return "0";
  if (isPresetTokPerParam(value)) return String(value);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

export function isPresetTokPerParam(value: number): boolean {
  return TOKENS_PER_PARAM_PRESETS.some((preset) => Math.abs(preset - value) < 1e-6);
}

/** True when the run is spending every unique token (and that isn't already a preset chip). */
export function isMaxTokPerParamSelected(current: number, cap: number): boolean {
  if (!(cap > 0) || !Number.isFinite(current)) return false;
  if (isPresetTokPerParam(cap) && isPresetTokPerParam(current)) return false;
  return Math.abs(current - cap) <= 1e-4;
}

/**
 * Snap a tok/param choice when unique tokens shrink.
 * The floor preset may oversample. Max (the unique cap) is always kept.
 */
export function clampTokPerParam(
  requested: number,
  uniqueMTok: number,
  totalParamsB: number,
): number {
  const floor = TOKENS_PER_PARAM_FLOOR;
  const cap = maxTokensPerParam(uniqueMTok, totalParamsB);
  if (!(requested > 0) || !Number.isFinite(requested)) return floor;
  if (requested <= floor + 1e-9) return requested;
  if (requested <= cap + 1e-9) return requested;
  return cap >= floor ? cap : floor;
}

export function tokPerParamLockReason(
  value: number,
  uniqueMTok: number,
  totalParamsB: number,
): string | null {
  const floor = TOKENS_PER_PARAM_FLOOR;
  if (value <= floor) return null;
  const need = tokensToMTok(value, totalParamsB);
  if (need <= uniqueMTok + 1e-6) return null;
  return `Need ${formatMTok(need)} unique for ${value} tok/param; you have ${formatMTok(uniqueMTok)}.`;
}

export function tokPerParamMaxLockReason(uniqueMTok: number): string | null {
  if (uniqueMTok > 0) return null;
  return "No unique tokens yet.";
}

export function tokensPerParamOf(design: ModelDesign): number {
  const denom = design.arch.totalParamsB * 1000;
  if (!(denom > 0)) return TRAINING_TOKENS_DEFAULT;
  const raw = sumDomainMTok(design.data.domainMTok);
  return raw / denom;
}

const TRAINING_TOKENS_DEFAULT = 20;

export function sumDomainMTok(domainMTok: Partial<Record<DataDomain, number>>): number {
  let total = 0;
  for (const value of Object.values(domainMTok)) {
    if (typeof value === "number" && value > 0) total += value;
  }
  return total;
}

export function scaleDomainMix(
  domainMTok: Partial<Record<DataDomain, number>>,
  tokensPerParam: number,
  totalParamsB: number,
): Partial<Record<DataDomain, number>> {
  const target = tokensToMTok(tokensPerParam, totalParamsB);
  const current = sumDomainMTok(domainMTok);
  if (!(target > 0)) return {};
  if (!(current > 0)) return domainMTok;
  const scale = target / current;
  const next: Partial<Record<DataDomain, number>> = {};
  for (const domain of DATA_DOMAINS) {
    const value = domainMTok[domain];
    if (typeof value === "number" && value > 0) {
      next[domain] = value * scale;
    }
  }
  return next;
}

export function mixProportions(
  domainMTok: Partial<Record<DataDomain, number>>,
): Partial<Record<DataDomain, number>> {
  const total = sumDomainMTok(domainMTok);
  if (!(total > 0)) return {};
  const next: Partial<Record<DataDomain, number>> = {};
  for (const domain of DATA_DOMAINS) {
    const value = domainMTok[domain];
    if (typeof value === "number" && value > 0) next[domain] = value / total;
  }
  return next;
}

/**
 * Mix share where `domainVectorFor` saturates specialist affinity (`share / 0.15`).
 * Domains at or above this start pulling the model toward a specialist.
 */
export const SPECIALIST_MIX_SHARE = 0.15;

export function specialistPullDomains(
  domainMTok: Partial<Record<DataDomain, number>>,
): DataDomain[] {
  const shares = mixProportions(domainMTok);
  return DATA_DOMAINS.filter((domain) => (shares[domain] ?? 0) >= SPECIALIST_MIX_SHARE);
}

export function epochsFor(requestedMTok: number, availableMTok: number): number {
  if (!(availableMTok > 0) || !(requestedMTok > 0)) return 1;
  return requestedMTok / availableMTok;
}

export function totalUniqueMTok(available: DomainAvailability): number {
  let total = 0;
  for (const row of Object.values(available)) {
    if (row && row.uniqueMTok > 0) total += row.uniqueMTok;
  }
  return total;
}

function focusedDomain(available: DomainAvailability): DataDomain {
  let best: DataDomain = "code";
  let bestTokens = -1;
  for (const domain of DATA_DOMAINS) {
    const unique = available[domain]?.uniqueMTok ?? 0;
    if (unique > bestTokens) {
      bestTokens = unique;
      best = domain;
    }
  }
  return best;
}

function mixFromAvailable(
  available: DomainAvailability,
  totalMTok: number,
  focus?: DataDomain,
): Partial<Record<DataDomain, number>> {
  if (!(totalMTok > 0)) return {};
  if (focus) return { [focus]: totalMTok };
  const weights: Partial<Record<DataDomain, number>> = {};
  let weightSum = 0;
  for (const domain of DATA_DOMAINS) {
    const unique = available[domain]?.uniqueMTok ?? 0;
    if (unique > 0) {
      weights[domain] = unique;
      weightSum += unique;
    }
  }
  if (!(weightSum > 0)) {
    const even = totalMTok / DATA_DOMAINS.length;
    const next: Partial<Record<DataDomain, number>> = {};
    for (const domain of DATA_DOMAINS) next[domain] = even;
    return next;
  }
  const next: Partial<Record<DataDomain, number>> = {};
  for (const domain of DATA_DOMAINS) {
    const w = weights[domain];
    if (w && w > 0) next[domain] = (w / weightSum) * totalMTok;
  }
  return next;
}

export function extraDataForContinue(
  available: DomainAvailability,
  arch: Architecture,
  parent: Checkpoint | undefined,
  focus: ContinueFocus,
): Partial<Record<DataDomain, number>> {
  const totalMTok = tokensToMTok(5, arch.totalParamsB);
  if (focus !== "more_data") {
    return mixFromAvailable(available, totalMTok, focus);
  }
  const mix = parent?.trainingSummary.dataMix;
  if (mix) {
    const next: Partial<Record<DataDomain, number>> = {};
    let shareSum = 0;
    for (const domain of DATA_DOMAINS) {
      const share = mix[domain];
      if (typeof share === "number" && share > 0) {
        next[domain] = share;
        shareSum += share;
      }
    }
    if (shareSum > 0) {
      for (const domain of DATA_DOMAINS) {
        const share = next[domain];
        if (typeof share === "number") next[domain] = (share / shareSum) * totalMTok;
      }
      return next;
    }
  }
  return mixFromAvailable(available, totalMTok);
}

function biggestAffordableParamsB(available: DomainAvailability, tokensPerParam: number): number {
  const unique = totalUniqueMTok(available);
  if (!(unique > 0) || !(tokensPerParam > 0)) return 70;
  const affordable = unique / (tokensPerParam * 1000);
  return snapSize(Math.min(70, Math.max(SIZE_MIN, affordable)));
}

function byTeacherRank(a: Checkpoint, b: Checkpoint): number {
  if (a.status !== b.status) return a.status === "released" ? -1 : 1;
  if (a.arch.totalParamsB !== b.arch.totalParamsB) {
    return b.arch.totalParamsB - a.arch.totalParamsB;
  }
  return b.createdDay - a.createdDay;
}

function byContinueRank(a: Checkpoint, b: Checkpoint): number {
  if (a.status !== b.status) {
    if (a.status === "released") return -1;
    if (b.status === "released") return 1;
  }
  if (a.arch.totalParamsB !== b.arch.totalParamsB) {
    return b.arch.totalParamsB - a.arch.totalParamsB;
  }
  return b.createdDay - a.createdDay;
}

export function distillTeachers(checkpoints: Checkpoint[]): Checkpoint[] {
  return checkpoints
    .filter((checkpoint) => checkpoint.status === "kept" || checkpoint.status === "released")
    .sort(byTeacherRank);
}

export function bestTeacher(checkpoints: Checkpoint[]): Checkpoint | undefined {
  return distillTeachers(checkpoints)[0];
}

const CONTINUE_READY = new Set(["kept", "released", "stealth"]);

export function continueParentsFor(
  checkpoints: Checkpoint[],
  match?: Architecture,
): Checkpoint[] {
  const eligible = checkpoints
    .filter((checkpoint) => checkpoint.stage !== "post" && CONTINUE_READY.has(checkpoint.status))
    .sort(byContinueRank);
  if (!match) return eligible;
  return eligible.filter((row) => aiTypeOf(row.arch) === aiTypeOf(match));
}

export function bestContinueParent(
  checkpoints: Checkpoint[],
  match?: Architecture,
): Checkpoint | undefined {
  return continueParentsFor(checkpoints, match)[0];
}

export function checkpointById(state: SimState, id: string | undefined): Checkpoint | undefined {
  if (!id) return undefined;
  return trainingStateOf(state, state.playerLabId).checkpoints.find((row) => row.id === id);
}

export interface PresetOpts {
  parentCheckpointId?: string;
  teacherCheckpointId?: string;
  copyFromEndpointId?: string;
  continueFocus?: ContinueFocus;
  keepArch?: Architecture;
  teacherSynthShare?: number;
}

function copyName(name: string): string {
  const trimmed = name.trim() || "Untitled";
  return / copy$/i.test(trimmed) ? trimmed : `${trimmed} copy`;
}

function pushOccupiedName(names: { name: string }[], value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  names.push({ name: trimmed });
  const stripped = stripStageSuffix(trimmed);
  if (stripped && stripped !== trimmed) names.push({ name: stripped });
}

/** Names already used by models, runs, checkpoints, and endpoints. */
export function occupiedRunNames(state: SimState): { name: string }[] {
  const names: { name: string }[] = [];
  pushOccupiedName(names, state.player.trainingJob?.name);
  for (const model of state.player.models) pushOccupiedName(names, model.name);
  const playerTraining = trainingStateOf(state, state.playerLabId);
  for (const run of playerTraining.runs) pushOccupiedName(names, run.design.name);
  for (const checkpoint of playerTraining.checkpoints) pushOccupiedName(names, checkpoint.name);
  for (const endpoint of playerTraining.endpoints) pushOccupiedName(names, endpoint.name);
  for (const rival of state.rivals) {
    for (const model of rival.models) pushOccupiedName(names, model.name);
    const rivalTraining = rival.training;
    if (!rivalTraining) continue;
    for (const run of rivalTraining.runs) pushOccupiedName(names, run.design.name);
    for (const checkpoint of rivalTraining.checkpoints) pushOccupiedName(names, checkpoint.name);
    for (const endpoint of rivalTraining.endpoints) pushOccupiedName(names, endpoint.name);
  }
  return names;
}

function freshRunName(state: SimState, avoid?: string): string {
  return generateUniqueModelName({ playerModels: occupiedRunNames(state) }, { avoid });
}

function continueNameFor(parentName: string | undefined, state: SimState): string {
  const family = stripStageSuffix(parentName?.trim() ?? "");
  if (!family) return freshRunName(state);
  return continueRunName(family, occupiedRunNames(state));
}

function pretrainGoal(goal: ModelGoal, arch: Architecture): ModelGoal {
  if (goal !== "distill" && goal !== "continue") return goal;
  if (arch.preset === "omni") return "omni";
  if (arch.preset !== "language") return "multimodal";
  if (arch.totalParamsB <= 13) return "specialist";
  return "flagship";
}

function lineageRootOf(checkpoints: Checkpoint[], start: Checkpoint): Checkpoint {
  const byId = new Map(checkpoints.map((row) => [row.id, row]));
  const seen = new Set<string>();
  let cursor = start;
  while (cursor.parentId) {
    if (seen.has(cursor.id)) break;
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    seen.add(cursor.id);
    cursor = parent;
  }
  return cursor;
}

function dataFromSummary(checkpoint: Checkpoint): DataAllocation {
  const mix = checkpoint.trainingSummary.dataMix;
  const total = checkpoint.trainingSummary.effectiveMTok;
  const domainMTok: Partial<Record<DataDomain, number>> = {};
  if (total > 0) {
    for (const domain of DATA_DOMAINS) {
      const share = mix[domain];
      if (typeof share === "number" && share > 0) {
        domainMTok[domain] = share * total;
      }
    }
  }
  return { domainMTok, holdoutShare: 0.05 };
}

export function trainedDomainMTok(
  checkpoint: Checkpoint | undefined,
): Partial<Record<DataDomain, number>> {
  if (!checkpoint) return {};
  return dataFromSummary(checkpoint).domainMTok;
}

function cloneArch(arch: Architecture): Architecture {
  return {
    ...arch,
    inputs: [...arch.inputs],
    outputs: [...arch.outputs],
  };
}

function asFreshPretrain(source: ModelDesign, name: string, day: number, id: string): ModelDesign {
  return {
    ...source,
    id,
    name,
    goal: pretrainGoal(source.goal, source.arch),
    arch: cloneArch(source.arch),
    data: {
      domainMTok: { ...source.data.domainMTok },
      holdoutShare: source.data.holdoutShare,
    },
    compute: { ...source.compute },
    mode: { kind: "pretrain" },
    createdDay: day,
  };
}

/** Walk to the lineage root and clone its pretrain recipe (arch + data mix). */
export function copyFormulaFromCheckpoint(
  state: SimState,
  checkpointId: string,
): ModelDesign | null {
  const training = trainingStateOf(state, state.playerLabId);
  const start = training.checkpoints.find((row) => row.id === checkpointId);
  if (!start) return null;
  const root = lineageRootOf(training.checkpoints, start);
  const run =
    (root.runId ? training.runs.find((row) => row.id === root.runId) : undefined) ??
    training.runs.find(
      (row) => row.finalCheckpointId === root.id || row.checkpointIds.includes(root.id),
    );
  const id = `design-copy-${root.id}`;
  if (run) {
    return asFreshPretrain(run.design, copyName(run.design.name || root.name), state.day, id);
  }
  const fallback = defaultDesign(state.day);
  return asFreshPretrain(
    {
      ...fallback,
      name: root.name,
      arch: cloneArch(root.arch),
      data: dataFromSummary(root),
    },
    copyName(root.name),
    state.day,
    id,
  );
}

export function copyFormulaFromEndpoint(state: SimState, endpointId: string): ModelDesign | null {
  const training = trainingStateOf(state, state.playerLabId);
  const endpoint = training.endpoints.find((row) => row.id === endpointId);
  if (!endpoint) return null;
  const checkpointId =
    endpoint.members.find((member) => member.role === "primary")?.checkpointId ??
    endpoint.members[0]?.checkpointId;
  if (!checkpointId) return null;
  return copyFormulaFromCheckpoint(state, checkpointId);
}

export function presetFor(goal: ModelGoal, state: SimState, opts: PresetOpts = {}): ModelDesign {
  const available = availableTokensOf(state);
  const training = trainingStateOf(state, state.playerLabId);
  const day = state.day;
  const base = defaultDesign(day);
  const teacher =
    checkpointById(state, opts.teacherCheckpointId) ?? bestTeacher(training.checkpoints);
  const parent =
    checkpointById(state, opts.parentCheckpointId)
    ?? bestContinueParent(training.checkpoints, opts.keepArch);
  const keepProduct = (arch: Architecture) =>
    opts.keepArch ? overlayProduct(arch, opts.keepArch) : arch;

  if (goal === "specialist") {
    const arch = keepProduct(withSize(defaultArchitecture(), 7));
    const tokensPerParam = 20;
    const focus = specialistFocusFor(arch, available);
    return {
      ...base,
      name: freshRunName(state),
      goal,
      arch,
      data: {
        domainMTok: mixFromAvailable(available, tokensToMTok(tokensPerParam, arch.totalParamsB), focus),
        holdoutShare: 0.05,
      },
      mode: { kind: "pretrain" },
    };
  }

  if (goal === "flagship") {
    const tokensPerParam = 20;
    const arch = keepProduct(
      withSize(defaultArchitecture(), biggestAffordableParamsB(available, tokensPerParam)),
    );
    return {
      ...base,
      name: freshRunName(state),
      goal,
      arch,
      data: {
        domainMTok: mixFromAvailable(available, tokensToMTok(tokensPerParam, arch.totalParamsB)),
        holdoutShare: 0.05,
      },
      mode: { kind: "pretrain" },
    };
  }

  if (goal === "distill") {
    const arch = keepProduct(withSize(defaultArchitecture(), 7));
    const teacherShare = clampShare(opts.teacherSynthShare ?? DEFAULT_TEACHER_SYNTH_SHARE);
    return {
      ...base,
      name: teacher ? `${stripStageSuffix(teacher.name)} student` : freshRunName(state),
      goal,
      arch,
      data: {
        domainMTok: mixFromAvailable(available, tokensToMTok(20, arch.totalParamsB)),
        holdoutShare: 0.05,
        teacherSynthShare: teacherShare,
      },
      mode: { kind: "distill", teacherCheckpointId: teacher?.id ?? opts.teacherCheckpointId ?? "" },
    };
  }

  if (goal === "continue") {
    const arch = parent ? cloneArch(parent.arch) : keepProduct(defaultArchitecture());
    const extra = extraDataForContinue(
      available,
      arch,
      parent,
      opts.continueFocus ?? "more_data",
    );
    return {
      ...base,
      name: continueNameFor(parent?.name, state),
      goal,
      arch,
      data: { domainMTok: extra, holdoutShare: 0.05 },
      mode: { kind: "continue", parentCheckpointId: parent?.id ?? opts.parentCheckpointId ?? "" },
    };
  }

  if (goal === "multimodal") {
    const arch = withPreset(withSize(defaultArchitecture(), 30), "vision_language");
    const imageFocus: DataDomain = "image";
    return {
      ...base,
      name: freshRunName(state),
      goal,
      arch,
      data: {
        domainMTok: mixFromAvailable(
          available,
          tokensToMTok(20, arch.totalParamsB),
          available.image ? imageFocus : focusedDomain(available),
        ),
        holdoutShare: 0.05,
      },
      mode: { kind: "pretrain" },
    };
  }

  const arch = withPreset(
    withBackbone(withSize(defaultArchitecture(), 400), "moe", 0.1),
    "omni",
  );
  return {
    ...base,
    name: freshRunName(state),
    goal,
    arch,
    data: {
      domainMTok: mixFromAvailable(available, tokensToMTok(20, arch.totalParamsB)),
      holdoutShare: 0.05,
    },
    mode: { kind: "pretrain" },
  };
}

export function initialDesignState(
  state: SimState,
  goal?: ModelGoal,
  opts: PresetOpts = {},
): DesignUiState {
  if (opts.copyFromEndpointId) {
    const copied = copyFormulaFromEndpoint(state, opts.copyFromEndpointId);
    if (copied) {
      return {
        step: "architecture",
        design: copied,
        tokensPerParam: tokensPerParamOf(copied) || TRAINING_TOKENS_DEFAULT,
        launchError: null,
        nameDirty: false,
        continueFocus: "more_data",
      };
    }
  }
  const resolvedGoal = goal ?? "flagship";
  const design = presetFor(resolvedGoal, state, opts);
  return {
    step: "goal",
    design,
    tokensPerParam: tokensPerParamOf(design) || TRAINING_TOKENS_DEFAULT,
    launchError: null,
    nameDirty: resolvedGoal !== "continue" && resolvedGoal !== "distill",
    continueFocus: opts.continueFocus ?? "more_data",
  };
}

function patchDesign(design: ModelDesign, patch: Partial<ModelDesign>): ModelDesign {
  return { ...design, ...patch };
}

export function reduceDesign(state: DesignUiState, action: DesignAction): DesignUiState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        step: action.step ?? state.step,
        design: action.design,
        tokensPerParam: action.tokensPerParam ?? tokensPerParamOf(action.design),
        launchError: null,
        nameDirty: action.nameDirty ?? false,
        continueFocus: action.continueFocus ?? "more_data",
      };
    case "setStep":
      return { ...state, step: action.step };
    case "applyPreset": {
      const switchingIntoContinue =
        action.design.goal === "continue" && state.design.goal !== "continue";
      const name = switchingIntoContinue
        ? action.design.name
        : state.nameDirty
          ? state.design.name
          : action.design.name;
      return {
        ...state,
        design: { ...action.design, name },
        nameDirty: switchingIntoContinue ? false : state.nameDirty,
        tokensPerParam: tokensPerParamOf(action.design) || state.tokensPerParam,
        continueFocus:
          action.design.goal === "continue"
            ? switchingIntoContinue
              ? "more_data"
              : state.continueFocus
            : "more_data",
        launchError: null,
      };
    }
    case "setContinueFocus": {
      const next = patchDesign(state.design, {
        data: { ...state.design.data, domainMTok: action.domainMTok },
      });
      return {
        ...state,
        continueFocus: action.focus,
        design: next,
        tokensPerParam: tokensPerParamOf(next) || state.tokensPerParam,
      };
    }
    case "setSize": {
      const arch = withSize(state.design.arch, action.totalParamsB);
      const domainMTok = scaleDomainMix(
        state.design.data.domainMTok,
        state.tokensPerParam,
        arch.totalParamsB,
      );
      return {
        ...state,
        design: patchDesign(state.design, {
          arch,
          data: { ...state.design.data, domainMTok },
        }),
      };
    }
    case "setBackbone": {
      const fraction =
        state.design.arch.backbone === "moe"
          ? activeFractionOf(state.design.arch)
          : MOE_ACTIVE_DEFAULT;
      return {
        ...state,
        design: patchDesign(state.design, {
          arch: withBackbone(state.design.arch, action.backbone, fraction),
        }),
      };
    }
    case "setActiveFraction": {
      if (state.design.arch.backbone !== "moe") return state;
      return {
        ...state,
        design: patchDesign(state.design, {
          arch: withBackbone(state.design.arch, "moe", action.fraction),
        }),
      };
    }
    case "setPrecision":
      return {
        ...state,
        design: patchDesign(state.design, {
          arch: { ...state.design.arch, precision: action.precision },
        }),
      };
    case "setPreset":
      return {
        ...state,
        design: patchDesign(state.design, {
          arch: withPreset(state.design.arch, action.preset),
        }),
      };
    case "setAiType": {
      const arch =
        action.preset === "language"
          ? withLlmInputs(state.design.arch, {
              image: action.imageIn ?? llmInputEnabled(state.design.arch, "image"),
              video: action.videoIn ?? llmInputEnabled(state.design.arch, "video"),
            })
          : withPreset(state.design.arch, action.preset);
      let domainMTok = state.design.data.domainMTok;
      if (state.design.goal === "specialist") {
        const focus = specialistFocusFor(arch, {});
        domainMTok = focusMixOnDomain(domainMTok, focus);
        if (sumDomainMTok(domainMTok) <= 0) {
          domainMTok = { [focus]: tokensToMTok(state.tokensPerParam, arch.totalParamsB) };
        }
      }
      return {
        ...state,
        design: patchDesign(state.design, {
          arch,
          data: { ...state.design.data, domainMTok },
        }),
      };
    }
    case "setLlmInput": {
      if (aiTypeOf(state.design.arch) !== "language") return state;
      return {
        ...state,
        design: patchDesign(state.design, {
          arch: withLlmInputs(state.design.arch, {
            image:
              action.extra === "image"
                ? action.enabled
                : llmInputEnabled(state.design.arch, "image"),
            video:
              action.extra === "video"
                ? action.enabled
                : llmInputEnabled(state.design.arch, "video"),
          }),
        }),
      };
    }
    case "setTeacher": {
      if (state.design.mode.kind !== "distill") return state;
      const name =
        state.nameDirty || !action.name
          ? state.design.name
          : action.name;
      return {
        ...state,
        design: patchDesign(state.design, {
          name,
          mode: { kind: "distill", teacherCheckpointId: action.teacherCheckpointId },
        }),
      };
    }
    case "setTeacherSynthShare":
      return {
        ...state,
        design: patchDesign(state.design, {
          data: {
            ...state.design.data,
            teacherSynthShare: clampShare(action.share),
          },
        }),
      };
    case "setContext":
      return {
        ...state,
        design: patchDesign(state.design, {
          arch: { ...state.design.arch, contextK: snapContextK(action.contextK) },
        }),
      };
    case "setDomain": {
      const domainMTok = {
        ...state.design.data.domainMTok,
        [action.domain]: Math.max(0, action.mtok),
      };
      const next = patchDesign(state.design, {
        data: { ...state.design.data, domainMTok },
      });
      return {
        ...state,
        design: next,
        tokensPerParam: tokensPerParamOf(next) || state.tokensPerParam,
      };
    }
    case "setFocusDomain": {
      let domainMTok = focusMixOnDomain(state.design.data.domainMTok, action.domain);
      if (sumDomainMTok(domainMTok) <= 0) {
        domainMTok = {
          [action.domain]: tokensToMTok(state.tokensPerParam, state.design.arch.totalParamsB),
        };
      }
      const next = patchDesign(state.design, {
        data: { ...state.design.data, domainMTok },
      });
      return {
        ...state,
        design: next,
        tokensPerParam: tokensPerParamOf(next) || state.tokensPerParam,
      };
    }
    case "setTokensPerParam": {
      const tokensPerParam = action.tokensPerParam;
      const domainMTok = scaleDomainMix(
        state.design.data.domainMTok,
        tokensPerParam,
        state.design.arch.totalParamsB,
      );
      return {
        ...state,
        tokensPerParam,
        design: patchDesign(state.design, {
          data: { ...state.design.data, domainMTok },
        }),
      };
    }
    case "setHoldout": {
      const holdoutShare = Math.min(HOLDOUT_MAX, Math.max(HOLDOUT_MIN, action.share));
      return {
        ...state,
        design: patchDesign(state.design, {
          data: { ...state.design.data, holdoutShare },
        }),
      };
    }
    case "setName":
      return {
        ...state,
        nameDirty: true,
        design: patchDesign(state.design, { name: action.name }),
      };
    case "setPriority":
      return {
        ...state,
        design: patchDesign(state.design, {
          compute: {
            ...state.design.compute,
            priority: Math.min(5, Math.max(1, Math.round(action.priority))),
          },
        }),
      };
    case "setSource":
      return {
        ...state,
        design: patchDesign(state.design, {
          compute: { ...state.design.compute, source: action.source },
        }),
      };
    case "setPfPerDay":
      return {
        ...state,
        design: patchDesign(state.design, {
          compute: { ...state.design.compute, pfPerDay: Math.max(0, action.pfPerDay) },
        }),
      };
    case "setLaunchError":
      return { ...state, launchError: action.error };
    default:
      return state;
  }
}

export function lockedUnlockFromBlockers(blockers: Forecast["blockers"] | undefined): TrainingUnlock | null {
  if (!blockers) return null;
  for (const blocker of blockers) {
    const unlock = unlockFromBlockerCode(blocker.code);
    if (unlock) return unlock;
  }
  return null;
}

export function launchDisabled(forecast: Forecast | null, error: string | null): boolean {
  if (error || !forecast) return true;
  return forecast.blockers.length > 0;
}

export function extraDataOf(design: ModelDesign): DataAllocation {
  return design.data;
}

export function serveHbmGB(totalParamsB: number, precision: ServePrecision): number {
  return Math.max(0, totalParamsB) * SERVE_BYTES_PER_PARAM[precision];
}

export function contextNeedsUnlock(contextK: number | undefined): boolean {
  return contextUnlockFor(contextK) != null;
}

export function maxUnlockedContextK(state: SimState): number {
  try {
    return maxContextKForUnlocks(modifiersForLab(state, state.playerLabId).unlocks);
  } catch {
    return 4;
  }
}

export function contextLockReason(contextK: number | undefined, state: SimState): string | null {
  return optionLockReason(contextUnlockFor(contextK) ?? undefined, state);
}

export function formatContextK(contextK: number): string {
  if (contextK >= 1024) {
    const millions = contextK / 1024;
    return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  return `${contextK}k`;
}

export function snapContextK(contextK: number): number {
  const stops = CONTEXT_STOPS;
  let best: number = stops[0] ?? 4;
  let bestDist = Math.abs(contextK - best);
  for (const stop of stops) {
    const dist = Math.abs(contextK - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

export function formatMTok(mtok: number): string {
  if (!Number.isFinite(mtok) || mtok <= 0) return "0";
  if (mtok >= 1_000_000) return `${(mtok / 1_000_000).toFixed(mtok >= 10_000_000 ? 0 : 1)}T`;
  if (mtok >= 1000) return `${(mtok / 1000).toFixed(mtok >= 10_000 ? 0 : 1)}B`;
  if (mtok >= 10) return `${Math.round(mtok)}M`;
  if (mtok >= 1) return `${mtok.toFixed(1)}M`;
  return `${Math.round(mtok * 1000)}K`;
}

export function formatDays(days: number): string {
  if (!Number.isFinite(days)) return days === Number.POSITIVE_INFINITY ? "stalled" : "n/a";
  if (days >= 100) return `${Math.round(days)}d`;
  if (days >= 10) return `${days.toFixed(1)}d`;
  return `${days.toFixed(2)}d`;
}

export function formatPfDays(pfDays: number): string {
  if (!Number.isFinite(pfDays)) return "n/a";
  if (pfDays >= 1000) return `${(pfDays / 1000).toFixed(1)}k PF-d`;
  if (pfDays >= 10) return `${pfDays.toFixed(1)} PF-d`;
  return `${pfDays.toFixed(2)} PF-d`;
}

export function actionError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Action failed";
}
