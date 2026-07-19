/**
 * Shared compute pools for any lab (player fleet snapshot or rival abstract flops).
 * Player still uses full computeSnapshot for power/VRAM; rivals use this abstract path.
 * Serve **tokens** use tokensPerDayFromFlops (one servingEfficiency application).
 */
import type { Allocation, Model } from '../types'
import {
  pfPerMTokForModel,
  TOK_PER_PF_SEC,
  tokensPerDayCapacity,
  tokensPerDayFromFlops,
} from '../balance/tokenServe'
import { normalizeAllocation } from './compute'

export interface AbstractLabCompute {
  flopsPf: number
  utilCap: number
  allocation: Allocation
  /** Serving stack efficiency (rivals + player) */
  servingEfficiency?: number
  /** 0–1 research PF reserved for data gen */
  dataGenResearchShare?: number
  /** Optional extra derates (power/vram/ram/cpu) already folded for player */
  derate?: number
  /** Actual post-hosting hardware throughput when physical rack mix is known. */
  hardwareTokPerSec?: number
  /** Engineering uplift applied once on the serving conversion path. */
  engineerServeBonus?: number
}

export interface LabPfPools {
  training: number
  inference: number
  research: number
  /**
   * Inference PF pool (no se multiply — se applies once on token path).
   * Kept name for call-site compat; equals raw inference pool.
   */
  inferenceEffective: number
}

/**
 * Split total PF into train / infer / research pools.
 * Same formula family for player abstract view and rivals.
 */
export function abstractPools(lab: AbstractLabCompute): LabPfPools {
  const alloc = normalizeAllocation(lab.allocation)
  const derate = Math.max(0.05, Math.min(1, lab.derate ?? 1))
  const util = Math.max(0.2, Math.min(0.98, lab.utilCap))
  const base = Math.max(0, lab.flopsPf) * util * derate
  const dataShare = Math.max(0, Math.min(0.85, lab.dataGenResearchShare ?? 0))
  const training = base * alloc.training
  const inference = base * alloc.inference
  const research = base * alloc.research * (1 - dataShare)
  return {
    training,
    inference,
    research,
    // Do NOT multiply by se here — token capacity applies se once
    inferenceEffective: inference,
  }
}

/** Rival-style train PF (shared with abstractPools.training). */
export function labTrainPf(lab: AbstractLabCompute): number {
  return abstractPools(lab).training
}

/** Rival-style research tech PF. */
export function labResearchPf(lab: AbstractLabCompute): number {
  return abstractPools(lab).research
}

/** Market inference capacity PF (serve pool; se applied on token conversion). */
export function labInferCapacityPf(lab: AbstractLabCompute): number {
  return abstractPools(lab).inferenceEffective
}

/** Rival/player abstract token Cap (MTok/day) for a model — same rules as player token path. */
export function labInferCapacityMTok(
  lab: AbstractLabCompute,
  model: Pick<
    Model,
    'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
  > | null,
): number {
  if (!model) return 0
  const alloc = normalizeAllocation(lab.allocation)
  return tokensPerDayFromFlops({
    flopsPf: lab.flopsPf,
    model,
    servingEfficiency: lab.servingEfficiency ?? 1,
    inferenceShare: alloc.inference,
    utilCap: lab.utilCap,
    derate: lab.derate ?? 1,
  })
}

const REFERENCE_SERVE_MODEL = {
  paramsB: 7,
  activeParamsB: 7,
  family: 'dense' as const,
  inferCostMult: 1,
  tokPerSecMult: 1,
}

/**
 * Controller-neutral inference capacity in the same PF-work units consumed by
 * inferencePfDemand.  Raw accelerator PF is not a serving unit: the player
 * path converts rack tok/s into MTok/day, so rivals must make the identical
 * conversion before comparing supply with model-specific PF demand.
 */
export function labInferCapacityWorkPf(lab: AbstractLabCompute): number {
  const alloc = normalizeAllocation(lab.allocation)
  const servingEfficiency = lab.servingEfficiency ?? 1
  const capacityMTok =
    lab.hardwareTokPerSec == null
      ? tokensPerDayFromFlops({
          flopsPf: lab.flopsPf,
          model: REFERENCE_SERVE_MODEL,
          servingEfficiency,
          inferenceShare: alloc.inference,
          utilCap: lab.utilCap,
          derate: lab.derate ?? 1,
        }) * (1 + Math.max(0, lab.engineerServeBonus ?? 0))
      : tokensPerDayCapacity({
          hardwareTokPerSec: Math.max(0, lab.hardwareTokPerSec),
          model: REFERENCE_SERVE_MODEL,
          servingEfficiency,
          inferenceShare: alloc.inference,
          util: lab.utilCap,
          powerDerate: lab.derate ?? 1,
          engServe: lab.engineerServeBonus,
        })
  return (
    capacityMTok *
    pfPerMTokForModel(REFERENCE_SERVE_MODEL, servingEfficiency)
  )
}

/** Standard remote-provider throughput for compatibility ledgers. */
export function hardwareTokPerSecFromPf(flopsPf: number): number {
  return Math.max(0, flopsPf) * TOK_PER_PF_SEC
}
