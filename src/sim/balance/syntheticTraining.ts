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
  const effectiveSyntheticMTok = realMTok * (usefulBase + usefulBeyond)
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
