import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  INSTANT_EFFORT_ID,
  migrateEffortRecipes,
} from "../balance/modelProduct";
import type { SimState } from "../types";
import {
  createManualTrainingCheckpoint,
  forkTrainingCheckpoint,
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

function trainedHeadNames(profile: Parameters<typeof migrateEffortRecipes>[0]) {
  return migrateEffortRecipes(profile)
    .filter((recipe) => recipe.kind === "trained")
    .map((recipe) => recipe.name)
    .sort();
}

describe("checkpoint → train preserves effort heads", () => {
  it("carries Think+Deep from a checkpoint onto the branched job profile", () => {
    let state = startTraining(richState(8801), {
      name: "Headed Atlas",
      family: "dense",
      paramsB: 1,
    });
    const sourceJob = state.player.trainingJob!;
    state = startEffortTraining(state, {
      id: sourceJob.id,
      name: "Think",
      thinkingTokenMult: 2.2,
      trainPfDays: 8,
    });
    state = startEffortTraining(state, {
      id: sourceJob.id,
      name: "Deep",
      thinkingTokenMult: 6,
      trainPfDays: 8,
    });

    const headed = state.player.trainingJob!;
    expect(trainedHeadNames(headed.productProfile)).toEqual(["Deep", "Think"]);

    // Allocate some progress so a manual checkpoint can be captured.
    const progressed = {
      ...headed,
      progressPfDays: Math.max(1, headed.targetPfDays * 0.2),
      daysElapsed: 4,
    };
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: progressed,
        trainingJobs: (state.player.trainingJobs ?? [headed]).map((job) =>
          job.id === headed.id ? progressed : job,
        ),
      },
    };

    state = createManualTrainingCheckpoint(state, {
      sourceJobId: headed.id,
      label: "Heads frozen",
    });
    const checkpoint = state.player.trainingCheckpoints!.at(-1)!;
    expect(trainedHeadNames(checkpoint.model.productProfile)).toEqual([
      "Deep",
      "Think",
    ]);
    expect(
      migrateEffortRecipes(checkpoint.model.productProfile).map((recipe) => ({
        name: recipe.name,
        served: recipe.served,
        thinkingTokenMult: recipe.thinkingTokenMult,
        quality: recipe.quality,
        capabilityBias: recipe.capabilityBias,
      })),
    ).toEqual(
      migrateEffortRecipes(progressed.productProfile).map((recipe) => ({
        name: recipe.name,
        served: recipe.served,
        thinkingTokenMult: recipe.thinkingTokenMult,
        quality: recipe.quality,
        capabilityBias: recipe.capabilityBias,
      })),
    );

    const beforeIds = new Set(
      (state.player.trainingJobs ?? [])
        .map((job) => job.id)
        .concat(state.player.trainingJob ? [state.player.trainingJob.id] : []),
    );
    state = forkTrainingCheckpoint(state, {
      checkpointId: checkpoint.id,
      direction: "general",
      label: "Branch with heads",
    });
    const child = (state.player.trainingJobs ?? []).find(
      (job) => !beforeIds.has(job.id),
    );
    expect(child, state.alerts[0]?.message).toBeDefined();
    expect(child!.parentCheckpointId).toBe(checkpoint.id);
    expect(child!.productProfile).toBeDefined();
    expect(trainedHeadNames(child!.productProfile)).toEqual(["Deep", "Think"]);
    expect(
      migrateEffortRecipes(child!.productProfile).some(
        (recipe) => recipe.id === INSTANT_EFFORT_ID,
      ),
    ).toBe(true);
    expect(
      migrateEffortRecipes(child!.productProfile).filter(
        (recipe) => recipe.kind === "trained",
      ),
    ).toHaveLength(2);
  });
});
