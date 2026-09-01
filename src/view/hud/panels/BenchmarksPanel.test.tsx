import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import type { Model } from '../../../sim/types'
import { instantRecipe } from '../../../sim/balance/modelProduct'
import { SUITE_METRICS } from '../../../sim/balance/evaluationSuites'
import { useGameStore } from '../../../store/gameStore'
import {
  BenchmarkScoreCost,
  BenchmarksPanel,
  InternalBenchmarksTab,
  MobileBenchmarkCard,
  SelectedBenchmarkModelReview,
  projectedBenchmarkScore,
} from './BenchmarksPanel'

function releasedThinkingModel(): Model {
  const benchmarks = {
    mmlu: 61, coding: 58, math: 63, vision: 24, law: 49, health: 51,
    science: 60, multilingual: 55, agents: 54, safety: 72, personality: 48,
  }
  return {
    id: 'review-model', name: 'Review Model', family: 'dense', paramsB: 8,
    capability: 60, releaseDay: 9, modalities: ['text'],
    productPreset: 'language',
    io: { inputs: { text: 50 }, outputs: { text: 50 }, tools: 0 },
    quality: { reasoning: 60, coding: 58, chat: 62, image: 20, video: 10, safety: 72, reliability: 66 },
    benchmarks, benchmarkSuites: { language: benchmarks },
    productProfile: {
      lifecycle: 'aligned',
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 48, tokenEfficiency: 55, defaultEffortId: 'instant',
      effortRecipes: [
        instantRecipe(),
        { id: 'deep', name: 'Deep', kind: 'trained', thinkingTokenMult: 32,
          trainPfDays: 20, trainCash: 100_000, trained: true, quality: 0.9, served: true },
      ],
    },
    postTrain: 'process', release: 'released', shipped: true,
    commerciallyOffered: true,
    inferCostMult: 1, tokPerSecMult: 1,
    apiPricePerMTok: 8, apiPriceInPerMTok: 3, apiPriceOutPerMTok: 15,
    suggestedApiPrice: 8, suggestedApiPriceIn: 3, suggestedApiPriceOut: 15,
  } as Model
}

