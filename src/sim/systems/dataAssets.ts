import { seededId } from "../rng";
import type {
  DataDomain,
  DataManifest,
  DatasetAsset,
  DatasetSource,
  LabData,
  SyntheticProvenance,
  TrainingDataEvidence,
} from "../types";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function qualityTrainingValue(quality: number): number {
  const q = Math.max(0, Math.min(100, quality));
  if (q <= 35) return 0.35;
  if (q <= 55) return 0.35 + ((q - 35) / 20) * 0.3;
  if (q <= 75) return 0.65 + ((q - 55) / 20) * 0.2;
  return Math.min(1, 0.85 + ((q - 75) / 20) * 0.15);
}

function datasetRightsRisk(asset: DatasetAsset): number {
  if (asset.rights === "restricted") return 0.72;
  if (asset.rights === "licensed") return 0.12;
  if (asset.rights === "public") return 0.08;
  return 0.02;
}

/**
 * Materialize only the positive gap between aggregate processed stocks and the
 * canonical asset catalogue. Older saves and tests can legitimately carry
 * stock without asset provenance; this adapter makes that volume attributable
 * without ever deriving volume from requested recipe weights.
 */
function assetsWithAggregateStockFallback(
  data: LabData,
  consumed: Partial<Record<DataDomain, number>>,
): DatasetAsset[] {
  const assets = [...(data.assets ?? [])];
  for (const [domain, rawStock] of Object.entries(data.stocks) as [
    DataDomain,
    LabData["stocks"][DataDomain],
  ][]) {
    if ((consumed[domain] ?? 0) <= 0) continue;
    const processed = Math.max(0, rawStock?.processed ?? 0);
    const hasAnyExplicitAsset = assets.some(
      (asset) => (asset.domainWeights[domain] ?? 0) > 0,
    );
    if (hasAnyExplicitAsset) continue;
    const gap = processed;
    if (gap <= 1e-9) continue;
    const syntheticVolume = Math.max(
      0,
      (rawStock.fromSynthHQ ?? 0) + (rawStock.fromSynthLQ ?? 0),
    );
    const syntheticShare = clamp01(syntheticVolume / Math.max(1e-9, processed));
    assets.push({
      id: `dataset-legacy-stock-${domain}`,
      name: `Imported ${domain} processed stock`,
      volumeMTok: gap,
      domainWeights: { [domain]: 1 },
      verticalTags: [domain, "legacy-stock-fallback"],
      quality: Math.max(0, Math.min(100, rawStock.quality ?? 40)),
      diversity: 0.52,
      freshness: 0.62,
      rights: "restricted",
      source: syntheticShare >= 0.5 ? "synthetic" : "web",
      exclusiveUntilDay: null,
      contaminationRisk: 0.18,
      synthetic:
        syntheticShare >= 0.5
          ? {
              method: "imitation",
              teacherModelIds: [],
              generationDepth: 1,
              promptDiversity: 0.52,
              verifierStrength: 0,
              candidatesPerAccepted: 1,
              humanAnchorShare: 1 - syntheticShare,
            }
          : undefined,
      acquiredDay: 1,
    });
  }
  return assets;
}

export function appendDatasetAsset(
  data: LabData,
  asset: DatasetAsset,
): LabData {
  const existing = (data.assets ?? []).find(
    (candidate) => candidate.id === asset.id,
  );
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
    : [
        ...(data.assets ?? []),
        { ...asset, volumeMTok: Math.max(0, asset.volumeMTok) },
      ];
  return { ...data, assets };
}

export interface DatasetPruneBreakdown {
  webMTok: number;
  userMTok: number;
  boughtMTok: number;
  synthHqMTok: number;
  synthLqMTok: number;
}

export interface DatasetPruneResult {
  data: LabData;
  removedMTok: number;
  /** Quality weighted by removed domain MTok, used to conserve corpus quality. */
  removedQualityMTok: number;
  breakdown: DatasetPruneBreakdown;
}

