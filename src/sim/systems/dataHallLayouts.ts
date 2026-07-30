import type {
  DataHallDoorPlacement,
  DataHallEditPlan,
  DataHallLayout,
  DataHallLayoutAnalysis,
  DataHallObjectKind,
  DataHallObjectPlacement,
  DataHallShellId,
  DataHallWallSegment,
  HallAutoLayoutStrategy,
  HallRotation,
  LabId,
  RackInstall,
  SimState,
} from '../types'
import { resolveRackSku } from './racks'
import { facilityAnchorTiles } from './worldAccess'
import { isDcAnchor, isDcKind } from './map'

export const HALL_GRID_METERS = 0.25

export interface DataHallShellTemplate {
  id: DataHallShellId
  width: number
  depth: number
  exteriorDoor: { x: number; z: number; width: number; clearance: number }
}

export const DATA_HALL_SHELLS: Record<DataHallShellId, DataHallShellTemplate> = {
  'hall-small-v1': { id: 'hall-small-v1', width: 96, depth: 72, exteriorDoor: { x: 46, z: 0, width: 4, clearance: 6 } },
  'hall-medium-v1': { id: 'hall-medium-v1', width: 168, depth: 120, exteriorDoor: { x: 82, z: 0, width: 4, clearance: 6 } },
  'hall-large-v1': { id: 'hall-large-v1', width: 288, depth: 192, exteriorDoor: { x: 142, z: 0, width: 4, clearance: 6 } },
}

export interface HallEquipmentDef {
  id: string
  kind: Exclude<DataHallObjectKind, 'rack'>
  name: string
  width: number
  depth: number
  price: number
  powerMw?: number
  coolingMw?: number
  networkGbps?: number
}

export const HALL_EQUIPMENT_CATALOG: readonly HallEquipmentDef[] = [
  { id: 'crac-2mw', kind: 'cooling', name: 'CRAC 2 MW', width: 8, depth: 12, price: 3_200_000, coolingMw: 2 },
  { id: 'inrow-350kw', kind: 'cooling', name: 'In-row cooler', width: 3, depth: 5, price: 720_000, coolingMw: 0.35 },
  { id: 'pdu-2mw', kind: 'power', name: 'PDU 2 MW', width: 4, depth: 4, price: 1_150_000, powerMw: 2 },
  { id: 'ups-5mw', kind: 'power', name: 'UPS 5 MW', width: 6, depth: 8, price: 5_800_000, powerMw: 5 },
  { id: 'core-6t', kind: 'network', name: 'Core fabric 6.4T', width: 3, depth: 4, price: 980_000, networkGbps: 6_400 },
  { id: 'core-25t', kind: 'network', name: 'Core fabric 25T', width: 4, depth: 5, price: 3_600_000, networkGbps: 25_600 },
] as const

export interface HallRackUnit {
  unitId: string
  skuId: string
  mw: number
  networkGbps: number
  delivered: boolean
}

export function shellIdForSize(size?: string): DataHallShellId {
  return size === 'large' ? 'hall-large-v1' : size === 'medium' ? 'hall-medium-v1' : 'hall-small-v1'
}

export function ensureRackUnitIds(install: RackInstall): RackInstall {
  const existing = install.unitIds ?? []
  const unitIds = Array.from({ length: Math.max(0, Math.floor(install.count)) }, (_, index) =>
    existing[index]?.trim() || `${install.id}:unit:${String(index + 1).padStart(4, '0')}`)
  return { ...install, unitIds }
}

function ownerFleet(state: SimState, ownerId: LabId): RackInstall[] {
  if (ownerId === state.playerLabId) return state.player.rackFleet ?? []
  return state.rivals.find((rival) => rival.id === ownerId)?.rackFleet ?? state.labs[ownerId]?.rackFleet ?? []
}

function ownerDesigns(state: SimState, ownerId: LabId) {
  if (ownerId === state.playerLabId) return state.player.rackDesigns ?? []
  return state.rivals.find((rival) => rival.id === ownerId)?.rackDesigns ?? state.labs[ownerId]?.rackDesigns ?? []
}

export function rackUnitsForFacility(state: SimState, facilityId: string, ownerId: LabId): HallRackUnit[] {
  const designs = ownerDesigns(state, ownerId)
  const hall = facilityAnchorTiles(state, { ownerId }).find((candidate) => (candidate.campusId ?? `facility:${candidate.x},${candidate.y}`) === facilityId)
  return ownerFleet(state, ownerId)
    .filter((install) => install.facilityId === facilityId || (!install.facilityId && hall?.x === install.x && hall.y === install.y))
    .flatMap((raw) => {
      const install = ensureRackUnitIds(raw)
      let mw = 0.0075
      let networkGbps = 400
      try {
        const sku = resolveRackSku(install.skuId, designs)
        mw = sku.mw
        networkGbps = sku.networkGbps ?? 400
      } catch { /* legacy unknown rack */ }
      return install.unitIds!.map((unitId) => ({ unitId, skuId: install.skuId, mw, networkGbps, delivered: install.status === 'live' }))
    })
}

function dims(object: DataHallObjectPlacement): { width: number; depth: number } {
  const base = object.kind === 'rack'
    ? { width: 3, depth: 5 }
    : HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId) ?? { width: 1, depth: 1 }
  return object.rotation === 90 || object.rotation === 270
    ? { width: base.depth, depth: base.width }
    : { width: base.width, depth: base.depth }
}

