import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { startTraining } from "../systems/training";
import { playerTrainingJobs } from "../systems/training";
import {
  architectureWorkMultiplier,
  freezeTrainingPlan,
  hydrateFrozenTrainingPlan,
  trainingOutcomeSeed,
} from "./trainingPlan";
import { DEFAULT_TRAINING_NUMERICS } from "./trainingPrecision";

describe("frozen training plans", () => {
  it("copies the specification immutably", () => {
    const dataRecipe = {
      totalUnits: 100,
      totalMTok: 100,
      trainShare: 0.8,
      weights: { chat: 1 },
      allowSynthetic: true,
    };
    const plan = freezeTrainingPlan({
      id: "plan-1",
      companyId: "player",
      name: "Spark",
      productPreset: "language",
      backbone: "dense",
      totalParamsB: 1,
      trainingNumerics: DEFAULT_TRAINING_NUMERICS,
      dataRecipe,
      computePlan: {
        source: "local",
        reservedPf: 8,
        computePriority: 50,
        activationCheckpointing: false,
      },
      distillationShare: 0,
      integratedResearchIds: ["dense_basics", "data_mix"],
      outcomeSeed: 9,
      createdDay: 3,
    });
    dataRecipe.weights.chat = 0;
    expect(plan.dataRecipe.weights.chat).toBe(1);
    expect(plan.integratedResearchIds).toEqual(["data_mix", "dense_basics"]);
  });

  it("hashes the same plan to the same outcome seed", () => {
    const input = {
      worldSeed: 42,
      companyId: "player",
      planId: "job-1",
      backbone: "dense" as const,
      productPreset: "language" as const,
      createdDay: 12,
    };
    expect(trainingOutcomeSeed(input)).toBe(trainingOutcomeSeed(input));
    expect(trainingOutcomeSeed({ ...input, createdDay: 13 })).not.toBe(
      trainingOutcomeSeed(input),
    );
  });

  it("hydrates legacy jobs without calling RNG", () => {
    const hydrated = hydrateFrozenTrainingPlan(
      {
        id: "legacy",
        name: "Legacy",
        family: "dense",
        backbone: "dense",
        productPreset: "language",
        targetParamsB: 7,
        targetPfDays: 20,
        progressPfDays: 4,
        postTrain: "none",
        postTrainProgress: 0,
        postTrainTarget: 0,
        mode: "pretrain",
        dataMix: "web",
        dataPlan: {
          totalUnits: 50,
          totalMTok: 50,
          trainShare: 0.82,
          weights: { chat: 1 },
        },
        dataConsumed: {},
        dataCoverage: 6,
        dataQualityUsed: 70,
        syntheticUnits: 0,
        trainShare: 0.82,
        trainMTok: 41,
        verifyMTok: 9,
        cashBurnPerDay: 0,
        cashSunk: 0,
        outcomeSeed: 77,
        integratedMethods: ["dense_basics"],
      },
      "player",
    );
    expect(hydrated.outcomeSeed).toBe(77);
    expect(hydrated.integratedResearchIds).toEqual(["dense_basics"]);
    expect(hydrated.totalParamsB).toBe(7);
  });

  it("freezes start-time research onto the job plan", () => {
    let state = createGame({
      seed: 14_100,
      labName: "Freeze",
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 0 },
      legacyMapFixture: true,
    });
    state = {
      ...state,
      player: {
        ...state.player,
        cash: 5_000_000_000,
        researchUnlocked: [...state.player.researchUnlocked, "data_mix"],
      },
    };
    const started = startTraining(state, {
      name: "Frozen",
      family: "dense",
      paramsB: 0.4,
      computePriority: 0,
      dataPlan: {
        totalUnits: 80,
        totalMTok: 80,
        trainShare: 0.82,
        weights: { chat: 1 },
        allowSynthetic: true,
      },
    });
    const job = playerTrainingJobs(started)[0];
    expect(job?.plan).toBeTruthy();
    expect(job?.plan?.integratedResearchIds).toEqual(
      [...started.player.researchUnlocked].sort(),
    );
    expect(job?.outcomeSeed).toBe(job?.plan?.outcomeSeed);
  });

  it("keeps architecture work multipliers documented and finite", () => {
    expect(architectureWorkMultiplier("dense")).toBe(1);
    expect(architectureWorkMultiplier("moe", "moe")).toBe(1.08);
    expect(architectureWorkMultiplier("diffusion")).toBe(1.25);
    expect(architectureWorkMultiplier("video")).toBe(2.4);
    expect(architectureWorkMultiplier("omni")).toBeGreaterThan(1);
  });
});
