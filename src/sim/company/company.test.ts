import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  SAVE_VERSION,
  parseSave,
  roundTripState,
  serializeSave,
  buildSaveFile,
} from "../save";
import { updateLab } from "../systems/labEngine";
import {
  assertCompanyParity,
  selectPlayerCompany,
  updateCompany,
  withCanonicalCompanies,
} from "./index";
import { assertModelReferences } from "./maps";

describe("canonical company state", () => {
  it("gives the player and rivals the same company shape", () => {
    const state = createGame({
      seed: 14_001,
      labName: "Canonical",
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 2 },
      legacyMapFixture: true,
    });
    expect(SAVE_VERSION).toBe(14);
    expect(state.playerCompanyId).toBe(state.playerLabId);
    const player = selectPlayerCompany(state);
    const rival = state.companies![state.rivals[0]!.id]!;
    expect(player.controller).toBe("player");
    expect(rival.controller).toBe("rival");
    expect(Object.keys(player)).toEqual(Object.keys(rival));
    expect(player.finance.cash).toBe(state.player.cash);
    expect(player.finance.cash).toBe(state.labs[state.playerLabId]!.cash);
    assertCompanyParity(state);
  });

  it("keeps a mutation on exactly one canonical company record", () => {
    const initial = createGame(14_002);
    const playerId = initial.playerLabId;
    const rivalId = initial.rivals[0]!.id;
    const beforeRival = initial.companies![rivalId]!.finance.cash;
    const next = updateCompany(initial, playerId, (company) => ({
      ...company,
      finance: { ...company.finance, cash: company.finance.cash - 1_000_000 },
    }));
    expect(next.companies![playerId]!.finance.cash).toBe(
      initial.companies![playerId]!.finance.cash - 1_000_000,
    );
    expect(next.player.cash).toBe(next.companies![playerId]!.finance.cash);
    expect(next.labs[playerId]!.cash).toBe(next.player.cash);
    expect(next.companies![rivalId]!.finance.cash).toBe(beforeRival);
    expect(next.rivals[0]!.cash).toBe(beforeRival);
  });

  it("round-trips company state through save/load without rerolling models", () => {
    const state = createGame(14_003);
    const mutated = updateLab(state, state.playerLabId, (lab) => ({
      ...lab,
      cash: lab.cash - 50_000,
      brandTrust: 61,
    }));
    const modelIds = selectPlayerCompany(mutated).modelOrder;
    const once = roundTripState(mutated);
    const twice = roundTripState(once);
    expect(once.companies![once.playerLabId]!.finance.cash).toBe(
      mutated.companies![mutated.playerLabId]!.finance.cash,
    );
    expect(once.companies![once.playerLabId]!.ops.brandTrust).toBe(61);
    expect(selectPlayerCompany(once).modelOrder).toEqual(modelIds);
    expect(selectPlayerCompany(twice).finance).toEqual(
      selectPlayerCompany(once).finance,
    );
    expect(selectPlayerCompany(twice).modelsById).toEqual(
      selectPlayerCompany(once).modelsById,
    );
  });

  it("loads v13 saves into companies without calling current RNG", () => {
    const state = createGame(14_004);
    const legacy = JSON.parse(serializeSave(buildSaveFile(state, "1")));
    legacy.version = 13;
    legacy.meta.version = 13;
    delete legacy.state.companies;
    delete legacy.state.playerCompanyId;
    const loaded = parseSave(JSON.stringify(legacy));
    expect(loaded.version).toBe(13);
    expect(loaded.state.playerCompanyId).toBe(loaded.state.playerLabId);
    expect(loaded.state.companies![loaded.state.playerLabId]!.id).toBe(
      loaded.state.playerLabId,
    );
    assertCompanyParity(loaded.state);
  });

  it("rejects product routes that point at missing models", () => {
    const state = withCanonicalCompanies(createGame(14_005));
    const company = selectPlayerCompany(state);
    expect(() =>
      assertModelReferences({
        modelsById: company.modelsById,
        productsById: {
          broken: {
            id: "broken",
            labId: company.id,
            channel: "payg_api",
            name: "Ghost",
            promoted: true,
            sourcePlanId: null,
            primaryModelId: "missing-model",
            modelIds: ["missing-model"],
            targetSegments: [],
            pricing: {
              billingModel: "usage",
              monthlyUsd: null,
              includedMTokPerMonth: null,
              inputUsdPerMTok: 1,
              outputUsdPerMTok: 3,
              overageInputUsdPerMTok: null,
              overageOutputUsdPerMTok: null,
              minimumCommitmentUsd: null,
            },
            delivery: "shared",
            capacityPriority: 1,
            servePrecision: "bf16",
            capability: 10,
            reliability: 10,
            modalities: ["text"],
          },
        },
        deploymentsById: company.deploymentsById,
        jobsById: company.trainingJobsById,
      }),
    ).toThrow(/missing model/);
  });
});