function rectCells(shell: DataHallShellTemplate, object: DataHallObjectPlacement): number[] {
  const { width, depth } = dims(object)
  const cells: number[] = []
  for (let z = object.z; z < object.z + depth; z += 1) {
    for (let x = object.x; x < object.x + width; x += 1) cells.push(z * shell.width + x)
  }
  return cells
}

function rectsOverlap(a: DataHallObjectPlacement, b: DataHallObjectPlacement): boolean {
  const ad = dims(a)
  const bd = dims(b)
  return a.x < b.x + bd.width && a.x + ad.width > b.x && a.z < b.z + bd.depth && a.z + ad.depth > b.z
}

/** Cheap pointer-preview validation that deliberately avoids utility routing. */
export function previewHallObjectPlacement(
  layout: Pick<DataHallLayout, 'shellId' | 'objects' | 'walls' | 'doors'>,
  candidate: DataHallObjectPlacement,
  rackCapacity: number,
): 'valid' | 'warning' | 'invalid' {
  const shell = DATA_HALL_SHELLS[layout.shellId]
  const size = dims(candidate)
  if (!Number.isInteger(candidate.x) || !Number.isInteger(candidate.z) || candidate.x < 0 || candidate.z < 0 || candidate.x + size.width > shell.width || candidate.z + size.depth > shell.depth) return 'invalid'
  const exterior = shell.exteriorDoor
  if (candidate.x < exterior.x + exterior.width && candidate.x + size.width > exterior.x && candidate.z < exterior.clearance) return 'invalid'
  if (candidate.kind === 'rack' && layout.objects.filter((object) => object.kind === 'rack' && object.id !== candidate.id).length >= rackCapacity) return 'invalid'
  if (layout.objects.some((object) => object.id !== candidate.id && rectsOverlap(object, candidate))) return 'invalid'
  if (layout.walls.some((wall) => wallIntersectsObject(wall, candidate))) return 'invalid'
  for (const door of layout.doors) {
    const wall = layout.walls.find((entry) => entry.id === door.wallId)
    if (!wall) continue
    const horizontal = wall.z1 === wall.z2
    const length = Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)
    const start = Math.max(0, Math.min(Math.max(0, length - door.width), Math.round(door.offset * Math.max(0, length - door.width))))
    const doorX = horizontal ? Math.min(wall.x1, wall.x2) + start : wall.x1
    const doorZ = horizontal ? wall.z1 : Math.min(wall.z1, wall.z2) + start
    const overlaps = horizontal
      ? candidate.x < doorX + door.width && candidate.x + size.width > doorX && candidate.z < doorZ + 6 && candidate.z + size.depth > doorZ - 6
      : candidate.z < doorZ + door.width && candidate.z + size.depth > doorZ && candidate.x < doorX + 6 && candidate.x + size.width > doorX - 6
    if (overlaps) return 'invalid'
  }
  if (candidate.kind !== 'rack') return 'valid'
  const clearance = 5
  const nearObject = layout.objects.some((object) => {
    if (object.id === candidate.id) return false
    const d = dims(object)
    return candidate.x - clearance < object.x + d.width && candidate.x + size.width + clearance > object.x &&
      candidate.z - clearance < object.z + d.depth && candidate.z + size.depth + clearance > object.z
  })
  return nearObject ? 'warning' : 'valid'
}

function route(shell: DataHallShellTemplate, from: DataHallObjectPlacement, to: DataHallObjectPlacement): number[] {
  const a = dims(from)
  const b = dims(to)
  let x = from.x + Math.floor(a.width / 2)
  let z = from.z + Math.floor(a.depth / 2)
  const tx = to.x + Math.floor(b.width / 2)
  const tz = to.z + Math.floor(b.depth / 2)
  const cells: number[] = [z * shell.width + x]
  while (x !== tx) { x += x < tx ? 1 : -1; cells.push(z * shell.width + x) }
  while (z !== tz) { z += z < tz ? 1 : -1; cells.push(z * shell.width + x) }
  return cells
}

function wallIntersectsObject(wall: DataHallWallSegment, object: DataHallObjectPlacement): boolean {
  const { width, depth } = dims(object)
  const minX = object.x
  const maxX = object.x + width
  const minZ = object.z
  const maxZ = object.z + depth
  if (wall.x1 === wall.x2) return wall.x1 > minX && wall.x1 < maxX && Math.max(wall.z1, wall.z2) > minZ && Math.min(wall.z1, wall.z2) < maxZ
  if (wall.z1 === wall.z2) return wall.z1 > minZ && wall.z1 < maxZ && Math.max(wall.x1, wall.x2) > minX && Math.min(wall.x1, wall.x2) < maxX
  return true
}

function emptyAnalysis(revision: number): DataHallLayoutAnalysis {
  return {
    revision, valid: true, hardErrors: [], warnings: [], operationalRackUnitIds: [], offlineRackUnitIds: [],
    environmentScore: 1, coolingScore: 1, airflowScore: 1, aisleScore: 1,
    throughputMultiplier: 1, pueMultiplier: 1, incidentRiskMultiplier: 1,
    powerRoutes: [], networkRoutes: [],
  }
}

