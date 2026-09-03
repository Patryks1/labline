import { describe, expect, it } from "vitest";
import { TRAINING_V4 } from "./constants";
import { engineerFactorFor, forecastFromInputs, holdoutTokensFor, utilForLab } from "./forecast";
import { baselineModifiers } from "./modifiers";
import { defaultDesign, emptyTrainingState } from "./state";
import type { Architecture, EffectiveDataBreakdown, ModelDesign } from "./types";
import type { PlayerState, SimState } from "../types";

function denseLanguage(paramsB: number, precision: Architecture["precision"] = "fp32"): Architecture {
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

function dataFor(tokens: number, extras: Partial<EffectiveDataBreakdown> = {}): EffectiveDataBreakdown {
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
    ...extras,
  };
}

const mods = baselineModifiers();

describe("forecastFromInputs", () => {
  it("builds an 80% capability band through the architecture ceiling", () => {
    const forecast = forecastFromInputs({
      arch: denseLanguage(7),
      effectiveData: dataFor(140e9),
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 40,
      util: 0.9,
      mode: { kind: "pretrain" },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    expect(forecast.capability.p10).toBeLessThan(forecast.capability.p50);
    expect(forecast.capability.p50).toBeLessThan(forecast.capability.p90);
    expect(forecast.capability.ceiling).toBe(TRAINING_V4.ceilings.dense);
    expect(forecast.domains.language).toBeCloseTo(forecast.capability.p50, 5);
    expect(forecast.blockers).toEqual([]);
  });

  it("adds parent tokens to D_eff for continue but bills PF on new tokens only", () => {
    const fresh = dataFor(20e9);
    const parentTokens = 120e9;
    const continued = forecastFromInputs({
      arch: denseLanguage(7),
      effectiveData: fresh,
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 40,
      util: 0.9,
      mode: { kind: "continue", parentCheckpointId: "ckpt-parent" },
      parentSummary: {
        pfDays: 10,
        effectiveMTok: parentTokens / 1e6,
        loss: 2,
        gap: 0.4,
        dataMix: { chat: 1 },
        syntheticShare: 0,
      },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    const fromScratch = forecastFromInputs({
      arch: denseLanguage(7),
      effectiveData: fresh,
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 40,
      util: 0.9,
      mode: { kind: "pretrain" },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    expect(continued.loss.dEff).toBeCloseTo(140e9, -2);
    expect(fromScratch.loss.dEff).toBeCloseTo(20e9, -2);
    expect(continued.capability.p50).toBeGreaterThan(fromScratch.capability.p50);
    expect(continued.compute.trainPfDays).toBeCloseTo(fromScratch.compute.trainPfDays, 6);
  });

  it("uses distillGap and discounts train PF", () => {
    const pretrain = forecastFromInputs({
      arch: denseLanguage(7),
      effectiveData: dataFor(140e9),
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 40,
      util: 0.9,
      mode: { kind: "pretrain" },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    const distilled = forecastFromInputs({
      arch: denseLanguage(7),
      effectiveData: dataFor(140e9),
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 40,
      util: 0.9,
      mode: { kind: "distill", teacherCheckpointId: "teacher" },
      teacherGap: 0.16,
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    expect(distilled.loss.gap).toBeLessThan(pretrain.loss.gap);
    expect(distilled.compute.trainPfDays).toBeCloseTo(
      pretrain.compute.trainPfDays * TRAINING_V4.distill.computeMult,
      6,
    );
  });

  it("emits blockers for missing data/compute and locked options", () => {
    const forecast = forecastFromInputs({
      arch: {
        backbone: "moe",
        totalParamsB: 70,
        activeParamsB: 7,
        precision: "nvfp4",
        preset: "omni",
        inputs: ["text", "image", "audio", "video"],
        outputs: ["text"],
        contextK: 64,
      },
      effectiveData: dataFor(0),
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 0,
      util: 0.9,
      mode: { kind: "distill", teacherCheckpointId: "t" },
      sigmaContext: { biggestPriorParamsB: 0, firstMoe: true, engineerFactor: 1 },
    });
    const codes = forecast.blockers.map((row) => row.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "no_data",
        "no_compute",
        "locked_moe",
        "locked_nvfp4",
        "locked_omni",
        "locked_vision",
        "locked_audio",
        "locked_video",
        "locked_distill",
        "locked_long_context",
      ]),
    );
  });

  it("blocks continued pretrain without the unlock", () => {
    const forecast = forecastFromInputs({
      arch: {
        backbone: "dense",
        totalParamsB: 7,
        activeParamsB: 7,
        precision: "bf16_mixed",
        preset: "language",
        inputs: ["text"],
        outputs: ["text"],
      },
      effectiveData: dataFor(1e9),
      holdoutTokens: 0,
      modifiers: mods,
      pfPerDay: 20,
      util: 0.9,
      mode: { kind: "continue", parentCheckpointId: "p" },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: false, engineerFactor: 1 },
    });
    expect(forecast.blockers.map((row) => row.code)).toContain("locked_continued_pretrain");
  });

  it("warns on undertrain, synthetic share, first MoE, scale jump, and nvfp4", () => {
    const forecast = forecastFromInputs({
      arch: {
        backbone: "moe",
        totalParamsB: 400,
        activeParamsB: 40,
        precision: "nvfp4",
        preset: "language",
        inputs: ["text"],
        outputs: ["text"],
      },
      effectiveData: dataFor(40e9, { syntheticShare: 0.7 }),
      holdoutTokens: 0,
      modifiers: { ...mods, unlocks: ["moe", "nvfp4_train"] },
      pfPerDay: 80,
      util: 0.9,
      mode: { kind: "pretrain" },
      sigmaContext: { biggestPriorParamsB: 7, firstMoe: true, engineerFactor: 1 },
    });
    expect(forecast.warnings.join(" ")).toMatch(/Undertrained/);
    expect(forecast.warnings.join(" ")).toMatch(/Synthetic/);
    expect(forecast.warnings.join(" ")).toMatch(/First MoE/);
    expect(forecast.warnings.join(" ")).toMatch(/Scale jump/);
    expect(forecast.warnings.join(" ")).toMatch(/NVFP4/);
  });
});

describe("forecast helpers", () => {
  it("computes holdout tokens from domain MTok × holdoutShare", () => {
    const design: ModelDesign = {
      ...defaultDesign(1),
      data: { domainMTok: { chat: 100, code: 50 }, holdoutShare: 0.1 },
    };
    expect(holdoutTokensFor(design)).toBeCloseTo(150 * 0.1 * 1e6, 0);
  });

  it("uses engineer headcount for the player and 1.0 for rivals", () => {
    const empty = emptyTrainingState();
    const state = {
      playerLabId: "player",
      player: { staff: { researcher: 0, data_processor: 0, engineer: 8, ops: 0 }, utilCap: 0.85, training: empty } as PlayerState,
      rivals: [{ id: "rival-a", training: empty }],
    } as SimState;
    expect(engineerFactorFor(state, "player")).toBeCloseTo(1.3 - 0.12 * Math.log2(9), 5);
    expect(engineerFactorFor(state, "rival-a")).toBe(1);
    expect(utilForLab(state, "player")).toBe(0.85);
    expect(utilForLab(state, "rival-a")).toBe(0.9);
  });
});
