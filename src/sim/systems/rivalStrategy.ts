import { getResearchNode, RESEARCH_NODES } from '../balance/research'
import type {
  Allocation,
  PlanServePrecision,
  ResearchNodeDef,
  RivalControllerState,
  RivalGoalKind,
  RivalLab,
  SimState,
  TrainingNumerics,
} from '../types'
import { createRng, hashSeed } from '../rng'
import { minResearchersForNode, planResearchPath } from './research'
import { resolveRackSku } from './racks'
import {
  DEFAULT_TRAINING_NUMERICS,
  validateTrainingNumerics,
} from '../balance/trainingPrecision'

const STRATEGIC_CADENCE_DAYS = 28
const TACTICAL_CADENCE_DAYS = 5
const RIVAL_MEMORY_LIMIT = 32

export type RivalDecisionCadence = 'operational' | 'tactical' | 'strategic'

export function rivalActionSeed(
  worldSeed: number,
  labId: string,
  decisionRevision: number,
  day: number,
  cadence: RivalDecisionCadence,
  actionKind: string,
): number {
  return hashSeed(
    worldSeed,
    labId,
    decisionRevision,
    day,
    cadence,
    actionKind,
  )
}

export function rivalActionRng(
  worldSeed: number,
  labId: string,
  decisionRevision: number,
  day: number,
  cadence: RivalDecisionCadence,
  actionKind: string,
) {
  return createRng(
    rivalActionSeed(worldSeed, labId, decisionRevision, day, cadence, actionKind),
  )
}

function releasedPlayerCapability(state: SimState): number {
  return state.player.models.reduce(
    (best, model) =>
      model.release === 'released' || model.shipped
        ? Math.max(best, model.capability)
        : best,
    0,
  )
}

function ownCapability(rival: RivalLab): number {
  return rival.models.reduce((best, model) => Math.max(best, model.capability), 0)
}

function difficultyObservationWeight(
  difficulty: SimState['config']['difficulty'],
): number {
  if (difficulty === 'easy') return 0.08
  if (difficulty === 'hard') return 0.42
  return 0.2
}

function chooseGoal(
  rival: RivalLab,
  beliefFrontier: number,
): { primary: RivalGoalKind; secondary?: RivalGoalKind } {
  const runway = rival.finance?.runwayDays ?? Infinity
  const capGap = beliefFrontier - ownCapability(rival)
  if (rival.cash <= 0 || runway < 45) {
    return { primary: 'survive', secondary: 'improve_efficiency' }
  }
  if ((rival.lastUnserved ?? rival.servicePain ?? 0) > 0.16) {
    return { primary: 'restore_service', secondary: 'improve_efficiency' }
  }
  if (rival.models.length === 0 || rival.trainingJob) {
    return { primary: 'ship_model', secondary: 'unlock_research' }
  }
  if (
    rival.archetype === 'efficiency' &&
    (!rival.researchUnlocked.includes('sys_quant') || capGap > 5)
  ) {
    return { primary: 'improve_efficiency', secondary: 'ship_model' }
  }
  if (capGap > 8) return { primary: 'ship_model', secondary: 'unlock_research' }
  if ((rival.marketShare ?? 0) < 0.08) {
    return { primary: 'grow_share', secondary: 'defend_segment' }
  }
  return { primary: 'defend_segment', secondary: 'unlock_research' }
}

function defaultStrategy(rival: RivalLab, state: SimState): RivalControllerState {
  const frontier = releasedPlayerCapability(state)
  const goal = chooseGoal(rival, frontier)
  return {
    profileId: rival.archetype,
    goal: goal.primary,
    secondaryGoal: goal.secondary,
    beliefs: {
      observedDay: state.day,
      frontierCapability: frontier,
      marketPricePerMTok: Math.max(0, state.player.pricing.apiPricePerMTok),
      demandGrowth: 0,
      confidence: state.config.difficulty === 'hard' ? 0.82 : state.config.difficulty === 'easy' ? 0.52 : 0.68,
    },
    plan: [],
    memory: [],
    cooldowns: {},
    decisionRevision: 0,
    lastOperationalDay: state.day - 1,
    lastTacticalDay: state.day - TACTICAL_CADENCE_DAYS,
    lastStrategicDay: state.day - STRATEGIC_CADENCE_DAYS,
  }
}

/**
 * Save-compatible strategy normalization. The field is optional so old saves
 * receive a controller on their first tick without changing their economy.
 */
