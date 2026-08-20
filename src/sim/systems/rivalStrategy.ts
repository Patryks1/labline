import { getResearchNode, RESEARCH_NODES } from '../balance/research'
import type {
  Allocation,
  DataDomain,
  ModelBackbone,
  ModelFamily,
  PlanServePrecision,
  ResearchNodeDef,
  RivalArchetype,
  RivalCampusPlan,
  RivalControllerState,
  RivalGoalKind,
  RivalLab,
  SimState,
  TrainingNumerics,
} from '../types'
import { isLivePublicModel } from '../modelRelease'
import { createRng, hashSeed } from '../rng'
import { minResearchersForNode, planResearchPath } from './research'
import { resolveRackSku } from './racks'
import { ECONOMY } from '../balance/economy'
import { estimateTrainingEconomics } from '../balance/training'
import {
  expectedRivalTrainingRecipeKnobs,
  recipeOutcomeSignals,
  recipeVolumeTargetMTok,
} from '../balance/trainingRecipe'
import { scaleIntelligence } from '../balance/modelScaling'
import {
  DEFAULT_TRAINING_NUMERICS,
  estimateTrainingMemoryGb,
  validateTrainingNumerics,
} from '../balance/trainingPrecision'

const STRATEGIC_CADENCE_DAYS = 28
const TACTICAL_CADENCE_DAYS = 5
const RIVAL_MEMORY_LIMIT = 32

