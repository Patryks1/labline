/**
 * Canonical unit-economics consistency: margin definition, in≤out split,
 * estimate vs settlement composition, live vs estimate paths.
 */
import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { computeSnapshot } from "../systems/compute";
import { energyPriceForState, playerBuildingOpex } from "../systems/map";
import { attributedServingFixedCost } from "../systems/market";
import { tickDay } from "../tick";
import type { Model, SimState } from "../types";
import {
  applyModelApiMarkup,
  listReleasedModel,
  setModelApiInOut,
} from "../systems/training";
import { ECONOMY } from "./economy";
import { buildScaledModel } from "./modelBuild";
import {
  API_IN_SHARE,
  API_OUT_SHARE,
  analyzeApiPricing,
  apiRevenueForCommercialWork,
  blendApiPrice,
  commercialApiListPricePerEquivalentMTok,
  splitBlendedApiPrice,
  suggestApiInOut,
  suggestCompetitiveApiInOut,
} from "./pricing";
import {
  API_CAMPUS_CLOUD_SWITCH_MULT,
  API_COST_IN_MULT,
  API_COST_OUT_MULT,
  API_FLOOR_TARGET_UTILIZATION,
  FALLBACK_COST_PER_MTOK,
  apiHostingCostFloor,
  apiUnitCostPerMTok,
  boundedApiListCostPerMTok,
  birthApiUnitCostPerMTok,
  clampApiListToHostingFloor,
  launchReferenceApiCostPerMTok,
  marginPct,
  markupRatio,
  servingOpsDayEstimate,
  splitInOutCost,
  targetUtilizedApiCostPerMTok,
} from "./unitEconomics";

function withServeCampus(state: SimState, racks = 32): SimState {
  const tiles = state.map.tiles.map((t) => {
    if (t.x === 2 && t.y === 2) {
      return {
        ...t,
        kind: "dc" as const,
        owner: "player" as const,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 512,
        racksUsed: 0,
        mwCapacity: 80,
        // Keep hall opex modest so a 70B listing still clears the campus
        // vs cloud switch (ops scale with tiles on legacy fixtures).
        opexPerDay: 12_000,
      };
    }
    if (t.x === 3 && t.y === 2) {
      return {
        ...t,
        kind: "substation" as const,
        owner: "player" as const,
        buildingProgress: 1,
        buildingTarget: 1,
        mwCapacity: 80,
        opexPerDay: 2_000,
      };
    }
    // Legacy maps ship with large starter-campus opex; clamp other player
    // buildings so hosting-floor tests measure rack/model scale, not HQ rent.
    if (
      t.owner === "player" &&
      typeof t.opexPerDay === "number" &&
      t.opexPerDay > 2_000
    ) {
      return { ...t, opexPerDay: 2_000 };
    }
    return t;
  });
  const model = buildScaledModel({
    id: "ue-model",
    name: "UnitEcon",
    paramsB: 7,
    family: "dense",
    day: state.day,
    dataCoverage: 12,
    dataQuality: 70,
    shipped: true,
    release: "released",
    costPerMTokBase: FALLBACK_COST_PER_MTOK,
  });
  return {
    ...state,
    map: { ...state.map, tiles },
    player: {
      ...state.player,
      cash: 1e9,
      models: [model],
      pricing: {
        ...state.player.pricing,
        activeModelId: model.id,
        apiModelIds: [model.id],
      },
      rackFleet: [
        {
          id: "ue-fleet",
          skuId: "rack_h100",
          x: 2,
          y: 2,
          count: racks,
          status: "live",
          daysLeft: 0,
          paidEach: 165_000,
          rackUnits: 1,
        },
      ],
      allocation: { training: 0.15, inference: 0.7, research: 0.15 },
      servingEfficiency: 0.85,
    },
  };
}

