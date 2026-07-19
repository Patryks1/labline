import type { RackDesign, RackSku, SimState } from '../types'

/** Global effective-compute uplift applied to every complete rack. */
export const RACK_PF_MULTIPLIER = 2

/**
 * Complete rack products you order into a data hall.
 * Market SKUs + player custom blueprints (resolved via designToSku in racks.ts).
 */
const BASE_RACK_SKU_CATALOG: RackSku[] = [
  {
    id: 'rack_a100',
    name: 'Aether A-Node',
    blurb: 'Entry training/serve rack. Cheap, power-hungry for the FLOPS.',
    generation: 1,
    rackUnits: 1,
    flopsPf: 0.35,
    vramGb: 80,
    systemRamGb: 256,
    cpuScore: 24,
    mw: 0.0065,
    tokPerSec: 1100,
    price: 180_500,
    leadTimeDays: 4,
    sellBackRate: 0.42,
    unlockedByDefault: true,
  },
  {
    id: 'rack_h100',
    name: 'Aether H-Node',
    blurb: 'Workhorse dense-training rack. Best $/PF early game.',
    generation: 2,
    rackUnits: 1,
    flopsPf: 0.7,
    vramGb: 80,
    systemRamGb: 512,
    cpuScore: 40,
    mw: 0.0072,
    tokPerSec: 2200,
    price: 313_500,
    leadTimeDays: 6,
    sellBackRate: 0.4,
    unlockedByDefault: true,
  },
  {
    id: 'rack_h200',
    name: 'Aether H2-Node',
    blurb: 'High-VRAM serve node. Good for larger context and MoE.',
    generation: 2,
    rackUnits: 1,
    flopsPf: 0.85,
    vramGb: 141,
    systemRamGb: 768,
    cpuScore: 48,
    mw: 0.0078,
    tokPerSec: 2800,
    price: 418_000,
    leadTimeDays: 8,
    sellBackRate: 0.38,
    unlockedByDefault: true,
  },
  {
    id: 'rack_b200',
    name: 'Aether B-Node',
    blurb: 'Next-gen dense rack. Needs Silicon research for best pricing.',
    generation: 3,
    rackUnits: 1,
    flopsPf: 1.45,
    vramGb: 192,
    systemRamGb: 1024,
    cpuScore: 64,
    mw: 0.0095,
    tokPerSec: 5200,
    price: 646_000,
    leadTimeDays: 10,
    sellBackRate: 0.35,
    requiresResearch: 'si_arch',
  },
  {
    id: 'rack_infer',
    name: 'Serve Sled',
    blurb: 'Inference-optimized: lower VRAM, high tokens/sec, efficient draw.',
    generation: 2,
    rackUnits: 1,
    flopsPf: 0.4,
    vramGb: 48,
    systemRamGb: 384,
    cpuScore: 56,
    mw: 0.0042,
    tokPerSec: 4500,
    price: 209_000,
    leadTimeDays: 5,
    sellBackRate: 0.4,
    unlockedByDefault: true,
  },
  {
    id: 'rack_train',
    name: 'Train Cluster Rack',
    blurb: 'Dual-bay training rack (2 hall slots). Huge VRAM for big pretrains.',
    generation: 3,
    rackUnits: 2,
    flopsPf: 2.2,
    vramGb: 320,
    systemRamGb: 1536,
    cpuScore: 80,
    mw: 0.016,
    tokPerSec: 3600,
    price: 988_000,
    leadTimeDays: 12,
    sellBackRate: 0.33,
    requiresResearch: 'sys_batching',
  },
  {
    id: 'rack_custom_l1',
    name: 'Labline L1 Rack',
    blurb: 'Your custom silicon in a full rack. Unlocks when fab hits volume.',
    generation: 4,
    rackUnits: 1,
    flopsPf: 1.9,
    vramGb: 160,
    mw: 0.0058,
    tokPerSec: 7500,
    price: 180_500,
    leadTimeDays: 2,
    sellBackRate: 0.5,
    custom: true,
  },
]

export const RACK_SKU_CATALOG: RackSku[] = BASE_RACK_SKU_CATALOG.map((sku) => ({
  ...sku,
  flopsPf: sku.flopsPf * RACK_PF_MULTIPLIER,
}))

const extra: Record<string, RackSku> = {}

export function registerRackSku(sku: RackSku) {
  extra[sku.id] = { ...sku, flopsPf: sku.flopsPf * RACK_PF_MULTIPLIER }
}

export function getRackSku(id: string): RackSku {
  const s = RACK_SKU_CATALOG.find((x) => x.id === id) ?? extra[id]
  if (!s) throw new Error(`Unknown rack SKU ${id}`)
  return s
}

/** Live order quote for qty of a SKU (UI + validation). */
export function quoteRackOrder(
  sku: RackSku,
  qty: number,
  opts?: { discount?: number; freeBays?: number; cash?: number; pue?: number },
): {
  qty: number
  unitPrice: number
  totalPrice: number
  bays: number
  mw: number
  mwWithPue: number
  flopsPf: number
  vramGb: number
  tokPerSec: number
  leadDays: number
  canFit: boolean
  canAfford: boolean
  freeAfter: number
} {
  const q = Math.max(1, Math.floor(qty) || 1)
  const discount = opts?.discount ?? 0
  const unitPrice = Math.floor(sku.price * (1 - discount))
  const bays = sku.rackUnits * q
  const free = opts?.freeBays ?? Infinity
  const cash = opts?.cash ?? Infinity
  const pue = opts?.pue ?? 1.25
  const mwDraw = sku.mw * q
  return {
    qty: q,
    unitPrice,
    totalPrice: unitPrice * q,
    bays,
    mw: mwDraw,
    mwWithPue: mwDraw * pue,
    flopsPf: sku.flopsPf * q,
    vramGb: sku.vramGb * q,
    tokPerSec: sku.tokPerSec * q,
    leadDays: sku.leadTimeDays,
    canFit: bays <= free,
    canAfford: unitPrice * q <= cash,
    freeAfter: free - bays,
  }
}

/**
 * Market catalog available to order (no blueprints — those are merged in dcRacks / UI).
 */
export function orderableMarketSkus(
  researchUnlocked: string[],
  fabPhase?: string,
): RackSku[] {
  return RACK_SKU_CATALOG.filter((s) => {
    if (s.id === 'rack_custom_l1') return fabPhase === 'volume'
    if (s.custom) return false
    if (s.unlockedByDefault) return true
    if (s.requiresResearch && researchUnlocked.includes(s.requiresResearch)) return true
    return false
  })
}

/** @deprecated use orderableMarketSkus + design blueprints */
export function orderableRackSkus(
  researchUnlocked: string[],
  _designs: RackDesign[] = [],
  fabPhase?: string,
): RackSku[] {
  return orderableMarketSkus(researchUnlocked, fabPhase)
}

export function orderableRackSkusFromState(state: SimState): RackSku[] {
  return orderableMarketSkus(state.player.researchUnlocked, state.player.fab.phase)
}
