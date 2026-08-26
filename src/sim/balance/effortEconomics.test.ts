import { describe, expect, it } from "vitest";
import type { Model } from "../types";
import { emptyBenchmarks } from "./benchmarks";
import {
  apiEffortChoice,
  planEffortMix,
  routedApiEffortChoices,
} from "./effortEconomics";
import { effortRequestMultipliers } from "./modelProduct";
import { apiRevenueForCommercialWork } from "./pricing";
import {
  billableTextMTok,
  nativeWorkFromEquivalentMTokAtEffort,
} from "./workload";

function effortModel(): Pick<
  Model,
  "capability" | "benchmarks" | "productProfile"
> {
  const benchmarks = {
    ...emptyBenchmarks(),
    mmlu: 62,
    coding: 62,
    math: 62,
    science: 62,
    agents: 62,
  };
  return {
    capability: 62,
    benchmarks,
    productProfile: {
      lifecycle: "reasoning",
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 60,
      tokenEfficiency: 70,
      defaultEffortId: "max",
      effortRecipes: [
        {
          id: "instant",
          name: "Instant",
          kind: "instant",
          thinkingTokenMult: 1,
          trainPfDays: 0,
          trainCash: 0,
          trained: true,
          quality: 1,
          served: true,
        },
        {
          id: "max",
          name: "Max",
          kind: "trained",
          thinkingTokenMult: 100,
          trainPfDays: 160,
          trainCash: 8_000_000,
          trained: true,
          quality: 0.9,
          served: true,
          capabilityBias: 0.65,
        },
      ],
    },
  };
}

