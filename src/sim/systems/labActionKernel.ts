import {
  apiHostingCostFloor,
  blendApiPrice,
  clampApiListToHostingFloor,
} from '../balance/pricing'
import { getResearchNode } from '../balance/research'
import { computeSnapshot } from './compute'
import type {
  Allocation,
  LabAction,
  LabActionPreview,
  Model,
  PlanServePrecision,
  ProductPricing,
  RivalLab,
  RivalTrainJob,
  SimState,
  StaffHeadcount,
  TrainingJob,
} from '../types'
import { planResearchPath } from './research'
import { syncLabIndex } from './labEngine'

const MAX_RESEARCH_QUEUE = 12

/**
 * The smallest common surface needed by the first shared player/rival action
 * kernel. It deliberately contains no controller-specific fields: callers may
 * pass PlayerState, RivalLab, or a canonical lab projection.
 */
export interface LabActionTarget {
  allocation: Allocation
  staff?: StaffHeadcount
  researchUnlocked: string[]
  researchQueue?: string[]
  activeResearch?: { nodeId: string } | string | null
  models: Model[]
  pricing: ProductPricing
  trainingJobs?: TrainingJob[]
  trainingJob?: TrainingJob | RivalTrainJob | null
}

function invalid(reason: string): LabActionPreview {
  return { legal: false, reasons: [reason], cashCost: 0, expectedPfDays: 0 }
}

function legal(expectedPfDays = 0): LabActionPreview {
  return { legal: true, reasons: [], cashCost: 0, expectedPfDays }
}

function normalizedAllocation(allocation: Allocation): Allocation | null {
  const values = [allocation.training, allocation.inference, allocation.research]
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 1e-9) return null
  return {
    training: allocation.training / total,
    inference: allocation.inference / total,
    research: allocation.research / total,
  }
}

export function isServePrecisionResearchUnlocked(
  precision: PlanServePrecision,
  unlocked: readonly string[],
): boolean {
  if (precision === 'fp32') return true
  if (precision === 'fp16') return unlocked.includes('opt_fp16')
  if (precision === 'bf16') return unlocked.includes('opt_mixed')
  if (precision === 'int8') return unlocked.includes('sys_quant')
  if (precision === 'fp8' || precision === 'int4' || precision === 'nvfp4') {
    return unlocked.includes('sys_fp8')
  }
  return unlocked.includes('dense_bitnet')
}

function jobsForTarget(target: LabActionTarget): Array<TrainingJob | RivalTrainJob> {
  if (target.trainingJobs?.length) return target.trainingJobs
  return target.trainingJob ? [target.trainingJob] : []
}

function scheduledResearch(target: LabActionTarget): string[] {
  const active =
    typeof target.activeResearch === 'string'
      ? target.activeResearch
      : target.activeResearch?.nodeId
  return [...(target.researchQueue ?? []), ...(active ? [active] : [])]
}

