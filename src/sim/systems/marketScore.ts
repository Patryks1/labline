import { ECONOMY, SEGMENTS } from "../balance/economy";
import { segmentBenchmarkFit } from "../balance/benchmarks";
import { API_PRICE_EPSILON } from "../balance/pricing";
import {
  obsolescenceDiscount,
  obsolescenceUsage,
  relativeSota,
} from "../balance/obsolescence";
import { tokenThroughputScore } from "../balance/tokenSpeed";
import { offerDomainHeatBonus } from "../balance/domainHeat";
import type { DomainHeat, MarketOffer, SegmentId } from "../types";

export interface OfferFactorScores {
  intelligence: number;
  price: number;
  speed: number;
  tooling: number;
  trust: number;
  safety: number;
  /** List price divided by estimated successful-task rate. */
  effectivePrice: number;
  /** 0 = far behind frontier, 1 = co-SOTA / frontier */
  sota: number;
}

export interface OfferUtilityOpts {
  /** Best capability among public offers this tick (frontier). */
  frontier?: number;
  /** Best benchmark-aware usable quality among offers in this segment. */
  qualityFrontier?: number;
  /** Current campaign domain-heat pulse. */
  domainHeat?: DomainHeat;
}

/**
 * Benchmark-aware usable quality for one segment. Capability alone is not a
 * sufficient market signal: a cheap checkpoint with poor evals still fails
 * more customer tasks than a similarly sized, well post-trained model.
 */
export function segmentOfferQuality(
  offer: MarketOffer,
  segmentId: SegmentId,
): number {
  const seg = SEGMENTS.find((candidate) => candidate.id === segmentId)!;
  const bench = segmentBenchmarkFit(offer.benchmarks, seg.benchmarkWeights);
  return Math.max(
    0,
    Math.min(
      100,
      offer.capability * 0.38 + bench * 0.42 + offer.reliability * 0.2,
    ),
  );
}

/**
 * Continuous API competitiveness from absolute usability and distance to the
 * best public offer. Floor-free: relative exponential decay off the quality
 * frontier times an absolute viability sigmoid (see obsolescenceDiscount).
 * No residual trickle — far-lagging endpoints decay toward epsilon, so price
 * alone cannot buy frontier-scale traffic.
 */
export function apiQualityCompetitivenessMultiplier(input: {
  quality: number;
  frontierQuality: number;
  qualityFloor: number;
  segmentId: SegmentId;
}): number {
  return obsolescenceDiscount(input);
}

/**
 * How close capability is to the public frontier (0–1), measured as a
 * *relative* gap so the same curve holds at frontier 60 and frontier 600.
 */
export function sotaProximity(capability: number, frontier: number): number {
  return relativeSota(capability, frontier);
}

/**
 * Token / engagement intensity from SOTA proximity, through the origin:
 * zero proximity means zero intensity, no additive baseline. Co-SOTA top
 * ends match the legacy curve; everything below decays procedurally.
 */
export function sotaUsageMultiplier(
  sota: number,
  segmentId: SegmentId,
): number {
  return obsolescenceUsage(sota, segmentId);
}

