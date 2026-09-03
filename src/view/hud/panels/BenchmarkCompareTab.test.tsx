import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EffortRecipe } from '../../../sim/types'
import type { LeaderboardRow } from '../../../sim/training/leaderboard'
import {
  BenchmarkCompareTab,
  formatFrontierReadout,
  formatFrontierThinking,
  frontierThinkingFor,
  isCompactBenchmarkViewport,
  thinkingPointRadius,
} from './BenchmarkCompareTab'

const INSTANT: EffortRecipe = {
  id: 'instant',
  name: 'Instant',
  kind: 'instant',
  thinkingTokenMult: 1,
  trainPfDays: 0,
  trainCash: 0,
  trained: true,
  quality: 1,
  served: true,
}

const THINK: EffortRecipe = {
  id: 'think',
  name: 'Think',
  kind: 'trained',
  thinkingTokenMult: 4,
  trainPfDays: 10,
  trainCash: 0,
  trained: true,
  quality: 0.8,
  served: true,
}

function thinkingModel(overrides: {
  capability?: number
  productProfile?: {
    lifecycle: 'reasoning'
    focus: { coding: number; science: number; research: number; personality: number; chat: number }
    personality: number
    tokenEfficiency: number
    effortRecipes: EffortRecipe[]
    defaultEffortId: string
  }
} = {}) {
  return {
    id: 'model-atlas',
    name: 'Atlas',
    family: 'dense' as const,
    releaseDay: 12,
    capability: overrides.capability ?? 72,
    paramsB: 7.4,
    modalities: ['text' as const],
    quality: {
      reasoning: 65, coding: 62, chat: 68, image: 20, video: 0, safety: 70, reliability: 72,
    },
    benchmarks: {
      mmlu: 72, coding: 62, math: 60, vision: 20, law: 55, health: 58,
      science: 52, multilingual: 60, agents: 40, safety: 70, personality: 48,
    },
    ...overrides,
  }
}

function v4Row(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    labId: 'player',
    labName: 'You',
    entryId: 'ep-atlas',
    name: 'Atlas Live',
    kind: 'endpoint',
    isPlayer: true,
    tierBudget: 1,
    scores: { overall: 61, language: 63, code: 58, math: 55 },
    overall: 61,
    season: 1,
    contaminated: [],
    ...overrides,
  }
}

describe('frontier thinking encoding', () => {
  it('treats Instant-only releases as missing thinking, not a fake budget', () => {
    const thinking = frontierThinkingFor(thinkingModel())
    expect(thinking.thinkingTokenMult).toBeNull()
    expect(thinking.recipeName).toBeNull()
    expect(thinking.peakCapability).toBe(72)
    expect(formatFrontierThinking(thinking)).toBe('think —')
    expect(thinkingPointRadius(thinking.thinkingTokenMult)).toBe(3.25)
  })

  it('uses the trained thinking budget and lifts peak capability', () => {
    const model = thinkingModel({
      productProfile: {
        lifecycle: 'reasoning',
        focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
        personality: 50,
        tokenEfficiency: 50,
        effortRecipes: [INSTANT, THINK],
        defaultEffortId: 'think',
      },
    })
    const thinking = frontierThinkingFor(model)
    expect(thinking.thinkingTokenMult).toBe(4)
    expect(thinking.recipeName).toBe('Think')
    expect(thinking.peakCapability).toBeGreaterThan(thinking.instantCapability)
    expect(formatFrontierThinking(thinking)).toBe('think 4.0× Think')
    expect(thinkingPointRadius(4)).toBeGreaterThan(thinkingPointRadius(null))
    expect(formatFrontierReadout({ model }, thinking)).toContain('think 4.0× Think')
  })
})

describe('benchmark compare workflow', () => {
  it('uses the compact treatment for portrait and landscape phone widths', () => {
    expect(isCompactBenchmarkViewport(390, 844)).toBe(true)
    expect(isCompactBenchmarkViewport(844, 390)).toBe(true)
    expect(isCompactBenchmarkViewport(1080, 540)).toBe(true)
    expect(isCompactBenchmarkViewport(1024, 768)).toBe(false)
    expect(isCompactBenchmarkViewport(1280, 720)).toBe(false)
  })

  it('renders player vs frontier per metric from leaderboard rows', () => {
    const player = v4Row()
    const rival = v4Row({
      labId: 'aegis',
      labName: 'Aegis Labs',
      entryId: 'ep-aegis',
      name: 'Aegis Live',
      isPlayer: false,
      scores: { overall: 70, language: 68, code: 72, math: 64 },
      overall: 70,
      contaminated: ['math'],
    })
    const markup = renderToStaticMarkup(
      createElement(BenchmarkCompareTab, { rows: [player, rival] }),
    )

    expect(markup).toContain('data-benchmark-compare')
    expect(markup).toContain('You vs the public board')
    expect(markup).toContain('data-compare-metric="overall"')
    expect(markup).toContain('data-compare-metric="code"')
    expect(markup).toContain('aria-label="Player versus frontier by metric"')
    expect(markup).toContain('Pick two live endpoints, then inspect exact scores.')
    expect(markup).toContain('data-swipe-ignore="true"')
    expect(markup).toContain('touch-pan-x touch-pan-y')
    expect(markup).toContain('snap-x snap-proximity')
    expect(markup).toContain('min-h-11')
    expect(markup).toContain('Atlas Live')
    expect(markup).toContain('Aegis Live')
    expect(markup).toContain('math')
  })
})
