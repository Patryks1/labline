import { describe, expect, it } from "vitest";
import { createGame } from "../../sim/createGame";
import { emptyStaff } from "../../sim/balance/staff";
import { canPlaceBuilding, placeBuilding } from "../../sim/systems/map";
import { hireStaff } from "../../sim/systems/staff";
import { TERRAIN_KIND } from "../../sim/world";
import { tileCoords } from "../../sim/world/ids";
import type { SimState } from "../../sim/types";
import type { TileId } from "../../sim/world";
import { defaultArchitecture, emptyTrainingState, withTrainingState } from "../../sim/training/state";
import type { Checkpoint, Endpoint, Eval, TrainingRun } from "../../sim/training/types";
import { baselineModifiers } from "../../sim/training/modifiers";
import { buildObjectives } from "./objectives";

function findHqSpot(state: SimState): { x: number; y: number } {
  const world = state.map.world!;
  const width = world.descriptor.width;
  const candidates: TileId[] = [...world.staticWorld.starterPads];
  for (let id = 0; id < world.staticWorld.kind.length; id++) {
    if (world.staticWorld.kind[id] !== TERRAIN_KIND.empty) continue;
    const feature = world.staticWorld.feature[id]!;
    if (feature > 0 && (feature & 0x8000) === 0) candidates.unshift(id as TileId);
  }
  for (const id of candidates) {
    const { x, y } = tileCoords(id, width);
    if (canPlaceBuilding(state, x, y, "hq").ok) return { x, y };
  }
  throw new Error("No placeable HQ spot");
}

function pastCloud(seed: number): SimState {
  let state = createGame(seed);
  const { x, y } = findHqSpot(state);
  state = placeBuilding(state, x, y, "hq");
  const city = state.map.cities![0]!;
  state = {
    ...state,
    day: 10,
    map: {
      ...state.map,
      cities: [
        {
          ...city,
          talentAvailable: {
            ...(city.talentAvailable ?? emptyStaff()),
            researcher: 5,
          },
        },
        ...state.map.cities!.slice(1),
      ],
    },
  };
  const hired = hireStaff(
    {
      ...state,
      lastMarket: { ...state.lastMarket, unservedRatio: 0, playerDemandMTok: 0 },
      player: {
        ...state.player,
        cash: Math.max(state.player.cash, 50_000_000),
        finance: { ...state.player.finance, cash: Math.max(state.player.finance.cash, 50_000_000), runwayDays: 90 },
      },
    },
    city.id,
    "researcher",
    1,
  );
  return {
    ...hired,
    player: {
      ...hired.player,
      cash: Math.max(hired.player.cash, 50_000_000),
      finance: { ...hired.player.finance, cash: Math.max(hired.player.finance.cash, 50_000_000), runwayDays: 90 },
    },
  };
}

function makeRun(id: string): TrainingRun {
  return {
    id,
    labId: "player",
    design: {
      id,
      name: "First run",
      goal: "flagship",
      arch: defaultArchitecture(),
      data: { domainMTok: {}, holdoutShare: 0.05 },
      mode: { kind: "pretrain" },
      compute: { pfPerDay: 1, priority: 1, source: "local" },
      createdDay: 1,
    },
    forecast: {
      compute: {
        trainPfDays: 4,
        holdoutPfDays: 0,
        totalPfDays: 4,
        archCost: 1,
        modalityCost: 1,
        throughput: 1,
        days: 6,
        paceFloorDays: 3,
        trainHbmGB: 10,
        cashEstimate: 1,
      },
      loss: {
        nEff: 1,
        dEff: 1,
        paramTerm: 1,
        dataTerm: 1,
        loss: 2,
        precisionPenalty: 0,
        gap: 0.4,
      },
      effectiveData: {
        rawMTok: 10,
        uniqueMTok: 10,
        effectiveMTok: 8,
        qualityWeight: 1,
        diversity: 1,
        epochs: 1,
        epochFactor: 1,
        syntheticShare: 0,
        syntheticDiscount: 1,
        domainMix: {},
        perDomain: {},
      },
      capability: { p10: 20, p50: 28, p90: 36, ceiling: 82, sigma: 0.06 },
      domains: {
        language: 28,
        reasoning: 28,
        code: 28,
        math: 28,
        science: 28,
        vision: 0,
        video: 0,
        audio: 0,
        tools: 28,
      },
      blockers: [],
      warnings: [],
    },
    modifiersFrozen: baselineModifiers(),
    seed: 1,
    status: "running",
    startDay: 1,
    progress: 0.3,
    pfDaysDone: 1,
    pfDaysTotal: 4,
    cashSpent: 1,
    etaDays: 4,
    incidents: [],
    sigmaMult: 1,
    costMult: 1,
    gapDelta: 0,
    checkpointIds: [],
    autoCheckpointEvery: 0.25,
    lossCurve: [],
  };
}

