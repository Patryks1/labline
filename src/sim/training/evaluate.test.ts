import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { createRng, hashSeed } from "../rng";
import type { ModelCapabilities, SimState } from "../types";
import { TRAINING_V4 } from "./constants";
import {
  currentSeason,
  deflatePublicScore,
  evalCost,
  latentDraw,
  orderEval,
  publicScores,
  tickEvals,
  tickSeasons,
} from "./evaluate";
import { defaultArchitecture, emptyTrainingState, trainingStateOf, withTrainingState } from "./state";
import type { Checkpoint, Endpoint, EvalMetric, ThinkingTier } from "./types";

const METRICS: EvalMetric[] = ["language", "math", "overall"];

function truthAt(value: number, domains?: Partial<ModelCapabilities["domains"]>): ModelCapabilities {
  return {
    domains: {
      language: value,
      reasoning: value,
      code: value,
      math: value,
      science: value,
      vision: 0,
      video: 0,
      audio: 0,
      tools: value,
      ...domains,
    },
    factuality: value,
    steerability: value,
    robustness: value,
    safety: value,
    reliability: value,
  };
}

function makeCheckpoint(
  state: SimState,
  overrides: Partial<Checkpoint> & Pick<Checkpoint, "id">,
): Checkpoint {
  return {
    labId: state.playerLabId,
    lineageId: "line-1",
    name: overrides.name ?? "Atlas",
    version: "0.1",
    stage: "post",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truthAt(70),
    trainingSummary: {
      pfDays: 10,
      effectiveMTok: 140,
      loss: 2.1,
      gap: 0.4,
      dataMix: {},
      syntheticShare: 0.1,
    },
    postTrain: { stages: {} },
    tiers: [{ budget: 1, served: true }],
    endpointIds: [],
    ...overrides,
  };
}

function makeEndpoint(
  state: SimState,
  overrides: Partial<Endpoint> & Pick<Endpoint, "id" | "name">,
): Endpoint {
  return {
    labId: state.playerLabId,
    members: [{ checkpointId: "cp-1", role: "primary" }],
    policy: "single",
    tiers: [{ budget: 1, served: true }],
    precision: "bf16",
    status: "live",
    releaseDay: 1,
    pricing: { inPerMTok: 1, outPerMTok: 3 },
    openWeights: false,
    modelId: overrides.id,
    ...overrides,
  };
}

function withPlayerTraining(state: SimState, patch: Partial<ReturnType<typeof emptyTrainingState>>): SimState {
  const slice = trainingStateOf(state, state.playerLabId);
  return withTrainingState(state, state.playerLabId, { ...slice, ...patch });
}

function rich(state: SimState, cash = 5_000_000): SimState {
  return { ...state, player: { ...state.player, cash } };
}

function completeOn(state: SimState, day: number): SimState {
  return tickEvals({ ...state, day });
}

describe("evalCost", () => {
  it("matches the V4 cash / days / sigma table", () => {
    expect(evalCost("quick", METRICS)).toEqual({ cash: 0, days: 1, sigma: 4 });
    expect(evalCost("audit", METRICS)).toEqual({ cash: 400_000, days: 7, sigma: 1 });

    const one = evalCost("suite", ["language"]);
    expect(one.cash).toBe(62_500);
    expect(one.days).toBe(2);
    expect(one.sigma).toBe(2.5);

    const three = evalCost("suite", ["language", "math", "code"]);
    expect(three.cash).toBe(87_500);
    expect(three.days).toBe(3);
    expect(three.sigma).toBe(2.25);

    const eight = evalCost("suite", [
      "language",
      "reasoning",
      "code",
      "math",
      "science",
      "tools",
      "safety",
      "overall",
    ]);
    expect(eight.cash).toBe(150_000);
    expect(eight.days).toBe(4);
    expect(eight.sigma).toBe(1.625);

    const many = evalCost("suite", [
      "language",
      "reasoning",
      "code",
      "math",
      "science",
      "tools",
      "safety",
      "steerability",
      "reliability",
    ]);
    expect(many.cash).toBe(150_000);
    expect(many.days).toBe(5);
    expect(many.sigma).toBe(1.5);
  });

  it("scales cash by thinking budget and days by sqrt", () => {
    const instant = evalCost("suite", ["language"], 1);
    const high = evalCost("suite", ["language"], 8);
    expect(high.cash).toBe(instant.cash * 8);
    expect(high.days).toBe(Math.max(instant.days, Math.ceil(instant.days * Math.sqrt(8))));
    expect(high.sigma).toBe(instant.sigma);
    expect(evalCost("quick", ["overall"], 100).cash).toBe(0);
    expect(evalCost("quick", ["overall"], 100).days).toBe(10);
  });
});

