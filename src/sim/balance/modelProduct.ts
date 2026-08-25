import type {
  BenchmarkScores,
  DataDomain,
  EffortBoard,
  EffortKind,
  EffortRecipe,
  Model,
  ModelLifecycle,
  ModelProductProfile,
  PostTrainGym,
  PostTrainStage,
  ReasoningEffort,
  ReasoningEffortPolicy,
  SpecializationFocus,
} from "../types";
import { emptyBenchmarks } from "./benchmarks";
import { DATA_DOMAINS, normalizeWeights } from "./data";
import { hashSeed } from "../rng";

const clamp = (n: number, lo = 0, hi = 100) =>
  Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

function clampUnit(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

export function postTrainStagesFromResearch(
  unlocked: readonly string[] | undefined,
): Exclude<PostTrainStage, "none">[] {
  const stages: Exclude<PostTrainStage, "none">[] = [];
  const set = new Set(unlocked ?? []);
  if (set.has("align_sft")) stages.push("sft");
  if (set.has("align_rlhf") || set.has("align_dpo")) stages.push("rlhf");
  if (set.has("align_process") || set.has("align_grpo")) stages.push("process");
  if (set.has("domain_agents")) stages.push("tools");
  return stages;
}

export function emptySpecializationFocus(): SpecializationFocus {
  return { coding: 0, science: 0, research: 0, personality: 0, chat: 0 };
}

export function normalizeFocus(focus?: Partial<SpecializationFocus> | null): SpecializationFocus {
  return {
    coding: clampUnit(focus?.coding ?? 0),
    science: clampUnit(focus?.science ?? 0),
    research: clampUnit(focus?.research ?? 0),
    personality: clampUnit(focus?.personality ?? 0),
    chat: clampUnit(focus?.chat ?? 0),
  };
}

/** Completion-only mix: chat mass is folded into code/math/science. */
export function foundationDataWeights(
  familyMix: Record<DataDomain, number>,
): Record<DataDomain, number> {
  const next = { ...familyMix };
  const chat = Math.max(0, next.chat ?? 0);
  next.chat = 0;
  next.code = (next.code ?? 0) + chat * 0.4;
  next.math = (next.math ?? 0) + chat * 0.25;
  next.science = (next.science ?? 0) + chat * 0.25;
  next.law = (next.law ?? 0) + chat * 0.05;
  next.health = (next.health ?? 0) + chat * 0.05;
  return capBaseChatWeights(normalizeWeights(next));
}

/** Pretrain chat ceiling. Instruction data belongs in post-train. */
export const BASE_CHAT_CAP = 0.08;

export function capBaseChatWeights(
  weights: Record<DataDomain, number>,
): Record<DataDomain, number> {
  const chat = Math.max(0, weights.chat ?? 0);
  if (chat <= BASE_CHAT_CAP + 1e-9) return normalizeWeights(weights);
  const excess = chat - BASE_CHAT_CAP;
  const next = { ...weights, chat: BASE_CHAT_CAP };
  next.code = (next.code ?? 0) + excess * 0.45;
  next.math = (next.math ?? 0) + excess * 0.3;
  next.science = (next.science ?? 0) + excess * 0.25;
  return normalizeWeights(next);
}

/** Instruction / preference mix used after the base run. */
export function alignmentDataWeights(
  foundationMix: Record<DataDomain, number>,
): Record<DataDomain, number> {
  const base = capBaseChatWeights(foundationMix);
  return normalizeWeights({
    ...base,
    chat: Math.max(base.chat, 0.06) + 0.38,
    code: (base.code ?? 0) * 0.72,
    math: (base.math ?? 0) * 0.7,
    science: (base.science ?? 0) * 0.7,
    law: (base.law ?? 0) * 0.85,
    health: (base.health ?? 0) * 0.85,
  });
}

export const DEFAULT_POST_TRAIN_SHARE = 0.22;
/** Base can sit from 10% to 90% of the envelope; default seed is 50%. */
export const MIN_POST_TRAIN_SHARE = 0.1;
export const MAX_POST_TRAIN_SHARE = 0.9;

export function defaultAlignmentMTok(baseMTok: number): number {
  return Math.max(
    8,
    Math.round(
      (Math.max(0, baseMTok) * DEFAULT_POST_TRAIN_SHARE) /
        Math.max(1e-9, 1 - DEFAULT_POST_TRAIN_SHARE) *
        10,
    ) / 10,
  );
}

export function splitTrainingTokens(
  totalMTok: number,
  postTrainShare = DEFAULT_POST_TRAIN_SHARE,
): { baseMTok: number; postTrainMTok: number; postTrainShare: number } {
  const share = Math.max(
    MIN_POST_TRAIN_SHARE,
    Math.min(MAX_POST_TRAIN_SHARE, postTrainShare),
  );
  const total = Math.max(1, totalMTok);
  const postTrainMTok = Math.max(4, Math.round(total * share * 10) / 10);
  return {
    baseMTok: Math.max(1, Math.round((total - postTrainMTok) * 10) / 10),
    postTrainMTok,
    postTrainShare: share,
  };
}

export function focusToMix(
  focus: SpecializationFocus,
  foundationMix: Record<DataDomain, number>,
): Record<DataDomain, number> {
  const f = normalizeFocus(focus);
  const next: Partial<Record<DataDomain, number>> = { ...foundationMix };
  next.code = (next.code ?? 0) * (1 + 2.1 * f.coding);
  next.math = (next.math ?? 0) * (1 + 1.3 * f.coding + 1.5 * f.research);
  next.science = (next.science ?? 0) * (1 + 2.2 * f.science + 1.1 * f.research);
  next.chat = Math.max(next.chat ?? 0, 0.04) + 0.42 * f.chat + 0.28 * f.personality;
  next.law = (next.law ?? 0) * (1 + 0.35 * f.personality);
  next.health = (next.health ?? 0) * (1 + 0.2 * f.personality);
  for (const domain of DATA_DOMAINS) {
    if (next[domain] == null) next[domain] = 0;
  }
  return normalizeWeights(next);
}

export function inferModelLifecycle(input: {
  lifecycle?: ModelLifecycle;
  postTrain?: PostTrainStage;
  completedPostTrainStages?: readonly Exclude<PostTrainStage, "none">[];
  specializationFocus?: SpecializationFocus | null;
  branchDirection?: string;
}): ModelLifecycle {
  if (input.lifecycle) return input.lifecycle;
  const stages = new Set(input.completedPostTrainStages ?? []);
  if (input.postTrain && input.postTrain !== "none") {
    stages.add(input.postTrain);
  }
  if (stages.has("process") || stages.has("tools")) return "reasoning";
  if (stages.has("sft") || stages.has("rlhf")) return "aligned";
  const focus = normalizeFocus(input.specializationFocus);
  const specialized =
    Boolean(input.branchDirection && input.branchDirection !== "general") ||
    focus.coding + focus.science + focus.research + focus.personality + focus.chat >
      0.12;
  return specialized ? "specialized" : "foundation";
}

function seededJitter(seed: number, salt: string, amplitude: number): number {
  const n = hashSeed(seed, salt) >>> 0;
  const unit = (n % 10_000) / 9_999 - 0.5;
  return unit * 2 * amplitude;
}

export function scorePersonality(input: {
  lifecycle: ModelLifecycle;
  focus: SpecializationFocus;
  chatShare: number;
  chatQuality: number;
  sftEffectiveness: number;
  rlhfEffectiveness: number;
  chatGymQuality: number;
  outcomeSeed?: number;
}): number {
  const focus = normalizeFocus(input.focus);
  if (input.lifecycle === "foundation") {
    return clamp(
      18 +
        6 * clampUnit(input.chatShare) +
        seededJitter(input.outcomeSeed ?? 1, "personality-foundation", 3),
    );
  }
  const mixTerm = 22 * clampUnit(input.chatShare) + 18 * focus.chat + 24 * focus.personality;
  const qualityTerm = 16 * clampUnit(input.chatQuality > 1 ? input.chatQuality / 100 : input.chatQuality);
  const postTerm =
    14 * clampUnit(input.sftEffectiveness) + 22 * clampUnit(input.rlhfEffectiveness);
  const gymTerm = 14 * clampUnit(input.chatGymQuality);
  const seed = seededJitter(input.outcomeSeed ?? 1, "personality", 3);
  return clamp(12 + mixTerm + qualityTerm + postTerm + gymTerm + seed);
}

export function scoreTokenEfficiency(input: {
  stackIds?: readonly string[];
  researchUnlocked?: readonly string[];
  family?: string;
  processEffectiveness?: number;
  backbone?: string;
}): number {
  const stack = new Set(input.stackIds ?? []);
  const research = new Set(input.researchUnlocked ?? []);
  let score = 42;
  if (stack.has("opt_flash") || research.has("opt_flash")) score += 8;
  if (stack.has("sys_kernels") || research.has("sys_kernels")) score += 6;
  if (stack.has("sys_compile") || research.has("sys_compile")) score += 5;
  if (stack.has("sys_spec_decode") || research.has("sys_spec_decode")) score += 9;
  if (stack.has("sys_paged_attn") || research.has("sys_paged_attn")) score += 4;
  if (research.has("sys_batching")) score += 4;
  if (research.has("sys_kernel_fusion_v2")) score += 5;
  score += 10 * clampUnit(input.processEffectiveness ?? 0);
  if (input.backbone === "moe" || input.family === "moe") score += 6;
  return clamp(score);
}

export const INSTANT_EFFORT_ID = "instant";
export const MAX_TRAINED_EFFORTS = 3;
export const THINKING_TOKEN_MIN = 1.4;
export const THINKING_TOKEN_MAX = 8;
export const EFFORT_HEAD_SHARE_MAX = 0.45;
export const EFFORT_HEAD_POOL_CAP = 0.8;
export const EFFORT_CAPABILITY_BIAS_DEFAULT = 0.5;
export const DEFAULT_EFFORT_HEAD_SHARE = 0.2;

export const EFFORT_OUTPUT_TOKEN_MULT: Record<ReasoningEffort, number> = {
  low: 1,
  medium: 2.2,
  high: 4.5,
};

export const EFFORT_HARD_TASK_LIFT: Record<ReasoningEffort, number> = {
  low: 0,
  medium: 3.5,
  high: 8,
};

export const EFFORT_CAPABILITY_LIFT: Record<ReasoningEffort, number> = {
  low: 0,
  medium: 4.5,
  high: 10,
};

export const EFFORT_UNLOCK_RESEARCH = "align_process";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
];

