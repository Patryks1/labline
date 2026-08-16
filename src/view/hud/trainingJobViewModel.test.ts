import { describe, expect, it } from "vitest";
import type { SimState, TrainingJob } from "../../sim/types";
import { createGame } from "../../sim/createGame";
import type { TrainingResourceAllocation } from "../../sim/systems/training";
import {
  buildTrainingActivity,
  buildTrainingJobViewModel,
  normalizeTrainingJobs,
  selectPrimaryTrainingJob,
  sortTrainingJobViewModels,
} from "./trainingJobViewModel";

function job(patch: Partial<TrainingJob> = {}): TrainingJob {
  return {
    id: "job-active",
    name: "Spark-2",
    targetPfDays: 100,
    progressPfDays: 20,
    postTrain: "none",
    postTrainProgress: 0,
    postTrainTarget: 0,
    mode: "pretrain",
    failed: false,
    paused: false,
    stallReason: null,
    ...patch,
  } as TrainingJob;
}

const readyResources: TrainingResourceAllocation = {
  rawPf: 4,
  effectivePf: 2,
  computeShare: 1,
  ramAllocatedGb: 64,
  ramRequiredGb: 32,
  ramReady: true,
  systemRamAllocatedGb: 128,
  systemRamRequiredGb: 64,
  systemRamReady: true,
  bottleneck: "none",
};

describe("training job view model", () => {
  it("normalizes legacy and concurrent jobs without duplicating the mirror", () => {
    const state = createGame({ seed: 101, difficulty: "easy" });
    const legacy = job({ id: "legacy", name: "Legacy" });
    const concurrent = job({ id: "concurrent", name: "Concurrent" });
    const migrated = {
      ...state,
      player: {
        ...state.player,
        trainingJob: legacy,
        trainingJobs: [concurrent, legacy],
      },
    };

    expect(
      normalizeTrainingJobs(migrated).map((candidate) => candidate.id),
    ).toEqual(["legacy", "concurrent"]);
  });

  it("chooses urgent jobs first and keeps ties deterministic", () => {
    const failed = job({ id: "z-failed", failed: true, failureReason: "OOM" });
    const paused = job({ id: "b-paused", paused: true });
    const active = job({ id: "a-active" });
    const ready = job({ id: "c-ready", progressPfDays: 100 });

    expect(selectPrimaryTrainingJob([active, paused, ready, failed])?.id).toBe(
      "z-failed",
    );

    const sorted = sortTrainingJobViewModels([
      buildTrainingJobViewModel(active, { resource: readyResources }),
      buildTrainingJobViewModel(paused, { resource: readyResources }),
      buildTrainingJobViewModel(ready, { resource: readyResources }),
      buildTrainingJobViewModel(failed, { resource: readyResources }),
    ]);
    expect(sorted.map((candidate) => candidate.id)).toEqual([
      "z-failed",
      "b-paused",
      "c-ready",
      "a-active",
    ]);
  });

  it("exposes post-training stage, progress, ETA, and a safe review action", () => {
    const candidate = job({
      id: "post-train",
      progressPfDays: 100,
      postTrain: "sft",
      postTrainProgress: 4,
      postTrainTarget: 10,
    });
    const model = buildTrainingJobViewModel(candidate, {
      resource: readyResources,
    });

    expect(model.stage).toBe("sft");
    expect(model.stageLabel).toBe("SFT");
    expect(model.stageProgress).toBeCloseTo(0.4);
    expect(model.etaDays).toBeCloseTo(3);
    expect(model.etaLabel).toBe("~3d");
    expect(model.primaryAction).toMatchObject({
      kind: "open-run",
      label: "Review run",
    });
  });

  it("shows the paced base-training ETA for trillion-scale jobs", () => {
    const candidate = job({
      id: "trillion-paced",
      targetParamsB: 1_000,
      progressPfDays: 20,
      minCalendarDays: 100,
    });
    const model = buildTrainingJobViewModel(candidate, {
      resource: readyResources,
    });

    expect(model.stage).toBe("base");
    expect(model.etaDays).toBeCloseTo(80);
    expect(model.etaLabel).toBe("~80d");
  });

  it("only exposes recovery when the existing post-training recovery gate is valid", () => {
    const failed = job({
      id: "failed-post-train",
      failed: true,
      failureStage: "sft",
      failureRecoveryCheckpointId: "checkpoint-safe",
    });
    const model = buildTrainingJobViewModel(failed);

    expect(model.primaryAction).toEqual({
      kind: "recover",
      label: "Recover",
      jobId: "failed-post-train",
      checkpointId: "checkpoint-safe",
    });
    expect(model.statusTone).toBe("danger");
    expect(model.etaLabel).toBe("Failed");
  });

  it("keeps campaign decisions navigational and exposes paused runs as resumable", () => {
    const decision = job({
      id: "decision",
      pendingCampaignEvent: {
        id: "event-1",
        kind: "data_anomaly",
        title: "Data discovery",
        description: "A new source changes the run profile.",
        signal: "source",
        day: 12,
        milestone: 0.2,
        decisionDeadlineDay: 16,
        severity: "warning",
        choices: [],
      } as NonNullable<TrainingJob["pendingCampaignEvent"]>,
    });
    const paused = buildTrainingJobViewModel(
      job({ id: "paused", paused: true }),
    );
    const decisionModel = buildTrainingJobViewModel(decision);

    expect(decisionModel).toMatchObject({
      issueLabel: "Decision: Data discovery",
      issueTone: "warning",
      primaryAction: { kind: "open-run", label: "Resolve decision" },
      etaLabel: "Decision due",
    });
    expect(paused.primaryAction).toEqual({
      kind: "resume",
      label: "Resume",
      jobId: "paused",
    });
  });

  it("keeps the mounted activity surface empty but present without jobs", () => {
    const state = createGame({ seed: 102, difficulty: "easy" }) as SimState;
    const activity = buildTrainingActivity(state);

    expect(activity).toMatchObject({
      activeCount: 0,
      issueCount: 0,
      readyCount: 0,
      summary: "No model training runs",
    });
    expect(activity.jobs).toHaveLength(0);
  });
});
