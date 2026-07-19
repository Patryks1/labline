/**
 * Shared intelligence scaling: parameter size × data volume × data quality × mix.
 * Used by player training finalize AND rivals so everyone plays by the same rules.
 *
 * Design goals:
 * - Tiny models land ~10–20% on benches (not maxed)
 * - ~70B with solid data is mid-pack (~45–60), not saturated
 * - Multi-hundred-B / T-scale + great data + research approaches ceiling
 * - Wrong mix (all code / no chat) hurts general benches; helps specialists
 * - Under-trained big models stay dumb (data is a real gate)
 */
import type {
  BenchmarkId,
  BenchmarkScores,
  ModelFamily,
  QualityAxes,
} from '../types'
import { applyBenchmarkPolicy, inferReasoningEnabled } from './evaluationSuites'

function emptyBenchmarks(): BenchmarkScores {
  return {
    mmlu: 0,
    coding: 0,
    math: 0,
    vision: 0,
    law: 0,
    health: 0,
    science: 0,
    multilingual: 0,
    agents: 0,
    safety: 0,
  }
}

/** Capability / bench score bounds (game units 0–100). */
export const SCALE = {
  CAP_FLOOR: 9,
  CAP_CEIL: 94,
  /** Soft asymptotic bench ceiling even with perfect setup */
  BENCH_HARD_CEIL: 96,
} as const

export interface ScaleInputs {
  paramsB: number
  activeParamsB?: number
  family?: ModelFamily
  /** 0–1.2+ data volume vs recommended for this size (Chinchilla-ish coverage) */
  dataCoverage: number
  /**
   * Data quality multiplier.
   * Player lab `dataQuality` is ~1.0 baseline; job qualityUsed is 0–100.
   * Pass a 0–1.4-ish effective quality (see `normalizeDataQuality`).
   */
  dataQuality: number
  /**
   * Domain mix weights (should sum ~1). Empty → neutral balanced prior.
   */
  mixWeights?: Partial<Record<string, number>>
  /** Research soft multiplier (1 = none, up to ~1.12) */
  researchMult?: number
  /** Train completion 0–1 */
  trainComplete?: number
  /** Post-train stage strength 0–1 */
  postTrainStrength?: number
}

export interface ScaleResult {
  /** 0–1 size potential alone */
  paramPotential: number
  /** 0–1.15 data volume × quality fit */
  dataFit: number
  /** 0.7–1.05 generalist mix efficiency */
  mixGeneral: number
  /** Domain specialty 0–1 boosts */
  domainBoost: Record<string, number>
  /** Combined 0–1 intelligence index before map to capability */
  intelligence: number
  /** 0–100 capability score */
  capability: number
  /** Per-benchmark soft ceilings given this scale (before research spikes) */
  benchCeilings: BenchmarkScores
}

/**
 * Effective size for scaling curves.
 *
 * Sparse experts add useful specialized capacity, but an inactive parameter
 * cannot contribute like one exercised on every token. Count the active path
 * fully and the remaining expert bank partially, with routing overhead keeping
 * the result below an equally sized dense model.
 */
export function effectiveScaleParamsB(
  paramsB: number,
  activeParamsB?: number,
  family?: ModelFamily,
): number {
  const n = Math.max(0.001, paramsB)
  if (family === 'moe') {
    const active = Math.max(
      0.001,
      Math.min(n, activeParamsB ?? n * 0.1),
    )
    const partialExpertCapacity = active + (n - active) * 0.35
    return Math.min(n * 0.9, partialExpertCapacity)
  }
  return n
}

/**
 * Asymptotic size potential 0–~0.92 from parameter count.
 *
 * Rough targets (perfect data still multiplies):
 *  7M → 0.05 · 1B → 0.20 · 7B → 0.36 · 70B → 0.58 · 405B → 0.74 · 1T → 0.81
 */
export function paramScalePotential(
  paramsB: number,
  activeParamsB?: number,
  family?: ModelFamily,
): number {
  const n = effectiveScaleParamsB(paramsB, activeParamsB, family)
  // log10 of parameter count in millions
  const u = Math.log10(Math.max(n, 1e-5) * 1000)
  // Sigmoid centered near ~30B (u≈4.5)
  const pot = 1 / (1 + Math.exp(-(u - 4.5) / 1.05))
  return Math.max(0.02, Math.min(0.93, pot))
}