export function clampCapabilityBias(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return EFFORT_CAPABILITY_BIAS_DEFAULT;
  }
  return Math.max(0, Math.min(1, value));
}

export function clampEffortTrainShare(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(EFFORT_HEAD_SHARE_MAX, value));
}

/** Serve-cost multiplier. 0.5 is cost-neutral; capability is a massive markup. */
export function effortServeCostScale(
  capabilityBias: number | undefined,
): number {
  return Math.pow(3.4, 2 * clampCapabilityBias(capabilityBias) - 1);
}

export function effortCapabilityScale(
  capabilityBias: number | undefined,
): number {
  return 0.74 + 0.52 * clampCapabilityBias(capabilityBias);
}

export function effortFundedPfFromQuality(
  quality: number,
  requiredPfDays: number,
): number {
  const q = clampUnit(quality);
  if (q <= 0) return 0;
  if (q >= 0.999) return Math.max(1, requiredPfDays) * 4;
  return Math.max(0, (-Math.log(1 - q) * Math.max(1, requiredPfDays)) / 1.6);
}

export function allocateEffortHeadPf(
  recipes: readonly EffortRecipe[],
  allocatedPf: number,
): { remainderPf: number; byId: Record<string, number> } {
  const pf = Math.max(0, allocatedPf);
  const shares: Record<string, number> = {};
  let totalShare = 0;
  for (const recipe of recipes) {
    const share = clampEffortTrainShare(recipe.trainComputeShare);
    shares[recipe.id] = share;
    totalShare += share;
  }
  const scale =
    totalShare > EFFORT_HEAD_POOL_CAP && totalShare > 0
      ? EFFORT_HEAD_POOL_CAP / totalShare
      : 1;
  const byId: Record<string, number> = {};
  let used = 0;
  for (const recipe of recipes) {
    const headPf = pf * (shares[recipe.id] ?? 0) * scale;
    byId[recipe.id] = headPf;
    used += headPf;
  }
  return { remainderPf: Math.max(0, pf - used), byId };
}

