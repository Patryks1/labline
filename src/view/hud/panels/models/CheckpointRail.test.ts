import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingCheckpointCandidate } from "../../../../sim/types";
import { CheckpointRail } from "./CheckpointRail";
import {
  checkpointRivalDelta,
  checkpointUiRecordFromCandidate,
  confidenceLabel,
  formatBenchmarkInterval,
  type CheckpointUiRecord,
} from "./checkpointUi";

function checkpoint(
  over: Partial<CheckpointUiRecord> = {},
): CheckpointUiRecord {
  return {
    id: "cp-20",
    sourceJobId: "job-aster",
    label: "Aster · 20%",
    day: 42,
    milestone: 0.2,
    progress: 0.2,
    stage: "base",
    kind: "milestone",
    visibility: "stealth",
    status: "reviewed",
    confidence: 0.76,
    evaluationScore: {
      label: "Scientific reasoning",
      estimate: 61.4,
      low: 57.2,
      high: 65.1,
    },
    reportCount: 1,
    pendingEvaluations: [],
    evidenceReports: [],
    benchmark: {
      suiteLabel: "Language & reasoning",
      metricLabel: "Scientific reasoning",
      score: 63.2,
      low: 59.8,
      high: 66.6,
      confidence: 0.86,
      accuracy: 0.82,
      rivalBest: 60,
      rivalName: "Northstar",
    },
    review: {
      status: "complete",
      mode: "nda_external",
      verdict: "advance",
      headline: "Promising, with one launch blocker",
      summary: "Independent reviewers reproduced the coding gain.",
      strengths: ["Stable code lift", "Clean holdout"],
      risks: ["Weak long context"],
      leakRisk: 0.27,
    },
    actions: {
      benchmark: { enabled: true },
      review: { enabled: true, label: "External review" },
      promote: { enabled: true },
      discard: { enabled: true },
      fork: { enabled: true },
      rollback: { enabled: true },
    },
    ...over,
  };
}

