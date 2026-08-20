import { describe, expect, it } from "vitest";
import { emptyBenchmarks } from "../balance/benchmarks";
import { ECONOMY, SEGMENTS } from "../balance/economy";
import { apiDemandPricePenalty } from "../balance/pricing";
import { createGame } from "../createGame";
import type { Model, SimState } from "../types";
import { syncLabIndex } from "./labEngine";
import { collectOffers, tickMarket } from "./market";
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
});
