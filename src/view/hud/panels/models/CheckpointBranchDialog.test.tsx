import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingCheckpointCandidate } from "../../../../sim/types";
import { CheckpointBranchDialog } from "./CheckpointBranchDialog";

function candidate(): TrainingCheckpointCandidate {
  return {
    id: "cp-aster-32",
    sourceJobId: "job-aster",
    lineageId: "lineage-aster",
    ordinal: 2,
    kind: "milestone",
    branchDirection: "general",
    milestone: 0.32,
    capturedDay: 18,
    stage: "base",
    status: "stealth",
    model: {
      id: "checkpoint-model-aster",
      name: "Aster · C32",
      paramsB: 7,
    } as TrainingCheckpointCandidate["model"],
    telemetry: {
      progressPfDays: 32,
      targetPfDays: 100,
      progress: 0.32,
      daysElapsed: 17,
      stage: "base",
      stageProgress: 0.32,
      loss: 3.4,
      energyMWh: 120,
    },
  };
}

describe("CheckpointBranchDialog", () => {
  it("explains the split and exposes distinct model specialisations", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointBranchDialog, {
        open: true,
        checkpoint: candidate(),
        sourceRunName: "Aster",
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Train a new model from these weights");
    expect(markup).toContain("source run keeps training");
    expect(markup).toContain("Aster at 32%");
    expect(markup).toContain("Aster · Branch");
    expect(markup).toContain("Code");
    expect(markup).toContain("Cyber");
    expect(markup).toContain("Reasoning");
    expect(markup).toContain("Start branch");
    expect(markup).toContain('data-checkpoint-branch-workflow="true"');
    expect(markup).not.toContain(">×<");
  });

  it("renders nothing while closed", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointBranchDialog, {
        open: false,
        checkpoint: candidate(),
        sourceRunName: "Aster",
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(markup).toBe("");
  });
});
