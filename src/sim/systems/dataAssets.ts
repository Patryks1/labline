import { seededId } from '../rng'
import type {
  DataDomain,
  DataManifest,
  DatasetAsset,
  DatasetSource,
  LabData,
  SyntheticProvenance,
} from '../types'

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function appendDatasetAsset(data: LabData, asset: DatasetAsset): LabData {
  const existing = (data.assets ?? []).find((candidate) => candidate.id === asset.id)
  const assets = existing
    ? (data.assets ?? []).map((candidate) =>
        candidate.id === asset.id
          ? {
              ...asset,
              volumeMTok: Math.max(0, asset.volumeMTok),
              acquiredDay: Math.min(candidate.acquiredDay, asset.acquiredDay),
            }
          : candidate,
      )
    : [...(data.assets ?? []), { ...asset, volumeMTok: Math.max(0, asset.volumeMTok) }]
  return { ...data, assets }
}

/**
 * Stable identity for a recurring market corpus. Market listings are refreshed
 * with day-scoped order IDs, but a lab buying the same corpus from the same
 * seller is extending one inspectable provenance lineage rather than creating
 * an unbounded series of equivalent assets.
 */
export function marketDatasetLineageId(input: {
  labId: string
  domain: DataDomain
  name: string
  sellerKind: string
  sellerName?: string
  qualityBand: string
  offerSource: string
}): string {
  return seededId(
    'dataset-market-lineage',
    input.labId,
    input.domain,
    input.name,
    input.sellerKind,
    input.sellerName ?? 'unknown-seller',
    input.qualityBand,
    input.offerSource,
  )
}

/** Merge another purchased lot into a canonical lineage without losing totals. */
export function mergeRecurringDatasetAsset(
  prior: DatasetAsset | undefined,
  incoming: DatasetAsset,
): DatasetAsset {
  if (!prior) return incoming
  const priorVolume = Math.max(0, prior.volumeMTok)
  const incomingVolume = Math.max(0, incoming.volumeMTok)
  const volumeMTok = priorVolume + incomingVolume
  const weighted = (before: number, after: number) =>
    volumeMTok > 0
      ? (before * priorVolume + after * incomingVolume) / volumeMTok
      : after
  const domains = new Set([
    ...Object.keys(prior.domainWeights),
    ...Object.keys(incoming.domainWeights),
  ] as DataDomain[])
  const domainWeights: Partial<Record<DataDomain, number>> = {}
  for (const domain of domains) {
    domainWeights[domain] = weighted(
      prior.domainWeights[domain] ?? 0,
      incoming.domainWeights[domain] ?? 0,
    )
  }

  return {
    ...incoming,
    id: prior.id,
    name: prior.name,
    volumeMTok,
    domainWeights,
    verticalTags: [...new Set([...prior.verticalTags, ...incoming.verticalTags])],
    quality: weighted(prior.quality, incoming.quality),
    diversity: weighted(prior.diversity, incoming.diversity),
    freshness: weighted(prior.freshness, incoming.freshness),
    contaminationRisk: weighted(
      prior.contaminationRisk,
      incoming.contaminationRisk,
    ),
    exclusiveUntilDay:
      prior.exclusiveUntilDay == null && incoming.exclusiveUntilDay == null
        ? null
        : Math.max(
            prior.exclusiveUntilDay ?? -Infinity,
            incoming.exclusiveUntilDay ?? -Infinity,
          ),
    acquiredDay: Math.min(prior.acquiredDay, incoming.acquiredDay),
  }
}

export const SYNTHETIC_TEACHER_LINEAGE_LIMIT = 16

/**
 * Merge successive generations into one canonical domain/tier asset. Domain
 * stocks already carry the exact aggregate token quantities; this asset keeps
 * the inspectable provenance and weighted quality without persisting one
 * almost-identical record per retired teacher model.
 */
