import { createGame } from "../../../../../sim/createGame";
import { withTrainingState, emptyTrainingState, defaultArchitecture, defaultDesign } from "../../../../../sim/training/state";
import { baselineModifiers } from "../../../../../sim/training/modifiers";
import type {
  Checkpoint,
  Eval,
  Endpoint,
  Forecast,
  PostTrainForecast,
  PostTrainRecipe,
  RunIncident,
  TrainingRun,
  TrainingState,
} from "../../../../../sim/training/types";
import type { ModelCapabilities, SimState } from "../../../../../sim/types";

export function emptyTruth(): ModelCapabilities {
  return {
    domains: {
      language: 0,
      reasoning: 0,
      code: 0,
      math: 0,
      science: 0,
      vision: 0,
      video: 0,
      audio: 0,
      tools: 0,
    },
    factuality: 0,
    steerability: 0,
    robustness: 0,
    safety: 0,
    reliability: 0,
  };
}

export function stubForecast(over: Partial<Forecast> = {}): Forecast {
  return {
    compute: {
      trainPfDays: 10,
      holdoutPfDays: 1,
      totalPfDays: 11,
      archCost: 1,
      modalityCost: 1,
      throughput: 1,
      days: 12,
      paceFloorDays: 8,
      trainHbmGB: 48,
      cashEstimate: 120_000,
    },
    loss: {
      nEff: 7e9,
      dEff: 1.4e11,
      paramTerm: 1,
      dataTerm: 1,
      loss: 2.1,
      precisionPenalty: 0,
      gap: 0.41,
    },
    effectiveData: {
      rawMTok: 140000,
      uniqueMTok: 140000,
      effectiveMTok: 140000,
      qualityWeight: 1,
      diversity: 1,
      epochs: 1,
      epochFactor: 1,
      syntheticShare: 0,
      syntheticDiscount: 1,
      domainMix: {},
      perDomain: {},
    },
    capability: { p10: 40, p50: 48, p90: 55, ceiling: 82, sigma: 0.06 },
    domains: {
      language: 48,
      reasoning: 40,
      code: 42,
      math: 40,
      science: 38,
      vision: 0,
      video: 0,
      audio: 0,
      tools: 20,
    },
    blockers: [],
    warnings: [],
    ...over,
  };
}

export function stubRecipeForecast(over: Partial<PostTrainForecast> = {}): PostTrainForecast {
  return {
    pfDays: 8,
    days: 4,
    cash: 40_000,
    deltas: {},
    unlocksTiers: false,
    adequacy: {},
    warnings: [],
    ...over,
  };
}

export function stubIncident(over: Partial<RunIncident> = {}): RunIncident {
  return {
    id: "inc-1",
    kind: "loss_spike",
    day: 18,
    title: "Loss spike at scale",
    body: "The observed loss moved outside the forecast band.",
    autoResolveDay: 23,
    choices: [
      {
        id: "stabilize",
        label: "Lower the learning rate",
        description: "Cool the schedule.",
        effects: { sigmaMult: 0.85, daysDelta: 2 },
      },
      {
        id: "spend",
        label: "Buy diagnostic compute",
        description: "Spend cash on proxies.",
        effects: { costMult: 1.15, gapDelta: -0.02 },
      },
      {
        id: "push",
        label: "Push through",
        description: "Keep the schedule.",
        effects: { rollbackProgress: 0.04, sigmaMult: 1.2 },
      },
    ],
    ...over,
  };
}

export function stubRun(labId: string, over: Partial<TrainingRun> = {}): TrainingRun {
  const design = defaultDesign(1);
  return {
    id: "run-1",
    labId,
    design: { ...design, name: "Helix", id: "design-helix" },
    forecast: stubForecast(),
    modifiersFrozen: baselineModifiers(),
    seed: 7,
    status: "awaiting_decision",
    startDay: 10,
    progress: 0.42,
    pfDaysDone: 4.6,
    pfDaysTotal: 11,
    cashSpent: 50_000,
    etaDays: 7,
    incidents: [stubIncident()],
    sigmaMult: 1,
    costMult: 1,
    gapDelta: 0,
    checkpointIds: [],
    autoCheckpointEvery: 0.25,
    lossCurve: [
      { progress: 0.1, loss: 3.2 },
      { progress: 0.42, loss: 2.6 },
    ],
    ...over,
  };
}

