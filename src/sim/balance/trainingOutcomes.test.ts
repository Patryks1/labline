import { describe, expect, it } from "vitest";
import { rollTrainingOutcome } from "./trainingV3";

describe("bounded training RNG", () => {
  it("lands most runs in the normal band and stays deterministic", () => {
    const counts = { normal: 0, stumble: 0, breakthrough: 0, failure: 0 };
    for (let seed = 1; seed <= 2_000; seed++) {
      const first = rollTrainingOutcome({
        seed,
        quality: 70,
        verifyShare: 0.18,
        engineers: 6,
        researchCount: 8,
        day: 40,
      });
      const again = rollTrainingOutcome({
        seed,
        quality: 70,
        verifyShare: 0.18,
        engineers: 6,
        researchCount: 8,
        day: 40,
      });
      expect(again).toEqual(first);
      counts[first.kind] += 1;
    }
    expect(counts.normal / 2_000).toBeGreaterThan(0.75);
    expect(counts.normal / 2_000).toBeLessThan(0.9);
    expect(counts.breakthrough / 2_000).toBeGreaterThan(0.04);
    expect(counts.breakthrough / 2_000).toBeLessThan(0.12);
    expect((counts.stumble + counts.failure) / 2_000).toBeGreaterThan(0.05);
    expect((counts.stumble + counts.failure) / 2_000).toBeLessThan(0.16);
  });
});
