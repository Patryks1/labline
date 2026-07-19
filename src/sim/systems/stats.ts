/**
 * Pure lab statistics aggregation for the Stats panel & tests.
 * Reads SimState / compute snapshot — never mutates.
 */
import { getChipDef } from '../balance/chips'
import { ECONOMY } from '../balance/economy'
import type {
  FinanceDaySnapshot,
  LabFinance,
  ModelFinanceRow,
  PlanDayStats,
  SimState,
} from '../types'
import { computeSnapshot, inferenceTokensPerDay, type ComputeSnapshot } from './compute'
import { buildingDisplayName, energyPriceForState } from './map'
import { facilityAnchorTiles } from './worldAccess'

export type StatsSectionId = 'pnl' | 'models' | 'compute' | 'facilities' | 'trends'

export interface MoneyLine {
  id: string
  label: string
  amount: number
  kind: 'in' | 'out' | 'neutral' | 'total'
  hint?: string
}

export interface FacilityRow {
  key: string
  name: string
  kind: string
  level: number
  region: string
  opexPerDay: number
  capex: number
  racksUsed: number
  rackCapacity: number
  mwCapacity: number
  mwGeneration: number
  complete: boolean
}

export interface ChipFleetRow {
  defId: string
  name: string
  count: number
  arriving: number
  flopsPf: number
  mw: number
  bookValue: number
  amortPerDay: number
}

export interface TrendSeries {
  days: number[]
  revenue: number[]
  net: number[]
  cash: number[]
  share: number[]
  servedMTok: number[]
  effectivePf: number[]
  valuation: number[]
}

export interface LabStats {
  day: number
  finance: LabFinance
  /** Organized P&L lines for today */
  income: MoneyLine[]
  productCosts: MoneyLine[]
  operatingCosts: MoneyLine[]
  totals: MoneyLine[]
  unitEconomics: {
    marginPerMTok: number
    marginPerSubMonth: number
    revenuePerMTok: number
    costPerMTok: number
    grossMarginPct: number
    netMarginPct: number
    apiUsers: number
    planSubscribers: number
  }
  plans: PlanDayStats[]
  models: ModelFinanceRow[]
  compute: ComputeSnapshot & {
    capacityMTok: number
    demandMTok: number
    servedMTok: number
    unservedRatio: number
    energyPrice: number
    energyCostDay: number
    costPerMTokServed: number
    pfUtilization: number
    trainShare: number
    inferShare: number
    researchShare: number
    trainCostDay: number
    inferCostDay: number
    researchCostDay: number
  }
  facilities: FacilityRow[]
  facilityTotals: {
    opex: number
    capex: number
    rackCap: number
    racksUsed: number
    mwGrid: number
    mwGen: number
  }
  chips: ChipFleetRow[]
  chipTotals: {
    count: number
    bookValue: number
    amortPerDay: number
    flopsPf: number
    mw: number
  }
  trends: TrendSeries
  history: FinanceDaySnapshot[]
  kpis: {
    cash: number
    dayNet: number
    dayRevenue: number
    share: number
    valuation: number
    runwayDays: number
    lifetimeRevenue: number
    lifetimeNet: number
    burnOrProfitLabel: string
  }
}

function sum(lines: MoneyLine[]): number {
  return lines.reduce((s, l) => s + l.amount, 0)
}

