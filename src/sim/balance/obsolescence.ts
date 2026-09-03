/**
 * Scale-free obsolescence doctrine.
 *
 * Demand relevance is a function of *relative* distance to the frontier, never
 * absolute capability-point gaps and never additive or residual floors. Every
 * curve below is asymptotic: it approaches zero as the gap (or age) grows, and
 * only touches zero at a true zero (zero capability, infinite price). The
 * single epsilon bound (1e-6) is a numeric guard for softmax/log stability,
 * not an economic floor — 1e-6 of share is zero for gameplay.
 *
 * Why relative: an absolute "32 points behind is obsolete" rule means
 * different things at frontier 60 vs frontier 500. A 450-capability model
 * facing a 500 frontier is near-SOTA and should earn real demand; a 30-cap
 * model facing an 80 frontier is a budget niche that earns a decaying share
 * while young and ~nothing once aged. Relative gaps give both procedurally,
 * so the same functions scale to massive models without retuning.
 *
 * Age flows through capability, not a second discount: offers carry
 * age-penalized capability (see modelAging), so an aged model slides down
 * these same curves automatically. No curve here takes age directly, which
 * keeps one decay path instead of two double-counting each other.
 */

export const OBSOLESCENCE_EPSILON = 1e-6;

/** Clamp to [0, 1]; non-finite input maps to 0 (dead offer, never NaN). */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Scale-free SOTA proximity in [0, 1]. 1 at or above the frontier, decaying
 * linearly with the *relative* gap: 1 - (frontier - capability) / frontier.
 * A model at half the frontier scores 0.5 whether the frontier is 60 or 600.
 */
export function relativeSota(capability: number, frontier: number): number {
  const f = Math.max(OBSOLESCENCE_EPSILON, frontier);
  if (!Number.isFinite(capability) || capability <= 0) return 0;
  return clamp01(1 - (f - capability) / f);
}

/**
 * Per-segment competitive hardness: how fast demand decays with relative gap.
 * Enterprise-grade segments are winner-take-all; hobby/indie tolerate laggards
 * (budget niche). Values are dimensionless exponents, not point scales, so
 * they hold at any frontier magnitude.
 */
export function obsolescenceHardness(segmentId: string): number {
  switch (segmentId) {
    case "enterprise":
    case "legal":
    case "healthcare":
    case "science":
      return 3.0;
    case "startup_api":
      return 2.2;
    case "creative":
      return 1.9;
    case "consumer":
      return 1.8;
    case "indie_api":
      return 1.5;
    case "hobby":
    default:
      return 1.2;
  }
}

/**
 * Relative decay scale per segment: the relative gap that costs ~63% of
 * competitiveness (1/e). Calibrated so at frontier ~60 it reproduces the
 * legacy absolute scales (8–14 pts) and then scales proportionally forever.
 */
function relativeScale(segmentId: string): number {
  switch (segmentId) {
    case "science":
      return 8 / 60;
    case "startup_api":
      return 9 / 60;
    case "creative":
      return 10 / 60;
    case "indie_api":
      return 12 / 60;
    default:
      return 14 / 60;
  }
}

/**
 * Floor-free quality competitiveness in (0, 1]. Relative exponential decay
 * off the quality frontier multiplied by an absolute viability sigmoid around
 * the segment quality floor. Young weak-but-viable models keep a real
 * fraction; far-lagging or below-floor models decay toward epsilon, never to
 * a residual trickle and never clipped by one.
 */
export function obsolescenceDiscount(input: {
  quality: number;
  frontierQuality: number;
  qualityFloor: number;
  segmentId: string;
}): number {
  const quality = Number.isFinite(input.quality) ? Math.max(0, input.quality) : 0;
  const frontier = Math.max(quality, input.frontierQuality);
  const gap = Math.max(0, frontier - quality);
  const scale = Math.max(
    OBSOLESCENCE_EPSILON,
    relativeScale(input.segmentId) * Math.max(OBSOLESCENCE_EPSILON, frontier),
  );
  const relative = Math.exp(-gap / scale);
  // Viability sigmoid: ~1 above the floor, →0 far below. Width scales with
  // the floor so the sharpness is proportional at any quality magnitude.
  const floor = Math.max(OBSOLESCENCE_EPSILON, input.qualityFloor);
  const width = Math.max(3, floor * 0.25);
  const absolute = 1 / (1 + Math.exp(-(quality - floor) / width));
  return Math.max(
    OBSOLESCENCE_EPSILON,
    Math.min(1, relative * absolute),
  );
}

/**
 * Token/engagement intensity through the origin: zero SOTA proximity means
 * zero intensity, no additive baseline. Gain preserves the legacy top-end
 * (~5.2x enterprise, ~2.3x hobby at co-SOTA) so frontier behavior is
 * unchanged; everything below decays procedurally with segment hardness.
 */
export function obsolescenceUsage(sota: number, segmentId: string): number {
  const s = clamp01(sota);
  if (s <= 0) return 0;
  const hardness = obsolescenceHardness(segmentId);
  switch (segmentId) {
    case "enterprise":
    case "legal":
    case "healthcare":
    case "science":
      return 5.15 * Math.pow(s, hardness * 0.55);
    case "startup_api":
      return 4.42 * Math.pow(s, hardness * 0.6);
    case "consumer":
      return 3.4 * Math.pow(s, hardness * 0.7);
    case "creative":
      return 3.35 * Math.pow(s, hardness * 0.68);
    case "indie_api":
      return 3.1 * Math.pow(s, hardness * 0.8);
    case "hobby":
    default:
      return 2.25 * Math.pow(s, hardness * 0.9);
  }
}
