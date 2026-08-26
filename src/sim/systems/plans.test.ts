import { describe, expect, it } from "vitest";
import { buildScaledModel } from "../balance/modelBuild";
import {
  INSTANT_EFFORT_ID,
  emptySpecializationFocus,
  instantRecipe,
  serveTokenMultiplierForRecipe,
} from "../balance/modelProduct";
import { avgTokensPerInteraction } from "../balance/pricing";
import { createGame } from "../createGame";
import { ECONOMY } from "../balance/economy";
import type { EffortRecipe, Model, ModelProductProfile, SubPlan } from "../types";
import {
  MAX_PLANS,
  createPlan,
  effortRecipeRequestShares,
  planAllowanceMTokPerMonth,
  planEnabledEffortRecipes,
  planEffortEntitlementDisplayName,
  planModelEntitlements,
  unlockedPlanPrecisions,
  updatePlan,
} from "./plans";

describe("subscription plan limits", () => {
  it("allows a normal plan creation below the cap", () => {
    const state = createGame(8_101);
    const next = createPlan(state, {
      name: "Team",
      pricePerMonth: 45,
      usageMultiplier: 1,
    });

    expect(next.player.pricing.plans).toHaveLength(
      state.player.pricing.plans.length + 1,
    );
    expect(next.player.pricing.plans.at(-1)?.name).toBe("Team");
    expect(next.player.pricing.plans.at(-1)?.servePrecision).toBe("fp32");
  });

  it("starts with FP32 serving and research-unlocks FP16 then BF16", () => {
    expect(unlockedPlanPrecisions([])).toEqual(["fp32"]);
    expect(unlockedPlanPrecisions(["opt_fp16"])).toEqual(["fp32", "fp16"]);
    expect(unlockedPlanPrecisions(["opt_fp16", "opt_mixed"])).toEqual([
      "fp32",
      "fp16",
      "bf16",
    ]);
  });

  it("rejects the ninth plan in simulation logic and records feedback", () => {
    let state = createGame(8_102);
    while (state.player.pricing.plans.length < MAX_PLANS) {
      state = createPlan(state, {
        name: `Custom ${state.player.pricing.plans.length}`,
        pricePerMonth: 10 + state.player.pricing.plans.length,
        usageMultiplier: 1,
      });
    }

    const beforePlans = state.player.pricing.plans;
    const blocked = createPlan(state, {
      name: "Rejected",
      pricePerMonth: 999,
      usageMultiplier: 5,
    });

    expect(beforePlans).toHaveLength(MAX_PLANS);
    expect(blocked.player.pricing.plans).toEqual(beforePlans);
    expect(blocked.alerts[0]?.severity).toBe("warn");
    expect(blocked.alerts[0]?.message).toContain(
      `Plan limit reached (${MAX_PLANS})`,
    );
  });

  it("updatePlan persists acceptingNew and posts a closed-to-new feed card", () => {
    const state = createGame(8_103);
    const plus = state.player.pricing.plans.find((plan) => plan.id === "plan-plus")!;
    expect(plus.acceptingNew).not.toBe(false);
    const next = updatePlan(state, plus.id, { acceptingNew: false });
    expect(
      next.player.pricing.plans.find((plan) => plan.id === plus.id)?.acceptingNew,
    ).toBe(false);
    expect(
      next.feedEvents?.some((event) => event.kind === "plan_closed_to_new"),
    ).toBe(true);
  });
});

function trainedHead(
  id: string,
  name: string,
  thinkingTokenMult: number,
  served = true,
): EffortRecipe {
  return {
    id,
    name,
    kind: "trained",
    thinkingTokenMult,
    trainPfDays: 20,
    trainCash: 1,
    trained: true,
    quality: 1,
    served,
    capabilityBias: 0.5,
  };
}

function profileWithHeads(...heads: EffortRecipe[]): ModelProductProfile {
  return {
    lifecycle: "reasoning",
    focus: emptySpecializationFocus(),
    personality: 40,
    tokenEfficiency: 50,
    effortRecipes: [instantRecipe(), ...heads],
    defaultEffortId: INSTANT_EFFORT_ID,
  };
}

