import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { roundTripState } from "../save";
import type { SimState, TrainingJob } from "../types";
import {
  createManualTrainingCheckpoint,
  eligiblePostTrainRecoveryCheckpoint,
  playerTrainingResourcePlan,
  recoverFailedPostTrainFromCheckpoint,
  rollbackTrainingJobToCheckpoint,
  selectPostTrain,
  startTraining,
  tickTraining,
  trainingStageFailurePlan,
  withTrainingJobs,
} from "./training";

function replaceJob(state: SimState, job: TrainingJob): SimState {
  return withTrainingJobs(
    state,
    (state.player.trainingJobs ?? [job]).map((candidate) =>
      candidate.id === job.id ? job : candidate,
    ),
  );
}

function completedBase(seed: number): SimState {
  const base = createGame(seed);
  let state = startTraining(
    {
      ...base,
      player: {
        ...base.player,
        cash: 5_000_000_000,
        allocation: { training: 0.9, inference: 0.05, research: 0.05 },
      },
    },
    {
      name: `Recovery Atlas ${seed}`,
      family: "dense",
      paramsB: 0.1,
      computePriority: 100,
    },
  );
  const job = state.player.trainingJob!;
  expect(job, state.alerts[0]?.message).toBeTruthy();
  state = replaceJob(state, {
    ...job,
    progressPfDays: job.targetPfDays,
    paused: false,
    awaitingDecision: false,
    pendingCampaignEvent: undefined,
  });
  return state;
}

function selectedSft(seed: number, captureBase: boolean): SimState {
  let state = completedBase(seed);
  const jobId = state.player.trainingJob!.id;
  if (captureBase) {
    state = createManualTrainingCheckpoint(state, {
      sourceJobId: jobId,
      label: "Known-good base",
    });
  }
  return selectPostTrain(state, jobId, "sft");
}

function forcePostFailure(
  state: SimState,
  options: { atFraction: number; startingFraction?: number },
): SimState {
  const job = state.player.trainingJob!;
  const dailyPf = playerTrainingResourcePlan(state).jobs[job.id]!.effectivePf;
  expect(dailyPf).toBeGreaterThan(0);
  const target = Math.max(1e-6, dailyPf * 2);
  return replaceJob(state, {
    ...job,
    postTrainTarget: target,
    postTrainProgress: target * (options.startingFraction ?? 0),
    postTrainRiskPlan: {
      ...job.postTrainRiskPlan!,
      probability: 0.24,
      band: "critical",
      willFail: true,
      atFraction: options.atFraction,
      factors: ["thin relevant dataset", "long optimization horizon"],
    },
  });
}

