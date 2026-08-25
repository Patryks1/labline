import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  MAX_PLANS,
  createPlan,
  unlockedPlanPrecisions,
} from "./plans";

describe("subscription plan limits", () => {
  it("allows a normal plan creation below the cap", () => {
    const state = createGame(8_101);
    const next = createPlan(state, {
      name: "Team",
      pricePerMonth: 45,
      usageMultiplier: 1,
    });

    expect(next.player.pricing.plans).toHaveLength(
      state.player.pricing.plans.length + 1,
    );
    expect(next.player.pricing.plans.at(-1)?.name).toBe("Team");
    expect(next.player.pricing.plans.at(-1)?.servePrecision).toBe("fp32");
  });

  it("starts with FP32 serving and research-unlocks FP16 then BF16", () => {
    expect(unlockedPlanPrecisions([])).toEqual(["fp32"]);
    expect(unlockedPlanPrecisions(["opt_fp16"])).toEqual(["fp32", "fp16"]);
    expect(unlockedPlanPrecisions(["opt_fp16", "opt_mixed"])).toEqual([
      "fp32",
      "fp16",
      "bf16",
    ]);
  });

  it("rejects the ninth plan in simulation logic and records feedback", () => {
    let state = createGame(8_102);
    while (state.player.pricing.plans.length < MAX_PLANS) {
      state = createPlan(state, {
        name: `Custom ${state.player.pricing.plans.length}`,
        pricePerMonth: 10 + state.player.pricing.plans.length,
        usageMultiplier: 1,
      });
    }

    const beforePlans = state.player.pricing.plans;
    const blocked = createPlan(state, {
      name: "Rejected",
      pricePerMonth: 999,
      usageMultiplier: 5,
    });

    expect(beforePlans).toHaveLength(MAX_PLANS);
    expect(blocked.player.pricing.plans).toEqual(beforePlans);
    expect(blocked.alerts[0]?.severity).toBe("warn");
    expect(blocked.alerts[0]?.message).toContain(
      `Plan limit reached (${MAX_PLANS})`,
    );
  });
});
