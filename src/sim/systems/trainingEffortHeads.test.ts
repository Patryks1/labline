import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  INSTANT_EFFORT_ID,
  migrateEffortRecipes,
  serveTokenMultiplierForRecipe,
} from "../balance/modelProduct";
import type { SimState } from "../types";
import {
  applyEffortHeadTick,
  releaseFromJob,
  setEffortHeadCapabilityBias,
  setEffortHeadComputeShare,
  startEffortTraining,
  startTraining,
} from "./training";

function richState(seed: number): SimState {
  const state = createGame(seed);
  return {
    ...state,
    player: {
      ...state.player,
      cash: 5_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
      researchUnlocked: [
        ...state.player.researchUnlocked,
        "align_process",
        "align_grpo",
      ],
    },
  };
}

describe("per-head effort training", () => {
  it("gives higher compute share more progress and lower loss", () => {
    let state = startTraining(richState(4401), {
      name: "Head Shares",
      family: "dense",
      paramsB: 1,
    });
    const job = state.player.trainingJob!;
    state = startEffortTraining(state, {
      id: job.id,
      name: "Fast",
      thinkingTokenMult: 3,
      trainPfDays: 12,
    });
    state = startEffortTraining(state, {
      id: job.id,
      name: "Slow",
      thinkingTokenMult: 3,
      trainPfDays: 12,
    });
    const recipesAfter = migrateEffortRecipes(
      state.player.trainingJob?.productProfile,
    );
    const fastId = recipesAfter.find((recipe) => recipe.name === "Fast")!.id;
    const slowId = recipesAfter.find((recipe) => recipe.name === "Slow")!.id;
    state = setEffortHeadComputeShare(state, job.id, fastId, 0.4);
    state = setEffortHeadComputeShare(state, job.id, slowId, 0.05);
    state = setEffortHeadComputeShare(state, job.id, INSTANT_EFFORT_ID, 0);
    let working = state.player.trainingJob!;
    for (let day = 1; day <= 18; day += 1) {
      working = applyEffortHeadTick(state, working, 8, day).job;
    }
    const recipes = migrateEffortRecipes(working.productProfile);
    const fast = recipes.find((recipe) => recipe.id === fastId)!;
    const slow = recipes.find((recipe) => recipe.id === slowId)!;
    expect(fast.progressPfDays ?? 0).toBeGreaterThan(slow.progressPfDays ?? 0);
    expect(fast.loss).toBeDefined();
    expect(slow.loss).toBeDefined();
    expect(fast.loss!).toBeLessThan(slow.loss!);
  });

  it("continues training Instant and Deep instead of only naming a new head", () => {
    let state = startTraining(richState(4402), {
      name: "Continue Heads",
      family: "dense",
      paramsB: 1,
    });
    const job = state.player.trainingJob!;
    state = startEffortTraining(state, {
      id: job.id,
      recipeId: INSTANT_EFFORT_ID,
      name: "Instant",
      trainPfDays: 6,
    });
    const instant = migrateEffortRecipes(
      state.player.trainingJob?.productProfile,
    ).find((recipe) => recipe.id === INSTANT_EFFORT_ID);
    expect(instant?.targetPfDays).toBeGreaterThan(0);
    expect(instant?.trainComputeShare).toBeGreaterThan(0);
    expect(
      migrateEffortRecipes(state.player.trainingJob?.productProfile).filter(
        (recipe) => recipe.kind === "trained",
      ),
    ).toHaveLength(0);

    state = startEffortTraining(state, {
      id: job.id,
      name: "Deep",
      thinkingTokenMult: 6,
    });
    const deepId = migrateEffortRecipes(
      state.player.trainingJob?.productProfile,
    ).find((recipe) => recipe.name === "Deep")!.id;
    const before = migrateEffortRecipes(
      state.player.trainingJob?.productProfile,
    ).find((recipe) => recipe.id === deepId)!;
    state = startEffortTraining(state, {
      id: job.id,
      recipeId: deepId,
      name: "Deep",
      thinkingTokenMult: 6,
      trainPfDays: 8,
    });
    const continued = migrateEffortRecipes(
      state.player.trainingJob?.productProfile,
    ).find((recipe) => recipe.id === deepId)!;
    expect(continued.targetPfDays ?? 0).toBeGreaterThan(before.targetPfDays ?? 0);
    expect(
      migrateEffortRecipes(state.player.trainingJob?.productProfile).filter(
        (recipe) => recipe.name === "Deep",
      ),
    ).toHaveLength(1);
  });

  it("keeps Instant free to serve after a capability-biased continue", () => {
    let state = startTraining(richState(4403), {
      name: "Free Instant",
      family: "dense",
      paramsB: 1,
    });
    const job = state.player.trainingJob!;
    const before = serveTokenMultiplierForRecipe(
      migrateEffortRecipes(job.productProfile).find(
        (recipe) => recipe.id === INSTANT_EFFORT_ID,
      )!,
      50,
    );
    state = setEffortHeadCapabilityBias(state, job.id, INSTANT_EFFORT_ID, 1);
    state = startEffortTraining(state, {
      id: job.id,
      recipeId: INSTANT_EFFORT_ID,
      name: "Instant",
      capabilityBias: 1,
    });
    const instant = migrateEffortRecipes(
      state.player.trainingJob?.productProfile,
    ).find((recipe) => recipe.id === INSTANT_EFFORT_ID)!;
    expect(instant.capabilityBias).toBe(1);
    expect(serveTokenMultiplierForRecipe(instant, 50)).toBeCloseTo(before);
  });

  it("preserves Think/Deep when continuing Instant on a multi-head model", () => {
    let state = startTraining(richState(4404), {
      name: "Multi Head Source",
      family: "dense",
      paramsB: 1,
    });
    const job = state.player.trainingJob!;
    state = startEffortTraining(state, {
      id: job.id,
      name: "Think",
      thinkingTokenMult: 2.2,
      trainPfDays: 10,
    });
    state = startEffortTraining(state, {
      id: job.id,
      name: "Deep",
      thinkingTokenMult: 6,
      trainPfDays: 10,
    });
    let working = state.player.trainingJob!;
    for (let day = 0; day < 30; day += 1) {
      working = applyEffortHeadTick(state, working, 12, day).job;
    }
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: working,
        trainingJobs: [working],
      },
    };
    state = releaseFromJob(finishJob(state), undefined, { list: false });
    const model = state.player.models.at(-1)!;
    const before = migrateEffortRecipes(model.productProfile);
    expect(before.some((recipe) => recipe.name === "Think")).toBe(true);
    expect(before.some((recipe) => recipe.name === "Deep")).toBe(true);
    const thinkBefore = before.find((recipe) => recipe.name === "Think")!;
    const deepBefore = before.find((recipe) => recipe.name === "Deep")!;
    const instantBefore = before.find(
      (recipe) => recipe.id === INSTANT_EFFORT_ID,
    )!;

    // Grant fresh corpus so continue-train can start.
    state = {
      ...state,
      player: {
        ...state.player,
        models: state.player.models.map((candidate) =>
          candidate.id === model.id
            ? { ...candidate, dataWatermarkMTok: 0 }
            : candidate,
        ),
        data: {
          ...state.player.data!,
          stocks: Object.fromEntries(
            Object.entries(state.player.data!.stocks).map(([domain, stock]) => [
              domain,
              { ...stock, processed: stock.processed + 2_000 },
            ]),
          ),
          lifetimeProcessed: state.player.data!.lifetimeProcessed + 8_000,
        },
      },
    };

    state = startTraining(state, {
      name: "Multi Head CT",
      family: "dense",
      paramsB: model.paramsB,
      mode: "continue",
      continueFromId: model.id,
    });
    const continuedJob = state.player.trainingJob!;
    const onJob = migrateEffortRecipes(continuedJob.productProfile);
    expect(onJob.some((recipe) => recipe.name === "Think")).toBe(true);
    expect(onJob.some((recipe) => recipe.name === "Deep")).toBe(true);
    expect(
      onJob.find((recipe) => recipe.name === "Think")?.thinkingTokenMult,
    ).toBe(thinkBefore.thinkingTokenMult);
    expect(
      onJob.find((recipe) => recipe.name === "Deep")?.quality,
    ).toBeCloseTo(deepBefore.quality, 5);
    expect(
      onJob.find((recipe) => recipe.name === "Think")?.served,
    ).toBe(thinkBefore.served);

    const instantOnJob = onJob.find(
      (recipe) => recipe.id === INSTANT_EFFORT_ID,
    )!;
    state = startEffortTraining(state, {
      id: continuedJob.id,
      recipeId: INSTANT_EFFORT_ID,
      name: "Instant",
      thinkingTokenMult: 1,
      trainPfDays: 8,
      trainComputeShare: Math.max(
        instantOnJob.trainComputeShare ?? 0,
        0.15,
      ),
    });
    let nextJob = state.player.trainingJob!;
    const afterFund = migrateEffortRecipes(nextJob.productProfile);
    expect(afterFund.some((recipe) => recipe.name === "Think")).toBe(true);
    expect(afterFund.some((recipe) => recipe.name === "Deep")).toBe(true);
    expect(afterFund.filter((recipe) => recipe.kind === "trained")).toHaveLength(
      2,
    );
    const instantFunded = afterFund.find(
      (recipe) => recipe.id === INSTANT_EFFORT_ID,
    )!;
    expect(instantFunded.targetPfDays ?? 0).toBeGreaterThan(
      instantBefore.targetPfDays ?? 0,
    );

    for (let day = 0; day < 20; day += 1) {
      nextJob = applyEffortHeadTick(state, nextJob, 10, day).job;
    }
    const afterTicks = migrateEffortRecipes(nextJob.productProfile);
    const instantAfter = afterTicks.find(
      (recipe) => recipe.id === INSTANT_EFFORT_ID,
    )!;
    expect(instantAfter.progressPfDays ?? 0).toBeGreaterThan(
      instantFunded.progressPfDays ?? 0,
    );
    expect(instantAfter.trainPfDays).toBeGreaterThan(instantFunded.trainPfDays);
    expect(afterTicks.some((recipe) => recipe.name === "Think")).toBe(true);
    expect(afterTicks.some((recipe) => recipe.name === "Deep")).toBe(true);
    expect(
      afterTicks.find((recipe) => recipe.name === "Deep")?.thinkingTokenMult,
    ).toBe(deepBefore.thinkingTokenMult);

    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: {
          ...nextJob,
          progressPfDays: nextJob.targetPfDays,
          daysElapsed: Math.max(nextJob.minCalendarDays ?? 0, 30),
          stage: "done",
        },
        trainingJobs: [
          {
            ...nextJob,
            progressPfDays: nextJob.targetPfDays,
            daysElapsed: Math.max(nextJob.minCalendarDays ?? 0, 30),
            stage: "done",
          },
        ],
      },
    };
    state = releaseFromJob(state, undefined, { list: false });
    const released = state.player.models.at(-1)!;
    const releasedRecipes = migrateEffortRecipes(released.productProfile);
    expect(releasedRecipes.some((recipe) => recipe.name === "Think")).toBe(
      true,
    );
    expect(releasedRecipes.some((recipe) => recipe.name === "Deep")).toBe(true);
    expect(
      releasedRecipes.find((recipe) => recipe.id === INSTANT_EFFORT_ID)
        ?.trainPfDays ?? 0,
    ).toBeGreaterThan(instantBefore.trainPfDays);
  });

  it("keeps sibling heads when Continue train runs on a released Instant", () => {
    let state = startTraining(richState(4405), {
      name: "Released Heads",
      family: "dense",
      paramsB: 1,
    });
    const job = state.player.trainingJob!;
    state = startEffortTraining(state, {
      id: job.id,
      name: "Think",
      thinkingTokenMult: 2.5,
      trainPfDays: 10,
    });
    let working = state.player.trainingJob!;
    for (let day = 0; day < 24; day += 1) {
      working = applyEffortHeadTick(state, working, 10, day).job;
    }
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: working,
        trainingJobs: [working],
      },
    };
    state = releaseFromJob(finishJob(state), undefined, { list: false });
    const model = state.player.models.at(-1)!;
    const before = migrateEffortRecipes(model.productProfile);
    const think = before.find((recipe) => recipe.name === "Think")!;
    const instantBefore = before.find(
      (recipe) => recipe.id === INSTANT_EFFORT_ID,
    )!;

    state = startEffortTraining(state, {
      id: model.id,
      recipeId: INSTANT_EFFORT_ID,
      name: "Instant",
      trainPfDays: 6,
      trainComputeShare: 0.2,
    });
    const after = migrateEffortRecipes(
      state.player.models.find((candidate) => candidate.id === model.id)
        ?.productProfile,
    );
    expect(after.some((recipe) => recipe.name === "Think")).toBe(true);
    expect(after.find((recipe) => recipe.name === "Think")?.quality).toBeCloseTo(
      think.quality,
      5,
    );
    expect(after.find((recipe) => recipe.name === "Think")?.served).toBe(
      think.served,
    );
    const instantAfter = after.find(
      (recipe) => recipe.id === INSTANT_EFFORT_ID,
    )!;
    expect(instantAfter.trainPfDays).toBeGreaterThan(instantBefore.trainPfDays);
    expect(instantAfter.progressPfDays ?? 0).toBeGreaterThan(
      instantBefore.progressPfDays ?? 0,
    );
    expect(instantAfter.targetPfDays ?? 0).toBeGreaterThan(
      instantBefore.targetPfDays ?? 0,
    );
  });
});

function finishJob(state: SimState): SimState {
  const job = state.player.trainingJob;
  if (!job) return state;
  const done = {
    ...job,
    progressPfDays: job.targetPfDays,
    daysElapsed: Math.max(job.minCalendarDays ?? 0, 30),
    stage: "done" as const,
  };
  return {
    ...state,
    player: {
      ...state.player,
      trainingJob: done,
      trainingJobs: [done],
    },
  };
}