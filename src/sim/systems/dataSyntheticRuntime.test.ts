import { describe, expect, it } from "vitest";
import { emptyBenchmarks } from "../balance/benchmarks";
import { teacherCapabilityForDataDomain } from "../balance/modelCapabilities";
import {
  syntheticJobQuality,
  teacherDomainStrength,
} from "../balance/syntheticTraining";
import { createGame } from "../createGame";
import { roundTripState } from "../save";
import type { Model, SimState } from "../types";
import {
  consumeForTraining,
  estimateSynthBudget,
  startSynthBudget,
  startSynthGen,
  synthTeacherFreshness,
  tickData,
} from "./data";

function teacher(): Model {
  return {
    id: "teacher-domain-runtime",
    name: "Domain Teacher",
    family: "dense",
    paramsB: 7,
    capability: 72,
    capabilities: {
      domains: {
        language: 78,
        reasoning: 60,
        code: 32,
        math: 28,
        science: 35,
        vision: 18,
        video: 8,
        audio: 12,
        tools: 30,
      },
      factuality: 64,
      steerability: 70,
      robustness: 62,
      safety: 72,
      reliability: 75,
    },
    modalities: ["text"],
    quality: {
      reasoning: 65,
      coding: 40,
      chat: 74,
      image: 10,
      video: 5,
      safety: 72,
      reliability: 75,
    },
    benchmarks: emptyBenchmarks(),
    postTrain: "rlhf",
    trainComputeSpent: 80,
    releaseDay: 1,
    shipped: true,
    release: "released",
    tokPerSecMult: 1,
    inferCostMult: 1,
    apiPricePerMTok: 2,
    apiPriceInPerMTok: 1,
    apiPriceOutPerMTok: 3,
    suggestedApiPrice: 2,
    suggestedApiPriceIn: 1,
    suggestedApiPriceOut: 3,
    costApiPriceIn: 0.2,
    costApiPriceOut: 0.8,
    distilled: false,
    trainMode: "pretrain",
  };
}

