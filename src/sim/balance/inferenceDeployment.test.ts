import { describe, expect, it } from "vitest";
import {
  dailyDecodeCapacity,
  devicesPerReplica,
  replicaLayout,
  trainingPaybackDays,
  unitGrossMargin,
} from "./inferenceDeployment";
import { estimateServingMemory } from "./tokenServe";

describe("inference deployments", () => {
  it("sizes MoE weight memory from total parameters, not only active", () => {
    const dense = estimateServingMemory({
      model: { paramsB: 70, family: "dense" },
      precision: "bf16",
    });
    const moe = estimateServingMemory({
      model: { paramsB: 70, activeParamsB: 7, family: "moe" },
      precision: "bf16",
    });
    expect(moe.weightMemoryGb).toBeGreaterThanOrEqual(dense.weightMemoryGb * 0.95);
  });

  it("turns extra devices into replicas rather than faster single-stream decode", () => {
    expect(devicesPerReplica({ residentMemoryGb: 160, hbmGbPerDevice: 80 })).toBe(2);
    const layout = replicaLayout({
      model: { paramsB: 7, family: "dense" },
      availableDevices: 8,
      hbmGbPerDevice: 80,
    });
    expect(layout.replicas).toBeGreaterThan(1);
    expect(dailyDecodeCapacity({ singleStreamTokPerSec: 40, replicas: 2 })).toBe(
      dailyDecodeCapacity({ singleStreamTokPerSec: 40, replicas: 1 }) * 2,
    );
  });

  it("keeps training investment out of token COGS while reporting payback", () => {
    expect(unitGrossMargin({ listPrice: 10, servingCost: 4 })).toBeCloseTo(0.6);
    expect(trainingPaybackDays({ trainingInvestmentGbp: 120, dailyContributionGbp: 1 })).toBe(
      120,
    );
    expect(
      trainingPaybackDays({ trainingInvestmentGbp: 120, dailyContributionGbp: 0 }),
    ).toBeNull();
  });
});
