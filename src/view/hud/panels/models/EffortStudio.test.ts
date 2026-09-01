import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTANT_EFFORT_ID,
  buildModelProductProfile,
  instantRecipe,
} from "../../../../sim/balance/modelProduct";
import type { ModelProductProfile } from "../../../../sim/types";
import { useGameStore } from "../../../../store/gameStore";
import { EffortStudio, LogThinkingBudgetField } from "./EffortStudio";

vi.mock("../../../../store/gameStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../store/gameStore")>();
  const useGameStore = Object.assign(
    (selector: (state: ReturnType<typeof actual.useGameStore.getState>) => unknown) =>
      selector(actual.useGameStore.getState()),
    actual.useGameStore,
  );
  return { ...actual, useGameStore };
});

beforeEach(() => {
  const { state } = useGameStore.getState();
  useGameStore.setState({
    state: {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: Array.from(
          new Set([...state.player.researchUnlocked, "align_process"]),
        ),
      },
    },
  });
});

function headedProfile(): ModelProductProfile {
  return buildModelProductProfile({
    completedPostTrainStages: ["process"],
    chatShare: 0.2,
    chatQuality: 60,
    reasoningEnabled: true,
    researchUnlocked: ["align_process"],
    existing: {
      lifecycle: "reasoning",
      focus: {
        coding: 0,
        science: 0,
        research: 0,
        personality: 0,
        chat: 0,
      },
      personality: 40,
      tokenEfficiency: 50,
      defaultEffortId: "high",
      effortRecipes: [
        {
          ...instantRecipe(),
          served: true,
          loss: 4.21,
          trainComputeShare: 0.2,
          progressPfDays: 3,
          targetPfDays: 10,
        },
        {
          id: "high",
          name: "Deep",
          kind: "trained",
          thinkingTokenMult: 8,
          trainPfDays: 12,
          trainCash: 1,
          trained: true,
          quality: 0.8,
          served: true,
          capabilityBias: 0.7,
          trainComputeShare: 0.15,
          progressPfDays: 2,
          targetPfDays: 12,
          loss: 5.04,
        },
      ],
    },
  });
}

function instantOnlyProfile(): ModelProductProfile {
  return buildModelProductProfile({
    completedPostTrainStages: ["process"],
    chatShare: 0.2,
    chatQuality: 60,
    reasoningEnabled: true,
    researchUnlocked: ["align_process"],
    existing: {
      lifecycle: "reasoning",
      focus: {
        coding: 0,
        science: 0,
        research: 0,
        personality: 0,
        chat: 0,
      },
      personality: 40,
      tokenEfficiency: 50,
      defaultEffortId: INSTANT_EFFORT_ID,
      effortRecipes: [instantRecipe()],
    },
  });
}

function effortHeadMarkup(html: string, id: string): string {
  const token = `data-effort-head="${id}"`;
  const start = html.indexOf(token);
  if (start < 0) return "";
  const rest = html.slice(start);
  const next = rest.indexOf("data-effort-head=", token.length);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("EffortStudio head tools", () => {
  it("puts compute share, loss, and efficiency sliders on existing head cards", () => {
    const html = renderToStaticMarkup(
      createElement(EffortStudio, {
        subjectId: "job-1",
        profile: headedProfile(),
        capability: 42,
        paramsB: 8,
        live: true,
      }),
    );
    expect(html).toContain('data-effort-studio="true"');
    expect(html).toMatch(/<details[^>]*data-effort-studio="true"/);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(html).toMatch(/<summary[^>]*class="[^"]*min-h-11[^"]*"/);
    expect(html).toContain("generated / reasoning budget");
    expect(html).toContain("total billed");
    expect(html).toContain("up to 100× generated");
    expect(html).toContain(`data-effort-head="${INSTANT_EFFORT_ID}"`);
    expect(html).toContain('data-effort-head="high"');
    expect(html).toContain("Train PF share");
    expect(html).toContain("Efficiency vs capability");
    expect(html).toContain("loss 4.21");
    expect(html).toContain("loss 5.04");
    expect(html).toContain("Continue train");
    expect(html).toContain("free");
    const instantCard = effortHeadMarkup(html, INSTANT_EFFORT_ID);
    expect(instantCard).toContain("Free to serve");
    expect(instantCard).toContain("not extra Instant compute");
    expect(instantCard).not.toContain("Train PF share");
    expect(effortHeadMarkup(html, "high")).toContain("Train PF share");
  });

  it("hides train-a-head form and trained-head sliders on the fleet", () => {
    const html = renderToStaticMarkup(
      createElement(EffortStudio, {
        subjectId: "model-1",
        profile: headedProfile(),
        capability: 42,
        paramsB: 8,
      }),
    );
    expect(html).toContain("Train further to add thinking heads");
    expect(html).not.toContain("Train a thinking head");
    expect(html).not.toContain("Train PF share");
    expect(html).toContain('data-effort-head="high"');
    expect(html).toContain("Stop serving");
    expect(html).toContain("Make default");
    expect(html).not.toContain("Continue train");
  });

  it("keeps Instant free of Train PF share on a live Instant-only profile", () => {
    const html = renderToStaticMarkup(
      createElement(EffortStudio, {
        subjectId: "job-instant",
        profile: instantOnlyProfile(),
        capability: 42,
        paramsB: 8,
        live: true,
      }),
    );
    const instantCard = effortHeadMarkup(html, INSTANT_EFFORT_ID);
    expect(instantCard.length).toBeGreaterThan(0);
    expect(instantCard).toContain("Free to serve");
    expect(instantCard).not.toContain("Train PF share");
    expect(html).not.toContain('data-effort-head="high"');
  });

  it("exposes meaningful values for the logarithmic budget range", () => {
    const html = renderToStaticMarkup(
      createElement(LogThinkingBudgetField, {
        value: 2.2,
        billedMultiplier: 1.6,
        onChange: () => undefined,
      }),
    );
    expect(html).toContain("Generated / reasoning budget");
    expect(html).toContain(
      'aria-valuetext="2.2× generated; 1.6× total billed"',
    );
  });
});
