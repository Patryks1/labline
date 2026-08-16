import { buildLabStats, type LabStats, type TrendSeries } from '../../../sim/systems/stats'
import { computeSnapshot } from '../../../sim/systems/compute'
import type {
  FinanceDaySnapshot,
  LabFinance,
  PlanStatsDaySnapshot,
  SimState,
} from '../../../sim/types'

const HISTORY_LIMIT = 180

export interface FinanceRevenueView {
  /** Authoritative total; channel rows are explanatory, never additive fallbacks. */
  total: number
  api: number
  subscription: number
  enterprise: number
  other: number
}

export interface FinanceCostsView {
  /** Product COGS attribution from finance.dayCogs. */
  productCogs: number
  /** Authoritative all-cash-out total from finance.dayTotalOut. */
  totalCashOut: number
  /** Residual cash out after the product COGS attribution. */
  operatingCashOut: number
  /** Book-only amortization, deliberately excluded from cash totals. */
  nonCashAmortization: number
  energy: number
  wages: number
  hosting: number
  marketing: number
  loans: number
  ledger: number
}

export interface FinanceCurrentView extends FinanceDaySnapshot {
  runwayDays: number
  lifetimeRevenue: number
  lifetimeNet: number
  debtOutstanding: number
}

export interface FinanceDashboardModel {
  day: number
  /** Existing rich lab statistics remain available to every caller. */
  stats: LabStats
  finance: LabFinance
  current: FinanceCurrentView
  revenue: FinanceRevenueView
  costs: FinanceCostsView
  /** Daily history with the current day merged from authoritative finance fields. */
  history: FinanceDaySnapshot[]
  /** Per-plan history with the current day merged when history already exists. */
  planHistory: PlanStatsDaySnapshot[]
  trends: TrendSeries
}

export interface FinanceDashboardReadouts {
  finance: LabFinance
  current: FinanceCurrentView
  revenue: FinanceRevenueView
  costs: FinanceCostsView
}

