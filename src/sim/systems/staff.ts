/**
 * HQ staffing: hire from shared city talent pools, poach rivals, wage burn.
 * Replaces global Org "Hire talent" scalar bumps.
 */
import {
  emptyStaff,
  staffTotal,
  addStaff,
  clampStaff,
  talentFromStaff,
  STAFF_HIRE_COST,
  STAFF_POACH_MULT,
  STAFF_ROLES,
  STAFF_WAGE_PER_DAY,
  STAFF_LABELS,
  HQ_STAFF_CAP,
  cityTalentCapacity,
  cityTalentInitial,
} from '../balance/staff'
import type { MapCity, SimState, StaffHeadcount, StaffRole } from '../types'
import { isHqAnchor, isHqKind } from './map'
import {
  compactCompletedFacilitiesForOwner,
  facilityAnchorTiles,
  mapTileAtAny,
} from './worldAccess'
import { queueTalentOrder } from './sharedMarkets'

export { STAFF_ROLES, STAFF_LABELS, emptyStaff, staffTotal, talentFromStaff }

/** Cloud-startup campaigns begin in a small leased office before owning a campus. */
export const BASE_REMOTE_TEAM_SEATS = 12

export function playerStaff(state: SimState): StaffHeadcount {
  return clampStaff(state.player.staff ?? emptyStaff())
}

export function rivalStaff(state: SimState, rivalId: string): StaffHeadcount {
  const r = state.rivals.find((x) => x.id === rivalId)
  return clampStaff(r?.staff ?? emptyStaff())
}

/** Product-specific staffing target; generic rivals stay deliberately lean. */
export function rivalResearcherHiringTarget(
  rival: Pick<SimState['rivals'][number], 'archetype' | 'researchUnlocked'>,
): number {
  return rival.archetype === 'multimodal' && !rival.researchUnlocked.includes('mm_omni')
    ? 8
    : 3
}

/** Desk seats from completed HQs. Identical for every lab controller. */
export function labHqStaffCap(state: SimState, labId: string): number {
  let cap = BASE_REMOTE_TEAM_SEATS
  if (state.map.storage === 'compact' && state.map.world) {
    for (const facility of compactCompletedFacilitiesForOwner(state, labId) ?? []) {
      if (facility.kind !== 'hq' && facility.kind !== 'hq_m' && facility.kind !== 'hq_l') {
        continue
      }
      cap += HQ_STAFF_CAP[facility.kind] ?? HQ_STAFF_CAP.hq ?? 12
      cap += Math.max(0, facility.level - 1) * 4
    }
    return cap
  }
  for (const t of facilityAnchorTiles(state, { ownerId: labId })) {
    if (!isHqKind(t.kind) || !isHqAnchor(t)) continue
    if (t.buildingProgress < t.buildingTarget) continue
    cap += HQ_STAFF_CAP[t.kind] ?? HQ_STAFF_CAP.hq ?? 12
    // Level ups add desks
    cap += Math.max(0, t.level - 1) * 4
  }
  return cap
}

/** Team seats from the leased office plus completed player HQs. */
export function playerHqStaffCap(state: SimState): number {
  return labHqStaffCap(state, state.playerLabId)
}

export function labStaffOpenSeats(state: SimState, labId: string): number {
  const staff =
    labId === state.playerLabId ? playerStaff(state) : rivalStaff(state, labId)
  return Math.max(0, labHqStaffCap(state, labId) - staffTotal(staff))
}

export function playerStaffOpenSeats(state: SimState): number {
  return labStaffOpenSeats(state, state.playerLabId)
}

