import { describe, expect, it } from "vitest";
import { emptyBenchmarks } from "../balance/benchmarks";
import { createGame } from "../createGame";
import type { Model, SimState } from "../types";
import {
  currentSeason,
  deflatePublicScore,
  publicScores,
  tickSeasons,
} from "./evaluate";
import {
  frontierOverall,
  leaderboardRows,
  playerBestOverall,
} from "./leaderboard";
import { defaultArchitecture, emptyTrainingState, trainingStateOf, withTrainingState } from "./state";
import type { Checkpoint, Endpoint } from "./types";

function truthAt(value: number) {
  return {
    domains: {
      language: value,
      reasoning: value,
      code: value,
      math: value,
      science: value,
      vision: 0,
      video: 0,
      audio: 0,
      tools: value,
    },
    factuality: value,
    steerability: value,
    robustness: value,
    safety: value,
    reliability: value,
  };
}

function makeCheckpoint(
  labId: string,
  id: string,
  value: number,
  extras?: Partial<Checkpoint>,
): Checkpoint {
  return {
    id,
    labId,
    lineageId: id,
    name: extras?.name ?? id,
    version: "1.0",
    stage: "post",
    status: "released",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truthAt(value),
    trainingSummary: {
      pfDays: 12,
      effectiveMTok: 140,
      loss: 2,
      gap: 0.35,
      dataMix: {},
      syntheticShare: 0.2,
    },
    postTrain: { stages: {} },
    tiers: [
      { budget: 1, served: true },
      { budget: 8, served: true },
    ],
    endpointIds: [],
    ...extras,
  };
}

function makeEndpoint(labId: string, id: string, checkpointId: string, name: string): Endpoint {
  return {
    id,
    labId,
    name,
    members: [{ checkpointId, role: "primary" }],
    policy: "single",
    tiers: [
      { budget: 1, served: true },
      { budget: 8, served: true },
    ],
    precision: "bf16",
    status: "live",
    releaseDay: 1,
    pricing: { inPerMTok: 1, outPerMTok: 2 },
    openWeights: false,
    modelId: id,
  };
}

function stubModel(overrides: Partial<Model> & Pick<Model, "id" | "name" | "capability">): Model {
  return {
    family: "dense",
    paramsB: 7,
    modalities: ["text", "tools"],
    quality: {
      reasoning: 60,
      coding: 60,
      chat: 60,
      image: 5,
      video: 2,
      safety: 70,
      reliability: 65,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: "none",
    trainComputeSpent: 10,
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
    costApiPriceIn: 0.3,
    costApiPriceOut: 0.9,
    distilled: false,
    trainMode: "pretrain",
    commerciallyOffered: true,
    ...overrides,
  };
}

function silenceRivals(state: SimState): SimState {
  return {
    ...state,
    rivals: state.rivals.map((rival) => ({
      ...rival,
      models: [],
      training: emptyTrainingState(),
    })),
  };
}

describe("leaderboardRows", () => {
  it("mixes V4 endpoints with legacy rival models and sorts by overall", () => {
    const raw = createGame(8110);
    const quiet = silenceRivals(raw);
    const playerCp = makeCheckpoint(quiet.playerLabId, "cp-player", 55, { name: "Player CP" });
    const playerEp = makeEndpoint(quiet.playerLabId, "ep-player", "cp-player", "Player Live");
    let state = withTrainingState(quiet, quiet.playerLabId, {
      ...trainingStateOf(quiet, quiet.playerLabId),
      checkpoints: [playerCp],
      endpoints: [playerEp],
    });

    const v4Rival = state.rivals[0];
    const legacyRival = state.rivals[1];
    expect(v4Rival && legacyRival).toBeTruthy();

    const rivalCp = makeCheckpoint(v4Rival!.id, "cp-rival", 92, { name: "Rival CP" });
    const rivalEp = makeEndpoint(v4Rival!.id, "ep-rival", "cp-rival", "Rival Live");
    state = withTrainingState(state, v4Rival!.id, {
      ...emptyTrainingState(),
      checkpoints: [rivalCp],
      endpoints: [rivalEp],
    });

    const legacy = stubModel({
      id: "legacy-mid",
      name: "Legacy Mid",
      capability: 40,
      capabilities: undefined,
    });
    state = {
      ...state,
      rivals: state.rivals.map((rival) => {
        if (rival.id === legacyRival!.id) {
          return { ...rival, models: [legacy], training: emptyTrainingState() };
        }
        return rival;
      }),
    };

    const rows = leaderboardRows(state, 1);
    expect(rows.map((row) => row.kind)).toEqual(["endpoint", "endpoint", "legacyModel"]);
    expect(rows[0]?.entryId).toBe("ep-rival");
    expect(rows[0]?.isPlayer).toBe(false);
    expect(rows.some((row) => row.entryId === "ep-player" && row.isPlayer)).toBe(true);
    expect(rows[rows.length - 1]?.kind).toBe("legacyModel");
    expect(rows[rows.length - 1]?.entryId).toBe("legacy-mid");
    expect(rows.map((row) => row.overall)).toEqual(
      [...rows.map((row) => row.overall)].sort((a, b) => b - a),
    );

    expect(playerBestOverall(state)).toBe(
      rows.find((row) => row.isPlayer)?.overall,
    );
    expect(frontierOverall(state)).toBe(rows[0]?.overall);
    expect(frontierOverall(state)).toBeGreaterThan(playerBestOverall(state) ?? 0);
  });

  it("omits sunset endpoints and leaves playerBestOverall null without live player rows", () => {
    const raw = silenceRivals(createGame(8111));
    const checkpoint = makeCheckpoint(raw.playerLabId, "cp-1", 80);
    const sunset = makeEndpoint(raw.playerLabId, "ep-sunset", "cp-1", "Gone");
    sunset.status = "sunset";
    const state = withTrainingState(raw, raw.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [checkpoint],
      endpoints: [sunset],
    });
    expect(publicScores(state, "ep-sunset")).toEqual({});
    expect(leaderboardRows(state, 1)).toEqual([]);
    expect(playerBestOverall(state)).toBeNull();
    expect(frontierOverall(state)).toBe(0);
  });

  it("deflates legacy rival scores using the current season", () => {
    const raw = silenceRivals(createGame(8112));
    const rival = raw.rivals[0]!;
    const model = stubModel({
      id: "legacy-hot",
      name: "Legacy Hot",
      capability: 95,
      capabilities: undefined,
    });
    let state: SimState = {
      ...raw,
      rivals: raw.rivals.map((item) =>
        item.id === rival.id ? { ...item, models: [model], training: emptyTrainingState() } : item,
      ),
    };
    const season1 = leaderboardRows(state, 1)[0]!;
    expect(season1.kind).toBe("legacyModel");
    expect(season1.overall).toBe(95);

    state = tickSeasons({ ...state, day: 365 });
    const difficulty = currentSeason(state).difficultyIndex;
    const season2 = leaderboardRows(state, 1)[0]!;
    expect(season2.overall).toBe(Math.round(deflatePublicScore(95, difficulty) * 10) / 10);
    expect(season2.overall).toBeLessThan(season1.overall);
  });
});
