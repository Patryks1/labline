import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { collectOffers } from "../systems/market";
import {
  createPlan,
  planServingModelIds,
  updatePlan,
} from "../systems/plans";
import type { Model, ModelCapabilities, SimState } from "../types";
import {
  compositeCapabilities,
  compositeCapabilitiesWithQuality,
  createEndpoint,
  createRouter,
  endpointCostMultiplier,
  endpointHbmGB,
  misrouteFraction,
  openSourceEndpoint,
  projectEndpointsToModels,
  retireEndpoint,
  setEndpointTier,
  sunsetEndpoint,
  tickEndpoints,
  updateEndpoint,
} from "./endpoints";
import { unlockedThinkingTiers } from "./thinking";
import { defaultArchitecture, emptyTrainingState, withTrainingState } from "./state";
import type { Architecture, Checkpoint, Endpoint } from "./types";

const REQUIRED_MODEL_KEYS = [
  "id",
  "name",
  "family",
  "paramsB",
  "capability",
  "modalities",
  "quality",
  "benchmarks",
  "postTrain",
  "trainComputeSpent",
  "releaseDay",
  "shipped",
  "release",
  "tokPerSecMult",
  "inferCostMult",
  "apiPricePerMTok",
  "apiPriceInPerMTok",
  "apiPriceOutPerMTok",
  "suggestedApiPrice",
  "suggestedApiPriceIn",
  "suggestedApiPriceOut",
  "costApiPriceIn",
  "costApiPriceOut",
  "distilled",
  "trainMode",
] as const satisfies readonly (keyof Model)[];

function assertModelComplete(model: Model): void {
  for (const key of REQUIRED_MODEL_KEYS) {
    expect(model[key], key).not.toBeUndefined();
  }
  expect(model.capabilities).toBeDefined();
  expect(model.productProfile?.effortRecipes?.length).toBeGreaterThan(0);
  expect(model.endpointId).toBe(model.id);
  expect(model.v4CheckpointId).toBeTruthy();
}

function truth(
  domains: Partial<ModelCapabilities["domains"]> = {},
): ModelCapabilities {
  return {
    domains: {
      language: 50,
      reasoning: 48,
      code: 45,
      math: 42,
      science: 40,
      vision: 0,
      audio: 0,
      video: 0,
      tools: 20,
      ...domains,
    },
    factuality: 44,
    steerability: 46,
    robustness: 47,
    safety: 55,
    reliability: 60,
  };
}

function makeCheckpoint(
  labId: string,
  id: string,
  opts: {
    name?: string;
    status?: Checkpoint["status"];
    arch?: Architecture;
    domains?: Partial<ModelCapabilities["domains"]>;
    paramsB?: number;
    postReasoning?: number;
  } = {},
): Checkpoint {
  const arch = opts.arch ?? {
    ...defaultArchitecture(),
    totalParamsB: opts.paramsB ?? 7,
    activeParamsB: opts.paramsB ?? 7,
  };
  return {
    id,
    labId,
    lineageId: `lineage-${id}`,
    name: opts.name ?? id,
    version: "0.1",
    stage: "post",
    status: opts.status ?? "kept",
    arch,
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truth(opts.domains),
    trainingSummary: {
      pfDays: 12,
      effectiveMTok: 140,
      loss: 2.1,
      gap: 0.4,
      dataMix: { chat: 0.4, code: 0.3, math: 0.3 },
      syntheticShare: 0,
    },
    postTrain: {
      stages: {
        instruct: { effect: 0.4, runs: 1, pfDays: 2 },
        ...(opts.postReasoning
          ? {
              reasoning: {
                effect: opts.postReasoning,
                runs: 1,
                pfDays: 8,
              },
            }
          : {}),
      },
    },
    tiers: [
      { budget: 1, served: true },
      { budget: 2, served: true },
      { budget: 8, served: false },
      { budget: 20, served: false },
    ],
    endpointIds: [],
  };
}

function seedCheckpoints(
  state: SimState,
  labId: string,
  checkpoints: Checkpoint[],
  extras?: { researchUnlocked?: string[] },
): SimState {
  let next = withTrainingState(state, labId, {
    ...emptyTrainingState(),
    checkpoints,
  });
  if (labId === next.playerLabId && extras?.researchUnlocked) {
    next = {
      ...next,
      player: {
        ...next.player,
        researchUnlocked: [
          ...next.player.researchUnlocked,
          ...extras.researchUnlocked,
        ],
      },
    };
  }
  return next;
}

