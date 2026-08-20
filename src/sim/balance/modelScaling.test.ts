import { describe, expect, it } from "vitest";
import {
  capabilityCeiling,
  effectiveScaleParamsB,
  mixFit,
  moeRoutingCapacityMultiplier,
  overtrainBonus,
  overtrainCap,
  paramScalePotential,
  postTrainSizePunch,
  scaleIntelligence,
} from "./modelScaling";
import { commercialModelKind } from "./pricing";
import { aggregateEffects } from "../systems/research";

describe("general capability ceilings", () => {
  const base = {
    dataCoverage: 6,
    dataQuality: 1,
    family: "dense" as const,
    mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
  };

  it("keeps small pretrained models below larger models with the same corpus", () => {
    const small = capabilityCeiling({ ...base, paramsB: 1 });
    const medium = capabilityCeiling({ ...base, paramsB: 34 });
    const large = capabilityCeiling({ ...base, paramsB: 405 });

    expect(small.capability).toBeLessThan(35);
    expect(medium.capability).toBeGreaterThan(small.capability + 15);
    expect(large.capability).toBeGreaterThan(medium.capability + 12);
  });

  it("makes exceptional data and reasoning technology expensive headroom, not a free bypass", () => {
    const ordinary = capabilityCeiling({
      ...base,
      paramsB: 7,
      dataQuality: 0.9,
    });
    const exceptional = capabilityCeiling({
      ...base,
      paramsB: 7,
      dataCoverage: 20,
      dataQuality: 1.35,
      researchMult: 1.12,
      reasoningEnabled: true,
    });

    expect(exceptional.capability).toBeGreaterThan(ordinary.capability + 10);
    expect(exceptional.capability).toBeLessThan(70);
    expect(exceptional.technologyBonus).toBeGreaterThan(
      ordinary.technologyBonus + 8,
    );
  });

  it("allows a strong teacher to raise a small student ceiling through distillation", () => {
    const pretrain = capabilityCeiling({ ...base, paramsB: 1 });
    const distilled = capabilityCeiling({
      ...base,
      paramsB: 1,
      teacherCapability: 80,
    });

    expect(distilled.capability).toBeGreaterThan(pretrain.capability + 30);
    expect(distilled.capability).toBeCloseTo(70.4, 1);
    expect(distilled.limitingFactor).toBe("teacher");
  });
});

describe("post-train size punch", () => {
  it("gives smaller models more capability from the same post-train work", () => {
    const small = postTrainSizePunch(0.9, paramScalePotential(7), true);
    const large = postTrainSizePunch(0.9, paramScalePotential(70), true);
    expect(small).toBeGreaterThan(large);
    expect(small).toBeGreaterThan(5);
  });
});

describe("overtrain / compute-intensity axis", () => {
  const common = {
    paramsB: 7,
    dataQuality: 1,
    family: "dense" as const,
    mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
    trainComplete: 1,
    postTrainStrength: 0.7,
  };

  it("raises capability with higher compute-intensity at fixed params and quality", () => {
    const atTarget = scaleIntelligence({ ...common, dataCoverage: 6 });
    const overtrained = scaleIntelligence({ ...common, dataCoverage: 20 });

    expect(overtrained.capability).toBeGreaterThan(atTarget.capability);
    expect(overtrained.overtrain).toBeGreaterThan(atTarget.overtrain);
    expect(overtrained.overtrain).toBeGreaterThan(1);
  });

  it("hard-caps overtrain near +1.5 without research unlocks", () => {
    expect(overtrainCap(0)).toBeCloseTo(1.5, 12);
    expect(overtrainBonus(40, 0)).toBeLessThanOrEqual(1.5);
    expect(overtrainBonus(40, 0)).toBeGreaterThan(1.2);

    const high = scaleIntelligence({ ...common, dataCoverage: 40 });
    const higher = scaleIntelligence({ ...common, dataCoverage: 80 });
    expect(high.overtrain).toBeLessThanOrEqual(1.5);
    expect(higher.overtrain - high.overtrain).toBeLessThan(0.25);
  });

  it("lets research raise the overtrain hard cap", () => {
    const unlocked = aggregateEffects([
      "data_synth",
      "data_self_train",
      "align_process",
      "align_grpo",
      "opt_compute_sched",
    ]);
    expect(unlocked.overtrainCapBonus).toBeGreaterThan(5);
    expect(overtrainCap(unlocked.overtrainCapBonus ?? 0)).toBeGreaterThan(6);
    expect(overtrainCap(unlocked.overtrainCapBonus ?? 0)).toBeLessThanOrEqual(8);

    const baseRun = scaleIntelligence({
      ...common,
      dataCoverage: 24,
      overtrainCapBonus: 0,
    });
    const researched = scaleIntelligence({
      ...common,
      dataCoverage: 24,
      overtrainCapBonus: unlocked.overtrainCapBonus,
    });
    expect(researched.overtrain).toBeGreaterThan(baseRun.overtrain + 3);
    expect(researched.capability).toBeGreaterThan(baseRun.capability + 2);
  });

  it("keeps early-tech tiny models hard-capped while late tech punches up", () => {
    const early = scaleIntelligence({
      paramsB: 0.1,
      dataCoverage: 20,
      dataQuality: 1.35,
      mixWeights: { math: 1 },
      researchMult: 1,
      overtrainCapBonus: 0,
    });
    expect(early.capability).toBeLessThan(20);

    const late = scaleIntelligence({
      paramsB: 0.1,
      dataCoverage: 20,
      dataQuality: 1.35,
      mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
      researchMult: 1.14,
      reasoningEnabled: true,
      overtrainCapBonus: 6.8,
      trainComplete: 1,
      postTrainStrength: 0.7,
    });
    // Tech + post-train punch on a tiny late model (~mid 30s–low 40s).
    expect(late.capability).toBeGreaterThanOrEqual(32);
    expect(late.capability).toBeLessThanOrEqual(48);
  });
});