export function stubCheckpoint(
  labId: string,
  over: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    id: "cp-stealth",
    labId,
    lineageId: "lin-1",
    name: "Helix",
    version: "0.1",
    stage: "base",
    status: "stealth",
    arch: defaultArchitecture(),
    createdDay: 12,
    progressAtSnapshot: 1,
    truth: emptyTruth(),
    trainingSummary: {
      pfDays: 11,
      effectiveMTok: 140000,
      loss: 2.1,
      gap: 0.41,
      dataMix: {},
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [
      { budget: 1, served: true },
    ],
    endpointIds: [],
    ...over,
  };
}

export function stubEval(labId: string, over: Partial<Eval> = {}): Eval {
  return {
    id: "eval-1",
    labId,
    checkpointId: "cp-kept",
    tier: "suite",
    tierBudget: 1,
    metrics: ["overall", "language"],
    orderedDay: 14,
    completeDay: 16,
    cashCost: 80_000,
    status: "complete",
    result: {
      measured: {
        overall: { mean: 48, ci: 4 },
        language: { mean: 51, ci: 3 },
        reasoning: { mean: 40, ci: 4 },
        code: { mean: 42, ci: 3 },
        math: { mean: 38, ci: 4 },
        science: { mean: 36, ci: 3 },
      },
      season: 0,
    },
    seed: 3,
    ...over,
  };
}

export function stubRecipe(labId: string, over: Partial<PostTrainRecipe> = {}): PostTrainRecipe {
  return {
    id: "recipe-1",
    labId,
    checkpointId: "cp-kept",
    stages: ["instruct", "preference"],
    safetyFocus: 0.2,
    gymIds: [],
    budgetPfDays: 8,
    dataUse: {
      instructionMTok: 10,
      preferenceMTok: 4,
      verifiableTasks: 0,
      toolTrajectories: 0,
    },
    startDay: 18,
    progress: 0.35,
    pfDaysDone: 2.8,
    status: "running",
    forecast: stubRecipeForecast(),
    seed: 9,
    ...over,
  };
}

export function stubEndpoint(labId: string, over: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "ep-1",
    labId,
    name: "Helix API",
    members: [{ checkpointId: "cp-post", role: "primary" }],
    policy: "single",
    tiers: [
      { budget: 1, served: true },
      { budget: 2, served: true },
      { budget: 8, served: false },
      { budget: 20, served: false },
    ],
    precision: "fp8",
    status: "live",
    releaseDay: 20,
    pricing: { inPerMTok: 1, outPerMTok: 4 },
    openWeights: false,
    modelId: "ep-1",
    ...over,
  };
}

export function pipelineFixture(): SimState {
  const game = createGame({
    seed: 11,
    difficulty: "easy",
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  });
  const labId = game.playerLabId;
  const training: TrainingState = {
    ...emptyTrainingState(),
    runs: [stubRun(labId)],
    checkpoints: [
      stubCheckpoint(labId, {
        id: "cp-stealth",
        name: "Helix",
        version: "0.1",
        status: "stealth",
        runId: "run-1",
        progressAtSnapshot: 0.42,
      }),
      stubCheckpoint(labId, {
        id: "cp-kept",
        name: "Helix",
        version: "0.2",
        status: "kept",
        parentId: "cp-stealth",
        runId: "run-1",
        endpointIds: [],
      }),
      stubCheckpoint(labId, {
        id: "cp-post",
        name: "Helix Instruct",
        version: "0.3",
        stage: "post",
        status: "kept",
        parentId: "cp-kept",
        recipeId: "recipe-1",
        runId: "run-1",
        endpointIds: ["ep-1"],
        postTrain: {
          stages: {
            instruct: { effect: 0.12, runs: 1, pfDays: 4 },
          },
        },
        tiers: [
          { budget: 1, served: true },
          { budget: 2, served: true },
          { budget: 8, served: false },
          { budget: 20, served: false },
        ],
      }),
    ],
    recipes: [stubRecipe(labId)],
    evals: [stubEval(labId)],
    endpoints: [stubEndpoint(labId)],
  };
  return withTrainingState(game, labId, training);
}