export function previewLabActionForTarget(
  target: LabActionTarget,
  action: LabAction,
): LabActionPreview {
  if (action.kind === 'set_allocation') {
    return normalizedAllocation(action.allocation)
      ? legal()
      : invalid('Allocation shares must be finite, non-negative, and sum above zero.')
  }

  if (action.kind === 'queue_research') {
    try {
      getResearchNode(action.nodeId)
    } catch {
      return invalid(`Unknown research method: ${action.nodeId}`)
    }
    if (target.researchUnlocked.includes(action.nodeId)) {
      return invalid('Research method is already unlocked.')
    }
    const path = planResearchPath(
      target.researchUnlocked,
      scheduledResearch(target),
      action.nodeId,
    )
    if (path.reason) return invalid(path.reason)
    if ((target.researchQueue?.length ?? 0) + path.nodeIds.length > MAX_RESEARCH_QUEUE) {
      return invalid(`Research queue is limited to ${MAX_RESEARCH_QUEUE} methods.`)
    }
    const researchers = target.staff?.researcher ?? 0
    if (researchers < 1) return invalid('Need at least 1 researcher.')
    const expectedPfDays = path.nodeIds.reduce(
      (sum, nodeId) => sum + getResearchNode(nodeId).costPfDays,
      0,
    )
    return legal(expectedPfDays)
  }

  if (action.kind === 'set_api_price') {
    const model = target.models.find((candidate) => candidate.id === action.modelId)
    if (!model) return invalid('Model is not owned by this lab.')
    if (
      !Number.isFinite(action.input) ||
      !Number.isFinite(action.output) ||
      action.input < 0 ||
      action.output < 0
    ) {
      return invalid('API prices must be finite and non-negative.')
    }
    return legal()
  }

  if (action.kind === 'set_api_precision') {
    const model = target.models.find((candidate) => candidate.id === action.modelId)
    if (!model) return invalid('Model is not owned by this lab.')
    if (!isServePrecisionResearchUnlocked(action.precision, target.researchUnlocked)) {
      return invalid(`${action.precision} serving is not researched.`)
    }
    if (
      action.precision === 'ternary_1_58' &&
      model.trainingNumerics?.nativeWeightFormat !== 'ternary_1_58'
    ) {
      return invalid('Ternary serving requires a natively ternary checkpoint.')
    }
    return legal()
  }

  if (action.kind === 'set_training_priority' || action.kind === 'pause_training') {
    const job = jobsForTarget(target).find((candidate) => candidate.id === action.jobId)
    if (!job) return invalid('Training job is not active for this lab.')
    if (action.kind === 'set_training_priority') {
      if (!Number.isFinite(action.priority) || action.priority < 0 || action.priority > 100) {
        return invalid('Training priority must be between 0 and 100.')
      }
      if (
        action.reservedPf != null &&
        (!Number.isFinite(action.reservedPf) || action.reservedPf < 0)
      ) {
        return invalid('Reserved PF must be finite and non-negative.')
      }
    }
    return legal()
  }

  const plan = target.pricing.plans.find((candidate) => candidate.id === action.planId)
  if (!plan) return invalid('Subscription plan is not owned by this lab.')
  const { route } = action
  if (route.primaryModelId && !target.models.some((model) => model.id === route.primaryModelId)) {
    return invalid('Primary route model is not owned by this lab.')
  }
  if (route.fallbackModelId && !target.models.some((model) => model.id === route.fallbackModelId)) {
    return invalid('Fallback route model is not owned by this lab.')
  }
  if (!Number.isFinite(route.premiumShare) || route.premiumShare < 0 || route.premiumShare > 1) {
    return invalid('Premium traffic share must be between zero and one.')
  }
  if (!isServePrecisionResearchUnlocked(route.precision, target.researchUnlocked)) {
    return invalid(`${route.precision} serving is not researched.`)
  }
  return legal()
}

