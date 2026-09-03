import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { emptyTrainingState, withTrainingState } from "../../../../../../sim/training/state";
import type { TrainingState } from "../../../../../../sim/training/types";
import { useGameStore } from "../../../../../../store/gameStore";
import type { EndpointCardVM, FleetVM } from "../../viewModels/types";
import { FleetBoard } from "./FleetBoard";

function seedStore(training?: TrainingState) {
  const game = createGame(42);
  const next = training
    ? withTrainingState(game, game.playerLabId, training)
    : game;
  useGameStore.setState({ state: next });
  return next;
}

function vm(partial: Partial<EndpointCardVM> & Pick<EndpointCardVM, "id" | "status">): EndpointCardVM {
  return {
    name: partial.id,
    policy: "single",
    memberNames: ["Atlas"],
    revenuePerDay: 1000,
    share: 0.1,
    tokPerSec: 80,
    agingPct: 0.2,
    tiers: [{ budget: 1, served: true }],
    hbmGB: 14,
    publicScores: { overall: 50 },
    ...partial,
  };
}

const callbacks = {
  onOpenRouter: vi.fn(),
  onOpenSunset: vi.fn(),
  onSelect: vi.fn(),
};

describe("FleetBoard", () => {
  it("orders live then sunset then retired", () => {
    seedStore();
    const fleet: FleetVM = {
      totalRevenuePerDay: 9000,
      totalHbmGB: 40,
      endpoints: [
        vm({ id: "retired-1", status: "retired" }),
        vm({ id: "sunset-1", status: "sunset", sunsetDaysLeft: 12 }),
        vm({ id: "live-1", status: "live" }),
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(FleetBoard, { ...callbacks, vm: fleet }),
    );
    const liveAt = markup.indexOf('data-endpoint-card="live-1"');
    const sunsetAt = markup.indexOf('data-endpoint-card="sunset-1"');
    const retiredAt = markup.indexOf('data-endpoint-card="retired-1"');
    expect(liveAt).toBeGreaterThan(-1);
    expect(sunsetAt).toBeGreaterThan(liveAt);
    expect(retiredAt).toBeGreaterThan(sunsetAt);
    expect(markup).toContain("data-retired-disclosure");
  });

  it("disables New router with fewer than two checkpoints", () => {
    seedStore(emptyTrainingState());
    const markup = renderToStaticMarkup(
      createElement(FleetBoard, { ...callbacks, vm: { endpoints: [], totalRevenuePerDay: 0, totalHbmGB: 0 } }),
    );
    expect(markup).toContain("New router");
    expect(markup).toContain("Need at least two kept or released checkpoints");
    expect(markup).toContain("Release a checkpoint from the Pipeline to create your first endpoint.");
  });
});
