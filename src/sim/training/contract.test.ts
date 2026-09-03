import { describe, expect, it, vi } from "vitest";
import type { PlayerState, RivalLab, SimState } from "../types";
import { baselineModifiers, hasUnlock } from "./modifiers";
import {
  defaultArchitecture,
  defaultDesign,
  emptyTrainingState,
  trainingStateOf,
  withTrainingState,
} from "./state";
import { tickTrainingCore } from "./tickTrainingCore";
import { CALIBRATION_BANDS, TRAINING_V4 } from "./constants";
import { startRun } from "./run";

function fakeState(): SimState {
  return {
    playerLabId: "player",
    player: { training: undefined } as unknown as PlayerState,
    rivals: [{ id: "rival-a", training: undefined } as unknown as RivalLab],
  } as SimState;
}

describe("training contract Phase 0", () => {
  it("exposes scaling constants and the calibration table", () => {
    expect(TRAINING_V4.scaling).toMatchObject({
      E: 1.69,
      A: 406.4,
      B: 410.7,
      alpha: 0.34,
      beta: 0.28,
      capK: 1.45,
    });
    expect(CALIBRATION_BANDS[2]).toMatchObject({
      paramsB: 7,
      tokensPerParam: 20,
      expected: 48,
    });
  });

  it("returns baseline modifiers and unlock membership", () => {
    const mods = baselineModifiers();
    expect(mods.paramEfficiency).toBe(1);
    expect(mods.ceilingLift).toBe(0);
    expect(mods.rlQuality).toBe(0.35);
    expect(mods.routerQuality).toBe(0.5);
    expect(mods.verifierStrength).toBe(0.2);
    expect(mods.unlocks).toEqual([]);
    expect(hasUnlock(mods, "moe")).toBe(false);
    expect(hasUnlock({ ...mods, unlocks: ["moe"] }, "moe")).toBe(true);
  });

  it("builds empty state, default dense 7B architecture, and player/rival slices", () => {
    const empty = emptyTrainingState();
    expect(empty.runs).toEqual([]);
    expect(empty.pools.instructionMTok).toBe(0);

    const arch = defaultArchitecture();
    expect(arch).toMatchObject({
      backbone: "dense",
      totalParamsB: 7,
      activeParamsB: 7,
      precision: "fp32",
      preset: "language",
      inputs: ["text"],
      outputs: ["text"],
      contextK: 4,
    });

    const design = defaultDesign(12);
    expect(design.createdDay).toBe(12);
    expect(design.mode).toEqual({ kind: "pretrain" });

    const state = fakeState();
    expect(trainingStateOf(state, "player").runs).toEqual([]);
    const filled = emptyTrainingState();
    filled.biggestTrainedParamsB = 70;
    const next = withTrainingState(state, "player", filled);
    expect(next.player.training?.biggestTrainedParamsB).toBe(70);
    expect(state.player.training).toBeUndefined();

    const rivalNext = withTrainingState(state, "rival-a", filled);
    expect(rivalNext.rivals[0]?.training?.biggestTrainedParamsB).toBe(70);
  });

  it("guards every tick step so a failing step cannot crash the tick", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = fakeState();
    // A bare fake state has no day/seed/compute, so implemented steps either
    // no-op or throw; either way the tick must return a usable state.
    const next = tickTrainingCore(state);
    expect(next.playerLabId).toBe("player");
    expect(next.rivals).toHaveLength(1);
    warn.mockRestore();
  });

  it("startRun rejects a bare fake state instead of throwing", () => {
    const started = startRun(fakeState(), "player", defaultDesign(0));
    expect(started.result.ok).toBe(false);
    if (started.result.ok) throw new Error("expected blockers");
    expect(started.result.reason.length).toBeGreaterThan(0);
  });
});
