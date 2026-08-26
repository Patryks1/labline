import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  INSTANT_EFFORT_ID,
  buildModelProductProfile,
  instantRecipe,
} from "../../../../sim/balance/modelProduct";
import { EffortStudio, LogThinkingBudgetField } from "./EffortStudio";

describe("EffortStudio head tools", () => {
  it("puts compute share, loss, and efficiency sliders on existing head cards", () => {
    const profile = buildModelProductProfile({
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
    const html = renderToStaticMarkup(
      createElement(EffortStudio, {
        subjectId: "job-1",
        profile,
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
