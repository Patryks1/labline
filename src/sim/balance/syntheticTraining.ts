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
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Shared forecast used by recipe UI, model finalization, and reviews. */
export function syntheticTrainingProfile(input: {
  realMTok: number
  syntheticMTok: number
  teacherCapability: number
  frontierCapability: number
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
  const idealMultiplier = teacherTier === 'sota' ? 3 : teacherTier === 'medium' ? 2 : teacherTier === 'weak' ? 1 : 0
  const atIdeal = idealMultiplier > 0 ? Math.min(1, syntheticMultiplier / idealMultiplier) : 0
  const imitationRetention = input.teacherCapability > 0 ? 0.5 + atIdeal * 0.3 : 0
  const excess = Math.max(0, syntheticMultiplier - idealMultiplier)
  const saturation = Math.max(0, syntheticShare - 0.55)
  const weakTeacherRisk = teacherTier === 'weak' ? syntheticShare * 0.18 : 0
  const benchmarkOverfit = clamp01(excess * 0.22 + saturation * 0.7 + weakTeacherRisk)
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
  }
}