export function normalizeRivalStrategy(
  rival: RivalLab,
  state: SimState,
): RivalControllerState {
  const fallback = defaultStrategy(rival, state)
  const saved = rival.strategy
  if (!saved) return fallback
  return {
    ...fallback,
    ...saved,
    profileId: rival.archetype,
    beliefs: { ...fallback.beliefs, ...saved.beliefs },
    plan: [...(saved.plan ?? [])],
    memory: [...(saved.memory ?? [])].slice(-RIVAL_MEMORY_LIMIT),
    cooldowns: { ...(saved.cooldowns ?? {}) },
  }
}

function researchEffectUtility(node: ResearchNodeDef, goal: RivalGoalKind): number {
  const effects = node.effects
  let score =
    (effects.utilCap ?? 0) * 70 +
    (effects.servingEfficiency ?? 0) * 75 +
    (effects.trainEfficiency ?? 0) * 72 +
    (effects.capabilityBonus ?? 0) * 5 +
    (effects.dataFlywheel ?? 0) * 54 +
    (effects.safetyBonus ?? 0) * 3 +
    (effects.rlhfQuality ?? 0) * 3 +
    (effects.chipDiscount ?? 0) * 34 +
    (effects.talentAttract ?? 0) * 20 +
    (effects.trainingBreakthroughBias ?? 0) * 45

  if (effects.unlockFamily) score += 18
  if (effects.benchmarkBoost) {
    score += Object.values(effects.benchmarkBoost).reduce(
      (sum, value) => sum + Math.max(0, value ?? 0),
      0,
    ) * 1.8
  }
  if (goal === 'restore_service' || goal === 'improve_efficiency') {
    score += (effects.servingEfficiency ?? 0) * 115 + (effects.utilCap ?? 0) * 80
  }
  if (goal === 'ship_model') {
    score += (effects.trainEfficiency ?? 0) * 100 + (effects.capabilityBonus ?? 0) * 7
  }
  if (goal === 'survive') {
    score +=
      (effects.servingEfficiency ?? 0) * 90 +
      (effects.trainEfficiency ?? 0) * 55 +
      (effects.chipDiscount ?? 0) * 70
  }
  return Math.max(0.5, score)
}

function archetypeResearchMultiplier(rival: RivalLab, node: ResearchNodeDef): number {
  const id = node.id
  const trunk = node.trunk
  if (rival.archetype === 'efficiency') {
    if (trunk === 'inference' || trunk === 'optimize' || trunk === 'moe') return 1.9
  } else if (rival.archetype === 'multimodal') {
    if (trunk === 'multimodal' || id.startsWith('mm_') || trunk === 'data') return 1.9
  } else if (rival.archetype === 'safety') {
    if (trunk === 'alignment' || id.startsWith('align_') || trunk === 'data') return 1.85
  } else if (rival.archetype === 'open_weights') {
    if (trunk === 'optimize' || trunk === 'inference' || trunk === 'data') return 1.65
  } else if (trunk === 'dense' || trunk === 'hardware' || trunk === 'optimize') {
    return 1.65
  }
  return 1
}

/**
 * Score complete prerequisite paths instead of selecting the cheapest visible
 * node. The returned order is topological and can be handed directly to the
 * common research action.
 */
export function planRivalResearchPath(
  rival: RivalLab,
  strategy: RivalControllerState,
  worldSeed: number,
): string[] {
  const scheduled = [
    ...(rival.activeResearch ? [rival.activeResearch] : []),
    ...(rival.researchQueue ?? []),
  ]
  const staffResearchers = rival.staff?.researcher ?? 0
  if (staffResearchers < 1) return []

  // Product-focused labs finish their disclosed modality ladder before
  // wandering into generic marginal upgrades. Prerequisites still come from
  // the common planner and retain the same staff, PF-day, and cash gates.
  if (rival.archetype === 'multimodal' && scheduled.length === 0) {
    const milestone = ['mm_vision', 'mm_diff', 'mm_video', 'mm_omni', 'moe_basics']
      .find((nodeId) => !rival.researchUnlocked.includes(nodeId))
    if (milestone) {
      const path = planResearchPath(rival.researchUnlocked, scheduled, milestone)
      const first = path.nodeIds[0] ? getResearchNode(path.nodeIds[0]) : undefined
      if (!path.reason && first && staffResearchers >= minResearchersForNode(first.id)) {
        return path.nodeIds
      }
    }
  }

  const choices = RESEARCH_NODES.flatMap((node) => {
    if (rival.researchUnlocked.includes(node.id) || scheduled.includes(node.id)) return []
    const path = planResearchPath(rival.researchUnlocked, scheduled, node.id)
    if (path.reason || path.nodeIds.length === 0) return []
    const first = getResearchNode(path.nodeIds[0]!)
    const firstBlockedByStaff = staffResearchers < minResearchersForNode(first.id)
    if (firstBlockedByStaff) return []
    const pathCost = path.nodeIds.reduce(
      (sum, nodeId) => sum + getResearchNode(nodeId).costPfDays,
      0,
    )
    const directUtility = researchEffectUtility(node, strategy.goal)
    const optionValue = path.nodeIds.slice(0, -1).reduce(
      (sum, nodeId) => sum + researchEffectUtility(getResearchNode(nodeId), strategy.goal) * 0.25,
      0,
    )
    const quantUrgency =
      (strategy.goal === 'restore_service' || strategy.goal === 'improve_efficiency') &&
      (node.id === 'sys_quant' || node.id === 'sys_fp8')
        ? 24
        : 0
    const tie =
      (hashSeed(worldSeed, rival.id, strategy.decisionRevision, node.id, 'research-rank') % 1000) /
      1_000_000
    const score =
      ((directUtility + optionValue + quantUrgency) * archetypeResearchMultiplier(rival, node)) /
        Math.max(1, Math.sqrt(pathCost)) +
      tie
    return [{ nodeId: node.id, path: path.nodeIds, score }]
  })
  choices.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
  return choices[0]?.path ?? []
}

