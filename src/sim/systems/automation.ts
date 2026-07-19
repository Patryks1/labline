import type { AutomationPolicies, SimState } from '../types'
import { computeSnapshot } from './compute'
import {
  quoteComputeContract,
  signComputeContract,
  terminateComputeContract,
} from './computeContracts'
import { autoBalanceHosting } from './hosting'

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}

export function setAutomationPolicies(
  state: SimState,
  update: Partial<AutomationPolicies>,
): SimState {
  return {
    ...state,
    automation: {
      ...state.automation,
      ...update,
      overflowCloud: {
        ...state.automation.overflowCloud,
        ...(update.overflowCloud ?? {}),
      },
      allocation: {
        ...state.automation.allocation,
        ...(update.allocation ?? {}),
      },
      dataProcessing: {
        ...state.automation.dataProcessing,
        ...(update.dataProcessing ?? {}),
      },
      fleetDeployment: {
        ...state.automation.fleetDeployment,
        ...(update.fleetDeployment ?? {}),
      },
      productCapacity: {
        ...state.automation.productCapacity,
        ...(update.productCapacity ?? {}),
      },
    },
  }
}

function automateOverflowCloud(state: SimState): SimState {
  const policy = state.automation.overflowCloud
  if (!policy.enabled) return state
  const demand = Math.max(0, state.lastMarket.demandPf)
  const capacity = Math.max(0.01, state.lastMarket.capacityPf)
  const utilization = demand / capacity
  const existing = state.computeContracts.find(
    (contract) =>
      contract.buyerLabId === state.playerLabId &&
      contract.kind === 'emergency' &&
      (contract.status === 'active' || contract.status === 'interrupted'),
  )

  if (existing && utilization < Math.max(0.35, policy.targetUtilization - 0.22)) {
    return terminateComputeContract(state, existing.id)
  }
  if (existing || utilization <= policy.targetUtilization || demand <= 0) return state

  const inferenceShare = Math.max(0.08, state.player.allocation.inference)
  const desiredCapacity = demand / Math.max(0.25, policy.targetUtilization)
  const pf = Math.ceil(
    clamp(1, Math.max(1, policy.maxPf), (desiredCapacity - capacity) / inferenceShare),
  )
  const quote = quoteComputeContract(state, {
    providerId: 'cloud-atlas',
    buyerLabId: state.playerLabId,
    kind: 'emergency',
    pf,
    termDays: 14,
  })
  if (
    !quote.canSign ||
    quote.dailyCost > policy.maxDailySpend ||
    state.player.cash < quote.dailyCost * 14
  ) {
    return state
  }
  return signComputeContract(state, quote)
}

function automateAllocation(state: SimState): SimState {
  const policy = state.automation.allocation
  if (!policy.enabled) return state
  const snapshot = computeSnapshot(state)
  if (snapshot.rawFlopsPf <= 0) return state

  const demandPf = Math.max(0, state.lastMarket.demandPf)
  const targetInferencePf = demandPf * (1 + clamp(0, 0.75, policy.inferenceHeadroom))
  const inference = clamp(0.12, 0.82, targetInferencePf / Math.max(0.01, snapshot.effectiveFlopsPf))
  const hasTraining = state.player.trainingJob != null || (state.player.trainingPrograms ?? []).length > 0
  const hasResearch =
    state.player.activeResearch != null ||
    (state.player.researchPrograms ?? []).some((program) => program.phase !== 'complete')
  const remainder = 1 - inference
  const trainWeight = hasTraining ? 0.68 : 0.38
  const researchWeight = hasResearch ? 1 - trainWeight : 0.22
  const weightTotal = trainWeight + researchWeight
  const training = remainder * (trainWeight / weightTotal)
  const research = remainder - training

  return {
    ...state,
    player: {
      ...state.player,
      allocation: { training, inference, research },
    },
  }
}

function automateProductCapacity(state: SimState): SimState {
  if (!state.automation.productCapacity.enabled) return state
  const apiPressure =
    (state.lastMarket.apiDemandMTok ?? 0) /
    Math.max(0.01, state.lastMarket.apiDayMTok)
  const activePlans = state.lastMarket.planStats
  const planPressure = activePlans.length > 0
    ? activePlans.reduce(
        (sum, plan) =>
          sum +
          (plan.maxSeats != null
            ? plan.subscribers / Math.max(1, plan.maxSeats)
            : plan.usageRate),
        0,
      ) / activePlans.length
    : 1
  const target = clamp(0.2, 0.85, apiPressure / Math.max(0.01, apiPressure + planPressure))
  const current = state.player.pricing.apiVsSubPriority
  return {
    ...state,
    player: {
      ...state.player,
      pricing: {
        ...state.player.pricing,
        apiVsSubPriority: current * 0.72 + target * 0.28,
      },
    },
  }
}

/**
 * Persistent policies execute after today's market settlement and prepare the
 * next day. They are conservative, budget-capped, and never bypass a quote or
 * physical ordering service.
 */
export function tickAutomation(state: SimState): SimState {
  const policy = state.automation
  if (
    !policy.overflowCloud.enabled &&
    !policy.allocation.enabled &&
    !policy.dataProcessing.enabled &&
    !policy.fleetDeployment.enabled &&
    !policy.productCapacity.enabled
  ) {
    return state
  }

  let next = state
  if (next.player.data.autoProcess !== policy.dataProcessing.enabled) {
    next = {
      ...next,
      player: {
        ...next.player,
        data: { ...next.player.data, autoProcess: policy.dataProcessing.enabled },
      },
    }
  }
  next = automateOverflowCloud(next)
  next = automateAllocation(next)
  next = automateProductCapacity(next)

  if (
    policy.fleetDeployment.enabled &&
    next.calendar.isMarketDay &&
    next.player.cash > policy.fleetDeployment.weeklyBudget * 1.5
  ) {
    const beforeCash = next.player.cash
    const balanced = autoBalanceHosting(next)
    if (beforeCash - balanced.player.cash <= policy.fleetDeployment.weeklyBudget) {
      next = balanced
    }
  }
  return next
}
