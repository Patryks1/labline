import type { DataMix, ModelFamily } from '../types'

/**
 * Training economics (game-scaled, loosely Chinchilla-shaped but flattened for play).
 *
 * Costs are in PF-days of the *training pool* (raw fleet PF × util × train alloc × derates).
 *
 * Target feel with a healthy campus (~200 H-node racks, power matched, ~45% train split):
 * - ~7B: days–1 week
 * - ~70B: ~2–3 weeks
 * - ~500B: ~1–2 months  (was multi-year — too steep)
 * - ~1T: ~3–4 months with a frontier fleet
 *
 * If estimate is still huge, check power: train pool collapses when grid can't feed the hall.
 */

export const PARAM_PRESETS = [
  { label: '7M', paramsB: 0.007 },
  { label: '70M', paramsB: 0.07 },
  { label: '125M', paramsB: 0.125 },
  { label: '400M', paramsB: 0.4 },
  { label: '1B', paramsB: 1 },
  { label: '1.5B', paramsB: 1.5 },
  { label: '3B', paramsB: 3 },
  { label: '7B', paramsB: 7 },
  { label: '13B', paramsB: 13 },
  { label: '22B', paramsB: 22 },
  { label: '34B', paramsB: 34 },
  { label: '70B', paramsB: 70 },
  { label: '110B', paramsB: 110 },
  { label: '180B', paramsB: 180 },
  { label: '235B', paramsB: 235 },
  { label: '405B', paramsB: 405 },
  { label: '671B', paramsB: 671 },
  { label: '1T', paramsB: 1000 },
  { label: '1.8T', paramsB: 1800 },
  { label: '3T', paramsB: 3000 },
  { label: '5T', paramsB: 5000 },
  { label: '7T', paramsB: 7000 },
  { label: '10T', paramsB: 10_000 },
  { label: '13T', paramsB: 13_000 },
  { label: '20T', paramsB: 20_000 },
  { label: '30T', paramsB: 30_000 },
] as const

export function formatParams(paramsB: number): string {
  if (paramsB >= 1000) return `${(paramsB / 1000).toFixed(paramsB % 1000 === 0 ? 0 : 2)}T`
  if (paramsB >= 1) return `${paramsB >= 10 ? paramsB.toFixed(0) : paramsB.toFixed(1)}B`
  if (paramsB >= 0.001) return `${(paramsB * 1000).toFixed(paramsB * 1000 >= 10 ? 0 : 1)}M`
  return `${(paramsB * 1e6).toFixed(0)}K`
}

/** Dense pretrain PF-days (before efficiency / family). */
function densePfDays(paramsB: number): number {
  const n = Math.max(0.001, paramsB)
  // Flatter than real Chinchilla so frontier jobs stay playable.
  // Approx: 1B≈4, 7B≈22, 70B≈140, 405B≈520, 500B≈600, 1T≈1000 (then / trainEfficiency)
  return 3.9 * Math.pow(n, 0.76)
}

/**
 * MoE: total params drive most of train cost (all experts updated),
 * active params drive a smaller share (routing / critical path).
 */
function moePfDays(totalB: number, activeB: number): number {
  const t = Math.max(0.01, totalB)
  const a = Math.max(0.001, Math.min(activeB, t))
  const effective = a + (t - a) * 0.2
  return densePfDays(effective) * 1.08
}

export const TRAINING_MODALITY_COST = {
  text: 1,
  code: 1,
  law: 1,
  health: 1,
  chat: 1,
  audio: 2,
  image: 4,
  video: 12,
} as const

export function modalityComputeMultiplier(weights?: Partial<Record<string, number>>): number {
  if (!weights) return 1
  let total = 0
  let weighted = 0
  for (const [domain, raw] of Object.entries(weights)) {
    const share = Math.max(0, raw ?? 0)
    total += share
    weighted += share * (TRAINING_MODALITY_COST[domain as keyof typeof TRAINING_MODALITY_COST] ?? 1)
  }
  return total > 0 ? weighted / total : 1
}

/** PF multiplier for chosen volume; 6 tokens/parameter is the strong baseline. */
export function trainingVolumeMultiplier(dataRatio: number): number {
  return Math.max(0.25, Math.min(4, Math.max(0, dataRatio) / 6))
}

export function trainCostPfDays(opts: {
  paramsB: number
  family: ModelFamily
  trainEfficiency: number
  activeParamsB?: number
  mode?: 'pretrain' | 'distill'
  teacherParamsB?: number
  /** Actual quality-weighted tokens per total parameter. Defaults to strong 6:1. */
  dataRatio?: number
  modalityComputeMult?: number
}): number {
  const family = opts.family
  let base: number

  if (family === 'moe') {
    const active = opts.activeParamsB ?? opts.paramsB * 0.1
    base = moePfDays(opts.paramsB, active)
  } else {
    base = densePfDays(opts.paramsB)
    if (family === 'video') base *= 2.4
    else if (family === 'diffusion') base *= 1.25
    else if (family === 'omni') base *= 1.45
  }

  if (opts.mode === 'distill') {
    // Distillation: ~15–22% of pretrain compute (cheaper path to ~80% teacher IQ)
    const teacher = Math.max(opts.teacherParamsB ?? opts.paramsB * 2, opts.paramsB)
    const ratio = Math.min(1, opts.paramsB / Math.max(teacher, 0.01))
    base *= 0.14 + 0.08 * ratio
  }

  base *= trainingVolumeMultiplier(opts.dataRatio ?? 6)
  base *= Math.max(0.8, Math.min(12, opts.modalityComputeMult ?? 1))
  if (family === 'omni') base *= 1.35

  const eff = Math.max(0.25, opts.trainEfficiency)
  return base / eff
}

