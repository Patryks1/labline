import { calendarForDay } from '../campaign'
import type { FinanceDaySnapshot, FinanceMonthSnapshot, SimState } from '../types'

export const HISTORY_LIMITS = {
  financeDays: 180,
  alerts: 40,
  news: 64,
  marketFills: 80,
  reviews: 120,
  evaluations: 240,
  benchmarkSeasons: 64,
  financeMonths: 600,
  pendingIntents: 128,
} as const

/** Keeps chronological series (oldest first) bounded to the newest entries. */
export function boundDailyHistory<T>(
  history: readonly T[],
  limit = HISTORY_LIMITS.financeDays,
): T[] {
  const safeLimit = Math.max(0, Math.floor(limit))
  if (safeLimit === 0) return []
  return history.length > safeLimit ? history.slice(-safeLimit) : [...history]
}

function addDayToMonth(
  existing: FinanceMonthSnapshot | undefined,
  day: FinanceDaySnapshot,
  state: SimState,
): FinanceMonthSnapshot {
  const calendar = calendarForDay(day.day, state.config.campaignRules)
  if (!existing) {
    return {
      year: calendar.year,
      month: calendar.month,
      firstDay: day.day,
      lastDay: day.day,
      days: 1,
      closingCash: day.cash,
      revenue: day.revenue,
      productCogs: day.productCogs,
      opex: day.opex,
      energy: day.energy,
      net: day.net,
      averageShare: day.share,
      servedMTok: day.servedMTok,
      demandMTok: day.demandMTok,
      averageEffectivePf: day.effectivePf,
      averageValuation: day.valuation,
    }
  }

  const days = existing.days + 1
  return {
    ...existing,
    firstDay: Math.min(existing.firstDay, day.day),
    lastDay: Math.max(existing.lastDay, day.day),
    days,
    closingCash: day.day >= existing.lastDay ? day.cash : existing.closingCash,
    revenue: existing.revenue + day.revenue,
    productCogs: existing.productCogs + day.productCogs,
    opex: existing.opex + day.opex,
    energy: existing.energy + day.energy,
    net: existing.net + day.net,
    averageShare: (existing.averageShare * existing.days + day.share) / days,
    servedMTok: existing.servedMTok + day.servedMTok,
    demandMTok: existing.demandMTok + day.demandMTok,
    averageEffectivePf:
      (existing.averageEffectivePf * existing.days + day.effectivePf) / days,
    averageValuation:
      (existing.averageValuation * existing.days + day.valuation) / days,
  }
}

/** Move finance days beyond the detailed window into deterministic month bins. */
export function aggregateAgedFinance(state: SimState): {
  daily: FinanceDaySnapshot[]
  monthly: FinanceMonthSnapshot[]
} {
  const history = state.financeHistory ?? []
  const overflow = Math.max(0, history.length - HISTORY_LIMITS.financeDays)
  if (overflow === 0) {
    return {
      daily: [...history],
      monthly: [...(state.financeMonthlyHistory ?? [])],
    }
  }

  const byMonth = new Map<string, FinanceMonthSnapshot>()
  for (const month of state.financeMonthlyHistory ?? []) {
    byMonth.set(`${month.year}-${month.month}`, { ...month })
  }
  for (const day of history.slice(0, overflow)) {
    const calendar = calendarForDay(day.day, state.config.campaignRules)
    const key = `${calendar.year}-${calendar.month}`
    byMonth.set(key, addDayToMonth(byMonth.get(key), day, state))
  }
  const monthly = [...byMonth.values()]
    .sort((a, b) => a.firstDay - b.firstDay)
    .slice(-HISTORY_LIMITS.financeMonths)
  return { daily: history.slice(overflow), monthly }
}

/**
 * Final daily compaction boundary. Operational queues and model portfolios are
 * deliberately untouched; only append/prepend-only reporting collections are
 * bounded so an endless save cannot grow one record per simulated day.
 */
export function boundHistories(state: SimState): SimState {
  const finance = aggregateAgedFinance(state)
  const reviews = [...(state.reviews ?? [])]
    .sort((a, b) => b.publishedDay - a.publishedDay || a.id.localeCompare(b.id))
    .slice(0, HISTORY_LIMITS.reviews)
  const evaluations = [...(state.evaluations ?? [])]
    .sort(
      (a, b) =>
        Math.max(b.publishDay, b.scheduledDay) - Math.max(a.publishDay, a.scheduledDay) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, HISTORY_LIMITS.evaluations)
  const benchmarkSeasons = [...(state.benchmarkSeasons ?? [])]
    .sort((a, b) => b.opensDay - a.opensDay || a.id.localeCompare(b.id))
    .slice(0, HISTORY_LIMITS.benchmarkSeasons)
  const externalities = state.externalities
    ? { ...state.externalities, incidents: state.externalities.incidents.slice(0, 160) }
    : undefined

  return {
    ...state,
    financeHistory: finance.daily,
    financeMonthlyHistory: finance.monthly,
    // Per-plan demand series is oldest-first like financeHistory.
    planStatsHistory: boundDailyHistory(
      state.planStatsHistory ?? [],
      HISTORY_LIMITS.financeDays,
    ),
    // Alerts, news, and fills are newest-first in the existing simulation.
    alerts: (state.alerts ?? []).slice(0, HISTORY_LIMITS.alerts),
    news: (state.news ?? []).slice(0, HISTORY_LIMITS.news),
    worldMarkets: {
      ...state.worldMarkets,
      fills: (state.worldMarkets?.fills ?? []).slice(0, HISTORY_LIMITS.marketFills),
      // Intents are an oldest-first pending queue. A malformed client or an
      // imported save must not turn it into an unbounded event history.
      intents: (state.worldMarkets?.intents ?? []).slice(-HISTORY_LIMITS.pendingIntents),
    },
    reviews,
    evaluations,
    benchmarkSeasons,
    externalities,
  }
}
