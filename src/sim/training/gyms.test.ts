import { beforeAll, describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import type { ModelCapabilities, SimState } from "../types";
import {
  GYM_BUDGET_MONTH_STEP,
  GYM_CREATE_CASH,
  GYM_TIER_MONTHLY,
  assignGymAuditShare,
  assignGymMonthlyBudget,
  assignGymResearchers,
  assignGymResearchShare,
  assignGymTeacher,
  cleanPostTrainPool,
  cleanPostTrainPoolCost,
  createGym,
  tickGyms,
  upgradeGym,
} from "./postTrain";
import {
  gymBudgetSeatPerDay,
  gymComputeSeat,
  gymDailyYield,
  gymResearcherSeat,
  gymTierFromMonthly,
  gymTierSpec,
} from "./gyms";
import { stageEffect } from "./postTrainStages";
import { emptyTrainingState, trainingStateOf, withTrainingState } from "./state";
import type { Checkpoint, TrainingState } from "./types";

function withEmptyTraining(game: SimState, cash = 20_000_000): SimState {
  const next = withTrainingState(game, game.playerLabId, emptyTrainingState());
  return { ...next, player: { ...next.player, cash } };
}

function withResearchers(state: SimState, researchers: number): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      staff: {
        researcher: researchers,
        engineer: state.player.staff?.engineer ?? 0,
        data_processor: state.player.staff?.data_processor ?? 0,
        ops: state.player.staff?.ops ?? 0,
      },
    },
  };
}

function truth(fill = 80): ModelCapabilities {
  return {
    domains: {
      language: fill,
      reasoning: fill,
      code: fill,
      math: fill,
      science: fill,
      vision: fill,
      video: fill,
      audio: fill,
      tools: fill,
    },
    factuality: fill,
    steerability: fill,
    robustness: fill,
    safety: fill,
    reliability: fill,
  };
}

function teacherCheckpoint(state: SimState): Checkpoint {
  return {
    id: "ckpt-teacher",
    labId: state.playerLabId,
    lineageId: "lineage-teacher",
    name: "Teacher 7B",
    version: "1.0",
    stage: "base",
    status: "kept",
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
    progressAtSnapshot: 1,
    truth: truth(),
    trainingSummary: {
      pfDays: 100,
      effectiveMTok: 140,
      loss: 2.1,
      gap: 0.4,
      dataMix: {},
      syntheticShare: 0,
    },
    postTrain: { stages: {} },
    tiers: [],
    endpointIds: [],
  };
}

function withTeacherSlice(state: SimState, training: TrainingState): SimState {
  return withTrainingState(state, state.playerLabId, {
    ...training,
    checkpoints: [teacherCheckpoint(state)],
  });
}

