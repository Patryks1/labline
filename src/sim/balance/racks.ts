import type {
  ChassisDef,
  ModuleDef,
  RackDesign,
  RackDesignStats,
  TrainingNumerics,
} from '../types'
import { RACK_PF_MULTIPLIER } from './rackSkus'
import {
  estimateTrainingMemoryGb,
  LEGACY_TRAINING_NUMERICS,
} from './trainingPrecision'

/** Grid is 6 columns × N rows of 1×1 cells; larger slots span cells. */
export const CHASSIS_CATALOG: ChassisDef[] = [
  {
    id: 'case_4u',
    name: '4U Edge Case',
    blurb: 'Compact. Few bays — great for inference edges.',
    baseCost: 18_000,
    maxMw: 0.004,
    rackUnits: 1,
    slots: [
      { id: 'a1', size: 2, col: 0, row: 0, w: 3, h: 2 },
      { id: 'a2', size: 2, col: 3, row: 0, w: 3, h: 2 },
      { id: 'b1', size: 1, col: 0, row: 2, w: 2, h: 1 },
      { id: 'b2', size: 1, col: 2, row: 2, w: 2, h: 1 },
      { id: 'b3', size: 1, col: 4, row: 2, w: 2, h: 1 },
      { id: 'c1', size: 1, col: 0, row: 3, w: 3, h: 1 },
      { id: 'c2', size: 1, col: 3, row: 3, w: 3, h: 1 },
    ],
  },
  {
    id: 'case_8u',
    name: '8U Train Node',
    blurb: 'Balanced mid-size. Room for GPUs + HBM + cooling.',
    baseCost: 42_000,
    maxMw: 0.012,
    rackUnits: 1,
    slots: [
      { id: 'g1', size: 2, col: 0, row: 0, w: 3, h: 2 },
      { id: 'g2', size: 2, col: 3, row: 0, w: 3, h: 2 },
      { id: 'g3', size: 2, col: 0, row: 2, w: 3, h: 2 },
      { id: 'g4', size: 2, col: 3, row: 2, w: 3, h: 2 },
      { id: 'm1', size: 1, col: 0, row: 4, w: 2, h: 1 },
      { id: 'm2', size: 1, col: 2, row: 4, w: 2, h: 1 },
      { id: 'm3', size: 1, col: 4, row: 4, w: 2, h: 1 },
      { id: 'm4', size: 1, col: 0, row: 5, w: 2, h: 1 },
      { id: 'm5', size: 1, col: 2, row: 5, w: 2, h: 1 },
      { id: 'm6', size: 1, col: 4, row: 5, w: 2, h: 1 },
      { id: 's1', size: 1, col: 0, row: 6, w: 3, h: 1 },
      { id: 's2', size: 1, col: 3, row: 6, w: 3, h: 1 },
      { id: 'x1', size: 4, col: 0, row: 7, w: 6, h: 2 },
    ],
  },
  {
    id: 'case_12u',
    name: '12U Dense Pod',
    blurb: 'Max pack density. Needs serious cooling + PSU.',
    baseCost: 95_000,
    maxMw: 0.028,
    rackUnits: 2,
    slots: [
      { id: 'g1', size: 2, col: 0, row: 0, w: 3, h: 2 },
      { id: 'g2', size: 2, col: 3, row: 0, w: 3, h: 2 },
      { id: 'g3', size: 2, col: 0, row: 2, w: 3, h: 2 },
      { id: 'g4', size: 2, col: 3, row: 2, w: 3, h: 2 },
      { id: 'g5', size: 2, col: 0, row: 4, w: 3, h: 2 },
      { id: 'g6', size: 2, col: 3, row: 4, w: 3, h: 2 },
      { id: 'g7', size: 2, col: 0, row: 6, w: 3, h: 2 },
      { id: 'g8', size: 2, col: 3, row: 6, w: 3, h: 2 },
      { id: 'm1', size: 1, col: 0, row: 8, w: 2, h: 1 },
      { id: 'm2', size: 1, col: 2, row: 8, w: 2, h: 1 },
      { id: 'm3', size: 1, col: 4, row: 8, w: 2, h: 1 },
      { id: 'm4', size: 1, col: 0, row: 9, w: 2, h: 1 },
      { id: 'm5', size: 1, col: 2, row: 9, w: 2, h: 1 },
      { id: 'm6', size: 1, col: 4, row: 9, w: 2, h: 1 },
      { id: 'm7', size: 1, col: 0, row: 10, w: 2, h: 1 },
      { id: 'm8', size: 1, col: 2, row: 10, w: 2, h: 1 },
      { id: 'c1', size: 1, col: 4, row: 10, w: 2, h: 1 },
      { id: 'x1', size: 4, col: 0, row: 11, w: 3, h: 2 },
      { id: 'x2', size: 4, col: 3, row: 11, w: 3, h: 2 },
      { id: 'p1', size: 2, col: 0, row: 13, w: 6, h: 1 },
    ],
  },
]

