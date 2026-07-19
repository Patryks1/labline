import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_ECONOMY,
  SEGMENT_DATA_DEPOSIT,
  normalizeDomainStock,
} from '../balance/data'
import type {
  DataDomain,
  LabData,
  ProcessJob,
  SegmentId,
  StaffHeadcount,
} from '../types'
import {
  appendDatasetAsset,
  processedTrafficDatasetAsset,
} from './dataAssets'

const EMPTY_STAFF: StaffHeadcount = {
  researcher: 0,
  data_processor: 0,
  engineer: 0,
  ops: 0,
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low))
}

/** Defensive copy used by every controller before mutating a corpus day. */
export function cloneLabData(data: LabData): LabData {
  const stocks = {} as LabData['stocks']
  for (const domain of DATA_DOMAINS) {
    stocks[domain] = normalizeDomainStock(data.stocks[domain])
  }
  return {
    ...data,
    stocks,
    assets: (data.assets ?? []).map((asset) => ({
      ...asset,
      domainWeights: { ...asset.domainWeights },
      verticalTags: [...asset.verticalTags],
      synthetic: asset.synthetic
        ? { ...asset.synthetic, teacherModelIds: [...asset.synthetic.teacherModelIds] }
        : undefined,
    })),
    manifests: (data.manifests ?? []).map((manifest) => ({
      ...manifest,
      assetIds: [...manifest.assetIds],
      domainWeights: { ...manifest.domainWeights },
    })),
    processQueue: (data.processQueue ?? []).map((job) => ({ ...job })),
    pruneQueue: (data.pruneQueue ?? []).map((job) => ({ ...job })),
    synthQueue: (data.synthQueue ?? []).map((job) => ({ ...job })),
    dayCollectByDomain: { ...(data.dayCollectByDomain ?? {}) },
    dataGenResearchShare: data.dataGenResearchShare ?? 0,
    daySynthMTok: data.daySynthMTok ?? 0,
  }
}

export interface TrafficCollectionInput {
  data: LabData
  servedMTok: number
  demandMTok: number
  brandTrust: number
  dataFlywheel: number
  segments: readonly { id: SegmentId; size: number }[]
}

export interface TrafficCollectionResult {
  data: LabData
  brandTrust: number
  collectedMTok: number
}

/**
 * Convert served useful-task traffic into raw domain data. The caller decides
 * how much traffic a lab served; controller identity never changes the yield.
 */
export function collectTrafficData(input: TrafficCollectionInput): TrafficCollectionResult {
  const data = cloneLabData(input.data)
  data.dayCollected = 0
  data.dayCollectByDomain = {}
  const served = Math.max(0, input.servedMTok)
  if (served <= 0.001) {
    return { data, brandTrust: input.brandTrust, collectedMTok: 0 }
  }

  const rate = clamp(data.collectionRate, 0, 1)
  const brandFactor = 0.55 + clamp(input.brandTrust, 0, 100) / 200
  // Repeated prompts, model outputs, retries, and template traffic are not
  // independent training examples. Daily novelty therefore grows
  // sublinearly instead of turning market share directly into an unlimited
  // high-quality-token flywheel.
  const noveltyScaleMTok = 500
  const novelServed =
    noveltyScaleMTok * Math.log1p(served / noveltyScaleMTok)
  const base =
    novelServed *
    DATA_ECONOMY.collectMTokPerServedMTok *
    rate *
    brandFactor *
    (1 + Math.max(0, input.dataFlywheel) * 0.5)
  const segmentTotal = input.segments.reduce((sum, segment) => sum + Math.max(0, segment.size), 0) || 1
  const servedRatio = served / Math.max(1, input.demandMTok || served)

  for (const segment of input.segments) {
    const deposits = SEGMENT_DATA_DEPOSIT[segment.id]
    if (!deposits) continue
    const chunk =
      base *
      (Math.max(0, segment.size) / segmentTotal) *
      (0.7 + clamp(servedRatio, 0, 1) * 0.3)
    for (const [domain, weight] of Object.entries(deposits) as [DataDomain, number][]) {
      const add = chunk * Math.max(0, weight)
      if (add <= 0) continue
      data.stocks[domain].raw += add
      data.dayCollected += add
      data.lifetimeCollected += add
      data.dayCollectByDomain[domain] = (data.dayCollectByDomain[domain] ?? 0) + add
    }
  }

  const privacyHit =
    rate > 0.7 && served > 5
      ? DATA_ECONOMY.privacyBrandHit * (rate - 0.65) * Math.min(2, served / 20)
      : 0
  return {
    data,
    brandTrust: Math.max(5, input.brandTrust - privacyHit),
    collectedMTok: data.dayCollected,
  }
}

