import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingJob } from "../../../../sim/types";
import { ModelsTrainingQueue } from "./ModelsTrainingQueue";

function job(patch: Partial<TrainingJob> = {}): TrainingJob {
  return {
    id: "spark-run",
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

describe("ModelsTrainingQueue", () => {
  it("keeps the selected run and new-model action in one compact activity surface", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingQueue, {
        jobs: [job()],
        selectedJobId: "spark-run",
        activeView: "runs",
        viewCounts: { runs: 1, checkpoints: 2, fleet: 3 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
        onNewModel: vi.fn(),
      }),
    );

    expect(markup).toContain('data-model-training-queue="true"');
    expect(markup).toContain('data-job-id="spark-run"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("Training activity");
    expect(markup).toContain("+ Train model");
    expect(markup).toContain("20%");
    expect(markup).toContain('data-view="runs"');
    expect(markup).toContain('data-view="checkpoints"');
    expect(markup).toContain('data-view="fleet"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain('aria-label="Models workspace views"');
    expect(markup).toContain('aria-label="Runs, 1 runs"');
    expect(markup).toContain("Checkpoints");
    expect(markup).toContain("Fleet");
  });

  it("exposes direct recovery and resume actions without changing run selection", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingQueue, {
        jobs: [
          job({ id: "paused-run", name: "Paused", paused: true }),
          job({
            id: "failed-run",
            name: "Failed",
            failed: true,
            failureStage: "sft",
            failureRecoveryCheckpointId: "cp-1",
          }),
        ],
        selectedJobId: "paused-run",
        activeView: "runs",
        viewCounts: { runs: 2, checkpoints: 0, fleet: 0 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
        onNewModel: vi.fn(),
        onResume: vi.fn(),
        onRecover: vi.fn(),
      }),
    );

    expect(markup).toContain(">Resume</button>");
    expect(markup).toContain(">Recover</button>");
    expect(markup).toContain("Paused");
    expect(markup).toContain("Failed");
  });

  it("keeps the queue mounted when no run exists", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingQueue, {
        jobs: [],
        selectedJobId: null,
        activeView: "runs",
        viewCounts: { runs: 0, checkpoints: 2, fleet: 3 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
        onNewModel: vi.fn(),
      }),
    );

    expect(markup).toContain('data-model-training-queue="true"');
    expect(markup).toContain('data-model-training-empty="true"');
    expect(markup).toContain("No training runs");
    expect(markup).toContain("Start one with Train model above.");
    expect(markup).not.toContain("Open the new model workflow");
    expect(markup).toContain('data-models-view-nav="true"');
  });

  it("identifies checkpoint branches without hiding their independent progress", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingQueue, {
        jobs: [
          job({
            id: "cyber-child",
            name: "Aster · Cyber",
            parentCheckpointId: "cp-20",
            branchDirection: "cyber",
          }),
        ],
        selectedJobId: "cyber-child",
        activeView: "runs",
        viewCounts: { runs: 1, checkpoints: 1, fleet: 0 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
        onNewModel: vi.fn(),
      }),
    );

    expect(markup).toContain("Cyber branch · checkpoint lineage");
    expect(markup).toContain("20%");
  });
});
