import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecipePlanModal } from "./RecipePlanModal";
import type { RecipePlan } from "./recipePlan";

const plan: RecipePlan = {
  id: "aster",
  name: "Aster",
  weights: {
    code: 0.5,
    math: 0.2,
    science: 0.1,
    law: 0,
    health: 0,
    chat: 0.2,
    image: 0,
    video: 0,
    audio: 0,
  },
  postTrainWeights: {
    code: 0.2,
    math: 0.1,
    science: 0.1,
    law: 0,
    health: 0,
    chat: 0.6,
    image: 0,
    video: 0,
    audio: 0,
  },
  postTrainShare: 0.22,
  paramsB: 7,
  capability: 54,
  quality: 70,
  tokensMTok: 300,
};

describe("RecipePlanModal", () => {
  it("lists previous mixes and lets the player use one as a plan", () => {
    const markup = renderToStaticMarkup(
      createElement(RecipePlanModal, {
        open: true,
        plans: [plan],
        onClose: vi.fn(),
        onChoose: vi.fn(),
      }),
    );

    expect(markup).toContain("Load a mix");
    expect(markup).toContain("Aster");
    expect(markup).toContain("Use plan");
    expect(markup).toContain("Code");
    expect(markup).toContain('data-recipe-plan-list="true"');
  });

  it("stays closed without stealing the training workflow", () => {
    const markup = renderToStaticMarkup(
      createElement(RecipePlanModal, {
        open: false,
        plans: [plan],
        onClose: vi.fn(),
        onChoose: vi.fn(),
      }),
    );
    expect(markup).toBe("");
  });
});