function lumenFixture(heads: EffortRecipe[] = [
  trainedHead("medium", "Think", 2.2),
  trainedHead("high", "Deep", 4.5),
]): { state: ReturnType<typeof createGame>; plan: SubPlan; model: Model } {
  const state = createGame(9_201);
  const built = buildScaledModel({
    id: "lumen",
    name: "Lumen",
    paramsB: 7,
    family: "dense",
    day: state.day,
    dataCoverage: 1,
    dataQuality: 70,
    shipped: true,
    release: "released",
  });
  const model: Model = {
    ...built,
    shipped: true,
    release: "released",
    commerciallyOffered: true,
    apiPricePerMTok: null,
    apiPriceInPerMTok: 2,
    apiPriceOutPerMTok: 10,
    productProfile: profileWithHeads(...heads),
  };
  const plan: SubPlan = {
    ...state.player.pricing.plans.find((p) => p.id === "plan-plus")!,
    modelIds: [model.id],
    routerIds: [],
  };
  const next = {
    ...state,
    player: {
      ...state.player,
      models: [model],
      pricing: {
        ...state.player.pricing,
        plans: state.player.pricing.plans.map((p) =>
          p.id === plan.id ? plan : { ...p, modelIds: [] },
        ),
      },
    },
  };
  return { state: next, plan, model };
}

