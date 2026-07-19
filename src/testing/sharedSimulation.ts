import type {
  Allocation,
  BuildableKind,
  MapTile,
  Model,
  ResearchEffects,
  RivalLab,
  SimState,
  TileOwner,
} from '../sim/types'
import {
  abstractPools,
  labInferCapacityMTok,
  labInferCapacityPf,
  type AbstractLabCompute,
  type LabPfPools,
} from '../sim/systems/labCompute'
import { applyResearchEffectsToLab } from '../sim/systems/research'
import { createRivals, rivalInferCapacityPfShared } from '../sim/systems/rivals'
import { gridScarcity, resolvePlayerPowerMw } from '../sim/systems/map'

export interface DifferentialLabState extends AbstractLabCompute {
  servingEfficiency: number
  dataGenResearchShare: number
  brandTrust: number
  dataQuality: number
  trainEfficiency: number
  pue: number
}

export type SharedLabAction =
  | { type: 'add-flops'; pf: number }
  | { type: 'set-allocation'; allocation: Allocation }
  | { type: 'set-util-cap'; utilCap: number }
  | { type: 'set-serving-efficiency'; servingEfficiency: number }
  | { type: 'set-data-gen-share'; share: number }
  | { type: 'apply-research'; effects: ResearchEffects }

export interface SharedLabObservation {
  step: number
  action: SharedLabAction
  playerPools: LabPfPools
  rivalPools: LabPfPools
  playerInferPf: number
  rivalInferPf: number
  playerInferMTok: number
  rivalInferMTok: number
  player: DifferentialLabState
  rival: RivalLab
}

export interface NumericInvariantFailure {
  step: number
  metric: string
  player: number
  rival: number
  difference: number
}

export interface SharedLabDifferentialResult {
  observations: SharedLabObservation[]
  failures: NumericInvariantFailure[]
}

export const DEFAULT_SHARED_LAB_ACTIONS: readonly SharedLabAction[] = [
  { type: 'add-flops', pf: 125 },
  { type: 'set-allocation', allocation: { training: 0.45, inference: 0.4, research: 0.15 } },
  { type: 'set-util-cap', utilCap: 0.63 },
  { type: 'set-serving-efficiency', servingEfficiency: 0.92 },
  { type: 'set-data-gen-share', share: 0.2 },
  {
    type: 'apply-research',
    effects: {
      utilCap: 0.08,
      servingEfficiency: 0.12,
      trainEfficiency: 0.07,
      energyPue: -0.06,
      dataFlywheel: 0.2,
      safetyBonus: 4,
    },
  },
]

const DEFAULT_MODEL: Pick<
  Model,
  'paramsB' | 'activeParamsB' | 'family' | 'inferCostMult' | 'tokPerSecMult'
> = {
  paramsB: 7,
  activeParamsB: 7,
  family: 'dense',
  inferCostMult: 1,
  tokPerSecMult: 1,
}

function createInitialLabState(): DifferentialLabState {
  return {
    flopsPf: 75,
    utilCap: 0.48,
    allocation: { training: 0.4, inference: 0.35, research: 0.25 },
    servingEfficiency: 0.55,
    dataGenResearchShare: 0,
    brandTrust: 50,
    dataQuality: 1,
    trainEfficiency: 0.5,
    pue: 1.35,
  }
}

function rivalFromLab(lab: DifferentialLabState, seed: number): RivalLab {
  const rival = createRivals(seed, 1)[0]
  if (!rival) throw new Error('createRivals did not create a differential rival')
  return {
    ...rival,
    flopsPf: lab.flopsPf,
    utilCap: lab.utilCap,
    allocation: { ...lab.allocation },
    servingEfficiency: lab.servingEfficiency ?? 1,
    brandTrust: lab.brandTrust,
    dataQuality: lab.dataQuality,
    data: rival.data
      ? { ...rival.data, dataGenResearchShare: lab.dataGenResearchShare ?? 0 }
      : rival.data,
  }
}

