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
  PlanDissatisfactionStatusChip,
  planDissatisfactionChipTitle,
} from "./planDissatisfactionCopy";
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
            effortId: "instant",
            name: "Pocket Aster",
            kind: "language",
            trafficShare: 1,
            blendedApiPricePerMTok: 0.8,
            includedMTokPerMonth: 24,
            tokensPerInteraction: 2_000,
            tokenMult: 1,
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

  it("renders per-model serve load and outage banner when provided", () => {
    const state = createGame(9_908);
    const ledger: ComputeLedger = {
      day: 1,
      labId: "player",
      items: [],
      requestedPfDays: 0,
      admittedPfDays: 0,
      servedPfDays: 0,
      billedPfDays: 0,
      capacityPfDays: 1,
      reservedPfDays: 0,
      backfilledPfDays: 0,
    };
    const serveLoad = {
      allocatedPf: 10,
      usedPf: 9,
      idlePf: 1,
      fill: 0.9,
      apiUsedPf: 4,
      subUsedPf: 5,
      warn: false,
      models: [
        {
          modelId: "m1",
          name: "Alpha",
          allocatedPf: 10,
          usedPf: 9,
          apiUsedPf: 4,
          subUsedPf: 5,
          idlePf: 1,
          fill: 0.9,
          warn: false,
          unserved: false,
          planMix: [],
        },
      ],
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
        unservedRatio: 0.45,
        onPriorityChange: () => undefined,
        throttlePolicy: "balanced",
        onThrottlePolicyChange: () => undefined,
        apiLoad: 0.8,
        subLoad: 0.6,
        apiStrain: 0.1,
        subStrain: 0.05,
        serveLoad,
        outageState: {
          ...state,
          lastMarket: {
            ...state.lastMarket,
            capacityPf: 0,
            unservedRatio: 0.45,
            playerDemandMTok: 10,
            serveOutage: true,
          },
        },
        onPauseApi: () => undefined,
        onPauseSubs: () => undefined,
        peakListPrice: 2,
        peakPrice: 2.8,
        peakExtraRevenue: 1200,
      }),
    );

    expect(markup).toContain("data-testid=\"plans-serve-model-load\"");
    expect(markup).toContain("Per-model serve load");
    expect(markup).toContain("data-testid=\"serve-outage-banner\"");
    expect(markup).toContain("data-testid=\"peak-pricing-strip\"");
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

  it("puts a concrete why-dissatisfied title on the FREE plan status chip", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanDissatisfactionStatusChip, {
        isFree: true,
        dissatisfaction: 0.7432,
        allowanceDissatisfaction: 0,
        stabilityDissatisfaction: 0.58,
        slownessDissatisfaction: 0.28,
        serveFraction: 0.78,
        serveOutage: false,
        subSpeedStrain: 0.42,
      }),
    );

    expect(markup).toContain("74.32% dissatisfied");
    expect(markup).toContain('class="status-chip status-chip--danger"');
    expect(markup).toContain(
      "unsustainable subsidy · slow streams from overload (free users are less sensitive) · 22% of this plan unserved · weak brand patience",
    );
    expect(markup).not.toContain("peak");
    expect(markup).not.toContain(
      "Included usage is below what customers expect at this price and capability.",
    );
  });
});

describe("plan dissatisfaction chip copy", () => {
  it("ranks settled causes and is honest about free-tier slowness sensitivity", () => {
    const title = planDissatisfactionChipTitle({
      isFree: true,
      dissatisfaction: 0.7432,
      allowanceDissatisfaction: 0,
      stabilityDissatisfaction: 0.58,
      slownessDissatisfaction: 0.28,
      serveFraction: 0.78,
      subSpeedStrain: 0.42,
    });

    expect(title).toBe(
      "unsustainable subsidy · slow streams from overload (free users are less sensitive) · 22% of this plan unserved · weak brand patience",
    );
    expect(title).not.toMatch(/peak/i);
  });

  it("does not tell paid users they notice slowness less", () => {
    const title = planDissatisfactionChipTitle({
      isFree: false,
      dissatisfaction: 0.41,
      allowanceDissatisfaction: 0,
      stabilityDissatisfaction: 0,
      slownessDissatisfaction: 0.4,
      subSpeedStrain: 0.5,
    });

    expect(title).toBe("slow streams from overload");
    expect(title).not.toMatch(/free users/i);
    expect(title).not.toMatch(/peak/i);
  });

  it("attributes token-speed slowness when overload strain is idle", () => {
    expect(
      planDissatisfactionChipTitle({
        isFree: false,
        dissatisfaction: 0.22,
        slownessDissatisfaction: 0.22,
        subSpeedStrain: 0,
      }),
    ).toBe("streams below 30 tok/s");
  });

  it("does not blame include when stats cleared allowance but slowness remains", () => {
    const title = planDissatisfactionChipTitle({
      isFree: true,
      dissatisfaction: 0.31,
      allowanceDissatisfaction: 0,
      stabilityDissatisfaction: 0,
      slownessDissatisfaction: 0.3,
      subSpeedStrain: 0.2,
      allowanceFallback: 0.4,
      allowanceFallbackLabel: "Free users expect at least 1M tokens/month.",
    });

    expect(title).toContain("slow streams from overload");
    expect(title).toContain("free users are less sensitive");
    expect(title).not.toContain("Free users expect");
    expect(title).not.toContain("include below");
  });

  it("names paid include and loss causes without inventing API peak price", () => {
    const title = planDissatisfactionChipTitle({
      isFree: false,
      dissatisfaction: 0.62,
      allowanceDissatisfaction: 0.4,
      stabilityDissatisfaction: 0.35,
      slownessDissatisfaction: 0,
    });

    expect(title).toBe(
      "include below expected for this price · losing money / sub",
    );
    expect(title).not.toMatch(/peak/i);
  });

  it("surfaces recovered brand residual when operational mix cannot explain the total", () => {
    const title = planDissatisfactionChipTitle({
      isFree: true,
      dissatisfaction: 0.5,
      allowanceDissatisfaction: 0,
      stabilityDissatisfaction: 0,
      slownessDissatisfaction: 0.2,
    });

    expect(title).toContain("slow streams (free users are less sensitive)");
    expect(title).toContain("weak brand patience");
  });

  it("falls back to allowance copy when plan stats have not settled", () => {
    expect(
      planDissatisfactionChipTitle({
        isFree: true,
        dissatisfaction: 0.4,
        allowanceFallback: 0.4,
        allowanceFallbackLabel: "Free users expect at least 1M tokens/month.",
      }),
    ).toBe("Free users expect at least 1M tokens/month.");
  });
});
