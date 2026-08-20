import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { minimumTrainingCalendarDays } from "./trainingDuration";
import {
  appendLossPoint,
  canReleaseTrainingJob,
  playerTrainingResourcePlan,
  startTraining,
  tickTraining,
  trainingLoss,
} from "./training";
import {
  fundedTrainingMaturity,
  pacedTrainingPfPerDay,
} from "../balance/training";
import type { TrainingJob } from "../types";
import { mwPerPf } from "./computeMarket";
import { computeSnapshot } from "./compute";

function richState(seed: number) {
  const state = createGame(seed);
  return {
    ...state,
    player: {
      ...state.player,
      cash: 5_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
    },
  };
}

describe("minimum training duration", () => {
  it("derives a bounded calendar gate from scale, family, and mode", () => {
    const small = minimumTrainingCalendarDays({ paramsB: 1, family: "dense" });
    const frontier = minimumTrainingCalendarDays({
      paramsB: 405,
      family: "dense",
    });
    const video = minimumTrainingCalendarDays({
      paramsB: 405,
      family: "video",
    });
    const distill = minimumTrainingCalendarDays({
      paramsB: 405,
      family: "dense",
      mode: "distill",
    });
    expect(frontier).toBeGreaterThan(small);
    expect(video).toBeGreaterThan(frontier);
    expect(distill).toBeLessThan(frontier);
    expect(small).toBeGreaterThanOrEqual(24);
    expect(frontier).toBeGreaterThanOrEqual(58);
  });

  it("never compresses any training mode below ten calendar days", () => {
    for (const mode of ["pretrain", "continue", "distill"] as const) {
      expect(
        minimumTrainingCalendarDays({ paramsB: 0.001, family: "dense", mode }),
      ).toBeGreaterThanOrEqual(10);
    }
  });

  it("paces trillion-scale models and their data workload across 100–150 active days", () => {
    const thinOneTrillion = minimumTrainingCalendarDays({
      paramsB: 1_000,
      family: "dense",
      trainingTokensMTok: 1,
    });
    const strongOneTrillion = minimumTrainingCalendarDays({
      paramsB: 1_000,
      family: "dense",
      trainingTokensMTok: 4_920_000,
      verificationTokensMTok: 1_080_000,
    });
    const strongThirtyTrillion = minimumTrainingCalendarDays({
      paramsB: 30_000,
      family: "dense",
      trainingTokensMTok: 147_600_000,
      verificationTokensMTok: 32_400_000,
    });

    expect(thinOneTrillion).toBe(100);
    expect(strongOneTrillion).toBe(125);
    expect(strongThirtyTrillion).toBe(150);
    expect(pacedTrainingPfPerDay(15_000, strongThirtyTrillion)).toBe(100);
  });

  it("freezes the derived trillion-scale pace onto newly started jobs", () => {
    const state = startTraining(richState(1208), {
      name: "One trillion",
      family: "dense",
      paramsB: 1_000,
      computePriority: 0,
      dataPlan: {
        totalUnits: 1,
        totalMTok: 1,
        trainShare: 0.82,
        weights: {},
        allowSynthetic: false,
      },
    });
    const job = state.player.trainingJob!;

    expect(job.targetParamsB).toBe(1_000);
    expect(job.minCalendarDays).toBeGreaterThanOrEqual(100);
    expect(job.minCalendarDays).toBeLessThanOrEqual(150);
  });

  it("keeps PF work and upfront cash independent of launch-time pool size", () => {
    const fast = startTraining(richState(1201), {
      name: "PoolInvariant",
      family: "dense",
      paramsB: 1,
    });
    const slowBase = richState(1201);
    const slow = startTraining(
      {
        ...slowBase,
        player: {
          ...slowBase.player,
          allocation: { training: 0.05, inference: 0.9, research: 0.05 },
        },
      },
      { name: "PoolInvariant", family: "dense", paramsB: 1 },
    );
    expect(slow.player.trainingJob!.targetPfDays).toBeCloseTo(
      fast.player.trainingJob!.targetPfDays,
    );
    expect(slow.player.trainingJob!.cashSunk).toBe(
      fast.player.trainingJob!.cashSunk,
    );
  });

  it("treats priority zero as an allocated-compute pause", () => {
    const state = startTraining(richState(1204), {
      name: "Zero priority",
      family: "dense",
      paramsB: 1,
      computePriority: 0,
    });
    const job = state.player.trainingJob!;
    expect(job.computePriority).toBe(0);
    expect(playerTrainingResourcePlan(state).jobs[job.id]!.effectivePf).toBe(0);
    expect(tickTraining(state).player.trainingJob!.progressPfDays).toBe(0);
    expect(computeSnapshot(state).mwBreakdown.training).toBe(0);
  });

  it("continues recurring training burn and allocated PF while cash is negative", () => {
    const started = startTraining(richState(1205), {
      name: "Debt financed run",
      family: "dense",
      paramsB: 1,
      computePriority: 100,
    });
    const job = started.player.trainingJob!;
    const dailyPf =
      playerTrainingResourcePlan(started).jobs[job.id]!.effectivePf;
    const running = {
      ...job,
      targetPfDays: dailyPf * 100,
      recommendedPfDays: dailyPf * 100,
      campaignMilestonesReached: [],
    };
    let state = {
      ...started,
      player: {
        ...started.player,
        cash: -1,
        trainingJob: running,
        trainingJobs: [running],
      },
    };
    const first = tickTraining(state);
    const second = tickTraining({ ...first, day: first.day + 1 });
    expect(first.player.cash).toBeLessThan(state.player.cash);
    expect(second.player.cash).toBeLessThan(first.player.cash);
    expect(first.player.trainingJob!.progressPfDays).toBeGreaterThan(0);
    expect(second.player.trainingJob!.progressPfDays).toBeGreaterThan(
      first.player.trainingJob!.progressPfDays,
    );
  });

  it("keeps investing allocated PF after the releasable target is complete", () => {
    let state = startTraining(richState(1201), {
      name: "FastTrain",
      family: "dense",
      paramsB: 1,
      computePriority: 100,
    });
    const job = state.player.trainingJob!;
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...job, progressPfDays: job.targetPfDays },
        trainingJobs: [{ ...job, progressPfDays: job.targetPfDays }],
      },
    };

    state = tickTraining(state);
    expect(state.player.trainingJob!.pendingPostTrainPhase).toBeFalsy();
    expect(state.player.trainingJob!.postTrainPhaseResolved).toBe(true);
    const allocatedPf =
      playerTrainingResourcePlan(state).jobs[job.id]!.effectivePf;
    expect(state.player.trainingJob!.progressPfDays).toBeCloseTo(
      job.targetPfDays + allocatedPf,
    );
    state = tickTraining(state);
    expect(state.player.trainingJob!.daysElapsed).toBe(2);
    expect(state.player.trainingJob!.progressPfDays).toBeCloseTo(
      job.targetPfDays + allocatedPf * 2,
    );
    expect(canReleaseTrainingJob(state.player.trainingJob!).ok).toBe(true);
    expect(
      fundedTrainingMaturity(state.player.trainingJob!).extraSignal,
    ).toBeGreaterThan(0);
    expect(state.player.trainingJob!.awaitingDecision).toBe(false);
    expect(state.player.trainingJob!.daysRemaining).toBe(0);
  });

  it("stops post-target optimization when compute priority is zero", () => {
    let state = startTraining(richState(1206), {
      name: "Target complete idle",
      family: "dense",
      paramsB: 1,
      computePriority: 0,
    });
    const job = state.player.trainingJob!;
    const complete = { ...job, progressPfDays: job.targetPfDays };
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: complete,
        trainingJobs: [complete],
      },
    };

    const next = tickTraining(state);
    expect(next.player.trainingJob!.progressPfDays).toBe(job.targetPfDays);
    expect(next.player.trainingJob!.daysElapsed).toBe(0);
    expect(next.player.cash).toBe(state.player.cash);
  });

  it("accumulates allocated-PF energy and recomputes live days remaining", () => {
    let state = startTraining(richState(1202), {
      name: "MeteredTrain",
      family: "dense",
      paramsB: 1,
      computePriority: 100,
    });
    const started = state.player.trainingJob!;
    const firstAllocatedPf =
      playerTrainingResourcePlan(state).jobs[started.id]!.effectivePf;
    expect(firstAllocatedPf).toBeGreaterThan(0);

    // Keep the metering fixture below the first campaign checkpoint. Campaign
    // decisions intentionally stop the run until the player intervenes.
    const targetPfDays = firstAllocatedPf * 20;
    const meteredJob = {
      ...started,
      targetPfDays,
      recommendedPfDays: targetPfDays,
      minCalendarDays: 20,
      daysRemaining: 20,
    };
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: meteredJob,
        trainingJobs: [meteredJob],
      },
    };

    state = tickTraining(state);
    const afterOne = state.player.trainingJob!;
    expect(afterOne.energyMwDays).toBeCloseTo(firstAllocatedPf * mwPerPf(), 10);
    expect(afterOne.energyMWh).toBeCloseTo(
      firstAllocatedPf * mwPerPf() * 24,
      10,
    );
    expect(afterOne.daysRemaining).toBeCloseTo(19, 10);

    const secondAllocatedPf =
      playerTrainingResourcePlan(state).jobs[started.id]!.effectivePf;
    state = tickTraining({ ...state, day: state.day + 1 });
    const afterTwo = state.player.trainingJob!;
    expect(afterTwo.energyMwDays).toBeCloseTo(
      (firstAllocatedPf + secondAllocatedPf) * mwPerPf(),
      10,
    );
    expect(afterTwo.daysRemaining).toBeCloseTo(18, 10);
    expect(afterTwo.daysRemaining!).toBeLessThan(afterOne.daysRemaining!);
  });

  it("credits only the trillion-scale model/data pipeline limit each active day", () => {
    let state = startTraining(richState(1207), {
      name: "Pipeline paced",
      family: "dense",
      paramsB: 1,
      computePriority: 100,
    });
    const started = state.player.trainingJob!;
    const allocatedPf =
      playerTrainingResourcePlan(state).jobs[started.id]!.effectivePf;
    const targetPfDays = allocatedPf * 12;
    const pacedJob = {
      ...started,
      targetPfDays,
      recommendedPfDays: targetPfDays,
      minCalendarDays: 120,
      campaignMilestonesReached: [],
    };
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: pacedJob,
        trainingJobs: [pacedJob],
      },
    };

    const next = tickTraining(state).player.trainingJob!;
    expect(next.progressPfDays).toBeCloseTo(targetPfDays / 120, 10);
    expect(next.progressPfDays).toBeLessThan(allocatedPf);
    expect(next.daysRemaining).toBeCloseTo(119, 10);
  });
});

