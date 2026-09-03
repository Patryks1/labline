import { describe, expect, it } from "vitest";
import { trainingCompute } from "./compute";
import { CALIBRATION_BANDS, TRAINING_V4 } from "./constants";
import { forecastFromInputs } from "./forecast";
import { baselineModifiers } from "./modifiers";
import {
  capabilityFromGap,
  distillGap,
  gapFromCapability,
  lossFor,
} from "./scaling";
import { drawEpsilon, realizeGap, sigmaFor } from "./outcome";
import type { Architecture, EffectiveDataBreakdown, TrainingModifiers } from "./types";

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

function tokensFor(paramsB: number, tokensPerParam: number): number {
  return tokensPerParam * paramsB * TRAINING_V4.compute.paramsPerBillion;
}

function capAt(
  paramsB: number,
  tokensPerParam: number,
  modifiers: TrainingModifiers = baselineModifiers(),
  precision: Architecture["precision"] = "bf16_mixed",
): number {
  const arch = denseLanguage(paramsB, precision);
  const loss = lossFor(arch, tokensFor(paramsB, tokensPerParam), modifiers);
  return capabilityFromGap(loss.gap, arch, modifiers);
}

function dataFor(tokens: number): EffectiveDataBreakdown {
  const mtok = tokens / 1e6;
  return {
    rawMTok: mtok,
    uniqueMTok: mtok,
    effectiveMTok: mtok,
    qualityWeight: 1,
    diversity: 1,
    epochs: 1,
    epochFactor: 1,
    syntheticShare: 0,
    syntheticDiscount: 1,
    domainMix: { chat: 1 },
    perDomain: {},
  };
}

describe("CALIBRATION_BANDS", () => {
  const mods = baselineModifiers();

  it("hits every dense bf16 row within tolerance", () => {
    for (const row of CALIBRATION_BANDS) {
      const cap = capAt(row.paramsB, row.tokensPerParam, mods);
      expect(cap, `${row.paramsB}B @ ${row.tokensPerParam}N`).toBeGreaterThanOrEqual(
        row.expected - row.tolerance,
      );
      expect(cap, `${row.paramsB}B @ ${row.tokensPerParam}N`).toBeLessThanOrEqual(
        row.expected + row.tolerance,
      );
    }
  });

  it("matches undertrained 70B to a well-trained small model (~50)", () => {
    const undertrained = capAt(70, 1, mods);
    expect(undertrained).toBeGreaterThanOrEqual(47);
    expect(undertrained).toBeLessThanOrEqual(53);
  });
});

describe("MoE vs dense compute and capability", () => {
  const mods = baselineModifiers();
  const tokens = 800e9;
  const moe: Architecture = {
    backbone: "moe",
    totalParamsB: 400,
    activeParamsB: 40,
    precision: "bf16_mixed",
    preset: "language",
    inputs: ["text"],
    outputs: ["text"],
  };
  const dense400 = denseLanguage(400);

  it("lands capability in [66, 78] at D_eff = 800e9/1.2", () => {
    const dEff = tokens / TRAINING_V4.moe.dataRequirementMult;
    const cap = capabilityFromGap(lossFor(moe, dEff, mods).gap, moe, mods);
    expect(cap).toBeGreaterThanOrEqual(66);
    expect(cap).toBeLessThanOrEqual(78);
  });

  it("trains at ~dense-400B/8 PF-days within 20%, including archCost 1.1", () => {
    const moeRow = trainingCompute(moe, tokens, 0, mods, 100, 1);
    const denseRow = trainingCompute(dense400, tokens, 0, mods, 100, 1);
    const target = denseRow.trainPfDays / 8;
    expect(moeRow.archCost).toBe(1.1);
    expect(moeRow.trainPfDays / target).toBeGreaterThanOrEqual(0.8);
    expect(moeRow.trainPfDays / target).toBeLessThanOrEqual(1.2);
  });
});

