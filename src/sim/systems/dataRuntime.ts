import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_ECONOMY,
  SEGMENT_DATA_DEPOSIT,
  normalizeDomainStock,
} from "../balance/data";
import type {
  DataDomain,
  LabData,
  ProcessJob,
  SegmentId,
  StaffHeadcount,
} from "../types";
import {
  appendDatasetAsset,
  marketDatasetAsset,
  mergeRecurringDatasetAsset,
  processedTrafficDatasetAsset,
} from "./dataAssets";
import { effectivePlanDataCollectionRate } from "./plans";
import { activeBalanceTuning } from "../balance/tuning";

const EMPTY_STAFF: StaffHeadcount = {
  researcher: 0,
  data_processor: 0,
  engineer: 0,
  ops: 0,
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

/** Defensive copy used by every controller before mutating a corpus day. */
export function cloneLabData(data: LabData): LabData {
  const stocks = {} as LabData["stocks"];
  for (const domain of DATA_DOMAINS) {
    stocks[domain] = normalizeDomainStock(data.stocks[domain]);
  }
  return {
    ...data,
    stocks,
    assets: (data.assets ?? []).map((asset) => ({
      ...asset,
      domainWeights: { ...asset.domainWeights },
      verticalTags: [...asset.verticalTags],
      synthetic: asset.synthetic
        ? {
            ...asset.synthetic,
            teacherModelIds: [...asset.synthetic.teacherModelIds],
          }
        : undefined,
    })),
    manifests: (data.manifests ?? []).map((manifest) => ({
      ...manifest,
      assetIds: [...manifest.assetIds],
      domainWeights: { ...manifest.domainWeights },
    })),
    processQueue: (data.processQueue ?? []).map((job) => ({ ...job })),
    pruneQueue: (data.pruneQueue ?? []).map((job) => ({ ...job })),
    synthQueue: (data.synthQueue ?? []).map((job) => ({
      ...job,
      teacherModelIds: job.teacherModelIds
        ? { ...job.teacherModelIds }
        : undefined,
    })),
    dayCollectByDomain: { ...(data.dayCollectByDomain ?? {}) },
    dayCollectChatFree: data.dayCollectChatFree ?? 0,
    dayCollectChatPaid: data.dayCollectChatPaid ?? 0,
    dataGenResearchShare: data.dataGenResearchShare ?? 0,
    daySynthMTok: data.daySynthMTok ?? 0,
  };
}

/** Per-plan served traffic used to apply free/paid collection caps. */
export interface TrafficPlanSlice {
  id: string;
  pricePerMonth: number;
  servedMTok: number;
  /** Desired collect share (0–1); capped by plan price policy. */
  dataCollectionRate?: number;
}

export interface TrafficCollectionInput {
  data: LabData;
  servedMTok: number;
  demandMTok: number;
  brandTrust: number;
  dataFlywheel: number;
  segments: readonly { id: SegmentId; size: number }[];
  /**
   * When present with measurable plan volume, collection uses per-plan rates
   * (free up to 100%, paid ≤ $50 capped, paid > $50 blocked). Otherwise the
   * legacy global `collectionRate` multiplies total served traffic.
   */
  planSlices?: readonly TrafficPlanSlice[];
}

export interface TrafficCollectionResult {
  data: LabData;
  brandTrust: number;
  collectedMTok: number;
}

export function resolveCollectableServed(input: {
  servedMTok: number;
  collectionRate: number;
  planSlices?: readonly TrafficPlanSlice[];
}): {
  /** Served MTok after per-plan (or global) collect rates — feeds novelty. */
  effectiveServedMTok: number;
  freeEffectiveMTok: number;
  paidEffectiveMTok: number;
  /** Volume-weighted effective rate for privacy pressure. */
  privacyRate: number;
} {
  const served = Math.max(0, input.servedMTok);
  const slices = input.planSlices ?? [];
  const planServed = slices.reduce(
    (sum, slice) => sum + Math.max(0, slice.servedMTok),
    0,
  );

  if (planServed > 0.001) {
    let freeEffective = 0;
    let paidEffective = 0;
    let rateWeight = 0;
    for (const slice of slices) {
      const setting =
        slice.dataCollectionRate !== undefined &&
        Number.isFinite(slice.dataCollectionRate)
          ? slice.dataCollectionRate
          : input.collectionRate;
      const eff = effectivePlanDataCollectionRate(slice.pricePerMonth, setting);
      const part = Math.max(0, slice.servedMTok) * eff;
      if (slice.pricePerMonth <= 0) freeEffective += part;
      else paidEffective += part;
      rateWeight += Math.max(0, slice.servedMTok) * eff;
    }
    const effective = freeEffective + paidEffective;
    return {
      effectiveServedMTok: effective,
      freeEffectiveMTok: freeEffective,
      paidEffectiveMTok: paidEffective,
      privacyRate: planServed > 1e-9 ? rateWeight / planServed : 0,
    };
  }

  const rate = clamp(input.collectionRate, 0, 1);
  return {
    effectiveServedMTok: served * rate,
    freeEffectiveMTok: served * rate,
    paidEffectiveMTok: 0,
    privacyRate: rate,
  };
}

/**
 * Convert served useful-task traffic into raw domain data. The caller decides
 * how much traffic a lab served; controller identity never changes the yield.
 */
export function collectTrafficData(
  input: TrafficCollectionInput,
): TrafficCollectionResult {
  const data = cloneLabData(input.data);
  data.dayCollected = 0;
  data.dayCollectByDomain = {};
  data.dayCollectChatFree = 0;
  data.dayCollectChatPaid = 0;
  const served = Math.max(0, input.servedMTok);
  if (served <= 0.001) {
    return { data, brandTrust: input.brandTrust, collectedMTok: 0 };
  }

  const collectable = resolveCollectableServed({
    servedMTok: served,
    collectionRate: data.collectionRate,
    planSlices: input.planSlices,
  });
  const planServed = (input.planSlices ?? []).reduce(
    (sum, slice) => sum + Math.max(0, slice.servedMTok),
    0,
  );
  const usingPlanTiers = planServed > 0.001;
  if (usingPlanTiers && collectable.effectiveServedMTok <= 0.001) {
    return { data, brandTrust: input.brandTrust, collectedMTok: 0 };
  }

  const rate = usingPlanTiers
    ? collectable.privacyRate
    : clamp(data.collectionRate, 0, 1);
  const brandFactor = 0.55 + clamp(input.brandTrust, 0, 100) / 200;
  // Repeated prompts, model outputs, retries, and template traffic are not
  // independent training examples. Daily novelty therefore grows
  // sublinearly instead of turning market share directly into an unlimited
  // high-quality-token flywheel.
  const noveltyScaleMTok = 500;
  // Legacy (no plan volume): novelty on full served, then × global rate.
  // Plan tiers: novelty on rate-weighted collectable served (caps baked in).
  const noveltyInput = usingPlanTiers
    ? collectable.effectiveServedMTok
    : served;
  const novelServed =
    noveltyScaleMTok * Math.log1p(noveltyInput / noveltyScaleMTok);
  const rateMult = usingPlanTiers ? 1 : rate;
  const base =
    novelServed *
    DATA_ECONOMY.collectMTokPerServedMTok *
    rateMult *
    brandFactor *
    (1 + Math.max(0, input.dataFlywheel) * 0.5);
  const segmentTotal =
    input.segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.size),
      0,
    ) || 1;
  const servedRatio = served / Math.max(1, input.demandMTok || served);

  for (const segment of input.segments) {
    const deposits = SEGMENT_DATA_DEPOSIT[segment.id];
    if (!deposits) continue;
    const chunk =
      base *
      (Math.max(0, segment.size) / segmentTotal) *
      (0.7 + clamp(servedRatio, 0, 1) * 0.3);
    for (const [domain, weight] of Object.entries(deposits) as [
      DataDomain,
      number,
    ][]) {
      const add = chunk * Math.max(0, weight);
      if (add <= 0) continue;
      data.stocks[domain].raw += add;
      data.dayCollected += add;
      data.lifetimeCollected += add;
      data.dayCollectByDomain[domain] =
        (data.dayCollectByDomain[domain] ?? 0) + add;
    }
  }

  const chatCollected = data.dayCollectByDomain.chat ?? 0;
  const tierDenom =
    collectable.freeEffectiveMTok + collectable.paidEffectiveMTok;
  if (chatCollected > 0 && tierDenom > 1e-9) {
    data.dayCollectChatFree =
      chatCollected * (collectable.freeEffectiveMTok / tierDenom);
    data.dayCollectChatPaid =
      chatCollected * (collectable.paidEffectiveMTok / tierDenom);
  }

  const privacyHit =
    rate > 0.7 && served > 5
      ? DATA_ECONOMY.privacyBrandHit * (rate - 0.65) * Math.min(2, served / 20)
      : 0;
  return {
    data,
    brandTrust: Math.max(5, input.brandTrust - privacyHit),
    collectedMTok: data.dayCollected,
  };
}

