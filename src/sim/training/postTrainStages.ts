import type { ModelCapabilities } from "../types";
import { TRAINING_V4 } from "./constants";
import type {
  Architecture,
  Checkpoint,
  Gym,
  GymKind,
  PostTrainForecastDelta,
  PostTrainPoolKind,
  PostTrainPools,
  PostTrainStageKind,
  TierBudget,
  TrainingModifiers,
} from "./types";
import { thinkingTrainPfMult } from "./thinking";

/** Data needed at 7B active; scaled by (N_active_B / 7)^0.5. */
export const STAGE_DATA_NEEDED_AT_7B: Record<PostTrainStageKind, number> = {
  instruct: 5,
  preference: 3,
  reasoning: 2000,
  agentic: 1000,
};

const DATA_SCALE_EXP = 0.5;
const DATA_SCALE_MIN = 0.5;
const DATA_SCALE_MAX = 1.5;
const ADEQUACY_EXP = 0.7;
const REPEAT_DECAY = 0.5;
const PREFERENCE_SAFETY_GYM_BONUS = 0.1;

const REASONING_GYM_KINDS: ReadonlySet<GymKind> = new Set([
  "code",
  "math",
  "science",
]);

export const STAGE_POOL_KIND: Record<PostTrainStageKind, PostTrainPoolKind> = {
  instruct: "instructionMTok",
  preference: "preferenceMTok",
  reasoning: "verifiableTasks",
  agentic: "toolTrajectories",
};

export const STAGE_LABEL: Record<PostTrainStageKind, string> = {
  instruct: "Instruct",
  preference: "Preference",
  reasoning: "Reasoning",
  agentic: "Agentic",
};

