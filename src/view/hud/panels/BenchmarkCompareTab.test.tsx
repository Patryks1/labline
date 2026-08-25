import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BenchmarkSuiteId, EffortRecipe } from '../../../sim/types'
import {
  EVALUATION_MARKETS,
  SUITE_METRICS,
  suiteForEvaluationMarket,
} from '../../../sim/balance/evaluationSuites'
import type { collectLeaderboardModels } from '../../../sim/systems/rivals'
import {
  BenchmarkCompareTab,
  formatFrontierReadout,
  formatFrontierThinking,
  frontierThinkingFor,
  thinkingPointRadius,
} from './BenchmarkCompareTab'

type LeaderboardRow = ReturnType<typeof collectLeaderboardModels>[number]

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

function fixtureRow(
  suiteId: BenchmarkSuiteId,
  overrides: Partial<LeaderboardRow> & { model?: Partial<LeaderboardRow['model']> } = {},
): LeaderboardRow {
  const { model: modelOverrides, ...rowOverrides } = overrides
  return {
    labId: 'player',
    labName: 'You',
    color: 0x3dffc0,
    isPlayer: true,
    kind: 'model',
    ...rowOverrides,
    model: {
      id: 'model-atlas',
      name: 'Atlas',
      family: 'dense',
      releaseDay: 12,
      capability: 72,
      paramsB: 7.4,
      modalities: ['text'],
      quality: {
        reasoning: 65,
        coding: 62,
        chat: 68,
        image: 20,
        video: 0,
        safety: 70,
        reliability: 72,
      },
      benchmarks: {
        mmlu: 72,
        coding: 62,
        math: 60,
        vision: 20,
        law: 55,
        health: 58,
        science: 52,
        multilingual: 60,
        agents: 40,
        safety: 70,
      },
      benchmarkSuites: { [suiteId]: {} },
      ...modelOverrides,
    } as LeaderboardRow['model'],
  }
}

describe('frontier thinking encoding', () => {
  it('treats Instant-only releases as missing thinking, not a fake budget', () => {
    const thinking = frontierThinkingFor(fixtureRow('language').model)
    expect(thinking.thinkingTokenMult).toBeNull()
    expect(thinking.recipeName).toBeNull()
    expect(thinking.peakCapability).toBe(72)
    expect(formatFrontierThinking(thinking)).toBe('think —')
    expect(thinkingPointRadius(thinking.thinkingTokenMult)).toBe(3.25)
  })

  it('uses the trained thinking budget and lifts peak capability', () => {
    const row = fixtureRow('language', {
      model: {
        productProfile: {
          lifecycle: 'reasoning',
          focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
          personality: 50,
          tokenEfficiency: 50,
          effortRecipes: [INSTANT, THINK],
          defaultEffortId: 'think',
        },
      },
    })
    const thinking = frontierThinkingFor(row.model)
    expect(thinking.thinkingTokenMult).toBe(4)
    expect(thinking.recipeName).toBe('Think')
    expect(thinking.peakCapability).toBeGreaterThan(thinking.instantCapability)
    expect(formatFrontierThinking(thinking)).toBe('think 4.0× Think')
    expect(thinkingPointRadius(4)).toBeGreaterThan(thinkingPointRadius(null))
    expect(formatFrontierReadout(row, thinking)).toContain('think 4.0× Think')
  })
})

describe('benchmark compare workflow', () => {
  it('exposes one touch-sized market group and a pinned chart readout', () => {
    const market = EVALUATION_MARKETS[0]!.id
    const suiteId = suiteForEvaluationMarket(market)
    const markup = renderToStaticMarkup(
      createElement(BenchmarkCompareTab, {
        rows: [fixtureRow(suiteId)],
        suiteId,
        metrics: SUITE_METRICS[suiteId],
        market,
        onMarketChange: () => undefined,
      }),
    )

    expect(markup).toContain('role="group" aria-label="Market filters"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-label="Frontier progress: capability and thinking by release day"')
    expect(markup).toContain('Cap + thinking over time')
    expect(markup).toContain('size = think ×')
    expect(markup).toContain('data-benchmark-pinned-point')
    expect(markup).toContain('Point size is thinking budget (— if none). Hover or select a point; click or tap to pin.')
    expect(markup).toContain('data-point-detail="think —"')
  })

  it('renders rival thinking budgets as larger markers than Instant-only', () => {
    const market = EVALUATION_MARKETS[0]!.id
    const suiteId = suiteForEvaluationMarket(market)
    const player = fixtureRow(suiteId)
    const rival = fixtureRow(suiteId, {
      labId: 'aegis',
      labName: 'Aegis Labs',
      color: 0x6ea8ff,
      isPlayer: false,
      model: {
        id: 'aegis-think',
        name: 'Aegis Think',
        releaseDay: 18,
        capability: 68,
        productProfile: {
          lifecycle: 'reasoning',
          focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
          personality: 48,
          tokenEfficiency: 50,
          effortRecipes: [INSTANT, THINK],
          defaultEffortId: 'think',
        },
      },
    })
    const markup = renderToStaticMarkup(
      createElement(BenchmarkCompareTab, {
        rows: [player, rival],
        suiteId,
        metrics: SUITE_METRICS[suiteId],
        market,
        onMarketChange: () => undefined,
      }),
    )

    expect(markup).toContain('data-point-detail="think —"')
    expect(markup).toContain('data-point-detail="think 4.0× Think"')
    expect(thinkingPointRadius(4)).toBeGreaterThan(thinkingPointRadius(null))
  })
})
