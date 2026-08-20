import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrainingCampaignEvent, TrainingJob } from "../../../../sim/types";
import { CampaignDecisionModal } from "./CampaignDecisionModal";

function event(): TrainingCampaignEvent {
  return {
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
    choices: [
      {
        id: "stabilize-recipe",
        label: "Lower the learning rate",
        description: "Cool the schedule.",
        recommended: true,
        effects: { extraComputeFraction: 0.04 },
      },
      {
        id: "diagnostic-sweep",
        label: "Run a diagnostic sweep",
        description: "Spend cash on proxies.",
        effects: { cashCost: 80_000 },
      },
      {
        id: "push-through",
        label: "Push through the spike",
        description: "Keep the schedule.",
        effects: { stumbleRisk: 0.07 },
      },
      {
        id: "rollback-optimizer",
        label: "Roll back the optimizer",
        description: "Replay from a snapshot.",
        effects: { progressRollbackFraction: 0.03 },
      },
      {
        id: "pause-and-staff",
        label: "Pause and staff up",
        description: "Raise the floor.",
        effects: { minResearchers: 10 },
      },
    ],
  };
}

describe("CampaignDecisionModal", () => {
  it("shows four options and hides extra tactics", () => {
    const markup = renderToStaticMarkup(
      createElement(CampaignDecisionModal, {
        open: true,
        job: { id: "run-1", name: "Aster", daysElapsed: 18 } as TrainingJob,
        event: event(),
        cash: 1_000_000,
        researcherCount: 20,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(markup).toContain('data-campaign-decision-modal="true"');
    expect(markup).toContain("Lower the learning rate");
    expect(markup).toContain("Run a diagnostic sweep");
    expect(markup).toContain("Push through the spike");
    expect(markup).toContain("Roll back the optimizer");
    expect(markup).not.toContain("Pause and staff up");
    expect(markup).toContain("Safe default (AFK)");
    expect(markup).not.toContain("recommended");
    expect(markup).not.toContain("Commitment preview");
  });
});