export function mergeSyntheticDatasetAsset(
  prior: DatasetAsset | undefined,
  incoming: DatasetAsset,
): DatasetAsset {
  if (!prior || prior.source !== 'synthetic' || incoming.source !== 'synthetic') {
    return incoming
  }
  const priorVolume = Math.max(0, prior.volumeMTok)
  const incomingVolume = Math.max(0, incoming.volumeMTok)
  const volumeMTok = priorVolume + incomingVolume
  const weighted = (before: number, after: number) =>
    volumeMTok > 0
      ? (before * priorVolume + after * incomingVolume) / volumeMTok
      : after
  const teachers = [
    ...(prior.synthetic?.teacherModelIds ?? []),
    ...(incoming.synthetic?.teacherModelIds ?? []),
  ].filter((teacherId, index, values) => values.indexOf(teacherId) === index)
  const teacherModelIds = teachers.slice(-SYNTHETIC_TEACHER_LINEAGE_LIMIT)

  return {
    ...incoming,
    volumeMTok,
    quality: weighted(prior.quality, incoming.quality),
    diversity: weighted(prior.diversity, incoming.diversity),
    contaminationRisk: weighted(prior.contaminationRisk, incoming.contaminationRisk),
    acquiredDay: Math.min(prior.acquiredDay, incoming.acquiredDay),
    synthetic: incoming.synthetic
      ? {
          ...incoming.synthetic,
          teacherModelIds,
          generationDepth: Math.max(
            prior.synthetic?.generationDepth ?? 1,
            incoming.synthetic.generationDepth,
          ),
        }
      : prior.synthetic,
  }
}

export function marketDatasetAsset(input: {
  id: string
  name: string
  domain: DataDomain
  quantityMTok: number
  quality: number
  qualityBand: 'scrap' | 'standard' | 'premium' | 'curated'
  sellerKind: string
  sellerName?: string
  offerSource: 'web' | 'scrap' | 'licensed'
  day: number
}): DatasetAsset {
  const publicSource = input.sellerKind === 'opensource' || input.offerSource === 'web'
  const source: DatasetSource =
    input.sellerKind === 'opensource'
      ? 'opensource'
      : input.sellerKind === 'enterprise' || input.sellerKind === 'research_lab'
        ? 'partner'
        : input.sellerKind === 'web_scrape'
          ? 'web'
          : 'expert'
  const bandDiversity = {
    scrap: 0.38,
    standard: 0.58,
    premium: 0.74,
    curated: 0.86,
  }[input.qualityBand]
  return {
    id: input.id,
    name: input.name,
    volumeMTok: Math.max(0, input.quantityMTok),
    domainWeights: { [input.domain]: 1 },
    verticalTags: [
      input.domain,
      input.sellerKind,
      input.sellerName ?? 'unknown-seller',
      input.qualityBand,
      input.offerSource,
    ],
    quality: Math.max(0, Math.min(100, input.quality)),
    diversity: bandDiversity,
    freshness: publicSource ? 0.68 : 0.82,
    rights: publicSource ? 'public' : input.offerSource === 'licensed' ? 'licensed' : 'restricted',
    source,
    exclusiveUntilDay: null,
    contaminationRisk: clamp01(
      (100 - input.quality) / 220 + (input.qualityBand === 'scrap' ? 0.22 : 0.03),
    ),
    acquiredDay: input.day,
  }
}

export function syntheticDatasetAsset(input: {
  id: string
  name: string
  domain: DataDomain
  volumeMTok: number
  quality: number
  teacherModelId: string
  tier: 'hq' | 'lq'
  day: number
  provenance?: Partial<SyntheticProvenance>
}): DatasetAsset {
  const provenance: SyntheticProvenance = {
    method: input.tier === 'hq' ? 'filtered' : 'imitation',
    teacherModelIds: [input.teacherModelId],
    generationDepth: 1,
    promptDiversity: input.tier === 'hq' ? 0.72 : 0.42,
    verifierStrength: input.domain === 'code' || input.domain === 'math' ? 0.35 : 0.08,
    candidatesPerAccepted: input.tier === 'hq' ? 5 : 1,
    humanAnchorShare: input.tier === 'hq' ? 0.18 : 0.04,
    ...input.provenance,
  }
  return {
    id: input.id,
    name: input.name,
    volumeMTok: Math.max(0, input.volumeMTok),
    domainWeights: { [input.domain]: 1 },
    verticalTags: [input.domain, 'synthetic', input.tier],
    quality: Math.max(0, Math.min(100, input.quality)),
    diversity: provenance.promptDiversity,
    freshness: 1,
    rights: 'owned',
    source: 'synthetic',
    exclusiveUntilDay: null,
    contaminationRisk: input.tier === 'hq' ? 0.09 : 0.28,
    synthetic: provenance,
    acquiredDay: input.day,
  }
}