function emptyPruneBreakdown(): DatasetPruneBreakdown {
  return {
    webMTok: 0,
    userMTok: 0,
    boughtMTok: 0,
    synthHqMTok: 0,
    synthLqMTok: 0,
  };
}

function recordPrunedSource(
  breakdown: DatasetPruneBreakdown,
  asset: DatasetAsset,
  amount: number,
): void {
  if (asset.source === "web" || asset.source === "opensource") {
    breakdown.webMTok += amount;
    return;
  }
  if (asset.source === "user") {
    breakdown.userMTok += amount;
    return;
  }
  if (asset.source !== "synthetic") {
    breakdown.boughtMTok += amount;
    return;
  }
  if (asset.verticalTags.includes("hq")) breakdown.synthHqMTok += amount;
  else breakdown.synthLqMTok += amount;
}

/**
 * Permanently remove a domain slice from the canonical backing assets.
 *
 * Assets are ordered from lowest quality / highest contamination first. For a
 * mixed-domain asset, reducing one domain rewrites its volume and weights while
 * preserving the absolute quantities of every other domain. Historical
 * manifests remain immutable, but future manifests cannot select the removed
 * volume.
 */
export function pruneDatasetAssetsForDomain(input: {
  data: LabData;
  domain: DataDomain;
  amountMTok: number;
}): DatasetPruneResult {
  const assets = (input.data.assets ?? []).map((asset) => ({
    ...asset,
    domainWeights: { ...asset.domainWeights },
    verticalTags: [...asset.verticalTags],
    synthetic: asset.synthetic
      ? {
          ...asset.synthetic,
          teacherModelIds: [...asset.synthetic.teacherModelIds],
          teacherEffortIds: asset.synthetic.teacherEffortIds
            ? [...asset.synthetic.teacherEffortIds]
            : undefined,
          teacherEffortNames: asset.synthetic.teacherEffortNames
            ? [...asset.synthetic.teacherEffortNames]
            : undefined,
        }
      : undefined,
  }));
  const ordered = assets
    .map((asset, index) => ({ asset, index }))
    .filter(
      ({ asset }) =>
        Math.max(0, asset.volumeMTok) *
          Math.max(0, asset.domainWeights[input.domain] ?? 0) >
        1e-9,
    )
    .sort(
      (a, b) =>
        a.asset.quality - b.asset.quality ||
        b.asset.contaminationRisk - a.asset.contaminationRisk ||
        a.asset.acquiredDay - b.asset.acquiredDay ||
        a.asset.id.localeCompare(b.asset.id),
    );

  let remaining = Math.max(0, input.amountMTok);
  let removedMTok = 0;
  let removedQualityMTok = 0;
  const breakdown = emptyPruneBreakdown();

  for (const { asset, index } of ordered) {
    if (remaining <= 1e-9) break;
    const volume = Math.max(0, asset.volumeMTok);
    const domainWeight = Math.max(0, asset.domainWeights[input.domain] ?? 0);
    const available = volume * domainWeight;
    const take = Math.min(remaining, available);
    if (take <= 1e-9) continue;

    const targetRemaining = Math.max(0, available - take);
    const otherVolume = Math.max(0, volume - available);
    // An audit removes the low-quality tail within a blended asset, not a
    // random sample at the asset mean. Split mixed assets so a quality lift in
    // one audited domain cannot launder the untouched domains.
    const removedUnitQuality = Math.min(asset.quality, 22);
    const targetQuality =
      targetRemaining > 1e-9
        ? Math.max(
            asset.quality,
            Math.min(
              95,
              (asset.quality * available - removedUnitQuality * take) /
                targetRemaining,
            ),
          )
        : asset.quality;
    const otherWeights: Partial<Record<DataDomain, number>> = {};
    if (otherVolume > 1e-9) {
      for (const [domain, rawWeight] of Object.entries(asset.domainWeights) as [
        DataDomain,
        number,
      ][]) {
        if (domain === input.domain) continue;
        const priorQuantity = volume * Math.max(0, rawWeight);
        if (priorQuantity > 1e-9)
          otherWeights[domain] = priorQuantity / otherVolume;
      }
    }

    if (otherVolume > 1e-9) {
      assets[index] = {
        ...asset,
        volumeMTok: otherVolume,
        domainWeights: otherWeights,
      };
      if (targetRemaining > 1e-9) {
        assets.push({
          ...asset,
          id: `${asset.id}--${input.domain}-post-prune`,
          name: `${asset.name} · audited ${input.domain}`,
          volumeMTok: targetRemaining,
          domainWeights: { [input.domain]: 1 },
          quality: targetQuality,
          verticalTags: [
            ...new Set([...asset.verticalTags, "quality-audited"]),
          ],
        });
      }
    } else {
      assets[index] = {
        ...asset,
        volumeMTok: targetRemaining,
        domainWeights: targetRemaining > 1e-9 ? { [input.domain]: 1 } : {},
        quality: targetQuality,
      };
    }
    remaining -= take;
    removedMTok += take;
    removedQualityMTok += take * removedUnitQuality;
    recordPrunedSource(breakdown, asset, take);
  }

  return {
    data: { ...input.data, assets },
    removedMTok,
    removedQualityMTok,
    breakdown,
  };
}

