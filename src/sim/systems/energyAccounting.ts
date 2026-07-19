import type { EnergyContract, LabId, SimState } from '../types'

/** Active long-term power instruments for one lab. */
export function activeEnergyContractsForLab(
  state: SimState,
  labId: LabId,
): EnergyContract[] {
  return (state.energyContracts ?? []).filter(
    (contract) =>
      contract.labId === labId &&
      contract.status === 'active' &&
      contract.daysLeft > 0,
  )
}

/** Firm MW available at the contract price rather than the spot price. */
export function energyContractCapacityMw(state: SimState, labId: LabId): number {
  return activeEnergyContractsForLab(state, labId).reduce(
    (sum, contract) => sum + Math.max(0, contract.mw),
    0,
  )
}

export interface EnergyContractLoadSplit {
  contractedMw: number
  spotMw: number
  takeOrPayCostDay: number
}

/**
 * Splits a lab's utility load between already-paid long-term supply and spot
 * supply. The invoice is based on all contracted MW because these instruments
 * are take-or-pay; unused contracted power is deliberately not refunded.
 */
export function splitEnergyContractLoad(
  state: SimState,
  labId: LabId,
  loadMw: number,
): EnergyContractLoadSplit {
  const contracts = activeEnergyContractsForLab(state, labId)
  const safeLoadMw = Math.max(0, loadMw)
  const contractedCapacityMw = contracts.reduce(
    (sum, contract) => sum + Math.max(0, contract.mw),
    0,
  )
  const contractedMw = Math.min(safeLoadMw, contractedCapacityMw)
  return {
    contractedMw,
    spotMw: Math.max(0, safeLoadMw - contractedMw),
    takeOrPayCostDay: contracts.reduce(
      (sum, contract) =>
        sum + Math.max(0, contract.mw) * 24 * Math.max(0, contract.pricePerMWh),
      0,
    ),
  }
}
