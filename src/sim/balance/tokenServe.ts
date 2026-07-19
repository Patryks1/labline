/**
 * Token-based serve capacity: racks × model (active params + family) → MTok/day.
 * Single path for player, rivals, pricing, and UI.
 */
import type { Model, ModelFamily, RackSku } from '../types'
import type { ComputeSnapshot } from '../systems/compute'

/** Reference dense size for sizeTokMult = 1. */
export const REF_PARAMS_B = 7

/** H100-ish: 2200 t/s / 0.7 PF ≈ synthetic rival bridge */
export const TOK_PER_PF_SEC = 3800

export const SIZE_TOK_EXPONENT = 0.55
export const SIZE_TOK_MIN = 0.14
export const SIZE_TOK_MAX = 16

/**
 * Global serve headroom — racks → people served.
 * 5× the prior mid-ground so small halls can cover meaningful share of the 3B TAM.
 */
export const SERVE_TOK_THROUGHPUT_MULT = 27.5

/**
 * Family compute intensity for serve (higher = fewer tokens per rack-sec).
 * User design: moe less, dense 1, omni 1.5.
 */
export function familyServeMult(family: ModelFamily | string | undefined): number {
  switch (family) {
    case 'moe':
      return 0.7
    case 'omni':
      return 1.5
    case 'video':
      return 1.9
    case 'diffusion':
      return 1.35
    case 'dense':
    default:
      return 1
  }
}

/** Serving stack factor (shared with legacy serveCompute). */
export function serveEffFactor(servingEfficiency: number): number {
  return Math.max(0.22, Math.min(1.65, servingEfficiency))
}

/**
 * Throughput mult vs 7B dense from active params.
 * Smaller models → higher tokens/sec.
 */
export function sizeTokMult(
  model: Pick<Model, 'paramsB' | 'activeParamsB'>,
): number {
  const active = Math.max(0.05, model.activeParamsB ?? model.paramsB)
  const raw = Math.pow(REF_PARAMS_B / active, SIZE_TOK_EXPONENT)
  return Math.max(SIZE_TOK_MIN, Math.min(SIZE_TOK_MAX, raw))
}

/**
 * Cost intensity vs 7B dense (inverse of throughput, × family).
 * Used for $/MTok floors and legacy pfPerMTok.
 */
export function modelServeCostMult(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
): number {
  const size = 1 / sizeTokMult(model)
  const family = familyServeMult(model.family)
  const infer = Math.max(0.35, model.inferCostMult ?? 1)
  return Math.max(0.08, size * family * infer)
}

/** Alias — pricing / serveCompute historically used modelCostMult. */
export function modelCostMult(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
): number {
  return modelServeCostMult(model)
}

export type ServeModelPick = Pick<
  Model,
  'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
>

/**
 * Tokens/sec from one rack SKU running this model at stack efficiency.
 */
export function tokensPerSecForSku(
  sku: Pick<RackSku, 'tokPerSec'>,
  model: ServeModelPick,
  servingEfficiency = 1,
): number {
  const se = serveEffFactor(servingEfficiency)
  const size = sizeTokMult(model)
  const fam = familyServeMult(model.family)
  const tokMult = Math.max(0.15, model.tokPerSecMult ?? 1)
  // Family intensity reduces throughput (omni burns more per token)
  return (
    (sku.tokPerSec * tokMult * se * size) / Math.max(0.35, fam) * SERVE_TOK_THROUGHPUT_MULT
  )
}

export function mtokPerDayFromTps(tps: number): number {
  return (Math.max(0, tps) * 86_400) / 1_000_000
}

/**
 * Fleet hardware tokens/sec (before model size / family / serve alloc).
 * Prefer snap.chipCount * avgTok when available.
 */
export function fleetHardwareTokPerSec(snap: Pick<
  ComputeSnapshot,
  'chipCount' | 'avgTokPerSecPerChip'
>): number {
  return Math.max(0, snap.chipCount) * Math.max(0, snap.avgTokPerSecPerChip)
}