describe("synthetic data runtime", () => {
  it("prices generated quality from teacher strength, method, filtering, and depth decay", () => {
    let state = createGame(702);
    const model = teacher();
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };
    state = startSynthGen(state, {
      domain: "chat",
      modelId: model.id,
      targetMTok: 5,
      researchShare: 0.5,
      qualityTier: "hq",
    });
    state = tickData(state);

    const asset = state.player.data.assets.find(
      (item) => item.source === "synthetic",
    );
    expect(asset?.synthetic).toBeDefined();
    const expected = syntheticJobQuality({
      teacherStrength: teacherDomainStrength({
        domainBenchmark: teacherCapabilityForDataDomain(model, "chat"),
        reliability: model.quality.reliability,
        capability: model.capability,
      }),
      method: "filtered",
      filterIntensity: 0.7,
      generationDepth: 1,
    });
    expect(asset?.quality).toBeCloseTo(expected, 8);
    expect(asset!.quality).toBeLessThanOrEqual(
      model.capabilities!.domains.language,
    );
    expect(state.player.data.stocks.chat.quality).toBeLessThanOrEqual(
      model.capabilities!.domains.language,
    );
  });

  it("runs continuously and degrades corpus quality when a stronger frontier teacher appears", () => {
    const model = teacher();
    const frontier = {
      ...teacher(),
      id: "frontier-teacher",
      name: "Frontier Teacher",
      capability: 95,
      capabilities: {
        ...teacher().capabilities!,
        domains: { ...teacher().capabilities!.domains, language: 98 },
      },
    };
    let state = createGame(703);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [{ ...state.rivals[0]!, models: [frontier] }],
    };
    state = startSynthGen(state, {
      domain: "chat",
      modelId: model.id,
      researchShare: 0.35,
      qualityTier: "hq",
    });
    expect(state.player.data.synthQueue[0]?.continuous).toBe(true);
    state = tickData(state);
    const first = state.player.data.synthQueue[0]?.progressMTok ?? 0;
    state = tickData({ ...state, day: state.day + 1 });
    expect(state.player.data.synthQueue[0]?.progressMTok).toBeGreaterThan(
      first,
    );
    expect(synthTeacherFreshness(state, model, "chat").freshness).toBeLessThan(
      1,
    );
    const asset = state.player.data.assets.find(
      (item) => item.source === "synthetic",
    );
    expect(asset?.freshness).toBeLessThan(1);
  });

  it("turns one compute budget into probabilistic processed HQ, LQ, and rejected output", () => {
    const model = teacher();
    let state = createGame(704);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };
    const small = estimateSynthBudget(state, 0.1);
    const large = estimateSynthBudget(state, 0.5);
    expect(large.grossMTokPerDay).toBeGreaterThan(small.grossMTokPerDay);
    expect(large.acceptedMTokPerDay).toBeGreaterThan(small.acceptedMTokPerDay);
    // Extra PF is a small filter bonus. Quality is capability-gated.
    expect(large.usefulChance - small.usefulChance).toBeLessThan(0.08);
    expect(large.hqChance - small.hqChance).toBeLessThan(0.06);

    const beforeProcessed = Object.values(state.player.data.stocks).reduce(
      (sum, stock) => sum + stock.processed,
      0,
    );
    state = startSynthBudget(state, { researchShare: 0.5 });
    expect(state.player.data.synthQueue[0]?.autoPortfolio).toBe(true);
    state = tickData(state);
    const job = state.player.data.synthQueue[0]!;
    const afterProcessed = Object.values(state.player.data.stocks).reduce(
      (sum, stock) => sum + stock.processed,
      0,
    );
    expect((job.hqMTok ?? 0) + (job.lqMTok ?? 0)).toBeGreaterThan(0);
    expect(job.wastedMTok ?? 0).toBeGreaterThan(0);
    expect(afterProcessed).toBeGreaterThan(beforeProcessed);
    expect(
      state.player.data.assets.some((asset) => asset.source === "synthetic"),
    ).toBe(true);
  });

  it("routes each corpus to its persisted teacher and exposes fit-adjusted economics", () => {
    const general = teacher();
    const mathTeacher: Model = {
      ...teacher(),
      id: "math-route-teacher",
      name: "Proof Route",
      paramsB: 3,
      capabilities: {
        ...teacher().capabilities!,
        domains: {
          ...teacher().capabilities!.domains,
          math: 94,
          reasoning: 88,
          tools: 82,
        },
      },
      io: {
        inputs: { text: 90 },
        outputs: { text: 92 },
        tools: 82,
      },
    };
    const imageTeacher: Model = {
      ...teacher(),
      id: "image-route-teacher",
      name: "Pixel Route",
      family: "diffusion",
      productPreset: "image_generation",
      paramsB: 2,
      capabilities: {
        ...teacher().capabilities!,
        domains: {
          ...teacher().capabilities!.domains,
          vision: 91,
        },
      },
      io: {
        inputs: { text: 90, image: 48 },
        outputs: { image: 92 },
        tools: 0,
      },
      quality: { ...teacher().quality, image: 90 },
    };
    let state = createGame(7_041);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [general, mathTeacher, imageTeacher],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };

    const estimate = estimateSynthBudget(state, 0.4, {
      math: mathTeacher.id,
      image: imageTeacher.id,
    });
    const math = estimate.domains.find((route) => route.domain === "math")!;
    const image = estimate.domains.find((route) => route.domain === "image")!;
    const chat = estimate.domains.find((route) => route.domain === "chat")!;

    expect(math.teacher?.id).toBe(mathTeacher.id);
    expect(math.assignment).toBe("assigned");
    expect(image.teacher?.id).toBe(imageTeacher.id);
    expect(image.modalityFit).toBeGreaterThan(0.75);
    expect(chat.assignment).toBe("auto");
    expect(estimate.acceptedMTokPerDay).toBeGreaterThan(0);
    expect(estimate.dailyComputeCost).toBeGreaterThan(0);
    expect(estimate.powerMw).toBeGreaterThan(0);
    expect(estimate.costPerAcceptedMTok).toBeGreaterThan(0);
    expect(estimate.kwhPerAcceptedMTok).toBeGreaterThan(0);
  });

  it("makes a larger equivalent teacher more expensive and power-intensive per accepted token", () => {
    const small: Model = {
      ...teacher(),
      id: "small-teacher",
      name: "Small Teacher",
      paramsB: 1,
      activeParamsB: 1,
    };
    const large: Model = {
      ...teacher(),
      id: "large-teacher",
      name: "Large Teacher",
      paramsB: 120,
      activeParamsB: 120,
    };
    let state = createGame(7_042);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [small, large],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };

    const smallRoute = estimateSynthBudget(state, 0.35, {
      chat: small.id,
    }).domains.find((route) => route.domain === "chat")!;
    const largeRoute = estimateSynthBudget(state, 0.35, {
      chat: large.id,
    }).domains.find((route) => route.domain === "chat")!;

    expect(largeRoute.acceptedMTokPerDay).toBeLessThan(
      smallRoute.acceptedMTokPerDay,
    );
    expect(largeRoute.costPerAcceptedMTok).toBeGreaterThan(
      smallRoute.costPerAcceptedMTok,
    );
    expect(largeRoute.kwhPerAcceptedMTok).toBeGreaterThan(
      smallRoute.kwhPerAcceptedMTok,
    );
  });

  it("lets a more capable teacher accept more high-quality tokens at the same size", () => {
    const weak: Model = {
      ...teacher(),
      id: "weak-chat-teacher",
      name: "Weak Chat",
      capability: 42,
      capabilities: {
        ...teacher().capabilities!,
        domains: { ...teacher().capabilities!.domains, language: 38 },
      },
    };
    const strong: Model = {
      ...teacher(),
      id: "strong-chat-teacher",
      name: "Strong Chat",
      capability: 88,
      capabilities: {
        ...teacher().capabilities!,
        domains: { ...teacher().capabilities!.domains, language: 86 },
      },
    };
    let state = createGame(7_045);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [weak, strong],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };

    const weakRoute = estimateSynthBudget(state, 0.35, {
      chat: weak.id,
    }).domains.find((route) => route.domain === "chat")!;
    const strongRoute = estimateSynthBudget(state, 0.35, {
      chat: strong.id,
    }).domains.find((route) => route.domain === "chat")!;

    expect(strongRoute.usefulChance).toBeGreaterThan(weakRoute.usefulChance);
    expect(strongRoute.hqChance).toBeGreaterThan(weakRoute.hqChance * 1.8);
    expect(strongRoute.acceptedMTokPerDay).toBeGreaterThan(
      weakRoute.acceptedMTokPerDay,
    );
  });

  it("falls back to Auto when an assigned teacher is deleted", () => {
    const model = teacher();
    let state = createGame(7_043);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
      },
      rivals: [],
    };
    const route = estimateSynthBudget(state, 0.25, {
      chat: "deleted-teacher",
    }).domains.find((candidate) => candidate.domain === "chat")!;

    expect(route.assignment).toBe("fallback");
    expect(route.teacher?.id).toBe(model.id);
    expect(route.validation).toContain("unavailable");
  });

  it("keeps historical teacher lineage when a live corpus route changes", () => {
    const first = teacher();
    const second: Model = {
      ...teacher(),
      id: "second-math-teacher",
      name: "Second Math Teacher",
      capabilities: {
        ...teacher().capabilities!,
        domains: { ...teacher().capabilities!.domains, math: 82 },
      },
    };
    let state = createGame(7_044);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [first, second],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };
    state = startSynthBudget(state, {
      researchShare: 0.4,
      teacherModelIds: { math: first.id },
    });
    state = tickData(state);
    const firstStock = state.player.data.stocks.math.processed;
    state = startSynthBudget(state, {
      researchShare: 0.4,
      teacherModelIds: { math: second.id },
    });
    state = tickData({ ...state, day: state.day + 1 });

    const mathAssets = state.player.data.assets.filter(
      (asset) =>
        asset.source === "synthetic" && (asset.domainWeights.math ?? 0) > 0,
    );
    expect(state.player.data.stocks.math.processed).toBeGreaterThan(firstStock);
    expect(
      mathAssets.some((asset) =>
        asset.synthetic?.teacherModelIds.includes(first.id),
      ),
    ).toBe(true);
    expect(
      mathAssets.some((asset) =>
        asset.synthetic?.teacherModelIds.includes(second.id),
      ),
    ).toBe(true);
  });

  it("enforces the requested synthetic expansion cap in the simulation", () => {
    const model = teacher();
    let state = createGame(705);
    state = {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
      },
      rivals: [],
    };
    const result = consumeForTraining(
      state,
      {
        totalMTok: 10_000,
        totalUnits: 10_000,
        weights: {
          code: 0,
          math: 0,
          science: 0,
          law: 0,
          health: 0,
          chat: 1,
          image: 0,
          video: 0,
          audio: 0,
        },
        trainShare: 0.82,
        allowSynthetic: true,
        syntheticMultiplier: 0.5,
        includeSynthHQ: true,
        includeSynthLQ: false,
        syntheticTeacherIds: { chat: model.id },
      },
      1,
      "dense",
    );
    const total = Object.values(result.consumed).reduce(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    const real = total - result.syntheticUnits;

    expect(result.syntheticUnits).toBeLessThanOrEqual(real * 0.5 + 1e-6);
    expect(total).toBeLessThan(10_000);
  });
});

