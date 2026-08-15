import { getChipDef } from '../balance/chips'
import { getRackSku } from '../balance/rackSkus'
import {
  CHASSIS_CATALOG,
  getChassis,
  getModule,
  modelTrainVramGb,
  modelVramGb,
  MODULE_CATALOG,
  scoreDesign,
} from '../balance/racks'
import {
  estimateTrainingMemoryGb,
  LEGACY_TRAINING_NUMERICS,
} from '../balance/trainingPrecision'
import type { PlacedModule, RackDesign, RackSku, SimState } from '../types'
import {
  dataHallComputeMultiplier,
  isDcKind,
  isDcAnchor,
  mapTileAt,
} from './map'
import { seededId } from '../rng'
import { ensureRackUnitIds } from './dataHallLayouts'
import { servingPlacementNeed } from './servingPlacement'

/** Blueprint → orderable custom SKU (kept here to avoid rackSkus ↔ racks cycle). */
export function designToSku(design: RackDesign): RackSku | null {
  const st = scoreDesign(design)
  if (!st.valid) return null
  const chassis = getChassis(design.chassisId)
  return {
    id: `design:${design.id}`,
    name: design.name,
    blurb: `Custom ${chassis.name} blueprint — ${st.gpuCount} GPU · ${st.vramGb}GB`,
    generation: 2,
    rackUnits: chassis.rackUnits,
    flopsPf: st.flopsPf,
    vramGb: st.vramGb,
    systemRamGb: st.systemRamGb,
    cpuScore: st.cpuScore,
    networkGbps: st.networkGbps,
    mw: st.mw,
    tokPerSec: st.tokPerSec,
    accelerator: {
      deviceCount: Math.max(1, st.gpuCount),
      generation: 2,
      fp32TfPerDevice: (st.flopsPf * 1_000) / Math.max(1, st.gpuCount) / 16,
      fp16Bf16TfPerDevice: (st.flopsPf * 1_000) / Math.max(1, st.gpuCount),
      fp8TfPerDevice: (st.flopsPf * 2_000) / Math.max(1, st.gpuCount),
      fp4TfPerDevice: 0,
      hbmGbPerDevice: st.vramGb / Math.max(1, st.gpuCount),
      hbmBandwidthTbPerSecPerDevice: 3,
      interconnectGbps: st.networkGbps,
      idleMw: st.mw * 0.3,
      maxMw: st.mw,
      hostOverheadMw: st.mw * 0.08,
      supportedTrainingFormats: ['fp32', 'fp16_mixed', 'bf16_mixed', 'fp8_hybrid'],
      supportedServePrecisions: ['fp16', 'bf16', 'fp8', 'int8', 'int4', 'ternary_1_58'],
    },
    price: Math.max(chassis.baseCost, Math.round(st.buildCost)),
    leadTimeDays: 5,
    sellBackRate: 0.35,
    custom: true,
  }
}

export function resolveRackSku(id: string, designs: RackDesign[] = []): RackSku {
  if (id.startsWith('design:')) {
    const designId = id.slice('design:'.length)
    const design = designs.find((d) => d.id === designId)
    if (design) {
      const sku = designToSku(design)
      if (sku) return sku
    }
    throw new Error(`Unknown design rack ${id}`)
  }
  return getRackSku(id)
}

export function emptyDesign(chassisId: string, name?: string): RackDesign {
  return {
    id: `design-${Date.now().toString(36)}`,
    name: name ?? getChassis(chassisId).name,
    chassisId,
    placements: [],
  }
}