export function advanceRivalStrategy(
  rival: RivalLab,
  state: SimState,
): RivalControllerState {
  const prior = normalizeRivalStrategy(rival, state)
  if (prior.lastOperationalDay >= state.day) return prior

  const observationWeight = difficultyObservationWeight(state.config.difficulty)
  const observedFrontier = releasedPlayerCapability(state)
  const observedPrice = Math.max(0, state.player.pricing.apiPricePerMTok)
  const industryDemand = Math.max(0, state.lastMarket.industryDemandMTok ?? 0)
  const priorIndustryDemand = prior.cooldowns.lastIndustryDemand ?? industryDemand
  const observedDemandGrowth =
    priorIndustryDemand > 0
      ? Math.max(-0.5, Math.min(0.5, industryDemand / priorIndustryDemand - 1))
      : 0
  const priorShare = prior.cooldowns.lastMarketShare ?? rival.marketShare
  const realizedUtility = (rival.marketShare - priorShare) * 100
  const memory = prior.memory.map((record, index, records) =>
    index === records.length - 1 && record.result === 'planned' && record.day < state.day
      ? { ...record, result: 'applied' as const, realizedUtility }
      : record,
  )
  const beliefs = {
    ...prior.beliefs,
    observedDay: state.day,
    frontierCapability:
      prior.beliefs.frontierCapability * (1 - observationWeight) +
      observedFrontier * observationWeight,
    marketPricePerMTok:
      prior.beliefs.marketPricePerMTok * (1 - observationWeight) +
      observedPrice * observationWeight,
    demandGrowth:
      prior.beliefs.demandGrowth * (1 - observationWeight) +
      observedDemandGrowth * observationWeight,
  }
  const chosen = chooseGoal(rival, beliefs.frontierCapability)
  const strategicDue =
    state.day - prior.lastStrategicDay >= STRATEGIC_CADENCE_DAYS ||
    chosen.primary !== prior.goal ||
    prior.plan.length === 0
  const next: RivalControllerState = {
    ...prior,
    goal: chosen.primary,
    secondaryGoal: chosen.secondary,
    beliefs,
    memory,
    cooldowns: {
      ...prior.cooldowns,
      lastIndustryDemand: industryDemand,
      lastMarketShare: rival.marketShare,
      serviceHeadroomTarget: Math.max(
        0.12,
        Math.min(
          0.5,
          (prior.cooldowns.serviceHeadroomTarget ?? 0.2) +
            ((rival.lastUnserved ?? 0) - 0.05) * 0.08,
        ),
      ),
    },
    lastOperationalDay: state.day,
    lastTacticalDay:
      state.day - prior.lastTacticalDay >= TACTICAL_CADENCE_DAYS
        ? state.day
        : prior.lastTacticalDay,
    lastStrategicDay: strategicDue ? state.day : prior.lastStrategicDay,
    decisionRevision: strategicDue ? prior.decisionRevision + 1 : prior.decisionRevision,
  }
  if (strategicDue) {
    next.plan = planRivalResearchPath(rival, next, state.seed)
    next.memory = [
      ...memory,
      {
        day: state.day,
        actionKind: `goal:${chosen.primary}`,
        expectedUtility: 0,
        result: 'planned' as const,
      },
    ].slice(-RIVAL_MEMORY_LIMIT)
  }
  return next
}

