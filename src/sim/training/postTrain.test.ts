import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGame } from "../createGame";
import * as computeMod from "../systems/compute";
import type { ModelCapabilities, SimState } from "../types";
import { POST_TRAIN_DATA_PRICE } from "./dataBridge";
import { TRAINING_V4 } from "./constants";
import * as modifiers from "./modifiers";
import { baselineModifiers } from "./modifiers";
import {
  POST_TRAIN_CASH_PER_PF_DAY,
  SYNTH_POST_TRAIN_RATE,
  adequacyFor,
  buyPostTrainData,
  createGym,
  forecastRecipe,
  neededDataForStage,
  recipePfPerDay,
  startRecipe,
  synthesizePostTrainData,
  tickRecipes,
  tierLift,
} from "./postTrain";
import { emptyTrainingState, trainingStateOf, withTrainingState } from "./state";
import type {
  Architecture,
  Checkpoint,
  PostTrainPools,
  PostTrainRecipe,
  StartResult,
  TrainingState,
} from "./types";

const CKPT_ID = "ckpt-atlas";

function truth(fill = 40): ModelCapabilities {
  return {
    domains: {
      language: fill,
      reasoning: fill,
      code: fill,
      math: fill,
      science: fill,
      vision: fill,
      video: fill,
      audio: fill,
      tools: fill,
    },
    factuality: fill,
    steerability: fill,
    robustness: fill,
    safety: fill,
    reliability: fill,
  };
}

function checkpoint(
  state: SimState,
  overrides: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    id: CKPT_ID,
    labId: state.playerLabId,
    lineageId: "lineage-atlas",
    name: "Atlas 7B",
    version: "1.0",
    stage: "base",
    status: "kept",
    arch: {
      backbone: "dense",
      totalParamsB: 7,
      activeParamsB: 7,
      precision: "bf16_mixed",
      preset: "language",
      inputs: ["text"],
      outputs: ["text"],
    },
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truth(),
    trainingSummary: {
      pfDays: 100,
      effectiveMTok: 140,
      loss: 2.1,
      gap: 0.4,
      dataMix: {},
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [],
    endpointIds: [],
    ...overrides,
  };
}

function pools(partial: Partial<PostTrainPools> = {}): PostTrainPools {
  return {
    instructionMTok: 0,
    preferenceMTok: 0,
    verifiableTasks: 0,
    toolTrajectories: 0,
    ...partial,
  };
}

function fixture(
  game: SimState,
  training: Partial<TrainingState>,
  cash = 20_000_000,
): SimState {
  const nextTraining: TrainingState = {
    ...emptyTrainingState(),
    ...training,
    pools: pools(training.pools),
    checkpoints: training.checkpoints ?? [],
    gyms: training.gyms ?? [],
    recipes: training.recipes ?? [],
  };
  const withSlice = withTrainingState(game, game.playerLabId, nextTraining);
  return {
    ...withSlice,
    player: { ...withSlice.player, cash },
  };
}

function instructDraft(
  extra: Partial<PostTrainRecipe> = {},
): Omit<
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
> {
  return {
    checkpointId: CKPT_ID,
    stages: ["instruct"],
    safetyFocus: 0,
    gymIds: [],
    budgetPfDays: 100,
    dataUse: pools({ instructionMTok: 5 }),
    ...extra,
  };
}