export interface TokenCapacityOpts {
  /** Raw hardware tokens/sec (sum of sku.tokPerSec * count) */
  hardwareTokPerSec: number
  model: ServeModelPick | null
  servingEfficiency: number
  /** 0–1 inference allocation */
  inferenceShare: number
  /** Effective util (utilCap × eng), 0–1 */
  util?: number
  powerDerate?: number
  vramDerate?: number
  systemRamDerate?: number
  cpuDerate?: number
  engServe?: number
}

/**
 * Max MTok/day the fleet can serve for this model.
 * Token-first; derates and serve share apply once.
 */
export function tokensPerDayCapacity(opts: TokenCapacityOpts): number {
  if (!opts.model) return 0
  const hw = Math.max(0, opts.hardwareTokPerSec)
  if (hw <= 0) return 0

  const se = serveEffFactor(opts.servingEfficiency)
  const size = sizeTokMult(opts.model)
  const fam = familyServeMult(opts.model.family)
  const tokMult = Math.max(0.15, opts.model.tokPerSecMult ?? 1)

  let tps = hw * tokMult * se * size / Math.max(0.35, fam)

  const util = Math.max(0.15, Math.min(0.98, opts.util ?? 1))
  const power = Math.max(0.2, Math.min(1, opts.powerDerate ?? 1))
  const vram = Math.max(0.2, Math.min(1, opts.vramDerate ?? 1))
  const ram = Math.max(0.35, Math.min(1, opts.systemRamDerate ?? 1))
  const cpu = Math.max(0.35, Math.min(1, opts.cpuDerate ?? 1))
  const eng = 1 + Math.max(0, opts.engServe ?? 0)
  const infer = Math.max(0.05, Math.min(1, opts.inferenceShare))

  // Blend secondary derates lightly so VRAM/RAM don't double-kill vs pool path
  const secondary = 0.55 + 0.25 * ram + 0.2 * cpu
  tps *= util * power * vram * secondary * eng * infer * SERVE_TOK_THROUGHPUT_MULT

  return mtokPerDayFromTps(tps)
}

/**
 * Player capacity from a compute snapshot (live racks).
 */
export function tokensPerDayFromSnapshot(
  snap: ComputeSnapshot,
  model: ServeModelPick | null,
  servingEfficiency: number,
  inferenceShare: number,
): number {
  if (snap.vramDerateServe < 0.2) return 0
  const hw = fleetHardwareTokPerSec(snap)
  // util already partially in effective pools; use utilCap as fleet util
  return tokensPerDayCapacity({
    hardwareTokPerSec: hw,
    model,
    servingEfficiency,
    inferenceShare,
    util: snap.utilCap,
    powerDerate: snap.powerDerate > 0 && snap.powerDerate <= 1.5
      ? Math.min(1, snap.powerDerate)
      : 1,
    // powerDerate in snap is a product of many derates — use softer floors from fields
    vramDerate: snap.vramDerateServe,
    systemRamDerate: snap.systemRamDerate,
    cpuDerate: snap.cpuDerate,
  })
}

/**
 * Prefer explicit derates when we have them (player market path).
 */
export function tokensPerDayFromSnapshotPrecise(
  snap: ComputeSnapshot,
  model: ServeModelPick | null,
  servingEfficiency: number,
  inferenceShare: number,
  opts?: { engServe?: number; powerOnly?: number },
): number {
  if (snap.vramDerateServe < 0.2) return 0
  return tokensPerDayCapacity({
    hardwareTokPerSec: fleetHardwareTokPerSec(snap),
    model,
    servingEfficiency,
    inferenceShare,
    util: snap.utilCap,
    // The snapshot already blends local power/rack throttling with remote
    // host-complete capacity. Ignoring it made player serving immune to
    // brownouts while rival PF pools were derated.
    powerDerate: opts?.powerOnly ?? snap.powerDerate,
    vramDerate: snap.vramDerateServe,
    systemRamDerate: snap.systemRamDerate,
    cpuDerate: snap.cpuDerate,
    engServe: opts?.engServe ?? snap.engineerServeBonus,
  })
}

