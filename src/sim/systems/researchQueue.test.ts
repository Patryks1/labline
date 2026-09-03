import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { getResearchNode } from "../balance/research";
import type { SimState } from "../types";
import {
  aggregateEffects,
  canEnqueue,
  completeResearchNode,
  maybeAutoQueueResearch,
  nextAutoQueueResearchId,
} from "./research";

function withAutoQueue(state: SimState, on: boolean): SimState {
  return {
    ...state,
    player: { ...state.player, autoQueueResearch: on },
  };
}

function queuedIds(state: SimState): string[] {
  return [
    ...state.player.researchQueue,
    ...(state.player.researchProgramQueue ?? []),
  ];
}

describe("research auto-queue", () => {
  it("auto-queue off: complete leaves queue empty", () => {
    let state = createGame(9_101);
    expect(state.player.autoQueueResearch).toBeFalsy();
    state = completeResearchNode(state, getResearchNode("sys_batching"));
    expect(queuedIds(state)).toEqual([]);
    expect(state.player.activeResearch).toBeNull();
  });

  it("auto-queue on after sys_batching: enqueues cheapest available inference one-shot", () => {
    let state = withAutoQueue(createGame(9_102), true);
    state = completeResearchNode(state, getResearchNode("sys_batching"));
    const picked = nextAutoQueueResearchId(
      {
        ...state,
        player: {
          ...state.player,
          researchQueue: [],
          researchProgramQueue: [],
          activeResearch: null,
        },
      },
      "sys_batching",
    );
    expect(picked).toBe("sys_quant");
    expect(
      queuedIds(state).includes("sys_quant") ||
        state.player.activeResearch?.nodeId === "sys_quant",
    ).toBe(true);
  });

  it("auto-queue on with existing queue: does not insert extra", () => {
    let state = withAutoQueue(createGame(9_103), true);
    state = {
      ...state,
      player: { ...state.player, researchQueue: ["data_clean"] },
    };
    const before = [...state.player.researchQueue];
    state = completeResearchNode(state, getResearchNode("sys_batching"));
    expect(state.player.researchQueue).toEqual(before);
    expect(state.player.researchQueue).not.toContain("sys_quant");
    expect(state.player.researchProgramQueue ?? []).not.toContain("sys_quant");
    const idle = maybeAutoQueueResearch(
      {
        ...state,
        player: {
          ...state.player,
          activeResearch: null,
          researchQueue: ["data_clean"],
        },
      },
      "sys_batching",
    );
    expect(idle.player.researchQueue).toEqual(["data_clean"]);
  });
});

describe("repeatable research ranks", () => {
  it("after rank 1, includes(id) true, canEnqueue until rank 5", () => {
    const id = "sys_kernel_tune";
    let state = createGame(9_104);
    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...new Set([...state.player.researchUnlocked, "sys_kernels"]),
        ],
      },
    };
    state = completeResearchNode(state, getResearchNode(id));
    expect(state.player.researchUnlocked.includes(id)).toBe(true);
    expect(state.player.researchRanks?.[id]).toBe(1);
    expect(canEnqueue(state, id).ok).toBe(true);

    for (let rank = 2; rank <= 5; rank++) {
      state = completeResearchNode(state, getResearchNode(id));
      expect(state.player.researchUnlocked.filter((item) => item === id)).toHaveLength(
        1,
      );
      expect(state.player.researchRanks?.[id]).toBe(rank);
      expect(canEnqueue(state, id).ok).toBe(rank < 5);
    }
    expect(canEnqueue(state, id).ok).toBe(false);
    expect(canEnqueue(state, id).reason).toBe("Already unlocked");
  });

  it("rank 2 stacks V4 throughput via modifiersForLab and dataFlywheel * rank", () => {
    const tune = getResearchNode("sys_kernel_tune");
    let state = createGame(9_105);
    const trainBefore = state.player.trainEfficiency;
    state = completeResearchNode(state, tune);
    state = completeResearchNode(state, tune);
    expect(state.player.researchRanks?.["sys_kernel_tune"]).toBe(2);
    // V4-DELETE: catalog no longer writes trainEfficiency onto the lab.
    expect(state.player.trainEfficiency).toBeCloseTo(trainBefore);

    const stacked = aggregateEffects(["sys_kernel_tune", "data_ops_refine"], {
      sys_kernel_tune: 2,
      data_ops_refine: 2,
    });
    expect(stacked.dataFlywheel).toBeCloseTo(
      (getResearchNode("data_ops_refine").effects.dataFlywheel ?? 0) * 2,
    );
  });
});