export function analyzeHallLayout(
  layout: Pick<DataHallLayout, 'revision' | 'shellId' | 'objects' | 'walls' | 'doors'>,
  inventory: readonly HallRackUnit[],
  rackCapacity = Number.MAX_SAFE_INTEGER,
): DataHallLayoutAnalysis {
  const shell = DATA_HALL_SHELLS[layout.shellId]
  const analysis = emptyAnalysis(layout.revision)
  const occupancy = new Int32Array(shell.width * shell.depth)
  const inventoryById = new Map(inventory.map((unit) => [unit.unitId, unit]))
  const racks = layout.objects.filter((object) => object.kind === 'rack').sort((a, b) => a.id.localeCompare(b.id))
  const placementIds = new Set<string>()
  for (const entry of [...layout.objects, ...layout.walls, ...layout.doors]) {
    if (placementIds.has(entry.id)) analysis.hardErrors.push(`Placement ID ${entry.id} is used more than once.`)
    else placementIds.add(entry.id)
  }
  if (racks.length > rackCapacity) analysis.hardErrors.push(`Layout has ${racks.length} racks but this shell is rated for ${rackCapacity}.`)
  const seenRackUnits = new Set<string>()
  for (let objectIndex = 0; objectIndex < layout.objects.length; objectIndex += 1) {
    const object = layout.objects[objectIndex]!
    if (object.kind !== 'rack') {
      const equipment = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId)
      if (!equipment || equipment.kind !== object.kind) analysis.hardErrors.push(`${object.id} references unknown ${object.kind} equipment ${object.catalogId}.`)
    }
    const { width, depth } = dims(object)
    if (!Number.isInteger(object.x) || !Number.isInteger(object.z) || object.x < 0 || object.z < 0 || object.x + width > shell.width || object.z + depth > shell.depth) {
      analysis.hardErrors.push(`${object.id} is outside the hall shell.`)
      continue
    }
    const door = shell.exteriorDoor
    if (object.x < door.x + door.width && object.x + width > door.x && object.z < door.clearance) {
      analysis.hardErrors.push(`${object.id} blocks the exterior door clearance.`)
    }
    for (const wall of layout.walls) if (wallIntersectsObject(wall, object)) analysis.hardErrors.push(`${object.id} intersects wall ${wall.id}.`)
    for (const cell of rectCells(shell, object)) {
      if (occupancy[cell] !== 0) analysis.hardErrors.push(`${object.id} overlaps ${layout.objects[occupancy[cell]! - 1]!.id}.`)
      else occupancy[cell] = objectIndex + 1
    }
    if (object.kind === 'rack') {
      if (object.reserved) {
        if (object.rackUnitId) analysis.hardErrors.push(`${object.id} cannot be both reserved and assigned to rack unit ${object.rackUnitId}.`)
        continue
      }
      if (!object.rackUnitId || !inventoryById.has(object.rackUnitId)) analysis.hardErrors.push(`${object.id} does not reference an owned rack unit.`)
      else if (seenRackUnits.has(object.rackUnitId)) analysis.hardErrors.push(`${object.rackUnitId} is placed more than once.`)
      else seenRackUnits.add(object.rackUnitId)
    }
  }
  for (const wall of layout.walls) {
    if ((wall.x1 !== wall.x2 && wall.z1 !== wall.z2) || wall.x1 < 0 || wall.x2 < 0 || wall.z1 < 0 || wall.z2 < 0 || wall.x1 > shell.width || wall.x2 > shell.width || wall.z1 > shell.depth || wall.z2 > shell.depth) {
      analysis.hardErrors.push(`Wall ${wall.id} must be an axis-aligned segment inside the shell.`)
    }
  }
  for (const door of layout.doors) {
    const wall = layout.walls.find((candidate) => candidate.id === door.wallId)
    if (!wall) { analysis.hardErrors.push(`Door ${door.id} has no supporting wall.`); continue }
    const horizontal = wall.z1 === wall.z2
    const length = Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)
    const start = Math.max(0, Math.min(Math.max(0, length - door.width), Math.round(door.offset * Math.max(0, length - door.width))))
    const doorX = horizontal ? Math.min(wall.x1, wall.x2) + start : wall.x1
    const doorZ = horizontal ? wall.z1 : Math.min(wall.z1, wall.z2) + start
    for (const object of layout.objects) {
      const d = dims(object)
      const overlaps = horizontal
        ? object.x < doorX + door.width && object.x + d.width > doorX && object.z < doorZ + 6 && object.z + d.depth > doorZ - 6
        : object.z < doorZ + door.width && object.z + d.depth > doorZ && object.x < doorX + 6 && object.x + d.width > doorX - 6
      if (overlaps) analysis.hardErrors.push(`${object.id} blocks door ${door.id}.`)
    }
  }

  const power = layout.objects.filter((object) => object.kind === 'power').map((object) => ({ object, remaining: HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId)?.powerMw ?? 0 }))
  const network = layout.objects.filter((object) => object.kind === 'network').map((object) => ({ object, remaining: HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId)?.networkGbps ?? 0 }))
  const coolingCapacity = layout.objects.filter((object) => object.kind === 'cooling').reduce((sum, object) => sum + (HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId)?.coolingMw ?? 0), 0)
  const deliveredRacks = racks.filter((rack) => !rack.reserved && rack.rackUnitId && inventoryById.get(rack.rackUnitId)?.delivered)
  let totalHeat = 0
  let airflowTotal = 0
  let aisleTotal = 0
  for (const rack of deliveredRacks) {
    const unit = inventoryById.get(rack.rackUnitId!)!
    totalHeat += unit.mw
    const nearestPower = power.filter((entry) => entry.remaining + 1e-9 >= unit.mw).sort((a, b) => route(shell, rack, a.object).length - route(shell, rack, b.object).length || a.object.id.localeCompare(b.object.id))[0]
    const nearestNetwork = network.filter((entry) => entry.remaining + 1e-9 >= unit.networkGbps).sort((a, b) => route(shell, rack, a.object).length - route(shell, rack, b.object).length || a.object.id.localeCompare(b.object.id))[0]
    if (nearestPower) { nearestPower.remaining -= unit.mw; analysis.powerRoutes.push({ rackUnitId: unit.unitId, equipmentId: nearestPower.object.id, cells: route(shell, rack, nearestPower.object) }) }
    if (nearestNetwork) { nearestNetwork.remaining -= unit.networkGbps; analysis.networkRoutes.push({ rackUnitId: unit.unitId, equipmentId: nearestNetwork.object.id, cells: route(shell, rack, nearestNetwork.object) }) }
    if (nearestPower && nearestNetwork) analysis.operationalRackUnitIds.push(unit.unitId)
    else analysis.offlineRackUnitIds.push(unit.unitId)

    const d = dims(rack)
    const ownIndex = layout.objects.indexOf(rack) + 1
    const clearance = (dx: number, dz: number, target: number, acrossX: boolean) => {
      for (let step = 1; step <= target; step += 1) {
        const sx = dx < 0 ? rack.x - step : dx > 0 ? rack.x + d.width - 1 + step : rack.x
        const sz = dz < 0 ? rack.z - step : dz > 0 ? rack.z + d.depth - 1 + step : rack.z
        const across = acrossX ? d.width : d.depth
        for (let offset = 0; offset < across; offset += 1) {
          const x = sx + (acrossX ? offset : 0)
          const z = sz + (acrossX ? 0 : offset)
          if (x < 0 || z < 0 || x >= shell.width || z >= shell.depth) return (step - 1) / target
          const occupant = occupancy[z * shell.width + x]
          if (occupant !== 0 && occupant !== ownIndex) return (step - 1) / target
        }
      }
      return 1
    }
    const front = rack.rotation === 0 ? clearance(0, 1, 5, true) : rack.rotation === 180 ? clearance(0, -1, 5, true) : rack.rotation === 90 ? clearance(1, 0, 5, false) : clearance(-1, 0, 5, false)
    const rear = rack.rotation === 0 ? clearance(0, -1, 5, true) : rack.rotation === 180 ? clearance(0, 1, 5, true) : rack.rotation === 90 ? clearance(-1, 0, 5, false) : clearance(1, 0, 5, false)
    airflowTotal += Math.min(front, rear)
    const sides = rack.rotation === 0 || rack.rotation === 180
      ? [clearance(-1, 0, 6, false), clearance(1, 0, 6, false)]
      : [clearance(0, -1, 6, true), clearance(0, 1, 6, true)]
    aisleTotal += Math.max(...sides)
  }
  const divisor = Math.max(1, deliveredRacks.length)
  analysis.coolingScore = Math.max(0, Math.min(1, totalHeat > 0 ? coolingCapacity / totalHeat : 1))
  analysis.airflowScore = airflowTotal / divisor
  analysis.aisleScore = aisleTotal / divisor
  analysis.environmentScore = Math.max(0, Math.min(1, analysis.coolingScore * 0.6 + analysis.airflowScore * 0.25 + analysis.aisleScore * 0.15))
  analysis.throughputMultiplier = 0.65 + 0.35 * analysis.environmentScore
  analysis.pueMultiplier = 1 + 0.25 * (1 - analysis.environmentScore)
  analysis.incidentRiskMultiplier = 1 + 2 * (1 - analysis.environmentScore)
  if (analysis.coolingScore < 0.999) analysis.warnings.push('Cooling capacity is below installed rack heat load.')
  if (analysis.airflowScore < 0.8) analysis.warnings.push('Hot/cold aisle clearance is reducing throughput.')
  if (analysis.aisleScore < 0.8) analysis.warnings.push('Service aisle access is below target.')
  if (analysis.offlineRackUnitIds.length) analysis.warnings.push(`${analysis.offlineRackUnitIds.length} delivered rack(s) lack power or network.`)
  analysis.valid = analysis.hardErrors.length === 0
  return analysis
}

