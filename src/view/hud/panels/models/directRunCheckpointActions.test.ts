import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../../sim/createGame";
import type { SimState, TrainingJob } from "../../../../sim/types";
import { createManualTrainingCheckpoint } from "../../../../sim/systems/training";
import {
  directRunCheckpointRequest,
  ensureCurrentRunCheckpoint,
} from "./directRunCheckpointActions";

function runState(progress = 0.42): SimState {
  const base = createGame(41_208);
  const job = {
    id: "job-direct-actions",
    name: "Aster",
    family: "dense",
    targetParamsB: 1,
    targetPfDays: 100,
    progressPfDays: 100 * progress,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    mode: "pretrain",
    dataMix: "web",
    dataPlan: {
      totalUnits: 1_000,
      totalMTok: 1_000,
      trainShare: 0.82,
      weights: {},
      allowSynthetic: false,
    },
    dataConsumed: {},
    dataCoverage: 1,
    dataQualityUsed: 80,
    syntheticUnits: 0,
    trainShare: 0.82,
    trainMTok: 820,
    verifyMTok: 180,
    cashBurnPerDay: 0,
    cashSunk: 0,
    branchDirection: "code",
  } satisfies TrainingJob;
  return {
    ...base,
    player: {
      ...base.player,
      trainingJob: job,
      trainingJobs: [job],
      trainingCheckpoints: [],
    },
  };
}

describe("direct run checkpoint actions", () => {
  it("creates a sensible current-weight label and inherits branch direction", () => {
    expect(
      directRunCheckpointRequest(runState(), "job-direct-actions"),
    ).toEqual({
      sourceJobId: "job-direct-actions",
      label: "Aster · Base 42%",
      branchDirection: "code",
    });
    expect(
      directRunCheckpointRequest(runState(0), "job-direct-actions"),
    ).toBeUndefined();
  });

  it("creates once and reuses the exact persisted checkpoint for benchmarking", () => {
    let state = runState();
    const create = vi.fn((request) => {
      state = createManualTrainingCheckpoint(state, request);
    });
    const ensure = () =>
      ensureCurrentRunCheckpoint({
        state,
        jobId: "job-direct-actions",
        createCheckpoint: create,
        readState: () => state,
      });

    const first = ensure();
    const second = ensure();
    expect(first?.id).toBe(second?.id);
    expect(first?.customLabel).toBe("Aster · Base 42%");
    expect(state.player.trainingCheckpoints).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("captures a distinct post-training fingerprint at unchanged base progress", () => {
    let state = runState(1);
    const baseJob = state.player.trainingJob!;
    const postJob: TrainingJob = {
      ...baseJob,
      postTrain: "sft",
      postTrainProgress: 12,
      postTrainTarget: 40,
    };
    state = {
      ...state,
      player: { ...state.player, trainingJob: postJob, trainingJobs: [postJob] },
    };
    const create = (request: Parameters<typeof createManualTrainingCheckpoint>[1]) => {
      state = createManualTrainingCheckpoint(state, request);
    };
    const checkpoint = ensureCurrentRunCheckpoint({
      state,
      jobId: postJob.id,
      createCheckpoint: create,
      readState: () => state,
    });

    expect(checkpoint?.stage).toBe("sft");
    expect(checkpoint?.customLabel).toBe("Aster · SFT 30%");
  });
});
