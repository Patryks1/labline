import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LabsTab } from "./LabsTab";

const labsProps = {
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
};

describe("LabsTab compact layout", () => {
  it("keeps campus split collapsed and shows gym focus sliders on the cards", () => {
    const markup = renderToStaticMarkup(createElement(LabsTab, labsProps));

    expect(markup).toContain('data-labs-research-split="collapsed"');
    expect(markup).toContain("hud-mobile-summary");
    expect(markup).toContain("hud-mobile-detail");
    expect(markup).toContain("!min-h-11");
    expect(markup).toContain("Feeds the tools post-train stage");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(markup).toContain("Focus");
    expect(markup).toContain("Pragmatic");
    expect(markup).toContain('data-gym-auto-staff="true"');
    expect(markup).not.toContain("Configure");
    expect(markup).not.toContain("Researchers assigned");
  });

  it("renders gym names without a configure dialog", () => {
    const markup = renderToStaticMarkup(createElement(LabsTab, labsProps));

    expect(markup).toContain('data-labs-gym-grid="true"');
    expect(markup).toContain("Code lab");
    expect(markup).toContain("Cyber range");
    expect(markup).toContain("Math lab");
    expect(markup).toContain("Research lab");
    expect(markup).toContain("Personality lab");
    expect(markup).not.toContain('data-gym-open="false"');
    expect(markup).not.toContain("data-labs-gym-editor");
    expect(markup).not.toContain("Close gym");
  });
});
