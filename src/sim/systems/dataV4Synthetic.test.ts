import { describe, expect, it } from "vitest";
import { emptyBenchmarks } from "../balance/benchmarks";
import { syntheticQualityFor } from "../balance/syntheticGeneration";
import { createGame } from "../createGame";
import type { Model, SimState } from "../types";
import {
  collectFromTraffic,
  startSyntheticGenerationJob,
  tickData,
} from "./data";
import { POST_TRAIN_TRAFFIC_TO_POOL, poolsFor } from "../training/dataBridge";
import {
  defaultArchitecture,
  emptyTrainingState,
  withTrainingState,
} from "../training/state";
import type { Checkpoint } from "../training/types";
import { teacherCapabilityForDataDomain } from "../balance/modelCapabilities";

function teacher(): Model {
  return {
    id: "v4-teacher",
    name: "V4 Teacher",
    family: "dense",
    paramsB: 7,
    capability: 72,
    capabilities: {
      domains: {
        language: 78,
        reasoning: 60,
        code: 80,
        math: 28,
        science: 35,
        vision: 18,
        video: 8,
        audio: 12,
        tools: 30,
      },
      factuality: 64,
      steerability: 70,
      robustness: 62,
      safety: 72,
      reliability: 75,
    },
    modalities: ["text"],
    quality: {
      reasoning: 65,
      coding: 80,
      chat: 74,
      image: 10,
      video: 5,
      safety: 72,
      reliability: 75,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: "rlhf",
    trainComputeSpent: 80,
    releaseDay: 1,
    shipped: true,
    release: "released",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: 2,
    apiPriceInPerMTok: 1,
    apiPriceOutPerMTok: 3,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: "pretrain",
  };
}

function labWithTeacher(seed: number): SimState {
  const state = createGame(seed);
  const model = teacher();
  return {
    ...state,
    player: {
      ...state.player,
      models: [model],
      allocation: { training: 0.1, inference: 0.2, research: 0.7 },
      cash: Math.max(state.player.cash, 50_000_000),
    },
  };
}

function syntheticCkpt(): Checkpoint {
  return {
    id: "ckpt-synth-teacher",
    labId: "player",
    lineageId: "lin-synth",
    name: "Synth-trained teacher",
    version: "1",
    stage: "base",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: {
      domains: {
        language: 70,
        reasoning: 60,
        code: 80,
        math: 40,
        science: 50,
        vision: 10,
        video: 5,
        audio: 8,
        tools: 20,
      },
      factuality: 60,
      steerability: 60,
      robustness: 60,
      safety: 70,
      reliability: 70,
    },
    trainingSummary: {
      pfDays: 10,
      effectiveMTok: 400,
      loss: 2.1,
      gap: 0.4,
      dataMix: { code: 1 },
      syntheticShare: 0.5,
    },
    postTrain: { stages: {} },
    tiers: [],
    endpointIds: [],
  };
}

describe("V4 synthetic generation jobs", () => {
  it("completes a job and writes an asset with lineage and depth 1", () => {
    let state = labWithTeacher(8801);
    const model = teacher();
    state = startSyntheticGenerationJob(state, {
      domain: "code",
      teacherRef: model.id,
      tierBudget: 8,
      targetMTok: 1,
      verify: true,
    });
    for (let day = 0; day < 40; day += 1) {
      state = tickData({ ...state, day: state.day + (day === 0 ? 0 : 1) });
      const job = state.player.data.syntheticJobs?.find(
        (item) => item.status === "completed",
      );
      if (job) break;
    }
    const job = state.player.data.syntheticJobs?.find(
      (item) => item.teacherRef === model.id,
    );
    expect(job?.status).toBe("completed");
    const written = state.player.data.assets.find(
      (item) => item.id === `dataset-v4-${job!.id}`,
    );
    expect(written?.source).toBe("synthetic");
    expect(written?.v4Synthetic?.teacherName).toBe(model.name);
    expect(written?.v4Synthetic?.depth).toBe(1);
    expect(written?.v4Synthetic?.verifiedShare).toBe(1);
    expect(written?.synthetic?.generationDepth).toBe(1);
    const expected = syntheticQualityFor({
      teacherDomainCap: teacherCapabilityForDataDomain(model, "code"),
      tierBudget: 8,
      verifierStrength: 0.2,
      depth: 1,
    });
    expect(written?.v4Synthetic?.quality).toBeCloseTo(expected, 8);
  });

  it("sets depth 2 when the teacher checkpoint was itself trained on synthetic data", () => {
    let state = labWithTeacher(8802);
    state = withTrainingState(state, state.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [{ ...syntheticCkpt(), labId: state.playerLabId }],
    });
    state = startSyntheticGenerationJob(state, {
      domain: "code",
      teacherRef: "checkpoint:ckpt-synth-teacher",
      tierBudget: 1,
      targetMTok: 1,
      verify: false,
    });
    for (let day = 0; day < 40; day += 1) {
      state = tickData({ ...state, day: state.day + (day === 0 ? 0 : 1) });
      if (state.player.data.syntheticJobs?.some((item) => item.status === "completed")) {
        break;
      }
    }
    const job = state.player.data.syntheticJobs?.[0];
    expect(job?.status).toBe("completed");
    const written = state.player.data.assets.find(
      (item) => item.id === `dataset-v4-${job!.id}`,
    );
    expect(written?.v4Synthetic?.depth).toBe(2);
    expect(written?.v4Synthetic?.teacherCheckpointId).toBe("ckpt-synth-teacher");
  });
});

describe("collectFromTraffic post-train pools", () => {
  it("adds instruction and preference MTok from free-tier collected chat", () => {
    let state = createGame(8803);
    state = {
      ...state,
      lastMarket: {
        ...state.lastMarket,
        servedMTok: 800,
        playerDemandMTok: 800,
        servedMTokByPlanId: { "plan-free": 800 },
      },
    };
    const before = poolsFor(state, state.playerLabId);
    state = collectFromTraffic(state);
    const freeChat = state.player.data.dayCollectChatFree ?? 0;
    expect(freeChat).toBeGreaterThan(0);
    const after = poolsFor(state, state.playerLabId);
    expect(after.instructionMTok).toBeCloseTo(
      before.instructionMTok +
        freeChat * POST_TRAIN_TRAFFIC_TO_POOL.instructionPerFreeChatMTok,
      8,
    );
    expect(after.preferenceMTok).toBeCloseTo(
      before.preferenceMTok +
        freeChat * POST_TRAIN_TRAFFIC_TO_POOL.preferencePerFreeChatMTok,
      8,
    );
  });
});