function utilityPlacement(id: string, catalogId: string, x: number, z: number, purchasePrice = 0): DataHallObjectPlacement {
  const def = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === catalogId)!
  return { id, kind: def.kind, catalogId, x, z, rotation: 0, purchasePrice }
}

export function createDefaultHallLayout(
  facilityId: string,
  shellId: DataHallShellId,
  inventory: readonly HallRackUnit[],
  rackCapacity: number,
): DataHallLayout {
  const shell = DATA_HALL_SHELLS[shellId]
  const delivered = inventory.filter((unit) => unit.delivered)
  const totalMw = delivered.reduce((sum, unit) => sum + unit.mw, 0)
  const totalNetwork = delivered.reduce((sum, unit) => sum + unit.networkGbps, 0)
  const powerCount = Math.max(1, Math.ceil(totalMw / 5))
  const networkCount = Math.max(1, Math.ceil(totalNetwork / 25_600))
  const coolingCount = Math.max(1, Math.ceil(totalMw / 2))
  const objects: DataHallObjectPlacement[] = []
  for (let index = 0; index < powerCount; index += 1) objects.push(utilityPlacement(`${facilityId}:power:${index + 1}`, 'ups-5mw', 2 + index * 8, 2))
  for (let index = 0; index < networkCount; index += 1) objects.push(utilityPlacement(`${facilityId}:network:${index + 1}`, 'core-25t', shell.width - 8 - index * 6, 2))
  for (let index = 0; index < coolingCount; index += 1) objects.push(utilityPlacement(`${facilityId}:cooling:${index + 1}`, 'crac-2mw', 2 + index * 10, shell.depth - 14))
  const layout: DataHallLayout = {
    version: 1, facilityId, shellId, revision: 0, autoPlaceDeliveries: true, preferredStrategy: 'efficiency',
    objects, walls: [], doors: [], analysis: emptyAnalysis(0),
  }
  const planned = autoPlanHall(layout, inventory.filter((unit) => unit.delivered), 'efficiency', rackCapacity)
  return { ...planned, analysis: analyzeHallLayout(planned, inventory, rackCapacity) }
}

