import { describe, expect, it } from "vitest";
import {
  clampTrainingCampaignIntervention,
  describeCampaignIntervention,
  meetsIndependentVerificationGate,
  previewTrainingCampaignIntervention,
  withCampaignEvidencePrecision,
} from "./trainingCampaignIntervention";

describe("training campaign intervention mixer", () => {
  it("clamps illegal recipes and strips recursive bonus from ordinary incidents", () => {
    const clamped = clampTrainingCampaignIntervention("loss_spike", {
      cashCost: 99_000_000,
      extraComputeFraction: 0.9,
      progressRollbackFraction: 0.8,
      verifiedRecursiveCapabilityBonus: 1.2,
    });
    expect(clamped.cashCost).toBeLessThanOrEqual(12_000_000);
    expect(clamped.extraComputeFraction).toBeLessThanOrEqual(0.16);
    expect(clamped.progressRollbackFraction).toBeLessThanOrEqual(0.12);
    expect(clamped.verifiedRecursiveCapabilityBonus).toBeUndefined();
  });

  it("requires cash, extra compute, and staff for independent verification", () => {
    expect(
      meetsIndependentVerificationGate({
        cashCost: 1_000_000,
        extraComputeFraction: 0.12,
        minResearchers: 32,
      }),
    ).toBe(true);
    expect(
      meetsIndependentVerificationGate({
        cashCost: 1_000_000,
        extraComputeFraction: 0.04,
        minResearchers: 32,
      }),
    ).toBe(false);
  });

  it("previews funded plan and rollback before confirm", () => {
    const preview = previewTrainingCampaignIntervention(
      { targetPfDays: 100, recommendedPfDays: 100, progressPfDays: 20 },
      { extraComputeFraction: 0.04, progressRollbackFraction: 0.02, cashCost: 80_000 },
    );
    expect(preview.nextFundedPfDays).toBeCloseTo(104, 8);
    expect(preview.nextProgressPfDays).toBeCloseTo(19.6, 8);
    expect(preview.cashCost).toBe(80_000);
    expect(
      describeCampaignIntervention({
        extraComputeFraction: 0.04,
        progressRollbackFraction: 0.02,
        cashCost: 80_000,
      }),
    ).toContain("PF");
  });

  it("applies evidence precision only to funded interventions", () => {
    const unpaid = withCampaignEvidencePrecision({ reliabilityDelta: 1 }, 0.95);
    const paid = withCampaignEvidencePrecision(
      { cashCost: 50_000, reliabilityDelta: 1, stumbleRisk: 0 },
      0.95,
    );
    expect(unpaid.reliabilityDelta).toBe(1);
    expect(paid.reliabilityDelta).toBeGreaterThan(1);
    expect(paid.stumbleRisk ?? 0).toBeLessThan(0);
  });
});
