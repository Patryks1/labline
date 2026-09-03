import { describe, expect, it } from "vitest";
import { createEmptyLabData } from "../balance/data";
import { baselineModifiers } from "./modifiers";
import {
  availableDomainTokens,
  effectiveDataFor,
  POST_TRAIN_DATA_PRICE,
  postTrainDataUnitLabel,
} from "./dataBridge";
import {
  defaultArchitecture,
  emptyTrainingState,
  withTrainingState,
} from "./state";
import type { DatasetAsset, PlayerState, RivalLab, SimState } from "../types";

function asset(partial: Partial<DatasetAsset> & Pick<DatasetAsset, "id">): DatasetAsset {
  return {
    name: partial.name ?? partial.id,
    volumeMTok: 100,
    domainWeights: { code: 1 },
    verticalTags: ["code"],
    quality: 80,
    diversity: 0.5,
    freshness: 1,
    rights: "owned",
    source: "web",
    exclusiveUntilDay: null,
    contaminationRisk: 0,
    acquiredDay: 1,
    ...partial,
  };
}

function fakeState(assets: DatasetAsset[], rivalId = "rival-a"): SimState {
  const data = createEmptyLabData();
  data.assets = assets;
  return {
    playerLabId: "player",
    player: { data, training: emptyTrainingState() } as PlayerState,
    rivals: [{ id: rivalId } as RivalLab],
    calendar: { era: "cloud_startup" },
    progression: { era: "cloud_startup" },
  } as SimState;
}

describe("dataBridge available tokens", () => {
  it("subtracts reservations and never goes negative", () => {
    let state = fakeState([asset({ id: "code-lot", volumeMTok: 100 })]);
    expect(availableDomainTokens(state, "player").code?.uniqueMTok).toBeCloseTo(
      100,
      8,
    );
    state = withTrainingState(state, "player", {
      ...emptyTrainingState(),
      reservations: [{ runId: "run-a", domainMTok: { code: 40 } }],
    });
    expect(availableDomainTokens(state, "player").code?.uniqueMTok).toBeCloseTo(
      60,
      8,
    );
    state = withTrainingState(state, "player", {
      ...emptyTrainingState(),
      reservations: [{ runId: "run-a", domainMTok: { code: 150 } }],
    });
    expect(availableDomainTokens(state, "player").code?.uniqueMTok).toBe(0);
  });

  it("synthesizes a generous era-scaled rival inventory without assets", () => {
    const state = fakeState([]);
    const rival = availableDomainTokens(state, "rival-a");
    expect(rival.code?.uniqueMTok ?? 0).toBeGreaterThan(100);
    expect(rival.code?.syntheticShare).toBe(0);
  });
});

