import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../sim/types";
import { FleetTab } from "./FleetTab";
import type { CheckpointUiRecord } from "./checkpointUi";

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

    expect(markup).toContain("internal · measured checkpoint");
    expect(markup).toContain("Eval score");
    expect(markup).toContain("61.4 · 57.2–65.1");
    expect(markup).toContain("Day 40");
    expect(markup).not.toContain("99.9");
    expect(markup).not.toContain("98.8");
    expect(markup).not.toContain("Tier progress");
    expect(markup).not.toContain("Custom API markup percentage");
    expect(markup).not.toContain("Markup");
    expect(markup).toMatch(/data-hud-variant="danger"[^>]*>Delete<\/button>/);
    expect(markup).not.toContain("Private checkpoints");
    expect(markup).not.toContain("Public fleet");
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
    expect(markup).toContain("Axis readout");
    expect(markup).toContain("$621.26B");
    expect(markup).toContain("Archive");
    expect(markup).toContain("Train new version");
    expect(markup).toContain("Distill");
    expect(markup).toContain("Effort heads");
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
    expect(markup).toContain("ARCHIVED");
    expect(markup).toContain("Train new version");
    expect(markup).toContain("Distill");
    expect(markup).toContain("Restore");
    expect(markup).toMatch(/data-hud-variant="danger"[^>]*>Delete<\/button>/);
    expect(markup).not.toContain("ACTIVE");
    expect(markup).toContain("Axis readout");
  });

  it("groups internal and released cards and orders them by finish day", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetTab, {
        internal: [{ ...promotedModel(), releaseDay: 12 }],
        released: [{ ...releasedModel(), releaseDay: 40 }],
        pricingId: null,
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
    expect(markup).not.toContain("Private checkpoints");
    expect(markup).not.toContain("Public fleet");
    expect(markup.indexOf("Spark")).toBeGreaterThan(-1);
    expect(markup.indexOf("Spark")).toBeLessThan(markup.indexOf("Aster · C32"));
    expect(markup).toContain("Day 40");
    expect(markup).toContain("Day 12");
    expect(markup).toContain("Axis readout");
  });
});