export function processedTrafficDatasetAsset(input: {
  id: string
  domain: DataDomain
  volumeMTok: number
  quality: number
  day: number
}): DatasetAsset {
  return {
    id: input.id,
    name: `Processed ${input.domain} product traffic`,
    volumeMTok: Math.max(0, input.volumeMTok),
    domainWeights: { [input.domain]: 1 },
    verticalTags: [input.domain, 'product-traffic'],
    quality: Math.max(0, Math.min(100, input.quality)),
    diversity: 0.64,
    freshness: 0.96,
    rights: 'restricted',
    source: 'user',
    exclusiveUntilDay: null,
    contaminationRisk: 0.08,
    acquiredDay: input.day,
  }
}

/** Captures the exact corpus catalogue and method-independent quality assumptions at run start. */
export function createDataManifest(input: {
  data: LabData
  consumed: Partial<Record<DataDomain, number>>
  totalMTok: number
  day: number
  seed: number
  runId: string
}): { data: LabData; manifest: DataManifest } {
  const consumedDomains = Object.entries(input.consumed).filter(
    ([, amount]) => (amount ?? 0) > 0,
  ) as [DataDomain, number][]
  const allocations = new Map<DatasetAsset, number>()
  let uniqueMTok = 0

  for (const [domain, requestedRaw] of consumedDomains) {
    const requested = Math.max(0, requestedRaw)
    const domainAssets = (input.data.assets ?? [])
      .map((asset) => ({
        asset,
        available:
          Math.max(0, asset.volumeMTok) *
          Math.max(0, asset.domainWeights[domain] ?? 0),
      }))
      .filter(({ available }) => available > 0)
    const available = domainAssets.reduce((sum, lot) => sum + lot.available, 0)
    const consumed = Math.min(requested, available)
    uniqueMTok += consumed
    if (available <= 0 || consumed <= 0) continue

    // Stocks expose blended domain inventory rather than lot selection. Use a
    // proportional draw so manifest quality/contamination matches that blend,
    // while no asset can supply more than its domain-weighted share.
    for (const { asset, available: assetAvailable } of domainAssets) {
      const allocated = consumed * (assetAvailable / available)
      allocations.set(asset, (allocations.get(asset) ?? 0) + allocated)
    }
  }

  const allocatedMTok = [...allocations.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  )
  const quality =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + asset.quality * amount,
          0,
        ) / allocatedMTok
      : 0
  const contamination =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + asset.contaminationRisk * amount,
          0,
        ) / allocatedMTok
      : 0
  const total = Math.max(0, input.totalMTok)
  const manifest: DataManifest = {
    id: seededId('manifest', input.seed, input.day, input.runId),
    assetIds: [...allocations.keys()].map((asset) => asset.id).sort(),
    domainWeights: Object.fromEntries(
      consumedDomains.map(([domain, amount]) => [domain, (amount ?? 0) / Math.max(1e-9, total)]),
    ),
    uniqueMTok: Math.min(total, uniqueMTok),
    repeatedMTok: Math.max(0, total - uniqueMTok),
    effectiveQuality: quality,
    contaminationRisk: contamination,
    createdDay: input.day,
  }
  return {
    data: {
      ...input.data,
      manifests: [...(input.data.manifests ?? []), manifest],
    },
    manifest,
  }
}
