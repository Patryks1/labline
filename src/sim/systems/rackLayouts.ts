import { CHASSIS_CATALOG, MODULE_CATALOG, scoreDesign } from '../balance/racks'
import type { ModuleDef, RackBlueprint, RackInstall } from '../types'
import { validateBlueprint } from './blueprints'

/** A stable, facility-local address. Rows and bays are zero based in data. */
export interface FacilityRackAddress {
  facilityId: string
  row: number
  bay: number
}

export interface RackHallTemplate {
  id: string
  capacity: number
  rows: number
  baysPerRow: number
}

export const RACK_HALL_TEMPLATES: readonly RackHallTemplate[] = [
  { id: 'hall-96', capacity: 96, rows: 6, baysPerRow: 16 },
  { id: 'hall-288', capacity: 288, rows: 12, baysPerRow: 24 },
  { id: 'hall-960', capacity: 960, rows: 24, baysPerRow: 40 },
] as const

export interface PhysicalRackPlacement {
  /** Stable identity of one physical chassis, not its catalog SKU. */
  id: string
  skuId: string
  address: FacilityRackAddress
  /** Contiguous hall positions occupied by this chassis. */
  rackUnits: number
}

export interface RackLayout {
  facilityId: string
  templateId: RackHallTemplate['id']
  placements: PhysicalRackPlacement[]
}

export interface RackLayoutValidation {
  valid: boolean
  errors: string[]
  used: number
  free: number
}

export interface RackPlacementRequest {
  id: string
  skuId: string
  rackUnits: number
  count?: number
}

export interface RackAutoPlacePreview {
  layout: RackLayout
  placed: PhysicalRackPlacement[]
  unplaced: { id: string; reason: string }[]
  valid: boolean
}

export type RackDesignGoal = 'balanced' | 'training' | 'inference' | 'memory'

export interface RackAutoDesignOptions {
  goal?: RackDesignGoal
  limit?: number
  chassisIds?: readonly string[]
  moduleIds?: readonly string[]
  minimumNetworkGbps?: number
  requiredVramGb?: number
}

export interface RackDesignRecommendation {
  blueprint: RackBlueprint
  score: number
  reason: string
  stats: NonNullable<ReturnType<typeof validateBlueprint>['stats']>
}

export function getRackHallTemplate(
  templateOrCapacity: string | number,
): RackHallTemplate {
  const template = RACK_HALL_TEMPLATES.find(
    (entry) => entry.id === templateOrCapacity || entry.capacity === templateOrCapacity,
  )
  if (template) return template
  const parsed = typeof templateOrCapacity === 'string'
    ? /^hall-custom-(\d+)$/.exec(templateOrCapacity)
    : undefined
  const capacity = typeof templateOrCapacity === 'number'
    ? templateOrCapacity
    : parsed ? Number(parsed[1]) : Number.NaN
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error(`Unsupported rack hall template: ${templateOrCapacity}`)
  }
  const baysPerRow = capacity <= 192 ? 16 : capacity <= 480 ? 24 : 40
  return { id: `hall-custom-${capacity}`, capacity, rows: Math.ceil(capacity / baysPerRow), baysPerRow }
}

export function createRackLayout(
  facilityId: string,
  templateOrCapacity: RackHallTemplate['id'] | RackHallTemplate['capacity'],
  placements: readonly PhysicalRackPlacement[] = [],
): RackLayout {
  return normalizeRackLayout({
    facilityId,
    templateId: getRackHallTemplate(templateOrCapacity).id,
    placements: [...placements],
  })
}

/** Human-readable and URL-safe; format is versioned so it can be persisted. */
export function formatRackAddress(address: FacilityRackAddress): string {
  if (!address.facilityId.trim() || !Number.isInteger(address.row) || !Number.isInteger(address.bay)) {
    throw new Error('Rack address requires a facility id and integer row/bay coordinates.')
  }
  return `rack:v1:${encodeURIComponent(address.facilityId)}:r${String(address.row + 1).padStart(2, '0')}:b${String(address.bay + 1).padStart(3, '0')}`
}

export function parseRackAddress(value: string): FacilityRackAddress | null {
  const match = /^rack:v1:([^:]+):r(\d+):b(\d+)$/.exec(value)
  if (!match) return null
  try {
    const facilityId = decodeURIComponent(match[1]).trim()
    const row = Number(match[2]) - 1
    const bay = Number(match[3]) - 1
    if (!facilityId || !Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(bay) || bay < 0) {
      return null
    }
    return { facilityId, row, bay }
  } catch {
    return null
  }
}