describe('BenchmarksPanel official leaderboard and review', () => {
  it('lists Instant and trained thinking levels as official ranked rows', () => {
    const state = createGame(64_221)
    const model = releasedThinkingModel()
    const next = { ...state, player: { ...state.player, models: [model] } }
    useGameStore.setState({ state: next })
    const markup = renderToStaticMarkup(createElement(BenchmarksPanel))

    expect(markup).toContain('one row per trained thinking level')
    expect(markup).toContain('Ranks, model economics and reviews.')
    expect(markup).toContain('aria-sort="descending"')
    expect(markup).toContain('Sort by Coding')
    expect(markup).toContain('data-mobile-benchmark-sort')
    expect(markup).toContain('aria-label="Mobile benchmark sort"')
    expect(markup).toContain('data-mobile-benchmark-leaderboard')
    expect(markup).toContain('data-mobile-official-benchmarks')
    expect(markup).toContain('data-desktop-official-benchmarks')
    expect(markup).toContain('data-swipe-ignore="true"')
    expect(markup).toContain('touch-pan-x touch-pan-y')

    const row = {
      labId: 'player', labName: 'Labline', color: 0x3dffc0, model,
      isPlayer: true, kind: 'model' as const, recipeId: 'instant',
      recipeName: 'Instant', displayName: model.name, capability: model.capability,
      tokenMult: 1, usdPerMTok: 8, scores: model.benchmarkSuites!.language!,
    }
    const review = renderToStaticMarkup(createElement(SelectedBenchmarkModelReview, {
      row, rank: 1, suiteId: 'language', metrics: SUITE_METRICS.language,
      recipeId: 'deep', onRecipeChange: () => {},
      prices: { priceIn: 3, priceOut: 15 }, servingEfficiency: 1,
      publishedReviews: [],
    }))
    expect(review).toContain('Instant')
    expect(review).toContain('Deep · 32.0× budget')
    expect(review).toContain('Effective $/MTok')
    expect(review).toContain('Per-task benchmark ledger')
    expect(review).not.toContain('<details open')
    const once = projectedBenchmarkScore(model, 'coding', 58, 'deep')
    expect(once).toBeGreaterThan(58)
    expect(projectedBenchmarkScore(model, 'coding', 58, 'instant')).toBe(58)
    expect(projectedBenchmarkScore(model, 'coding', once, 'deep')).toBeGreaterThan(once)

    const mobileCard = renderToStaticMarkup(createElement(MobileBenchmarkCard, {
      row,
      rank: 1,
      selected: true,
      metrics: SUITE_METRICS.language,
      sortId: 'cap',
      prices: { priceIn: 3, priceOut: 15 },
      servingEfficiency: 1,
      onSelect: () => {},
    }))
    expect(mobileCard).toContain('Instant')
    expect(mobileCard).toContain('All 11 scores &amp; task cost')
    expect(mobileCard).toContain('aria-controls="benchmark-model-review"')
    expect(mobileCard).toContain('aria-expanded="false"')

    const cost = renderToStaticMarkup(createElement(BenchmarkScoreCost, {
      model, metric: SUITE_METRICS.language[1]!, score: 58,
      prices: { priceIn: 3, priceOut: 15 }, servingEfficiency: 1,
      placeAbove: false,
    }))
    expect(cost).toContain('Estimated representative task economics')
    expect(cost).toContain('input list $3.00/MTok')
    expect(cost).toContain('data-benchmark-cost-trigger')
    expect(cost).toContain('aria-haspopup="dialog"')
    expect(cost).toContain('aria-expanded="false"')

    const deepCard = renderToStaticMarkup(createElement(MobileBenchmarkCard, {
      row: {
        ...row,
        recipeId: 'deep',
        recipeName: 'Deep',
        displayName: 'Review Model-Deep',
        tokenMult: 8,
      },
      rank: 1,
      selected: false,
      metrics: SUITE_METRICS.language,
      sortId: 'cap',
      prices: { priceIn: 3, priceOut: 15 },
      servingEfficiency: 1,
      onSelect: () => {},
    }))
    expect(deepCard).toContain('Review Model-Deep')
    expect(deepCard).toContain('Deep')
    expect(deepCard).not.toContain('>Instant<')
  })

  it('keeps trained thinking rows on the official public board', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./BenchmarksPanel.tsx', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('expandLeaderboardEffortRows(boardModels')
    expect(source).not.toContain(
      '.filter((row) => row.recipeId === INSTANT_EFFORT_ID)',
    )
    expect(source).toContain('one row per trained thinking level')
    expect(source).toContain('setReviewRecipeId(row.recipeId)')
    expect(source).toContain('setReviewRecipeId(r.recipeId)')
    expect(source).toContain('{row.recipeName}')
  })

  it('renders a concise, sortable internal card view before the wide table', () => {
    const state = createGame(64_222)
    const model = {
      ...releasedThinkingModel(),
      id: 'private-mobile-model',
      name: 'Private Mobile Model',
      release: 'internal' as const,
      shipped: false,
      commerciallyOffered: false,
    }
    const markup = renderToStaticMarkup(createElement(InternalBenchmarksTab, {
      rows: [{
        id: model.id,
        name: model.name,
        status: 'internal' as const,
        day: model.releaseDay,
        capability: model.capability,
        safety: model.quality.safety,
        suite: model.benchmarks.mmlu,
        pending: false,
        model,
      }],
      suiteId: 'language',
      metrics: SUITE_METRICS.language,
      state,
      columns: [],
    }))

    expect(markup).toContain('data-mobile-internal-sort')
    expect(markup).toContain('aria-label="Mobile internal benchmark sort"')
    expect(markup).toContain('data-mobile-internal-benchmarks')
    expect(markup).toContain('data-desktop-internal-benchmarks')
    expect(markup).toContain('Scores &amp; trained effort')
    expect(markup).toContain('role="region" aria-label="Internal benchmark table"')
    expect(markup).toContain('touch-pan-x touch-pan-y')
  })
})
