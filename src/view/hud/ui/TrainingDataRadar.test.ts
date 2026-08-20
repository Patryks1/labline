import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DATA_DOMAINS, createEmptyLabData, emptyDomainStock } from '../../../sim/balance/data'
import type { DataDomain } from '../../../sim/types'
import { TrainingDataRadar } from './TrainingDataRadar'
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

function radarProps(
  overrides: Partial<ComponentProps<typeof TrainingDataRadar>> = {},
) {
  return {
    baseWeights: blankAllocations(10),
    postWeights: blankAllocations(10),
    baseMTok: 78,
    postMTok: 22,
    data: createEmptyLabData(),
    teachers: [],
    syntheticTeacherIds: {},
    includeSynthHQ: false,
    includeSynthLQ: false,
    onOwnedChange: vi.fn(),
    onTeacherChange: vi.fn(),
    onOpenPlanLibrary: vi.fn(),
    trainShare: 0.82,
    onTrainShareChange: vi.fn(),
    ...overrides,
  }
}

describe('training data radar', () => {
  it('keeps the spider as the recipe: three zones, tokens, and click-to-edit', () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingDataRadar, radarProps()),
    )

    expect(markup).toContain('aria-label="Draggable radar chart for training data domains"')
    expect(markup).toContain('training-data-radar-layout')
    expect(markup).toContain('role="slider"')
    expect(markup).toContain('aria-label="Code base volume"')
    expect(markup).toContain('aria-label="Math base volume"')
    expect(markup).toContain('aria-label="Code data volume"')
    expect(markup).toContain('aria-label="Edit Code base down"')
    expect(markup).toContain('aria-label="Edit Code base up"')
    expect(markup).not.toContain('aria-label="Code synthetic volume"')
    expect(markup).toContain('Load plan')
    expect(markup).toContain('Use all data')
    expect(markup).toContain('Zoom in')
    expect(markup).toContain('Fit recipe')
    expect(markup).toContain('Focus selected domain')
    expect(markup).not.toMatch(/>Q\d/)
    expect(markup).toContain('Verification holdout')
    expect(markup).toContain('data-radar-legend="true"')
    expect(markup).toContain('Tokens the run actually trains on')
    expect(markup).toContain('Overflow past base, same pile')
    expect(markup).toContain('Holdout from the center of this domain')
    expect(markup).toContain('not trained')
    expect(markup).toContain('data-radar-label="code"')
    expect(markup).toContain('data-radar-label="math"')
    expect(markup).toContain('Verify')
    expect(markup).not.toContain('aria-label="Code verify volume"')
    expect(markup).toContain('data-radar-pop="true"')
    expect(markup).toContain('training-data-radar-pop')
    expect(markup).toContain('aria-label="Edit Code all"')
    expect(markup).toContain('aria-label="Edit Code base"')
    expect(markup).toContain('aria-label="Edit Code align"')
    expect(markup).not.toContain('aria-label="Edit Code verify"')
    expect(markup).toContain('data-readonly="true"')
    expect(markup).not.toContain('Domain volume')
    expect(markup).not.toContain('Alignment overflow')
    expect(markup).not.toContain('Balance owned stock')
    expect(markup).not.toContain('aria-label="Recipe zone"')
    expect(markup).not.toContain('Auto · best teacher')
  })

  it('draws base, post-train, and synthetic on one graph without zone tabs', () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingDataRadar, radarProps({ syntheticUnlocked: true })),
    )

    expect(markup).toContain('>Base</strong>')
    expect(markup).toContain('>Align</strong>')
    expect(markup).toContain('>Synthetic</strong>')
    expect(markup).toContain('Generated tokens past the pile')
    expect(markup).toContain('aria-label="Code synthetic volume"')
    expect(markup).not.toContain('data-radar-zone')
    expect(markup).not.toContain('aria-label="Recipe zone"')
    expect(markup).not.toContain('aria-label="Data phase"')
  })

  it('hides the synthetic band until Synthetic Generators is unlocked', () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingDataRadar, radarProps()),
    )

    expect(markup).not.toContain('aria-label="Code synthetic volume"')
    expect(markup).not.toContain('>Synthetic</strong>')
    expect(markup).not.toContain('aria-label="Edit Code synth"')
    expect(markup).not.toContain('Synth in pile')
    expect(markup).toContain('Use all data')
    expect(markup).toContain('aria-label="Code data volume"')
  })

  it('shows the selected domain volumes next to its spider label', () => {
    const markup = renderToStaticMarkup(
      createElement(TrainingDataRadar, radarProps({ syntheticUnlocked: true })),
    )

    expect(markup).toContain('data-radar-label="code"')
    expect(markup).not.toMatch(/>Q\d/)
    expect(markup).toContain('data-radar-pop="true"')
    expect(markup).toContain('aria-label="Code recipe volumes"')
    expect(markup).toContain('aria-label="Edit Code all"')
    expect(markup).toContain('aria-label="Edit Code base"')
    expect(markup).toContain('aria-label="Edit Code align"')
    expect(markup).toContain('aria-label="Edit Code synth"')
    expect(markup).not.toContain('aria-label="Edit Code verify"')
    expect(markup).not.toContain('aria-label="Code post-train MTok"')
  })

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
    for (const domain of DATA_DOMAINS.filter((entry) => entry !== 'code')) {
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

    expect(fill.capMTok).toBe(300)
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

    expect(fill.capMTok).toBe(900)
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

    expect(fill.capMTok).toBe(1600)
    expect(fill.synthTake).toBe(1500)
    expect(fill.shortfall).toBe(100_000 - 1600)
  })

  it('takes unpurged pile synth even when extra synth is turned off', () => {
    const fill = trainingDataDomainFill({
      needMTok: 100,
      realAvailableMTok: 40,
      synthHQStockMTok: 60,
      synthLQStockMTok: 0,
      includeSynthHQ: false,
      includeSynthLQ: false,
      syntheticMultiplier: 0,
    })

    expect(fill.realTake).toBeCloseTo(40)
    expect(fill.hqTake).toBeCloseTo(60)
    expect(fill.lqTake).toBe(0)
    expect(fill.synthTake).toBe(0)
    expect(fill.shortfall).toBe(0)
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