export function emptyPools(): PostTrainPools {
  return {
    instructionMTok: 0,
    preferenceMTok: 0,
    verifiableTasks: 0,
    toolTrajectories: 0,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function sizePfScale(activeParamsB: number): number {
  const ref = TRAINING_V4.postTrain.referenceParamsB;
  return Math.pow(Math.max(1e-9, activeParamsB) / ref, TRAINING_V4.postTrain.sizeExponent);
}

export function sizeDataScale(activeParamsB: number): number {
  const ref = TRAINING_V4.postTrain.referenceParamsB;
  return Math.pow(Math.max(1e-9, activeParamsB) / ref, DATA_SCALE_EXP);
}

export function neededDataForStage(
  stage: PostTrainStageKind,
  activeParamsB: number,
): number {
  return STAGE_DATA_NEEDED_AT_7B[stage] * sizeDataScale(activeParamsB);
}

export function providedDataForStage(
  stage: PostTrainStageKind,
  dataUse: PostTrainPools,
): number {
  return Math.max(0, dataUse[STAGE_POOL_KIND[stage]] ?? 0);
}

/** clamp(sqrt(provided / needed), 0.5, 1.5). Zero provided still floors at 0.5. */
export function dataScaleFor(provided: number, needed: number): number {
  if (!(needed > 0)) return DATA_SCALE_MIN;
  return clamp(Math.sqrt(Math.max(0, provided) / needed), DATA_SCALE_MIN, DATA_SCALE_MAX);
}

/** min(1, provided/needed)^0.7. Zero provided → 0. */
export function adequacyFor(provided: number, needed: number): number {
  if (!(needed > 0) || !(provided > 0)) return 0;
  return Math.pow(Math.min(1, provided / needed), ADEQUACY_EXP);
}

export function pfStageFor(
  stage: PostTrainStageKind,
  activeParamsB: number,
  provided: number,
): number {
  const needed = neededDataForStage(stage, activeParamsB);
  return (
    TRAINING_V4.postTrain.baseStagePfDays[stage] *
    sizePfScale(activeParamsB) *
    dataScaleFor(provided, needed)
  );
}

export function selectedGymsOf(
  gyms: readonly Gym[],
  gymIds: readonly string[],
): Gym[] {
  const wanted = new Set(gymIds);
  return gyms.filter((gym) => wanted.has(gym.id));
}

export function poolQualityForStage(
  stage: PostTrainStageKind,
  poolQuality: PostTrainPools | undefined,
): number {
  if (!poolQuality) return 1;
  const stored = poolQuality[STAGE_POOL_KIND[stage]];
  if (typeof stored !== "number" || !Number.isFinite(stored)) return 1;
  return clamp(stored, 0, 1);
}

/**
 * instruct: 1.
 * preference: 1, plus +0.1 if a safety gym is selected.
 * reasoning: mean quality of selected code/math/science gyms (0 if none).
 * agentic: mean quality of selected agentic gyms (0 if none).
 */
export function gymQualityForStage(
  stage: PostTrainStageKind,
  selected: readonly Gym[],
): number {
  if (stage === "instruct") return 1;
  if (stage === "preference") {
    return selected.some((gym) => gym.kind === "safety")
      ? 1 + PREFERENCE_SAFETY_GYM_BONUS
      : 1;
  }
  const kinds = stage === "reasoning" ? REASONING_GYM_KINDS : new Set<GymKind>(["agentic"]);
  const matched = selected.filter((gym) => kinds.has(gym.kind));
  if (matched.length === 0) return 0;
  return matched.reduce((sum, gym) => sum + gym.quality, 0) / matched.length;
}

export function hasReasoningGym(selected: readonly Gym[]): boolean {
  return selected.some((gym) => REASONING_GYM_KINDS.has(gym.kind));
}

export function hasAgenticGym(selected: readonly Gym[]): boolean {
  return selected.some((gym) => gym.kind === "agentic");
}

export function rlQualityForStage(
  stage: PostTrainStageKind,
  modifiers: TrainingModifiers,
): number {
  return stage === "reasoning" || stage === "agentic" ? modifiers.rlQuality : 1;
}

export function priorStageRuns(
  checkpoint: Checkpoint,
  stage: PostTrainStageKind,
): number {
  return Math.max(0, checkpoint.postTrain.stages[stage]?.runs ?? 0);
}

export interface StageWork {
  stage: PostTrainStageKind;
  provided: number;
  needed: number;
  pfDays: number;
  adequacy: number;
  gymQuality: number;
  poolQuality: number;
  rlQuality: number;
  completeness: number;
  effect: number;
}

export function completenessFor(budgetPfDays: number, totalPfDays: number): number {
  if (!(budgetPfDays > 0) || !(totalPfDays > 0)) return 0;
  return Math.min(1, budgetPfDays / totalPfDays);
}

/** Zero provided data or zero budget → effect 0. Then × 0.5^priorRuns. */
export function stageEffect(input: {
  adequacy: number;
  gymQuality: number;
  poolQuality: number;
  rlQuality: number;
  completeness: number;
  postTrainEfficiency: number;
  priorRuns: number;
  provided: number;
  budgetPfDays: number;
}): number {
  if (!(input.provided > 0) || !(input.budgetPfDays > 0)) return 0;
  const dataGrade = 0.2 + 0.8 * clamp(input.poolQuality, 0, 1);
  const base =
    input.adequacy *
    input.gymQuality *
    dataGrade *
    input.rlQuality *
    input.completeness *
    input.postTrainEfficiency;
  return base * Math.pow(REPEAT_DECAY, input.priorRuns);
}

export function planStages(input: {
  checkpoint: Checkpoint;
  stages: readonly PostTrainStageKind[];
  dataUse: PostTrainPools;
  gyms: readonly Gym[];
  gymIds: readonly string[];
  budgetPfDays: number;
  modifiers: TrainingModifiers;
  thinkingTrainBudgets?: readonly TierBudget[];
  poolQuality?: PostTrainPools;
}): { works: StageWork[]; totalPfDays: number; completeness: number } {
  const selected = selectedGymsOf(input.gyms, input.gymIds);
  const nActive = input.checkpoint.arch.activeParamsB;
  const thinkingMult = thinkingTrainPfMult(input.thinkingTrainBudgets ?? []);
  const draft: Omit<StageWork, "completeness" | "effect">[] = input.stages.map(
    (stage) => {
      const provided = providedDataForStage(stage, input.dataUse);
      const needed = neededDataForStage(stage, nActive);
      const basePf = pfStageFor(stage, nActive, provided);
      return {
        stage,
        provided,
        needed,
        pfDays: stage === "reasoning" ? basePf * thinkingMult : basePf,
        adequacy: adequacyFor(provided, needed),
        gymQuality: gymQualityForStage(stage, selected),
        poolQuality: poolQualityForStage(stage, input.poolQuality),
        rlQuality: rlQualityForStage(stage, input.modifiers),
      };
    },
  );
  const totalPfDays = draft.reduce((sum, row) => sum + row.pfDays, 0);
  const completeness = completenessFor(input.budgetPfDays, totalPfDays);
  const works: StageWork[] = draft.map((row) => ({
    ...row,
    completeness,
    effect: stageEffect({
      adequacy: row.adequacy,
      gymQuality: row.gymQuality,
      poolQuality: row.poolQuality,
      rlQuality: row.rlQuality,
      completeness,
      postTrainEfficiency: input.modifiers.postTrainEfficiency,
      priorRuns: priorStageRuns(input.checkpoint, row.stage),
      provided: row.provided,
      budgetPfDays: input.budgetPfDays,
    }),
  }));
  return { works, totalPfDays, completeness };
}

function addDelta(
  deltas: PostTrainForecastDelta,
  key: keyof PostTrainForecastDelta,
  amount: number,
): void {
  if (amount === 0) return;
  deltas[key] = (deltas[key] ?? 0) + amount;
}

export function deltasForWorks(
  works: readonly StageWork[],
  safetyFocus: number,
): PostTrainForecastDelta {
  const focus = clamp(safetyFocus, 0, 1);
  const deltas: PostTrainForecastDelta = {};
  for (const work of works) {
    const e = work.effect;
    if (!(e > 0)) continue;
    if (work.stage === "instruct") {
      addDelta(deltas, "steerability", 25 * e);
      addDelta(deltas, "factuality", 5 * e);
      addDelta(deltas, "language", 3 * e);
    } else if (work.stage === "preference") {
      addDelta(deltas, "safety", (15 + 25 * focus) * e);
      addDelta(deltas, "steerability", 10 * e);
      addDelta(deltas, "robustness", 8 * e);
      addDelta(deltas, "language", 2 * (1 - focus) * e);
    } else if (work.stage === "reasoning") {
      addDelta(deltas, "reasoning", 6 * e);
      addDelta(deltas, "math", 6 * e);
      addDelta(deltas, "code", 6 * e);
      addDelta(deltas, "science", 6 * e);
      addDelta(deltas, "reliability", 5 * e);
    } else {
      addDelta(deltas, "tools", 30 * e);
      addDelta(deltas, "code", 3 * e);
      addDelta(deltas, "reliability", 4 * e);
    }
  }
  return deltas;
}

const DOMAIN_KEYS = [
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "vision",
  "video",
  "audio",
  "tools",
] as const;

const QUALITY_KEYS = [
  "factuality",
  "steerability",
  "robustness",
  "safety",
  "reliability",
] as const;

export function fallbackArchCeiling(
  arch: Architecture,
  modifiers: TrainingModifiers,
): number {
  const walls = TRAINING_V4.ceilings;
  let base: number = walls.dense;
  if (arch.preset === "omni") base = walls.omni;
  else if (arch.preset !== "language") base = walls.specialist;
  else if (arch.backbone === "moe") base = walls.moe;
  return base + modifiers.ceilingLift;
}

export function applyDeltasToTruth(
  truth: ModelCapabilities,
  deltas: PostTrainForecastDelta,
  domainCeiling: number,
): ModelCapabilities {
  const domains = { ...truth.domains };
  for (const key of DOMAIN_KEYS) {
    const delta = deltas[key];
    if (delta == null) continue;
    domains[key] = clamp(domains[key] + delta, 0, domainCeiling);
  }
  const next = { ...truth, domains };
  for (const key of QUALITY_KEYS) {
    const delta = deltas[key];
    if (delta == null) continue;
    next[key] = clamp(next[key] + delta, 0, 100);
  }
  return next;
}

export function meanDomainCapability(truth: ModelCapabilities): number {
  const values = DOMAIN_KEYS.map((key) => truth.domains[key]);
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function recipeStageLabel(stages: readonly PostTrainStageKind[]): string {
  return stages.map((stage) => STAGE_LABEL[stage]).join("+");
}

export function bumpMinorVersion(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return "1.1";
  return `${match[1]}.${Number(match[2]) + 1}`;
}
