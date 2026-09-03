import {
  TIER_BUDGETS,
  tierLabel,
} from "../../../../../../sim/training/thinking";
import type {
  BenchmarkMetricId,
  CapabilityDomain,
  ModelCapabilities,
  ServePrecision,
} from "../../../../../../sim/types";
import type {
  Checkpoint,
  EndpointMember,
  EndpointMemberRole,
  RouterPolicy,
  ThinkingTier,
  TierBudget,
} from "../../../../../../sim/training/types";
import type { EndpointCardVM } from "../../viewModels/types";

export { TIER_BUDGETS, tierLabel };

export const CAPABILITY_DOMAINS: readonly CapabilityDomain[] = [
  "language",
  "reasoning",
  "code",
  "math",
  "science",
  "vision",
  "video",
  "audio",
  "tools",
];

export const POLICY_LABEL: Record<RouterPolicy, string> = {
  single: "Single",
  domain: "Domain router",
  cascade: "Cascade",
  modality: "Modality",
};

export function trySim<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function orderFleetEndpoints(endpoints: EndpointCardVM[]): {
  live: EndpointCardVM[];
  sunset: EndpointCardVM[];
  retired: EndpointCardVM[];
} {
  const live: EndpointCardVM[] = [];
  const sunset: EndpointCardVM[] = [];
  const retired: EndpointCardVM[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.status === "live") live.push(endpoint);
    else if (endpoint.status === "sunset") sunset.push(endpoint);
    else retired.push(endpoint);
  }
  return { live, sunset, retired };
}

export function eligibleCheckpoints(checkpoints: Checkpoint[]): Checkpoint[] {
  return checkpoints.filter(
    (checkpoint) => checkpoint.status === "kept" || checkpoint.status === "released",
  );
}

export function nextTiers(
  tiers: ThinkingTier[],
  budget: TierBudget,
  served: boolean,
): ThinkingTier[] | null {
  const current = tiers.find((tier) => tier.budget === budget);
  if (!current) return null;
  if (current.served && !served) {
    const servedCount = tiers.filter((tier) => tier.served).length;
    if (servedCount <= 1) return null;
  }
  return tiers.map((tier) => (tier.budget === budget ? { ...tier, served } : tier));
}

export interface RouterDraftMember {
  checkpointId: string;
  role: EndpointMemberRole;
  domains?: CapabilityDomain[];
}

export interface RouterDraft {
  name: string;
  members: RouterDraftMember[];
  policy: RouterPolicy;
}

export function validateRouterDraft(
  draft: RouterDraft,
): { ok: true } | { ok: false; reason: string } {
  if (draft.members.length < 2) {
    return { ok: false, reason: "Need at least two members" };
  }
  const primaries = draft.members.filter((member) => member.role === "primary");
  if (primaries.length !== 1) {
    return { ok: false, reason: "Exactly one primary required" };
  }
  if (draft.policy === "single") {
    return { ok: false, reason: "Single policy is for one-checkpoint endpoints" };
  }
  return { ok: true };
}

export function emptyCapabilities(): ModelCapabilities {
  return {
    domains: {
      language: 0,
      reasoning: 0,
      code: 0,
      math: 0,
      science: 0,
      vision: 0,
      video: 0,
      audio: 0,
      tools: 0,
    },
    factuality: 0,
    steerability: 0,
    robustness: 0,
    safety: 0,
    reliability: 0,
  };
}

/** Per-domain max of member truths (UI fallback when compositeCapabilities is stubbed). */
export function compositeFallbackCapabilities(
  truths: ModelCapabilities[],
): ModelCapabilities {
  if (truths.length === 0) return emptyCapabilities();
  const domains = { ...emptyCapabilities().domains };
  for (const domain of CAPABILITY_DOMAINS) {
    let max = 0;
    for (const truth of truths) {
      const value = truth.domains[domain] ?? 0;
      if (value > max) max = value;
    }
    domains[domain] = max;
  }
  const maxOf = (pick: (caps: ModelCapabilities) => number) =>
    truths.reduce((max, caps) => Math.max(max, pick(caps)), 0);
  return {
    domains,
    factuality: maxOf((caps) => caps.factuality),
    steerability: maxOf((caps) => caps.steerability),
    robustness: maxOf((caps) => caps.robustness),
    safety: maxOf((caps) => caps.safety),
    reliability: maxOf((caps) => caps.reliability),
  };
}

export function domainMean(caps: ModelCapabilities): number {
  let sum = 0;
  for (const domain of CAPABILITY_DOMAINS) sum += caps.domains[domain] ?? 0;
  return sum / CAPABILITY_DOMAINS.length;
}

export function bestSingleCapabilities(truths: ModelCapabilities[]): ModelCapabilities {
  if (truths.length === 0) return emptyCapabilities();
  let best = truths[0]!;
  let bestMean = domainMean(best);
  for (let i = 1; i < truths.length; i++) {
    const candidate = truths[i]!;
    const mean = domainMean(candidate);
    if (mean > bestMean) {
      best = candidate;
      bestMean = mean;
    }
  }
  return best;
}

const DOMAIN_TO_METRIC: Partial<Record<CapabilityDomain, BenchmarkMetricId>> = {
  language: "mmlu",
  reasoning: "math",
  code: "coding",
  math: "math",
  science: "science",
  vision: "vision",
  tools: "agents",
};

export function capabilitiesToRadarScores(
  caps: ModelCapabilities,
): Partial<Record<BenchmarkMetricId, number>> {
  const scores: Partial<Record<BenchmarkMetricId, number>> = {
    safety: caps.safety,
  };
  for (const domain of CAPABILITY_DOMAINS) {
    const metric = DOMAIN_TO_METRIC[domain];
    if (!metric) continue;
    const value = caps.domains[domain] ?? 0;
    scores[metric] = Math.max(scores[metric] ?? 0, value);
  }
  return scores;
}

const SERVE_BYTES: Record<ServePrecision, number> = {
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8: 1,
  fp6: 0.75,
  int8: 1,
  int4: 0.5,
  nvfp4: 0.5,
  ternary_1_58: 0.2,
};

/** Local serving-resident estimate: paramsB × bytes/param. */
export function estimateHbmGB(paramsB: number, precision: ServePrecision = "bf16"): number {
  return Math.max(0, paramsB) * (SERVE_BYTES[precision] ?? 2);
}

export function estimateMembersHbmGB(
  checkpoints: Checkpoint[],
  precision: ServePrecision = "bf16",
): number {
  let total = 0;
  for (const checkpoint of checkpoints) {
    total += estimateHbmGB(checkpoint.arch.totalParamsB, precision);
  }
  return total;
}

export function primaryCheckpointId(members: EndpointMember[]): string | undefined {
  const primary = members.find((member) => member.role === "primary");
  return primary?.checkpointId ?? members[0]?.checkpointId;
}

export function ensureOnePrimary(members: RouterDraftMember[]): RouterDraftMember[] {
  if (members.length === 0) return members;
  const primaries = members.filter((member) => member.role === "primary");
  if (primaries.length === 1) return members;
  return members.map((member, index) => ({
    ...member,
    role: index === 0 ? "primary" : member.role === "primary" ? "member" : member.role,
  }));
}