/** Shared headcount conversion. Equal staff always produces equal throughput. */
export function dataStaffThroughput(
  staff: StaffHeadcount = EMPTY_STAFF,
): number {
  const processors = Math.max(0, staff.data_processor ?? 0);
  if (processors <= 0) return 4;
  return 6 + processors * 18 + Math.max(0, staff.ops ?? 0) * 2.5;
}

export function dataProcessingThroughput(input: {
  staff?: StaffHeadcount;
  researchPf: number;
  labSites: number;
  dataFlywheel: number;
}): number {
  const base =
    dataStaffThroughput(input.staff ?? EMPTY_STAFF) +
    Math.max(0, input.researchPf) * 4 +
    Math.max(0, input.labSites) * 4;
  return base * (1 + Math.max(0, input.dataFlywheel) * 0.4);
}

export function defaultProcessingQualityTarget(
  dataQuality: number,
  staff: StaffHeadcount = EMPTY_STAFF,
): number {
  const staffSkill = Math.log2(1 + Math.max(0, staff.data_processor ?? 0));
  return clamp(55 + staffSkill * 8 + (dataQuality - 1) * 12, 30, 95);
}

export type ProcessingSource = "product_traffic" | "web" | "scrap" | "licensed";

const DOMAIN_ACCEPTANCE_BASE: Record<DataDomain, number> = {
  chat: 0.86,
  code: 0.8,
  math: 0.74,
  science: 0.7,
  law: 0.68,
  health: 0.65,
  image: 0.56,
  audio: 0.52,
  video: 0.32,
};