/**
 * Normalize assorted quality signals into ~0.35–1.35.
 * - `labDataQuality` ~1.0 baseline (player.stat)
 * - `jobQualityUsed` 0–100 from consumed packs
 */
export function normalizeDataQuality(opts: {
  labDataQuality?: number
  jobQualityUsed?: number
}): number {
  const lab = opts.labDataQuality ?? 1
  const job =
    opts.jobQualityUsed != null
      ? Math.max(0, Math.min(1, opts.jobQualityUsed / 100))
      : 0.55
  // Blend lab flywheel with pack quality
  const raw = 0.35 + lab * 0.35 + job * 0.45
  return Math.max(0.3, Math.min(1.4, raw))
}

/**
 * Data volume × quality gate.
 * Coverage 1.0 = recommended tokens for this size; underfeed hurts hard.
 */
export function dataFitScore(coverage: number, dataQuality: number): number {
  const c = Math.max(0, coverage)
  // Hybrid curve: 1:1 is viable, 6:1 strong, ~20:1 frontier.
  // Unique high-quality data is never punished; marginal value simply falls.
  const vol =
    c <= 0
      ? 0.08
      : c < 1
        ? 0.18 + Math.pow(Math.max(0.02, c), 0.72) * 0.62
        : c < 6
          ? 0.8 + ((c - 1) / 5) * 0.2
          : c < 20
            ? 1 + ((c - 6) / 14) * 0.12
            : Math.min(1.16, 1.12 + Math.log2(1 + (c - 20) / 20) * 0.025)
  const q = Math.max(0.3, Math.min(1.35, dataQuality))
  // Big models with trash data: quality bites harder via product
  return Math.max(0.1, Math.min(1.18, vol * (0.42 + q * 0.58)))
}

/** Entropy-style generalist mix score + domain specialty boosts. */
export function mixFit(weights?: Partial<Record<string, number>>): {
  general: number
  domainBoost: Record<string, number>
} {
  const keys = [
    'code',
    'math',
    'science',
    'law',
    'health',
    'chat',
    'image',
    'video',
    'audio',
  ] as const
  const w: Record<string, number> = {}
  let sum = 0
  for (const k of keys) {
    const v = Math.max(0, weights?.[k] ?? 0)
    w[k] = v
    sum += v
  }
  if (sum <= 1e-9) {
    // Neutral prior — slightly chat-weighted generalist
    return {
      general: 1,
      domainBoost: {
        code: 0.15,
        math: 0.1,
        science: 0.1,
        chat: 0.2,
        law: 0.1,
        health: 0.1,
        image: 0.08,
      },
    }
  }
  for (const k of keys) w[k] = (w[k] ?? 0) / sum

  // Shannon entropy normalized by log(n)
  let ent = 0
  for (const k of keys) {
    const p = w[k] ?? 0
    if (p > 1e-9) ent -= p * Math.log(p)
  }
  const entMax = Math.log(keys.length)
  const diversity = entMax > 0 ? ent / entMax : 1
  // Mono-domain ~0.72 general efficiency; balanced ~1.05
  const general = 0.72 + diversity * 0.33

  const domainBoost: Record<string, number> = {}
  for (const k of keys) {
    domainBoost[k] = Math.min(1, (w[k] ?? 0) * 1.65)
  }
  return { general: Math.max(0.65, Math.min(1.08, general)), domainBoost }
}

/**
 * Full intelligence scaling — single source of truth for capability.
 */
export function scaleIntelligence(input: ScaleInputs): ScaleResult {
  const paramPotential = paramScalePotential(
    input.paramsB,
    input.activeParamsB,
    input.family,
  )
  const dataFit = dataFitScore(input.dataCoverage, input.dataQuality)
  const { general: mixGeneral, domainBoost } = mixFit(input.mixWeights)
  const research = Math.max(0.9, Math.min(1.14, input.researchMult ?? 1))
  const complete = Math.max(0.55, Math.min(1, input.trainComplete ?? 1))
  const post = Math.max(0, Math.min(1, input.postTrainStrength ?? 0.35))

  // Core product: size × data × mix. Post-train / research are soft (can't invent scale).
  let intelligence =
    paramPotential * dataFit * mixGeneral * research * (0.88 + complete * 0.12)
  // Post-train alignment lifts a bit but never past size×data ceiling
  intelligence = Math.min(
    paramPotential * 1.12 * Math.min(1.15, dataFit),
    intelligence * (1 + post * 0.08),
  )
  intelligence = Math.max(0.03, Math.min(0.96, intelligence))

  const capability =
    SCALE.CAP_FLOOR + (SCALE.CAP_CEIL - SCALE.CAP_FLOOR) * intelligence

  const benchCeilings = benchCeilingsFromIntelligence(intelligence, domainBoost, input.family)

  return {
    paramPotential,
    dataFit,
    mixGeneral,
    domainBoost,
    intelligence,
    capability: clamp100(capability),
    benchCeilings,
  }
}

