/**
 * Bank credit secured against lab valuation.
 * Higher valuation → larger credit line; leverage & risk raise rates.
 */
import { ECONOMY } from '../balance/economy'
import type { ActiveLoan, LoanOffer, SimState } from '../types'
import { computeValuation, playerSotaProximity } from './victory'
import { seededId } from '../rng'

export function totalDebt(loans: ActiveLoan[]): number {
  return loans.reduce((s, l) => s + l.remaining, 0)
}

export function dailyLoanPayment(loans: ActiveLoan[]): number {
  return loans.reduce((s, l) => s + l.dailyPayment, 0)
}

function typedDebtTotal(state: SimState): number {
  return (state.player.capital?.debt ?? []).reduce(
    (sum, debt) => sum + debt.remaining,
    0,
  )
}

function formatM(n: number) {
  return `$${(n / 1e6).toFixed(1)}M`
}

const LOAN_CFG = () => ECONOMY.loans

/** Max total debt banks will hold against this lab. */
export function creditLimitForValuation(
  valuation: number,
  brandTrust = 50,
  /** 0–1 SOTA proximity — banks stretch LTV for frontier labs */
  sotaProximity = 0,
): number {
  const cfg = LOAN_CFG()
  const ltv = (cfg.maxLtv ?? 0.35) * (1 + Math.min(0.18, sotaProximity * 0.18))
  const floor = cfg.minCreditFloor ?? 40_000_000
  const cap = cfg.maxCreditCap ?? 2_500_000_000
  // Brand softens/hardens the line; SOTA labs get better terms
  const brandMult =
    0.85 + Math.min(0.3, Math.max(0, brandTrust) / 200) + sotaProximity * 0.12
  const raw = Math.max(floor, valuation * ltv * brandMult)
  return Math.min(cap, raw)
}

export interface BankCreditSnapshot {
  valuation: number
  /** Max outstanding debt banks allow */
  creditLimit: number
  outstanding: number
  /** Principal you can still draw (approx; interest counted against limit too) */
  available: number
  /** Current debt / valuation */
  ltv: number
  maxLtv: number
  dailyPayment: number
}

export function bankCreditSnapshot(state: SimState): BankCreditSnapshot {
  const valuation = Math.max(
    state.player.finance.valuation || 0,
    computeValuation(state),
  )
  const { sota } = playerSotaProximity(state)
  const outstanding = totalDebt(state.player.loans ?? []) + typedDebtTotal(state)
  const creditLimit = creditLimitForValuation(valuation, state.player.brandTrust, sota)
  const maxLtv = (LOAN_CFG().maxLtv ?? 0.35) * (1 + Math.min(0.18, sota * 0.18))
  // Leave headroom for interest on new draws (~15% buffer of available principal)
  const available = Math.max(0, (creditLimit - outstanding) / 1.15)
  return {
    valuation,
    creditLimit,
    outstanding,
    available,
    ltv: valuation > 1 ? outstanding / valuation : outstanding > 0 ? 1 : 0,
    maxLtv,
    dailyPayment: dailyLoanPayment(state.player.loans ?? []),
  }
}

/**
 * Total interest fraction for a draw — rises with leverage, term, and weak brand/share.
 */
export function interestForDraw(
  state: SimState,
  principal: number,
  termDays: number,
): number {
  const cfg = LOAN_CFG()
  const snap = bankCreditSnapshot(state)
  const postDebt = snap.outstanding + principal * 1.1
  const postLtv = snap.valuation > 1 ? postDebt / snap.valuation : 1
  const base = cfg.baseInterest ?? 0.07
  const termBump = Math.max(0, (termDays - 30) / 90) * (cfg.termInterestPerQuarter ?? 0.04)
  const levBump = Math.max(0, postLtv - 0.12) * (cfg.leverageInterestMult ?? 0.35)
  const brand = state.player.brandTrust
  const brandBump = brand < 40 ? 0.04 : brand < 55 ? 0.02 : 0
  const share = state.player.finance.totalShare ?? 0
  const shareBump = share < 0.02 ? 0.03 : share < 0.08 ? 0.01 : 0
  const pain = state.player.servicePain ?? 0
  const painBump = pain > 0.25 ? 0.04 : pain > 0.1 ? 0.015 : 0
  // Negative-cash labs pay distress pricing on any new credit.
  const cash = state.player.cash
  const distressBump = cash <= -100_000_000 ? 0.06 : cash < 0 ? 0.03 : 0
  return Math.min(
    cfg.maxInterest ?? 0.28,
    Math.max(cfg.minInterest ?? 0.04, base + termBump + levBump + brandBump + shareBump + painBump + distressBump),
  )
}

