import type { ModelFamily } from '../types'

export interface ModelStackModule {
  id: string
  name: string
  focus: 'Train' | 'Host' | 'Speed' | 'Intelligence'
  description: string
  families?: ModelFamily[]
  trainCostMult: number
  hostingMult: number
  speedMult: number
  capabilityBonus: number
  reasoningEnabled?: boolean
}

// V4-DELETE: stack speed/hosting multipliers remain until V4 serveEfficiency fully replaces them.
export const MODEL_STACK_MODULES: readonly ModelStackModule[] = [
  {
    id: 'opt_flash', name: 'Flash Attention', focus: 'Speed',
    description: 'IO-aware attention for faster training and generation.',
    trainCostMult: 0.9, hostingMult: 0.94, speedMult: 1.12, capabilityBonus: 0.3,
  },
  {
    id: 'sys_kernels', name: 'Fused Kernels', focus: 'Host',
    description: 'Fuse hot paths to use fewer serving PF.',
    trainCostMult: 0.94, hostingMult: 0.88, speedMult: 1.18, capabilityBonus: 0,
  },
  {
    id: 'sys_compile', name: 'Graph Compiler', focus: 'Host',
    description: 'Compile model shapes into a lean production graph.',
    trainCostMult: 0.95, hostingMult: 0.9, speedMult: 1.14, capabilityBonus: 0,
  },
  {
    id: 'sys_paged_attn', name: 'Paged Attention', focus: 'Host',
    description: 'Pack KV cache cleanly for more concurrent users.',
    trainCostMult: 1, hostingMult: 0.86, speedMult: 1.08, capabilityBonus: 0,
  },
  {
    id: 'sys_spec_decode', name: 'Speculative Decode', focus: 'Speed',
    description: 'Use a draft path to accelerate accepted tokens.',
    trainCostMult: 1.02, hostingMult: 0.92, speedMult: 1.24, capabilityBonus: 0,
  },
  {
    id: 'sys_medusa', name: 'Medusa Decode Heads', focus: 'Speed',
    description: 'Attach auxiliary heads and verify a tree of draft tokens in parallel.',
    trainCostMult: 1.04, hostingMult: 0.96, speedMult: 1.3, capabilityBonus: 0,
  },
  {
    id: 'dense_mtp', name: 'Training-Time MTP', focus: 'Intelligence',
    description: 'Train auxiliary future-token objectives into the base model.', families: ['dense', 'moe', 'omni'],
    trainCostMult: 1.08, hostingMult: 1, speedMult: 1, capabilityBonus: 1.1,
  },
  {
    id: 'dense_opt', name: 'Better Optimizers', focus: 'Intelligence',
    description: 'Spend the same data and compute more effectively.', families: ['dense'],
    trainCostMult: 0.9, hostingMult: 1, speedMult: 1, capabilityBonus: 1.5,
  },
  {
    id: 'moe_balance', name: 'Expert Load Balance', focus: 'Intelligence',
    description: 'Route tokens evenly so sparse experts learn and serve well.', families: ['moe'],
    trainCostMult: 0.9, hostingMult: 0.88, speedMult: 1.08, capabilityBonus: 1,
  },
  {
    id: 'align_process', name: 'Reasoning Training', focus: 'Intelligence',
    description: 'Process rewards teach the model to plan and verify intermediate steps.',
    families: ['dense', 'moe', 'omni', 'embedding'],
    trainCostMult: 1.15, hostingMult: 1.04, speedMult: 0.92, capabilityBonus: 0.8,
    reasoningEnabled: true,
  },
] as const

export function modelStackModulesForFamily(family: ModelFamily): readonly ModelStackModule[] {
  return MODEL_STACK_MODULES.filter(
    (module) => !module.families || module.families.includes(family),
  )
}

export function sanitizeModelStack(
  selected: readonly string[],
  unlocked: readonly string[],
  family: ModelFamily,
): string[] {
  const allowed = new Set(
    modelStackModulesForFamily(family)
      .filter((module) => unlocked.includes(module.id))
      .map((module) => module.id),
  )
  return [...new Set(selected)].filter((id) => allowed.has(id))
}

export function defaultModelStack(unlocked: readonly string[], family: ModelFamily): string[] {
  return modelStackModulesForFamily(family)
    .filter((module) => unlocked.includes(module.id))
    .map((module) => module.id)
}

export function modelStackModifiers(selected: readonly string[], family: ModelFamily) {
  const selectedSet = new Set(selected)
  return modelStackModulesForFamily(family).reduce(
    (result, module) => selectedSet.has(module.id)
      ? {
          trainCostMult: result.trainCostMult * module.trainCostMult,
          hostingMult: result.hostingMult * module.hostingMult,
          speedMult: result.speedMult * module.speedMult,
          capabilityBonus: result.capabilityBonus + module.capabilityBonus,
          reasoningEnabled: result.reasoningEnabled || module.reasoningEnabled === true,
        }
      : result,
    { trainCostMult: 1, hostingMult: 1, speedMult: 1, capabilityBonus: 0, reasoningEnabled: false },
  )
}