describe("post-train gyms", () => {
  let game: SimState;

  beforeAll(() => {
    game = createGame(4243);
  });

  it("creates one gym per kind at 0% quality with no idle yield", () => {
    const seeded = withEmptyTraining(game);
    const created = createGym(seeded, seeded.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    expect(created.state.player.cash).toBeCloseTo(20_000_000 - GYM_CREATE_CASH);
    const again = createGym(created.state, created.state.playerLabId, "code");
    expect(again.result.ok).toBe(false);

    const spec0 = gymTierSpec(0);
    const gym = trainingStateOf(created.state, created.state.playerLabId).gyms[0]!;
    expect(gym).toMatchObject({
      kind: "code",
      tier: 0,
      quality: 0,
      tasksPerDay: spec0.tasksPerDay,
      researchers: 0,
      researchShare: 0,
      budgetPerDay: 0,
      auditShare: 0,
    });
    expect(gymDailyYield(gym).amount).toBe(0);
    expect(gymDailyYield(gym).quality).toBe(0);

    const produced = tickGyms(created.state);
    expect(trainingStateOf(produced, produced.playerLabId).pools.verifiableTasks).toBe(0);
  });

  it("does not produce from agentic or safety gyms without a grader", () => {
    let state = withEmptyTraining(game);
    const agentic = createGym(state, state.playerLabId, "agentic");
    expect(agentic.result.ok).toBe(true);
    state = agentic.state;
    const safety = createGym(state, state.playerLabId, "safety");
    expect(safety.result.ok).toBe(true);
    state = safety.state;

    const ticked = tickGyms(state);
    const slice = trainingStateOf(ticked, ticked.playerLabId);
    expect(slice.pools.toolTrajectories).toBe(0);
    expect(slice.pools.preferenceMTok).toBe(0);
    expect(slice.pools.verifiableTasks).toBe(0);
  });

  it("will not assign more researchers than HQ spare headcount", () => {
    const created = createGym(withEmptyTraining(game), game.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    const gym = trainingStateOf(created.state, created.state.playerLabId).gyms[0]!;

    const none = assignGymResearchers(created.state, gym.id, 4);
    expect(trainingStateOf(none, none.playerLabId).gyms[0]?.researchers).toBe(0);

    const two = assignGymResearchers(withResearchers(created.state, 2), gym.id, 4);
    expect(trainingStateOf(two, two.playerLabId).gyms[0]?.researchers).toBe(2);

    const released = assignGymResearchers(two, gym.id, 0);
    expect(trainingStateOf(released, released.playerLabId).gyms[0]?.researchers).toBe(0);
  });

  it("scales task yield with balanced researchers, compute, and budget", () => {
    const created = createGym(withEmptyTraining(game), game.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    const gym = trainingStateOf(created.state, created.state.playerLabId).gyms[0]!;
    expect(gymDailyYield({ ...gym, researchers: 20 }).amount).toBe(0);
    expect(gymDailyYield({ ...gym, researchShare: 0.2 }).amount).toBe(0);
    expect(
      gymDailyYield({ ...gym, budgetPerDay: gymBudgetSeatPerDay(gym.tier) }).amount,
    ).toBe(0);

    const balanced = gymDailyYield({
      ...gym,
      researchers: gymResearcherSeat(gym.tier),
      researchShare: gymComputeSeat(gym.tier),
      budgetPerDay: gymBudgetSeatPerDay(gym.tier),
    });
    expect(balanced.amount).toBeGreaterThan(1);
    expect(balanced.quality).toBeGreaterThan(0.2);

    const doubled = gymDailyYield({
      ...gym,
      researchers: gymResearcherSeat(gym.tier) * 2,
      researchShare: gymComputeSeat(gym.tier) * 2,
      budgetPerDay: gymBudgetSeatPerDay(gym.tier) * 2,
    });
    expect(doubled.amount).toBeGreaterThan(balanced.amount);
  });

  it("auto-upgrades campus from monthly operating spend", () => {
    const created = createGym(withEmptyTraining(game), game.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    const gym = trainingStateOf(created.state, created.state.playerLabId).gyms[0]!;

    const funded = assignGymMonthlyBudget(created.state, gym.id, GYM_TIER_MONTHLY[1]);
    const fundedGym = trainingStateOf(funded, funded.playerLabId).gyms[0]!;
    expect(gymTierFromMonthly(GYM_TIER_MONTHLY[1])).toBe(1);
    expect(fundedGym.tier).toBe(1);
    expect(fundedGym.upgrade).toBeUndefined();
    expect(fundedGym.tasksPerDay).toBe(gymTierSpec(1).tasksPerDay);
    expect(funded.player.cash).toBeCloseTo(created.state.player.cash);

    const stepped = upgradeGym(created.state, gym.id);
    expect(trainingStateOf(stepped, stepped.playerLabId).gyms[0]?.tier).toBe(1);
  });

  it("caps gym research share and spends the monthly operating budget", () => {
    const created = createGym(withEmptyTraining(game), game.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    const gym = trainingStateOf(created.state, created.state.playerLabId).gyms[0]!;

    const overShare = assignGymResearchShare(created.state, gym.id, 0.9);
    expect(trainingStateOf(overShare, overShare.playerLabId).gyms[0]?.researchShare).toBeCloseTo(
      0.25,
    );

    const funded = assignGymMonthlyBudget(created.state, gym.id, GYM_BUDGET_MONTH_STEP);
    const fundedGym = trainingStateOf(funded, funded.playerLabId).gyms[0]!;
    expect(fundedGym.budgetPerDay).toBeCloseTo(GYM_BUDGET_MONTH_STEP / 30);

    const cashBefore = funded.player.cash;
    const ticked = tickGyms(funded);
    expect(ticked.player.cash).toBeCloseTo(cashBefore - fundedGym.budgetPerDay);
    expect(trainingStateOf(ticked, ticked.playerLabId).pools.verifiableTasks).toBe(0);

    const broke = { ...funded, player: { ...funded.player, cash: 1 } };
    const stalled = tickGyms(broke);
    expect(stalled.player.cash).toBe(1);
    expect(trainingStateOf(stalled, stalled.playerLabId).pools.verifiableTasks).toBe(0);
  });

  it("lets a synthetic teacher grade when Synthetic Generators is unlocked", () => {
    const created = createGym(withEmptyTraining(game), game.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    let state = withTeacherSlice(
      created.state,
      trainingStateOf(created.state, created.state.playerLabId),
    );
    const gym = trainingStateOf(state, state.playerLabId).gyms[0]!;

    const locked = assignGymTeacher(state, gym.id, "ckpt-teacher");
    expect(trainingStateOf(locked, locked.playerLabId).gyms[0]?.teacherCheckpointId).toBeUndefined();

    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
      },
    };
    const assigned = assignGymTeacher(state, gym.id, "ckpt-teacher");
    expect(trainingStateOf(assigned, assigned.playerLabId).gyms[0]?.teacherCheckpointId).toBe(
      "ckpt-teacher",
    );

    const teacherGym = {
      ...trainingStateOf(assigned, assigned.playerLabId).gyms[0]!,
      researchShare: gymComputeSeat(0, true),
      budgetPerDay: gymBudgetSeatPerDay(0),
    };
    const teacherYield = gymDailyYield(teacherGym, {
      teacherStrength: 0.8,
      syntheticQuality: 1,
    });
    const humanYield = gymDailyYield({
      ...teacherGym,
      teacherCheckpointId: undefined,
      researchers: gymResearcherSeat(0),
      researchShare: gymComputeSeat(0),
    });
    expect(teacherYield.amount).toBeGreaterThan(0);
    expect(teacherYield.quality).toBeGreaterThan(0);
    expect(teacherYield.quality).toBeLessThan(humanYield.quality);
  });

  it("trades volume for quality when auditing and when cleaning a pool", () => {
    const created = createGym(withEmptyTraining(game), game.playerLabId, "code");
    expect(created.result.ok).toBe(true);
    const gym = trainingStateOf(created.state, created.state.playerLabId).gyms[0]!;
    const staffed = {
      ...gym,
      researchers: 1,
      researchShare: gymComputeSeat(gym.tier),
      budgetPerDay: gymBudgetSeatPerDay(gym.tier),
    };
    const raw = gymDailyYield(staffed);
    const audited = gymDailyYield({ ...staffed, auditShare: 0.2 });
    expect(audited.amount).toBeLessThan(raw.amount);
    expect(audited.quality).toBeGreaterThan(raw.quality);

    const assigned = assignGymAuditShare(created.state, gym.id, 0.4);
    expect(trainingStateOf(assigned, assigned.playerLabId).gyms[0]?.auditShare).toBeCloseTo(0.4);

    const dirty = withTrainingState(created.state, created.state.playerLabId, {
      ...trainingStateOf(created.state, created.state.playerLabId),
      pools: {
        instructionMTok: 0,
        preferenceMTok: 0,
        verifiableTasks: 200,
        toolTrajectories: 0,
      },
      poolQuality: {
        instructionMTok: 0,
        preferenceMTok: 0,
        verifiableTasks: 0.4,
        toolTrajectories: 0,
      },
    });
    const cashBefore = dirty.player.cash;
    const cleaned = cleanPostTrainPool(dirty, "verifiableTasks");
    const slice = trainingStateOf(cleaned, cleaned.playerLabId);
    expect(slice.pools.verifiableTasks).toBeLessThan(200);
    expect(slice.poolQuality?.verifiableTasks ?? 0).toBeGreaterThan(0.4);
    expect(cleaned.player.cash).toBeCloseTo(
      cashBefore - cleanPostTrainPoolCost(200),
    );
  });

  it("gives HQ task pools a stronger post-train effect than dirty pools", () => {
    const dirty = stageEffect({
      adequacy: 1,
      gymQuality: 1,
      poolQuality: 0.2,
      rlQuality: 1,
      completeness: 1,
      postTrainEfficiency: 1,
      priorRuns: 0,
      provided: 2000,
      budgetPfDays: 10,
    });
    const clean = stageEffect({
      adequacy: 1,
      gymQuality: 1,
      poolQuality: 0.9,
      rlQuality: 1,
      completeness: 1,
      postTrainEfficiency: 1,
      priorRuns: 0,
      provided: 2000,
      budgetPfDays: 10,
    });
    expect(clean).toBeGreaterThan(dirty);
    expect(dirty).toBeCloseTo(0.36);
    expect(clean).toBeCloseTo(0.92);
  });
});
