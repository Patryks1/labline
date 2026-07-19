import { ECONOMY, SEGMENTS } from '../balance/economy'
import { segmentBenchmarkFit } from '../balance/benchmarks'
import type { MarketOffer, SegmentId } from '../types'

export interface OfferFactorScores {
  intelligence: number
  price: number
  speed: number
  tooling: number
  trust: number
  safety: number
  /** List price divided by estimated successful-task rate. */
  effectivePrice: number
  /** 0 = far behind frontier, 1 = co-SOTA / frontier */
  sota: number
}

export interface OfferUtilityOpts {
  /** Best capability among public offers this tick (frontier). */
  frontier?: number
}

/** How close capability is to the public frontier (0–1). */
export function sotaProximity(capability: number, frontier: number): number {
  const f = Math.max(18, frontier)
  const gap = Math.max(0, f - capability)
  // Softer curve: #2–4 still count as "in market" (gap 12 → ~0.62, gap 20 → ~0.38)
  return Math.max(0, Math.min(1, 1 - gap / 32))
}

/**
 * Token / engagement intensity from SOTA proximity.
 * SOTA → super high API & sub usage; lagging models stay light even with share.
 */
export function sotaUsageMultiplier(sota: number, segmentId: SegmentId): number {
  const s = Math.max(0, Math.min(1, sota))
  // Floors keep mid-pack (#3–4) generating real traffic, not near-zero
  switch (segmentId) {
    case 'enterprise':
    case 'legal':
    case 'healthcare':
    case 'science':
      // Enterprise piles onto frontier: ~0.55× lagging → ~5.2× co-SOTA
      return 0.55 + Math.pow(s, 1.55) * 4.6
    case 'startup_api':
      return 0.62 + Math.pow(s, 1.35) * 3.8
    case 'indie_api':
      return 0.7 + Math.pow(s, 1.2) * 2.4
    case 'creative':
      return 0.65 + Math.pow(s, 1.3) * 2.7
    case 'consumer':
      return 0.6 + Math.pow(s, 1.3) * 2.8
    case 'hobby':
    default:
      // Free tier: SOTA still busier, but #3–4 keep a pulse
      return 0.65 + Math.pow(s, 1.1) * 1.6
  }
}

/** Softmax temperature — mixed enough that near-SOTA + cheap still gets users. */
export function segmentSoftmaxTemp(segmentId: SegmentId): number {
  switch (segmentId) {
    case 'enterprise':
    case 'legal':
    case 'healthcare':
    case 'science':
      return Math.max(0.75, ECONOMY.softmaxTemp * 0.72)
    case 'startup_api':
      // Slightly mixed so #2–4 retain API users vs pure winner-take-all
      return Math.max(1.05, ECONOMY.softmaxTemp * 1.05)
    case 'consumer':
      return Math.max(1.0, ECONOMY.softmaxTemp * 1.0)
    case 'hobby':
    case 'indie_api':
      return ECONOMY.softmaxTemp * 1.25
    default:
      return ECONOMY.softmaxTemp
  }
}

/**
 * Multi-attribute scores in 0–100 space for market choice.
 * Intelligence is absolute quality; `sota` is frontier-relative.
 */
export function scoreOfferFactors(
  offer: MarketOffer,
  segmentId: SegmentId,
  opts?: OfferUtilityOpts,
): OfferFactorScores {
  const seg = SEGMENTS.find((s) => s.id === segmentId)!
  const bench = segmentBenchmarkFit(offer.benchmarks, seg.benchmarkWeights)
  const frontier = opts?.frontier ?? Math.max(offer.capability, 40)
  const sota = sotaProximity(offer.capability, frontier)

  // Absolute intelligence (still used for floors / display)
  const intelligence = Math.min(
    100,
    offer.capability * 0.42 + bench * 0.38 + offer.reliability * 0.12 + sota * 12,
  )

  // Price attractiveness uses cost per successful task, so a cheap model that
  // repeatedly fails is not treated as cheaper intelligence.
  const successRate = Math.max(
    0.08,
    Math.min(1, (offer.capability * 0.42 + bench * 0.38 + offer.reliability * 0.2) / 100),
  )
  // Hosted open-weight endpoints still charge their advertised API or plan
  // price. Treating every open offer as free double-counted local/open usage,
  // which already lives in the market's outside option.
  const p = Math.max(0.01, seg.prefersSub ? offer.subPrice : offer.apiPrice)
  const effectivePrice = p / successRate
  const price = seg.prefersSub
    ? Math.max(0, Math.min(100, 85 - Math.log10(effectivePrice + 1) * 28))
    : Math.max(0, Math.min(100, 80 - Math.log10(effectivePrice * 8 + 0.05) * 26))

  // Speed: latency score + token throughput (tokPerSec)
  const tok = offer.tokPerSec ?? 0
  const tokScore = Math.min(50, Math.log10(tok + 10) * 12)
  const speed = Math.min(100, offer.latencyScore * 0.55 + tokScore + 10)

  // Tooling: tools modality, agents benchmark, multi-modal features
  const agents = offer.benchmarks.agents ?? 0
  const toolMod = offer.modalities.includes('tools') ? 28 : 0
  const multi =
    (offer.modalities.includes('image') ? 12 : 0) +
    (offer.modalities.includes('video') ? 10 : 0)
  const openEcosystem =
    offer.isOpenWeights && (segmentId === 'indie_api' || segmentId === 'science')
      ? 8
      : 0
  const tooling = Math.min(
    100,
    toolMod + agents * 0.55 + multi + offer.modalities.length * 4 + openEcosystem,
  )

  return {
    intelligence,
    price,
    speed,
    tooling,
    trust: offer.brandTrust,
    safety: offer.safety,
    effectivePrice,
    sota,
  }
}