export function rackAddressAt(
  facilityId: string,
  templateOrCapacity: RackHallTemplate['id'] | RackHallTemplate['capacity'],
  unitIndex: number,
): FacilityRackAddress {
  const template = getRackHallTemplate(templateOrCapacity)
  if (!Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex >= template.capacity) {
    throw new Error(`Rack unit index ${unitIndex} is outside ${template.id}.`)
  }
  return {
    facilityId,
    row: Math.floor(unitIndex / template.baysPerRow),
    bay: unitIndex % template.baysPerRow,
  }
}

export function rackUnitIndex(
  address: FacilityRackAddress,
  templateOrCapacity: RackHallTemplate['id'] | RackHallTemplate['capacity'],
): number {
  const template = getRackHallTemplate(templateOrCapacity)
  if (
    !Number.isInteger(address.row) ||
    !Number.isInteger(address.bay) ||
    address.row < 0 ||
    address.row >= template.rows ||
    address.bay < 0 ||
    address.bay >= template.baysPerRow
  ) {
    return -1
  }
  const index = address.row * template.baysPerRow + address.bay
  return index < template.capacity ? index : -1
}

function comparePlacements(a: PhysicalRackPlacement, b: PhysicalRackPlacement): number {
  return (
    (a.address?.row ?? Number.MAX_SAFE_INTEGER) - (b.address?.row ?? Number.MAX_SAFE_INTEGER) ||
    (a.address?.bay ?? Number.MAX_SAFE_INTEGER) - (b.address?.bay ?? Number.MAX_SAFE_INTEGER) ||
    String(a.id).localeCompare(String(b.id)) ||
    String(a.skuId).localeCompare(String(b.skuId))
  )
}

export function normalizeRackLayout(layout: RackLayout): RackLayout {
  return {
    facilityId: layout.facilityId.trim(),
    templateId: layout.templateId,
    placements: layout.placements
      .map((placement) => ({
        id: placement.id.trim(),
        skuId: placement.skuId.trim(),
        rackUnits: placement.rackUnits,
        address: {
          facilityId: placement.address.facilityId.trim(),
          row: placement.address.row,
          bay: placement.address.bay,
        },
      }))
      .sort(comparePlacements),
  }
}