/**
 * Stable identity for a recurring market corpus. Market listings are refreshed
 * with day-scoped order IDs, but a lab buying the same corpus from the same
 * seller is extending one inspectable provenance lineage rather than creating
 * an unbounded series of equivalent assets.
 */
export function marketDatasetLineageId(input: {
  labId: string;
  domain: DataDomain;
  name: string;
  sellerKind: string;
  sellerName?: string;
  qualityBand: string;
  offerSource: string;
}): string {
  return seededId(
    "dataset-market-lineage",
    input.labId,
    input.domain,
    input.name,
    input.sellerKind,
    input.sellerName ?? "unknown-seller",
    input.qualityBand,
    input.offerSource,
  );
}

/** Merge another purchased lot into a canonical lineage without losing totals. */
export function mergeRecurringDatasetAsset(
  prior: DatasetAsset | undefined,
  incoming: DatasetAsset,
): DatasetAsset {
  if (!prior) return incoming;
  const priorVolume = Math.max(0, prior.volumeMTok);
  const incomingVolume = Math.max(0, incoming.volumeMTok);
  const volumeMTok = priorVolume + incomingVolume;
  const weighted = (before: number, after: number) =>
    volumeMTok > 0
      ? (before * priorVolume + after * incomingVolume) / volumeMTok
      : after;
  const domains = new Set([
    ...Object.keys(prior.domainWeights),
    ...Object.keys(incoming.domainWeights),
  ] as DataDomain[]);
  const domainWeights: Partial<Record<DataDomain, number>> = {};
  for (const domain of domains) {
    domainWeights[domain] = weighted(
      prior.domainWeights[domain] ?? 0,
      incoming.domainWeights[domain] ?? 0,
    );
  }

  return {
    ...incoming,
    id: prior.id,
    name: prior.name,
    volumeMTok,
    domainWeights,
    verticalTags: [
      ...new Set([...prior.verticalTags, ...incoming.verticalTags]),
    ],
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
  };
}

export const SYNTHETIC_TEACHER_LINEAGE_LIMIT = 16;

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
  if (
    !prior ||
    prior.source !== "synthetic" ||
    incoming.source !== "synthetic"
  ) {
    return incoming;
  }
  const priorVolume = Math.max(0, prior.volumeMTok);
  const incomingVolume = Math.max(0, incoming.volumeMTok);
  const volumeMTok = priorVolume + incomingVolume;
  const weighted = (before: number, after: number) =>
    volumeMTok > 0
      ? (before * priorVolume + after * incomingVolume) / volumeMTok
      : after;
  const teachers = [
    ...(prior.synthetic?.teacherModelIds ?? []),
    ...(incoming.synthetic?.teacherModelIds ?? []),
  ].filter((teacherId, index, values) => values.indexOf(teacherId) === index);
  const teacherModelIds = teachers.slice(-SYNTHETIC_TEACHER_LINEAGE_LIMIT);

  return {
    ...incoming,
    volumeMTok,
    quality: weighted(prior.quality, incoming.quality),
    diversity: weighted(prior.diversity, incoming.diversity),
    contaminationRisk: weighted(
      prior.contaminationRisk,
      incoming.contaminationRisk,
    ),
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
  };
}

