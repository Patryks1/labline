import { describe, expect, it } from "vitest";
import { createGame } from "../../sim/createGame";
import { baselineModifiers } from "../../sim/training/modifiers";
import {
  defaultArchitecture,
  defaultDesign,
  emptyTrainingState,
  withTrainingState,
} from "../../sim/training/state";
import type {
  Forecast,
  PostTrainRecipe,
  TrainingRun,
} from "../../sim/training/types";
import { runActivityViewModel } from "./runViewModel";

function stubForecast(p50 = 50): Forecast {
  const band = { p10: p50 - 8, p50, p90: p50 + 8, ceiling: 82, sigma: 0.06 };
  return {
    compute: {
      trainPfDays: 10,
      holdoutPfDays: 0,
      totalPfDays: 10,
      archCost: 1,
      modalityCost: 1,
      throughput: 1,
      days: 12,
      paceFloorDays: 8,
      trainHbmGB: 40,
      cashEstimate: 1,
    },
    loss: {
      nEff: 7e9,
      dEff: 1e11,
      paramTerm: 1,
      dataTerm: 1,
      loss: 2.1,
      precisionPenalty: 0,
      gap: 0.4,
    },
    effectiveData: {
      rawMTok: 100,
      uniqueMTok: 80,
      effectiveMTok: 70,
      qualityWeight: 1,
      diversity: 1,
      epochs: 1,
      epochFactor: 1,
      syntheticShare: 0,
      syntheticDiscount: 1,
      domainMix: {},
      perDomain: {},
    },
    capability: band,
    domains: {
      language: p50,
      reasoning: p50,
      code: p50,
      math: p50,
      science: p50,
      vision: 0,
      video: 0,
      audio: 0,
      tools: p50,
    },
    blockers: [],
    warnings: [],
  };
}

function makeRun(overrides: Partial<TrainingRun> & Pick<TrainingRun, "id">): TrainingRun {
  const design = defaultDesign(1);
  return {
    labId: "player",
    design: { ...design, name: overrides.design?.name ?? design.name, id: overrides.id },
    forecast: stubForecast(),
    modifiersFrozen: baselineModifiers(),
    seed: 1,
    status: "running",
    startDay: 1,
    progress: 0,
    pfDaysDone: 0,
    pfDaysTotal: 10,
    cashSpent: 0,
    etaDays: 8,
    incidents: [],
    sigmaMult: 1,
    costMult: 1,
    gapDelta: 0,
    checkpointIds: [],
    autoCheckpointEvery: 0.25,
    lossCurve: [],
    ...overrides,
  };
}

function makeRecipe(
  overrides: Partial<PostTrainRecipe> & Pick<PostTrainRecipe, "id">,
): PostTrainRecipe {
  return {
    labId: "player",
    checkpointId: "cp-1",
    stages: ["instruct"],
    safetyFocus: 0,
    gymIds: [],
    budgetPfDays: 3,
    dataUse: {
      instructionMTok: 1,
      preferenceMTok: 0,
      verifiableTasks: 0,
      toolTrajectories: 0,
    },
    startDay: 1,
    progress: 0.2,
    pfDaysDone: 0.5,
    status: "running",
    forecast: {
      pfDays: 3,
      days: 4,
      cash: 10_000,
      deltas: {},
      unlocksTiers: false,
      adequacy: {},
      warnings: [],
    },
    seed: 1,
    ...overrides,
  };
}