describe("early / late capability design targets", () => {
  const earlyRecipe = {
    dataCoverage: 8,
    dataQuality: 1,
    researchMult: 1,
    overtrainCapBonus: 0,
    family: "dense" as const,
    mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
    trainComplete: 1,
    postTrainStrength: 0.35,
  };

  it("keeps early millions-param models in the low single / low teens band", () => {
    const m70 = scaleIntelligence({ ...earlyRecipe, paramsB: 0.07 });
    const m600 = scaleIntelligence({ ...earlyRecipe, paramsB: 0.6 });
    const m878 = scaleIntelligence({ ...earlyRecipe, paramsB: 0.878 });

    expect(m70.capability).toBeGreaterThanOrEqual(4);
    expect(m70.capability).toBeLessThanOrEqual(9);
    expect(m600.capability).toBeGreaterThanOrEqual(6);
    expect(m600.capability).toBeLessThanOrEqual(12);
    // Leaderboard case: sub-1B must not read as mid-pack.
    expect(m878.capability).toBeLessThanOrEqual(14);
  });

  it("lets early 7B sit mid-teens–mid-20s and early 70B mid-pack", () => {
    const m7 = scaleIntelligence({ ...earlyRecipe, paramsB: 7 });
    const m70 = scaleIntelligence({ ...earlyRecipe, paramsB: 70 });

    expect(m7.capability).toBeGreaterThanOrEqual(16);
    expect(m7.capability).toBeLessThanOrEqual(28);
    expect(m70.capability).toBeGreaterThanOrEqual(45);
    expect(m70.capability).toBeLessThanOrEqual(65);
  });

  it("lets late tech punch tiny models into the mid-30s without matching frontier scale", () => {
    const lateTiny = scaleIntelligence({
      paramsB: 0.1,
      dataCoverage: 20,
      dataQuality: 1.1,
      mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
      researchMult: 1.14,
      reasoningEnabled: true,
      overtrainCapBonus: 6.8,
      trainComplete: 1,
      postTrainStrength: 0.7,
    });
    expect(lateTiny.capability).toBeGreaterThanOrEqual(32);
    expect(lateTiny.capability).toBeLessThanOrEqual(48);
  });

  it("makes a well-fed early 1B beat a data-starved 70B, then needs scale later", () => {
    const earlySmall = scaleIntelligence({
      ...earlyRecipe,
      paramsB: 1,
      dataCoverage: 6,
    });
    const starvedLarge = scaleIntelligence({
      ...earlyRecipe,
      paramsB: 70,
      // Same ~8B-token corpus as a 1B at 8N.
      dataCoverage: 8 / 70,
    });
    const laterLarge = scaleIntelligence({
      ...earlyRecipe,
      paramsB: 70,
      dataCoverage: 8,
    });
    expect(earlySmall.capability).toBeGreaterThan(starvedLarge.capability);
    expect(laterLarge.capability).toBeGreaterThan(earlySmall.capability + 20);
  });

  it("lets a late post-trained 7B close in on a raw 70B without matching it", () => {
    const rawSeventy = scaleIntelligence({
      paramsB: 70,
      dataCoverage: 8,
      dataQuality: 1,
      researchMult: 1.04,
      family: "dense",
      mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
      trainComplete: 1,
      postTrainStrength: 0.1,
    });
    const alignedSeven = scaleIntelligence({
      paramsB: 7,
      dataCoverage: 20,
      dataQuality: 1.3,
      researchMult: 1.12,
      reasoningEnabled: true,
      overtrainCapBonus: 6,
      family: "dense",
      mixWeights: { chat: 0.4, code: 0.3, math: 0.3 },
      trainComplete: 1,
      postTrainStrength: 0.95,
    });
    expect(alignedSeven.capability).toBeGreaterThan(rawSeventy.capability - 12);
    expect(alignedSeven.capability).toBeLessThan(rawSeventy.capability);
  });
});