describe("unitEconomics canonical helpers", () => {
  it("protects the listing floor at healthy rather than perfect utilization", () => {
    const quote = targetUtilizedApiCostPerMTok({
      opsDay: 620,
      capacityMTok: 1_000,
      referenceCostPerMTok: 5,
      bandwidthPerMTok: 0.025,
    })
    expect(API_FLOOR_TARGET_UTILIZATION).toBe(0.62)
    expect(quote.useCloudReference).toBe(false)
    expect(quote.blended).toBeCloseTo(1.025, 10)

    const realizedCostAtTarget =
      620 / (1_000 * API_FLOOR_TARGET_UTILIZATION) + 0.025
    const realizedCostAtLowUse = 620 / (1_000 * 0.35) + 0.025
    const realizedCostAtHighUse = 620 / (1_000 * 0.85) + 0.025
    expect(realizedCostAtTarget).toBeCloseTo(quote.blended, 10)
    expect(realizedCostAtLowUse).toBeGreaterThan(quote.blended)
    expect(realizedCostAtHighUse).toBeLessThan(quote.blended)
  })

  it("switches an absurd local quote to the bounded cloud reference", () => {
    const quote = targetUtilizedApiCostPerMTok({
      opsDay: 100_000,
      capacityMTok: 1,
      referenceCostPerMTok: 4,
    })
    expect(quote.campusBlended).toBeGreaterThan(
      4 * API_CAMPUS_CLOUD_SWITCH_MULT,
    )
    expect(quote.useCloudReference).toBe(true)
    expect(quote.blended).toBe(4)
  })

  it("bounds a launch quote when the local endpoint is severely under-provisioned", () => {
    const base = createGame({ seed: 4_411 });
    const state: SimState = {
      ...withServeCampus(base, 1),
      computeContracts: [],
    };
    const huge = buildScaledModel({
      id: "launch-405b",
      name: "Launch 405B",
      paramsB: 405,
      family: "dense",
      day: state.day,
      dataCoverage: 12,
      dataQuality: 70,
    });
    const reference = launchReferenceApiCostPerMTok(huge);
    const birth = birthApiUnitCostPerMTok(state, computeSnapshot(state), huge);
    expect(birth).toBeLessThanOrEqual(reference * 2 + 1e-9);
    expect(birth).toBeLessThan(250);
    const list = suggestApiInOut({
      costPerMTokBase: birth,
      paramsB: huge.paramsB,
      family: huge.family,
      inferCostMult: huge.inferCostMult,
      markupPct: 120,
    });
    expect(list.blendedPrice).toBeLessThan(500);
  });

  it("keeps automatic markup market-realistic while preserving realized COGS", () => {
    const base = createGame({ seed: 4_412 });
    const state: SimState = {
      ...withServeCampus(base, 1),
      computeContracts: [],
    };
    const huge = buildScaledModel({
      id: "markup-405b",
      name: "Markup 405B",
      paramsB: 405,
      family: "dense",
      day: state.day,
      dataCoverage: 12,
      dataQuality: 70,
      shipped: true,
      release: "released",
    });
    const withHuge: SimState = {
      ...state,
      player: {
        ...state.player,
        models: [huge],
        pricing: {
          ...state.player.pricing,
          activeModelId: huge.id,
          apiModelIds: [huge.id],
        },
      },
    };
    const actual = apiUnitCostPerMTok(
      withHuge,
      computeSnapshot(withHuge),
      huge,
      { forceEstimate: true },
    );
    const bounded = boundedApiListCostPerMTok(huge, actual.blended);
    expect(bounded).toBeLessThanOrEqual(
      launchReferenceApiCostPerMTok(huge) * 2,
    );

    const repriced = applyModelApiMarkup(withHuge, huge.id, 120);
    const model = repriced.player.models[0]!;
    const hosting = apiHostingCostFloor(
      withHuge,
      computeSnapshot(withHuge),
      huge,
    );
    expect(model.costApiPriceOut).toBeCloseTo(hosting.costOut, 8);
    expect(model.apiPriceInPerMTok ?? 0).toBeGreaterThanOrEqual(
      hosting.costIn - 1e-9,
    );
    expect(model.apiPriceOutPerMTok ?? 0).toBeGreaterThanOrEqual(
      hosting.costOut - 1e-9,
    );
    if (hosting.source === "cloud_reference") {
      expect(model.apiPriceInPerMTok).toBeLessThan(1_000);
      expect(model.apiPriceOutPerMTok).toBeLessThan(1_000);
    }
    expect(actual.costOut).toBeGreaterThan(0);
  });

  it("preserves a blended list price under the canonical 70/30 text mix", () => {
    expect(API_IN_SHARE).toBe(0.7);
    expect(API_OUT_SHARE).toBe(0.3);
    const split = splitBlendedApiPrice(12);
    expect(split.priceIn).toBeLessThan(split.priceOut);
    expect(blendApiPrice(split.priceIn, split.priceOut)).toBeCloseTo(12, 10);
  });

  it("clamps listed API prices up to the hosting floor", () => {
    const state = createGame(7_707);
    const model = buildScaledModel({
      id: "micro-list",
      name: "Micro list",
      paramsB: 1,
      family: "dense",
      day: state.day,
      dataCoverage: 12,
      dataQuality: 60,
      postTrain: "none",
    });
    const withModel = {
      ...state,
      player: { ...state.player, models: [model] },
    };
    const hosting = apiHostingCostFloor(
      withModel,
      computeSnapshot(withModel),
      model,
    );
    const priced = setModelApiInOut(
      withModel,
      model.id,
      0.0000001,
      0.0000007,
    ).player.models[0]!;
    expect(priced.apiPriceInPerMTok).toBeCloseTo(hosting.costIn, 8);
    expect(priced.apiPriceOutPerMTok).toBeCloseTo(hosting.costOut, 8);
    expect(priced.costApiPriceIn).toBeCloseTo(hosting.costIn, 8);
    expect(priced.costApiPriceOut).toBeCloseTo(hosting.costOut, 8);
  });

  it("bills media in native images, minutes, and seconds", () => {
    // Each demand scalar below represents exactly one native interaction.
    expect(
      apiRevenueForCommercialWork("image", 0.004, 1, 5, {
        perImage: 0.04,
      }),
    ).toBeCloseTo(0.04);
    expect(
      apiRevenueForCommercialWork("video", 0.024, 1, 5, {
        perVideoSecond: 0.1,
      }),
    ).toBeCloseTo(0.8);
    expect(
      apiRevenueForCommercialWork("audio", 0.003, 1, 5, {
        perAudioMinute: 0.02,
      }),
    ).toBeCloseTo(0.01);
  });

  it("never hides a native media billing floor behind a token list price", () => {
    for (const kind of ["image", "video", "audio"] as const) {
      expect(apiRevenueForCommercialWork(kind, 10, 0, 0)).toBe(0);
      expect(
        apiRevenueForCommercialWork(kind, 10, 0.0000001, 0.0000001),
      ).toBeCloseTo(0.000001, 12);
    }
    expect(
      commercialApiListPricePerEquivalentMTok("image", 0, 0, {
        perImage: 0.04,
      }),
    ).toBeCloseTo(10);
  });

  it("defines marginPct as (revenue − cost) / revenue", () => {
    expect(marginPct(4, 1)).toBeCloseTo(0.75, 10);
    expect(marginPct(10, 10)).toBeCloseTo(0, 10);
    expect(marginPct(2, 4)).toBeCloseTo(-1, 10);
    expect(
      analyzeApiPricing({
        price: 4,
        marginalCost: 1,
        capability: 50,
        featureScore: 10,
        peers: [],
      }).marginPct,
    ).toBeCloseTo(0.75, 10);
    expect(
      analyzeApiPricing({
        price: 4,
        marginalCost: 1,
        capability: 50,
        featureScore: 10,
        peers: [],
      }).markupRatio,
    ).toBeCloseTo(4, 10);
    expect(markupRatio(4, 1)).toBeCloseTo(4, 10);
  });

  it("keeps input cost and price ≤ output in defaults, suggestions, and birth seed", () => {
    expect(API_COST_IN_MULT).toBeLessThan(API_COST_OUT_MULT);
    const split = splitInOutCost(2);
    expect(split.costIn).toBeLessThanOrEqual(split.costOut);

    const sug = suggestApiInOut({
      costPerMTokBase: FALLBACK_COST_PER_MTOK,
      paramsB: 7,
      family: "dense",
      markupPct: 120,
    });
    expect(sug.costIn).toBeLessThanOrEqual(sug.costOut);
    expect(sug.priceIn).toBeLessThanOrEqual(sug.priceOut);

    const competitive = suggestCompetitiveApiInOut({
      costIn: sug.costIn,
      costOut: sug.costOut,
      capability: 55,
      featureScore: 20,
      peers: [],
      fallbackPriceIn: sug.priceIn,
      fallbackPriceOut: sug.priceOut,
    });
    expect(competitive.priceIn).toBeLessThanOrEqual(competitive.priceOut);

    const birth = buildScaledModel({
      id: "birth-ue",
      name: "Birth",
      paramsB: 4,
      family: "dense",
      day: 1,
      dataCoverage: 8,
      dataQuality: 65,
    });
    expect(birth.costApiPriceIn).toBeLessThanOrEqual(birth.costApiPriceOut);
    expect(birth.apiPriceInPerMTok ?? 0).toBeLessThanOrEqual(
      birth.apiPriceOutPerMTok ?? 0,
    );
  });

  it("capacity estimate uses the same ops components as settlement attribution", () => {
    const state = withServeCampus(createGame({ seed: 4401 }));
    const snap = computeSnapshot(state);
    const energyPrice = energyPriceForState(state);
    const components = servingOpsDayEstimate(state, snap, energyPrice);

    let rackCapital = 0;
    for (const rack of state.player.rackFleet ?? []) {
      if (rack.status === "live") rackCapital += rack.paidEach * rack.count;
    }
    const settlementOps = attributedServingFixedCost({
      energyCostDay: Math.max(0, snap.mwDemand) * 24 * energyPrice,
      chipAmortDay: rackCapital / ECONOMY.chipAmortDays,
      buildingOpexDay: playerBuildingOpex(state),
      computeLeaseCostDay: state.player.computeLeaseCostToday ?? 0,
      inferenceShare: Math.max(0.08, state.player.allocation.inference),
    });

    expect(components.opsDay).toBeCloseTo(settlementOps, 6);
    expect(components.buildingOpexDay).toBeGreaterThan(0);
    expect(components.amortDay).toBeGreaterThan(0);

    const model = state.player.models[0]!;
    const unit = apiUnitCostPerMTok(state, snap, model, {
      forceEstimate: true,
    });
    expect(unit.source).toBe("estimate");
    expect(unit.blended).toBeGreaterThan(ECONOMY.bandwidthPerMTok);
    expect(unit.costIn).toBeLessThanOrEqual(unit.costOut);

    // Served-path unit cost may diverge via capacity vs volume, but the ops
    // numerator must stay composition-identical (within float noise).
    const servedDenom = Math.max(unit.capacityMTok * 0.4, 0.0001);
    const settlementUnit =
      settlementOps / servedDenom + ECONOMY.bandwidthPerMTok;
    const estimateUnit =
      components.opsDay / unit.capacityMTok + ECONOMY.bandwidthPerMTok;
    // Same ops, different denom → ratio bounded by capacity/served assumption.
    expect(settlementUnit / estimateUnit).toBeGreaterThan(0.3);
    expect(settlementUnit / estimateUnit).toBeLessThan(4);
  });

  it("prefers live settlement COGS/MTok when the model served tokens", () => {
    const base = withServeCampus(createGame({ seed: 4402 }));
    const model = base.player.models[0]!;
    const state: SimState = {
      ...base,
      lastMarket: {
        ...base.lastMarket,
        modelFinance: [
          {
            modelId: model.id,
            name: model.name,
            family: model.family,
            release: "released",
            isActive: true,
            isPublic: true,
            capability: model.capability,
            apiPricePerMTok: 4,
            dayApiRevenue: 400,
            dayApiDirectCogs: 100,
            dayApiAllocatedOps: 0,
            dayApiCogs: 100,
            dayApiMTok: 50,
            dayApiContribution: 300,
            apiCapacityUtilization: 0.2,
            daySubRevenue: 0,
            daySubCogs: 0,
            dayEnterpriseShare: 0,
            dayNet: 300,
            note: "test",
          },
        ],
      },
    };
    const snap = computeSnapshot(state);
    const live = apiUnitCostPerMTok(state, snap, model);
    expect(live.source).toBe("live");
    expect(live.blended).toBeCloseTo(2, 8);
    expect(live.costIn).toBeLessThanOrEqual(live.costOut);

    const estimate = apiUnitCostPerMTok(state, snap, model, {
      forceEstimate: true,
    });
    expect(estimate.source).toBe("estimate");
    // UI helper path: live row matches finance.dayApiCogs / dayApiMTok.
    expect(live.blended).toBeCloseTo(100 / 50, 8);
  });

  it("birth seeding uses capacity estimate (or fallback) and keeps in ≤ out", () => {
    const state = withServeCampus(createGame({ seed: 4403 }));
    const snap = computeSnapshot(state);
    const model = state.player.models[0]!;
    const birth = birthApiUnitCostPerMTok(state, snap, model);
    expect(birth).toBeGreaterThanOrEqual(ECONOMY.bandwidthPerMTok);
    const sug = suggestApiInOut({
      costPerMTokBase: birth,
      paramsB: model.paramsB,
      family: model.family,
      inferCostMult: model.inferCostMult,
      markupPct: 120,
    });
    expect(sug.priceIn).toBeLessThanOrEqual(sug.priceOut);
    expect(sug.costIn).toBeLessThanOrEqual(sug.costOut);
  });

  it("matches settlement finance rows after a tick with API traffic", () => {
    let state = withServeCampus(createGame({ seed: 4404 }), 48);
    // Drive a few days so market can allocate API demand to the public model.
    for (let i = 0; i < 5; i++) state = tickDay(state);

    const model = state.player.models.find(
      (m) => m.release === "released" || m.shipped,
    ) as Model;
    expect(model).toBeTruthy();
    const fin = state.lastMarket.modelFinance?.find(
      (row) => row.modelId === model.id,
    );
    const snap = computeSnapshot(state);
    const unit = apiUnitCostPerMTok(state, snap, model);

    if (fin && fin.dayApiMTok > 0.001 && fin.dayApiCogs > 0) {
      expect(unit.source).toBe("live");
      expect(unit.blended).toBeCloseTo(fin.dayApiCogs / fin.dayApiMTok, 5);
    } else {
      // No API traffic yet — estimate still exposes settlement composition.
      expect(unit.source).toBe("estimate");
      expect(unit.components.buildingOpexDay).toBeGreaterThan(0);
    }
  });
});