/** Pure validation with errors emitted in stable placement/address order. */
export function validateRackLayout(layout: RackLayout): RackLayoutValidation {
  const errors: string[] = []
  let template: RackHallTemplate | undefined
  try {
    template = getRackHallTemplate(layout.templateId)
  } catch {
    errors.push(`Unknown hall template: ${String(layout.templateId)}.`)
  }
  if (!layout.facilityId?.trim()) errors.push('Layout needs a facility id.')
  if (!Array.isArray(layout.placements)) {
    return { valid: false, errors: [...errors, 'Layout placements must be a list.'], used: 0, free: template?.capacity ?? 0 }
  }

  const ids = new Set<string>()
  const occupied = new Map<number, string>()
  for (const placement of [...layout.placements].sort(comparePlacements)) {
    if (!placement.id?.trim()) errors.push('A rack placement needs an id.')
    else if (ids.has(placement.id)) errors.push(`Rack placement ${placement.id} is duplicated.`)
    else ids.add(placement.id)
    if (!placement.skuId?.trim()) errors.push(`Rack ${placement.id || '<unknown>'} needs a SKU id.`)
    if (placement.address?.facilityId !== layout.facilityId) {
      errors.push(`Rack ${placement.id || '<unknown>'} belongs to a different facility.`)
    }
    if (!Number.isInteger(placement.rackUnits) || placement.rackUnits <= 0) {
      errors.push(`Rack ${placement.id || '<unknown>'} must occupy a positive whole number of units.`)
      continue
    }
    if (!template) continue
    const start = rackUnitIndex(placement.address, template.id)
    if (start < 0) {
      errors.push(`Rack ${placement.id || '<unknown>'} has an address outside ${template.id}.`)
      continue
    }
    if (placement.address.bay + placement.rackUnits > template.baysPerRow) {
      errors.push(`Rack ${placement.id || '<unknown>'} crosses the end of row ${placement.address.row + 1}.`)
      continue
    }
    if (start + placement.rackUnits > template.capacity) {
      errors.push(`Rack ${placement.id || '<unknown>'} exceeds ${template.capacity} available rack units.`)
      continue
    }
    for (let offset = 0; offset < placement.rackUnits; offset += 1) {
      const index = start + offset
      const owner = occupied.get(index)
      if (owner) errors.push(`Rack ${placement.id || '<unknown>'} overlaps ${owner} at ${formatRackAddress(rackAddressAt(layout.facilityId, template.id, index))}.`)
      else occupied.set(index, placement.id)
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    used: occupied.size,
    free: Math.max(0, (template?.capacity ?? 0) - occupied.size),
  }
}

export function placeRack(
  layout: RackLayout,
  placement: PhysicalRackPlacement,
): { layout: RackLayout; errors: string[] } {
  const next = normalizeRackLayout({ ...layout, placements: [...layout.placements, placement] })
  const validation = validateRackLayout(next)
  return validation.valid ? { layout: next, errors: [] } : { layout, errors: validation.errors }
}

export function moveRack(
  layout: RackLayout,
  placementId: string,
  address: FacilityRackAddress,
): { layout: RackLayout; errors: string[] } {
  if (!layout.placements.some((entry) => entry.id === placementId)) {
    return { layout, errors: [`Rack placement ${placementId} was not found.`] }
  }
  const next = normalizeRackLayout({
    ...layout,
    placements: layout.placements.map((entry) =>
      entry.id === placementId ? { ...entry, address } : entry,
    ),
  })
  const validation = validateRackLayout(next)
  return validation.valid ? { layout: next, errors: [] } : { layout, errors: validation.errors }
}

export function removeRack(layout: RackLayout, placementId: string): RackLayout {
  return normalizeRackLayout({
    ...layout,
    placements: layout.placements.filter((entry) => entry.id !== placementId),
  })
}

function firstFit(layout: RackLayout, rackUnits: number): FacilityRackAddress | null {
  const template = getRackHallTemplate(layout.templateId)
  const occupied = new Set<number>()
  for (const placement of layout.placements) {
    const start = rackUnitIndex(placement.address, template.id)
    for (let offset = 0; start >= 0 && offset < placement.rackUnits; offset += 1) {
      occupied.add(start + offset)
    }
  }
  for (let row = 0; row < template.rows; row += 1) {
    for (let bay = 0; bay + rackUnits <= template.baysPerRow; bay += 1) {
      const start = row * template.baysPerRow + bay
      let free = true
      for (let offset = 0; offset < rackUnits; offset += 1) {
        if (occupied.has(start + offset)) { free = false; break }
      }
      if (free) return { facilityId: layout.facilityId, row, bay }
    }
  }
  return null
}

/** Deterministic first-fit preview. Requests are ordered by id, then expanded by ordinal. */
export function previewAutoPlace(
  layout: RackLayout,
  requests: readonly RackPlacementRequest[],
): RackAutoPlacePreview {
  const initial = validateRackLayout(layout)
  if (!initial.valid) return { layout, placed: [], unplaced: [{ id: '<layout>', reason: initial.errors[0] }], valid: false }
  let next = normalizeRackLayout(layout)
  const placed: PhysicalRackPlacement[] = []
  const unplaced: { id: string; reason: string }[] = []
  const expanded = [...requests]
    .sort((a, b) => a.id.localeCompare(b.id) || a.skuId.localeCompare(b.skuId))
    .flatMap((request) => {
      const count = request.count == null
        ? 1
        : Number.isInteger(request.count) && request.count > 0
          ? request.count
          : 0
      if (count === 0) {
        unplaced.push({ id: request.id, reason: 'Rack count must be a positive whole number.' })
      }
      return Array.from({ length: count }, (_, ordinal) => ({
        ...request,
        id: count === 1 ? request.id : `${request.id}:${String(ordinal + 1).padStart(3, '0')}`,
      }))
    })
  for (const request of expanded) {
    if (!request.id.trim() || !request.skuId.trim() || !Number.isInteger(request.rackUnits) || request.rackUnits <= 0) {
      unplaced.push({ id: request.id, reason: 'Invalid rack placement request.' })
      continue
    }
    const address = firstFit(next, request.rackUnits)
    if (!address) {
      unplaced.push({ id: request.id, reason: `No contiguous ${request.rackUnits}-unit space remains.` })
      continue
    }
    const placement = { id: request.id, skuId: request.skuId, rackUnits: request.rackUnits, address }
    const result = placeRack(next, placement)
    if (result.errors.length) unplaced.push({ id: request.id, reason: result.errors[0] })
    else { next = result.layout; placed.push(placement) }
  }
  return { layout: next, placed, unplaced, valid: unplaced.length === 0 }
}

/** Commit is intentionally a no-op transform over a preview, making preview/commit identical. */
export function commitAutoPlace(preview: RackAutoPlacePreview): RackLayout
export function commitAutoPlace(
  layout: RackLayout,
  requests: readonly RackPlacementRequest[],
): RackLayout
export function commitAutoPlace(
  previewOrLayout: RackAutoPlacePreview | RackLayout,
  requests?: readonly RackPlacementRequest[],
): RackLayout {
  return requests
    ? previewAutoPlace(previewOrLayout as RackLayout, requests).layout
    : (previewOrLayout as RackAutoPlacePreview).layout
}

/** Stable facility key used when a map hall has no authored facility id yet. */
export function facilityIdForHall(x: number, y: number): string {
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Hall coordinates must be integers.')
  return `map-hall:${x},${y}`
}

export function rackInstallPlacementId(installId: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error('Rack ordinal must be a non-negative integer.')
  return `${installId}:rack:${String(ordinal + 1).padStart(4, '0')}`
}

/**
 * Deterministically projects legacy aggregate fleet rows into exact positions.
 * The returned layout is derived data; no save migration is needed.
 */
export function layoutRackInstalls(
  x: number,
  y: number,
  capacity: RackHallTemplate['capacity'],
  installs: readonly RackInstall[],
  facilityId = facilityIdForHall(x, y),
): RackAutoPlacePreview {
  const hallInstalls = installs
    .filter((install) => install.x === x && install.y === y && install.count > 0)
    .sort((a, b) => a.id.localeCompare(b.id) || a.skuId.localeCompare(b.skuId))
  let layout = createRackLayout(facilityId, capacity)
  const placed: PhysicalRackPlacement[] = []
  const requests: RackPlacementRequest[] = []
  const unplaced: RackAutoPlacePreview['unplaced'] = []
  for (const install of hallInstalls) {
    for (let ordinal = 0; ordinal < Math.max(0, Math.floor(install.count)); ordinal += 1) {
      const request = {
        id: rackInstallPlacementId(install.id, ordinal),
        skuId: install.skuId,
        rackUnits: Math.max(1, Math.floor(install.rackUnits || 1)),
      }
      const persistedStart = install.bayStarts?.[ordinal]
      if (Number.isSafeInteger(persistedStart) && persistedStart! >= 0 && persistedStart! < capacity) {
        const placement = { ...request, address: rackAddressAt(facilityId, capacity, persistedStart!) }
        const result = placeRack(layout, placement)
        if (result.errors.length === 0) {
          layout = result.layout
          placed.push(placement)
          continue
        }
      }
      requests.push(request)
    }
  }
  const preview = previewAutoPlace(layout, requests)
  return {
    layout: preview.layout,
    placed: [...placed, ...preview.placed],
    unplaced: [...unplaced, ...preview.unplaced],
    valid: unplaced.length === 0 && preview.valid,
  }
}

/** Persist an edited physical layout back onto compact grouped rack installs. */
export function applyRackLayoutToInstalls(
  installs: readonly RackInstall[],
  x: number,
  y: number,
  layout: RackLayout,
): RackInstall[] {
  const starts = new Map<string, number>()
  for (const placement of layout.placements) {
    starts.set(placement.id, rackUnitIndex(placement.address, layout.templateId))
  }
  return installs.map((install) => {
    if (install.x !== x || install.y !== y) return install
    const bayStarts = Array.from({ length: Math.max(0, Math.floor(install.count)) }, (_, ordinal) =>
      starts.get(rackInstallPlacementId(install.id, ordinal)) ?? -1)
    return { ...install, facilityId: layout.facilityId, bayStarts }
  })
}

function bestFitSlot(
  blueprint: RackBlueprint,
  module: ModuleDef,
): string | null {
  const chassis = CHASSIS_CATALOG.find((entry) => entry.id === blueprint.chassisId)
  const used = new Set(blueprint.placements.map((entry) => entry.slotId))
  return chassis?.slots
    .filter((slot) => !used.has(slot.id) && slot.size >= module.slotSize)
    .sort((a, b) => a.size - b.size || a.id.localeCompare(b.id))[0]?.id ?? null
}

function addModule(blueprint: RackBlueprint, module: ModuleDef): boolean {
  const slotId = bestFitSlot(blueprint, module)
  if (!slotId) return false
  blueprint.placements.push({
    instanceId: `${blueprint.id}:${String(blueprint.placements.length + 1).padStart(2, '0')}`,
    moduleId: module.id,
    slotId,
  })
  return true
}

function designMetric(goal: RackDesignGoal, stats: RackDesignRecommendation['stats']): number {
  const base = goal === 'training'
    ? stats.flopsPf * 1_000 + stats.vramGb
    : goal === 'inference'
      ? stats.tokPerSec / 10 + stats.flopsPf * 100
      : goal === 'memory'
        ? stats.vramGb * 4 + stats.systemRamGb
        : stats.flopsPf * 500 + stats.vramGb + stats.tokPerSec / 20
  return base / Math.max(1, stats.buildCost / 100_000)
}

/** Catalog-driven, stable recommendations. No RNG, dates, or mutable state are consulted. */
export function recommendRackDesigns(options: RackAutoDesignOptions = {}): RackDesignRecommendation[] {
  const goal = options.goal ?? 'balanced'
  const allowedModules = MODULE_CATALOG.filter((entry) => !options.moduleIds || options.moduleIds.includes(entry.id))
  const byKind = (kind: ModuleDef['kind']) => allowedModules.filter((entry) => entry.kind === kind)
  const gpuModules = byKind('gpu').sort((a, b) => {
    const av = goal === 'memory' ? a.vramGb ?? 0 : goal === 'inference' ? a.tokPerSec ?? 0 : a.flopsPf ?? 0
    const bv = goal === 'memory' ? b.vramGb ?? 0 : goal === 'inference' ? b.tokPerSec ?? 0 : b.flopsPf ?? 0
    return bv - av || a.id.localeCompare(b.id)
  })
  const chassis = CHASSIS_CATALOG.filter((entry) => !options.chassisIds || options.chassisIds.includes(entry.id))
  const candidates: RackDesignRecommendation[] = []

  for (const shell of chassis) {
    for (const gpu of gpuModules) {
      const blueprint: RackBlueprint = {
        id: `auto-${goal}-${shell.id}-${gpu.id}`,
        name: `${shell.name} ${goal}`,
        chassisId: shell.id,
        placements: [],
      }
      const cpu = byKind('cpu').sort((a, b) => (b.systemRamGb ?? 0) - (a.systemRamGb ?? 0) || a.id.localeCompare(b.id))[0]
      const nic = byKind('nic').sort((a, b) => (b.networkGbps ?? 0) - (a.networkGbps ?? 0) || a.id.localeCompare(b.id))[0]
      if (!cpu || !nic || !addModule(blueprint, cpu) || !addModule(blueprint, nic)) continue

      // Leave enough generic bays for power and cooling, then pack accelerators.
      const reserve = 2
      const shellSlots = shell.slots.length
      while (blueprint.placements.length < shellSlots - reserve && addModule(blueprint, gpu)) { /* pack */ }
      const draw = blueprint.placements.reduce((sum, entry) => sum + (MODULE_CATALOG.find((m) => m.id === entry.moduleId)?.mw ?? 0), 0)
      const cooling = byKind('cooling')
        .filter((entry) => (entry.coolingMw ?? 0) + 1e-9 >= draw)
        .sort((a, b) => (a.cost - b.cost) || a.id.localeCompare(b.id))[0]
      const psu = byKind('psu')
        .filter((entry) => (entry.psuMw ?? 0) + 1e-9 >= draw)
        .sort((a, b) => (a.cost - b.cost) || a.id.localeCompare(b.id))[0]
      if (!cooling || !psu || !addModule(blueprint, cooling) || !addModule(blueprint, psu)) continue

      if (goal === 'memory') {
        const ram = byKind('ram').sort((a, b) => ((b.vramGb ?? 0) + (b.systemRamGb ?? 0)) - ((a.vramGb ?? 0) + (a.systemRamGb ?? 0)) || a.id.localeCompare(b.id))[0]
        while (ram && addModule(blueprint, ram)) { /* fill */ }
      }
      blueprint.placements.sort((a, b) => a.slotId.localeCompare(b.slotId))
      const validation = validateBlueprint(blueprint, {
        minimumNetworkGbps: options.minimumNetworkGbps,
        requiredVramGb: options.requiredVramGb,
      })
      if (!validation.valid || !validation.stats || !scoreDesign(blueprint).valid) continue
      const score = designMetric(goal, validation.stats)
      candidates.push({
        blueprint,
        score,
        reason: `${goal} fit: ${validation.stats.gpuCount} accelerator(s), ${validation.stats.vramGb} GB VRAM, ${validation.networkGbps} Gbps fabric.`,
        stats: validation.stats,
      })
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.blueprint.id.localeCompare(b.blueprint.id))
    .slice(0, Math.max(0, Math.floor(options.limit ?? 3)))
}

// Explicit aliases for callers that use the feature language in commands.
export const autoPlaceRacks = previewAutoPlace
export const autoDesignRacks = recommendRackDesigns
export const HALL_TEMPLATES = RACK_HALL_TEMPLATES
export const validateLayout = validateRackLayout
export const autoPlacePreview = previewAutoPlace
export const autoPlaceCommit = commitAutoPlace
export const autoDesignRecommendations = recommendRackDesigns
