import type {
  BenchmarkSuiteId,
  Model,
  ModelFamily,
  ProductPricing,
  SimState,
} from "../types";
import { isLivePublicModel } from "../modelRelease";
import type { ComputeSnapshot } from "../systems/compute";
import { ECONOMY } from "./economy";
import { normalizeModelEvaluations, suiteComposite } from "./evaluationSuites";
import {
  modelCostMult as tokenModelCostMult,
  suggestApiFromUnitCost,
} from "./tokenServe";
import {
  API_COST_IN_MULT,
  API_COST_OUT_MULT,
  API_UNIT_COST_FLOOR,
  FALLBACK_COST_PER_MTOK,
  apiUnitCostPerMTok,
  marginPct,
  markupRatio,
  servingOpsDayEstimate,
  splitInOutCost,
} from "./unitEconomics";
import {
  CANONICAL_TEXT_INPUT_SHARE,
  CANONICAL_TEXT_OUTPUT_SHARE,
} from "./workload";

export {
  API_CAMPUS_CLOUD_SWITCH_MULT,
  API_COST_IN_MULT,
  API_COST_OUT_MULT,
  API_FLOOR_TARGET_UTILIZATION,
  API_UNIT_COST_FLOOR,
  FALLBACK_COST_PER_MTOK,
  apiHostingCostFloor,
  apiPriceMarkupPct,
  apiUnitCostPerMTok,
  boundedApiListCostPerMTok,
  birthApiUnitCostPerMTok,
  clampApiListToHostingFloor,
  marginPct,
  markupPct,
  markupRatio,
  planMarginPerSubMonth,
  servingOpsDayEstimate,
  splitInOutCost,
  targetUtilizedApiCostPerMTok,
} from "./unitEconomics";
export type { ApiHostingCostFloor, ApiHostingCostSource } from "./unitEconomics";

/** Canonical default text mix. Workload-specific ledgers may override it. */
export const API_IN_SHARE = CANONICAL_TEXT_INPUT_SHARE;
export const API_OUT_SHARE = CANONICAL_TEXT_OUTPUT_SHARE;

export interface FullyLoadedApiCostFloor {
  blended: number;
  costIn: number;
  costOut: number;
  source: "live" | "marginal";
}

/**
 * Cost floor for an API model. Prefers live settlement COGS/MTok when the
 * model served yesterday; otherwise the capacity-based marginal estimate.
 * Prefer `apiUnitCostPerMTok` for new call sites.
 */
export function fullyLoadedApiCostFloor(input: {
  dayCogs?: number;
  dayMTok?: number;
  marginalCostPerMTok: number;
}): FullyLoadedApiCostFloor {
  const marginal = Math.max(API_UNIT_COST_FLOOR, input.marginalCostPerMTok);
  const hasLiveCost =
    Number.isFinite(input.dayCogs) &&
    Number.isFinite(input.dayMTok) &&
    (input.dayCogs ?? 0) > 0 &&
    (input.dayMTok ?? 0) > 0.001;
  const blended = hasLiveCost
    ? Math.max(
        API_UNIT_COST_FLOOR,
        (input.dayCogs as number) / Math.max(0.001, input.dayMTok as number),
      )
    : marginal;
  const split = splitInOutCost(blended);
  return {
    blended,
    costIn: split.costIn,
    costOut: split.costOut,
    source: hasLiveCost ? "live" : "marginal",
  };
}

export interface ApiUnitEconomics {
  directBlended: number;
  directIn: number;
  directOut: number;
  observedAllocatedBlended: number | null;
  allocatedOverheadPerMTok: number;
  directOpsDay: number;
  capacityMTok: number;
  utilization: number;
  valueIndex: number;
  marketReference: number;
  costBand: { low: number; high: number };
  valueBand: { low: number; high: number };
  recommendedBand: { low: number; high: number };
  recommendedPrice: number;
  state:
    | "efficiency_premium"
    | "healthy"
    | "uncompetitive_cost"
    | "overbuilt_capacity";
}

export interface ApiCompetitivePeerPrice {
  priceIn: number;
  priceOut: number;
  capability: number;
  featureScore: number;
  tokPerSec?: number;
  valueIndex?: number;
}

/**
 * Recommend separate API list prices from quality-adjusted rival rates.
 * The target is a 12.5% undercut of comparable peers, bounded by the
 * model's marginal input/output cost floors.
 */