const SOURCE_ACCEPTANCE_MULT: Record<ProcessingSource, number> = {
  product_traffic: 1,
  licensed: 1.05,
  web: 0.86,
  scrap: 0.65,
};

const SOURCE_EFFORT_MULT: Record<ProcessingSource, number> = {
  licensed: 1,
  web: 1.15,
  product_traffic: 1.1,
  scrap: 1.3,
};

const DOMAIN_QUALITY_CEILING_PENALTY: Record<DataDomain, number> = {
  chat: 0,
  code: 0,
  math: 1,
  science: 1,
  law: 1,
  health: 2,
  image: 3,
  audio: 4,
  video: 6,
};

function jobProcessingSource(job: ProcessJob): ProcessingSource {
  if (job.purchaseLot?.offerSource === "licensed") return "licensed";
  if (job.purchaseLot?.offerSource === "scrap") return "scrap";
  if (job.purchaseLot?.offerSource === "web") return "web";
  return job.id.startsWith("proc-auto-") ? "product_traffic" : "web";
}

function defaultRawQuality(source: ProcessingSource): number {
  if (source === "licensed") return 76;
  if (source === "product_traffic") return 58;
  if (source === "scrap") return 34;
  return 48;
}

export function resolvedProcessingQuality(
  requestedQuality: number,
  dataQuality: number,
  staff: StaffHeadcount = EMPTY_STAFF,
  rawQuality = 55,
  domain: DataDomain = "chat",
): number {
  const staffSkill = Math.log2(1 + Math.max(0, staff.data_processor ?? 0));
  // Filtering can select the better examples in a source, but a high slider
  // setting cannot turn noisy raw material into arbitrarily good output. Both
  // lab capability and source quality impose independent ceilings.
  const labCeiling =
    52 + (clamp(dataQuality, 0.5, 3) - 1) * 18 + staffSkill * 5;
  const sourceCeiling =
    clamp(rawQuality, 5, 98) +
    5 +
    (clamp(dataQuality, 0.5, 3) - 1) * 8 +
    staffSkill * 2 -
    DOMAIN_QUALITY_CEILING_PENALTY[domain];
  return clamp(
    Math.min(clamp(requestedQuality, 0, 95), labCeiling, sourceCeiling),
    5,
    95,
  );
}