function failReason(result: StartResult): string {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

function okId(result: StartResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.id;
}

function tickUntilComplete(state: SimState, recipeId: string, max = 80): SimState {
  let next = state;
  for (let i = 0; i < max; i++) {
    const recipe = trainingStateOf(next, next.playerLabId).recipes.find(
      (entry) => entry.id === recipeId,
    );
    if (recipe?.status === "completed") return next;
    next = tickRecipes(next);
  }
  return next;
}

function mockTrainPf(pf: number) {
  vi.spyOn(computeMod, "computeSnapshot").mockReturnValue({
    pools: { training: pf, inference: 1, research: 1 },
  } as computeMod.ComputeSnapshot);
}

describe("post-train recipes", () => {
  let game: SimState;

  beforeAll(() => {
    game = createGame(4242);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("zero work yields zero effect", () => {
    const state = fixture(game, { checkpoints: [checkpoint(game)] });
    const zeroData = forecastRecipe(
      state,
      state.playerLabId,
      instructDraft({
        budgetPfDays: 0,
        dataUse: pools(),
      }),
    );
    expect(zeroData.adequacy.instruct).toBe(0);
    expect(zeroData.deltas.steerability ?? 0).toBe(0);
    expect(zeroData.deltas.factuality ?? 0).toBe(0);
    expect(zeroData.deltas.language ?? 0).toBe(0);

    const zeroBudget = forecastRecipe(
      state,
      state.playerLabId,
      instructDraft({ budgetPfDays: 0, dataUse: pools({ instructionMTok: 5 }) }),
    );
    expect(zeroBudget.deltas.steerability ?? 0).toBe(0);
  });

  it("follows the adequacy curve min(1, provided/needed)^0.7", () => {
    const state = fixture(game, { checkpoints: [checkpoint(game)] });
    const needed = neededDataForStage("instruct", 7);
    expect(needed).toBeCloseTo(5);

    const at = (provided: number) =>
      forecastRecipe(
        state,
        state.playerLabId,
        instructDraft({ dataUse: pools({ instructionMTok: provided }) }),
      ).adequacy.instruct ?? 0;

    expect(at(0)).toBe(0);
    expect(at(needed / 2)).toBeCloseTo(adequacyFor(needed / 2, needed));
    expect(at(needed / 2)).toBeCloseTo(Math.pow(0.5, 0.7));
    expect(at(needed)).toBeCloseTo(1);
    expect(at(needed * 2)).toBeCloseTo(1);
  });

  it("halves stage effect on a repeat of the same lineage stage", () => {
    const fresh = fixture(game, { checkpoints: [checkpoint(game)] });
    const repeated = fixture(game, {
      checkpoints: [
        checkpoint(game, {
          postTrain: {
            stages: { instruct: { runs: 1, pfDays: 3, effect: 0.9 } },
          },
        }),
      ],
    });
    const first = forecastRecipe(fresh, fresh.playerLabId, instructDraft());
    const second = forecastRecipe(repeated, repeated.playerLabId, instructDraft());
    expect(second.deltas.steerability ?? 0).toBeCloseTo(
      (first.deltas.steerability ?? 0) * 0.5,
    );
    expect(second.warnings.some((warning) => warning.includes("diminishing"))).toBe(
      true,
    );
  });

  it("scales forecast PF with (N_active_B / 7)^0.75 at matched adequacy", () => {
    const smallArch: Architecture = {
      backbone: "dense",
      totalParamsB: 7,
      activeParamsB: 7,
      precision: "bf16_mixed",
      preset: "language",
      inputs: ["text"],
      outputs: ["text"],
    };
    const largeArch: Architecture = { ...smallArch, totalParamsB: 70, activeParamsB: 70 };
    const smallNeeded = neededDataForStage("instruct", 7);
    const largeNeeded = neededDataForStage("instruct", 70);
    const small = fixture(game, {
      checkpoints: [checkpoint(game, { arch: smallArch })],
    });
    const large = fixture(game, {
      checkpoints: [checkpoint(game, { id: CKPT_ID, arch: largeArch })],
    });
    const pfSmall = forecastRecipe(
      small,
      small.playerLabId,
      instructDraft({ dataUse: pools({ instructionMTok: smallNeeded }) }),
    ).pfDays;
    const pfLarge = forecastRecipe(
      large,
      large.playerLabId,
      instructDraft({ dataUse: pools({ instructionMTok: largeNeeded }) }),
    ).pfDays;
    expect(pfSmall).toBeCloseTo(TRAINING_V4.postTrain.baseStagePfDays.instruct);
    expect(pfLarge / pfSmall).toBeCloseTo(Math.pow(10, 0.75));
  });

  it("rejects invalid startRecipe inputs", () => {
    const ready = fixture(
      game,
      {
        checkpoints: [checkpoint(game)],
        pools: pools({ instructionMTok: 5 }),
      },
      20_000_000,
    );

    expect(
      startRecipe(ready, ready.playerLabId, instructDraft({ checkpointId: "missing" }))
        .result,
    ).toEqual({ ok: false, reason: "checkpoint missing" });

    const released = fixture(game, {
      checkpoints: [checkpoint(game, { status: "released" })],
      pools: pools({ instructionMTok: 5 }),
    });
    expect(startRecipe(released, released.playerLabId, instructDraft()).result.ok).toBe(
      false,
    );

    expect(
      failReason(
        startRecipe(
          ready,
          ready.playerLabId,
          instructDraft({ dataUse: pools({ instructionMTok: 0 }) }),
        ).result,
      ),
    ).toMatch(/zero data/);

    expect(
      failReason(
        startRecipe(
          ready,
          ready.playerLabId,
          instructDraft({
            stages: ["reasoning"],
            dataUse: pools({ verifiableTasks: 2000 }),
          }),
        ).result,
      ),
    ).toMatch(/reasoning/);

    expect(
      failReason(
        startRecipe(
          ready,
          ready.playerLabId,
          instructDraft({
            stages: ["agentic"],
            dataUse: pools({ toolTrajectories: 1000 }),
          }),
        ).result,
      ),
    ).toMatch(/agentic/);

    const broke = fixture(
      game,
      {
        checkpoints: [checkpoint(game)],
        pools: pools({ instructionMTok: 5 }),
      },
      0,
    );
    expect(failReason(startRecipe(broke, broke.playerLabId, instructDraft()).result)).toMatch(
      /cash/,
    );

    const first = startRecipe(ready, ready.playerLabId, instructDraft());
    expect(first.result.ok).toBe(true);
    const second = startRecipe(first.state, first.state.playerLabId, instructDraft());
    expect(failReason(second.result)).toMatch(/running recipe/);
  });

  it("completes a recipe into a post checkpoint with bumped version and merged record", () => {
    const state = fixture(
      game,
      {
        checkpoints: [checkpoint(game)],
        pools: pools({ instructionMTok: 5 }),
      },
      20_000_000,
    );
    const forecast = forecastRecipe(state, state.playerLabId, instructDraft());
    expect(forecast.pfDays).toBeGreaterThan(0);
    expect(forecast.cash).toBeCloseTo(forecast.pfDays * POST_TRAIN_CASH_PER_PF_DAY);

    const started = startRecipe(state, state.playerLabId, instructDraft());
    const recipeId = okId(started.result);
    const done = tickUntilComplete(started.state, recipeId);
    const slice = trainingStateOf(done, done.playerLabId);
    const recipe = slice.recipes.find((entry) => entry.id === recipeId);
    expect(recipe?.status).toBe("completed");
    const result = slice.checkpoints.find((entry) => entry.id === recipe?.resultCheckpointId);
    expect(result).toMatchObject({
      stage: "post",
      status: "kept",
      parentId: CKPT_ID,
      lineageId: "lineage-atlas",
      version: "1.1",
      recipeId,
    });
    expect(result?.name).toBe("Atlas 7B · Instruct");
    expect(result?.postTrain.stages.instruct?.runs).toBe(1);
    expect(result?.postTrain.stages.instruct?.pfDays).toBeCloseTo(forecast.pfDays);
    expect(result?.postTrain.stages.instruct?.effect).toBeGreaterThan(0);
    expect(result?.tiers).toEqual([]);
    const source = slice.checkpoints.find((entry) => entry.id === CKPT_ID);
    expect(source?.stage).toBe("base");
    expect(source?.truth.steerability).toBe(40);
    expect(result?.truth.steerability).toBeGreaterThan(40);
    expect(result?.endpointIds).toEqual([]);
  });

  it("updates a post checkpoint in place instead of forking a Ready sibling", () => {
    const state = fixture(
      game,
      {
        checkpoints: [checkpoint(game)],
        pools: pools({ instructionMTok: 5, preferenceMTok: 5 }),
      },
      20_000_000,
    );
    const first = startRecipe(state, state.playerLabId, instructDraft());
    const firstId = okId(first.result);
    const afterInstruct = tickUntilComplete(first.state, firstId);
    const afterInstructSlice = trainingStateOf(afterInstruct, afterInstruct.playerLabId);
    const instructRecipe = afterInstructSlice.recipes.find((entry) => entry.id === firstId);
    const postId = instructRecipe?.resultCheckpointId;
    expect(postId).toBeTruthy();
    expect(afterInstructSlice.checkpoints).toHaveLength(2);

    const preferenceDraft = instructDraft({
      checkpointId: postId!,
      stages: ["preference"],
      dataUse: pools({ preferenceMTok: 5 }),
    });
    const second = startRecipe(afterInstruct, afterInstruct.playerLabId, preferenceDraft);
    const secondId = okId(second.result);
    const done = tickUntilComplete(second.state, secondId);
    const slice = trainingStateOf(done, done.playerLabId);
    const recipe = slice.recipes.find((entry) => entry.id === secondId);
    expect(recipe?.resultCheckpointId).toBe(postId);
    expect(slice.checkpoints).toHaveLength(2);
    const result = slice.checkpoints.find((entry) => entry.id === postId);
    expect(result).toMatchObject({
      id: postId,
      parentId: CKPT_ID,
      stage: "post",
      status: "kept",
      version: "1.2",
      name: "Atlas 7B · Instruct+Preference",
    });
    expect(result?.postTrain.stages.instruct?.runs).toBe(1);
    expect(result?.postTrain.stages.preference?.runs).toBe(1);
    expect(slice.checkpoints.filter((entry) => entry.stage === "post")).toHaveLength(1);
  });

  it("stalls when the training pool is empty", () => {
    const state = fixture(
      game,
      {
        checkpoints: [checkpoint(game)],
        pools: pools({ instructionMTok: 5 }),
      },
      20_000_000,
    );
    const started = startRecipe(state, state.playerLabId, instructDraft());
    const recipeId = okId(started.result);
    mockTrainPf(0);
    expect(recipePfPerDay(started.state, started.state.playerLabId)).toBe(0);
    expect(
      forecastRecipe(started.state, started.state.playerLabId, instructDraft()).days,
    ).toBe(Number.POSITIVE_INFINITY);

    const ticked = tickRecipes(started.state);
    const recipe = trainingStateOf(ticked, ticked.playerLabId).recipes.find(
      (entry) => entry.id === recipeId,
    );
    expect(recipe?.status).toBe("running");
    expect(recipe?.pfDaysDone).toBe(0);
    expect(recipe?.progress).toBe(0);
  });

  it("burns training-pool PF while a recipe runs", () => {
    mockTrainPf(0.4);
    const state = fixture(
      game,
      {
        checkpoints: [checkpoint(game)],
        pools: pools({ instructionMTok: 5 }),
      },
      20_000_000,
    );
    const started = startRecipe(state, state.playerLabId, instructDraft());
    const recipeId = okId(started.result);
    const before = trainingStateOf(started.state, started.state.playerLabId).recipes.find(
      (entry) => entry.id === recipeId,
    );
    expect(before?.pfDaysDone).toBe(0);

    const ticked = tickRecipes(started.state);
    const after = trainingStateOf(ticked, ticked.playerLabId).recipes.find(
      (entry) => entry.id === recipeId,
    );
    expect(after?.pfDaysDone).toBeGreaterThan(0);
    expect(after?.status).toBe("running");
  });

  it("does not unlock thinking tiers when the unlock is missing", () => {
    const withGym = createGym(
      fixture(game, {
        checkpoints: [checkpoint(game)],
        pools: pools({ verifiableTasks: 2000 }),
      }),
      game.playerLabId,
      "code",
    );
    const gymId = okId(withGym.result);
    const draft = instructDraft({
      stages: ["reasoning"],
      gymIds: [gymId],
      dataUse: pools({ verifiableTasks: 2000 }),
    });
    const quote = forecastRecipe(withGym.state, withGym.state.playerLabId, draft);
    expect(quote.unlocksTiers).toBe(false);
    expect(quote.warnings.some((warning) => warning.includes("tiers locked"))).toBe(
      true,
    );
    const started = startRecipe(withGym.state, withGym.state.playerLabId, draft);
    const recipeId = okId(started.result);
    const done = tickUntilComplete(started.state, recipeId);
    const slice = trainingStateOf(done, done.playerLabId);
    const recipe = slice.recipes.find((entry) => entry.id === recipeId);
    const result = slice.checkpoints.find((entry) => entry.id === recipe?.resultCheckpointId);
    expect(result?.tiers).toEqual([]);
    expect(
      failReason(
        startRecipe(
          withGym.state,
          withGym.state.playerLabId,
          instructDraft({
            stages: ["reasoning"],
            gymIds: [gymId],
            dataUse: pools({ verifiableTasks: 2000 }),
            thinkingBudgets: [8],
          }),
        ).result,
      ),
    ).toMatch(/thinking tiers locked/);
  });

  it("keeps Instant when reasoning completes with the unlock, unless extra budgets are trained", () => {
    vi.spyOn(modifiers, "modifiersForLab").mockReturnValue({
      ...baselineModifiers(),
      unlocks: ["thinking_tiers"],
    });
    try {
      const withGym = createGym(
        fixture(game, {
          checkpoints: [checkpoint(game)],
          pools: pools({ verifiableTasks: 2000 }),
        }),
        game.playerLabId,
        "code",
      );
      const gymId = okId(withGym.result);
      const draft = instructDraft({
        stages: ["reasoning"],
        gymIds: [gymId],
        dataUse: pools({ verifiableTasks: 2000 }),
      });
      const quote = forecastRecipe(withGym.state, withGym.state.playerLabId, draft);
      expect(quote.unlocksTiers).toBe(true);
      const started = startRecipe(withGym.state, withGym.state.playerLabId, draft);
      const recipeId = okId(started.result);
      const done = tickUntilComplete(started.state, recipeId);
      const slice = trainingStateOf(done, done.playerLabId);
      const recipe = slice.recipes.find((entry) => entry.id === recipeId);
      const result = slice.checkpoints.find(
        (entry) => entry.id === recipe?.resultCheckpointId,
      );
      expect(result?.tiers).toEqual([{ budget: 1, served: true }]);

      const withHeads = instructDraft({
        stages: ["reasoning"],
        gymIds: [gymId],
        dataUse: pools({ verifiableTasks: 2000 }),
        thinkingBudgets: [1, 8],
      });
      const quoteHeads = forecastRecipe(withGym.state, withGym.state.playerLabId, withHeads);
      expect(quoteHeads.pfDays).toBeGreaterThan(quote.pfDays);
      const startedHeads = startRecipe(withGym.state, withGym.state.playerLabId, withHeads);
      const headsId = okId(startedHeads.result);
      const doneHeads = tickUntilComplete(startedHeads.state, headsId);
      const headsSlice = trainingStateOf(doneHeads, doneHeads.playerLabId);
      const headsRecipe = headsSlice.recipes.find((entry) => entry.id === headsId);
      const headsResult = headsSlice.checkpoints.find(
        (entry) => entry.id === headsRecipe?.resultCheckpointId,
      );
      expect(headsResult?.tiers).toEqual([
        { budget: 1, served: true },
        { budget: 8, served: false },
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is zero at budget 1 and monotone in thinking-tier budget", () => {
    const q = 0.35;
    expect(tierLift(1, q, "math")).toBe(0);
    expect(tierLift(1, q, "language")).toBe(0);
    expect(tierLift(2, q, "math")).toBeGreaterThan(tierLift(1, q, "math"));
    expect(tierLift(8, q, "math")).toBeGreaterThan(tierLift(2, q, "math"));
    expect(tierLift(20, q, "math")).toBeGreaterThan(tierLift(8, q, "math"));
    expect(tierLift(20, q, "math")).toBeGreaterThan(tierLift(20, q, "language"));
  });

  it("buyPostTrainData deducts cash and fills the pool", () => {
    const state = fixture(game, {}, 1_000_000);
    const amount = 10;
    const next = buyPostTrainData(state, "instructionMTok", amount);
    expect(next.player.cash).toBeCloseTo(
      1_000_000 - amount * POST_TRAIN_DATA_PRICE.instructionMTok,
    );
    expect(trainingStateOf(next, next.playerLabId).pools.instructionMTok).toBe(amount);
    expect(buyPostTrainData(state, "instructionMTok", 0)).toBe(state);
  });

  it("synthesizePostTrainData yields from teacher capability and spends cash", () => {
    const state = fixture(
      game,
      { checkpoints: [checkpoint(game, { status: "kept", truth: truth(50) })] },
      5_000_000,
    );
    const amount = 100;
    const result = synthesizePostTrainData(state, {
      kind: "instructionMTok",
      teacherCheckpointId: CKPT_ID,
      tierBudget: 1,
      amount,
    });
    expect(result.result.ok).toBe(true);
    expect(result.state.player.cash).toBeCloseTo(
      5_000_000 - amount * 1 * SYNTH_POST_TRAIN_RATE.instructionMTok,
    );
    // mean(domains)=50 → quality 0.5, budget 1 → yield 50
    expect(
      trainingStateOf(result.state, result.state.playerLabId).pools.instructionMTok,
    ).toBeCloseTo(50);

    const stealth = fixture(game, {
      checkpoints: [checkpoint(game, { status: "stealth" })],
    });
    expect(
      synthesizePostTrainData(stealth, {
        kind: "instructionMTok",
        teacherCheckpointId: CKPT_ID,
        tierBudget: 1,
        amount: 10,
      }).result.ok,
    ).toBe(false);
  });
});