/** Prefer HQ's city / region; fall back to nearest city. */
export function cityForHq(
  state: SimState,
  x: number,
  y: number,
): MapCity | null {
  const tile = mapTileAtAny(state, x, y)
  const cities = state.map.cities ?? []
  if (!cities.length) return null
  if (tile?.cityId) {
    const c = cities.find((z) => z.id === tile.cityId)
    if (c) return c
  }
  if (tile?.regionId) {
    const c = cities.find((z) => z.id === tile.regionId)
    if (c) return c
  }
  let best: MapCity | null = null
  let bestD = Infinity
  for (const c of cities) {
    const d = Math.max(Math.abs(c.cx - x), Math.abs(c.cy - y))
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

export function ensureCityTalent(city: MapCity): MapCity {
  if (city.talentAvailable && city.talentCapacity) return city
  const cap = cityTalentCapacity(city.population, city.industry)
  return {
    ...city,
    talentCapacity: cap,
    talentAvailable: city.talentAvailable ?? cityTalentInitial(cap),
    talentWageMult: city.talentWageMult ?? (city.industry === 'tech' ? 1.15 : 1),
  }
}

function withCities(state: SimState, cities: MapCity[]): SimState {
  return { ...state, map: { ...state.map, cities } }
}

function syncTalentScore(state: SimState): SimState {
  const staff = playerStaff(state)
  return {
    ...state,
    player: {
      ...state.player,
      staff,
      talent: talentFromStaff(staff),
    },
  }
}

export function hireStaffCost(
  state: SimState,
  role: StaffRole,
  count: number,
  cityId: string,
): number {
  const city = (state.map.cities ?? []).find((c) => c.id === cityId)
  const wageM = city?.talentWageMult ?? 1
  return Math.floor(STAFF_HIRE_COST[role] * count * wageM)
}

export function hireStaff(
  state: SimState,
  cityId: string,
  role: StaffRole,
  count = 1,
): SimState {
  const n = Math.max(1, Math.floor(count))
  if (playerHqStaffCap(state) <= 0) {
    return alert(state, 'warn', 'Build an HQ first — desks are required to hire.')
  }
  const open = playerStaffOpenSeats(state)
  if (open < n) {
    return alert(
      state,
      'warn',
      `Only ${open} HQ seat(s) free. Expand HQ or free headcount.`,
    )
  }
  let s = state
  const cities = s.map.cities ?? []
  const ci = cities.findIndex((c) => c.id === cityId)
  if (ci < 0) return alert(s, 'warn', 'Unknown city talent market.')
  let city = ensureCityTalent(cities[ci]!)
  const avail = city.talentAvailable![role] ?? 0
  if (avail < n) {
    return alert(
      s,
      'warn',
      `${city.name} has only ${avail} free ${STAFF_LABELS[role].toLowerCase()}.`,
    )
  }
  const cost = hireStaffCost(s, role, n, cityId)
  if (s.player.cash < cost) {
    return alert(s, 'warn', `Hiring needs $${(cost / 1e6).toFixed(1)}M.`)
  }
  city = {
    ...city,
    talentAvailable: addStaff(city.talentAvailable ?? emptyStaff(), role, -n),
  }
  const staff = addStaff(playerStaff(s), role, n)
  return {
    ...s,
    map: {
      ...s.map,
      cities: cities.map((candidate, index) =>
        index === ci ? city : ensureCityTalent(candidate),
      ),
    },
    player: {
      ...s.player,
      cash: s.player.cash - cost,
      staff,
      talent: talentFromStaff(staff),
      finance: {
        ...s.player.finance,
        cash: s.player.cash - cost,
        dayTotalOut: s.player.finance.dayTotalOut + cost,
        dayNet: s.player.finance.dayNet - cost,
        lifetimeNet: s.player.finance.lifetimeNet - cost,
      },
    },
    alerts: [
      {
        id: `hire-${s.day}-${cityId}-${role}-${n}`,
        day: s.day,
        severity: 'info' as const,
        message: `${n} ${STAFF_LABELS[role].toLowerCase()} hired immediately in ${city.name} for $${(cost / 1e6).toFixed(2)}M.`,
      },
      ...s.alerts,
    ].slice(0, 40),
  }
}

export function poachStaffCost(
  state: SimState,
  rivalId: string,
  role: StaffRole,
  count: number,
): number {
  const base = STAFF_HIRE_COST[role] * count * STAFF_POACH_MULT
  const rival = state.rivals.find((r) => r.id === rivalId)
  const brandGap = Math.max(0, (rival?.brandTrust ?? 50) - state.player.brandTrust) / 100
  return Math.floor(base * (1 + brandGap * 0.6))
}

/** Pull staff from a rival lab into player HQ (city pool not used). */
export function poachRivalStaff(
  state: SimState,
  rivalId: string,
  role: StaffRole,
  count = 1,
): SimState {
  const n = Math.max(1, Math.floor(count))
  if (playerHqStaffCap(state) <= 0) {
    return alert(state, 'warn', 'Build an HQ before poaching talent.')
  }
  if (playerStaffOpenSeats(state) < n) {
    return alert(state, 'warn', 'No free HQ seats for poached staff.')
  }
  const ri = state.rivals.findIndex((r) => r.id === rivalId)
  if (ri < 0) return state
  const rival = state.rivals[ri]!
  const rs = clampStaff(rival.staff ?? emptyStaff())
  if ((rs[role] ?? 0) < n) {
    return alert(
      state,
      'warn',
      `${rival.name} only has ${rs[role] ?? 0} ${STAFF_LABELS[role].toLowerCase()}.`,
    )
  }
  const cost = poachStaffCost(state, rivalId, role, n)
  if (state.player.cash < cost) {
    return alert(state, 'warn', `Poach needs $${(cost / 1e6).toFixed(1)}M.`)
  }
  const staff = addStaff(playerStaff(state), role, n)
  const rivals = state.rivals.slice()
  rivals[ri] = {
    ...rival,
    staff: addStaff(rs, role, -n),
    brandTrust: Math.max(20, rival.brandTrust - 1.5 * n),
  }
  return {
    ...state,
    rivals,
    player: {
      ...state.player,
      cash: state.player.cash - cost,
      staff,
      talent: talentFromStaff(staff),
      brandTrust: Math.min(100, state.player.brandTrust + 0.4 * n),
    },
    alerts: [
      {
        id: `poach-${rivalId}-${role}-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Poached ${n}× ${STAFF_LABELS[role].toLowerCase()} from ${rival.name} (−$${(cost / 1e6).toFixed(1)}M).`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

/** Daily wage burn for any lab. Controllers receive no special wage formula. */
export function labStaffWagePerDay(state: SimState, labId: string): number {
  const staff =
    labId === state.playerLabId
      ? playerStaff(state)
      : state.rivals.find((rival) => rival.id === labId)?.staff ?? emptyStaff()
  let wage = 0
  for (const r of STAFF_ROLES) {
    wage += (staff[r] ?? 0) * STAFF_WAGE_PER_DAY[r]
  }
  // Ops + HQ level softens wage pressure
  const ops = staff.ops ?? 0
  const wageRelief = Math.min(0.35, ops * 0.012)
  let hqRelief = 0
  if (state.map.storage === 'compact' && state.map.world) {
    for (const facility of compactCompletedFacilitiesForOwner(state, labId) ?? []) {
      if (isHqKind(facility.kind)) hqRelief += 0.03 * Math.max(1, facility.level)
    }
  } else {
    for (const t of facilityAnchorTiles(state, { ownerId: labId })) {
      if (!isHqKind(t.kind) || !isHqAnchor(t)) continue
      if (t.buildingProgress < t.buildingTarget) continue
      hqRelief += 0.03 * Math.max(1, t.level)
    }
  }
  hqRelief = Math.min(0.25, hqRelief)
  return Math.floor(wage * (1 - wageRelief - hqRelief))
}

/** Daily player wage burn retained as a compatibility wrapper. */
export function staffWagePerDay(state: SimState): number {
  return (
    labStaffWagePerDay(state, state.playerLabId) +
    (state.player.researchLeads ?? []).reduce((sum, lead) => sum + lead.salaryPerDay, 0)
  )
}

/** Regen free city pools + rival hiring/poach AI + sync talent score. */
export function tickStaff(state: SimState): SimState {
  let s = syncTalentScore(state)

  // Ensure + regen city pools
  const cities = (s.map.cities ?? []).map((raw) => {
    const c = ensureCityTalent(raw)
    const cap = c.talentCapacity!
    const av = { ...c.talentAvailable! }
    for (const r of STAFF_ROLES) {
      const room = (cap[r] ?? 0) - (av[r] ?? 0)
      if (room > 0) {
        // Slow regen — cities stay scarce
        const gain = Math.max(0, Math.floor(room * 0.018 + (s.day % 10 === 0 ? 1 : 0)))
        av[r] = (av[r] ?? 0) + Math.min(room, gain)
      }
    }
    return { ...c, talentAvailable: av }
  })
  s = withCities(s, cities)

  // Multimodal labs need enough researchers to clear the video/omni ladder
  // (depth gates require 5 and 8 respectively). Other rivals retain the
  // conservative three-researcher target so this product policy is not a
  // global research-speed buff.
  // Rival applications use the same queued city-talent clearing as the player.
  for (const riv of s.rivals) {
    const staff = clampStaff(riv.staff ?? emptyStaff())
    if (riv.cash < 8_000_000 || s.day % 3 !== riv.id.length % 3) continue
    const city = cities.find((candidate) => candidate.id === riv.regionId) ?? cities[0]
    if (!city?.talentAvailable) continue
    const role: StaffRole =
      (staff.researcher ?? 0) < rivalResearcherHiringTarget(riv)
        ? 'researcher'
        : (staff.data_processor ?? 0) < 2
          ? 'data_processor'
          : 'engineer'
    if ((city.talentAvailable[role] ?? 0) < 1) continue
    const cost = STAFF_HIRE_COST[role]
    s = queueTalentOrder(s, riv.id, city.id, role, 1, cost)
  }

  // Ops slowly lift brand
  const brandLift = opsBrandLiftPerDay(s)
  if (brandLift > 0) {
    s = {
      ...s,
      player: {
        ...s.player,
        brandTrust: Math.min(100, s.player.brandTrust + brandLift),
      },
    }
  }

  // Occasional rival poach of player researchers
  if (s.day % 11 === 0 && (playerStaff(s).researcher ?? 0) > 2) {
    const aggressor = s.rivals.find((r) => r.cash > 40_000_000)
    if (aggressor) {
      const cost = STAFF_HIRE_COST.researcher * STAFF_POACH_MULT * 0.9
      if (aggressor.cash > cost) {
        const staff = addStaff(playerStaff(s), 'researcher', -1)
        s = {
          ...s,
          player: {
            ...s.player,
            staff,
            talent: talentFromStaff(staff),
            brandTrust: Math.max(15, s.player.brandTrust - 1.2),
          },
          rivals: s.rivals.map((r) =>
            r.id === aggressor.id
              ? {
                  ...r,
                  cash: r.cash - cost,
                  staff: addStaff(clampStaff(r.staff ?? emptyStaff()), 'researcher', 1),
                }
              : r,
          ),
          alerts: [
            {
              id: `poached-${s.day}`,
              day: s.day,
              severity: 'warn' as const,
              message: `${aggressor.name} poached one of your researchers.`,
            },
            ...s.alerts,
          ].slice(0, 40),
        }
      }
    }
  }

  return s
}

/**
 * Research speed mult from researcher headcount.
 * **Hard gate:** 0 researchers → no progress.
 * Scales strongly with headcount so more hires clearly speed tech.
 * 1→1.0, 2→1.55, 5→3.0, 10→5.4, 20→9.5 (cap 14).
 */
export function researchTalentMult(state: SimState): number {
  return researchTalentMultFromCount(playerStaff(state).researcher ?? 0)
}

/** Same formula for player + rivals. */
export function researchTalentMultFromCount(researchers: number): number {
  const n = Math.max(0, Math.floor(researchers))
  if (n <= 0) return 0
  // Near-linear parallel research with mild diminishing returns
  return Math.min(14, 0.55 * n + Math.log2(1 + n) * 0.45)
}

/** Data processing throughput from data_processor headcount (ops help a little). */
export function dataStaffThroughputBonus(state: SimState): number {
  const n = playerStaff(state).data_processor ?? 0
  if (n <= 0) return 4 // crawl without processors
  return 6 + n * 18 + (playerStaff(state).ops ?? 0) * 2.5
}

/** Engineers raise effective util / serve conversion (capped). */
export function engineerUtilBonus(state: SimState): number {
  const n = playerStaff(state).engineer ?? 0
  return Math.min(0.14, n * 0.012)
}

export function engineerServeBonus(state: SimState): number {
  const n = playerStaff(state).engineer ?? 0
  return Math.min(0.2, n * 0.015)
}

export function engineerTrainBonus(state: SimState): number {
  const n = playerStaff(state).engineer ?? 0
  return Math.min(0.18, n * 0.012)
}

/** Fab design quality from engineers. */
export function engineerFabDesignBonus(state: SimState): number {
  const n = playerStaff(state).engineer ?? 0
  return n * 0.08
}

/** Ops brand lift per day (small). */
export function opsBrandLiftPerDay(state: SimState): number {
  const n = playerStaff(state).ops ?? 0
  return Math.min(0.08, n * 0.008)
}

function alert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `stf-${state.day}-${message.slice(0, 12)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}