describe("targeted synthetic generation jobs", () => {
  function labWith(model: Model, seed: number): SimState {
    const state = createGame(seed);
    return {
      ...state,
      player: {
        ...state.player,
        models: [model],
        researchUnlocked: [...state.player.researchUnlocked, "data_synth"],
        allocation: { training: 0.1, inference: 0.1, research: 0.8 },
      },
      rivals: [],
    };
  }

  it("a teacher weak at math generates a weak math corpus despite a high general score", () => {
    const weakMath = teacher(); // capability 72 but math domain 28
    const strongMath: Model = {
      ...teacher(),
      id: "math-teacher",
      name: "Math Teacher",
      capabilities: {
        ...teacher().capabilities!,
        domains: { ...teacher().capabilities!.domains, math: 88 },
      },
    };
    const qualityOf = (model: Model, seed: number) => {
      let state = labWith(model, seed);
      state = startSynthGen(state, {
        domain: "math",
        modelId: model.id,
        targetMTok: 5,
        researchShare: 0.5,
        qualityTier: "hq",
        filterIntensity: 0.7,
      });
      state = tickData(state);
      return state.player.data.assets.find(
        (asset) => asset.source === "synthetic",
      )?.quality;
    };
    const weak = qualityOf(weakMath, 706);
    const strong = qualityOf(strongMath, 707);

    expect(weak).toBeDefined();
    expect(strong).toBeDefined();
    expect(weak!).toBeLessThan(strong! * 0.75);
    expect(
      teacherDomainStrength({
        domainBenchmark: teacherCapabilityForDataDomain(weakMath, "math"),
        reliability: weakMath.quality.reliability,
        capability: weakMath.capability,
      }),
    ).toBeLessThan(
      teacherDomainStrength({
        domainBenchmark: teacherCapabilityForDataDomain(strongMath, "math"),
        reliability: strongMath.quality.reliability,
        capability: strongMath.capability,
      }),
    );
  });

  it("deposits generated tokens only in the chosen target corpus", () => {
    const model = teacher();
    let state = labWith(model, 708);
    const chatBefore = state.player.data.stocks.chat.processed;
    const codeBefore = state.player.data.stocks.code.processed;
    state = startSynthGen(state, {
      domain: "math",
      modelId: model.id,
      targetMTok: 5,
      researchShare: 0.5,
      qualityTier: "hq",
    });
    state = tickData(state);

    expect(state.player.data.stocks.math.processed).toBeGreaterThan(0.05);
    expect(state.player.data.stocks.chat.processed).toBeCloseTo(chatBefore, 12);
    expect(state.player.data.stocks.chat.processed).toBeCloseTo(chatBefore, 12);
    expect(state.player.data.stocks.code.processed).toBeCloseTo(codeBefore, 12);
    const asset = state.player.data.assets.find(
      (item) => item.source === "synthetic",
    );
    expect(asset?.domainWeights).toEqual({ math: 1 });
  });

  it("stops a targeted job when its persisted compute budget is spent", () => {
    const model = teacher();
    let state = labWith(model, 709);
    state = startSynthGen(state, {
      domain: "chat",
      modelId: model.id,
      researchShare: 0.5,
      qualityTier: "hq",
      computeBudgetPfDays: 0.05,
    });
    state = tickData(state);
    expect(state.player.data.synthQueue[0]?.pfDaysSpent ?? 0).toBeGreaterThan(
      0,
    );
    state = tickData({ ...state, day: state.day + 1 });
    expect(state.player.data.synthQueue).toHaveLength(0);
    expect(
      state.alerts.some((alert) => alert.message.includes("budget spent")),
    ).toBe(true);
  });

  it("charges targeted generation for its research-compute runtime", () => {
    const model = teacher();
    let state = labWith(model, 7091);
    state = startSynthGen(state, {
      domain: "chat",
      modelId: model.id,
      targetMTok: 5,
      researchShare: 0.5,
      qualityTier: "hq",
    });
    const cashBefore = state.player.cash;

    state = tickData(state);

    expect(state.player.data.stocks.chat.processed).toBeGreaterThan(0);
    expect(state.player.cash).toBeLessThan(cashBefore);
  });

  it("persists teacher, corpus, volume, tier, filtering, and budget across saves", () => {
    const model = teacher();
    let state = labWith(model, 710);
    state = startSynthGen(state, {
      domain: "science",
      modelId: model.id,
      targetMTok: 40,
      researchShare: 0.3,
      qualityTier: "lq",
      filterIntensity: 0.85,
      computeBudgetPfDays: 120,
    });
    const restored = roundTripState(state);
    const job = restored.player.data.synthQueue.find(
      (candidate) => candidate.modelId === model.id,
    );

    expect(job).toMatchObject({
      domain: "science",
      modelId: model.id,
      targetMTok: 40,
      qualityTier: "lq",
      filterIntensity: 0.85,
      computeBudgetPfDays: 120,
    });
  });

  it("round-trips automatic per-corpus teacher assignments", () => {
    const model = teacher();
    let state = labWith(model, 711);
    state = startSynthBudget(state, {
      researchShare: 0.3,
      teacherModelIds: {
        chat: model.id,
        science: model.id,
      },
    });

    const restored = roundTripState(state);
    const job = restored.player.data.synthQueue.find(
      (candidate) => candidate.autoPortfolio,
    );
    expect(job?.teacherModelIds).toEqual({
      chat: model.id,
      science: model.id,
    });
    expect(job?.researchShare).toBe(0.3);
  });
});
