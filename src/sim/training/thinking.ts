import { TRAINING_V4 } from "./constants";
import type { Checkpoint, ThinkingTier, TierBudget } from "./types";

export const TIER_BUDGETS: readonly TierBudget[] = TRAINING_V4.postTrain.tierBudgets;

const TIER_NAME: Record<TierBudget, string> = {
  1: "Instant",
  2: "Low",
  4: "Medium",
  8: "High",
  12: "xHigh",
  20: "Max",
  100: "Ultra",
};

export const THINKING_UNLOCK_REASON =
  "Needs Thinking-Tier RL and a reasoning post-train";

export const THINKING_UNTRAINED_REASON =
  "Not trained — a reasoning post-train at this budget costs extra compute";

export function isTierBudget(value: number): value is TierBudget {
  return (TIER_BUDGETS as readonly number[]).includes(value);
}

/** Snap legacy Think ×3 (and any stray number) onto the current ladder. */
export function canonicalizeTierBudget(raw: number): TierBudget {
  if (isTierBudget(raw)) return raw;
  if (raw === 3) return 2;
  let best: TierBudget = 1;
  let dist = Number.POSITIVE_INFINITY;
  for (const budget of TIER_BUDGETS) {
    const gap = Math.abs(budget - raw);
    if (gap < dist) {
      dist = gap;
      best = budget;
    }
  }
  return best;
}

/** Serve-time thinking budget: Instant ×1, Low ×2, … Ultra ×100. */
export function tierLabel(budget: number): string {
  const canonical = Number.isFinite(budget) ? canonicalizeTierBudget(budget) : 1;
  return `${TIER_NAME[canonical]} ×${canonical}`;
}

/** Instant only — higher rungs are trained one budget at a time. */
export function defaultTiers(): ThinkingTier[] {
  return [{ budget: 1, served: true }];
}

/** Legal ladder after Thinking-Tier RL. Does not mean every rung is trained. */
export function unlockedThinkingTiers(): ThinkingTier[] {
  return TIER_BUDGETS.map((budget) => ({
    budget,
    served: budget === 1,
  }));
}

export function thinkingUnlocked(checkpoint: Pick<Checkpoint, "tiers">, budget: TierBudget): boolean {
  if (budget === 1) return true;
  return checkpoint.tiers.some((tier) => canonicalizeTierBudget(tier.budget) === budget);
}

/** Budgets actually present on the checkpoint, Instant always included. */
export function trainedThinkingBudgets(checkpoint: Pick<Checkpoint, "tiers">): TierBudget[] {
  const present = new Set<TierBudget>([1]);
  for (const row of checkpoint.tiers) {
    present.add(canonicalizeTierBudget(row.budget));
  }
  return TIER_BUDGETS.filter((budget) => present.has(budget));
}

/**
 * Extra heads this recipe will train (not already on the checkpoint).
 * Instant is never extra — it ships with every checkpoint.
 */
export function extraThinkingBudgetsToTrain(
  checkpoint: Pick<Checkpoint, "tiers">,
  requested: readonly number[] | undefined,
): TierBudget[] {
  if (!requested?.length) return [];
  const seen = new Set<TierBudget>();
  const extras: TierBudget[] = [];
  for (const raw of requested) {
    if (!Number.isFinite(raw)) continue;
    const budget = canonicalizeTierBudget(raw);
    if (budget <= 1 || seen.has(budget) || thinkingUnlocked(checkpoint, budget)) continue;
    seen.add(budget);
    extras.push(budget);
  }
  return extras;
}

/** Union Instant + source heads + newly requested budgets. New heads stay unserved. */
export function mergeTrainedTiers(
  source: readonly ThinkingTier[],
  addBudgets: readonly number[] | undefined,
): ThinkingTier[] {
  const served = new Map<TierBudget, boolean>();
  served.set(1, true);
  for (const row of source) {
    const budget = canonicalizeTierBudget(row.budget);
    served.set(budget, Boolean(served.get(budget)) || row.served);
  }
  for (const raw of addBudgets ?? []) {
    if (!Number.isFinite(raw)) continue;
    const budget = canonicalizeTierBudget(raw);
    if (!served.has(budget)) served.set(budget, budget === 1);
  }
  return TIER_BUDGETS.filter((budget) => served.has(budget)).map((budget) => ({
    budget,
    served: budget === 1 ? served.get(1) !== false : Boolean(served.get(budget)),
  }));
}

