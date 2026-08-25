import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildScaledModel } from "../../../sim/balance/modelBuild";
import { blendApiPrice } from "../../../sim/balance/pricing";
import { createGame } from "../../../sim/createGame";
import { useGameStore } from "../../../store/gameStore";
import type { ComputeLedger } from "../../../sim/types";
import {
  ApiCostSummary,
  PlansCapacitySummary,
  PlanEntitlementBreakdown,
  PlansPanel,
} from "./PlansPanel";
import { effectiveApiPeerPricing, formatApiListPrice } from "./apiPriceUi";
import {
  NEW_PLAN_SELECTOR_ID,
  PLANS_TAB_IDS,
  planSelectorOrder,
} from "./plansPanelNavigation";

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
    expect(markup).toContain("24.80 MTok requested");
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

describe("PlansPanel navigation and capacity summary", () => {
  it("keeps usage information outside the section tabs", () => {
    const ledger: ComputeLedger = {
      day: 42,
      labId: "player",
      items: [
        {
          id: "api-ledger-test",
          labId: "player",
          channel: "api",
          kind: "api_text",
          requested: { inputMTok: 498.85, images: 83, videoSeconds: 45.1 },
          admitted: { inputMTok: 498.85, images: 83, videoSeconds: 45.1 },
          served: { inputMTok: 498.85, images: 83, videoSeconds: 45.1 },
          billed: { inputMTok: 498.85, images: 83, videoSeconds: 45.1 },
          requestedPfDays: 1,
          servedPfDays: 0.8,
          revenue: 0,
          directCogs: 0,
        },
      ],
      requestedPfDays: 1,
      admittedPfDays: 1,
      servedPfDays: 0.8,
      billedPfDays: 0.8,
      capacityPfDays: 2,
      reservedPfDays: 0,
      backfilledPfDays: 0,
    };
    const markup = renderToStaticMarkup(
      createElement(PlansCapacitySummary, {
        apiServed: 12.4,
        apiRequested: 16.8,
        subServed: 7.2,
        subRequested: 9.1,
        apiPf: 3.4,
        apiModelUsage: [],
        stats: [],
        ledger,
        headroom: 0.25,
        apiPriority: 0.68,
        autoApiPriority: 0.7,
        apiServeFraction: 0.74,
        subscriptionServeFraction: 0.79,
        apiBacklogMTok: 4.4,
        subscriptionBacklogMTok: 1.9,
        unservedRatio: 0.23,
        onPriorityChange: () => undefined,
        throttlePolicy: "balanced",
        onThrottlePolicyChange: () => undefined,
        apiLoad: 0.8,
        subLoad: 0.6,
        apiStrain: 0.1,
        subStrain: 0.05,
      }),
    );

    expect(markup).toContain("Capacity at a glance");
    expect(markup).not.toContain("Capacity routing details");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("<summary");
    expect(markup).toContain("API channel");
    expect(markup).toContain("Serving compute allocation");
    expect(markup).toContain("plans-compute-allocation__lane-short");
    expect(markup).not.toContain(">Usage<");
    expect(PLANS_TAB_IDS).toEqual(["demand", "tiers", "api"]);
  });

  it("places the new-plan action after every existing plan", () => {
    expect(
      planSelectorOrder([{ id: "free" }, { id: "pro" }, { id: "max" }]),
    ).toEqual(["free", "pro", "max", NEW_PLAN_SELECTOR_ID]);
  });

  it("keeps permanent plan deletion on the shared danger action", () => {
    const state = createGame(9_906);
    useGameStore.setState({ state });

    const markup = renderToStaticMarkup(createElement(PlansPanel));

    expect(markup).toContain("Delete plan");
    expect(markup).toContain('data-hud-variant="danger"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain("Allow chat data collection");
    expect(markup).not.toContain("chat data collection rate");
  });

  it("wraps plan KPI details instead of clipping the usage-per-seat readout", () => {
    useGameStore.setState({ state: createGame(9_907) });

    const markup = renderToStaticMarkup(createElement(PlansPanel));

    expect(markup).toContain(
      "whitespace-normal break-words font-mono text-[0.6875rem] leading-snug text-muted",
    );
    expect(markup).toContain("Plan usage / seat");
    expect(markup).toContain("include");
  });
});
