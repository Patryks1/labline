import { describe, expect, it } from "vitest";
import { denseTrainingPfDays } from "./training";
import { generalCapabilityHardMax } from "./capabilityCeilings";
import { buildScaledModel } from "./modelBuild";
import { launchReferenceApiCostPerMTok, API_UNIT_COST_FLOOR } from "./unitEconomics";
import { rollTrainingOutcome } from "./trainingV3";

describe("economy invariants", () => {
  it("keeps training work non-negative and size-capped", () => {
    expect(denseTrainingPfDays(7, 42_000)).toBeGreaterThan(0);
    expect(denseTrainingPfDays(0, 0)).toBe(0);
    const tiny = buildScaledModel({
      id: "inv-70m",
      name: "inv-70m",
      paramsB: 0.07,
      family: "dense",
      day: 1,
      dataCoverage: 100,
      dataQuality: 100,
      postTrain: "none",
    });
    expect(tiny.capability).toBeLessThanOrEqual(generalCapabilityHardMax(0.07));
    expect(tiny.capability).toBeLessThan(40);
  });

  it("keeps public API floors at or above serving cost", () => {
    const model = buildScaledModel({
      id: "inv-api",
      name: "inv-api",
      paramsB: 7,
      family: "dense",
      day: 1,
      dataCoverage: 6,
      dataQuality: 80,
      postTrain: "none",
    });
    const floor = launchReferenceApiCostPerMTok(model);
    expect(floor).toBeGreaterThanOrEqual(API_UNIT_COST_FLOOR);
    expect((model.apiPricePerMTok ?? floor) + 1e-9).toBeGreaterThanOrEqual(floor * 0.5);
  });

  it("is deterministic for a frozen training seed", () => {
    const a = rollTrainingOutcome({
      seed: 99,
      quality: 70,
      verifyShare: 0.2,
      engineers: 4,
      researchCount: 5,
      day: 10,
    });
    const b = rollTrainingOutcome({
      seed: 99,
      quality: 70,
      verifyShare: 0.2,
      engineers: 4,
      researchCount: 5,
      day: 10,
    });
    expect(a).toEqual(b);
  });
});
