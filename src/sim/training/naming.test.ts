import { describe, expect, it } from "vitest";
import {
  checkpointDisplayName,
  lineageBaseName,
  persistBaseCheckpointName,
  persistPostCheckpointName,
} from "./naming";
import { emptyTrainingState } from "./state";
import type { Checkpoint, TrainingState } from "./types";

function ckpt(over: Partial<Checkpoint> & Pick<Checkpoint, "id" | "name">): Checkpoint {
  return {
    labId: "player",
    lineageId: "lin",
    version: "1.0",
    stage: "base",
    status: "stealth",
    arch: {
      backbone: "dense",
      totalParamsB: 7,
      activeParamsB: 7,
      precision: "bf16_mixed",
      preset: "language",
      inputs: ["text"],
      outputs: ["text"],
    },
    createdDay: 1,
    progressAtSnapshot: 0.25,
    truth: {
      domains: {
        language: 0,
        reasoning: 0,
        code: 0,
        math: 0,
        science: 0,
        vision: 0,
        video: 0,
        audio: 0,
        tools: 0,
      },
      factuality: 0,
      steerability: 0,
      robustness: 0,
      safety: 0,
      reliability: 0,
    },
    trainingSummary: {
      pfDays: 1,
      effectiveMTok: 1,
      loss: 3,
      gap: 1,
      dataMix: {},
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [],
    endpointIds: [],
    ...over,
  };
}

describe("checkpoint naming", () => {
  it("names base snapshots after the design plus Base", () => {
    expect(persistBaseCheckpointName("Coder 2")).toBe("Coder 2 · Base");
    expect(persistBaseCheckpointName("Coder 2 · Base")).toBe("Coder 2 · Base");
  });

  it("rewrites auto-N checkpoints to the lineage base name plus stage", () => {
    const training = {
      ...emptyTrainingState(),
      runs: [
        {
          id: "run-1",
          design: { name: "Coder 2" },
        },
      ] as TrainingState["runs"],
      checkpoints: [
        ckpt({ id: "auto", name: "auto-25", runId: "run-1" }),
      ],
    };
    const auto = training.checkpoints[0]!;
    expect(lineageBaseName(auto, training)).toBe("Coder 2");
    expect(checkpointDisplayName(auto, training)).toBe("Coder 2 · Base");
  });

  it("names post results from the root plus accumulated stages", () => {
    const source = ckpt({ id: "base", name: "Atlas 7B · Base" });
    const training = { ...emptyTrainingState(), checkpoints: [source] };
    expect(persistPostCheckpointName(source, training, ["instruct"])).toBe("Atlas 7B · Instruct");
    expect(
      persistPostCheckpointName(source, training, ["instruct", "preference"]),
    ).toBe("Atlas 7B · Instruct+Preference");
  });

  it("keeps Helix Instruct readable when stage records are missing", () => {
    const base = ckpt({ id: "base", name: "Helix" });
    const post = ckpt({
      id: "post",
      name: "Helix Instruct",
      stage: "post",
      parentId: "base",
    });
    const training = { ...emptyTrainingState(), checkpoints: [base, post] };
    expect(checkpointDisplayName(post, training)).toBe("Helix · Instruct");
    expect(checkpointDisplayName(base, training)).toBe("Helix · Base");
  });
});