/**
 * Fraction of inspected raw records accepted into the training-ready corpus.
 * Yield depends on modality, source cleanliness, listed/raw quality, and the
 * requested strictness. Video and image have much lower usable yield because
 * decode failures, weak captions, temporal defects, and perceptual duplicates
 * are inspected and rejected rather than silently becoming text-equivalents.
 */
export function processingAcceptanceYield(
  qualityTarget: number,
  domain: DataDomain = "chat",
  source: ProcessingSource = "product_traffic",
  rawQuality = defaultRawQuality(source),
): number {
  const strictness = (clamp(qualityTarget, 30, 95) - 30) / 65;
  const strictnessMult = 1 - 0.42 * strictness;
  const rawQualityMult = 0.7 + clamp(rawQuality, 5, 98) / 300;
  return clamp(
    DOMAIN_ACCEPTANCE_BASE[domain] *
      SOURCE_ACCEPTANCE_MULT[source] *
      strictnessMult *
      rawQualityMult,
    0.04,
    0.94,
  );
}

/** Cash charged for every raw MTok inspected, including rejected records. */
export function processingCostPerInspectedMTok(
  domain: DataDomain,
  qualityTarget: number,
  source: ProcessingSource = "web",
): number {
  const strictness = (clamp(qualityTarget, 30, 95) - 30) / 65;
  const strictnessCost = 1 + 1.5 * strictness * strictness;
  return (
    DATA_DOMAIN_META[domain].processCostPerMTok *
    SOURCE_EFFORT_MULT[source] *
    strictnessCost
  );
}

/** Staff/PF throughput is consumed by inspected raw volume, not accepted output. */
export function processingEffortPerInspectedMTok(
  domain: DataDomain,
  qualityTarget: number,
  source: ProcessingSource = "web",
): number {
  const strictness = (clamp(qualityTarget, 30, 95) - 30) / 65;
  return (
    DATA_DOMAIN_META[domain].processHard *
    SOURCE_EFFORT_MULT[source] *
    (1 + 0.75 * strictness * strictness)
  );
}

export function enqueueAutomaticProcessing(input: {
  data: LabData;
  day: number;
  labId: string;
  dataQuality: number;
  staff?: StaffHeadcount;
  priorityDomains?: readonly DataDomain[];
}): LabData {
  const data = cloneLabData(input.data);
  if (
    !data.autoProcess ||
    data.processQueue.length >= DATA_ECONOMY.maxProcessJobs
  )
    return data;
  const priority = new Map(
    (input.priorityDomains ?? []).map((domain, index) => [domain, index]),
  );
  const ranked = [...DATA_DOMAINS].sort((a, b) => {
    const pa = priority.get(a);
    const pb = priority.get(b);
    if (pa != null || pb != null) {
      if (pa == null) return 1;
      if (pb == null) return -1;
      if (pa !== pb) return pa - pb;
    }
    return data.stocks[b].raw - data.stocks[a].raw || a.localeCompare(b);
  });
  for (const domain of ranked) {
    if (data.processQueue.length >= DATA_ECONOMY.maxProcessJobs) break;
    // Small but meaningful traffic deposits still deserve canonical
    // provenance. Waiting for a 2 MTok batch made early user collections
    // invisible even when the lab had idle processing capacity.
    if (data.stocks[domain].raw <= 0.001) continue;
    if (data.processQueue.some((job) => job.domain === domain)) continue;
    const take = Math.min(data.stocks[domain].raw, 40);
    data.stocks[domain].raw -= take;
    data.processQueue.push({
      id: `proc-auto-${input.day}-${input.labId}-${domain}`,
      domain,
      remaining: take,
      total: take,
      qualityTarget: defaultProcessingQualityTarget(
        input.dataQuality,
        input.staff ?? EMPTY_STAFF,
      ),
    });
  }
  return data;
}

