import { BENCHMARK_DEFS } from './benchmarks'
import { createRng, hashSeed } from '../rng'
import type { BenchmarkId, BenchmarkScores, CampaignEra, DomainHeat } from '../types'

/**
 * 2026-grounded domain heat: coding/agents/science are the commercial pulse.
 * Heat is a mean-reverting walk around an era target, never a hard cutoff.
 */

export const DOMAIN_HEAT_MIN = 0.7
export const DOMAIN_HEAT_MAX = 1.6
export const DOMAIN_HEAT_UTILITY_BONUS = 0.8

const HOT_KEYS: readonly BenchmarkId[] = ['coding', 'agents', 'science', 'math']

export const BASELINE_DOMAIN_HEAT: Required<
  Pick<DomainHeat, 'coding' | 'agents' | 'science' | 'math'>
> = {
  coding: 1.35,
  agents: 1.25,
  science: 1.2,
  math: 1.1,
}

export function baselineDomainHeat(): DomainHeat {
  return { ...BASELINE_DOMAIN_HEAT }
}

export function clampDomainHeatValue(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(DOMAIN_HEAT_MIN, Math.min(DOMAIN_HEAT_MAX, value))
}

function eraTarget(era: CampaignEra | undefined, key: BenchmarkId): number {
  const late =
    era === 'power_limited_frontier' ||
    era === 'frontier_abundance' ||
    era === 'endless'
  const mid = era === 'platform_competition' || late
  switch (key) {
    case 'coding':
      return late ? 1.28 : mid ? 1.38 : era === 'scaling_specialization' ? 1.35 : 1.3
    case 'agents':
      return late ? 1.32 : mid ? 1.3 : era === 'scaling_specialization' ? 1.22 : 1.12
    case 'science':
      return late ? 1.38 : mid ? 1.2 : 1.08
    case 'math':
      return late ? 1.18 : mid ? 1.12 : 1.08
    default:
      return 1
  }
}

export function normalizeDomainHeat(heat: DomainHeat | undefined): DomainHeat {
  const next: DomainHeat = { ...BASELINE_DOMAIN_HEAT }
  if (!heat) return next
  for (const def of BENCHMARK_DEFS) {
    const raw = heat[def.id]
    next[def.id] = raw == null ? (next[def.id] ?? 1) : clampDomainHeatValue(raw)
  }
  return next
}

/**
 * Seeded mean-reverting daily step plus era drift. Tiny steps keep the pulse
 * fluid; clamps keep every domain commercially alive.
 */
export function nextDomainHeat(
  prev: DomainHeat | undefined,
  day: number,
  seed: number,
  era?: CampaignEra,
): DomainHeat {
  const current = normalizeDomainHeat(prev)
  const rng = createRng(hashSeed(seed, 'domain-heat', Math.max(1, Math.floor(day))))
  const next: DomainHeat = {}
  for (const def of BENCHMARK_DEFS) {
    const key = def.id
    const target = eraTarget(era, key)
    const prior = current[key] ?? 1
    const revert = (target - prior) * 0.012
    const noise = (rng.next() - 0.5) * 0.016
    next[key] = clampDomainHeatValue(prior + revert + noise)
  }
  return next
}

/** Benchmark-weight-normalized heat for a segment. Neutral weights → 1. */
export function segmentDomainHeatMultiplier(
  benchmarkWeights: Partial<Record<BenchmarkId, number>> | undefined,
  heat: DomainHeat | undefined,
): number {
  const h = normalizeDomainHeat(heat)
  const weights = benchmarkWeights ?? {}
  let weighted = 0
  let mass = 0
  for (const def of BENCHMARK_DEFS) {
    const w = weights[def.id] ?? 0
    if (w <= 0) continue
    weighted += w * (h[def.id] ?? 1)
    mass += w
  }
  if (mass <= 1e-9) return 1
  return clampDomainHeatValue(weighted / mass)
}

/**
 * Bounded utility nudge so a coding-hot offer excels without wiping others.
 * Alignment uses the offer's own benchmark mass, so specialists in a cold
 * domain keep a near-zero (not cliff) bonus.
 */
export function offerDomainHeatBonus(
  benchmarks: BenchmarkScores | undefined,
  heat: DomainHeat | undefined,
): number {
  if (!benchmarks) return 0
  const h = normalizeDomainHeat(heat)
  let weighted = 0
  let mass = 0
  for (const def of BENCHMARK_DEFS) {
    const score = Math.max(0, benchmarks[def.id] ?? 0)
    if (score <= 0) continue
    weighted += score * (h[def.id] ?? 1)
    mass += score
  }
  if (mass <= 1e-9) return 0
  const alignment = weighted / mass
  return Math.max(
    -DOMAIN_HEAT_UTILITY_BONUS,
    Math.min(DOMAIN_HEAT_UTILITY_BONUS, (alignment - 1) * 2.2),
  )
}

export function isHotDomain(id: BenchmarkId): boolean {
  return HOT_KEYS.includes(id)
}
