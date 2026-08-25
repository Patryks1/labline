import { describe, expect, it } from "vitest";
import {
  alignmentDataWeights,
  applyEffortLift,
  applyEffortLiftFromRecipe,
  buildEffortPolicies,
  buildModelProductProfile,
  effortBoardsFor,
  effortLevelUnlocked,
  effortViewFor,
  effortViewForRecipe,
  focusToMix,
  foundationDataWeights,
  highestPostTrainStage,
  INSTANT_EFFORT_ID,
  allocateEffortHeadPf,
  instantRecipe,
  migrateEffortRecipes,
  personalityEngagement,
  planPersonalityDissatisfaction,
  quoteEffortTraining,
  scorePersonality,
  servedEffortTokenMultiplier,
  serveTokenMultiplier,
  serveTokenMultiplierForRecipe,
  splitTrainingTokens,
  withServedRecipe,
} from "./modelProduct";
import { defaultDataWeights } from "./data";

describe("model product profile", () => {
  it("strips chat from foundation mixes", () => {
    const mix = foundationDataWeights(defaultDataWeights("dense"));
    expect(mix.chat).toBeLessThan(0.02);
    expect(mix.code).toBeGreaterThan(0.22);
  });

  it("splits a funded token budget into base and post-train slices", () => {
    const split = splitTrainingTokens(1000, 0.22);
    expect(split.postTrainShare).toBeCloseTo(0.22);
    expect(split.baseMTok + split.postTrainMTok).toBeCloseTo(1000, 0);
    expect(split.postTrainMTok).toBeGreaterThan(split.baseMTok * 0.15);
    expect(split.postTrainMTok).toBeLessThan(split.baseMTok);
    expect(splitTrainingTokens(1000, 0.01).postTrainShare).toBe(0.1);
    expect(splitTrainingTokens(1000, 0.9).postTrainShare).toBe(0.9);
    expect(splitTrainingTokens(1000, 0.99).postTrainShare).toBe(0.9);
  });

  it("keeps base chat under the pretrain cap and loads chat into alignment", () => {
    const foundation = foundationDataWeights(defaultDataWeights("dense"));
    expect(foundation.chat).toBeLessThanOrEqual(0.08);
    const align = alignmentDataWeights(foundation);
    expect(align.chat).toBeGreaterThan(0.3);
    expect(align.chat).toBeGreaterThan(foundation.chat);
  });

  it("scores foundation personality low without rerolling capability inputs", () => {
    const foundation = scorePersonality({
      lifecycle: "foundation",
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      chatShare: 0,
      chatQuality: 80,
      sftEffectiveness: 0,
      rlhfEffectiveness: 0,
      chatGymQuality: 0,
      outcomeSeed: 11,
    });
    const aligned = scorePersonality({
      lifecycle: "aligned",
      focus: { coding: 0.1, science: 0.1, research: 0, personality: 0.7, chat: 0.8 },
      chatShare: 0.4,
      chatQuality: 80,
      sftEffectiveness: 0.7,
      rlhfEffectiveness: 0.7,
      chatGymQuality: 0.8,
      outcomeSeed: 11,
    });
    expect(foundation).toBeLessThan(30);
    expect(aligned).toBeGreaterThan(foundation + 20);
  });

  it("cuts paid engagement when personality is poor", () => {
    expect(personalityEngagement(25)).toBeLessThan(0.6);
    expect(personalityEngagement(80)).toBeGreaterThan(0.85);
    expect(planPersonalityDissatisfaction(25)).toBeGreaterThan(
      planPersonalityDissatisfaction(80),
    );
  });

  it("makes high effort cost more tokens unless efficiency is high", () => {
    const poor = serveTokenMultiplier("high", 30);
    const rich = serveTokenMultiplier("high", 90);
    expect(poor).toBeGreaterThan(rich);
    expect(serveTokenMultiplier("low", 50)).toBeLessThan(poor);
  });

  it("locks medium and high effort behind process-reward research", () => {
    expect(effortLevelUnlocked("low", [])).toBe(true);
    expect(effortLevelUnlocked("medium", [])).toBe(false);
    expect(effortLevelUnlocked("high", ["align_process"])).toBe(true);
    const locked = buildEffortPolicies({
      reasoningEnabled: true,
      processEffectiveness: 0.8,
      researchUnlocked: [],
    });
    const open = buildEffortPolicies({
      reasoningEnabled: true,
      processEffectiveness: 0.8,
      researchUnlocked: ["align_process"],
    });
    expect(locked.find((policy) => policy.level === "medium")?.trained).toBe(false);
    expect(open.find((policy) => policy.level === "medium")?.trained).toBe(true);
    expect(open.find((policy) => policy.level === "high")?.trained).toBe(true);
  });

  it("raises capability and hard benches at higher effort without touching personality", () => {
    const base = {
      mmlu: 40,
      coding: 40,
      math: 40,
      vision: 10,
      law: 20,
      health: 20,
      science: 40,
      multilingual: 30,
      agents: 30,
      safety: 50,
      personality: 22,
    };
    const high = applyEffortLift(40, base, {
      level: "high",
      trained: true,
      hardTaskLift: 8,
    });
    expect(high.capability).toBeGreaterThan(40);
    expect(high.benchmarks.math).toBeGreaterThan(base.math);
    expect(high.benchmarks.personality).toBe(22);
  });

  it("charges mixed served efforts more tokens than low alone", () => {
    const profile = buildModelProductProfile({
      completedPostTrainStages: ["process"],
      chatShare: 0.2,
      chatQuality: 60,
      reasoningEnabled: true,
      researchUnlocked: ["align_process"],
    });
    const mixed = withServedRecipe(profile, "medium", true);
    const lowOnly = withServedRecipe(mixed, "medium", false);
    expect(servedEffortTokenMultiplier(mixed)).toBeGreaterThan(
      servedEffortTokenMultiplier(lowOnly),
    );
    expect(effortViewFor({ capability: 30, benchmarks: {
      mmlu: 30, coding: 30, math: 30, vision: 0, law: 0, health: 0,
      science: 30, multilingual: 0, agents: 20, safety: 40, personality: 20,
    }, productProfile: profile }, "medium")?.capability).toBeGreaterThan(30);
  });

  it("treats researched SFT as aligned lifecycle", () => {
    const profile = buildModelProductProfile({
      completedPostTrainStages: ["sft", "rlhf"],
      chatShare: 0.35,
      chatQuality: 70,
      outcomeSeed: 4,
    });
    expect(profile.lifecycle).toBe("aligned");
    expect(profile.personality).toBeGreaterThan(30);
  });

  it("maps alignment research to the strongest completed post-train stage", () => {
    expect(highestPostTrainStage(["sft", "rlhf", "process"])).toBe("process");
    expect(highestPostTrainStage(["sft", "tools"])).toBe("tools");
    expect(highestPostTrainStage([])).toBe("none");
  });

  it("always migrates Instant as the default untrained-free head", () => {
    const recipes = migrateEffortRecipes({
      defaultEffort: "medium",
      servedEfforts: ["low", "medium"],
      effortPolicies: [
        {
          level: "low",
          trained: true,
          quality: 1,
          outputTokenMult: 1,
          hardTaskLift: 0,
        },
        {
          level: "medium",
          trained: true,
          quality: 0.8,
          outputTokenMult: 2.2,
          hardTaskLift: 3.5,
        },
        {
          level: "high",
          trained: false,
          quality: 0.1,
          outputTokenMult: 4.5,
          hardTaskLift: 8,
        },
      ],
    });
    expect(recipes[0]?.id).toBe(INSTANT_EFFORT_ID);
    expect(recipes.find((recipe) => recipe.id === "medium")?.name).toBe("Think");
    expect(recipes.some((recipe) => recipe.id === "high")).toBe(false);
  });

  it("makes an underfunded high-budget recipe expensive and weak", () => {
    const funded = quoteEffortTraining({
      paramsB: 8,
      thinkingTokenMult: 8,
      trainPfDays: 4,
      researchUnlocked: ["align_process"],
    });
    const full = quoteEffortTraining({
      paramsB: 8,
      thinkingTokenMult: 8,
      researchUnlocked: ["align_process"],
    });
    expect(funded.cash).toBeGreaterThan(0);
    expect(funded.quality).toBeLessThan(full.quality);
    expect(funded.quality).toBeLessThan(0.55);
    const dummy = applyEffortLiftFromRecipe(
      40,
      {
        mmlu: 40,
        coding: 40,
        math: 40,
        vision: 10,
        law: 20,
        health: 20,
        science: 40,
        multilingual: 30,
        agents: 30,
        safety: 50,
        personality: 22,
      },
      {
        kind: "trained",
        trained: true,
        thinkingTokenMult: 8,
        quality: funded.quality,
      },
    );
    const strong = applyEffortLiftFromRecipe(
      40,
      {
        mmlu: 40,
        coding: 40,
        math: 40,
        vision: 10,
        law: 20,
        health: 20,
        science: 40,
        multilingual: 30,
        agents: 30,
        safety: 50,
        personality: 22,
      },
      {
        kind: "trained",
        trained: true,
        thinkingTokenMult: 8,
        quality: full.quality,
      },
    );
    expect(dummy.capability).toBeLessThan(strong.capability - 4);
    expect(dummy.benchmarks.personality).toBe(22);
    expect(
      serveTokenMultiplierForRecipe({ thinkingTokenMult: 8 }, 50),
    ).toBeGreaterThan(4);
  });

  it("makes capability-biased heads costlier and stronger than efficiency-biased heads", () => {
    const benches = {
      mmlu: 40,
      coding: 40,
      math: 40,
      vision: 10,
      law: 20,
      health: 20,
      science: 40,
      multilingual: 30,
      agents: 30,
      safety: 50,
      personality: 22,
    };
    const capable = applyEffortLiftFromRecipe(40, benches, {
      kind: "trained",
      trained: true,
      thinkingTokenMult: 4.5,
      quality: 0.85,
      capabilityBias: 1,
    });
    const efficient = applyEffortLiftFromRecipe(40, benches, {
      kind: "trained",
      trained: true,
      thinkingTokenMult: 4.5,
      quality: 0.85,
      capabilityBias: 0,
    });
    expect(capable.capability).toBeGreaterThan(efficient.capability + 1.5);
    const capableCost = serveTokenMultiplierForRecipe(
      { kind: "trained", thinkingTokenMult: 4.5, capabilityBias: 1 },
      50,
    );
    const efficientCost = serveTokenMultiplierForRecipe(
      { kind: "trained", thinkingTokenMult: 4.5, capabilityBias: 0 },
      50,
    );
    expect(capableCost).toBeGreaterThan(efficientCost * 2.5);
  });

  it("keeps Instant free to serve regardless of capability bias", () => {
    const capable = serveTokenMultiplierForRecipe(
      { kind: "instant", thinkingTokenMult: 1, capabilityBias: 1 },
      50,
    );
    const efficient = serveTokenMultiplierForRecipe(
      { kind: "instant", thinkingTokenMult: 1, capabilityBias: 0 },
      50,
    );
    expect(capable).toBeCloseTo(efficient);
    expect(capable).toBeLessThan(
      serveTokenMultiplierForRecipe(
        { kind: "trained", thinkingTokenMult: 4.5, capabilityBias: 0.5 },
        50,
      ),
    );
  });

  it("splits Train PF across heads without draining the whole pool", () => {
    const { remainderPf, byId } = allocateEffortHeadPf(
      [
        {
          ...instantRecipe(),
          trainComputeShare: 0.4,
        },
        {
          id: "high",
          name: "Deep",
          kind: "trained",
          thinkingTokenMult: 4.5,
          trainPfDays: 0,
          trainCash: 0,
          trained: true,
          quality: 0.7,
          served: true,
          trainComputeShare: 0.1,
        },
      ],
      10,
    );
    expect(byId[INSTANT_EFFORT_ID]).toBeCloseTo(4);
    expect(byId.high).toBeCloseTo(1);
    expect(remainderPf).toBeCloseTo(5);
  });

  it("quotes Instant benches at 1× tokens and trained recipes at their thinking budget", () => {
    const profile = buildModelProductProfile({
      completedPostTrainStages: ["process"],
      chatShare: 0.2,
      chatQuality: 60,
      reasoningEnabled: true,
      researchUnlocked: ["align_process"],
    });
    const think = migrateEffortRecipes(profile).find(
      (recipe) => recipe.id === "medium",
    );
    expect(think).toBeDefined();
    const boards = effortBoardsFor(
      {
        capability: 40,
        benchmarks: {
          mmlu: 40,
          coding: 40,
          math: 40,
          vision: 0,
          law: 0,
          health: 0,
          science: 40,
          multilingual: 0,
          agents: 20,
          safety: 40,
          personality: 20,
        },
        productProfile: profile,
      },
      1.2,
      0.01,
    );
    const instant = boards.find((board) => board.id === INSTANT_EFFORT_ID);
    const named = boards.find((board) => board.id === "medium");
    expect(instant?.tokenMult).toBeLessThan(named?.tokenMult ?? 0);
    expect(instant?.usdPerMTok).toBeLessThan(named?.usdPerMTok ?? 0);
    expect(effortViewForRecipe({
      capability: 40,
      benchmarks: {
        mmlu: 40, coding: 40, math: 40, vision: 0, law: 0, health: 0,
        science: 40, multilingual: 0, agents: 20, safety: 40, personality: 20,
      },
      productProfile: withServedRecipe(profile, "medium", true),
    }, INSTANT_EFFORT_ID)?.capability).toBe(40);
  });

  it("raises chat share when personality focus is applied", () => {
    const foundation = foundationDataWeights(defaultDataWeights("dense"));
    const specialized = focusToMix(
      { coding: 0, science: 0, research: 0, personality: 0.8, chat: 0.5 },
      foundation,
    );
    expect(specialized.chat).toBeGreaterThan(foundation.chat);
  });
});
