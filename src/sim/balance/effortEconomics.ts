import type { BenchmarkScores, EffortRecipe, Model } from "../types";
import {
  applyEffortLiftFromRecipe,
  defaultEffortIdOf,
  effortRequestMultipliers,
  servedRecipes,
} from "./modelProduct";
import type { CommercialModelKind } from "./pricing";
import {
  billableTextMTok,
  nativeWorkFromEquivalentMTok,
  nativeWorkFromEquivalentMTokAtEffort,
} from "./workload";

const TEXT_KINDS: readonly CommercialModelKind[] = [
  "language",
  "coding",
  "reasoning",
  "omni",
];

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function normalizedShares(
  recipes: readonly EffortRecipe[],
  defaultId: string,
): Record<string, number> {
  if (recipes.length === 0) return {};
  if (recipes.length === 1) return { [recipes[0]!.id]: 1 };
  const fallback = recipes.some((recipe) => recipe.id === defaultId)
    ? defaultId
    : recipes[0]!.id;
  const shares: Record<string, number> = { [fallback]: 0.55 };
  const each = 0.45 / Math.max(1, recipes.length - 1);
  for (const recipe of recipes) {
    if (recipe.id !== fallback) shares[recipe.id] = each;
  }
  return shares;
}

function textTaskPriceMultiplier(input: {
  kind: CommercialModelKind;
  generatedTokenMultiplier: number;
  priceIn: number;
  priceOut: number;
}): number {
  if (!TEXT_KINDS.includes(input.kind)) return 1;
  const base = billableTextMTok(
    nativeWorkFromEquivalentMTok(input.kind, 1),
  );
  const effort = billableTextMTok(
    nativeWorkFromEquivalentMTokAtEffort(
      input.kind,
      1,
      input.generatedTokenMultiplier,
    ),
  );
  const priceIn = Math.max(0, input.priceIn);
  const priceOut = Math.max(0, input.priceOut);
  const baseCost = base.inputMTok * priceIn + base.outputMTok * priceOut;
  const effortCost = effort.inputMTok * priceIn + effort.outputMTok * priceOut;
  return baseCost > 1e-12
    ? Math.max(1, effortCost / baseCost)
    : Math.max(1, effort.totalMTok / Math.max(1e-12, base.totalMTok));
}

export interface ApiEffortChoice {
  shares: Record<string, number>;
  realizedCapability: number;
  realizedBenchmarks: BenchmarkScores;
  /** Generated and hidden-reasoning tokens relative to Instant. */
  generatedTokenMultiplier: number;
  /** Total prompt + generated billable tokens relative to Instant. */
  billedTokenMultiplier: number;
  /** Physical serving work relative to one Instant-equivalent task. */
  computeTokenMultiplier: number;
  /** Dollar cost/task relative to Instant at the same in/out list prices. */
  effectiveTaskPriceMultiplier: number;
  /** Customers pushed away from desired thinking levels by task price. */
  fallbackShare: number;
  complaintPressure: number;
}

export interface PlanEffortMix {
  shares: Record<string, number>;
  generatedTokenMultiplier: number;
  billedTokenMultiplier: number;
  computeTokenMultiplier: number;
}

/**
 * Subscription users can select any served recipe, but a seat does not become
 * unbounded just because per-token price sensitivity is absent. The configured
 * default receives 55% of request traffic and the remainder is shared across
 * the other served recipes; market settlement caps the expanded tokens at the
 * plan allowance.
 */