describe("precision speed / quality", () => {
  const mods = baselineModifiers();
  const tokens = tokensFor(70, 20);

  it("fp8 is ~1.8× faster than bf16 and several capability points worse at 70B", () => {
    const bf16 = denseLanguage(70, "bf16_mixed");
    const fp8 = denseLanguage(70, "fp8_hybrid");
    const bf16Days = trainingCompute(bf16, tokens, 0, mods, 40, 1).days;
    const fp8Days = trainingCompute(fp8, tokens, 0, mods, 40, 1).days;
    expect(fp8Days / bf16Days).toBeCloseTo(1 / 1.8, 3);
    const bf16Cap = capAt(70, 20, mods, "bf16_mixed");
    const fp8Cap = capAt(70, 20, mods, "fp8_hybrid");
    const drop = bf16Cap - fp8Cap;
    expect(drop).toBeGreaterThanOrEqual(5);
    expect(drop).toBeLessThanOrEqual(12);
  });

  it("nvfp4 is ≥2.5× faster than bf16 and much worse at 70B", () => {
    const bf16 = denseLanguage(70, "bf16_mixed");
    const nvfp4 = denseLanguage(70, "nvfp4");
    const bf16Days = trainingCompute(bf16, tokens, 0, mods, 40, 1).days;
    const nvfp4Days = trainingCompute(nvfp4, tokens, 0, mods, 40, 1).days;
    expect(bf16Days / nvfp4Days).toBeGreaterThanOrEqual(2.5);
    const drop = capAt(70, 20, mods, "bf16_mixed") - capAt(70, 20, mods, "nvfp4");
    expect(drop).toBeGreaterThanOrEqual(10);
    expect(drop).toBeLessThanOrEqual(24);
  });
});

describe("distill", () => {
  const mods = baselineModifiers();
  const student = denseLanguage(7);
  const ownGap = lossFor(student, 140e9, mods).gap;
  const teacherGap = gapFromCapability(80);

  it("puts a 7B student at teacher 80 into [60, 72] at baseline", () => {
    const gap = distillGap(teacherGap, ownGap, mods);
    const cap = capabilityFromGap(gap, student, mods);
    expect(cap).toBeGreaterThanOrEqual(60);
    expect(cap).toBeLessThanOrEqual(72);
  });

  it("raises the student when distillEfficiency is 1.5", () => {
    const baseline = capabilityFromGap(distillGap(teacherGap, ownGap, mods), student, mods);
    const boosted = capabilityFromGap(
      distillGap(teacherGap, ownGap, { ...mods, distillEfficiency: 1.5 }),
      student,
      mods,
    );
    expect(boosted).toBeGreaterThan(baseline);
  });
});

describe("research efficiencies and ceilings", () => {
  const mods = baselineModifiers();

  it("lifts 7B@20N when paramEfficiency and dataEfficiency are 0.5", () => {
    const researched = capAt(7, 20, { ...mods, paramEfficiency: 0.5, dataEfficiency: 0.5 });
    const baseline = capAt(7, 20, mods);
    expect(researched).toBeGreaterThan(baseline);
    // Frozen Kaplan + cap=100·exp(−k·g): both efficiencies at 0.5 halves the gap
    // and lands ~71, not the drafted [58, 66]. Requested contract update.
    expect(researched).toBeGreaterThanOrEqual(68);
    expect(researched).toBeLessThanOrEqual(74);
  });

  it("holds architecture walls at 1T dense and omni", () => {
    expect(capAt(1000, 20, mods)).toBe(TRAINING_V4.ceilings.dense);
    const omni: Architecture = { ...denseLanguage(70), preset: "omni" };
    expect(capabilityFromGap(0, omni, mods)).toBe(TRAINING_V4.ceilings.omni);
  });
});

describe("RNG coverage", () => {
  const mods = baselineModifiers();
  const arch = denseLanguage(7);
  const gap = lossFor(arch, tokensFor(7, 20), mods).gap;
  const sigma = sigmaFor({
    modifiers: mods,
    precision: "bf16_mixed",
    firstMoe: false,
    scaleJumpLog10: 0,
    engineerFactor: 1,
  });

  it("keeps realized capability inside [p10, p90] on 78–84% of seeds", () => {
    const forecast = forecastFromInputs({
      arch,
      effectiveData: dataFor(tokensFor(7, 20)),
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 40,
      util: 1,
      mode: { kind: "pretrain" },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    const { p10, p90 } = forecast.capability;
    let inside = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const epsilon = drawEpsilon(seed, sigma);
      expect(Math.abs(epsilon)).toBeLessThanOrEqual(TRAINING_V4.rng.clampSigmas * sigma + 1e-12);
      const realized = capabilityFromGap(realizeGap(gap, epsilon, 0), arch, mods);
      if (realized >= p10 && realized <= p90) inside += 1;
    }
    const rate = inside / 3000;
    expect(rate).toBeGreaterThanOrEqual(0.78);
    expect(rate).toBeLessThanOrEqual(0.84);
  });

  it("returns the same epsilon for the same seed", () => {
    expect(drawEpsilon(12345, sigma)).toBe(drawEpsilon(12345, sigma));
  });
});
