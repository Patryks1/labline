/**
 * Day cash ledger helpers — keep dayTotalOut / dayNet / runway aligned with
 * every cash outflow, not only market ops settlement.
 */
import type { LabFinance, SimState } from '../types'

export type FinanceSpendCategory =
  | 'data'
  | 'training'
  | 'research'
  | 'hiring'
  | 'capex'
  | 'ops'
  | 'loan'
  | 'energy'
  | 'externality'

const CATEGORY_FIELD: Partial<
  Record<FinanceSpendCategory, keyof LabFinance>
> = {
  data: 'dayDataCost',
  training: 'dayTrainingCost',
  research: 'dayResearchCost',
  hiring: 'dayHiringCost',
  capex: 'dayCapexCost',
}

export function recomputeRunway(cash: number, dayNet: number): number {
  return dayNet >= 0
    ? Number.POSITIVE_INFINITY
    : cash / Math.max(1, -dayNet)
}

export function ledgerDayOutflows(finance: LabFinance): number {
  return (
    (finance.dayDataCost ?? 0) +
    (finance.dayTrainingCost ?? 0) +
    (finance.dayResearchCost ?? 0) +
    (finance.dayHiringCost ?? 0) +
    (finance.dayCapexCost ?? 0)
  )
}

/** Zero per-day ledger line items at the start of a sim day. */
export function resetDayLedgerCosts(state: SimState): SimState {
  const f = state.player.finance
  return {
    ...state,
    player: {
      ...state.player,
      finance: {
        ...f,
        dayDataCost: 0,
        dayTrainingCost: 0,
        dayResearchCost: 0,
        dayHiringCost: 0,
        dayCapexCost: 0,
      },
    },
  }
}

function patchFinanceHistoryOutflow(
  state: SimState,
  amount: number,
  cash: number,
): SimState {
  if (!(amount > 0) || state.financeHistory.length === 0) return state
  const last = state.financeHistory.length - 1
  return {
    ...state,
    financeHistory: state.financeHistory.map((sample, index) =>
      index === last && sample.day === state.day
        ? {
            ...sample,
            cash,
            opex: sample.opex + amount,
            net: sample.net - amount,
          }
        : sample,
    ),
  }
}

function patchFinanceHistoryIncome(
  state: SimState,
  amount: number,
  cash: number,
): SimState {
  if (!(amount > 0) || state.financeHistory.length === 0) return state
  const last = state.financeHistory.length - 1
  return {
    ...state,
    financeHistory: state.financeHistory.map((sample, index) =>
      index === last && sample.day === state.day
        ? {
            ...sample,
            cash,
            revenue: sample.revenue + amount,
            net: sample.net + amount,
          }
        : sample,
    ),
  }
}

/**
 * Record an already-deducted cash spend on the day P&L / runway.
 * Does not change player.cash — caller must deduct (or use chargeExpense).
 */
export function recordCashSpend(
  state: SimState,
  amount: number,
  category: FinanceSpendCategory,
): SimState {
  if (!(amount > 0)) return state
  const cash = state.player.cash
  const f = state.player.finance
  const field = CATEGORY_FIELD[category]
  const dayTotalOut = (f.dayTotalOut ?? 0) + amount
  const dayNet = (f.dayNet ?? 0) - amount
  const nextFinance: LabFinance = {
    ...f,
    cash,
    dayTotalOut,
    dayNet,
    lifetimeNet: (f.lifetimeNet ?? 0) - amount,
    lowestCash: Math.min(f.lowestCash ?? cash, cash),
    runwayDays: recomputeRunway(cash, dayNet),
    ...(field
      ? { [field]: ((f[field] as number | undefined) ?? 0) + amount }
      : {}),
  }
  return patchFinanceHistoryOutflow(
    {
      ...state,
      player: {
        ...state.player,
        finance: nextFinance,
      },
    },
    amount,
    cash,
  )
}

/** Deduct cash and record the spend on the day ledger. */
export function chargeExpense(
  state: SimState,
  amount: number,
  category: FinanceSpendCategory,
): SimState {
  if (!(amount > 0)) return state
  const cash = state.player.cash - amount
  return recordCashSpend(
    {
      ...state,
      player: {
        ...state.player,
        cash,
      },
    },
    amount,
    category,
  )
}

/** Record cash income against the day P&L (revenue / net / runway). */
export function recordCashIncome(
  state: SimState,
  amount: number,
): SimState {
  if (!(amount > 0)) return state
  const cash = state.player.cash + amount
  const f = state.player.finance
  const dayNet = (f.dayNet ?? 0) + amount
  const next = {
    ...state,
    player: {
      ...state.player,
      cash,
      finance: {
        ...f,
        cash,
        dayRevenue: (f.dayRevenue ?? 0) + amount,
        dayNet,
        dayGrossProfit: (f.dayGrossProfit ?? 0) + amount,
        lifetimeRevenue: (f.lifetimeRevenue ?? 0) + amount,
        lifetimeNet: (f.lifetimeNet ?? 0) + amount,
        peakCash: Math.max(f.peakCash ?? cash, cash),
        runwayDays: recomputeRunway(cash, dayNet),
      },
    },
  }
  return patchFinanceHistoryIncome(next, amount, cash)
}
