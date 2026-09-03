import { describe, expect, it } from "vitest";
import { baselineModifiers } from "./modifiers";
import {
  archCeiling,
  capabilityFromGap,
  distillGap,
  domainVectorFor,
  effectiveParams,
  gapFromCapability,
  lossFor,
  overallCapability,
} from "./scaling";
import { TRAINING_V4 } from "./constants";
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

describe("effectiveParams", () => {
  it("returns raw dense params", () => {
    expect(effectiveParams(denseLanguage(7))).toBeCloseTo(7e9, -2);
  });

  it("mixes MoE active and total with nEffExponent", () => {
    const arch: Architecture = {
      ...denseLanguage(400),
      backbone: "moe",
      activeParamsB: 40,
    };
    const expected = 40e9 * (400 / 40) ** TRAINING_V4.moe.nEffExponent;
    expect(effectiveParams(arch)).toBeCloseTo(expected, -2);
  });
});

describe("lossFor", () => {
  it("treats effectiveTokens as already-taxed raw D (no second MoE /1.2)", () => {
    const mods = baselineModifiers();
    const moe: Architecture = {
      ...denseLanguage(400),
      backbone: "moe",
      activeParamsB: 40,
    };
    const raw = 800e9;
    const taxed = raw / TRAINING_V4.moe.dataRequirementMult;
    const once = lossFor(moe, taxed, mods);
    const twice = lossFor(moe, taxed / TRAINING_V4.moe.dataRequirementMult, mods);
    expect(once.dEff).toBe(taxed);
    expect(twice.gap).toBeGreaterThan(once.gap);
  });

  it("caps gap at 6 when D is non-positive", () => {
    const loss = lossFor(denseLanguage(7), 0, baselineModifiers());
    expect(loss.gap).toBe(6);
    expect(loss.dEff).toBe(0);
  });
});

describe("ceilings and capability map", () => {
  const mods = baselineModifiers();

  it("maps dense / moe / specialist / omni / verified omni", () => {
    expect(archCeiling(denseLanguage(7), mods)).toBe(TRAINING_V4.ceilings.dense);
    expect(
      archCeiling({ ...denseLanguage(70), backbone: "moe", activeParamsB: 7 }, mods),
    ).toBe(TRAINING_V4.ceilings.moe);
    expect(
      archCeiling({ ...denseLanguage(7), preset: "image_generation", outputs: ["image"] }, mods),
    ).toBe(TRAINING_V4.ceilings.specialist);
    expect(archCeiling({ ...denseLanguage(7), preset: "omni" }, mods)).toBe(
      TRAINING_V4.ceilings.omni,
    );
    expect(
      archCeiling(
        { ...denseLanguage(7), preset: "omni" },
        { ...mods, unlocks: ["verifier"], modalityBridge: 1.2 },
      ),
    ).toBe(TRAINING_V4.ceilings.omniVerified);
    expect(
      archCeiling(
        { ...denseLanguage(7), preset: "omni" },
        { ...mods, unlocks: ["verifier"], modalityBridge: 1.19 },
      ),
    ).toBe(TRAINING_V4.ceilings.omni);
  });

  it("adds ceilingLift and never exceeds 100", () => {
    expect(archCeiling(denseLanguage(7), { ...mods, ceilingLift: 5 })).toBe(87);
    expect(archCeiling(denseLanguage(7), { ...mods, ceilingLift: 50 })).toBe(100);
  });

  it("inverts capabilityFromGap below the wall", () => {
    const arch = denseLanguage(7);
    const gap = 0.4;
    const cap = capabilityFromGap(gap, arch, mods);
    expect(gapFromCapability(cap)).toBeCloseTo(gap, 5);
  });
});

describe("domainVectorFor / overallCapability", () => {
  const mods = baselineModifiers();
  const arch = denseLanguage(7);

  it("gives language = capability and STEM affinity parity at 15% mix", () => {
    const mix = { chat: 0.55, code: 0.15, math: 0.15, science: 0.15 };
    const truth = domainVectorFor(60, arch, mix, mods);
    expect(truth.domains.language).toBeCloseTo(60, 5);
    expect(truth.domains.code).toBeCloseTo(60, 5);
    expect(truth.domains.math).toBeCloseTo(60, 5);
    expect(truth.domains.science).toBeCloseTo(60, 5);
    expect(truth.domains.vision).toBe(0);
    expect(truth.domains.tools).toBeCloseTo(30, 5);
    expect(truth.safety).toBeCloseTo(35 + 0.3 * 60, 5);
  });

  it("enables vision only when image is on the architecture", () => {
    const withImage: Architecture = {
      ...arch,
      inputs: ["text", "image"],
      outputs: ["text"],
    };
    const mix = { chat: 0.8, image: 0.2 };
    expect(domainVectorFor(50, arch, mix, mods).domains.vision).toBe(0);
    expect(domainVectorFor(50, withImage, mix, mods).domains.vision).toBeCloseTo(50, 5);
  });

  it("renormalizes overall weights over live modality domains", () => {
    const visionArch: Architecture = {
      ...arch,
      inputs: ["text", "image"],
      outputs: ["text"],
    };
    const truth = domainVectorFor(80, visionArch, { chat: 0.8, image: 0.2 }, mods);
    expect(truth.domains.vision).toBeGreaterThan(0);
    expect(truth.domains.audio).toBe(0);
    expect(truth.domains.video).toBe(0);
    const overall = overallCapability(truth);
    expect(overall).toBeGreaterThan(0);
    expect(overall).toBeLessThanOrEqual(archCeiling(visionArch, mods));
  });
});

describe("distillGap", () => {
  const mods = baselineModifiers();

  it("cannot beat teacher + margin, and efficiency > 1 lowers the own-gap floor", () => {
    const teacher = 0.2;
    const own = 0.5;
    const baseline = distillGap(teacher, own, mods);
    const efficient = distillGap(teacher, own, { ...mods, distillEfficiency: 1.5 });
    expect(baseline).toBeCloseTo(
      Math.max(teacher + TRAINING_V4.distill.gapMargin, TRAINING_V4.distill.ownGapFloor * own),
      8,
    );
    expect(efficient).toBeLessThan(baseline);
    expect(efficient).toBeGreaterThanOrEqual(teacher + TRAINING_V4.distill.gapMargin);
  });
});