/** Target student intelligence as fraction of teacher when fully teacher-weighted. */
export const DISTILL_RETENTION = 0.8

/** Clamp distill teacher-share (own corpus = 1 − share). */
export function clampDistillTeacherShare(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0.72
  return Math.max(0.05, Math.min(0.95, n))
}

/**
 * Apply distillation quality from teacher signal.
 * Default retention ≈ 0.80 when fully teacher-weighted; lower if caller reduces it.
 * Pure helper — used by training finalize and unit tests.
 */
export function distillFromTeacher(opts: {
  teacherCapability: number
  teacherBenchmarks: Record<string, number>
  studentScaleCap: number
  /** Target fraction of teacher (default DISTILL_RETENTION = 0.80) */
  targetRetention?: number
}): { capability: number; retention: number; benchmarks: Record<string, number> } {
  const retention = Math.max(0.35, Math.min(0.92, opts.targetRetention ?? DISTILL_RETENTION))
  // Slight pull from student scale so tiny students cannot exceed ~80% of a giant teacher
  // while still staying in the 0.72–0.88 band for typical same-family distill.
  const scalePull = Math.min(
    1,
    Math.max(0.92, opts.studentScaleCap / Math.max(opts.teacherCapability, 1)),
  )
  const capability = Math.min(
    100,
    Math.max(1, opts.teacherCapability * retention * (0.96 + 0.04 * scalePull)),
  )
  const actualRetention = capability / Math.max(opts.teacherCapability, 1e-6)
  const benchmarks: Record<string, number> = {}
  for (const [k, v] of Object.entries(opts.teacherBenchmarks)) {
    benchmarks[k] = Math.min(100, Math.max(0, v * retention * (0.97 + 0.03 * scalePull)))
  }
  return { capability, retention: actualRetention, benchmarks }
}

/** Data mix modifiers applied at model finalize. */
export const DATA_MIX_DEFS: Record<
  DataMix,
  { label: string; blurb: string; coding: number; math: number; chat: number; safety: number; capability: number }
> = {
  web: {
    label: 'Web crawl',
    blurb: 'Broad internet mix. Balanced, cheap.',
    coding: 0,
    math: 0,
    chat: 1,
    safety: -1,
    capability: 0,
  },
  code: {
    label: 'Code-heavy',
    blurb: 'Repos, issues, docs. Strong coding benches.',
    coding: 8,
    math: 2,
    chat: -2,
    safety: 0,
    capability: 1,
  },
  math: {
    label: 'STEM / math',
    blurb: 'Papers + problem sets. Reasoning & science.',
    coding: 2,
    math: 9,
    chat: -1,
    safety: 1,
    capability: 2,
  },
  curated: {
    label: 'Curated HQ',
    blurb: 'Human-filtered. Costly, safer, stickier chat.',
    coding: 3,
    math: 3,
    chat: 5,
    safety: 6,
    capability: 3,
  },
  synthetic: {
    label: 'Synthetic',
    blurb: 'Model-generated. Fast & cheap; weaker long-tail.',
    coding: 1,
    math: 1,
    chat: 0,
    safety: -2,
    capability: -1,
  },
}

export { suggestedApiPricePerMTok, suggestApiInOut } from './pricing'

/**
 * Soft guidance: racks (or chip-equivalents) for healthy train ETA.
 * Tuned to hall-scale fleets (tens–low thousands), not real datacenter counts.
 */
export function recommendedChips(paramsB: number, family: ModelFamily): number {
  const n = family === 'moe' ? paramsB * 0.55 : paramsB
  if (n < 1) return 12
  if (n < 7) return 48
  if (n < 30) return 96
  if (n < 80) return 160
  if (n < 200) return 220
  if (n < 500) return 280
  if (n < 900) return 400
  return 600
}

export function recommendedRacks(paramsB: number, family: ModelFamily): number {
  return recommendedChips(paramsB, family)
}

/**
 * Soft validation only — **no research size caps**.
 * Scale is limited by train PF-days, VRAM, power, and inference capacity.
 * Family unlocks (MoE / multimodal) are checked separately in startTraining.
 */
export function sizeGate(
  paramsB: number,
  _family?: ModelFamily,
  _unlocked?: string[],
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(paramsB) || paramsB < 0.001) {
    return { ok: false, reason: 'Minimum size is 1M parameters.' }
  }
  return { ok: true }
}

/** @deprecated size no longer research-gated; kept for callers */
export function moeActiveGate(
  _activeParamsB: number,
  _unlocked: string[],
): { ok: boolean; reason?: string } {
  return { ok: true }
}

export function estimateTrainDays(pfDays: number, trainPoolPf: number): number {
  if (trainPoolPf <= 0.001) return Infinity
  return Math.ceil(pfDays / trainPoolPf)
}
