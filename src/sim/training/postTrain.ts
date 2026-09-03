import type { CapabilityDomain, LabId, SimState } from "../types";
import { gymResearchReservationShare } from "../balance/modelStudio";
import {
  dataResearchReservationShare,
  ensureLabData,
} from "../systems/data";
import { chargeExpense } from "../systems/financeLedger";
import { availableHqStaff } from "../systems/staffReservations";
import { createRng, hashSeed, seededId, type Rng } from "../rng";
import { TRAINING_V4 } from "./constants";
import { addToPool, consumeFromPool, poolQualityOf, poolsFor, POST_TRAIN_DATA_PRICE } from "./dataBridge";
import { utilForLab } from "./forecast";
import { baselineModifiers, hasUnlock, modifiersForLab } from "./modifiers";
import {
  allocateLabTrainingPf,
  recipeTrainContender,
  trainPfForLab,
} from "./run";
import { archCeiling } from "./scaling";
import { trainingStateOf, withTrainingState } from "./state";
import {
  extraThinkingBudgetsToTrain,
  mergeTrainedTiers,
} from "./thinking";
import type {
  Checkpoint,
  Eval,
  Gym,
  GymKind,
  PostTrainForecast,
  PostTrainPoolKind,
  PostTrainRecipe,
  PostTrainStageKind,
  PostTrainStageRecord,
  StartResult,
  TierBudget,
  TrainingModifiers,
  TrainingState,
} from "./types";
import {
  applyGymCampus,
  GYM_BUDGET_MONTH_MAX,
  GYM_BUDGET_MONTH_STEP,
  GYM_CREATE_CASH,
  GYM_RESEARCH_SHARE_STEP,
  GYM_RESEARCHER_MAX,
  GYM_SYNTH_TEACHER_NODE,
  GYM_TIER_MONTHLY,
  capGymResearchShare,
  gymAuditShare,
  gymBudgetPerDay,
  gymDailyYield,
  gymEmitQuality,
  gymResearchShare,
  gymTierSpec,
  monthlyBudgetToPerDay,
  v4GymResearchReservationShare,
  type GymYieldContext,
} from "./gyms";
import {
  applyDeltasToTruth,
  bumpMinorVersion,
  clamp,
  deltasForWorks,
  fallbackArchCeiling,
  hasAgenticGym,
  hasReasoningGym,
  meanDomainCapability,
  planStages,
  priorStageRuns,
  providedDataForStage,
  selectedGymsOf,
} from "./postTrainStages";
import { orderedPostStages, persistPostCheckpointName } from "./naming";

/** Cluster cash burn while a recipe runs. */
export const POST_TRAIN_CASH_PER_PF_DAY = 15_000;

/** Refund this fraction of the unconsumed (1 − progress) dataUse on cancel. */
export const CANCEL_POOL_REFUND = 0.5;

/** Cash = amount · tierBudget · rate. Synthesis is half the market table in dataBridge. */
export const SYNTH_POST_TRAIN_RATE: Record<PostTrainPoolKind, number> = {
  instructionMTok: POST_TRAIN_DATA_PRICE.instructionMTok / 2,
  preferenceMTok: POST_TRAIN_DATA_PRICE.preferenceMTok / 2,
  verifiableTasks: POST_TRAIN_DATA_PRICE.verifiableTasks / 2,
  toolTrajectories: POST_TRAIN_DATA_PRICE.toolTrajectories / 2,
};

const SYNTH_TIER_YIELD = 0.05;
const SYNTH_YIELD_CAP = 1.3;
const EPSILON_SIGMA = 0.12;
const EPSILON_CLAMP_SIGMAS = 2;
const LOW_ADEQUACY = 0.5;

type RecipeDraft = Omit<
  PostTrainRecipe,
  | "id"
  | "startDay"
  | "progress"
  | "pfDaysDone"
  | "status"
  | "forecast"
  | "resultCheckpointId"
  | "seed"
  | "labId"
>;

function labIdsOf(state: SimState): LabId[] {
  return [state.playerLabId, ...state.rivals.map((rival) => rival.id)];
}

function isNotImplemented(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("not implemented:");
}

