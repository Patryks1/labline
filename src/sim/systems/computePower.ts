/**
 * Shared physical power accounting for player and rival accelerator fleets.
 * PF is useful compute capacity; MW is an independent electrical constraint.
 */

export interface FleetPowerInput {
  /** Accelerator draw at full useful duty, before facility overhead. */
  fullLoadMw: number
  /** Powered-on accelerator draw with no useful work, before facility overhead. */
  idleMw: number
  /** Useful fleet duty in the 0..1 range. */
  dutyCycle: number
  /** Facility power usage effectiveness. */
  pue: number
}

export interface FleetPowerDraw {
  idleMw: number
  dynamicMw: number
  demandMw: number
}

/** Convert physical fleet characteristics and useful duty into facility MW. */
export function fleetPowerDraw(input: FleetPowerInput): FleetPowerDraw {
  const fullLoadMw = Math.max(0, input.fullLoadMw)
  const idleMw = Math.min(fullLoadMw, Math.max(0, input.idleMw))
  const dutyCycle = Math.max(0, Math.min(1, input.dutyCycle))
  const pue = Math.max(1, input.pue)
  const facilityIdleMw = idleMw * pue
  const dynamicMw =
    Math.max(0, fullLoadMw - idleMw) * Math.pow(dutyCycle, 1.2) * pue
  return {
    idleMw: facilityIdleMw,
    dynamicMw,
    demandMw: facilityIdleMw + dynamicMw,
  }
}

/** Brownouts reduce local PF throughput; they never turn PF into MW. */
export function powerDerateForSupply(
  demandMw: number,
  availableMw: number,
  floor = 0.22,
): { derate: number; throttled: boolean } {
  const demand = Math.max(0, demandMw)
  const available = Math.max(0, availableMw)
  const raw = demand > available ? available / Math.max(1e-6, demand) : 1
  return {
    derate: Math.max(0, Math.min(1, Math.max(floor, raw))),
    throttled: raw < 0.999,
  }
}

/**
 * Electrical draw for a PF workload on a known fleet. This is for forecasts
 * and attribution only; PF work remains the authoritative job currency.
 */
export function workloadPowerMw(input: {
  workPf: number
  fleetPf: number
  fullLoadMw: number
  idleMw?: number
  pue?: number
}): number {
  const fleetPf = Math.max(0, input.fleetPf)
  if (fleetPf <= 1e-9 || input.workPf <= 0) return 0
  const dutyCycle = Math.min(1, Math.max(0, input.workPf) / fleetPf)
  return fleetPowerDraw({
    fullLoadMw: input.fullLoadMw,
    idleMw: input.idleMw ?? 0,
    dutyCycle,
    pue: input.pue ?? 1,
  }).demandMw
}
