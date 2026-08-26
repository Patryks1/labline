import { describe, expect, it } from "vitest";
import type { EffortRecipe, Model } from "../types";
import { emptyBenchmarks } from "./benchmarks";
import { instantRecipe } from "./modelProduct";
import {
  availableSyntheticTeacherRecipes,
  resolveSyntheticTeacherRecipe,
  syntheticTeacherDomainCapability,
  syntheticTeacherGenerationEconomics,
} from "./syntheticTeacherEffort";

function trainedRecipe(
  id: string,
  quality: number,
  thinkingTokenMult = 6,
  served = false,
): EffortRecipe {
  return {
    id,
    name: id === "deliberate" ? "Deliberate" : id,
    kind: "trained",
    thinkingTokenMult,
    trainPfDays: 120,
    trainCash: 4_000_000,
    trained: true,
    quality,
    served,
    capabilityBias: 0.7,
  };
}

function teacher(overrides: Partial<Model> = {}): Model {
  const benchmarks = {
    ...emptyBenchmarks(),
    mmlu: 58,
    coding: 55,
    math: 52,
    science: 50,
    law: 48,
    health: 47,
    agents: 42,
  };
  return {
    id: "teacher",
    name: "Teacher",
    family: "dense",
    paramsB: 12,
    capability: 56,
    modalities: ["text"],
    quality: {
      reasoning: 58,
      coding: 55,
      chat: 62,
      image: 0,
      video: 0,
      safety: 68,
      reliability: 74,
    },
    benchmarks,
    productProfile: {
      lifecycle: "reasoning",
      focus: { coding: 0.2, science: 0.2, research: 0.2, personality: 0.2, chat: 0.2 },
      personality: 55,
      tokenEfficiency: 72,
      effortRecipes: [
        instantRecipe(),
        trainedRecipe("deliberate", 0.82, 6, false),
        { ...trainedRecipe("unfinished", 0.2, 8), trained: false },
      ],
      defaultEffortId: "instant",
    },
    postTrain: "process",
    trainComputeSpent: 100,
    releaseDay: 10,
    shipped: true,
    release: "released",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: 2,
    apiPriceInPerMTok: 1,
    apiPriceOutPerMTok: 3,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: "pretrain",
    ...overrides,
  };
}

describe("synthetic teacher thinking recipes", () => {
  it("offers Instant and actual trained model-owned recipes, even when internal-only", () => {
    const recipes = availableSyntheticTeacherRecipes(teacher());
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      "instant",
      "deliberate",
    ]);
    expect(recipes[1]?.served).toBe(false);
  });

  it("keeps media-only generators on Instant", () => {
    const image = teacher({
      family: "diffusion",
      productPreset: "image_generation",
      io: { inputs: { text: 80 }, outputs: { image: 90 }, tools: 0 },
      modalities: ["image"],
    });
    expect(
      availableSyntheticTeacherRecipes(image).map((recipe) => recipe.id),
    ).toEqual(["instant"]);
  });

  it("uses realized recipe quality for domain capability and bills all generated tokens", () => {
    const model = teacher();
    const instant = syntheticTeacherGenerationEconomics({
      model,
      domain: "math",
      effortId: "instant",
      acceptedMTok: 10,
    });
    const deliberate = syntheticTeacherGenerationEconomics({
      model,
      domain: "math",
      effortId: "deliberate",
      acceptedMTok: 10,
    });

    expect(deliberate.effectiveDomainCapability).toBeGreaterThan(
      instant.effectiveDomainCapability,
    );
    expect(deliberate.billedTokenMultiplier).toBeGreaterThan(
      instant.billedTokenMultiplier,
    );
    expect(deliberate.generatedTokenMTok).toBeCloseTo(
      10 * deliberate.billedTokenMultiplier,
    );
    expect(deliberate.computeIntensityMultiplier).toBeGreaterThan(1);
    expect(instant.computeIntensityMultiplier).toBe(1);
    expect(deliberate.computePfDays).toBeGreaterThan(instant.computePfDays);
    expect(deliberate.cashCost).toBeGreaterThan(instant.cashCost);
  });

  it("falls back to Instant for legacy, missing, and invalid recipe ids", () => {
    const model = teacher();
    expect(resolveSyntheticTeacherRecipe(model, undefined).id).toBe("instant");
    expect(resolveSyntheticTeacherRecipe(model, "deleted-head").id).toBe(
      "instant",
    );
    expect(
      syntheticTeacherDomainCapability(model, "science", "deleted-head"),
    ).toBeCloseTo(
      syntheticTeacherDomainCapability(model, "science", "instant"),
    );
  });
});
