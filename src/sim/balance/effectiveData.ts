import type { DataDomain } from "../types";

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

export const REPEAT_EPOCH_LOG_COEFFICIENT = 0.55;

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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