export function autoPlanHall(
  layout: DataHallLayout,
  inventory: readonly HallRackUnit[],
  strategy: HallAutoLayoutStrategy,
  rackCapacity = Number.MAX_SAFE_INTEGER,
  options: { provisionUtilities?: boolean } = {},
): DataHallLayout {
  const shell = DATA_HALL_SHELLS[layout.shellId]
  const savedReservations = strategy === layout.preferredStrategy
    ? layout.objects.filter((object) => object.kind === 'rack' && object.reserved)
    : []
  const utilities = layout.objects.filter((object) => object.kind !== 'rack' && !object.id.includes(':auto-plan:'))
  if (options.provisionUtilities) {
    const delivered = inventory.filter((unit) => unit.delivered).slice(0, rackCapacity)
    const reserve = strategy === 'resilience' ? 1.35 : strategy === 'efficiency' ? 1.15 : 1.05
    const scale = rackCapacity >= 700 ? 8 : rackCapacity >= 200 ? 4 : 2
    const targetMw = Math.max(delivered.reduce((sum, unit) => sum + unit.mw, 0), rackCapacity * 0.012) * reserve
    const targetNetwork = Math.max(delivered.reduce((sum, unit) => sum + unit.networkGbps, 0), rackCapacity * 400) * reserve
    const targets = [
      { kind: 'power' as const, catalogId: 'ups-5mw', minimum: scale + (strategy === 'resilience' ? Math.ceil(scale / 2) : 0), capacity: targetMw, field: 'powerMw' as const },
      { kind: 'cooling' as const, catalogId: 'crac-2mw', minimum: scale + (strategy === 'resilience' ? Math.ceil(scale / 2) : 0), capacity: targetMw, field: 'coolingMw' as const },
      { kind: 'network' as const, catalogId: 'core-25t', minimum: Math.max(scale, Math.ceil(targetNetwork / 25_600)) + (strategy === 'resilience' ? 1 : 0), capacity: targetNetwork, field: 'networkGbps' as const },
    ]
    const occupied = new Uint8Array(shell.width * shell.depth)
    for (const object of utilities) for (const cell of rectCells(shell, object)) if (cell >= 0 && cell < occupied.length) occupied[cell] = 1
    const usedIds = new Set(utilities.map((object) => object.id))
    for (const target of targets) {
      const definition = HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === target.catalogId)!
      let count = utilities.filter((object) => object.kind === target.kind).length
      let capacity = utilities.filter((object) => object.kind === target.kind).reduce((sum, object) => sum + (HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId)?.[target.field] ?? 0), 0)
      let sequence = 1
      while (count < target.minimum || capacity + 1e-9 < target.capacity) {
        while (usedIds.has(`${layout.facilityId}:auto-plan:${target.kind}:${sequence}`)) sequence += 1
        const id = `${layout.facilityId}:auto-plan:${target.kind}:${sequence++}`
        let placed: DataHallObjectPlacement | undefined
        for (let z = 2; z + definition.depth < shell.depth - 2 && !placed; z += 2) {
          for (let x = 2; x + definition.width < shell.width - 2; x += 2) {
            const candidate = utilityPlacement(id, target.catalogId, x, z, definition.price)
            const cells = rectCells(shell, candidate)
            if (cells.some((cell) => occupied[cell])) continue
            if (previewHallObjectPlacement({ ...layout, objects: utilities }, candidate, rackCapacity) === 'invalid') continue
            placed = candidate
            cells.forEach((cell) => { occupied[cell] = 1 })
            break
          }
        }
        if (!placed) break
        utilities.push(placed)
        usedIds.add(id)
        count += 1
        capacity += definition[target.field] ?? 0
      }
    }
  }
  const occupied = new Uint8Array(shell.width * shell.depth)
  for (const object of utilities) for (const cell of rectCells(shell, object)) if (cell >= 0 && cell < occupied.length) occupied[cell] = 1
  const spacing = strategy === 'density' ? 1 : strategy === 'efficiency' ? 2 : 3
  const rowGap = strategy === 'density' ? 2 : strategy === 'efficiency' ? 5 : 7
  const units = inventory.filter((unit) => unit.delivered).slice(0, rackCapacity).sort((a, b) => a.unitId.localeCompare(b.unitId))
  const selectedUnitIds = new Set(units.map((unit) => unit.unitId))
  const preserveInstalled = !options.provisionUtilities && strategy === layout.preferredStrategy
  const racks: DataHallObjectPlacement[] = preserveInstalled
    ? layout.objects.filter((object) => object.kind === 'rack' && !object.reserved && object.rackUnitId && selectedUnitIds.has(object.rackUnitId))
    : []
  for (const rack of racks) {
    for (const cell of rectCells(shell, rack)) if (cell >= 0 && cell < occupied.length) occupied[cell] = 1
  }
  const assignedUnitIds = new Set(racks.flatMap((rack) => rack.rackUnitId ? [rack.rackUnitId] : []))
  const pendingUnits = units.filter((unit) => !assignedUnitIds.has(unit.unitId))
  const consumedReservations = new Set<string>()

  if (preserveInstalled) {
    for (const unit of pendingUnits.slice()) {
      if (racks.length >= rackCapacity) break
      const saved = savedReservations.find((reservation) => !consumedReservations.has(reservation.id))
      if (!saved) break
      consumedReservations.add(saved.id)
      const rack: DataHallObjectPlacement = {
        ...saved,
        id: `rack:${unit.unitId}`,
        catalogId: unit.skuId,
        rackUnitId: unit.unitId,
        reserved: undefined,
        purchasePrice: 0,
      }
      if (previewHallObjectPlacement({ ...layout, objects: [...utilities, ...racks] }, rack, rackCapacity) === 'invalid') continue
      for (const cell of rectCells(shell, rack)) occupied[cell] = 1
      racks.push(rack)
      assignedUnitIds.add(unit.unitId)
    }
  }
  const overflowUnits = pendingUnits.filter((unit) => !assignedUnitIds.has(unit.unitId))
  let cursor = 0
  for (let z = 10; z + 5 < shell.depth && cursor < overflowUnits.length; z += 5 + rowGap) {
    for (let x = 8; x + 3 < shell.width && cursor < overflowUnits.length; x += 3 + spacing) {
      const rack: DataHallObjectPlacement = { id: `rack:${overflowUnits[cursor]!.unitId}`, kind: 'rack', catalogId: overflowUnits[cursor]!.skuId, rackUnitId: overflowUnits[cursor]!.unitId, x, z, rotation: z % 2 === 0 ? 0 : 180, purchasePrice: 0 }
      const cells = rectCells(shell, rack)
      if (cells.some((cell) => occupied[cell])) continue
      if (previewHallObjectPlacement({ ...layout, objects: [...utilities, ...racks] }, rack, rackCapacity) === 'invalid') continue
      cells.forEach((cell) => { occupied[cell] = 1 })
      racks.push(rack)
      cursor += 1
    }
  }
  // Utilities or wide-aisle patterns can consume some preferred row slots.
  // Finish the rated plan with deterministic first-fit spaces rather than
  // silently leaving a partially planned hall.
  for (let z = 7; z + 5 < shell.depth && cursor < overflowUnits.length; z += 1) {
    for (let x = 4; x + 3 < shell.width && cursor < overflowUnits.length; x += 1) {
      const rack: DataHallObjectPlacement = { id: `rack:${overflowUnits[cursor]!.unitId}`, kind: 'rack', catalogId: overflowUnits[cursor]!.skuId, rackUnitId: overflowUnits[cursor]!.unitId, x, z, rotation: 0, purchasePrice: 0 }
      const cells = rectCells(shell, rack)
      if (cells.some((cell) => occupied[cell])) continue
      if (previewHallObjectPlacement({ ...layout, objects: [...utilities, ...racks] }, rack, rackCapacity) === 'invalid') continue
      cells.forEach((cell) => { occupied[cell] = 1 })
      racks.push(rack)
      cursor += 1
    }
  }
  // A saved capacity plan remains useful as inventory arrives. Actual racks
  // are placed first so they replace matching planned cabinets; only
  // collision-valid unused reservations are restored around them.
  const usedIds = new Set([...utilities, ...racks].map((object) => object.id))
  for (const saved of savedReservations) {
    if (racks.length >= rackCapacity || consumedReservations.has(saved.id) || usedIds.has(saved.id)) continue
    const reservation: DataHallObjectPlacement = { ...saved, rackUnitId: undefined, reserved: true }
    if (previewHallObjectPlacement({ ...layout, objects: [...utilities, ...racks] }, reservation, rackCapacity) === 'invalid') continue
    racks.push(reservation)
    usedIds.add(reservation.id)
  }
  return { ...layout, preferredStrategy: strategy, objects: [...utilities, ...racks], analysis: emptyAnalysis(layout.revision) }
}