describe("API effort economics", () => {
  it("keeps prompt tokens fixed while billing generated and reasoning tokens as output", () => {
    const billed = billableTextMTok(
      nativeWorkFromEquivalentMTokAtEffort("reasoning", 10, 4),
    );
    expect(billed.inputMTok).toBeCloseTo(6.5, 9);
    expect(billed.outputMTok).toBeCloseTo(14, 9);
    expect(apiRevenueForCommercialWork("reasoning", 10, 1, 5, undefined, 4)).toBeCloseTo(
      76.5,
      9,
    );
  });

  it("uses the same realized mix for quality, billed tokens, and compute", () => {
    const choice = apiEffortChoice({
      model: effortModel(),
      kind: "reasoning",
      ratioToPeer: 1,
      priceElasticity: 0.7,
      priceIn: 1,
      priceOut: 5,
    });
    expect(choice.shares.max).toBeGreaterThan(0);
    expect(choice.realizedCapability).toBeGreaterThan(62);
    expect(choice.generatedTokenMultiplier).toBeGreaterThan(1);
    const maxRequest = effortRequestMultipliers(
      effortModel().productProfile!.effortRecipes[1]!,
      70,
      0.35,
    );
    expect(choice.generatedTokenMultiplier).toBeCloseTo(
      (choice.shares.instant ?? 0) +
        (choice.shares.max ?? 0) * maxRequest.generatedTokenMultiplier,
      9,
    );
    expect(choice.billedTokenMultiplier).toBeGreaterThan(1);
    expect(choice.computeTokenMultiplier).toBeGreaterThan(
      choice.billedTokenMultiplier,
    );
  });

  it("deterministically moves expensive customers toward Instant and raises complaints", () => {
    const affordable = apiEffortChoice({
      model: effortModel(),
      kind: "reasoning",
      ratioToPeer: 0.55,
      priceElasticity: 1,
      priceIn: 1,
      priceOut: 5,
    });
    const expensive = apiEffortChoice({
      model: effortModel(),
      kind: "reasoning",
      ratioToPeer: 4,
      priceElasticity: 1,
      priceIn: 1,
      priceOut: 5,
    });
    expect(expensive.shares.max).toBeLessThan(affordable.shares.max!);
    expect(expensive.fallbackShare).toBeGreaterThan(affordable.fallbackShare);
    expect(expensive.complaintPressure).toBeGreaterThan(
      affordable.complaintPressure,
    );
  });

  it("keeps native media Instant-only", () => {
    const choice = apiEffortChoice({
      model: effortModel(),
      kind: "image",
      ratioToPeer: 1,
      priceElasticity: 1,
    });
    expect(choice.shares).toEqual({ instant: 1 });
    expect(choice.generatedTokenMultiplier).toBe(1);
    expect(choice.billedTokenMultiplier).toBe(1);
    expect(choice.computeTokenMultiplier).toBe(1);
  });

  it("uses a bounded default/served mix for plan token and compute work", () => {
    const mix = planEffortMix({ model: effortModel(), kind: "reasoning" });
    expect(mix.shares.max).toBeCloseTo(0.55, 9);
    expect(mix.shares.instant).toBeCloseTo(0.45, 9);
    expect(mix.generatedTokenMultiplier).toBeGreaterThan(1);
    expect(mix.computeTokenMultiplier).toBeGreaterThan(
      mix.billedTokenMultiplier,
    );

    const media = planEffortMix({ model: effortModel(), kind: "image" });
    expect(media).toEqual({
      shares: { instant: 1 },
      generatedTokenMultiplier: 1,
      billedTokenMultiplier: 1,
      computeTokenMultiplier: 1,
    });
  });

  it("honors a plan-filtered effort entitlement", () => {
    const model = effortModel();
    const instant = model.productProfile!.effortRecipes.find(
      (recipe) => recipe.id === "instant",
    )!;
    const max = model.productProfile!.effortRecipes.find(
      (recipe) => recipe.id === "max",
    )!;

    const instantOnly = planEffortMix({
      model,
      kind: "reasoning",
      recipes: [instant],
    });
    expect(instantOnly.shares).toEqual({ instant: 1 });
    expect(instantOnly.billedTokenMultiplier).toBe(1);
    expect(instantOnly.computeTokenMultiplier).toBe(1);

    const maxOnly = planEffortMix({
      model,
      kind: "reasoning",
      recipes: [max],
    });
    expect(maxOnly.shares).toEqual({ max: 1 });
    expect(maxOnly.billedTokenMultiplier).toBeGreaterThan(1);
    expect(maxOnly.computeTokenMultiplier).toBeGreaterThan(
      maxOnly.billedTokenMultiplier,
    );
  });

  it("resolves heterogeneous router members from each member's own recipes", () => {
    const instantOnly = { ...effortModel(), productProfile: undefined };
    const members = [
      {
        id: "reasoning",
        share: 0.4,
        model: effortModel(),
        kind: "reasoning" as const,
        priceIn: 1,
        priceOut: 5,
      },
      {
        id: "instant",
        share: 0.6,
        model: instantOnly,
        kind: "reasoning" as const,
        priceIn: 1,
        priceOut: 5,
      },
    ];
    const resolve = (ordered: typeof members) =>
      routedApiEffortChoices({
        members: ordered,
        ratioToPeer: 1,
        priceElasticity: 0.8,
      });
    const resolved = resolve(members);
    const reversed = resolve([...members].reverse());
    const byId = Object.fromEntries(
      resolved.map((member) => [member.id, member.effort]),
    );
    const reversedById = Object.fromEntries(
      reversed.map((member) => [member.id, member.effort]),
    );
    expect(byId.reasoning.generatedTokenMultiplier).toBeGreaterThan(1);
    expect(byId.reasoning.computeTokenMultiplier).toBeGreaterThan(
      byId.reasoning.billedTokenMultiplier,
    );
    expect(byId.instant.generatedTokenMultiplier).toBe(1);
    expect(byId.instant.billedTokenMultiplier).toBe(1);
    expect(reversedById.reasoning).toEqual(byId.reasoning);
    expect(reversedById.instant).toEqual(byId.instant);
  });
});
