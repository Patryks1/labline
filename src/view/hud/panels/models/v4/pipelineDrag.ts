import type { CheckpointStage } from "../../../../../sim/training/types";

export const PIPELINE_DRAG_MIME = "application/x-labline-pipeline";

export type PipelineColumnId = "training" | "checkpoints" | "postTraining" | "ready";

export type PipelineDragPayload =
  | { kind: "run"; id: string }
  | { kind: "checkpoint"; id: string };

export type PipelineDropAction =
  | { type: "continue"; checkpointId: string }
  | { type: "postTrain"; checkpointId: string }
  | { type: "snapshot"; runId: string }
  | { type: "none" };

export function parsePipelineDragPayload(raw: string): PipelineDragPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const kind = "kind" in parsed ? parsed.kind : null;
    const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : "";
    if (!id) return null;
    if (kind === "run" || kind === "checkpoint") return { kind, id };
    return null;
  } catch {
    return null;
  }
}

export function dropActionFor(
  payload: PipelineDragPayload,
  column: PipelineColumnId,
  meta?: { stage?: CheckpointStage },
): PipelineDropAction {
  if (payload.kind === "run" && column === "checkpoints") {
    return { type: "snapshot", runId: payload.id };
  }
  if (payload.kind === "checkpoint" && column === "training") {
    if (meta?.stage === "post") return { type: "none" };
    return { type: "continue", checkpointId: payload.id };
  }
  if (payload.kind === "checkpoint" && column === "postTraining") {
    return { type: "postTrain", checkpointId: payload.id };
  }
  return { type: "none" };
}

export function dropStateFor(
  payload: PipelineDragPayload | null,
  column: PipelineColumnId,
  hoverColumn: PipelineColumnId | null,
  meta?: { stage?: CheckpointStage },
): "ok" | "blocked" | null {
  if (!payload || hoverColumn !== column) return null;
  return dropActionFor(payload, column, meta).type === "none" ? "blocked" : "ok";
}
