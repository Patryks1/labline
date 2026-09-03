import { afterEach, describe, expect, it, vi } from "vitest";
import { createGame } from "../createGame";
import * as computeMod from "../systems/compute";
import type { DatasetAsset, ModelCapabilities, SimState } from "../types";
import {
  checkpointById,
  discardCheckpoint,
  keepCheckpoint,
  lineageOf,
  renameCheckpoint,
  snapshotCheckpoint,
  snapshotVersion,
} from "./checkpoints";
import { defaultArchitecture, emptyTrainingState, trainingStateOf, withTrainingState } from "./state";
import { startRun, tickRuns } from "./run";
import type { Checkpoint, ModelDesign, PostTrainRecipe } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

function truth(fill: number): ModelCapabilities {
  return {
    domains: {
      language: fill,
      reasoning: fill,
      code: fill,
      math: fill,
      science: fill,
      vision: 0,
      video: 0,
      audio: 0,
      tools: fill * 0.5,
    },
    factuality: fill,
    steerability: fill,
    robustness: fill,
    safety: 40,
    reliability: fill,
  };
}

function ckpt(state: SimState, over: Partial<Checkpoint>): Checkpoint {
  return {
    id: "ckpt-a",
    labId: state.playerLabId,
    lineageId: "lineage-a",
    name: "A",
    version: "1.0",
    stage: "base",
    status: "stealth",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truth(40),
    trainingSummary: {
      pfDays: 10,
      effectiveMTok: 140,
      loss: 2,
      gap: 0.4,
      dataMix: { chat: 1 },
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [],
    endpointIds: [],
    ...over,
  };
}

function ample(state: SimState): SimState {
  const asset: DatasetAsset = {
    id: "v4-ample-chat",
    name: "Ample Chat",
    volumeMTok: 200_000,
    domainWeights: { chat: 1 },
    verticalTags: ["general"],
    quality: 80,
    diversity: 0.7,
    freshness: 1,
    rights: "owned",
    source: "web",
    exclusiveUntilDay: null,
    contaminationRisk: 0,
    acquiredDay: 1,
  };
  const data = state.player.data;
  vi.spyOn(computeMod, "computeSnapshot").mockReturnValue({
    pools: { training: 8_000, inference: 1, research: 1 },
  } as computeMod.ComputeSnapshot);
  return {
    ...state,
    player: {
      ...state.player,
      data: { ...data, assets: [...(data.assets ?? []), asset] },
      cash: Math.max(state.player.cash, 50_000_000),
    },
  };
}

describe("checkpoints", () => {
  it("formats snapshot versions without overflowing 0.100", () => {
    expect(snapshotVersion(0.25)).toBe("0.25");
    expect(snapshotVersion(0.75)).toBe("0.75");
    expect(snapshotVersion(1)).toBe("1.0");
    expect(snapshotVersion(0.05)).toBe("0.05");
  });

  it("guards snapshot/keep/discard and walks lineage root→self then BFS descendants", () => {
    let state = ample(createGame(42));
    const design: ModelDesign = {
      id: "design-7b",
      name: "Atlas-7B",
      goal: "flagship",
      arch: defaultArchitecture(),
      data: { domainMTok: { chat: 140_000 }, holdoutShare: 0.05 },
      mode: { kind: "pretrain" },
      compute: { pfPerDay: 200, priority: 3, source: "local" },
      createdDay: state.day,
    };
    const started = startRun(state, state.playerLabId, design);
    expect(started.result.ok).toBe(true);
    if (!started.result.ok) return;
    state = started.state;
    const early = snapshotCheckpoint(state, started.result.id);
    expect(early.checkpointId).toBeNull();
    state = { ...state, day: state.day + 1 };
    state = tickRuns(state);
    const unnamed = snapshotCheckpoint(state, started.result.id);
    expect(unnamed.checkpointId).toBeTruthy();
    expect(checkpointById(unnamed.state, unnamed.checkpointId!)?.name).toBe("Atlas-7B · Base");
    const snap = snapshotCheckpoint(unnamed.state, started.result.id, { name: "manual-mid" });
    expect(snap.checkpointId).toBeTruthy();
    state = snap.state;
    const id = snap.checkpointId!;
    expect(checkpointById(state, id)?.status).toBe("stealth");
    state = keepCheckpoint(state, id);
    expect(checkpointById(state, id)?.status).toBe("kept");
    state = renameCheckpoint(state, id, "  Mid  ");
    expect(checkpointById(state, id)?.name).toBe("Mid");

    const root = ckpt(state, { id: "root", lineageId: "L", name: "root" });
    const self = ckpt(state, {
      id: "self",
      lineageId: "L",
      parentId: "root",
      name: "self",
    });
    const c1 = ckpt(state, {
      id: "c1",
      lineageId: "L",
      parentId: "self",
      name: "c1",
      createdDay: 2,
    });
    const c2 = ckpt(state, {
      id: "c2",
      lineageId: "L",
      parentId: "self",
      name: "c2",
      createdDay: 3,
    });
    const lined = withTrainingState(state, state.playerLabId, {
      ...trainingStateOf(state, state.playerLabId),
      checkpoints: [root, self, c2, c1],
    });
    expect(lineageOf(lined, "self").map((row) => row.id)).toEqual(["root", "self", "c1", "c2"]);
    const stealth = ckpt(state, { id: "drop-me", status: "stealth" });
    let dropState = withTrainingState(state, state.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [stealth],
    });
    dropState = discardCheckpoint(dropState, "drop-me");
    expect(checkpointById(dropState, "drop-me")?.status).toBe("discarded");
  });

  it("discards kept post checkpoints even when a completed recipe produced them", () => {
    const state = createGame({ seed: 3 });
    const parent = ckpt(state, { id: "parent", status: "kept" });
    const ready = ckpt(state, {
      id: "ready",
      status: "kept",
      stage: "post",
      parentId: "parent",
    });
    const done: PostTrainRecipe = {
      id: "r1",
      labId: state.playerLabId,
      checkpointId: "parent",
      stages: ["instruct"],
      safetyFocus: 0,
      gymIds: [],
      budgetPfDays: 1,
      dataUse: {
        instructionMTok: 1,
        preferenceMTok: 0,
        verifiableTasks: 0,
        toolTrajectories: 0,
      },
      startDay: 1,
      progress: 1,
      pfDaysDone: 1,
      status: "completed",
      forecast: {
        pfDays: 1,
        days: 1,
        cash: 1,
        deltas: {},
        unlocksTiers: false,
        adequacy: {},
        warnings: [],
      },
      resultCheckpointId: "ready",
      seed: 1,
    };
    let next = withTrainingState(state, state.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [parent, ready],
      recipes: [done],
    });
    next = discardCheckpoint(next, "ready");
    expect(checkpointById(next, "ready")?.status).toBe("discarded");
    next = discardCheckpoint(next, "parent");
    expect(checkpointById(next, "parent")?.status).toBe("discarded");
  });

  it("does not discard a checkpoint on a live endpoint", () => {
    const state = createGame({ seed: 4 });
    const ready = ckpt(state, { id: "ready", status: "kept", stage: "post" });
    const blocked = withTrainingState(state, state.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [ready],
      endpoints: [
        {
          id: "ep",
          labId: state.playerLabId,
          name: "API",
          members: [{ checkpointId: "ready", role: "primary" }],
          policy: "single",
          tiers: [],
          precision: "fp8",
          status: "live",
          releaseDay: 1,
          pricing: { inPerMTok: 1, outPerMTok: 4 },
          openWeights: false,
          modelId: "ep",
        },
      ],
    });
    expect(checkpointById(discardCheckpoint(blocked, "ready"), "ready")?.status).toBe("kept");
  });
});