export function migrateLegacyRackLayout(
  facilityId: string,
  shellId: DataHallShellId,
  inventory: readonly HallRackUnit[],
  rackCapacity: number,
): DataHallLayout {
  return createDefaultHallLayout(facilityId, shellId, inventory, rackCapacity)
}

function normalizeFleet(fleet: RackInstall[]): RackInstall[] {
  return fleet.map(ensureRackUnitIds)
}

export function migrateDataHallLayouts(state: SimState): SimState {
  const halls = facilityAnchorTiles(state).filter((tile) => isDcKind(tile.kind) && isDcAnchor(tile))
  const fleetsNormalized = (state.player.rackFleet ?? []).every((install) => install.unitIds?.length === install.count) &&
    state.rivals.every((rival) => (rival.rackFleet ?? []).every((install) => install.unitIds?.length === install.count))
  const layoutsComplete = halls.every((hall) => Boolean(state.dataHallLayouts?.[hall.campusId ?? `facility:${hall.x},${hall.y}`]))
  if (fleetsNormalized && layoutsComplete) return state
  let next: SimState = {
    ...state,
    player: { ...state.player, rackFleet: normalizeFleet(state.player.rackFleet ?? []) },
    rivals: state.rivals.map((rival) => ({ ...rival, rackFleet: normalizeFleet(rival.rackFleet ?? []) })),
  }
  const layouts = { ...(state.dataHallLayouts ?? {}) }
  for (const hall of halls) {
    const facilityId = hall.campusId ?? `facility:${hall.x},${hall.y}`
    if (layouts[facilityId]) continue
    const ownerId = hall.owner as LabId
    const fleet = ownerId === next.playerLabId ? next.player.rackFleet : next.rivals.find((rival) => rival.id === ownerId)?.rackFleet ?? []
    const withFacility = fleet.map((install) => install.x === hall.x && install.y === hall.y && !install.facilityId ? { ...install, facilityId } : install)
    if (ownerId === next.playerLabId) next = { ...next, player: { ...next.player, rackFleet: withFacility } }
    else next = { ...next, rivals: next.rivals.map((rival) => rival.id === ownerId ? { ...rival, rackFleet: withFacility } : rival) }
    const inventory = rackUnitsForFacility(next, facilityId, ownerId)
    layouts[facilityId] = migrateLegacyRackLayout(facilityId, shellIdForSize(hall.dcSize), inventory, hall.rackCapacity)
  }
  return { ...next, dataHallLayouts: layouts }
}