describe("CheckpointRail", () => {
  it("renders stealth economics, uncertainty, rival comparison and review risk", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointRail, {
        checkpoints: [checkpoint()],
        onSelect: vi.fn(),
        onBenchmark: vi.fn(),
        onReview: vi.fn(),
        onPromote: vi.fn(),
        onDiscard: vi.fn(),
        onBranch: vi.fn(),
      }),
    );

    expect(markup).toContain("Checkpoint history");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(
      "A checkpoint is a saved copy of one run at a specific moment.",
    );
    expect(markup).toContain(
      "generates no demand, customers, market share, or revenue",
    );
    expect(markup).toContain("63.2 · 59.8–66.6");
    expect(markup).toContain("+3.2 vs Northstar");
    expect(markup).toContain("Estimated leak risk 27%");
    expect(markup).toContain("NDA external panel");
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="76"');
    expect(markup).toContain('aria-label="Benchmark Aster · 20%"');
    expect(markup).toContain('aria-label="Review Aster · 20%"');
    expect(markup).toContain('aria-label="Promote Aster · 20%"');
    expect(markup).toContain('aria-label="Discard Aster · 20%"');
    expect(markup).toContain(
      'aria-label="Branch a new model from Aster · 20%"',
    );
    expect(markup).toContain("Branch new model");
    expect(markup).toContain("source run keeps");
    expect(markup).toContain('data-hud-variant="danger"');
    expect(markup).toContain('aria-label="Checkpoint history"');
    expect(markup).not.toContain("Training run checkpoint graph");
  });

  it("selects the requested checkpoint and exposes disabled action reasons", () => {
    const first = checkpoint({ id: "cp-10", label: "Aster · 10%", day: 38 });
    const second = checkpoint({
      id: "cp-40",
      label: "Aster · 40%",
      day: 49,
      actions: {
        benchmark: { enabled: false, reason: "Evaluation already queued." },
        review: { enabled: false, reason: "Benchmark evidence required." },
        promote: { enabled: false, reason: "Review is incomplete." },
        discard: { enabled: true },
        fork: { enabled: true },
        rollback: { enabled: false, reason: "Source run completed." },
      },
    });
    const markup = renderToStaticMarkup(
      createElement(CheckpointRail, {
        checkpoints: [first, second],
        selectedId: second.id,
      }),
    );

    expect(markup).toContain("Select Aster · 10%, Reviewed");
    expect(markup).toContain("Select Aster · 40%, Reviewed");
    expect(markup).toContain('title="Evaluation already queued."');
    expect(markup).toContain('title="Benchmark evidence required."');
    expect(markup).toContain('title="Review is incomplete."');
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Promote Aster · 40%"/,
    );
  });

  it("renders a useful empty state", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointRail, { checkpoints: [] }),
    );
    expect(markup).toContain("No retained checkpoints");
    expect(markup).toContain("reusable checkpoint is saved");
  });

  it("labels the evaluation score unknown until a report exists", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointRail, {
        checkpoints: [
          checkpoint({
            evaluationScore: {},
            reportCount: 0,
            pendingEvaluations: [],
            confidence: 0,
            benchmark: undefined,
            review: undefined,
          }),
        ],
      }),
    );

    expect(markup).toContain("Unknown");
    expect(markup).toContain("private eval required");
    expect(markup).toContain("Not measured");
    expect(markup).toContain("Run a private benchmark");
  });

  it("shows concurrent studies without disabling another benchmark or review", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointRail, {
        checkpoints: [
          checkpoint({
            pendingEvaluations: [
              {
                id: "eval-internal",
                mode: "internal",
                readyDay: 51,
                totalCost: 125_000,
                accuracy: 0.72,
                confidence: 0.78,
                leakRisk: 0,
              },
              {
                id: "eval-pilot",
                mode: "partner_pilot",
                readyDay: 63,
                totalCost: 390_000,
                accuracy: 0.9,
                confidence: 0.94,
                leakRisk: 0.07,
              },
            ],
          }),
        ],
        onBenchmark: vi.fn(),
        onReview: vi.fn(),
      }),
    );

    expect(markup).toContain("2 concurrent evaluations");
    expect(markup).toContain("due D51");
    expect(markup).toContain("due D63");
    expect(markup).toMatch(
      /<button(?![^>]*disabled)[^>]*aria-label="Benchmark Aster · 20%"/,
    );
    expect(markup).toMatch(
      /<button(?![^>]*disabled)[^>]*aria-label="Review Aster · 20%"/,
    );
  });

  it("renders the persisted report ledger with metrics and blind reviewer calibration", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointRail, {
        checkpoints: [
          checkpoint({
            evidenceReports: [
              {
                id: "eval-1",
                day: 46,
                mode: "nda_external",
                totalCost: 295_000,
                accuracy: 0.79,
                confidence: 0.85,
                leakRisk: 0.033,
                contaminationRisk: 0.07,
                leakOutcome: "none",
                flags: ["Holdout overlap signal"],
                suites: [
                  {
                    id: "language",
                    label: "Language & reasoning",
                    accuracy: 0.79,
                    confidence: 0.85,
                    metrics: [
                      {
                        id: "science",
                        label: "Science",
                        score: 63.2,
                        low: 59.8,
                        high: 66.6,
                        contaminationSignal: 0.08,
                        rival: {
                          name: "Northstar",
                          score: 60,
                          delta: 3.2,
                          rank: 1,
                          fieldSize: 5,
                        },
                      },
                    ],
                  },
                ],
                reviews: [
                  {
                    id: "reviewer-1",
                    panel: "external",
                    focus: "science_reasoning",
                    score: 62.7,
                    confidence: 0.81,
                    calibration: -1.2,
                    verdict: "promising",
                    strengths: ["Stable reasoning"],
                    concerns: ["Thin legal coverage"],
                  },
                ],
              },
            ],
          }),
        ],
      }),
    );

    expect(markup).toContain("Evidence ledger · 1 report · consensus");
    expect(markup).toContain("Day 46 · NDA external panel");
    expect(markup).toContain("+3.2 vs Northstar · rank 1/5");
    expect(markup).toContain("reviewer calibration -1.2");
    expect(markup).toContain("Holdout overlap signal");
  });
});

