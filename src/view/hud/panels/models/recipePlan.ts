import type { DataDomain, Model } from "../../../../sim/types";
import {
  DATA_DOMAINS,
  normalizeWeights,
} from "../../../../sim/balance/data";
import {
  alignmentDataWeights,
  DEFAULT_POST_TRAIN_SHARE,
  MAX_POST_TRAIN_SHARE,
  MIN_POST_TRAIN_SHARE,
  splitTrainingTokens,
} from "../../../../sim/balance/modelProduct";
import {
  DEFAULT_RECIPE_ALIGN_SHARE,
  clampEnvelopeSplit,
  clampRecipeToUsable,
  defaultRecipeVolumeMTok,
  scaleEnvelope,
  seedRecipeVolumes,
  usableStockByDomain,
} from "../../../../sim/balance/trainingRecipe";

export {
  DEFAULT_RECIPE_ALIGN_SHARE,
  clampEnvelopeSplit,
  clampRecipeToUsable,
  defaultRecipeVolumeMTok,
  scaleEnvelope,
  seedRecipeVolumes,
  usableStockByDomain,
};

export type RecipeZone = "base" | "post" | "synth";

export const RECIPE_ZONE_META: Record<
  RecipeZone,
  { label: string; blurb: string; stroke: string; fill: string }
> = {
  base: {
    label: "Base",
    blurb: "Tokens the run actually trains on",
    stroke: "#00e5c0",
    fill: "rgba(0,229,192,.42)",
  },
  post: {
    label: "Align",
    blurb: "Overflow past base, same pile",
    stroke: "#e040fb",
    fill: "rgba(224,64,251,.38)",
  },
  synth: {
    label: "Synthetic",
    blurb: "Generated tokens past the pile",
    stroke: "#ffab00",
    fill: "rgba(255,171,0,.40)",
  },
};

export const RECIPE_VERIFY_META = {
  label: "Verify",
  blurb: "Holdout from the center of this domain's corpus, not trained",
  stroke: "#42a5f5",
  fill: "rgba(66,165,245,.40)",
};

export function verifyTokens(envelope: number, trainShare: number): number {
  const owned = Math.max(0, envelope);
  const train = Math.max(0.4, Math.min(0.95, trainShare));
  return owned * (1 - train);
}

/** Parse a typed recipe volume. Bare numbers are MTok; K / M / B / T suffixes work. */
export function parseRecipeTokInput(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "").replace(/\s*toks?\s*$/i, "");
  if (!text) return null;
  const match = text.match(/^([0-9]*\.?[0-9]+)\s*([kKmMbBtT])?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "M").toUpperCase();
  if (unit === "K") return amount / 1000;
  if (unit === "B") return amount * 1000;
  if (unit === "T") return amount * 1_000_000;
  return amount;
}

export function formatRecipeTokDraft(mTok: number): string {
  if (!Number.isFinite(mTok) || mTok <= 0) return "0";
  if (mTok >= 1000) {
    const billions = mTok / 1000;
    return `${Number(billions.toFixed(billions >= 10 ? 1 : 2))}B`;
  }
  if (mTok >= 10) return String(Math.round(mTok));
  if (mTok >= 1) return mTok.toFixed(1);
  return `${Math.round(mTok * 1000)}K`;
}

export function allocationsFromMix(
  weights: Partial<Record<DataDomain, number>> | undefined,
  totalMTok: number,
): Record<DataDomain, number> {
  const normalized = normalizeWeights(weights ?? {});
  const total = Math.max(0, totalMTok);
  return Object.fromEntries(
    DATA_DOMAINS.map((domain) => [domain, total * (normalized[domain] ?? 0)]),
  ) as Record<DataDomain, number>;
}

export function mixFromAllocations(
  allocations: Record<DataDomain, number>,
): { weights: Record<DataDomain, number>; totalMTok: number } {
  const totalMTok = DATA_DOMAINS.reduce(
    (sum, domain) => sum + Math.max(0, allocations[domain] ?? 0),
    0,
  );
  return {
    totalMTok,
    weights: normalizeWeights(
      Object.fromEntries(
        DATA_DOMAINS.map((domain) => [
          domain,
          Math.max(0, allocations[domain] ?? 0),
        ]),
      ),
    ),
  };
}

export function postTrainShareFromVolumes(
  baseMTok: number,
  postMTok: number,
): number {
  const total = Math.max(1e-9, Math.max(0, baseMTok) + Math.max(0, postMTok));
  return Math.max(
    MIN_POST_TRAIN_SHARE,
    Math.min(MAX_POST_TRAIN_SHARE, postMTok / total),
  );
}

export interface StackedSpoke {
  base: number;
  post: number;
  synth: number;
  inner: number;
  mid: number;
  outer: number;
}

/** Base, then alignment overflow, then synthetic at the end. */
export function stackedSpoke(
  base: number,
  post: number,
  synth: number,
): StackedSpoke {
  const inner = Math.max(0, base);
  const mid = inner + Math.max(0, post);
  const outer = mid + Math.max(0, synth);
  return {
    base: inner,
    post: Math.max(0, post),
    synth: Math.max(0, synth),
    inner,
    mid,
    outer,
  };
}