export const MODULE_CATALOG: ModuleDef[] = [
  // GPUs
  {
    id: 'gpu_h100',
    name: 'Aether-H100',
    kind: 'gpu',
    slotSize: 2,
    cost: 32_000,
    blurb: '80GB HBM. Solid all-rounder.',
    flopsPf: 0.4,
    vramGb: 80,
    mw: 0.0007,
    tokPerSec: 1200,
    color: '#4da3ff',
  },
  {
    id: 'gpu_h200',
    name: 'Aether-H200',
    kind: 'gpu',
    slotSize: 2,
    cost: 48_000,
    blurb: '141GB HBM. Better for large weights.',
    flopsPf: 0.7,
    vramGb: 141,
    mw: 0.00075,
    tokPerSec: 2200,
    color: '#38bdf8',
  },
  {
    id: 'gpu_b200',
    name: 'Aether-B200',
    kind: 'gpu',
    slotSize: 2,
    cost: 72_000,
    blurb: '192GB class. Frontier packing.',
    flopsPf: 1.4,
    vramGb: 192,
    mw: 0.001,
    tokPerSec: 4800,
    color: '#818cf8',
  },
  {
    id: 'gpu_slim',
    name: 'Infer-Slim 1U',
    kind: 'gpu',
    slotSize: 1,
    cost: 14_000,
    blurb: 'Low-profile accelerator. Less FLOPS, fits 1-slots.',
    flopsPf: 0.15,
    vramGb: 24,
    mw: 0.00025,
    tokPerSec: 600,
    color: '#67e8f9',
  },
  // RAM / HBM expanders
  {
    id: 'ram_64',
    name: 'HBM tray 64GB',
    kind: 'ram',
    slotSize: 1,
    cost: 6_500,
    blurb: 'Extra device memory pool for weight sharding.',
    vramGb: 64,
    mw: 0.00005,
    color: '#3dffc0',
  },
  {
    id: 'ram_128',
    name: 'HBM tray 128GB',
    kind: 'ram',
    slotSize: 1,
    cost: 12_000,
    blurb: 'Dense memory for giant checkpoints.',
    vramGb: 128,
    mw: 0.00008,
    color: '#34d399',
  },
  {
    id: 'ram_256',
    name: 'HBM tray 256GB',
    kind: 'ram',
    slotSize: 2,
    cost: 28_000,
    blurb: 'Fat memory bay. Costs a 2-slot.',
    vramGb: 256,
    mw: 0.00012,
    color: '#10b981',
  },
  {
    id: 'sys_ram_512',
    name: 'Host DRAM 512GB',
    kind: 'ram',
    slotSize: 1,
    cost: 4_200,
    blurb: 'CPU-side RAM for data pipeline / offload.',
    systemRamGb: 512,
    mw: 0.00004,
    color: '#6ee7b7',
  },
  // CPU
  {
    id: 'cpu_std',
    name: 'Host CPU',
    kind: 'cpu',
    slotSize: 1,
    cost: 3_800,
    blurb: 'Required for I/O. One per chassis recommended.',
    systemRamGb: 64,
    cpuScore: 12,
    mw: 0.00015,
    color: '#fbbf24',
  },
  {
    id: 'cpu_pro',
    name: 'Host CPU Pro',
    kind: 'cpu',
    slotSize: 1,
    cost: 7_500,
    blurb: 'Faster data feed → slight train util.',
    systemRamGb: 128,
    cpuScore: 24,
    mw: 0.00022,
    color: '#f59e0b',
  },
  // Cooling
  {
    id: 'cool_air',
    name: 'Air cooler bay',
    kind: 'cooling',
    slotSize: 1,
    cost: 1_200,
    blurb: 'Budget cooling. ~1.2 kW capacity.',
    coolingMw: 0.0012,
    color: '#94a3b8',
  },
  {
    id: 'cool_liquid',
    name: 'Liquid loop',
    kind: 'cooling',
    slotSize: 1,
    cost: 4_800,
    blurb: 'Cold plate loop. ~4 kW.',
    coolingMw: 0.004,
    color: '#64748b',
  },
  {
    id: 'cool_immersion',
    name: 'Immersion block',
    kind: 'cooling',
    slotSize: 2,
    cost: 18_000,
    blurb: 'Immersion cassette. ~12 kW.',
    coolingMw: 0.012,
    color: '#475569',
  },
  {
    id: 'cool_mega',
    name: 'CDU cartridge',
    kind: 'cooling',
    slotSize: 4,
    cost: 45_000,
    blurb: 'Chassis-scale CDU. ~25 kW.',
    coolingMw: 0.025,
    color: '#334155',
  },
  // PSU / NIC
  {
    id: 'psu_3k',
    name: 'PSU 3kW',
    kind: 'psu',
    slotSize: 1,
    cost: 2_200,
    blurb: 'Power delivery. Need capacity ≥ heat draw.',
    psuMw: 0.003,
    color: '#fb7185',
  },
  {
    id: 'psu_8k',
    name: 'PSU 8kW',
    kind: 'psu',
    slotSize: 2,
    cost: 6_500,
    blurb: 'High-watt feed for dense GPU trays.',
    psuMw: 0.008,
    color: '#f43f5e',
  },
  {
    id: 'nic_400',
    name: '400G NIC',
    kind: 'nic',
    slotSize: 1,
    cost: 3_200,
    blurb: 'Cluster fabric. Helps multi-node train slightly.',
    mw: 0.00005,
    networkGbps: 400,
    color: '#c084fc',
  },
]