export function suggestCompetitiveApiInOut(input: {
  costIn: number;
  costOut: number;
  capability: number;
  featureScore: number;
  tokPerSec?: number;
  peers: ApiCompetitivePeerPrice[];
  fallbackPriceIn?: number;
  fallbackPriceOut?: number;
}): { priceIn: number; priceOut: number; hasComparablePeers: boolean } {
  const ownQuality = apiDemandQuality(input);
  const validPeers = input.peers
    .map((peer) => ({ peer, quality: apiDemandQuality(peer) }))
    .filter(({ peer }) => peer.priceIn >= 0 && peer.priceOut >= 0);
  const comparable = validPeers.filter(
    ({ quality }) =>
      quality >= ownQuality * 0.55 && quality <= ownQuality * 1.8,
  );
  const peers = comparable.length > 0 ? comparable : validPeers;
  const normalizedIn = peers.map(
    ({ peer, quality }) => peer.priceIn * (ownQuality / quality),
  );
  const normalizedOut = peers.map(
    ({ peer, quality }) => peer.priceOut * (ownQuality / quality),
  );
  const targetIn = median(normalizedIn);
  const targetOut = median(normalizedOut);
  const floorIn = Math.max(0, input.costIn);
  const floorOut = Math.max(0, input.costOut);
  const roundUpCents = (value: number) => Math.ceil(value * 100 - 1e-9) / 100;
  return {
    priceIn: roundUpCents(
      Math.max(
        floorIn,
        targetIn == null
          ? (input.fallbackPriceIn ?? floorIn)
          : targetIn * 0.875,
      ),
    ),
    priceOut: roundUpCents(
      Math.max(
        floorOut,
        targetOut == null
          ? (input.fallbackPriceOut ?? floorOut)
          : targetOut * 0.875,
      ),
    ),
    hasComparablePeers: comparable.length > 0,
  };
}

export type PricingSignal =
  | "fair"
  | "below_cost"
  | "undercutting"
  | "expensive"
  | "demand_collapse"
  | "stingy_plan"
  | "unsustainable_plan";

export interface PricingDiagnostic {
  primary: PricingSignal;
  signals: PricingSignal[];
  severity: "ok" | "amber" | "danger";
  peerMedian: number | null;
  ratioToPeer: number | null;
  /** True margin (revenue − cost) / revenue. */
  marginPct: number;
  /** Price / cost (1 = at cost). API diagnostics only; plans mirror margin language. */
  markupRatio: number;
  /**
   * @deprecated Use `marginPct` (true margin) or `markupRatio` (price/cost).
   * Kept as an alias of `marginPct` so older readers stay consistent.
   */
  marginRatio: number;
  capabilityLead: number;
  featureLead: number;
  explanation: string;
}

export interface ApiPeerPrice {
  price: number;
  capability: number;
  featureScore: number;
  /** Effective endpoint throughput after serving precision. */
  tokPerSec?: number;
  valueIndex?: number;
  kind?: string;
}

export type CommercialModelKind =
  "language" | "coding" | "reasoning" | "image" | "video" | "audio" | "omni";

/**
 * Price ratio vs the quality-adjusted peer median that the market tolerates
 * before demand starts to decay. Wider tolerance keeps a peer-priced
 * competitive API viable vs subs; capability/feature leads earn real premium.
 */
export function apiPriceToleranceRatio(
  kind?: string,
  capabilityLead?: number,
  featureLead?: number,
): number {
  const premiumTolerance: Record<string, number> = {
    language: 1.2,
    coding: 1.55,
    reasoning: 1.65,
    image: 1.7,
    video: 2.1,
    audio: 1.5,
    omni: 1.65,
  };
  const capabilityPremium =
    1 +
    Math.max(0, capabilityLead ?? 0) * 0.022 +
    Math.max(0, featureLead ?? 0) * 0.008;
  return (premiumTolerance[kind ?? "language"] ?? 1.2) * capabilityPremium;
}

/** Continuous peer-relative price pressure; premiums decay demand, never erase it. */
export function apiDemandPricePenalty(input: {
  ratioToPeer: number | null;
  kind?: string;
  capabilityLead?: number;
  featureLead?: number;
  /**
   * Multiplier on the tolerated ratio for high-willingness-to-pay audiences
   * (e.g. subscription ARPU segments where £100+/mo seats are normal). 1 = default.
   */
  toleranceScale?: number;
}): number {
  if (input.ratioToPeer == null || input.ratioToPeer <= 1) return 0;
  const toleratedRatio =
    apiPriceToleranceRatio(
      input.kind,
      input.capabilityLead,
      input.featureLead,
    ) * Math.max(0.05, input.toleranceScale ?? 1);
  const excessLog = Math.max(
    0,
    Math.log(Math.max(1, input.ratioToPeer / toleratedRatio)),
  );
  return Math.min(9, excessLog * 3.2 + excessLog * excessLog * 0.95);
}

/**
 * Per-segment price elasticity of API token demand. Hobby/indie churn away
 * fastest; science and enterprise-like buyers absorb premiums.
 */
export const SEGMENT_API_PRICE_ELASTICITY: Record<string, number> = {
  hobby: 1.7,
  indie_api: 1.5,
  startup_api: 1.1,
  science: 0.8,
  creative: 1.0,
};

