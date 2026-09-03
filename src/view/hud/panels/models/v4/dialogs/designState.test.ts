import { describe, expect, it } from "vitest";
import { createGame } from "../../../../../../sim/createGame";
import { defaultArchitecture, emptyTrainingState, withTrainingState } from "../../../../../../sim/training/state";
import type { Endpoint, Forecast } from "../../../../../../sim/training/types";
import { stubRun } from "../../viewModels/testFixtures";
import { makeCheckpoint } from "./fixtures";
import {
  AI_TYPE_CARDS,
  CONTINUE_INTENT_CARDS,
  GOAL_CARDS,
  copyFormulaFromEndpoint,
  extraDataForContinue,
  goalLockReason,
  initialDesignState,
  launchDisabled,
  lockedUnlockFromBlockers,
  mixProportions,
  overlayProduct,
  presetFor,
  reduceDesign,
  scaleDomainMix,
  snapSize,
  specialistPullDomains,
  tokensPerParamOf,
  maxTokensPerParam,
  affordableTokPerParam,
  tokPerParamLockReason,
  unlockFromBlockerCode,
  formatContextK,
  contextNeedsUnlock,
  withBackbone,
  withLlmInputs,
  workflowSteps,
  clampTokPerParam,
  isMaxTokPerParamSelected,
  tokPerParamMaxLockReason,
  type DesignUiState,
} from "./designState";

function seedState(design = presetFor("flagship", createGame(7_001))): DesignUiState {
  return {
    step: "goal",
    design,
    tokensPerParam: tokensPerParamOf(design) || 20,
    launchError: null,
    nameDirty: false,
    continueFocus: "more_data",
  };
}

describe("designState presets", () => {
  it("builds specialist, flagship, multimodal, and omni shapes", () => {
    const state = createGame(7_002);
    const specialist = presetFor("specialist", state);
    expect(specialist.arch.backbone).toBe("dense");
    expect(specialist.arch.totalParamsB).toBe(7);
    expect(Object.keys(specialist.data.domainMTok)).toHaveLength(1);
    expect(Math.round(tokensPerParamOf(specialist))).toBe(20);

    const flagship = presetFor("flagship", state);
    expect(flagship.arch.backbone).toBe("dense");
    expect(flagship.arch.totalParamsB).toBeLessThanOrEqual(70);

    const multimodal = presetFor("multimodal", state);
    expect(multimodal.arch.preset).toBe("vision_language");
    expect(multimodal.arch.totalParamsB).toBe(30);
    expect(multimodal.arch.inputs).toContain("image");

    const omni = presetFor("omni", state);
    expect(omni.arch.preset).toBe("omni");
    expect(omni.arch.backbone).toBe("moe");
    expect(omni.arch.totalParamsB).toBe(400);
    expect(omni.arch.activeParamsB).toBeCloseTo(40);
    expect(flagship.name).not.toBe("Untitled");
    expect(specialist.name).not.toBe("Untitled");
    expect(multimodal.name).not.toBe("Multimodal");
    expect(omni.name).not.toBe("Omni");
    expect(flagship.name).not.toMatch(/\scontinued$/i);
  });

  it("wires distill and continue to the best kept/released parent", () => {
    const base = createGame(7_003);
    const teacher = makeCheckpoint({
      id: "cp-teacher",
      name: "Teacher",
      status: "released",
      arch: { ...defaultArchitecture(), totalParamsB: 70, activeParamsB: 70 },
    });
    const parent = makeCheckpoint({
      id: "cp-parent",
      name: "Parent",
      status: "kept",
    });
    const state = withTrainingState(base, base.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [teacher, parent],
    });

    const distill = presetFor("distill", state);
    expect(distill.mode).toEqual({ kind: "distill", teacherCheckpointId: "cp-teacher" });
    expect(distill.arch.totalParamsB).toBe(7);
    expect(distill.data.teacherSynthShare).toBe(0.5);

    const continued = presetFor("continue", state, { parentCheckpointId: "cp-parent" });
    expect(continued.mode).toEqual({ kind: "continue", parentCheckpointId: "cp-parent" });
    expect(continued.name).toBe("Parent v2");
    expect(Math.round(tokensPerParamOf(continued))).toBe(5);
    expect(continued.data.domainMTok).toEqual({ code: expect.any(Number) });

    const focused = presetFor("continue", state, {
      parentCheckpointId: "cp-parent",
      continueFocus: "math",
    });
    expect(Object.keys(focused.data.domainMTok)).toEqual(["math"]);
  });
});

