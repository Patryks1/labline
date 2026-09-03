import { seededId } from "../rng";
import type { LabId, SimState } from "../types";
import { findCheckpoint } from "./checkpoints";
import { gapFromCapability, overallCapability } from "./scaling";
import type { Architecture, DataAllocation, ModelDesign } from "./types";

const READY = new Set(["kept", "released"]);

/** Build a distill `ModelDesign` from a teacher checkpoint and student architecture. */
export function distillDesign(
  state: SimState,
  labId: LabId,
  input: {
    teacherCheckpointId: string;
    studentArch: Architecture;
    data: DataAllocation;
    name: string;
    compute: ModelDesign["compute"];
  },
): ModelDesign {
  const found = findCheckpoint(state, input.teacherCheckpointId);
  if (!found || found.labId !== labId) {
    throw new Error("Teacher checkpoint missing from this lab.");
  }
  if (!READY.has(found.checkpoint.status)) {
    throw new Error("Teacher must be kept or released.");
  }
  return {
    id: seededId("design", labId, state.day, "distill", input.teacherCheckpointId, input.name),
    name: input.name,
    goal: "distill",
    arch: {
      ...input.studentArch,
      inputs: [...input.studentArch.inputs],
      outputs: [...input.studentArch.outputs],
    },
    data: input.data,
    mode: { kind: "distill", teacherCheckpointId: input.teacherCheckpointId },
    compute: { ...input.compute },
    createdDay: state.day,
  };
}

/** Hidden teacher gap used by `distillGap`. */
export function teacherGapFor(state: SimState, teacherCheckpointId: string): number {
  const found = findCheckpoint(state, teacherCheckpointId);
  if (!found) return 0;
  return gapFromCapability(overallCapability(found.checkpoint.truth));
}