/** Softmax temperature — mixed enough that near-SOTA + cheap still gets users. */
export function segmentSoftmaxTemp(segmentId: SegmentId): number {
  switch (segmentId) {
    case "enterprise":
    case "legal":
    case "healthcare":
    case "science":
      return Math.max(0.75, ECONOMY.softmaxTemp * 0.72);
    case "startup_api":
      // Slightly mixed so #2–4 retain API users vs pure winner-take-all
      return Math.max(1.05, ECONOMY.softmaxTemp * 1.05);
    case "consumer":
      return Math.max(1.0, ECONOMY.softmaxTemp * 1.0);
    case "hobby":
    case "indie_api":
      return ECONOMY.softmaxTemp * 1.25;
    default:
      return ECONOMY.softmaxTemp;
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
  const seg = SEGMENTS.find((s) => s.id === segmentId)!;
  const bench = segmentBenchmarkFit(offer.benchmarks, seg.benchmarkWeights);
  const frontier = opts?.frontier ?? Math.max(offer.capability, 40);
  const sota = sotaProximity(offer.capability, frontier);

  // Absolute intelligence (still used for floors / display)
  const intelligence = Math.min(
    100,
    offer.capability * 0.42 +
      bench * 0.38 +
      offer.reliability * 0.12 +
      sota * 12,
  );

  // Price attractiveness uses cost per successful task, so a cheap model that
  // repeatedly fails is not treated as cheaper intelligence.
  const successRate = Math.max(
    0.08,
    Math.min(
      1,
      (offer.capability * 0.42 + bench * 0.38 + offer.reliability * 0.2) / 100,
    ),
  );
  // Hosted open-weight endpoints still charge their advertised API or plan
  // price. Treating every open offer as free double-counted local/open usage,
  // which already lives in the market's outside option.
  const p = Math.max(
    seg.prefersSub ? 0.01 : API_PRICE_EPSILON,
    seg.prefersSub ? offer.subPrice : offer.apiPrice,
  );
  const effectivePrice = p / successRate;
  const price = seg.prefersSub
    ? Math.max(0, Math.min(100, 85 - Math.log10(effectivePrice + 1) * 28))
    : Math.max(
        0,
        Math.min(100, 80 - Math.log10(effectivePrice * 8 + 0.05) * 26),
      );

  // Speed: latency score + token throughput. The tok/s term is a 30 tok/s
  // sigmoid knee (not a log-only curve), so 10–20 tok/s is painful while
  // 45+ is comfortable; magnitude stays in the historic 0–50 tok band.
  const tokScore = tokenThroughputScore(offer.tokPerSec ?? 0);
  const speed = Math.min(100, offer.latencyScore * 0.55 + tokScore + 10);

  // Tooling: tools modality, agents benchmark, multi-modal features
  const agents = offer.benchmarks.agents ?? 0;
  const toolMod = offer.modalities.includes("tools") ? 28 : 0;
  const multi =
    (offer.modalities.includes("image") ? 12 : 0) +
    (offer.modalities.includes("video") ? 10 : 0);
  const openEcosystem =
    offer.isOpenWeights &&
    (segmentId === "indie_api" || segmentId === "science")
      ? 8
      : 0;
  const tooling = Math.min(
    100,
    toolMod +
      agents * 0.55 +
      multi +
      offer.modalities.length * 4 +
      openEcosystem,
  );

  return {
    intelligence,
    price,
    speed,
    tooling,
    trust: offer.brandTrust,
    safety: offer.safety,
    effectivePrice,
    sota,
  };
}

/**
 * How much price moves share (0–1).
 * Near-SOTA still price-sensitive on hobby/indie/API — cheap #2–3 models get users.
 * Enterprise cares less but not zero when quality is close.
 */
function priceLeverage(sota: number, segmentId: SegmentId): number {
  const lag = 1 - sota;
  // Floor leverage so 20% markup near-SOTA still competes
  const nearSotaBoost = sota > 0.5 ? 0.22 + sota * 0.15 : 0;
  switch (segmentId) {
    case "enterprise":
    case "legal":
    case "healthcare":
    case "science":
      return Math.min(0.85, 0.12 + lag * lag * 0.55 + nearSotaBoost * 0.35);
    case "startup_api":
      return Math.min(0.95, 0.28 + lag * 0.55 + nearSotaBoost * 0.55);
    case "consumer":
      return Math.min(0.95, 0.3 + lag * 0.5 + nearSotaBoost * 0.5);
    case "indie_api":
    case "hobby":
      return Math.min(1, 0.5 + lag * 0.45 + nearSotaBoost * 0.4);
    default:
      return Math.min(0.95, 0.3 + lag * 0.55 + nearSotaBoost * 0.45);
  }
}

/** Quality term — SOTA leads but near-SOTA stays in the race. */
function frontierQualityTerm(
  sota: number,
  intelligence: number,
  segmentId: SegmentId,
): number {
  let q = intelligence / 10;
  const premium =
    segmentId === "enterprise" ||
    segmentId === "legal" ||
    segmentId === "healthcare" ||
    segmentId === "science"
      ? 6.5
      : segmentId === "startup_api"
        ? 5.5
        : segmentId === "consumer"
          ? 4.8
          : segmentId === "creative"
            ? 4.5
            : 3.2;
  // Procedural curve through the origin: zero proximity contributes zero
  // (no floor), co-SOTA keeps the full premium. Near-vs-mid spread is carried
  // by value competition (price band) and relative proximity itself, not by
  // an absolute-gap gate — gentler on mid-pack than convex alternatives.
  q += Math.pow(Math.max(0, sota), 1.25) * premium;
  if (sota < 0.35) {
    q -=
      (0.35 - sota) *
      (segmentId === "hobby" || segmentId === "indie_api" ? 3 : 5.5);
  }
  return q;
}

export interface OfferUtilityOptsWithPeers extends OfferUtilityOpts {
  /** Peers in a similar price band (rivals + own other products). */
  priceBandPeers?: MarketOffer[];
}

/** Offers whose list price is within ~0.4×–2.5× of the reference offer. */
export function peersInPriceBand(
  offer: MarketOffer,
  candidates: MarketOffer[],
  prefersSub: boolean,
  band = { lo: 0.4, hi: 2.5 },
): MarketOffer[] {
  const price = Math.max(
    prefersSub ? 0.01 : API_PRICE_EPSILON,
    prefersSub ? offer.subPrice : offer.apiPrice,
  );
  const inBand = candidates.filter((peer) => {
    if (peer.labId === offer.labId && peer.modelId === offer.modelId)
      return false;
    const peerPrice = Math.max(
      prefersSub ? 0.01 : API_PRICE_EPSILON,
      prefersSub ? peer.subPrice : peer.apiPrice,
    );
    const ratio = peerPrice / price;
    return ratio >= band.lo && ratio <= band.hi;
  });
  if (inBand.length > 0) return inBand;
  // No peer in band: the offer priced itself out of the neighborhood. Fall
  // back to the single nearest peer instead of reporting none — otherwise a
  // drastic undercut (everyone else above 2.5×) forfeits its entire value
  // bonus at exactly the moment it earned the most, a perverse cliff. The
  // log-bounded bonus then keeps rewarding deeper cuts continuously up to
  // its cap (and punishes drastic overpricing symmetrically).
  let nearest: MarketOffer | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const peer of candidates) {
    if (peer.labId === offer.labId && peer.modelId === offer.modelId)
      continue;
    const peerPrice = Math.max(
      prefersSub ? 0.01 : API_PRICE_EPSILON,
      prefersSub ? peer.subPrice : peer.apiPrice,
    );
    const distance = Math.abs(Math.log(peerPrice / price));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = peer;
    }
  }
  return nearest ? [nearest] : [];
}