export const DEFAULT_API_PRICE_ELASTICITY = 0.9;

/**
 * Smallest positive public API list price the demand model distinguishes.
 * Stored prices may still be exactly zero (a genuinely free endpoint); this
 * epsilon is only used where ratios/logarithms need a non-zero denominator.
 */
export const API_PRICE_EPSILON = 0.0000001;

/**
 * Multiplicative demand response to the peer-relative price ratio. Unlike the
 * utility penalty this scales realized MTok directly: inside the tolerated
 * ratio there is a mild undercut reward (≤1.15×), beyond it demand decays as
 * (tolerated / ratio)^elasticity with a 0.02 floor so gouging leaves a trickle.
 */
export function apiDemandElasticityMultiplier(input: {
  ratioToPeer: number | null;
  kind?: string;
  capabilityLead?: number;
  featureLead?: number;
  elasticity: number;
}): number {
  if (input.ratioToPeer == null) return 1;
  const tolerated = apiPriceToleranceRatio(
    input.kind,
    input.capabilityLead,
    input.featureLead,
  );
  if (input.ratioToPeer <= tolerated) {
    return Math.min(
      1.15,
      Math.pow(tolerated / Math.max(input.ratioToPeer, 0.05), 0.25),
    );
  }
  return Math.max(
    0.005,
    Math.pow(tolerated / input.ratioToPeer, Math.max(0, input.elasticity)),
  );
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export function apiModelKind(
  model: Pick<Model, "family" | "productPreset" | "io">,
): string {
  if (model.family === "video" || (model.io?.outputs.video ?? 0) > 0)
    return "video";
  if (model.family === "diffusion" || (model.io?.outputs.image ?? 0) > 0)
    return "image";
  if (model.productPreset === "audio" || (model.io?.outputs.audio ?? 0) > 0)
    return "audio";
  if (model.family === "omni" || model.productPreset === "omni") return "omni";
  return "language";
}

export function commercialModelKind(
  model: Pick<
    Model,
    "family" | "productPreset" | "io" | "benchmarks" | "reasoningEnabled"
  >,
): CommercialModelKind {
  const kind = apiModelKind(model);
  if (kind !== "language") return kind as CommercialModelKind;
  // Process-reward / tools-trained reasoning stacks burn long CoT tokens even
  // before domain benches cross the specialist threshold.
  if (model.reasoningEnabled) return "reasoning";
  const coding = Math.max(
    model.benchmarks.coding ?? 0,
    model.benchmarks.agents ?? 0,
  );
  const reasoning = Math.max(
    model.benchmarks.math ?? 0,
    model.benchmarks.science ?? 0,
    model.benchmarks.law ?? 0,
    model.benchmarks.health ?? 0,
  );
  if (coding >= 58 && coding >= reasoning) return "coding";
  if (reasoning >= 58) return "reasoning";
  return "language";
}

/**
 * Expected tokens per customer interaction by workload. Basic chat is light
 * (~1–2K), coding sessions run ~3–8K, reasoning ~5–15K. Generation workloads
 * are measured in token-equivalent units: one image generation, a
 * significantly larger unit per video generation, and a duration-based unit
 * for audio.
 */
export const WORKLOAD_TOKENS_PER_INTERACTION: Record<
  CommercialModelKind,
  number
> = {
  language: 1_500,
  coding: 5_000,
  reasoning: 8_500,
  image: 4_000,
  video: 24_000,
  audio: 3_000,
  omni: 3_000,
};

export function avgTokensPerInteraction(kind: CommercialModelKind): number {
  return (
    WORKLOAD_TOKENS_PER_INTERACTION[kind] ??
    WORKLOAD_TOKENS_PER_INTERACTION.language
  );
}

/**
 * Blended public list price ($/MTok) for one model: input price × expected
 * input share + output price × expected output share. Model list prices win;
 * the lab policy is the fallback for models without explicit pricing.
 */
export function modelBlendedPublicApiPrice(
  pricing: Pick<
    ProductPricing,
    "apiPricePerMTok" | "apiPriceInPerMTok" | "apiPriceOutPerMTok"
  >,
  model:
    | Pick<
        Model,
        | "apiPricePerMTok"
        | "apiPriceInPerMTok"
        | "apiPriceOutPerMTok"
        | "suggestedApiPrice"
        | "suggestedApiPriceIn"
        | "suggestedApiPriceOut"
      >
    | null
    | undefined,
): number {
  if (
    model?.apiPriceInPerMTok == null &&
    model?.apiPriceOutPerMTok == null &&
    model?.apiPricePerMTok != null
  ) {
    return Math.max(0, model.apiPricePerMTok);
  }
  const labSplit = splitBlendedApiPrice(pricing.apiPricePerMTok);
  const labIn = pricing.apiPriceInPerMTok ?? labSplit.priceIn;
  const labOut = pricing.apiPriceOutPerMTok ?? labSplit.priceOut;
  const priceIn =
    model?.apiPriceInPerMTok ?? model?.suggestedApiPriceIn ?? labIn;
  const priceOut =
    model?.apiPriceOutPerMTok ?? model?.suggestedApiPriceOut ?? labOut;
  return Math.max(
    0,
    blendApiPrice(Math.max(0, priceIn), Math.max(0, priceOut)),
  );
}

function primarySuiteId(model: Model): BenchmarkSuiteId {
  if (model.family === "omni" || model.productPreset === "omni")
    return "omni_overview";
  if (model.family === "video" || (model.io?.outputs.video ?? 0) > 0)
    return "video_generation";
  if (model.family === "diffusion" || (model.io?.outputs.image ?? 0) > 0)
    return "image_generation";
  if (model.productPreset === "audio" || (model.io?.outputs.audio ?? 0) > 0)
    return "audio_generation";
  return "language";
}

/** Customer value, deliberately independent from compute cost. */
export function apiModelValueIndex(source: Model): number {
  const model = normalizeModelEvaluations(source);
  const suite = suiteComposite(model.benchmarkSuites?.[primarySuiteId(model)]);
  const speed =
    model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult;
  const speedScore = clamp(Math.log10(Math.max(1, speed) + 9) * 28);
  const toolsScore = clamp(
    ((model.io?.tools ?? 0) > 0 || model.modalities.includes("tools")
      ? 72
      : 20) +
      Math.max(0, model.modalities.length - 1) * 6,
  );
  return clamp(
    model.capability * 0.5 +
      suite * 0.2 +
      model.quality.reliability * 0.1 +
      model.quality.safety * 0.1 +
      speedScore * 0.05 +
      toolsScore * 0.05,
    5,
    100,
  );
}

export function apiMarketReference(
  valueIndex: number,
  peers: ApiPeerPrice[],
): number {
  const normalized = peers
    .filter((peer) => peer.price > 0)
    .map((peer) => {
      const peerValue = peer.valueIndex ?? apiDemandQuality(peer);
      return peer.price * (valueIndex / Math.max(5, peerValue));
    });
  return median(normalized) ?? 0.35 * Math.exp((valueIndex - 20) / 18);
}

export function apiPriceRecommendation(input: {
  directCost: number;
  valueIndex: number;
  peers: ApiPeerPrice[];
  allocatedOverheadPerMTok?: number;
}): Pick<
  ApiUnitEconomics,
  | "marketReference"
  | "costBand"
  | "valueBand"
  | "recommendedBand"
  | "recommendedPrice"
  | "state"
> {
  const direct = Math.max(0.005, input.directCost);
  const marketReference = Math.max(
    0.005,
    apiMarketReference(input.valueIndex, input.peers),
  );
  const costBand = { low: direct * 1.4, high: direct * 1.8 };
  const valueBand = {
    low: marketReference * 0.85,
    high: marketReference * 1.15,
  };
  let recommendedBand: { low: number; high: number };
  let state: ApiUnitEconomics["state"];
  if (costBand.low > valueBand.high) {
    recommendedBand = { low: costBand.low, high: costBand.low };
    state = "uncompetitive_cost";
  } else if (valueBand.low > costBand.high) {
    recommendedBand = valueBand;
    state = "efficiency_premium";
  } else {
    recommendedBand = {
      low: Math.max(costBand.low, valueBand.low),
      high: Math.min(costBand.high, valueBand.high),
    };
    state = "healthy";
  }
  const overhead = Math.max(0, input.allocatedOverheadPerMTok ?? 0);
  if (state !== "uncompetitive_cost" && overhead > direct * 8)
    state = "overbuilt_capacity";
  return {
    marketReference,
    costBand,
    valueBand,
    recommendedBand,
    recommendedPrice: (recommendedBand.low + recommendedBand.high) / 2,
    state,
  };
}

/**
 * Authoritative player endpoint economics. Direct cost uses the canonical
 * capacity estimate (settlement composition); live allocated COGS is diagnostic.
 */
export function deriveApiUnitEconomics(input: {
  state: SimState;
  snap: ComputeSnapshot;
  model: Model;
  serveModel?: Model;
  energyPricePerMWh: number;
  dayCogs?: number;
  dayMTok?: number;
  peers?: ApiPeerPrice[];
}): ApiUnitEconomics {
  const serveModel = input.serveModel ?? input.model;
  const unit = apiUnitCostPerMTok(input.state, input.snap, serveModel, {
    energyPricePerMWh: input.energyPricePerMWh,
    dayCogs: input.dayCogs,
    dayMTok: input.dayMTok,
    forceEstimate: true,
  });
  const directBlended = unit.blended;
  const directIn = unit.costIn;
  const directOut = unit.costOut;
  const directOpsDay = unit.opsDay;
  const capacityMTok = unit.capacityMTok;
  const hasObserved =
    Number.isFinite(input.dayCogs) &&
    Number.isFinite(input.dayMTok) &&
    (input.dayCogs ?? 0) > 0 &&
    (input.dayMTok ?? 0) > 0.001;
  const observedAllocatedBlended = hasObserved
    ? (input.dayCogs ?? 0) / Math.max(0.001, input.dayMTok ?? 0)
    : null;
  const allocatedOverheadPerMTok = Math.max(
    0,
    (observedAllocatedBlended ?? directBlended) - directBlended,
  );
  const utilization = Math.max(
    0,
    Math.min(1, (input.dayMTok ?? 0) / capacityMTok),
  );
  const valueIndex = apiModelValueIndex(serveModel);
  const kind = apiModelKind(serveModel);
  const peers = (input.peers ?? []).filter(
    (peer) => !peer.kind || peer.kind === kind,
  );
  const recommendation = apiPriceRecommendation({
    directCost: directBlended,
    valueIndex,
    peers,
    allocatedOverheadPerMTok,
  });
  return {
    directBlended,
    directIn,
    directOut,
    observedAllocatedBlended,
    allocatedOverheadPerMTok,
    directOpsDay,
    capacityMTok,
    utilization,
    valueIndex,
    ...recommendation,
  };
}

/**
 * A single quality score for API demand comparisons. Capability leads, while
 * useful surface area and interactive speed let efficient models compete.
 */
export function apiDemandQuality(input: {
  capability: number;
  featureScore: number;
  tokPerSec?: number;
  valueIndex?: number;
}): number {
  if (input.valueIndex != null) return Math.max(5, input.valueIndex);
  const speedBonus = Math.log10(Math.max(1, input.tokPerSec ?? 1) + 9) * 4;
  return Math.max(
    10,
    input.capability + input.featureScore * 0.22 + speedBonus,
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Shared API pricing status used by demand and UI. Peer prices are normalized
 * by capability and useful feature coverage before comparison.
 */
export function analyzeApiPricing(input: {
  price: number;
  marginalCost: number;
  capability: number;
  featureScore: number;
  tokPerSec?: number;
  kind?: string;
  peers: ApiPeerPrice[];
}): PricingDiagnostic {
  const ownQuality = apiDemandQuality(input);
  const normalizedPeers = input.peers
    .filter((peer) => peer.price >= 0)
    .map((peer) => {
      const peerQuality = apiDemandQuality(peer);
      return peer.price * (ownQuality / peerQuality);
    });
  const peerMedian = median(normalizedPeers);
  const ratioToPeer =
    peerMedian != null
      ? input.price / Math.max(API_PRICE_EPSILON, peerMedian)
      : null;
  const priceMarkupRatio = markupRatio(input.price, input.marginalCost);
  const priceMarginPct = marginPct(input.price, input.marginalCost);
  const capabilityLead =
    input.peers.length > 0
      ? input.capability -
        Math.max(...input.peers.map((peer) => peer.capability))
      : 0;
  const featureLead =
    input.peers.length > 0
      ? input.featureScore -
        Math.max(...input.peers.map((peer) => peer.featureScore))
      : 0;
  const signals: PricingSignal[] = [];
  if (input.price < input.marginalCost * 1.1) signals.push("below_cost");
  if (ratioToPeer != null && ratioToPeer < 0.75 && priceMarkupRatio >= 1.1) {
    signals.push("undercutting");
  }
  if (
    ratioToPeer != null &&
    ratioToPeer > 1.5 &&
    capabilityLead < 5 &&
    featureLead < 15
  ) {
    signals.push("expensive");
  }
  const demandPenalty = apiDemandPricePenalty({
    ratioToPeer,
    kind: input.kind,
    capabilityLead,
    featureLead,
  });
  if (demandPenalty >= 4.75) signals.push("demand_collapse");
  const primary: PricingSignal = signals.includes("demand_collapse")
    ? "demand_collapse"
    : signals.includes("below_cost")
      ? "below_cost"
      : signals.includes("expensive")
        ? "expensive"
        : signals.includes("undercutting")
          ? "undercutting"
          : "fair";
  const severity =
    primary === "below_cost" || primary === "demand_collapse"
      ? "danger"
      : primary === "fair"
        ? "ok"
        : "amber";
  const explanation =
    primary === "below_cost"
      ? "Blended price is below 1.10× marginal serving cost."
      : primary === "undercutting"
        ? "Profitable price is over 25% below the quality-adjusted peer median."
        : primary === "expensive"
          ? "Price is over 1.50× peers without a clear capability or feature lead."
          : primary === "demand_collapse"
            ? "Price is far above quality-adjusted peer value; demand and brand pressure rise gradually."
            : "Price is within the sustainable competitive range.";
  return {
    primary,
    signals,
    severity,
    peerMedian,
    ratioToPeer,
    marginPct: priceMarginPct,
    markupRatio: priceMarkupRatio,
    marginRatio: priceMarginPct,
    capabilityLead,
    featureLead,
    explanation,
  };
}

export interface PlanPeerValue {
  price: number;
  includedMTokPerMonth: number;
  capability: number;
  featureScore: number;
}

export interface PlanPriceUsageSuggestion {
  pricePerMonth: number;
  includedMTokPerMonth: number;
  segment: "free" | "consumer" | "professional" | "enterprise";
  explanation: string;
}

/** Quality-, modality-, and peer-aware subscription recommendation. */
export function suggestPlanPriceAndUsage(input: {
  currentPrice: number;
  currentIncludedMTokPerMonth: number;
  marginalCostPerMTok: number;
  capability: number;
  frontierCapability: number;
  kind: CommercialModelKind;
  peers: PlanPeerValue[];
}): PlanPriceUsageSuggestion {
  const segment =
    input.currentPrice <= 0
      ? "free"
      : input.currentPrice <= 35
        ? "consumer"
        : input.currentPrice <= 180
          ? "professional"
          : "enterprise";
  const modalityMultiplier: Record<CommercialModelKind, number> = {
    language: 1,
    coding: 1.3,
    reasoning: 1.45,
    image: 1.6,
    video: 2.15,
    audio: 1.35,
    omni: 1.7,
  };
  const segmentMultiplier = {
    free: 0.45,
    consumer: 1,
    professional: 1.8,
    enterprise: 3.2,
  }[segment];
  const paidPeers = input.peers.filter(
    (peer) => peer.price > 0 && peer.includedMTokPerMonth > 0,
  );
  const peerPrices = paidPeers.map((peer) => peer.price);
  const peerAllowances = paidPeers.map((peer) => peer.includedMTokPerMonth);
  const peerPrice = median(peerPrices) ?? Math.max(20, input.currentPrice);
  const peerAllowance =
    median(peerAllowances) ?? Math.max(0.06, input.currentIncludedMTokPerMonth);
  const sota = Math.max(
    0,
    Math.min(
      1,
      1 - Math.max(0, input.frontierCapability - input.capability) / 32,
    ),
  );
  const includedMTokPerMonth = Math.max(
    0.06,
    Math.min(
      300,
      peerAllowance *
        segmentMultiplier *
        modalityMultiplier[input.kind] *
        (0.82 + sota * 0.36),
    ),
  );
  const ownQuality = Math.max(10, input.capability);
  const peerQuality =
    median(
      paidPeers.map((peer) =>
        Math.max(10, peer.capability + peer.featureScore * 0.22),
      ),
    ) ?? ownQuality;
  const qualityPremium = Math.max(
    0.65,
    Math.min(1.8, ownQuality / peerQuality),
  );
  const allowancePremium = Math.sqrt(
    includedMTokPerMonth / Math.max(0.06, peerAllowance),
  );
  const costFloor =
    includedMTokPerMonth *
    (0.22 + modalityMultiplier[input.kind] * 0.08) *
    Math.max(0, input.marginalCostPerMTok);
  const pricePerMonth =
    segment === "free"
      ? 0
      : Math.max(
          5,
          Math.min(
            5_000,
            Math.max(
              costFloor * 1.25,
              peerPrice * qualityPremium * allowancePremium,
            ),
          ),
        );
  return {
    pricePerMonth: Math.round(pricePerMonth * 100) / 100,
    includedMTokPerMonth: Math.round(includedMTokPerMonth * 100) / 100,
    segment,
    explanation: `${segment} peers, ${Math.round(sota * 100)}% frontier proximity, and ${input.kind} usage intensity`,
  };
}

export function analyzePlanPricing(input: {
  price: number;
  includedMTokPerMonth: number;
  expectedUtilization: number;
  marginalCostPerMTok: number;
  capability: number;
  featureScore: number;
  peers: PlanPeerValue[];
}): PricingDiagnostic {
  const ownQuality = Math.max(10, input.capability + input.featureScore * 0.22);
  const ownValuePerDollar =
    (input.includedMTokPerMonth * ownQuality) /
    Math.max(0.01, input.price || 0.01);
  const peerValues = input.peers
    .filter((peer) => peer.price > 0 && peer.includedMTokPerMonth > 0)
    .map(
      (peer) =>
        (peer.includedMTokPerMonth *
          Math.max(10, peer.capability + peer.featureScore * 0.22)) /
        peer.price,
    );
  const peerMedianValue = median(peerValues);
  const valueRatio =
    peerMedianValue != null
      ? ownValuePerDollar / Math.max(0.001, peerMedianValue)
      : null;
  const expectedCogs =
    input.includedMTokPerMonth *
    Math.max(0.05, Math.min(1, input.expectedUtilization)) *
    Math.max(0, input.marginalCostPerMTok);
  const planMarginPct = marginPct(input.price, expectedCogs);
  const signals: PricingSignal[] = [];
  if (valueRatio != null && valueRatio < 0.7) signals.push("stingy_plan");
  if (input.price <= 0 ? expectedCogs > 0 : expectedCogs > input.price * 0.9) {
    signals.push("unsustainable_plan");
  }
  const primary: PricingSignal = signals.includes("unsustainable_plan")
    ? "unsustainable_plan"
    : signals.includes("stingy_plan")
      ? "stingy_plan"
      : "fair";
  const severity =
    primary === "unsustainable_plan"
      ? "danger"
      : primary === "fair"
        ? "ok"
        : "amber";
  const explanation =
    primary === "unsustainable_plan"
      ? "Expected serving COGS exceeds 90% of monthly plan revenue."
      : primary === "stingy_plan"
        ? "Included quality-adjusted value per dollar is below 70% of peers."
        : "Plan value and serving cost are in a sustainable range.";
  return {
    primary,
    signals,
    severity,
    peerMedian: peerMedianValue,
    ratioToPeer: valueRatio,
    marginPct: planMarginPct,
    markupRatio: markupRatio(input.price, Math.max(0.001, expectedCogs)),
    marginRatio: planMarginPct,
    capabilityLead: 0,
    featureLead: 0,
    explanation,
  };
}

/** Re-export token-based cost mult (active params + family). */
export function modelCostMult(
  model: Pick<Model, "paramsB" | "activeParamsB" | "family" | "inferCostMult">,
): number {
  return tokenModelCostMult(model);
}

/**
 * Infrastructure cost of serving — settlement composition (energy + rack amort
 * + building opex + leases) × inference share + bandwidth, ÷ capacity.
 * Delegates to the canonical unit-economics estimate.
 */
export function serveInfraCost(
  state: SimState,
  snap: ComputeSnapshot,
  energyPricePerMWh: number,
): {
  energyDay: number;
  amortDay: number;
  buildingOpexDay: number;
  leaseDay: number;
  fixedDay: number;
  /** $/MTok at full inference capacity (variable-ish unit cost) */
  costPerMTok: number;
  capacityMTok: number;
} {
  const components = servingOpsDayEstimate(state, snap, energyPricePerMWh);
  const active = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      isLivePublicModel(m),
  );
  const model =
    active ??
    state.player.models.find((m) => isLivePublicModel(m));
  if (model) {
    const unit = apiUnitCostPerMTok(state, snap, model, {
      energyPricePerMWh,
      forceEstimate: true,
    });
    return {
      energyDay: components.energyDay * components.inferenceShare,
      amortDay: components.amortDay * components.inferenceShare,
      buildingOpexDay: components.buildingOpexDay * components.inferenceShare,
      leaseDay: components.leaseDay * components.inferenceShare,
      fixedDay: unit.opsDay,
      costPerMTok: unit.blended,
      capacityMTok: unit.capacityMTok,
    };
  }
  const capacityMTok = 0.25;
  const costPerMTok = Math.max(
    API_UNIT_COST_FLOOR,
    components.opsDay / capacityMTok + ECONOMY.bandwidthPerMTok,
  );
  return {
    energyDay: components.energyDay * components.inferenceShare,
    amortDay: components.amortDay * components.inferenceShare,
    buildingOpexDay: components.buildingOpexDay * components.inferenceShare,
    leaseDay: components.leaseDay * components.inferenceShare,
    fixedDay: components.opsDay,
    costPerMTok,
    capacityMTok,
  };
}

export function blendApiPrice(priceIn: number, priceOut: number): number {
  return priceIn * API_IN_SHARE + priceOut * API_OUT_SHARE;
}

/**
 * Expand a legacy blended text price into a canonical prefill/decode list
 * while preserving the exact blended value for the 70/30 workload.
 */
export function splitBlendedApiPrice(blendedPrice: number): {
  priceIn: number;
  priceOut: number;
} {
  const blended = Math.max(0, blendedPrice);
  const normalization = blendApiPrice(API_COST_IN_MULT, API_COST_OUT_MULT);
  return {
    priceIn: (blended * API_COST_IN_MULT) / normalization,
    priceOut: (blended * API_COST_OUT_MULT) / normalization,
  };
}

/** Split total MTok into in/out buckets for billing. */
export function splitInOutMTok(totalMTok: number): {
  inMTok: number;
  outMTok: number;
} {
  return {
    inMTok: totalMTok * API_IN_SHARE,
    outMTok: totalMTok * API_OUT_SHARE,
  };
}

export function apiRevenueFromMTok(
  totalMTok: number,
  priceIn: number,
  priceOut: number,
): number {
  const { inMTok, outMTok } = splitInOutMTok(totalMTok);
  return inMTok * priceIn + outMTok * priceOut;
}

export interface NativeApiListPrices {
  perImage?: number | null;
  perAudioMinute?: number | null;
  perVideoSecond?: number | null;
}

/**
 * Convert a product-native list price into the same $/MTok-equivalent unit
 * used by demand and finance. Native pricing is authoritative only when it is
 * explicitly configured; otherwise the visible input/output token list is
 * authoritative. This prevents a $0 token list from silently billing a hidden
 * per-image/per-second floor.
 */
export function commercialApiListPricePerEquivalentMTok(
  kind: CommercialModelKind,
  priceIn: number,
  priceOut: number,
  native?: NativeApiListPrices,
): number {
  if (kind === "image" && native?.perImage != null) {
    return (
      Math.max(0, native.perImage) *
      (1_000_000 / WORKLOAD_TOKENS_PER_INTERACTION.image)
    );
  }
  if (kind === "video" && native?.perVideoSecond != null) {
    const clipsPerMTok = 1_000_000 / WORKLOAD_TOKENS_PER_INTERACTION.video;
    return Math.max(0, native.perVideoSecond) * clipsPerMTok * 8;
  }
  if (kind === "audio" && native?.perAudioMinute != null) {
    const interactionsPerMTok =
      1_000_000 / WORKLOAD_TOKENS_PER_INTERACTION.audio;
    return Math.max(0, native.perAudioMinute) * interactionsPerMTok * 0.5;
  }
  return Math.max(0, blendApiPrice(priceIn, priceOut));
}

/**
 * Bill product-native work. Explicit native prices use images, minutes, or
 * seconds; otherwise the visible input/output token-equivalent list is billed
 * exactly. There is no hidden media floor.
 */
export function apiRevenueForCommercialWork(
  kind: CommercialModelKind,
  equivalentMTok: number,
  priceIn: number,
  priceOut: number,
  native?: NativeApiListPrices,
): number {
  const mtok = Math.max(
    0,
    Number.isFinite(equivalentMTok) ? equivalentMTok : 0,
  );
  return (
    mtok *
    commercialApiListPricePerEquivalentMTok(
      kind,
      Math.max(0, priceIn),
      Math.max(0, priceOut),
      native,
    )
  );
}

/**
 * Cost-based suggested API prices ($ / 1M tokens in & out).
 * `markupPct` 0 = at cost, 100 = 2× cost, 200 = 3×, etc.
 */
/**
 * Cost-based suggested API prices.
 * `costPerMTokBase` should already be model-specific (from serveInfraCost on that Cap).
 * Does **not** re-apply modelCostMult (avoids double-tax on large models).
 */
export function suggestApiInOut(opts: {
  costPerMTokBase: number;
  paramsB: number;
  activeParamsB?: number;
  family: ModelFamily;
  inferCostMult?: number;
  capability?: number;
  markupPct?: number;
  /** When true, scale base cost by this model's intensity vs a reference (legacy). Default false. */
  applyModelMult?: boolean;
}): {
  costIn: number;
  costOut: number;
  priceIn: number;
  priceOut: number;
  blendedCost: number;
  blendedPrice: number;
  markupPct: number;
} {
  let unit = Math.max(0.005, opts.costPerMTokBase);
  if (opts.applyModelMult) {
    unit *= modelCostMult({
      paramsB: opts.paramsB,
      activeParamsB: opts.activeParamsB,
      family: opts.family,
      inferCostMult: opts.inferCostMult ?? 1,
    });
  }
  const sug = suggestApiFromUnitCost({
    costPerMTok: unit,
    markupPct: opts.markupPct,
  });
  return {
    ...sug,
    blendedCost: blendApiPrice(sug.costIn, sug.costOut),
    blendedPrice: blendApiPrice(sug.priceIn, sug.priceOut),
  };
}

/** Legacy single-price suggestion (blended out-heavy). */
export function suggestedApiPricePerMTok(opts: {
  paramsB: number;
  activeParamsB?: number;
  family: ModelFamily;
  inferCostMult: number;
  capability: number;
  costPerMTokBase?: number;
}): number {
  const s = suggestApiInOut({
    costPerMTokBase: opts.costPerMTokBase ?? FALLBACK_COST_PER_MTOK,
    paramsB: opts.paramsB,
    activeParamsB: opts.activeParamsB,
    family: opts.family,
    inferCostMult: opts.inferCostMult,
    capability: opts.capability,
    markupPct: 120,
  });
  return Math.round(s.blendedPrice * 100) / 100;
}
