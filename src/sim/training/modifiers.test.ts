import { describe, expect, it } from "vitest";
import { getResearchNode } from "../balance/research";
import { createGame } from "../createGame";
import type { ResearchNodeDef } from "../types";
import {
  aggregateModifiers,
  baselineModifiers,
  computeEquivalent,
  describeModifiers,
  hasUnlock,
  modifiersForLab,
} from "./modifiers";
import { completeResearchNode } from "../systems/research";

function node(
  id: string,
  effects: ResearchNodeDef["effects"],
): ResearchNodeDef {
  return {
    id,
    trunk: "optimize",
    name: id,
    description: id,
    costPfDays: 1,
    daysMin: 1,
    prereqs: [],
    effects,
  };
}

describe("aggregateModifiers", () => {
  it("returns baseline when no nodes contribute", () => {
    expect(aggregateModifiers([], {})).toEqual(baselineModifiers());
    expect(
      aggregateModifiers([node("empty", { servingEfficiency: 0.2 })], {
        empty: 1,
      }),
    ).toEqual(baselineModifiers());
  });

  it("multiplies value^rank, sums ceilingLift, unions unlocks", () => {
    const a = node("a", {
      paramEfficiency: 0.9,
      computeThroughput: 1.1,
      ceilingLift: 2,
      unlock: ["moe"],
    });
    const b = node("b", {
      paramEfficiency: 0.8,
      computeThroughput: 1.2,
      ceilingLift: 0.5,
      unlock: ["distill", "moe"],
    });
    const once = aggregateModifiers([a, b], { a: 1, b: 1 });
    expect(once.paramEfficiency).toBeCloseTo(0.9 * 0.8);
    expect(once.computeThroughput).toBeCloseTo(1.1 * 1.2);
    expect(once.ceilingLift).toBeCloseTo(2.5);
    expect(once.unlocks.sort()).toEqual(["distill", "moe"]);

    const ranked = aggregateModifiers([a], { a: 2 });
    expect(ranked.paramEfficiency).toBeCloseTo(0.9 ** 2);
    expect(ranked.computeThroughput).toBeCloseTo(1.1 ** 2);
    expect(ranked.ceilingLift).toBeCloseTo(4);
  });

  it("adds quality from baseline and clamps to [0, 1]", () => {
    const high = aggregateModifiers(
      [node("hot", { rlQuality: 0.9, routerQuality: 0.8, verifierStrength: 0.5 })],
      { hot: 1 },
    );
    expect(high.rlQuality).toBe(1);
    expect(high.routerQuality).toBe(1);
    expect(high.verifierStrength).toBeCloseTo(0.7);

    const mild = aggregateModifiers(
      [node("warm", { rlQuality: 0.1 })],
      { warm: 2 },
    );
    expect(mild.rlQuality).toBeCloseTo(0.35 + 0.2);
  });

  it("treats a missing rank on a provided node as 1", () => {
    const m = aggregateModifiers(
      [node("x", { computeThroughput: 1.5 })],
      {},
    );
    expect(m.computeThroughput).toBeCloseTo(1.5);
  });
});

describe("modifiersForLab", () => {
  it("folds player unlocks and ranks; missing rank on an unlocked id is 1", () => {
    const state = createGame(11_001);
    const starter = modifiersForLab(state, state.playerLabId);
    expect(starter.paramEfficiency).toBeCloseTo(
      getResearchNode("dense_basics").effects.paramEfficiency ?? 1,
    );
    expect(starter.unlocks).toEqual([]);

    const withMoe = completeResearchNode(state, getResearchNode("moe_basics"));
    const after = modifiersForLab(withMoe, withMoe.playerLabId);
    expect(hasUnlock(after, "moe")).toBe(true);
    expect(after.paramEfficiency).toBeCloseTo(
      (getResearchNode("dense_basics").effects.paramEfficiency ?? 1) *
        (getResearchNode("moe_basics").effects.paramEfficiency ?? 1),
    );
  });

  it("ranks a repeatable node as value^rank for the player", () => {
    let state = createGame(11_002);
    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...new Set([...state.player.researchUnlocked, "sys_kernels"]),
        ],
      },
    };
    state = completeResearchNode(state, getResearchNode("sys_kernel_tune"));
    state = completeResearchNode(state, getResearchNode("sys_kernel_tune"));
    const m = modifiersForLab(state, state.playerLabId);
    const perRank = getResearchNode("sys_kernel_tune").effects.computeThroughput ?? 1;
    const starter = getResearchNode("dense_basics").effects.computeThroughput ?? 1;
    expect(m.computeThroughput).toBeCloseTo(starter * perRank ** 2);
  });

  it("uses rival.researchUnlocked, or an era-scaled cheapest-path default when the list is empty", () => {
    const state = createGame(11_003);
    const rival = state.rivals[0]!;
    const listed = modifiersForLab(state, rival.id);
    expect(listed.paramEfficiency).toBeCloseTo(
      getResearchNode("dense_basics").effects.paramEfficiency ?? 1,
    );

    const emptyList = {
      ...state,
      rivals: state.rivals.map((candidate) =>
        candidate.id === rival.id
          ? { ...candidate, researchUnlocked: [] }
          : candidate,
      ),
    };
    const fallback = modifiersForLab(emptyList, rival.id);
    expect(fallback.computeThroughput).toBeGreaterThanOrEqual(listed.computeThroughput);

    const late = {
      ...emptyList,
      day: 365 * 8,
    };
    const lateFallback = modifiersForLab(late, rival.id);
    expect(computeEquivalent(lateFallback)).toBeGreaterThan(
      computeEquivalent(fallback),
    );
  });
});

describe("computeEquivalent / describeModifiers", () => {
  it("matches param^(−1/α)·data^(−1/β)·throughput and skips baseline lines", () => {
    const m = aggregateModifiers(
      [
        node("p", {
          paramEfficiency: 0.85,
          dataEfficiency: 0.9,
          computeThroughput: 1.4,
          unlock: ["moe"],
        }),
      ],
      { p: 1 },
    );
    expect(computeEquivalent(m)).toBeCloseTo(
      0.85 ** (-1 / 0.34) * 0.9 ** (-1 / 0.28) * 1.4,
    );
    const lines = describeModifiers(m);
    expect(lines).toContain("Param efficiency ×0.85");
    expect(lines).toContain("Throughput ×1.4");
    expect(lines).toContain("Unlocks: MoE");
    expect(describeModifiers(baselineModifiers())).toEqual([]);
  });
});