export function tickDataHallLayouts(state: SimState): SimState {
  let next = migrateDataHallLayouts(state)
  for (const hall of facilityAnchorTiles(next).filter((tile) => isDcKind(tile.kind) && isDcAnchor(tile))) {
    const facilityId = hall.campusId ?? `facility:${hall.x},${hall.y}`
    const layout = next.dataHallLayouts?.[facilityId]
    if (!layout) continue
    const inventory = rackUnitsForFacility(next, facilityId, hall.owner)
    const delivered = inventory.filter((unit) => unit.delivered)
    const placed = new Set(layout.objects.flatMap((object) => !object.reserved && object.rackUnitId ? [object.rackUnitId] : []))
    const missing = delivered.some((unit) => !placed.has(unit.unitId))
    if (layout.autoPlaceDeliveries && missing) {
      const planned = autoPlanHall(layout, inventory, layout.preferredStrategy, hall.rackCapacity)
      const gainsPlacement = planned.objects.some((object) => !object.reserved && object.rackUnitId && !placed.has(object.rackUnitId))
      // If the selected strategy cannot fit any more racks, leave the excess
      // in staging without churning the layout revision on every tick.
      if (!gainsPlacement) {
        if (hall.owner === next.playerLabId) {
          const id = `rack-staging-${facilityId}-${layout.revision}`
          if (!next.alerts.some((entry) => entry.id === id)) next = {
            ...next,
            alerts: [{ id, day: next.day, severity: 'warn' as const, message: `Some delivered racks remain staged at ${hall.name || 'a data hall'} because the saved auto-layout cannot place them.` }, ...next.alerts].slice(0, 40),
          }
        }
        continue
      }
      const updated = { ...planned, revision: layout.revision + 1 }
      const analysis = analyzeHallLayout(updated, inventory, hall.rackCapacity)
      next = { ...next, dataHallLayouts: { ...(next.dataHallLayouts ?? {}), [facilityId]: { ...updated, analysis } } }
    }
  }
  return next
}

/** Infrastructure cash delta for a draft. Racks are already paid inventory. */
export function quoteHallPlanNetCost(
  current: Pick<DataHallLayout, 'objects' | 'walls' | 'doors'>,
  candidate: Pick<DataHallLayout, 'objects' | 'walls' | 'doors'>,
): number {
  const objectKey = (object: DataHallObjectPlacement) => `object:${object.kind}:${object.catalogId}:${object.id}`
  const wallKey = (wall: DataHallWallSegment) => `wall:${wall.id}:${wall.x1},${wall.z1}:${wall.x2},${wall.z2}`
  const doorKey = (door: DataHallDoorPlacement) => `door:${door.id}:${door.wallId}:${door.width}`
  const keys = (layout: Pick<DataHallLayout, 'objects' | 'walls' | 'doors'>) => new Set([
    ...layout.objects.map(objectKey),
    ...layout.walls.map(wallKey),
    ...layout.doors.map(doorKey),
  ])
  const infrastructureValue = (layout: Pick<DataHallLayout, 'objects' | 'walls' | 'doors'>, excluded: Set<string>) =>
    layout.objects.reduce((sum, object) => {
      if (object.kind === 'rack' || excluded.has(objectKey(object))) return sum
      return sum + (HALL_EQUIPMENT_CATALOG.find((entry) => entry.id === object.catalogId && entry.kind === object.kind)?.price ?? 0)
    }, 0) +
    layout.walls.reduce((sum, wall) => excluded.has(wallKey(wall)) ? sum : sum + (Math.abs(wall.x2 - wall.x1) + Math.abs(wall.z2 - wall.z1)) * HALL_WALL_PRICE_PER_CELL, 0) +
    layout.doors.reduce((sum, door) => excluded.has(doorKey(door)) ? sum : sum + HALL_DOOR_PRICE, 0)
  const currentKeys = keys(current)
  const candidateKeys = keys(candidate)
  const added = infrastructureValue(candidate, currentKeys)
  const removed = infrastructureValue(current, candidateKeys)
  return added - Math.floor(removed * 0.5)
}