describe("reasoning workload classification", () => {
  it("forces reasoning commercial kind when reasoningEnabled is set", () => {
    const weakBenches = {
      mmlu: 40,
      coding: 40,
      math: 40,
      vision: 10,
      law: 30,
      health: 30,
      science: 35,
      multilingual: 40,
      agents: 35,
      safety: 50,
      personality: 28,
    };
    expect(
      commercialModelKind({
        family: "dense",
        productPreset: "language",
        io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 0 },
        benchmarks: weakBenches,
        reasoningEnabled: true,
      }),
    ).toBe("reasoning");
    expect(
      commercialModelKind({
        family: "dense",
        productPreset: "language",
        io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 0 },
        benchmarks: weakBenches,
        reasoningEnabled: false,
      }),
    ).toBe("language");
  });
});

describe("first-class math and science scaling", () => {
  it("counts math and science evidence in mix specialization", () => {
    const math = mixFit({ math: 1 });
    const science = mixFit({ science: 1 });

    expect(math.general).toBeCloseTo(0.5, 12);
    expect(math.domainBoost.math).toBe(1);
    expect(math.domainBoost.science).toBe(0);
    expect(science.domainBoost.science).toBe(1);
    expect(science.domainBoost.math).toBe(0);
  });

  it("smoothly narrows general capability once the top domains exceed 60%", () => {
    const broad = mixFit({ chat: 0.2, code: 0.15, math: 0.15, science: 0.15, law: 0.1, health: 0.1, image: 0.05, video: 0.05, audio: 0.05 });
    const threshold = mixFit({ math: 0.4, code: 0.21, chat: 0.13, science: 0.13, law: 0.13 });
    const extreme = mixFit({ math: 0.96, chat: 0.04 });

    expect(threshold.general).toBeLessThan(broad.general);
    expect(threshold.specialization).toBeGreaterThan(0);
    expect(extreme.generalPenalty).toBeCloseTo(0.5, 12);
    expect(extreme.general).toBeGreaterThanOrEqual(0.5);
    expect(extreme.domainBoost.math).toBe(1);
  });

  it("does not let specialization bypass early parameter ceilings", () => {
    const tiny = scaleIntelligence({
      paramsB: 0.1,
      dataCoverage: 20,
      dataQuality: 1.35,
      mixWeights: { math: 1 },
      researchMult: 1,
      overtrainCapBonus: 0,
    });
    expect(tiny.capability).toBeLessThan(20);
    expect(tiny.benchCeilings.math).toBeLessThan(70);
  });

  it("lets a code-only mix beat a generalist on coding while losing elsewhere", () => {
    const base = {
      paramsB: 20,
      dataCoverage: 6,
      dataQuality: 1,
      trainComplete: 1,
      postTrainStrength: 0.5,
    };
    const general = scaleIntelligence({
      ...base,
      mixWeights: {
        chat: 0.22,
        code: 0.22,
        math: 0.2,
        science: 0.18,
        law: 0.1,
        health: 0.08,
      },
    });
    const coder = scaleIntelligence({
      ...base,
      mixWeights: { code: 0.92, math: 0.08 },
    });

    expect(coder.capability).toBeLessThan(general.capability);
    expect(coder.benchCeilings.coding).toBeGreaterThan(
      general.benchCeilings.coding,
    );
    expect(coder.benchCeilings.multilingual).toBeLessThan(
      general.benchCeilings.multilingual,
    );
  });

  it("makes narrow math and science corpora lead their own benchmark family", () => {
    const base = {
      paramsB: 20,
      dataCoverage: 6,
      dataQuality: 1,
      trainComplete: 1,
      postTrainStrength: 0.7,
    };
    const math = scaleIntelligence({
      ...base,
      mixWeights: { math: 0.8, chat: 0.2 },
    });
    const science = scaleIntelligence({
      ...base,
      mixWeights: { science: 0.8, chat: 0.2 },
    });

    expect(math.benchCeilings.math).toBeGreaterThan(science.benchCeilings.math);
    expect(science.benchCeilings.science).toBeGreaterThan(
      math.benchCeilings.science,
    );
  });
});

