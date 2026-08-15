import { describe, expect, it } from 'vitest'
import { DATA_DOMAINS, emptyDomainStock } from '../../../sim/balance/data'
import type { DataDomain } from '../../../sim/types'
import {
  domainAvailabilityTooltip,
  domainCapReason,
  domainSharePct,
  domainStockAvailability,
  rebalanceTrainingDataDomain,
  trainingDataDomainAvailability,
  trainingDataDomainCapMTok,
  trainingDataDomainFill,
} from './trainingDataRadarMath'

function blankAllocations(fill = 10): Record<DataDomain, number> {
  return Object.fromEntries(
    DATA_DOMAINS.map((domain) => [domain, fill]),
  ) as Record<DataDomain, number>
}

describe('training data radar', () => {
  it('moves one domain without silently changing any other token allocation', () => {
    const initial = Object.fromEntries(
      DATA_DOMAINS.map((domain, index) => [domain, (index + 1) * 10]),
    ) as Record<(typeof DATA_DOMAINS)[number], number>
    const next = rebalanceTrainingDataDomain(
      initial,
      'code',
      initial.code + 120,
      500,
    )

    expect(next.code).toBe(initial.code + 120)
    for (const domain of DATA_DOMAINS.filter((domain) => domain !== 'code')) {
      expect(next[domain]).toBe(initial[domain])
    }
    expect(rebalanceTrainingDataDomain(initial, 'code', 900, 500).code).toBe(500)
  })

  it('keeps sibling domains intact across successive absolute edits', () => {
    let allocations = blankAllocations(40)
    const untouched = DATA_DOMAINS.filter((domain) => domain !== 'code')

    allocations = rebalanceTrainingDataDomain(allocations, 'code', 180, 10_000)
    for (const domain of untouched) {
      expect(allocations[domain]).toBe(40)
    }

    allocations = rebalanceTrainingDataDomain(allocations, 'code', 90, 10_000)
    for (const domain of untouched) {
      expect(allocations[domain]).toBe(40)
    }
    expect(allocations.code).toBe(90)
  })

  it('allows the handle to rise when math inventory is large but selection is small', () => {
    const stock = { ...emptyDomainStock(), processed: 12_000, quality: 70 }
    const availability = domainStockAvailability(stock, {
      includeSynthHQ: false,
      includeSynthLQ: false,
      selectedMTok: 25,
    })

    // Cap is inventory-driven, not selection-driven — a tiny recipe can still grow.
    expect(availability.capMTok).toBe(12_000)
    expect(availability.usableRealMTok).toBe(12_000)
    expect(availability.selectedMTok).toBe(25)

    const initial = blankAllocations(25)
    const raised = rebalanceTrainingDataDomain(
      initial,
      'code',
      4_000,
      availability.capMTok,
    )
    expect(raised.code).toBe(4_000)
    for (const domain of DATA_DOMAINS.filter((d) => d !== 'code')) {
      expect(raised[domain]).toBe(25)
    }
  })

  it('caps requested volume using real + synthetic headroom base', () => {
    expect(trainingDataDomainCapMTok(100, 25, 0)).toBe(100)
    expect(trainingDataDomainCapMTok(100, 25, 2)).toBe(375)
    expect(trainingDataDomainCapMTok(100, 25, 99)).toBe(1000)
    expect(trainingDataDomainCapMTok(100, 2_000, 7)).toBe(16_800)
    expect(trainingDataDomainCapMTok(0, 100, 7)).toBe(800)
  })

  it('reports share from absolute allocations without mutating them', () => {
    const allocations = blankAllocations(0)
    allocations.code = 75
    allocations.chat = 25
    expect(domainSharePct(allocations, 'code')).toBe(75)
    expect(allocations.chat).toBe(25)
  })

  it('surfaces a clear capped reason and tooltip inventory lines', () => {
    const availability = trainingDataDomainAvailability({
      processedRealMTok: 100,
      includeSynthHQ: false,
      includeSynthLQ: false,
      selectedMTok: 100,
    })
    expect(domainCapReason(availability, 0)).toMatch(/Capped at available real/)
    const tip = domainAvailabilityTooltip(availability, 0)
    expect(tip).toContain('Available real: 100 MTok')
    expect(tip).toContain('Selected: 100 MTok')
    expect(tip).toContain('Max: 100 MTok')
    expect(tip).toMatch(/Capped/)
  })
})

describe('training data domain fill (drag past owned corpus)', () => {
  const baseFill = {
    synthHQStockMTok: 0,
    synthLQStockMTok: 0,
    includeSynthHQ: false,
    includeSynthLQ: false,
  }

  it('blocks the drag at the owned corpus when expansion is unavailable (no unlock, no teacher)', () => {
    const fill = trainingDataDomainFill({
      ...baseFill,
      needMTok: 400,
      realAvailableMTok: 100,
      syntheticMultiplier: 0,
    })

    expect(fill.capMTok).toBe(100)
    expect(fill.realTake).toBe(100)
    expect(fill.synthTake).toBe(0)
    expect(fill.shortfall).toBe(300)
  })

  it('allows drag past the corpus in pretrain/continue when synthetic generation is unlocked', () => {
    const fill = trainingDataDomainFill({
      ...baseFill,
      needMTok: 250,
      realAvailableMTok: 100,
      syntheticMultiplier: 2,
    })

    expect(fill.capMTok).toBe(300) // 100 real × (1 + 2×)
    expect(fill.synthTake).toBe(150)
    expect(fill.shortfall).toBe(0)
  })

  it('allows drag past the corpus in distill via teacher synthetic headroom', () => {
    const fill = trainingDataDomainFill({
      ...baseFill,
      needMTok: 500,
      realAvailableMTok: 100,
      syntheticMultiplier: 2,
      syntheticHeadroomMTok: 200,
    })

    expect(fill.capMTok).toBe(900) // (100 real + 200 teacher) × (1 + 2×)
    expect(fill.synthTake).toBe(400)
    expect(fill.shortfall).toBe(0)
  })

  it('hard-caps expansion at 8× the domain real + teacher base', () => {
    const fill = trainingDataDomainFill({
      ...baseFill,
      needMTok: 100_000,
      realAvailableMTok: 100,
      syntheticMultiplier: 20,
      syntheticHeadroomMTok: 100,
    })

    expect(fill.capMTok).toBe(1600) // 8 × (100 + 100)
    expect(fill.synthTake).toBe(1500)
    expect(fill.shortfall).toBe(100_000 - 1600)
  })

  it('consumes stocked HQ/LQ synthetic before fresh expansion', () => {
    const fill = trainingDataDomainFill({
      needMTok: 200,
      realAvailableMTok: 100,
      synthHQStockMTok: 60,
      synthLQStockMTok: 20,
      includeSynthHQ: true,
      includeSynthLQ: true,
      syntheticMultiplier: 1,
    })

    expect(fill.realTake).toBe(100)
    expect(fill.hqTake).toBe(60)
    expect(fill.lqTake).toBe(20)
    expect(fill.synthTake).toBe(20)
    expect(fill.shortfall).toBe(0)
  })
})
