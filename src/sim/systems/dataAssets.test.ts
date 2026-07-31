import { describe, expect, it } from 'vitest'
import { createEmptyLabData } from '../balance/data'
import {
  appendDatasetAsset,
  createDataManifest,
  marketDatasetAsset,
  marketDatasetLineageId,
  mergeRecurringDatasetAsset,
  mergeSyntheticDatasetAsset,
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
    expect(manifest.domainWeights).toMatchObject({ chat: 0.7, code: 0.3 })
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
})