describe("runActivityViewModel", () => {
  it("returns null when the lab has no active runs or recipes", () => {
    const state = withTrainingState(createGame(401), "player", emptyTrainingState());
    expect(runActivityViewModel(state)).toBeNull();
  });

  it("picks awaiting_decision before a higher-progress running run", () => {
    const waiting = makeRun({
      id: "run-wait",
      status: "awaiting_decision",
      progress: 0.2,
      design: { ...defaultDesign(1), id: "run-wait", name: "Needs call" },
    });
    const racing = makeRun({
      id: "run-fast",
      status: "running",
      progress: 0.9,
      design: { ...defaultDesign(1), id: "run-fast", name: "Almost done" },
    });
    const state = withTrainingState(createGame(402), "player", {
      ...emptyTrainingState(),
      runs: [racing, waiting],
    });
    const vm = runActivityViewModel(state);
    expect(vm?.runId).toBe("run-wait");
    expect(vm?.pendingDecision).toBe(true);
    expect(vm?.kind).toBe("run");
    expect(vm?.secondaryCount).toBe(1);
    expect(vm?.sizeLabel).toBe("7B");
  });

  it("picks the highest-progress active run when none await a decision", () => {
    const low = makeRun({ id: "run-low", progress: 0.31, etaDays: 9 });
    const high = makeRun({
      id: "run-high",
      progress: 0.77,
      etaDays: 3,
      forecast: stubForecast(61),
    });
    const done = makeRun({ id: "run-done", status: "completed", progress: 1 });
    const state = withTrainingState(createGame(403), "player", {
      ...emptyTrainingState(),
      runs: [low, high, done],
    });
    const vm = runActivityViewModel(state);
    expect(vm?.runId).toBe("run-high");
    expect(vm?.progress).toBe(0.77);
    expect(vm?.etaDays).toBe(3);
    expect(vm?.band.p50).toBe(61);
    expect(vm?.pendingDecision).toBe(false);
    expect(vm?.secondaryCount).toBe(1);
  });

  it("falls back to a running recipe when no active run exists", () => {
    const recipe = makeRecipe({ id: "recipe-1", progress: 0.4 });
    const state = withTrainingState(createGame(404), "player", {
      ...emptyTrainingState(),
      recipes: [recipe],
      checkpoints: [
        {
          id: "cp-1",
          labId: "player",
          lineageId: "cp-1",
          name: "Spark",
          version: "1.0",
          stage: "base",
          status: "kept",
          arch: defaultArchitecture(),
          createdDay: 1,
          progressAtSnapshot: 1,
          truth: {
            domains: {
              language: 40,
              reasoning: 40,
              code: 40,
              math: 40,
              science: 40,
              vision: 0,
              video: 0,
              audio: 0,
              tools: 40,
            },
            factuality: 40,
            steerability: 40,
            robustness: 40,
            safety: 50,
            reliability: 45,
          },
          trainingSummary: {
            pfDays: 4,
            effectiveMTok: 20,
            loss: 2.4,
            gap: 0.5,
            dataMix: {},
            syntheticShare: 0,
          },
          postTrain: { stages: {} },
          tiers: [{ budget: 1, served: true }],
          endpointIds: [],
        },
      ],
    });
    const vm = runActivityViewModel(state);
    expect(vm?.kind).toBe("recipe");
    expect(vm?.runId).toBe("recipe-1");
    expect(vm?.name).toContain("Spark");
    expect(vm?.progress).toBe(0.4);
    expect(vm?.secondaryCount).toBe(0);
  });

  it("counts unresolved incidents and other active work in secondaryCount", () => {
    const run = makeRun({
      id: "run-inc",
      progress: 0.5,
      incidents: [
        {
          id: "i1",
          kind: "loss_spike",
          day: 2,
          title: "Spike",
          body: "Loss jumped.",
          choices: [],
          autoResolveDay: 7,
        },
        {
          id: "i2",
          kind: "breakthrough",
          day: 3,
          title: "Done",
          body: "Resolved.",
          choices: [],
          resolvedChoiceId: "ok",
          autoResolveDay: 8,
        },
      ],
    });
    const recipe = makeRecipe({ id: "recipe-side", progress: 0.1 });
    const state = withTrainingState(createGame(405), "player", {
      ...emptyTrainingState(),
      runs: [run],
      recipes: [recipe],
    });
    const vm = runActivityViewModel(state);
    expect(vm?.runId).toBe("run-inc");
    expect(vm?.incidentCount).toBe(1);
    expect(vm?.secondaryCount).toBe(1);
  });
});
