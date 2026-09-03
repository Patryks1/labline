import { afterEach, describe, expect, it, vi } from "vitest";
import { createGame } from "../createGame";
import * as computeMod from "../systems/compute";
import type { DatasetAsset, SimState } from "../types";
import { cashPerPfDayEstimate } from "./compute";
import { defaultArchitecture, trainingStateOf, withTrainingState } from "./state";
import { reservedTokensFor } from "./dataBridge";
import { forecastDesign, utilForLab } from "./forecast";
import {
  allocateLabTrainingPf,
  allocateTrainingPf,
  cloudShareFor,
  recipeTrainContender,
  startRun,
  tickRuns,
} from "./run";
import type { ModelDesign, PostTrainRecipe } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

function ampleAsset(): DatasetAsset {
  return {
    id: "v4-ample-chat",
    name: "Ample Chat",
    volumeMTok: 200_000,
    domainWeights: { chat: 1 },
    verticalTags: ["general"],
    quality: 80,
    diversity: 0.7,
    freshness: 1,
    rights: "owned",
    source: "web",
    exclusiveUntilDay: null,
    contaminationRisk: 0,
    acquiredDay: 1,
  };
}

function withAmpleData(state: SimState): SimState {
  const data = state.player.data;
  return {
    ...state,
    player: {
      ...state.player,
      data: { ...data, assets: [...(data.assets ?? []), ampleAsset()] },
      cash: Math.max(state.player.cash, 50_000_000),
    },
  };
}

function mockTrainPf(pf: number) {
  vi.spyOn(computeMod, "computeSnapshot").mockReturnValue({
    pools: { training: pf, inference: 1, research: 1 },
  } as computeMod.ComputeSnapshot);
}

function runningRecipe(labId: string, id: string): PostTrainRecipe {
  return {
    id,
    labId,
    checkpointId: "ck",
    stages: ["instruct"],
    safetyFocus: 0,
    gymIds: [],
    budgetPfDays: 4,
    dataUse: {
      instructionMTok: 1,
      preferenceMTok: 0,
      verifiableTasks: 0,
      toolTrajectories: 0,
    },
    startDay: 1,
    progress: 0,
    pfDaysDone: 0,
    status: "running",
    forecast: {
      pfDays: 4,
      days: 4,
      cash: 0,
      deltas: {},
      unlocksTiers: false,
      adequacy: {},
      warnings: [],
    },
    seed: 1,
  };
}

function designFor(state: SimState, over: Partial<ModelDesign> = {}): ModelDesign {
  return {
    id: "design-7b",
    name: "Atlas-7B",
    goal: "flagship",
    arch: defaultArchitecture(),
    data: { domainMTok: { chat: 140_000 }, holdoutShare: 0.05 },
    mode: { kind: "pretrain" },
    compute: { pfPerDay: 200, priority: 3, source: "local" },
    createdDay: state.day,
    ...over,
  };
}

describe("run priority and cloud cash", () => {
  it("priority split sums to trainPf", () => {
    const shares = allocateTrainingPf(100, [
      { id: "a", design: { compute: { priority: 1 } } as ModelDesign },
      { id: "b", design: { compute: { priority: 3 } } as ModelDesign },
    ]);
    expect(shares.a! + shares.b!).toBeCloseTo(100, 8);
    expect(shares.a).toBeCloseTo(25, 8);
    expect(shares.b).toBeCloseTo(75, 8);
  });

  it("caps each run at requested pfPerDay and redistributes leftover", () => {
    const shares = allocateTrainingPf(100, [
      { id: "a", design: { compute: { priority: 1, pfPerDay: 10 } } as ModelDesign },
      { id: "b", design: { compute: { priority: 1, pfPerDay: 90 } } as ModelDesign },
    ]);
    expect(shares.a).toBeCloseTo(10, 8);
    expect(shares.b).toBeCloseTo(90, 8);
  });

  it("leaves unused PF when every run is capped", () => {
    const shares = allocateTrainingPf(100, [
      { id: "a", design: { compute: { priority: 1, pfPerDay: 10 } } as ModelDesign },
      { id: "b", design: { compute: { priority: 1, pfPerDay: 10 } } as ModelDesign },
    ]);
    expect(shares.a).toBeCloseTo(10, 8);
    expect(shares.b).toBeCloseTo(10, 8);
  });

  it("splits the pool evenly between a run and a recipe", () => {
    const shares = allocateTrainingPf(100, [
      { id: "run", design: { compute: { priority: 1 } } as ModelDesign },
      recipeTrainContender("recipe"),
    ]);
    expect(shares.run).toBeCloseTo(50, 8);
    expect(shares.recipe).toBeCloseTo(50, 8);
  });

  it("cuts a run's daily PF when a post-train recipe is also running", () => {
    mockTrainPf(100);
    let state = withAmpleData(createGame(9002));
    const started = startRun(
      state,
      state.playerLabId,
      designFor(state, { compute: { pfPerDay: 200, priority: 1, source: "local" } }),
    );
    expect(started.result.ok).toBe(true);
    if (!started.result.ok) return;
    state = started.state;
    const runId = started.result.id;
    expect(allocateLabTrainingPf(state, state.playerLabId)[runId]).toBeCloseTo(100, 8);

    const training = trainingStateOf(state, state.playerLabId);
    const withRecipe = withTrainingState(state, state.playerLabId, {
      ...training,
      recipes: [runningRecipe(state.playerLabId, "recipe-share")],
    });
    const split = allocateLabTrainingPf(withRecipe, withRecipe.playerLabId);
    expect(split[runId]).toBeCloseTo(50, 8);
    expect(split["recipe-share"]).toBeCloseTo(50, 8);

    const tickedAlone = tickRuns(state);
    const tickedSplit = tickRuns(withRecipe);
    const pfAlone = trainingStateOf(tickedAlone, tickedAlone.playerLabId).runs[0]!.pfDaysDone;
    const pfSplit = trainingStateOf(tickedSplit, tickedSplit.playerLabId).runs[0]!.pfDaysDone;
    expect(pfSplit).toBeCloseTo(pfAlone / 2, 5);
  });

  it("pace floor caps daily progress and cloud cash is charged", () => {
    mockTrainPf(50_000);
    let state = withAmpleData(createGame(9001));
    const cloud = designFor(state, {
      compute: { pfPerDay: 200, priority: 1, source: "cloud" },
    });
    const forecast = forecastDesign(state, state.playerLabId, cloud);
    expect(forecast.blockers).toEqual([]);
    const started = startRun(state, state.playerLabId, cloud);
    expect(started.result.ok).toBe(true);
    if (!started.result.ok) return;
    state = started.state;
    const cashBefore = state.player.cash;
    state = { ...state, day: state.day + 1 };
    state = tickRuns(state);
    const run = trainingStateOf(state, state.playerLabId).runs[0]!;
    const floor = forecast.compute.paceFloorDays;
    expect(run.progress).toBeLessThanOrEqual(1 / floor + 1e-6);
    expect(run.progress).toBeGreaterThan(0);
    const util = utilForLab(state, state.playerLabId);
    const pfToday = 200 * util;
    const expectedCash = pfToday * cloudShareFor("cloud") * cashPerPfDayEstimate(state.day, 0);
    expect(run.cashSpent).toBeCloseTo(expectedCash, 4);
    expect(cashBefore - state.player.cash).toBeCloseTo(expectedCash, 4);
    expect(reservedTokensFor(state, state.playerLabId)["chat"]).toBeGreaterThan(0);
  });
});