export function normalizeEffortRecipe(recipe: EffortRecipe): EffortRecipe {
  return {
    ...recipe,
    capabilityBias: clampCapabilityBias(recipe.capabilityBias),
    trainComputeShare: clampEffortTrainShare(recipe.trainComputeShare),
    progressPfDays: Math.max(0, recipe.progressPfDays ?? 0),
    targetPfDays: Math.max(0, recipe.targetPfDays ?? 0),
    loss:
      recipe.loss != null && Number.isFinite(recipe.loss)
        ? recipe.loss
        : undefined,
  };
}

export function instantRecipe(): EffortRecipe {
  return {
    id: INSTANT_EFFORT_ID,
    name: "Instant",
    kind: "instant",
    thinkingTokenMult: 1,
    trainPfDays: 0,
    trainCash: 0,
    trained: true,
    quality: 1,
    served: true,
    capabilityBias: EFFORT_CAPABILITY_BIAS_DEFAULT,
    trainComputeShare: 0,
    progressPfDays: 0,
    targetPfDays: 0,
  };
}

export function migrateEffortRecipes(
  profile?: Partial<ModelProductProfile> | null,
): EffortRecipe[] {
  if (profile?.effortRecipes && profile.effortRecipes.length > 0) {
    const hasInstant = profile.effortRecipes.some(
      (recipe) => recipe.kind === "instant" || recipe.id === INSTANT_EFFORT_ID,
    );
    return hasInstant
      ? profile.effortRecipes.map((recipe) =>
          normalizeEffortRecipe(
            recipe.kind === "instant" || recipe.id === INSTANT_EFFORT_ID
              ? {
                  ...instantRecipe(),
                  ...recipe,
                  id: INSTANT_EFFORT_ID,
                  kind: "instant",
                  trained: true,
                  thinkingTokenMult: 1,
                }
              : recipe,
          ),
        )
      : [instantRecipe(), ...profile.effortRecipes.map(normalizeEffortRecipe)];
  }
  const recipes: EffortRecipe[] = [instantRecipe()];
  const served = new Set(profile?.servedEfforts ?? ["low"]);
  for (const policy of profile?.effortPolicies ?? []) {
    if (policy.level === "low" || !policy.trained) continue;
    recipes.push(
      normalizeEffortRecipe({
        id: policy.level,
        name: policy.level === "medium" ? "Think" : "Deep",
        kind: "trained",
        thinkingTokenMult: EFFORT_OUTPUT_TOKEN_MULT[policy.level],
        trainPfDays: 0,
        trainCash: 0,
        trained: true,
        quality: clampUnit(policy.quality),
        served: served.has(policy.level),
        capabilityBias: EFFORT_CAPABILITY_BIAS_DEFAULT,
        trainComputeShare: 0,
        progressPfDays: 0,
        targetPfDays: 0,
      }),
    );
  }
  const instant = recipes.find((recipe) => recipe.id === INSTANT_EFFORT_ID);
  if (instant) {
    instant.served = served.size === 0 || served.has("low") || recipes.every((recipe) => !recipe.served);
  }
  return recipes;
}

export function defaultEffortIdOf(
  profile?: Partial<ModelProductProfile> | null,
): string {
  const recipes = migrateEffortRecipes(profile);
  const requested =
    profile?.defaultEffortId ??
    (profile?.defaultEffort === "medium"
      ? "medium"
      : profile?.defaultEffort === "high"
        ? "high"
        : INSTANT_EFFORT_ID);
  if (recipes.some((recipe) => recipe.id === requested && recipe.trained)) {
    return requested;
  }
  return INSTANT_EFFORT_ID;
}