/**
 * Trailing average daily cash burn from the finance history (default 14 days).
 * Only days where closing cash fell count toward the burn; flat/up days count
 * as zero-burn days in the average. Falls back to today's net outflow when
 * there is no history yet.
 */
export function trailingDailyCashBurn(state: SimState, windowDays = 14): number {
  const samples = state.financeHistory.slice(-windowDays)
  let decreases = 0
  let days = 0
  for (let i = 1; i < samples.length; i++) {
    decreases += Math.max(0, samples[i - 1]!.cash - samples[i]!.cash)
    days += 1
  }
  const last = samples[samples.length - 1]
  if (last && last.day !== state.day) {
    // Today so far: from the last settled close to current cash.
    decreases += Math.max(0, last.cash - state.player.cash)
    days += 1
  }
  if (days === 0) return Math.max(0, -(state.player.finance.dayNet ?? 0))
  return decreases / days
}

/**
 * Liquidity runway: days of positive cash left at the trailing burn rate.
 * Divisor floored at $1 so a non-burning lab reports an effectively
 * unbounded runway instead of dividing by zero.
 */
export function liquidityRunwayDays(state: SimState): number {
  const burn = Math.max(1, trailingDailyCashBurn(state))
  return Math.max(0, state.player.cash) / burn
}

/** Hard ceiling on the emergency facility principal. */
export const BAILOUT_MAX_PRINCIPAL = 120_000_000
/** Smallest facility worth paperwork. */
export const BAILOUT_MIN_PRINCIPAL = 15_000_000

/** The lab can plausibly recover: assets cover debt, or revenue still flows. */
function isRecoverableBusiness(state: SimState): boolean {
  const snap = bankCreditSnapshot(state)
  return (
    snap.valuation > snap.outstanding ||
    (state.player.finance.dayRevenue ?? 0) > 0
  )
}

/**
 * Emergency facility only after cash has actually gone negative.
 * Negative P&L, short runway, or thin-but-positive cash never qualifies —
 * those are still solvent. An open bailout or an unrecoverable balance
 * sheet also blocks a new facility.
 */
export function isBailoutEligible(state: SimState): boolean {
  if (state.player.cash >= 0) return false
  const hasBailout = (state.player.loans ?? []).some((l) => l.offerId === 'bailout')
  if (hasBailout) return false
  return isRecoverableBusiness(state)
}

/**
 * Size a one-shot emergency facility (expensive, short). Principal restores
 * ~30–45 days of runway: target runway cost + overdue obligations − current
 * cash, floored at a minimum facility and capped at a hard maximum. The
 * facility ADDS financing cash on take — it never resets the balance.
 */
export function bailoutOffer(state: SimState): LoanOffer | null {
  if (!isBailoutEligible(state)) return null
  const cash = state.player.cash
  const burn = Math.max(1, trailingDailyCashBurn(state))
  const targetDays = 45
  const targetRunwayCost = burn * targetDays
  const overdueObligations =
    7 *
    (dailyLoanPayment(state.player.loans ?? []) +
      (state.player.capital?.debt ?? []).reduce(
        (sum, debt) => sum + debt.dailyPayment,
        0,
      ))
  const required = targetRunwayCost + overdueObligations - cash
  const principal = Math.floor(
    Math.min(BAILOUT_MAX_PRINCIPAL, Math.max(BAILOUT_MIN_PRINCIPAL, required)),
  )
  // Steep interest — last resort, not free money
  const interestTotal = Math.min(
    0.45,
    Math.max(0.25, (LOAN_CFG().maxInterest ?? 0.28) + 0.1),
  )
  return {
    id: 'bailout',
    label: 'Emergency bailout',
    blurb: `Distress facility · high interest · ${formatM(principal)} to restore ~${targetDays}d runway.`,
    principal,
    termDays: 30,
    interestTotal,
  }
}