describe("latentDraw", () => {
  it("is deterministic and clamped to ±3", () => {
    const a = latentDraw(11, "cp-1", "math");
    const b = latentDraw(11, "cp-1", "math");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(-3);
    expect(a).toBeLessThanOrEqual(3);
    expect(latentDraw(11, "cp-1", "language")).not.toBe(a);
  });
});

describe("orderEval validations", () => {
  it("rejects missing checkpoint, empty metrics, unaffordable cash, and unknown tiers", () => {
    const base = rich(createGame(8011));
    const checkpoint = makeCheckpoint(base, {
      id: "cp-1",
      tiers: [{ budget: 1, served: true }, { budget: 8, served: true }],
    });
    const state = withPlayerTraining(base, { checkpoints: [checkpoint] });

    expect(orderEval(state, state.playerLabId, {
      checkpointId: "missing",
      tier: "quick",
      tierBudget: 1,
      metrics: ["overall"],
    }).result).toEqual({ ok: false, reason: "checkpoint not found" });

    expect(orderEval(state, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "quick",
      tierBudget: 1,
      metrics: [],
    }).result).toEqual({ ok: false, reason: "metrics required" });

    expect(orderEval(state, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "suite",
      tierBudget: 20,
      metrics: ["overall"],
    }).result).toEqual({ ok: false, reason: "tier not available" });

    const broke = { ...state, player: { ...state.player, cash: 0 } };
    expect(orderEval(broke, broke.playerLabId, {
      checkpointId: "cp-1",
      tier: "suite",
      tierBudget: 1,
      metrics: ["overall"],
    }).result).toEqual({ ok: false, reason: "insufficient cash" });
  });

  it("queues several thinking budgets in one order and charges the sum", () => {
    const base = rich(createGame(8011));
    const checkpoint = makeCheckpoint(base, {
      id: "cp-1",
      tiers: [
        { budget: 1, served: true },
        { budget: 8, served: false },
      ],
    });
    const state = withPlayerTraining(base, { checkpoints: [checkpoint] });
    const cash = state.player.cash;
    const ordered = orderEval(state, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "suite",
      tierBudgets: [1, 8],
      metrics: ["overall"],
    });
    expect(ordered.result.ok).toBe(true);
    const evals = trainingStateOf(ordered.state, state.playerLabId).evals;
    expect(evals).toHaveLength(2);
    expect(evals.map((item) => item.tierBudget).sort((a, b) => a - b)).toEqual([1, 8]);
    expect(ordered.state.player.cash).toBe(
      cash - evalCost("suite", ["overall"], 1).cash - evalCost("suite", ["overall"], 8).cash,
    );
  });
});