describe("dataBridge effective data", () => {
  it("is monotone in requested tokens with diminishing epochs", () => {
    const state = fakeState([
      asset({ id: "code-lot", volumeMTok: 100, quality: 100 }),
    ]);
    const arch = defaultArchitecture();
    const mods = baselineModifiers();
    const one = effectiveDataFor(
      state,
      "player",
      { domainMTok: { code: 100 }, holdoutShare: 0 },
      arch,
      mods,
    );
    const two = effectiveDataFor(
      state,
      "player",
      { domainMTok: { code: 200 }, holdoutShare: 0 },
      arch,
      mods,
    );
    expect(two.effectiveMTok).toBeGreaterThan(one.effectiveMTok);
    expect(two.effectiveMTok).toBeLessThan(one.effectiveMTok * 2);
    expect(two.epochs).toBeCloseTo(2, 5);
  });

  it("applies a stronger synthetic discount to unverified deep lineage", () => {
    const verified = fakeState([
      asset({
        id: "v",
        volumeMTok: 100,
        quality: 80,
        source: "synthetic",
        v4Synthetic: {
          teacherName: "T",
          tierBudget: 8,
          depth: 1,
          verifiedShare: 1,
          method: "verifier",
          quality: 0.8,
          generatedDay: 1,
        },
      }),
    ]);
    const unverified = fakeState([
      asset({
        id: "u",
        volumeMTok: 100,
        quality: 80,
        source: "synthetic",
        v4Synthetic: {
          teacherName: "T",
          tierBudget: 8,
          depth: 1,
          verifiedShare: 0,
          method: "imitation",
          quality: 0.8,
          generatedDay: 1,
        },
      }),
    ]);
    const deep = fakeState([
      asset({
        id: "d",
        volumeMTok: 100,
        quality: 80,
        source: "synthetic",
        v4Synthetic: {
          teacherName: "T",
          tierBudget: 8,
          depth: 3,
          verifiedShare: 0,
          method: "imitation",
          quality: 0.8,
          generatedDay: 1,
        },
      }),
    ]);
    const arch = defaultArchitecture();
    const mods = baselineModifiers();
    const alloc = { domainMTok: { code: 100 }, holdoutShare: 0 };
    const v = effectiveDataFor(verified, "player", alloc, arch, mods);
    const u = effectiveDataFor(unverified, "player", alloc, arch, mods);
    const d = effectiveDataFor(deep, "player", alloc, arch, mods);
    expect(v.syntheticDiscount).toBeGreaterThan(u.syntheticDiscount);
    expect(u.syntheticDiscount).toBeGreaterThan(d.syntheticDiscount);
    expect(v.effectiveMTok).toBeGreaterThan(u.effectiveMTok);
    expect(u.effectiveMTok).toBeGreaterThan(d.effectiveMTok);
  });

  it("divides MoE effective tokens by 1.2", () => {
    const state = fakeState([
      asset({ id: "code-lot", volumeMTok: 100, quality: 100 }),
    ]);
    const mods = baselineModifiers();
    const alloc = { domainMTok: { code: 100 }, holdoutShare: 0 };
    const dense = effectiveDataFor(
      state,
      "player",
      alloc,
      defaultArchitecture(),
      mods,
    );
    const moe = effectiveDataFor(
      state,
      "player",
      alloc,
      { ...defaultArchitecture(), backbone: "moe", totalParamsB: 14, activeParamsB: 7 },
      mods,
    );
    expect(moe.effectiveMTok).toBeCloseTo(dense.effectiveMTok / 1.2, 8);
  });

  it("gives mixed-domain recipes more diversity than a single domain", () => {
    const state = fakeState([
      asset({ id: "code-lot", volumeMTok: 100, quality: 100 }),
      asset({
        id: "math-lot",
        volumeMTok: 100,
        quality: 100,
        domainWeights: { math: 1 },
        verticalTags: ["math"],
      }),
    ]);
    const arch = defaultArchitecture();
    const mods = baselineModifiers();
    const single = effectiveDataFor(
      state,
      "player",
      { domainMTok: { code: 100 }, holdoutShare: 0 },
      arch,
      mods,
    );
    const mixed = effectiveDataFor(
      state,
      "player",
      { domainMTok: { code: 50, math: 50 }, holdoutShare: 0 },
      arch,
      mods,
    );
    expect(single.diversity).toBeCloseTo(0.8, 8);
    expect(mixed.diversity).toBeGreaterThan(single.diversity);
  });

  it("returns all-zero finite breakdowns for empty requests", () => {
    const state = fakeState([asset({ id: "code-lot" })]);
    const empty = effectiveDataFor(
      state,
      "player",
      { domainMTok: {}, holdoutShare: 0 },
      defaultArchitecture(),
      baselineModifiers(),
    );
    expect(empty.rawMTok).toBe(0);
    expect(empty.effectiveMTok).toBe(0);
    expect(Number.isFinite(empty.effectiveMTok)).toBe(true);
    expect(Number.isNaN(empty.epochs)).toBe(false);
  });

  it("blends teacher synthetic share on top of stock synth", () => {
    const state = fakeState([
      asset({ id: "code-lot", volumeMTok: 100, quality: 100 }),
    ]);
    const arch = defaultArchitecture();
    const mods = baselineModifiers();
    const stock = effectiveDataFor(
      state,
      "player",
      { domainMTok: { code: 50 }, holdoutShare: 0 },
      arch,
      mods,
    );
    const teacher = effectiveDataFor(
      state,
      "player",
      { domainMTok: { code: 50 }, holdoutShare: 0, teacherSynthShare: 0.5 },
      arch,
      mods,
    );
    expect(teacher.syntheticShare).toBeGreaterThan(stock.syntheticShare);
    expect(teacher.syntheticShare).toBeGreaterThanOrEqual(0.5);
  });
});

describe("post-train pool labels", () => {
  it("prices instruction/preference per MTok and tasks/trajectories per unit", () => {
    expect(POST_TRAIN_DATA_PRICE.instructionMTok).toBeGreaterThan(0);
    expect(POST_TRAIN_DATA_PRICE.preferenceMTok).toBeGreaterThan(
      POST_TRAIN_DATA_PRICE.instructionMTok,
    );
    expect(postTrainDataUnitLabel("instructionMTok")).toBe("MTok");
    expect(postTrainDataUnitLabel("verifiableTasks")).toBe("tasks");
    expect(postTrainDataUnitLabel("toolTrajectories")).toBe("trajectories");
  });
});
