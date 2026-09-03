import { describe, expect, it } from "vitest";
import type { Model } from "../../../sim/types";
import { emptyBenchmarks } from "../../../sim/balance/benchmarks";
import { instantRecipe } from "../../../sim/balance/modelProduct";
import {
  parseSyntheticTeacherSelectValue,
  syntheticTeacherSelectOptions,
  syntheticTeacherSelectValue,
} from "./trainingSyntheticTeacherOptions";

function teacher(): Model {
  return {
    id: "teacher::with-separator",
    name: "Atlas",
    family: "dense",
    paramsB: 7,
    capability: 50,
    modalities: ["text"],
    quality: {
      reasoning: 52,
      coding: 50,
      chat: 58,
      image: 0,
      video: 0,
      safety: 65,
      reliability: 72,
    },
    benchmarks: {
      ...emptyBenchmarks(),
      coding: 52,
      math: 50,
      science: 48,
      agents: 40,
    },
    productProfile: {
      lifecycle: "reasoning",
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 50,
      tokenEfficiency: 80,
      effortRecipes: [
        instantRecipe(),
        {
          id: "careful",
          name: "Careful",
          kind: "trained",
          thinkingTokenMult: 4,
          trainPfDays: 80,
          trainCash: 2_000_000,
          trained: true,
          quality: 0.76,
          served: true,
          capabilityBias: 0.65,
        },
      ],
      defaultEffortId: "instant",
    },
    postTrain: "process",
    trainComputeSpent: 80,
    releaseDay: 1,
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
  };
}

describe("training synthetic teacher options", () => {
  it("creates one option per eligible model × trained recipe with economics", () => {
    const options = syntheticTeacherSelectOptions([teacher()], "math");
    const efforts = options.map((option) => option.effortId).toSorted();
    expect(efforts).toEqual(["careful", "instant"]);
    const careful = options.find((option) => option.effortId === "careful");
    expect(careful?.label).toContain("Atlas · Careful");
    expect(careful?.label).toContain("cap ");
    expect(careful?.label).toContain("/ q 76%");
    expect(careful?.label).toContain("× billed");
    expect(careful?.label).toContain("× PF intensity");
    expect(careful?.label).toContain("$250/billed MTok");
    expect(careful?.label).toContain("PF/accepted MTok");
  });

  it("round-trips arbitrary model and recipe ids", () => {
    const value = syntheticTeacherSelectValue(
      "teacher::with-separator",
      "careful",
    );
    expect(parseSyntheticTeacherSelectValue(value)).toEqual({
      teacherId: "teacher::with-separator",
      effortId: "careful",
    });
  });
});
