import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  benchmarkTrainingJob,
  cancelTraining,
  captureTrainingCheckpoint,
  completeTrainingJobsNow,
  keepInternal,
  promoteTrainingCheckpoint,
  selectPostTrain,
  startTraining,
  tickTraining,
  trainingStageFailurePlan,
} from "./training";
import { studioPostTrainTargetPfDays } from "../balance/postTraining";
import { ensureLabData } from "./data";
import { tickCheckpointEvaluations } from "./checkpointEvaluations";

function started(seed = 930) {
  const state = startTraining(createGame(seed), {
    name: "Lifecycle",
    family: "dense",
    paramsB: 1,
  });
  expect(state.player.trainingJob).not.toBeNull();
  return state;
}

describe("training lifecycle controls", () => {
  it("creates and finalizes an omni product on a sparse backbone without dropping active params", () => {
    let state = createGame(929);
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 2_000_000_000,
        researchUnlocked: [
          ...state.player.researchUnlocked,
          "mm_vision",
          "mm_diff",
          "mm_video",
          "mm_omni",
          "moe_basics",
          "moe_routing",
          "data_mix",
        ],
      },
    };
    const data = ensureLabData(state);
    state = {
      ...state,
      player: {
        ...state.player,
        data: {
          ...data,
          stocks: {
            ...data.stocks,
            image: { ...data.stocks.image, processed: 200, fromWeb: 200 },
            audio: { ...data.stocks.audio, processed: 200, fromWeb: 200 },
            video: { ...data.stocks.video, processed: 200, fromWeb: 200 },
          },
        },
      },
    };
    state = startTraining(state, {
      name: "Sparse Omni",
      family: "omni",
      backbone: "moe",
      productPreset: "omni",
      paramsB: 0.1,
      activeParamsB: 0.01,
      dataPlan: {
        totalUnits: 200,
        weights: { chat: 0.4, image: 0.2, audio: 0.2, video: 0.2 },
        allowSynthetic: true,
      },
    });

    expect(state.player.trainingJob, state.alerts[0]?.message).toMatchObject({
      family: "omni",
      backbone: "moe",
      productPreset: "omni",
      activeParamsB: 0.01,
    });

    state = completeTrainingJobsNow(state);
    state = keepInternal(state);
    expect(
      state.player.models.find((model) => model.name === "Sparse Omni"),
    ).toMatchObject({
      family: "omni",
      backbone: "moe",
      productPreset: "omni",
      activeParamsB: 0.01,
    });
  });

  it("cancels exactly one concurrent job and preserves the compatibility mirror", () => {
    let state = started();
    state = startTraining(state, {
      name: "Second",
      family: "dense",
      paramsB: 1,
    });
    expect(state.player.trainingJobs).toHaveLength(2);
    const cancelledId = state.player.trainingJobs![0]!.id;

    state = cancelTraining(state, cancelledId);

    expect(state.player.trainingJobs).toHaveLength(1);
    expect(
      state.player.trainingJobs?.some((job) => job.id === cancelledId),
    ).toBe(false);
    expect(state.player.trainingJob?.id).toBe(
      state.player.trainingJobs?.[0]?.id,
    );
  });

  it("gives identical same-day campaigns independent job and checkpoint identities", () => {
    let state = createGame(934);
    state = startTraining(state, {
      name: "Twin Run",
      family: "dense",
      paramsB: 0.1,
    });
    state = startTraining(state, {
      name: "Twin Run",
      family: "dense",
      paramsB: 0.1,
    });
    expect(state.player.trainingJobs).toHaveLength(2);
    expect(new Set(state.player.trainingJobs!.map((job) => job.id)).size).toBe(
      2,
    );

    const prepared = state.player.trainingJobs!.map((job) => ({
      ...job,
      progressPfDays: job.targetPfDays * 0.5,
      campaignMilestonesReached: [0.5],
    }));
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: prepared,
        trainingJob: prepared[0]!,
      },
    };
    state = captureTrainingCheckpoint(state, prepared[0]!.id);
    state = captureTrainingCheckpoint(state, prepared[1]!.id);

    const checkpoints = state.player.trainingCheckpoints ?? [];
    expect(checkpoints).toHaveLength(2);
    expect(new Set(checkpoints.map((checkpoint) => checkpoint.id)).size).toBe(
      2,
    );
    expect(
      new Set(checkpoints.map((checkpoint) => checkpoint.sourceJobId)),
    ).toEqual(new Set(prepared.map((job) => job.id)));

    state = promoteTrainingCheckpoint(state, checkpoints[0]!.id);
    state = cancelTraining(state, prepared[0]!.id);
    expect(
      state.player.models.some(
        (model) => model.id === checkpoints[0]!.model.id,
      ),
    ).toBe(true);
    expect(state.player.trainingCheckpoints![1]!.status).toBe("stealth");
    expect(state.player.trainingJobs!.map((job) => job.id)).toEqual([
      prepared[1]!.id,
    ]);
  });

  it("keeps mature catastrophic failures rare and scales them with recipe risk", () => {
    const repeated = trainingStageFailurePlan(
      { id: "same", outcomeSeed: 42 },
      "base",
    );
    expect(
      trainingStageFailurePlan({ id: "same", outcomeSeed: 42 }, "base"),
    ).toEqual(repeated);
    const failures = Array.from(
      { length: 2_000 },
      (_, seed) =>
        trainingStageFailurePlan(
          { id: `job-${seed}`, outcomeSeed: seed },
          "base",
        ).willFail,
    ).filter(Boolean).length;
    const highRiskFailures = Array.from(
      { length: 2_000 },
      (_, seed) =>
        trainingStageFailurePlan(
          { id: `job-${seed}`, outcomeSeed: seed, outcomeRisk: "high" },
          "base",
        ).willFail,
    ).filter(Boolean).length;
    expect(failures).toBeGreaterThan(15);
    expect(failures).toBeLessThan(55);
    expect(highRiskFailures).toBeGreaterThan(failures * 4);
  });

  it("lets a completed checkpoint choose a specific researched post-train stage", () => {
    const state = started(930);
    const job = state.player.trainingJob!;
    const completed = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [
          {
            ...job,
            progressPfDays: job.targetPfDays,
            daysElapsed: job.minCalendarDays,
          },
        ],
        trainingJob: {
          ...job,
          progressPfDays: job.targetPfDays,
          daysElapsed: job.minCalendarDays,
        },
        researchUnlocked: [...state.player.researchUnlocked, "align_rlhf"],
      },
    };

    const next = selectPostTrain(completed, job.id, "rlhf");
    expect(next.player.trainingJob).toMatchObject({
      postTrain: "rlhf",
      postTrainProgress: 0,
      postTrainTarget: studioPostTrainTargetPfDays(job, "rlhf"),
    });
  });

  it("advances post-training after the base recommendation decision", () => {
    const state = started(934);
    const job = state.player.trainingJob!;
    const completed = {
      ...state,
      player: {
        ...state.player,
        cash: 1_000_000_000,
        trainingJobs: [
          {
            ...job,
            progressPfDays: job.targetPfDays,
            daysElapsed: job.minCalendarDays,
            awaitingDecision: true,
            paused: true,
          },
        ],
        trainingJob: {
          ...job,
          progressPfDays: job.targetPfDays,
          daysElapsed: job.minCalendarDays,
          awaitingDecision: true,
          paused: true,
        },
      },
    };
    let selected = selectPostTrain(completed, job.id, "sft");
    const selectedJob = selected.player.trainingJob!;
    const tinyTargetJob = {
      ...selectedJob,
      postTrainTarget: 1e-6,
    };
    selected = {
      ...selected,
      player: {
        ...selected.player,
        trainingJob: tinyTargetJob,
        trainingJobs: [tinyTargetJob],
      },
    };
    selected = tickTraining(selected);
    expect(
      selected.player.trainingJob?.postTrainStagesCompletedThisRun,
    ).toContain("sft");
  });

  it("switches stages after PF completion without a calendar gate", () => {
    const state = started(935);
    const job = state.player.trainingJob!;
    const baseComplete = {
      ...job,
      progressPfDays: job.targetPfDays,
      daysElapsed: job.minCalendarDays,
    };
    const selected = selectPostTrain(
      {
        ...state,
        player: {
          ...state.player,
          cash: 2_000_000_000,
          researchUnlocked: [...state.player.researchUnlocked, "domain_agents"],
          trainingJobs: [baseComplete],
          trainingJob: baseComplete,
        },
      },
      job.id,
      "sft",
    );
    const sft = selected.player.trainingJob!;
    const waitingOnCalendar = {
      ...sft,
      postTrainProgress: sft.postTrainTarget,
      postTrainDaysElapsed: 0,
    };
    const advanced = selectPostTrain(
      {
        ...selected,
        player: {
          ...selected.player,
          trainingJobs: [waitingOnCalendar],
          trainingJob: waitingOnCalendar,
        },
      },
      job.id,
      "tools",
    );

    expect(advanced.player.trainingJob?.postTrain).toBe("tools");
  });

  it("prevents replaying a completed post-training stage in the same model version", () => {
    const state = started(931);
    const job = state.player.trainingJob!;
    const completed = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [
          {
            ...job,
            progressPfDays: job.targetPfDays,
            daysElapsed: job.minCalendarDays,
            completedPostTrainStages: ["sft" as const],
          },
        ],
        trainingJob: {
          ...job,
          progressPfDays: job.targetPfDays,
          daysElapsed: job.minCalendarDays,
          completedPostTrainStages: ["sft" as const],
        },
      },
    };

    const next = selectPostTrain(completed, job.id, "sft");
    expect(next.player.trainingJob?.postTrain).toBe("none");
    expect(next.alerts[0]?.message).toContain("model version");
  });

  it("materializes tools I/O and lineage history on a tools-trained model", () => {
    const state = startTraining(createGame(933), {
      name: "Lifecycle",
      family: "dense",
      paramsB: 1,
      io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 0 },
    });
    const job = state.player.trainingJob!;
    const baseComplete = {
      ...state,
      player: {
        ...state.player,
        cash: 2_000_000_000,
        researchUnlocked: [...state.player.researchUnlocked, "domain_agents"],
        trainingJobs: [
          {
            ...job,
            progressPfDays: job.targetPfDays,
            daysElapsed: job.minCalendarDays,
          },
        ],
        trainingJob: {
          ...job,
          progressPfDays: job.targetPfDays,
          daysElapsed: job.minCalendarDays,
        },
      },
    };
    const baseline = keepInternal(baseComplete, job.id).player.models.find(
      (candidate) => candidate.name === "Lifecycle",
    )!;
    const selected = selectPostTrain(baseComplete, job.id, "tools");
    const stageComplete = completeTrainingJobsNow(selected);
    expect(
      stageComplete.player.trainingJob?.completedPostTrainStages,
    ).toContain("tools");
    expect(
      stageComplete.player.trainingJob?.postTrainStageEffectiveness?.tools,
    ).toBeGreaterThan(0);

    const finalized = keepInternal(stageComplete, job.id);
    const model = finalized.player.models.find(
      (candidate) => candidate.name === "Lifecycle",
    )!;
    expect(model.completedPostTrainStages).toContain("tools");
    expect(model.io?.tools).toBeGreaterThan(0);
    expect(model.modalities).toContain("tools");
    expect(model.benchmarks.agents).toBeGreaterThan(baseline.benchmarks.agents);
    expect(model.evaluationProfile?.agents?.penalty).not.toBe(
      "Tools I/O is not enabled",
    );
  });

  it("benchmarks a completed run as a private model without releasing it", () => {
    const state = started(932);
    const job = state.player.trainingJob!;
    const midrun = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays * 0.5 }],
        trainingJob: { ...job, progressPfDays: job.targetPfDays * 0.5 },
      },
    };

    // Benchmarks run asynchronously: scheduling queues a checkpoint due in 2d.
    const scheduled = benchmarkTrainingJob(midrun, job.id);
    const queued = scheduled.player.trainingJobs?.find(
      (candidate) => candidate.id === job.id,
    );
    expect(queued).toBeTruthy();
    expect(queued!.benchmarkSnapshots?.length ?? 0).toBe(0);
    expect(queued!.pendingBenchmark).toMatchObject({
      startedDay: scheduled.day,
      readyDay: scheduled.day + 2,
    });
    expect(queued!.lastBenchmarkDay).toBe(scheduled.day);
    expect(scheduled.player.models.length).toBe(midrun.player.models.length);

    // The checkpoint resolves into a non-terminal snapshot two days later —
    // it still does not materialize or release a model.
    const resolved = tickCheckpointEvaluations({
      ...scheduled,
      day: scheduled.day + 2,
    });
    const updated = resolved.player.trainingJobs?.find(
      (candidate) => candidate.id === job.id,
    );
    expect(updated).toBeTruthy();
    expect(updated!.pendingBenchmark).toBeUndefined();
    expect(updated!.benchmarkSnapshots?.length ?? 0).toBeGreaterThan(0);
    expect(resolved.player.models.length).toBe(midrun.player.models.length);
  });

  it("makes checkpoint estimates deterministically noisy with a 20%+ confidence band", () => {
    const state = started(933);
    const job = state.player.trainingJob!;
    const benchmarkable = {
      ...state,
      player: {
        ...state.player,
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays * 0.5 }],
        trainingJob: { ...job, progressPfDays: job.targetPfDays * 0.5 },
      },
    };

    const resolveBenchmark = (input: typeof benchmarkable) => {
      const scheduled = benchmarkTrainingJob(input, job.id);
      const resolved = tickCheckpointEvaluations({
        ...scheduled,
        day: scheduled.day + 2,
      });
      return resolved.player.trainingJobs!.find(
        (candidate) => candidate.id === job.id,
      )!.benchmarkSnapshots![0]!;
    };
    const first = resolveBenchmark(benchmarkable);
    const repeated = resolveBenchmark(benchmarkable);

    expect(repeated).toEqual(first);
    expect(first.inaccuracy).toBeGreaterThanOrEqual(0.2);
    expect(first.confidence).toBeLessThan(1);
    expect(first.capabilityLow).toBeLessThanOrEqual(first.capability * 0.8);
    expect(first.capabilityHigh).toBeGreaterThanOrEqual(first.capability * 1.2);
  });
});
