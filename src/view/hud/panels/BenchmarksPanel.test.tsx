import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import type { Model, SimState } from '../../../sim/types'
import { emptyBenchmarks } from '../../../sim/balance/benchmarks'
import { instantRecipe } from '../../../sim/balance/modelProduct'
import { SUITE_METRICS } from '../../../sim/balance/evaluationSuites'
import { defaultArchitecture, emptyTrainingState, withTrainingState } from '../../../sim/training/state'
import type { Checkpoint, Endpoint } from '../../../sim/training/types'
import { useGameStore } from '../../../store/gameStore'
import {
  BenchmarkScoreCost,
  BenchmarksPanel,
  InternalBenchmarksTab,
  MobileBenchmarkCard,
  SelectedBenchmarkModelReview,
  projectedBenchmarkScore,
} from './BenchmarksPanel'

function truthAt(value: number) {
  return {
    domains: {
      language: value, reasoning: value, code: value, math: value, science: value,
      vision: 0, video: 0, audio: 0, tools: value,
    },
    factuality: value, steerability: value, robustness: value, safety: value, reliability: value,
  }
}

function makeCheckpoint(labId: string, id: string, value: number, extras?: Partial<Checkpoint>): Checkpoint {
  return {
    id,
    labId,
    lineageId: id,
    name: extras?.name ?? id,
    version: '1.0',
    stage: 'post',
    status: 'released',
    arch: defaultArchitecture(),
    createdDay: 1,
    progressAtSnapshot: 1,
    truth: truthAt(value),
    trainingSummary: {
      pfDays: 12, effectiveMTok: 140, loss: 2, gap: 0.35, dataMix: {}, syntheticShare: 0.2,
    },
    postTrain: { stages: {} },
    tiers: [{ budget: 1, served: true }, { budget: 8, served: true }],
    endpointIds: [],
    ...extras,
  }
}

function makeEndpoint(labId: string, id: string, checkpointId: string, name: string): Endpoint {
  return {
    id,
    labId,
    name,
    members: [{ checkpointId, role: 'primary' }],
    policy: 'single',
    tiers: [{ budget: 1, served: true }, { budget: 8, served: true }],
    precision: 'bf16',
    status: 'live',
    releaseDay: 1,
    pricing: { inPerMTok: 1, outPerMTok: 2 },
    openWeights: false,
    modelId: id,
  }
}

function silenceRivals(state: SimState): SimState {
  return {
    ...state,
    rivals: state.rivals.map((rival) => ({
      ...rival,
      models: [],
      training: emptyTrainingState(),
    })),
  }
}

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
  it('lists V4 live endpoints with tier selector, season, and contamination flags', () => {
    const quiet = silenceRivals(createGame(64_221))
    const checkpoint = makeCheckpoint(quiet.playerLabId, 'cp-board', 58, { name: 'Secret Weights' })
    const endpoint = makeEndpoint(quiet.playerLabId, 'ep-board', 'cp-board', 'Aurora Live')
    const state = withTrainingState(quiet, quiet.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [checkpoint],
      endpoints: [endpoint],
      seasons: [{
        season: 2,
        startDay: 0,
        difficultyIndex: 1,
        contamination: { 'ep-board': ['code'] },
      }],
    })
    useGameStore.setState({ state })
    const markup = renderToStaticMarkup(createElement(BenchmarksPanel, { state }))

    expect(markup).toContain('Aurora Live')
    expect(markup).not.toContain('Secret Weights')
    expect(markup).toContain('×1')
    expect(markup).toContain('×2')
    expect(markup).toContain('×8')
    expect(markup).toContain('×20')
    expect(markup).toContain('Season 2')
    expect(markup).toContain('code')
    expect(markup).toContain('aria-sort="descending"')
    expect(markup).toContain('Sort by Overall')
    expect(markup).toContain('data-mobile-benchmark-sort')
    expect(markup).toContain('aria-label="Mobile benchmark sort"')
    expect(markup).toContain('data-mobile-benchmark-leaderboard')
    expect(markup).toContain('data-mobile-official-benchmarks')
    expect(markup).toContain('data-desktop-official-benchmarks')
    expect(markup).toContain('data-swipe-ignore="true"')
    expect(markup).toContain('touch-pan-x touch-pan-y')
    expect(markup).not.toContain('data-benchmark-fog-hint')

    const model = releasedThinkingModel()
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

  it('shows the fog hint for kept checkpoints without a live endpoint', () => {
    const quiet = silenceRivals(createGame(64_223))
    const kept = makeCheckpoint(quiet.playerLabId, 'cp-kept', 80, {
      name: 'Vault Weights',
      status: 'kept',
    })
    const state = withTrainingState(quiet, quiet.playerLabId, {
      ...emptyTrainingState(),
      checkpoints: [kept],
    })
    useGameStore.setState({ state })
    const markup = renderToStaticMarkup(createElement(BenchmarksPanel, { state }))
    expect(markup).toContain('data-benchmark-fog-hint')
    expect(markup).toContain('Your unreleased checkpoints are private — order an Eval from the Pipeline')
    expect(markup).not.toContain('Vault Weights')
  })

  it('still lists rival legacy models through leaderboard rows', () => {
    const raw = createGame(64_224)
    const quiet = silenceRivals(raw)
    const rival = quiet.rivals[0]
    expect(rival).toBeTruthy()
    const model: Model = {
      id: 'rival-legacy',
      name: 'Helix Legacy',
      family: 'dense',
      paramsB: 7,
      capability: 71,
      releaseDay: 4,
      modalities: ['text'],
      quality: {
        reasoning: 70, coding: 68, chat: 66, image: 10, video: 4, safety: 72, reliability: 70,
      },
      benchmarks: emptyBenchmarks(),
      postTrain: 'none',
      trainComputeSpent: 10,
      shipped: true,
      release: 'released',
      commerciallyOffered: true,
      tokPerSecMult: 1,
      inferCostMult: 1,
      apiPricePerMTok: 2,
      apiPriceInPerMTok: 1,
      apiPriceOutPerMTok: 3,
      suggestedApiPrice: 2,
      suggestedApiPriceIn: 1,
      suggestedApiPriceOut: 3,
    } as Model
    const state: SimState = {
      ...quiet,
      rivals: quiet.rivals.map((row) =>
        row.id === rival!.id ? { ...row, models: [model], training: emptyTrainingState() } : row,
      ),
    }
    useGameStore.setState({ state })
    const markup = renderToStaticMarkup(createElement(BenchmarksPanel, { state }))
    expect(markup).toContain('Helix Legacy')
    expect(markup).toContain('legacy')
  })

  it('reads official rows from leaderboardRows rather than effort expansion', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./BenchmarksPanel.tsx', import.meta.url)),
      'utf8',
    )
    expect(source).toContain('leaderboardRows(state, budget)')
    expect(source).toContain('Your unreleased checkpoints are private')
    expect(source).not.toContain('expandLeaderboardEffortRows(boardModels')
    expect(source).not.toContain('one row per trained thinking level')
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