/** Per-eval difficulty & domain affinity (higher difficulty → slower climb). */
const BENCH_META: Record<
  BenchmarkId,
  { floor: number; ceil: number; difficulty: number; domains: string[] }
> = {
  mmlu: { floor: 10, ceil: 96, difficulty: 1.05, domains: ['chat', 'code', 'law', 'health'] },
  coding: { floor: 8, ceil: 95, difficulty: 1.12, domains: ['code'] },
  math: { floor: 7, ceil: 94, difficulty: 1.2, domains: ['math'] },
  vision: { floor: 4, ceil: 93, difficulty: 1.15, domains: ['image', 'video'] },
  law: { floor: 6, ceil: 94, difficulty: 1.18, domains: ['law'] },
  health: { floor: 6, ceil: 94, difficulty: 1.2, domains: ['health'] },
  science: { floor: 8, ceil: 95, difficulty: 1.1, domains: ['science'] },
  multilingual: { floor: 9, ceil: 94, difficulty: 1.0, domains: ['chat'] },
  agents: { floor: 5, ceil: 93, difficulty: 1.25, domains: ['code', 'chat'] },
  safety: { floor: 12, ceil: 96, difficulty: 0.9, domains: ['law', 'health', 'chat'] },
}

function domainAffinity(domains: string[], boost: Record<string, number>): number {
  if (domains.length === 0) return 0.5
  let s = 0
  for (const d of domains) s += boost[d] ?? 0.12
  return Math.max(0.2, Math.min(1.15, 0.35 + s / domains.length))
}

/**
 * Soft ceiling per bench given intelligence — 70B good data should not sit at 95.
 * Uses power curve so early scale is slow, late scale approaches ceil.
 */
export function benchCeilingsFromIntelligence(
  intelligence: number,
  domainBoost: Record<string, number> = {},
  family?: ModelFamily,
): BenchmarkScores {
  const out = emptyBenchmarks()
  const intel = Math.max(0.02, Math.min(0.98, intelligence))
  for (const id of Object.keys(BENCH_META) as BenchmarkId[]) {
    const meta = BENCH_META[id]!
    let aff = domainAffinity(meta.domains, domainBoost)
    if (id === 'vision' && (family === 'diffusion' || family === 'omni' || family === 'video')) {
      aff = Math.max(aff, 0.95)
    }
    if (id === 'vision' && family === 'dense') {
      aff *= 0.35
    }
    // Effective progress along 0–1 with difficulty
    const x = Math.pow(intel * (0.5 + 0.5 * aff), meta.difficulty)
    // Approach ceiling asymptotically — never quite hard-caps without perfect intel
    const approach = 1 - Math.exp(-2.4 * x)
    const score = meta.floor + (meta.ceil - meta.floor) * approach
    out[id] = clamp100(Math.min(SCALE.BENCH_HARD_CEIL, score))
  }
  return out
}

/**
 * Final benchmark scores from scale + quality axes + research/post-train nudges.
 * Research/domain nudges are **small** and still clamped to a soft headroom above ceiling.
 */