export const MIN_RECIPE_ZOOM = 0.4;
export const MAX_RECIPE_ZOOM = 16;
export const TOKEN_RADIUS_FIT = 0.84;

export function clampRecipeZoom(zoom: number): number {
  return Math.max(MIN_RECIPE_ZOOM, Math.min(MAX_RECIPE_ZOOM, zoom));
}

/**
 * Shared log radius so a fat corpus draws a longer spoke than a thin one,
 * without a linear axis crushing small domains. The ceiling is locked by the
 * caller so dragging one handle cannot rescale the whole chart.
 */
export function tokenRadius(mTok: number, ceiling: number, zoom = 1): number {
  const cap = Math.max(1, ceiling);
  const volume = Math.max(0, mTok);
  if (volume <= 0) return 0;
  const unit = Math.log1p(volume) / Math.log1p(cap);
  return Math.min(1.2, unit * TOKEN_RADIUS_FIT * clampRecipeZoom(zoom));
}

export function invertTokenRadius(
  radius: number,
  ceiling: number,
  zoom = 1,
): number {
  const cap = Math.max(1, ceiling);
  const unit = Math.max(0, radius) / (TOKEN_RADIUS_FIT * clampRecipeZoom(zoom));
  if (unit <= 0) return 0;
  return Math.expm1(Math.min(1.35, unit) * Math.log1p(cap));
}

/** Stock-led ceiling. Recipe peaks do not pull this around while dragging. */
export function recipeScaleCeiling(
  usableByDomain: Partial<Record<DataDomain, number>>,
  extraByDomain: Partial<Record<DataDomain, number>> = {},
): number {
  return Math.max(
    1,
    ...DATA_DOMAINS.map(
      (domain) =>
        Math.max(0, usableByDomain[domain] ?? 0) +
        Math.max(0, extraByDomain[domain] ?? 0),
    ),
  );
}

export function focusZoomForVolume(volumeMTok: number, ceiling: number): number {
  const fitted = tokenRadius(Math.max(4, volumeMTok), ceiling, 1);
  if (fitted <= 1e-9) return 1;
  return clampRecipeZoom(0.6 / fitted);
}

/** @deprecated Use tokenRadius + a locked ceiling. */
export function domainSpokeScale(usableMTok: number, zoom = 1): number {
  return Math.max(1, usableMTok) / (0.78 * clampRecipeZoom(zoom));
}

export function focusZoomForDomain(
  usableMTok: number,
  envelopeMTok: number,
): number {
  return focusZoomForVolume(envelopeMTok, Math.max(1, usableMTok));
}

export function recipeAxisMaxMTok(
  outerByDomain: Partial<Record<DataDomain, number>>,
  zoom = 1,
): number {
  const recipeMax = Math.max(
    1,
    ...DATA_DOMAINS.map((domain) => Math.max(0, outerByDomain[domain] ?? 0)),
  );
  return Math.max(1, recipeMax / (0.78 * clampRecipeZoom(zoom)));
}

/** True radii from token volumes. No padding that moves sibling handles. */
export function trueStackRadii(
  inner: number,
  mid: number,
  outer: number,
  scale: number,
  trainShare = 0.82,
): { inner: number; verify: number; owned: number; outer: number } {
  const s = Math.max(1e-9, scale);
  const train = Math.max(0.4, Math.min(0.95, trainShare));
  const owned = Math.max(0, mid) / s;
  const frac = owned > 1e-9 ? Math.max(0, inner) / Math.max(0, mid) : 0;
  return {
    inner: owned * frac,
    verify: owned * (1 - train),
    owned,
    outer: Math.max(0, outer) / s,
  };
}

/**
 * Verify grows from the center as a small fraction of this domain's spoke.
 * Base sits on a linear share of the same spoke so 50% of the data used is
 * halfway out and easy to grab.
 */
export function stackRadiiFromTokens(
  inner: number,
  mid: number,
  outer: number,
  ceiling: number,
  zoom = 1,
  trainShare = 0.82,
): { inner: number; verify: number; owned: number; outer: number } {
  const train = Math.max(0.4, Math.min(0.95, trainShare));
  const owned = Math.max(0, mid);
  const ownedR = tokenRadius(owned, ceiling, zoom);
  const frac = owned > 1e-9 ? Math.max(0, Math.min(1, inner / owned)) : 0;
  return {
    inner: ownedR * frac,
    verify: ownedR * (1 - train),
    owned: ownedR,
    outer: tokenRadius(Math.max(owned, outer), ceiling, zoom),
  };
}

export function volumesFromRecipe(input: {
  weights: Partial<Record<DataDomain, number>>;
  postTrainWeights?: Partial<Record<DataDomain, number>>;
  totalMTok: number;
  postTrainShare?: number;
}): {
  base: Record<DataDomain, number>;
  align: Record<DataDomain, number>;
} {
  const split = splitTrainingTokens(
    input.totalMTok,
    input.postTrainShare ?? DEFAULT_POST_TRAIN_SHARE,
  );
  const postWeights =
    input.postTrainWeights ?? alignmentDataWeights(normalizeWeights(input.weights));
  return {
    base: allocationsFromMix(input.weights, split.baseMTok),
    align: allocationsFromMix(postWeights, split.postTrainMTok),
  };
}

