import { describe, expect, it } from "vitest";
import type { BenchmarkScores, Model } from "../types";
import { instantRecipe } from "./modelProduct";
import {
  createPendingCheckpointEvaluation,
  eligibleCheckpointEvaluationSuites,
  quoteCheckpointEvaluation,
  resolveCheckpointEvaluation,
} from "./checkpointEvaluation";

const scores = (value: number): BenchmarkScores => ({
  mmlu: value,
  coding: value,
  math: value,
  vision: value,
  law: value,
  health: value,
  science: value,
  multilingual: value,
  agents: value,
  safety: value,
  personality: value,
});

function model(id: string, value = 70, patch: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    family: "dense",
    productPreset: "language",
    paramsB: 7,
    capability: value,
    modalities: ["text", "tools"],
    io: { inputs: { text: 60 }, outputs: { text: 60 }, tools: 50 },
    quality: {
      reasoning: value,
      coding: value,
      chat: value,
      image: 0,
      video: 0,
      safety: value,
      reliability: value,
    },
    benchmarks: scores(value),
    postTrain: "tools",
    trainComputeSpent: 10,
    releaseDay: 0,
    shipped: false,
    release: "internal",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: 2,
    apiPriceInPerMTok: 1,
    apiPriceOutPerMTok: 3,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.6,
    distilled: false,
    trainMode: "pretrain",
    ...patch,
  };
}

