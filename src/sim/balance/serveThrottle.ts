import type { ProductPricing, ServeThrottlePolicy } from '../types'
import { planTokenSpeedDissatisfaction } from './tokenSpeed'

/**
 * Overload throttle math — the day-granularity interpretation:
 * capacity is physics (the ledger never serves more PF than exists), so the
 * policy decides what the UNSERVED fraction experienced:
 *
 * - 'shed': errors/timeouts. Full service pain, churn, and demand spillover.
 * - 'throttle': slow streams. Tokens eventually flow, so churn/pain/spillover
 *   are muted — but speedStrain rises and tomorrow's offers are slower
 *   (demand cools through the speed/latency utility terms instead).
 * - 'balanced': the first ~25 points of overload are throttled, the rest shed.
 * - 'surge': same absorb curve as balanced, plus a posted API price hike.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export const DEFAULT_SERVE_SLOWDOWN_LIMIT = 0.25
export const DEFAULT_PEAK_PRICING_PCT = 0

/**
 * Translate the retired policy selector into the two continuous controls.
 * Keeping this in one place makes raw legacy fixtures and normalized saves
 * behave identically while new saves no longer need binary policy semantics.
 */
export function legacyServeControls(policy: ServeThrottlePolicy | undefined): {
  slowdownLimit: number
  peakPricingPct: number
} {
  switch (policy) {
    case 'shed':
      return { slowdownLimit: 0, peakPricingPct: 0 }
    case 'throttle':
      return { slowdownLimit: 1, peakPricingPct: 0 }
    case 'surge':
      return { slowdownLimit: DEFAULT_SERVE_SLOWDOWN_LIMIT, peakPricingPct: 80 }
    case 'balanced':
    default:
      return {
        slowdownLimit: DEFAULT_SERVE_SLOWDOWN_LIMIT,
        peakPricingPct: DEFAULT_PEAK_PRICING_PCT,
      }
  }
}

/** Resolve explicit controls first, then preserve a legacy policy's behavior. */
export function serveControls(pricing: Pick<ProductPricing, 'serveThrottlePolicy' | 'serveSlowdownLimit' | 'peakPricingPct'>): {
  slowdownLimit: number
  peakPricingPct: number
} {
  const legacy = legacyServeControls(pricing.serveThrottlePolicy)
  // A pre-control fixture can be constructed by changing only the legacy
  // policy on a fresh state (whose new fields carry the balanced defaults).
  // Let that explicit legacy selector win in this one unambiguous case.
  const legacySelectorOverridesDefaults =
    pricing.serveThrottlePolicy != null &&
    pricing.serveThrottlePolicy !== 'balanced' &&
    pricing.serveSlowdownLimit === DEFAULT_SERVE_SLOWDOWN_LIMIT &&
    (pricing.peakPricingPct ?? DEFAULT_PEAK_PRICING_PCT) ===
      DEFAULT_PEAK_PRICING_PCT
  if (legacySelectorOverridesDefaults) return legacy
  return {
    slowdownLimit: Number.isFinite(pricing.serveSlowdownLimit)
      ? Math.max(0, Math.min(1, pricing.serveSlowdownLimit!))
      : legacy.slowdownLimit,
    peakPricingPct: Number.isFinite(pricing.peakPricingPct)
      ? Math.max(0, Math.min(100, pricing.peakPricingPct!))
      : legacy.peakPricingPct,
  }
}

/**
 * Share of today's unserved demand that is absorbed as slowness rather than
 * rejected. Balanced absorbs up to 25% overload fully, then sheds the margin.
 */
export function throttleAbsorbShare(
  policy: ServeThrottlePolicy,
  unservedRatio: number,
): number {
  const u = clamp01(unservedRatio)
  if (u <= 1e-9) return 0
  switch (policy) {
    case 'shed':
      return 0
    case 'throttle':
      return 1
    case 'balanced':
    case 'surge':
    default:
      return Math.min(1, 0.25 / u)
  }
}

/**
 * Share of today's unserved work that is slowed before it is shed, using the
 * configured overload headroom. `slowdownLimit` is a fraction of capacity,
 * not a fraction of already-unserved demand. Thus 0.25 reproduces the old
 * balanced behavior around a 25% capacity oversubscription, while 0 sheds
 * immediately and 1 keeps all excess in the slow-stream path.
 */
export function slowdownAbsorbShare(
  unservedRatio: number,
  slowdownLimit: number,
): number {
  const u = clamp01(unservedRatio)
  const limit = clamp01(slowdownLimit)
  if (u <= 1e-9 || limit <= 1e-9) return 0
  // capacity / demand = 1 - unserved; compare the configured headroom to
  // excess demand in the same units before converting to a share of excess.
  return Math.min(1, (limit * Math.max(0, 1 - u)) / u)
}

/** Resolve the configured absorb curve while honoring policy-only legacy fixtures. */
export function configuredAbsorbShare(
  pricing: Pick<ProductPricing, 'serveThrottlePolicy' | 'serveSlowdownLimit' | 'peakPricingPct'>,
  unservedRatio: number,
): number {
  const controls = serveControls(pricing)
  const policy = pricing.serveThrottlePolicy
  const legacyDefaults =
    policy != null &&
    policy !== 'balanced' &&
    pricing.serveSlowdownLimit === DEFAULT_SERVE_SLOWDOWN_LIMIT &&
    (pricing.peakPricingPct ?? DEFAULT_PEAK_PRICING_PCT) ===
      DEFAULT_PEAK_PRICING_PCT
  return legacyDefaults
    ? throttleAbsorbShare(policy, unservedRatio)
    : slowdownAbsorbShare(unservedRatio, controls.slowdownLimit)
}

