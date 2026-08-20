import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingCheckpointCandidate } from "../../../../sim/types";
import { CheckpointEvaluationDialog } from "./CheckpointEvaluationDialog";

function imageCandidate(): TrainingCheckpointCandidate {
  return {
    id: "image-checkpoint",
    sourceJobId: "image-job",
    lineageId: "image-lineage",
    ordinal: 1,
    milestone: 0.12,
    capturedDay: 30,
    stage: "base",
    status: "stealth",
    model: {
      id: "hidden-image-model",
      name: "Canvas · C12",
      family: "diffusion",
      productPreset: "image_generation",
      modalities: ["image"],
      io: { inputs: { text: 50 }, outputs: { image: 50 }, tools: 0 },
    },
    telemetry: {
      progressPfDays: 12,
      targetPfDays: 100,
      progress: 0.12,
      daysElapsed: 8,
      stage: "base",
      stageProgress: 0.12,
      loss: 2.4,
      energyMWh: 18,
    },
  } as unknown as TrainingCheckpointCandidate;
}

describe("CheckpointEvaluationDialog", () => {
  it("renders an accessible modality-tailored quote with panel and budget tradeoffs", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointEvaluationDialog, {
        open: true,
        candidate: imageCandidate(),
        cash: 1_000_000,
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Image generation");
    expect(markup).not.toContain("Language &amp; reasoning");
    expect(markup).toContain("Internal red team");
    expect(markup).toContain("NDA external");
    expect(markup).toContain("Partner pilot");
    expect(markup).toContain("$50.00K/suite");
    expect(markup).toContain("$100.00K/suite");
    expect(markup).toContain("$150.00K/suite");
    expect(markup).toContain("Accuracy");
    expect(markup).toContain("Confidence");
    expect(markup).toContain("No external leak surface");
    expect(markup).toContain("hud-button--ghost");
  });

  it("disables scheduling when the quoted study is unaffordable", () => {
    const markup = renderToStaticMarkup(
      createElement(CheckpointEvaluationDialog, {
        open: true,
        candidate: imageCandidate(),
        cash: 1,
        initialMode: "partner_pilot",
        onClose: vi.fn(),
        onSubmit: vi.fn(),
      }),
    );

    expect(markup).toContain("Insufficient cash");
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*>Schedule evaluation<\/button>/,
    );
  });
});