/**
 * Quality-per-dollar vs peers in the same price band.
 * Positive when this offer beats the band median; mild cannibalization when
 * own cheaper API undercuts own subscription-tier siblings.
 */
export function priceBandCompetitionBonus(
  offer: MarketOffer,
  peers: MarketOffer[],
  segmentId: SegmentId,
): number {
  if (peers.length === 0) return 0;
  const seg = SEGMENTS.find((s) => s.id === segmentId)!;
  const ownPrice = Math.max(
    seg.prefersSub ? 0.01 : API_PRICE_EPSILON,
    seg.prefersSub ? offer.subPrice : offer.apiPrice,
  );
  // Price-band value must use the segment's benchmark-aware task
  // quality. Otherwise a smaller coding/security specialist is undervalued by
  // headline capability even when it solves more target tasks per dollar.
  const ownValue = segmentOfferQuality(offer, segmentId) / ownPrice;
  const peerValues = peers.map((peer) => {
    const peerPrice = Math.max(
      seg.prefersSub ? 0.01 : API_PRICE_EPSILON,
      seg.prefersSub ? peer.subPrice : peer.apiPrice,
    );
    return segmentOfferQuality(peer, segmentId) / peerPrice;
  });
  const medianPeer =
    [...peerValues].sort((a, b) => a - b)[Math.floor(peerValues.length / 2)] ??
    ownValue;
  const relative = ownValue / Math.max(1e-6, medianPeer);
  // Sharper than the legacy 2.4 so a strictly dominated same-price offer
  // (half the quality-per-dollar of its band median) loses decisively in
  // choice share instead of riding proximity alone. Still log-bounded with
  // the same ± caps — no cliff, just steeper continuous differentiation.
  let bonus = Math.max(-2.2, Math.min(2.8, Math.log(relative) * 3.0));
  // Own-product cannibalization: undercutting a sibling subscription hurts less
  // on API-native segments (buyers wanted API) and more on sub-native ones.
  const ownSiblings = peers.filter((peer) => peer.labId === offer.labId);
  if (ownSiblings.length > 0 && !seg.prefersSub) {
    const cheaperThanOwnSub = ownSiblings.some(
      (peer) => offer.apiPrice + 1e-9 < peer.subPrice * 0.15,
    );
    if (cheaperThanOwnSub) bonus += seg.prefersSub ? -0.8 : 0.35;
  }
  return bonus;
}