function playerEndpoint(state: SimState, id: string): Endpoint {
  const endpoint = state.player.training?.endpoints.find((e) => e.id === id);
  expect(endpoint).toBeDefined();
  return endpoint!;
}

describe("V4 endpoints", () => {
  it("creates a live endpoint, marks the checkpoint released, and projects a full Model", () => {
    let state = createGame(4_101);
    const ckpt = makeCheckpoint("player", "ckpt-a", { status: "stealth" });
    state = seedCheckpoints(state, "player", [ckpt]);
    const { state: next, result } = createEndpoint(state, "player", {
      name: "Helios",
      checkpointId: "ckpt-a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const released = next.player.training?.checkpoints.find((c) => c.id === "ckpt-a");
    expect(released?.status).toBe("released");
    expect(released?.endpointIds).toContain(result.id);
    const projected = next.player.models.find((m) => m.id === result.id);
    expect(projected).toBeDefined();
    assertModelComplete(projected!);
    expect(projected!.commerciallyOffered).toBe(true);
    expect(projected!.archived).toBeFalsy();
    expect(projected!.release).toBe("released");
    expect(projected!.family).toBe("dense");
  });

  it("does not auto-attach a new endpoint onto empty plans", () => {
    let state = createGame(4_101);
    const ckpt = makeCheckpoint("player", "ckpt-a", { status: "stealth" });
    state = seedCheckpoints(state, "player", [ckpt]);
    const { state: next, result } = createEndpoint(state, "player", {
      name: "Helios",
      checkpointId: "ckpt-a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      next.player.pricing.plans.every((plan) => !plan.modelIds.includes(result.id)),
    ).toBe(true);
  });

  it("preserves economics across re-projection", () => {
    let state = createGame(4_102);
    state = seedCheckpoints(state, "player", [makeCheckpoint("player", "ckpt-e")]);
    const created = createEndpoint(state, "player", {
      name: "Atlas",
      checkpointId: "ckpt-e",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    const economics = {
      lifetimeApiRevenue: 12_000,
      lifetimeSubRevenue: 3_000,
      lifetimeEnterpriseRevenue: 0,
      lifetimeServingCost: 1_000,
      lifetimeNet: 14_000,
      trainingInitialCost: 500,
      trainingDataCost: 200,
      trainingDailyCost: 100,
    };
    state = {
      ...created.state,
      player: {
        ...created.state.player,
        models: created.state.player.models.map((model) =>
          model.id === id ? { ...model, economics } : model,
        ),
      },
    };
    state = projectEndpointsToModels(state, "player");
    const again = state.player.models.find((model) => model.id === id);
    expect(again?.economics).toEqual(economics);
  });

  it("domain composite takes per-domain max and applies a misroute penalty that shrinks with routerQuality", () => {
    let state = createGame(4_103);
    const code = makeCheckpoint("player", "ckpt-code", {
      domains: { code: 80, math: 20, language: 40 },
    });
    const math = makeCheckpoint("player", "ckpt-math", {
      domains: { code: 25, math: 90, language: 40 },
    });
    state = seedCheckpoints(state, "player", [code, math], {
      researchUnlocked: ["router_domain"],
    });
    const created = createRouter(state, "player", {
      name: "Domain Mix",
      policy: "domain",
      members: [
        { checkpointId: "ckpt-code", role: "primary", domains: ["code"] },
        { checkpointId: "ckpt-math", role: "member", domains: ["math"] },
      ],
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const endpoint = playerEndpoint(created.state, created.result.id);
    const low = compositeCapabilitiesWithQuality(created.state, endpoint, 0);
    const high = compositeCapabilitiesWithQuality(created.state, endpoint, 1);
    expect(high.domains.code).toBeCloseTo(80, 8);
    expect(high.domains.math).toBeCloseTo(90, 8);
    expect(low.domains.code).toBeLessThan(high.domains.code);
    expect(misrouteFraction(0)).toBeGreaterThan(misrouteFraction(1));
    const live = compositeCapabilities(created.state, endpoint);
    expect(live.domains.code).toBeLessThan(80);
    expect(live.domains.code).toBeGreaterThan(70);
  });

  it("modality router never invents a modality no member has", () => {
    let state = createGame(4_104);
    const text = makeCheckpoint("player", "ckpt-text");
    const visionArch: Architecture = {
      ...defaultArchitecture(),
      preset: "vision_language",
      inputs: ["text", "image"],
      outputs: ["text"],
    };
    const vision = makeCheckpoint("player", "ckpt-vision", {
      arch: visionArch,
      domains: { vision: 70, language: 45, audio: 12 },
    });
    state = seedCheckpoints(state, "player", [text, vision]);
    const created = createRouter(state, "player", {
      name: "Omni Gate",
      policy: "modality",
      members: [
        { checkpointId: "ckpt-text", role: "primary" },
        { checkpointId: "ckpt-vision", role: "member" },
      ],
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const endpoint = playerEndpoint(created.state, created.result.id);
    const caps = compositeCapabilities(created.state, endpoint);
    expect(caps.domains.vision).toBeGreaterThan(0);
    expect(caps.domains.audio).toBe(0);
    expect(caps.domains.video).toBe(0);
  });

  it("cascade serve cost is cheaper than the primary", () => {
    let state = createGame(4_105);
    const small = makeCheckpoint("player", "ckpt-small", { paramsB: 7 });
    const large = makeCheckpoint("player", "ckpt-large", { paramsB: 70 });
    state = seedCheckpoints(state, "player", [small, large], {
      researchUnlocked: ["router_cascade"],
    });
    const created = createRouter(state, "player", {
      name: "Cascade",
      policy: "cascade",
      members: [
        { checkpointId: "ckpt-large", role: "primary" },
        { checkpointId: "ckpt-small", role: "member" },
      ],
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const endpoint = playerEndpoint(created.state, created.result.id);
    expect(endpointCostMultiplier(created.state, endpoint)).toBeLessThan(1);
  });

  it("HBM sums all resident members", () => {
    let state = createGame(4_106);
    const a = makeCheckpoint("player", "ckpt-a", { paramsB: 7 });
    const b = makeCheckpoint("player", "ckpt-b", { paramsB: 13 });
    state = seedCheckpoints(state, "player", [a, b], {
      researchUnlocked: ["router_cascade"],
    });
    const created = createRouter(state, "player", {
      name: "Fleet",
      policy: "cascade",
      members: [
        { checkpointId: "ckpt-a", role: "primary" },
        { checkpointId: "ckpt-b", role: "member" },
      ],
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const endpoint = playerEndpoint(created.state, created.result.id);
    expect(endpointHbmGB(created.state, endpoint)).toBeCloseTo((7 + 13) * 4 * 1.15, 8);
  });

  it("sunset drains demand then retires", () => {
    let state = createGame(4_107);
    state = seedCheckpoints(state, "player", [makeCheckpoint("player", "ckpt-s")]);
    const created = createEndpoint(state, "player", {
      name: "Dusk",
      checkpointId: "ckpt-s",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const startDay = created.state.day;
    const id = created.result.id;
    state = sunsetEndpoint(created.state, id, 10);
    const mid = state.player.models.find((model) => model.id === id);
    expect(mid?.sunsetDemandMult).toBe(1);
    expect(mid?.commerciallyOffered).toBe(true);
    state = tickEndpoints({ ...state, day: startDay + 5 });
    const draining = state.player.models.find((model) => model.id === id);
    expect(draining?.sunsetDemandMult).toBeCloseTo(0.5, 8);
    expect(draining?.archived).toBeFalsy();
    state = tickEndpoints({ ...state, day: startDay + 10 });
    const retired = state.player.models.find((model) => model.id === id);
    expect(retired?.archived).toBe(true);
    expect(retired?.commerciallyOffered).toBe(false);
    expect(collectOffers(state).some((offer) => offer.modelId === id)).toBe(false);
  });

  it("retired projected models are archived and not offered", () => {
    let state = createGame(4_108);
    state = seedCheckpoints(state, "player", [makeCheckpoint("player", "ckpt-r")]);
    const created = createEndpoint(state, "player", {
      name: "Retired",
      checkpointId: "ckpt-r",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    state = retireEndpoint(created.state, id);
    const model = state.player.models.find((entry) => entry.id === id)!;
    expect(model.archived).toBe(true);
    expect(model.commerciallyOffered).toBe(false);
    expect(collectOffers(state).some((offer) => offer.modelId === id)).toBe(false);
  });

  it("rivals project into rival.models", () => {
    let state = createGame(4_109);
    const rivalId = state.rivals[0]!.id;
    const ckpt = makeCheckpoint(rivalId, "ckpt-rival");
    state = seedCheckpoints(state, rivalId, [ckpt]);
    const created = createEndpoint(state, rivalId, {
      name: "Rival Live",
      checkpointId: "ckpt-rival",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    const rival = created.state.rivals.find((r) => r.id === rivalId)!;
    const projected = rival.models.find((m) => m.id === id);
    expect(projected).toBeDefined();
    expect(created.state.player.models.some((m) => m.id === id)).toBe(false);
    assertModelComplete(projected!);
  });

  it("plans endpointIds resolve into the served roster", () => {
    let state = createGame(4_110);
    state = seedCheckpoints(state, "player", [makeCheckpoint("player", "ckpt-p")]);
    const created = createEndpoint(state, "player", {
      name: "PlanModel",
      checkpointId: "ckpt-p",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    state = created.state;
    const plus = state.player.pricing.plans.find((p) => p.id === "plan-plus")!;
    state = updatePlan(state, plus.id, {
      modelIds: [],
      endpointIds: [id],
    });
    const plan = state.player.pricing.plans.find((p) => p.id === plus.id)!;
    expect(planServingModelIds(state, plan)).toContain(id);
    const made = createPlan(state, {
      name: "Endpoint Seat",
      pricePerMonth: 40,
      usageMultiplier: 1,
      endpointIds: [id],
    });
    const custom = made.player.pricing.plans.find((p) => p.name === "Endpoint Seat");
    expect(custom?.endpointIds).toEqual([id]);
    expect(planServingModelIds(made, custom!)).toContain(id);
  });

  it("scales projected hosting cost with the peak served thinking budget", () => {
    let state = createGame(4_111);
    const ckpt = {
      ...makeCheckpoint("player", "ckpt-think"),
      tiers: unlockedThinkingTiers(),
    };
    state = seedCheckpoints(state, "player", [ckpt]);
    const created = createEndpoint(state, "player", {
      name: "Think Host",
      checkpointId: "ckpt-think",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const endpointId = created.result.id;
    const instant = created.state.player.models.find((m) => m.id === endpointId);
    expect(instant).toBeDefined();
    const served = setEndpointTier(created.state, endpointId, 20, true);
    const maxed = served.player.models.find((m) => m.id === endpointId);
    expect(maxed).toBeDefined();
    expect(maxed!.inferCostMult).toBeCloseTo((instant!.inferCostMult ?? 1) * 20, 5);
    expect(maxed!.tokPerSecMult).toBeCloseTo(
      (instant!.tokPerSecMult ?? 1) / Math.sqrt(20),
      5,
    );
  });

  it("open-sourcing a live endpoint raises brand and is one-way", () => {
    let state = createGame(4_112);
    const ckpt = makeCheckpoint("player", "ckpt-open");
    state = seedCheckpoints(state, "player", [ckpt]);
    const created = createEndpoint(state, "player", {
      name: "Open Host",
      checkpointId: "ckpt-open",
    });
    expect(created.result.ok).toBe(true);
    if (!created.result.ok) return;
    const id = created.result.id;
    const before = created.state.player.brandTrust;
    const opened = openSourceEndpoint(created.state, id);
    expect(opened.player.models.find((model) => model.id === id)?.openWeights).toBe(true);
    expect(opened.player.brandTrust).toBeGreaterThan(before);
    const again = openSourceEndpoint(opened, id);
    expect(again.player.brandTrust).toBe(opened.player.brandTrust);
    const closed = updateEndpoint(opened, id, { openWeights: false });
    expect(closed.player.models.find((model) => model.id === id)?.openWeights).toBe(true);
  });

  it("releasing with open weights grants the same brand lift", () => {
    let state = createGame(4_113);
    const ckpt = makeCheckpoint("player", "ckpt-open-ship");
    state = seedCheckpoints(state, "player", [ckpt]);
    const closed = createEndpoint(state, "player", {
      name: "Closed Ship",
      checkpointId: "ckpt-open-ship",
    });
    const opened = createEndpoint(state, "player", {
      name: "Open Ship",
      checkpointId: "ckpt-open-ship",
      openWeights: true,
    });
    expect(closed.result.ok && opened.result.ok).toBe(true);
    if (!closed.result.ok || !opened.result.ok) return;
    expect(opened.state.player.brandTrust).toBeGreaterThan(closed.state.player.brandTrust);
    expect(opened.state.player.models.find((model) => model.id === opened.result.id)?.openWeights).toBe(
      true,
    );
  });
});
