import { describe, expect, it } from "vitest";
import {
  capabilityCeiling,
  effectiveScaleParamsB,
  mixFit,
  scaleIntelligence,
} from "./modelScaling";

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

describe("first-class math and science scaling", () => {
  it("counts math and science evidence in mix specialization", () => {
    const math = mixFit({ math: 1 });
    const science = mixFit({ science: 1 });

    expect(math.general).toBeCloseTo(0.72, 12);
    expect(math.domainBoost.math).toBe(1);
    expect(math.domainBoost.science).toBe(0);
    expect(science.domainBoost.science).toBe(1);
    expect(science.domainBoost.math).toBe(0);
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
