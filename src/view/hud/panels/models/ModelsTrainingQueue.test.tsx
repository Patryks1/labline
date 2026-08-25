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
  it("keeps the selected run on a compact activity rail without a second train action", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingQueue, {
        jobs: [job()],
        selectedJobId: "spark-run",
        activeView: "runs",
        viewCounts: { runs: 1, checkpoints: 2, labs: 3, routers: 0, fleet: 3 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-model-training-queue="true"');
    expect(markup).toContain('data-job-id="spark-run"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("Campaign");
    expect(markup).not.toContain("+ Train model");
    expect(markup).not.toContain("Train model");
    expect(markup).toContain("20%");
    expect(markup).toContain('data-view="runs"');
    expect(markup).toContain('data-view="checkpoints"');
    expect(markup).toContain('data-view="labs"');
    expect(markup).toContain('data-view="routers"');
    expect(markup).toContain('data-view="fleet"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Models workspace tabs"');
    expect(markup).toContain('aria-label="Runs, 1 in flight"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Checkpoints");
    expect(markup).toContain("Gyms");
    expect(markup).not.toContain("Catalogs");
    expect(markup).toContain("Runs");
    expect(markup).toContain("Routers");
    expect(markup).toContain("Fleet");
    expect(markup).toContain("0.00 PF/d");
  });

  it("keeps ten concurrent runs on a scannable list", () => {
    const jobs = Array.from({ length: 10 }, (_, index) =>
      job({
        id: `run-${index}`,
        name: `Run ${index + 1}`,
        targetParamsB: index + 1,
        progressPfDays: 10 * (index + 1),
      }),
    );
    const markup = renderToStaticMarkup(
      createElement(ModelsTrainingQueue, {
        jobs,
        selectedJobId: "run-3",
        activeView: "runs",
        viewCounts: { runs: 10, checkpoints: 0, labs: 0, routers: 0, fleet: 0 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-run-count="10"');
    expect(markup).toContain('aria-label="Runs, 10 in flight"');
    expect(markup).toContain("Run 10");
    expect(markup).toContain("1.00B");
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
        viewCounts: { runs: 2, checkpoints: 0, labs: 3, routers: 0, fleet: 0 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
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
        viewCounts: { runs: 0, checkpoints: 2, labs: 3, routers: 0, fleet: 3 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-model-training-queue="true"');
    expect(markup).toContain('data-model-training-empty="true"');
    expect(markup).toContain("No runs");
    expect(markup).not.toContain("Start one with Train model above.");
    expect(markup).not.toContain("Train model");
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
        viewCounts: { runs: 1, checkpoints: 1, labs: 3, routers: 0, fleet: 0 },
        onSelect: vi.fn(),
        onViewChange: vi.fn(),
      }),
    );

    expect(markup).toContain("Cyber branch · checkpoint lineage");
    expect(markup).toContain("20%");
  });
});
