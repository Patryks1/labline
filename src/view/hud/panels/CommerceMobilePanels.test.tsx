import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createGame } from "../../../sim/createGame";
import { useGameStore } from "../../../store/gameStore";
import { useUiStore } from "../../../store/uiStore";
import { MarketPanel } from "./MarketPanel";
import { OrgPanel } from "./OrgPanel";
import { RivalIntelPanel } from "./RivalIntelPanel";
import { StatsPanel } from "./StatsPanel";

describe("commerce panels on portrait and landscape phones", () => {
  it("keeps market decisions visible and puts reach and operations behind disclosures", () => {
    useGameStore.setState({ state: createGame(81_101) });

    const markup = renderToStaticMarkup(createElement(MarketPanel));

    expect(markup).toContain('data-mobile-summary="market-position"');
    expect(markup).toContain("Share, demand, and products.");
    expect(markup).toContain("Market reach");
    expect(markup).toContain("Operational detail");
    expect(markup).not.toContain("<details open");
  });

  it("leads finance with daily P&L and collapses historical and forensic ledgers", () => {
    useGameStore.setState({ state: createGame(81_102) });

    const markup = renderToStaticMarkup(createElement(StatsPanel));

    expect(markup).toContain('data-mobile-summary="daily-pnl"');
    expect(markup).toContain("Cash, runway, and daily profit.");
    expect(markup).toContain("Money history");
    expect(markup).toContain("Revenue ledger");
    expect(markup).toContain("Cost ledger");
    expect(markup).not.toContain("<details open");
  });

  it("uses summary cards through the landscape-phone breakpoint before the rival table", () => {
    const state = createGame(81_103);
    useGameStore.setState({ state });
    useUiStore.getState().setSelectedRivalId(state.rivals[0]?.id ?? null);

    const markup = renderToStaticMarkup(createElement(RivalIntelPanel));

    expect(markup).toContain('data-testid="rival-public-model-mobile-list"');
    expect(markup).toContain('data-testid="rival-public-model-desktop-table"');
    expect(markup).toContain("space-y-2 lg:hidden");
    expect(markup).toContain("hidden overflow-x-auto overscroll-x-contain");
    expect(markup).toContain("lg:block");
    expect(markup).toContain("Compare public rival signals.");
  });

  it("keeps marketing budget primary and collapses campaign diagnostics", () => {
    useGameStore.setState({ state: createGame(81_104) });

    const markup = renderToStaticMarkup(
      createElement(OrgPanel, { workspace: "marketing" }),
    );

    expect(markup).toContain('data-mobile-summary="marketing-performance"');
    expect(markup).toContain("Spend and customer growth.");
    expect(markup).toContain("Campaign diagnostics");
    expect(markup).not.toContain("<details open");
  });

  it("keeps capital actions first while buybacks and specialist offers stay optional", () => {
    useGameStore.setState({ state: createGame(81_105) });

    const markup = renderToStaticMarkup(
      createElement(OrgPanel, { workspace: "capital" }),
    );

    expect(markup).toContain("Raise, borrow, and protect ownership.");
    expect(markup).toContain('data-testid="capital-buyback-details"');
    expect(markup).toContain('data-testid="specialist-bank-details"');
    expect(markup).toContain("Equity term sheets");
    expect(markup).not.toContain("<details open");
  });
});