export interface ProcessDataJobsResult {
  data: LabData;
  cash: number;
  cashSpent: number;
  /** Raw volume actually inspected; accepted + rejected always equals this. */
  inspectedMTok: number;
  processedMTok: number;
  /** Inspected raw volume rejected by quality, safety, and dedup filters. */
  rejectedMTok: number;
  blockedForCash: boolean;
}

/** Process queued raw data with conserved cash and hardness-adjusted capacity. */
export function processDataJobs(input: {
  data: LabData;
  cash: number;
  throughputMTok: number;
  dataQuality: number;
  staff?: StaffHeadcount;
  day: number;
}): ProcessDataJobsResult {
  let data = cloneLabData(input.data);
  let cash = input.cash;
  let throughput = Math.max(0, input.throughputMTok);
  let cashSpent = 0;
  let inspectedMTok = 0;
  let processedMTok = 0;
  let rejectedMTok = 0;
  let blockedForCash = false;
  const queue: ProcessJob[] = [];

  for (const job of data.processQueue) {
    if (throughput <= 1e-9) {
      queue.push(job);
      continue;
    }
    const source = jobProcessingSource(job);
    const rawQuality = clamp(
      job.purchaseLot?.purchaseQuality ?? defaultRawQuality(source),
      5,
      98,
    );
    const costPerInspectedMTok = processingCostPerInspectedMTok(
      job.domain,
      job.qualityTarget,
      source,
    );
    const effortPerInspectedMTok = processingEffortPerInspectedMTok(
      job.domain,
      job.qualityTarget,
      source,
    );
    const affordable = Math.max(0, cash) / Math.max(1e-9, costPerInspectedMTok);
    const byCapacity = throughput / Math.max(1e-9, effortPerInspectedMTok);
    // Cash, staff/PF throughput, and queue volume are all continuous. Even a
    // cash-constrained lab can make an affordable fractional pass rather than
    // waiting until it can fund a full nominal tick.
    const step = Math.min(job.remaining, byCapacity, affordable);
    if (step <= 1e-9) {
      if (affordable <= 1e-9) blockedForCash = true;
      queue.push(job);
      continue;
    }

    const cost = step * costPerInspectedMTok;
    cash -= cost;
    cashSpent += cost;
    inspectedMTok += step;
    throughput -= step * effortPerInspectedMTok;
    const left = job.remaining - step;
    const stock = data.stocks[job.domain];
    const targetQuality = resolvedProcessingQuality(
      job.qualityTarget,
      input.dataQuality,
      input.staff ?? EMPTY_STAFF,
      rawQuality,
      job.domain,
    );
    // Corpus quality gain knob: scale how fast each accepted lot pulls the
    // stock average toward the job's target quality.
    const qualityGainMult = activeBalanceTuning().dataQualityMult;
    const quality = clamp(
      rawQuality + (targetQuality - rawQuality) * qualityGainMult,
      Math.min(rawQuality, targetQuality),
      targetQuality,
    );
    const accepted =
      step *
      processingAcceptanceYield(
        job.qualityTarget,
        job.domain,
        source,
        rawQuality,
      );
    const rejected = step - accepted;
    processedMTok += accepted;
    rejectedMTok += rejected;
    const newProcessed = stock.processed + accepted;
    stock.quality =
      newProcessed > 0
        ? (stock.quality * stock.processed + quality * accepted) / newProcessed
        : quality;
    stock.processed = newProcessed;
    // Queued raw stock usually comes from consented product traffic. Purchased
    // raw market lots carry their own seller lineage: accepted tokens count as
    // bought stock and extend the recurring market asset instead.
    if (job.purchaseLot) {
      stock.fromBought = (stock.fromBought ?? 0) + accepted;
    } else {
      stock.fromUser = (stock.fromUser ?? 0) + accepted;
    }
    data.dayProcessed += accepted;
    data.lifetimeProcessed += accepted;
    if (job.purchaseLot) {
      const lot = job.purchaseLot;
      const assetId = lot.lineageId;
      const priorAsset = data.assets.find((asset) => asset.id === assetId);
      const incoming = marketDatasetAsset({
        id: assetId,
        name: lot.name,
        domain: job.domain,
        quantityMTok: accepted,
        quality,
        qualityBand: lot.qualityBand,
        sellerKind: lot.sellerKind,
        sellerName: lot.sellerName,
        offerSource: lot.offerSource,
        day: input.day,
      });
      data = appendDatasetAsset(
        data,
        mergeRecurringDatasetAsset(priorAsset, incoming),
      );
      if (left > 1e-9) queue.push({ ...job, remaining: left });
      if (left > 1e-9 && cash <= 1e-6) blockedForCash = true;
      continue;
    }
    const automaticTraffic = job.id.startsWith("proc-auto-");
    const assetId = automaticTraffic
      ? `dataset-processed-traffic-${job.domain}`
      : `dataset-${job.id}`;
    const priorAsset = data.assets.find((asset) => asset.id === assetId);
    const assetVolume = (priorAsset?.volumeMTok ?? 0) + accepted;
    const assetQuality =
      assetVolume > 0
        ? ((priorAsset?.quality ?? quality) * (priorAsset?.volumeMTok ?? 0) +
            quality * accepted) /
          assetVolume
        : quality;
    data = appendDatasetAsset(
      data,
      processedTrafficDatasetAsset({
        id: assetId,
        domain: job.domain,
        // Every partial/automatic pass extends one reusable accepted lineage;
        // rejected raw records never appear as training-ready asset volume.
        volumeMTok: assetVolume,
        quality: assetQuality,
        day: input.day,
      }),
    );
    if (left > 1e-9) queue.push({ ...job, remaining: left });
    if (left > 1e-9 && cash <= 1e-6) blockedForCash = true;
  }
  data.processQueue = queue;
  return {
    data,
    cash,
    cashSpent,
    inspectedMTok,
    processedMTok,
    rejectedMTok,
    blockedForCash,
  };
}

