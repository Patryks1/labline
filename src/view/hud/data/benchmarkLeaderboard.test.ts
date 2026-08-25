import { describe, expect, it } from 'vitest'
import type { Model } from '../../../sim/types'
import {
  INSTANT_EFFORT_ID,
  instantRecipe,
} from '../../../sim/balance/modelProduct'
import {
  expandLeaderboardEffortRows,
  leaderboardEffortDisplayName,
  leaderboardMetricCost,
  leaderboardMetricCostTitle,
  rankLeaderboardEffortRows,
  type LeaderboardModelRow,
} from './benchmarkLeaderboard'

function benches(overrides: Partial<Model['benchmarks']> = {}) {
  return {
    mmlu: 40,
    coding: 40,
    math: 40,
    vision: 20,
    law: 30,
    health: 30,
    science: 40,
    multilingual: 30,
    agents: 30,
    safety: 50,
    personality: 22,
    ...overrides,
  }
}

function thinkingModel(name = 'Solace'): Model {
  return {
    id: 'solace',
    name,
    family: 'dense',
    capability: 40,
    paramsB: 8,
    releaseDay: 12,
    modalities: ['text'],
    reasoningEnabled: true,
    postTrain: 'process',
    quality: {
      reasoning: 50,
      coding: 50,
      chat: 50,
      image: 20,
      video: 10,
      safety: 50,
      reliability: 50,
    },
    benchmarks: benches(),
    productProfile: {
      lifecycle: 'aligned',
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 22,
      tokenEfficiency: 50,
      defaultEffortId: INSTANT_EFFORT_ID,
      effortRecipes: [
        instantRecipe(),
        {
          id: 'medium',
          name: 'Think',
          kind: 'trained',
          thinkingTokenMult: 2.2,
          trainPfDays: 0,
          trainCash: 0,
          trained: true,
          quality: 1,
          served: true,
        },
        {
          id: 'high',
          name: 'Deep',
          kind: 'trained',
          thinkingTokenMult: 4.5,
          trainPfDays: 0,
          trainCash: 0,
          trained: true,
          quality: 1,
          served: true,
        },
      ],
    },
  } as Model
}

function instantOnlyModel(name = 'Spark'): Model {
  return {
    ...thinkingModel(name),
    id: 'spark',
    name,
    productProfile: {
      lifecycle: 'foundation',
      focus: { coding: 0, science: 0, research: 0, personality: 0, chat: 0 },
      personality: 22,
      tokenEfficiency: 50,
      defaultEffortId: INSTANT_EFFORT_ID,
      effortRecipes: [instantRecipe()],
    },
  } as Model
}

function asRow(model: Model, isPlayer = true): LeaderboardModelRow {
  return {
    labId: isPlayer ? 'player' : 'rival-a',
    labName: isPlayer ? 'You' : 'Northstar',
    color: 0x3dffc0,
    model,
    isPlayer,
    kind: 'model',
  }
}

describe('leaderboardEffortDisplayName', () => {
  it('hyphenates think level when a model has multiple recipes', () => {
    expect(
      leaderboardEffortDisplayName('Solace', instantRecipe(), 3),
    ).toBe('Solace-Instant')
    expect(
      leaderboardEffortDisplayName(
        'Solace',
        { kind: 'trained', name: 'Think' },
        3,
      ),
    ).toBe('Solace-Think')
    expect(
      leaderboardEffortDisplayName(
        'Solace',
        { kind: 'trained', name: 'Careful' },
        2,
      ),
    ).toBe('Solace-Careful')
  })

  it('keeps the bare name for instant-only models', () => {
    expect(
      leaderboardEffortDisplayName('Spark', instantRecipe(), 1),
    ).toBe('Spark')
  })
})

