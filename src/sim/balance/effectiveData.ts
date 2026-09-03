import type { DataDomain } from "../types";
import { TRAINING_V4 } from "../training/constants";
import type { EffectiveDataBreakdown } from "../training/types";

export interface DomainTokenStock {
  domain: DataDomain;
  rawTokensMTok: number;
  quality: number;
  diversity: number;
  freshness: number;
  provenanceConfidence: number;
  contaminationPenalty: number;
  repetitionPenalty: number;
  syntheticLineagePenalty: number;
}

export const REPEAT_EPOCH_LOG_COEFFICIENT = TRAINING_V4.data.epochLog2Coef;

/** Quality 0 maps to 0.5; quality 1 maps to 1.2 (linear). */
export const QUALITY_WEIGHT_AT_ZERO = 0.5;
export const QUALITY_WEIGHT_AT_ONE = 1.2;

const EPS = 1e-12;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

/** Repeated epochs help, but never count as new unique corpora. */
export function repeatEpochMultiplier(epochs: number): number {
  const n = Math.max(1, epochs);
  return 1 + REPEAT_EPOCH_LOG_COEFFICIENT * Math.log2(n);
}

export function domainEffectiveTokensMTok(stock: DomainTokenStock): number {
  const raw = Math.max(0, stock.rawTokensMTok);
  return (
    raw *
    clamp01(stock.quality) *
    clamp01(stock.diversity) *
    clamp01(stock.freshness) *
    clamp01(stock.provenanceConfidence) *
    clamp01(stock.contaminationPenalty) *
    clamp01(stock.repetitionPenalty) *
    clamp01(stock.syntheticLineagePenalty)
  );
}

export function totalEffectiveTokensMTok(
  stocks: readonly DomainTokenStock[],
): number {
  return stocks.reduce((sum, stock) => sum + domainEffectiveTokensMTok(stock), 0);
}

export function effectiveTokensFromEpochs(input: {
  uniqueMTok: number;
  epochs: number;
  quality?: number;
  diversity?: number;
  freshness?: number;
  provenanceConfidence?: number;
  contaminationPenalty?: number;
  syntheticLineagePenalty?: number;
}): number {
  const unique = Math.max(0, input.uniqueMTok);
  return (
    unique *
    repeatEpochMultiplier(input.epochs) *
    clamp01(input.quality ?? 1) *
    clamp01(input.diversity ?? 1) *
    clamp01(input.freshness ?? 1) *
    clamp01(input.provenanceConfidence ?? 1) *
    clamp01(input.contaminationPenalty ?? 1) *
    clamp01(input.syntheticLineagePenalty ?? 1)
  );
}

export function syntheticLineagePenalty(
  generationDepth: number,
  verified: boolean,
): number {
  const depth = Math.max(0, generationDepth);
  const unverifiedDecay = verified ? 0.04 : 0.16;
  return Math.max(0.12, 1 - depth * unverifiedDecay);
}

/** Linear map: quality 0 → 0.5, quality 1 → 1.2. */
export function qualityWeightFromQuality(quality01: number): number {
  const q = clamp01(quality01);
  return QUALITY_WEIGHT_AT_ZERO + (QUALITY_WEIGHT_AT_ONE - QUALITY_WEIGHT_AT_ZERO) * q;
}

/**
 * V4 synthetic discount.
 * clamp(1 − share · (0.35 · (1 − verifiedShare · verifierStrength) + 0.08 · (depth − 1)), 0.4, 1)
 * then × syntheticQuality, capped so the result never exceeds 1.
 */
export function syntheticDiscountFor(input: {
  syntheticShare: number;
  verifiedShare: number;
  depth: number;
  verifierStrength: number;
  syntheticQuality: number;
}): number {
  const share = clamp01(input.syntheticShare);
  const verified = clamp01(input.verifiedShare);
  const depth = share > 0 ? Math.max(1, input.depth) : 1;
  const inner =
    0.35 * (1 - verified * clamp01(input.verifierStrength)) + 0.08 * (depth - 1);
  const base = clamp(1 - share * inner, 0.4, 1);
  const quality = Number.isFinite(input.syntheticQuality)
    ? Math.max(0, input.syntheticQuality)
    : 1;
  return Math.min(1, base * quality);
}