function labModifiers(state: SimState, labId: LabId): TrainingModifiers {
  try {
    return modifiersForLab(state, labId);
  } catch (error) {
    if (isNotImplemented(error)) return baselineModifiers();
    throw error;
  }
}

function domainCeiling(
  checkpoint: Checkpoint,
  modifiers: TrainingModifiers,
): number {
  try {
    return archCeiling(checkpoint.arch, modifiers);
  } catch (error) {
    if (isNotImplemented(error)) {
      return fallbackArchCeiling(checkpoint.arch, modifiers);
    }
    throw error;
  }
}

function debitPlayer(state: SimState, amount: number): SimState {
  if (!(amount > 0)) return state;
  return {
    ...state,
    player: { ...state.player, cash: state.player.cash - amount },
  };
}

const FORECAST_RECIPE_JOB_ID = "__forecast-recipe__";

/**
 * Training PF this recipe would receive today, sharing the pool with runs
 * and any other running recipes. Zero when the training pool is empty.
 */
export function recipePfPerDay(
  state: SimState,
  labId: LabId,
  runningCount = 1,
): number {
  const current = trainingStateOf(state, labId).recipes.filter(
    (recipe) => recipe.status === "running",
  ).length;
  const extra = Math.max(0, Math.max(1, runningCount) - current);
  const extras = Array.from({ length: extra }, (_, index) =>
    recipeTrainContender(`${FORECAST_RECIPE_JOB_ID}-${index}`),
  );
  const shares = allocateLabTrainingPf(state, labId, extras);
  if (extras.length > 0) {
    return extras.reduce((sum, job) => sum + (shares[job.id] ?? 0), 0) / extras.length;
  }
  const running = trainingStateOf(state, labId).recipes.find(
    (recipe) => recipe.status === "running",
  );
  return running ? (shares[running.id] ?? 0) : trainPfForLab(state, labId);
}

function checkpointOf(
  training: TrainingState,
  checkpointId: string,
): Checkpoint | undefined {
  return training.checkpoints.find((checkpoint) => checkpoint.id === checkpointId);
}