/** Shared headcount conversion. Equal staff always produces equal throughput. */
export function dataStaffThroughput(staff: StaffHeadcount = EMPTY_STAFF): number {
  const processors = Math.max(0, staff.data_processor ?? 0)
  if (processors <= 0) return 4
  return 6 + processors * 18 + Math.max(0, staff.ops ?? 0) * 2.5
}

export function dataProcessingThroughput(input: {
  staff?: StaffHeadcount
  researchPf: number
  labSites: number
  dataFlywheel: number
}): number {
  const base =
    dataStaffThroughput(input.staff ?? EMPTY_STAFF) +
    Math.max(0, input.researchPf) * 4 +
    Math.max(0, input.labSites) * 4
  return base * (1 + Math.max(0, input.dataFlywheel) * 0.4)
}

export function defaultProcessingQualityTarget(
  dataQuality: number,
  staff: StaffHeadcount = EMPTY_STAFF,
): number {
  const staffSkill = Math.log2(1 + Math.max(0, staff.data_processor ?? 0))
  return clamp(55 + staffSkill * 8 + (dataQuality - 1) * 12, 30, 95)
}

export function resolvedProcessingQuality(
  requestedQuality: number,
  dataQuality: number,
  staff: StaffHeadcount = EMPTY_STAFF,
): number {
  const staffSkill = Math.log2(1 + Math.max(0, staff.data_processor ?? 0))
  return clamp(requestedQuality * 0.7 + dataQuality * 12 + staffSkill * 4, 0, 95)
}

export function enqueueAutomaticProcessing(input: {
  data: LabData
  day: number
  labId: string
  dataQuality: number
  staff?: StaffHeadcount
  priorityDomains?: readonly DataDomain[]
}): LabData {
  const data = cloneLabData(input.data)
  if (!data.autoProcess || data.processQueue.length >= DATA_ECONOMY.maxProcessJobs) return data
  const priority = new Map(
    (input.priorityDomains ?? []).map((domain, index) => [domain, index]),
  )
  const ranked = [...DATA_DOMAINS].sort((a, b) => {
    const pa = priority.get(a)
    const pb = priority.get(b)
    if (pa != null || pb != null) {
      if (pa == null) return 1
      if (pb == null) return -1
      if (pa !== pb) return pa - pb
    }
    return data.stocks[b].raw - data.stocks[a].raw || a.localeCompare(b)
  })
  for (const domain of ranked) {
    if (data.processQueue.length >= DATA_ECONOMY.maxProcessJobs) break
    // Small but meaningful traffic deposits still deserve canonical
    // provenance. Waiting for a 2 MTok batch made early user collections
    // invisible even when the lab had idle processing capacity.
    if (data.stocks[domain].raw <= 0.001) continue
    if (data.processQueue.some((job) => job.domain === domain)) continue
    const take = Math.min(data.stocks[domain].raw, 40)
    data.stocks[domain].raw -= take
    data.processQueue.push({
      id: `proc-auto-${input.day}-${input.labId}-${domain}`,
      domain,
      remaining: take,
      total: take,
      qualityTarget: defaultProcessingQualityTarget(
        input.dataQuality,
        input.staff ?? EMPTY_STAFF,
      ),
    })
  }
  return data
}

export interface ProcessDataJobsResult {
  data: LabData
  cash: number
  cashSpent: number
  processedMTok: number
  blockedForCash: boolean
}