export function saveRackDesign(state: SimState, design: RackDesign): SimState {
  const stats = scoreDesign(design)
  if (!stats.valid) {
    return alert(state, 'warn', stats.errors[0] ?? 'Invalid design')
  }
  const existing = state.player.rackDesigns.findIndex((d) => d.id === design.id)
  const designs = [...state.player.rackDesigns]
  if (existing >= 0) designs[existing] = design
  else designs.push(design)

  return {
    ...state,
    player: { ...state.player, rackDesigns: designs },
    alerts: [
      {
        id: `design-save-${design.id}`,
        day: state.day,
        severity: 'info' as const,
        message: `Blueprint saved: ${design.name} (${stats.gpuCount} GPU · ${stats.vramGb}GB VRAM · ${stats.flopsPf.toFixed(2)} PF)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function deleteRackDesign(state: SimState, designId: string): SimState {
  if (state.player.deployedRacks.some((d) => d.designId === designId && d.count > 0)) {
    return alert(state, 'warn', 'Undeploy all copies before deleting blueprint.')
  }
  return {
    ...state,
    player: {
      ...state.player,
      rackDesigns: state.player.rackDesigns.filter((d) => d.id !== designId),
    },
  }
}

export function buyModules(state: SimState, moduleId: string, count: number): SimState {
  const mod = getModule(moduleId)
  const total = mod.cost * count
  if (count <= 0 || state.player.cash < total) {
    return alert(state, 'warn', state.player.cash < total ? 'Insufficient cash.' : 'Invalid qty')
  }
  const stock = state.player.moduleStock.map((s) => ({ ...s }))
  let row = stock.find((s) => s.moduleId === moduleId)
  if (!row) {
    row = { moduleId, count: 0 }
    stock.push(row)
  }
  row.count += count
  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - total,
      moduleStock: stock,
    },
    alerts: [
      {
        id: `mod-buy-${state.day}-${moduleId}`,
        day: state.day,
        severity: 'info' as const,
        message: `Bought ${count}× ${mod.name} ($${(total / 1000).toFixed(0)}k)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function deployRacks(state: SimState, designId: string, count: number): SimState {
  if (count <= 0) return state
  const design = state.player.rackDesigns.find((d) => d.id === designId)
  if (!design) return alert(state, 'warn', 'Blueprint not found')
  const stats = scoreDesign(design)
  if (!stats.valid) return alert(state, 'warn', stats.errors[0] ?? 'Fix design first')

  const chassis = getChassis(design.chassisId)
  const need = new Map<string, number>()
  for (const p of design.placements) {
    need.set(p.moduleId, (need.get(p.moduleId) ?? 0) + count)
  }
  for (const [mid, qty] of need) {
    const have = state.player.moduleStock.find((s) => s.moduleId === mid)?.count ?? 0
    if (have < qty) {
      return alert(
        state,
        'warn',
        `Need ${qty}× ${getModule(mid).name}, have ${have}. Buy modules first.`,
      )
    }
  }

  const chassisCost = chassis.baseCost * count
  if (state.player.cash < chassisCost) {
    return alert(state, 'warn', `Need $${(chassisCost / 1000).toFixed(0)}k for chassis shells.`)
  }

  let stock = state.player.moduleStock.map((s) => ({ ...s }))
  for (const [mid, qty] of need) {
    const row = stock.find((s) => s.moduleId === mid)!
    row.count -= qty
  }
  stock = stock.filter((s) => s.count > 0)

  const deployed = state.player.deployedRacks.map((d) => ({ ...d }))
  let group = deployed.find((d) => d.designId === designId)
  if (!group) {
    group = { designId, count: 0 }
    deployed.push(group)
  }
  group.count += count

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - chassisCost,
      moduleStock: stock,
      deployedRacks: deployed,
    },
    alerts: [
      {
        id: `deploy-${state.day}-${designId}`,
        day: state.day,
        severity: 'info' as const,
        message: `Deployed ${count}× ${design.name} (+${stats.vramGb * count}GB VRAM, +${(stats.flopsPf * count).toFixed(1)} PF)`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function undeployRacks(state: SimState, designId: string, count: number): SimState {
  const deployed = state.player.deployedRacks.map((d) => ({ ...d }))
  const group = deployed.find((d) => d.designId === designId)
  if (!group || group.count < count) return alert(state, 'warn', 'Not enough deployed units')
  group.count -= count
  return {
    ...state,
    player: {
      ...state.player,
      deployedRacks: deployed.filter((d) => d.count > 0),
    },
    alerts: [
      {
        id: `undeploy-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Decommissioned ${count} rack(s). Modules written off.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export interface FleetStats {
  flopsPf: number
  vramGb: number
  systemRamGb: number
  /** Host CPU score (SKU/cpu modules) — research + prefill */
  cpuScore: number
  mw: number
  idleMw: number
  tokPerSec: number
  gpuCount: number
  rackUnitsUsed: number
  designs: {
    designId: string
    name: string
    count: number
    stats: ReturnType<typeof scoreDesign>
  }[]
}

export function fleetStats(state: SimState): FleetStats {
  let flopsPf = 0
  let vramGb = 0
  let systemRamGb = 0
  let cpuScore = 0
  let mw = 0
  let idleMw = 0
  let tokPerSec = 0
  let gpuCount = 0
  let rackUnitsUsed = 0
  const designRows: FleetStats['designs'] = []
  const blueprints = state.player.rackDesigns ?? []

  // Primary: complete racks ordered into data halls (skip powered-down halls)
  const fleet = state.player.rackFleet ?? []
  for (const r of fleet) {
    if (r.status !== 'live' || r.count <= 0) continue
    const hall = mapTileAt(state, r.x, r.y)
    if (hall && (isDcKind(hall.kind) && isDcAnchor(hall)) && hall.powered === false) continue
    const sku = resolveRackSku(r.skuId, blueprints)
    const hallCompute = hall ? dataHallComputeMultiplier(hall) : 1
    const normalized = ensureRackUnitIds(r)
    const facilityId = r.facilityId ?? hall?.campusId
    const layout = facilityId ? state.dataHallLayouts?.[facilityId] : undefined
    const operational = layout ? new Set(layout.analysis.operationalRackUnitIds) : null
    const placed = layout ? new Set(layout.objects.flatMap((object) => object.rackUnitId ? [object.rackUnitId] : [])) : null
    const unitIds = normalized.unitIds ?? []
    const activeCount = operational
      ? unitIds.filter((unitId) => operational.has(unitId)).length
      : r.count
    const placedCount = placed
      ? unitIds.filter((unitId) => placed.has(unitId)).length
      : r.count
    // A persisted layout is authoritative: disconnected or inaccessible racks
    // never resurrect at partial throughput. Legacy layouts are repaired during
    // save migration before this aggregation runs.
    const environmentThroughput = layout?.analysis.throughputMultiplier ?? 1
    if (activeCount <= 0) continue
    const ram = sku.systemRamGb ?? sku.vramGb * 4
    const cpu = sku.cpuScore ?? Math.max(8, sku.flopsPf * 50)
    flopsPf += sku.flopsPf * activeCount * hallCompute * environmentThroughput
    vramGb += sku.vramGb * activeCount
    systemRamGb += ram * activeCount
    cpuScore += cpu * activeCount
    mw += sku.mw * activeCount
    idleMw += (sku.accelerator?.idleMw ?? sku.mw * 0.3) * activeCount
    tokPerSec += sku.tokPerSec * activeCount * hallCompute * environmentThroughput
    gpuCount += (sku.accelerator?.deviceCount ?? 1) * activeCount
    rackUnitsUsed += (r.rackUnits || sku.rackUnits) * Math.max(placedCount, activeCount)
    const existing = designRows.find((d) => d.designId === r.skuId)
    if (existing) {
      existing.count += activeCount
    } else {
      designRows.push({
        designId: r.skuId,
        name: sku.name,
        count: activeCount,
        stats: {
          flopsPf: sku.flopsPf,
          vramGb: sku.vramGb,
          systemRamGb: ram,
          cpuScore: cpu,
          networkGbps: sku.networkGbps ?? sku.accelerator?.interconnectGbps ?? 0,
          mw: sku.mw,
          coolingMw: sku.mw * 0.3,
          psuMw: sku.mw * 1.1,
          tokPerSec: sku.tokPerSec,
          gpuCount: sku.accelerator?.deviceCount ?? 1,
          buildCost: sku.price,
          valid: true,
          errors: [],
        },
      })
    }
  }

  // Legacy designer deploys (old saves)
  for (const dep of state.player.deployedRacks) {
    const design = blueprints.find((d) => d.id === dep.designId)
    if (!design || dep.count <= 0) continue
    const st = scoreDesign(design)
    const chassis = getChassis(design.chassisId)
    flopsPf += st.flopsPf * dep.count
    vramGb += st.vramGb * dep.count
    systemRamGb += st.systemRamGb * dep.count
    cpuScore += Math.max(4, st.gpuCount * 8) * dep.count
    mw += st.mw * dep.count
    idleMw += st.mw * 0.3 * dep.count
    tokPerSec += st.tokPerSec * dep.count
    gpuCount += st.gpuCount * dep.count
    rackUnitsUsed += chassis.rackUnits * dep.count
    designRows.push({ designId: design.id, name: design.name, count: dep.count, stats: st })
  }

  // Legacy loose chips (tests / fab) — still count until migrated
  for (const inv of state.player.chips) {
    const def = getChipDef(inv.defId)
    flopsPf += inv.count * def.flopsPf
    vramGb += inv.count * 80
    systemRamGb += inv.count * 128
    cpuScore += inv.count * 12
    mw += inv.count * def.mwPerChip
    idleMw += inv.count * def.mwPerChip * 0.3
    tokPerSec += inv.count * def.tokPerSec
    gpuCount += inv.count
    rackUnitsUsed += inv.count
  }

  // Ordered (in-flight) racks reserve bay slots
  for (const r of fleet) {
    if (r.status !== 'ordered' || r.count <= 0) continue
    const sku = resolveRackSku(r.skuId, blueprints)
    rackUnitsUsed += (r.rackUnits || sku.rackUnits) * r.count
  }

  return {
    flopsPf,
    vramGb,
    systemRamGb,
    cpuScore,
    mw,
    idleMw,
    tokPerSec,
    gpuCount,
    rackUnitsUsed,
    designs: designRows,
  }
}

export function placeModule(
  design: RackDesign,
  slotId: string,
  moduleId: string,
): { design: RackDesign; error?: string } {
  const chassis = getChassis(design.chassisId)
  const slot = chassis.slots.find((s) => s.id === slotId)
  if (!slot) return { design, error: 'Bad slot' }
  const mod = getModule(moduleId)
  if (mod.slotSize > slot.size) {
    return { design, error: `${mod.name} needs a size-${mod.slotSize} bay` }
  }
  if (design.placements.some((p) => p.slotId === slotId)) {
    return { design, error: 'Slot occupied — clear it first' }
  }
  const placements: PlacedModule[] = [
    ...design.placements,
    {
      instanceId: seededId('placed-module', design.id, slotId, moduleId, design.placements.length),
      moduleId,
      slotId,
    },
  ]
  return { design: { ...design, placements } }
}

export function clearSlot(design: RackDesign, slotId: string): RackDesign {
  return {
    ...design,
    placements: design.placements.filter((p) => p.slotId !== slotId),
  }
}

export function vramPressure(
  state: SimState,
  mode: 'train' | 'serve',
): {
  needGb: number
  haveGb: number
  derate: number
  systemRamNeedGb?: number
  systemRamHaveGb?: number
  systemRamDerate?: number
  modelName?: string
} {
  const fleet = fleetStats(state)
  if (mode === 'train') {
    const listed = state.player.trainingJobs ?? []
    const legacy = state.player.trainingJob
    const jobs = legacy
      ? [legacy, ...listed.filter((job) => job.id !== legacy.id)]
      : listed
    const activeJobs = jobs.filter((job) => !job.paused)
    const safetyModel = state.player.safetyCampaign
      ? state.player.models.find(
          (model) => model.id === state.player.safetyCampaign!.modelId,
        )
      : undefined
    if (activeJobs.length === 0 && !safetyModel) {
      return { needGb: 0, haveGb: fleet.vramGb, derate: 1 }
    }
    const activationCheckpointing = state.player.researchUnlocked.includes('opt_checkpoint')
    let need = activeJobs.reduce(
      (sum, job) =>
        sum +
        estimateTrainingMemoryGb({
          paramsB: job.targetParamsB,
          activeParamsB: job.activeParamsB,
          family: job.family,
          numerics:
            job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
          activationCheckpointing,
        }).totalGb,
      0,
    )
    if (safetyModel) {
      need += estimateTrainingMemoryGb({
        paramsB: safetyModel.paramsB,
        activeParamsB: safetyModel.activeParamsB,
        family: safetyModel.family,
        numerics: safetyModel.trainingNumerics ?? LEGACY_TRAINING_NUMERICS,
        activationCheckpointing,
      }).totalGb
    }
    const residentNames = [
      ...activeJobs.map((job) => job.name),
      ...(safetyModel ? [`${safetyModel.name} safety`] : []),
    ]
    const have = fleet.vramGb
    return {
      needGb: need,
      haveGb: have,
      derate: need <= 0 ? 1 : Math.min(1, have / need),
      modelName:
        residentNames.length === 1
          ? residentNames[0]
          : `${residentNames[0]} + ${residentNames.length - 1} more`,
    }
  }
  const placement = servingPlacementNeed(state)
  const need = placement.hbmNeedGb
  const have = fleet.vramGb
  const systemRamNeed = placement.systemRamNeedGb
  const systemRamHave = fleet.systemRamGb
  const derate = need <= 0 ? 1 : Math.min(1, have / need)
  return {
    needGb: need,
    haveGb: have,
    derate,
    systemRamNeedGb: systemRamNeed,
    systemRamHaveGb: systemRamHave,
    systemRamDerate:
      systemRamNeed <= 0 ? 1 : Math.min(1, systemRamHave / systemRamNeed),
    modelName:
      placement.placements.length === 1
        ? placement.placements[0]!.model.name
        : placement.placements.length > 1
          ? `${placement.placements[0]!.model.name} + ${placement.placements.length - 1} more`
          : undefined,
  }
}

function alert(state: SimState, severity: 'info' | 'warn' | 'danger', message: string): SimState {
  return {
    ...state,
    alerts: [
      { id: `rk-${state.day}-${message.slice(0, 14)}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export { CHASSIS_CATALOG, MODULE_CATALOG, scoreDesign, modelVramGb, modelTrainVramGb, getModule, getChassis }
