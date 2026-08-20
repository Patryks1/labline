import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BenchmarkSuiteId } from '../../../sim/types'
import {
  EVALUATION_MARKETS,
  SUITE_METRICS,
  suiteForEvaluationMarket,
} from '../../../sim/balance/evaluationSuites'
import type { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { BenchmarkCompareTab } from './BenchmarkCompareTab'

type LeaderboardRow = ReturnType<typeof collectLeaderboardModels>[number]

function fixtureRow(suiteId: BenchmarkSuiteId): LeaderboardRow {
  return {
    labId: 'player',
    labName: 'You',
    color: 0x3dffc0,
    isPlayer: true,
    kind: 'model',
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
    } as LeaderboardRow['model'],
  }
}

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
    expect(markup).toContain('aria-label="Frontier progress: capability by release day"')
    expect(markup).toContain('data-benchmark-pinned-point')
    expect(markup).toContain('Hover or select a point to inspect it; click or tap to pin the readout.')
  })
})