export function buildLabStats(state: SimState): LabStats {
  const f = state.player.finance
  const snap = computeSnapshot(state)
  const lm = state.lastMarket
  const capacityMTok = lm.capacityMTok || inferenceTokensPerDay(state, snap)
  const energyPrice = energyPriceForState(state)
  const energyCostDay = f.dayEnergyCost || snap.mwDemand * 24 * energyPrice

  const alloc = state.player.allocation
  const allocSum = alloc.training + alloc.inference + alloc.research || 1
  const trainShare = alloc.training / allocSum
  const inferShare = alloc.inference / allocSum
  const researchShare = alloc.research / allocSum

  // Attribute full energy + chip amort across pools for cost center view
  const energy = f.dayEnergyCost
  const amort = f.dayChipAmort
  const trainCostDay = energy * trainShare + amort * trainShare
  const inferCostDay = energy * inferShare + amort * inferShare
  const researchCostDay = energy * researchShare + amort * researchShare

  const income: MoneyLine[] = [
    {
      id: 'api',
      label: 'API revenue',
      amount: f.apiRevenue,
      kind: 'in',
      hint: `${lm.apiDayMTok.toFixed(2)} MTok @ product pricing`,
    },
    {
      id: 'sub',
      label: 'Subscription revenue',
      amount: f.subRevenue,
      kind: 'in',
      hint: 'All enabled plans combined',
    },
    {
      id: 'ent',
      label: 'Enterprise / contracts',
      amount: f.enterpriseRevenue,
      kind: 'in',
      hint: `${state.player.enterpriseContracts} contracts`,
    },
  ]

  const productCosts: MoneyLine[] = [
    {
      id: 'api-cogs',
      label: 'API COGS',
      amount: -f.apiCogs,
      kind: 'out',
      hint: 'Inference energy + amort + bandwidth share',
    },
    {
      id: 'sub-cogs',
      label: 'Subscription COGS',
      amount: -f.subCogs,
      kind: 'out',
      hint: 'Token burn on plans',
    },
  ]

  const operatingCosts: MoneyLine[] = [
    {
      id: 'energy',
      label: 'Energy (campus)',
      amount: -f.dayEnergyCost,
      kind: 'out',
      hint: `${snap.mwDemand.toFixed(2)} MW × 24h × $${energyPrice.toFixed(0)}/MWh`,
    },
    {
      id: 'energy-note',
      label: '  of which non-inference',
      amount: -(f.dayEnergyOther ?? 0),
      kind: 'out',
      hint: 'Train/research residual (not in product COGS)',
    },
    {
      id: 'wages',
      label: 'Wages',
      amount: -f.dayWageCost,
      kind: 'out',
      hint: `Talent ${state.player.talent.toFixed(0)}`,
    },
    {
      id: 'mkt',
      label: 'Marketing',
      amount: -(f.dayMarketing ?? state.player.marketingSpendPerDay),
      kind: 'out',
    },
    {
      id: 'loans',
      label: 'Loan payments',
      amount: -(f.dayLoanPayment ?? 0),
      kind: 'out',
      hint:
        (f.debtOutstanding ?? 0) > 0
          ? `Outstanding debt ${Math.round((f.debtOutstanding ?? 0) / 1e6)}M`
          : 'No active loans',
    },
    {
      id: 'facility',
      label: 'Facility opex',
      amount: -f.dayBuildingOpex,
      kind: 'out',
      hint: 'Completed player buildings',
    },
    {
      id: 'amort',
      label: 'Chip amort (non-cash)',
      amount: -f.dayChipAmort,
      kind: 'out',
      hint: 'Book only — not deducted from cash (capex paid at purchase)',
    },
    {
      id: 'amort-other',
      label: '  of which non-inference',
      amount: -(f.dayChipAmortOther ?? 0),
      kind: 'out',
    },
  ]

  const dayNet =
    typeof f.dayNet === 'number'
      ? f.dayNet
      : f.dayRevenue + sum(productCosts) + sum(operatingCosts.filter((l) => !l.id.includes('of which')))

  // Avoid double-counting energy/amort already inside product COGS in the display total.
  // Net cash change is authoritative from finance.dayNet.
  const totals: MoneyLine[] = [
    {
      id: 'rev',
      label: 'Total revenue',
      amount: f.dayRevenue,
      kind: 'total',
    },
    {
      id: 'gross',
      label: 'Gross profit (rev − product COGS)',
      amount: f.dayGrossProfit ?? f.dayRevenue - f.dayCogs,
      kind: 'total',
    },
    {
      id: 'out',
      label: 'Total cash out (ops)',
      amount: -(f.dayTotalOut ?? f.dayEnergyCost + f.dayWageCost + (f.dayMarketing ?? 0) + f.dayBuildingOpex),
      kind: 'total',
      hint: 'Cash ops only (excludes non-cash amort)',
    },
    {
      id: 'net',
      label: 'Day net cash',
      amount: dayNet,
      kind: 'total',
      hint: 'Cash change from operations today (amort is book-only)',
    },
  ]

  const planSubscribers = lm.planStats.reduce((s, p) => s + p.subscribers, 0)
  const served = lm.servedMTok
  const costPerMTokServed = served > 0.0001 ? f.apiCogs + f.subCogs > 0 ? (f.apiCogs + f.subCogs) / Math.max(served, 0.0001) : lm.marginalPerMTok : lm.marginalPerMTok
  const revenuePerMTok = served > 0.0001 ? (f.apiRevenue + f.subRevenue) / served : 0
  const gross = f.dayGrossProfit ?? f.dayRevenue - f.dayCogs
  const grossMarginPct = f.dayRevenue > 0 ? gross / f.dayRevenue : 0
  const netMarginPct = f.dayRevenue > 0 ? dayNet / f.dayRevenue : 0

  const facilities: FacilityRow[] = facilityAnchorTiles(state, { ownerId: 'player' })
    .filter((t) => t.kind !== 'empty' && t.campusRole !== 'pad')
    .map((t) => {
      const region = state.map.regions.find((r) => r.id === t.regionId)
      return {
        key: `${t.x},${t.y}`,
        name: buildingDisplayName(t, t.kind),
        kind: t.kind,
        level: t.level,
        region: region?.name ?? t.regionId,
        opexPerDay:
          t.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1),
        capex: t.capex,
        racksUsed: t.racksUsed,
        rackCapacity: t.rackCapacity,
        mwCapacity: t.mwCapacity,
        mwGeneration: t.mwGeneration,
        complete: t.buildingProgress >= t.buildingTarget,
      }
    })
    .sort((a, b) => b.opexPerDay - a.opexPerDay)

  const facilityTotals = {
    opex: facilities.reduce((s, x) => s + (x.complete ? x.opexPerDay : 0), 0),
    capex: facilities.reduce((s, x) => s + x.capex, 0),
    rackCap: facilities.reduce((s, x) => s + x.rackCapacity, 0),
    racksUsed: facilities.reduce((s, x) => s + x.racksUsed, 0),
    mwGrid: facilities.reduce((s, x) => s + x.mwCapacity, 0),
    mwGen: facilities.reduce((s, x) => s + x.mwGeneration, 0),
  }

  const chips: ChipFleetRow[] = state.player.chips.map((inv) => {
    const def = getChipDef(inv.defId)
    const arriving = inv.arriving.reduce((s, a) => s + a.count, 0)
    const price = def?.price ?? 0
    return {
      defId: inv.defId,
      name: def?.name ?? inv.defId,
      count: inv.count,
      arriving,
      flopsPf: (def?.flopsPf ?? 0) * inv.count,
      mw: (def?.mwPerChip ?? 0) * inv.count,
      bookValue: price * inv.count,
      amortPerDay: (price * inv.count) / ECONOMY.chipAmortDays,
    }
  })

  const chipTotals = {
    count: chips.reduce((s, c) => s + c.count, 0),
    bookValue: chips.reduce((s, c) => s + c.bookValue, 0),
    amortPerDay: chips.reduce((s, c) => s + c.amortPerDay, 0),
    flopsPf: chips.reduce((s, c) => s + c.flopsPf, 0),
    mw: chips.reduce((s, c) => s + c.mw, 0),
  }

  const history = state.financeHistory
  const trends: TrendSeries = {
    days: history.map((h) => h.day),
    revenue: history.map((h) => h.revenue),
    net: history.map((h) => h.net),
    cash: history.map((h) => h.cash),
    share: history.map((h) => h.share),
    servedMTok: history.map((h) => h.servedMTok),
    effectivePf: history.map((h) => h.effectivePf),
    valuation: history.map((h) => h.valuation),
  }

  const burnOrProfitLabel =
    dayNet >= 0
      ? `Profitable · ${formatRunway(f.runwayDays)}`
      : `Burning · ${formatRunway(f.runwayDays)} runway`

  return {
    day: state.day,
    finance: f,
    income,
    productCosts,
    operatingCosts,
    totals,
    unitEconomics: {
      marginPerMTok: f.marginPerMTok,
      marginPerSubMonth: f.marginPerSub,
      revenuePerMTok,
      costPerMTok: costPerMTokServed,
      grossMarginPct,
      netMarginPct,
      apiUsers: lm.apiSubscribers,
      planSubscribers,
    },
    plans: lm.planStats,
    models: lm.modelFinance ?? [],
    compute: {
      ...snap,
      capacityMTok,
      demandMTok: lm.playerDemandMTok,
      servedMTok: lm.servedMTok,
      unservedRatio: lm.unservedRatio,
      energyPrice,
      energyCostDay,
      costPerMTokServed,
      pfUtilization: snap.rawFlopsPf > 0 ? snap.effectiveFlopsPf / snap.rawFlopsPf : 0,
      trainShare,
      inferShare,
      researchShare,
      trainCostDay,
      inferCostDay,
      researchCostDay,
    },
    facilities,
    facilityTotals,
    chips,
    chipTotals,
    trends,
    history,
    kpis: {
      cash: state.player.cash,
      dayNet,
      dayRevenue: f.dayRevenue,
      share: f.totalShare,
      valuation: f.valuation,
      runwayDays: f.runwayDays ?? Infinity,
      lifetimeRevenue: f.lifetimeRevenue ?? 0,
      lifetimeNet: f.lifetimeNet ?? 0,
      burnOrProfitLabel,
    },
  }
}

function formatRunway(days: number): string {
  if (!Number.isFinite(days) || days > 9_000) return '∞'
  if (days >= 365) return `${(days / 365).toFixed(1)}y`
  return `${Math.floor(days)}d`
}

/** Sparkline path for SVG (0..w, 0..h), y up. */
export function sparkPath(values: number[], w = 120, h = 28, pad = 2): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const n = values.length
  return values
    .map((v, i) => {
      const x = pad + (i / Math.max(1, n - 1)) * (w - pad * 2)
      const y = h - pad - ((v - min) / span) * (h - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}
