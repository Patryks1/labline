import { describe, expect, it } from "vitest";
import { emptyBenchmarks } from "../balance/benchmarks";
import {
  ECONOMY,
  liftMarketTokenDemand,
  SEGMENTS,
} from "../balance/economy";
import { apiDemandPricePenalty } from "../balance/pricing";
import { apiEffortChoice } from "../balance/effortEconomics";
import { createGame } from "../createGame";
import type { Model, SimState } from "../types";
import { syncLabIndex } from "./labEngine";
import { collectOffers, tickMarket } from "./market";
import { planAllowanceMTokPerMonth } from "./plans";
import { offerUtility, peersInPriceBand, segmentShares } from "./marketScore";
import {
  apiQualityCompetitivenessMultiplier,
  segmentOfferQuality,
} from "./marketScore";

function releasedModel(
  id: string,
  capability: number,
  reliability: number,
  paramsB = 14,
  apiPrice = 4,
): Model {
  return {
    id,
    name: id,
    family: "dense",
    paramsB,
    capability,
    modalities: ["text", "tools"],
    quality: {
      reasoning: capability,
      coding: capability,
      chat: capability,
      image: 0,
      video: 0,
      safety: reliability,
      reliability,
    },
    benchmarks: {
      ...emptyBenchmarks(),
      mmlu: capability,
      coding: capability,
      math: capability,
      science: capability,
      safety: reliability,
      agents: capability,
      law: capability * 0.9,
      health: capability * 0.9,
    },
    postTrain: "rlhf",
    trainComputeSpent: 40,
    releaseDay: 1,
    shipped: true,
    release: "released",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: apiPrice,
    apiPriceInPerMTok: apiPrice,
    apiPriceOutPerMTok: apiPrice,
    suggestedApiPrice: apiPrice,
    suggestedApiPriceIn: apiPrice,
    suggestedApiPriceOut: apiPrice,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: "pretrain",
  };
}

function parityState(seed = 9_401): SimState {
  const created = createGame(seed);
  const template = created.rivals[0]!;
  const price = 4;
  const capability = 72;
  const reliability = 80;
  const playerModel = releasedModel(
    "player-parity",
    capability,
    reliability,
    14,
    price,
  );
  const rivalModel = releasedModel(
    "rival-parity",
    capability,
    reliability,
    14,
    price,
  );
  const rival = {
    ...template,
    models: [rivalModel],
    flopsPf: 50_000_000,
    utilCap: 1,
    servingEfficiency: 1,
    servicePain: 0,
    marketingSpendPerDay: 0,
    brandTrust: 70,
    allocation: { training: 0.05, inference: 0.9, research: 0.05 },
    pricing: {
      ...template.pricing,
      apiPricePerMTok: price,
      apiPriceInPerMTok: price,
      apiPriceOutPerMTok: price,
      subPlusPrice: 20,
      apiModelIds: [rivalModel.id],
      plans: template.pricing.plans.map((plan) => ({
        ...plan,
        modelIds: [rivalModel.id],
        enabled: true,
      })),
    },
  };
  return syncLabIndex({
    ...created,
    rivals: [rival],
    player: {
      ...created.player,
      models: [playerModel],
      brandTrust: 70,
      servicePain: 0,
      servingEfficiency: 1,
      marketingSpendPerDay: 0,
      utilCap: 1,
      allocation: { training: 0.05, inference: 0.9, research: 0.05 },
      pricing: {
        ...created.player.pricing,
        activeModelId: playerModel.id,
        apiModelIds: [playerModel.id],
        apiPricePerMTok: price,
        apiPriceInPerMTok: price,
        apiPriceOutPerMTok: price,
        apiVsSubPriority: 0.62,
        plans: created.player.pricing.plans.map((plan) => ({
          ...plan,
          modelIds: [playerModel.id],
          enabled: true,
          pricePerMonth: plan.pricePerMonth <= 0 ? 0 : 20,
        })),
      },
    },
    segments: created.segments.map((segment) => ({
      ...segment,
      providerShares: {},
    })),
  });
}

