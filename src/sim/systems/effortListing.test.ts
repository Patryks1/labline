import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { INSTANT_EFFORT_ID, migrateEffortRecipes } from "../balance/modelProduct";
import { isCommerciallyOffered, isLivePublicModel } from "../modelRelease";
import type { SimState } from "../types";
import {
  listReleasedModel,
  releaseFromJob,
  startEffortTraining,
  startTraining,
} from "./training";
import { collectOffers } from "./market";

function richState(seed: number): SimState {
  const state = createGame(seed);
  return {
    ...state,
    player: {
      ...state.player,
      cash: 5_000_000_000,
      researchUnlocked: [
        ...state.player.researchUnlocked,
        "align_process",
        "align_grpo",
      ],
    },
  };
}

function finishJob(state: SimState): SimState {
  const job = state.player.trainingJob;
  if (!job) return state;
  const done = {
    ...job,
    progressPfDays: job.targetPfDays,
    daysElapsed: Math.max(job.minCalendarDays, 30),
    stage: "done" as const,
  };
  return {
    ...state,
    player: {
      ...state.player,
      trainingJob: done,
      trainingJobs: [done],
    },
  };
}

describe("named effort heads and go-to-market listing", () => {
  it("starts every model on Instant and trains a named compute-priced head", () => {
    let state = startTraining(richState(9101), {
      name: "Effort Source",
      family: "dense",
      paramsB: 1,
    });
    const job = state.player.trainingJob!;
    const before = migrateEffortRecipes(job.productProfile);
    expect(before.some((recipe) => recipe.id === INSTANT_EFFORT_ID)).toBe(true);
    expect(before.filter((recipe) => recipe.kind === "trained")).toHaveLength(0);

    state = startEffortTraining(state, {
      id: job.id,
      name: "Deep Think",
      thinkingTokenMult: 4,
      trainPfDays: 12,
    });
    const recipes = migrateEffortRecipes(state.player.trainingJob?.productProfile);
    const trained = recipes.find((recipe) => recipe.name === "Deep Think");
    expect(trained?.kind).toBe("trained");
    expect(trained?.thinkingTokenMult).toBe(4);
    expect(trained?.quality).toBeGreaterThan(0);
    expect(trained?.served).toBe(true);
    expect(state.player.trainingJob?.productProfile?.defaultEffortId).toBe(
      trained?.id,
    );
  });

  it("keeps a released model off demand until listing is confirmed", () => {
    let state = startTraining(richState(9102), {
      name: "List Me",
      family: "dense",
      paramsB: 1,
    });
    state = releaseFromJob(finishJob(state), undefined, { list: false });
    const model = state.player.models.at(-1)!;
    expect(isLivePublicModel(model)).toBe(true);
    expect(isCommerciallyOffered(model)).toBe(false);
    expect(
      collectOffers(state).some((offer) => offer.modelId === model.id),
    ).toBe(false);
    expect(
      state.player.pricing.plans.every(
        (plan) => !plan.modelIds.includes(model.id),
      ),
    ).toBe(true);

    const planId = state.player.pricing.plans[0]?.id;
    state = listReleasedModel(state, {
      modelId: model.id,
      sell: true,
      apiIn: 0.4,
      apiOut: 1.6,
      planIds: planId ? [planId] : [],
    });
    const listed = state.player.models.find((item) => item.id === model.id)!;
    expect(isCommerciallyOffered(listed)).toBe(true);
    expect(listed.apiPriceInPerMTok).toBe(0.4);
    expect(listed.apiPriceOutPerMTok).toBe(1.6);
    if (planId) {
      expect(
        state.player.pricing.plans
          .find((plan) => plan.id === planId)
          ?.modelIds.includes(model.id),
      ).toBe(true);
    }
  });

  it("can release without selling", () => {
    let state = startTraining(richState(9103), {
      name: "Hold Back",
      family: "dense",
      paramsB: 1,
    });
    state = releaseFromJob(finishJob(state), undefined, { list: false });
    const model = state.player.models.at(-1)!;
    state = listReleasedModel(state, {
      modelId: model.id,
      sell: false,
    });
    const held = state.player.models.find((item) => item.id === model.id)!;
    expect(isLivePublicModel(held)).toBe(true);
    expect(isCommerciallyOffered(held)).toBe(false);
    expect(held.apiPriceInPerMTok).toBeNull();
  });
});