/** Same aggregate quality update for every lab after processing/synthesis. */
export function updateDataQualityIndex(current: number, data: LabData): number {
  let weightedQuality = 0;
  let weight = 0;
  for (const domain of DATA_DOMAINS) {
    const stock = data.stocks[domain];
    if (stock.processed <= 0) continue;
    weightedQuality += stock.quality * stock.processed;
    weight += stock.processed;
  }
  if (weight <= 0) return current;
  const target = 0.8 + weightedQuality / weight / 100;
  return clamp(current * 0.97 + target * 0.03, 0.8, 2.8);
}

/** Domain-aware synthetic volume conversion; policy only chooses its inputs. */
export function syntheticGenerationMTokPerDay(input: {
  domain: DataDomain;
  teacherDomainCapability: number;
  teacherReliability: number;
  researchPf: number;
  tier: "hq" | "lq";
}): number {
  const speedMultiplier = input.tier === "lq" ? 1.65 : 0.85;
  return (
    DATA_DOMAIN_META[input.domain].synthMTokPerPfDay *
    (0.5 + clamp(input.teacherDomainCapability, 0, 100) / 100) *
    Math.max(0.4, clamp(input.teacherReliability, 0, 100) / 80) *
    speedMultiplier *
    Math.max(0, input.researchPf)
  );
}
