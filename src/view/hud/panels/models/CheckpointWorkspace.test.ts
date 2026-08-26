import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingJob } from "../../../../sim/types";
import { CheckpointWorkspace } from "./CheckpointWorkspace";
import type { CheckpointUiRecord } from "./checkpointUi";

function checkpoint(): CheckpointUiRecord {
  return {
    id: "cp-manual-code",
    sourceJobId: "job-1",
    label: "Aster · code branch",
    day: 38,
    milestone: 0.41,
    progress: 0.41,
    stage: "base",
    kind: "manual",
    branchDirection: "code",
    visibility: "internal",
    status: "promoted",
    confidence: 0.78,
    evaluationScore: {
      label: "Coding",
      estimate: 64.8,
      low: 60.2,
      high: 69.1,
    },
    reportCount: 1,
    pendingEvaluations: [],
    evidenceReports: [],
    retainedModel: {
      id: "model-code",
      name: "Aster Code v2",
      status: "internal",
    },
    actions: {
      benchmark: { enabled: true },
      review: { enabled: true },
      promote: { enabled: false },
      discard: { enabled: false },
      fork: { enabled: true },
      rollback: { enabled: true },
    },
  };
}

describe("CheckpointWorkspace", () => {
  it("surfaces manual creation, run graph markers, branching, rollback and released model status", () => {
    const job = {
      id: "job-1",
      name: "Aster",
      progressPfDays: 41,
      targetPfDays: 100,
    } as TrainingJob;
    const markup = renderToStaticMarkup(
      createElement(CheckpointWorkspace, {
        entries: [{ sourceJobId: job.id, checkpoint: checkpoint() }],
        jobs: [job],
        onCreateManual: vi.fn(),
        onBranch: vi.fn(),
        onRollback: vi.fn(),
      }),
    );

    expect(markup).toContain("Save the current weights without stopping the run");
    expect(markup).toContain("Save current weights");
    expect(markup).toContain("Aster · 41%");
    expect(markup).toContain("Run histories");
    expect(markup).toContain("1 checkpoint");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Checkpoint history"');
    expect(markup).toContain("manual · code");
    expect(markup).toContain(
      'aria-label="Branch a new model from Aster · code branch"',
    );
    expect(markup).toContain("Branch new model");
    expect(markup).toContain(
      'aria-label="Restart source here Aster · code branch"',
    );
    expect(markup).toContain("Aster Code v2");
    expect(markup).toContain("internal · model-code");
    expect(markup).toContain("min-h-11 w-full");
    expect(markup).toContain('class="hud-select mt-1 min-h-11 w-full');
    expect(markup).toContain('class="hud-input mt-1 min-h-11 w-full');
    expect(markup).toContain("grid grid-cols-2 gap-2");
    expect(markup).toContain('data-manual-checkpoint-disclosure="true"');
    expect(markup).toContain('data-mobile-scroll="horizontal"');
    expect(markup).not.toMatch(/<details[^>]*data-manual-checkpoint-disclosure="true"[^>]*\sopen/);
  });

  it("keeps archived checkpoints actionable when no run is active", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointWorkspace, {
        entries: [{ sourceJobId: "finished-job", checkpoint: checkpoint() }],
        jobs: [],
        onBranch: vi.fn(),
      }),
    );
    expect(markup).toContain("Start or continue a training run");
    expect(markup).toContain("Aster · checkpoints");
    expect(markup).toContain(
      'aria-label="Branch a new model from Aster · code branch"',
    );
  });
});