export function getChassis(id: string): ChassisDef {
  const c = CHASSIS_CATALOG.find((x) => x.id === id)
  if (!c) throw new Error(`Unknown chassis ${id}`)
  return c
}

export function getModule(id: string): ModuleDef {
  const m = MODULE_CATALOG.find((x) => x.id === id)
  if (!m) throw new Error(`Unknown module ${id}`)
  return m
}

export function scoreDesign(design: RackDesign): RackDesignStats {
  const chassis = getChassis(design.chassisId)
  const errors: string[] = []
  const used = new Set<string>()

  let flopsPf = 0
  let vramGb = 0
  let systemRamGb = 0
  let cpuScore = 0
  let networkGbps = 0
  let mw = 0
  let coolingMw = 0
  let psuMw = 0
  let tokPerSec = 0
  let gpuCount = 0
  let buildCost = chassis.baseCost

  for (const p of design.placements) {
    if (used.has(p.slotId)) {
      errors.push(`Slot ${p.slotId} double-booked`)
      continue
    }
    used.add(p.slotId)
    const slot = chassis.slots.find((s) => s.id === p.slotId)
    if (!slot) {
      errors.push(`Missing slot ${p.slotId}`)
      continue
    }
    const mod = getModule(p.moduleId)
    if (mod.slotSize > slot.size) {
      errors.push(`${mod.name} needs size ${mod.slotSize}, slot is ${slot.size}`)
      continue
    }
    buildCost += mod.cost
    flopsPf += mod.flopsPf ?? 0
    vramGb += mod.vramGb ?? 0
    systemRamGb += mod.systemRamGb ?? 0
    cpuScore += mod.cpuScore ?? 0
    networkGbps += mod.networkGbps ?? 0
    mw += mod.mw ?? 0
    coolingMw += mod.coolingMw ?? 0
    psuMw += mod.psuMw ?? 0
    tokPerSec += mod.tokPerSec ?? 0
    if (mod.kind === 'gpu') gpuCount += 1
  }

  if (gpuCount === 0) errors.push('Add at least one GPU / accelerator')
  if (coolingMw + 1e-9 < mw) {
    errors.push(
      `Cooling short ${(mw * 1000).toFixed(1)} kW draw vs ${(coolingMw * 1000).toFixed(1)} kW cool`,
    )
  }
  if (psuMw + 1e-9 < mw) {
    errors.push(
      `PSU short ${(mw * 1000).toFixed(1)} kW draw vs ${(psuMw * 1000).toFixed(1)} kW supply`,
    )
  }
  if (mw > chassis.maxMw + 1e-9) {
    errors.push(`Chassis thermal limit ${(chassis.maxMw * 1000).toFixed(1)} kW exceeded`)
  }
  const hasCpu = design.placements.some((p) => getModule(p.moduleId).kind === 'cpu')
  if (!hasCpu) errors.push('Add a host CPU')

  return {
    flopsPf: flopsPf * RACK_PF_MULTIPLIER,
    vramGb,
    systemRamGb,
    cpuScore,
    networkGbps,
    mw,
    coolingMw,
    psuMw,
    tokPerSec,
    gpuCount,
    buildCost,
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Rough VRAM need for a model (GB).
 * FP16 weights ≈ 2 bytes/param.
 * MoE: experts mostly resident (total) + hot active path / activations.
 * Hosting *compute* (PF) uses active only — see modelHostNeed.
 */
/** Bytes per parameter for a serving precision. */
export function servePrecisionBytes(precision: string = 'fp16'): number {
  switch (precision) {
    case 'fp32':
      return 4
    case 'bf16':
    case 'fp16':
      return 2
    case 'fp8':
    case 'int8':
      return 1
    case 'nvfp4':
    case 'int4':
      return 0.5
    case 'ternary_1_58':
      return 0.2
    default:
      return 2
  }
}

/**
 * Rough VRAM need for a model (GB).
 * Dense uses total params; MoE uses active + 0.5*(total-active) resident experts.
 * Precision scales bytes/weight; KV-cache + workspace are shared headroom.
 */
export function modelVramGb(
  paramsB: number,
  activeParamsB?: number,
  family?: string,
  precision: string = 'fp16',
): number {
  const bytes = servePrecisionBytes(precision)
  const total = Math.max(0.01, paramsB)
  const active = Math.max(0.01, activeParamsB ?? total)
  const isMoe = family === 'moe' && activeParamsB != null
  // MoE: offloaded experts count half toward resident memory.
  const residentB = isMoe ? active + 0.5 * Math.max(0, total - active) : total
  const weightGb = (residentB * 1e9 * bytes) / (1024 ** 3)
  const kvCacheGb = Math.max(2, active * 0.35 * (bytes / 2))
  const workspaceGb = Math.max(4, active * 0.25)
  return weightGb + kvCacheGb + workspaceGb
}

export function modelTrainVramGb(
  paramsB: number,
  activeParamsB?: number,
  family?: string,
  numerics: TrainingNumerics = LEGACY_TRAINING_NUMERICS,
  activationCheckpointing = false,
): number {
  return estimateTrainingMemoryGb({
    paramsB,
    activeParamsB,
    family,
    numerics,
    activationCheckpointing,
  }).totalGb
}