function makeCheckpoint(id: string): Checkpoint {
  return {
    id,
    labId: "player",
    lineageId: id,
    name: "Kept",
    version: "1.0",
    stage: "base",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 2,
    progressAtSnapshot: 1,
    truth: {
      domains: {
        language: 30,
        reasoning: 30,
        code: 30,
        math: 30,
        science: 30,
        vision: 0,
        video: 0,
        audio: 0,
        tools: 30,
      },
      factuality: 30,
      steerability: 30,
      robustness: 30,
      safety: 40,
      reliability: 35,
    },
    trainingSummary: {
      pfDays: 4,
      effectiveMTok: 12,
      loss: 2.2,
      gap: 0.45,
      dataMix: {},
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [{ budget: 1, served: true }],
    endpointIds: [],
  };
}

function makeEval(id: string, checkpointId: string): Eval {
  return {
    id,
    labId: "player",
    checkpointId,
    tier: "suite",
    tierBudget: 1,
    metrics: ["overall"],
    orderedDay: 3,
    completeDay: 5,
    cashCost: 50_000,
    status: "running",
    seed: 1,
  };
}

function makeEndpoint(id: string, checkpointId: string, policy: Endpoint["policy"] = "single"): Endpoint {
  return {
    id,
    labId: "player",
    name: id,
    members:
      policy === "single"
        ? [{ checkpointId, role: "primary" }]
        : [
            { checkpointId, role: "primary" },
            { checkpointId, role: "member" },
          ],
    policy,
    tiers: [{ budget: 1, served: true }],
    precision: "bf16",
    status: "live",
    releaseDay: 6,
    pricing: { inPerMTok: 1, outPerMTok: 2 },
    openWeights: false,
    modelId: id,
  };
}

describe("V4 training objectives", () => {
  it("asks to start a run, then keep, eval, release, recipe, and router", () => {
    let state = pastCloud(42_201);
    expect(buildObjectives(state, true)[0]?.id).toBe("ship-model");

    state = withTrainingState(state, state.playerLabId, {
      ...emptyTrainingState(),
      runs: [makeRun("run-1")],
    });
    expect(buildObjectives(state, true)[0]?.id).toBe("keep-checkpoint");

    state = withTrainingState(state, state.playerLabId, {
      ...trainingSlice(state),
      checkpoints: [makeCheckpoint("cp-1")],
    });
    expect(buildObjectives(state, true)[0]?.id).toBe("order-eval");

    state = withTrainingState(state, state.playerLabId, {
      ...trainingSlice(state),
      evals: [makeEval("ev-1", "cp-1")],
    });
    expect(buildObjectives(state, true)[0]?.id).toBe("ship-model");
    expect(buildObjectives(state, true)[0]?.title).toMatch(/endpoint/i);

    state = withTrainingState(state, state.playerLabId, {
      ...trainingSlice(state),
      endpoints: [makeEndpoint("ep-1", "cp-1")],
      checkpoints: [{ ...makeCheckpoint("cp-1"), status: "released", endpointIds: ["ep-1"] }],
    });
    expect(buildObjectives(state, true)[0]?.id).toBe("complete-recipe");

    state = withTrainingState(state, state.playerLabId, {
      ...trainingSlice(state),
      recipes: [
        {
          id: "rec-1",
          labId: "player",
          checkpointId: "cp-1",
          stages: ["instruct"],
          safetyFocus: 0,
          gymIds: [],
          budgetPfDays: 3,
          dataUse: {
            instructionMTok: 1,
            preferenceMTok: 0,
            verifiableTasks: 0,
            toolTrajectories: 0,
          },
          startDay: 6,
          progress: 1,
          pfDaysDone: 3,
          status: "completed",
          forecast: {
            pfDays: 3,
            days: 2,
            cash: 1,
            deltas: {},
            unlocksTiers: false,
            adequacy: {},
            warnings: [],
          },
          seed: 1,
        },
      ],
    });
    expect(buildObjectives(state, true)[0]?.id).toBe("create-router");

    state = withTrainingState(state, state.playerLabId, {
      ...trainingSlice(state),
      endpoints: [makeEndpoint("ep-router", "cp-1", "domain")],
    });
    expect(buildObjectives(state, true)[0]?.id).not.toBe("create-router");
  });
});

function trainingSlice(state: SimState) {
  return state.player.training ?? emptyTrainingState();
}
