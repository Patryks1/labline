import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { useGameStore } from "../../../../../../store/gameStore";
import { GYM_KINDS } from "./gymModel";
import { GymsBoard } from "./GymsBoard";
import type { GymCardVM, GymsVM } from "../../viewModels/types";

function gym(kind: GymCardVM["kind"], id: string): GymCardVM {
  return {
    id,
    kind,
    tier: 0,
    quality: 0,
    tasksPerDay: 12,
    researchers: 0,
    spareResearchers: 0,
    researchShare: 0,
    spareResearchShare: 0.25,
    budgetPerDay: 0,
    yieldPerDay: 0,
    yieldUnit: kind === "safety" ? "preferenceMTok" : "tasks",
    bottleneck: "researchers",
    pausedForCash: false,
    auditShare: 0,
    synthUnlocked: false,
    teachers: [],
    poolKind:
      kind === "safety"
        ? "preferenceMTok"
        : kind === "agentic"
          ? "toolTrajectories"
          : "verifiableTasks",
    poolAmount: 0,
    poolQuality: 0,
    cleanCash: 0,
    canClean: false,
    nextTierMonthly: 150_000,
    needsGrader: true,
  };
}

describe("GymsBoard", () => {
  it("renders five slots as build cards when no gyms exist", () => {
    useGameStore.setState({ state: createGame(42) });
    const vm: GymsVM = {
      gyms: [],
      pools: {
        instructionMTok: 1.5,
        preferenceMTok: 0.4,
        verifiableTasks: 120,
        toolTrajectories: 80,
      },
    };
    const markup = renderToStaticMarkup(
      createElement(GymsBoard, { onSelect: vi.fn(), vm }),
    );
    expect(markup).toContain("data-gym-slots");
    for (const kind of GYM_KINDS) {
      expect(markup).toContain(`data-build-gym="${kind}"`);
    }
    expect(markup).toContain("Build gym");
    expect(markup).toContain("Instruction");
    expect(markup).not.toContain("data-gym-data-strip");
    expect(markup).not.toContain("Synthesize from teacher");
    expect(markup).not.toContain("+1 MTok instruction");
  });

  it("renders an existing gym card in its slot and build cards for the rest", () => {
    useGameStore.setState({ state: createGame(42) });
    const vm: GymsVM = {
      gyms: [gym("code", "gym-code")],
      pools: {
        instructionMTok: 0,
        preferenceMTok: 0,
        verifiableTasks: 0,
        toolTrajectories: 0,
      },
    };
    const markup = renderToStaticMarkup(
      createElement(GymsBoard, { onSelect: vi.fn(), vm }),
    );
    expect(markup).toContain('data-gym-card="gym-code"');
    expect(markup).not.toContain('data-build-gym="code"');
    expect(markup).toContain('data-build-gym="math"');
    expect(markup).toContain('data-build-gym="science"');
    expect(markup).toContain('data-build-gym="agentic"');
    expect(markup).toContain('data-build-gym="safety"');
  });
});