describe('expandLeaderboardEffortRows', () => {
  it('expands one row per trained thinking level and ranks Deep above Instant', () => {
    const rows = expandLeaderboardEffortRows([asRow(thinkingModel())], {
      suiteId: 'language',
      unitUsdPerMTokFor: () => 0.15,
    })
    const ranked = rankLeaderboardEffortRows(rows, 'cap')

    expect(rows.map((row) => row.displayName)).toEqual([
      'Solace-Instant',
      'Solace-Think',
      'Solace-Deep',
    ])
    expect(ranked[0]?.displayName).toBe('Solace-Deep')
    expect(ranked[0]?.capability ?? 0).toBeGreaterThan(
      rows.find((row) => row.recipeId === INSTANT_EFFORT_ID)?.capability ?? 0,
    )
    expect(ranked.every((row) => row.isPlayer)).toBe(true)
  })

  it('does not invent Think or Deep rows for instant-only models', () => {
    const rows = expandLeaderboardEffortRows([asRow(instantOnlyModel())], {
      suiteId: 'language',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.displayName).toBe('Spark')
    expect(rows[0]?.recipeName).toBe('Instant')
  })

  it('keeps list-price $/MTok the same while Think/Deep use more tokens', () => {
    const rows = expandLeaderboardEffortRows([asRow(thinkingModel())], {
      suiteId: 'language',
      unitUsdPerMTokFor: () => 0.15,
    })
    const instant = rows.find((row) => row.recipeId === INSTANT_EFFORT_ID)
    const think = rows.find((row) => row.recipeId === 'medium')
    const deep = rows.find((row) => row.recipeId === 'high')

    expect(instant?.usdPerMTok).toBe(0.15)
    expect(think?.usdPerMTok).toBe(0.15)
    expect(deep?.usdPerMTok).toBe(0.15)
    expect(think?.tokenMult ?? 0).toBeGreaterThan(instant?.tokenMult ?? 0)
    expect(deep?.tokenMult ?? 0).toBeGreaterThan(think?.tokenMult ?? 0)
  })

  it('lifts hard-task category scores with thinking and leaves voice at the model score', () => {
    const rows = expandLeaderboardEffortRows([asRow(thinkingModel())], {
      suiteId: 'language',
    })
    const instant = rows.find((row) => row.recipeId === INSTANT_EFFORT_ID)
    const deep = rows.find((row) => row.recipeId === 'high')

    expect(deep?.scores.coding ?? 0).toBeGreaterThan(instant?.scores.coding ?? 0)
    expect(deep?.scores.math ?? 0).toBeGreaterThan(instant?.scores.math ?? 0)
    expect(deep?.scores.personality).toBe(instant?.scores.personality)
    expect(deep?.scores.safety).toBe(instant?.scores.safety)
  })

  it('ranks by the score for that row’s thinking level', () => {
    const ranked = rankLeaderboardEffortRows(
      expandLeaderboardEffortRows([asRow(thinkingModel())], {
        suiteId: 'language',
      }),
      'coding',
    )

    expect(ranked.map((row) => row.displayName)).toEqual([
      'Solace-Deep',
      'Solace-Think',
      'Solace-Instant',
    ])
    expect(ranked[0]?.scores.coding ?? 0).toBeGreaterThan(
      ranked[ranked.length - 1]?.scores.coding ?? 0,
    )
  })
})

describe('leaderboardMetricCostTitle', () => {
  it('shows toks × thinking and $ / query from list price', () => {
    const rows = expandLeaderboardEffortRows([asRow(thinkingModel())], {
      suiteId: 'language',
      unitUsdPerMTokFor: () => 0.15,
    })
    const think = rows.find((row) => row.recipeId === 'medium')!
    const coding = leaderboardMetricCost(think, 'coding')
    const knowledge = leaderboardMetricCost(think, 'mmlu')

    expect(coding.tokens).toBeGreaterThan(knowledge.tokens)
    expect(coding.usdPerQuery).toBeGreaterThan(knowledge.usdPerQuery ?? 0)
    expect(
      leaderboardMetricCostTitle(think, { id: 'coding', label: 'Coding' }),
    ).toMatch(/Coding \d+ · .+ toks \(.*× Think\) · \$/)
    expect(
      leaderboardMetricCostTitle(think, { id: 'coding', label: 'Coding' }),
    ).toContain('/ query at $0.15/MTok')
  })

  it('Deep burns more tokens than Instant at the same $/MTok', () => {
    const rows = expandLeaderboardEffortRows([asRow(thinkingModel())], {
      suiteId: 'language',
      unitUsdPerMTokFor: () => 0.15,
    })
    const instant = rows.find((row) => row.recipeId === INSTANT_EFFORT_ID)!
    const deep = rows.find((row) => row.recipeId === 'high')!
    expect(leaderboardMetricCost(deep, 'math').usdPerQuery!).toBeGreaterThan(
      leaderboardMetricCost(instant, 'math').usdPerQuery!,
    )
  })
})
