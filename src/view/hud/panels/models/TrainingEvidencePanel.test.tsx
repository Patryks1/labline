import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingJob } from "../../../../sim/types";
import { TrainingEvidencePanel } from "./TrainingEvidencePanel";
import type { CheckpointUiRecord } from "./checkpointUi";

const job = (
  patch: Partial<TrainingJob> = {},
): Pick<
  TrainingJob,
  "id" | "name" | "benchmarkSnapshots" | "pendingBenchmark"
> => ({
  id: "run-evidence",
  name: "Aster",
  benchmarkSnapshots: [],
  ...patch,
});

const checkpoint = (
  patch: Partial<CheckpointUiRecord> = {},
): CheckpointUiRecord => ({
  id: "checkpoint-evidence",
  sourceJobId: "run-evidence",
  label: "Aster · Base 42%",
  day: 42,
  milestone: 0.42,
  progress: 0.42,
  stage: "base",
  kind: "manual",
  visibility: "stealth",
  status: "reviewed",
  confidence: 0.88,
  evaluationScore: {
    label: "Capability",
    estimate: 71.4,
    low: 68.2,
    high: 74.6,
  },
  reportCount: 1,
  pendingEvaluations: [],
  evidenceReports: [],
  benchmark: {
    suiteLabel: "Language & reasoning",
    metricLabel: "Capability",
    score: 71.4,
    low: 68.2,
    high: 74.6,
    confidence: 0.88,
  },
  review: {
    status: "complete",
    mode: "internal",
    verdict: "advance",
    summary: "Completed day 44 with 88% report confidence.",
    strengths: ["Strong tool use"],
    risks: ["Thin legal evidence"],
  },
  actions: {
    benchmark: { enabled: true },
    review: { enabled: true },
    promote: { enabled: true },
    discard: { enabled: true },
    fork: { enabled: true },
    rollback: { enabled: true },
  },
  ...patch,
});

describe("TrainingEvidencePanel", () => {
  it("explains that Benchmark captures a checkpoint before review", () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingEvidencePanel, {
        job: job(),
        checkpoints: [],
      }),
    );

    expect(markup).toContain("Benchmarks &amp; reviews");
    expect(markup).toContain("Benchmark saves these exact weights first");
    expect(markup).toContain("No benchmark evidence yet");
  });

  it("shows benchmark intervals, verdicts, strengths, and risks in the active run", () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingEvidencePanel, {
        job: job(),
        checkpoints: [checkpoint()],
        onOpenCheckpointHistory: vi.fn(),
      }),
    );

    expect(markup).toContain("Aster · Base 42%");
    expect(markup).toContain("Advance");
    expect(markup).toContain("Capability 71.40");
    expect(markup).toContain("interval 68.20–74.60");
    expect(markup).toContain("Strength · Strong tool use");
    expect(markup).toContain("Risk · Thin legal evidence");
    expect(markup).toContain("Open checkpoint history");
  });

  it("keeps pending review timing and legacy run benchmark results visible", () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingEvidencePanel, {
        job: job({
          benchmarkSnapshots: [
            {
              day: 43,
              progress: 0.45,
              capability: 64.25,
              safety: 58.5,
              suite: 62.75,
              confidence: 0.9,
              accuracy: 0.85,
              capabilityLow: 61,
              capabilityHigh: 67.5,
              safetyLow: 55.4,
              safetyHigh: 61.6,
              suiteIds: ["language"],
              totalCost: 100_000,
            },
          ],
        }),
        checkpoints: [
          checkpoint({
            status: "evaluating",
            reportCount: 0,
            benchmark: undefined,
            review: {
              status: "running",
              mode: "nda_external",
              headline: "Results due day 46",
            },
            pendingEvaluations: [
              {
                id: "pending-review",
                mode: "nda_external",
                readyDay: 46,
                totalCost: 250_000,
                accuracy: 0.9,
                confidence: 0.92,
                leakRisk: 0.08,
              },
            ],
          }),
        ],
      }),
    );

    expect(markup).toContain("Latest run benchmark · D43");
    expect(markup).toContain("64.25");
    expect(markup).toContain("Review due D46");
    expect(markup).toContain("90.00% expected accuracy");
  });
});
