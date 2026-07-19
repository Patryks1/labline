import { CHASSIS_CATALOG, MODULE_CATALOG, scoreDesign } from '../balance/racks'
import { seededId } from '../rng'
import type {
  ModuleKind,
  RackBlueprint,
  RackDesignStats,
  SimState,
} from '../types'
import { orderRacksIntoDc, getPlayerDc } from './dcRacks'
import { resolvePlayerPowerMw } from './map'
import { fleetStats, resolveRackSku } from './racks'

export const BLUEPRINT_PROFILE_KEY = 'labline.profile.rack-blueprints.v1'
export const BLUEPRINT_PROFILE_VERSION = 1

const DEFAULT_MIN_NETWORK_GBPS = 400
const MAX_BLUEPRINT_NAME_LENGTH = 64
const MAX_PLACEMENTS = 128

export interface BlueprintValidationContext {
  /** Optional model or workload memory requirement for fit checks. */
  requiredVramGb?: number
  /** Defaults to one 400G fabric connection. Set to zero for isolated edge racks. */
  minimumNetworkGbps?: number
  /** Content packs can restrict the chassis catalog without changing the service. */
  allowedChassisIds?: readonly string[]
  /** Hardware supply, export controls, or regional rules can block individual parts. */
  unavailableModuleIds?: readonly string[]
  /** Optional per-rack site envelope. Fleet power is checked during instantiation. */
  powerBudgetMw?: number
  regionId?: string
}

export interface BlueprintValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  stats: RackDesignStats | null
  networkGbps: number
  moduleCounts: Partial<Record<ModuleKind, number>>
}

export interface InstantiateBlueprintRequest {
  blueprintId: string
  x: number
  y: number
  count: number
  validation?: Omit<BlueprintValidationContext, 'regionId'>
}

export interface BlueprintProfileStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface BlueprintProfileFile {
  version: typeof BLUEPRINT_PROFILE_VERSION
  blueprints: RackBlueprint[]
}

function addAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('blueprint-alert', state.seed, state.day, severity, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function comparePlacements(
  a: RackBlueprint['placements'][number],
  b: RackBlueprint['placements'][number],
): number {
  return (
    a.slotId.localeCompare(b.slotId) ||
    a.moduleId.localeCompare(b.moduleId) ||
    a.instanceId.localeCompare(b.instanceId)
  )
}

/** Stable canonical representation used by saves, profiles, and revision checks. */
export function normalizeBlueprint(blueprint: RackBlueprint): RackBlueprint {
  return {
    id: blueprint.id.trim(),
    name: blueprint.name.trim().slice(0, MAX_BLUEPRINT_NAME_LENGTH),
    chassisId: blueprint.chassisId.trim(),
    placements: blueprint.placements
      .map((placement) => ({
        instanceId: placement.instanceId.trim(),
        moduleId: placement.moduleId.trim(),
        slotId: placement.slotId.trim(),
      }))
      .sort(comparePlacements),
  }
}

function structuralFingerprint(blueprint: RackBlueprint): string {
  const normalized = normalizeBlueprint(blueprint)
  return JSON.stringify({
    chassisId: normalized.chassisId,
    placements: normalized.placements.map(({ moduleId, slotId }) => ({ moduleId, slotId })),
  })
}

/**
 * Pure, deterministic, and non-throwing validation for rack blueprints.
 * Contextual checks let campaign content packs add availability and site limits
 * while the canonical catalog remains the source of component truth.
 */
export function validateBlueprint(
  blueprint: RackBlueprint,
  context: BlueprintValidationContext = {},
): BlueprintValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const moduleCounts: Partial<Record<ModuleKind, number>> = {}
  let networkGbps = 0
  let stats: RackDesignStats | null = null

  if (!blueprint || typeof blueprint !== 'object') {
    return {
      valid: false,
      errors: ['Blueprint must be an object.'],
      warnings,
      stats,
      networkGbps,
      moduleCounts,
    }
  }
  if (!isNonBlankString(blueprint.id)) errors.push('Blueprint needs an id.')
  if (!isNonBlankString(blueprint.name)) errors.push('Blueprint needs a name.')
  if (typeof blueprint.name === 'string' && blueprint.name.trim().length > MAX_BLUEPRINT_NAME_LENGTH) {
    errors.push(`Blueprint name must be ${MAX_BLUEPRINT_NAME_LENGTH} characters or fewer.`)
  }
  if (!isNonBlankString(blueprint.chassisId)) errors.push('Blueprint needs a chassis.')
  if (!Array.isArray(blueprint.placements)) {
    errors.push('Blueprint placements must be a list.')
    return { valid: false, errors, warnings, stats, networkGbps, moduleCounts }
  }
  if (blueprint.placements.length > MAX_PLACEMENTS) {
    errors.push(`Blueprint cannot contain more than ${MAX_PLACEMENTS} modules.`)
  }

  const chassis = CHASSIS_CATALOG.find((entry) => entry.id === blueprint.chassisId)
  if (!chassis) errors.push(`Unknown chassis: ${String(blueprint.chassisId)}.`)
  if (
    chassis &&
    context.allowedChassisIds &&
    !context.allowedChassisIds.includes(chassis.id)
  ) {
    errors.push(`${chassis.name} is unavailable${context.regionId ? ` in ${context.regionId}` : ''}.`)
  }

  const usedSlots = new Set<string>()
  const usedInstances = new Set<string>()
  let structurallySafe = chassis != null && blueprint.placements.length <= MAX_PLACEMENTS
  for (let index = 0; index < blueprint.placements.length; index += 1) {
    const placement = blueprint.placements[index]
    if (!placement || typeof placement !== 'object') {
      errors.push(`Placement ${index + 1} is malformed.`)
      structurallySafe = false
      continue
    }
    if (!isNonBlankString(placement.instanceId)) {
      errors.push(`Placement ${index + 1} needs an instance id.`)
      structurallySafe = false
    } else if (usedInstances.has(placement.instanceId)) {
      errors.push(`Module instance ${placement.instanceId} is duplicated.`)
      structurallySafe = false
    } else {
      usedInstances.add(placement.instanceId)
    }
    if (!isNonBlankString(placement.slotId)) {
      errors.push(`Placement ${index + 1} needs a slot id.`)
      structurallySafe = false
    } else if (usedSlots.has(placement.slotId)) {
      errors.push(`Slot ${placement.slotId} is double-booked.`)
      structurallySafe = false
    } else {
      usedSlots.add(placement.slotId)
    }
    if (!isNonBlankString(placement.moduleId)) {
      errors.push(`Placement ${index + 1} needs a module id.`)
      structurallySafe = false
      continue
    }
    const module = MODULE_CATALOG.find((entry) => entry.id === placement.moduleId)
    if (!module) {
      errors.push(`Unknown module: ${placement.moduleId}.`)
      structurallySafe = false
      continue
    }
    moduleCounts[module.kind] = (moduleCounts[module.kind] ?? 0) + 1
    networkGbps += module.networkGbps ?? 0
    if (context.unavailableModuleIds?.includes(module.id)) {
      errors.push(`${module.name} is unavailable${context.regionId ? ` in ${context.regionId}` : ''}.`)
    }
    const slot = chassis?.slots.find((entry) => entry.id === placement.slotId)
    if (!slot) {
      if (chassis && isNonBlankString(placement.slotId)) {
        errors.push(`Slot ${placement.slotId} does not exist on ${chassis.name}.`)
      }
      structurallySafe = false
    } else if (module.slotSize > slot.size) {
      errors.push(`${module.name} needs a size-${module.slotSize} bay; ${slot.id} is size ${slot.size}.`)
      structurallySafe = false
    }
  }

  if (structurallySafe) {
    try {
      stats = scoreDesign(blueprint)
      errors.push(...stats.errors)
    } catch {
      errors.push('Blueprint could not be scored against the current hardware catalog.')
    }
  }

  const minimumNetworkGbps = Math.max(
    0,
    context.minimumNetworkGbps ?? DEFAULT_MIN_NETWORK_GBPS,
  )
  if (networkGbps + 1e-9 < minimumNetworkGbps) {
    errors.push(
      `Network fabric provides ${networkGbps} Gbps; ${minimumNetworkGbps} Gbps is required.`,
    )
  }
  if (stats) {
    const requiredVramGb = Math.max(0, context.requiredVramGb ?? 0)
    if (stats.vramGb + 1e-9 < requiredVramGb) {
      errors.push(
        `Memory fit failed: ${stats.vramGb} GB VRAM available, ${requiredVramGb} GB required.`,
      )
    }
    if (stats.gpuCount > 0 && stats.systemRamGb < stats.gpuCount * 64) {
      warnings.push(
        `Host memory is ${stats.systemRamGb} GB for ${stats.gpuCount} accelerator(s); data loading may bottleneck.`,
      )
    }
    if (
      context.powerBudgetMw != null &&
      stats.mw > Math.max(0, context.powerBudgetMw) + 1e-9
    ) {
      errors.push(
        `Power envelope exceeded: ${(stats.mw * 1000).toFixed(2)} kW draw vs ${(Math.max(0, context.powerBudgetMw) * 1000).toFixed(2)} kW available.`,
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
    networkGbps,
    moduleCounts,
  }
}

/** Save or replace a campaign blueprint after canonical validation. */
export function saveBlueprint(state: SimState, blueprint: RackBlueprint): SimState {
  const validation = validateBlueprint(blueprint)
  if (!validation.valid) {
    return addAlert(state, 'warn', validation.errors[0] ?? 'Blueprint is invalid.')
  }
  const normalized = normalizeBlueprint(blueprint)
  const current = state.player.rackDesigns.find((entry) => entry.id === normalized.id)
  const instantiated =
    state.player.rackFleet.some((entry) => entry.skuId === `design:${normalized.id}`) ||
    state.player.deployedRacks.some((entry) => entry.designId === normalized.id)
  if (
    current &&
    instantiated &&
    structuralFingerprint(current) !== structuralFingerprint(normalized)
  ) {
    return addAlert(
      state,
      'warn',
      `${current.name} is already instantiated. Save hardware changes under a new blueprint id.`,
    )
  }
  const rackDesigns = current
    ? state.player.rackDesigns.map((entry) =>
        entry.id === normalized.id ? normalized : entry,
      )
    : [...state.player.rackDesigns, normalized]
  return addAlert(
    {
      ...state,
      player: { ...state.player, rackDesigns },
    },
    'info',
    `Blueprint saved: ${normalized.name} (${validation.stats?.gpuCount ?? 0} accelerator · ${validation.networkGbps} Gbps).`,
  )
}

function committedFleetMw(state: SimState): number {
  // fleetStats includes live complete racks, legacy designer deployments, and
  // loose legacy chips. Ordered complete racks are the only extra reservation.
  let mw = fleetStats(state).mw
  for (const rack of state.player.rackFleet) {
    if (rack.status !== 'ordered' || rack.count <= 0) continue
    try {
      mw += resolveRackSku(rack.skuId, state.player.rackDesigns).mw * rack.count
    } catch {
      // Stale legacy rack entries do not reserve new blueprint capacity.
    }
  }
  return mw
}

export function instantiateBlueprint(
  state: SimState,
  request: InstantiateBlueprintRequest,
): SimState
export function instantiateBlueprint(
  state: SimState,
  blueprintId: string,
  x: number,
  y: number,
  count: number,
): SimState
export function instantiateBlueprint(
  state: SimState,
  requestOrId: InstantiateBlueprintRequest | string,
  x?: number,
  y?: number,
  count?: number,
): SimState {
  const request: InstantiateBlueprintRequest =
    typeof requestOrId === 'string'
      ? {
          blueprintId: requestOrId,
          x: x ?? Number.NaN,
          y: y ?? Number.NaN,
          count: count ?? 0,
        }
      : requestOrId
  const blueprint = state.player.rackDesigns.find(
    (entry) => entry.id === request.blueprintId,
  )
  if (!blueprint) return addAlert(state, 'warn', 'Blueprint not found in this campaign.')
  if (!Number.isInteger(request.x) || !Number.isInteger(request.y)) {
    return addAlert(state, 'warn', 'Blueprint needs a valid data-center destination.')
  }
  if (!Number.isFinite(request.count) || request.count <= 0 || !Number.isInteger(request.count)) {
    return addAlert(state, 'warn', 'Instantiate a positive whole number of racks.')
  }
  const dc = getPlayerDc(state, request.x, request.y)
  if (!dc) return addAlert(state, 'warn', 'Select a completed player data hall.')
  if (dc.powered === false) return addAlert(state, 'warn', 'Power on the data hall before ordering racks.')

  const validation = validateBlueprint(blueprint, {
    ...request.validation,
    regionId: dc.regionId,
  })
  if (!validation.valid || !validation.stats) {
    return addAlert(state, 'warn', validation.errors[0] ?? 'Blueprint is invalid.')
  }

  const existingMw = committedFleetMw(state)
  const addedMw = validation.stats.mw * request.count
  const requiredMw = (existingMw + addedMw) * Math.max(1, state.player.pue)
  const power = resolvePlayerPowerMw(state, requiredMw)
  const hasPhysicalPowerSource =
    power.mwGeneration > 1e-9 ||
    power.mwInterconnect > 1e-9 ||
    power.mwContractImport > 1e-9
  if (!hasPhysicalPowerSource || power.mwAvailable + 1e-9 < requiredMw) {
    return addAlert(
      state,
      'warn',
      `Insufficient firm power: ${(requiredMw - existingMw * Math.max(1, state.player.pue)).toFixed(3)} MW new load would exceed ${power.mwAvailable.toFixed(3)} MW available.`,
    )
  }

  return orderRacksIntoDc(
    state,
    request.x,
    request.y,
    `design:${blueprint.id}`,
    request.count,
  )
}

function defaultProfileStorage(): BlueprintProfileStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/** Load only blueprints that remain valid under the current component catalog. */
export function loadProfileBlueprints(
  storage: BlueprintProfileStorage | undefined = defaultProfileStorage(),
): RackBlueprint[] {
  if (!storage) return []
  let parsed: unknown
  try {
    const raw = storage.getItem(BLUEPRINT_PROFILE_KEY)
    if (!raw) return []
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as Partial<BlueprintProfileFile>
  if (file.version !== BLUEPRINT_PROFILE_VERSION || !Array.isArray(file.blueprints)) return []
  const byId = new Map<string, RackBlueprint>()
  for (const candidate of file.blueprints) {
    try {
      const validation = validateBlueprint(candidate)
      if (validation.valid) {
        const normalized = normalizeBlueprint(candidate)
        byId.set(normalized.id, normalized)
      }
    } catch {
      // A malformed or retired component never invalidates the full profile.
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Persist a canonical, deduplicated profile library independent of campaign saves. */
export function saveProfileBlueprint(
  blueprint: RackBlueprint,
  storage: BlueprintProfileStorage | undefined = defaultProfileStorage(),
): RackBlueprint[] {
  const validation = validateBlueprint(blueprint)
  if (!storage || !validation.valid) return loadProfileBlueprints(storage)
  const normalized = normalizeBlueprint(blueprint)
  const byId = new Map(
    loadProfileBlueprints(storage).map((entry) => [entry.id, entry] as const),
  )
  byId.set(normalized.id, normalized)
  const blueprints = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  const file: BlueprintProfileFile = {
    version: BLUEPRINT_PROFILE_VERSION,
    blueprints,
  }
  storage.setItem(BLUEPRINT_PROFILE_KEY, JSON.stringify(file))
  return blueprints
}