describe("API hosting cost floor", () => {
  it("charges more per token for a larger model on the same campus", () => {
    const state = withServeCampus(
      createGame({ seed: 4415, legacyMapFixture: true }),
      32,
    );
    const snap = computeSnapshot(state);
    const small = buildScaledModel({
      id: "floor-7b",
      name: "Floor 7B",
      paramsB: 7,
      family: "dense",
      day: state.day,
      dataCoverage: 12,
      dataQuality: 70,
    });
    const large = buildScaledModel({
      id: "floor-70b",
      name: "Floor 70B",
      paramsB: 70,
      family: "dense",
      day: state.day,
      dataCoverage: 12,
      dataQuality: 70,
    });
    const smallFloor = apiHostingCostFloor(state, snap, small);
    const largeFloor = apiHostingCostFloor(state, snap, large);
    expect(smallFloor.source).toBe("campus");
    expect(largeFloor.source).toBe("campus");
    expect(largeFloor.blended).toBeGreaterThan(smallFloor.blended);
    expect(largeFloor.costOut).toBeGreaterThan(largeFloor.costIn);
    expect(smallFloor.costOut / smallFloor.costIn).toBeCloseTo(
      API_COST_OUT_MULT / API_COST_IN_MULT,
      5,
    );
    expect(smallFloor.campusPerMTok + smallFloor.bandwidthPerMTok).toBeCloseTo(
      smallFloor.blended,
      6,
    );
  });

  it("uses a cloud rental quote when the campus has no serving replica", () => {
    const state = createGame({ seed: 4416 });
    const model = buildScaledModel({
      id: "cloud-floor",
      name: "Cloud floor",
      paramsB: 8,
      family: "dense",
      day: state.day,
      dataCoverage: 8,
      dataQuality: 60,
    });
    const floor = apiHostingCostFloor(state, computeSnapshot(state), model);
    expect(floor.source).toBe("cloud_reference");
    expect(floor.capacityMTok).toBe(0);
    expect(floor.blended).toBeCloseTo(launchReferenceApiCostPerMTok(model), 8);
    expect(floor.costIn).toBeLessThan(floor.costOut);
  });

  it("lifts a below-cost go-to-market list to the hosting floor", () => {
    const base = createGame({ seed: 4417 });
    const model = buildScaledModel({
      id: "list-floor",
      name: "List floor",
      paramsB: 3,
      family: "dense",
      day: base.day,
      dataCoverage: 8,
      dataQuality: 65,
      shipped: true,
      release: "released",
    });
    const state: SimState = {
      ...base,
      player: { ...base.player, models: [model] },
    };
    const hosting = apiHostingCostFloor(state, computeSnapshot(state), model);
    const listed = listReleasedModel(state, {
      modelId: model.id,
      sell: true,
      apiIn: hosting.costIn * 0.1,
      apiOut: hosting.costOut * 0.1,
    }).player.models[0]!;
    expect(listed.apiPriceInPerMTok).toBeCloseTo(hosting.costIn, 8);
    expect(listed.apiPriceOutPerMTok).toBeCloseTo(hosting.costOut, 8);
    expect(listed.commerciallyOffered).toBe(true);
  });

  it("does not lower an above-floor list", () => {
    const listed = clampApiListToHostingFloor(4, 12, {
      costIn: 0.4,
      costOut: 1.6,
    });
    expect(listed.priceIn).toBe(4);
    expect(listed.priceOut).toBe(12);
  });
});
