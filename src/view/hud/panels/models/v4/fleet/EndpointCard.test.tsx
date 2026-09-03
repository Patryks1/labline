import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { useGameStore } from "../../../../../../store/gameStore";
import type { EndpointCardVM } from "../../viewModels/types";
import { EndpointCard } from "./EndpointCard";

function vm(partial: Partial<EndpointCardVM> = {}): EndpointCardVM {
  return {
    id: "ep-live",
    name: "Helios",
    policy: "domain",
    memberNames: ["Helios-A", "Helios-B"],
    status: "live",
    revenuePerDay: 12_500,
    share: 0.18,
    tokPerSec: 420,
    agingPct: 0.22,
    tiers: [
      { budget: 1, served: true },
      { budget: 2, served: true },
    ],
    hbmGB: 28,
    publicScores: { overall: 61, code: 74, math: 58, language: 49 },
    openWeights: false,
    ...partial,
  };
}

describe("EndpointCard", () => {
  it("renders numbers, pills, and two-step confirm actions", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(EndpointCard, {
        vm: vm(),
        selected: true,
        onSelect: vi.fn(),
        onOpenRouter: vi.fn(),
        onOpenSunset: vi.fn(),
      }),
    );
    expect(markup).toContain("Helios");
    expect(markup).toContain("Domain router");
    expect(markup).toContain("Helios-A, Helios-B");
    expect(markup).toContain("Live");
    expect(markup).toContain("$12.50K");
    expect(markup).toContain("18.00%");
    expect(markup).toContain("420");
    expect(markup).toContain("28.00 GB");
    expect(markup).toContain("overall 61");
    expect(markup).toContain("code 74");
    expect(markup).toContain("Members");
    expect(markup).toContain("Sunset");
    expect(markup).toContain("Plans");
    expect(markup).toContain('data-two-step="retire"');
    expect(markup).toContain("Retire");
    expect(markup).toContain("Copy formula");
    expect(markup).toContain('data-copy-formula="ep-live"');
    expect(markup).toContain('data-two-step="open-source"');
    expect(markup).toContain("Open source");
    expect(markup).not.toContain("Confirm retire");
    expect(markup).not.toContain("Confirm open source");
    expect(markup).toContain("×1");
    expect(markup).toContain("×2");
    expect(markup).not.toContain(">Select</button>");
    expect(markup).not.toContain(">Selected</button>");
    expect(markup).toContain('data-selected="true"');
  });

  it("locks copy formula once the endpoint is fully aged", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(EndpointCard, {
        vm: vm({ agingPct: 1 }),
        selected: false,
        onSelect: vi.fn(),
        onOpenRouter: vi.fn(),
        onOpenSunset: vi.fn(),
      }),
    );
    expect(markup).toContain("This recipe is too stale to start a new run.");
    expect(markup).toContain("disabled");
  });

  it("shows sunset days remaining", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(EndpointCard, {
        vm: vm({ status: "sunset", sunsetDaysLeft: 11, id: "ep-sun" }),
        selected: false,
        onSelect: vi.fn(),
        onOpenRouter: vi.fn(),
        onOpenSunset: vi.fn(),
      }),
    );
    expect(markup).toContain("11d left");
    expect(markup).not.toContain("Sunset</button>");
  });
});