function applyLabAction(lab: DifferentialLabState, action: SharedLabAction): DifferentialLabState {
  switch (action.type) {
    case 'add-flops':
      return { ...lab, flopsPf: Math.max(0, lab.flopsPf + action.pf) }
    case 'set-allocation':
      return { ...lab, allocation: { ...action.allocation } }
    case 'set-util-cap':
      return { ...lab, utilCap: action.utilCap }
    case 'set-serving-efficiency':
      return { ...lab, servingEfficiency: action.servingEfficiency }
    case 'set-data-gen-share':
      return { ...lab, dataGenResearchShare: action.share }
    case 'apply-research':
      return applyResearchEffectsToLab(lab, action.effects)
  }
}

function applyRivalAction(rival: RivalLab, action: SharedLabAction): RivalLab {
  switch (action.type) {
    case 'add-flops':
      return { ...rival, flopsPf: Math.max(0, rival.flopsPf + action.pf) }
    case 'set-allocation':
      return { ...rival, allocation: { ...action.allocation } }
    case 'set-util-cap':
      return { ...rival, utilCap: action.utilCap }
    case 'set-serving-efficiency':
      return { ...rival, servingEfficiency: action.servingEfficiency }
    case 'set-data-gen-share':
      return rival.data
        ? { ...rival, data: { ...rival.data, dataGenResearchShare: action.share } }
        : rival
    case 'apply-research':
      return applyResearchEffectsToLab(rival, action.effects)
  }
}

function rivalAsLab(rival: RivalLab): AbstractLabCompute {
  return {
    flopsPf: rival.flopsPf,
    utilCap: rival.utilCap,
    allocation: rival.allocation,
    servingEfficiency: rival.servingEfficiency,
    dataGenResearchShare: rival.data?.dataGenResearchShare,
  }
}

function closeEnough(a: number, b: number, tolerance: number) {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))
}

function compareObservation(
  observation: SharedLabObservation,
  tolerance: number,
): NumericInvariantFailure[] {
  const pairs: [string, number, number][] = [
    ['pools.training', observation.playerPools.training, observation.rivalPools.training],
    ['pools.inference', observation.playerPools.inference, observation.rivalPools.inference],
    ['pools.research', observation.playerPools.research, observation.rivalPools.research],
    ['inferPf', observation.playerInferPf, observation.rivalInferPf],
    ['inferMTok', observation.playerInferMTok, observation.rivalInferMTok],
  ]
  return pairs.flatMap(([metric, player, rival]) =>
    closeEnough(player, rival, tolerance)
      ? []
      : [
          {
            step: observation.step,
            metric,
            player,
            rival,
            difference: player - rival,
          },
        ],
  )
}

/**
 * Applies identical actions to player-shaped and RivalLab-shaped state and
 * observes both exclusively through the current shared simulation APIs.
 */
export function runSharedLabDifferential(
  actions: readonly SharedLabAction[] = DEFAULT_SHARED_LAB_ACTIONS,
  options: {
    initial?: DifferentialLabState
    model?: typeof DEFAULT_MODEL
    seed?: number
    tolerance?: number
  } = {},
): SharedLabDifferentialResult {
  let player = options.initial ? { ...options.initial } : createInitialLabState()
  let rival = rivalFromLab(player, options.seed ?? 10_901)
  const model = options.model ?? DEFAULT_MODEL
  const tolerance = options.tolerance ?? 1e-10
  const observations: SharedLabObservation[] = []
  const failures: NumericInvariantFailure[] = []
  for (let step = 0; step < actions.length; step++) {
    const action = actions[step]!
    player = applyLabAction(player, action)
    rival = applyRivalAction(rival, action)
    const rivalLab = rivalAsLab(rival)
    const observation: SharedLabObservation = {
      step,
      action,
      playerPools: abstractPools(player),
      rivalPools: abstractPools(rivalLab),
      playerInferPf: labInferCapacityPf(player),
      // This wrapper is the production rival call path and must remain shared.
      rivalInferPf: rivalInferCapacityPfShared(rival),
      playerInferMTok: labInferCapacityMTok(player, model),
      rivalInferMTok: labInferCapacityMTok(rivalLab, model),
      player,
      rival,
    }
    observations.push(observation)
    failures.push(...compareObservation(observation, tolerance))
  }
  return { observations, failures }
}

