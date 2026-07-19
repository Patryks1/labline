import { describe, expect, it } from 'vitest'
import { createEmptyLabData } from '../balance/data'
import type { DataDomain, LabData, StaffHeadcount } from '../types'
import {
  collectTrafficData,
  dataProcessingThroughput,
  enqueueAutomaticProcessing,
  processDataJobs,
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

  it('never processes a partial unaffordable job or creates cash', () => {
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
    expect(result.processedMTok).toBe(0)
    expect(result.cashSpent).toBe(0)
    expect(result.cash).toBe(100)
    expect(result.data.processQueue[0]?.remaining).toBe(20)
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
    expect(assets[0]?.volumeMTok).toBeCloseTo(12, 8)
    expect(assets[0]?.acquiredDay).toBe(1)
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
      resolvedProcessingQuality(75, 1.08, STAFF),
      12,
    )
  })
})
