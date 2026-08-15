import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingJob } from "../../../../sim/types";
import { ActiveTrainingCard } from "./ActiveTrainingCard";

function trainingJob(patch: Partial<TrainingJob> = {}): TrainingJob {
  return {
    id: "run-card-job",
    name: "Aster",
    family: "dense",
    targetParamsB: 1,
    targetPfDays: 100,
    recommendedPfDays: 100,
    progressPfDays: 42,
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
    computePriority: 50,
    ...patch,
  };
}

function markup(job: TrainingJob): string {
  return renderToStaticMarkup(
    createElement(ActiveTrainingCard, {
      job,
      jobs: [job],
      trainingPoolPf: 10,
      unlocked: [],
      day: 20,
      cash: 10_000_000,
      onPriority: vi.fn(),
      onPause: vi.fn(),
      onCancel: vi.fn(),
      onRelease: vi.fn(),
      onKeepInternal: vi.fn(),
      onBenchmark: vi.fn(),
      onSaveCheckpoint: vi.fn(),
      onRecoverFromCheckpoint: vi.fn(),
      onSelectPostTrain: vi.fn(),
    }),
  );
}

describe("ActiveTrainingCard direct checkpoint actions", () => {
  it("shows Benchmark and Save checkpoint on progressed active weights", () => {
    const rendered = markup(trainingJob());
    expect(rendered).toContain(">Benchmark</button>");
    expect(rendered).toContain(">Save checkpoint</button>");
    expect(rendered).toContain("Capture these exact weights");
  });

  it("disables both actions until the run has produced weights", () => {
    const rendered = markup(trainingJob({ progressPfDays: 0 }));
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Benchmark<\/button>/);
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Save checkpoint<\/button>/);
    expect(rendered).toContain("Allocate compute before saving a checkpoint.");
  });

  it("labels funded continuation as optimizing and priority-zero completion as idle", () => {
    const optimizing = markup(trainingJob({ progressPfDays: 123 }));
    const idle = markup(
      trainingJob({ progressPfDays: 123, computePriority: 0 }),
    );
    expect(optimizing).toContain("Optimizing · 1.23× funded");
    expect(optimizing).toContain("123 / 100 PF funded");
    expect(idle).toContain("Target complete · idle");
    expect(idle).not.toContain("Optimizing · 1.23× funded");
  });

  it("keeps very long optimization runs readable once maturity saturates", () => {
    const rendered = markup(trainingJob({ progressPfDays: 12_300 }));
    expect(rendered).toContain(
      "Optimizing · 12.3K PF invested · maturity saturated",
    );
    expect(rendered).not.toContain("123.00× funded");
  });

  it("keeps primary run actions reachable while secondary evidence is disclosed on demand", () => {
    const rendered = markup(
      trainingJob({
        dataEvidence: {
          effectiveTrainingValue: 0.82,
          effectiveQuality: 0.79,
          effectiveDiversity: 0.76,
          effectiveFreshness: 0.71,
          humanAnchorShare: 0.9,
          contaminationRisk: 0.08,
          rightsRisk: 0.04,
          syntheticShare: 0.12,
          syntheticGenerationDepth: 0,
        },
      }),
    );

    expect(rendered).toContain("sticky bottom-0");
    expect(rendered).toContain("Frozen corpus evidence");
    expect(rendered).toContain("<details");
    expect(rendered).toContain("Dense transformer frontier");
  });

  it("keeps failed runs limited to deletion", () => {
    const rendered = markup(
      trainingJob({
        failed: true,
        failureStage: "base",
        failureDay: 20,
        failureReason: "Diverged",
      }),
    );
    expect(rendered).toContain("Delete failed run");
    expect(rendered).not.toContain(">Benchmark</button>");
    expect(rendered).not.toContain(">Save checkpoint</button>");
  });

  it("offers checkpoint recovery for a failed post-training stage", () => {
    const rendered = renderToStaticMarkup(
      createElement(ActiveTrainingCard, {
        job: trainingJob({
          failed: true,
          failureStage: "rlhf",
          failureDay: 33,
          failureReason: "Preference collapse",
          failureRecoveryCheckpointId: "cp-safe",
          failureRecord: {
            kind: "preference_collapse",
            stage: "rlhf",
            day: 33,
            progressPfDays: 100,
            stageProgress: 0.61,
            probability: 0.18,
            riskBand: "high",
            factors: ["thin relevant dataset", "large-model optimization pressure"],
            recoveryCheckpointId: "cp-safe",
          },
        }),
        jobs: [],
        trainingPoolPf: 10,
        unlocked: [],
        day: 33,
        cash: 10_000_000,
        checkpointMarkers: [{
          id: "cp-safe",
          day: 30,
          progress: 1,
          loss: 3.2,
          label: "RLHF safe point",
          detail: "stealth weights",
          kind: "manual" as const,
          visibility: "stealth" as const,
        }],
        onPriority: vi.fn(),
        onPause: vi.fn(),
        onCancel: vi.fn(),
        onRelease: vi.fn(),
        onKeepInternal: vi.fn(),
        onBenchmark: vi.fn(),
        onSaveCheckpoint: vi.fn(),
        onRecoverFromCheckpoint: vi.fn(),
        onSelectPostTrain: vi.fn(),
      }),
    );
    expect(rendered).toContain("Recover from RLHF safe point");
    expect(rendered).toContain("18% · high");
    expect(rendered).toContain("Refund");
    expect(rendered).toContain("thin relevant dataset");
  });
});