describe("checkpoint-backed post-training recovery", () => {
  it("freezes an explainable risk plan at stage selection and across saves", () => {
    const selected = selectedSft(16_001, false);
    const plan = selected.player.trainingJob!.postTrainRiskPlan;
    expect(plan).toMatchObject({ stage: "sft", seedVersion: 2 });
    expect(plan!.probability).toBeGreaterThan(0);
    expect(plan!.factors.length).toBeGreaterThan(0);

    const researched: SimState = {
      ...selected,
      player: {
        ...selected.player,
        researchUnlocked: [...selected.player.researchUnlocked, "align_sft"],
      },
    };
    expect(roundTripState(researched).player.trainingJob!.postTrainRiskPlan).toEqual(
      plan,
    );
  });

  it("sanitizes malformed persisted risk and failure telemetry without rerolling valid plans", () => {
    const selected = selectedSft(16_007, false);
    const job = selected.player.trainingJob!;
    const corrupted = replaceJob(selected, {
      ...job,
      failed: true,
      failureStage: "sft",
      failureRecord: {
        kind: "supervision_collapse",
        stage: "sft",
        day: selected.day,
        progressPfDays: Number.NaN,
        stageProgress: Number.POSITIVE_INFINITY,
        probability: Number.NaN,
        riskBand: "critical",
        factors: ["legacy malformed record"],
      },
      postTrainRiskPlan: {
        ...job.postTrainRiskPlan!,
        probability: Number.NaN,
        atFraction: Number.POSITIVE_INFINITY,
        startFraction: Number.NaN,
      },
    });
    const restored = roundTripState(corrupted).player.trainingJob!;

    expect(restored.postTrainRiskPlan).toMatchObject({
      probability: 0,
      atFraction: 0.5,
      startFraction: undefined,
    });
    expect(restored.failureRecord).toMatchObject({
      progressPfDays: job.progressPfDays,
      stageProgress: 0,
      probability: 0,
      factors: ["legacy malformed record"],
    });
  });

  it("stops at the exact hidden crossing and exposes structured recovery metadata", () => {
    let state = selectedSft(16_002, true);
    state = forcePostFailure(state, { atFraction: 0.4 });
    const target = state.player.trainingJob!.postTrainTarget;
    state = tickTraining(state);

    const failed = state.player.trainingJob!;
    const checkpoint = eligiblePostTrainRecoveryCheckpoint(state, failed.id);
    expect(failed.failed).toBe(true);
    expect(failed.postTrainProgress).toBeCloseTo(target * 0.4, 10);
    expect(failed.failureRecord).toMatchObject({
      kind: "supervision_collapse",
      stage: "sft",
      stageProgress: 0.4,
      probability: 0.24,
      riskBand: "critical",
      recoveryCheckpointId: checkpoint!.id,
    });
    expect(failed.completedPostTrainStages).not.toContain("sft");
    expect(failed.paused).toBe(true);
  });

  it("makes a no-checkpoint failure terminal", () => {
    let state = forcePostFailure(selectedSft(16_003, false), {
      atFraction: 0.35,
    });
    state = tickTraining(state);
    const failed = state.player.trainingJob!;

    expect(failed.failed).toBe(true);
    expect(failed.failureRecoveryCheckpointId).toBeUndefined();
    expect(failed.failureReason).toContain("No eligible pre-failure checkpoint");
    const attempted = recoverFailedPostTrainFromCheckpoint(state, {
      jobId: failed.id,
      checkpointId: "missing",
    });
    expect(attempted.player.trainingJobs).toHaveLength(1);
  });

  it("restores as a distinct child, resumes exact weights, and does not repay data", () => {
    let state = selectedSft(16_004, false);
    state = forcePostFailure(state, {
      atFraction: 0.6,
      startingFraction: 0.25,
    });
    const sourceId = state.player.trainingJob!.id;
    state = createManualTrainingCheckpoint(state, {
      sourceJobId: sourceId,
      label: "SFT quarter point",
    });
    const checkpoint = state.player.trainingCheckpoints!.at(-1)!;
    state = tickTraining(state);
    const failed = state.player.trainingJob!;
    expect(failed.failureRecoveryCheckpointId).toBe(checkpoint.id);

    const cashBefore = state.player.cash;
    const dataBefore = state.player.data;
    const recovered = recoverFailedPostTrainFromCheckpoint(state, {
      jobId: sourceId,
      checkpointId: checkpoint.id,
    });
    const jobs = recovered.player.trainingJobs!;
    const source = jobs.find((job) => job.id === sourceId)!;
    const child = jobs.find((job) => job.recoveredFromJobId === sourceId)!;

    expect(jobs).toHaveLength(2);
    expect(source.failed).toBe(true);
    expect(source.recoveryChildJobId).toBe(child.id);
    expect(child.id).not.toBe(source.id);
    expect(child).toMatchObject({
      recoveryCheckpointId: checkpoint.id,
      parentCheckpointId: checkpoint.id,
      postTrain: "sft",
      postTrainRecoveryAttempt: 1,
      failed: false,
      paused: false,
      cashSunk: 0,
      economics: { setupCost: 0, dataCost: 0, trainingCostAccrued: 0 },
    });
    expect(child.postTrainProgress / child.postTrainTarget).toBeCloseTo(0.25);
    expect(child.postTrainRiskPlan!.atFraction).toBeGreaterThan(0.25);
    expect(recovered.player.cash).toBe(cashBefore);
    expect(recovered.player.data).toEqual(dataBefore);

    const repeated = rollbackTrainingJobToCheckpoint(recovered, {
      jobId: sourceId,
      checkpointId: checkpoint.id,
    });
    expect(repeated.player.trainingJobs).toHaveLength(2);

    const restored = roundTripState(recovered);
    const restoredChild = restored.player.trainingJobs!.find(
      (job) => job.recoveredFromJobId === sourceId,
    )!;
    expect(restoredChild.recoveryCheckpointId).toBe(checkpoint.id);
    expect(restoredChild.postTrainRiskPlan).toEqual(child.postTrainRiskPlan);
    expect(eligiblePostTrainRecoveryCheckpoint(restored, sourceId)?.id).toBe(
      checkpoint.id,
    );
  });

  it("lets the recovery child receive compute while the failed source stays frozen", () => {
    let state = forcePostFailure(selectedSft(16_005, true), {
      atFraction: 0.3,
    });
    state = tickTraining(state);
    const source = state.player.trainingJob!;
    const checkpointId = source.failureRecoveryCheckpointId!;
    state = recoverFailedPostTrainFromCheckpoint(state, {
      jobId: source.id,
      checkpointId,
    });
    const child = state.player.trainingJobs!.find(
      (job) => job.recoveredFromJobId === source.id,
    )!;
    state = replaceJob(state, {
      ...child,
      postTrainRiskPlan: { ...child.postTrainRiskPlan!, willFail: false },
    });
    const before = state.player.trainingJobs!.find(
      (job) => job.id === child.id,
    )!.postTrainProgress;
    const next = tickTraining(state);
    const nextSource = next.player.trainingJobs!.find(
      (job) => job.id === source.id,
    )!;
    const nextChild = next.player.trainingJobs!.find(
      (job) => job.id === child.id,
    )!;

    expect(nextSource.postTrainProgress).toBe(source.postTrainProgress);
    expect(nextChild.postTrainProgress).toBeGreaterThan(before);
  });

  it("cannot skip a base failure behind a campaign milestone", () => {
    const initial = startTraining(createGame(16_006), {
      name: "Boundary order",
      family: "dense",
      paramsB: 0.1,
      computePriority: 100,
    });
    const initialJob = initial.player.trainingJob!;
    const dailyPf = playerTrainingResourcePlan(initial).jobs[initialJob.id]!
      .effectivePf;
    let outcomeSeed = 0;
    let plan = trainingStageFailurePlan(
      { ...initialJob, outcomeSeed, outcomeRisk: "high" },
      "base",
    );
    while (!(plan.willFail && plan.atFraction < 0.32)) {
      outcomeSeed += 1;
      plan = trainingStageFailurePlan(
        { ...initialJob, outcomeSeed, outcomeRisk: "high" },
        "base",
      );
    }
    const target = dailyPf / 0.25;
    const prepared: TrainingJob = {
      ...initialJob,
      targetPfDays: target,
      recommendedPfDays: target,
      progressPfDays: target * 0.1,
      outcomeSeed,
      outcomeRisk: "high",
      campaignMilestonesReached: [],
      pendingCampaignEvent: undefined,
    };
    const next = tickTraining(replaceJob(initial, prepared));
    const failed = next.player.trainingJob!;

    expect(failed.failed).toBe(true);
    expect(failed.progressPfDays).toBeCloseTo(target * plan.atFraction, 10);
    expect(failed.pendingCampaignEvent).toBeUndefined();
    expect(failed.campaignMilestonesReached).toEqual([]);
  });
});