/** Bank facilities sized to your credit line (not fixed $25M packs). */
export function loanOffers(state?: SimState): LoanOffer[] {
  const terms = LOAN_CFG().terms ?? [
    { id: 'bridge', label: 'Bridge note', blurb: 'Short runway.', termDays: 30, fracOfLimit: 0.2 },
    { id: 'growth', label: 'Growth facility', blurb: 'Mid-term capital.', termDays: 60, fracOfLimit: 0.45 },
    { id: 'expansion', label: 'Expansion credit', blurb: 'Heavy lift.', termDays: 90, fracOfLimit: 0.85 },
  ]

  if (!state) {
    // Static fallback for menus without a run
    return terms.map((t) => ({
      id: t.id,
      label: t.label,
      blurb: t.blurb,
      principal: Math.round((LOAN_CFG().minCreditFloor ?? 40e6) * t.fracOfLimit),
      termDays: t.termDays,
      interestTotal: LOAN_CFG().baseInterest ?? 0.08,
    }))
  }

  const snap = bankCreditSnapshot(state)
  const minDraw = LOAN_CFG().minDraw ?? 5_000_000

  const offers = terms
    .map((t) => {
      const principal = Math.floor(
        Math.min(snap.available, Math.max(0, snap.creditLimit * t.fracOfLimit)),
      )
      const interestTotal = interestForDraw(state, Math.max(principal, minDraw), t.termDays)
      return {
        id: t.id,
        label: t.label,
        blurb: `${t.blurb} Secured on lab valuation (${formatM(snap.valuation)}).`,
        principal,
        termDays: t.termDays,
        interestTotal,
      } satisfies LoanOffer
    })
    .filter((o) => o.principal >= minDraw)

  const bail = bailoutOffer(state)
  if (bail) offers.unshift(bail)
  return offers
}

/**
 * Draw bank credit.
 * - `takeLoan(state, 'bridge' | 'growth' | 'expansion')` — sized facility
 * - `takeLoan(state, { principal, termDays })` — custom amount up to available
 */