export function trainedEffortCount(recipes: readonly EffortRecipe[]): number {
  return recipes.filter((recipe) => recipe.kind === "trained").length;
}

export function clampThinkingTokenMult(value: number): number {
  if (!Number.isFinite(value)) return THINKING_TOKEN_MIN;
  return Math.max(THINKING_TOKEN_MIN, Math.min(THINKING_TOKEN_MAX, value));
}

/** PF-days to fully fund a thinking budget. Underfunding is allowed. */
export function effortTrainTargetPfDays(input: {
  paramsB: number;
  thinkingTokenMult: number;
  gymQuality?: number;
  researchUnlocked?: readonly string[];
}): number {
  const size = Math.pow(Math.max(1, input.paramsB), 0.18);
  const budget = clampThinkingTokenMult(input.thinkingTokenMult);
  const gymTax = 1.15 - clampUnit(input.gymQuality ?? 0) * 0.2;
  const research = new Set(input.researchUnlocked ?? []);
  const researchCut =
    (research.has("align_process") ? 0.88 : 1) *
    (research.has("align_grpo") ? 0.82 : 1);
  return Math.max(
    8,
    Math.round(42 * size * (0.45 + budget * 0.28) * gymTax * researchCut * 10) /
      10,
  );
}

export function effortQualityFromTrain(
  trainPfDays: number,
  requiredPfDays: number,
): number {
  const required = Math.max(1, requiredPfDays);
  const funded = Math.max(0, trainPfDays) / required;
  return clampUnit(1 - Math.exp(-funded * 1.6));
}

export function effortCashCost(targetPfDays: number, paramsB: number): number {
  return Math.round(18_000 * targetPfDays * Math.pow(Math.max(1, paramsB), 0.22));
}

export function effortReasoningUnlocked(
  researchUnlocked?: readonly string[],
): boolean {
  return (researchUnlocked ?? []).includes(EFFORT_UNLOCK_RESEARCH);
}

export function effortLevelUnlocked(
  level: ReasoningEffort,
  researchUnlocked?: readonly string[],
): boolean {
  return level === "low" || effortReasoningUnlocked(researchUnlocked);
}

export function buildEffortPolicies(input: {
  reasoningEnabled: boolean;
  processEffectiveness: number;
  outcomeSeed?: number;
  existing?: ReasoningEffortPolicy[];
  researchUnlocked?: readonly string[];
}): ReasoningEffortPolicy[] {
  const process = clampUnit(input.processEffectiveness);
  const reasoning =
    Boolean(input.reasoningEnabled) &&
    effortReasoningUnlocked(input.researchUnlocked);
  const jitter = (level: ReasoningEffort) =>
    seededJitter(input.outcomeSeed ?? 1, `effort-${level}`, 0.04);
  const lowQuality = clampUnit(0.58 + process * 0.28 + jitter("low"));
  const medQuality = reasoning
    ? clampUnit(0.38 + process * 0.4 + jitter("medium"))
    : 0.22;
  const highQuality = reasoning
    ? clampUnit(0.18 + process * 0.42 + jitter("high"))
    : 0.08;
  const next: ReasoningEffortPolicy[] = [
    {
      level: "low",
      trained: true,
      quality: lowQuality,
      outputTokenMult: EFFORT_OUTPUT_TOKEN_MULT.low,
      hardTaskLift: EFFORT_HARD_TASK_LIFT.low,
    },
    {
      level: "medium",
      trained: reasoning,
      quality: medQuality,
      outputTokenMult: EFFORT_OUTPUT_TOKEN_MULT.medium,
      hardTaskLift: EFFORT_HARD_TASK_LIFT.medium * medQuality,
    },
    {
      level: "high",
      trained: reasoning && process > 0.35,
      quality: highQuality,
      outputTokenMult: EFFORT_OUTPUT_TOKEN_MULT.high,
      hardTaskLift: EFFORT_HARD_TASK_LIFT.high * highQuality,
    },
  ];
  if (input.existing?.length === 3) {
    return next.map((policy) => {
      const prior = input.existing!.find((item) => item.level === policy.level);
      return prior
        ? {
            ...prior,
            trained: policy.trained,
            quality: policy.quality,
            hardTaskLift: policy.hardTaskLift,
          }
        : policy;
    });
  }
  return next;
}

export function efficiencyTokenFactor(tokenEfficiency: number): number {
  return Math.max(0.4, 0.55 + 0.45 * (clamp(tokenEfficiency) / 100));
}

export function serveTokenMultiplierForRecipe(
  recipe: Pick<EffortRecipe, "thinkingTokenMult"> &
    Partial<Pick<EffortRecipe, "kind" | "capabilityBias">>,
  tokenEfficiency: number,
): number {
  const base =
    Math.max(1, recipe.thinkingTokenMult) /
    efficiencyTokenFactor(tokenEfficiency);
  if (recipe.kind === "instant") return Math.max(1, base);
  return Math.max(1, base * effortServeCostScale(recipe.capabilityBias));
}

export function serveTokenMultiplier(
  effort: ReasoningEffort,
  tokenEfficiency: number,
): number {
  const base = EFFORT_OUTPUT_TOKEN_MULT[effort] ?? 1;
  return base / efficiencyTokenFactor(tokenEfficiency);
}