export function scoresFromScale(opts: {
  scale: ScaleResult
  quality: QualityAxes
  family: ModelFamily
  unlocked?: string[]
  postTrain?: string
  /** Extra absolute points from research/domain (capped) */
  extras?: Partial<Record<BenchmarkId, number>>
  reasoningEnabled?: boolean
  toolsEnabled?: boolean
  imageDataQualityFactor?: number
  healthLowQualityShare?: number
  scienceDataQuality?: number
  chatDataQuality?: number
}): BenchmarkScores {
  const { scale, quality, family, unlocked = [], postTrain = 'none', extras = {} } = opts
  const has = (id: string) => unlocked.includes(id)
  const base = { ...scale.benchCeilings }

  // Quality axes slightly reshape within headroom (not a second free scale axis)
  const reshape = (id: BenchmarkId, delta: number) => {
    const headroom = Math.max(2, SCALE.BENCH_HARD_CEIL - base[id])
    base[id] = clamp100(base[id] + Math.max(-8, Math.min(headroom * 0.35, delta)))
  }

  reshape('coding', (quality.coding - scale.capability) * 0.08 + (has('domain_coding') ? 4 : 0))
  reshape('math', (quality.reasoning - scale.capability) * 0.07 + (has('domain_math') ? 3.5 : 0))
  reshape('mmlu', (quality.reasoning + quality.chat - scale.capability * 2) * 0.04)
  reshape(
    'vision',
    family === 'dense' ? -6 : (quality.image - 20) * 0.06 + (has('mm_vision') ? 4 : 0),
  )
  reshape('law', (quality.safety - 30) * 0.05 + (has('domain_law') ? 6 : 0))
  reshape('health', (quality.safety - 30) * 0.05 + (has('domain_health') ? 6 : 0))
  reshape('science', (quality.reasoning - scale.capability) * 0.05 + (has('domain_science') ? 4 : 0))
  reshape('multilingual', (quality.chat - scale.capability) * 0.06 + (has('domain_multi') ? 5 : 0))
  reshape(
    'agents',
    (quality.coding - scale.capability) * 0.05 +
      (postTrain === 'tools' ? 5 : 0) +
      (has('domain_agents') ? 4 : 0),
  )
  reshape(
    'safety',
    (quality.safety - 40) * 0.12 +
      (has('align_redteam') ? 4 : 0) +
      (postTrain === 'none' ? -8 : postTrain === 'rlhf' ? 3 : 0),
  )

  // Research extras — hard-capped so unlocks don't max 7B models
  for (const id of Object.keys(base) as BenchmarkId[]) {
    const extra = Math.min(7, extras[id] ?? 0)
    const ceil = scale.benchCeilings[id] + 6
    base[id] = clamp100(Math.min(ceil, base[id] + extra))
  }

  const reasoningEnabled = opts.reasoningEnabled ?? inferReasoningEnabled({ postTrain })
  if (reasoningEnabled) {
    base.math = clamp100(base.math + 8)
    base.coding = clamp100(base.coding + 5)
    base.science = clamp100(base.science + 4)
    base.agents = clamp100(base.agents + 8)
  }

  return applyBenchmarkPolicy({
    scores: base,
    intelligence: scale.intelligence,
    capability: scale.capability,
    family,
    quality,
    postTrain,
    reasoningEnabled,
    toolsEnabled: opts.toolsEnabled ?? (postTrain === 'tools' || family === 'omni'),
    imageDataQualityFactor: opts.imageDataQualityFactor,
    healthLowQualityShare: opts.healthLowQualityShare,
    scienceDataQuality: opts.scienceDataQuality,
    chatDataQuality: opts.chatDataQuality,
  })
}

/** Soft post-train strength 0–1 for scaling. */
export function postTrainStrength(postTrain: string): number {
  switch (postTrain) {
    case 'tools':
      return 0.95
    case 'process':
      return 0.85
    case 'rlhf':
      return 0.7
    case 'sft':
      return 0.45
    default:
      return 0.1
  }
}

/** Max benchmark implied by model size and capability (debug/UI helper). */
export function modelBenchCeiling(
  model: {
    paramsB: number
    activeParamsB?: number
    family?: ModelFamily
    capability: number
  },
  benchId: BenchmarkId,
): number {
  // Infer intelligence from capability map (inverse of linear map, approx)
  const intel = Math.max(
    0.03,
    Math.min(
      0.96,
      (model.capability - SCALE.CAP_FLOOR) / (SCALE.CAP_CEIL - SCALE.CAP_FLOOR),
    ),
  )
  // Prefer size potential when downstream post-training raised capability.
  const sizeIntel = paramScalePotential(model.paramsB, model.activeParamsB, model.family)
  const use = Math.min(intel, sizeIntel * 1.15)
  const ceilings = benchCeilingsFromIntelligence(use, {}, model.family)
  return ceilings[benchId] + 4 // small headroom for post-training variance
}

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n))
}

/** Debug / UI helper: expected mmlu band for a size with good data. */
export function expectedScoresPreview(
  paramsB: number,
  opts?: { coverage?: number; quality?: number; family?: ModelFamily },
): ScaleResult {
  return scaleIntelligence({
    paramsB,
    family: opts?.family ?? 'dense',
    dataCoverage: opts?.coverage ?? 1,
    dataQuality: opts?.quality ?? 0.95,
    trainComplete: 1,
    postTrainStrength: 0.7,
  })
}
