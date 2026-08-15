import type { AcceleratorProfile, RackDesign, RackSku, SimState } from '../types'

/** @deprecated Compute-v2 stores physical aggregate throughput per node. */
export const RACK_PF_MULTIPLIER = 1

function accelerator(
  input: Omit<AcceleratorProfile, 'supportedTrainingFormats' | 'supportedServePrecisions'>,
): AcceleratorProfile {
  const training: AcceleratorProfile['supportedTrainingFormats'] = [
    'fp32',
    'fp16_mixed',
    'bf16_mixed',
  ]
  const serving: AcceleratorProfile['supportedServePrecisions'] = [
    'fp16',
    'bf16',
    'int8',
    'int4',
    'ternary_1_58',
  ]
  if (input.generation >= 2) {
    training.push('fp8_hybrid')
    serving.push('fp8')
  }
  if (input.generation >= 3) {
    training.push('nvfp4')
    serving.push('nvfp4')
  }
  return {
    ...input,
    supportedTrainingFormats: training,
    supportedServePrecisions: serving,
  }
}

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
    flopsPf: 2.496,
    vramGb: 640,
    systemRamGb: 256,
    cpuScore: 24,
    mw: 0.0065,
    tokPerSec: 24_000,
    accelerator: accelerator({
      deviceCount: 8,
      generation: 1,
      fp32TfPerDevice: 19.5,
      fp16Bf16TfPerDevice: 312,
      fp8TfPerDevice: 0,
      fp4TfPerDevice: 0,
      hbmGbPerDevice: 80,
      hbmBandwidthTbPerSecPerDevice: 2.04,
      interconnectGbps: 600,
      idleMw: 0.0021,
      maxMw: 0.0056,
      hostOverheadMw: 0.0009,
    }),
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
    flopsPf: 7.912,
    vramGb: 640,
    systemRamGb: 512,
    cpuScore: 40,
    // DGX H100/H200 systems are rated at 10.2 kW maximum.  The accelerator
    // profile keeps the 8 x 700 W device envelope separate from the host,
    // fabric and cooling overhead so fleet power cannot price only the GPUs.
    mw: 0.0102,
    tokPerSec: 96_000,
    accelerator: accelerator({
      deviceCount: 8,
      generation: 2,
      fp32TfPerDevice: 67,
      fp16Bf16TfPerDevice: 989,
      fp8TfPerDevice: 1_979,
      fp4TfPerDevice: 0,
      hbmGbPerDevice: 80,
      hbmBandwidthTbPerSecPerDevice: 3.35,
      interconnectGbps: 900,
      idleMw: 0.002,
      maxMw: 0.0056,
      hostOverheadMw: 0.0046,
    }),
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
    flopsPf: 7.912,
    vramGb: 1_128,
    systemRamGb: 768,
    cpuScore: 48,
    mw: 0.0102,
    tokPerSec: 112_000,
    accelerator: accelerator({
      deviceCount: 8,
      generation: 2,
      fp32TfPerDevice: 67,
      fp16Bf16TfPerDevice: 989,
      fp8TfPerDevice: 1_979,
      fp4TfPerDevice: 0,
      hbmGbPerDevice: 141,
      hbmBandwidthTbPerSecPerDevice: 4.8,
      interconnectGbps: 900,
      idleMw: 0.0021,
      maxMw: 0.0056,
      hostOverheadMw: 0.0046,
    }),
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
    flopsPf: 18,
    // DGX B200 exposes 1,440 GB HBM across eight 180 GB accelerators and
    // ships with 2 TB of system memory.
    vramGb: 1_440,
    systemRamGb: 2_048,
    cpuScore: 64,
    mw: 0.0143,
    tokPerSec: 240_000,
    accelerator: accelerator({
      deviceCount: 8,
      generation: 3,
      fp32TfPerDevice: 90,
      fp16Bf16TfPerDevice: 2_250,
      fp8TfPerDevice: 4_500,
      fp4TfPerDevice: 9_000,
      hbmGbPerDevice: 180,
      hbmBandwidthTbPerSecPerDevice: 8,
      interconnectGbps: 1_800,
      idleMw: 0.0027,
      maxMw: 0.008,
      hostOverheadMw: 0.0063,
    }),
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
    flopsPf: 1.98,
    vramGb: 192,
    systemRamGb: 384,
    cpuScore: 56,
    mw: 0.0042,
    tokPerSec: 76_000,
    accelerator: accelerator({
      deviceCount: 4,
      generation: 2,
      fp32TfPerDevice: 34,
      fp16Bf16TfPerDevice: 495,
      fp8TfPerDevice: 990,
      fp4TfPerDevice: 0,
      hbmGbPerDevice: 48,
      hbmBandwidthTbPerSecPerDevice: 2.5,
      interconnectGbps: 450,
      idleMw: 0.0012,
      maxMw: 0.0032,
      hostOverheadMw: 0.001,
    }),
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
    flopsPf: 18,
    vramGb: 1_440,
    systemRamGb: 2_048,
    cpuScore: 80,
    mw: 0.016,
    tokPerSec: 184_000,
    accelerator: accelerator({
      deviceCount: 8,
      generation: 3,
      fp32TfPerDevice: 90,
      fp16Bf16TfPerDevice: 2_250,
      fp8TfPerDevice: 4_500,
      fp4TfPerDevice: 9_000,
      hbmGbPerDevice: 180,
      hbmBandwidthTbPerSecPerDevice: 8,
      interconnectGbps: 1_800,
      idleMw: 0.004,
      maxMw: 0.014,
      hostOverheadMw: 0.002,
    }),
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
    flopsPf: 12,
    vramGb: 1_280,
    mw: 0.0058,
    tokPerSec: 190_000,
    accelerator: accelerator({
      deviceCount: 8,
      generation: 4,
      fp32TfPerDevice: 80,
      fp16Bf16TfPerDevice: 1_500,
      fp8TfPerDevice: 3_200,
      fp4TfPerDevice: 6_400,
      hbmGbPerDevice: 160,
      hbmBandwidthTbPerSecPerDevice: 6,
      interconnectGbps: 1_800,
      idleMw: 0.0015,
      maxMw: 0.0048,
      hostOverheadMw: 0.001,
    }),
    price: 180_500,
    leadTimeDays: 2,
    sellBackRate: 0.5,
    custom: true,
  },
]

export const RACK_SKU_CATALOG: RackSku[] = BASE_RACK_SKU_CATALOG

const extra: Record<string, RackSku> = {}

export function registerRackSku(sku: RackSku) {
  extra[sku.id] = { ...sku }
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