export function servedRecipes(profile: ModelProductProfile): EffortRecipe[] {
  const recipes = migrateEffortRecipes(profile);
  const served = recipes.filter((recipe) => recipe.served && recipe.trained);
  return served.length > 0 ? served : recipes.filter((recipe) => recipe.id === INSTANT_EFFORT_ID);
}

export function normalizeServedEfforts(
  profile: Pick<
    ModelProductProfile,
    | "effortPolicies"
    | "defaultEffort"
    | "servedEfforts"
    | "effortRecipes"
    | "defaultEffortId"
  >,
): ReasoningEffort[] {
  const recipes = migrateEffortRecipes(profile);
  const served = recipes.filter((recipe) => recipe.served && recipe.trained);
  const ids = (served.length > 0 ? served : recipes.filter((r) => r.kind === "instant")).map(
    (recipe) => recipe.id,
  );
  const mapped = ids.map((id): ReasoningEffort => {
    if (id === "medium") return "medium";
    if (id === "high") return "high";
    return "low";
  });
  return mapped.length > 0 ? mapped : ["low"];
}

export function effortTrafficShares(
  served: readonly ReasoningEffort[],
  defaultEffort: ReasoningEffort,
): Record<ReasoningEffort, number> {
  const shares: Record<ReasoningEffort, number> = {
    low: 0,
    medium: 0,
    high: 0,
  };
  if (served.length === 0) {
    shares[defaultEffort] = 1;
    return shares;
  }
  if (served.length === 1) {
    shares[served[0]!] = 1;
    return shares;
  }
  const fallback = served.includes(defaultEffort) ? defaultEffort : served[0]!;
  const remainder = served.filter((level) => level !== fallback);
  shares[fallback] = 0.55;
  const each = 0.45 / remainder.length;
  for (const level of remainder) shares[level] = each;
  return shares;
}

export function servedEffortTokenMultiplier(
  profile: ModelProductProfile,
): number {
  const recipes = servedRecipes(profile);
  const defaultId = defaultEffortIdOf(profile);
  if (recipes.length === 1) {
    return serveTokenMultiplierForRecipe(recipes[0]!, profile.tokenEfficiency);
  }
  const fallback =
    recipes.find((recipe) => recipe.id === defaultId) ?? recipes[0]!;
  const remainder = recipes.filter((recipe) => recipe.id !== fallback.id);
  const fallbackShare = 0.55;
  const each = remainder.length > 0 ? 0.45 / remainder.length : 0;
  return (
    fallbackShare *
      serveTokenMultiplierForRecipe(fallback, profile.tokenEfficiency) +
    remainder.reduce(
      (sum, recipe) =>
        sum +
        each * serveTokenMultiplierForRecipe(recipe, profile.tokenEfficiency),
      0,
    )
  );
}

const HARD_BENCHES: readonly (keyof BenchmarkScores)[] = [
  "math",
  "coding",
  "science",
  "agents",
];

export function applyEffortLiftFromRecipe(
  capability: number,
  benches: BenchmarkScores,
  recipe: Pick<
    EffortRecipe,
    "kind" | "trained" | "thinkingTokenMult" | "quality"
  > &
    Partial<
      Pick<EffortRecipe, "capabilityBias" | "trainPfDays" | "targetPfDays">
    >,
): { capability: number; benchmarks: BenchmarkScores } {
  if (!recipe.trained && recipe.kind !== "instant") {
    return { capability, benchmarks: { ...benches } };
  }
  const bias = clampCapabilityBias(recipe.capabilityBias);
  const capScale = effortCapabilityScale(bias);
  if (recipe.kind === "instant") {
    const funded = Math.max(0, recipe.trainPfDays ?? 0);
    if (funded <= 1e-9) {
      return { capability, benchmarks: { ...benches } };
    }
    const required = Math.max(1, recipe.targetPfDays ?? funded);
    const extra = effortQualityFromTrain(funded, required);
    const capLift = 3.6 * extra * capScale;
    const benchLift = 3.1 * extra * capScale;
    const next = { ...benches };
    for (const id of HARD_BENCHES) {
      next[id] = clamp(next[id] + benchLift);
    }
    next.mmlu = clamp(next.mmlu + benchLift * 0.45);
    next.personality = benches.personality;
    return {
      capability: clamp(capability + capLift),
      benchmarks: next,
    };
  }
  const quality = clampUnit(recipe.quality);
  const usefulMult = 1 + (Math.max(1, recipe.thinkingTokenMult) - 1) * quality;
  const capLift = 7.2 * Math.log2(Math.max(1, usefulMult)) * quality * capScale;
  const benchLift = 6.4 * Math.log2(Math.max(1, usefulMult)) * quality * capScale;
  const next = { ...benches };
  for (const id of HARD_BENCHES) {
    next[id] = clamp(next[id] + benchLift);
  }
  next.mmlu = clamp(next.mmlu + benchLift * 0.45);
  next.personality = benches.personality;
  return {
    capability: clamp(capability + capLift),
    benchmarks: next,
  };
}

export function applyEffortLift(
  capability: number,
  benches: BenchmarkScores,
  policy: Pick<ReasoningEffortPolicy, "level" | "trained" | "hardTaskLift">,
): { capability: number; benchmarks: BenchmarkScores } {
  if (!policy.trained) {
    return { capability, benchmarks: { ...benches } };
  }
  const capLift = EFFORT_CAPABILITY_LIFT[policy.level] ?? 0;
  const benchLift = policy.hardTaskLift;
  const next = { ...benches };
  for (const id of HARD_BENCHES) {
    next[id] = clamp(next[id] + benchLift);
  }
  next.mmlu = clamp(next.mmlu + benchLift * 0.45);
  next.personality = benches.personality;
  return {
    capability: clamp(capability + capLift),
    benchmarks: next,
  };
}

