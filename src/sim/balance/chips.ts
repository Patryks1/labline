import type { ChipDef } from '../types'

export const CHIP_CATALOG: ChipDef[] = [
  {
    id: 'gen1',
    name: 'Aether-H100',
    generation: 1,
    flopsPf: 0.4,
    mwPerChip: 0.00075,
    tokPerSec: 1200,
    price: 32_000,
    leadTimeDays: 5,
    perfPerWatt: 1,
  },
  {
    id: 'gen2',
    name: 'Aether-H200',
    generation: 2,
    flopsPf: 0.7,
    mwPerChip: 0.0008,
    tokPerSec: 2200,
    price: 48_000,
    leadTimeDays: 8,
    perfPerWatt: 1.25,
  },
  {
    id: 'gen3',
    name: 'Aether-B200',
    generation: 3,
    flopsPf: 1.4,
    mwPerChip: 0.0011,
    tokPerSec: 4800,
    price: 72_000,
    leadTimeDays: 12,
    perfPerWatt: 1.6,
  },
  {
    id: 'custom_v1',
    name: 'Labline L1 (custom)',
    generation: 4,
    flopsPf: 1.8,
    mwPerChip: 0.00065,
    tokPerSec: 7200,
    price: 0,
    leadTimeDays: 0,
    perfPerWatt: 2.4,
    custom: true,
    moeBoost: 1.35,
  },
  {
    id: 'custom_v2',
    name: 'Labline L2 (custom)',
    generation: 5,
    flopsPf: 2.6,
    mwPerChip: 0.0007,
    tokPerSec: 11000,
    price: 0,
    leadTimeDays: 0,
    perfPerWatt: 3.1,
    custom: true,
    moeBoost: 1.55,
  },
]

const dynamicCustom: Record<string, ChipDef> = {}

export function registerCustomChip(def: ChipDef) {
  dynamicCustom[def.id] = def
}

export function getChipDef(id: string): ChipDef {
  const def = CHIP_CATALOG.find((c) => c.id === id) ?? dynamicCustom[id]
  if (!def) throw new Error(`Unknown chip ${id}`)
  return def
}

export function buyableChips(): ChipDef[] {
  return CHIP_CATALOG.filter((c) => !c.custom)
}