/** Keep stacked handles far enough apart to grab. */
export function spacedStackRadii(
  inner: number,
  mid: number,
  outer: number,
  trainShare = 0.82,
): { inner: number; verify: number; owned: number; outer: number } {
  const train = Math.max(0.4, Math.min(0.95, trainShare));
  const m = Math.max(0.13, Math.min(1.14, mid));
  const i = Math.max(0.08, Math.min(m - 0.05, inner));
  const v = Math.max(0.04, Math.min(i - 0.02, m * (1 - train)));
  const o = Math.max(m + 0.1, Math.min(1.18, outer));
  return { inner: i, verify: v, owned: m, outer: o };
}

export function splitStackedDrag(
  zone: RecipeZone,
  projectedCumulative: number,
  spoke: StackedSpoke,
): number {
  const projected = Math.max(0, projectedCumulative);
  if (zone === "base") return projected;
  if (zone === "post") return Math.max(0, projected);
  return Math.max(0, projected - spoke.mid);
}

/** Generated-token headroom past the owned pile. Zero without expansion. */
export function recipeSynthCapMTok(
  availability: {
    usableMTok: number;
    capMTok: number;
    syntheticHeadroomMTok?: number;
  },
  opts: { syntheticUnlocked: boolean; expansionEnabled: boolean },
): number {
  if (!opts.expansionEnabled) return 0;
  const owned = Math.max(0, availability.usableMTok);
  const pile = owned + Math.max(0, availability.syntheticHeadroomMTok ?? 0);
  return Math.max(0, availability.capMTok - owned, pile * 8 - owned);
}

/**
 * All / Base stay on owned stock unless synthetic expansion is actually
 * available. Past-pile drag is Synthetic (or All overflowing into Synthetic).
 */
export function recipeZoneCapMTok(
  zone: RecipeZone,
  availability: {
    usableMTok: number;
    capMTok: number;
    syntheticHeadroomMTok?: number;
  },
  opts: { syntheticUnlocked: boolean; expansionEnabled: boolean },
): number {
  const owned = Math.max(0, availability.usableMTok);
  const extra = recipeSynthCapMTok(availability, opts);
  if (zone === "synth") return extra;
  if (zone === "post") return owned + extra;
  return owned;
}

export function splitOwnedAndSynth(
  requestedMTok: number,
  usableMTok: number,
): { owned: number; synth: number } {
  const usable = Math.max(0, usableMTok);
  const requested = Math.max(0, requestedMTok);
  if (requested <= usable) return { owned: requested, synth: 0 };
  return { owned: usable, synth: requested - usable };
}

/** Move the base handle inside a fixed data envelope. Alignment takes the rest. */
export function splitEnvelope(
  envelope: number,
  nextBase: number,
): { base: number; align: number } {
  const owned = Math.max(0, envelope);
  const maxBase = owned * (1 - MIN_POST_TRAIN_SHARE);
  const minBase = owned * (1 - MAX_POST_TRAIN_SHARE);
  const base = Math.max(minBase, Math.min(maxBase, nextBase));
  return { base, align: owned - base };
}

export interface RecipePlan {
  id: string;
  name: string;
  weights: Record<DataDomain, number>;
  postTrainWeights: Record<DataDomain, number>;
  postTrainShare: number;
  quality?: number;
  paramsB?: number;
  capability?: number;
  tokensMTok?: number;
}

export function recipePlanFromModel(model: Model): RecipePlan | null {
  const raw = model.dataPlan?.weights;
  if (!raw) return null;
  const weights = normalizeWeights(raw as Record<DataDomain, number>);
  const postRaw = model.dataPlan?.postTrainWeights as
    | Record<DataDomain, number>
    | undefined;
  return {
    id: model.id,
    name: model.name,
    weights,
    postTrainWeights: normalizeWeights(postRaw ?? alignmentDataWeights(weights)),
    postTrainShare:
      model.dataPlan?.postTrainShare ?? DEFAULT_POST_TRAIN_SHARE,
    quality: model.dataQualityUsed,
    paramsB: model.paramsB,
    capability: model.capability,
    tokensMTok:
      model.dataTokensUsedMTok ??
      model.dataPlan?.totalMTok ??
      model.dataPlan?.totalUnits,
  };
}

export function listRecipePlans(models: readonly Model[]): RecipePlan[] {
  const plans: RecipePlan[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const plan = recipePlanFromModel(model);
    if (!plan || seen.has(plan.id)) continue;
    seen.add(plan.id);
    plans.push(plan);
  }
  return plans;
}

export function domainQualityTone(quality: number): "mint" | "amber" | "muted" {
  if (quality >= 70) return "mint";
  if (quality < 45) return "amber";
  return "muted";
}