describe("goal cards and continue intents", () => {
  it("describes types without sizes or tok/param", () => {
    const leak = /\d+\s*B\b|tok\/param|400B|70B|7B|30B/i;
    for (const card of [...GOAL_CARDS, ...AI_TYPE_CARDS]) {
      expect(card.label).not.toMatch(leak);
      expect(card.blurb).not.toMatch(leak);
    }
    expect(GOAL_CARDS.map((card) => card.label)).toEqual([
      "Broad",
      "Specialist",
      "Continue",
      "Distill",
    ]);
    expect(AI_TYPE_CARDS.map((card) => card.label)).toEqual([
      "LLM",
      "Image generation",
      "Music generation",
      "Video generation",
      "Omni",
    ]);
    expect(CONTINUE_INTENT_CARDS[0]?.id).toBe("more_data");
    expect(CONTINUE_INTENT_CARDS.some((card) => card.id === "code")).toBe(true);
  });

  it("keeps size and run name when switching AI type", () => {
    let ui = seedState();
    ui = reduceDesign(ui, { type: "setSize", totalParamsB: 13 });
    ui = reduceDesign(ui, { type: "setName", name: "Atlas" });
    ui = reduceDesign(ui, { type: "setAiType", preset: "image_generation" });
    expect(ui.design.name).toBe("Atlas");
    expect(ui.design.arch.preset).toBe("image_generation");
    expect(ui.design.arch.outputs).toEqual(["image"]);
    expect(ui.design.arch.totalParamsB).toBe(13);
  });

  it("keeps text output when an LLM accepts image or video input", () => {
    const arch = withLlmInputs(defaultArchitecture(), { image: true, video: true });
    expect(arch.preset).toBe("vision_language");
    expect(arch.inputs).toEqual(["text", "image", "video"]);
    expect(arch.outputs).toEqual(["text"]);
  });

  it("keeps product IO when switching to specialist", () => {
    const state = createGame(7_053);
    const image = overlayProduct(defaultArchitecture(), {
      ...defaultArchitecture(),
      preset: "image_generation",
      inputs: ["text", "image"],
      outputs: ["image"],
    });
    const specialist = presetFor("specialist", state, { keepArch: image });
    expect(specialist.arch.preset).toBe("image_generation");
    expect(specialist.arch.outputs).toEqual(["image"]);
    expect(Object.keys(specialist.data.domainMTok)).toEqual(["image"]);
  });

  it("keeps a typed name when switching types", () => {
    let ui = seedState();
    ui = reduceDesign(ui, { type: "setName", name: "Atlas" });
    const specialist = presetFor("specialist", createGame(7_050));
    ui = reduceDesign(ui, { type: "applyPreset", design: specialist });
    expect(ui.design.name).toBe("Atlas");
    expect(ui.design.goal).toBe("specialist");
  });

  it("versions the parent name when switching into continue", () => {
    const game = createGame(7_060);
    const parent = makeCheckpoint({ id: "cp-parent", name: "Helix · Instruct", status: "kept" });
    const state = withTrainingState(game, game.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [parent],
    });
    let ui = seedState(presetFor("flagship", state));
    ui = reduceDesign(ui, { type: "setName", name: "Spark" });
    const continued = presetFor("continue", state, { parentCheckpointId: "cp-parent" });
    ui = reduceDesign(ui, { type: "applyPreset", design: continued });
    expect(ui.design.name).toBe("Helix v2");
    expect(ui.design.goal).toBe("continue");
    expect(ui.nameDirty).toBe(false);
  });

  it("bumps a continued lineage to the next version", () => {
    const game = createGame(7_061);
    const root = makeCheckpoint({ id: "cp-root", name: "bob", status: "kept" });
    const child = makeCheckpoint({
      id: "cp-child",
      name: "bob v2",
      status: "kept",
      parentId: "cp-root",
    });
    const state = withTrainingState(game, game.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [root, child],
    });
    expect(presetFor("continue", state, { parentCheckpointId: "cp-child" }).name).toBe("bob v3");
  });

  it("focuses extra continue tokens on one domain", () => {
    const parent = makeCheckpoint({
      id: "cp-mix",
      trainingSummary: {
        pfDays: 12,
        effectiveMTok: 100,
        loss: 2.1,
        gap: 0.4,
        dataMix: { chat: 0.6, code: 0.4 },
        syntheticShare: 0,
      },
    });
    const more = extraDataForContinue({}, parent.arch, parent, "more_data");
    expect(more.chat ?? 0).toBeGreaterThan(more.code ?? 0);
    const fixCode = extraDataForContinue({}, parent.arch, parent, "code");
    expect(Object.keys(fixCode)).toEqual(["code"]);
  });

  it("skips architecture when continuing a checkpoint", () => {
    const continued = presetFor("continue", createGame(7_051));
    expect(workflowSteps(continued).map((step) => step.id)).toEqual(["goal", "data", "launch"]);
    expect(workflowSteps(presetFor("flagship", createGame(7_052))).map((step) => step.id)).toEqual([
      "goal",
      "architecture",
      "data",
      "launch",
    ]);
  });
});

