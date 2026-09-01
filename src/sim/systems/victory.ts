import { ECONOMY } from '../balance/economy'
import { STAFF_HIRE_COST, STAFF_ROLES, STAFF_WAGE_PER_DAY } from '../balance/staff'
import type { CashDistressStage, Model, SimState, TileKind } from '../types'
import { isLivePublicModel } from '../modelRelease'
import { isBuildableKind, isDcKind, isHqAnchor } from './map'
import { playerStaff } from './staff'
import { facilityAnchorTiles, usesCompactWorld } from './worldAccess'
import { dataCenterFacilityIds, facilityNav } from './facilityMarket'

/** Cash-distress thresholds: warning stages between $0 and the bankruptcy floor. */
export const CASH_DISTRESS_SEVERE = -100_000_000
export const CASH_DISTRESS_FINAL = -250_000_000

/**
 * Cash-distress ladder. Cash keeps falling unclamped between stages — credit
 * gets expensive and emergency funding may appear. Hitting the insolvency
 * floor opens an asset-sale window; the run ends only after that window
 * expires without a recovery.
 */
export function cashDistressStage(cash: number): CashDistressStage {
  if (cash <= ECONOMY.victory.bankruptCash) return 'bankrupt'
  if (cash < CASH_DISTRESS_FINAL) return 'final'
  if (cash < CASH_DISTRESS_SEVERE) return 'severe'
  if (cash < 0) return 'distressed'
  return 'stable'
}

/** Board-forced recovery window after cash hits the insolvency floor. */
export function insolvencyGraceDays(): number {
  return ECONOMY.victory.bankruptcyGraceDays ?? 30
}

export function playerRestructuring(state: SimState) {
  return (
    state.player.capital?.restructuring ?? {
      active: false,
      daysLeft: 0,
      stage: 'none' as const,
    }
  )
}

export function isInsolvencyLoss(reason: string): boolean {
  return /bankrupt/i.test(reason)
}

