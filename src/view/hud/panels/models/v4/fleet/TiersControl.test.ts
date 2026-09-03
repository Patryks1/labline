import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { useGameStore } from "../../../../../../store/gameStore";
import { nextTiers } from "./fleetModel";
import { TiersControl } from "./TiersControl";

describe("nextTiers", () => {
  const base = [
    { budget: 1 as const, served: true },
    { budget: 2 as const, served: true },
    { budget: 8 as const, served: false },
  ];

  it("returns null for budgets that are not present", () => {
    expect(nextTiers(base, 20, true)).toBeNull();
  });

  it("refuses to turn off the last served tier", () => {
    expect(nextTiers([{ budget: 1, served: true }], 1, false)).toBeNull();
    expect(nextTiers(base, 1, false)).not.toBeNull();
  });

  it("toggles a present budget", () => {
    expect(nextTiers(base, 8, true)?.find((tier) => tier.budget === 8)?.served).toBe(true);
    expect(nextTiers(base, 2, false)?.find((tier) => tier.budget === 2)?.served).toBe(false);
  });
});

describe("TiersControl", () => {
  it("only renders trained budgets and protects the last served tier", () => {
    useGameStore.setState({ state: createGame(42) });
    const markup = renderToStaticMarkup(
      createElement(TiersControl, {
        endpointId: "ep-1",
        tiers: [
          { budget: 1, served: true },
          { budget: 8, served: false },
        ],
      }),
    );
    expect(markup).toContain("data-tiers-control");
    expect(markup).toContain("models-v4-actions");
    expect(markup).toContain("At least one served tier must remain on");
    expect(markup).toContain("×1");
    expect(markup).toContain("×8");
    expect(markup).not.toContain("×2");
    expect(markup).not.toContain("×4");
    expect(markup).not.toContain("×12");
    expect(markup).not.toContain("×20");
    expect(markup).not.toContain("×100");
    expect(markup).not.toContain("Needs Thinking-Tier RL");
    expect(markup).not.toContain("Not trained");
  });
});