/** Pure action application used directly by controllers and by the state wrapper. */
export function applyLabActionToTarget<T extends LabActionTarget>(
  target: T,
  action: LabAction,
): T {
  const preview = previewLabActionForTarget(target, action)
  if (!preview.legal) return target

  if (action.kind === 'set_allocation') {
    return { ...target, allocation: normalizedAllocation(action.allocation)! }
  }

  if (action.kind === 'queue_research') {
    const path = planResearchPath(
      target.researchUnlocked,
      scheduledResearch(target),
      action.nodeId,
    )
    return { ...target, researchQueue: [...(target.researchQueue ?? []), ...path.nodeIds] }
  }

  if (action.kind === 'set_api_price') {
    const owned = target.models.find((model) => model.id === action.modelId)
    const listed = owned
      ? clampApiListToHostingFloor(action.input, action.output, {
          costIn: owned.costApiPriceIn,
          costOut: owned.costApiPriceOut,
        })
      : { priceIn: action.input, priceOut: action.output }
    const price = blendApiPrice(listed.priceIn, listed.priceOut)
    return {
      ...target,
      pricing: {
        ...target.pricing,
        apiPricePerMTok: price,
        apiPriceInPerMTok: listed.priceIn,
        apiPriceOutPerMTok: listed.priceOut,
      },
      models: target.models.map((model) =>
        model.id === action.modelId
          ? {
              ...model,
              apiPricePerMTok: price,
              apiPriceInPerMTok: listed.priceIn,
              apiPriceOutPerMTok: listed.priceOut,
            }
          : model,
      ),
    }
  }

  if (action.kind === 'set_api_precision') {
    return {
      ...target,
      pricing: {
        ...target.pricing,
        apiServePrecisionByModel: {
          ...(target.pricing.apiServePrecisionByModel ?? {}),
          [action.modelId]: action.precision,
        },
      },
    }
  }

  if (action.kind === 'set_training_priority' || action.kind === 'pause_training') {
    const update = <J extends TrainingJob | RivalTrainJob>(job: J): J => {
      if (job.id !== action.jobId) return job
      if (action.kind === 'pause_training') {
        return { ...job, paused: action.paused } as J
      }
      return {
        ...job,
        computePriority: action.priority,
        reservedPf: action.reservedPf,
      } as J
    }
    const trainingJobs = target.trainingJobs?.map(update)
    const trainingJob = target.trainingJob ? update(target.trainingJob) : target.trainingJob
    return { ...target, trainingJobs, trainingJob }
  }

  return {
    ...target,
    pricing: {
      ...target.pricing,
      plans: target.pricing.plans.map((plan) =>
        plan.id === action.planId
          ? {
              ...plan,
              modelIds: action.route.primaryModelId
                ? [...new Set([...plan.modelIds, action.route.primaryModelId])]
                : plan.modelIds,
              modalityRoutes: {
                ...(plan.modalityRoutes ?? {}),
                [action.route.modality]: { ...action.route, fallbackModelId: null },
              },
              servePrecisionByModel: action.route.primaryModelId
                ? {
                    ...(plan.servePrecisionByModel ?? {}),
                    [action.route.primaryModelId]: action.route.precision,
                  }
                : plan.servePrecisionByModel,
              servePrecision: action.route.precision,
            }
          : plan,
      ),
    },
  }
}

function targetForState(state: SimState, labId: string): LabActionTarget {
  if (labId === state.playerLabId) {
    return {
      ...state.player,
      researchQueue: state.player.researchQueue ?? [],
      trainingJobs: state.player.trainingJobs ?? [],
    }
  }
  const rival = state.rivals.find((candidate) => candidate.id === labId)
  if (!rival) throw new Error(`Unknown lab ${labId}`)
  return {
    ...rival,
    researchQueue: rival.researchQueue ?? [],
    trainingJobs: rival.trainingJobs ?? [],
  }
}

export function previewLabAction(
  state: SimState,
  labId: string,
  action: LabAction,
): LabActionPreview {
  return previewLabActionForTarget(targetForState(state, labId), action)
}

/**
 * Shared state-level entry point. It updates the compatibility view, then
 * refreshes the canonical lab index so callers cannot create dual authority.
 */
export function applyLabAction(state: SimState, labId: string, action: LabAction): SimState {
  const target = targetForState(state, labId)
  if (!previewLabActionForTarget(target, action).legal) return state
  if (labId === state.playerLabId) {
    let nextAction = action
    let player = state.player
    if (action.kind === 'set_api_price') {
      const model = player.models.find((candidate) => candidate.id === action.modelId)
      if (model) {
        const hosting = apiHostingCostFloor(state, computeSnapshot(state), model)
        const listed = clampApiListToHostingFloor(
          action.input,
          action.output,
          hosting,
        )
        player = {
          ...player,
          models: player.models.map((candidate) =>
            candidate.id === model.id
              ? {
                  ...candidate,
                  costApiPriceIn: hosting.costIn,
                  costApiPriceOut: hosting.costOut,
                }
              : candidate,
          ),
        }
        nextAction = {
          ...action,
          input: listed.priceIn,
          output: listed.priceOut,
        }
      }
    }
    return syncLabIndex({
      ...state,
      player: applyLabActionToTarget(player, nextAction),
    })
  }
  return syncLabIndex({
    ...state,
    rivals: state.rivals.map((rival) =>
      rival.id === labId
        ? applyLabActionToTarget(
            { ...rival, researchQueue: rival.researchQueue ?? [] } satisfies RivalLab,
            action,
          )
        : rival,
    ),
  })
}