export function assertSharedLabInvariants(result: SharedLabDifferentialResult) {
  if (result.failures.length === 0) return
  const detail = result.failures
    .map(
      (failure) =>
        `step ${failure.step} ${failure.metric}: player=${failure.player}, rival=${failure.rival}`,
    )
    .join('\n')
  throw new Error(`Player/rival shared simulation diverged:\n${detail}`)
}

export type FacilitySequenceAction =
  | {
      type: 'build'
      x: number
      y: number
      kind: Extract<BuildableKind, 'dc' | 'dc_m' | 'dc_l' | 'substation' | 'solar' | 'gas' | 'nuclear' | 'battery'>
      racksUsed?: number
      rackCapacity?: number
      mwGeneration?: number
      mwCapacity?: number
    }
  | { type: 'densify'; x: number; y: number; racksAdded: number }

export const DEFAULT_FACILITY_ACTIONS: readonly FacilitySequenceAction[] = [
  { type: 'build', x: 1, y: 1, kind: 'dc', racksUsed: 72, rackCapacity: 96 },
  { type: 'build', x: 2, y: 1, kind: 'substation', mwCapacity: 24 },
  { type: 'build', x: 3, y: 1, kind: 'solar', mwGeneration: 9 },
  { type: 'densify', x: 1, y: 1, racksAdded: 16 },
  { type: 'build', x: 4, y: 1, kind: 'gas', mwGeneration: 22 },
  { type: 'build', x: 5, y: 1, kind: 'dc_m', racksUsed: 180, rackCapacity: 288 },
]

type GridScarcitySnapshot = ReturnType<typeof gridScarcity>

export interface FacilityDifferentialObservation {
  step: number
  action: FacilitySequenceAction
  playerOwned: GridScarcitySnapshot
  rivalOwned: GridScarcitySnapshot
}

export interface FacilityDifferentialResult {
  observations: FacilityDifferentialObservation[]
  failures: NumericInvariantFailure[]
  playerOwnedState: SimState
  rivalOwnedState: SimState
}

function cloneMapState(state: SimState): SimState {
  return {
    ...state,
    player: { ...state.player },
    rivals: state.rivals.map((rival) => ({ ...rival })),
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => ({ ...tile })),
      regions: state.map.regions.map((region) => ({ ...region })),
      cities: state.map.cities?.map((city) => ({ ...city })),
    },
  }
}

function actionDefaults(action: Extract<FacilitySequenceAction, { type: 'build' }>) {
  const dc = action.kind === 'dc' || action.kind === 'dc_m' || action.kind === 'dc_l'
  return {
    racksUsed: dc ? (action.racksUsed ?? 48) : 0,
    rackCapacity: dc ? (action.rackCapacity ?? 96) : 0,
    mwGeneration:
      action.mwGeneration ??
      (action.kind === 'solar'
        ? 8
        : action.kind === 'gas'
          ? 22
          : action.kind === 'nuclear'
            ? 90
            : 0),
    mwCapacity:
      action.mwCapacity ?? (action.kind === 'substation' || action.kind === 'battery' ? 24 : 0),
    campusRole: dc ? ('anchor' as const) : undefined,
  }
}

