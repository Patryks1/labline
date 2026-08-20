import { describe, expect, it } from "vitest";
import { denseTrainingPfDays, moeTrainingComputeParamsB, verificationPfDays } from "./training";
import { estimateTrainingMemoryGb } from "./trainingPrecision";
import { buildScaledModel } from "./modelBuild";
import { distillRetentionFor, blendDistilledCapability } from "./training";
import { generalCapabilityHardMax } from "./capabilityCeilings";
import { launchReferenceApiCostPerMTok } from "./unitEconomics";
import { segmentShares } from "../systems/marketScore";
import type { MarketOffer } from "../types";

function offerFor(model: ReturnType<typeof buildScaledModel>, labId: string): MarketOffer {
  return {
    labId,
    modelId: model.id,
    capability: model.capability,
    reliability: model.quality.reliability,
    safety: model.quality.safety,
    brandTrust: 60,
    apiPrice: model.apiPricePerMTok ?? model.suggestedApiPrice ?? 1,
    subPrice: 20,
    latencyScore: 75,
    tokPerSec: model.serviceProfile?.interactiveTokPerSec ?? 30,
    modalities: model.modalities,
    isOpenWeights: false,
    benchmarks: model.benchmarks,
  };
}

describe("scenario matrix", () => {
  const scales = [0.07, 0.4, 1, 7, 70, 405, 1_000];

  for (const paramsB of scales) {
    it(`keeps ${paramsB}B dense work, memory and ceilings physical`, () => {
      const work = denseTrainingPfDays(paramsB, paramsB * 1_000 * 6);
      expect(work).toBeGreaterThan(0);
      const verify = verificationPfDays(paramsB, paramsB * 1_000 * 0.2);
      expect(verify).toBeGreaterThan(0);
      expect(verify).toBeLessThan(work);
      const memory = estimateTrainingMemoryGb({ paramsB, family: "dense" });
      expect(memory.requiredHbmGb).toBeGreaterThan(0);
      const model = buildScaledModel({
        id: `dense-${paramsB}`,
        name: `dense-${paramsB}`,
        paramsB,
        family: "dense",
        day: 1,
        dataCoverage: 6,
        dataQuality: 80,
        postTrain: "none",
      });
      expect(model.capability).toBeLessThanOrEqual(generalCapabilityHardMax(paramsB) + 8);
      expect(launchReferenceApiCostPerMTok(model)).toBeGreaterThan(0);
    });
  }

  it("uses active-path compute for MoE but total parameters for memory", () => {
    const computeParams = moeTrainingComputeParamsB(70, 7);
    expect(computeParams).toBeLessThan(70);
    expect(computeParams).toBeGreaterThan(7);
    const moeMem = estimateTrainingMemoryGb({
      paramsB: 70,
      activeParamsB: 7,
      family: "moe",
    });
    const denseMem = estimateTrainingMemoryGb({ paramsB: 70, family: "dense" });
    expect(moeMem.requiredHbmGb).toBeGreaterThan(denseMem.requiredHbmGb * 0.8);
  });

  it("lets a cheap coding specialist beat a larger generalist in coding demand", () => {
    const specialist = buildScaledModel({
      id: "code-7b",
      name: "code-7b",
      paramsB: 7,
      family: "dense",
      day: 1,
      dataCoverage: 20,
      dataQuality: 90,
      postTrain: "tools",
      mixWeights: { code: 0.7, chat: 0.2, math: 0.1 },
    });
    const generalist = buildScaledModel({
      id: "gen-70b",
      name: "gen-70b",
      paramsB: 70,
      family: "dense",
      day: 1,
      dataCoverage: 6,
      dataQuality: 70,
      postTrain: "none",
      mixWeights: { chat: 0.7, code: 0.1, math: 0.1, science: 0.1 },
    });
    specialist.benchmarks = { ...specialist.benchmarks, coding: 72, agents: 64 };
    generalist.benchmarks = { ...generalist.benchmarks, coding: 48, agents: 40 };
    specialist.apiPricePerMTok = 0.4;
    generalist.apiPricePerMTok = 8;
    const shares = segmentShares(
      [offerFor(generalist, "gen"), offerFor(specialist, "spec")],
      "indie_api",
    );
    expect(shares[1]!).toBeGreaterThan(0.2);
  });

  it("uses one distillation function and cannot erase the student ceiling", () => {
    const retention = distillRetentionFor({
      teacherParamsB: 70,
      studentParamsB: 0.07,
      dataFactor: 0.8,
      rng01: 0.5,
    });
    const blend = blendDistilledCapability({
      studentCapability: 12,
      studentParamsB: 0.07,
      teacherCapability: 70,
      teacherParamsB: 70,
      teacherShare: 0.8,
      dataFactor: 0.8,
      rng01: 0.5,
    });
    expect(retention).toBeLessThan(0.7);
    expect(blend.capability).toBeLessThan(generalCapabilityHardMax(0.07) + 12);
  });
});