export function applyHallPlan(
  state: SimState,
  plan: DataHallEditPlan,
  ownerId: LabId = state.playerLabId,
): { state: SimState; ok: boolean; error?: string; netCost: number } {
  const current = state.dataHallLayouts?.[plan.facilityId]
  if (!current) return { state, ok: false, error: 'Data hall layout was not found.', netCost: 0 }
  if (current.revision !== plan.expectedRevision) return { state, ok: false, error: 'The hall changed while this plan was open. Reload the editor.', netCost: 0 }
  const hall = facilityAnchorTiles(state).find((tile) => (tile.campusId ?? `facility:${tile.x},${tile.y}`) === plan.facilityId)
  if (!hall || hall.owner !== ownerId) return { state, ok: false, error: 'You no longer own this data hall.', netCost: 0 }
  const inventory = rackUnitsForFacility(state, plan.facilityId, ownerId)
  const candidate: DataHallLayout = { ...current, preferredStrategy: plan.preferredStrategy ?? current.preferredStrategy, revision: current.revision + 1, objects: plan.objects, walls: plan.walls, doors: plan.doors, analysis: emptyAnalysis(current.revision + 1) }
  candidate.analysis = analyzeHallLayout(candidate, inventory, hall.rackCapacity)
  if (!candidate.analysis.valid) return { state, ok: false, error: candidate.analysis.hardErrors[0], netCost: 0 }
  // A negative net cost is a refund: removed infrastructure recovers half of
  // its recorded purchase price after any new construction is paid for.
  const netCost = quoteHallPlanNetCost(current, candidate)
  if (state.player.cash < netCost) return { state, ok: false, error: `Need $${(netCost / 1e6).toFixed(2)}M to apply this plan.`, netCost }
  const cash = state.player.cash - netCost
  return {
    ok: true,
    netCost,
    state: {
      ...state,
      dataHallLayouts: { ...(state.dataHallLayouts ?? {}), [plan.facilityId]: candidate },
      player: { ...state.player, cash, finance: { ...state.player.finance, cash } },
      labs: state.labs[state.playerLabId] ? { ...state.labs, [state.playerLabId]: { ...state.labs[state.playerLabId]!, cash, finance: { ...state.labs[state.playerLabId]!.finance, cash } } } : state.labs,
    },
  }
}

export function removeDataHallLayout(state: SimState, facilityId: string): SimState {
  if (!state.dataHallLayouts?.[facilityId]) return state
  const layouts = { ...state.dataHallLayouts }
  delete layouts[facilityId]
  return { ...state, dataHallLayouts: layouts }
}

export function refreshDataHallAnalysis(state: SimState, facilityId: string): SimState {
  const layout = state.dataHallLayouts?.[facilityId]
  const hall = facilityAnchorTiles(state).find((tile) => (tile.campusId ?? `facility:${tile.x},${tile.y}`) === facilityId)
  if (!layout || !hall) return state
  const inventory = rackUnitsForFacility(state, facilityId, hall.owner)
  const analysis = analyzeHallLayout(layout, inventory, hall.rackCapacity)
  return { ...state, dataHallLayouts: { ...(state.dataHallLayouts ?? {}), [facilityId]: { ...layout, analysis } } }
}

export function refreshAllDataHallAnalyses(state: SimState): SimState {
  let next = state
  for (const facilityId of Object.keys(state.dataHallLayouts ?? {})) next = refreshDataHallAnalysis(next, facilityId)
  return next
}

export function hallInfrastructureValue(layout?: DataHallLayout): number {
  if (!layout) return 0
  return layout.objects.filter((object) => object.kind !== 'rack').reduce((sum, object) => sum + object.purchasePrice * 0.65, 0) +
    layout.walls.reduce((sum, wall) => sum + wall.purchasePrice * 0.5, 0) + layout.doors.reduce((sum, door) => sum + door.purchasePrice * 0.5, 0)
}

export function playerHallPueMultiplier(state: SimState): number {
  const playerFacilityIds = new Set(
    facilityAnchorTiles(state, { ownerId: state.playerLabId })
      .filter((hall) => isDcKind(hall.kind) && isDcAnchor(hall))
      .map((hall) => hall.campusId ?? `facility:${hall.x},${hall.y}`),
  )
  const layouts = Object.values(state.dataHallLayouts ?? {}).filter((layout) => playerFacilityIds.has(layout.facilityId))
  let racks = 0
  let weighted = 0
  for (const layout of layouts) {
    const count = layout.analysis.operationalRackUnitIds.length
    if (count <= 0) continue
    racks += count
    weighted += count * layout.analysis.pueMultiplier
  }
  return racks > 0 ? weighted / racks : 1
}

export const HALL_WALL_PRICE_PER_CELL = 18_000
export const HALL_DOOR_PRICE = 95_000

export function createWall(id: string, x1: number, z1: number, x2: number, z2: number): DataHallWallSegment {
  return { id, x1, z1, x2, z2, purchasePrice: (Math.abs(x2 - x1) + Math.abs(z2 - z1)) * HALL_WALL_PRICE_PER_CELL }
}

export function createDoor(id: string, wallId: string, offset: number, width = 4): DataHallDoorPlacement {
  return { id, wallId, offset, width, purchasePrice: HALL_DOOR_PRICE }
}

export function rotateHallObject(object: DataHallObjectPlacement): DataHallObjectPlacement {
  const rotation = ((object.rotation + 90) % 360) as HallRotation
  return { ...object, rotation }
}