describe("grounded sparse scaling", () => {
  it("uses a sparse omni active path without losing omni benchmark semantics", () => {
    const common = {
      paramsB: 100,
      activeParamsB: 10,
      family: "omni" as const,
      dataCoverage: 6,
      dataQuality: 1,
      mixWeights: { chat: 0.4, image: 0.2, video: 0.2, audio: 0.2 },
    };
    const denseOmni = scaleIntelligence({ ...common, backbone: "dense" });
    const sparseOmni = scaleIntelligence({ ...common, backbone: "moe" });
    const sparseLanguage = scaleIntelligence({
      ...common,
      family: "moe",
      backbone: "moe",
    });

    expect(sparseOmni.capability).toBeLessThan(denseOmni.capability);
    expect(sparseOmni.paramPotential).toBeCloseTo(sparseLanguage.paramPotential);
    expect(sparseOmni.benchCeilings.vision).toBeGreaterThan(
      sparseLanguage.benchCeilings.vision,
    );
  });

  it("values inactive experts partially rather than as dense-equivalent capacity", () => {
    const effective = effectiveScaleParamsB(10, 1, "moe");

    expect(effective).toBeGreaterThan(1);
    expect(effective).toBeLessThan(10);
    expect(effective).toBeCloseTo(4.15, 12);
  });

  it("penalizes extreme sparse routes continuously instead of hard-blocking them", () => {
    const tinyRoute = moeRoutingCapacityMultiplier(13, 0.07);
    const healthyRoute = moeRoutingCapacityMultiplier(13, 0.26);

    expect(tinyRoute).toBeGreaterThan(0.5);
    expect(tinyRoute).toBeLessThan(0.55);
    expect(healthyRoute).toBe(1);
    expect(effectiveScaleParamsB(13, 0.07, "moe")).toBeLessThan(
      effectiveScaleParamsB(13, 0.26, "moe"),
    );
  });

  it("places MoE between same-active and same-total dense models", () => {
    const common = {
      dataCoverage: 6,
      dataQuality: 1,
      mixWeights: { code: 0.55, math: 0.25, chat: 0.2 },
      trainComplete: 1,
      postTrainStrength: 0.7,
    };
    const activeDense = scaleIntelligence({
      ...common,
      paramsB: 1,
      family: "dense",
    });
    const sparse = scaleIntelligence({
      ...common,
      paramsB: 10,
      activeParamsB: 1,
      family: "moe",
    });
    const totalDense = scaleIntelligence({
      ...common,
      paramsB: 10,
      family: "dense",
    });

    expect(sparse.capability).toBeGreaterThan(activeDense.capability);
    expect(sparse.capability).toBeLessThan(totalDense.capability);
    expect(sparse.benchCeilings.coding).toBeGreaterThan(
      activeDense.benchCeilings.coding,
    );
    expect(sparse.benchCeilings.coding).toBeLessThan(
      totalDense.benchCeilings.coding,
    );
  });
});

describe("architecture data demand", () => {
  const common = {
    paramsB: 70,
    dataCoverage: 10,
    dataQuality: 1,
    mixWeights: { chat: 0.5, code: 0.25, math: 0.25 },
    trainComplete: 1,
    postTrainStrength: 0.7,
  };

  it("makes equal raw corpus cover less of MoE and omni blueprints", () => {
    const dense = scaleIntelligence({ ...common, family: "dense" });
    const moe = scaleIntelligence({
      ...common,
      family: "moe",
      backbone: "moe",
      activeParamsB: 7,
    });
    const omni = scaleIntelligence({
      ...common,
      family: "omni",
      backbone: "dense",
    });

    expect(dense.architectureDataCoverage).toBe(10);
    expect(moe.architectureDataCoverage).toBeCloseTo(10 / 1.2, 12);
    expect(omni.architectureDataCoverage).toBeCloseTo(10 / 1.8, 12);
    expect(moe.dataFit).toBeLessThan(dense.dataFit);
    expect(omni.dataFit).toBeLessThan(moe.dataFit);
  });

  it("lets 1.8x raw omni data restore dense-equivalent data fit", () => {
    const dense = scaleIntelligence({ ...common, family: "dense" });
    const matchedOmni = scaleIntelligence({
      ...common,
      family: "omni",
      backbone: "dense",
      dataCoverage: common.dataCoverage * 1.8,
    });

    expect(matchedOmni.architectureDataCoverage).toBeCloseTo(
      dense.architectureDataCoverage,
      12,
    );
    expect(matchedOmni.dataFit).toBeCloseTo(dense.dataFit, 12);
  });
});