describe("copy formula", () => {
  function endpoint(partial: Partial<Endpoint> = {}): Endpoint {
    return {
      id: "ep-coder",
      labId: "player",
      name: "Coder",
      members: [{ checkpointId: "cp-post", role: "primary" }],
      policy: "single",
      tiers: [{ budget: 1, served: true }],
      precision: "bf16",
      status: "live",
      releaseDay: 40,
      pricing: { inPerMTok: 1, outPerMTok: 2 },
      openWeights: false,
      modelId: "ep-coder",
      ...partial,
    };
  }

  it("walks to the lineage root and clones arch + data mix as a fresh pretrain", () => {
    const base = createGame(7_010);
    const root = makeCheckpoint({
      id: "cp-root",
      name: "Coder",
      stage: "base",
      arch: { ...defaultArchitecture(), totalParamsB: 0.07, activeParamsB: 0.07 },
      trainingSummary: {
        pfDays: 4,
        effectiveMTok: 1400,
        loss: 2.1,
        gap: 0.4,
        dataMix: { chat: 0.7, code: 0.3 },
        syntheticShare: 0,
      },
    });
    const post = makeCheckpoint({
      id: "cp-post",
      name: "Coder 1.4",
      parentId: "cp-root",
      stage: "post",
      arch: root.arch,
    });
    const state = withTrainingState(base, base.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [root, post],
      endpoints: [endpoint()],
    });

    const copied = copyFormulaFromEndpoint(state, "ep-coder");
    expect(copied).not.toBeNull();
    expect(copied?.mode).toEqual({ kind: "pretrain" });
    expect(copied?.name).toBe("Coder copy");
    expect(copied?.arch.totalParamsB).toBe(0.07);
    expect(copied?.data.domainMTok.chat).toBeCloseTo(980);
    expect(copied?.data.domainMTok.code).toBeCloseTo(420);
    expect(Math.round(tokensPerParamOf(copied!))).toBe(20);

    const ui = initialDesignState(state, undefined, { copyFromEndpointId: "ep-coder" });
    expect(ui.step).toBe("architecture");
    expect(ui.design.mode.kind).toBe("pretrain");
    expect(ui.design.arch.totalParamsB).toBe(0.07);
  });

  it("prefers the original run design over reconstructed mix", () => {
    const base = createGame(7_011);
    const design = {
      ...presetFor("specialist", base),
      id: "design-helix",
      name: "Helix",
      arch: { ...defaultArchitecture(), totalParamsB: 7, activeParamsB: 7 },
      data: { domainMTok: { code: 140_000 }, holdoutShare: 0.04 },
      mode: { kind: "continue" as const, parentCheckpointId: "cp-old" },
      compute: { pfPerDay: 12, priority: 3, source: "local" as const },
    };
    const root = makeCheckpoint({
      id: "cp-root",
      name: "Helix",
      runId: "run-helix",
      arch: design.arch,
      trainingSummary: {
        pfDays: 8,
        effectiveMTok: 10,
        loss: 2,
        gap: 0.3,
        dataMix: { math: 1 },
        syntheticShare: 0,
      },
    });
    const state = withTrainingState(base, base.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [root],
      runs: [
        stubRun(base.playerLabId, {
          id: "run-helix",
          design,
          checkpointIds: ["cp-root"],
          finalCheckpointId: "cp-root",
          status: "completed",
        }),
      ],
      endpoints: [endpoint({ members: [{ checkpointId: "cp-root", role: "primary" }] })],
    });

    const copied = copyFormulaFromEndpoint(state, "ep-coder");
    expect(copied?.mode).toEqual({ kind: "pretrain" });
    expect(copied?.name).toBe("Helix copy");
    expect(copied?.data.domainMTok).toEqual({ code: 140_000 });
    expect(copied?.data.holdoutShare).toBe(0.04);
    expect(copied?.compute.pfPerDay).toBe(12);
    expect(copied?.goal).toBe("specialist");
  });
});

