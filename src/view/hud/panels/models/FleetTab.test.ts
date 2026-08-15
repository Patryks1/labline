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
        onTrainFurther: vi.fn(),
        onDistill: vi.fn(),
      }),
    );

    expect(markup).toContain("internal · measured checkpoint");
    expect(markup).toContain("Eval score");
    expect(markup).toContain("61.4 · 57.2–65.1");
    expect(markup).not.toContain("99.9");
    expect(markup).not.toContain("98.8");
    expect(markup).not.toContain("Tier progress");
    expect(markup).not.toContain("Custom API markup percentage");
    expect(markup).not.toContain("Markup");
  });
});