export function takeLoan(
  state: SimState,
  offerIdOrOpts: string | { principal: number; termDays: number; label?: string },
): SimState {
  const loans = state.player.loans ?? []
  const maxActive = LOAN_CFG().maxActive ?? 4
  const requestingBailout =
    typeof offerIdOrOpts === 'string' && offerIdOrOpts === 'bailout'
  if (loans.length >= maxActive && !requestingBailout) {
    return withAlert(
      state,
      'warn',
      `At loan limit (${maxActive}). Repay one before drawing again.`,
    )
  }
  // Bailout can stack as one extra facility when maxed
  if (requestingBailout && loans.length >= maxActive + 1) {
    return withAlert(state, 'warn', 'Already at emergency facility limit.')
  }

  const snap = bankCreditSnapshot(state)
  let principal: number
  let termDays: number
  let label: string
  let offerId: string
  let interestTotal: number

  if (typeof offerIdOrOpts === 'string') {
    const offer = loanOffers(state).find((o) => o.id === offerIdOrOpts)
    if (!offer) {
      if (snap.available < (LOAN_CFG().minDraw ?? 5e6)) {
        return withAlert(
          state,
          'warn',
          `Credit line full or too small — valuation ${formatM(snap.valuation)}, available ${formatM(snap.available)}. Grow the lab or repay debt.`,
        )
      }
      return withAlert(state, 'warn', 'Unknown loan product.')
    }
    if (loans.some((l) => l.offerId === offer.id)) {
      return withAlert(state, 'warn', `${offer.label} already open — repay it first.`)
    }
    // Bailout can open even when normal line is full (one emergency slot)
    if (offer.id === 'bailout') {
      if (!isBailoutEligible(state)) {
        return withAlert(state, 'warn', 'Not eligible for emergency bailout right now.')
      }
      principal = offer.principal
      termDays = offer.termDays
      label = offer.label
      offerId = offer.id
      interestTotal = offer.interestTotal
      // Skip available/creditLimit checks below via special path
      const totalDue = principal * (1 + interestTotal)
      const loan: ActiveLoan = {
        id: `loan-bailout-${state.day}-${loans.length}`,
        offerId,
        label,
        principal,
        remaining: totalDue,
        dailyPayment: totalDue / termDays,
        daysLeft: termDays,
        termDays,
        takenDay: state.day,
        interestTotal,
      }
      return {
        ...state,
        player: {
          ...state.player,
          cash: state.player.cash + principal,
          loans: [...loans, loan],
          finance: {
            ...state.player.finance,
            cash: state.player.cash + principal,
            debtOutstanding: snap.outstanding + totalDue,
            valuation: snap.valuation,
          },
        },
        alerts: [
          {
            id: `loan-bailout-${state.day}`,
            day: state.day,
            severity: 'warn' as const,
            message: `Emergency bailout: +${formatM(principal)} · ${(interestTotal * 100).toFixed(0)}% interest · ${formatM(loan.dailyPayment)}/d × ${termDays}d. Expensive — stabilize or restructure.`,
          },
          ...state.alerts,
        ].slice(0, 40),
        news: [
          `Day ${state.day}: ${state.player.name} takes an emergency bailout facility.`,
          ...state.news,
        ].slice(0, 48),
      }
    }
    principal = offer.principal
    termDays = offer.termDays
    label = offer.label
    offerId = offer.id
    interestTotal = offer.interestTotal
  } else {
    const minDraw = LOAN_CFG().minDraw ?? 5_000_000
    principal = Math.floor(Math.max(0, offerIdOrOpts.principal))
    termDays = Math.max(14, Math.min(180, Math.floor(offerIdOrOpts.termDays)))
    if (principal < minDraw) {
      return withAlert(state, 'warn', `Minimum draw is ${formatM(minDraw)}.`)
    }
    if (principal > snap.available + 1) {
      return withAlert(
        state,
        'warn',
        `Banks will only lend ${formatM(snap.available)} more (valuation ${formatM(snap.valuation)}, LTV cap ${(snap.maxLtv * 100).toFixed(0)}%).`,
      )
    }
    interestTotal = interestForDraw(state, principal, termDays)
    label = offerIdOrOpts.label ?? `Bank draw ${formatM(principal)}`
    offerId = `custom-${termDays}d`
  }

  if (principal < (LOAN_CFG().minDraw ?? 5e6)) {
    return withAlert(
      state,
      'warn',
      `Available credit ${formatM(snap.available)} is below minimum draw. Raise valuation or repay debt.`,
    )
  }

  const totalDue = principal * (1 + interestTotal)
  const outstanding = snap.outstanding
  if (outstanding + totalDue > snap.creditLimit * 1.02) {
    return withAlert(
      state,
      'warn',
      `Exceeds credit limit ${formatM(snap.creditLimit)} (valuation-based). Outstanding ${formatM(outstanding)}.`,
    )
  }

  const loan: ActiveLoan = {
    id: `loan-${offerId}-${state.day}-${loans.length}`,
    offerId,
    label,
    principal,
    remaining: totalDue,
    dailyPayment: totalDue / termDays,
    daysLeft: termDays,
    termDays,
    takenDay: state.day,
    interestTotal,
  }

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash + principal,
      loans: [...loans, loan],
      finance: {
        ...state.player.finance,
        cash: state.player.cash + principal,
        debtOutstanding: outstanding + totalDue,
        valuation: snap.valuation,
      },
    },
    alerts: [
      {
        id: `loan-take-${state.day}-${offerId}`,
        day: state.day,
        severity: 'info' as const,
        message: `Bank ${label}: +${formatM(principal)} · ${formatM(loan.dailyPayment)}/d × ${termDays}d · ${(interestTotal * 100).toFixed(1)}% interest · line ${formatM(snap.creditLimit)} on ${formatM(snap.valuation)} valuation.`,
      },
      ...state.alerts,
    ].slice(0, 40),
    news: [
      `Day ${state.day}: ${state.player.name} borrows ${formatM(principal)} against lab valuation.`,
      ...state.news,
    ].slice(0, 48),
  }
}

