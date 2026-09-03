import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { rivalDesignFor, rivalTrainCadenceDays, tickRivalTraining } from "./rivals";
import { tickRuns } from "./run";
import { trainingStateOf, withTrainingState } from "./state";

describe("rival V4 training", () => {
  it("chooses a design by cadence and completes a run through tickRuns", () => {
    let state = createGame(2026);
    const rival = state.rivals[0]!;
    expect(rivalDesignFor(state, rival.id)).not.toBeNull();
    const cadence = rivalTrainCadenceDays(state, rival);
    expect(cadence).toBeGreaterThanOrEqual(120);
    expect(cadence).toBeLessThanOrEqual(400);

    state = tickRivalTraining(state);
    let training = trainingStateOf(state, rival.id);
    expect(training.runs.length).toBeGreaterThan(0);
    const runId = training.runs[0]!.id;

    let ticks = 0;
    while (ticks < 80) {
      const live = trainingStateOf(state, rival.id).runs.find((row) => row.id === runId);
      if (!live || live.status === "completed" || live.status === "failed") break;
      state = { ...state, day: state.day + 1 };
      state = tickRuns(state);
      ticks += 1;
    }
    const done = trainingStateOf(state, rival.id).runs.find((row) => row.id === runId);
    expect(done?.status).toBe("completed");
    expect(done?.finalCheckpointId).toBeTruthy();
    expect(trainingStateOf(state, rival.id).biggestTrainedParamsB).toBeGreaterThanOrEqual(7);

    const blocked = withTrainingState(state, rival.id, {
      ...trainingStateOf(state, rival.id),
      runs: trainingStateOf(state, rival.id).runs.map((row) =>
        row.id === runId ? { ...row, status: "running" as const, startDay: state.day } : row,
      ),
    });
    expect(rivalDesignFor(blocked, rival.id)).toBeNull();
  });

  it("does not call Math.random", () => {
    const original = Math.random.bind(Math);
    let calls = 0;
    Math.random = () => {
      calls += 1;
      return original();
    };
    try {
      let state = createGame(88);
      state = tickRivalTraining(state);
      state = { ...state, day: state.day + 1 };
      tickRuns(state);
      expect(calls).toBe(0);
    } finally {
      Math.random = original;
    }
  });
});
