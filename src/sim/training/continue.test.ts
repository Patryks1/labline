import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { continueDesign } from "./continue";
import { defaultArchitecture, emptyTrainingState, withTrainingState } from "./state";
import type { Checkpoint } from "./types";

function ckpt(over: Partial<Checkpoint> & Pick<Checkpoint, "id" | "stage">): Checkpoint {
  return {
    labId: "player",
    lineageId: "lin",
    name: "Atlas",
    version: "1.0",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: {
      domains: {
        language: 40,
        reasoning: 30,
        code: 35,
        math: 32,
        science: 28,
        vision: 0,
        video: 0,
        audio: 0,
        tools: 10,
      },
      factuality: 40,
      steerability: 40,
      robustness: 40,
      safety: 40,
      reliability: 40,
    },
    trainingSummary: {
      pfDays: 10,
      effectiveMTok: 100,
      loss: 2,
      gap: 0.4,
      dataMix: {},
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [],
    endpointIds: [],
    ...over,
  };
}

describe("continueDesign", () => {
  it("rejects post-trained parents", () => {
    const game = createGame(11);
    const post = ckpt({ id: "cp-post", stage: "post", labId: game.playerLabId });
    const state = withTrainingState(game, game.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [post],
    });
    expect(() =>
      continueDesign(state, state.playerLabId, {
        parentCheckpointId: "cp-post",
        extraData: { domainMTok: { chat: 1 }, holdoutShare: 0.05 },
        name: "Atlas continued",
        compute: { pfPerDay: 10, priority: 3, source: "local" },
      }),
    ).toThrow(/post-trained/i);
  });
});
