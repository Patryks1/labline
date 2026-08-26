import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LabsTab } from "./LabsTab";

describe("LabsTab compact layout", () => {
  it("keeps decisions visible while secondary allocation data starts collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(LabsTab, {
        cash: 1_000_000,
        researchUnlocked: [
          "domain_coding",
          "domain_agents",
          "domain_math",
          "domain_science",
          "align_sft",
        ],
        onInvestGym: vi.fn(),
        onSetGymAllocation: vi.fn(),
        onTeachTool: vi.fn(),
        researchAllocation: {
          dataShare: 0.1,
          safetyShare: 0,
          employedResearchers: 10,
          podResearchers: 0,
          fixedResearchers: 0,
        },
      }),
    );

    expect(markup).toContain('data-labs-research-split="collapsed"');
    expect(markup).toContain('data-gym-allocation="collapsed"');
    expect(markup).toContain("hud-mobile-summary");
    expect(markup).toContain("hud-mobile-detail");
    expect(markup).toContain("!min-h-11");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  });
});