function boxMuller(rng: Rng): number {
  let u = 0;
  while (u <= 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function drawEpsilon(seed: number, axis: string): number {
  const rng = createRng(hashSeed(seed, axis));
  const raw = boxMuller(rng) * EPSILON_SIGMA;
  const cap = EPSILON_CLAMP_SIGMAS * EPSILON_SIGMA;
  return clamp(raw, -cap, cap);
}

function noisyDeltas(
  deltas: PostTrainForecast["deltas"],
  recipeSeed: number,
): PostTrainForecast["deltas"] {
  const next: PostTrainForecast["deltas"] = {};
  for (const [key, value] of Object.entries(deltas)) {
    if (value == null) continue;
    const axis = key as keyof PostTrainForecast["deltas"];
    next[axis] = value * (1 + drawEpsilon(recipeSeed, key));
  }
  return next;
}

function forecastWarnings(input: {
  works: ReturnType<typeof planStages>["works"];
  selected: readonly Gym[];
  stages: readonly PostTrainStageKind[];
  unlocksTiers: boolean;
  checkpoint: Checkpoint;
}): string[] {
  const warnings: string[] = [];
  if (input.stages.includes("reasoning") && !hasReasoningGym(input.selected)) {
    warnings.push("missing gyms: reasoning needs a code, math, or science gym");
  }
  if (input.stages.includes("agentic") && !hasAgenticGym(input.selected)) {
    warnings.push("missing gyms: agentic needs an agentic gym");
  }
  if (
    input.stages.includes("preference") &&
    !input.selected.some((gym) => gym.kind === "safety")
  ) {
    warnings.push("missing gyms: no safety gym selected");
  }
  for (const work of input.works) {
    if (work.provided > 0 && work.adequacy < LOW_ADEQUACY) {
      warnings.push(`low adequacy: ${work.stage}`);
    }
    if (priorStageRuns(input.checkpoint, work.stage) > 0) {
      warnings.push(`repeat-stage diminishing: ${work.stage}`);
    }
  }
  if (input.stages.includes("reasoning") && !input.unlocksTiers) {
    warnings.push("tiers locked");
  }
  return warnings;
}

/**
 * Post-train PF = baseStage · (N_active_B / 7)^0.75 · dataScale(tokens).
 * effect = adequacy(data) · gymQuality · rlQuality · completeness(pf). Zero work = zero effect.
 */
export function forecastRecipe(
  state: SimState,
  labId: LabId,
  input: RecipeDraft,
): PostTrainForecast {
  const training = trainingStateOf(state, labId);
  const checkpoint = checkpointOf(training, input.checkpointId);
  const modifiers = labModifiers(state, labId);
  if (!checkpoint) {
    return {
      pfDays: 0,
      days: 0,
      cash: 0,
      deltas: {},
      unlocksTiers: false,
      adequacy: {},
      warnings: ["checkpoint missing"],
    };
  }
  const thinkingTrainBudgets = extraThinkingBudgetsToTrain(
    checkpoint,
    input.thinkingBudgets,
  );
  const planned = planStages({
    checkpoint,
    stages: input.stages,
    dataUse: input.dataUse,
    gyms: training.gyms,
    gymIds: input.gymIds,
    budgetPfDays: input.budgetPfDays,
    modifiers,
    thinkingTrainBudgets,
    poolQuality: training.poolQuality,
  });
  const running =
    training.recipes.filter((recipe) => recipe.status === "running").length + 1;
  const pfPerDay = recipePfPerDay(state, labId, running);
  const pfDays = planned.totalPfDays;
  const unlocksTiers =
    input.stages.includes("reasoning") && hasUnlock(modifiers, "thinking_tiers");
  const adequacy: Partial<Record<PostTrainStageKind, number>> = {};
  for (const work of planned.works) adequacy[work.stage] = work.adequacy;
  return {
    pfDays,
    days:
      pfDays <= 0
        ? 0
        : pfPerDay > 1e-12
          ? Math.ceil(pfDays / pfPerDay)
          : Number.POSITIVE_INFINITY,
    cash: pfDays * POST_TRAIN_CASH_PER_PF_DAY,
    deltas: deltasForWorks(planned.works, input.safetyFocus),
    unlocksTiers,
    adequacy,
    warnings: forecastWarnings({
      works: planned.works,
      selected: selectedGymsOf(training.gyms, input.gymIds),
      stages: input.stages,
      unlocksTiers,
      checkpoint,
    }),
  };
}

export function startRecipe(
  state: SimState,
  labId: LabId,
  input: RecipeDraft,
): { state: SimState; result: StartResult } {
  const training = trainingStateOf(state, labId);
  const checkpoint = checkpointOf(training, input.checkpointId);
  if (!checkpoint) {
    return { state, result: { ok: false, reason: "checkpoint missing" } };
  }
  if (checkpoint.status !== "stealth" && checkpoint.status !== "kept") {
    return { state, result: { ok: false, reason: "checkpoint status not stealth|kept" } };
  }
  if (
    training.recipes.some(
      (recipe) =>
        recipe.checkpointId === input.checkpointId && recipe.status === "running",
    )
  ) {
    return { state, result: { ok: false, reason: "already has a running recipe" } };
  }
  for (const stage of input.stages) {
    if (!(providedDataForStage(stage, input.dataUse) > 0)) {
      return { state, result: { ok: false, reason: `zero data: ${stage}` } };
    }
  }
  const selected = selectedGymsOf(training.gyms, input.gymIds);
  if (input.stages.includes("reasoning") && !hasReasoningGym(selected)) {
    return {
      state,
      result: { ok: false, reason: "reasoning without a code, math, or science gym" },
    };
  }
  if (input.stages.includes("agentic") && !hasAgenticGym(selected)) {
    return { state, result: { ok: false, reason: "agentic without an agentic gym" } };
  }
  const extras = extraThinkingBudgetsToTrain(checkpoint, input.thinkingBudgets);
  if (extras.length > 0) {
    if (!input.stages.includes("reasoning")) {
      return { state, result: { ok: false, reason: "thinking budgets need a reasoning stage" } };
    }
    if (!hasUnlock(labModifiers(state, labId), "thinking_tiers")) {
      return { state, result: { ok: false, reason: "thinking tiers locked" } };
    }
  }
  const pools = poolsFor(state, labId);
  for (const key of Object.keys(input.dataUse) as PostTrainPoolKind[]) {
    if ((input.dataUse[key] ?? 0) > pools[key] + 1e-9) {
      return { state, result: { ok: false, reason: `insufficient pool: ${key}` } };
    }
  }
  const forecast = forecastRecipe(state, labId, input);
  if (labId === state.playerLabId && state.player.cash + 1e-9 < forecast.cash) {
    return { state, result: { ok: false, reason: "insufficient cash" } };
  }

  let next = consumeFromPool(state, labId, input.dataUse);
  if (labId === next.playerLabId) next = debitPlayer(next, forecast.cash);
  const id = seededId("recipe", labId, next.day, input.checkpointId);
  const recipe: PostTrainRecipe = {
    ...input,
    id,
    labId,
    startDay: next.day,
    progress: 0,
    pfDaysDone: 0,
    status: "running",
    forecast,
    seed: hashSeed(next.seed, id),
  };
  const slice = trainingStateOf(next, labId);
  next = withTrainingState(next, labId, {
    ...slice,
    recipes: [...slice.recipes, recipe],
  });
  return { state: next, result: { ok: true, id } };
}

export function cancelRecipe(state: SimState, recipeId: string): SimState {
  for (const labId of labIdsOf(state)) {
    const training = trainingStateOf(state, labId);
    const recipe = training.recipes.find((entry) => entry.id === recipeId);
    if (!recipe) continue;
    if (recipe.status !== "running") return state;
    const unconsumed = 1 - clamp(recipe.progress, 0, 1);
    const refundShare = CANCEL_POOL_REFUND * unconsumed;
    let next = state;
    for (const key of Object.keys(recipe.dataUse) as PostTrainPoolKind[]) {
      const amount = (recipe.dataUse[key] ?? 0) * refundShare;
      if (amount > 0) next = addToPool(next, labId, key, amount);
    }
    const slice = trainingStateOf(next, labId);
    return withTrainingState(next, labId, {
      ...slice,
      recipes: slice.recipes.map((entry) =>
        entry.id === recipeId ? { ...entry, status: "cancelled" } : entry,
      ),
    });
  }
  return state;
}

function mergeStageRecords(
  source: Checkpoint,
  recipe: PostTrainRecipe,
  gyms: readonly Gym[],
  modifiers: TrainingModifiers,
  poolQuality: TrainingState["poolQuality"],
): Partial<Record<PostTrainStageKind, PostTrainStageRecord>> {
  const planned = planStages({
    checkpoint: source,
    stages: recipe.stages,
    dataUse: recipe.dataUse,
    gyms,
    gymIds: recipe.gymIds,
    budgetPfDays: recipe.budgetPfDays,
    modifiers,
    thinkingTrainBudgets: extraThinkingBudgetsToTrain(source, recipe.thinkingBudgets),
    poolQuality,
  });
  const stages = { ...source.postTrain.stages };
  for (const work of planned.works) {
    const prev = stages[work.stage];
    stages[work.stage] = {
      runs: (prev?.runs ?? 0) + 1,
      pfDays: (prev?.pfDays ?? 0) + work.pfDays,
      effect: (prev?.effect ?? 0) + work.effect,
    };
  }
  return stages;
}

function completeRecipe(
  training: TrainingState,
  recipe: PostTrainRecipe,
  day: number,
  modifiers: TrainingModifiers,
): { recipes: PostTrainRecipe[]; checkpoints: Checkpoint[]; evals: Eval[] } {
  const source = checkpointOf(training, recipe.checkpointId);
  if (!source) {
    return {
      checkpoints: training.checkpoints,
      evals: training.evals,
      recipes: training.recipes.map((entry) =>
        entry.id === recipe.id
          ? { ...entry, status: "completed", progress: 1 }
          : entry,
      ),
    };
  }
  const realized = noisyDeltas(recipe.forecast.deltas, recipe.seed);
  const truth = applyDeltasToTruth(
    source.truth,
    realized,
    domainCeiling(source, modifiers),
  );
  const unlocksTiers = recipe.forecast.unlocksTiers;
  const tiers =
    recipe.stages.includes("reasoning") && unlocksTiers
      ? mergeTrainedTiers(source.tiers, recipe.thinkingBudgets)
      : source.tiers;
  const inPlace = source.stage === "post";
  const resultId = inPlace ? source.id : seededId("ckpt", recipe.id);
  const postTrain = {
    stages: mergeStageRecords(source, recipe, training.gyms, modifiers, training.poolQuality),
    safetyFocus: recipe.stages.includes("preference")
      ? recipe.safetyFocus
      : source.postTrain.safetyFocus,
  };
  const result: Checkpoint = {
    ...source,
    id: resultId,
    parentId: inPlace ? source.parentId : source.id,
    recipeId: recipe.id,
    name: persistPostCheckpointName(source, training, orderedPostStages(postTrain.stages)),
    version: bumpMinorVersion(source.version),
    stage: "post",
    status: inPlace ? source.status : "kept",
    createdDay: inPlace ? source.createdDay : day,
    progressAtSnapshot: 1,
    truth,
    postTrain,
    tiers,
    endpointIds: inPlace ? source.endpointIds : [],
  };
  return {
    checkpoints: inPlace
      ? training.checkpoints.map((row) => (row.id === source.id ? result : row))
      : [...training.checkpoints, result],
    evals: inPlace
      ? training.evals.filter((row) => row.checkpointId !== source.id)
      : training.evals,
    recipes: training.recipes.map((entry) =>
      entry.id === recipe.id
        ? {
            ...entry,
            pfDaysDone: Math.max(entry.pfDaysDone, recipe.forecast.pfDays),
            progress: 1,
            status: "completed",
            resultCheckpointId: resultId,
          }
        : entry,
    ),
  };
}

export function tickRecipes(state: SimState): SimState {
  let next = state;
  for (const labId of labIdsOf(next)) {
    const training = trainingStateOf(next, labId);
    const running = training.recipes.filter((recipe) => recipe.status === "running");
    if (running.length === 0) continue;
    let shares: Record<string, number> = {};
    let util = 1;
    try {
      shares = allocateLabTrainingPf(next, labId);
      util = utilForLab(next, labId);
    } catch {
      shares = {};
      util = 1;
    }
    const modifiers = labModifiers(next, labId);
    let slice = training;
    for (const recipe of running) {
      const live = slice.recipes.find((entry) => entry.id === recipe.id);
      if (!live || live.status !== "running") continue;
      const pfToday = (shares[live.id] ?? 0) * util;
      const pfDaysDone = live.pfDaysDone + pfToday;
      const target = live.forecast.pfDays;
      const progress = target > 0 ? Math.min(1, pfDaysDone / target) : 1;
      const done = target <= 0 || pfDaysDone + 1e-9 >= target;
      if (!done) {
        slice = {
          ...slice,
          recipes: slice.recipes.map((entry) =>
            entry.id === live.id ? { ...entry, pfDaysDone, progress } : entry,
          ),
        };
        continue;
      }
      const advanced: PostTrainRecipe = { ...live, pfDaysDone, progress: 1 };
      slice = {
        ...slice,
        recipes: slice.recipes.map((entry) =>
          entry.id === live.id ? advanced : entry,
        ),
      };
      const finished = completeRecipe(slice, advanced, next.day, modifiers);
      slice = {
        ...slice,
        recipes: finished.recipes,
        checkpoints: finished.checkpoints,
        evals: finished.evals,
      };
    }
    next = withTrainingState(next, labId, slice);
  }
  return next;
}

function findGym(
  state: SimState,
  gymId: string,
): { labId: LabId; gym: Gym; training: TrainingState } | null {
  for (const labId of labIdsOf(state)) {
    const training = trainingStateOf(state, labId);
    const gym = training.gyms.find((entry) => entry.id === gymId);
    if (gym) return { labId, gym, training };
  }
  return null;
}

export function gymYieldContext(state: SimState, gym: Gym): GymYieldContext {
  const training = trainingStateOf(state, gym.labId);
  const teacher = gym.teacherCheckpointId
    ? checkpointOf(training, gym.teacherCheckpointId)
    : undefined;
  const usable =
    teacher &&
    (teacher.status === "kept" || teacher.status === "released");
  const teacherStrength = usable
    ? clamp(meanDomainCapability(teacher.truth) / 100, 0, 1)
    : 0;
  let syntheticQuality = 1;
  try {
    syntheticQuality = labModifiers(state, gym.labId).syntheticQuality;
  } catch {
    syntheticQuality = 1;
  }
  return { teacherStrength, syntheticQuality };
}

export function gymSynthTeacherUnlocked(state: SimState, labId: LabId): boolean {
  if (labId !== state.playerLabId) return true;
  return state.player.researchUnlocked.includes(GYM_SYNTH_TEACHER_NODE);
}

function stampGym(state: SimState, gym: Gym): Gym {
  const campus = applyGymCampus(gym);
  return {
    ...campus,
    quality: gymEmitQuality(campus, gymYieldContext(state, campus)),
  };
}

export function cleanPostTrainPoolCost(amount: number): number {
  if (!(amount > 0)) return 0;
  return Math.max(25_000, amount * 8);
}

export function tickGyms(state: SimState): SimState {
  let next = state;
  for (const labId of labIdsOf(next)) {
    const training = trainingStateOf(next, labId);
    if (training.gyms.length === 0) continue;
    let gyms = training.gyms.map((gym) => applyGymCampus(gym));
    next = withTrainingState(next, labId, { ...trainingStateOf(next, labId), gyms });
    const graded: Gym[] = [];
    for (const gym of gyms) {
      const budget = gymBudgetPerDay(gym);
      const isPlayer = labId === next.playerLabId;
      let producing = gym;
      if (isPlayer && budget > 0) {
        if (next.player.cash + 1e-9 < budget) {
          producing = { ...gym, budgetPerDay: 0 };
        } else {
          next = chargeExpense(next, budget, "research");
        }
      }
      const ctx = gymYieldContext(next, producing);
      const produced = gymDailyYield(producing, ctx);
      graded.push({ ...gym, quality: produced.quality });
      if (produced.amount > 0) {
        next = addToPool(next, labId, produced.kind, produced.amount, produced.quality);
      }
    }
    next = withTrainingState(next, labId, {
      ...trainingStateOf(next, labId),
      gyms: graded,
    });
  }
  return next;
}

export function createGym(
  state: SimState,
  labId: LabId,
  kind: GymKind,
): { state: SimState; result: StartResult } {
  const training = trainingStateOf(state, labId);
  if (training.gyms.some((gym) => gym.kind === kind)) {
    return { state, result: { ok: false, reason: "gym kind already exists" } };
  }
  if (labId === state.playerLabId && state.player.cash + 1e-9 < GYM_CREATE_CASH) {
    return { state, result: { ok: false, reason: "insufficient cash" } };
  }
  const spec = gymTierSpec(0);
  const id = seededId("gym", labId, kind);
  const gym: Gym = {
    id,
    labId,
    kind,
    tier: spec.tier,
    quality: spec.quality,
    tasksPerDay: spec.tasksPerDay,
    researchers: 0,
    researchShare: 0,
    budgetPerDay: 0,
    auditShare: 0,
  };
  let next = state;
  if (labId === next.playerLabId) next = debitPlayer(next, GYM_CREATE_CASH);
  const slice = trainingStateOf(next, labId);
  next = withTrainingState(next, labId, {
    ...slice,
    gyms: [...slice.gyms, stampGym(next, gym)],
  });
  return { state: next, result: { ok: true, id } };
}

export function upgradeGym(state: SimState, gymId: string): SimState {
  const found = findGym(state, gymId);
  if (!found) return state;
  if (found.gym.tier >= 3) return state;
  const monthly = GYM_TIER_MONTHLY[found.gym.tier + 1] ?? GYM_TIER_MONTHLY[3];
  return assignGymMonthlyBudget(state, gymId, monthly);
}

export function assignGymResearchers(
  state: SimState,
  gymId: string,
  n: number,
): SimState {
  const found = findGym(state, gymId);
  if (!found) return state;
  const requested = Math.round(n);
  let max = GYM_RESEARCHER_MAX;
  if (found.labId === state.playerLabId) {
    max = Math.min(
      GYM_RESEARCHER_MAX,
      availableHqStaff(state, { exceptTrainingGymId: gymId }).researchers,
    );
  }
  const researchers = clamp(requested, 0, max);
  if (researchers === found.gym.researchers) return state;
  return withTrainingState(state, found.labId, {
    ...found.training,
    gyms: found.training.gyms.map((gym) =>
      gym.id === gymId ? stampGym(state, { ...gym, researchers }) : gym,
    ),
  });
}

export function assignGymResearchShare(
  state: SimState,
  gymId: string,
  share: number,
): SimState {
  const found = findGym(state, gymId);
  if (!found) return state;
  const requested =
    Math.round(Math.max(0, share) / GYM_RESEARCH_SHARE_STEP) *
    GYM_RESEARCH_SHARE_STEP;
  const otherV4 = v4GymResearchReservationShare(found.training.gyms, gymId);
  const isPlayer = found.labId === state.playerLabId;
  const legacy = isPlayer
    ? gymResearchReservationShare(state.player.postTrainGyms)
    : 0;
  const dataShare = isPlayer
    ? dataResearchReservationShare(ensureLabData(state))
    : 0;
  const safetyShare = isPlayer && state.player.safetyCampaign ? 0.4 : 0;
  const researchShare = capGymResearchShare({
    requested,
    otherV4,
    legacy,
    dataShare,
    safetyShare,
  });
  if (Math.abs(researchShare - gymResearchShare(found.gym)) < 1e-9) return state;
  return withTrainingState(state, found.labId, {
    ...found.training,
    gyms: found.training.gyms.map((gym) =>
      gym.id === gymId ? stampGym(state, { ...gym, researchShare }) : gym,
    ),
  });
}

export function assignGymMonthlyBudget(
  state: SimState,
  gymId: string,
  monthly: number,
): SimState {
  const found = findGym(state, gymId);
  if (!found) return state;
  const snapped =
    Math.round(Math.max(0, monthly) / GYM_BUDGET_MONTH_STEP) *
    GYM_BUDGET_MONTH_STEP;
  const clamped = clamp(snapped, 0, GYM_BUDGET_MONTH_MAX);
  const budgetPerDay = monthlyBudgetToPerDay(clamped);
  if (Math.abs(budgetPerDay - gymBudgetPerDay(found.gym)) < 1e-9) return state;
  return withTrainingState(state, found.labId, {
    ...found.training,
    gyms: found.training.gyms.map((gym) =>
      gym.id === gymId ? stampGym(state, { ...gym, budgetPerDay }) : gym,
    ),
  });
}

export function assignGymTeacher(
  state: SimState,
  gymId: string,
  checkpointId: string | undefined,
): SimState {
  const found = findGym(state, gymId);
  if (!found) return state;
  if (!checkpointId) {
    if (!found.gym.teacherCheckpointId) return state;
    return withTrainingState(state, found.labId, {
      ...found.training,
      gyms: found.training.gyms.map((gym) =>
        gym.id === gymId
          ? stampGym(state, { ...gym, teacherCheckpointId: undefined })
          : gym,
      ),
    });
  }
  if (
    found.labId === state.playerLabId &&
    !gymSynthTeacherUnlocked(state, found.labId)
  ) {
    return state;
  }
  const teacher = checkpointOf(found.training, checkpointId);
  if (!teacher) return state;
  if (teacher.status !== "kept" && teacher.status !== "released") return state;
  if (found.gym.teacherCheckpointId === checkpointId) return state;
  return withTrainingState(state, found.labId, {
    ...found.training,
    gyms: found.training.gyms.map((gym) =>
      gym.id === gymId
        ? stampGym(state, { ...gym, teacherCheckpointId: checkpointId })
        : gym,
    ),
  });
}

export function assignGymAuditShare(
  state: SimState,
  gymId: string,
  share: number,
): SimState {
  const found = findGym(state, gymId);
  if (!found) return state;
  const auditShare = clamp(Math.round(share * 20) / 20, 0, 1);
  if (Math.abs(auditShare - gymAuditShare(found.gym)) < 1e-9) return state;
  return withTrainingState(state, found.labId, {
    ...found.training,
    gyms: found.training.gyms.map((gym) =>
      gym.id === gymId ? stampGym(state, { ...gym, auditShare }) : gym,
    ),
  });
}

export function cleanPostTrainPool(
  state: SimState,
  kind: PostTrainPoolKind,
): SimState {
  const training = trainingStateOf(state, state.playerLabId);
  const amount = Math.max(0, training.pools[kind] ?? 0);
  if (!(amount > 0)) return state;
  const quality = poolQualityOf(training, kind);
  const cash = cleanPostTrainPoolCost(amount);
  if (state.player.cash + 1e-9 < cash) return state;
  const discard = amount * (0.1 + 0.22 * (1 - quality));
  const kept = Math.max(0, amount - discard);
  const nextQuality = quality + (1 - quality) * 0.4;
  const paid = chargeExpense(state, cash, "research");
  const slice = trainingStateOf(paid, paid.playerLabId);
  return withTrainingState(paid, paid.playerLabId, {
    ...slice,
    pools: { ...slice.pools, [kind]: kept },
    poolQuality: {
      instructionMTok: poolQualityOf(slice, "instructionMTok"),
      preferenceMTok: poolQualityOf(slice, "preferenceMTok"),
      verifiableTasks: poolQualityOf(slice, "verifiableTasks"),
      toolTrajectories: poolQualityOf(slice, "toolTrajectories"),
      [kind]: kept > 0 ? nextQuality : 0,
    },
  });
}

/** lift(domain) = rlQuality · (1 − e^{−(budget−1)/tierLiftK}) · maxLift(domain). */
export function tierLift(
  budget: TierBudget,
  rlQuality: number,
  domain: CapabilityDomain,
): number {
  const k = TRAINING_V4.postTrain.tierLiftK;
  const maxLift = TRAINING_V4.maxLiftByDomain[domain];
  return rlQuality * (1 - Math.exp(-(budget - 1) / k)) * maxLift;
}

export function buyPostTrainData(
  state: SimState,
  kind: PostTrainPoolKind,
  amount: number,
): SimState {
  if (!(amount > 0)) return state;
  const cash = amount * POST_TRAIN_DATA_PRICE[kind];
  if (state.player.cash + 1e-9 < cash) return state;
  const paid = debitPlayer(state, cash);
  return addToPool(paid, paid.playerLabId, kind, amount, 0.62);
}

export function synthesizePostTrainData(
  state: SimState,
  input: {
    kind: PostTrainPoolKind;
    teacherCheckpointId: string;
    tierBudget: TierBudget;
    amount: number;
  },
): { state: SimState; result: StartResult } {
  const labId = state.playerLabId;
  if (!(input.amount > 0)) {
    return { state, result: { ok: false, reason: "amount must be positive" } };
  }
  const training = trainingStateOf(state, labId);
  const teacher = checkpointOf(training, input.teacherCheckpointId);
  if (!teacher) {
    return { state, result: { ok: false, reason: "teacher checkpoint missing" } };
  }
  if (teacher.status !== "kept" && teacher.status !== "released") {
    return { state, result: { ok: false, reason: "teacher must be kept or released" } };
  }
  const qualityFactor = clamp(meanDomainCapability(teacher.truth) / 100, 0, 1);
  const yieldAmount = Math.min(
    input.amount * SYNTH_YIELD_CAP,
    input.amount * qualityFactor * (1 + SYNTH_TIER_YIELD * (input.tierBudget - 1)),
  );
  const cash = input.amount * input.tierBudget * SYNTH_POST_TRAIN_RATE[input.kind];
  if (state.player.cash + 1e-9 < cash) {
    return { state, result: { ok: false, reason: "insufficient cash" } };
  }
  const id = seededId(
    "synth",
    labId,
    input.kind,
    input.teacherCheckpointId,
    state.day,
    input.amount,
  );
  let next = debitPlayer(state, cash);
  if (yieldAmount > 0) {
    next = addToPool(next, labId, input.kind, yieldAmount, qualityFactor * 0.48);
  }
  return { state: next, result: { ok: true, id } };
}

export {
  GYM_BUDGET_MONTH_MAX,
  GYM_BUDGET_MONTH_STEP,
  GYM_CREATE_CASH,
  GYM_DAYS_PER_MONTH,
  GYM_RESEARCH_SHARE_MAX,
  GYM_RESEARCH_SHARE_STEP,
  GYM_RESEARCHER_MAX,
  GYM_SYNTH_TEACHER_NODE,
  GYM_TIER_MONTHLY,
} from "./gyms";
export {
  STAGE_DATA_NEEDED_AT_7B,
  adequacyFor,
  neededDataForStage,
} from "./postTrainStages";
