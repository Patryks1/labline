import { beforeEach, describe, expect, it } from "vitest";
import { createGame } from "./createGame";
import { calendarForDay } from "./campaign";
import {
  DEMAND_MODEL_VERSION,
  ECONOMY,
  WORLD_POPULATION,
} from "./balance/economy";
import { blendApiPrice } from "./balance/pricing";
import { buildScaledModel } from "./balance/modelBuild";
import type { TrainingCheckpointCandidate } from "./types";
import { scheduleCheckpointEvaluation } from "./systems/checkpointEvaluations";
import { TERRAIN_KIND, tileId } from "./world";
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  V1_INCOMPATIBILITY_REASON,
  V3_INCOMPATIBILITY_REASON,
  buildSaveFile,
  buildSaveMeta,
  clearAllSaves,
  deleteSaveSlot,
  extractV3RackBlueprints,
  inspectSaveCompatibility,
  listSaveSlots,
  MANUAL_SLOTS,
  mostRecentSlotId,
  parseSave,
  readSaveSlot,
  roundTripState,
  sanitizeState,
  serializeSave,
  writeSaveSlot,
} from "./save";

describe("save / load v13", () => {
  beforeEach(async () => {
    await clearAllSaves();
  });

  it("round-trips a legacy-rendered small map inside a v4 save", () => {
    const state = createGame({
      seed: 42,
      labName: "TestLab",
      difficulty: "normal",
      legacyMapFixture: true,
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 2 },
    });
    state.day = 17;
    state.player.cash = 123_456_789;
    state.map.energyPricePerMWh = 100;

    const back = roundTripState(state);
    expect(back.seed).toBe(42);
    expect(back.day).toBe(17);
    expect(back.player.cash).toBe(123_456_789);
    expect(back.map.storage).toBe("legacy");
    expect(back.map.tiles.length).toBe(state.map.tiles.length);
    expect(back.map.energyPricePerMWh).toBe(100);
    expect(back.config.difficulty).toBe("normal");
  });

  it("accepts v12 saves and migrates the unified private evaluation queue", () => {
    const state = createGame(10_012);
    const legacy = JSON.parse(serializeSave(buildSaveFile(state, "1")));
    legacy.version = 12;
    legacy.meta.version = 12;
    delete legacy.state.player.privateEvaluationJobs;
    const loaded = parseSave(JSON.stringify(legacy));
    expect(loaded.version).toBe(12);
    expect(loaded.state.player.privateEvaluationJobs).toEqual([]);
  });

  it("normalizes legacy cloud pools and additive investor-pitch state", () => {
    const state = createGame(10_014);
    const legacy = JSON.parse(serializeSave(buildSaveFile(state, "1")));
    legacy.state.day = 1;
    const provider = legacy.state.worldMarkets.cloudProviders.find(
      (entry: { id: string }) => entry.id === "cloud-northstar",
    );
    provider.baselinePf = 3_600;
    provider.availablePf = 3_576;
    delete provider.launchBaselinePf;
    delete provider.maxBaselinePf;
    delete legacy.state.player.capital.pitchCooldownUntilDay;
    delete legacy.state.player.capital.pitchModelCooldowns;
    delete legacy.state.player.capital.pitchHistory;
    const restored = parseSave(JSON.stringify(legacy)).state;
    const normalized = restored.worldMarkets.cloudProviders.find(
      (entry) => entry.id === "cloud-northstar",
    )!;
    expect(normalized.baselinePf).toBeLessThanOrEqual(1_000);
    expect(normalized.availablePf).toBe(
      normalized.baselinePf -
        restored.computeContracts
          .filter(
            (contract) =>
              contract.providerId === normalized.id &&
              (contract.status === "active" || contract.status === "interrupted") &&
              contract.kind !== "emergency" &&
              contract.kind !== "rival_resale",
          )
          .reduce((sum, contract) => sum + contract.pf, 0),
    );
    expect(restored.player.capital?.pitchCooldownUntilDay).toBe(0);
    expect(restored.player.capital?.pitchModelCooldowns).toEqual({});
    expect(restored.player.capital?.pitchHistory).toEqual([]);
    expect(restored.companies?.[restored.playerLabId]?.ops.capital).toEqual(
      restored.player.capital,
    );
  });

  it("keeps the newest investor pitches from oversized imported histories", () => {
    const state = createGame(10_016);
    const imported = JSON.parse(serializeSave(buildSaveFile(state, "1")));
    imported.state.player.capital.pitchHistory = Array.from(
      { length: 20 },
      (_: unknown, index: number) => ({
        id: `pitch-${index}`,
        modelId: `model-${index}`,
        modelName: `Model ${index}`,
        investorName: "Northstar",
        day: 20 - index,
        outcome: "declined",
        successChance: 0.25,
        cashRaised: 0,
        preMoneyValuation: 80_000_000,
        postMoneyValuation: 80_000_000,
        investorOwnership: 0,
        cooldownUntilDay: 30,
      }),
    );

    const restored = parseSave(JSON.stringify(imported)).state;
    expect(restored.player.capital?.pitchHistory).toHaveLength(16);
    expect(restored.player.capital?.pitchHistory?.map((record) => record.id)).toEqual(
      Array.from({ length: 16 }, (_: unknown, index: number) => `pitch-${index}`),
    );
  });

  it("caps partially migrated oversized day-one cloud launch pools", () => {
    const state = createGame(10_015);
    const partial = JSON.parse(serializeSave(buildSaveFile(state, "1")));
    partial.state.day = 1;
    const provider = partial.state.worldMarkets.cloudProviders.find(
      (entry: { id: string }) => entry.id === "cloud-northstar",
    );
    provider.baselinePf = 3_600;
    provider.availablePf = 3_576;
    provider.launchBaselinePf = 3_600;
    provider.maxBaselinePf = 3_600;

    const restored = parseSave(JSON.stringify(partial)).state;
    const normalized = restored.worldMarkets.cloudProviders.find(
      (entry) => entry.id === "cloud-northstar",
    )!;
    expect(normalized.launchBaselinePf).toBeLessThanOrEqual(1_000);
    expect(normalized.baselinePf).toBeLessThanOrEqual(1_000);
  });

  it("repairs orphaned checkpoints without treating lineage history as ownership", () => {
    const base = createGame(10_013);
    const model = buildScaledModel({
      id: "orphan-checkpoint-model",
      name: "Orphan weights",
      paramsB: 1,
      family: "dense",
      day: base.day,
      dataCoverage: 2,
      dataQuality: 70,
      postTrain: "none",
      shipped: false,
      release: "internal",
    });
    const checkpoint: TrainingCheckpointCandidate = {
      id: "orphan-checkpoint",
      sourceJobId: "deleted-source-job",
      lineageId: "deleted-lineage",
      ordinal: 1,
      kind: "manual",
      milestone: 0.4,
      capturedDay: base.day,
      stage: "base",
      status: "stealth",
      model,
      telemetry: {
        progressPfDays: 4,
        targetPfDays: 10,
        progress: 0.4,
        daysElapsed: 2,
        stage: "base",
        stageProgress: 0.4,
        loss: 3.2,
        energyMWh: 10,
      },
    };
    const staleHistoryModel = {
      ...model,
      id: "stale-history-only",
      sourceTrainingJobId: checkpoint.sourceJobId,
    };
    const malformed = scheduleCheckpointEvaluation(
      {
        ...base,
        player: {
          ...base.player,
          cash: 1_000_000_000,
          trainingCheckpoints: [checkpoint],
          trainingJobs: [],
          trainingJob: null,
          models: [staleHistoryModel],
        },
      },
      checkpoint.id,
      {
        suiteIds: ["language"],
        budgetTier: "lean",
        mode: "internal",
      },
    );
    expect(malformed.player.privateEvaluationJobs).toHaveLength(1);

    const restored = roundTripState(malformed);
    expect(restored.player.trainingCheckpoints).toEqual([]);
    expect(restored.player.privateEvaluationJobs).toEqual([]);

    const canonicalOutput = {
      ...staleHistoryModel,
      id: `model-${base.day}-${checkpoint.sourceJobId}`,
    };
    const migrated = roundTripState({
      ...malformed,
      player: { ...malformed.player, models: [canonicalOutput] },
    });
    expect(migrated.player.trainingCheckpoints).toHaveLength(1);
    expect(migrated.player.trainingCheckpoints![0]!.ownerModelId).toBe(
      canonicalOutput.id,
    );
    expect(migrated.player.privateEvaluationJobs).toHaveLength(1);
  });

  it("round-trips v11 facility-market and physical rack metadata", () => {
    const state = createGame({
      seed: 10010,
      labName: "Metadata Lab",
      difficulty: "easy",
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    });
    const rival = state.rivals[0]!;
    const facility = state.map.world!.queryFacilities({
      ownerId: rival.id,
      kind: "dc",
    })[0]!;
    state.map
      .world!.beginBatch()
      .updateFacility(facility.id, {
        forSale: true,
        listPrice: 123_456_789,
        stats: { ...facility.stats, rackCapacity: 144 },
      })
      .commit();
    const playerRack = {
      id: "player-physical",
      skuId: "rack_h100",
      facilityId: "player-campus",
      x: 1,
      y: 2,
      count: 2,
      rackUnits: 1,
      status: "live" as const,
      daysLeft: 0,
      paidEach: 100,
      bayStarts: [7, 23],
    };
    const rivalRack = {
      id: "rival-physical",
      skuId: "rack_h100",
      facilityId: facility.id,
      x: 3,
      y: 4,
      count: 2,
      rackUnits: 1,
      status: "live" as const,
      daysLeft: 0,
      paidEach: 100,
      bayStarts: [11, 29],
    };
    state.player.rackFleet = [playerRack];
    state.rivals[0] = { ...rival, rackFleet: [rivalRack] };
    state.facilityMarket = {
      offers: [
        {
          id: "saved-offer",
          facilityId: facility.id,
          buyerLabId: state.playerLabId,
          sellerLabId: rival.id,
          amount: 100_000_000,
          escrow: 100_000_000,
          submittedDay: state.day,
          respondDay: state.day + 2,
          expiresDay: state.day + 7,
          status: "countered",
          counterAmount: 110_000_000,
        },
      ],
    };

    const restored = roundTripState(state);
    const restoredFacility = restored.map.world!.facilitiesById.get(
      facility.id,
    )!;
    expect(restoredFacility).toMatchObject({
      id: facility.id,
      forSale: true,
      listPrice: 123_456_789,
      stats: { rackCapacity: 144 },
    });
    expect(restored.player.rackFleet).toEqual([
      {
        ...playerRack,
        unitIds: ["player-physical:unit:0001", "player-physical:unit:0002"],
      },
    ]);
    expect(restored.rivals[0]!.rackFleet).toEqual([
      {
        ...rivalRack,
        unitIds: ["rival-physical:unit:0001", "rival-physical:unit:0002"],
      },
    ]);
    expect(restored.dataHallLayouts?.[facility.id]).toMatchObject({
      version: 2,
      facilityId: facility.id,
    });
    expect(restored.facilityMarket?.offers).toEqual(
      state.facilityMarket.offers,
    );
  });

  it("preserves explicit pre-default-change dimensions through save and load", () => {
    const state = createGame({
      seed: 43,
      difficulty: "normal",
      legacyMapFixture: true,
      advanced: { mapWidth: 150, mapHeight: 120, cityCount: 4, rivalCount: 2 },
    });

    const back = roundTripState(state);

    expect(back.map).toMatchObject({ width: 150, height: 120 });
    expect(back.config).toMatchObject({
      mapWidth: 150,
      mapHeight: 120,
      cityCount: 4,
    });
  });

  it("migrates implicit legacy auto-pause rules to opt-in settings", () => {
    const state = createGame({ seed: 420, difficulty: "normal" });
    const file = buildSaveFile(state, "auto");
    file.state.config.campaignRules.autoPauseConfigured = undefined;
    file.state.config.campaignRules.autoPause = {
      projectComplete: true,
      majorEvent: true,
      quarterlyReport: true,
      runwayEmergency: true,
    };
    const loaded = parseSave(serializeSave(file)).state;
    expect(loaded.config.campaignRules.autoPauseConfigured).toBe(true);
    expect(loaded.config.campaignRules.autoPause).toEqual({
      projectComplete: false,
      majorEvent: false,
      quarterlyReport: false,
      runwayEmergency: false,
    });
  });

  it("rebuilds compact static data and derived indexes from sparse world state", () => {
    const state = createGame({
      seed: 73,
      labName: "Compact Lab",
      difficulty: "normal",
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 2 },
    });
    const world = state.map.world;
    expect(state.map.storage).toBe("compact");
    expect(world).toBeDefined();
    const x = 1;
    const y = 1;
    const id = tileId(x, y, world!.descriptor.width, world!.descriptor.height);
    const city = world!.cityRuntime.get(0)!;
    world!
      .beginBatch()
      .setTerrain({ tileId: id, kind: TERRAIN_KIND.park, ownerId: "player" })
      .updateCity(0, {
        population: city.population + 12_345,
        growthEvents: city.growthEvents + 1,
        lastGrowthDay: 14,
      })
      .commit();
    const originalHash = world!.staticWorld.staticHash;
    const originalFacilityCount = world!.metrics.facilities.count;
    state.map.cities![0]!.talentAvailable!.researcher = 7;

    const back = roundTripState(state);
    expect(back.map.storage).toBe("compact");
    expect(back.map.tiles).toEqual([]);
    expect(back.map.world).toBeDefined();
    expect(back.map.world).not.toBe(world);
    expect(back.map.world?.staticWorld.staticHash).toBe(originalHash);
    expect(back.map.world?.getKind(id)).toBe(TERRAIN_KIND.park);
    expect(back.map.world?.getOwner(id)).toBe("player");
    expect(back.map.world?.cityRuntime.get(0)).toMatchObject({
      population: city.population + 12_345,
      growthEvents: city.growthEvents + 1,
      lastGrowthDay: 14,
    });
    expect(back.map.world?.metrics.facilities.count).toBe(
      originalFacilityCount,
    );
    expect(back.map.cities?.[0]?.talentAvailable?.researcher).toBe(7);
    expect(back.map.cities?.[0]?.population).toBe(city.population + 12_345);
  });

  it("lets the compact snapshot override conflicting compatibility population", () => {
    const state = createGame({
      seed: 74,
      difficulty: "normal",
      advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 1 },
    });
    const city = state.map.world!.cityRuntime.get(0)!;
    const snapshotPopulation = city.population + 44_444;
    state.map
      .world!.beginBatch()
      .updateCity(0, { ...city, population: snapshotPopulation })
      .commit();
    state.map.cities![0]!.population = snapshotPopulation - 33_333;

    const file = buildSaveFile(state, "1");
    expect(file.state).not.toHaveProperty("cityStats");
    expect(file.state.map).not.toHaveProperty("cityStats");
    const back = parseSave(serializeSave(file)).state;

    expect(back.map.world!.cityRuntime.get(0)!.population).toBe(
      snapshotPopulation,
    );
    expect(back.map.cities![0]!.population).toBe(snapshotPopulation);
  });

  it("continues to accept v6 envelopes for preserved campaigns", () => {
    const state = createGame({
      seed: 706,
      difficulty: "normal",
      legacyMapFixture: true,
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    });
    const legacy = JSON.parse(serializeSave(buildSaveFile(state, "1")));
    legacy.version = 6;
    legacy.meta.version = 6;
    const loaded = parseSave(JSON.stringify(legacy));
    expect(loaded.state.seed).toBe(706);
    expect(loaded.state.map.storage).toBe("legacy");
  });

  it("preserves rival topology and product fields while canonicalizing legacy jobs", () => {
    const state = createGame({ seed: 707, difficulty: "normal" });
    const rival = state.rivals[0]!;
    rival.trainingJobs = [];
    rival.trainingJob = {
      id: "legacy-sparse-omni",
      name: "Legacy Sparse Omni",
      family: "omni",
      backbone: "moe",
      productPreset: "omni",
      io: { inputs: { text: 80, image: 70 }, outputs: { text: 80 }, tools: 60 },
      paramsB: 100,
      activeParamsB: 10,
      targetPfDays: 100,
      progressPfDays: 20,
      modalities: ["text", "image", "tools"],
      dataCoverage: 1,
      dataQuality: 70,
      includeSynthHQ: false,
      includeSynthLQ: false,
      synthLqShare: 0,
      trainShare: 0.82,
      totalMTok: 1_000,
    };

    const restored = roundTripState(state);
    expect(restored.rivals[0]!.trainingJobs?.[0]).toMatchObject({
      family: "omni",
      backbone: "moe",
      productPreset: "omni",
      activeParamsB: 10,
      io: { inputs: { text: 80, image: 70 }, outputs: { text: 80 }, tools: 60 },
    });
  });

  it("never serializes million-tile static buffers or runtime indexes", () => {
    const state = createGame({
      seed: 1_001,
      labName: "Million",
      difficulty: "normal",
      advanced: { mapWidth: 1_000, mapHeight: 1_000, rivalCount: 5 },
    });
    const file = buildSaveFile(state, "auto");
    const json = serializeSave(file);
    expect(file.state.map.storage).toBe("compact");
    expect(file.state.map).not.toHaveProperty("tiles");
    expect(file.state.map).not.toHaveProperty("world");
    expect(json).not.toContain("staticWorld");
    expect(json).not.toContain("facilitiesById");
    expect(json).not.toContain('terrainOverrides":{}');
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(1_000_000);
  });

  it("preserves Infinity runwayDays through sanitize and restore", () => {
    const state = createGame({
      seed: 1,
      labName: "Inf",
      difficulty: "easy",
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
    });
    state.player.finance.runwayDays = Infinity;
    const clean = sanitizeState(state);
    expect(clean.player.finance.runwayDays).toBeNull();
    expect(roundTripState(state).player.finance.runwayDays).toBe(Infinity);
  });

  it("normalizes legacy audience demand exactly once on restore", () => {
    const state = createGame({ seed: 8, difficulty: "easy" });
    state.lastMarket.demandModelVersion = undefined;
    state.lastMarket.demandMTok = 1_000;
    state.lastMarket.industryDemandMTok = 1_000;
    state.lastMarket.playerDemandMTok = 100;
    state.lastMarket.apiDemandMTok = 100;
    state.lastMarket.servedMTok = 50;
    state.lastMarket.capacityMTok = 100;
    state.lastMarket.demandPf = 100;
    state.lastMarket.capacityPf = 100;

    const restored = roundTripState(state);
    expect(restored.lastMarket.demandModelVersion).toBe(DEMAND_MODEL_VERSION);
    expect(restored.lastMarket.playerDemandMTok).toBe(
      100 * ECONOMY.marketDailyActiveUsageShare,
    );
    expect(restored.lastMarket.demandMTok).toBe(
      1_000 * ECONOMY.marketDailyActiveUsageShare,
    );
    expect(roundTripState(restored).lastMarket.playerDemandMTok).toBe(
      restored.lastMarket.playerDemandMTok,
    );
  });

  it("migrates untouched legacy plan allowances to the 20M monthly baseline", () => {
    const state = createGame({ seed: 82, difficulty: "easy" });
    state.player.pricing.plans = state.player.pricing.plans.map((plan) => ({
      ...plan,
      includedMTokPerMonth:
        plan.id === "plan-plus" ? 0.65 : 0.6 * plan.usageMultiplier,
    }));

    const restored = roundTripState(state);
    const free = restored.player.pricing.plans.find(
      (plan) => plan.id === "plan-free",
    )!;
    const plus = restored.player.pricing.plans.find(
      (plan) => plan.id === "plan-plus",
    )!;
    const pro = restored.player.pricing.plans.find(
      (plan) => plan.id === "plan-pro",
    )!;

    expect(free.includedMTokPerMonth).toBeCloseTo(4);
    expect(plus.includedMTokPerMonth).toBeCloseTo(20);
    expect(pro.includedMTokPerMonth).toBeCloseTo(100);
  });

  it("preserves deliberately customized subscription allowances on restore", () => {
    const state = createGame({ seed: 82, difficulty: "easy" });
    const plus = state.player.pricing.plans.find(
      (plan) => plan.id === "plan-plus",
    )!;
    plus.includedMTokPerMonth = 12;

    const restored = roundTripState(state);
    expect(
      restored.player.pricing.plans.find((plan) => plan.id === "plan-plus")!
        .includedMTokPerMonth,
    ).toBe(12);
  });

  it("derives monthlyApiValueSubsidyGbp from legacy included MTok on restore", () => {
    const state = createGame({ seed: 84, difficulty: "easy" });
    state.player.pricing.plans = state.player.pricing.plans.map((plan) => {
      const { monthlyApiValueSubsidyGbp: _drop, ...rest } = plan;
      return rest as typeof plan;
    });

    const restored = roundTripState(state);
    const blended = blendApiPrice(
      restored.player.pricing.apiPriceInPerMTok,
      restored.player.pricing.apiPriceOutPerMTok,
    );
    for (const plan of restored.player.pricing.plans) {
      expect(plan.monthlyApiValueSubsidyGbp).toBeGreaterThan(0);
      expect(plan.monthlyApiValueSubsidyGbp).toBeCloseTo(
        plan.includedMTokPerMonth! * blended,
        5,
      );
    }
  });

  it("migrates vision_language models and fills native weight precision on restore", () => {
    const state = createGame({ seed: 85, difficulty: "easy" });
    state.player.models = [
      {
        id: "legacy-vl",
        name: "Legacy VL",
        family: "dense",
        paramsB: 12,
        productPreset: "vision_language",
        io: {
          inputs: { text: 60, image: 50 },
          outputs: { text: 60 },
          tools: 20,
        },
        capability: 55,
        quality: {
          reasoning: 50,
          coding: 45,
          reliability: 60,
          safety: 55,
          knowledge: 50,
        },
        modalities: ["text", "image"],
        release: "released",
        shipped: true,
        tokPerSecMult: 1,
        postTrain: "none",
      } as unknown as (typeof state.player.models)[number],
    ];
    state.player.trainingJobs = [
      {
        id: "legacy-vl-job",
        name: "Legacy VL Job",
        family: "dense",
        productPreset: "vision_language",
        io: {
          inputs: { text: 70, image: 60, audio: 40 },
          outputs: { text: 70, image: 30 },
          tools: 25,
        },
        targetParamsB: 20,
        targetPfDays: 40,
        progressPfDays: 10,
        postTrain: "none",
        postTrainProgress: 0,
        postTrainTarget: 0,
        mode: "pretrain",
        dataMix: "web",
        dataPlan: {
          totalUnits: 100,
          totalMTok: 100,
          trainShare: 0.8,
          weights: { chat: 1 },
          allowSynthetic: true,
        },
        dataConsumed: { chat: 10 },
        dataCoverage: 1,
        dataQualityUsed: 70,
        syntheticUnits: 0,
        trainShare: 0.8,
        trainMTok: 80,
        verifyMTok: 20,
        cashBurnPerDay: 0,
        cashSunk: 0,
      } as unknown as NonNullable<typeof state.player.trainingJobs>[number],
    ];

    const restored = roundTripState(state);
    const model = restored.player.models.find(
      (candidate) => candidate.id === "legacy-vl",
    )!;
    expect(model.productPreset).toBe("language");
    expect(model.nativeWeightPrecision).toBe("bf16");
    expect(model.trainingNumerics?.computeFormat).toBe("bf16_mixed");

    const job = (restored.player.trainingJobs ?? []).find(
      (candidate) => candidate.id === "legacy-vl-job",
    )!;
    expect(job.productPreset).toBe("omni");
    expect(job.dataPlan?.syntheticProvenance).toEqual([]);
  });

  it("soft-migrates data supplier contract bookkeeping fields on restore", () => {
    const state = createGame({ seed: 86, difficulty: "easy" });
    state.player.dataSupplierContracts = [
      {
        id: "dsc-legacy",
        supplierId: "sup-1",
        supplierName: "Legacy Desk",
        domainMix: { chat: 1 },
        quality: 62,
        dailyDeliveryMTok: 5,
        dailyPrice: 1_000,
        termDays: 30,
        daysRemaining: 12,
        acceptedDay: 3,
        status: "completed",
      },
    ];

    const restored = roundTripState(state);
    const contract = restored.player.dataSupplierContracts![0]!;
    expect(contract.status).toBe("completed");
    expect(contract.qualityFloor).toBe(62);
    expect(contract.deliveredMTok).toBe(0);
    expect(contract.cancellationFeeCharged).toBe(0);
    expect(contract.extendedDays).toBe(0);
    expect(contract.extensionCount).toBe(0);
    expect(contract.offeredDay).toBe(3);
  });

  it("restores per-corpus synthetic teacher routing and drops malformed IDs", () => {
    const state = createGame({ seed: 87, difficulty: "easy" });
    state.player.data.synthQueue = [
      {
        id: "synth-auto-save",
        domain: "chat",
        modelId: "teacher-chat",
        modelName: "Teacher Chat",
        targetMTok: 0,
        progressMTok: 12,
        continuous: true,
        researchShare: 0.25,
        qualityTier: "hq",
        autoPortfolio: true,
        teacherModelIds: {
          chat: "teacher-chat",
          science: "teacher-science",
          math: 42 as unknown as string,
        },
      },
    ];

    const restored = roundTripState(state);
    expect(restored.player.data.synthQueue[0]?.teacherModelIds).toEqual({
      chat: "teacher-chat",
      science: "teacher-science",
    });
  });

  it("round-trips per-model plan serving precision while legacy precision remains optional", () => {
    const state = createGame({ seed: 425, difficulty: "normal" });
    const plan = state.player.pricing.plans[1]!;
    plan.servePrecisionByModel = { "released-model": "int8" };
    const restored = roundTripState(state);
    expect(
      restored.player.pricing.plans.find(
        (candidate) => candidate.id === plan.id,
      )?.servePrecisionByModel,
    ).toEqual({ "released-model": "int8" });
  });

  it("caps oversized legacy audiences at the world population on restore", () => {
    const state = createGame({ seed: 81, difficulty: "easy" });
    state.segments = state.segments.map((segment) => ({
      ...segment,
      size: segment.size * 10,
    }));

    const restored = roundTripState(state);
    const restoredAudience = restored.segments.reduce(
      (sum, segment) => sum + segment.size,
      0,
    );

    expect(restoredAudience).toBeCloseTo(WORLD_POPULATION, -1);
  });

  it("rejects v1 explicitly without attempting migration", () => {
    const legacy = JSON.stringify({
      format: SAVE_FORMAT,
      version: 1,
      meta: {},
      state: {},
    });
    expect(() => parseSave(legacy)).toThrow(V1_INCOMPATIBILITY_REASON);
  });

  it("rejects v3 economies explicitly without attempting migration", () => {
    expect(() =>
      parseSave(
        JSON.stringify({
          format: SAVE_FORMAT,
          version: 3,
          meta: {},
          state: {},
        }),
      ),
    ).toThrow(V3_INCOMPATIBILITY_REASON);
  });

  it("rejects bad and newer formats", () => {
    expect(() =>
      parseSave(JSON.stringify({ format: "nope", version: 2 })),
    ).toThrow(/Labline save/i);
    expect(() =>
      parseSave(
        JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION + 1 }),
      ),
    ).toThrow(/newer than this build/i);
  });

  it("writes, lists, reads, and deletes an async slot", async () => {
    const state = createGame({
      seed: 9,
      labName: "Slotty",
      difficulty: "hard",
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
    });
    state.day = 5;
    const meta = await writeSaveSlot("1", state);
    expect(meta).toMatchObject({
      labName: "Slotty",
      day: 5,
      slotId: "1",
      version: SAVE_VERSION,
    });
    expect(
      (await listSaveSlots()).some((candidate) => candidate.slotId === "1"),
    ).toBe(true);

    const loaded = await readSaveSlot("1");
    expect(loaded.day).toBe(5);
    expect(loaded.seed).toBe(9);

    await deleteSaveSlot("1");
    expect(
      (await listSaveSlots()).some((candidate) => candidate.slotId === "1"),
    ).toBe(false);
  });

  it("offers eight manual sandbox slots", () => {
    expect(MANUAL_SLOTS).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("reports actionable validation problems before a damaged save is loaded", () => {
    const state = createGame({
      seed: 29,
      labName: "Recovery Lab",
      difficulty: "easy",
    });
    const file = buildSaveFile(state, "4");
    file.state.day = Number.NaN;
    expect(inspectSaveCompatibility(file)).toEqual({
      compatible: false,
      reason:
        "Simulation state is incomplete (day, company, or world data is missing).",
    });
  });

  it("persists the sandbox date and selected company mark in save metadata", () => {
    const state = createGame({
      seed: 30,
      labName: "Prism Works",
      companyMark: "prism",
      difficulty: "normal",
    });
    state.day = 400;
    state.calendar = calendarForDay(state.day, state.config.campaignRules);
    expect(buildSaveMeta(state, "5", "2026-07-18T12:00:00.000Z")).toMatchObject(
      {
        companyMark: "prism",
        campaignDate: "2027-02-04",
        savedAt: "2026-07-18T12:00:00.000Z",
      },
    );
  });

  it("continues from the newest compatible save instead of always preferring autosave", async () => {
    const state = createGame({ seed: 91, difficulty: "normal" });
    await writeSaveSlot("auto", state);
    await new Promise((resolve) => setTimeout(resolve, 2));
    state.day += 1;
    await writeSaveSlot("1", state);

    expect(await mostRecentSlotId()).toBe("1");
  });

  it("serializeSave pins the current format and content pack", () => {
    const state = createGame({ seed: 2, difficulty: "easy" });
    const parsed = JSON.parse(serializeSave(buildSaveFile(state, "auto")));
    expect(parsed.format).toBe(SAVE_FORMAT);
    expect(parsed.version).toBe(SAVE_VERSION);
    expect(parsed.contentPackId).toBe(state.config.campaignRules.contentPackId);
    expect(parsed.state.industryDataPack.id).toBe(parsed.contentPackId);
  });

  it("restores the embedded calibration snapshot instead of consulting live balance data", () => {
    const state = createGame({ seed: 22, difficulty: "easy" });
    state.industryDataPack = {
      ...state.industryDataPack,
      demand: {
        ...state.industryDataPack.demand,
        reportYearMinMultiplier: 5.25,
      },
    };
    const restored = roundTripState(state);
    expect(restored.industryDataPack.demand.reportYearMinMultiplier).toBe(5.25);
  });

  it("does not import malformed v3 rack blueprints", () => {
    const json = JSON.stringify({
      format: SAVE_FORMAT,
      version: 3,
      state: {
        player: {
          rackDesigns: [
            {
              id: "bad",
              name: "Bad rack",
              chassisId: "missing",
              placements: [],
            },
            { id: 2, name: "Wrong shape" },
          ],
        },
      },
    });
    expect(extractV3RackBlueprints(json)).toEqual([]);
  });

  it("imports a valid v3 rack blueprint without migrating its live economy", () => {
    const blueprint = {
      id: "v3-balanced-node",
      name: "V3 balanced node",
      chassisId: "case_8u",
      placements: [
        { instanceId: "nic", moduleId: "nic_400", slotId: "m4" },
        { instanceId: "gpu", moduleId: "gpu_h100", slotId: "g1" },
        { instanceId: "psu", moduleId: "psu_3k", slotId: "m3" },
        { instanceId: "cpu", moduleId: "cpu_std", slotId: "m1" },
        { instanceId: "cool", moduleId: "cool_liquid", slotId: "m2" },
      ],
    };
    const json = JSON.stringify({
      format: SAVE_FORMAT,
      version: 3,
      state: {
        day: 90,
        player: { cash: 999_000_000, rackDesigns: [blueprint] },
      },
    });

    expect(extractV3RackBlueprints(json)).toEqual([blueprint]);
    expect(() => parseSave(json)).toThrowError(V3_INCOMPATIBILITY_REASON);
  });
});
