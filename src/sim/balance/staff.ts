import type { StaffHeadcount, StaffRole } from '../types'

export const STAFF_ROLES: StaffRole[] = [
  'researcher',
  'data_processor',
  'engineer',
  'ops',
]

export const STAFF_LABELS: Record<StaffRole, string> = {
  researcher: 'Researchers',
  data_processor: 'Data processors',
  engineer: 'Engineers',
  ops: 'Ops',
}

export const STAFF_BLURBS: Record<StaffRole, string> = {
  researcher: 'Required for research. Deep tech needs more headcount.',
  data_processor: 'Process raw corpus into training packs.',
  engineer: 'Raise util, serve efficiency, and fab design quality.',
  ops: 'Cut wage pressure and slowly lift brand trust.',
}

/** Daily wage per head by role (before city mult / HQ wage relief). */
export const STAFF_WAGE_PER_DAY: Record<StaffRole, number> = {
  researcher: 18_000,
  data_processor: 9_500,
  engineer: 14_000,
  ops: 7_500,
}

/** Cash cost to hire one head from the free city pool. */
export const STAFF_HIRE_COST: Record<StaffRole, number> = {
  researcher: 2_800_000,
  data_processor: 1_100_000,
  engineer: 2_200_000,
  ops: 900_000,
}

/** Premium mult when poaching from a rival (vs free-pool hire). */
export const STAFF_POACH_MULT = 2.4

/** HQ desk capacity by kind. */
export const HQ_STAFF_CAP: Record<string, number> = {
  hq: 12,
  hq_m: 36,
  hq_l: 90,
  office: 12, // legacy
}

/**
 * Leased/remote desk seats before an owned HQ completes.
 * HQ-first starts at 0 — hire only after placing a completed HQ.
 */
export const BASE_REMOTE_TEAM_SEATS = 0

export function emptyStaff(): StaffHeadcount {
  return { researcher: 0, data_processor: 0, engineer: 0, ops: 0 }
}

export function staffTotal(s: StaffHeadcount | undefined | null): number {
  if (!s) return 0
  return STAFF_ROLES.reduce((n, r) => n + (s[r] ?? 0), 0)
}

export function addStaff(
  a: StaffHeadcount,
  role: StaffRole,
  n: number,
): StaffHeadcount {
  return { ...a, [role]: Math.max(0, (a[role] ?? 0) + n) }
}

export function clampStaff(s: StaffHeadcount): StaffHeadcount {
  const out = emptyStaff()
  for (const r of STAFF_ROLES) out[r] = Math.max(0, Math.floor(s[r] ?? 0))
  return out
}

/** Soft talent score for UI / legacy formulas (research uses researchers directly). */
export function talentFromStaff(s: StaffHeadcount | undefined | null): number {
  if (!s) return 1
  return (
    1 +
    (s.researcher ?? 0) * 0.11 +
    (s.data_processor ?? 0) * 0.06 +
    (s.engineer ?? 0) * 0.08 +
    (s.ops ?? 0) * 0.04
  )
}

/**
 * City free-pool capacity from population + industry.
 * Kept intentionally scarce early — metros start tight.
 */
export function cityTalentCapacity(
  population: number,
  industry: string,
): StaffHeadcount {
  // ~0.2–0.6M pop → popK ~2–8 after scale-down (was ~80+)
  const popK = Math.max(2.5, population / 80_000)
  const tech =
    industry === 'tech' ? 1.2 : industry === 'finance' ? 1.08 : industry === 'port' ? 0.92 : 1
  return {
    researcher: Math.max(2, Math.round(popK * 0.9 * tech)),
    data_processor: Math.max(2, Math.round(popK * 1.15 * tech)),
    engineer: Math.max(2, Math.round(popK * 0.85 * tech)),
    ops: Math.max(3, Math.round(popK * 1.2)),
  }
}

/** Initial free pool — only a fraction of capacity is free at start. */
export function cityTalentInitial(
  capacity: StaffHeadcount,
  fill = 0.38,
): StaffHeadcount {
  const out = emptyStaff()
  for (const r of STAFF_ROLES) {
    out[r] = Math.max(0, Math.floor((capacity[r] ?? 0) * fill))
  }
  return out
}
