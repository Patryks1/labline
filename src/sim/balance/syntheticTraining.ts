import { DATA_DOMAINS, defaultDataWeights, normalizeWeights } from './data'
import type { DataDomain, Model, TrainMode } from '../types'
import { activeBalanceTuning } from './tuning'

export interface SyntheticTrainingProfile {
  realMTok: number
  syntheticMTok: number
  totalMTok: number
  syntheticMultiplier: number
  syntheticShare: number
  idealMultiplier: number
  teacherTier: 'none' | 'weak' | 'medium' | 'sota'
  imitationRetention: number
  benchmarkOverfit: number
  /** Synthetic volume after teacher/quality/compute diminishing returns. */
  effectiveSyntheticMTok: number
  /** Conditions supporting useful expansion beyond 2x real data (0–1). */
  conditionalBeyond2: number
  /** Small deterministic run-to-run factor derived from the supplied seed. */
  seededVariation: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const clampScore = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
const smoothstep = (value: number) => {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

function seededUnit(seed: string | number | undefined): number {
  const text = String(seed ?? 'labline-synthetic')
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffff_ffff
}

/** Shared forecast used by recipe UI, model finalization, and reviews. */
export function syntheticTrainingProfile(input: {
  realMTok: number
  syntheticMTok: number
  teacherCapability: number
  frontierCapability: number
  teacherReliability?: number
  dataQuality?: number
  computePfDays?: number
  seed?: string | number
}): SyntheticTrainingProfile {
  const realMTok = Math.max(0, input.realMTok)
  const syntheticMTok = Math.max(0, input.syntheticMTok)
  const totalMTok = realMTok + syntheticMTok
  const syntheticMultiplier = realMTok > 0 ? syntheticMTok / realMTok : syntheticMTok > 0 ? 3 : 0
  const syntheticShare = totalMTok > 0 ? syntheticMTok / totalMTok : 0
  const relativeTeacher = input.frontierCapability > 0
    ? input.teacherCapability / input.frontierCapability
    : input.teacherCapability > 0 ? 1 : 0
  const teacherTier = input.teacherCapability <= 0
    ? 'none' as const
    : relativeTeacher >= 0.9
      ? 'sota' as const
      : relativeTeacher >= 0.55
        ? 'medium' as const
        : 'weak' as const
  const teacherStrength = clamp01(relativeTeacher)
  const absoluteTeacherStrength = smoothstep(
    (Math.max(0, input.teacherCapability) - 72) / 23,
  )
  const reliability = clamp01((input.teacherReliability ?? input.teacherCapability) / 100)
  const quality = clamp01((input.dataQuality ?? 70) / 100)
  const compute = 1 - Math.exp(-Math.max(0, input.computePfDays ?? 100) / 80)
  const conditionalBeyond2 =
    smoothstep((teacherStrength - 0.78) / 0.2) *
    absoluteTeacherStrength *
    smoothstep((reliability - 0.7) / 0.25) *
    smoothstep((quality - 0.7) / 0.25) *
    compute
  const idealMultiplier = teacherTier === 'none'
    ? 0
    : teacherTier === 'weak'
      ? 1
      : 2 + conditionalBeyond2 * 2
  const usefulBase = Math.min(2, syntheticMultiplier)
  const beyond2 = Math.max(0, syntheticMultiplier - 2)
  const usefulBeyond = Math.min(
    beyond2,
    conditionalBeyond2 * 1.8 * (1 - Math.exp(-beyond2 / 1.8)),
  )
  const effectiveSyntheticMTok =
    realMTok *
    (usefulBase + usefulBeyond) *
    activeBalanceTuning().syntheticEfficiencyMult
  const seededVariation = (seededUnit(input.seed) - 0.5) * 0.08
  const baseConditions = (0.45 + reliability * 0.55) * (0.4 + quality * 0.6)
  const imitationRetention = input.teacherCapability > 0
    ? clamp01(
        (0.42 +
          0.42 * (1 - Math.exp(-usefulBase / 0.75)) * teacherStrength * baseConditions +
          0.1 * conditionalBeyond2 * (1 - Math.exp(-beyond2 / 2))) *
          (1 + seededVariation),
      )
    : 0
  const excess = Math.max(0, syntheticMultiplier - 2)
  const saturation = Math.max(0, syntheticShare - 0.55)
  const weakTeacherRisk = teacherTier === 'weak' ? syntheticShare * 0.18 : 0
  const benchmarkOverfit = clamp01(
    (1 - Math.exp(-excess / 1.5)) * (0.15 + 0.55 * (1 - conditionalBeyond2)) +
      saturation * 0.45 +
      weakTeacherRisk -
      seededVariation * 0.25,
  )
  return {
    realMTok,
    syntheticMTok,
    totalMTok,
    syntheticMultiplier,
    syntheticShare,
    idealMultiplier,
    teacherTier,
    imitationRetention,
    benchmarkOverfit,
    effectiveSyntheticMTok,
    conditionalBeyond2,
    seededVariation,
  }
}

/**
 * Synthetic expansion past the owned corpus is available in every training mode
 * once the lab unlocks Synthetic Generators. In distill the selected teacher is
 * the generator, so expansion works there even without the lab unlock.
 */
export function syntheticExpansionUnlocked(input: {
  synthResearchUnlocked: boolean
  mode: TrainMode
  hasDistillTeacher: boolean
}): boolean {
  return (
    input.synthResearchUnlocked ||
    (input.mode === 'distill' && input.hasDistillTeacher)
  )
}

/**
 * Domain-specific teacher strength for a targeted generation job.
 * A teacher weak at math cannot generate strong math data merely because it
 * has a high general score: the domain benchmark carries 70% of the signal.
 */
export function teacherDomainStrength(input: {
  /** Teacher benchmark for the target domain (teacherCapabilityForDataDomain). */
  domainBenchmark: number
  /** Teacher reliability axis (model.quality.reliability). */
  reliability: number
  /** Teacher general capability (model.capability). */
  capability: number
}): number {
  return (
    0.7 * Math.max(0, input.domainBenchmark) +
    0.2 * Math.max(0, input.reliability) +
    0.1 * Math.max(0, input.capability)
  )
}

/** Per-token quality factor of the generation method (0–1). */
export const SYNTH_GENERATION_METHOD_QUALITY: Record<
  'imitation' | 'filtered' | 'verifier' | 'curriculum',
  number
> = {
  imitation: 0.72,
  filtered: 0.88,
  verifier: 0.95,
  curriculum: 0.9,
}

/** Quality retention per generation of self-consuming synthetic lineage. */
export function syntheticDepthDecay(generationDepth: number): number {
  return Math.pow(0.92, Math.max(1, generationDepth) - 1)
}

/**
 * Quality of one targeted synthetic generation job:
 * teacher strength × generation-method quality × filtering quality × depth decay.
 * Filtering quality scales 0.6–1.0 with the job's filter intensity.
 */
export function syntheticJobQuality(input: {
  /** teacherDomainStrength output (0–100). */
  teacherStrength: number
  method?: 'imitation' | 'filtered' | 'verifier' | 'curriculum'
  /** Job filtering intensity 0–1. */
  filterIntensity: number
  generationDepth: number
}): number {
  const methodQuality =
    SYNTH_GENERATION_METHOD_QUALITY[input.method ?? 'imitation']
  const filteringQuality = 0.6 + 0.4 * clamp01(input.filterIntensity)
  return clampScore(
    Math.max(0, input.teacherStrength) *
      methodQuality *
      filteringQuality *
      syntheticDepthDecay(input.generationDepth),
  )
}

/**
 * Per-domain synthetic headroom (MTok) a distill teacher can generate on top of
 * the player's owned corpus. Sourced from the teacher's own training corpus —
 * persisted per-domain consumption when available, else lifetime trained tokens
 * spread over the teacher's recipe mix, else a capability-scaled estimate — then
 * gated by teacher tier: a SOTA teacher transfers its full corpus, weaker
 * teachers proportionally less (same idealMultiplier ladder as the profile).
 */
export function teacherSyntheticHeadroomMTok(input: {
  teacher: Pick<
    Model,
    'capability' | 'family' | 'dataConsumed' | 'dataTokensUsedMTok' | 'dataPlan'
  >
  frontierCapability: number
}): Record<DataDomain, number> {
  const { teacher } = input
  const profile = syntheticTrainingProfile({
    realMTok: 1,
    syntheticMTok: 0,
    teacherCapability: teacher.capability,
    frontierCapability: input.frontierCapability,
  })
  const tierShare = profile.idealMultiplier / 3
  const consumed = teacher.dataConsumed ?? {}
  const hasPersisted = DATA_DOMAINS.some(
    (domain) => (consumed[domain] ?? 0) > 0,
  )
  const mix =
    teacher.dataPlan?.weights &&
    Object.keys(teacher.dataPlan.weights).length > 0
      ? normalizeWeights(teacher.dataPlan.weights)
      : defaultDataWeights(teacher.family)
  const lifetime = Math.max(0, teacher.dataTokensUsedMTok ?? 0)
  const estimatedTotal = lifetime > 0 ? lifetime : Math.max(0, teacher.capability) * 100
  const out = {} as Record<DataDomain, number>
  for (const domain of DATA_DOMAINS) {
    const corpus = hasPersisted
      ? Math.max(0, consumed[domain] ?? 0)
      : estimatedTotal * mix[domain]
    out[domain] = corpus * tierShare
  }
  return out
}