describe("checkpoint UI math", () => {
  it("formats confidence, intervals and rival deltas deterministically", () => {
    expect(confidenceLabel(0.83)).toBe("High confidence");
    expect(confidenceLabel(0.6)).toBe("Moderate confidence");
    expect(confidenceLabel(0.2)).toBe("Low confidence");
    expect(
      formatBenchmarkInterval({ score: 61.25, low: 58.1, high: 64.4 }),
    ).toBe("61.3 · 58.1–64.4");
    expect(checkpointRivalDelta({ score: 61.25, rivalBest: 60 })).toBeCloseTo(
      1.25,
    );
    expect(checkpointRivalDelta({ score: 61.25 })).toBeNull();
  });

  it("uses an accuracy-confidence weighted consensus and never latent model scores", () => {
    const report = (
      id: string,
      day: number,
      score: number,
      low: number,
      high: number,
      accuracy: number,
      confidence: number,
      rivalDelta: number,
    ) => ({
      id,
      modelId: "secret-model",
      modelName: "Aster · C32",
      scheduledDay: day - 2,
      completedDay: day,
      request: {
        suiteIds: ["language" as const],
        budgetTier: "standard" as const,
        mode: "internal" as const,
      },
      quote: {
        suiteIds: ["language" as const],
        budgetTier: "standard" as const,
        mode: "internal" as const,
        spendPerSuite: 100_000,
        suiteCost: 100_000,
        panelCost: 57_000,
        totalCost: 157_000,
        durationDays: 4,
        reviewerCount: 4,
        accuracy,
        confidence,
        leakRisk: 0,
        contaminationRisk: 0.05,
      },
      overallScore: score,
      confidence,
      contaminationRisk: 0.05,
      leakRisk: 0,
      leakOutcome: "none" as const,
      flags: [],
      suites: [
        {
          suiteId: "language" as const,
          label: "Language & reasoning",
          score,
          low,
          high,
          accuracy,
          confidence,
          metrics: [
            {
              metricId: "science" as const,
              label: "Science",
              score,
              low,
              high,
              contaminationSignal: 0.04,
              rival: {
                modelId: "rival",
                modelName: "Northstar",
                score: score - rivalDelta,
                delta: rivalDelta,
                rank: 1,
                fieldSize: 4,
              },
            },
          ],
        },
      ],
      reviews: [],
    });
    const candidate = {
      id: "checkpoint",
      sourceJobId: "job",
      lineageId: "lineage",
      ordinal: 2,
      milestone: 0.32,
      capturedDay: 40,
      stage: "base",
      status: "stealth",
      model: {
        id: "secret-model",
        name: "Aster · C32",
        capability: 99.9,
        benchmarkSuites: { language: { science: 98.8 } },
      },
      telemetry: {
        progressPfDays: 32,
        targetPfDays: 100,
        progress: 0.32,
        daysElapsed: 20,
        stage: "base",
        stageProgress: 0.32,
        loss: 1.8,
        energyMWh: 12,
      },
      evaluations: [
        report("report-low", 43, 40, 34, 46, 0.5, 0.6, -4),
        report("report-high", 49, 80, 76, 84, 0.9, 0.9, 2),
      ],
    } as unknown as TrainingCheckpointCandidate;

    const adapted = checkpointUiRecordFromCandidate(candidate);
    const expected = (40 * 0.3 + 80 * 0.81) / 1.11;
    expect(adapted.evaluationScore.estimate).toBeCloseTo(expected, 5);
    expect(adapted.evaluationScore.estimate).not.toBe(99.9);
    expect(adapted.reportCount).toBe(2);
    expect(adapted.review?.headline).toBe("2 reports · weighted consensus");
    expect(adapted.benchmark?.rivalDelta).toBe(2);
  });
});