/** Process queued raw data with conserved cash and hardness-adjusted capacity. */
export function processDataJobs(input: {
  data: LabData
  cash: number
  throughputMTok: number
  dataQuality: number
  staff?: StaffHeadcount
  day: number
}): ProcessDataJobsResult {
  let data = cloneLabData(input.data)
  let cash = input.cash
  let throughput = Math.max(0, input.throughputMTok)
  let cashSpent = 0
  let processedMTok = 0
  let blockedForCash = false
  const queue: ProcessJob[] = []

  for (const job of data.processQueue) {
    if (throughput <= 0.001) {
      queue.push(job)
      continue
    }
    const meta = DATA_DOMAIN_META[job.domain]
    const step = Math.min(job.remaining, throughput / meta.processHard)
    const cost = step * meta.processCostPerMTok
    if (step <= 0) {
      queue.push(job)
      continue
    }
    if (cash + 1e-9 < cost) {
      blockedForCash = true
      queue.push(job)
      continue
    }

    cash -= cost
    cashSpent += cost
    throughput -= step * meta.processHard
    processedMTok += step
    const left = job.remaining - step
    const stock = data.stocks[job.domain]
    const quality = resolvedProcessingQuality(
      job.qualityTarget,
      input.dataQuality,
      input.staff ?? EMPTY_STAFF,
    )
    const newProcessed = stock.processed + step
    stock.quality =
      newProcessed > 0
        ? (stock.quality * stock.processed + quality * step) / newProcessed
        : quality
    stock.processed = newProcessed
    stock.fromUser = (stock.fromUser ?? 0) + step * 0.85
    stock.fromWeb = (stock.fromWeb ?? 0) + step * 0.15
    data.dayProcessed += step
    data.lifetimeProcessed += step
    const automaticTraffic = job.id.startsWith('proc-auto-')
    const assetId = automaticTraffic
      ? `dataset-processed-traffic-${job.domain}`
      : `dataset-${job.id}`
    const priorAsset = data.assets.find((asset) => asset.id === assetId)
    data = appendDatasetAsset(
      data,
      processedTrafficDatasetAsset({
        id: assetId,
        domain: job.domain,
        // Automatic product traffic is one reusable domain asset, not one
        // persisted dataset per day. Manual/licensed jobs retain their IDs.
        volumeMTok: automaticTraffic
          ? (priorAsset?.volumeMTok ?? 0) + step
          : job.total - left,
        quality,
        day: input.day,
      }),
    )
    if (left > 0.5) queue.push({ ...job, remaining: left })
  }
  data.processQueue = queue
  return { data, cash, cashSpent, processedMTok, blockedForCash }
}

/** Same aggregate quality update for every lab after processing/synthesis. */
export function updateDataQualityIndex(current: number, data: LabData): number {
  let weightedQuality = 0
  let weight = 0
  for (const domain of DATA_DOMAINS) {
    const stock = data.stocks[domain]
    if (stock.processed <= 0) continue
    weightedQuality += stock.quality * stock.processed
    weight += stock.processed
  }
  if (weight <= 0) return current
  const target = 0.8 + weightedQuality / weight / 100
  return clamp(current * 0.97 + target * 0.03, 0.8, 2.8)
}

/** Domain-aware synthetic volume conversion; policy only chooses its inputs. */
export function syntheticGenerationMTokPerDay(input: {
  domain: DataDomain
  teacherDomainCapability: number
  teacherReliability: number
  researchPf: number
  tier: 'hq' | 'lq'
}): number {
  const speedMultiplier = input.tier === 'lq' ? 1.65 : 0.85
  return (
    DATA_DOMAIN_META[input.domain].synthMTokPerPfDay *
    (0.5 + clamp(input.teacherDomainCapability, 0, 100) / 100) *
    Math.max(0.4, clamp(input.teacherReliability, 0, 100) / 80) *
    speedMultiplier *
    Math.max(0, input.researchPf)
  )
}