export function allocationForRivalStrategy(
  base: Allocation,
  strategy: RivalControllerState,
): Allocation {
  let training = base.training
  let inference = base.inference
  let research = base.research
  if (strategy.goal === 'restore_service') inference += 0.18
  else if (strategy.goal === 'ship_model') training += 0.12
  else if (strategy.goal === 'unlock_research' || strategy.goal === 'improve_efficiency') {
    research += 0.12
  } else if (strategy.goal === 'survive') {
    inference += 0.08
    training = Math.max(0.08, training - 0.08)
  }
  const total = training + inference + research
  return {
    training: training / total,
    inference: inference / total,
    research: research / total,
  }
}

function supportsServePrecision(rival: RivalLab, precision: PlanServePrecision): boolean {
  const live = (rival.rackFleet ?? []).filter((install) => install.status === 'live' && install.count > 0)
  // Legacy abstract fleets predate hardware profiles and represent the same
  // broadly-compatible commercial accelerator generation as the starter lab.
  if (live.length === 0) return precision !== 'fp8' && precision !== 'nvfp4'
  return live.some((install) => {
    try {
      return resolveRackSku(install.skuId, rival.rackDesigns ?? []).accelerator
        ?.supportedServePrecisions.includes(precision) ?? false
    } catch {
      return false
    }
  })
}

export function rivalTrainingHardwareGeneration(rival: RivalLab): number {
  let generation = 0
  for (const install of rival.rackFleet ?? []) {
    if (install.status !== 'live' || install.count <= 0) continue
    try {
      generation = Math.max(
        generation,
        resolveRackSku(install.skuId, rival.rackDesigns ?? []).accelerator?.generation ?? 1,
      )
    } catch {
      // Imported or retired SKUs contribute no advanced-format capability.
    }
  }
  // Abstract starting fleets are the commercial H-class hardware used to
  // derive rival flops in createRivals. Unknown remote capacity remains gen 1.
  if (rival.flopsPf > 0 || rival.chips > 0) generation = Math.max(generation, 2)
  return Math.max(1, generation)
}

/** Pick only a recipe that passes the same research and hardware validator. */
export function chooseRivalTrainingNumerics(
  rival: RivalLab,
  family: RivalLab['models'][number]['family'],
): TrainingNumerics {
  const fp16 = DEFAULT_TRAINING_NUMERICS
  const bf16: TrainingNumerics = {
    computeFormat: 'bf16_mixed',
    nativeWeightFormat: 'float',
    recipeVersion: 1,
  }
  const fp8: TrainingNumerics = {
    computeFormat: 'fp8_hybrid',
    nativeWeightFormat: 'float',
    recipeVersion: 1,
  }
  const nvfp4: TrainingNumerics = {
    computeFormat: 'nvfp4',
    nativeWeightFormat: 'float',
    recipeVersion: 1,
  }
  const ternary: TrainingNumerics = {
    computeFormat: 'bf16_mixed',
    nativeWeightFormat: 'ternary_1_58',
    recipeVersion: 1,
  }
  const preferred =
    rival.archetype === 'efficiency'
      ? [ternary, nvfp4, fp8, bf16, fp16]
      : rival.archetype === 'open_weights'
        ? [ternary, fp8, bf16, fp16]
        : rival.archetype === 'hyperscale'
          ? [nvfp4, fp8, bf16, fp16]
          : rival.archetype === 'multimodal'
            ? [fp8, bf16, fp16]
            : [bf16, fp16]
  const hardwareGeneration = rivalTrainingHardwareGeneration(rival)
  return (
    preferred.find((numerics) =>
      validateTrainingNumerics({
        hardwareGeneration,
        numerics,
        researchUnlocked: rival.researchUnlocked,
        family,
      }).ok,
    ) ?? fp16
  )
}

/** Research and physical hardware both gate the rival's product precision. */
export function chooseRivalServePrecision(rival: RivalLab): PlanServePrecision {
  const pressure = Math.max(rival.lastUnserved ?? 0, rival.servicePain ?? 0)
  const costPressure = rival.cash < Math.max(5_000_000, (rival.dayRevenue ?? 0) * 45)
  const efficiencyBias = rival.archetype === 'efficiency' || rival.archetype === 'open_weights'
  if (
    rival.archetype !== 'safety' &&
    rival.researchUnlocked.includes('sys_fp8') &&
    supportsServePrecision(rival, 'int4') &&
    (pressure > 0.25 || (efficiencyBias && costPressure))
  ) {
    return 'int4'
  }
  if (
    rival.researchUnlocked.includes('sys_quant') &&
    supportsServePrecision(rival, 'int8') &&
    (pressure > 0.06 || efficiencyBias || costPressure)
  ) {
    return 'int8'
  }
  return 'fp16'
}
