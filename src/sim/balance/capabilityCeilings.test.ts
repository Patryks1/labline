import { describe, expect, it } from "vitest";
import { buildScaledModel } from "./modelBuild";
import {
  generalCapabilityHardMax,
  stackedEfficiency,
} from "./capabilityCeilings";

describe("general capability ceilings", () => {
  it("keeps compact generalists far below frontier generalists", () => {
    expect(generalCapabilityHardMax(0.07)).toBe(15);
    expect(generalCapabilityHardMax(1_000)).toBe(96);
    const tiny = buildScaledModel({
      id: "tiny",
      name: "tiny",
      paramsB: 0.07,
      family: "dense",
      day: 1,
      dataCoverage: 100,
      dataQuality: 100,
      postTrain: "tools",
    });
    const frontier = buildScaledModel({
      id: "frontier",
      name: "frontier",
      paramsB: 405,
      family: "dense",
      day: 1,
      dataCoverage: 20,
      dataQuality: 90,
      postTrain: "none",
    });
    expect(tiny.capability).toBeLessThanOrEqual(15);
    expect(tiny.capability).toBeLessThan(frontier.capability - 20);
  });

  it("stacks research with diminishing combined efficiency", () => {
    expect(stackedEfficiency([0.2, 0.2, 0.2])).toBeCloseTo(0.488, 3);
    expect(stackedEfficiency([0.2, 0.2, 0.2])).toBeLessThan(0.6);
    expect(stackedEfficiency([])).toBe(0);
  });
});