describe("designState snapping and MoE", () => {
  it("snaps sizes onto the contracted stops", () => {
    expect(snapSize(6.2)).toBe(7);
    expect(snapSize(0.04)).toBe(0.07);
    expect(snapSize(2500)).toBe(2000);
    expect(snapSize(0.48)).toBe(0.5);
  });

  it("keeps MoE active fraction in 5-35% when size changes", () => {
    let ui = seedState();
    ui = reduceDesign(ui, { type: "setBackbone", backbone: "moe" });
    expect(ui.design.arch.backbone).toBe("moe");
    expect(ui.design.arch.activeParamsB / ui.design.arch.totalParamsB).toBeCloseTo(0.1);

    ui = reduceDesign(ui, { type: "setActiveFraction", fraction: 0.5 });
    expect(ui.design.arch.activeParamsB / ui.design.arch.totalParamsB).toBeCloseTo(0.35);

    ui = reduceDesign(ui, { type: "setActiveFraction", fraction: 0.01 });
    expect(ui.design.arch.activeParamsB / ui.design.arch.totalParamsB).toBeCloseTo(0.05);

    const before = ui.design.arch.activeParamsB / ui.design.arch.totalParamsB;
    ui = reduceDesign(ui, { type: "setSize", totalParamsB: 400 });
    expect(ui.design.arch.totalParamsB).toBe(400);
    expect(ui.design.arch.activeParamsB / ui.design.arch.totalParamsB).toBeCloseTo(before);
  });

  it("dense withBackbone restores active = total", () => {
    const moe = withBackbone(defaultArchitecture(), "moe", 0.2);
    expect(moe.activeParamsB).toBeCloseTo(1.4);
    const dense = withBackbone(moe, "dense");
    expect(dense.activeParamsB).toBe(dense.totalParamsB);
  });
});

describe("tokens-per-param scaling", () => {
  it("keeps mix proportions when the tok/param control scales sliders", () => {
    let ui = seedState();
    ui = reduceDesign(ui, { type: "setDomain", domain: "code", mtok: 80 });
    ui = reduceDesign(ui, { type: "setDomain", domain: "math", mtok: 20 });
    const before = mixProportions(ui.design.data.domainMTok);
    ui = reduceDesign(ui, { type: "setTokensPerParam", tokensPerParam: 50 });
    const after = mixProportions(ui.design.data.domainMTok);
    expect(after.code).toBeCloseTo(before.code ?? 0);
    expect(after.math).toBeCloseTo(before.math ?? 0);
    expect(Math.round(tokensPerParamOf(ui.design))).toBe(50);
  });

  it("scaleDomainMix is a no-op on an empty mix", () => {
    expect(scaleDomainMix({}, 20, 7)).toEqual({});
  });

  it("flags mix shares that pull the model toward a specialist", () => {
    expect(specialistPullDomains({ code: 80, math: 10, chat: 10 })).toEqual(["code"]);
    expect(specialistPullDomains({ code: 50, math: 50 })).toEqual(["code", "math"]);
    expect(
      specialistPullDomains({
        code: 1,
        math: 1,
        science: 1,
        law: 1,
        health: 1,
        chat: 1,
        image: 1,
        video: 1,
        audio: 1,
      }),
    ).toEqual([]);
  });

  it("locks tok/param presets that need more unique tokens than the lab has", () => {
    expect(maxTokensPerParam(350, 0.07)).toBeCloseTo(5, 8);
    expect(affordableTokPerParam(350, 0.07)).toBe(5);
    expect(affordableTokPerParam(1_400, 0.07)).toBe(20);
    expect(tokPerParamLockReason(5, 350, 0.07)).toBeNull();
    expect(tokPerParamLockReason(20, 350, 0.07)).toMatch(/20 tok\/param/i);
    expect(tokPerParamLockReason(20, 10_000_000, 7)).toBeNull();
  });

  it("lets Max spend every unique token without snapping back to a preset", () => {
    expect(maxTokensPerParam(100, 0.07)).toBeCloseTo(100 / 70, 8);
    expect(clampTokPerParam(20, 100, 0.07)).toBe(5);
    expect(clampTokPerParam(100 / 70, 100, 0.07)).toBeCloseTo(100 / 70, 8);
    expect(clampTokPerParam(7, 490, 0.07)).toBeCloseTo(7, 8);
    expect(clampTokPerParam(20, 490, 0.07)).toBeCloseTo(7, 8);
    expect(isMaxTokPerParamSelected(100 / 70, 100 / 70)).toBe(true);
    expect(isMaxTokPerParamSelected(20, 20)).toBe(false);
    expect(tokPerParamMaxLockReason(0)).toMatch(/unique/i);
    expect(tokPerParamMaxLockReason(100)).toBeNull();

    let ui = seedState();
    ui = reduceDesign(ui, { type: "setTokensPerParam", tokensPerParam: 100 / 70 });
    expect(tokensPerParamOf(ui.design)).toBeCloseTo(100 / 70, 8);
  });
});

