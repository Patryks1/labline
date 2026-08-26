import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  isArchivedModel,
  isInternalFleetModel,
  isLivePublicModel,
} from "../modelRelease";
import { roundTripState } from "../save";
import type { Model, SimState } from "../types";
import { ensureLabData } from "./data";
import { hostedServingModels } from "./servingPlacement";
import {
  archiveModel,
  completeTrainingJobsNow,
  keepInternal,
  releaseFromJob,
  restoreArchivedModel,
  startTraining,
} from "./training";

function richState(seed: number): SimState {
  const state = createGame(seed);
  return {
    ...state,
    player: {
      ...state.player,
      cash: 10_000_000_000,
      allocation: { training: 0.9, inference: 0.05, research: 0.05 },
    },
  };
}

function addFreshTextData(state: SimState, volume = 2_000): SimState {
  const data = ensureLabData(state);
  const perDomain = volume / 2;
  const stocks = { ...data.stocks };
  for (const domain of ["chat", "code"] as const) {
    const stock = stocks[domain];
    stocks[domain] = {
      ...stock,
      processed: stock.processed + perDomain,
      fromWeb: stock.fromWeb + perDomain,
    };
  }
  return {
    ...state,
    day: state.day + 1,
    player: {
      ...state.player,
      data: {
        ...data,
        stocks,
        lifetimeProcessed: data.lifetimeProcessed + volume,
      },
    },
  };
}

function releasedSpark(seed = 4411): { state: SimState; model: Model } {
  let state = startTraining(richState(seed), {
    name: "Spark",
    family: "dense",
    paramsB: 1,
    dataPlan: {
      totalUnits: 200,
      totalMTok: 200,
      weights: { chat: 0.6, code: 0.4 },
      allowSynthetic: true,
    },
  });
  expect(state.player.trainingJob, state.alerts[0]?.message).not.toBeNull();
  state = completeTrainingJobsNow(state);
  state = releaseFromJob(state);
  const model = state.player.models.find((candidate) => candidate.name === "Spark")!;
  expect(model).toMatchObject({ release: "released", shipped: true });
  return { state, model };
}

describe("model archive", () => {
  it("takes a public model off live serving without deleting the weights", () => {
    const { state, model } = releasedSpark();
    const attached = {
      ...state,
      player: {
        ...state.player,
        pricing: {
          ...state.player.pricing,
          activeModelId: model.id,
          apiModelIds: [model.id],
          plans: state.player.pricing.plans.map((plan, index) =>
            index === 0 ? { ...plan, modelIds: [model.id] } : plan,
          ),
        },
      },
    };
    expect(hostedServingModels(attached.player).map((row) => row.id)).toContain(
      model.id,
    );

    const archived = archiveModel(attached, model.id);
    const next = archived.player.models.find((row) => row.id === model.id)!;
    expect(next.archived).toBe(true);
    expect(isLivePublicModel(next)).toBe(false);
    expect(isArchivedModel(next)).toBe(true);
    expect(isInternalFleetModel(next)).toBe(false);
    expect(archived.player.models).toHaveLength(attached.player.models.length);
    expect(hostedServingModels(archived.player).map((row) => row.id)).not.toContain(
      model.id,
    );
    expect(archived.player.pricing.activeModelId).not.toBe(model.id);
    expect(archived.player.pricing.apiModelIds ?? []).not.toContain(model.id);
    expect(
      archived.player.pricing.plans.some((plan) => plan.modelIds.includes(model.id)),
    ).toBe(false);
    expect(archived.alerts[0]?.message).toMatch(/Archived Spark/);
  });

  it("still allows continue-train and distill from archived weights", () => {
    const { state, model } = releasedSpark(4412);
    const archived = addFreshTextData(archiveModel(state, model.id));

    const continued = startTraining(archived, {
      name: "Spark r2",
      family: "dense",
      paramsB: 1,
      mode: "continue",
      continueFromId: model.id,
    });
    expect(continued.player.trainingJob, continued.alerts[0]?.message).toMatchObject({
      continueFromId: model.id,
      mode: "continue",
    });

    const distilled = startTraining(archived, {
      name: "Spark Mini",
      family: "dense",
      paramsB: 0.1,
      mode: "distill",
      teacherId: model.id,
    });
    expect(distilled.player.trainingJob, distilled.alerts[0]?.message).toMatchObject({
      teacherId: model.id,
      mode: "distill",
    });
  });

  it("restores archived models to the public fleet and round-trips saves", () => {
    const { state, model } = releasedSpark(4413);
    const archived = archiveModel(state, model.id);
    const restored = restoreArchivedModel(archived, model.id);
    const live = restored.player.models.find((row) => row.id === model.id)!;
    expect(live.archived).toBeFalsy();
    expect(isLivePublicModel(live)).toBe(true);
    expect(hostedServingModels(restored.player).map((row) => row.id)).toContain(
      model.id,
    );

    const loaded = roundTripState(archived);
    const persisted = loaded.player.models.find((row) => row.id === model.id)!;
    expect(persisted.archived).toBe(true);
    expect(isLivePublicModel(persisted)).toBe(false);
  });

  it("refuses to archive internal checkpoints", () => {
    let state = startTraining(richState(4414), {
      name: "Draft",
      family: "dense",
      paramsB: 1,
    });
    state = completeTrainingJobsNow(state);
    state = keepInternal(state);
    const draft = state.player.models.find((row) => row.name === "Draft")!;
    const next = archiveModel(state, draft.id);
    expect(next.player.models.find((row) => row.id === draft.id)?.archived).toBeFalsy();
    expect(next.alerts[0]?.message).toMatch(/Only public models/);
  });

  it("refuses to hide the source of an active safety campaign", () => {
    const { state, model } = releasedSpark(4415);
    const campaigning: SimState = {
      ...state,
      player: {
        ...state.player,
        safetyCampaign: {
          id: "safe-active",
          modelId: model.id,
          modelName: model.name,
          intensity: "standard",
          assignedResearchers: 3,
          minimumResearchers: 2,
          targetTrainingPfDays: 10,
          targetResearchPfDays: 6,
          progressTrainingPfDays: 1,
          progressResearchPfDays: 1,
          cashBudget: 1_000_000,
          cashSpent: 1_000_000,
          safetyDataMTok: 20,
          safetyDataQuality: 80,
          startDay: state.day,
        },
      },
    };

    const next = archiveModel(campaigning, model.id);
    expect(next.player.models.find((row) => row.id === model.id)?.archived).toBeFalsy();
    expect(isLivePublicModel(next.player.models.find((row) => row.id === model.id)!)).toBe(true);
    expect(next.player.safetyCampaign?.modelId).toBe(model.id);
    expect(next.alerts[0]?.message).toMatch(/active safety campaign before archiving/);
  });
});
