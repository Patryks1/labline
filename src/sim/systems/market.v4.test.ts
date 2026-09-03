import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { collectOffers } from "./market";
import { emptyTrainingState, withTrainingState } from "../training/state";
import { defaultArchitecture } from "../training/state";
import { createEndpoint, retireEndpoint, sunsetEndpoint, openSourceEndpoint } from "../training/endpoints";
import type { Checkpoint } from "../training/types";

function keptCheckpoint(): Checkpoint {
  return {
    id: "ckpt-market",
    labId: "player",
    lineageId: "lineage-ckpt-market",
    name: "ckpt-market",
    version: "0.1",
    stage: "base",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: {
      domains: {
        language: 50,
        reasoning: 45,
        code: 40,
        math: 40,
        science: 40,
        vision: 0,
        audio: 0,
        video: 0,
        tools: 15,
      },
      factuality: 40,
      steerability: 40,
      robustness: 40,
      safety: 50,
      reliability: 55,
    },
    trainingSummary: {
      pfDays: 8,
      effectiveMTok: 100,
      loss: 2.2,
      gap: 0.5,
      dataMix: { chat: 1 },
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [
      { budget: 1, served: true },
      { budget: 2, served: false },
      { budget: 8, served: false },
      { budget: 20, served: false },
    ],
    endpointIds: [],
  };
}

describe("market V4 adapter", () => {
  it("lists live V4 projections and hides retired ones", () => {
    let state = createGame(4_201);
    state = withTrainingState(state, "player", {
      ...emptyTrainingState(),
      checkpoints: [keptCheckpoint()],
    });
    const created = createEndpoint(state, "player", {
      name: "Market Live",
      checkpointId: "ckpt-market",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    expect(collectOffers(created.state).some((offer) => offer.modelId === id)).toBe(
      true,
    );
    const retired = retireEndpoint(created.state, id);
    expect(collectOffers(retired).some((offer) => offer.modelId === id)).toBe(false);
  });

  it("keeps sunsetting endpoints offered with a demand ramp", () => {
    let state = createGame(4_202);
    state = withTrainingState(state, "player", {
      ...emptyTrainingState(),
      checkpoints: [keptCheckpoint()],
    });
    const created = createEndpoint(state, "player", {
      name: "Market Dusk",
      checkpointId: "ckpt-market",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    state = sunsetEndpoint(created.state, id, 8);
    const model = state.player.models.find((entry) => entry.id === id);
    expect(model?.sunsetDemandMult).toBe(1);
    expect(collectOffers(state).some((offer) => offer.modelId === id)).toBe(true);
  });

  it("flags player open-weight endpoints on market offers", () => {
    let state = createGame(4_203);
    state = withTrainingState(state, "player", {
      ...emptyTrainingState(),
      checkpoints: [keptCheckpoint()],
    });
    const created = createEndpoint(state, "player", {
      name: "Market Open",
      checkpointId: "ckpt-market",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    expect(collectOffers(created.state).find((offer) => offer.modelId === id)?.isOpenWeights).toBe(
      false,
    );
    const opened = openSourceEndpoint(created.state, id);
    expect(collectOffers(opened).find((offer) => offer.modelId === id)?.isOpenWeights).toBe(true);
  });
});
