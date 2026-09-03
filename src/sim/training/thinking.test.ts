import { describe, expect, it } from "vitest";
import {
  canonicalizeTierBudget,
  defaultTiers,
  extraThinkingBudgetsToTrain,
  mergeTrainedTiers,
  normalizeThinkingTiers,
  scaleEvalCost,
  servedThinkingCostMult,
  servedThinkingLatencyMult,
  thinkingCostMult,
  thinkingLockReason,
  thinkingTrainPfMult,
  thinkingUnlocked,
  trainedThinkingBudgets,
  tierLabel,
  unlockedThinkingTiers,
} from "./thinking";

describe("thinking budgets", () => {
  it("labels the Instant through Ultra ladder", () => {
    expect(tierLabel(1)).toBe("Instant ×1");
    expect(tierLabel(2)).toBe("Low ×2");
    expect(tierLabel(4)).toBe("Medium ×4");
    expect(tierLabel(8)).toBe("High ×8");
    expect(tierLabel(12)).toBe("xHigh ×12");
    expect(tierLabel(20)).toBe("Max ×20");
    expect(tierLabel(100)).toBe("Ultra ×100");
  });

  it("maps legacy Think ×3 onto Low ×2", () => {
    expect(canonicalizeTierBudget(3)).toBe(2);
    expect(tierLabel(3)).toBe("Low ×2");
  });

  it("keeps Instant-only until extra heads are trained", () => {
    expect(defaultTiers()).toEqual([{ budget: 1, served: true }]);
    expect(unlockedThinkingTiers().map((tier) => tier.budget)).toEqual([
      1, 2, 4, 8, 12, 20, 100,
    ]);
    expect(thinkingUnlocked({ tiers: defaultTiers() }, 1)).toBe(true);
    expect(thinkingUnlocked({ tiers: defaultTiers() }, 8)).toBe(false);
    expect(thinkingUnlocked({ tiers: unlockedThinkingTiers() }, 100)).toBe(true);
  });

  it("keeps Instant-only when extras were only listed, not served or reasoned", () => {
    expect(
      normalizeThinkingTiers([
        { budget: 1, served: true },
        { budget: 3, served: false },
        { budget: 8, served: false },
        { budget: 20, served: false },
      ]),
    ).toEqual([{ budget: 1, served: true }]);
  });

  it("keeps listed rungs after reasoning and remaps Think ×3", () => {
    expect(
      normalizeThinkingTiers(
        [
          { budget: 1, served: true },
          { budget: 3, served: false },
          { budget: 8, served: false },
          { budget: 20, served: false },
        ],
        { stages: { reasoning: { effect: 0.4, runs: 1 } } },
      ),
    ).toEqual([
      { budget: 1, served: true },
      { budget: 2, served: false },
      { budget: 8, served: false },
      { budget: 20, served: false },
    ]);
    expect(
      normalizeThinkingTiers([
        { budget: 1, served: true },
        { budget: 3, served: true },
        { budget: 8, served: false },
        { budget: 20, served: false },
      ]),
    ).toEqual([
      { budget: 1, served: true },
      { budget: 2, served: true },
      { budget: 8, served: false },
      { budget: 20, served: false },
    ]);
  });

  it("charges extra reasoning PF for untrained thinking heads", () => {
    expect(thinkingTrainPfMult([])).toBe(1);
    expect(thinkingTrainPfMult([1])).toBe(1);
    expect(thinkingTrainPfMult([8])).toBeCloseTo(Math.sqrt(8));
    expect(thinkingTrainPfMult([8, 8, 100])).toBeCloseTo(Math.sqrt(8) + Math.sqrt(100) - 1);
    expect(
      extraThinkingBudgetsToTrain({ tiers: defaultTiers() }, [1, 8, 8, 100]),
    ).toEqual([8, 100]);
    expect(
      extraThinkingBudgetsToTrain({ tiers: mergeTrainedTiers(defaultTiers(), [8]) }, [8, 20]),
    ).toEqual([20]);
    expect(trainedThinkingBudgets({ tiers: mergeTrainedTiers(defaultTiers(), [8]) })).toEqual([
      1, 8,
    ]);
    expect(thinkingLockReason({ tiers: defaultTiers() }, 8, false)).toMatch(/Thinking-Tier RL/);
    expect(thinkingLockReason({ tiers: defaultTiers() }, 8, true)).toMatch(/Not trained/);
    expect(thinkingLockReason({ tiers: mergeTrainedTiers(defaultTiers(), [8]) }, 8, true)).toBeNull();
  });

  it("scales eval cash linearly and days with sqrt of the budget", () => {
    const base = { cash: 10_000, days: 4, sigma: 2 };
    expect(scaleEvalCost(base, 1)).toEqual(base);
    expect(scaleEvalCost(base, 4)).toEqual({ cash: 40_000, days: 8, sigma: 2 });
    expect(scaleEvalCost({ cash: 0, days: 1, sigma: 4 }, 100)).toEqual({
      cash: 0,
      days: 10,
      sigma: 4,
    });
  });

  it("prices hosting at the peak served budget", () => {
    const tiers = [
      { budget: 1 as const, served: true },
      { budget: 20 as const, served: true },
      { budget: 100 as const, served: false },
    ];
    expect(thinkingCostMult(20)).toBe(20);
    expect(servedThinkingCostMult(tiers)).toBe(20);
    expect(servedThinkingLatencyMult(tiers)).toBe(Math.sqrt(20));
  });
});
