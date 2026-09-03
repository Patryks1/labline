import { describe, expect, it } from "vitest";
import type { TrainingUnlock } from "../training/types";
import {
  aggregateModifiers,
  computeEquivalent,
} from "../training/modifiers";
import { RESEARCH_NODES, getResearchNode } from "./research";

const V4_KEYS = [
  "paramEfficiency",
  "dataEfficiency",
  "computeThroughput",
  "stability",
  "precisionPenaltyMult",
  "ceilingLift",
  "postTrainEfficiency",
  "rlQuality",
  "syntheticQuality",
  "verifierStrength",
  "distillEfficiency",
  "routerQuality",
  "serveEfficiency",
  "hostingDiscount",
  "quantPenaltyMult",
  "modalityBridge",
] as const;

const ALL_UNLOCKS: TrainingUnlock[] = [
  "moe",
  "omni",
  "vision",
  "audio",
  "video",
  "context_32k",
  "long_context",
  "context_1m",
  "context_10m",
  "context_100m",
  "fp16_train",
  "bf16_train",
  "fp8_train",
  "fp6_train",
  "nvfp4_train",
  "distill",
  "merge",
  "thinking_tiers",
  "router_domain",
  "router_cascade",
  "continued_pretrain",
  "verifier",
];

/** ~15 cheapest-path training nodes for a plausible year-3 lab. */
export const YEAR_3_TRAINING_NODES = [
  "dense_basics",
  "opt_fp16",
  "align_sft",
  "data_mix",
  "opt_checkpoint",
  "align_thinking",
  "data_clean",
  "opt_distill_stack",
  "opt_data_pipe",
  "moe_basics",
  "opt_flash",
  "dense_opt",
  "opt_fsdp",
  "opt_mixed",
  "data_eval",
] as const;

/** Year-3 set plus 25 later training / data / fabric nodes. */
export const YEAR_8_TRAINING_NODES = [
  ...YEAR_3_TRAINING_NODES,
  "opt_grad_accum",
  "opt_overlap_comm",
  "opt_pipeline",
  "opt_torch_compile",
  "hw_network",
  "hw_storage",
  "opt_seq_parallel",
  "si_hbm_stack",
  "dense_context",
  "dense_mtp",
  "moe_routing",
  "moe_balance",
  "data_synth",
  "data_flywheel",
  "data_web",
  "data_specialists",
  "moe_parallel",
  "align_rlhf",
  "align_process",
  "opt_continue",
  "align_verifier",
  "opt_compute_sched",
  "dense_synth",
  "moe_upcycle",
  "org_talent",
] as const;

function modifiersForIds(ids: readonly string[]) {
  const nodes = ids.map((id) => getResearchNode(id));
  const ranks = Object.fromEntries(ids.map((id) => [id, 1]));
  return aggregateModifiers(nodes, ranks);
}

function transitiveIds(id: string): Set<string> {
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    for (const prereq of getResearchNode(nodeId).prereqs) visit(prereq);
  };
  visit(id);
  return seen;
}

function pathTo(targetId: string): string[] {
  return [...transitiveIds(targetId)];
}

describe("research V4 catalog", () => {
  it("gives every TrainingUnlock to exactly one node", () => {
    const grants = new Map<TrainingUnlock, string[]>();
    for (const unlock of ALL_UNLOCKS) grants.set(unlock, []);
    for (const node of RESEARCH_NODES) {
      for (const unlock of node.effects.unlock ?? []) {
        const list = grants.get(unlock) ?? [];
        list.push(node.id);
        grants.set(unlock, list);
      }
    }
    for (const unlock of ALL_UNLOCKS) {
      expect(grants.get(unlock), unlock).toEqual([
        expect.stringMatching(/.+/),
      ]);
      expect(grants.get(unlock)).toHaveLength(1);
    }
  });

  it("gives every node at least one V4 effect or unlock", () => {
    for (const node of RESEARCH_NODES) {
      const hasUnlock = (node.effects.unlock?.length ?? 0) > 0;
      const hasV4 = V4_KEYS.some((key) => node.effects[key] != null);
      expect(hasUnlock || hasV4, node.id).toBe(true);
    }
  });

  it("has acyclic prerequisites", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string) => {
      if (done.has(id)) return;
      expect(visiting.has(id), `cycle at ${id}`).toBe(false);
      visiting.add(id);
      for (const prereq of getResearchNode(id).prereqs) visit(prereq);
      visiting.delete(id);
      done.add(id);
    };
    for (const node of RESEARCH_NODES) visit(node.id);
  });

  it("keeps distill, thinking_tiers, and moe inside the first ~12 nodes of cost", () => {
    const distill = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("distill"),
    )!.id;
    const thinking = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("thinking_tiers"),
    )!.id;
    const moe = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("moe"),
    )!.id;
    const union = new Set([
      ...pathTo(distill),
      ...pathTo(thinking),
      ...pathTo(moe),
    ]);
    expect(union.size).toBeLessThanOrEqual(12);
  });

  it("puts omni behind vision, audio, video, and a modality bridge, deep in the tree", () => {
    const omni = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("omni"),
    )!;
    const vision = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("vision"),
    )!.id;
    const audio = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("audio"),
    )!.id;
    const video = RESEARCH_NODES.find((node) =>
      node.effects.unlock?.includes("video"),
    )!.id;
    const bridge = RESEARCH_NODES.find(
      (node) => (node.effects.modalityBridge ?? 1) > 1.1 && node.id !== omni.id,
    )!;
    const closure = transitiveIds(omni.id);
    expect(closure.has(vision)).toBe(true);
    expect(closure.has(audio)).toBe(true);
    expect(closure.has(video)).toBe(true);
    expect(closure.has(bridge.id)).toBe(true);
    expect(closure.size).toBeGreaterThanOrEqual(30);
  });

  it("year-3 training set lands computeEquivalent in [3, 4.5]", () => {
    expect(YEAR_3_TRAINING_NODES).toHaveLength(15);
    const eq = computeEquivalent(modifiersForIds(YEAR_3_TRAINING_NODES));
    expect(eq).toBeGreaterThanOrEqual(3);
    expect(eq).toBeLessThanOrEqual(4.5);
  });

  it("year-8 training set lands computeEquivalent in [8, 14]", () => {
    expect(YEAR_8_TRAINING_NODES).toHaveLength(40);
    const eq = computeEquivalent(modifiersForIds(YEAR_8_TRAINING_NODES));
    expect(eq).toBeGreaterThanOrEqual(8);
    expect(eq).toBeLessThanOrEqual(14);
  });
});