/** Rival / abstract: flops → synthetic tok/s then same model path. */
export function tokensPerDayFromFlops(opts: {
  flopsPf: number
  model: ServeModelPick | null
  servingEfficiency: number
  inferenceShare: number
  utilCap: number
  derate?: number
}): number {
  const hw = Math.max(0, opts.flopsPf) * TOK_PER_PF_SEC
  return tokensPerDayCapacity({
    hardwareTokPerSec: hw,
    model: opts.model,
    servingEfficiency: opts.servingEfficiency,
    inferenceShare: opts.inferenceShare,
    util: opts.utilCap,
    powerDerate: opts.derate ?? 1,
    vramDerate: 1,
    systemRamDerate: 1,
    cpuDerate: 1,
  })
}

/** Shared-pool serve accounting in token space. */
export function serveAgainstTokenPool(
  demandMTok: number,
  capacityMTok: number,
): { serveFrac: number; unservedRatio: number; servedMTok: number } {
  if (demandMTok <= 1e-9) {
    return { serveFrac: 1, unservedRatio: 0, servedMTok: 0 }
  }
  if (capacityMTok <= 1e-12) {
    return { serveFrac: 0, unservedRatio: 1, servedMTok: 0 }
  }
  const slack = 1.02
  const serveFrac = Math.min(1, (capacityMTok * slack) / demandMTok)
  return {
    serveFrac: Math.min(1, serveFrac),
    unservedRatio: Math.max(0, 1 - Math.min(1, capacityMTok / demandMTok)),
    servedMTok: demandMTok * Math.min(1, capacityMTok / demandMTok),
  }
}

/**
 * PF·day per MTok — derived from token cost mult for tooltips / legacy PF demand.
 * Calibrated so 7B dense @ se=1 ≈ ECONOMY.pfPerMTokAt7B when provided.
 */
export function pfPerMTokForModel(
  model: Pick<Model, 'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult'>,
  servingEfficiency = 1,
  pfPerMTokAt7B = 0.007,
): number {
  return (pfPerMTokAt7B * modelServeCostMult(model)) / serveEffFactor(servingEfficiency)
}

/** MTok/day for a single rack unit at current model (UI quotes). */
export function mtokPerDayForSku(
  sku: Pick<RackSku, 'tokPerSec'>,
  model: ServeModelPick,
  servingEfficiency: number,
  inferenceShare = 1,
  util = 1,
): number {
  const tps =
    tokensPerSecForSku(sku, model, servingEfficiency) *
    Math.max(0.05, inferenceShare) *
    Math.max(0.15, util)
  return mtokPerDayFromTps(tps)
}

export function suggestApiFromUnitCost(opts: {
  costPerMTok: number
  capability?: number
  markupPct?: number
}): {
  costIn: number
  costOut: number
  priceIn: number
  priceOut: number
  blendedCost: number
  blendedPrice: number
  markupPct: number
} {
  // costPerMTok already includes model intensity — do NOT multiply again
  const unit = Math.max(0.005, opts.costPerMTok)
  const cap = opts.capability ?? 50
  const qualityNudge = 0.9 + cap / 500
  const costIn = Math.max(0.005, unit * 0.4 * qualityNudge)
  const costOut = Math.max(0.01, unit * 1.15 * qualityNudge)
  const markupPct = opts.markupPct ?? 100
  const m = 1 + Math.max(0, markupPct) / 100
  const priceIn = Math.round(costIn * m * 1000) / 1000
  const priceOut = Math.round(costOut * m * 1000) / 1000
  const blend = (a: number, b: number) => a * 0.3 + b * 0.7
  return {
    costIn: Math.round(costIn * 1000) / 1000,
    costOut: Math.round(costOut * 1000) / 1000,
    priceIn,
    priceOut,
    blendedCost: blend(costIn, costOut),
    blendedPrice: blend(priceIn, priceOut),
    markupPct,
  }
}
