import type { Model, SimState } from "../../../../../sim/types";
import { endpointHbmGB } from "../../../../../sim/training/endpoints";
import { publicScores } from "../../../../../sim/training/evaluate";
import { TRAINING_V4 } from "../../../../../sim/training/constants";
import { mergeParamDeltaOk } from "../../../../../sim/training/merge";
import { allocateLabTrainingPf, trainPfForLab } from "../../../../../sim/training/run";
import { trainingStateOf } from "../../../../../sim/training/state";
import { gymResearchReservationShare } from "../../../../../sim/balance/modelStudio";
import {
  dataResearchReservationShare,
  ensureLabData,
} from "../../../../../sim/systems/data";
import { availableHqStaff } from "../../../../../sim/systems/staffReservations";
import {
  applyGymCampus,
  capGymResearchShare,
  GYM_TIER_MONTHLY,
  gymAuditShare,
  gymBalance,
  gymBudgetPerDay,
  gymDailyYield,
  gymHasGrader,
  gymProductionKind,
  gymResearchShare,
  v4GymResearchReservationShare,
} from "../../../../../sim/training/gyms";
import {
  cleanPostTrainPoolCost,
  gymSynthTeacherUnlocked,
  gymYieldContext,
} from "../../../../../sim/training/postTrain";
import { poolQualityOf } from "../../../../../sim/training/dataBridge";
import { competitorShips, fleetAgingFraction } from "../../../../../sim/balance/modelAging";
import { discardBlockReason } from "../../../../../sim/training/checkpoints";
import { checkpointDisplayName, orderedPostStages } from "../../../../../sim/training/naming";
import { hasUnlock, modifiersForLab } from "../../../../../sim/training/modifiers";
import type {
  Architecture,
  Checkpoint,
  CheckpointStatus,
  Eval,
  EvalMeasurement,
  EvalMetric,
  LossSample,
  PostTrainRecipe,
  PostTrainStageKind,
  TrainingRun,
  TrainingState,
  TrainingUnlock,
} from "../../../../../sim/training/types";
import type {
  ArchGlyphKind,
  CapBandVM,
  CheckpointAction,
  CheckpointCardVM,
  EndpointCardVM,
  FleetVM,
  GymCardVM,
  GymsVM,
  LineageNodeVM,
  PipelineBoardVM,
  PipelineForestNodeVM,
  PipelineLineageVM,
  RecipeCardVM,
  RunCardVM,
} from "./types";

export function sizeLabel(arch: Architecture): string {
  if (arch.backbone === "moe") {
    return `${formatParamsShort(arch.totalParamsB)}/${formatParamsShort(arch.activeParamsB)} active`;
  }
  return formatParamsShort(arch.totalParamsB);
}

export function glyphFor(arch: Architecture): ArchGlyphKind {
  if (arch.preset === "omni") return "omni";
  if (arch.backbone === "moe") return "moe";
  if (arch.preset !== "language") return "specialist";
  return "dense";
}

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);
const CHECKPOINT_COLUMN_STATUS = new Set<CheckpointStatus>(["stealth", "kept"]);
const MERGE_ELIGIBLE = new Set<CheckpointStatus>(["stealth", "kept", "released"]);
const FOREST_STATUS = new Set<CheckpointStatus>(["stealth", "kept", "released"]);