/** Herfindahl mix: 0.8 + 0.2 · (1 − Σ share²) over raw-token shares. */
export function diversityFromRawShares(shares: readonly number[]): number {
  let hhi = 0;
  for (const share of shares) {
    if (!(share > 0)) continue;
    hhi += share * share;
  }
  return 0.8 + 0.2 * (1 - hhi);
}

export interface EffectiveDataDomainInput {
  domain: DataDomain;
  rawMTok: number;
  uniqueAvailableMTok: number;
  quality: number;
  syntheticShare: number;
  syntheticDepth: number;
  verifiedShare: number;
}

export function emptyEffectiveDataBreakdown(): EffectiveDataBreakdown {
  return {
    rawMTok: 0,
    uniqueMTok: 0,
    effectiveMTok: 0,
    qualityWeight: 0,
    diversity: 0,
    epochs: 0,
    epochFactor: 0,
    syntheticShare: 0,
    syntheticDiscount: 0,
    domainMix: {},
    perDomain: {},
  };
}

/**
 * V4 D_eff core: unique · epochFactor · qualityWeight · syntheticDiscount per
 * domain, then × diversity, then MoE divides by dataRequirementMult.
 */
export function computeEffectiveDataBreakdown(input: {
  domains: readonly EffectiveDataDomainInput[];
  moe: boolean;
  verifierStrength: number;
  syntheticQuality: number;
}): EffectiveDataBreakdown {
  const requested = input.domains.filter((row) => row.rawMTok > 0);
  const totalRaw = requested.reduce((sum, row) => sum + Math.max(0, row.rawMTok), 0);
  if (!(totalRaw > 0) || requested.length === 0) {
    return emptyEffectiveDataBreakdown();
  }

  const domainMix: Partial<Record<DataDomain, number>> = {};
  const perDomain: EffectiveDataBreakdown["perDomain"] = {};
  let uniqueSum = 0;
  let domainEffectiveSum = 0;
  let qualityWeightAcc = 0;
  let syntheticShareAcc = 0;
  let discountAcc = 0;
  let synthWeight = 0;

  for (const row of requested) {
    const raw = Math.max(0, row.rawMTok);
    const unique = Math.min(raw, Math.max(0, row.uniqueAvailableMTok));
    const epochs = Math.max(1, raw / Math.max(unique, EPS));
    const epochFactor = repeatEpochMultiplier(epochs);
    const qualityWeight = qualityWeightFromQuality(row.quality);
    const syntheticDiscount = syntheticDiscountFor({
      syntheticShare: row.syntheticShare,
      verifiedShare: row.verifiedShare,
      depth: row.syntheticDepth,
      verifierStrength: input.verifierStrength,
      syntheticQuality: input.syntheticQuality,
    });
    const domainEffective = unique * epochFactor * qualityWeight * syntheticDiscount;
    const share = raw / totalRaw;
    domainMix[row.domain] = share;
    perDomain[row.domain] = {
      rawMTok: raw,
      effectiveMTok: domainEffective,
      quality: clamp01(row.quality),
      syntheticShare: clamp01(row.syntheticShare),
    };
    uniqueSum += unique;
    domainEffectiveSum += domainEffective;
    qualityWeightAcc += qualityWeight * raw;
    syntheticShareAcc += clamp01(row.syntheticShare) * unique;
    discountAcc += syntheticDiscount * raw;
    synthWeight += unique;
  }

  const diversity = diversityFromRawShares(
    requested.map((row) => (domainMix[row.domain] ?? 0)),
  );
  const epochs = Math.max(1, totalRaw / Math.max(uniqueSum, EPS));
  const epochFactor = repeatEpochMultiplier(epochs);
  let effectiveMTok = domainEffectiveSum * diversity;
  if (input.moe) {
    effectiveMTok /= TRAINING_V4.moe.dataRequirementMult;
  }
  if (!Number.isFinite(effectiveMTok)) effectiveMTok = 0;

  return {
    rawMTok: totalRaw,
    uniqueMTok: uniqueSum,
    effectiveMTok,
    qualityWeight: qualityWeightAcc / totalRaw,
    diversity,
    epochs,
    epochFactor,
    syntheticShare: synthWeight > 0 ? syntheticShareAcc / synthWeight : 0,
    syntheticDiscount: discountAcc / totalRaw,
    domainMix,
    perDomain,
  };
}
