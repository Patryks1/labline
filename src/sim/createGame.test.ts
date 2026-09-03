import { describe, expect, it } from "vitest";
import { createGame } from "./createGame";
import { TRAINING_V4 } from "./training/constants";
import { emptyTrainingState } from "./training/state";
import { starterTrainingState } from "./training/createStarterTraining";

describe("createGame training slice", () => {
  it("gives the player a starter V4 slice and rivals an empty one", () => {
    const seed = 4_202;
    const state = createGame({
      seed,
      difficulty: "easy",
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 2 },
      legacyMapFixture: true,
    });
    const expectedStarter = starterTrainingState(seed, 0);
    const tier0 = TRAINING_V4.gyms.tiers[0];

    expect(state.player.training).toEqual(expectedStarter);
    expect(state.player.training.gyms).toEqual([
      {
        id: `gym-${seed}-code`,
        labId: "player",
        kind: "code",
        tier: 0,
        quality: tier0.quality,
        tasksPerDay: tier0.tasksPerDay,
        researchers: 0,
        researchShare: 0,
        budgetPerDay: 0,
        auditShare: 0,
      },
    ]);
    expect(state.player.training.pools).toEqual({
      instructionMTok: 2,
      preferenceMTok: 0.5,
      verifiableTasks: 200,
      toolTrajectories: 0,
    });
    expect(state.player.training.seasons).toEqual([
      { season: 1, startDay: 0, difficultyIndex: 1, contamination: {} },
    ]);
    expect(state.player.training.runs).toEqual([]);
    expect(state.player.training.checkpoints).toEqual([]);
    expect(state.player.training.recipes).toEqual([]);
    expect(state.player.training.evals).toEqual([]);
    expect(state.player.training.endpoints).toEqual([]);
    expect(state.player.training.reservations).toEqual([]);

    for (const rival of state.rivals) {
      expect(rival.training).toEqual(emptyTrainingState());
    }
  });

  it("keeps the starter corpus and Foundations season alongside V4 training", () => {
    const state = createGame(7);
    expect(state.player.data).toBeDefined();
    expect(state.benchmarkSeasons[0]?.id).toBe("season-2026-foundations");
    expect(state.player.researchPods?.length).toBeGreaterThan(0);
  });
});
