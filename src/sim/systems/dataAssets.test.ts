import { describe, expect, it } from 'vitest'
import { createEmptyLabData } from '../balance/data'
import {
  appendDatasetAsset,
  createDataManifest,
  marketDatasetAsset,
  marketDatasetLineageId,
  mergeRecurringDatasetAsset,
  mergeSyntheticDatasetAsset,
  pruneDatasetAssetsForDomain,
  SYNTHETIC_TEACHER_LINEAGE_LIMIT,
  syntheticDatasetAsset,
} from './dataAssets'

describe('canonical dataset assets', () => {
  it('records market rights and provenance without changing aggregate stocks', () => {
    const data = createEmptyLabData()
    const before = data.stocks.science.processed
    const next = appendDatasetAsset(
      data,
      marketDatasetAsset({
        id: 'science-license',
        name: 'Curated experiment archive',
        domain: 'science',
        quantityMTok: 40,
        quality: 91,
        qualityBand: 'curated',
        sellerKind: 'research_lab',
        offerSource: 'licensed',
        day: 12,
      }),
    )
    expect(next.assets.at(-1)).toMatchObject({
      id: 'science-license',
      rights: 'licensed',
      source: 'partner',
      volumeMTok: 40,
    })
    expect(next.stocks.science.processed).toBe(before)
  })

  it('merges recurring market lots by seller lineage with weighted quality', () => {
    const id = marketDatasetLineageId({
      labId: 'rival-chroma',
      domain: 'image',
      name: 'Captioned studio archive',
      sellerKind: 'enterprise',
      sellerName: 'Apex Data Rights',
      qualityBand: 'premium',
      offerSource: 'licensed',
    })
    const first = marketDatasetAsset({
      id,
      name: 'Captioned studio archive',
      domain: 'image',
      quantityMTok: 30,
      quality: 70,
      qualityBand: 'premium',
      sellerKind: 'enterprise',
      sellerName: 'Apex Data Rights',
      offerSource: 'licensed',
      day: 20,
    })
    const second = marketDatasetAsset({
      id,
      name: 'Captioned studio archive',
      domain: 'image',
      quantityMTok: 10,
      quality: 90,
      qualityBand: 'premium',
      sellerKind: 'enterprise',
      sellerName: 'Apex Data Rights',
      offerSource: 'licensed',
      day: 80,
    })
    const merged = mergeRecurringDatasetAsset(first, second)

    expect(merged.id).toBe(id)
    expect(merged.volumeMTok).toBe(40)
    expect(merged.quality).toBe(75)
    expect(merged.acquiredDay).toBe(20)
    expect(merged.source).toBe('partner')
    expect(merged.verticalTags).toContain('Apex Data Rights')
  })

  it('updates a synthetic lineage lot instead of duplicating it each day', () => {
    let data = createEmptyLabData()
    data = appendDatasetAsset(
      data,
      syntheticDatasetAsset({
        id: 'synth-run',
        name: 'Verified code cases',
        domain: 'code',
        volumeMTok: 4,
        quality: 72,
        teacherModelId: 'teacher',
        tier: 'hq',
        day: 5,
      }),
    )
    data = appendDatasetAsset(
      data,
      syntheticDatasetAsset({
        id: 'synth-run',
        name: 'Verified code cases',
        domain: 'code',
        volumeMTok: 9,
        quality: 74,
        teacherModelId: 'teacher',
        tier: 'hq',
        day: 6,
      }),
    )
    expect(data.assets.filter((asset) => asset.id === 'synth-run')).toHaveLength(1)
    expect(data.assets.find((asset) => asset.id === 'synth-run')).toMatchObject({
      volumeMTok: 9,
      acquiredDay: 5,
      synthetic: { method: 'filtered', teacherModelIds: ['teacher'] },
    })
  })

  it('bounds retired teachers while conserving canonical synthetic volume and quality', () => {
    let lineage = syntheticDatasetAsset({
      id: 'rival-code-hq',
      name: 'Code lineage',
      domain: 'code',
      volumeMTok: 2,
      quality: 60,
      teacherModelId: 'teacher-0',
      tier: 'hq',
      day: 1,
    })
    for (let index = 1; index < 25; index += 1) {
      lineage = mergeSyntheticDatasetAsset(
        lineage,
        syntheticDatasetAsset({
          id: 'rival-code-hq',
          name: 'Code lineage',
          domain: 'code',
          volumeMTok: 2,
          quality: 60 + index,
          teacherModelId: `teacher-${index}`,
          tier: 'hq',
          day: index + 1,
        }),
      )
    }

    expect(lineage.volumeMTok).toBe(50)
    expect(lineage.quality).toBeCloseTo(72)
    expect(lineage.acquiredDay).toBe(1)
    expect(lineage.synthetic?.teacherModelIds).toHaveLength(
      SYNTHETIC_TEACHER_LINEAGE_LIMIT,
    )
    expect(lineage.synthetic?.teacherModelIds.at(-1)).toBe('teacher-24')
  })

  it('creates an immutable manifest with unique and repeated volume', () => {
    const base = createEmptyLabData()
    const { data, manifest } = createDataManifest({
      data: base,
      consumed: { chat: 420, code: 180 },
      totalMTok: 600,
      day: 20,
      seed: 42,
      runId: 'job-a',
    })
    expect(manifest.assetIds).toContain('dataset-public-foundation-2026')
    expect(manifest.uniqueMTok + manifest.repeatedMTok).toBe(600)
    expect(manifest.domainWeights.chat).toBeCloseTo(80 / 260, 12)
    expect(manifest.domainWeights.code).toBeCloseTo(180 / 260, 12)
    expect(data.manifests).toEqual([manifest])
    expect(base.manifests).toEqual([])
  })

  it('limits availability to each asset domain-weighted share', () => {
    const base = createEmptyLabData()
    base.assets = [
      {
        ...base.assets[0]!,
        id: 'mixed-lot',
        volumeMTok: 100,
        domainWeights: { chat: 0.2, code: 0.8 },
      },
    ]
    const { manifest } = createDataManifest({
      data: base,
      consumed: { chat: 50 },
      totalMTok: 50,
      day: 2,
      seed: 8,
      runId: 'weighted-domain',
    })

    expect(manifest.uniqueMTok).toBeCloseTo(20, 12)
    expect(manifest.repeatedMTok).toBeCloseTo(30, 12)
    expect(manifest.assetIds).toEqual(['mixed-lot'])
  })

  it('records the mix actually attributed by assets rather than requested weights', () => {
    const base = createEmptyLabData()
    const foundation = base.assets[0]!
    base.assets = [
      {
        ...foundation,
        id: 'small-chat-lot',
        volumeMTok: 10,
        domainWeights: { chat: 1 },
      },
      {
        ...foundation,
        id: 'large-code-lot',
        volumeMTok: 90,
        domainWeights: { code: 1 },
      },
    ]
    const { manifest } = createDataManifest({
      data: base,
      consumed: { chat: 50, code: 50 },
      totalMTok: 100,
      day: 3,
      seed: 81,
      runId: 'attributed-mix',
    })

    expect(manifest.uniqueMTok).toBe(60)
    expect(manifest.repeatedMTok).toBe(40)
    expect(manifest.domainWeights.chat).toBeCloseTo(1 / 6, 12)
    expect(manifest.domainWeights.code).toBeCloseTo(5 / 6, 12)
    expect(
      Object.values(manifest.domainWeights).reduce(
        (sum, weight) => sum + (weight ?? 0),
        0,
      ),
    ).toBeCloseTo(1, 12)
  })

  it('weights quality and contamination only by consumed domain fractions', () => {
    const base = createEmptyLabData()
    const foundation = base.assets[0]!
    base.assets = [
      {
        ...foundation,
        id: 'unrelated-clean-code',
        volumeMTok: 10_000,
        domainWeights: { code: 1 },
        quality: 100,
        contaminationRisk: 0,
      },
      {
        ...foundation,
        id: 'dirty-chat',
        volumeMTok: 10,
        domainWeights: { chat: 1 },
        quality: 20,
        contaminationRisk: 0.9,
      },
    ]
    const { manifest } = createDataManifest({
      data: base,
      consumed: { chat: 10 },
      totalMTok: 10,
      day: 4,
      seed: 9,
      runId: 'no-laundering',
    })

    expect(manifest.assetIds).toEqual(['dirty-chat'])
    expect(manifest.uniqueMTok).toBe(10)
    expect(manifest.effectiveQuality).toBe(20)
    expect(manifest.contaminationRisk).toBeCloseTo(0.9, 12)
  })

  it('uses proportional consumed fractions for blended domain provenance', () => {
    const base = createEmptyLabData()
    const foundation = base.assets[0]!
    base.assets = [
      {
        ...foundation,
        id: 'clean-chat',
        volumeMTok: 90,
        domainWeights: { chat: 1 },
        quality: 90,
        contaminationRisk: 0.01,
      },
      {
        ...foundation,
        id: 'noisy-chat',
        volumeMTok: 10,
        domainWeights: { chat: 1 },
        quality: 10,
        contaminationRisk: 0.91,
      },
    ]
    const { manifest } = createDataManifest({
      data: base,
      consumed: { chat: 10 },
      totalMTok: 10,
      day: 5,
      seed: 10,
      runId: 'proportional-blend',
    })

    expect(manifest.assetIds).toEqual(['clean-chat', 'noisy-chat'])
    expect(manifest.effectiveQuality).toBeCloseTo(82, 12)
    expect(manifest.contaminationRisk).toBeCloseTo(0.1, 12)
  })

  it('captures weighted diversity, freshness, rights, and synthetic lineage', () => {
    const base = createEmptyLabData()
    const foundation = base.assets[0]!
    base.assets = [
      {
        ...foundation,
        id: 'licensed-human-chat',
        volumeMTok: 75,
        domainWeights: { chat: 1 },
        diversity: 0.8,
        freshness: 0.6,
        rights: 'licensed',
        source: 'partner',
        contaminationRisk: 0.04,
      },
      syntheticDatasetAsset({
        id: 'recursive-chat',
        name: 'Recursive chat traces',
        domain: 'chat',
        volumeMTok: 25,
        quality: foundation.quality,
        teacherModelId: 'teacher-v3',
        tier: 'hq',
        day: 4,
        provenance: {
          generationDepth: 3,
          promptDiversity: 0.4,
          humanAnchorShare: 0.2,
        },
      }),
    ]
    const { manifest } = createDataManifest({
      data: base,
      consumed: { chat: 100 },
      totalMTok: 100,
      day: 8,
      seed: 11,
      runId: 'manifest-depth',
    })

    expect(manifest.effectiveDiversity).toBeCloseTo(0.7, 12)
    expect(manifest.effectiveFreshness).toBeCloseTo(0.7, 12)
    expect(manifest.syntheticShare).toBeCloseTo(0.25, 12)
    expect(manifest.syntheticGenerationDepth).toBeCloseTo(3, 12)
    expect(manifest.humanAnchorShare).toBeCloseTo(0.8, 12)
    expect(manifest.rightsRisk).toBeCloseTo(0.095, 12)
    expect(manifest.effectiveTrainingValue).toBeGreaterThan(0)
    expect(manifest.effectiveTrainingValue).toBeLessThan(1)
  })

  it('assigns no training value when no canonical asset can supply the request', () => {
    const base = createEmptyLabData()
    base.assets = []
    for (const stock of Object.values(base.stocks)) stock.processed = 0
    const { manifest } = createDataManifest({
      data: base,
      consumed: { audio: 40 },
      totalMTok: 40,
      day: 9,
      seed: 12,
      runId: 'empty-manifest',
    })

    expect(manifest.uniqueMTok).toBe(0)
    expect(manifest.repeatedMTok).toBe(40)
    expect(manifest.effectiveTrainingValue).toBe(0)
  })

  it('attributes only the aggregate stock gap for legacy corpora without assets', () => {
    const base = createEmptyLabData()
    base.stocks.audio.processed = 120
    base.stocks.audio.fromWeb = 120
    const { manifest } = createDataManifest({
      data: base,
      consumed: { audio: 200 },
      totalMTok: 200,
      day: 10,
      seed: 13,
      runId: 'legacy-audio-stock',
    })

    expect(manifest.uniqueMTok).toBe(120)
    expect(manifest.repeatedMTok).toBe(80)
    expect(manifest.domainWeights).toEqual({ audio: 1 })
    expect(manifest.assetIds).toContain('dataset-legacy-stock-audio')
    expect(manifest.assetIds).not.toContain('dataset-public-foundation-2026')
  })

  it('does not create fallback volume when assets already represent processed stock', () => {
    const base = createEmptyLabData()
    const { manifest } = createDataManifest({
      data: base,
      consumed: { code: 500 },
      totalMTok: 500,
      day: 11,
      seed: 14,
      runId: 'no-double-count',
    })

    expect(manifest.uniqueMTok).toBe(180)
    expect(manifest.repeatedMTok).toBe(320)
    expect(manifest.assetIds).toEqual(['dataset-public-foundation-2026'])
  })

  it('prunes backing volume without removing another domain from a mixed asset', () => {
    const base = createEmptyLabData()
    const foundation = base.assets[0]!
    base.assets = [{
      ...foundation,
      id: 'mixed-media',
      volumeMTok: 100,
      domainWeights: { image: 0.4, chat: 0.6 },
      quality: 48,
    }]
    const result = pruneDatasetAssetsForDomain({
      data: base,
      domain: 'image',
      amountMTok: 15,
    })
    const domainVolume = (domain: 'image' | 'chat') =>
      result.data.assets.reduce(
        (sum, asset) =>
          sum + asset.volumeMTok * Math.max(0, asset.domainWeights[domain] ?? 0),
        0,
      )
    const qualityMass = result.data.assets.reduce(
      (sum, asset) => sum + asset.quality * asset.volumeMTok,
      0,
    )
    const imageSurvivor = result.data.assets.find(
      (asset) => (asset.domainWeights.image ?? 0) > 0,
    )

    expect(result.removedMTok).toBeCloseTo(15, 12)
    expect(result.data.assets.reduce((sum, asset) => sum + asset.volumeMTok, 0)).toBeCloseTo(85, 12)
    expect(domainVolume('image')).toBeCloseTo(25, 12)
    expect(domainVolume('chat')).toBeCloseTo(60, 12)
    expect(imageSurvivor?.quality).toBeGreaterThan(48)
    expect(qualityMass + result.removedQualityMTok).toBeCloseTo(
      48 * 100,
      8,
    )
  })

  it('prevents future manifests from consuming pruned asset volume', () => {
    const base = createEmptyLabData()
    const pruned = pruneDatasetAssetsForDomain({
      data: base,
      domain: 'code',
      amountMTok: 45,
    }).data
    const { manifest } = createDataManifest({
      data: pruned,
      consumed: { code: 180 },
      totalMTok: 180,
      day: 8,
      seed: 7,
      runId: 'post-prune',
    })

    expect(manifest.uniqueMTok).toBeCloseTo(135, 8)
    expect(manifest.repeatedMTok).toBeCloseTo(45, 8)
  })
})