/** Listed-quality → contamination risk for a market lot (scrap carries inherent noise). */
export function marketContaminationRisk(
  quality: number,
  qualityBand: "scrap" | "standard" | "premium" | "curated",
): number {
  return clamp01(
    (100 - quality) / 220 + (qualityBand === "scrap" ? 0.22 : 0.03),
  );
}

export function marketDatasetAsset(input: {
  id: string;
  name: string;
  domain: DataDomain;
  quantityMTok: number;
  quality: number;
  qualityBand: "scrap" | "standard" | "premium" | "curated";
  sellerKind: string;
  sellerName?: string;
  offerSource: "web" | "scrap" | "licensed";
  day: number;
}): DatasetAsset {
  const publicSource =
    input.sellerKind === "opensource" || input.offerSource === "web";
  const source: DatasetSource =
    input.sellerKind === "opensource"
      ? "opensource"
      : input.sellerKind === "enterprise" || input.sellerKind === "research_lab"
        ? "partner"
        : input.sellerKind === "web_scrape"
          ? "web"
          : "expert";
  const bandDiversity = {
    scrap: 0.38,
    standard: 0.58,
    premium: 0.74,
    curated: 0.86,
  }[input.qualityBand];
  return {
    id: input.id,
    name: input.name,
    volumeMTok: Math.max(0, input.quantityMTok),
    domainWeights: { [input.domain]: 1 },
    verticalTags: [
      input.domain,
      input.sellerKind,
      input.sellerName ?? "unknown-seller",
      input.qualityBand,
      input.offerSource,
    ],
    quality: Math.max(0, Math.min(100, input.quality)),
    diversity: bandDiversity,
    freshness: publicSource ? 0.68 : 0.82,
    rights: publicSource
      ? "public"
      : input.offerSource === "licensed"
        ? "licensed"
        : "restricted",
    source,
    exclusiveUntilDay: null,
    contaminationRisk: marketContaminationRisk(
      input.quality,
      input.qualityBand,
    ),
    acquiredDay: input.day,
  };
}

export function syntheticDatasetAsset(input: {
  id: string;
  name: string;
  domain: DataDomain;
  volumeMTok: number;
  quality: number;
  teacherModelId: string;
  tier: "hq" | "lq";
  day: number;
  provenance?: Partial<SyntheticProvenance>;
}): DatasetAsset {
  const provenance: SyntheticProvenance = {
    method: input.tier === "hq" ? "filtered" : "imitation",
    teacherModelIds: [input.teacherModelId],
    generationDepth: 1,
    promptDiversity: input.tier === "hq" ? 0.72 : 0.42,
    verifierStrength:
      input.domain === "code" || input.domain === "math" ? 0.35 : 0.08,
    candidatesPerAccepted: input.tier === "hq" ? 5 : 1,
    humanAnchorShare: input.tier === "hq" ? 0.18 : 0.04,
    ...input.provenance,
  };
  return {
    id: input.id,
    name: input.name,
    volumeMTok: Math.max(0, input.volumeMTok),
    domainWeights: { [input.domain]: 1 },
    verticalTags: [input.domain, "synthetic", input.tier],
    quality: Math.max(0, Math.min(100, input.quality)),
    diversity: provenance.promptDiversity,
    freshness: 1,
    rights: "owned",
    source: "synthetic",
    exclusiveUntilDay: null,
    contaminationRisk: input.tier === "hq" ? 0.09 : 0.28,
    synthetic: provenance,
    acquiredDay: input.day,
  };
}

