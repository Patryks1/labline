import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type {
  EvaluationRun,
  FinanceDaySnapshot,
  MarketFill,
  ModelReview,
  SimAlert,
} from '../types'
import {
  aggregateAgedFinance,
  boundDailyHistory,
  boundHistories,
  HISTORY_LIMITS,
} from './history'

function financeDay(day: number): FinanceDaySnapshot {
  return {
    day,
    cash: day,
    revenue: day,
    productCogs: 0,
    opex: 0,
    energy: 0,
    net: day,
    share: 0,
    servedMTok: 0,
    demandMTok: 0,
    effectivePf: 0,
    valuation: day,
  }
}

describe('bounded campaign histories', () => {
  it('retains exactly the newest 180 chronological finance days', () => {
    const history = Array.from({ length: 240 }, (_, index) => financeDay(index + 1))
    const bounded = boundDailyHistory(history)
    expect(bounded).toHaveLength(180)
    expect(bounded[0]?.day).toBe(61)
    expect(bounded.at(-1)?.day).toBe(240)
    expect(history).toHaveLength(240)
  })

  it('aggregates finance older than 180 days into stable calendar months', () => {
    const base = createGame({
      seed: 81,
      difficulty: 'easy',
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
    })
    const state = {
      ...base,
      financeHistory: Array.from({ length: 240 }, (_, index) => financeDay(index + 1)),
    }
    const compacted = aggregateAgedFinance(state)
    expect(compacted.daily).toHaveLength(180)
    expect(compacted.daily[0]?.day).toBe(61)
    expect(compacted.monthly).toHaveLength(3)
    expect(compacted.monthly[0]).toMatchObject({ year: 2026, month: 1, days: 31 })
    expect(compacted.monthly[1]).toMatchObject({ year: 2026, month: 2, days: 28 })
    expect(compacted.monthly[1]?.lastDay).toBe(59)
    expect(compacted.monthly[2]).toMatchObject({ year: 2026, month: 3, days: 1 })

    const once = boundHistories(state)
    expect(boundHistories(once)).toEqual(once)
  })

  it('bounds all reporting collections without touching operational queues', () => {
    const base = createGame({
      seed: 8,
      difficulty: 'easy',
      advanced: { mapWidth: 20, mapHeight: 20, cityCount: 2, rivalCount: 1 },
    })
    const alerts: SimAlert[] = Array.from({ length: 75 }, (_, index) => ({
      id: `a-${index}`,
      day: 75 - index,
      severity: 'info',
      message: String(index),
    }))
    const fills: MarketFill[] = Array.from({ length: 120 }, (_, index) => ({
      id: `f-${index}`,
      orderId: `o-${index}`,
      labId: 'player',
      kind: 'accelerator',
      resourceId: 'rack_h100',
      quantity: 1,
      unitPrice: 1,
      day: 120 - index,
    }))
    const reviews: ModelReview[] = Array.from({ length: 260 }, (_, index) => ({
      id: `r-${index}`,
      modelId: 'm',
      audience: 'developers',
      capability: 50,
      value: 50,
      productQuality: 50,
      trust: 50,
      publishedDay: index + 1,
      phase: 'quarterly',
      headline: String(index),
    }))
    const evaluations: EvaluationRun[] = Array.from({ length: 260 }, (_, index) => ({
      id: `e-${index}`,
      modelId: 'm',
      seasonId: 's',
      kind: 'public',
      scheduledDay: index,
      publishDay: index + 1,
      scores: {},
      confidence: 0.8,
      contaminationFlags: [],
      published: true,
    }))
    const orders = base.worldMarkets.orders
    const state = {
      ...base,
      financeHistory: Array.from({ length: 240 }, (_, index) => financeDay(index + 1)),
      alerts,
      news: Array.from({ length: 100 }, (_, index) => `news-${index}`),
      worldMarkets: { ...base.worldMarkets, fills },
      reviews,
      evaluations,
      benchmarkSeasons: [],
    }

    const bounded = boundHistories(state)
    expect(bounded.financeHistory).toHaveLength(HISTORY_LIMITS.financeDays)
    expect(bounded.alerts).toHaveLength(HISTORY_LIMITS.alerts)
    expect(bounded.news).toHaveLength(HISTORY_LIMITS.news)
    expect(bounded.worldMarkets.fills).toHaveLength(HISTORY_LIMITS.marketFills)
    expect(bounded.reviews).toHaveLength(HISTORY_LIMITS.reviews)
    expect(bounded.reviews[0]?.publishedDay).toBe(260)
    expect(bounded.evaluations).toHaveLength(HISTORY_LIMITS.evaluations)
    expect(bounded.worldMarkets.orders).toBe(orders)
    expect(boundHistories(bounded)).toEqual(bounded)
  })
})
