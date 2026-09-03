import { seededId } from "../rng";
import type { LabId, SimState } from "../types";
import { findCheckpoint } from "./checkpoints";
import type { DataAllocation, ModelDesign } from "./types";

const READY = new Set(["kept", "released", "stealth"]);

/** Build a continued-pretrain `ModelDesign` that inherits the parent architecture. */
export function continueDesign(
  state: SimState,
  labId: LabId,
  input: {
    parentCheckpointId: string;
    extraData: DataAllocation;
    name: string;
    compute: ModelDesign["compute"];
  },
): ModelDesign {
  const found = findCheckpoint(state, input.parentCheckpointId);
  if (!found || found.labId !== labId) {
    throw new Error("Parent checkpoint missing from this lab.");
  }
  if (!READY.has(found.checkpoint.status)) {
    throw new Error("Parent must be kept, released, or stealth.");
  }
  if (found.checkpoint.stage === "post") {
    throw new Error("Post-trained weights can only take more post-training.");
  }
  const arch = found.checkpoint.arch;
  return {
    id: seededId("design", labId, state.day, "continue", input.parentCheckpointId, input.name),
    name: input.name,
    goal: "continue",
    arch: { ...arch, inputs: [...arch.inputs], outputs: [...arch.outputs] },
    data: input.extraData,
    mode: { kind: "continue", parentCheckpointId: input.parentCheckpointId },
    compute: { ...input.compute },
    createdDay: state.day,
  };
}
