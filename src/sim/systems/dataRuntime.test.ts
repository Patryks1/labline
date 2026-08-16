import { describe, expect, it } from 'vitest'
import { createEmptyLabData } from '../balance/data'
import type { DataDomain, LabData, StaffHeadcount } from '../types'
import {
  collectTrafficData,
  dataHygieneSnapshot,
  dataModelDriftRate,
  dataProcessingThroughput,
  enqueueAutomaticProcessing,
  processDataJobs,
  processingAcceptanceYield,
  processingCostPerInspectedMTok,
  resolveCollectableServed,
  resolvedProcessingQuality,
  syntheticGenerationMTokPerDay,
  updateDataQualityIndex,
} from './dataRuntime'

const STAFF: StaffHeadcount = {
  researcher: 2,
  data_processor: 3,
  engineer: 2,
  ops: 2,
}

function rawCorpus(): LabData {
  const data = createEmptyLabData()
  for (const domain of Object.keys(data.stocks) as DataDomain[]) {
    data.stocks[domain].raw = domain === 'science' ? 90 : domain === 'code' ? 70 : 15
  }
  return data
}

describe('controller-neutral data runtime', () => {
  it('treats untreated and queued corpus as a measurable hygiene risk', () => {
    const dirty = createEmptyLabData()
    dirty.stocks.code.raw = 900
    dirty.processQueue = [{
      id: 'dirty-backlog',
      domain: 'code',
      remaining: 300,
      total: 300,
      qualityTarget: 70,
    }]
    const clean = createEmptyLabData()
    clean.stocks.code.processed = 1_200
    clean.stocks.code.quality = 82

    const dirtyHygiene = dataHygieneSnapshot(dirty)
    const cleanHygiene = dataHygieneSnapshot(clean)

    expect(dirtyHygiene.pressure).toBeGreaterThan(cleanHygiene.pressure)
    expect(dirtyHygiene.qualityTarget).toBeLessThan(cleanHygiene.qualityTarget)
    expect(dataModelDriftRate(dirty)).toBeGreaterThan(0)
    expect(dataModelDriftRate(clean)).toBe(0)
    expect(updateDataQualityIndex(1.2, dirty)).toBeLessThan(
      updateDataQualityIndex(1.2, clean),
    )
  })

  it('uses monotone, modality-aware acceptance yields', () => {
    expect(processingAcceptanceYield(30)).toBeGreaterThan(0.7)
    expect(processingAcceptanceYield(95)).toBeLessThan(0.5)
    expect(processingAcceptanceYield(70)).toBeLessThan(
      processingAcceptanceYield(50),
    )
    const chat = processingAcceptanceYield(70, 'chat', 'web', 48)
    const image = processingAcceptanceYield(70, 'image', 'web', 48)
    const audio = processingAcceptanceYield(70, 'audio', 'web', 48)
    const video = processingAcceptanceYield(70, 'video', 'web', 48)
    expect(chat).toBeGreaterThan(image)
    expect(image).toBeGreaterThan(audio)
    expect(audio).toBeGreaterThan(video)
  })

  it('makes clean licensed lots yield more than low-quality scrap', () => {
    const licensed = processingAcceptanceYield(75, 'image', 'licensed', 84)
    const scrap = processingAcceptanceYield(75, 'image', 'scrap', 32)
    const cleanWeb = processingAcceptanceYield(75, 'image', 'web', 84)
    const dirtyWeb = processingAcceptanceYield(75, 'image', 'web', 32)
    expect(licensed).toBeGreaterThan(scrap * 1.5)
    expect(cleanWeb).toBeGreaterThan(dirtyWeb)
  })

  it('conserves inspected raw volume across accepted and rejected output', () => {
    const data = createEmptyLabData()
    data.stocks.chat.raw = 10
    const beforeProcessed = data.stocks.chat.processed
    const queued = enqueueAutomaticProcessing({
      data,
      day: 3,
      labId: 'mass-check',
      dataQuality: 1,
      staff: STAFF,
    })
    const result = processDataJobs({
      data: queued,
      cash: 5_000_000,
      throughputMTok: 100,
      dataQuality: 1,
      staff: STAFF,
      day: 3,
    })
    const accepted = result.data.stocks.chat.processed - beforeProcessed

    expect(result.data.stocks.chat.raw).toBe(0)
    expect(result.data.processQueue).toHaveLength(0)
    expect(accepted).toBeCloseTo(result.processedMTok, 12)
    expect(result.inspectedMTok).toBeCloseTo(10, 12)
    expect(accepted + result.rejectedMTok).toBeCloseTo(
      result.inspectedMTok,
      12,
    )
    expect(accepted).toBeLessThan(10)
  })

  it('collects identical domain volumes for equal served traffic and policy inputs', () => {
    const input = {
      data: createEmptyLabData(),
      servedMTok: 48,
      demandMTok: 60,
      brandTrust: 67,
      dataFlywheel: 0.18,
      segments: [
        { id: 'science' as const, size: 3_000_000 },
        { id: 'consumer' as const, size: 7_000_000 },
      ],
    }
    const player = collectTrafficData(input)
    const rival = collectTrafficData({ ...input, data: createEmptyLabData() })

    expect(rival.collectedMTok).toBeCloseTo(player.collectedMTok, 12)
    expect(rival.brandTrust).toBeCloseTo(player.brandTrust, 12)
    for (const domain of Object.keys(player.data.stocks) as DataDomain[]) {
      expect(rival.data.stocks[domain].raw).toBeCloseTo(
        player.data.stocks[domain].raw,
        12,
      )
      expect(rival.data.dayCollectByDomain[domain] ?? 0).toBeCloseTo(
        player.data.dayCollectByDomain[domain] ?? 0,
        12,
      )
    }
  })

  it('retains only consented novel traffic with diminishing returns at scale', () => {
    const collect = (servedMTok: number) =>
      collectTrafficData({
        data: createEmptyLabData(),
        servedMTok,
        demandMTok: servedMTok,
        brandTrust: 70,
        dataFlywheel: 0,
        segments: [{ id: 'startup_api', size: 1_000_000 }],
      }).collectedMTok
    const small = collect(100)
    const scale = collect(1_000_000)

    expect(small).toBeGreaterThan(0)
    expect(scale).toBeGreaterThan(small)
    expect(scale).toBeLessThan(small * 100)
    expect(scale).toBeLessThan(1_000_000 * 0.18)
  })

  it('converts equal staff, data, compute, and cash into equal yield and cost', () => {
    const throughput = dataProcessingThroughput({
      staff: STAFF,
      researchPf: 11,
      labSites: 2,
      dataFlywheel: 0.22,
    })
    const run = (labId: string) => {
      const queued = enqueueAutomaticProcessing({
        data: rawCorpus(),
        day: 42,
        labId,
        dataQuality: 1.08,
        staff: STAFF,
        priorityDomains: ['science', 'code', 'math'],
      })
      const result = processDataJobs({
        data: queued,
        cash: 5_000_000,
        throughputMTok: throughput,
        dataQuality: 1.08,
        staff: STAFF,
        day: 42,
      })
      return {
        ...result,
        qualityIndex: updateDataQualityIndex(1.08, result.data),
      }
    }

    const player = run('player')
    const rival = run('rival-a')
    expect(rival.processedMTok).toBeCloseTo(player.processedMTok, 12)
    expect(rival.cashSpent).toBeCloseTo(player.cashSpent, 8)
    expect(rival.cash).toBeCloseTo(player.cash, 8)
    expect(rival.qualityIndex).toBeCloseTo(player.qualityIndex, 12)
    for (const domain of Object.keys(player.data.stocks) as DataDomain[]) {
      expect(rival.data.stocks[domain].processed).toBeCloseTo(
        player.data.stocks[domain].processed,
        12,
      )
      expect(rival.data.stocks[domain].quality).toBeCloseTo(
        player.data.stocks[domain].quality,
        12,
      )
    }
  })

  it('uses the same domain-aware synthetic volume curve for any controller', () => {
    const input = {
      domain: 'math' as const,
      teacherDomainCapability: 74,
      teacherReliability: 81,
      researchPf: 18,
      tier: 'hq' as const,
    }
    const player = syntheticGenerationMTokPerDay(input)
    const rival = syntheticGenerationMTokPerDay({ ...input })
    expect(rival).toBe(player)
    expect(
      syntheticGenerationMTokPerDay({ ...input, domain: 'video' }),
    ).toBeLessThan(player)
  })

  it('spends available cash on a fractional pass without creating cash', () => {
    const data = rawCorpus()
    data.processQueue = [
      {
        id: 'expensive-science',
        domain: 'science',
        remaining: 20,
        total: 20,
        qualityTarget: 75,
      },
    ]
    const result = processDataJobs({
      data,
      cash: 100,
      throughputMTok: 100,
      dataQuality: 1,
      staff: STAFF,
      day: 1,
    })
    expect(result.blockedForCash).toBe(true)
    expect(result.inspectedMTok).toBeGreaterThan(0)
    expect(result.inspectedMTok).toBeLessThan(1)
    expect(result.processedMTok).toBeGreaterThan(0)
    expect(result.cashSpent).toBeCloseTo(100, 8)
    expect(result.cash).toBeCloseTo(0, 8)
    expect(result.data.processQueue[0]?.remaining).toBeLessThan(20)
    expect(result.data.processQueue[0]?.remaining).toBeGreaterThan(19)
    expect(result.processedMTok + result.rejectedMTok).toBeCloseTo(
      result.inspectedMTok,
      12,
    )
  })

  it('charges strict cleaning on inspected raw volume, including rejects', () => {
    const run = (qualityTarget: number) => {
      const data = createEmptyLabData()
      data.processQueue = [{
        id: `strict-${qualityTarget}`,
        domain: 'image',
        remaining: 10,
        total: 10,
        qualityTarget,
        purchaseLot: {
          lineageId: `lot-${qualityTarget}`,
          name: 'Image crawl',
          sellerKind: 'web_scrape',
          qualityBand: 'scrap',
          offerSource: 'scrap',
          purchaseQuality: 34,
        },
      }]
      return processDataJobs({
        data,
        cash: 10_000_000,
        throughputMTok: 1_000,
        dataQuality: 1,
        staff: STAFF,
        day: 1,
      })
    }
    const loose = run(40)
    const strict = run(90)

    expect(loose.inspectedMTok).toBeCloseTo(10, 12)
    expect(strict.inspectedMTok).toBeCloseTo(10, 12)
    expect(strict.cashSpent).toBeGreaterThan(loose.cashSpent * 1.8)
    expect(strict.processedMTok).toBeLessThan(loose.processedMTok)
    expect(strict.cashSpent).toBeCloseTo(
      strict.inspectedMTok * processingCostPerInspectedMTok('image', 90, 'scrap'),
      8,
    )
  })

  it('aggregates recurring automatic traffic into one bounded domain asset', () => {
    let data = rawCorpus()
    for (const day of [1, 2, 3]) {
      data.processQueue = [
        {
          id: `proc-auto-${day}-rival-a-code`,
          domain: 'code',
          remaining: 4,
          total: 4,
          qualityTarget: 75,
        },
      ]
      data = processDataJobs({
        data,
        cash: 5_000_000,
        throughputMTok: 10,
        dataQuality: 1,
        staff: STAFF,
        day,
      }).data
    }
    const assets = data.assets.filter(
      (asset) => asset.id === 'dataset-processed-traffic-code',
    )
    expect(assets).toHaveLength(1)
    expect(assets[0]?.volumeMTok).toBeCloseTo(
      12 * processingAcceptanceYield(75, 'code', 'product_traffic', 58),
      8,
    )
    expect(assets[0]?.acquiredDay).toBe(1)
  })

  it('preserves public stock while accepted traffic remains restricted user data', () => {
    const data = createEmptyLabData()
    const webBefore = data.stocks.chat.fromWeb
    data.stocks.chat.raw = 8
    const queued = enqueueAutomaticProcessing({
      data,
      day: 7,
      labId: 'provenance-check',
      dataQuality: 1,
      staff: STAFF,
    })
    const result = processDataJobs({
      data: queued,
      cash: 5_000_000,
      throughputMTok: 100,
      dataQuality: 1,
      staff: STAFF,
      day: 7,
    })
    const asset = result.data.assets.find(
      (candidate) => candidate.id === 'dataset-processed-traffic-chat',
    )

    expect(result.data.stocks.chat.fromWeb).toBe(webBefore)
    expect(result.data.stocks.chat.fromUser).toBeCloseTo(
      result.processedMTok,
      12,
    )
    expect(asset).toMatchObject({ source: 'user', rights: 'restricted' })
    expect(asset?.volumeMTok).toBeCloseTo(result.processedMTok, 12)
  })

  it('processes small collected traffic into visible user provenance', () => {
    const collected = collectTrafficData({
      data: createEmptyLabData(),
      servedMTok: 12,
      demandMTok: 100,
      brandTrust: 60,
      dataFlywheel: 0,
      segments: [{ id: 'consumer', size: 1_000_000 }],
    })
    const queued = enqueueAutomaticProcessing({
      data: collected.data,
      day: 9,
      labId: 'small-lab',
      dataQuality: 1,
      staff: STAFF,
    })
    const result = processDataJobs({
      data: queued,
      cash: 5_000_000,
      throughputMTok: 100,
      dataQuality: 1,
      staff: STAFF,
      day: 9,
    })

    expect(collected.collectedMTok).toBeGreaterThan(0)
    expect(result.processedMTok).toBeGreaterThan(0)
    expect(result.data.assets.some((asset) => asset.source === 'user')).toBe(true)
  })

  it('uses the requested target, lab quality, and staff exactly once for asset quality', () => {
    const data = createEmptyLabData()
    data.processQueue = [{
      id: 'quality-regression',
      domain: 'science',
      remaining: 5,
      total: 5,
      qualityTarget: 75,
    }]
    const result = processDataJobs({
      data,
      cash: 5_000_000,
      throughputMTok: 100,
      dataQuality: 1.08,
      staff: STAFF,
      day: 11,
    })
    const asset = result.data.assets.find(
      (candidate) => candidate.id === 'dataset-quality-regression',
    )

    expect(asset?.quality).toBeCloseTo(
      resolvedProcessingQuality(75, 1.08, STAFF, 48, 'science'),
      12,
    )
  })

  it('caps output quality by raw source and lab capability', () => {
    const weakSource = resolvedProcessingQuality(95, 1, STAFF, 28, 'video')
    const sameWeakSource = resolvedProcessingQuality(75, 1, STAFF, 28, 'video')
    const cleanSource = resolvedProcessingQuality(95, 1, STAFF, 88, 'video')

    expect(weakSource).toBe(sameWeakSource)
    expect(weakSource).toBeLessThan(40)
    expect(cleanSource).toBeGreaterThan(weakSource)
    expect(cleanSource).toBeLessThan(95)
  })
})

