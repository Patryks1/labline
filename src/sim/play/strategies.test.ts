import { describe, expect, it } from "vitest";
import { runStrategyBot, STRATEGY_IDS } from "./strategies";

describe("strategy bots", () => {
  it("runs every named strategy deterministically for a short horizon", () => {
    for (const strategy of STRATEGY_IDS) {
      const first = runStrategyBot({ strategy, seed: 21, maxDays: 8 });
      const again = runStrategyBot({ strategy, seed: 21, maxDays: 8 });
      expect(first.strategy).toBe(strategy);
      expect(first.daysRun).toBe(again.daysRun);
      expect(first.final.player.cash).toBe(again.final.player.cash);
      expect(first.bankrupt).toBe(again.bankrupt);
    }
  });
});