export function planEffortMix(input: {
  model: Pick<Model, "productProfile">;
  kind: CommercialModelKind;
  /** Plan-filtered recipes; omit to use every globally served recipe. */
  recipes?: readonly EffortRecipe[];
  /** Preferred recipe within the plan-filtered set. */
  defaultId?: string;
}): PlanEffortMix {
  const instant: PlanEffortMix = {
    shares: { instant: 1 },
    generatedTokenMultiplier: 1,
    billedTokenMultiplier: 1,
    computeTokenMultiplier: 1,
  };
  const profile = input.model.productProfile;
  if (!profile || !TEXT_KINDS.includes(input.kind)) return instant;
  const recipes = input.recipes ?? servedRecipes(profile);
  if (recipes.length === 0) return instant;
  const shares = normalizedShares(
    recipes,
    input.defaultId ?? defaultEffortIdOf(profile),
  );
  const baseBillable = billableTextMTok(
    nativeWorkFromEquivalentMTok(input.kind, 1),
  );
  const outputTokenShare =
    baseBillable.outputMTok / Math.max(1e-12, baseBillable.totalMTok);
  const economics = recipes.map((recipe) => ({
    recipe,
    request: effortRequestMultipliers(
      recipe,
      profile.tokenEfficiency,
      outputTokenShare,
    ),
  }));
  const blend = (
    pick: (request: ReturnType<typeof effortRequestMultipliers>) => number,
  ) =>
    economics.reduce(
      (sum, item) =>
        sum + (shares[item.recipe.id] ?? 0) * pick(item.request),
      0,
    );
  return {
    shares,
    generatedTokenMultiplier: blend(
      (request) => request.generatedTokenMultiplier,
    ),
    billedTokenMultiplier: blend((request) => request.billedTokenMultiplier),
    computeTokenMultiplier: blend(
      (request) => request.computeTokenMultiplier,
    ),
  };
}

/**
 * Resolve one deterministic API effort mix before provider choice and reuse it
 * for quality, tokens, compute, billing, and customer pressure.
 */
