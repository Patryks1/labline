import { defaultArchitecture } from "../../../../../../sim/training/state";
import type { Checkpoint } from "../../../../../../sim/training/types";

function blankTruth(): Checkpoint["truth"] {
  return {
    domains: {
      language: 40,
      reasoning: 30,
      code: 35,
      math: 32,
      science: 28,
      vision: 10,
      video: 5,
      audio: 8,
      tools: 20,
    },
    factuality: 40,
    steerability: 40,
    robustness: 40,
    safety: 50,
    reliability: 45,
  };
}

export function makeCheckpoint(
  partial: Partial<Checkpoint> & Pick<Checkpoint, "id">,
): Checkpoint {
  return {
    labId: "player",
    lineageId: partial.id,
    name: "Alpha",
    version: "1.0",
    stage: "base",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: blankTruth(),
    trainingSummary: {
      pfDays: 12,
      effectiveMTok: 100,
      loss: 2.1,
      gap: 0.4,
      dataMix: { code: 1 },
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [
      { budget: 1, served: true },
    ],
    endpointIds: [],
    ...partial,
  };
}

