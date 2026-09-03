import { describe, expect, it } from "vitest";
import { pipelineFixture } from "./testFixtures";
import { trainingStateOf, withTrainingState } from "../../../../../sim/training/state";
import {
  selectCheckpointCard,
  selectFleet,
  selectGyms,
  selectLabUnlocks,
  selectLineage,
  selectPipelineBoard,
  selectRunCard,
} from "./selectors";

describe("training v4 view-model selectors", () => {
  const state = pipelineFixture();

  it("places the run, stealth checkpoint, recipe, and ready checkpoints in the right columns", () => {
    const board = selectPipelineBoard(state);

    expect(board.training).toHaveLength(1);
    expect(board.training[0]?.id).toBe("run-1");
    expect(board.training[0]?.pendingDecision).toBe(true);
    expect(board.training[0]?.burnPerDay).toBe(10_000);

    expect(board.checkpoints.map((card) => card.id)).toEqual(["cp-stealth"]);
    expect(board.postTraining.map((card) => card.id)).toEqual(["recipe-1"]);
    expect(board.postTraining[0]?.pfAllocated).toBeGreaterThan(0);
    expect(board.trainingPfAllocated).toBeGreaterThan(0);
    expect(board.ready.map((card) => card.id)).toEqual(["cp-post"]);
    expect(board.ready.every((card) => card.status !== "released")).toBe(true);

    expect(board.unattachedTraining.map((card) => card.id)).toEqual(["run-1"]);
    expect(board.unattachedRecipes).toEqual([]);
    expect(board.lineages).toHaveLength(1);
    const lineage = board.lineages[0]!;
    expect(lineage.id).toBe("lin-1");
    expect(lineage.roots.map((node) => node.kind === "checkpoint" && node.card.id)).toEqual(["cp-stealth"]);
    const kept = lineage.roots[0]?.children.find(
      (node) => node.kind === "checkpoint" && node.card.id === "cp-kept",
    );
    expect(kept?.kind).toBe("checkpoint");
    expect(kept?.children.map((node) => node.card.id)).toEqual(["cp-post", "recipe-1"]);
  });

  it("maps checkpoint actions by status and same-size merge", () => {
    const stealth = selectCheckpointCard(state, "cp-stealth");
    const kept = selectCheckpointCard(state, "cp-kept");
    const post = selectCheckpointCard(state, "cp-post");

    expect(stealth?.actions).toEqual([
      "continue",
      "branch",
      "distill",
      "merge",
      "postTrain",
      "evaluate",
      "release",
      "keep",
      "discard",
    ]);
    expect(kept?.actions).toEqual([
      "continue",
      "branch",
      "distill",
      "merge",
      "postTrain",
      "evaluate",
      "release",
      "discard",
    ]);
    expect(kept?.actionLocks.merge).toMatch(/merge|family|5%/i);
    expect(kept?.actionLocks.continue).toMatch(/pretrain/i);
    expect(kept?.actionLocks.distill).toMatch(/distill/i);
    expect(kept?.band).toEqual({ p10: 44, p50: 48, p90: 52, ceiling: 82 });
    expect(post?.stage).toBe("post");
    expect(post?.actions).not.toContain("continue");
    expect(post?.actions).not.toContain("branch");
    expect(post?.actions).toContain("discard");
    expect(post?.actionLocks.discard).toMatch(/endpoint/i);
    expect(kept?.actionLocks.discard).toMatch(/recipe/i);
    expect(post?.name).toBe("Helix · Instruct");
    expect(selectCheckpointCard(state, "missing")).toBeNull();
  });

  it("offers open-source on released checkpoints that still have closed live endpoints", () => {
    const training = trainingStateOf(state, state.playerLabId);
    const released = withTrainingState(state, state.playerLabId, {
      ...training,
      checkpoints: training.checkpoints.map((row) =>
        row.id === "cp-post" ? { ...row, status: "released" as const } : row,
      ),
    });
    expect(selectCheckpointCard(released, "cp-post")?.actions).toContain("openSource");

    const alreadyOpen = withTrainingState(released, released.playerLabId, {
      ...trainingStateOf(released, released.playerLabId),
      endpoints: trainingStateOf(released, released.playerLabId).endpoints.map((endpoint) => ({
        ...endpoint,
        openWeights: true,
      })),
    });
    expect(selectCheckpointCard(alreadyOpen, "cp-post")?.actions).not.toContain("openSource");
  });

  it("keeps released checkpoints out of Ready", () => {
    const training = trainingStateOf(state, state.playerLabId);
    const released = withTrainingState(state, state.playerLabId, {
      ...training,
      checkpoints: training.checkpoints.map((row) =>
        row.id === "cp-post" ? { ...row, status: "released" as const } : row,
      ),
    });
    const board = selectPipelineBoard(released);
    expect(board.ready.map((card) => card.id)).toEqual([]);
    expect(board.checkpoints.map((card) => card.id)).toEqual(["cp-stealth"]);
  });

  it("hides an older post checkpoint once a newer post child exists", () => {
    const training = trainingStateOf(state, state.playerLabId);
    const stacked = withTrainingState(state, state.playerLabId, {
      ...training,
      checkpoints: [
        ...training.checkpoints,
        {
          ...training.checkpoints[2]!,
          id: "cp-post-2",
          name: "Helix Instruct Reasoning",
          version: "0.4",
          parentId: "cp-post",
          createdDay: 22,
        },
      ],
    });
    const board = selectPipelineBoard(stacked);
    expect(board.ready.map((card) => card.id)).toEqual(["cp-post-2"]);
    expect(board.checkpoints.map((card) => card.id)).toEqual(["cp-stealth"]);
  });

  it("builds a lineage tree from the family root with the selected node on the path", () => {
    const roots = selectLineage(state, "cp-kept");
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    expect(root.id).toBe("cp-stealth");
    expect(root.isSelected).toBe(false);
    expect(root.onPath).toBe(true);
    expect(root.children.map((node) => node.id)).toEqual(["cp-kept"]);
    expect(root.children[0]?.isSelected).toBe(true);
    expect(root.children[0]?.children.map((node) => node.id)).toEqual(["cp-post"]);
    expect(root.children[0]?.children[0]?.isSelected).toBe(false);
    expect(root.children[0]?.children[0]?.onPath).toBe(false);
  });

  it("keeps sibling branches visible under the shared parent", () => {
    const training = trainingStateOf(state, state.playerLabId);
    const branched = withTrainingState(state, state.playerLabId, {
      ...training,
      checkpoints: [
        ...training.checkpoints,
        {
          ...training.checkpoints[1]!,
          id: "cp-branch",
          name: "Helix Branch",
          version: "0.2b",
          parentId: "cp-stealth",
          createdDay: 13,
        },
        {
          ...training.checkpoints[0]!,
          id: "cp-other-root",
          name: "Helix @25%",
          version: "0.25",
          parentId: undefined,
        },
      ],
    });
    const roots = selectLineage(branched, "cp-kept");
    expect(roots.map((node) => node.id)).toEqual(["cp-stealth"]);
    expect(roots[0]?.children.map((node) => node.id)).toEqual(["cp-kept", "cp-branch"]);
    expect(roots[0]?.children[1]?.isSelected).toBe(false);
    expect(roots[0]?.children[1]?.onPath).toBe(false);
  });

  it("reads fleet endpoints and gym pools without throwing on stub evaluate/endpoints", () => {
    const fleet = selectFleet(state);
    expect(fleet.endpoints).toHaveLength(1);
    expect(fleet.endpoints[0]?.id).toBe("ep-1");
    expect(fleet.endpoints[0]?.hbmGB).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(fleet.endpoints[0]?.hbmGB)).toBe(true);
    expect(fleet.endpoints[0]?.publicScores).toEqual({});
    expect(fleet.endpoints[0]?.agingPct).toBe(0);
    expect(fleet.totalRevenuePerDay).toBe(0);

    const gyms = selectGyms(state);
    expect(gyms.gyms).toEqual([]);
    expect(gyms.pools.instructionMTok).toBe(0);
    expect(Array.isArray(selectLabUnlocks(state))).toBe(true);
  });

  it("ages fleet endpoints toward irrelevance over 360 days", () => {
    const quiet = {
      ...state,
      rivals: state.rivals.map((rival) => ({
        ...rival,
        models: [],
        releaseMilestones: [],
        training: { ...rival.training, endpoints: [] },
      })),
    };
    expect(selectFleet({ ...quiet, day: 20 + 180 }).endpoints[0]?.agingPct).toBeCloseTo(0.5, 5);
    expect(selectFleet({ ...quiet, day: 20 + 360 }).endpoints[0]?.agingPct).toBe(1);
  });

  it("builds a run card with burn from the forecast", () => {
    const card = selectRunCard(state, "run-1");
    expect(card?.name).toBe("Helix");
    expect(card?.status).toBe("awaiting_decision");
    expect(card?.incidentCount).toBe(1);
    expect(card?.burnPerDay).toBe(120_000 / 12);
  });
});