describe('chat collection tiers', () => {
  const segments = [{ id: 'consumer' as const, size: 1_000_000 }]

  it('grows collection from free-plan traffic when collection is on', () => {
    const off = collectTrafficData({
      data: createEmptyLabData(),
      servedMTok: 80,
      demandMTok: 80,
      brandTrust: 70,
      dataFlywheel: 0,
      segments,
      planSlices: [
        {
          id: 'free',
          pricePerMonth: 0,
          servedMTok: 80,
          dataCollectionRate: 0,
        },
      ],
    })
    const on = collectTrafficData({
      data: createEmptyLabData(),
      servedMTok: 80,
      demandMTok: 80,
      brandTrust: 70,
      dataFlywheel: 0,
      segments,
      planSlices: [
        {
          id: 'free',
          pricePerMonth: 0,
          servedMTok: 80,
          dataCollectionRate: 1,
        },
      ],
    })

    expect(off.collectedMTok).toBe(0)
    expect(on.collectedMTok).toBeGreaterThan(0)
    expect(on.data.dayCollectChatFree ?? 0).toBeGreaterThan(0)
    expect(on.data.dayCollectChatPaid ?? 0).toBe(0)
  })

  it('collects nothing from $60 plans even at 100% setting', () => {
    const result = collectTrafficData({
      data: createEmptyLabData(),
      servedMTok: 120,
      demandMTok: 120,
      brandTrust: 70,
      dataFlywheel: 0,
      segments,
      planSlices: [
        {
          id: 'pro',
          pricePerMonth: 60,
          servedMTok: 120,
          dataCollectionRate: 1,
        },
      ],
    })
    expect(result.collectedMTok).toBe(0)
    expect(result.data.dayCollectChatFree ?? 0).toBe(0)
    expect(result.data.dayCollectChatPaid ?? 0).toBe(0)
  })

  it('never lets a $20 plan exceed ~16% collect share even at 100% slider', () => {
    const served = 100
    const capped = resolveCollectableServed({
      servedMTok: served,
      collectionRate: 1,
      planSlices: [
        {
          id: 'plus',
          pricePerMonth: 20,
          servedMTok: served,
          dataCollectionRate: 1,
        },
      ],
    })
    expect(capped.effectiveServedMTok / served).toBeCloseTo(0.16, 8)
    expect(capped.effectiveServedMTok / served).toBeLessThanOrEqual(0.161)

    const fullFree = resolveCollectableServed({
      servedMTok: served,
      collectionRate: 1,
      planSlices: [
        {
          id: 'free',
          pricePerMonth: 0,
          servedMTok: served,
          dataCollectionRate: 1,
        },
      ],
    })
    expect(fullFree.effectiveServedMTok).toBeCloseTo(served, 8)

    const paidCollect = collectTrafficData({
      data: createEmptyLabData(),
      servedMTok: served,
      demandMTok: served,
      brandTrust: 70,
      dataFlywheel: 0,
      segments,
      planSlices: [
        {
          id: 'plus',
          pricePerMonth: 20,
          servedMTok: served,
          dataCollectionRate: 1,
        },
      ],
    })
    expect(paidCollect.data.dayCollectChatPaid ?? 0).toBeGreaterThan(0)
    expect(paidCollect.data.dayCollectChatFree ?? 0).toBe(0)
  })
})
