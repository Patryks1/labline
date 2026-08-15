import { ECONOMY } from '../balance/economy'
import { getRackSku } from '../balance/rackSkus'
import { scoreDesign } from '../balance/racks'
import type { RackDesign, RackInstall } from '../types'

export interface LooseAcceleratorLoad {
  count: number
  mwPerDevice: number
}

export interface FleetOperatingLoad {
  deviceCount: number
  mw: number
}

export interface FleetVariableOpex extends FleetOperatingLoad {
  deviceOpexDay: number
  mwOpexDay: number
  totalOpexDay: number
}

function rackLoad(
  skuId: string,
  designs: readonly RackDesign[],
): { deviceCount: number; mw: number } {
  if (skuId.startsWith('design:')) {
    const design = designs.find((candidate) => candidate.id === skuId.slice('design:'.length))
    if (!design) throw new Error(`Unknown design rack ${skuId}`)
    const stats = scoreDesign(design)
    if (!stats.valid) throw new Error(`Invalid design rack ${skuId}`)
    return { deviceCount: Math.max(1, stats.gpuCount), mw: Math.max(0, stats.mw) }
  }
  const sku = getRackSku(skuId)
  return {
    deviceCount: Math.max(1, sku.accelerator?.deviceCount ?? 1),
    mw: Math.max(0, sku.mw),
  }
}

/** Physical live-fleet load, independent of controller and facility shell costs. */
export function fleetOperatingLoad(input: {
  rackFleet?: readonly RackInstall[]
  rackDesigns?: readonly RackDesign[]
  looseAccelerators?: readonly LooseAcceleratorLoad[]
}): FleetOperatingLoad {
  const designs = input.rackDesigns ?? []
  let deviceCount = 0
  let mw = 0

  for (const install of input.rackFleet ?? []) {
    if (install.status !== 'live' || install.count <= 0) continue
    try {
      const load = rackLoad(install.skuId, designs)
      deviceCount += load.deviceCount * install.count
      mw += load.mw * install.count
    } catch {
      // Imported legacy SKUs retain the former conservative one-device fallback.
      deviceCount += install.count
      mw += 0.007 * install.count
    }
  }
  for (const accelerator of input.looseAccelerators ?? []) {
    const count = Math.max(0, accelerator.count)
    deviceCount += count
    mw += count * Math.max(0, accelerator.mwPerDevice)
  }

  return { deviceCount, mw }
}

/** Shared pure rack/GPU and MW operating-cost calculation for every lab. */
export function fleetVariableOpex(
  load: FleetOperatingLoad,
  rates: { perDeviceDay?: number; perMwDay?: number } = {},
): FleetVariableOpex {
  const deviceCount = Math.max(0, load.deviceCount)
  const mw = Math.max(0, load.mw)
  const deviceOpexDay =
    deviceCount * Math.max(0, rates.perDeviceDay ?? ECONOMY.rackOpexPerGpuDay ?? 420)
  const mwOpexDay = mw * Math.max(0, rates.perMwDay ?? ECONOMY.rackOpexPerMwDay ?? 18_000)
  return {
    deviceCount,
    mw,
    deviceOpexDay,
    mwOpexDay,
    totalOpexDay: deviceOpexDay + mwOpexDay,
  }
}

export function calculateFleetVariableOpex(
  input: Parameters<typeof fleetOperatingLoad>[0],
): FleetVariableOpex {
  return fleetVariableOpex(fleetOperatingLoad(input))
}