function applyFacilityAction(
  state: SimState,
  owner: TileOwner,
  action: FacilitySequenceAction,
): SimState {
  const index = state.map.tiles.findIndex((tile) => tile.x === action.x && tile.y === action.y)
  if (index < 0) throw new Error(`No tile at ${action.x},${action.y}`)
  const tiles = state.map.tiles.slice()
  const current = tiles[index]!
  if (action.type === 'densify') {
    tiles[index] = {
      ...current,
      racksUsed: Math.min(current.rackCapacity, current.racksUsed + action.racksAdded),
    }
  } else {
    const defaults = actionDefaults(action)
    const replacement: MapTile = {
      ...current,
      kind: action.kind,
      owner,
      name: `${owner} ${action.kind}`,
      buildingProgress: 1,
      buildingTarget: 1,
      racksUsed: defaults.racksUsed,
      rackCapacity: defaults.rackCapacity,
      mwGeneration: defaults.mwGeneration,
      mwCapacity: defaults.mwCapacity,
      campusRole: defaults.campusRole,
      powered: true,
    }
    tiles[index] = replacement
  }
  return { ...state, map: { ...state.map, tiles } }
}

function compareGridSnapshots(
  step: number,
  player: GridScarcitySnapshot,
  rival: GridScarcitySnapshot,
): NumericInvariantFailure[] {
  return (Object.keys(player) as (keyof GridScarcitySnapshot)[]).flatMap((metric) => {
    const a = player[metric]
    const b = rival[metric]
    return closeEnough(a, b, 1e-12)
      ? []
      : [{ step, metric: `grid.${metric}`, player: a, rival: b, difference: a - b }]
  })
}

/**
 * Proves shared-grid accounting is ownership-neutral: the same physical
 * sequence must load the grid identically when built by the player or a rival.
 * Private generation/interconnect ownership is intentionally not compared.
 */
export function runFacilityOwnershipDifferential(
  baseState: SimState,
  actions: readonly FacilitySequenceAction[] = DEFAULT_FACILITY_ACTIONS,
): FacilityDifferentialResult {
  let playerOwnedState = cloneMapState(baseState)
  let rivalOwnedState = cloneMapState(baseState)
  const rivalId = baseState.rivals[0]?.id
  if (!rivalId) throw new Error('Facility differential requires at least one rival')
  const observations: FacilityDifferentialObservation[] = []
  const failures: NumericInvariantFailure[] = []
  for (let step = 0; step < actions.length; step++) {
    const action = actions[step]!
    playerOwnedState = applyFacilityAction(playerOwnedState, 'player', action)
    rivalOwnedState = applyFacilityAction(rivalOwnedState, rivalId, action)
    const playerOwned = gridScarcity(playerOwnedState)
    const rivalOwned = gridScarcity(rivalOwnedState)
    observations.push({ step, action, playerOwned, rivalOwned })
    failures.push(...compareGridSnapshots(step, playerOwned, rivalOwned))
  }
  return { observations, failures, playerOwnedState, rivalOwnedState }
}

export function assertFacilityOwnershipInvariants(result: FacilityDifferentialResult) {
  if (result.failures.length === 0) return
  const detail = result.failures
    .map((failure) => `${failure.metric}: player=${failure.player}, rival=${failure.rival}`)
    .join('\n')
  throw new Error(`Player/rival shared-grid behavior diverged:\n${detail}`)
}

export interface PlayerPowerObservation {
  demandMw: number
  power: ReturnType<typeof resolvePlayerPowerMw>
}

export function observePlayerPower(state: SimState, demandsMw: readonly number[]): PlayerPowerObservation[] {
  return demandsMw.map((demandMw) => ({
    demandMw,
    power: resolvePlayerPowerMw(state, demandMw),
  }))
}

/** Ensures renderer-only state can never change simulation results. */
export function assertVisibilityIndependent<T>(
  state: SimState,
  simulate: (state: SimState) => T,
  withVisibilityMetadata: (state: SimState, variant: 'near' | 'far' | 'hidden') => SimState,
  fingerprint: (result: T) => string,
) {
  const expected = fingerprint(simulate(withVisibilityMetadata(state, 'near')))
  for (const variant of ['far', 'hidden'] as const) {
    const actual = fingerprint(simulate(withVisibilityMetadata(state, variant)))
    if (actual !== expected) {
      throw new Error(`Simulation depends on renderer visibility (${variant}: ${actual}, near: ${expected})`)
    }
  }
}