describe("evaluation pipeline", () => {
  it("does not mutate the input state when ordering", () => {
    const base = rich(createGame(8012));
    const state = withPlayerTraining(base, {
      checkpoints: [makeCheckpoint(base, { id: "cp-1" })],
    });
    const evals = trainingStateOf(state, state.playerLabId).evals;
    const cash = state.player.cash;
    const ordered = orderEval(state, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "suite",
      tierBudget: 1,
      metrics: METRICS,
    });
    expect(ordered.result.ok).toBe(true);
    expect(state.player.cash).toBe(cash);
    expect(trainingStateOf(state, state.playerLabId).evals).toBe(evals);
    expect(trainingStateOf(ordered.state, state.playerLabId).evals).toHaveLength(1);
    expect(ordered.state.player.cash).toBe(cash - evalCost("suite", METRICS).cash);
  });

  it("reuses the same latent so two suite evals on different days share means", () => {
    const base = rich(createGame(8013));
    const state = withPlayerTraining(base, {
      checkpoints: [makeCheckpoint(base, { id: "cp-1", truth: truthAt(72) })],
    });
    const first = orderEval(state, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "suite",
      tierBudget: 1,
      metrics: METRICS,
    });
    expect(first.result.ok).toBe(true);
    const firstDone = completeOn(first.state, first.state.day + 10);

    const laterDay = firstDone.day + 3;
    const second = orderEval({ ...firstDone, day: laterDay }, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "suite",
      tierBudget: 1,
      metrics: METRICS,
    });
    expect(second.result.ok).toBe(true);
    const both = completeOn(second.state, laterDay + 10);
    const evals = trainingStateOf(both, state.playerLabId).evals;
    expect(evals).toHaveLength(2);
    expect(evals[0]?.result?.measured.language?.mean).toBe(
      evals[1]?.result?.measured.language?.mean,
    );
    expect(evals[0]?.result?.measured.math?.mean).toBe(evals[1]?.result?.measured.math?.mean);
    expect(evals[0]?.id).not.toBe(evals[1]?.id);
  });

  it("completes on completeDay and not before", () => {
    const base = rich(createGame(8014));
    const state = withPlayerTraining(base, {
      checkpoints: [makeCheckpoint(base, { id: "cp-1" })],
    });
    const ordered = orderEval(state, state.playerLabId, {
      checkpointId: "cp-1",
      tier: "quick",
      tierBudget: 1,
      metrics: ["overall"],
    });
    const running = trainingStateOf(ordered.state, state.playerLabId).evals[0]!;
    expect(running.status).toBe("running");
    const early = tickEvals(ordered.state);
    expect(trainingStateOf(early, state.playerLabId).evals[0]?.status).toBe("running");
    const done = completeOn(ordered.state, running.completeDay);
    const finished = trainingStateOf(done, state.playerLabId).evals[0]!;
    expect(finished.status).toBe("complete");
    expect(finished.result?.measured.overall).toMatchObject({
      mean: expect.any(Number),
      ci: expect.any(Number),
    });
    expect(finished.result).not.toHaveProperty("truth");
  });

  it("orders confidence intervals audit < suite < quick", () => {
    const base = rich(createGame(8015));
    const state = withPlayerTraining(base, {
      checkpoints: [makeCheckpoint(base, { id: "cp-1" })],
    });
    let next = state;
    for (const tier of ["quick", "suite", "audit"] as const) {
      const ordered = orderEval(next, state.playerLabId, {
        checkpointId: "cp-1",
        tier,
        tierBudget: 1,
        metrics: ["language"],
      });
      expect(ordered.result.ok).toBe(true);
      next = ordered.state;
    }
    const done = completeOn(next, next.day + 7);
    const byTier = Object.fromEntries(
      trainingStateOf(done, state.playerLabId).evals.map((item) => [
        item.tier,
        item.result?.measured.language?.ci ?? 0,
      ]),
    );
    expect(byTier.audit).toBeLessThan(byTier.suite);
    expect(byTier.suite).toBeLessThan(byTier.quick);
  });

  it("applies tier lift when the matching thinking head is trained", () => {
    const base = rich(createGame(8016));
    const servedTiers: ThinkingTier[] = [
      { budget: 1, served: true },
      { budget: 8, served: true },
    ];
    const unservedTiers: ThinkingTier[] = [
      { budget: 1, served: true },
      { budget: 8, served: false },
    ];
    const reasoning = { stages: { reasoning: { effect: 1, runs: 1, pfDays: 12 } } };

    const servedState = withPlayerTraining(base, {
      checkpoints: [
        makeCheckpoint(base, {
          id: "cp-served",
          truth: truthAt(60),
          postTrain: reasoning,
          tiers: servedTiers,
        }),
      ],
    });
    const unservedState = withPlayerTraining(base, {
      checkpoints: [
        makeCheckpoint(base, {
          id: "cp-idle",
          truth: truthAt(60),
          postTrain: reasoning,
          tiers: unservedTiers,
        }),
      ],
    });

    function means(start: SimState, checkpointId: string): { base: number; lifted: number } {
      const low = orderEval(start, start.playerLabId, {
        checkpointId,
        tier: "suite",
        tierBudget: 1,
        metrics: ["math"],
      });
      const high = orderEval({ ...low.state, day: start.day + 1 }, start.playerLabId, {
        checkpointId,
        tier: "suite",
        tierBudget: 8,
        metrics: ["math"],
      });
      const done = completeOn(high.state, start.day + 20);
      const evals = trainingStateOf(done, start.playerLabId).evals;
      const at1 = evals.find((item) => item.tierBudget === 1)?.result?.measured.math?.mean ?? 0;
      const at8 = evals.find((item) => item.tierBudget === 8)?.result?.measured.math?.mean ?? 0;
      return { base: at1, lifted: at8 };
    }

    const served = means(servedState, "cp-served");
    expect(served.lifted).toBeGreaterThan(served.base);

    const idle = means(unservedState, "cp-idle");
    expect(idle.lifted).toBeGreaterThan(idle.base);
  });
});

