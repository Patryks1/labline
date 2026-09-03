import { describe, expect, it } from "vitest";
import { CASH_PER_PF_DAY_ESTIMATE, cashPerPfDayEstimate, paceFloorDays, trainHbmGB, trainingCompute } from "./compute";
import { TRAINING_V4 } from "./constants";
import { baselineModifiers } from "./modifiers";
import type { Architecture } from "./types";

function denseLanguage(paramsB: number, precision: Architecture["precision"] = "bf16_mixed"): Architecture {
  return {
    backbone: "dense",
    totalParamsB: paramsB,
    activeParamsB: paramsB,
    precision,
    preset: "language",
    inputs: ["text"],
    outputs: ["text"],
  };
}

describe("paceFloorDays / trainHbmGB", () => {
  it("matches clamp(8 · (N/7)^0.3, 3, 120)", () => {
    expect(paceFloorDays(7)).toBeCloseTo(8, 5);
    expect(paceFloorDays(0.07)).toBe(3);
    expect(paceFloorDays(0)).toBe(3);
    expect(paceFloorDays(1_000_000)).toBe(120);
  });

  it("uses optimizer-inclusive bytes per param", () => {
    expect(trainHbmGB(denseLanguage(7))).toBeCloseTo(7 * 12, 5);
    expect(trainHbmGB(denseLanguage(7, "fp8_hybrid"))).toBeCloseTo(7 * 8, 5);
  });
});

describe("trainingCompute", () => {
  const mods = baselineModifiers();

  it("uses 6 N_active D / flopsPerPfDay · archCost · modalityCost", () => {
    const arch = denseLanguage(7);
    const tokens = 140e9;
    const row = trainingCompute(arch, tokens, 0, mods, 1000, 1);
    const expected =
      (TRAINING_V4.compute.flopFactor * 7e9 * tokens) / TRAINING_V4.compute.flopsPerPfDay;
    expect(row.trainPfDays).toBeCloseTo(expected, 6);
    expect(row.archCost).toBe(1);
    expect(row.modalityCost).toBe(1);
    expect(row.holdoutPfDays).toBe(0);
    expect(row.cashEstimate).toBeCloseTo(row.totalPfDays * CASH_PER_PF_DAY_ESTIMATE, 6);
  });

  it("applies MoE archCost and omni modalityCost", () => {
    const moe: Architecture = {
      backbone: "moe",
      totalParamsB: 400,
      activeParamsB: 40,
      precision: "bf16_mixed",
      preset: "omni",
      inputs: ["text", "image", "audio", "video"],
      outputs: ["text", "image", "audio", "video"],
    };
    const row = trainingCompute(moe, 100e9, 10e9, mods, 50, 0.9);
    expect(row.archCost).toBe(TRAINING_V4.archCost.moe);
    expect(row.modalityCost).toBe(TRAINING_V4.modalityCost.omni);
    const nActive = 40e9;
    expect(row.trainPfDays).toBeCloseTo(
      ((6 * nActive * 100e9) / TRAINING_V4.compute.flopsPerPfDay) * 1.1 * 2.2,
      6,
    );
    expect(row.holdoutPfDays).toBeCloseTo(
      (2 * nActive * 10e9) / TRAINING_V4.compute.flopsPerPfDay,
      6,
    );
  });

  it("returns infinite days when pfPerDay is not positive", () => {
    const row = trainingCompute(denseLanguage(7), 1e9, 0, mods, 0, 0.9);
    expect(row.days).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(row.cashEstimate)).toBe(true);
  });

  it("clamps calendar days to the pace floor", () => {
    const row = trainingCompute(denseLanguage(7), 1, 0, mods, 1e12, 1);
    expect(row.days).toBe(paceFloorDays(7));
  });

  it("scales train PF-days and HBM with context", () => {
    const base = trainingCompute(denseLanguage(7), 140e9, 0, mods, 1000, 1);
    const long = trainingCompute(
      { ...denseLanguage(7), contextK: 32 },
      140e9,
      0,
      mods,
      1000,
      1,
    );
    expect(long.trainPfDays / base.trainPfDays).toBeCloseTo((32 / 4) ** 0.18, 5);
    expect(long.trainHbmGB / base.trainHbmGB).toBeCloseTo((32 / 4) ** 0.12, 5);
    expect(long.cashEstimate).toBeGreaterThan(base.cashEstimate);
  });
});

describe("cashPerPfDayEstimate", () => {
  it("starts at the Northstar list rate before escalation", () => {
    expect(cashPerPfDayEstimate(0, 0)).toBe(CASH_PER_PF_DAY_ESTIMATE);
    expect(CASH_PER_PF_DAY_ESTIMATE).toBe(120);
  });
});
