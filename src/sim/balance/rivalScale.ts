import type { BenchmarkScores, RivalArchetype } from '../types'

/**
 * Era-aware rival parameter ceilings. Year-0 labs stay near 120B; later
 * eras open the 2–5T band. Archetype multipliers keep hyperscalers ahead
 * and open-weights smaller, without a hard same-day lockstep.
 */

export const RIVAL_ERA_CEILING_Y0_B = 120
export const RIVAL_ERA_CEILING_Y2_B = 400
export const RIVAL_ERA_CEILING_Y4_B = 1_200
export const RIVAL_ERA_CEILING_Y6_B = 2_800
export const RIVAL_ERA_CEILING_Y8_B = 5_000

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

function smootherstep(t: number): number {
  const x = clamp01(t)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Campaign years elapsed from day 1 = Jan 1 of the start year. */
export function campaignYearsElapsed(day: number): number {
  return Math.max(0, (Math.max(1, day) - 1) / 365)
}

/** Smooth base ceiling in billions of parameters. */
export function rivalBaseEraCeilingB(day: number): number {
  const years = campaignYearsElapsed(day)
  if (years <= 2) {
    return lerp(
      RIVAL_ERA_CEILING_Y0_B,
      RIVAL_ERA_CEILING_Y2_B,
      smootherstep(years / 2),
    )
  }
  if (years <= 4) {
    return lerp(
      RIVAL_ERA_CEILING_Y2_B,
      RIVAL_ERA_CEILING_Y4_B,
      smootherstep((years - 2) / 2),
    )
  }
  if (years <= 6) {
    return lerp(
      RIVAL_ERA_CEILING_Y4_B,
      RIVAL_ERA_CEILING_Y6_B,
      smootherstep((years - 4) / 2),
    )
  }
  return lerp(
    RIVAL_ERA_CEILING_Y6_B,
    RIVAL_ERA_CEILING_Y8_B,
    smootherstep((years - 6) / 2),
  )
}

export function rivalArchetypeCeilingMult(archetype: RivalArchetype): number {
  switch (archetype) {
    case 'hyperscale':
      return 1.3
    case 'open_weights':
      return 0.6
    case 'efficiency':
      return 1.05
    case 'multimodal':
      return 0.95
    case 'safety':
      return 0.85
  }
}

/**
 * Soft ceiling used by live scale selection. Follows the public frontier
 * without overtaking the era band, so a player 2T flagship does not freeze
 * rivals at 120B.
 */
export function rivalEraParamCeilingB(input: {
  day: number
  archetype: RivalArchetype
  publicFrontierParamsB?: number
}): number {
  const era = rivalBaseEraCeilingB(input.day)
  const arch = rivalArchetypeCeilingMult(input.archetype)
  const eraCap = era * arch
  const frontier = Math.max(0, input.publicFrontierParamsB ?? 0)
  const follow = frontier * (0.72 + arch * 0.22)
  return Math.max(8, Math.min(RIVAL_ERA_CEILING_Y8_B * arch, Math.max(eraCap, follow)))
}

/**
 * Tokens:params comfort multiplier. Synthetic-data eras relax the bound so
 * multi-T trains are possible without deleting data as a constraint.
 */
export function rivalEraDataComfortMult(day: number, catchUp: boolean): number {
  const late = smootherstep((campaignYearsElapsed(day) - 2) / 4)
  const base = catchUp ? 2.5 : 1.15
  return base * (1 + late * (catchUp ? 1.35 : 2.1))
}

/** Seeded MoE adoption once the target leaves the dense-small regime. */
export const RIVAL_MOE_PARAM_THRESHOLD_B = 200

export function rivalMoeAdoptionChance(
  archetype: RivalArchetype,
  paramsB: number,
  hasMoeResearch: boolean,
): number {
  if (!hasMoeResearch) return 0
  if (archetype === 'efficiency') return 1
  if (paramsB < RIVAL_MOE_PARAM_THRESHOLD_B) return 0
  const scale = smootherstep((paramsB - RIVAL_MOE_PARAM_THRESHOLD_B) / 400)
  switch (archetype) {
    case 'hyperscale':
      return 0.28 + scale * 0.22
    case 'open_weights':
      return 0.22 + scale * 0.18
    case 'multimodal':
      return 0.12 + scale * 0.16
    case 'safety':
      return 0.08 + scale * 0.12
  }
}

/** Active-parameter fraction for a rival MoE (6–12% of total). */
export function rivalMoeActiveRatio(
  archetype: RivalArchetype,
  roll: number,
): number {
  const t = clamp01(roll)
  if (archetype === 'efficiency') return 0.06 + t * 0.04
  return 0.08 + t * 0.04
}

/** Independent ~8% luck bonus on a shipped rival (capability points). */
export const RIVAL_RELEASE_LUCK_CHANCE = 0.08
export const RIVAL_RELEASE_LUCK_MIN = 0.7
export const RIVAL_RELEASE_LUCK_MAX = 2.2

export function rivalReleaseLuckBonus(roll: number, magnitude: number): number {
  if (roll >= RIVAL_RELEASE_LUCK_CHANCE) return 0
  return lerp(RIVAL_RELEASE_LUCK_MIN, RIVAL_RELEASE_LUCK_MAX, clamp01(magnitude))
}

/** Luck never touches personality — that axis is scored, not rolled. */
export function applyRivalReleaseLuck<
  T extends { capability: number; benchmarks: BenchmarkScores },
>(model: T, luck: number): T {
  if (luck <= 0) return model
  return {
    ...model,
    capability: model.capability + luck,
    benchmarks: Object.fromEntries(
      Object.entries(model.benchmarks).map(([key, value]) => [
        key,
        key === 'personality'
          ? value
          : Math.min(100, (value as number) + luck * 0.45),
      ]),
    ) as T['benchmarks'],
  }
}