function trimScale(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatParamsShort(paramsB: number): string {
  const abs = Math.abs(paramsB);
  if (abs >= 1000) return `${trimScale(paramsB / 1000)}T`;
  if (abs >= 1) return `${trimScale(paramsB)}B`;
  if (abs >= 0.001) return `${trimScale(paramsB * 1000)}M`;
  return `${trimScale(paramsB * 1e6)}K`;
}

/** Existing 100% snapshots stored `0.100`; new snapshots use `1.0`. */
function displayVersion(version: string): string {
  if (version === "0.100") return "1.0";
  return version;
}

function playerTraining(state: SimState): TrainingState {
  return trainingStateOf(state, state.playerLabId);
}

function ceilingFor(arch: Architecture): number {
  const glyph = glyphFor(arch);
  if (glyph === "omni") return TRAINING_V4.ceilings.omni;
  if (glyph === "moe") return TRAINING_V4.ceilings.moe;
  if (glyph === "specialist") return TRAINING_V4.ceilings.specialist;
  return TRAINING_V4.ceilings.dense;
}

function completeEvals(training: TrainingState, checkpointId: string): Eval[] {
  return training.evals
    .filter((entry) => entry.checkpointId === checkpointId && entry.status === "complete" && entry.result)
    .slice()
    .sort((a, b) => b.completeDay - a.completeDay || b.orderedDay - a.orderedDay);
}

function latestCompleteEval(training: TrainingState, checkpointId: string): Eval | undefined {
  return completeEvals(training, checkpointId)[0];
}

function hasCompleteEval(training: TrainingState, checkpointId: string): boolean {
  return latestCompleteEval(training, checkpointId) != null;
}

function hasCompletedPostRecipe(training: TrainingState, checkpointId: string): boolean {
  return training.recipes.some(
    (recipe) => recipe.checkpointId === checkpointId && recipe.status === "completed",
  );
}

function hasReadyPostChild(training: TrainingState, checkpointId: string): boolean {
  return training.checkpoints.some(
    (row) =>
      row.parentId === checkpointId &&
      row.stage === "post" &&
      (row.status === "kept" || row.status === "released"),
  );
}

function bandFromEval(evalRow: Eval | undefined, arch: Architecture): CapBandVM | null {
  const overall = evalRow?.result?.measured.overall;
  if (!overall) return null;
  return {
    p10: overall.mean - overall.ci,
    p50: overall.mean,
    p90: overall.mean + overall.ci,
    ceiling: ceilingFor(arch),
  };
}

function measuredFromEval(evalRow: Eval | undefined): Partial<Record<EvalMetric, EvalMeasurement>> {
  return evalRow?.result?.measured ?? {};
}

function childIdsOf(training: TrainingState, checkpointId: string): string[] {
  return training.checkpoints.filter((entry) => entry.parentId === checkpointId).map((entry) => entry.id);
}

function lineageDepthOf(training: TrainingState, checkpoint: Checkpoint): number {
  let depth = 0;
  let cursor: Checkpoint | undefined = checkpoint;
  const seen = new Set<string>();
  while (cursor?.parentId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = training.checkpoints.find((entry) => entry.id === cursor?.parentId);
    if (!parent) break;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

function withinMergeFamily(a: Checkpoint, b: Checkpoint): boolean {
  return (
    a.arch.backbone === b.arch.backbone &&
    a.arch.preset === b.arch.preset &&
    mergeParamDeltaOk(a.arch.totalParamsB, b.arch.totalParamsB)
  );
}

function checkpointCanOpenSource(training: TrainingState, checkpoint: Checkpoint): boolean {
  if (checkpoint.status !== "released") return false;
  return training.endpoints.some(
    (endpoint) =>
      checkpoint.endpointIds.includes(endpoint.id) &&
      !endpoint.openWeights &&
      (endpoint.status === "live" || endpoint.status === "sunset"),
  );
}

function checkpointActions(
  training: TrainingState,
  checkpoint: Checkpoint,
  unlocks: { continue: boolean; distill: boolean; merge: boolean },
): { actions: CheckpointAction[]; actionLocks: Partial<Record<CheckpointAction, string>> } {
  const actionLocks: Partial<Record<CheckpointAction, string>> = {};
  if (checkpoint.status === "sold" || checkpoint.status === "discarded" || checkpoint.status === "retired") {
    return { actions: [], actionLocks };
  }

  let actions: CheckpointAction[] =
    checkpoint.status === "released"
      ? [
          "continue",
          "distill",
          "merge",
          "postTrain",
          "evaluate",
          ...(checkpointCanOpenSource(training, checkpoint) ? (["openSource"] as const) : []),
        ]
      : [
          "continue",
          "branch",
          "distill",
          "merge",
          "postTrain",
          "evaluate",
          "release",
          ...(checkpoint.status === "stealth" ? (["keep"] as const) : []),
          "discard",
        ];

  if (checkpoint.stage === "post") {
    actions = actions.filter((action) => action !== "continue" && action !== "branch");
  } else if (!unlocks.continue) {
    actionLocks.continue = "Research continued pretraining first.";
    actionLocks.branch = "Research continued pretraining first.";
  }
  if (!unlocks.distill) {
    actionLocks.distill = "Research distillation first.";
  }
  const partners = training.checkpoints.filter(
    (entry) =>
      entry.id !== checkpoint.id &&
      MERGE_ELIGIBLE.has(entry.status) &&
      withinMergeFamily(entry, checkpoint),
  );
  if (!unlocks.merge) {
    actionLocks.merge = "Research checkpoint merge first.";
  } else if (partners.length === 0) {
    actionLocks.merge =
      "Need another stealth, kept, or released checkpoint within 5% params and the same family.";
  }
  if (actions.includes("discard")) {
    const discardLock = discardBlockReason(training, checkpoint);
    if (discardLock) actionLocks.discard = discardLock;
  }

  return { actions, actionLocks };
}

function isReadyCheckpoint(training: TrainingState, checkpoint: Checkpoint): boolean {
  if (checkpoint.status !== "kept") return false;
  if (hasReadyPostChild(training, checkpoint.id)) return false;
  if (checkpoint.stage === "post") return true;
  return hasCompleteEval(training, checkpoint.id);
}

function isCheckpointColumn(training: TrainingState, checkpoint: Checkpoint): boolean {
  if (checkpoint.stage !== "base") return false;
  if (!CHECKPOINT_COLUMN_STATUS.has(checkpoint.status)) return false;
  if (hasCompletedPostRecipe(training, checkpoint.id)) return false;
  if (hasReadyPostChild(training, checkpoint.id)) return false;
  return !isReadyCheckpoint(training, checkpoint);
}

function toRunCard(
  run: TrainingRun,
  shares: Record<string, number>,
): RunCardVM {
  const days = Math.max(1, run.forecast.compute.days);
  const unresolved = run.incidents.some((incident) => incident.resolvedChoiceId == null);
  const last = run.lossCurve.at(-1)?.loss;
  const contender = run.status === "running" || run.status === "queued";
  return {
    id: run.id,
    name: run.design.name,
    glyph: glyphFor(run.design.arch),
    sizeLabel: sizeLabel(run.design.arch),
    progress: run.progress,
    etaDays: run.etaDays,
    burnPerDay: run.forecast.compute.cashEstimate / days,
    band: {
      p10: run.forecast.capability.p10,
      p50: run.forecast.capability.p50,
      p90: run.forecast.capability.p90,
      ceiling: run.forecast.capability.ceiling,
    },
    incidentCount: run.incidents.length,
    pendingDecision: run.status === "awaiting_decision" || unresolved,
    status: run.status,
    mode: run.design.mode.kind,
    lastLoss: last != null && Number.isFinite(last) ? last : null,
    lossCurve: run.lossCurve,
    pfPerDay: run.design.compute.pfPerDay,
    pfAllocated: contender ? (shares[run.id] ?? 0) : 0,
    pfDaysDone: run.pfDaysDone,
    pfDaysTotal: run.pfDaysTotal,
    priority: run.design.compute.priority,
    parentCheckpointId: runAnchorId(run),
  };
}

function runAnchorId(run: TrainingRun): string | undefined {
  if (run.parentCheckpointId) return run.parentCheckpointId;
  if (run.design.mode.kind === "continue") return run.design.mode.parentCheckpointId;
  if (run.design.mode.kind === "distill") return run.design.mode.teacherCheckpointId;
  return run.teacherCheckpointId;
}

function lossCurveForCheckpoint(training: TrainingState, checkpoint: Checkpoint): LossSample[] {
  const run = checkpoint.runId
    ? training.runs.find((row) => row.id === checkpoint.runId)
    : undefined;
  if (!run) return [];
  const cap = checkpoint.progressAtSnapshot + 1e-6;
  return run.lossCurve.filter((sample) => sample.progress <= cap);
}

function postStageRows(checkpoint: Checkpoint): CheckpointCardVM["postStages"] {
  const stages = checkpoint.postTrain.stages;
  return orderedPostStages(stages).flatMap((kind: PostTrainStageKind) => {
    const row = stages[kind];
    return row ? [{ kind, runs: row.runs, pfDays: row.pfDays, effect: row.effect }] : [];
  });
}

function toCheckpointCard(
  training: TrainingState,
  checkpoint: Checkpoint,
  unlocks: { continue: boolean; distill: boolean; merge: boolean },
): CheckpointCardVM {
  const latest = latestCompleteEval(training, checkpoint.id);
  const { actions, actionLocks } = checkpointActions(training, checkpoint, unlocks);
  return {
    id: checkpoint.id,
    name: checkpointDisplayName(checkpoint, training),
    version: displayVersion(checkpoint.version),
    glyph: glyphFor(checkpoint.arch),
    sizeLabel: sizeLabel(checkpoint.arch),
    lineageId: checkpoint.lineageId,
    stage: checkpoint.stage,
    status: checkpoint.status,
    band: bandFromEval(latest, checkpoint.arch),
    measured: measuredFromEval(latest),
    tiers: checkpoint.tiers,
    createdDay: checkpoint.createdDay,
    lineageDepth: lineageDepthOf(training, checkpoint),
    parentId: checkpoint.parentId,
    childIds: childIdsOf(training, checkpoint.id),
    endpointIds: checkpoint.endpointIds,
    lastLoss: Number.isFinite(checkpoint.trainingSummary.loss) ? checkpoint.trainingSummary.loss : null,
    pfDays: checkpoint.trainingSummary.pfDays,
    actions,
    actionLocks,
    lossCurve: lossCurveForCheckpoint(training, checkpoint),
    precision: checkpoint.arch.precision,
    backbone: checkpoint.arch.backbone,
    preset: checkpoint.arch.preset,
    inputs: [...checkpoint.arch.inputs],
    outputs: [...checkpoint.arch.outputs],
    dataMix: { ...checkpoint.trainingSummary.dataMix },
    syntheticShare: checkpoint.trainingSummary.syntheticShare,
    postStages: postStageRows(checkpoint),
    safetyFocus: checkpoint.postTrain.safetyFocus,
  };
}

function toRecipeCard(
  training: TrainingState,
  recipe: PostTrainRecipe,
  shares: Record<string, number>,
): RecipeCardVM {
  const checkpoint = training.checkpoints.find((entry) => entry.id === recipe.checkpointId);
  const days = Math.max(1, recipe.forecast.days);
  const pfAllocated = recipe.status === "running" ? (shares[recipe.id] ?? 0) : 0;
  const remainingPf = Math.max(0, recipe.forecast.pfDays - recipe.pfDaysDone);
  return {
    id: recipe.id,
    checkpointId: recipe.checkpointId,
    checkpointName: checkpoint
      ? checkpointDisplayName(checkpoint, training)
      : recipe.checkpointId,
    stages: recipe.stages,
    progress: recipe.progress,
    etaDays: pfAllocated > 1e-9 ? remainingPf / pfAllocated : remainingPf > 0 ? Number.POSITIVE_INFINITY : 0,
    burnPerDay: recipe.forecast.cash / days,
    pfAllocated,
    status: recipe.status,
  };
}

function labUnlockFlags(state: SimState): { continue: boolean; distill: boolean; merge: boolean } {
  try {
    const mods = modifiersForLab(state, state.playerLabId);
    return {
      continue: hasUnlock(mods, "continued_pretrain"),
      distill: hasUnlock(mods, "distill"),
      merge: hasUnlock(mods, "merge"),
    };
  } catch {
    return { continue: false, distill: false, merge: false };
  }
}

function trainingShares(state: SimState, _training: TrainingState): Record<string, number> {
  try {
    return allocateLabTrainingPf(state, state.playerLabId);
  } catch {
    return {};
  }
}

function earliestCreatedDay(node: PipelineForestNodeVM): number {
  if (node.kind === "checkpoint") return node.card.createdDay;
  return Number.POSITIVE_INFINITY;
}

function buildPipelineLineages(
  checkpoints: CheckpointCardVM[],
  recipes: RecipeCardVM[],
  runs: RunCardVM[],
): PipelineLineageVM[] {
  const byId = new Map(checkpoints.map((card) => [card.id, card]));
  const grouped = new Map<string, CheckpointCardVM[]>();
  for (const card of checkpoints) {
    const bucket = grouped.get(card.lineageId) ?? [];
    bucket.push(card);
    grouped.set(card.lineageId, bucket);
  }

  const recipesByCkpt = new Map<string, RecipeCardVM[]>();
  for (const recipe of recipes) {
    if (!byId.has(recipe.checkpointId)) continue;
    const bucket = recipesByCkpt.get(recipe.checkpointId) ?? [];
    bucket.push(recipe);
    recipesByCkpt.set(recipe.checkpointId, bucket);
  }

  const runsByCkpt = new Map<string, RunCardVM[]>();
  for (const run of runs) {
    const parent = run.parentCheckpointId;
    if (!parent || !byId.has(parent)) continue;
    const bucket = runsByCkpt.get(parent) ?? [];
    bucket.push(run);
    runsByCkpt.set(parent, bucket);
  }

  const lineages: PipelineLineageVM[] = [];
  for (const [lineageId, family] of grouped) {
    const familyIds = new Set(family.map((card) => card.id));
    const childrenOf = new Map<string, CheckpointCardVM[]>();
    for (const card of family) {
      const parentKey = card.parentId && familyIds.has(card.parentId) ? card.parentId : "";
      const bucket = childrenOf.get(parentKey) ?? [];
      bucket.push(card);
      childrenOf.set(parentKey, bucket);
    }
    for (const bucket of childrenOf.values()) {
      bucket.sort((a, b) => a.createdDay - b.createdDay || a.id.localeCompare(b.id));
    }

    const toNode = (card: CheckpointCardVM, trail: Set<string>): PipelineForestNodeVM => {
      const nextTrail = new Set(trail);
      nextTrail.add(card.id);
      const ckptKids = (childrenOf.get(card.id) ?? []).filter((child) => !trail.has(child.id));
      const recipeKids: PipelineForestNodeVM[] = (recipesByCkpt.get(card.id) ?? []).map((recipe) => ({
        kind: "recipe",
        card: recipe,
        children: [],
      }));
      const runKids: PipelineForestNodeVM[] = (runsByCkpt.get(card.id) ?? []).map((run) => ({
        kind: "run",
        card: run,
        children: [],
      }));
      return {
        kind: "checkpoint",
        card,
        children: [...ckptKids.map((child) => toNode(child, nextTrail)), ...recipeKids, ...runKids],
      };
    };

    const roots = (childrenOf.get("") ?? []).map((card) => toNode(card, new Set()));
    const rootName =
      roots.find((node) => node.kind === "checkpoint")?.card.name ?? lineageId;
    lineages.push({ id: lineageId, name: rootName, roots });
  }

  lineages.sort((a, b) => {
    const dayA = Math.min(...a.roots.map(earliestCreatedDay), Number.POSITIVE_INFINITY);
    const dayB = Math.min(...b.roots.map(earliestCreatedDay), Number.POSITIVE_INFINITY);
    return dayA - dayB || a.id.localeCompare(b.id);
  });
  return lineages;
}

export function selectPipelineBoard(state: SimState): PipelineBoardVM {
  const training = playerTraining(state);
  const unlocks = labUnlockFlags(state);
  const shares = trainingShares(state, training);
  const runCards = training.runs
    .filter((run) => !TERMINAL_RUN.has(run.status))
    .map((run) => toRunCard(run, shares));
  const checkpointCards = training.checkpoints
    .filter((checkpoint) => isCheckpointColumn(training, checkpoint))
    .map((checkpoint) => toCheckpointCard(training, checkpoint, unlocks));
  const recipeCards = training.recipes
    .filter((recipe) => recipe.status === "running")
    .map((recipe) => toRecipeCard(training, recipe, shares));
  const readyCards = training.checkpoints
    .filter((checkpoint) => isReadyCheckpoint(training, checkpoint))
    .map((checkpoint) => toCheckpointCard(training, checkpoint, unlocks));
  const forestCheckpoints = training.checkpoints
    .filter((checkpoint) => FOREST_STATUS.has(checkpoint.status))
    .map((checkpoint) => toCheckpointCard(training, checkpoint, unlocks));
  const forestIds = new Set(forestCheckpoints.map((card) => card.id));
  const lineages = buildPipelineLineages(forestCheckpoints, recipeCards, runCards);
  let trainingPfPool = 0;
  try {
    trainingPfPool = trainPfForLab(state, state.playerLabId);
  } catch {
    trainingPfPool = 0;
  }
  return {
    training: runCards,
    checkpoints: checkpointCards,
    postTraining: recipeCards,
    ready: readyCards,
    lineages,
    unattachedTraining: runCards.filter(
      (card) => !card.parentCheckpointId || !forestIds.has(card.parentCheckpointId),
    ),
    unattachedRecipes: recipeCards.filter((card) => !forestIds.has(card.checkpointId)),
    trainingPfPool,
    trainingPfAllocated:
      runCards.reduce((sum, card) => sum + card.pfAllocated, 0) +
      recipeCards.reduce((sum, card) => sum + card.pfAllocated, 0),
  };
}

function modelForEndpoint(state: SimState, modelId: string): Model | undefined {
  return state.player.models.find((model) => model.id === modelId);
}

function financeForEndpoint(state: SimState, modelId: string) {
  return state.lastMarket.modelFinance.find((row) => row.modelId === modelId);
}

function endpointRevenuePerDay(state: SimState, modelId: string): number {
  const finance = financeForEndpoint(state, modelId);
  if (finance) {
    return finance.dayApiRevenue + finance.daySubRevenue + finance.dayEnterpriseShare;
  }
  const model = modelForEndpoint(state, modelId);
  if (!model?.economics) return 0;
  return 0;
}

function endpointShare(state: SimState, modelId: string): number {
  const usage = state.lastMarket.apiModelUsage?.find((row) => row.modelId === modelId);
  if (usage) return usage.share;
  return 0;
}

function safeHbmGB(state: SimState, endpoint: TrainingState["endpoints"][number]): number {
  try {
    return endpointHbmGB(state, endpoint);
  } catch {
    return 0;
  }
}

function safePublicScores(state: SimState, endpointId: string): Partial<Record<EvalMetric, number>> {
  try {
    return publicScores(state, endpointId);
  } catch {
    return {};
  }
}

function endpointOwnCapability(
  training: TrainingState,
  endpoint: TrainingState["endpoints"][number],
  model: Model | undefined,
): number {
  if (model && Number.isFinite(model.capability)) return model.capability;
  let sum = 0;
  let n = 0;
  for (const member of endpoint.members) {
    const language = training.checkpoints.find((row) => row.id === member.checkpointId)?.truth.domains
      .language;
    if (typeof language !== "number" || !Number.isFinite(language)) continue;
    sum += language;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

function toEndpointCard(
  state: SimState,
  training: TrainingState,
  endpoint: TrainingState["endpoints"][number],
  rivalShips: ReturnType<typeof competitorShips>,
): EndpointCardVM {
  const model = modelForEndpoint(state, endpoint.modelId);
  const sunset =
    endpoint.sunset && endpoint.status === "sunset"
      ? Math.max(0, endpoint.sunset.startDay + endpoint.sunset.drainDays - state.day)
      : undefined;
  return {
    id: endpoint.id,
    name: endpoint.name,
    policy: endpoint.policy,
    memberNames: endpoint.members.map((member) => {
      const checkpoint = training.checkpoints.find((entry) => entry.id === member.checkpointId);
      return checkpoint?.name ?? member.checkpointId;
    }),
    status: endpoint.status,
    revenuePerDay: endpointRevenuePerDay(state, endpoint.modelId),
    share: endpointShare(state, endpoint.modelId),
    tokPerSec: model?.serviceProfile?.interactiveTokPerSec ?? 0,
    agingPct: fleetAgingFraction({
      releaseDay: endpoint.releaseDay,
      day: state.day,
      rivalShips,
      ownCapability: endpointOwnCapability(training, endpoint, model),
    }),
    tiers: endpoint.tiers,
    hbmGB: safeHbmGB(state, endpoint),
    publicScores: safePublicScores(state, endpoint.id),
    sunsetDaysLeft: sunset,
    openWeights: endpoint.openWeights,
  };
}

export function selectFleet(state: SimState): FleetVM {
  const training = playerTraining(state);
  const rivalShips = competitorShips(state, state.playerLabId);
  const endpoints = training.endpoints.map((endpoint) =>
    toEndpointCard(state, training, endpoint, rivalShips),
  );
  return {
    endpoints,
    totalRevenuePerDay: endpoints.reduce((sum, card) => sum + card.revenuePerDay, 0),
    totalHbmGB: endpoints.reduce((sum, card) => sum + card.hbmGB, 0),
  };
}

function toGymCard(
  state: SimState,
  gym: TrainingState["gyms"][number],
  spareResearchers: number,
  spareResearchShare: number,
  extras: {
    synthUnlocked: boolean;
    teachers: { id: string; name: string }[];
  },
): GymCardVM {
  const budgetPerDay = gymBudgetPerDay(gym);
  const pausedForCash = budgetPerDay > 0 && state.player.cash + 1e-9 < budgetPerDay;
  const producing = applyGymCampus(
    pausedForCash ? { ...gym, budgetPerDay: 0 } : gym,
  );
  const ctx = gymYieldContext(state, producing);
  const produced = gymDailyYield(producing, ctx);
  const campus = applyGymCampus(gym);
  const poolKind = gymProductionKind(gym.kind);
  const training = playerTraining(state);
  const poolAmount = Math.max(0, training.pools[poolKind] ?? 0);
  const poolQuality = poolQualityOf(training, poolKind);
  const cleanCash = cleanPostTrainPoolCost(poolAmount);
  return {
    id: gym.id,
    kind: gym.kind,
    tier: campus.tier,
    quality: produced.quality,
    tasksPerDay: campus.tasksPerDay,
    researchers: gym.researchers,
    spareResearchers,
    researchShare: gymResearchShare(gym),
    spareResearchShare,
    budgetPerDay,
    yieldPerDay: produced.amount,
    yieldUnit: gym.kind === "safety" ? "preferenceMTok" : "tasks",
    bottleneck: gymBalance(producing, ctx).bottleneck,
    pausedForCash,
    auditShare: gymAuditShare(gym),
    teacherCheckpointId: gym.teacherCheckpointId,
    synthUnlocked: extras.synthUnlocked,
    teachers: extras.teachers,
    poolKind,
    poolAmount,
    poolQuality,
    cleanCash,
    canClean: poolAmount > 0 && state.player.cash + 1e-9 >= cleanCash,
    nextTierMonthly:
      campus.tier >= 3 ? null : (GYM_TIER_MONTHLY[campus.tier + 1] ?? null),
    needsGrader: !gymHasGrader(producing, ctx.teacherStrength),
  };
}

export function selectGyms(state: SimState): GymsVM {
  const training = playerTraining(state);
  let spareResearchers = 0;
  try {
    spareResearchers = availableHqStaff(state).researchers;
  } catch {
    spareResearchers = 0;
  }
  const legacy = gymResearchReservationShare(state.player.postTrainGyms);
  let dataShare = 0;
  try {
    dataShare = dataResearchReservationShare(ensureLabData(state));
  } catch {
    dataShare = 0;
  }
  const safetyShare = state.player.safetyCampaign ? 0.4 : 0;
  const synthUnlocked = gymSynthTeacherUnlocked(state, state.playerLabId);
  const teachers = training.checkpoints
    .filter((row) => row.status === "kept" || row.status === "released")
    .map((row) => ({ id: row.id, name: row.name }));
  return {
    gyms: training.gyms.map((gym) => {
      const otherV4 = v4GymResearchReservationShare(training.gyms, gym.id);
      const maxShare = capGymResearchShare({
        requested: 1,
        otherV4,
        legacy,
        dataShare,
        safetyShare,
      });
      const spareResearchShare = Math.max(0, maxShare - gymResearchShare(gym));
      return toGymCard(state, gym, spareResearchers, spareResearchShare, {
        synthUnlocked,
        teachers,
      });
    }),
    pools: training.pools,
  };
}

export function selectLineage(state: SimState, checkpointId: string): LineageNodeVM[] {
  const training = playerTraining(state);
  const selected = training.checkpoints.find((entry) => entry.id === checkpointId);
  if (!selected) return [];

  const family = training.checkpoints.filter((entry) => entry.lineageId === selected.lineageId);
  const byId = new Map(family.map((entry) => [entry.id, entry]));
  const childrenOf = new Map<string, Checkpoint[]>();
  for (const entry of family) {
    const parentKey = entry.parentId && byId.has(entry.parentId) ? entry.parentId : "";
    const bucket = childrenOf.get(parentKey) ?? [];
    bucket.push(entry);
    childrenOf.set(parentKey, bucket);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.createdDay - b.createdDay || a.id.localeCompare(b.id));
  }

  const pathIds = new Set<string>();
  let cursor: Checkpoint | undefined = selected;
  const pathSeen = new Set<string>();
  while (cursor && !pathSeen.has(cursor.id)) {
    pathSeen.add(cursor.id);
    pathIds.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }

  const toNode = (checkpoint: Checkpoint, trail: Set<string>): LineageNodeVM => {
    const nextTrail = new Set(trail);
    nextTrail.add(checkpoint.id);
    const kids = (childrenOf.get(checkpoint.id) ?? []).filter((child) => !trail.has(child.id));
    return {
      id: checkpoint.id,
      name: checkpointDisplayName(checkpoint, training),
      version: displayVersion(checkpoint.version),
      stage: checkpoint.stage,
      status: checkpoint.status,
      depth: lineageDepthOf(training, checkpoint),
      isSelected: checkpoint.id === checkpointId,
      onPath: pathIds.has(checkpoint.id),
      children: kids.map((child) => toNode(child, nextTrail)),
    };
  };

  let root = selected;
  const climb = new Set<string>();
  while (root.parentId && byId.has(root.parentId) && !climb.has(root.id)) {
    climb.add(root.id);
    root = byId.get(root.parentId)!;
  }

  const sameRunRoots =
    selected.parentId == null && selected.runId
      ? (childrenOf.get("") ?? []).filter((entry) => entry.runId === selected.runId)
      : [root];

  return sameRunRoots.map((entry) => toNode(entry, new Set()));
}

export function selectCheckpointCard(state: SimState, id: string): CheckpointCardVM | null {
  const training = playerTraining(state);
  const checkpoint = training.checkpoints.find((entry) => entry.id === id);
  if (!checkpoint) return null;
  return toCheckpointCard(training, checkpoint, labUnlockFlags(state));
}

export function selectRunCard(state: SimState, id: string): RunCardVM | null {
  const training = playerTraining(state);
  const run = training.runs.find((entry) => entry.id === id);
  if (!run) return null;
  return toRunCard(run, trainingShares(state, training));
}

export function selectRecipeCard(state: SimState, id: string): RecipeCardVM | null {
  const training = playerTraining(state);
  const recipe = training.recipes.find((entry) => entry.id === id);
  if (!recipe) return null;
  return toRecipeCard(training, recipe, trainingShares(state, training));
}

export function selectWorkbenchStats(state: SimState): {
  runsInFlight: number;
  checkpointsKept: number;
  endpointsLive: number;
  trainingPf: number;
} {
  const training = playerTraining(state);
  let trainingPf = 0;
  try {
    trainingPf = trainPfForLab(state, state.playerLabId);
  } catch {
    trainingPf = 0;
  }
  return {
    runsInFlight: training.runs.filter((run) => !TERMINAL_RUN.has(run.status)).length,
    checkpointsKept: training.checkpoints.filter((checkpoint) => checkpoint.status === "kept").length,
    endpointsLive: training.endpoints.filter((endpoint) => endpoint.status === "live").length,
    trainingPf,
  };
}

export function selectLabUnlocks(state: SimState, labId = state.playerLabId): TrainingUnlock[] {
  return modifiersForLab(state, labId).unlocks;
}
