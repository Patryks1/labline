/**
 * Synthetic corpus generation: PF cost, accept rate, and HQ share.
 *
 * One compute budget mints many candidate tokens. Most are rejected. Of the
 * accepted remainder, weak teachers produce mostly low-quality data; HQ share
 * rises with domain capability. Teacher size sets how much PF each attempted
 * million tokens costs — a 1B model is cheap and noisy, a 120B model is slow.
 *
 * Live sliders (`syntheticVolumeMult`, `syntheticHqShareMult`) scale this
 * shipped curve without rewriting it.
 */
import type { DataDomain, Model, ModelCapabilities, ModelFamily } from '../types'
import { SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK } from './syntheticTeacherEffort'
import { activeBalanceTuning } from './tuning'

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Number.isFinite(value) ? value : low))

const clamp01 = (value: number) => clamp(value, 0, 1)

const smoothstep = (value: number) => {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

/** Chat's `synthMTokPerPfDay`. Other domains are relative to this. */
export const SYNTH_CHAT_REFERENCE_RATE = 18

export const SYNTH_GENERATION = {
  /** 7B dense teacher is the unit of inference work. */
  refParamsB: 7,
  minParamsB: 0.007,
  /**
   * Attempted MTok per PF-day for a 7B teacher on chat at LQ intent.
   * Capability barely changes this; it changes what survives the filter.
   */
  refAttemptedMTokPerPfDay: 0.85,
  /** PF ∝ activeParams^exp. Sublinear decode, still bites at 70B+. */
  sizeExponent: 0.62,
  /** Weak teachers still spew candidates. */
  volumeCapFloor: 0.72,
  volumeCapSpan: 0.38,
  reliabilityFloor: 0.55,
  lqSpeed: 1,
  hqSpeed: 0.72,
  /** Smoothstep window for useful yield vs domain capability. */
  usefulCapLo: 28,
  usefulCapHi: 90,
  usefulFloor: 0.048,
  usefulFromCap: 0.22,
  usefulFromFit: 0.06,
  usefulFromModality: 0.06,
  usefulFromReliability: 0.05,
  usefulFromCompute: 0.035,
  usefulMin: 0.04,
  usefulMax: 0.48,
  /** Smoothstep window for HQ share of accepted tokens. */
  hqCapLo: 32,
  hqCapHi: 90,
  hqFloor: 0.05,
  hqFromCap: 0.52,
  hqFromDomain: 0.04,
  hqFromFit: 0.04,
  hqFromCompute: 0.02,
  hqVerifier: 0.07,
  hqMin: 0.04,
  hqMax: 0.78,
  /** Extra PF buys a little filtering, not a volume cheat. */
  computeFilterK: 18,
} as const

export function synthTeacherActiveParamsB(model: {
  activeParamsB?: number
  paramsB: number
}): number {
  return Math.max(
    SYNTH_GENERATION.minParamsB,
    model.activeParamsB ?? model.paramsB,
  )
}

/** How many 7B-equivalent teachers this model costs to run. */
export function synthTeacherSizeScale(activeParamsB: number): number {
  const params = Math.max(SYNTH_GENERATION.minParamsB, activeParamsB)
  return (params / SYNTH_GENERATION.refParamsB) ** SYNTH_GENERATION.sizeExponent
}

export function synthModalityBurden(domain: DataDomain): number {
  if (domain === 'video') return 1.75
  if (domain === 'image') return 1.32
  if (domain === 'audio') return 1.2
  return 1
}

export function synthArchitectureBurden(family?: ModelFamily): number {
  return family === 'omni' ? 1.14 : 1
}

/** PF multiplier vs a 7B dense text teacher on this corpus. */
export function synthTeacherWorkMultiplier(
  model: Pick<Model, 'activeParamsB' | 'paramsB' | 'family'>,
  domain: DataDomain,
): number {
  return (
    synthTeacherSizeScale(synthTeacherActiveParamsB(model)) *
    synthModalityBurden(domain) *
    synthArchitectureBurden(model.family)
  )
}

export interface SynthAttemptedInput {
  domain: DataDomain
  domainSynthMTokPerPfDay: number
  teacherDomainCapability: number
  teacherReliability: number
  researchPf: number
  tier: 'hq' | 'lq'
  activeParamsB?: number
  family?: ModelFamily
}

/** Raw candidate tokens/day before the quality filter. */
export function synthAttemptedMTokPerDay(input: SynthAttemptedInput): number {
  const tuning = activeBalanceTuning()
  const capability = clamp(input.teacherDomainCapability, 0, 100)
  const reliability = clamp(input.teacherReliability, 0, 100)
  const sizeScale = synthTeacherSizeScale(
    input.activeParamsB ?? SYNTH_GENERATION.refParamsB,
  )
  const work =
    sizeScale *
    synthModalityBurden(input.domain) *
    synthArchitectureBurden(input.family)
  const domainRel = input.domainSynthMTokPerPfDay / SYNTH_CHAT_REFERENCE_RATE
  const volumeCap =
    SYNTH_GENERATION.volumeCapFloor +
    (capability / 100) * SYNTH_GENERATION.volumeCapSpan
  const reliabilityMult = Math.max(
    SYNTH_GENERATION.reliabilityFloor,
    reliability / 80,
  )
  const speed =
    input.tier === 'lq' ? SYNTH_GENERATION.lqSpeed : SYNTH_GENERATION.hqSpeed
  return (
    Math.max(0, input.researchPf) *
    SYNTH_GENERATION.refAttemptedMTokPerPfDay *
    Math.max(0.05, domainRel) *
    volumeCap *
    reliabilityMult *
    speed *
    tuning.syntheticVolumeMult /
    Math.max(0.08, work)
  )
}

export interface SynthAcceptanceInput {
  domain: DataDomain
  domainCapability: number
  overallFit: number
  modalityFit: number
  toolFit: number
  reliability: number
  researchPf: number
}

export interface SynthAcceptanceChances {
  usefulChance: number
  hqChance: number
  computeSignal: number
}

/**
 * Accept rate and HQ share of accepted tokens.
 * Capability/fit dominate. Extra PF is a small diminishing filter bonus.
 */
export function synthAcceptanceChances(
  input: SynthAcceptanceInput,
): SynthAcceptanceChances {
  const tuning = activeBalanceTuning()
  const cap = clamp(input.domainCapability, 0, 100)
  const fit = clamp01(input.overallFit)
  const modality = clamp01(input.modalityFit)
  const reliability = clamp01(input.reliability / 100)
  const computeSignal =
    Math.max(0, input.researchPf) /
    Math.max(2, input.researchPf + SYNTH_GENERATION.computeFilterK)
  const usefulSignal = smoothstep(
    (cap - SYNTH_GENERATION.usefulCapLo) /
      Math.max(1, SYNTH_GENERATION.usefulCapHi - SYNTH_GENERATION.usefulCapLo),
  )
  const hqSignal = smoothstep(
    (cap - SYNTH_GENERATION.hqCapLo) /
      Math.max(1, SYNTH_GENERATION.hqCapHi - SYNTH_GENERATION.hqCapLo),
  )
  const usefulChance = clamp(
    SYNTH_GENERATION.usefulFloor +
      usefulSignal * SYNTH_GENERATION.usefulFromCap +
      fit * SYNTH_GENERATION.usefulFromFit +
      (modality - 0.5) * SYNTH_GENERATION.usefulFromModality +
      (reliability - 0.5) * SYNTH_GENERATION.usefulFromReliability +
      computeSignal * SYNTH_GENERATION.usefulFromCompute,
    SYNTH_GENERATION.usefulMin,
    SYNTH_GENERATION.usefulMax,
  )
  const verifierBonus =
    input.domain === 'code' || input.domain === 'math'
      ? SYNTH_GENERATION.hqVerifier * clamp01(input.toolFit)
      : 0
  const hqChance = clamp(
    (SYNTH_GENERATION.hqFloor +
      hqSignal * SYNTH_GENERATION.hqFromCap +
      (cap / 100) * SYNTH_GENERATION.hqFromDomain +
      fit * SYNTH_GENERATION.hqFromFit +
      computeSignal * SYNTH_GENERATION.hqFromCompute +
      verifierBonus) *
      tuning.syntheticHqShareMult,
    SYNTH_GENERATION.hqMin,
    SYNTH_GENERATION.hqMax,
  )
  return { usefulChance, hqChance, computeSignal }
}

/** Thinking-budget method factors for `syntheticQualityFor`. */
export const SYNTH_QUALITY_METHOD_FACTOR = {
  1: 0.85,
  2: 0.9,
  4: 0.97,
  8: 1,
  12: 1.015,
  20: 1.03,
  100: 1.06,
} as const

export type SynthTierBudget = keyof typeof SYNTH_QUALITY_METHOD_FACTOR

export const SYNTH_QUALITY_DEPTH_BASE = 0.92

export interface SyntheticGenerationJob {
  id: string
  domain: DataDomain
  teacherRef: string
  tierBudget: SynthTierBudget
  targetMTok: number
  generatedMTok: number
  verify: boolean
  startDay: number
  status: 'running' | 'completed' | 'cancelled'
}

/**
 * Sole V4 synthetic quality formula (0–1):
 * (teacherDomainCap/100) · methodFactor · filterFactor · 0.92^(depth−1).
 * methodFactor by thinking budget {1: 0.85, 2: 0.9, 4: 0.97, 8: 1.0, 12: 1.015, 20: 1.03, 100: 1.06}.
 * filterFactor = 0.9 + 0.1 · verifierStrength.
 */
export function syntheticQualityFor(input: {
  teacherDomainCap: number
  tierBudget: SynthTierBudget
  verifierStrength: number
  depth: number
}): number {
  const cap = clamp(input.teacherDomainCap, 0, 100) / 100
  const methodFactor = SYNTH_QUALITY_METHOD_FACTOR[input.tierBudget]
  const filterFactor = 0.9 + 0.1 * clamp01(input.verifierStrength)
  const depth = Math.max(1, input.depth)
  return cap * methodFactor * filterFactor * SYNTH_QUALITY_DEPTH_BASE ** (depth - 1)
}

/** PF-days and cash to mint `generatedMTok` (generated × tierBudget × per-token work). */
export function syntheticGenerationCost(input: {
  generatedMTok: number
  tierBudget: SynthTierBudget
  teacherActiveParamsB: number
  domain: DataDomain
  family?: ModelFamily
}): { pfDays: number; cash: number } {
  const generated = Math.max(0, input.generatedMTok)
  const work =
    synthTeacherSizeScale(input.teacherActiveParamsB) *
    synthModalityBurden(input.domain) *
    synthArchitectureBurden(input.family) *
    input.tierBudget
  const pfPerMTok = work / SYNTH_GENERATION.refAttemptedMTokPerPfDay
  return {
    pfDays: generated * pfPerMTok,
    cash: generated * SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK * input.tierBudget,
  }
}

export function syntheticMTokFromPfDays(input: {
  pfDays: number
  tierBudget: SynthTierBudget
  teacherActiveParamsB: number
  domain: DataDomain
  family?: ModelFamily
}): number {
  const cost = syntheticGenerationCost({
    generatedMTok: 1,
    tierBudget: input.tierBudget,
    teacherActiveParamsB: input.teacherActiveParamsB,
    domain: input.domain,
    family: input.family,
  })
  if (!(cost.pfDays > 0)) return 0
  return Math.max(0, input.pfDays) / cost.pfDays
}

/** Map a data domain onto checkpoint/model capability truth (0–100). */
export function domainCapFromCapabilities(
  capabilities: ModelCapabilities,
  domain: DataDomain,
): number {
  const domains = capabilities.domains
  if (domain === 'code') return domains.code
  if (domain === 'math') return domains.math
  if (domain === 'science') return domains.science
  if (domain === 'image') return domains.vision
  if (domain === 'video') return domains.video
  if (domain === 'audio') return domains.audio
  if (domain === 'law') {
    return domains.language * 0.65 + domains.reasoning * 0.35
  }
  if (domain === 'health') {
    return (
      domains.science * 0.55 +
      domains.reasoning * 0.25 +
      capabilities.factuality * 0.2
    )
  }
  return domains.language
}

