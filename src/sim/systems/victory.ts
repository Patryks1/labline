import { ECONOMY } from '../balance/economy'
import { STAFF_HIRE_COST, STAFF_ROLES, STAFF_WAGE_PER_DAY } from '../balance/staff'
import type { Model, SimState, TileKind } from '../types'
import { isBuildableKind, isHqAnchor } from './map'
import { playerStaff } from './staff'
import { facilityAnchorTiles, usesCompactWorld } from './worldAccess'

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
    ms.filter((m) => m.release === 'released' || m.shipped)
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
  const models = state.player.models.filter(
    (m) => m.release === 'released' || m.shipped,
  )
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

/** Real estate + plant: halls, HQs, labs, power, fabs (completed + WIP). */
export function buildingAssetValue(state: SimState): number {
  let value = 0
  if (usesCompactWorld(state)) {
    state.map.world!.forEachFacility({ ownerId: 'player' }, (facility) => {
      if (!isBuildableKind(facility.kind as TileKind)) return

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
export function fleetAssetValue(state: SimState): number {
  let value = 0
  for (const r of state.player.rackFleet ?? []) {
    if (r.status === 'live') value += r.paidEach * r.count * 0.58
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
  const plantAndFleet = buildingAssetValue(state) + fleetAssetValue(state)
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
  const bestCap = state.player.models.reduce((m, x) => Math.max(m, x.capability), 0)
  const share = state.player.finance.totalShare
  const v = ECONOMY.victory

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

  const founderOwnership = (state.player.capital?.capTable ?? [])
    .filter((stake) => stake.kind === 'founder')
    .reduce((sum, stake) => sum + stake.ownership, 0)
  if (state.player.capital && founderOwnership < 0.05) {
    return {
      ...state,
      player,
      financeHistory,
      paused: true,
      progression: { ...state.progression, runPhase: 'failed' },
      victory: {
        ...state.victory,
        outcome: 'lost',
        reason: `Founder ownership fell to ${(founderOwnership * 100).toFixed(1)}%. The company is no longer yours.`,
      },
    }
  }

  // V4 decade campaigns use non-terminal milestone titles and the capital
  // recovery ladder. Valuation remains live here for funding and reports.
  if (state.config?.campaignRules) {
    if (
      state.player.capital?.restructuring.stage === 'bankruptcy' &&
      player.cash < -20_000_000
    ) {
      return {
        ...state,
        player,
        financeHistory,
        paused: true,
        progression: { ...state.progression, runPhase: 'failed' },
        victory: {
          ...state.victory,
          outcome: 'lost',
          reason: 'Restructuring failed and the company entered bankruptcy.',
        },
      }
    }
    return { ...state, player, financeHistory }
  }

  // loss: bankrupt
  if (player.cash < v.bankruptCash) {
    return {
      ...state,
      player,
      financeHistory,
      paused: true,
      victory: {
        ...state.victory,
        outcome: 'lost',
        reason: 'Cash cratered. The board forces a fire sale.',
      },
    }
  }

  // win conditions after min day
  if (state.day >= v.minDay) {
    if (share >= v.share && valuation >= v.valuation * 0.5) {
      return {
        ...state,
        player,
        financeHistory,
        paused: true,
        victory: {
          ...state.victory,
          outcome: 'won',
          reason: `Market dominance — ${(share * 100).toFixed(0)}% share and a real business.`,
        },
      }
    }
    if (bestCap >= v.capability && valuation >= v.valuation * 0.35) {
      return {
        ...state,
        player,
        financeHistory,
        paused: true,
        victory: {
          ...state.victory,
          outcome: 'won',
          reason: `Frontier milestone — capability ${bestCap.toFixed(0)} with a sustainable lab.`,
        },
      }
    }
    if (valuation >= v.valuation && share >= v.share * 0.55) {
      return {
        ...state,
        player,
        financeHistory,
        paused: true,
        victory: {
          ...state.victory,
          outcome: 'won',
          reason: `Valuation moonshot — ${(valuation / 1e9).toFixed(1)}B paper wealth.`,
        },
      }
    }
  }

  // soft loss: all rivals crushing forever at day 200 with <5% share
  if (state.day >= 200 && share < 0.05 && player.cash < 1_000_000) {
    return {
      ...state,
      player,
      financeHistory,
      paused: true,
      victory: {
        ...state.victory,
        outcome: 'lost',
        reason: 'Irrelevant. Rivals own the stack and you are out of runway.',
      },
    }
  }

  return { ...state, player, financeHistory }
}