export function processedTrafficDatasetAsset(input: {
  id: string;
  domain: DataDomain;
  volumeMTok: number;
  quality: number;
  day: number;
}): DatasetAsset {
  return {
    id: input.id,
    name: `Processed ${input.domain} product traffic`,
    volumeMTok: Math.max(0, input.volumeMTok),
    domainWeights: { [input.domain]: 1 },
    verticalTags: [input.domain, "product-traffic"],
    quality: Math.max(0, Math.min(100, input.quality)),
    diversity: 0.64,
    freshness: 0.96,
    rights: "restricted",
    source: "user",
    exclusiveUntilDay: null,
    contaminationRisk: 0.08,
    acquiredDay: input.day,
  };
}

/** Expand a manifest's attributed mix across the run's token exposures. */
export function manifestDomainExposureMTok(
  manifest: DataManifest,
  totalMTok = manifest.uniqueMTok + manifest.repeatedMTok,
): Partial<Record<DataDomain, number>> {
  const entries = Object.entries(manifest.domainWeights) as [
    DataDomain,
    number,
  ][];
  const weightTotal = entries.reduce(
    (sum, [, weight]) => sum + Math.max(0, weight ?? 0),
    0,
  );
  if (weightTotal <= 1e-9) return {};
  const exposure = Math.max(0, totalMTok);
  return Object.fromEntries(
    entries
      .filter(([, weight]) => (weight ?? 0) > 0)
      .map(([domain, weight]) => [
        domain,
        exposure * (Math.max(0, weight) / weightTotal),
      ]),
  );
}

/** Normalize optional legacy manifest fields into a complete frozen job snapshot. */
export function trainingDataEvidenceFromManifest(
  manifest: DataManifest,
): TrainingDataEvidence {
  return {
    effectiveQuality: Math.max(0, Math.min(100, manifest.effectiveQuality)),
    effectiveDiversity: clamp01(manifest.effectiveDiversity ?? 1),
    effectiveFreshness: clamp01(manifest.effectiveFreshness ?? 1),
    contaminationRisk: clamp01(manifest.contaminationRisk),
    syntheticShare: clamp01(manifest.syntheticShare ?? 0),
    syntheticGenerationDepth: Math.max(
      0,
      manifest.syntheticGenerationDepth ?? 0,
    ),
    humanAnchorShare: clamp01(manifest.humanAnchorShare ?? 1),
    rightsRisk: clamp01(manifest.rightsRisk ?? 0),
    effectiveTrainingValue: clamp01(manifest.effectiveTrainingValue ?? 1),
  };
}