export function effortPolicy(
  profile: ModelProductProfile | undefined,
  level: ReasoningEffort,
): ReasoningEffortPolicy | undefined {
  return profile?.effortPolicies?.find((policy) => policy.level === level);
}

export function effortViewForRecipe(
  model: Pick<Model, "capability" | "benchmarks" | "productProfile">,
  recipeId: string,
): { capability: number; benchmarks: BenchmarkScores; recipe: EffortRecipe } | null {
  const benches = { ...emptyBenchmarks(), ...model.benchmarks };
  const recipes = migrateEffortRecipes(model.productProfile);
  const recipe = recipes.find((item) => item.id === recipeId);
  if (!recipe?.trained) {
    if (recipeId === INSTANT_EFFORT_ID || recipeId === "low") {
      return {
        capability: model.capability,
        benchmarks: benches,
        recipe: instantRecipe(),
      };
    }
    return null;
  }
  const lifted = applyEffortLiftFromRecipe(model.capability, benches, recipe);
  return { ...lifted, recipe };
}

export function effortViewFor(
  model: Pick<Model, "capability" | "benchmarks" | "productProfile">,
  level: ReasoningEffort,
): { capability: number; benchmarks: BenchmarkScores } | null {
  const id =
    level === "low" ? INSTANT_EFFORT_ID : level === "medium" ? "medium" : "high";
  const view = effortViewForRecipe(model, id);
  if (view) return { capability: view.capability, benchmarks: view.benchmarks };
  if (level === "low") {
    return {
      capability: model.capability,
      benchmarks: { ...emptyBenchmarks(), ...model.benchmarks },
    };
  }
  return null;
}

export function peakServedCapability(
  model: Pick<Model, "capability" | "benchmarks" | "productProfile">,
): number {
  const profile = model.productProfile;
  if (!profile) return model.capability;
  let best = model.capability;
  for (const recipe of servedRecipes(profile)) {
    const view = effortViewForRecipe(model, recipe.id);
    if (view) best = Math.max(best, view.capability);
  }
  return best;
}

export function withServedRecipe(
  profile: ModelProductProfile,
  recipeId: string,
  served: boolean,
): ModelProductProfile {
  const recipes = migrateEffortRecipes(profile).map((recipe) =>
    recipe.id === recipeId && recipe.trained ? { ...recipe, served } : recipe,
  );
  if (!recipes.some((recipe) => recipe.served && recipe.trained)) {
    recipes.forEach((recipe) => {
      if (recipe.id === INSTANT_EFFORT_ID) recipe.served = true;
    });
  }
  const defaultEffortId = recipes.some(
    (recipe) => recipe.id === defaultEffortIdOf(profile) && recipe.served,
  )
    ? defaultEffortIdOf(profile)
    : (recipes.find((recipe) => recipe.served)?.id ?? INSTANT_EFFORT_ID);
  return {
    ...profile,
    effortRecipes: recipes,
    defaultEffortId,
    defaultEffort:
      defaultEffortId === "medium"
        ? "medium"
        : defaultEffortId === "high"
          ? "high"
          : "low",
    servedEfforts: recipes
      .filter((recipe) => recipe.served)
      .map((recipe) =>
        recipe.id === "medium" ? "medium" : recipe.id === "high" ? "high" : "low",
      ),
  };
}

export function withDefaultRecipe(
  profile: ModelProductProfile,
  recipeId: string,
): ModelProductProfile {
  const recipes = migrateEffortRecipes(profile);
  const target = recipes.find((recipe) => recipe.id === recipeId && recipe.trained);
  if (!target) return profile;
  return withServedRecipe(
    { ...profile, effortRecipes: recipes, defaultEffortId: recipeId },
    recipeId,
    true,
  );
}

export function withServedEffort(
  profile: ModelProductProfile,
  level: ReasoningEffort,
  served: boolean,
): ModelProductProfile {
  const id =
    level === "low" ? INSTANT_EFFORT_ID : level === "medium" ? "medium" : "high";
  return withServedRecipe(profile, id, served);
}

export function withEffortRecipePatch(
  profile: ModelProductProfile,
  recipeId: string,
  patch: Partial<EffortRecipe>,
): ModelProductProfile {
  const recipes = migrateEffortRecipes(profile).map((recipe) =>
    recipe.id === recipeId
      ? normalizeEffortRecipe({ ...recipe, ...patch, id: recipe.id })
      : recipe,
  );
  if (!recipes.some((recipe) => recipe.id === recipeId)) return profile;
  return { ...profile, effortRecipes: recipes };
}