/** Segment-weighted utility for softmax market share. */
export function offerUtility(
  offer: MarketOffer,
  segmentId: SegmentId,
  opts?: OfferUtilityOptsWithPeers,
): number {
  const seg = SEGMENTS.find((s) => s.id === segmentId)!;
  const frontier = opts?.frontier ?? Math.max(offer.capability, 40);
  const f = scoreOfferFactors(offer, segmentId, { frontier });
  const bench = segmentBenchmarkFit(offer.benchmarks, seg.benchmarkWeights);

  // Smooth viability pressure. Older versions returned a special hard score
  // after crossing these boundaries; keeping the penalty continuous avoids a
  // top-N/cliff market while still making unusable checkpoints unattractive.
  const floor = seg.qualityFloor;
  const capOk = offer.capability + offer.reliability * 0.25;
  const gap = frontier - offer.capability;
  // Scale-free obsolescence cliff: the tolerated lag is a fraction of the
  // frontier, not an absolute point count, so it holds at any magnitude.
  // Calibrated to match the legacy 32/42/52-point gaps at frontier ~70.
  const maxGapShare =
    segmentId === "enterprise" ||
    segmentId === "legal" ||
    segmentId === "healthcare"
      ? 0.45
      : segmentId === "startup_api" || segmentId === "consumer"
        ? 0.6
        : 0.72;
  const maxGap = maxGapShare * Math.max(frontier, 1);
  const benchmarkDeficit =
    Math.max(0, floor * 0.35 - bench) / Math.max(1, floor * 0.35);
  const capabilityDeficit =
    Math.max(0, floor * 0.45 - capOk) / Math.max(1, floor * 0.45);
  const frontierDeficit = Math.max(0, 0.18 - f.sota) / 0.18;
  // Beyond-cliff penalty in relative units (×21 ≈ legacy 0.3/pt at F≈70),
  // so the cliff costs the same utility at any frontier magnitude.
  const viabilityPenalty =
    benchmarkDeficit * capabilityDeficit * frontierDeficit * 22 +
    (Math.max(0, gap - maxGap) / Math.max(frontier, 1)) * 21;

  const w = seg.weights;
  const pLev = priceLeverage(f.sota, segmentId);
  const quality = frontierQualityTerm(f.sota, f.intelligence, segmentId);

  // Price matters more: cheap near-SOTA should win meaningful share
  const priceTerm = (f.price / 10) * (0.65 + pLev * 0.9) * (0.7 + w.price);

  // Procedural proximity reward through the origin: near-SOTA earns up to
  // +3.0 like the legacy top band, zero proximity earns zero — no
  // participation floor. Young weak models still score here because proximity
  // itself is now relative, not an absolute-gap gate. Spread against
  // near-frontier comes from value competition, not from this term.
  const nearSotaFloor = f.sota * (1.5 + f.sota * 1.5);

  // API segments care less about brand polish and more about usable models
  const apiish =
    segmentId === "indie_api" ||
    segmentId === "startup_api" ||
    segmentId === "hobby" ||
    segmentId === "creative" ||
    segmentId === "science";
  const trustW = apiish ? w.trust * 0.65 : w.trust;
  const qualityW = apiish ? w.quality * 1.05 : w.quality;
  const bandBonus = priceBandCompetitionBonus(
    offer,
    opts?.priceBandPeers ?? [],
    segmentId,
  );
  const usableQuality = segmentOfferQuality(offer, segmentId);
  const qualityCompetitiveness = apiQualityCompetitivenessMultiplier({
    quality: usableQuality,
    frontierQuality: opts?.qualityFrontier ?? usableQuality,
    qualityFloor: floor,
    segmentId,
  });
  // Provider choice already prices task-success quality through intelligence,
  // effective price and the frontier term. Keep this as a light nudge; the
  // full multiplier is applied to realized token intensity in market.ts.
  // A large log coefficient here double-counted quality inside the softmax
  // and collapsed otherwise viable third/fourth-place specialist offers.
  const competitivenessTerm = apiish
    ? Math.log(Math.max(0.001, qualityCompetitiveness)) * 0.1
    : 0;
  const heatBonus = offerDomainHeatBonus(offer.benchmarks, opts?.domainHeat);

  return (
    qualityW * quality * 1.15 +
    w.price * priceTerm * 1.35 +
    // Users expect cheap/smaller models to be snappy. Frontier intelligence
    // earns more latency tolerance, especially in reasoning-heavy segments.
    w.latency * (f.speed / 10) * (1.35 - f.sota * 0.55) +
    w.features * (f.tooling / 10) +
    trustW * (f.trust / 10) * (0.75 + f.sota * 0.35) +
    w.safety * (f.safety / 10) +
    nearSotaFloor +
    bandBonus +
    competitivenessTerm +
    heatBonus -
    viabilityPenalty
  );
}

export function softmaxShares(
  values: number[],
  temp = ECONOMY.softmaxTemp,
): number[] {
  if (values.length === 0) return [];
  const t = Math.max(0.2, temp);
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp((v - max) / t));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/** Convenience for tests: share of each offer in a segment. */
export function segmentShares(
  offers: MarketOffer[],
  segmentId: SegmentId,
  temp?: number,
  frontier?: number,
  domainHeat?: DomainHeat,
): number[] {
  const f =
    frontier ??
    (offers.length > 0 ? Math.max(...offers.map((o) => o.capability)) : 40);
  const t = temp ?? segmentSoftmaxTemp(segmentId);
  const qualityFrontier = offers.reduce(
    (best, offer) => Math.max(best, segmentOfferQuality(offer, segmentId)),
    0,
  );
  return softmaxShares(
    offers.map((o) =>
      offerUtility(o, segmentId, { frontier: f, qualityFrontier, domainHeat }),
    ),
    t,
  );
}
