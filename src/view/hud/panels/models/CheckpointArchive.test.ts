import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckpointArchive } from "./CheckpointArchive";
import type { CheckpointUiRecord } from "./checkpointUi";

function record(id: string): CheckpointUiRecord {
  return {
    id,
    sourceJobId: "finished-job",
    label: "Aster · C58",
    day: 52,
    milestone: 0.58,
    progress: 0.58,
    stage: "base",
    kind: "milestone",
    visibility: "stealth",
    status: "reviewed",
    confidence: 0.82,
    evaluationScore: {
      label: "Science",
      estimate: 64.2,
      low: 60.1,
      high: 68.3,
    },
    reportCount: 1,
    pendingEvaluations: [],
    evidenceReports: [],
    actions: {
      benchmark: { enabled: true },
      review: { enabled: true },
      promote: { enabled: true },
      discard: { enabled: true },
      fork: { enabled: true },
      rollback: { enabled: false },
    },
  };
}

describe("CheckpointArchive", () => {
  it("renders a stealth candidate when there are no active source jobs", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointArchive, {
        entries: [{ sourceJobId: "finished-job", checkpoint: record("cp-58") }],
        activeJobIds: [],
      }),
    );

    expect(markup).toContain("Checkpoint archive");
    expect(markup).toContain("Aster · C58");
    expect(markup).toContain('aria-label="Promote Aster · C58"');
  });

  it("does not duplicate candidates whose source job still owns a rail", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointArchive, {
        entries: [{ sourceJobId: "live-job", checkpoint: record("cp-58") }],
        activeJobIds: ["live-job"],
      }),
    );
    expect(markup).toBe("");
  });
});