export function previewEffortRecipe(input: {
  recipe: Pick<
    EffortRecipe,
    "kind" | "trained" | "thinkingTokenMult" | "quality"
  > &
    Partial<
      Pick<EffortRecipe, "capabilityBias" | "trainPfDays" | "targetPfDays">
    >;
  tokenEfficiency: number;
  baseCapability: number;
  benches?: BenchmarkScores;
}): {
  tokenMult: number;
  capability: number;
  capDelta: number;
  costScale: number;
  capScale: number;
} {
  const benches = input.benches ?? {
    mmlu: input.baseCapability,
    coding: input.baseCapability,
    math: input.baseCapability,
    vision: 0,
    law: 0,
    health: 0,
    science: input.baseCapability,
    multilingual: 0,
    agents: input.baseCapability,
    safety: 0,
    personality: 0,
  };
  const lifted = applyEffortLiftFromRecipe(
    input.baseCapability,
    benches,
    input.recipe,
  );
  const tokenMult = serveTokenMultiplierForRecipe(
    input.recipe,
    input.tokenEfficiency,
  );
  const costScale =
    input.recipe.kind === "instant"
      ? 1
      : effortServeCostScale(input.recipe.capabilityBias);
  return {
    tokenMult,
    capability: lifted.capability,
    capDelta: lifted.capability - input.baseCapability,
    costScale,
    capScale: effortCapabilityScale(input.recipe.capabilityBias),
  };
}

export function effortEconomics(
  recipe: EffortRecipe,
  tokenEfficiency: number,
  usdPerPfDay: number,
  pfPerMTokBase: number,
): {
  tokenMult: number;
  pfPerMTok: number;
  usdPerMTok: number;
  usdPer1kQueries: number;
} {
  const tokenMult = serveTokenMultiplierForRecipe(recipe, tokenEfficiency);
  const pfPerMTok = Math.max(0, pfPerMTokBase) * tokenMult;
  const usdPerMTok = pfPerMTok * Math.max(0, usdPerPfDay);
  const tokensPer1kQueries = 800 * tokenMult;
  return {
    tokenMult,
    pfPerMTok,
    usdPerMTok,
    usdPer1kQueries: (tokensPer1kQueries / 1_000_000) * usdPerMTok,
  };
}

export function quoteEffortTraining(input: {
  paramsB: number;
  thinkingTokenMult: number;
  trainPfDays?: number;
  gymQuality?: number;
  researchUnlocked?: readonly string[];
  capabilityBias?: number;
  kind?: EffortKind;
}): {
  thinkingTokenMult: number;
  requiredPfDays: number;
  fundedPfDays: number;
  quality: number;
  cash: number;
  costScale: number;
  capScale: number;
} {
  const thinkingTokenMult = clampThinkingTokenMult(input.thinkingTokenMult);
  const requiredPfDays = effortTrainTargetPfDays({
    paramsB: input.paramsB,
    thinkingTokenMult,
    gymQuality: input.gymQuality,
    researchUnlocked: input.researchUnlocked,
  });
  const fundedPfDays = Math.max(1, input.trainPfDays ?? requiredPfDays);
  const capabilityBias = clampCapabilityBias(input.capabilityBias);
  return {
    thinkingTokenMult,
    requiredPfDays,
    fundedPfDays,
    quality: effortQualityFromTrain(fundedPfDays, requiredPfDays),
    cash: effortCashCost(
      Math.min(fundedPfDays, requiredPfDays * 1.4),
      input.paramsB,
    ),
    costScale:
      input.kind === "instant" ? 1 : effortServeCostScale(capabilityBias),
    capScale: effortCapabilityScale(capabilityBias),
  };
}

export function effortBoardsFor(
  model: Pick<Model, "capability" | "benchmarks" | "productProfile">,
  usdPerMTokBase: number | null = null,
  pfPerMTokBase = 0,
): EffortBoard[] {
  const profile = model.productProfile;
  const recipes = migrateEffortRecipes(profile);
  return recipes
    .filter((recipe) => recipe.trained)
    .map((recipe) => {
      const view = effortViewForRecipe(model, recipe.id);
      const econ = effortEconomics(
        recipe,
        profile?.tokenEfficiency ?? 50,
        0,
        pfPerMTokBase,
      );
      return {
        id: recipe.id,
        name: recipe.name,
        trained: recipe.trained,
        served: recipe.served,
        capability: view?.capability ?? model.capability,
        tokenMult: econ.tokenMult,
        usdPerMTok:
          usdPerMTokBase != null ? usdPerMTokBase * econ.tokenMult : null,
        math: view?.benchmarks.math ?? model.benchmarks.math,
        coding: view?.benchmarks.coding ?? model.benchmarks.coding,
        science: view?.benchmarks.science ?? model.benchmarks.science,
        agents: view?.benchmarks.agents ?? model.benchmarks.agents,
      };
    });
}

/** Paid sub usage multiplier. 25 personality ≈ 0.52, 80 ≈ 0.94. */
export function personalityEngagement(score: number, isFree = false): number {
  const s = clamp(score) / 100;
  const curve = 0.4 + 0.6 * Math.pow(Math.max(0, (s - 0.12) / 0.88), 1.05);
  return Math.max(0.28, Math.min(1, isFree ? 0.62 + curve * 0.32 : curve));
}

/** 0–1 churn pressure when personality is below a consumer bar of 55. */
export function planPersonalityDissatisfaction(score: number): number {
  const gap = Math.max(0, 55 - clamp(score)) / 55;
  return gap * gap * 0.55;
}

export function gymQualityByKind(
  gyms: readonly PostTrainGym[] | undefined,
  kind: PostTrainGym["kind"],
): number {
  const gym = gyms?.find((entry) => entry.kind === kind);
  return clampUnit(gym?.quality ?? 0);
}