describe("API vs subscription demand balance", () => {
  it("lifts token work by exactly 1.25x without changing its audience input", () => {
    const wonCustomers = 8_000;
    const baselineMTok = wonCustomers * 0.004;
    expect(ECONOMY.tokenDemandMultiplier).toBe(1.25);
    expect(liftMarketTokenDemand(baselineMTok)).toBe(baselineMTok * 1.25);
    expect(wonCustomers).toBe(8_000);
  });

  it("raises API base intensity so peer-priced API can compete with seats", () => {
    expect(ECONOMY.apiBaseMTokPerUserDay).toBeGreaterThanOrEqual(0.028);
    expect(ECONOMY.apiBaseMTokPerUserDay).toBeLessThanOrEqual(0.04);
    expect(ECONOMY.marketDailyActiveUsageShare).toBeGreaterThanOrEqual(0.18);
    expect(ECONOMY.marketDailyActiveUsageShare).toBeLessThanOrEqual(0.24);
    expect(
      apiDemandPricePenalty({ ratioToPeer: 1.12, kind: "language" }),
    ).toBeLessThan(0.35);
  });

  it("scores offers against peers in a similar price band including own products", () => {
    const state = parityState();
    const offers = collectOffers(state);
    expect(offers.length).toBeGreaterThanOrEqual(2);
    const player = offers.find((offer) => offer.labId === state.playerLabId)!;
    const band = peersInPriceBand(player, offers, false);
    expect(band.some((peer) => peer.labId !== state.playerLabId)).toBe(true);

    const weakPeer = {
      ...player,
      labId: "weak-peer",
      modelId: "weak",
      capability: 40,
      reliability: 40,
      apiPrice: player.apiPrice,
    };
    const strongPeer = {
      ...player,
      labId: "strong-peer",
      modelId: "strong",
      capability: 90,
      reliability: 90,
      apiPrice: player.apiPrice,
    };
    const vsWeak = offerUtility(player, "indie_api", {
      frontier: 90,
      priceBandPeers: [weakPeer],
    });
    const vsStrong = offerUtility(player, "indie_api", {
      frontier: 90,
      priceBandPeers: [strongPeer],
    });
    expect(vsWeak).toBeGreaterThan(vsStrong);
  });

  it("keeps sub-micro API prices distinct in peer comparison", () => {
    const state = parityState();
    const base = collectOffers(state).find(
      (offer) => offer.labId === state.playerLabId,
    )!;
    const micro = { ...base, apiPrice: 0.0000001 };
    const close = {
      ...base,
      labId: "micro-close",
      modelId: "micro-close",
      apiPrice: 0.0000002,
    };
    const far = {
      ...base,
      labId: "micro-far",
      modelId: "micro-far",
      apiPrice: 0.0000009,
    };
    const band = peersInPriceBand(micro, [micro, close, far], false);
    expect(band.map((offer) => offer.modelId)).toEqual(["micro-close"]);
  });

  it("makes cheap API demand continuous but sharply quality-relative", () => {
    const makeOffer = (
      id: string,
      capability: number,
      benchmark: number,
      price: number,
    ) => {
      const model = releasedModel(id, capability, 70, 14, price);
      return {
        labId: id,
        modelId: id,
        capability,
        reliability: 70,
        safety: 70,
        brandTrust: 60,
        apiPrice: price,
        subPrice: 20,
        latencyScore: 70,
        tokPerSec: 100,
        modalities: model.modalities,
        isOpenWeights: false,
        benchmarks: Object.fromEntries(
          Object.keys(model.benchmarks).map((key) => [key, benchmark]),
        ) as Model["benchmarks"],
        apiListed: true,
        subscriptionListed: true,
      };
    };
    const frontier = makeOffer("frontier", 60, 60, 1.9);
    const near = makeOffer("near", 55, 55, 0.16);
    const weak = makeOffer("weak", 30, 12, 0.16);
    const nearShares = segmentShares([near, frontier], "indie_api");
    const weakShares = segmentShares([weak, frontier], "indie_api");
    expect(nearShares[0]).toBeGreaterThan(0.2);
    expect(weakShares[0]).toBeGreaterThan(0);
    // Choice keeps a visible bargain niche; realized MTok is then multiplied
    // by the much lower quality-competitiveness factor below.
    expect(weakShares[0]).toBeLessThan(nearShares[0]! * 0.15);

    const frontierQuality = segmentOfferQuality(frontier, "indie_api");
    const nearFactor = apiQualityCompetitivenessMultiplier({
      quality: segmentOfferQuality(near, "indie_api"),
      frontierQuality,
      qualityFloor: 24,
      segmentId: "indie_api",
    });
    const weakFactor = apiQualityCompetitivenessMultiplier({
      quality: segmentOfferQuality(weak, "indie_api"),
      frontierQuality,
      qualityFloor: 24,
      segmentId: "indie_api",
    });
    expect(nearFactor).toBeGreaterThan(weakFactor);
    expect(weakShares[0]! * weakFactor).toBeLessThan(
      nearShares[0]! * nearFactor * 0.05,
    );
    expect(weakFactor).toBeGreaterThan(0);
  });

  it("at matched capability/price, API demand ≥ sub demand while enterprise/legal stay sub-heavy", () => {
    const state = parityState();
    const settled = tickMarket(state);
    const apiDemand = settled.lastMarket.apiDemandMTok ?? 0;
    const subDemand = settled.lastMarket.planStats.reduce(
      (sum, plan) =>
        sum + plan.dayMTok / Math.max(0.05, plan.serveFraction ?? 1),
      0,
    );

    expect(apiDemand).toBeGreaterThan(0);
    expect(subDemand).toBeGreaterThan(0);
    expect(apiDemand).toBeGreaterThanOrEqual(subDemand * 0.95);

    const offers = collectOffers(settled);
    const apiNative = [
      "hobby",
      "indie_api",
      "startup_api",
      "science",
      "creative",
    ] as const;
    for (const segmentId of apiNative) {
      const def = SEGMENTS.find((segment) => segment.id === segmentId)!;
      expect(def.prefersSub).toBe(false);
      const shares = segmentShares(offers, segmentId);
      expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.2);
    }

    for (const segmentId of ["enterprise", "legal"] as const) {
      const def = SEGMENTS.find((segment) => segment.id === segmentId)!;
      expect(def.prefersSub).toBe(true);
    }

    // Sub-native channels should still produce meaningful seat traffic vs free-only API hobby.
    const paidSubMTok = settled.lastMarket.planStats
      .filter((plan) => !plan.isFree)
      .reduce((sum, plan) => sum + plan.dayMTok, 0);
    expect(paidSubMTok).toBeGreaterThan(0);
  });

  it("reconciles effort billing, revenue, PF, bandwidth, and COGS to one token ledger", () => {
    const base = parityState(9_403);
    const model = base.player.models[0]!;
    const state: SimState = {
      ...base,
      player: {
        ...base.player,
        models: [
          {
            ...model,
            apiPricePerMTok: null,
            apiPriceInPerMTok: 1,
            apiPriceOutPerMTok: 5,
            productProfile: {
              lifecycle: "reasoning",
              focus: {
                coding: 0,
                science: 0,
                research: 0,
                personality: 0,
                chat: 0,
              },
              personality: 65,
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
                  thinkingTokenMult: 32,
                  trainPfDays: 160,
                  trainCash: 8_000_000,
                  trained: true,
                  quality: 0.9,
                  served: true,
                  capabilityBias: 0.65,
                },
              ],
            },
          },
        ],
      },
    };
    const settled = tickMarket(state);
    const apiItems = (settled.lastMarket.computeLedger?.items ?? []).filter(
      (item) => item.channel === "api",
    );
    expect(apiItems.length).toBeGreaterThan(0);
    const billedMTok = apiItems.reduce(
      (sum, item) =>
        sum +
        (item.billed.inputMTok ?? 0) +
        (item.billed.cachedInputMTok ?? 0) +
        (item.billed.outputMTok ?? 0) +
        (item.billed.reasoningMTok ?? 0),
      0,
    );
    const tokenRevenue = apiItems.reduce(
      (sum, item) =>
        sum +
        ((item.billed.inputMTok ?? 0) +
          (item.billed.cachedInputMTok ?? 0)) *
          1 +
        ((item.billed.outputMTok ?? 0) +
          (item.billed.reasoningMTok ?? 0)) *
          5,
      0,
    );
    const ledgerRevenue = apiItems.reduce(
      (sum, item) => sum + item.revenue,
      0,
    );
    const ledgerPf = apiItems.reduce(
      (sum, item) => sum + item.servedPfDays,
      0,
    );
    const usagePf = (settled.lastMarket.apiModelUsage ?? []).reduce(
      (sum, usage) => sum + usage.dayInferPf,
      0,
    );
    expect(billedMTok).toBeCloseTo(settled.lastMarket.apiDayMTok, 7);
    expect(tokenRevenue).toBeCloseTo(settled.lastMarket.apiDayRevenue, 7);
    expect(ledgerRevenue).toBeCloseTo(settled.lastMarket.apiDayRevenue, 7);
    expect(ledgerPf).toBeCloseTo(usagePf, 7);
    expect(
      settled.lastMarket.apiDayCogs + 1e-9,
    ).toBeGreaterThanOrEqual(billedMTok * ECONOMY.bandwidthPerMTok);

    const planItems = (settled.lastMarket.computeLedger?.items ?? []).filter(
      (item) => item.channel === "subscription",
    );
    expect(planItems.length).toBeGreaterThan(0);
    const planBilledMTok = planItems.reduce(
      (sum, item) =>
        sum +
        (item.billed.inputMTok ?? 0) +
        (item.billed.cachedInputMTok ?? 0) +
        (item.billed.outputMTok ?? 0) +
        (item.billed.reasoningMTok ?? 0),
      0,
    );
    const planInputMTok = planItems.reduce(
      (sum, item) =>
        sum +
        (item.billed.inputMTok ?? 0) +
        (item.billed.cachedInputMTok ?? 0),
      0,
    );
    const planOutputMTok = planItems.reduce(
      (sum, item) =>
        sum +
        (item.billed.outputMTok ?? 0) +
        (item.billed.reasoningMTok ?? 0),
      0,
    );
    const planPf = planItems.reduce(
      (sum, item) => sum + item.servedPfDays,
      0,
    );
    expect(planBilledMTok).toBeCloseTo(
      settled.lastMarket.planStats.reduce(
        (sum, plan) => sum + plan.dayMTok,
        0,
      ),
      7,
    );
    expect(planPf).toBeCloseTo(
      settled.lastMarket.planStats.reduce(
        (sum, plan) => sum + plan.dayInferPf,
        0,
      ),
      7,
    );
    expect(planOutputMTok / Math.max(1e-12, planInputMTok)).toBeGreaterThan(
      0.35 / 0.65,
    );
    for (const plan of settled.lastMarket.planStats) {
      const configured = state.player.pricing.plans.find(
        (candidate) => candidate.id === plan.planId,
      )!;
      expect(
        plan.dayMTok / Math.max(1e-12, plan.subscribers),
      ).toBeLessThanOrEqual(
        (plan.allowanceMTokMonth ?? planAllowanceMTokPerMonth(configured)) /
          ECONOMY.daysPerMonth +
          1e-9,
      );
      if (plan.isFree) {
        expect(plan.dayRevenue).toBe(0);
      } else {
        const serviceCredit =
          (plan.serveFraction ?? 1) >= 0.97
            ? 1
            : 0.5 + 0.5 * (plan.serveFraction ?? 1);
        expect(plan.dayRevenue).toBeCloseTo(
          (plan.subscribers * configured.pricePerMonth * serviceCredit) /
            ECONOMY.daysPerMonth,
          7,
        );
      }
    }
  });

  it("settles subscription work from each plan's enabled effort recipes", () => {
    const base = parityState(9_406);
    const source = base.player.models[0]!;
    const model: Model = {
      ...source,
      productProfile: {
        lifecycle: "reasoning",
        focus: {
          coding: 0,
          science: 0,
          research: 0,
          personality: 0,
          chat: 0,
        },
        personality: 65,
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
            thinkingTokenMult: 32,
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
    const settleWithPolicy = (maxEnabled: boolean) =>
      tickMarket({
        ...base,
        player: {
          ...base.player,
          models: [model],
          pricing: {
            ...base.player.pricing,
            plans: base.player.pricing.plans.map((plan) => ({
              ...plan,
              effortPolicyByModel: {
                [model.id]: {
                  instant: { enabled: !maxEnabled },
                  max: { enabled: maxEnabled },
                },
              },
            })),
          },
        },
      });
    const subscriptionRates = (settled: SimState) => {
      const items = (settled.lastMarket.computeLedger?.items ?? []).filter(
        (item) => item.channel === "subscription",
      );
      const input = items.reduce(
        (sum, item) =>
          sum +
          (item.billed.inputMTok ?? 0) +
          (item.billed.cachedInputMTok ?? 0),
        0,
      );
      const generated = items.reduce(
        (sum, item) =>
          sum +
          (item.billed.outputMTok ?? 0) +
          (item.billed.reasoningMTok ?? 0),
        0,
      );
      const billed = input + generated;
      const pf = items.reduce((sum, item) => sum + item.servedPfDays, 0);
      expect(items.length).toBeGreaterThan(0);
      return {
        generatedPerInput: generated / Math.max(1e-12, input),
        pfPerMTok: pf / Math.max(1e-12, billed),
      };
    };

    const instant = subscriptionRates(settleWithPolicy(false));
    const max = subscriptionRates(settleWithPolicy(true));
    expect(instant.generatedPerInput).toBeCloseTo(0.14 / 0.86, 7);
    expect(max.generatedPerInput).toBeGreaterThan(
      instant.generatedPerInput * 5,
    );
    expect(max.pfPerMTok).toBeGreaterThan(instant.pfPerMTok);
  });

  it("lets a competitively priced reasoning recipe win demand from realized quality", () => {
    const instantState = parityState(9_404);
    const source = instantState.player.models[0]!;
    const cheapSource = {
      ...source,
      apiPricePerMTok: null,
      apiPriceInPerMTok: 0.04,
      apiPriceOutPerMTok: 0.04,
    };
    const baseState: SimState = {
      ...instantState,
      player: {
        ...instantState.player,
        models: [cheapSource],
      },
    };
    const effortState: SimState = {
      ...baseState,
      player: {
        ...baseState.player,
        models: [
          {
            ...cheapSource,
            productProfile: {
              lifecycle: "reasoning",
              focus: {
                coding: 0,
                science: 0,
                research: 0,
                personality: 0,
                chat: 0,
              },
              personality: 65,
              tokenEfficiency: 80,
              defaultEffortId: "think",
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
                  id: "think",
                  name: "Think",
                  kind: "trained",
                  thinkingTokenMult: 6,
                  trainPfDays: 80,
                  trainCash: 2_000_000,
                  trained: true,
                  quality: 0.95,
                  served: true,
                  capabilityBias: 0.5,
                },
              ],
            },
          },
        ],
      },
    };
    const instant = tickMarket(baseState);
    const effort = tickMarket(effortState);
    const choice = apiEffortChoice({
      model: effortState.player.models[0]!,
      kind: "reasoning",
      ratioToPeer: 0.01,
      priceElasticity: 0.8,
      priceIn: 0.04,
      priceOut: 0.04,
    });
    const baseOffers = collectOffers(baseState);
    const effectiveOffers = baseOffers.map((offer) =>
      offer.labId === baseState.playerLabId
        ? {
            ...offer,
            capability: choice.realizedCapability,
            benchmarks: choice.realizedBenchmarks,
            apiPrice: offer.apiPrice * choice.effectiveTaskPriceMultiplier,
          }
        : offer,
    );
    expect(segmentShares(effectiveOffers, "startup_api")[0]).toBeGreaterThan(
      segmentShares(baseOffers, "startup_api")[0]!,
    );
    expect(effort.lastMarket.apiDemandMTok ?? 0).toBeGreaterThan(
      instant.lastMarket.apiDemandMTok ?? 0,
    );
  });
});