export function apiEffortChoice(input: {
  model: Pick<Model, "capability" | "benchmarks" | "productProfile">;
  kind: CommercialModelKind;
  ratioToPeer: number;
  priceElasticity: number;
  priceIn?: number;
  priceOut?: number;
  baseCapability?: number;
  baseBenchmarks?: BenchmarkScores;
}): ApiEffortChoice {
  const baseCapability = Math.max(
    0,
    input.baseCapability ?? input.model.capability,
  );
  const baseBenchmarks = {
    ...input.model.benchmarks,
    ...(input.baseBenchmarks ?? {}),
  };
  const instant: ApiEffortChoice = {
    shares: { instant: 1 },
    realizedCapability: baseCapability,
    realizedBenchmarks: baseBenchmarks,
    generatedTokenMultiplier: 1,
    billedTokenMultiplier: 1,
    computeTokenMultiplier: 1,
    effectiveTaskPriceMultiplier: 1,
    fallbackShare: 0,
    complaintPressure: 0,
  };
  const profile = input.model.productProfile;
  if (!profile || !TEXT_KINDS.includes(input.kind)) return instant;

  const recipes = servedRecipes(profile);
  if (recipes.length === 0) return instant;
  const intended = normalizedShares(recipes, defaultEffortIdOf(profile));
  const priceIn = Math.max(0, input.priceIn ?? 1);
  const priceOut = Math.max(0, input.priceOut ?? priceIn);
  const baseBillable = billableTextMTok(
    nativeWorkFromEquivalentMTok(input.kind, 1),
  );
  const outputTokenShare =
    baseBillable.outputMTok / Math.max(1e-12, baseBillable.totalMTok);
  const ratioToPeer = Math.max(
    0.05,
    Number.isFinite(input.ratioToPeer) ? input.ratioToPeer : 1,
  );
  const elasticity = Math.max(
    0,
    Number.isFinite(input.priceElasticity) ? input.priceElasticity : 0,
  );

  const views = recipes.map((recipe) => {
    const lifted = applyEffortLiftFromRecipe(
      baseCapability,
      baseBenchmarks,
      recipe,
    );
    const economics = effortRequestMultipliers(
      recipe,
      profile.tokenEfficiency,
      outputTokenShare,
    );
    const taskPriceMultiplier = textTaskPriceMultiplier({
      kind: input.kind,
      generatedTokenMultiplier: economics.generatedTokenMultiplier,
      priceIn,
      priceOut,
    });
    const capabilityGain = Math.max(0, lifted.capability - baseCapability);
    // Customers value quality, but task price dominates at extreme budgets.
    const benefitPreference = 1 + Math.min(1.4, capabilityGain / 18);
    const priceBurden = Math.max(1, taskPriceMultiplier * ratioToPeer);
    const rawWeight =
      (intended[recipe.id] ?? 0) *
      benefitPreference /
      Math.pow(priceBurden, elasticity * 0.9);
    return {
      recipe,
      lifted,
      economics,
      taskPriceMultiplier,
      rawWeight,
    };
  });
  const weightTotal = views.reduce((sum, view) => sum + view.rawWeight, 0);
  if (weightTotal <= 1e-12) return instant;
  const shares: Record<string, number> = {};
  for (const view of views) {
    shares[view.recipe.id] = view.rawWeight / weightTotal;
  }

  const generatedTokenMultiplier = views.reduce(
    (sum, view) =>
      sum +
      (shares[view.recipe.id] ?? 0) *
        view.economics.generatedTokenMultiplier,
    0,
  );
  const effectiveTaskPriceMultiplier = textTaskPriceMultiplier({
    kind: input.kind,
    generatedTokenMultiplier,
    priceIn,
    priceOut,
  });
  const effortBillable = billableTextMTok(
    nativeWorkFromEquivalentMTokAtEffort(
      input.kind,
      1,
      generatedTokenMultiplier,
    ),
  );
  const billedTokenMultiplier =
    effortBillable.totalMTok / Math.max(1e-12, baseBillable.totalMTok);
  const computeTokenMultiplier = views.reduce(
    (sum, view) =>
      sum +
      (shares[view.recipe.id] ?? 0) * view.economics.computeTokenMultiplier,
    0,
  );

  const benchmarkKeys = Object.keys(baseBenchmarks) as (keyof BenchmarkScores)[];
  const realizedBenchmarks = { ...baseBenchmarks };
  for (const key of benchmarkKeys) {
    realizedBenchmarks[key] = views.reduce(
      (sum, view) =>
        sum +
        (shares[view.recipe.id] ?? 0) *
          (view.lifted.benchmarks[key] ?? baseBenchmarks[key]),
      0,
    );
  }
  const realizedCapability = views.reduce(
    (sum, view) =>
      sum + (shares[view.recipe.id] ?? 0) * view.lifted.capability,
    0,
  );
  const intendedThinkingShare = views.reduce(
    (sum, view) =>
      sum +
      (view.recipe.kind === "instant" ? 0 : intended[view.recipe.id] ?? 0),
    0,
  );
  const realizedThinkingShare = views.reduce(
    (sum, view) =>
      sum +
      (view.recipe.kind === "instant" ? 0 : shares[view.recipe.id] ?? 0),
    0,
  );
  const fallbackShare = Math.max(
    0,
    intendedThinkingShare - realizedThinkingShare,
  );
  const usedPremiumPain =
    realizedThinkingShare *
    Math.max(0, Math.log(Math.max(1, effectiveTaskPriceMultiplier * ratioToPeer)));
  const complaintPressure = clampUnit(
    fallbackShare * 0.85 + usedPremiumPain * 0.13,
  );

  return {
    shares,
    realizedCapability,
    realizedBenchmarks,
    generatedTokenMultiplier,
    billedTokenMultiplier,
    computeTokenMultiplier: Math.max(1, computeTokenMultiplier),
    effectiveTaskPriceMultiplier,
    fallbackShare,
    complaintPressure,
  };
}

/** Resolve effort independently for every concrete member behind a router. */
export function routedApiEffortChoices<T extends {
  model: Pick<Model, "capability" | "benchmarks" | "productProfile">;
  kind: CommercialModelKind;
  priceIn: number;
  priceOut: number;
}>(input: {
  members: readonly T[];
  ratioToPeer: number;
  priceElasticity: number;
}): Array<T & { effort: ApiEffortChoice }> {
  return input.members.map((member) => ({
    ...member,
    effort: apiEffortChoice({
      model: member.model,
      kind: member.kind,
      ratioToPeer: input.ratioToPeer,
      priceElasticity: input.priceElasticity,
      priceIn: member.priceIn,
      priceOut: member.priceOut,
    }),
  }));
}
