import type { SimState } from '../types'
import { servingPlacementNeed } from '../systems/servingPlacement'
import { aggregateEffects } from '../systems/research'
import { activeBalanceTuning } from './tuning'

/**
 * Daily cost of keeping public models resident and reachable.
 *
 * Distinct from fleet opex (which prices the hardware): this prices the
 * serving stack on top — redundant endpoint replicas of the weights, the
 * standing KV-cache pool, staging/control-plane overhead, and the
 * load-following infrastructure that scales with actually-served compute.
 *
 * Residency uses the same routed-model, serving precision, context and
 * concurrency placement as capacity admission. A checkpoint that does not
 * fit receives no implicit host-offload capacity.
 */

/** $/day per GB of resident (replicated) weights + standing KV pool. */
export const HOSTING_RESIDENCY_PER_GB_DAY = 1.2
/** Fixed control-plane / endpoint upkeep per public model per day. */
export const HOSTING_ENDPOINT_PER_MODEL_DAY = 500
/** $/day per served inference PF-day (load-following serving infra). */
export const HOSTING_LOAD_PER_PF_DAY = 180
/** Public endpoints run at least this many weight replicas for redundancy. */
export const HOSTING_MIN_REPLICAS = 2
/** @deprecated KV residency is now derived from context and concurrency. */
export const HOSTING_KV_FRACTION = 0.35

export interface HostedModelOpexBreakdown {
  models: Array<{
    modelId: string
    name: string
    paramsB: number
    precision: string
    replicas: number
    residentGb: number
    residencyDay: number
    endpointDay: number
  }>
  residencyDay: number
  endpointDay: number
  /** Load-following term from served inference PF-days. */
  loadDay: number
  totalDay: number
}

export function hostedModelOpexDay(
  state: SimState,
  servedInferPfDay: number,
): HostedModelOpexBreakdown {
  const tuning = activeBalanceTuning()
  const models: HostedModelOpexBreakdown['models'] = []
  const placement = servingPlacementNeed(state)
  for (const hosted of placement.placements) {
    const model = hosted.model
    const residentGb = hosted.memory.residentMemoryGb * HOSTING_MIN_REPLICAS
    const residencyDay = residentGb * HOSTING_RESIDENCY_PER_GB_DAY
    const endpointDay = HOSTING_ENDPOINT_PER_MODEL_DAY
    models.push({
      modelId: model.id,
      name: model.name,
      paramsB: model.paramsB,
      precision: hosted.precision,
      replicas: HOSTING_MIN_REPLICAS,
      residentGb,
      residencyDay,
      endpointDay,
    })
  }
  const residencyDay = models.reduce((sum, item) => sum + item.residencyDay, 0)
  const endpointDay = models.reduce((sum, item) => sum + item.endpointDay, 0)
  const loadDay =
    Math.max(0, servedInferPfDay) * HOSTING_LOAD_PER_PF_DAY
  const raw = residencyDay + endpointDay + loadDay
  const scaled = raw * tuning.hostingCostMult * tuning.expenseMult
  const discount = Math.min(
    0.25,
    Math.max(
      0,
      aggregateEffects(
        state.player.researchUnlocked,
        state.player.researchRanks,
      ).hostingOpexDiscount ?? 0,
    ),
  )
  const factor = 1 - discount
  const scale = raw > 1e-9 ? (scaled * factor) / raw : factor
  return {
    models: models.map((item) => ({
      ...item,
      residencyDay: item.residencyDay * scale,
      endpointDay: item.endpointDay * scale,
    })),
    residencyDay: residencyDay * scale,
    endpointDay: endpointDay * scale,
    loadDay: loadDay * scale,
    totalDay: scaled * factor,
  }
}
