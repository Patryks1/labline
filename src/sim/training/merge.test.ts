import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { createRng, hashSeed } from "../rng";
import { CAPABILITY_DOMAINS } from "../balance/modelCapabilities";
import type { ModelCapabilities, SimState } from "../types";
import { canMerge, mergeCheckpoints } from "./merge";
import { TRAINING_V4 } from "./constants";
import { defaultArchitecture, emptyTrainingState, withTrainingState } from "./state";
import { checkpointById } from "./checkpoints";
import type { Checkpoint } from "./types";

function truth(fill: number, over: Partial<ModelCapabilities["domains"]> = {}): ModelCapabilities {
  return {
    domains: {
      language: fill,
      reasoning: fill,
      code: fill,
      math: fill,
      science: fill,
      vision: 0,
      video: 0,
      audio: 0,
      tools: fill * 0.5,
      ...over,
    },
    factuality: fill,
    steerability: fill,
    robustness: fill,
    safety: 40,
    reliability: fill,
  };
}

function ckpt(state: SimState, over: Partial<Checkpoint>): Checkpoint {
  return {
    id: "a",
    labId: state.playerLabId,
    lineageId: "lin-a",
    name: "A",
    version: "1.0",
    stage: "base",
    status: "kept",
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truth(40, { math: 30 }),
    trainingSummary: {
      pfDays: 10,
      effectiveMTok: 100,
      loss: 2,
      gap: 0.4,
      dataMix: { chat: 1 },
      syntheticShare: 0,
    },
    postTrain: { stages: { instruct: { effect: 0.4, runs: 1, pfDays: 3 } } },
    tiers: [],
    endpointIds: [],
    ...over,
  };
}

function withMergeUnlock(state: SimState, a: Checkpoint, b: Checkpoint): SimState {
  const unlocked = state.player.researchUnlocked.includes("opt_merge")
    ? state.player.researchUnlocked
    : [...state.player.researchUnlocked, "opt_merge"];
  const next = withTrainingState(state, state.playerLabId, {
    ...emptyTrainingState(),
    checkpoints: [a, b],
  });
  return {
    ...next,
    player: { ...next.player, researchUnlocked: unlocked, cash: Math.max(next.player.cash, 1_000_000) },
  };
}

describe("merge", () => {
  it("enforces canMerge rules", () => {
    const state = createGame(11);
    const a = ckpt(state, { id: "a", status: "kept" });
    const b = ckpt(state, { id: "b", status: "kept", truth: truth(50) });
    expect(canMerge(state, "a", "b").ok).toBe(false);
    const ready = withMergeUnlock(state, a, b);
    expect(canMerge(ready, "a", "b").ok).toBe(true);
    expect(canMerge(ready, "a", "a").ok).toBe(false);
    const sold = withMergeUnlock(state, a, { ...b, status: "sold" });
    expect(canMerge(sold, "a", "b").ok).toBe(false);
    const moe = withMergeUnlock(state, a, {
      ...b,
      arch: { ...b.arch, backbone: "moe", activeParamsB: 0.7 },
    });
    expect(canMerge(moe, "a", "b").reason).toMatch(/Backbone/i);
    const size = withMergeUnlock(state, a, {
      ...b,
      arch: { ...b.arch, totalParamsB: 8, activeParamsB: 8 },
    });
    expect(canMerge(size, "a", "b").reason).toMatch(/5%/);
    const preset = withMergeUnlock(state, a, {
      ...b,
      arch: { ...b.arch, preset: "omni" },
    });
    expect(canMerge(preset, "a", "b").reason).toMatch(/Preset/i);
  });

  it("merges truth as max+bonus and applies seeded regression", () => {
    const base = createGame(11);
    const a = ckpt(base, { id: "a", truth: truth(40, { math: 20, code: 50 }) });
    const b = ckpt(base, { id: "b", lineageId: "lin-b", truth: truth(45, { math: 60, code: 30 }) });
    const bonus = TRAINING_V4.merge.bonus;
    const ready = withMergeUnlock(base, a, b);
    let cleanSeed = ready.seed;
    for (let seed = 1; seed < 400; seed++) {
      const rng = createRng(hashSeed(seed, "a", "b", "merge", ready.day));
      if (rng.next() >= TRAINING_V4.merge.regressionRisk) {
        cleanSeed = seed;
        break;
      }
    }
    const merged = mergeCheckpoints({ ...ready, seed: cleanSeed }, "a", "b", "Soup");
    expect(merged.result.ok).toBe(true);
    if (!merged.result.ok) return;
    const child = checkpointById(merged.state, merged.result.id)!;
    expect(child.version).toBe("1.0m");
    expect(child.lineageId).toBe(a.lineageId);
    expect(child.trainingSummary.mergedFrom).toEqual(["a", "b"]);
    expect(child.truth.domains.language).toBeCloseTo(Math.min(82, 45 + bonus), 5);
    expect(child.truth.domains.math).toBeCloseTo(Math.min(82, 60 + bonus), 5);
    expect(child.truth.domains.code).toBeCloseTo(Math.min(82, 50 + bonus), 5);
    expect(child.postTrain.stages.instruct?.effect).toBe(0.4);

    let seed = 1;
    let hit = false;
    for (; seed < 400; seed++) {
      const rng = createRng(hashSeed(seed, "a", "b", "merge", ready.day));
      if (rng.next() < TRAINING_V4.merge.regressionRisk) {
        hit = true;
        break;
      }
    }
    expect(hit).toBe(true);
    const rolled = mergeCheckpoints({ ...ready, seed }, "a", "b", "Soup-reg");
    expect(rolled.result.ok).toBe(true);
    if (!rolled.result.ok) return;
    const rng = createRng(hashSeed(seed, "a", "b", "merge", ready.day));
    rng.next();
    const domain = CAPABILITY_DOMAINS[Math.floor(rng.next() * CAPABILITY_DOMAINS.length)]!;
    const child2 = checkpointById(rolled.state, rolled.result.id)!;
    const expected = Math.max(0, Math.min(82, Math.max(a.truth.domains[domain], b.truth.domains[domain]) + bonus) - 4);
    expect(child2.truth.domains[domain]).toBeCloseTo(expected, 5);
  });
});