describe("plan model entitlement thinking levels", () => {
  it("expands enabled thinking heads into named rows with token-scaled usage", () => {
    const { state, plan, model } = lumenFixture();
    const rows = planModelEntitlements(state, plan);
    expect(rows.map((row) => row.name)).toEqual([
      "Lumen-Instant",
      "Lumen-Think",
      "Lumen-Deep",
    ]);
    expect(rows.map((row) => row.effortId)).toEqual([
      INSTANT_EFFORT_ID,
      "medium",
      "high",
    ]);

    const allowance = planAllowanceMTokPerMonth(plan);
    const shareSum = rows.reduce((sum, row) => sum + row.trafficShare, 0);
    const mtokSum = rows.reduce((sum, row) => sum + row.includedMTokPerMonth, 0);
    expect(shareSum).toBeCloseTo(1, 10);
    expect(mtokSum).toBeCloseTo(allowance, 8);

    const instant = rows[0]!;
    const think = rows[1]!;
    const deep = rows[2]!;
    expect(instant.trafficShare).toBeCloseTo(0.55, 10);
    expect(think.trafficShare).toBeCloseTo(0.225, 10);
    expect(deep.trafficShare).toBeCloseTo(0.225, 10);

    const efficiency = model.productProfile!.tokenEfficiency;
    expect(instant.tokenMult).toBeCloseTo(
      serveTokenMultiplierForRecipe(instantRecipe(), efficiency),
      8,
    );
    expect(think.tokenMult).toBeGreaterThan(instant.tokenMult);
    expect(deep.tokenMult).toBeGreaterThan(think.tokenMult);
    expect(think.billedTokenMult).toBeGreaterThan(instant.billedTokenMult);
    expect(deep.billedTokenMult).toBeGreaterThan(think.billedTokenMult);
    expect(think.computeTokenMult).toBeGreaterThan(think.billedTokenMult);
    expect(deep.computeIntensityMult).toBeGreaterThan(
      think.computeIntensityMult,
    );
    expect(think.blendedApiPricePerMTok).toBeGreaterThan(
      instant.blendedApiPricePerMTok,
    );
    expect(deep.effectiveApiSpendPerBaseMTok).toBeGreaterThan(
      think.effectiveApiSpendPerBaseMTok,
    );
    expect(think.includedMTokPerMonth).toBeGreaterThan(
      instant.includedMTokPerMonth * (think.trafficShare / instant.trafficShare),
    );
    expect(deep.includedMTokPerMonth).toBeGreaterThan(
      think.includedMTokPerMonth,
    );

    const base = avgTokensPerInteraction("language");
    expect(think.tokensPerInteraction).toBeCloseTo(
      base * think.billedTokenMult,
      8,
    );
    expect(think.interactionsPerDay).toBeCloseTo(
      (think.includedMTokPerMonth * 1_000_000) /
        think.tokensPerInteraction /
        ECONOMY.daysPerMonth,
      8,
    );
    // Request shares remain the source of message mix; billed MTok expands
    // around those requests, so equal Think/Deep request shares stay equal.
    expect(instant.interactionsPerDay).toBeGreaterThan(think.interactionsPerDay);
    expect(think.interactionsPerDay).toBeCloseTo(deep.interactionsPerDay, 8);
  });

  it("keeps Instant-only models as a single bare-name row", () => {
    const { state, plan } = lumenFixture([]);
    const rows = planModelEntitlements(state, plan);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Lumen");
    expect(rows[0]!.effortId).toBe(INSTANT_EFFORT_ID);
    expect(rows[0]!.trafficShare).toBeCloseTo(1, 10);
    expect(rows[0]!.tokenMult).toBeCloseTo(
      serveTokenMultiplierForRecipe(instantRecipe(), 50),
      8,
    );
  });

  it("respects plan effortPolicyByModel enablement and Instant fallback", () => {
    const { state, plan, model } = lumenFixture();
    const thinkOnly: SubPlan = {
      ...plan,
      effortPolicyByModel: {
        [model.id]: {
          [INSTANT_EFFORT_ID]: { enabled: false },
          medium: { enabled: true },
          high: { enabled: false },
        },
      },
    };
    const enabled = planEnabledEffortRecipes(thinkOnly, model);
    expect(enabled.map((r) => r.id)).toEqual(["medium"]);
    const rows = planModelEntitlements(state, thinkOnly);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Lumen");
    expect(rows[0]!.effortId).toBe("medium");
    expect(rows[0]!.tokenMult).toBeGreaterThan(1);

    const allOff: SubPlan = {
      ...plan,
      effortPolicyByModel: {
        [model.id]: {
          [INSTANT_EFFORT_ID]: { enabled: false },
          medium: { enabled: false },
          high: { enabled: false },
        },
      },
    };
    const fallback = planModelEntitlements(state, allOff);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.effortId).toBe(INSTANT_EFFORT_ID);
  });

  it("raises COGS per billed MTok with effort compute intensity", () => {
    const { state, plan } = lumenFixture();
    const unit = 2.5;
    const rows = planModelEntitlements(state, plan, {
      rawCostPerMTok: () => unit,
    });
    for (const row of rows) {
      expect(row.rawServingCostPerMonth).toBeCloseTo(
        row.includedMTokPerMonth *
          row.expectedUtilization *
          unit *
          row.computeIntensityMult,
        8,
      );
    }
    expect(rows[2]!.includedMTokPerMonth).toBeGreaterThan(
      rows[1]!.includedMTokPerMonth,
    );
    // Equal request remainder shares → deeper heads consume more billed
    // MTok and more PF for each one.
    expect(rows[2]!.rawServingCostPerMonth).toBeGreaterThan(
      rows[1]!.rawServingCostPerMonth!,
    );
    expect(rows[2]!.interactionsPerDay).toBeCloseTo(
      rows[1]!.interactionsPerDay,
      8,
    );
  });

  it("formats entitlement display names and effort request shares", () => {
    expect(
      planEffortEntitlementDisplayName("Lumen", instantRecipe(), 1),
    ).toBe("Lumen");
    expect(
      planEffortEntitlementDisplayName("Lumen", instantRecipe(), 2),
    ).toBe("Lumen-Instant");
    expect(
      planEffortEntitlementDisplayName(
        "Lumen",
        trainedHead("medium", "Think", 2.2),
        2,
      ),
    ).toBe("Lumen-Think");

    const shares = effortRecipeRequestShares(
      [instantRecipe(), trainedHead("medium", "Think", 2.2)],
      INSTANT_EFFORT_ID,
    );
    expect(shares[INSTANT_EFFORT_ID]).toBeCloseTo(0.55, 10);
    expect(shares.medium).toBeCloseTo(0.45, 10);
  });
});
