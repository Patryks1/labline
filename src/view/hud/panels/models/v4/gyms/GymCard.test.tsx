import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { useGameStore } from "../../../../../../store/gameStore";
import { money } from "../../../../format";
import type { GymCardVM } from "../../viewModels/types";
import { GymCard } from "./GymCard";
import { gymNextTierMonthly } from "./gymModel";

function vm(partial: Partial<GymCardVM> = {}): GymCardVM {
  return {
    id: "gym-code",
    kind: "code",
    tier: 0,
    quality: 0,
    tasksPerDay: 12,
    researchers: 0,
    spareResearchers: 0,
    researchShare: 0,
    spareResearchShare: 0.25,
    budgetPerDay: 0,
    yieldPerDay: 0,
    yieldUnit: "tasks",
    bottleneck: "researchers",
    pausedForCash: false,
    auditShare: 0,
    synthUnlocked: false,
    teachers: [],
    poolKind: "verifiableTasks",
    poolAmount: 200,
    poolQuality: 0.4,
    cleanCash: 25_000,
    canClean: true,
    nextTierMonthly: 150_000,
    needsGrader: true,
    ...partial,
  };
}

describe("GymCard", () => {
  it("shows 0% quality, sliders, and auto-tier copy instead of an upgrade button", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(GymCard, { vm: vm(), onSelect: vi.fn() }),
    );
    expect(markup).toContain("Code gym");
    expect(markup).toContain("verifiable programming tasks");
    expect(markup).toContain("0%");
    expect(markup).toContain('data-gym-slider="gym-code-researchers"');
    expect(markup).toContain('data-gym-slider="gym-code-compute"');
    expect(markup).toContain('data-gym-slider="gym-code-budget"');
    expect(markup).toContain('data-gym-slider="gym-code-audit"');
    expect(markup).toContain("Need a researcher");
    expect(markup).toContain("Unlock Synthetic Generators");
    expect(markup).toContain(`Campus grows automatically at ${money(gymNextTierMonthly(0)!)}/mo`);
    expect(markup).not.toContain("data-gym-upgrade-cost");
    expect(markup).not.toContain("Upgrade $");
  });

  it("caps the researcher slider at spare HQ headcount", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(GymCard, {
        vm: vm({ researchers: 0, spareResearchers: 0 }),
        onSelect: vi.fn(),
      }),
    );
    expect(markup).toContain('data-gym-slider="gym-code-researchers"');
    expect(markup).toMatch(/max="0"/);
  });

  it("opens the researcher slider when HQ has spare headcount", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(GymCard, {
        vm: vm({ researchers: 0, spareResearchers: 4 }),
        onSelect: vi.fn(),
      }),
    );
    expect(markup).toContain('max="4"');
  });

  it("exposes an AI teacher select once synthetic data is unlocked", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(GymCard, {
        vm: vm({
          synthUnlocked: true,
          teachers: [{ id: "ckpt-a", name: "Atlas 7B" }],
        }),
        onSelect: vi.fn(),
      }),
    );
    expect(markup).toContain('data-gym-teacher="gym-code"');
    expect(markup).toContain("Atlas 7B");
    expect(markup).not.toContain("Unlock Synthetic Generators");
  });

  it("offers a pool-clean action with the stored grade", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(GymCard, { vm: vm(), onSelect: vi.fn() }),
    );
    expect(markup).toContain("Pool grade 40%");
    expect(markup).toContain('data-gym-clean="gym-code"');
    expect(markup).toContain(money(25_000));
  });
});