/** EMA of stream slowness. Rises with absorbed overload, heals with headroom. */
export function nextSpeedStrain(
  prevStrain: number,
  unservedRatio: number,
  absorbShare: number,
): number {
  const s = clamp01(prevStrain)
  const absorbed = clamp01(unservedRatio) * clamp01(absorbShare)
  if (absorbed > 0.02) return Math.min(1, s * 0.7 + absorbed * 0.9)
  return Math.max(0, s * 0.6 - 0.03)
}

/** tokPerSec multiplier from strain: full strain ≈ 40% of normal speed. */
export function strainSpeedFactor(strain: number): number {
  return 1 - 0.6 * clamp01(strain)
}

/** Latency-score multiplier from strain (0–100 latency score space). */
export function strainLatencyFactor(strain: number): number {
  return 1 - 0.35 * clamp01(strain)
}

/**
 * Churn damping while throttling: throttled demand churns at ~35% of the
 * shed rate (their tokens arrived, just slowly).
 */
export function throttleChurnScale(absorbShare: number): number {
  return 1 - 0.65 * clamp01(absorbShare)
}

/**
 * Pain damping while throttling: queueing instead of errors hurts ~quarter
 * as much per unserved token.
 */
export function throttlePainScale(absorbShare: number): number {
  return 1 - 0.75 * clamp01(absorbShare)
}

/**
 * Spillover damping while throttling: most throttled users wait rather than
 * walking to a rival — but ~40% still walk.
 */
export function throttleSpillScale(absorbShare: number): number {
  return 1 - 0.6 * clamp01(absorbShare)
}

/**
 * Peak-pricing EMA. Mirrors stream-strain: rises with unserved load, heals
 * when headroom returns. Only 'surge' policy accumulates; other policies decay.
 */
export function nextSurgeLevel(
  prev: number,
  unservedRatio: number,
  policy: ServeThrottlePolicy = 'balanced',
  peakPricingPct?: number,
  slowdownLimit = DEFAULT_SERVE_SLOWDOWN_LIMIT,
): number {
  const enabled =
    peakPricingPct != null
      ? Math.max(0, peakPricingPct) > 0
      : policy === 'surge'
  if (!enabled) return Math.max(0, clamp01(prev) * 0.6 - 0.03)
  return nextSpeedStrain(
    prev,
    unservedRatio,
    slowdownAbsorbShare(unservedRatio, slowdownLimit),
  )
}

/** Posted API price multiplier with a configurable maximum uplift. */
export function surgePriceMultiplier(level: number, peakPricingPct = 80): number {
  const maxUplift = Math.max(0, Math.min(100, peakPricingPct)) / 100
  return 1 + Math.min(maxUplift, Math.max(0, level) * maxUplift * 2)
}

/**
 * Peak prices are a demand control as well as a revenue control.
 *
 * Modest surge (+10–40%) must reduce volume *less* than the price uplift so
 * API-day revenue rises under overload. A steep term only bites near the
 * +100% cap, where gouging still collapses traffic instead of leaving a
 * misleading full-demand ledger.
 */
export function peakPricingDemandMultiplier(priceMultiplier: number): number {
  const uplift = Math.max(0, Number.isFinite(priceMultiplier) ? priceMultiplier - 1 : 0)
  return Math.max(
    0.005,
    Math.exp(-uplift * 0.35 - Math.pow(uplift, 4) * 5),
  )
}

/** Posted price × remaining volume. >1 means the surge raises API revenue. */
export function peakPricingRevenueFactor(priceMultiplier: number): number {
  return (
    Math.max(0, Number.isFinite(priceMultiplier) ? priceMultiplier : 0) *
    peakPricingDemandMultiplier(priceMultiplier)
  )
}

/** Demand below this is a cold start / idle lab, not an outage. */
export const SERVE_OUTAGE_MIN_DEMAND_MTOK = 0.05
/** Unserved share at which coverage, not just an empty pool, is an outage. */
export const SERVE_OUTAGE_UNSERVED_RATIO = 0.4

/**
 * True when customers are asking and Serve cannot admit them: empty inference
 * pool, or ≥40% of demand unserved. Zero demand (fresh game, no public model)
 * is never an outage.
 */
export function isInferenceOutage(input: {
  capacityPf: number
  unservedRatio: number
  demandMTok: number
}): boolean {
  if (
    !Number.isFinite(input.demandMTok) ||
    input.demandMTok <= SERVE_OUTAGE_MIN_DEMAND_MTOK
  ) {
    return false
  }
  if (!Number.isFinite(input.capacityPf) || input.capacityPf <= 1e-6) return true
  return (
    Number.isFinite(input.unservedRatio) &&
    input.unservedRatio >= SERVE_OUTAGE_UNSERVED_RATIO
  )
}

/** Small gouging-perception brand hit while a posted surge is live. */
export function surgeBrandPressure(multiplier: number): number {
  return Math.max(0, multiplier - 1) * 0.15
}

/**
 * Plan dissatisfaction from slow streams. Strain is overload throttling;
 * optional tokPerSec adds the 30 tok/s knee (free users ~half as sensitive).
 * The two combine smoothly; omitting tokPerSec preserves the strain-only curve.
 */
export function planSlownessDissatisfaction(
  strain: number,
  isFree: boolean,
  tokPerSec?: number,
): number {
  const strainPart = Math.min(0.6, clamp01(strain) * (isFree ? 0.35 : 0.7))
  const speedPart =
    tokPerSec == null ? 0 : planTokenSpeedDissatisfaction(tokPerSec, isFree)
  return Math.min(0.85, 1 - (1 - strainPart) * (1 - speedPart))
}
