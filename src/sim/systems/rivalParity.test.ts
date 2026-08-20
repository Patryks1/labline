import { describe, expect, it } from "vitest";
import { estimateTrainingEconomics } from "../balance/training";
import { buildScaledModel } from "../balance/modelBuild";
import { launchReferenceApiCostPerMTok } from "../balance/unitEconomics";
import { scaleIntelligence } from "../balance/modelScaling";
import { distillRetentionFor } from "../balance/training";
import { createGame } from "../createGame";

describe("rival parity", () => {
  it("uses the same physical and economic functions for player and rival recipes", () => {
    const shared = {
      paramsB: 7,
      family: "dense" as const,
      dataCoverage: 6,
      dataQuality: 80,
      postTrain: "none" as const,
    };
    const player = buildScaledModel({
      id: "player-7b",
      name: "player-7b",
      day: 10,
      ...shared,
    });
    const rival = buildScaledModel({
      id: "rival-7b",
      name: "rival-7b",
      day: 10,
      ...shared,
    });
    expect(player.capability).toBe(rival.capability);
    expect(player.quality.coding).toBe(rival.quality.coding);
    expect(launchReferenceApiCostPerMTok(player)).toBe(
      launchReferenceApiCostPerMTok(rival),
    );
    expect(
      estimateTrainingEconomics({
        paramsB: 7,
        family: "dense",
        trainEfficiency: 0.6,
        trainingTokensMTok: 42_000,
        verificationTokensMTok: 8_000,
      }).targetPfDays,
    ).toBeGreaterThan(0);
    const scale = scaleIntelligence({
      paramsB: 7,
      dataCoverage: 6,
      dataQuality: 1,
    });
    expect(scale.capabilityCeiling).toBeGreaterThan(player.capability - 20);
    expect(
      distillRetentionFor({
        teacherParamsB: 70,
        studentParamsB: 7,
        dataFactor: 0.7,
        rng01: 0.5,
      }),
    ).toBeGreaterThan(0.2);
  });

  it("does not grant rivals free PF, data, or cheaper racks at a given difficulty", () => {
    const easy = createGame({ seed: 88, difficulty: "easy" });
    const hard = createGame({ seed: 88, difficulty: "hard" });
    const easyRival = easy.rivals[0]!;
    const hardRival = hard.rivals[0]!;
    expect(hardRival.cash).toBeLessThanOrEqual(easyRival.cash * 1.05);
    expect(hard.worldMarkets.cloudProviders[0]?.basePricePerPfDay ?? 0).toBeGreaterThanOrEqual(
      (easy.worldMarkets.cloudProviders[0]?.basePricePerPfDay ?? 0) * 0.95,
    );
  });
});