/**
 * How much price moves share (0–1).
 * Near-SOTA still price-sensitive on hobby/indie/API — cheap #2–3 models get users.
 * Enterprise cares less but not zero when quality is close.
 */
function priceLeverage(sota: number, segmentId: SegmentId): number {
  const lag = 1 - sota
  // Floor leverage so 20% markup near-SOTA still competes
  const nearSotaBoost = sota > 0.5 ? 0.22 + sota * 0.15 : 0
  switch (segmentId) {
    case 'enterprise':
    case 'legal':
    case 'healthcare':
    case 'science':
      return Math.min(0.85, 0.12 + lag * lag * 0.55 + nearSotaBoost * 0.35)
    case 'startup_api':
      return Math.min(0.95, 0.28 + lag * 0.55 + nearSotaBoost * 0.55)
    case 'consumer':
      return Math.min(0.95, 0.3 + lag * 0.5 + nearSotaBoost * 0.5)
    case 'indie_api':
    case 'hobby':
      return Math.min(1, 0.5 + lag * 0.45 + nearSotaBoost * 0.4)
    default:
      return Math.min(0.95, 0.3 + lag * 0.55 + nearSotaBoost * 0.45)
  }
}

/** Quality term — SOTA leads but near-SOTA stays in the race. */
function frontierQualityTerm(sota: number, intelligence: number, segmentId: SegmentId): number {
  let q = intelligence / 10
  const premium =
    segmentId === 'enterprise' ||
    segmentId === 'legal' ||
    segmentId === 'healthcare' ||
    segmentId === 'science'
      ? 6.5
      : segmentId === 'startup_api'
        ? 5.5
        : segmentId === 'consumer'
          ? 4.8
          : segmentId === 'creative'
            ? 4.5
            : 3.2
  // Softer curve so 70–90% of frontier still scores well
  q += Math.pow(Math.max(0.15, sota), 1.25) * premium
  if (sota < 0.35) {
    q -= (0.35 - sota) * (segmentId === 'hobby' || segmentId === 'indie_api' ? 3 : 5.5)
  }
  return q
}

/** Segment-weighted utility for softmax market share. */
export function offerUtility(
  offer: MarketOffer,
  segmentId: SegmentId,
  opts?: OfferUtilityOpts,
): number {
  const seg = SEGMENTS.find((s) => s.id === segmentId)!
  const frontier = opts?.frontier ?? Math.max(offer.capability, 40)
  const f = scoreOfferFactors(offer, segmentId, { frontier })
  const bench = segmentBenchmarkFit(offer.benchmarks, seg.benchmarkWeights)

  // Soft floors — only trash models are wiped (near-SOTA never hits this)
  const floor = seg.qualityFloor
  const capOk = offer.capability + offer.reliability * 0.25
  if (bench < floor * 0.35 && capOk < floor * 0.45 && f.sota < 0.18) {
    return -18 + f.price * 0.04
  }
  const gap = frontier - offer.capability
  const maxGap =
    segmentId === 'enterprise' || segmentId === 'legal' || segmentId === 'healthcare'
      ? 32
      : segmentId === 'startup_api' || segmentId === 'consumer'
        ? 42
        : 52
  if (gap > maxGap && f.sota < 0.1) {
    return -10 + f.price * 0.06
  }

  const w = seg.weights
  const pLev = priceLeverage(f.sota, segmentId)
  const quality = frontierQualityTerm(f.sota, f.intelligence, segmentId)

  // Price matters more: cheap near-SOTA should win meaningful share
  const priceTerm = (f.price / 10) * (0.65 + pLev * 0.9) * (0.7 + w.price)

  // Mid-pack / near-SOTA floor so #2–4 still pull real API & free-tier users
  const nearSotaFloor =
    f.sota >= 0.7
      ? 1.5 + f.sota * 1.5
      : f.sota >= 0.45
        ? 1.15 + f.sota * 1.55
        : f.sota >= 0.2
          ? 0.85 + f.sota * 1.35 // 3rd–4th place still competes on API
          : 0.25 + f.sota * 0.9

  // API segments care less about brand polish and more about usable models
  const apiish =
    segmentId === 'indie_api' ||
    segmentId === 'startup_api' ||
    segmentId === 'hobby' ||
    segmentId === 'creative'
  const trustW = apiish ? w.trust * 0.65 : w.trust
  const qualityW = apiish ? w.quality * 1.05 : w.quality

  return (
    qualityW * quality * 1.15 +
    w.price * priceTerm * 1.35 +
    // Users expect cheap/smaller models to be snappy. Frontier intelligence
    // earns more latency tolerance, especially in reasoning-heavy segments.
    w.latency * (f.speed / 10) * (1.35 - f.sota * 0.55) +
    w.features * (f.tooling / 10) +
    trustW * (f.trust / 10) * (0.75 + f.sota * 0.35) +
    w.safety * (f.safety / 10) +
    nearSotaFloor
  )
}

export function softmaxShares(values: number[], temp = ECONOMY.softmaxTemp): number[] {
  if (values.length === 0) return []
  const t = Math.max(0.2, temp)
  const max = Math.max(...values)
  const exps = values.map((v) => Math.exp((v - max) / t))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

/** Convenience for tests: share of each offer in a segment. */
export function segmentShares(
  offers: MarketOffer[],
  segmentId: SegmentId,
  temp?: number,
  frontier?: number,
): number[] {
  const f =
    frontier ??
    (offers.length > 0 ? Math.max(...offers.map((o) => o.capability)) : 40)
  const t = temp ?? segmentSoftmaxTemp(segmentId)
  return softmaxShares(
    offers.map((o) => offerUtility(o, segmentId, { frontier: f })),
    t,
  )
}