/** Full or partial early repayment of one loan. */
export function repayLoan(state: SimState, loanId: string, amount?: number): SimState {
  const loans = state.player.loans ?? []
  const loan = loans.find((l) => l.id === loanId)
  if (!loan) {
    return withAlert(state, 'warn', 'Loan not found.')
  }
  const pay = Math.min(loan.remaining, amount ?? loan.remaining)
  if (pay <= 0) return state
  if (state.player.cash < pay) {
    return withAlert(
      state,
      'warn',
      `Need ${formatM(pay)} cash to repay (have ${formatM(state.player.cash)}).`,
    )
  }

  const remaining = loan.remaining - pay
  const nextLoans =
    remaining < 1
      ? loans.filter((l) => l.id !== loanId)
      : loans.map((l) =>
          l.id === loanId
            ? {
                ...l,
                remaining,
                dailyPayment: l.daysLeft > 0 ? remaining / l.daysLeft : remaining,
              }
            : l,
        )

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - pay,
      loans: nextLoans,
      finance: {
        ...state.player.finance,
        cash: state.player.cash - pay,
        debtOutstanding: totalDebt(nextLoans) + typedDebtTotal(state),
      },
    },
    alerts: [
      {
        id: `loan-repay-${state.day}-${loanId}`,
        day: state.day,
        severity: 'info' as const,
        message:
          remaining < 1
            ? `Paid off ${loan.label} (${formatM(pay)}).`
            : `Paid ${formatM(pay)} on ${loan.label} — ${formatM(remaining)} left.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/**
 * Daily amortization. Called from the day tick after market so ops P&L is clean,
 * then loan cash leaves the books and finance.dayLoanPayment is set.
 */
export function tickLoans(state: SimState): SimState {
  const loansIn = state.player.loans ?? []
  const typedOutstanding = typedDebtTotal(state)
  if (loansIn.length === 0) {
    if (
      (state.player.finance.dayLoanPayment ?? 0) === 0 &&
      (state.player.finance.debtOutstanding ?? 0) === typedOutstanding
    ) {
      return state
    }
    return {
      ...state,
      player: {
        ...state.player,
        loans: [],
        finance: {
          ...state.player.finance,
          dayLoanPayment: 0,
          debtOutstanding: typedOutstanding,
        },
      },
    }
  }

  let payment = 0
  const news: string[] = []
  const alerts = [...state.alerts]
  const nextLoans: ActiveLoan[] = []

  for (const loan of loansIn) {
    const due = Math.min(loan.remaining, loan.dailyPayment)
    payment += due
    const remaining = loan.remaining - due
    const daysLeft = Math.max(0, loan.daysLeft - 1)
    if (remaining < 1 || daysLeft <= 0) {
      if (remaining >= 1) payment += remaining
      news.push(`Day ${state.day}: ${loan.label} fully repaid.`)
      continue
    }
    nextLoans.push({
      ...loan,
      remaining: remaining < 1 ? 0 : remaining,
      daysLeft,
      dailyPayment: daysLeft > 0 ? remaining / daysLeft : remaining,
    })
  }

  const cash = state.player.cash - payment
  let brandTrust = state.player.brandTrust
  if (cash < -5_000_000 && payment > 0) {
    brandTrust = Math.max(5, brandTrust - 0.15)
    if (state.day % 7 === 0) {
      alerts.unshift({
        id: `loan-stress-${state.day}`,
        day: state.day,
        severity: 'warn',
        message: `Debt service stress — cash ${formatM(cash)} after loan payments.`,
      })
    }
  }

  const debtOutstanding = totalDebt(nextLoans) + typedOutstanding
  const f = state.player.finance
  const dayNet = (f.dayNet ?? 0) - payment

  return {
    ...state,
    news: [...news, ...state.news].slice(0, 48),
    alerts: alerts.slice(0, 40),
    player: {
      ...state.player,
      cash,
      brandTrust,
      loans: nextLoans,
      finance: {
        ...f,
        cash,
        dayLoanPayment: payment,
        dayTotalOut: (f.dayTotalOut ?? 0) + payment,
        dayNet,
        debtOutstanding,
        lifetimeNet: (f.lifetimeNet ?? 0) - payment,
        lowestCash: Math.min(f.lowestCash ?? cash, cash),
        runwayDays:
          dayNet >= 0 ? Number.POSITIVE_INFINITY : cash / Math.max(1, -dayNet),
      },
    },
  }
}

function withAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('loan-alert', state.seed, state.day, severity, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}
