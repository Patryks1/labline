import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildScaledModel } from "../../../sim/balance/modelBuild";
import { blendApiPrice } from "../../../sim/balance/pricing";
import { createGame } from "../../../sim/createGame";
import { ApiCostSummary, PlanEntitlementBreakdown } from "./PlansPanel";
import { effectiveApiPeerPricing, formatApiListPrice } from "./apiPriceUi";

describe("ApiCostSummary", () => {
  it("leads with estimated per-million serving cost without a markup control", () => {
    const markup = renderToStaticMarkup(
      createElement(ApiCostSummary, {
        estimatedCostPerMTok: 2.47,
        modelCount: 3,
        liveModelCount: 2,
        servedMTok: 18.35,
        requestedMTok: 24.8,
      }),
    );

    expect(markup).toContain("Estimated cost / 1M tokens");
    expect(markup).toContain("$2.47");
    expect(markup).toContain("2 live endpoints");
    expect(markup).toContain("24.8 MTok requested");
    expect(markup).not.toContain("Markup over unit cost");
    expect(markup).not.toContain("markup percent");
  });
});

describe("API list price precision", () => {
  it("keeps sub-micro input and output prices visible instead of rounding to zero", () => {
    expect(formatApiListPrice(0.0000001)).toBe("0.0000001");
    expect(formatApiListPrice(0.0000123)).toBe("0.0000123");
    expect(formatApiListPrice(0)).toBe("0");
    expect(formatApiListPrice(3.8)).toBe("3.8");
  });

  it("normalizes native media peers to the effective price used by settlement", () => {
    const state = createGame(9_904);
    const base = buildScaledModel({
      id: "native-peer",
      name: "Native peer",
      paramsB: 2,
      family: "diffusion",
      productPreset: "image_generation",
      day: state.day,
      dataCoverage: 1,
      dataQuality: 70,
      shipped: true,
      release: "released",
    });
    const model = {
      ...base,
      apiPricePerMTok: 2,
      apiPriceInPerMTok: 1,
      apiPriceOutPerMTok: 3,
      apiPricePerImage: 0.04,
    };
    const peer = effectiveApiPeerPricing(state.player.pricing, model);

    expect(peer.price).toBeCloseTo(10, 12);
    expect(blendApiPrice(peer.priceIn, peer.priceOut)).toBeCloseTo(10, 12);
    expect(
      effectiveApiPeerPricing(state.player.pricing, {
        ...model,
        apiPricePerImage: 0,
      }),
    ).toEqual({ price: 0, priceIn: 0, priceOut: 0 });
  });
});

describe("PlansPanel mobile presentation", () => {
  it("renders model entitlements as compact cards without removing the desktop comparison table", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanEntitlementBreakdown, {
        planId: "mobile-plan",
        entitlements: [
          {
            modelId: "mobile-plan-model",
            name: "Pocket Aster",
            kind: "language",
            trafficShare: 1,
            blendedApiPricePerMTok: 0.8,
            includedMTokPerMonth: 24,
            tokensPerInteraction: 2_000,
            interactionsPerDay: 400,
            expectedUtilization: 0.72,
            apiEquivalentValuePerMonth: 19.2,
            rawServingCostPerMonth: 3.4,
          },
        ],
      }),
    );

    expect(markup).toContain("mobile-entitlements-");
    expect(markup).toContain("Pocket Aster");
    expect(markup).toContain("sm:hidden");
    expect(markup).toContain("hidden overflow-x-auto sm:block");
  });
});