export function thinkingLockReason(
  checkpoint: Pick<Checkpoint, "tiers">,
  budget: TierBudget,
  canTrain: boolean,
): string | null {
  if (thinkingUnlocked(checkpoint, budget)) return null;
  return canTrain ? THINKING_UNTRAINED_REASON : THINKING_UNLOCK_REASON;
}

/**
 * Old saves listed every rung even before unlock. Collapse back to Instant
 * unless reasoning ran or a non-Instant head is already served. After that,
 * keep listed rungs only — do not invent untrained heads.
 */
export function normalizeThinkingTiers(
  tiers: unknown,
  postTrain?: { stages?: { reasoning?: { effect?: number; runs?: number } } },
): ThinkingTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) return defaultTiers();
  const served = new Map<TierBudget, boolean>();
  let extraServed = false;
  for (const row of tiers) {
    if (!row || typeof row !== "object") continue;
    const raw = row as { budget?: unknown; served?: unknown };
    if (!Number.isFinite(Number(raw.budget))) continue;
    const budget = canonicalizeTierBudget(Number(raw.budget));
    const isServed = Boolean(raw.served);
    served.set(budget, Boolean(served.get(budget)) || isServed);
    extraServed = extraServed || (isServed && budget > 1);
  }
  const reasoning = postTrain?.stages?.reasoning;
  const hasReasoning =
    extraServed ||
    (reasoning?.runs ?? 0) > 0 ||
    (reasoning?.effect ?? 0) > 0;
  if (!hasReasoning) {
    return [{ budget: 1, served: served.get(1) !== false }];
  }
  return mergeTrainedTiers(
    TIER_BUDGETS.filter((budget) => served.has(budget)).map((budget) => ({
      budget,
      served: budget === 1 ? served.get(1) !== false : Boolean(served.get(budget)),
    })),
    [],
  );
}

export function maxServedTierBudget(tiers: readonly ThinkingTier[]): TierBudget {
  let max: TierBudget = 1;
  for (const tier of tiers) {
    if (!tier.served) continue;
    const budget = canonicalizeTierBudget(tier.budget);
    if (budget > max) max = budget;
  }
  return max;
}

/** Token / hosting-cost multiplier for a thinking budget. Instant is 1. */
export function thinkingCostMult(budget: number): number {
  return Math.max(1, canonicalizeTierBudget(budget));
}

/**
 * Train-time extra PF for new reasoning heads. Serve cost is linear in budget;
 * train cost uses √budget so Ultra is ~10× the reasoning stage, not 100×.
 */
export function thinkingTrainPfMult(budgets: readonly number[]): number {
  const seen = new Set<TierBudget>();
  let extra = 0;
  for (const raw of budgets) {
    if (!Number.isFinite(raw)) continue;
    const budget = canonicalizeTierBudget(raw);
    if (budget <= 1 || seen.has(budget)) continue;
    seen.add(budget);
    extra += Math.sqrt(thinkingCostMult(budget)) - 1;
  }
  return 1 + extra;
}

/**
 * Hosting PF and opex scale with the peak served budget: offering Ultra means
 * provisioning for 100× tokens even if Instant is also on.
 */
export function servedThinkingCostMult(tiers: readonly ThinkingTier[]): number {
  return thinkingCostMult(maxServedTierBudget(tiers));
}

/** Wall-clock serve slowdown: sqrt of the token budget so Ultra is 10×, not 100×. */
export function servedThinkingLatencyMult(tiers: readonly ThinkingTier[]): number {
  return Math.sqrt(servedThinkingCostMult(tiers));
}

export function scaleEvalCost(
  base: { cash: number; days: number; sigma: number },
  tierBudget: number = 1,
): { cash: number; days: number; sigma: number } {
  const scale = thinkingCostMult(tierBudget);
  return {
    cash: Math.round(base.cash * scale),
    days: Math.max(base.days, Math.ceil(base.days * Math.sqrt(scale))),
    sigma: base.sigma,
  };
}