describe("stealth checkpoint evaluation", () => {
  it("offers only product-supported suites with the native suite first", () => {
    const image = model("image", 70, {
      family: "diffusion",
      productPreset: "image_generation",
      modalities: ["text", "image"],
      io: { inputs: { text: 60 }, outputs: { image: 70 }, tools: 0 },
    });
    expect(eligibleCheckpointEvaluationSuites(image)).toEqual([
      "image_generation",
    ]);

    const omni = model("omni", 70, {
      family: "omni",
      productPreset: "omni",
      modalities: ["text", "image", "video", "audio", "tools"],
      io: {
        inputs: { text: 60, image: 60, video: 60, audio: 60 },
        outputs: { text: 60, image: 60, video: 60, audio: 60 },
        tools: 60,
      },
    });
    expect(eligibleCheckpointEvaluationSuites(omni)).toEqual([
      "omni_overview",
      "language",
      "image_generation",
      "video_generation",
      "audio_generation",
    ]);
  });

  it("quotes explicit cash, time, evidence quality, and stealth tradeoffs", () => {
    const checkpoint = model("quote");
    const internal = quoteCheckpointEvaluation(checkpoint, {
      suiteIds: ["language"],
      budgetTier: "lean",
      mode: "internal",
    });
    const external = quoteCheckpointEvaluation(checkpoint, {
      suiteIds: ["language"],
      budgetTier: "rigorous",
      mode: "nda_external",
    });
    expect(internal).toMatchObject({ spendPerSuite: 50_000, leakRisk: 0 });
    expect(external.spendPerSuite).toBe(150_000);
    expect(external.totalCost).toBeGreaterThan(internal.totalCost);
    expect(external.durationDays).toBeGreaterThan(internal.durationDays);
    expect(external.accuracy).toBeGreaterThan(internal.accuracy);
    expect(external.leakRisk).toBeGreaterThan(0);
    expect(external.computePfDays).toBeGreaterThan(0);
    expect(external.workload?.taskCount).toBeGreaterThan(0);
    expect(external.inferenceCost).toBeGreaterThan(0);
    expect(() =>
      quoteCheckpointEvaluation(checkpoint, {
        suiteIds: ["image_generation"],
        budgetTier: "lean",
        mode: "internal",
      }),
    ).toThrow(/not supported/);
  });

  it("quotes exact trained effort and rejects unknown recipe ids", () => {
    const checkpoint = model("effort", 60, {
      productProfile: {
        lifecycle: "aligned",
        focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
        personality: 50,
        tokenEfficiency: 50,
        defaultEffortId: "instant",
        effortRecipes: [
          instantRecipe(),
          {
            id: "max",
            name: "Max",
            kind: "trained",
            thinkingTokenMult: 100,
            trainPfDays: 100,
            trainCash: 1_000_000,
            trained: true,
            quality: 0.9,
            served: true,
          },
        ],
      },
    });
    const instant = quoteCheckpointEvaluation(checkpoint, {
      suiteIds: ["language"], budgetTier: "standard", mode: "internal",
      effortRecipeId: "instant",
    });
    const max = quoteCheckpointEvaluation(checkpoint, {
      suiteIds: ["language"], budgetTier: "standard", mode: "internal",
      effortRecipeId: "max",
    });
    expect(max.workload!.billedTokens).toBeGreaterThan(instant.workload!.billedTokens * 10);
    expect(max.computePfDays).toBeGreaterThan(instant.computePfDays! * 10);
    expect(max.totalCost).toBeGreaterThan(instant.totalCost);
    expect(() => quoteCheckpointEvaluation(checkpoint, {
      suiteIds: ["language"], budgetTier: "standard", mode: "internal",
      effortRecipeId: "unknown",
    })).toThrow(/not trained/);
    expect(createPendingCheckpointEvaluation(
      checkpoint,
      { suiteIds: ["language"], budgetTier: "standard", mode: "internal", effortRecipeId: "max" },
      1,
      5,
    ).computeProgressPfDays).toBe(0);
  });

  it("is deterministic and higher spend narrows the same measurement, not a reroll", () => {
    const checkpoint = model("stable");
    const input = { model: checkpoint, seed: 902, scheduledDay: 10 } as const;
    const lean = resolveCheckpointEvaluation({
      ...input,
      request: {
        suiteIds: ["language"],
        budgetTier: "lean",
        mode: "internal",
      },
    });
    const rigorous = resolveCheckpointEvaluation({
      ...input,
      request: {
        suiteIds: ["language"],
        budgetTier: "rigorous",
        mode: "internal",
      },
    });
    const repeat = resolveCheckpointEvaluation({
      ...input,
      request: {
        suiteIds: ["language"],
        budgetTier: "rigorous",
        mode: "internal",
      },
    });
    expect(rigorous).toEqual(repeat);
    const leanMetric = lean.suites[0]!.metrics[0]!;
    const rigorousMetric = rigorous.suites[0]!.metrics[0]!;
    expect(rigorousMetric.high - rigorousMetric.low).toBeLessThan(
      leanMetric.high - leanMetric.low,
    );
    expect(Math.sign(rigorousMetric.score - checkpoint.benchmarks.mmlu)).toBe(
      Math.sign(leanMetric.score - checkpoint.benchmarks.mmlu),
    );
  });

  it("keeps the checkpoint evidence tendency stable across days, modes and report identities", () => {
    const checkpoint = model("stable-across-studies", 70);
    const studies = [
      resolveCheckpointEvaluation({
        model: checkpoint,
        request: {
          suiteIds: ["language"],
          budgetTier: "lean",
          mode: "internal",
        },
        seed: 991,
        scheduledDay: 4,
        reportSequence: 0,
      }),
      resolveCheckpointEvaluation({
        model: checkpoint,
        request: {
          suiteIds: ["language"],
          budgetTier: "rigorous",
          mode: "nda_external",
        },
        seed: 991,
        scheduledDay: 19,
        reportSequence: 1,
      }),
      resolveCheckpointEvaluation({
        model: checkpoint,
        request: {
          suiteIds: ["language"],
          budgetTier: "standard",
          mode: "partner_pilot",
        },
        seed: 991,
        scheduledDay: 41,
        reportSequence: 2,
      }),
    ];
    const metrics = studies.map((report) => report.suites[0]!.metrics[0]!);
    const directions = metrics.map((metric) =>
      Math.sign(metric.score - checkpoint.benchmarks.mmlu),
    );

    expect(new Set(directions).size).toBe(1);
    expect(new Set(studies.map((report) => report.id)).size).toBe(3);
    expect(metrics[1]!.high - metrics[1]!.low).toBeLessThan(
      metrics[0]!.high - metrics[0]!.low,
    );
  });

  it("does not sell a fresh reviewer roll when the same panel is recommissioned", () => {
    const checkpoint = model("stable-panel", 70);
    const lean = resolveCheckpointEvaluation({
      model: checkpoint,
      request: {
        suiteIds: ["language"],
        budgetTier: "lean",
        mode: "internal",
      },
      seed: 887,
      scheduledDay: 3,
      reportSequence: 0,
    });
    const rigorous = resolveCheckpointEvaluation({
      model: checkpoint,
      request: {
        suiteIds: ["language"],
        budgetTier: "rigorous",
        mode: "internal",
      },
      seed: 887,
      scheduledDay: 33,
      reportSequence: 1,
    });

    for (let index = 0; index < lean.reviews.length; index += 1) {
      expect(rigorous.reviews[index]!.reviewerId).toBe(
        lean.reviews[index]!.reviewerId,
      );
      expect(rigorous.reviews[index]!.bias).toBe(lean.reviews[index]!.bias);
      expect(Math.sign(rigorous.reviews[index]!.noise)).toBe(
        Math.sign(lean.reviews[index]!.noise),
      );
      expect(Math.abs(rigorous.reviews[index]!.noise)).toBeLessThanOrEqual(
        Math.abs(lean.reviews[index]!.noise),
      );
    }
  });

  it("returns structured domain results and rival comparison without mutating capability", () => {
    const checkpoint = model("ours", 72);
    const before = structuredClone(checkpoint);
    const report = resolveCheckpointEvaluation({
      model: checkpoint,
      rivals: [{ model: model("leader", 80), labName: "Northstar" }],
      request: {
        suiteIds: ["language"],
        budgetTier: "standard",
        mode: "nda_external",
      },
      seed: 44,
      scheduledDay: 3,
    });
    expect(report.suites[0]!.metrics).toHaveLength(11);
    expect(report.suites[0]!.metrics[0]!.rival).toMatchObject({
      modelId: "leader",
      labName: "Northstar",
      fieldSize: 2,
    });
    expect(report.reviews).toHaveLength(report.quote.reviewerCount);
    expect(report.reviews.every((review) => review.identityBlind)).toBe(true);
    expect(report).not.toHaveProperty("capability");
    expect(checkpoint).toEqual(before);
  });

  it("tailors blind reviewers to model outputs and models external leak risk", () => {
    const image = model("creator", 75, {
      family: "diffusion",
      productPreset: "image_generation",
      modalities: ["text", "image"],
      io: { inputs: { text: 60 }, outputs: { image: 70 }, tools: 0 },
      // A stale/high legacy coding score must not recruit a developer-tools
      // reviewer for a generation-only product with no tools interface.
      benchmarks: { ...scores(75), coding: 90, agents: 5 },
      quality: {
        reasoning: 40,
        coding: 10,
        chat: 50,
        image: 82,
        video: 0,
        safety: 70,
        reliability: 70,
      },
    });
    const report = resolveCheckpointEvaluation({
      model: image,
      request: {
        suiteIds: ["image_generation"],
        budgetTier: "rigorous",
        mode: "partner_pilot",
      },
      seed: 9,
      scheduledDay: 2,
    });
    expect(
      report.reviews.some((review) => review.focus === "image_creator"),
    ).toBe(true);
    expect(
      report.reviews.some((review) => review.focus === "developer_tools"),
    ).toBe(false);
    expect(report.leakRisk).toBeGreaterThan(0);
    expect(["none", "rumor", "identity_leak"]).toContain(report.leakOutcome);
    const pending = createPendingCheckpointEvaluation(
      image,
      report.request,
      9,
      2,
    );
    expect(pending.readyDay - pending.scheduledDay).toBe(
      report.quote.durationDays,
    );
  });
});