interface NormalizedFinanceValues {
  revenue: number
  productCogs: number
  energy: number
  net: number
  totalCashOut: number
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeFinanceValues(finance: LabFinance): NormalizedFinanceValues {
  const revenue = finiteOr(finance.dayRevenue, 0)
  const productCogs = Math.max(0, finiteOr(finance.dayCogs, 0))
  const energy = Math.max(0, finiteOr(finance.dayEnergyCost, 0))
  const net = finiteOr(finance.dayNet, revenue - productCogs - energy)
  // Older saves did not persist one or both authoritative ledger totals. A
  // net-derived outflow keeps the shell consistent without inventing a second
  // P&L formula in each consumer.
  const totalCashOut = Math.max(0, finiteOr(finance.dayTotalOut, revenue - net))
  return { revenue, productCogs, energy, net, totalCashOut }
}

/**
 * Replace the current-day history row instead of appending a second copy.
 * Ledger events patch this same row during a day, so current finance remains
 * the final owner of net/cash/outflow values when the panel renders.
 */
export function mergeCurrentFinanceHistory(
  history: FinanceDaySnapshot[],
  current: FinanceDaySnapshot,
): FinanceDaySnapshot[] {
  if (history.length === 0) return []
  const last = history.at(-1)
  if (last?.day === current.day) {
    return [...history.slice(0, -1), current].slice(-HISTORY_LIMIT)
  }
  return [...history, current].slice(-HISTORY_LIMIT)
}

function currentFinanceSnapshot(
  state: SimState,
  finance: LabFinance,
  values = normalizeFinanceValues(finance),
): FinanceCurrentView {
  const snapshot = computeSnapshot(state)
  return {
    day: state.day,
    cash: state.player.cash,
    revenue: values.revenue,
    productCogs: values.productCogs,
    // Keep this residual derived from the authoritative total; do not sum the
    // rich P&L rows, which contain explanatory "of which" and book-only lines.
    opex: Math.max(0, values.totalCashOut - values.productCogs),
    energy: values.energy,
    net: values.net,
    share: finiteOr(finance.totalShare, 0),
    servedMTok: state.lastMarket.servedMTok,
    demandMTok: state.lastMarket.playerDemandMTok,
    effectivePf: snapshot.effectiveFlopsPf,
    valuation: finiteOr(finance.valuation, 0),
    debtOutstanding: Math.max(0, finiteOr(finance.debtOutstanding, 0)),
    brand: finiteOr(state.player.brandTrust, 0),
    // Infinity is the authoritative profitable-runway value; finiteOr would
    // incorrectly turn it into a zero-day warning for fresh campaigns.
    runwayDays:
      typeof finance.runwayDays === 'number' && !Number.isNaN(finance.runwayDays)
        ? finance.runwayDays
        : Number.POSITIVE_INFINITY,
    lifetimeRevenue: finiteOr(finance.lifetimeRevenue, 0),
    lifetimeNet: finiteOr(finance.lifetimeNet, 0),
  }
}

export function selectFinanceDashboardReadouts(state: SimState): FinanceDashboardReadouts {
  const finance = state.player.finance
  const values = normalizeFinanceValues(finance)
  const revenue: FinanceRevenueView = {
    total: values.revenue,
    api: finiteOr(finance.apiRevenue, 0),
    subscription: finiteOr(finance.subRevenue, 0),
    enterprise: finiteOr(finance.enterpriseRevenue, 0),
    other: Math.max(
      0,
      values.revenue -
        finiteOr(finance.apiRevenue, 0) -
        finiteOr(finance.subRevenue, 0) -
        finiteOr(finance.enterpriseRevenue, 0),
    ),
  }
  const costs: FinanceCostsView = {
    productCogs: values.productCogs,
    totalCashOut: values.totalCashOut,
    operatingCashOut: Math.max(0, values.totalCashOut - values.productCogs),
    nonCashAmortization: Math.max(0, finiteOr(finance.dayChipAmort, 0)),
    energy: values.energy,
    wages: Math.max(0, finiteOr(finance.dayWageCost, 0)),
    hosting: Math.max(0, finiteOr(finance.dayHostingOpex, 0)),
    marketing: Math.max(0, finiteOr(finance.dayMarketing, 0)),
    loans: Math.max(0, finiteOr(finance.dayLoanPayment, 0)),
    ledger: Math.max(
      0,
      finiteOr(finance.dayDataCost, 0) +
        finiteOr(finance.dayTrainingCost, 0) +
        finiteOr(finance.dayResearchCost, 0) +
        finiteOr(finance.dayHiringCost, 0) +
        finiteOr(finance.dayCapexCost, 0),
    ),
  }
  return {
    finance,
    current: currentFinanceSnapshot(state, finance, values),
    revenue,
    costs,
  }
}

export function selectFinanceDashboardView(state: SimState): {
  current: FinanceCurrentView
  history: FinanceDaySnapshot[]
} {
  const readouts = selectFinanceDashboardReadouts(state)
  return {
    current: readouts.current,
    history: mergeCurrentFinanceHistory(state.financeHistory, readouts.current),
  }
}

function currentPlanHistorySnapshot(state: SimState, stats: LabStats): PlanStatsDaySnapshot {
  return {
    day: state.day,
    plans: stats.plans.map((plan) => ({
      planId: plan.planId,
      name: plan.name,
      pricePerMonth:
        state.player.pricing.plans.find((candidate) => candidate.id === plan.planId)?.pricePerMonth ?? 0,
      subscribers: plan.subscribers,
      dayRevenue: plan.dayRevenue,
      dayMTok: plan.dayMTok,
    })),
  }
}

function mergeCurrentPlanHistory(
  history: PlanStatsDaySnapshot[],
  current: PlanStatsDaySnapshot,
): PlanStatsDaySnapshot[] {
  if (history.length === 0) return []
  const last = history.at(-1)
  if (last?.day === current.day) {
    return [...history.slice(0, -1), current]
  }
  return [...history, current].slice(-HISTORY_LIMIT)
}

function trendSeries(history: FinanceDaySnapshot[]): TrendSeries {
  return {
    days: history.map((sample) => sample.day),
    revenue: history.map((sample) => sample.revenue),
    net: history.map((sample) => sample.net),
    cash: history.map((sample) => sample.cash),
    share: history.map((sample) => sample.share),
    servedMTok: history.map((sample) => sample.servedMTok),
    effectivePf: history.map((sample) => sample.effectivePf),
    valuation: history.map((sample) => sample.valuation),
  }
}

export function buildFinanceDashboardModel(state: SimState): FinanceDashboardModel {
  const stats = buildLabStats(state)
  const readouts = selectFinanceDashboardReadouts(state)
  const { finance, current, revenue, costs } = readouts
  const history = mergeCurrentFinanceHistory(state.financeHistory, current)
  return {
    day: state.day,
    stats,
    finance,
    current,
    revenue,
    costs,
    history,
    planHistory: mergeCurrentPlanHistory(
      state.planStatsHistory ?? [],
      currentPlanHistorySnapshot(state, stats),
    ),
    trends: trendSeries(history),
  }
}