describe("training loss curve", () => {
  const job: Parameters<typeof trainingLoss>[0] = {
    id: "loss-job",
    outcomeSeed: 4242,
    targetParamsB: 8,
  };

  it("trends downward with diminishing late gains and stays above the floor", () => {
    const early = trainingLoss(job, "base", 0.05, 1);
    const mid = trainingLoss(job, "base", 0.5, 50);
    const late = trainingLoss(job, "base", 0.95, 95);
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late * 0.85);
    // Late-run day-to-day trend improvement is much smaller than early.
    const earlyDelta =
      trainingLoss(job, "base", 0.0, 1) - trainingLoss(job, "base", 0.1, 10);
    const lateDelta =
      trainingLoss(job, "base", 0.85, 85) - trainingLoss(job, "base", 0.95, 95);
    expect(earlyDelta).toBeGreaterThan(lateDelta * 2);
    expect(late).toBeGreaterThanOrEqual(1.15 * 0.92);
  });

  it("shows bounded post-target loss improvement instead of a flat line", () => {
    const target = trainingLoss(job, "base", 1, 100);
    const extra = trainingLoss(job, "base", 2, 100);
    const extreme = trainingLoss(job, "base", 20, 100);
    expect(extra).toBeLessThan(target);
    expect(target - extreme).toBeLessThan(0.2);
  });

  it("records non-monotonic observed history with up-ticks while trending down", () => {
    let historyJob: TrainingJob = {
      id: job.id,
      name: "LossHist",
      family: "dense",
      targetParamsB: job.targetParamsB,
      targetPfDays: 100,
      progressPfDays: 0,
      postTrain: "none",
      postTrainProgress: 0,
      postTrainTarget: 0,
      mode: "pretrain",
      dataMix: "web",
      dataPlan: {
        totalUnits: 100,
        totalMTok: 100,
        trainShare: 0.82,
        weights: {},
        allowSynthetic: true,
      },
      dataConsumed: {},
      dataCoverage: 1,
      dataQualityUsed: 70,
      syntheticUnits: 0,
      trainShare: 0.82,
      trainMTok: 82,
      verifyMTok: 18,
      cashBurnPerDay: 0,
      cashSunk: 0,
      outcomeSeed: job.outcomeSeed,
      lossHistory: [],
    };

    for (let day = 1; day <= 40; day++) {
      const progress = day / 40;
      historyJob = {
        ...historyJob,
        lossHistory: appendLossPoint(historyJob, "base", progress, day),
      };
    }
    const losses = historyJob.lossHistory!.map((point) => point.loss);
    expect(losses.length).toBe(40);
    expect(losses[0]!).toBeGreaterThan(losses[losses.length - 1]!);
    const upTicks = losses.filter(
      (loss, index) => index > 0 && loss > losses[index - 1]!,
    ).length;
    expect(upTicks).toBeGreaterThan(0);
    expect(Math.min(...losses)).toBeGreaterThanOrEqual(1.15 * 0.92 - 1e-9);
  });

  it("is deterministic for the same seed / day sequence", () => {
    const a = Array.from({ length: 20 }, (_, day) =>
      trainingLoss(job, "base", day / 20, day + 1),
    );
    const b = Array.from({ length: 20 }, (_, day) =>
      trainingLoss(job, "base", day / 20, day + 1),
    );
    expect(a).toEqual(b);

    let histA: TrainingJob = {
      id: job.id,
      name: "DetA",
      family: "dense",
      targetParamsB: job.targetParamsB,
      targetPfDays: 20,
      progressPfDays: 0,
      postTrain: "none",
      postTrainProgress: 0,
      postTrainTarget: 0,
      mode: "pretrain",
      dataMix: "web",
      dataPlan: {
        totalUnits: 20,
        totalMTok: 20,
        trainShare: 0.82,
        weights: {},
        allowSynthetic: true,
      },
      dataConsumed: {},
      dataCoverage: 1,
      dataQualityUsed: 70,
      syntheticUnits: 0,
      trainShare: 0.82,
      trainMTok: 16,
      verifyMTok: 4,
      cashBurnPerDay: 0,
      cashSunk: 0,
      outcomeSeed: job.outcomeSeed,
      lossHistory: [],
    };
    let histB = { ...histA };
    for (let day = 1; day <= 12; day++) {
      histA = {
        ...histA,
        lossHistory: appendLossPoint(histA, "base", day / 12, day),
      };
      histB = {
        ...histB,
        lossHistory: appendLossPoint(histB, "base", day / 12, day),
      };
    }
    expect(histA.lossHistory).toEqual(histB.lossHistory);
  });
});