/** Reopen play after a bankruptcy overlay so credit, equity, and model sales stay usable. */
export function resumeInsolvency(state: SimState): SimState {
  const graceDays = insolvencyGraceDays()
  const recovered = state.player.cash >= 0
  const capital = state.player.capital
  const runPhase =
    state.progression.runPhase === 'failed'
      ? state.config?.campaignRules
        ? 'campaign'
        : 'endless'
      : state.progression.runPhase
  return {
    ...state,
    paused: true,
    progression: { ...state.progression, runPhase },
    victory: {
      ...state.victory,
      outcome: 'playing',
      reason: '',
      bankruptDay: recovered ? 0 : state.victory.bankruptDay,
    },
    player: {
      ...state.player,
      capital: capital
        ? {
            ...capital,
            restructuring: recovered
              ? { active: false, daysLeft: 0, stage: 'none' }
              : { active: true, daysLeft: graceDays, stage: 'asset_sale' },
          }
        : capital,
    },
    alerts: [
      {
        id: `insolvency-resume-${state.day}`,
        day: state.day,
        severity: recovered ? ('info' as const) : ('danger' as const),
        message: recovered
          ? 'Cash is non-negative again. The board lifted bankruptcy review.'
          : `The board reopened a ${graceDays}-day recovery window. Take credit, sell equity, or sell models.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function formatCashM(n: number) {
  return `-$${(Math.abs(n) / 1e6).toFixed(0)}M`
}

/**
 * How close the lab's best public model is to industry frontier (0–1).
 * 1 = co-SOTA or leading; 0 = far behind.
 */
export function playerSotaProximity(state: SimState): {
  bestCap: number
  frontier: number
  sota: number
} {
  const released = (ms: Model[]) =>
    ms.filter(isLivePublicModel)
  const bestCap = released(state.player.models).reduce(
    (m, x) => Math.max(m, x.capability),
    0,
  )
  let frontier = bestCap
  for (const r of state.rivals) {
    for (const m of released(r.models)) {
      frontier = Math.max(frontier, m.capability)
    }
  }
  frontier = Math.max(20, frontier)
  // Within ~30 capability points of frontier = near SOTA
  const sota = Math.max(0, Math.min(1, 1 - Math.max(0, frontier - bestCap) / 30))
  return { bestCap, frontier, sota }
}

/**
 * IP / narrative value of shipped models — SOTA models dominate valuation
 * so banks lend more against a frontier lab even before profits scale.
 */
export function modelIpValue(state: SimState): number {
  const models = state.player.models.filter(isLivePublicModel)
  if (models.length === 0) return 0
  const { bestCap, sota } = playerSotaProximity(state)

  // Absolute capability curve — frontier 70+ is multi-hundred-M to multi-B IP
  const flagship =
    Math.pow(Math.max(0, bestCap), 1.72) * 220_000 * (0.4 + sota * 2.4)

  // Portfolio: other released models add smaller IP (diminishing)
  const portfolio = models
    .slice()
    .sort((a, b) => b.capability - a.capability)
    .reduce((sum, m, i) => {
      const w = i === 0 ? 0 : Math.pow(0.55, i)
      return sum + Math.pow(Math.max(0, m.capability), 1.35) * 55_000 * w
    }, 0)

  // SOTA premium: co-leading models get a narrative multiple
  const sotaPremium = sota * sota * (80_000_000 + bestCap * 2_200_000)

  return flagship + portfolio + sotaPremium
}

function ipSaleHaircut(cash: number): number {
  const stage = cashDistressStage(cash)
  if (stage === 'bankrupt') return 0.48
  if (stage === 'final') return 0.56
  if (stage === 'severe') return 0.64
  if (stage === 'distressed') return 0.72
  return 0.88
}

/**
 * Secondary-market bid for one model's IP. Distressed sales take a haircut
 * but still clear cash the same day.
 */
export function modelIpSaleQuote(state: SimState, model: Model): number {
  if (model.soldIp) return 0
  const cap = Math.max(0, model.capability)
  if (cap < 1 && (model.trainComputeSpent ?? 0) <= 0) return 0
  const { sota, bestCap } = playerSotaProximity(state)
  const publicOrShipped = isLivePublicModel(model) || model.shipped
  const flagship = cap + 0.01 >= bestCap && publicOrShipped
  const base = Math.pow(cap, 1.65) * (publicOrShipped ? 200_000 : 95_000)
  const sotaPremium = flagship ? sota * sota * (50_000_000 + cap * 1_400_000) : 0
  const raw = (base + sotaPremium) * ipSaleHaircut(state.player.cash)
  const floor = publicOrShipped ? 2_000_000 : 500_000
  return Math.max(floor, Math.round(raw / 100_000) * 100_000)
}

export function sellableModelQuotes(
  state: SimState,
): { model: Model; cash: number }[] {
  return state.player.models
    .map((model) => ({ model, cash: modelIpSaleQuote(state, model) }))
    .filter((row) => row.cash > 0)
    .sort((a, b) => b.cash - a.cash || a.model.id.localeCompare(b.model.id))
}

/** Real estate + plant: halls, HQs, labs, power, fabs (completed + WIP). */
export function buildingAssetValue(state: SimState, includeDataCenters = true): number {
  let value = 0
  if (usesCompactWorld(state)) {
    state.map.world!.forEachFacility({ ownerId: 'player' }, (facility) => {
      if (!isBuildableKind(facility.kind as TileKind)) return
      if (!includeDataCenters && isDcKind(facility.kind)) return

      const complete =
        facility.constructionTarget > 0
          ? Math.min(1, facility.constructionProgress / facility.constructionTarget)
          : 1
      const recovery = complete >= 1 ? 0.72 : 0.35 + complete * 0.25
      const stats = facility.stats
      value += Math.max(0, stats?.capex ?? 0) * recovery

      if (complete >= 1) {
        value += Math.max(0, facility.level - 1) * 2_500_000
        if ((stats?.mwGeneration ?? 0) > 0) value += (stats?.mwGeneration ?? 0) * 1_800_000
        if ((stats?.mwCapacity ?? 0) > 0 && (stats?.mwGeneration ?? 0) <= 0) {
          value += (stats?.mwCapacity ?? 0) * 400_000
        }
        if (isHqAnchor(facility)) {
          value += ((stats?.rackCapacity ?? 0) > 0 ? 0 : 1) * 3_000_000 * Math.max(1, facility.level)
        }
        if (facility.kind === 'lab') value += 4_500_000 * Math.max(1, facility.level)
        if (facility.kind === 'fab') value += 12_000_000 * Math.max(1, facility.level)
      }
    })
    return value
  }

  for (const t of facilityAnchorTiles(state, { ownerId: 'player' })) {
    if (!isBuildableKind(t.kind)) continue
    if (!includeDataCenters && isDcKind(t.kind)) continue
    // Multi-tile pads carry capex on anchor only
    if (t.campusRole === 'pad') continue

    const complete =
      t.buildingTarget > 0 ? Math.min(1, t.buildingProgress / t.buildingTarget) : 1
    // Live plant: strong book value; mid-build still counts for banks
    const recovery = complete >= 1 ? 0.72 : 0.35 + complete * 0.25
    value += Math.max(0, t.capex) * recovery

    // Level upgrades / HQ desks / gen capacity as soft multiples
    if (complete >= 1) {
      value += Math.max(0, t.level - 1) * 2_500_000
      if (t.mwGeneration > 0) value += t.mwGeneration * 1_800_000
      if (t.mwCapacity > 0 && t.mwGeneration <= 0) value += t.mwCapacity * 400_000
      if (isHqAnchor(t)) value += (t.rackCapacity > 0 ? 0 : 1) * 3_000_000 * Math.max(1, t.level)
      // Research labs command a premium (talent magnets)
      if (t.kind === 'lab') value += 4_500_000 * Math.max(1, t.level)
      if (t.kind === 'fab') value += 12_000_000 * Math.max(1, t.level)
    }

    // Parcel land under owned campuses
    value += Math.max(0, t.landValue ?? 0) * 0.55
  }
  return value
}

/**
 * Human capital — researchers especially valuable (hire cost × multiple + wage NPV).
 * Banks treat retained talent as collateral for tech labs.
 */
export function staffAssetValue(state: SimState): number {
  const staff = playerStaff(state)
  let value = 0
  for (const role of STAFF_ROLES) {
    const n = staff[role] ?? 0
    if (n <= 0) continue
    const hire = STAFF_HIRE_COST[role] ?? 1_000_000
    const wage = STAFF_WAGE_PER_DAY[role] ?? 8_000
    // Replacement cost + ~2y wage capitalisation (talent franchise)
    const perHead = hire * 1.15 + wage * 365 * 1.1
    // Researchers are the scarce asset banks care about most
    const roleMult =
      role === 'researcher' ? 1.85 : role === 'engineer' ? 1.35 : role === 'data_processor' ? 1.1 : 0.95
    value += n * perHead * roleMult
  }
  // Bench depth bonus once you have a real research org
  const researchers = staff.researcher ?? 0
  if (researchers >= 8) value += (researchers - 7) * 1_200_000
  if (researchers >= 20) value += 15_000_000
  return value
}

/** Live silicon + ordered (at cost) fleet. */
export function fleetAssetValue(state: SimState, includeInstalledDataCenterRacks = true): number {
  let value = 0
  for (const r of state.player.rackFleet ?? []) {
    if (r.status === 'live' && includeInstalledDataCenterRacks) value += r.paidEach * r.count * 0.58
    else if (r.status === 'ordered') value += r.paidEach * r.count * 0.85 // prepaid inventory
  }
  for (const inv of state.player.chips ?? []) {
    value += inv.count * 28_000
  }
  return value
}

/** Research unlocks as intangible know-how (not full retrain cost). */
export function researchAssetValue(state: SimState): number {
  const n = state.player.researchUnlocked?.length ?? 0
  // Diminishing: early nodes matter, tree depth still adds
  return Math.min(180_000_000, n * 2_800_000 + Math.pow(Math.max(0, n - 5), 1.2) * 1_100_000)
}

export interface ValuationDrivers {
  annualizedNet: number
  earningsMultiple: number
  earningsValue: number
  plantAndFleet: number
  talentAndResearch: number
  cashCredit: number
  debt: number
  modelIp: number
  sota: number
  bestCap: number
  frontier: number
  markedValue: number
}

/** Auditable company-value bridge used by funding UI and lenders. */
export function valuationDrivers(state: SimState): ValuationDrivers {
  const f = state.player.finance
  const daily = typeof f.dayNet === 'number' ? f.dayNet : f.dayRevenue - f.dayCogs
  const annualizedNet = daily * 365
  const share = f.totalShare
  const brand = state.player.brandTrust / 50
  // Data centres use the same neutral NAV shown in acquisitions. Their live
  // racks are already inside that NAV, so exclude the older fleet mark here.
  const infrastructureNav = dataCenterFacilityIds(state, state.playerLabId)
    .reduce((sum, facilityId) => sum + facilityNav(state, facilityId).total, 0)
  const plantAndFleet =
    buildingAssetValue(state, false) +
    fleetAssetValue(state, false) +
    infrastructureNav
  const talentAndResearch = staffAssetValue(state) + researchAssetValue(state)
  const debt =
    (state.player.loans ?? []).reduce((sum, loan) => sum + loan.remaining, 0) +
    (state.player.capital?.debt ?? []).reduce(
      (sum, instrument) => sum + instrument.remaining,
      0,
    )
  const cashCredit = Math.max(0, state.player.cash) * 0.35
  const { sota, bestCap, frontier } = playerSotaProximity(state)
  const earningsMultiple = Math.max(
    0.2,
    12 * (0.5 + share * 2) * brand * (1 + sota * 0.85 + bestCap / 200),
  )
  const earningsValue = annualizedNet * earningsMultiple
  const modelIp = modelIpValue(state)
  const markedValue = Math.max(
    0,
    earningsValue + plantAndFleet + talentAndResearch + cashCredit - debt * 0.85 + modelIp,
  )
  return {
    annualizedNet,
    earningsMultiple,
    earningsValue,
    plantAndFleet,
    talentAndResearch,
    cashCredit,
    debt,
    modelIp,
    sota,
    bestCap,
    frontier,
    markedValue,
  }
}

export function computeValuation(state: SimState): number {
  const f = state.player.finance
  const markedValue = valuationDrivers(state).markedValue
  // A single overloaded day can flip operating profit negative, but company
  // value and the credit line should reprice over time instead of evaporating
  // from one daily mark. Sustained losses still compound into a lower value.
  const priorValue = Math.max(0, f.valuation ?? 0)
  const recentPositiveMark = state.financeHistory
    .toReversed()
    .find(
      (entry) =>
        entry.day < state.day &&
        state.day - entry.day <= 7 &&
        entry.valuation > 0,
    )?.valuation ?? 0
  const downsideAnchor = Math.max(priorValue, recentPositiveMark)
  const downsideFloor = downsideAnchor > 0 ? downsideAnchor * 0.92 : 0
  return Math.max(markedValue, downsideFloor)
}

export function tickVictory(state: SimState): SimState {
  if (state.victory.outcome !== 'playing') return state

  const valuation = computeValuation(state)
  const share = state.player.finance.totalShare
  const v = ECONOMY.victory
  const overallServeRate = Math.max(
    0,
    Math.min(1, 1 - (state.lastMarket.unservedRatio ?? 1)),
  )
  const apiServeRate = Math.max(
    0,
    Math.min(1, state.lastMarket.apiServeFrac ?? overallServeRate),
  )
  const subServeRate = Math.max(
    0,
    Math.min(1, state.lastMarket.subServeFrac ?? overallServeRate),
  )
  const headroom =
    state.lastMarket.capacityPf > 1e-12
      ? Math.max(
          0,
          1 - state.lastMarket.demandPf / state.lastMarket.capacityPf,
        )
      : 0
  const dominanceQualified =
    share >= v.share &&
    overallServeRate >= v.minServeRate &&
    apiServeRate >= v.minPaidServeRate &&
    subServeRate >= v.minPaidServeRate &&
    headroom >= v.minHeadroom &&
    state.player.finance.dayGrossProfit > 0
  const priorDominanceDays = state.victory.dominanceQualifiedDays ?? 0
  const alreadyCountedToday =
    state.victory.lastDominanceQualifiedDay === state.day
  const dominanceQualifiedDays = dominanceQualified
    ? alreadyCountedToday
      ? priorDominanceDays
      : priorDominanceDays + 1
    : 0
  const victoryProgress = {
    ...state.victory,
    dominanceQualifiedDays,
    lastDominanceQualifiedDay: dominanceQualified ? state.day : 0,
  }

  let player = {
    ...state.player,
    finance: { ...state.player.finance, valuation },
  }

  // Keep latest history point valuation in sync (history written during market tick)
  const financeHistory = state.financeHistory.slice()
  if (financeHistory.length > 0) {
    const last = financeHistory[financeHistory.length - 1]!
    if (last.day === state.day) {
      financeHistory[financeHistory.length - 1] = { ...last, valuation, cash: player.cash }
    }
  }

  // Surface cash-distress stages in state once per day (UI reads the same
  // ladder via cashDistressStage).
  const distress = cashDistressStage(player.cash)
  const restructuring = playerRestructuring(state)
  const distressMessage =
    distress === 'severe'
      ? `Severe cash distress (${formatCashM(player.cash)}). Credit is expensive and terms are worsening — take credit, sell equity, or sell models.`
      : distress === 'final'
        ? `Final warning (${formatCashM(player.cash)}). At ${formatCashM(v.bankruptCash)} the board opens a ${insolvencyGraceDays()}-day recovery window — raise or sell before bankruptcy review.`
        : distress === 'bankrupt'
          ? `Insolvency (${formatCashM(player.cash)}). Take credit, sell equity, or sell models — the run ends only after the recovery window expires.`
          : null
  const alerts =
    distressMessage &&
    !state.alerts.some((a) => a.id === `cash-distress-${distress}-${state.day}`)
      ? [
          {
            id: `cash-distress-${distress}-${state.day}`,
            day: state.day,
            severity: 'danger' as const,
            message: distressMessage,
          },
          ...state.alerts,
        ].slice(0, 40)
      : state.alerts

  const founderOwnership = (state.player.capital?.capTable ?? [])
    .filter((stake) => stake.kind === 'founder')
    .reduce((sum, stake) => sum + stake.ownership, 0)
  if (state.player.capital && founderOwnership < 0.05) {
    return {
      ...state,
      player,
      financeHistory,
      alerts,
      paused: true,
      progression: { ...state.progression, runPhase: 'failed' },
      victory: {
        ...victoryProgress,
        outcome: 'lost',
        reason: `Founder ownership fell to ${(founderOwnership * 100).toFixed(1)}%. The company is no longer yours.`,
      },
    }
  }

  // Insolvency is not instant: tickCapital opens an asset-sale window so the
  // player can take credit, sell equity, or sell models. Loss only after that
  // window expires (restructuring stage `bankruptcy`).
  if (restructuring.stage === 'bankruptcy') {
    return {
      ...state,
      player,
      financeHistory,
      alerts,
      paused: true,
      ...(state.config?.campaignRules
        ? { progression: { ...state.progression, runPhase: 'failed' as const } }
        : {}),
      victory: {
        ...victoryProgress,
        outcome: 'lost',
        reason: 'Restructuring failed and the company entered bankruptcy.',
        bankruptDay: state.day,
      },
    }
  }

  // V4 decade campaigns use non-terminal milestone titles. Valuation remains
  // live here for funding and reports; skip classic win/soft-loss checks.
  if (state.config?.campaignRules) {
    return {
      ...state,
      player,
      financeHistory,
      alerts,
      victory: victoryProgress,
    }
  }

  // Dominance is fulfilled demand sustained under an enterprise-grade SLO;
  // valuation and a single frontier model remain milestones, not shortcuts.
  if (
    state.day >= v.minDay &&
    dominanceQualifiedDays >= v.sustainDays
  ) {
    return {
      ...state,
      player,
      financeHistory,
      alerts,
      paused: true,
      victory: {
        ...victoryProgress,
        outcome: 'won',
        reason: `Sustained market dominance — ${(share * 100).toFixed(0)}% fulfilled share for ${dominanceQualifiedDays} days with ${(headroom * 100).toFixed(0)}% capacity headroom.`,
      },
    }
  }

  // soft loss: all rivals crushing forever at day 200 with <5% share
  if (state.day >= 200 && share < 0.05 && player.cash < 1_000_000) {
    return {
      ...state,
      player,
      financeHistory,
      alerts,
      paused: true,
      victory: {
        ...victoryProgress,
        outcome: 'lost',
        reason: 'Irrelevant. Rivals own the stack and you are out of runway.',
      },
    }
  }

  return {
    ...state,
    player,
    financeHistory,
    alerts,
    victory: victoryProgress,
  }
}
