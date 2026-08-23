import { describe, expect, it } from "vitest";
import {
  demandInertiaShare,
  expectedRoutedValue,
  routerInventedCapability,
} from "./routerValue";

describe("routers and demand inertia", () => {
  it("scores routes as quality minus cost, latency, misroute and overhead", () => {
    expect(
      expectedRoutedValue({
        taskQuality: 80,
        servingCost: 10,
        latencyPenalty: 5,
        misroutingRisk: 4,
        routerOverhead: 1,
      }),
    ).toBe(60);
  });

  it("cannot invent a modality absent from every constituent model", () => {
    expect(
      routerInventedCapability(
        [{ io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 10 } }],
        "video",
      ),
    ).toBe(false);
    expect(
      routerInventedCapability(
        [{ io: { inputs: { text: 50, video: 40 }, outputs: { text: 50 }, tools: 0 } }],
        "video",
      ),
    ).toBe(true);
  });

  it("prevents overnight market share jumps", () => {
    const next = demandInertiaShare({
      previousShare: 0.8,
      targetShare: 0.1,
      switchingFriction: 0.8,
    });
    expect(next).toBeCloseTo(0.66, 5);
    expect(next).toBeGreaterThan(0.1);
  });
});