export const RIVAL_MULTIMODAL_RESEARCH_LADDER = [
  'mm_vision',
  'mm_diff',
  'mm_video',
  'mm_omni',
  'moe_basics',
] as const

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
      isLivePublicModel(model)
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
  if (rival.archetype === 'multimodal') {
    const milestone = RIVAL_MULTIMODAL_RESEARCH_LADDER
      .find(
        (nodeId) =>
          !rival.researchUnlocked.includes(nodeId) && !scheduled.includes(nodeId),
      )
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

// ────────────────────────────────────────────────────────────────────────────
// Scale ladder & infrastructure strategy
//
// Rivals plan model scale the way a lab would: evaluate a ladder of candidate
// sizes (plus MoE alternatives where the chosen topology is sparse) on expected
// capability gain, market value and SOTA catch-up, net of training cost,
// data-shortfall risk, time-to-market and the infrastructure the run requires.
// Infrastructure is planned before the campaign starts — firm power, then hall
// capacity, then racks — never after a failed train. Every capability, cost,
// memory and hosting number below reuses the shared balance formulas (or the
// same constants the shared market charges), so rival parity is preserved.
// ────────────────────────────────────────────────────────────────────────────

/** Parameter ladder evaluated for each new model generation. */
export const RIVAL_SCALE_LADDER_PARAMS_B: readonly number[] = [
  22, 34, 70, 110, 180, 235, 405, 700, 1100, 1800, 2500, 3500, 5000,
]

/** Campus plans are recomputed when older than this or the revision moved on. */
export const RIVAL_CAMPUS_PLAN_STALE_DAYS = 28

/** Training share assumed when sizing a campaign (matches the job-start allocation). */
export const RIVAL_CAMPAIGN_TRAINING_SHARE = 0.55

/** HBM / host RAM per rack_h100 — the SKU rivals actually bid on. */
const RIVAL_RACK_HBM_GB = 640
const RIVAL_RACK_RAM_GB = 512

/** Archetype risk posture for scale and infrastructure commitments. */
export interface RivalScaleStrategyProfile {
  /** Training setup cash ceiling as a fraction of liquid cash (25–35%). */
  maxSetupCashFrac: number
  /** Operating runway preserved after a campaign starts (90–180 days). */
  runwayFloorDays: number
  /** Campaign duration the fleet is sized for. */
  targetTrainDays: number
  riskTolerance: number
  /** Bias toward MoE candidates with small active-parameter counts. */
  moePreference: number
  /** Release-cadence bias; raises the time-to-market penalty weight. */
  cadencePreference: number
  /** Capability gap to the frontier treated as strategically dangerous. */
  sotaGapDanger: number
  /** Largest parameter multiple considered per generation. */
  maxLeapFactor: number
  /** Post-construction hosting-compute reserve target (25%). */
  hostingReserveFrac: number
  /** Post-construction power reserve target (20%). */
  powerReserveFrac: number
}

export function rivalScaleStrategyProfile(
  archetype: RivalArchetype,
): RivalScaleStrategyProfile {
  switch (archetype) {
    case 'hyperscale':
      return {
        maxSetupCashFrac: 0.35,
        runwayFloorDays: 90,
        targetTrainDays: 150,
        riskTolerance: 0.85,
        moePreference: 0.25,
        cadencePreference: 0.2,
        sotaGapDanger: 5,
        maxLeapFactor: 6,
        hostingReserveFrac: 0.25,
        powerReserveFrac: 0.2,
      }
    case 'open_weights':
      return {
        maxSetupCashFrac: 0.3,
        runwayFloorDays: 120,
        targetTrainDays: 90,
        riskTolerance: 0.55,
        moePreference: 0.35,
        cadencePreference: 0.9,
        sotaGapDanger: 9,
        maxLeapFactor: 3,
        hostingReserveFrac: 0.25,
        powerReserveFrac: 0.2,
      }
    case 'efficiency':
      return {
        maxSetupCashFrac: 0.25,
        runwayFloorDays: 180,
        targetTrainDays: 100,
        riskTolerance: 0.4,
        moePreference: 0.9,
        cadencePreference: 0.4,
        sotaGapDanger: 9,
        maxLeapFactor: 2.5,
        hostingReserveFrac: 0.25,
        powerReserveFrac: 0.2,
      }
    case 'multimodal':
      return {
        maxSetupCashFrac: 0.3,
        runwayFloorDays: 120,
        targetTrainDays: 120,
        riskTolerance: 0.5,
        moePreference: 0.3,
        cadencePreference: 0.5,
        sotaGapDanger: 8,
        maxLeapFactor: 3,
        hostingReserveFrac: 0.25,
        powerReserveFrac: 0.2,
      }
    case 'safety':
      return {
        maxSetupCashFrac: 0.25,
        runwayFloorDays: 180,
        targetTrainDays: 110,
        riskTolerance: 0.35,
        moePreference: 0.1,
        cadencePreference: 0.4,
        sotaGapDanger: 8,
        maxLeapFactor: 2.5,
        hostingReserveFrac: 0.25,
        powerReserveFrac: 0.2,
      }
  }
}

/** Shared-market unit costs resolved by the caller (real prices, no discounts). */
export interface RivalInfraUnitCosts {
  /** PF per accelerator rack the rival can actually buy (rack_h100 parity). */
  rackPf: number
  rackPrice: number
  /** Substation build cost per MW of interconnect. */
  interconnectCostPerMw: number
  /** Firm generation build cost per MW (gas peaker parity). */
  generationCostPerMw: number
  hallCash: { small: number; medium: number; large: number }
  hallRacks: { small: number; medium: number; large: number }
}

/** Everything the scale evaluator needs, precomputed from live sim state. */
export interface RivalScalePlanningContext {
  archetype: RivalArchetype
  researchUnlocked: readonly string[]
  currentParamsB: number
  currentActiveParamsB?: number
  currentCapability: number
  frontierCapability: number
  corpusMTok: number
  cash: number
  dailyOperatingBurn: number
  /** Train PF/day available under a campaign allocation on the current fleet. */
  expectedTrainPfPerDay: number
  /** Current effective fleet PF the campaign allocation runs on. */
  totalPf: number
  trainEfficiency: number
  researchMult: number
  numerics: TrainingNumerics
  activationCheckpointing: boolean
  /** Largest single placement-domain memory (training share already applied). */
  availableHbmGb: number
  availableSystemRamGb: number
  pue: number
  /** 0–1+ current inference demand vs capacity. */
  hostingUtilization: number
  marketShare: number
  inferenceAllocation: number
  /** normalizeQuality-scale data quality (0.25–1.4). */
  dataQuality: number
  mixWeights: Partial<Record<string, number>>
  modalityComputeMult: number
  isCatchUpChallenger: boolean
  /** Era/frontier ceiling in billions of parameters. */
  maxParamsB?: number
  /** Completed hall bays and rack bays already filled. */
  rackCapacityBays: number
  racksUsed: number
  /** Completed power supply: interconnect + owned generation (MW). */
  mwSupplyCapacity: number
  mwDemand: number
  unitCosts: RivalInfraUnitCosts
}

export interface RivalScaleCandidate {
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  backbone: ModelBackbone
  label: string
  expectedCapability: number
  expectedCapabilityGain: number
  expectedMarketValue: number
  sotaCatchUpValue: number
  trainingPfDays: number
  minCalendarDays: number
  estimatedDurationDays: number
  upfrontCash: number
  cashBurnPerDay: number
  totalCampaignCash: number
  dataCoverageEst: number
  dataShortfallRisk: number
  timeToMarketPenalty: number
  infrastructureCost: number
  requiredHbmGb: number
  requiredSystemRamGb: number
  requiredMw: number
  requiredFleetPf: number
  /** Additional racks the campaign + post-release hosting require. */
  racksNeeded: number
  hostingHeadroomAfterRelease: number
  memoryFitsNow: boolean
  utility: number
  affordable: boolean
  fitsRiskStrategy: boolean
}

/** Candidate sizes: a data-matched step plus every ladder rung above current. */
function rivalCandidateSizes(ctx: RivalScalePlanningContext): number[] {
  const comfortable = Math.max(0.05, ctx.corpusMTok / 1000)
  const ceiling =
    ctx.maxParamsB ?? RIVAL_SCALE_LADDER_PARAMS_B[RIVAL_SCALE_LADDER_PARAMS_B.length - 1]!
  const dataMatched = Math.min(
    Math.min(RIVAL_SCALE_LADDER_PARAMS_B[0]!, ceiling),
    Math.max(ctx.currentParamsB * 1.25, comfortable * 0.9),
  )
  const sizes = new Set<number>()
  if (
    dataMatched > Math.max(0.05, ctx.currentParamsB) * 1.02 &&
    dataMatched <= ceiling * 1.001
  ) {
    sizes.add(Math.round(dataMatched * 100) / 100)
  }
  for (const rung of RIVAL_SCALE_LADDER_PARAMS_B) {
    if (rung > Math.max(0.05, ctx.currentParamsB) * 1.02 && rung <= ceiling * 1.001) {
      sizes.add(rung)
    }
  }
  return [...sizes].sort((a, b) => a - b)
}

function evaluateRivalCandidate(
  ctx: RivalScalePlanningContext,
  profile: RivalScaleStrategyProfile,
  topology: { family: ModelFamily; backbone: ModelBackbone },
  paramsB: number,
  backbone: ModelBackbone,
  activeParamsB: number | undefined,
  label: string,
): RivalScaleCandidate {
  const family = topology.family
  const recipeKnobs = expectedRivalTrainingRecipeKnobs(ctx.archetype, {
    isCatchUp: ctx.isCatchUpChallenger,
  })
  const recipeTarget = recipeVolumeTargetMTok({
    paramsB,
    family,
    backbone,
    activeParamsB,
    trainShare: recipeKnobs.trainShare,
    usableTotal: ctx.corpusMTok,
    volumePolicy: recipeKnobs.volumePolicy,
  })
  const recipeAim = recipeVolumeTargetMTok({
    paramsB,
    family,
    backbone,
    activeParamsB,
    trainShare: recipeKnobs.trainShare,
    usableTotal: Number.POSITIVE_INFINITY,
    volumePolicy:
      recipeKnobs.volumePolicy === "all" ? "strong" : recipeKnobs.volumePolicy,
  })
  const recipeSignals = recipeOutcomeSignals({
    totalMTok: recipeTarget,
    paramsB,
    family,
    backbone,
    activeParamsB,
    postTrainShare: recipeKnobs.postTrainShare,
    trainShare: recipeKnobs.trainShare,
  })
  const coverageEst = Math.max(
    0.05,
    Math.min(6, recipeSignals.capabilityVolumeRatio),
  )
  // Same research-mult penalty buildScaledModel applies without moe_routing.
  const researchMult =
    ctx.researchMult *
    ((backbone === 'moe' || family === 'moe') && !ctx.researchUnlocked.includes('moe_routing')
      ? 0.55
      : 1)
  let overtrainCapBonus = 0
  for (const id of ctx.researchUnlocked) {
    overtrainCapBonus += RESEARCH_NODES.find((node) => node.id === id)?.effects.overtrainCapBonus ?? 0
  }
  // Same scaleIntelligence path the finalize step uses (postTrain 'none' → 0.1).
  const scale = scaleIntelligence({
    paramsB,
    activeParamsB,
    family,
    backbone,
    dataCoverage: coverageEst,
    dataQuality: ctx.dataQuality,
    mixWeights: ctx.mixWeights,
    researchMult,
    trainComplete: 1,
    postTrainStrength: 0.1,
    reasoningEnabled: ctx.researchUnlocked.includes('align_process'),
    overtrainCapBonus,
  })
  const expectedCapability = scale.capability
  const expectedCapabilityGain = Math.max(0, expectedCapability - ctx.currentCapability)
  const expectedMarketValue =
    expectedCapabilityGain * (0.35 + Math.max(0, ctx.marketShare) * 2.2)
  const capabilityGap = Math.max(0, ctx.frontierCapability - ctx.currentCapability)
  const sotaCatchUpValue =
    capabilityGap > 0.5
      ? Math.min(1, expectedCapabilityGain / capabilityGap) *
        Math.min(3, capabilityGap * 0.25) *
        (ctx.isCatchUpChallenger ? 1.6 : 1)
      : expectedCapabilityGain * 0.1

  const usableEst = recipeTarget
  const economics = estimateTrainingEconomics({
    paramsB,
    activeParamsB,
    family,
    backbone,
    trainEfficiency: ctx.trainEfficiency,
    trainingTokensMTok:
      usableEst * (1 - recipeKnobs.postTrainShare) * recipeKnobs.trainShare,
    verificationTokensMTok:
      usableEst * (1 - recipeKnobs.postTrainShare) * (1 - recipeKnobs.trainShare),
    modalityComputeMult: ctx.modalityComputeMult,
    dataCost: 0,
    numerics: ctx.numerics,
  })
  const estimatedDurationDays = Math.max(
    economics.minCalendarDays,
    economics.targetPfDays / Math.max(0.02, ctx.expectedTrainPfPerDay),
  )
  const memory = estimateTrainingMemoryGb({
    paramsB,
    activeParamsB,
    family,
    numerics: ctx.numerics,
    activationCheckpointing: ctx.activationCheckpointing,
  })
  const memoryFitsNow =
    memory.requiredHbmGb <= ctx.availableHbmGb + 1e-9 &&
    memory.requiredSystemRamGb <= ctx.availableSystemRamGb + 1e-9

  // Fleet PF that would finish the campaign inside the strategy duration target.
  const requiredFleetPf = Math.max(
    ctx.totalPf,
    (economics.targetPfDays / profile.targetTrainDays) *
      (ctx.totalPf / Math.max(0.02, ctx.expectedTrainPfPerDay)),
  )
  // Shared power proxy (same ECONOMY.mwPerPfProxy as computeMarket.pfToMw) × PUE.
  const requiredMw =
    requiredFleetPf * (ECONOMY.mwPerPfProxy ?? 0.011) * Math.max(1.05, ctx.pue)
  // Hosting equation parity: same host-need proxy as rivalHostingBalance.
  const hostNeedPf =
    (8 + Math.max(0, ctx.marketShare) * 120) *
    Math.pow(Math.max(0.5, activeParamsB ?? paramsB), 0.45) *
    (0.55 + ctx.inferenceAllocation * 0.9)
  const hostingHeadroomAfterRelease =
    (ctx.totalPf - hostNeedPf) / Math.max(1e-9, ctx.totalPf)

  // One fleet must satisfy PF, HBM and RAM simultaneously → max, not sum.
  const campaignRacks = Math.ceil(
    Math.max(0, requiredFleetPf - ctx.totalPf) / ctx.unitCosts.rackPf,
  )
  const hbmRacks = Math.ceil(
    Math.max(0, memory.requiredHbmGb - ctx.availableHbmGb) / RIVAL_RACK_HBM_GB,
  )
  const ramRacks = Math.ceil(
    Math.max(0, memory.requiredSystemRamGb - ctx.availableSystemRamGb) / RIVAL_RACK_RAM_GB,
  )
  const hostingRacks = Math.ceil(
    Math.max(0, hostNeedPf * (1 + profile.hostingReserveFrac) - ctx.totalPf) /
      ctx.unitCosts.rackPf,
  )
  const racksNeeded = Math.max(campaignRacks, hbmRacks, ramRacks, hostingRacks)
  const rackCost = racksNeeded * ctx.unitCosts.rackPrice
  const missingMw = Math.max(0, requiredMw - ctx.mwSupplyCapacity)
  const powerCost =
    missingMw *
    (ctx.unitCosts.interconnectCostPerMw + ctx.unitCosts.generationCostPerMw * 0.6)
  // Physical layouts, not historical bay ratings, admit rack compute. Rival
  // expansion still budgets a hall when it needs new physical rack footprint,
  // but never treats a numeric shell quota as free/blocked space.
  const hallShortfallBays = Math.max(0, racksNeeded)
  const hallSize =
    hallShortfallBays <= 0
      ? null
      : hallShortfallBays <= ctx.unitCosts.hallRacks.small * 0.75
        ? ('small' as const)
        : hallShortfallBays <= ctx.unitCosts.hallRacks.medium * 0.75
          ? ('medium' as const)
          : ('large' as const)
  const infrastructureCost =
    rackCost + powerCost + (hallSize ? ctx.unitCosts.hallCash[hallSize] : 0)

  const totalCampaignCash =
    economics.upfrontCash + economics.cashBurnPerDay * estimatedDurationDays
  const cashBasis = Math.max(1_000_000, ctx.cash)
  const dataShortfallRisk = Math.pow(
    Math.max(0, 1 - Math.min(1, ctx.corpusMTok / Math.max(1, recipeAim))),
    1.5,
  )
  const timeToMarketPenalty =
    (estimatedDurationDays / profile.targetTrainDays) * (0.5 + profile.cadencePreference)
  const moeBonus = backbone === 'moe' ? profile.moePreference * 0.8 : 0
  const utility =
    expectedCapabilityGain +
    expectedMarketValue * 0.6 +
    sotaCatchUpValue * 1.2 +
    moeBonus -
    (totalCampaignCash / cashBasis) * 6 -
    dataShortfallRisk * (5 * (1.15 - profile.riskTolerance)) -
    timeToMarketPenalty * 1.6 -
    (infrastructureCost / cashBasis) * 4

  const affordable =
    economics.upfrontCash <= profile.maxSetupCashFrac * ctx.cash + 1e-9 &&
    (ctx.cash - economics.upfrontCash) /
      Math.max(1, ctx.dailyOperatingBurn + economics.cashBurnPerDay) >=
      profile.runwayFloorDays
  const leapCap = profile.maxLeapFactor * (ctx.isCatchUpChallenger ? 1.5 : 1)
  const withinLeap =
    paramsB <= Math.max(1.25, Math.max(0.05, ctx.currentParamsB) * leapCap) * 1.001
  const withinRisk = dataShortfallRisk <= 0.25 + profile.riskTolerance * 0.65 + 1e-9

  return {
    paramsB,
    activeParamsB,
    family,
    backbone,
    label,
    expectedCapability,
    expectedCapabilityGain,
    expectedMarketValue,
    sotaCatchUpValue,
    trainingPfDays: economics.targetPfDays,
    minCalendarDays: economics.minCalendarDays,
    estimatedDurationDays,
    upfrontCash: economics.upfrontCash,
    cashBurnPerDay: economics.cashBurnPerDay,
    totalCampaignCash,
    dataCoverageEst: coverageEst,
    dataShortfallRisk,
    timeToMarketPenalty,
    infrastructureCost,
    requiredHbmGb: memory.requiredHbmGb,
    requiredSystemRamGb: memory.requiredSystemRamGb,
    requiredMw,
    requiredFleetPf,
    racksNeeded,
    hostingHeadroomAfterRelease,
    memoryFitsNow,
    utility,
    affordable,
    fitsRiskStrategy: withinLeap && withinRisk,
  }
}

export type RivalScaleHoldReason = 'no_positive_utility' | 'memory' | 'budget' | null

export interface RivalScaleDecision {
  candidates: RivalScaleCandidate[]
  /** Largest positive-utility candidate that may start now (memory fits). */
  selected: RivalScaleCandidate | null
  /** Largest positive-utility candidate fitting budget/risk — the build target. */
  planned: RivalScaleCandidate | null
  heldReason: RivalScaleHoldReason
}

/**
 * Evaluate the ladder and select the largest positive-utility candidate that
 * fits the rival's risk strategy. `planned` ignores the current-memory gate so
 * infrastructure can be built toward it; `selected` is what may start today.
 */
export function chooseRivalScaleCandidate(
  ctx: RivalScalePlanningContext,
  topology: { family: ModelFamily; backbone: ModelBackbone },
): RivalScaleDecision {
  const profile = rivalScaleStrategyProfile(ctx.archetype)
  const candidates: RivalScaleCandidate[] = []
  for (const paramsB of rivalCandidateSizes(ctx)) {
    if (topology.backbone === 'moe') {
      const ratio = ctx.archetype === 'efficiency' ? 0.08 : 0.12
      candidates.push(
        evaluateRivalCandidate(
          ctx,
          profile,
          topology,
          paramsB,
          'moe',
          Math.max(0.1, paramsB * ratio),
          `${paramsB}B MoE`,
        ),
      )
    } else {
      candidates.push(
        evaluateRivalCandidate(
          ctx,
          profile,
          topology,
          paramsB,
          'dense',
          undefined,
          `${paramsB}B dense`,
        ),
      )
    }
  }
  const viable = (candidate: RivalScaleCandidate) =>
    candidate.utility > 0 && candidate.affordable && candidate.fitsRiskStrategy
  const bySizeDesc = (a: RivalScaleCandidate, b: RivalScaleCandidate) =>
    b.paramsB - a.paramsB || b.utility - a.utility
  const planned = candidates.filter(viable).sort(bySizeDesc)[0] ?? null
  const selected = candidates.filter((c) => viable(c) && c.memoryFitsNow).sort(bySizeDesc)[0] ?? null
  const heldReason: RivalScaleHoldReason = selected
    ? null
    : planned
      ? 'memory'
      : candidates.some((c) => c.utility > 0 && c.fitsRiskStrategy)
        ? 'budget'
        : 'no_positive_utility'
  return { candidates, selected, planned, heldReason }
}

export type RivalExpansionTrigger =
  | 'hosting_utilization'
  | 'training_duration'
  | 'memory_fit'
  | 'power_headroom'
  | 'sota_gap'

/** Pre-training infrastructure projection for one candidate (spec 6.2). */
export interface RivalInfrastructureProjection {
  paramsB: number
  activeParamsB?: number
  family: ModelFamily
  backbone: ModelBackbone
  trainingPfDays: number
  estimatedDurationDays: number
  requiredHbmGb: number
  requiredSystemRamGb: number
  requiredMw: number
  requiredFleetPf: number
  projectedRackDemand: number
  /** Fraction of fleet PF left for hosting after release (target ≥ 25%). */
  hostingHeadroomAfterRelease: number
  dataRequiredMTok: number
  dataRequiredByDomain: Partial<Record<DataDomain, number>>
  memoryFitsNow: boolean
  /** Current (supply − demand) / supply before any new build. */
  powerHeadroomFrac: number
  hostingUtilization: number
  triggers: RivalExpansionTrigger[]
}

export function projectRivalTrainingInfrastructure(
  ctx: RivalScalePlanningContext,
  candidate: RivalScaleCandidate,
): RivalInfrastructureProjection {
  const profile = rivalScaleStrategyProfile(ctx.archetype)
  const recipeKnobs = expectedRivalTrainingRecipeKnobs(ctx.archetype, {
    isCatchUp: ctx.isCatchUpChallenger,
  })
  const dataRequiredMTok = recipeVolumeTargetMTok({
    paramsB: candidate.paramsB,
    family: candidate.family,
    trainShare: recipeKnobs.trainShare,
    usableTotal: Number.POSITIVE_INFINITY,
    volumePolicy:
      recipeKnobs.volumePolicy === "all" ? "strong" : recipeKnobs.volumePolicy,
  })
  const dataRequiredByDomain: Partial<Record<DataDomain, number>> = {}
  let weightTotal = 0
  for (const value of Object.values(ctx.mixWeights)) weightTotal += Math.max(0, value ?? 0)
  if (weightTotal > 0) {
    for (const [domain, value] of Object.entries(ctx.mixWeights)) {
      dataRequiredByDomain[domain as DataDomain] =
        (Math.max(0, value ?? 0) / weightTotal) * dataRequiredMTok
    }
  }
  const powerHeadroomFrac =
    ctx.mwSupplyCapacity > 1e-9
      ? (ctx.mwSupplyCapacity - ctx.mwDemand) / ctx.mwSupplyCapacity
      : ctx.mwDemand > 1e-9
        ? 0
        : 1
  const triggers: RivalExpansionTrigger[] = []
  if (
    ctx.hostingUtilization > 0.75 ||
    candidate.hostingHeadroomAfterRelease < profile.hostingReserveFrac
  ) {
    triggers.push('hosting_utilization')
  }
  if (candidate.estimatedDurationDays > profile.targetTrainDays) {
    triggers.push('training_duration')
  }
  if (!candidate.memoryFitsNow) triggers.push('memory_fit')
  if (
    powerHeadroomFrac < profile.powerReserveFrac ||
    candidate.requiredMw > ctx.mwSupplyCapacity * (1 - profile.powerReserveFrac)
  ) {
    triggers.push('power_headroom')
  }
  if (ctx.frontierCapability - ctx.currentCapability >= profile.sotaGapDanger) {
    triggers.push('sota_gap')
  }
  return {
    paramsB: candidate.paramsB,
    activeParamsB: candidate.activeParamsB,
    family: candidate.family,
    backbone: candidate.backbone,
    trainingPfDays: candidate.trainingPfDays,
    estimatedDurationDays: candidate.estimatedDurationDays,
    requiredHbmGb: candidate.requiredHbmGb,
    requiredSystemRamGb: candidate.requiredSystemRamGb,
    requiredMw: candidate.requiredMw,
    requiredFleetPf: candidate.requiredFleetPf,
    projectedRackDemand: ctx.racksUsed + candidate.racksNeeded,
    hostingHeadroomAfterRelease: candidate.hostingHeadroomAfterRelease,
    dataRequiredMTok,
    dataRequiredByDomain,
    memoryFitsNow: candidate.memoryFitsNow,
    powerHeadroomFrac,
    hostingUtilization: ctx.hostingUtilization,
    triggers,
  }
}

/** Hall size for projected three-year rack demand (usable = 75% of bays). */
export function chooseRivalDcSize(
  rackDemandBays: number,
  archetype: RivalArchetype,
  existingHalls = 0,
): 'dc' | 'dc_m' | 'dc_l' {
  // First site is always a small edge hall so rivals climb the same ladder as the player.
  if (existingHalls <= 0) return 'dc'
  // BUILD_DEFS bay counts: dc 96, dc_m 288, dc_l 960.
  let size: 'dc' | 'dc_m' | 'dc_l' =
    rackDemandBays <= 96 * 0.75 ? 'dc' : rackDemandBays <= 288 * 0.75 ? 'dc_m' : 'dc_l'
  // Hyperscalers build one tier ahead once demand passes 55% of the tier.
  if (archetype === 'hyperscale' && size !== 'dc_l') {
    const tierBays = size === 'dc' ? 96 : 288
    if (rackDemandBays > tierBays * 0.55) size = size === 'dc' ? 'dc_m' : 'dc_l'
  }
  if (existingHalls < 2 && size === 'dc_l') size = 'dc_m'
  return size
}

/** Serialize the planned model + projection into the persisted campus plan. */
export function campusPlanFromProjection(input: {
  day: number
  decisionRevision: number
  archetype: RivalArchetype
  projection: RivalInfrastructureProjection
}): RivalCampusPlan {
  return {
    createdDay: input.day,
    decisionRevision: input.decisionRevision,
    targetParamsB: input.projection.paramsB,
    targetActiveParamsB: input.projection.activeParamsB,
    targetFamily: input.projection.family,
    targetBackbone: input.projection.backbone,
    dcSize: chooseRivalDcSize(input.projection.projectedRackDemand, input.archetype),
    projectedRackDemand: input.projection.projectedRackDemand,
    projectedMwDemand: input.projection.requiredMw,
    projectedHbmGb: input.projection.requiredHbmGb,
    projectedSystemRamGb: input.projection.requiredSystemRamGb,
    projectedDataMTok: input.projection.dataRequiredMTok,
    triggers: [...input.projection.triggers],
  }
}

export function rivalCampusPlanStale(
  plan: RivalCampusPlan | undefined,
  day: number,
  decisionRevision: number,
): boolean {
  return (
    !plan ||
    day - plan.createdDay >= RIVAL_CAMPUS_PLAN_STALE_DAYS ||
    plan.decisionRevision !== decisionRevision
  )
}

/**
 * Daily cash the lab must be able to cover while training and building.
 * Finance totals already blend wages/marketing, so take the larger view.
 */
export function rivalDailyOperatingBurn(
  rival: Pick<
    RivalLab,
    'wagesPerDay' | 'marketingSpendPerDay' | 'trainingJob' | 'finance'
  >,
  facilityOpexPerDay = 0,
): number {
  const wages = Math.max(0, rival.wagesPerDay ?? 0)
  const marketing = Math.max(0, rival.marketingSpendPerDay ?? 0)
  const training = Math.max(0, rival.trainingJob?.cashBurnPerDay ?? 0)
  const financeOut = Math.max(0, rival.finance?.dayTotalOut ?? 0)
  return Math.max(
    50_000,
    Math.max(wages + marketing + training + facilityOpexPerDay, financeOut),
  )
}

export type RivalCampusProjectKind =
  | 'hq'
  | 'substation'
  | 'solar'
  | 'gas'
  | 'nuclear'
  | 'dc'
  | 'dc_m'
  | 'dc_l'

export interface RivalCampusProjectCosts {
  hq: number
  substation: number
  solar: number
  gas: number
  nuclear: number
  dc: number
  dc_m: number
  dc_l: number
}

export interface RivalCampusDecisionInput {
  archetype: RivalArchetype
  hasHq: boolean
  /** Completed + under-construction hall bays. */
  rackCapacityBays: number
  racksUsed: number
  /** Completed + under-construction interconnect (substations/batteries). */
  mwInterconnect: number
  /** Completed + under-construction owned generation. */
  mwGeneration: number
  mwDemand: number
  hostingUtilization: number
  sotaGapDangerous: boolean
  projection: RivalInfrastructureProjection | null
  cash: number
  dailyOperatingBurn: number
  costs: RivalCampusProjectCosts
  day: number
  /** Seeded 0–1 draw choosing between solar and gas. */
  generationPick: number
}

export interface RivalCampusProject {
  kind: RivalCampusProjectKind
  reason: RivalExpansionTrigger | 'hq'
}

/**
 * Coordinated campus build queue, evaluated lazily each capex tick:
 * grid/firm power → data hall → (racks clear the shared market separately) →
 * the training campaign. Deterministic given lab state; reserves after
 * construction are 25% hosting compute and 20% power, and every project must
 * preserve the archetype's cash-runway floor.
 */
export function chooseRivalCampusProject(
  input: RivalCampusDecisionInput,
): RivalCampusProject | null {
  const profile = rivalScaleStrategyProfile(input.archetype)
  const runwayOk = (cost: number) =>
    input.cash - cost >= profile.runwayFloorDays * Math.max(1, input.dailyOperatingBurn)

  if (!input.hasHq) {
    return runwayOk(input.costs.hq) ? { kind: 'hq', reason: 'hq' } : null
  }

  // 1. Firm power first — interconnect or generation ahead of the hall load.
  const mwSupply = input.mwInterconnect + input.mwGeneration
  const requiredMw = Math.max(
    input.mwDemand / (1 - profile.powerReserveFrac),
    input.projection?.requiredMw ?? 0,
  )
  if (mwSupply < requiredMw - 1e-9) {
    const gridImportNeed = requiredMw - input.mwGeneration
    if (
      input.mwInterconnect < gridImportNeed - 1e-9 &&
      runwayOk(input.costs.substation)
    ) {
      return { kind: 'substation', reason: 'power_headroom' }
    }
    const genDeficit = requiredMw - mwSupply
    if (
      input.archetype === 'hyperscale' &&
      input.day >= 70 &&
      genDeficit > 80 &&
      runwayOk(input.costs.nuclear * 1.5)
    ) {
      return { kind: 'nuclear', reason: 'power_headroom' }
    }
    const kind = input.generationPick < 0.55 ? 'solar' : 'gas'
    return runwayOk(input.costs[kind]) ? { kind, reason: 'power_headroom' } : null
  }

  // 2. Add physical hall floor area when projected hardware outgrows the
  // existing placed footprint. rackCapacityBays is legacy planning metadata,
  // never an admission limit for already placed operational racks.
  const rackDemand = Math.max(
    input.racksUsed,
    input.projection?.projectedRackDemand ?? 0,
    input.hostingUtilization > 0.75 ? input.racksUsed * 1.5 + 8 : 0,
    input.sotaGapDangerous && input.rackCapacityBays === 0 ? 24 : 0,
  )
  const additionalPhysicalFootprint = Math.max(0, rackDemand - input.racksUsed)
  if (additionalPhysicalFootprint > 1e-9) {
    const existingHalls = Math.max(
      input.rackCapacityBays > 0 ? 1 : 0,
      Math.round(input.rackCapacityBays / 96),
    )
    const size = chooseRivalDcSize(
      additionalPhysicalFootprint,
      input.archetype,
      existingHalls,
    )
    if (runwayOk(input.costs[size])) {
      return {
        kind: size,
        reason: input.projection?.triggers[0] ?? 'hosting_utilization',
      }
    }
  }
  return null
}