describe("fog and public scores", () => {
  it("returns {} for sunset or retired endpoints and hides unreleased checkpoints", () => {
    const base = rich(createGame(8017));
    const released = makeCheckpoint(base, { id: "cp-public", status: "released", truth: truthAt(88) });
    const stealth = makeCheckpoint(base, { id: "cp-stealth", status: "stealth", truth: truthAt(99) });
    const live = makeEndpoint(base, {
      id: "ep-live",
      name: "Live",
      members: [{ checkpointId: "cp-public", role: "primary" }],
    });
    const sunset = makeEndpoint(base, {
      id: "ep-sunset",
      name: "Sunset",
      status: "sunset",
      members: [{ checkpointId: "cp-public", role: "primary" }],
    });
    const retired = makeEndpoint(base, {
      id: "ep-retired",
      name: "Retired",
      status: "retired",
      members: [{ checkpointId: "cp-public", role: "primary" }],
    });
    const hidden = makeEndpoint(base, {
      id: "ep-hidden",
      name: "Hidden",
      members: [{ checkpointId: "cp-stealth", role: "primary" }],
    });
    const state = withPlayerTraining(base, {
      checkpoints: [released, stealth],
      endpoints: [live, sunset, retired, hidden],
    });

    expect(publicScores(state, "ep-sunset")).toEqual({});
    expect(publicScores(state, "ep-retired")).toEqual({});
    expect(publicScores(state, "ep-hidden")).toEqual({});
    const visible = publicScores(state, "ep-live");
    expect(Object.keys(visible).length).toBeGreaterThan(0);
    expect(visible).not.toEqual(released.truth);
    expect(JSON.stringify(visible)).not.toContain('"truth"');
  });
});

describe("seasons", () => {
  it("rolls over every 365 days and deflation reduces a 95 more than a 60", () => {
    const base = rich(createGame(8018));
    const state = withPlayerTraining(base, { checkpoints: [], endpoints: [] });
    expect(currentSeason(state)).toMatchObject({
      season: 1,
      startDay: 0,
      difficultyIndex: 1,
    });

    const seeded = tickSeasons(state);
    expect(currentSeason(seeded).season).toBe(1);

    const rolled = tickSeasons({ ...seeded, day: 365 });
    const season = currentSeason(rolled);
    expect(season.season).toBe(2);
    expect(season.startDay).toBe(365);
    expect(season.difficultyIndex).toBeCloseTo(1.15);

    const dropHigh = 95 - deflatePublicScore(95, season.difficultyIndex);
    const dropLow = 60 - deflatePublicScore(60, season.difficultyIndex);
    expect(dropHigh).toBeGreaterThan(dropLow);
    expect(dropLow).toBe(0);
  });

  it("flags synthetic-heavy and leaked-audit endpoints when a season opens", () => {
    const base = rich(createGame(8019));
    const dirty = makeCheckpoint(base, {
      id: "cp-synth",
      status: "released",
      trainingSummary: {
        pfDays: 8,
        effectiveMTok: 80,
        loss: 2,
        gap: 0.4,
        dataMix: {},
        syntheticShare: 0.7,
      },
    });
    const leaked = makeCheckpoint(base, { id: "cp-leak", status: "released" });
    let leakSeed = 0;
    for (let i = 0; i < 20_000; i++) {
      if (createRng(hashSeed(i, "leak")).next() < TRAINING_V4.evals.audit.leakRisk) {
        leakSeed = i;
        break;
      }
    }
    const state = withPlayerTraining(base, {
      checkpoints: [dirty, leaked],
      endpoints: [
        makeEndpoint(base, {
          id: "ep-synth",
          name: "Synth",
          members: [{ checkpointId: "cp-synth", role: "primary" }],
        }),
        makeEndpoint(base, {
          id: "ep-leak",
          name: "Leak",
          members: [{ checkpointId: "cp-leak", role: "primary" }],
        }),
      ],
      evals: [
        {
          id: "eval-planted",
          labId: base.playerLabId,
          checkpointId: "cp-leak",
          tier: "audit",
          tierBudget: 1,
          metrics: ["overall"],
          orderedDay: 1,
          completeDay: 1,
          cashCost: 400_000,
          status: "running",
          seed: leakSeed,
        },
      ],
    });
    const leakedState = tickEvals(state);
    expect(trainingStateOf(leakedState, base.playerLabId).evals[0]?.result?.leaked).toBe(true);
    expect(leakedState.alerts.some((alert) => alert.message.includes("leaked"))).toBe(true);
    expect((leakedState.feedEvents ?? []).some((event) => event.kind === "eval_leak")).toBe(true);
    expect(trainingStateOf(leakedState, base.playerLabId).endpoints.map((item) => item.id)).toEqual([
      "ep-synth",
      "ep-leak",
    ]);
    expect(
      trainingStateOf(leakedState, base.playerLabId).checkpoints.find((item) => item.id === "cp-synth")
        ?.trainingSummary.syntheticShare,
    ).toBe(0.7);

    const seasoned = tickSeasons(leakedState);
    const stored = trainingStateOf(seasoned, base.playerLabId).seasons;
    expect(stored.length).toBeGreaterThan(0);
    const contamination = currentSeason(seasoned).contamination;
    expect(contamination["ep-synth"]).toEqual(expect.arrayContaining(["reasoning", "math", "code"]));
    expect(contamination["ep-leak"]?.length).toBeGreaterThan(3);
  });
});
