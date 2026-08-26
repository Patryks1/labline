import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createGame } from "../../../sim/createGame";
import { buildScaledModel } from "../../../sim/balance/modelBuild";
import { instantRecipe } from "../../../sim/balance/modelProduct";
import {
  DATA_DOMAINS,
  dataOfferPurchasableMTok,
  ensureDataMarket,
  estimateSynthBudget,
} from "../../../sim/systems/data";
import { useGameStore } from "../../../store/gameStore";
import {
  DATA_COMPACT_SECONDARY_CLASS,
  DATA_MARKET_FILTER_GRID_CLASS,
  DATA_MARKET_FILTER_SELECT_CLASS,
  DATA_PANEL_SWIPE_CLASS,
  DATA_WIDE_SECONDARY_CLASS,
  DataPanel,
  SynthTeacherRoutingTable,
} from "./DataPanel";

describe("DataPanel market wiring", () => {
  it("renders the data panel with a market tab entry point", () => {
    useGameStore.setState({ state: createGame(6_407) });
    const markup = renderToStaticMarkup(createElement(DataPanel));
    expect(markup).toContain("Data");
    expect(markup).toContain("Market");
    expect(markup).toContain("Corpus");
    expect(markup).toContain("hud-input");
    expect(markup).toContain("hud-button");
  });

  it("uses shared controls for source and market data selectors", () => {
    useGameStore.setState({ state: createGame(6_407) });

    const Panel = DataPanel as unknown as (props: {
      initialTab?: "stocks" | "sources" | "market" | "synth";
    }) => ReactElement;
    const sourcesMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "sources" }),
    );
    const marketMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "market" }),
    );

    expect(sourcesMarkup).toContain("hud-button");
    expect(marketMarkup).toContain("Data type filter");
    expect(marketMarkup).toContain("hud-button");
    expect(DATA_MARKET_FILTER_GRID_CLASS).toContain("xl:grid-cols-3");
    expect(DATA_MARKET_FILTER_GRID_CLASS).toContain("orientation:landscape");
    expect(DATA_MARKET_FILTER_GRID_CLASS).toContain("max-h-[44vh]");
    expect(DATA_MARKET_FILTER_GRID_CLASS).not.toContain("lg:grid-cols-4");
    expect(DATA_MARKET_FILTER_SELECT_CLASS).toContain("w-full");
    expect(DATA_MARKET_FILTER_SELECT_CLASS).toContain("min-h-11");
    expect(marketMarkup).toContain("touch-auto flex-nowrap");
  });

  it("prioritizes mobile KPIs and collapses secondary stock detail", () => {
    useGameStore.setState({ state: createGame(6_411) });
    const markup = renderToStaticMarkup(createElement(DataPanel));

    expect(markup).toContain('data-testid="data-critical-metrics"');
    expect(markup).toContain('data-testid="data-mobile-secondary"');
    expect(markup).toContain('data-testid="data-touch-tabs"');
    expect(markup).toContain('data-testid="data-swipe-surface"');
    expect(markup).toContain("Corpus, buying &amp; synthetic data.");
    expect(markup).toContain("More corpus stats");
    expect(markup).toContain("Collection breakdown");
    expect(markup).toContain("Stock details");
    expect(markup).toContain("touch-auto");
    expect(markup).toContain("touch-pan-y");
    expect(markup).not.toContain("<details open");
    expect(DATA_COMPACT_SECONDARY_CLASS).toContain("sm:hidden");
    expect(DATA_COMPACT_SECONDARY_CLASS).toContain("orientation:landscape");
    expect(DATA_COMPACT_SECONDARY_CLASS).toContain("max-height:600px");
    expect(DATA_COMPACT_SECONDARY_CLASS).toContain("max-width:1180px");
    expect(DATA_WIDE_SECONDARY_CLASS).toContain("sm:block");
    expect(DATA_WIDE_SECONDARY_CLASS).toContain("orientation:landscape");
    expect(DATA_PANEL_SWIPE_CLASS).toContain("touch-pan-y");
  });

  it("keeps secondary source, market, and synth controls behind compact disclosures", () => {
    useGameStore.setState({ state: createGame(6_412) });
    const Panel = DataPanel as unknown as (props: {
      initialTab?: "stocks" | "sources" | "market" | "synth";
    }) => ReactElement;

    const sourcesMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "sources" }),
    );
    const marketMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "market" }),
    );
    const synthMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "synth" }),
    );

    expect(sourcesMarkup).toContain("Top domains");
    expect(marketMarkup).toContain("Last market fill");
    expect(marketMarkup).toContain("Supplier contracts");
    expect(marketMarkup).toContain("touch-auto flex-nowrap");
    expect(synthMarkup).toContain("Generation detail");
    expect(synthMarkup).toContain("Corpus routing");
    expect(synthMarkup).toContain("min-h-11 w-full");
    expect(sourcesMarkup).not.toContain("<details open");
    expect(marketMarkup).not.toContain("<details open");
    expect(synthMarkup).not.toContain("<details open");
  });

  it("surfaces hygiene consequences, domain buying, and compact market actions", () => {
    useGameStore.setState({ state: createGame(6_409) });
    const Panel = DataPanel as unknown as (props: {
      initialTab?: "stocks" | "sources" | "market" | "synth";
    }) => ReactElement;
    const stocksMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "stocks" }),
    );
    const sourcesMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "sources" }),
    );
    const marketMarkup = renderToStaticMarkup(
      createElement(Panel, { initialTab: "market" }),
    );

    expect(stocksMarkup).toContain("Hygiene load");
    expect(stocksMarkup).toContain(">Buy<");
    expect(stocksMarkup).toContain("hud-button--danger");
    expect(stocksMarkup).toContain(">Prune all<");
    expect(sourcesMarkup).not.toContain("Watch:");
    expect(marketMarkup).toContain("Buy all");
    expect(marketMarkup).not.toContain("Buy all matching");
    expect(marketMarkup).not.toContain("Buy amount ·");
  });

  it("wires store lot buys to the instant settlement path", () => {
    let state = ensureDataMarket(createGame(6_407));
    const offer = state.dataMarket!.offers.find(
      (candidate) => candidate.mTokLeft > 0,
    );
    expect(offer).toBeDefined();
    useGameStore.setState({ state });

    const cashBefore = state.player.cash;
    const amount = dataOfferPurchasableMTok(offer!);
    const dataOrdersBefore = state.worldMarkets.orders.filter(
      (order) => order.kind === "data",
    ).length;

    useGameStore.getState().buyDataLotAmount(offer!.id, amount);
    state = useGameStore.getState().state;

    expect(state.player.cash).toBeLessThan(cashBefore);
    expect(
      state.dataMarket!.offers.find((row) => row.id === offer!.id)!.mTokLeft,
    ).toBeLessThan(offer!.mTokLeft);
    // Instant path must not queue a delayed world-market data order.
    expect(
      state.worldMarkets.orders.filter((order) => order.kind === "data").length,
    ).toBe(dataOrdersBefore);
  });

  it("exposes supplier negotiation lifecycle actions on the store", () => {
    const store = useGameStore.getState();
    expect(typeof store.buyAllFilteredDataLots).toBe("function");
    expect(typeof store.counterDataSupplierOffer).toBe("function");
    expect(typeof store.cancelDataSupplierContract).toBe("function");
    expect(typeof store.acceptDataSupplierOffer).toBe("function");
    expect(typeof store.proposeDataSupplierTerms).toBe("function");
    expect(typeof store.acceptDataSupplierCounter).toBe("function");
    expect(typeof store.rejectDataSupplierCounter).toBe("function");
  });

  it("renders one accessible teacher route per corpus with causal unit economics", () => {
    const state = createGame(6_408);
    const model = buildScaledModel({
      id: "ui-synth-teacher",
      name: "Glyph Route",
      paramsB: 3,
      family: "omni",
      day: state.day,
      dataCoverage: 3,
      dataQuality: 78,
      postTrain: "tools",
      release: "released",
      shipped: true,
    });
    model.productProfile = {
      ...model.productProfile!,
      effortRecipes: [
        instantRecipe(),
        {
          id: "think",
          name: "Think",
          kind: "trained",
          thinkingTokenMult: 2.5,
          trainPfDays: 50,
          trainCash: 1_000_000,
          trained: true,
          quality: 0.72,
          served: true,
        },
      ],
      defaultEffortId: "instant",
    };
    state.player.models = [model];
    state.player.researchUnlocked = [
      ...state.player.researchUnlocked,
      "data_synth",
    ];
    const estimate = estimateSynthBudget(
      state,
      0.25,
      { code: model.id },
      { code: "think" },
    );
    const picks = Object.fromEntries(
      DATA_DOMAINS.map((domain) => [domain, ""]),
    ) as Record<(typeof DATA_DOMAINS)[number], string>;
    picks.code = model.id;
    const effortPicks = { ...picks, code: "think" };
    const markup = renderToStaticMarkup(
      createElement(SynthTeacherRoutingTable, {
        state,
        estimate,
        picks,
        effortPicks,
        onPick: () => undefined,
      }),
    );

    expect(markup).toContain("Corpus routing");
    expect(markup).toContain("teacher size");
    expect(markup).toContain("Teacher for Code corpus");
    expect(markup).toContain("Teacher for Video corpus");
    expect(markup).toContain("Auto · Glyph Route · Instant");
    expect(markup).toContain('value="ui-synth-teacher::effort::think"');
    expect(markup).toContain('class="bg-void" selected=""');
    expect(markup).toContain("Glyph Route · Think · cap");
    expect(markup).toContain("× billed");
    expect(markup).toContain("× PF intensity");
    expect(markup).toContain("/MTok");
    expect(markup).toContain("kWh/MTok");
    expect(markup).toContain("sm:flex-row");
    expect(markup).toContain("min-[520px]:grid-cols-");
    expect(markup).toContain("min-h-11 w-full");
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
  });
});
