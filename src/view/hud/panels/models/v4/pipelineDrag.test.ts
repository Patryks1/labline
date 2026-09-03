import { describe, expect, it } from "vitest";
import { dropActionFor, dropStateFor, parsePipelineDragPayload } from "./pipelineDrag";

describe("pipeline drag", () => {
  it("continues a base checkpoint dropped on Training", () => {
    expect(
      dropActionFor({ kind: "checkpoint", id: "cp-1" }, "training", { stage: "base" }),
    ).toEqual({ type: "continue", checkpointId: "cp-1" });
  });

  it("rejects post-trained weights dropped on Training", () => {
    expect(
      dropActionFor({ kind: "checkpoint", id: "cp-post" }, "training", { stage: "post" }),
    ).toEqual({ type: "none" });
  });

  it("opens post-train settings when a checkpoint lands on Post-training", () => {
    expect(dropActionFor({ kind: "checkpoint", id: "cp-1" }, "postTraining")).toEqual({
      type: "postTrain",
      checkpointId: "cp-1",
    });
    expect(
      dropActionFor({ kind: "checkpoint", id: "cp-post" }, "postTraining", { stage: "post" }),
    ).toEqual({ type: "postTrain", checkpointId: "cp-post" });
  });

  it("snapshots a run dropped on Checkpoints", () => {
    expect(dropActionFor({ kind: "run", id: "run-1" }, "checkpoints")).toEqual({
      type: "snapshot",
      runId: "run-1",
    });
  });

  it("parses payloads and reports hover drop state", () => {
    expect(parsePipelineDragPayload(`{"kind":"checkpoint","id":"cp-1"}`)).toEqual({
      kind: "checkpoint",
      id: "cp-1",
    });
    expect(parsePipelineDragPayload("nope")).toBeNull();
    const payload = { kind: "checkpoint" as const, id: "cp-1" };
    expect(dropStateFor(payload, "training", "training", { stage: "base" })).toBe("ok");
    expect(dropStateFor(payload, "training", "training", { stage: "post" })).toBe("blocked");
    expect(dropStateFor(payload, "training", "ready", { stage: "base" })).toBeNull();
  });
});