export function buildModelProductProfile(input: {
  lifecycle?: ModelLifecycle;
  focus?: Partial<SpecializationFocus> | null;
  branchDirection?: string;
  postTrain?: PostTrainStage;
  completedPostTrainStages?: readonly Exclude<PostTrainStage, "none">[];
  postTrainStageEffectiveness?: Partial<
    Record<Exclude<PostTrainStage, "none">, number>
  >;
  chatShare: number;
  chatQuality: number;
  gyms?: readonly PostTrainGym[];
  stackIds?: readonly string[];
  researchUnlocked?: readonly string[];
  family?: string;
  backbone?: string;
  reasoningEnabled?: boolean;
  outcomeSeed?: number;
  existing?: ModelProductProfile;
}): ModelProductProfile {
  const lifecycle = inferModelLifecycle(input);
  const focus = normalizeFocus(input.focus ?? input.existing?.focus);
  const sft = input.postTrainStageEffectiveness?.sft ?? (input.postTrain === "sft" ? 0.38 : 0);
  const rlhf =
    input.postTrainStageEffectiveness?.rlhf ?? (input.postTrain === "rlhf" ? 0.68 : 0);
  const process =
    input.postTrainStageEffectiveness?.process ??
    (input.postTrain === "process" || input.reasoningEnabled ? 0.55 : 0);
  const personality = scorePersonality({
    lifecycle,
    focus,
    chatShare: input.chatShare,
    chatQuality: input.chatQuality,
    sftEffectiveness: sft,
    rlhfEffectiveness: rlhf,
    chatGymQuality: gymQualityByKind(input.gyms, "chat"),
    outcomeSeed: input.outcomeSeed,
  });
  const tokenEfficiency = scoreTokenEfficiency({
    stackIds: input.stackIds,
    researchUnlocked: input.researchUnlocked,
    family: input.family,
    backbone: input.backbone,
    processEffectiveness: process,
  });
  const reasoningOn =
    Boolean(input.reasoningEnabled) || lifecycle === "reasoning";
  const effortPolicies = buildEffortPolicies({
    reasoningEnabled: reasoningOn,
    processEffectiveness: process,
    outcomeSeed: input.outcomeSeed,
    existing: input.existing?.effortPolicies,
    researchUnlocked: input.researchUnlocked,
  });
  const effortRecipes = migrateEffortRecipes({
    ...input.existing,
    effortPolicies,
  });
  const defaultEffortId = defaultEffortIdOf({
    ...input.existing,
    effortRecipes,
  });
  const defaultEffort: ReasoningEffort =
    defaultEffortId === "medium"
      ? "medium"
      : defaultEffortId === "high"
        ? "high"
        : "low";
  return {
    lifecycle,
    focus,
    personality,
    tokenEfficiency,
    effortRecipes,
    defaultEffortId,
    effortPolicies,
    defaultEffort,
    servedEfforts: effortRecipes
      .filter((recipe) => recipe.served)
      .map((recipe) =>
        recipe.id === "medium" ? "medium" : recipe.id === "high" ? "high" : "low",
      ),
  };
}

export function productProfileFromModel(
  model: Pick<
    Model,
    | "productProfile"
    | "postTrain"
    | "completedPostTrainStages"
    | "postTrainStageEffectiveness"
    | "quality"
    | "dataPlan"
    | "modelStack"
    | "family"
    | "backbone"
    | "reasoningEnabled"
    | "outcome"
  > & { branchDirection?: string },
  gyms?: readonly PostTrainGym[],
  researchUnlocked?: readonly string[],
): ModelProductProfile {
  const chatShare = model.dataPlan?.weights?.chat ?? 0;
  return buildModelProductProfile({
    postTrain: model.postTrain,
    completedPostTrainStages: model.completedPostTrainStages,
    postTrainStageEffectiveness: model.postTrainStageEffectiveness,
    chatShare,
    chatQuality: model.quality.chat,
    gyms,
    stackIds: model.modelStack,
    researchUnlocked,
    family: model.family,
    backbone: model.backbone,
    reasoningEnabled: model.reasoningEnabled,
    outcomeSeed: model.outcome?.kind ? 1 : 1,
    branchDirection: model.branchDirection,
    existing: model.productProfile,
  });
}

export function focusMagnitude(focus?: Partial<SpecializationFocus> | null): number {
  const next = normalizeFocus(focus);
  return next.coding + next.science + next.research + next.personality + next.chat;
}

export function highestPostTrainStage(
  stages: readonly Exclude<PostTrainStage, "none">[] | undefined,
): PostTrainStage {
  const set = new Set(stages ?? []);
  if (set.has("tools")) return "tools";
  if (set.has("process")) return "process";
  if (set.has("rlhf")) return "rlhf";
  if (set.has("sft")) return "sft";
  return "none";
}

export function branchFocusPreset(
  direction: string | undefined,
): SpecializationFocus {
  const empty = emptySpecializationFocus();
  if (direction === "code") return { ...empty, coding: 0.85, chat: 0.15 };
  if (direction === "cyber")
    return { ...empty, coding: 0.7, personality: 0.15, chat: 0.2 };
  if (direction === "chat") return { ...empty, chat: 0.7, personality: 0.45 };
  if (direction === "reasoning") return { ...empty, research: 0.8, science: 0.4 };
  if (direction === "agents") return { ...empty, coding: 0.55, chat: 0.4 };
  if (direction === "safety") return { ...empty, personality: 0.35, chat: 0.4 };
  return empty;
}