describe("launch blockers", () => {
  const forecast: Forecast = {
    compute: {
      trainPfDays: 10,
      holdoutPfDays: 1,
      totalPfDays: 11,
      archCost: 1,
      modalityCost: 1,
      throughput: 1,
      days: 8,
      paceFloorDays: 3,
      trainHbmGB: 84,
      cashEstimate: 1320,
    },
    loss: {
      nEff: 7e9,
      dEff: 1e11,
      paramTerm: 1,
      dataTerm: 1,
      loss: 2,
      precisionPenalty: 0,
      gap: 0.3,
    },
    effectiveData: {
      rawMTok: 100,
      uniqueMTok: 100,
      effectiveMTok: 100,
      qualityWeight: 1,
      diversity: 1,
      epochs: 1,
      epochFactor: 1,
      syntheticShare: 0,
      syntheticDiscount: 1,
      domainMix: {},
      perDomain: {},
    },
    capability: { p10: 40, p50: 48, p90: 55, ceiling: 82, sigma: 0.06 },
    domains: {
      language: 48,
      reasoning: 40,
      code: 50,
      math: 44,
      science: 42,
      vision: 10,
      video: 5,
      audio: 8,
      tools: 20,
    },
    blockers: [{ code: "locked_moe", message: "MoE is locked" }],
    warnings: [],
  };

  it("disables launch when forecast is missing, errors, or has blockers", () => {
    expect(launchDisabled(null, "not implemented")).toBe(true);
    expect(launchDisabled(forecast, null)).toBe(true);
    expect(launchDisabled({ ...forecast, blockers: [] }, null)).toBe(false);
  });
});

describe("design unlock mapping", () => {
  it("maps forecast blocker codes onto research unlock ids", () => {
    expect(unlockFromBlockerCode("locked_fp8")).toBe("fp8_train");
    expect(unlockFromBlockerCode("locked_fp6")).toBe("fp6_train");
    expect(unlockFromBlockerCode("locked_fp16")).toBe("fp16_train");
    expect(unlockFromBlockerCode("locked_nvfp4")).toBe("nvfp4_train");
    expect(unlockFromBlockerCode("locked_continued_pretrain")).toBe("continued_pretrain");
    expect(lockedUnlockFromBlockers([{ code: "locked_fp8", message: "FP8" }])).toBe("fp8_train");
  });

  it("formats context stops and treats 4k as free", () => {
    expect(formatContextK(4)).toBe("4k");
    expect(formatContextK(32)).toBe("32k");
    expect(formatContextK(1024)).toBe("1M");
    expect(formatContextK(102400)).toBe("100M");
    expect(contextNeedsUnlock(4)).toBe(false);
    expect(contextNeedsUnlock(8)).toBe(true);
    expect(contextNeedsUnlock(128)).toBe(true);
  });

  it("locks distill, continue, vision, and omni until researched", () => {
    const state = createGame(7_040);
    expect(goalLockReason("distill", state)).toMatch(/distill|checkpoint/i);
    expect(goalLockReason("continue", state)).toMatch(/pretrain|checkpoint/i);
    expect(goalLockReason("multimodal", state)).toMatch(/Vision/i);
    expect(goalLockReason("omni", state)).toMatch(/Omni/i);
    expect(goalLockReason("flagship", state)).toBeNull();
  });

  it("locks continue when the parent is already post-trained", () => {
    const game = createGame(7_041);
    const post = makeCheckpoint({ id: "cp-post", stage: "post", status: "kept" });
    const state = withTrainingState(game, game.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [post],
    });
    expect(goalLockReason("continue", state, { parentCheckpointId: "cp-post" })).toMatch(
      /post-trained/i,
    );
  });

  it("keeps Continue available when a stealth base exists beside a released post", () => {
    const game = createGame(7_042);
    const base = makeCheckpoint({ id: "cp-base", stage: "base", status: "stealth" });
    const post = makeCheckpoint({
      id: "cp-post",
      stage: "post",
      status: "released",
      arch: { ...defaultArchitecture(), totalParamsB: 70, activeParamsB: 70 },
    });
    const state = withTrainingState(game, game.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [base, post],
    });
    expect(goalLockReason("continue", state)).not.toMatch(/post-trained/i);
    expect(goalLockReason("continue", state, { parentCheckpointId: "cp-base" })).not.toMatch(
      /post-trained/i,
    );
  });
});
