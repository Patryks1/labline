import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../sim/types";
import { FleetTab } from "./FleetTab";
import type { CheckpointUiRecord } from "./checkpointUi";

function matchingDivEnd(markup: string, start: number): number {
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(markup); match; match = tags.exec(markup)) {
    if (match[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

function promotedModel(): Model {
  return {
    id: "promoted-model",
    checkpointCandidateId: "checkpoint-32",
    name: "Aster · C32",
    family: "dense",
    paramsB: 8,
    backbone: "dense",
    productPreset: "language",
    capability: 99.9,
    modalities: ["text", "tools"],
    quality: {
      reasoning: 98,
      coding: 98,
      chat: 98,
      image: 10,
      video: 5,
      safety: 94,
      reliability: 96,
    },
    benchmarks: {
      mmlu: 98.8,
      coding: 98.8,
      math: 98.8,
      vision: 98.8,
      law: 98.8,
      health: 98.8,
      science: 98.8,
      multilingual: 98.8,
      agents: 98.8,
      safety: 98.8,
      personality: 21,
    },
    benchmarkSuites: { language: { science: 98.8 } },
    postTrain: "none",
    trainComputeSpent: 100,
    releaseDay: 40,
    shipped: false,
    release: "internal",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: null,
    apiPriceInPerMTok: null,
    apiPriceOutPerMTok: null,
    suggestedApiPrice: 1,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 2,
    costApiPriceIn: 0.5,
    costApiPriceOut: 1,
    distilled: false,
    trainMode: "pretrain",
  };
}

function evidence(): CheckpointUiRecord {
  return {
    id: "checkpoint-32",
    sourceJobId: "job-aster",
    label: "Aster · C32",
    day: 40,
    milestone: 0.32,
    progress: 0.32,
    stage: "base",
    kind: "milestone",
    visibility: "internal",
    status: "promoted",
    confidence: 0.82,
    evaluationScore: {
      label: "Science",
      estimate: 61.4,
      low: 57.2,
      high: 65.1,
    },
    reportCount: 1,
    pendingEvaluations: [],
    evidenceReports: [],
    benchmark: {
      suiteLabel: "Language & reasoning",
      metricLabel: "Science",
      score: 61.4,
      low: 57.2,
      high: 65.1,
      confidence: 0.82,
      rivalBest: 60,
      rivalName: "Northstar",
      rivalDelta: 1.4,
    },
    actions: {
      benchmark: { enabled: true },
      review: { enabled: true },
      promote: { enabled: false },
      discard: { enabled: false },
      fork: { enabled: true },
      rollback: { enabled: false },
    },
  };
}

function releasedModel(): Model {
  return {
    ...promotedModel(),
    id: "spark",
    name: "Spark",
    shipped: true,
    release: "released",
    apiPricePerMTok: 12.5,
  };
}

function servingFinance() {
  return {
    modelId: "spark",
    name: "Spark",
    family: "dense",
    release: "released",
    isActive: true,
    isPublic: true,
    capability: 10,
    apiPricePerMTok: 12.5,
    dayApiRevenue: 621_260_000_000,
    dayApiDirectCogs: 100_000,
    dayApiAllocatedOps: 19_090,
    dayApiCogs: 119_090,
    dayApiMTok: 689_320,
    dayApiContribution: 621_259_900_000,
    apiCapacityUtilization: 0.8,
    daySubRevenue: 0,
    daySubCogs: 655.09,
    dayEnterpriseShare: 17.44,
    dayNet: 621_259_880_254.91,
    note: "Serving API and subscription traffic",
  };
}

describe("FleetTab checkpoint evidence", () => {
  it("shows measured evidence and masks latent capability and benchmark suites", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetTab, {
        internal: [promotedModel()],
        released: [],
        pricingId: null,
        frontierCapability: 60,
        checkpointEvidence: { "promoted-model": evidence() },
        onSelect: vi.fn(),
        onRelease: vi.fn(),
        onDelete: vi.fn(),
        onArchive: vi.fn(),
        onRestore: vi.fn(),
        onTrainFurther: vi.fn(),
        onDistill: vi.fn(),
      }),
    );

    expect(markup).toContain("private · measured checkpoint");
    expect(markup).toContain("Eval score");
    expect(markup).toContain("61.4 · 57.2–65.1");
    expect(markup).toContain("Day 40");
    expect(markup).not.toContain("99.9");
    expect(markup).not.toContain("98.8");
    expect(markup).not.toContain("Tier progress");
    expect(markup).not.toContain("Custom API markup percentage");
    expect(markup).not.toContain("Markup");
    expect(markup).toMatch(/data-hud-variant="danger"[^>]*>Delete<\/button>/);
    expect(markup).toContain("Private checkpoints");
    expect(markup).toContain("Public fleet");
  });

  it("puts serving economics and the public radar on released fleet cards", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetTab, {
        internal: [],
        released: [releasedModel()],
        modelFinance: [servingFinance()],
        pricingId: "spark",
        frontierCapability: 60,
        onSelect: vi.fn(),
        onRelease: vi.fn(),
        onDelete: vi.fn(),
        onArchive: vi.fn(),
        onRestore: vi.fn(),
        onTrainFurther: vi.fn(),
        onDistill: vi.fn(),
      }),
    );

    expect(markup).toContain("ACTIVE");
    expect(markup).toContain("Suite");
    expect(markup).toContain("Frontier");
    expect(markup).toContain("API rev");
    expect(markup).toContain("API COGS");
    expect(markup).toContain("API MTok");
    expect(markup).toContain("Sub rev");
    expect(markup).toContain("Enterprise");
    expect(markup).toContain("Serving API and subscription traffic");
    expect(markup).toContain('data-serving-economics="collapsed"');
    expect(markup).toContain("hud-mobile-summary");
    expect(markup).toContain("hud-mobile-detail");
    expect(markup).toContain('data-shell-gesture-ignore="true"');
    expect(markup).toContain("[&amp;_.hud-button]:!min-h-11");
    expect(markup).toContain("Axis readout");
    expect(markup).toContain("$621.26B");
    expect(markup).toContain("Archive");
    expect(markup).toContain("Train new version");
    expect(markup).toContain("Distill");
    expect(markup).toContain("Effort heads");
    expect(markup).toContain('data-fleet-evidence-disclosure="compact"');
    expect(markup).toMatch(
      /<details[^>]*data-fleet-evidence-disclosure="compact"[^>]*>/,
    );
    expect(
      markup.match(
        /<details[^>]*data-fleet-evidence-disclosure="compact"[^>]*>/,
      )?.[0],
    ).not.toContain("open=");
    expect(markup.match(/aria-label="Select Spark"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-hud-variant="danger"[^>]*>Delete<\/button>/);
    expect(markup).not.toContain("max-w-[14rem]");
  });

  it("keeps train and distill on archived fleet cards and offers restore", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetTab, {
        internal: [],
        released: [],
        archived: [{ ...releasedModel(), archived: true }],
        pricingId: "spark",
        frontierCapability: 60,
        onSelect: vi.fn(),
        onRelease: vi.fn(),
        onArchive: vi.fn(),
        onRestore: vi.fn(),
        onDelete: vi.fn(),
        onTrainFurther: vi.fn(),
        onDistill: vi.fn(),
      }),
    );

    expect(markup).toContain("Trained models");
    expect(markup).toContain('data-fleet-archive-disclosure="true"');
    expect(markup).toContain('data-archived-card="true"');
    expect(markup).toContain("Show archived models");
    expect(markup).toContain("Hide archived models");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(markup).toContain('data-archived-visual="muted"');
    expect(markup).toContain("opacity-60 grayscale-[0.65] saturate-50");
    expect(markup).not.toContain("border-t border-line/50 p-3 opacity-60");
    const archivedCardMarker = markup.indexOf('data-archived-card="true"');
    const archivedShellStart = markup.indexOf("<section", archivedCardMarker);
    const archivedShellTag = markup.slice(
      archivedShellStart,
      markup.indexOf(">", archivedShellStart) + 1,
    );
    expect(archivedShellTag).toContain("!border-line/50");
    expect(archivedShellTag).toContain("!bg-panel-2/45");
    expect(archivedShellTag).toContain("[&amp;&gt;header]:bg-void/15");
    expect(archivedShellTag).not.toMatch(/opacity|grayscale|saturate/);
    expect(markup).toContain("ARCHIVED");
    expect(markup).toContain("Train new version");
    expect(markup).toContain("Distill");
    expect(markup).toContain("Restore");
    expect(markup.match(/aria-label="Select Spark"/g)).toHaveLength(1);
    const archivedTitleLabel = markup.indexOf(
      'aria-label="Select Spark"',
      archivedCardMarker,
    );
    const archivedTitleTag = markup.slice(
      markup.lastIndexOf("<button", archivedTitleLabel),
      markup.indexOf(">", archivedTitleLabel) + 1,
    );
    expect(archivedTitleTag).toContain("!text-muted");
    expect(archivedTitleTag).not.toMatch(/opacity|grayscale|saturate/);
    const archivedActions = markup.match(
      /<div[^>]*data-fleet-actions="archived"[^>]*>/,
    )?.[0];
    expect(archivedActions).toBeDefined();
    expect(archivedActions).not.toMatch(/opacity|grayscale|saturate/);
    const mutedStart = markup.indexOf('data-archived-visual="muted"');
    const mutedContainerStart = markup.lastIndexOf("<div", mutedStart);
    const mutedEnd = matchingDivEnd(markup, mutedContainerStart);
    const archivedRadar = markup.indexOf('data-fleet-radar="archived"');
    expect(mutedEnd).toBeGreaterThan(mutedStart);
    expect(archivedRadar).toBeGreaterThan(mutedEnd);
    const archivedRadarTagStart = markup.lastIndexOf("<details", archivedRadar);
    expect(
      markup.slice(
        archivedRadarTagStart,
        markup.indexOf(">", archivedRadar) + 1,
      ),
    ).not.toMatch(/opacity|grayscale|saturate/);
    expect(markup).toContain('data-fleet-evidence-disclosure="compact"');
    expect(markup).toMatch(/data-hud-variant="danger"[^>]*>Delete<\/button>/);
    expect(markup).not.toContain("ACTIVE");
    expect(markup).toContain("Axis readout");
  });

  it("separates public, private, and archived models in lifecycle order", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetTab, {
        internal: [{ ...promotedModel(), name: "Private Aster", releaseDay: 12 }],
        released: [
          { ...releasedModel(), releaseDay: 40 },
          {
            ...releasedModel(),
            id: "nova",
            name: "Newer Nova",
            releaseDay: 80,
          },
        ],
        archived: [{ ...releasedModel(), id: "legacy", name: "Legacy Ember", archived: true, releaseDay: 8 }],
        pricingId: "spark",
        frontierCapability: 60,
        onSelect: vi.fn(),
        onRelease: vi.fn(),
        onDelete: vi.fn(),
        onArchive: vi.fn(),
        onRestore: vi.fn(),
        onTrainFurther: vi.fn(),
        onDistill: vi.fn(),
      }),
    );

    expect(markup).toContain("Trained models");
    expect(markup).toContain("Private checkpoints");
    expect(markup).toContain("Public fleet");
    expect(markup.indexOf('id="public-fleet-heading"')).toBeLessThan(markup.indexOf('id="private-fleet-heading"'));
    expect(markup.indexOf('id="private-fleet-heading"')).toBeLessThan(markup.indexOf('data-fleet-archive-disclosure="true"'));
    expect(markup.indexOf("Spark")).toBeLessThan(markup.indexOf("Newer Nova"));
    expect(markup.indexOf("Newer Nova")).toBeLessThan(markup.indexOf("Private Aster"));
    expect(markup.indexOf("Spark")).toBeLessThan(markup.indexOf("Private Aster"));
    expect(markup.indexOf("Private Aster")).toBeLessThan(markup.indexOf("Legacy Ember"));
    expect(markup).toContain("Day 40");
    expect(markup).toContain("Day 12");
    expect(markup).toContain("Scale");
    expect(markup).toContain("Profile");
    expect(markup).toContain("Axis readout");
  });

  it("disables archiving the source of an active safety campaign", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetTab, {
        internal: [],
        released: [releasedModel()],
        pricingId: "spark",
        frontierCapability: 60,
        activeSafetyCampaignModelId: "spark",
        onSelect: vi.fn(),
        onRelease: vi.fn(),
        onDelete: vi.fn(),
        onArchive: vi.fn(),
        onRestore: vi.fn(),
        onTrainFurther: vi.fn(),
        onDistill: vi.fn(),
      }),
    );

    expect(markup).toContain("Safety active");
    expect(markup).toContain("active safety campaign before archiving");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Safety active<\/button>/);
  });
});
