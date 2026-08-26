import { createElement, type ComponentProps } from "react";
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

function markup(
  job: TrainingJob,
  extras: Partial<
    Pick<ComponentProps<typeof ActiveTrainingCard>, "onSetLabs" | "gyms">
  > = {},
): string {
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
      onBranchCheckpoint: vi.fn(),
      onRecoverFromCheckpoint: vi.fn(),
      onSelectPostTrain: vi.fn(),
      ...extras,
    }),
  );
}

describe("ActiveTrainingCard campaign mixer", () => {
  it("hands incidents to the global decision modal instead of an inline mixer", () => {
    const rendered = markup(
      trainingJob({
        pendingCampaignEvent: {
          id: "evt-1",
          kind: "loss_spike",
          title: "Loss spike at scale",
          description: "The observed loss moved outside the band.",
          signal: "loss 3.4",
          day: 18,
          milestone: 0.12,
          decisionDeadlineDay: 23,
          severity: "warning",
          evidenceAccuracy: 0.4,
          choices: [],
        },
      }),
    );
    expect(rendered).toContain("Incident paused this run");
    expect(rendered).toContain("Loss spike at scale");
    expect(rendered).toContain(">Open decision</button>");
    expect(rendered).not.toContain('data-campaign-mixer="true"');
    expect(rendered).not.toContain("Keep the campaign moving");
  });
});

describe("ActiveTrainingCard direct checkpoint actions", () => {
  it("shows Benchmark, checkpoint save, and branch actions on progressed active weights", () => {
    const rendered = markup(trainingJob());
    expect(rendered).toContain('data-campaign-spine="true"');
    expect(rendered).toContain(">Benchmark</button>");
    expect(rendered).toContain(">Save snapshot</button>");
    expect(rendered).toContain(">Branch model</button>");
    expect(rendered).toContain("Capture these exact weights");
    expect(rendered).not.toContain('class="live-glow');
    expect(rendered).not.toContain(" live-glow ");
  });

  it("disables checkpoint actions until the run has produced weights", () => {
    const rendered = markup(trainingJob({ progressPfDays: 0 }));
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Benchmark<\/button>/);
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Save snapshot<\/button>/);
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Branch model<\/button>/);
    expect(rendered).toContain("Allocate compute before saving a checkpoint.");
  });

  it("labels funded continuation as optimizing and priority-zero completion as idle", () => {
    const optimizing = markup(trainingJob({ progressPfDays: 123 }));
    const idle = markup(
      trainingJob({ progressPfDays: 123, computePriority: 0 }),
    );
    expect(optimizing).toContain("Optimizing · 1.23× funded");
    expect(optimizing).toContain("123.00 / 100.00 PF funded");
    expect(idle).toContain("Target complete · idle");
    expect(idle).not.toContain("Optimizing · 1.23× funded");
  });

  it("keeps very long optimization runs readable once maturity saturates", () => {
    const rendered = markup(trainingJob({ progressPfDays: 12_300 }));
    expect(rendered).toContain(
      "Optimizing · 12.30K PF invested · maturity saturated",
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
    expect(rendered).toContain('data-mobile-actions="sticky-grid"');
    expect(rendered).toContain("xl:static");
    expect(rendered).not.toContain("lg:static");
    expect(rendered).not.toContain("sm:static");
    expect(rendered).toContain("min-[560px]:grid-cols-3");
    expect(rendered).toContain("[&amp;_.hud-button]:!min-h-11");
    expect(rendered).toContain("Frozen corpus evidence");
    expect(rendered).toContain("<details");
    expect(rendered).toContain("Dense transformer frontier");
    expect(rendered).toContain('data-run-telemetry-disclosure="true"');
    expect(rendered).toContain('data-shell-gesture-ignore="true"');
  });

  it("keeps every advanced section closed on a fully instrumented completed run", () => {
    const rendered = markup(
      trainingJob({
        progressPfDays: 120,
        computePriority: 0,
        economics: {
          setupCost: 1_000,
          dataCost: 2_000,
          trainingCostAccrued: 3_000,
        },
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
        productProfile: {
          lifecycle: "foundation",
          focus: {
            coding: 0,
            science: 0,
            research: 0,
            personality: 0,
            chat: 0,
          },
          personality: 0,
          tokenEfficiency: 1,
          effortRecipes: [
            {
              id: "instant",
              name: "Instant",
              kind: "instant",
              thinkingTokenMult: 1,
              trainPfDays: 0,
              trainCash: 0,
              trained: true,
              quality: 1,
              served: true,
            },
          ],
          defaultEffortId: "instant",
        },
      }),
      { onSetLabs: vi.fn(), gyms: [] },
    );

    expect(rendered).toContain('data-run-gyms-disclosure="true"');
    expect(rendered).toContain('data-run-telemetry-disclosure="true"');
    expect(rendered).toContain('data-specialize-disclosure="true"');
    expect(rendered).toContain('data-effort-studio="true"');
    expect(rendered).toContain("min-[560px]:grid-cols-3");
    expect(rendered).toContain("[&amp;_.hud-button]:!min-h-11");
    expect(rendered).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
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
    expect(rendered).not.toContain(">Save snapshot</button>");
  });

  it("marks run cancellation as destructive before the confirmation click", () => {
    const active = markup(trainingJob());
    expect(active).toMatch(
      /data-hud-variant="danger"[^>]*>Cancel<\/button>/,
    );

    const completed = markup(
      trainingJob({ progressPfDays: 120, computePriority: 0 }),
    );
    expect(completed).toMatch(
      /data-hud-variant="danger"[^>]*>Delete run<\/button>/,
    );
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
        onBranchCheckpoint: vi.fn(),
        onRecoverFromCheckpoint: vi.fn(),
        onSelectPostTrain: vi.fn(),
      }),
    );
    expect(rendered).toContain("Recover from RLHF safe point");
    expect(rendered).toContain("18.00% · high");
    expect(rendered).toContain("Refund");
    expect(rendered).toContain("thin relevant dataset");
  });
});