/** Captures the exact corpus catalogue and method-independent quality assumptions at run start. */
export function createDataManifest(input: {
  data: LabData;
  consumed: Partial<Record<DataDomain, number>>;
  totalMTok: number;
  day: number;
  seed: number;
  runId: string;
}): { data: LabData; manifest: DataManifest } {
  const attributableAssets = assetsWithAggregateStockFallback(
    input.data,
    input.consumed,
  );
  const consumedDomains = Object.entries(input.consumed).filter(
    ([, amount]) => (amount ?? 0) > 0,
  ) as [DataDomain, number][];
  const allocations = new Map<DatasetAsset, number>();
  const attributedByDomain: Partial<Record<DataDomain, number>> = {};
  let uniqueMTok = 0;

  for (const [domain, requestedRaw] of consumedDomains) {
    const requested = Math.max(0, requestedRaw);
    const domainAssets = attributableAssets
      .map((asset) => ({
        asset,
        available:
          Math.max(0, asset.volumeMTok) *
          Math.max(0, asset.domainWeights[domain] ?? 0),
      }))
      .filter(({ available }) => available > 0);
    const available = domainAssets.reduce((sum, lot) => sum + lot.available, 0);
    const consumed = Math.min(requested, available);
    attributedByDomain[domain] = consumed;
    uniqueMTok += consumed;
    if (available <= 0 || consumed <= 0) continue;

    // Stocks expose blended domain inventory rather than lot selection. Use a
    // proportional draw so manifest quality/contamination matches that blend,
    // while no asset can supply more than its domain-weighted share.
    for (const { asset, available: assetAvailable } of domainAssets) {
      const allocated = consumed * (assetAvailable / available);
      allocations.set(asset, (allocations.get(asset) ?? 0) + allocated);
    }
  }

  const allocatedMTok = [...allocations.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );
  const quality =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + asset.quality * amount,
          0,
        ) / allocatedMTok
      : 0;
  const contamination =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + asset.contaminationRisk * amount,
          0,
        ) / allocatedMTok
      : 0;
  const diversity =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + clamp01(asset.diversity) * amount,
          0,
        ) / allocatedMTok
      : 0;
  const freshness =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + clamp01(asset.freshness) * amount,
          0,
        ) / allocatedMTok
      : 0;
  const syntheticMTok = [...allocations.entries()].reduce(
    (sum, [asset, amount]) => sum + (asset.source === "synthetic" ? amount : 0),
    0,
  );
  const syntheticShare =
    allocatedMTok > 0 ? clamp01(syntheticMTok / allocatedMTok) : 0;
  const syntheticGenerationDepth =
    syntheticMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) =>
            sum +
            (asset.source === "synthetic"
              ? Math.max(1, asset.synthetic?.generationDepth ?? 1) * amount
              : 0),
          0,
        ) / syntheticMTok
      : 0;
  const humanAnchorShare =
    allocatedMTok > 0
      ? clamp01(
          [...allocations.entries()].reduce(
            (sum, [asset, amount]) =>
              sum +
              amount *
                (asset.source === "synthetic"
                  ? clamp01(asset.synthetic?.humanAnchorShare ?? 0)
                  : 1),
            0,
          ) / allocatedMTok,
        )
      : 0;
  const rightsRisk =
    allocatedMTok > 0
      ? [...allocations.entries()].reduce(
          (sum, [asset, amount]) => sum + datasetRightsRisk(asset) * amount,
          0,
        ) / allocatedMTok
      : 0;
  // Quality, source diversity, freshness and provenance each matter. Rights
  // exposure is deliberately excluded: it can block a release, but it cannot
  // make a token less learnable.
  const syntheticLineageMultiplier = clamp01(
    1 -
      (1 - humanAnchorShare) * 0.22 -
      syntheticShare * Math.max(0, syntheticGenerationDepth - 1) * 0.035,
  );
  const effectiveTrainingValue =
    allocatedMTok > 0
      ? clamp01(
          qualityTrainingValue(quality) *
            (0.7 + diversity * 0.3) *
            (0.85 + freshness * 0.15) *
            (1 - clamp01(contamination) * 0.7) *
            syntheticLineageMultiplier,
        )
      : 0;
  const total = Math.max(0, input.totalMTok);
  const manifest: DataManifest = {
    id: seededId("manifest", input.seed, input.day, input.runId),
    assetIds: [...allocations.keys()].map((asset) => asset.id).sort(),
    domainWeights: Object.fromEntries(
      consumedDomains
        .map(([domain]) => [domain, attributedByDomain[domain] ?? 0] as const)
        .filter(([, amount]) => amount > 0)
        .map(([domain, amount]) => [
          domain,
          amount / Math.max(1e-9, uniqueMTok),
        ]),
    ),
    uniqueMTok: Math.min(total, uniqueMTok),
    repeatedMTok: Math.max(0, total - uniqueMTok),
    effectiveQuality: quality,
    effectiveDiversity: diversity,
    effectiveFreshness: freshness,
    contaminationRisk: contamination,
    syntheticShare,
    syntheticGenerationDepth,
    humanAnchorShare,
    rightsRisk,
    effectiveTrainingValue,
    createdDay: input.day,
  };
  return {
    data: {
      ...input.data,
      manifests: [...(input.data.manifests ?? []), manifest],
    },
    manifest,
  };
}
