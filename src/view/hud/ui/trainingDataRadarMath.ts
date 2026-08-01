import { trainingDataDomainCapMTok } from '../../../sim/systems/training'
import type { DataDomain } from '../../../sim/types'

export { trainingDataDomainCapMTok }

export function rebalanceTrainingDataDomain(
  allocationsMTok: Record<DataDomain, number>,
  domain: DataDomain,
  valueMTok: number,
  capMTok = Number.POSITIVE_INFINITY,
) {
  return {
    ...allocationsMTok,
    [domain]: Math.max(0, Math.min(Math.max(0, capMTok), valueMTok)),
  }
}

export interface TrainingDataDomainFill {
  /** Hard drag cap for this domain (real corpus unless expansion is active). */
  capMTok: number
  realTake: number
  hqTake: number
  lqTake: number
  /** Tokens past the owned corpus covered by generated (teacher) synthetic data. */
  synthTake: number
  shortfall: number
}

/**
 * Coverage waterfall for one radar domain: owned real data first, then stocked
 * HQ/LQ synthetic, then freshly generated synthetic expansion past the owned
 * corpus — bounded by trainingDataDomainCapMTok so the drag is blocked at the
 * corpus when expansion is unavailable (no unlock, no distill teacher).
 */
export function trainingDataDomainFill(opts: {
  needMTok: number
  realAvailableMTok: number
  synthHQStockMTok: number
  synthLQStockMTok: number
  includeSynthHQ: boolean
  includeSynthLQ: boolean
  syntheticMultiplier?: number
  syntheticHeadroomMTok?: number
}): TrainingDataDomainFill {
  const need = Math.max(0, opts.needMTok)
  const realTake = Math.min(need, Math.max(0, opts.realAvailableMTok))
  const hqTake = opts.includeSynthHQ
    ? Math.min(Math.max(0, need - realTake), Math.max(0, opts.synthHQStockMTok))
    : 0
  const lqTake = opts.includeSynthLQ
    ? Math.min(
        Math.max(0, need - realTake - hqTake),
        Math.max(0, opts.synthLQStockMTok),
      )
    : 0
  const capMTok = trainingDataDomainCapMTok(
    opts.realAvailableMTok,
    opts.syntheticHeadroomMTok ?? 0,
    opts.syntheticMultiplier ?? 0,
  )
  const synthTake = Math.min(
    Math.max(0, need - realTake - hqTake - lqTake),
    Math.max(0, capMTok - realTake - hqTake - lqTake),
  )
  const shortfall = Math.max(0, need - realTake - hqTake - lqTake - synthTake)
  return { capMTok, realTake, hqTake, lqTake, synthTake, shortfall }
}
