import type { Allocation, SimState } from '../types'
import { inferenceCapacityMTok } from '../balance/serveCompute'
import { TOK_PER_PF_SEC } from '../balance/tokenServe'
import { campusBonuses } from './campus'
import { labContractCapacityPf } from './computeContracts'
import { mapEnergy as mapEnergyFromTiles, resolvePlayerPowerMw } from './map'
import { fleetStats, vramPressure } from './racks'
import {
  engineerServeBonus,
  engineerTrainBonus,
  engineerUtilBonus,
} from './staff'

export interface ComputeSnapshot {
  rawFlopsPf: number
  utilCap: number
  pue: number
  mwDemand: number
  mwAvailable: number
  powerDerate: number
  effectiveFlopsPf: number
  pools: { training: number; inference: number; research: number }
  chipCount: number
  avgTokPerSecPerChip: number
  throttled: boolean
  rackCap: number
  racksUsed: number
  vramGb: number
  vramNeedTrain: number
  vramNeedServe: number
  vramDerateTrain: number
  vramDerateServe: number
  systemRamGb: number
  systemRamNeed: number
  systemRamDerate: number
  cpuScore: number
  cpuNeed: number
  cpuDerate: number
  /** Serving-only engineer uplift, consumed once by the token path. */
  engineerServeBonus?: number
}

const referenceIds = new WeakMap<object, number>()
let nextReferenceId = 1
const snapshotCache = new Map<string, ComputeSnapshot>()

function referenceId(value: object | null | undefined): number {
  if (!value) return 0
  let id = referenceIds.get(value)
  if (id === undefined) {
    id = nextReferenceId++
    referenceIds.set(value, id)
  }
  return id
}

/** Only inputs that can affect compute/power/hosting belong in this key. */
function snapshotKey(state: SimState): string {
  const player = state.player
  return [
    state.map.storage ?? 'legacy',
    state.map.world?.revision ?? referenceId(state.map.tiles),
    referenceId(player.rackFleet),
    referenceId(player.chips),
    referenceId(player.deployedRacks),
    referenceId(player.rackDesigns),
    referenceId(player.models),
    referenceId(player.trainingJob),
    referenceId(player.staff),
    referenceId(player.researchUnlocked),
    referenceId(state.computeLeases),
    referenceId(state.computeContracts),
    referenceId(state.cityPowerContracts),
    referenceId(state.siteCapacities),
    referenceId(state.energyContracts),
    referenceId(state.activeEvents),
    player.allocation.training,
    player.allocation.inference,
    player.allocation.research,
    player.utilCap,
    player.pue,
    player.pricing.activeModelId ?? '',
  ].join('|')
}

export function mapEnergy(state: SimState) {
  return mapEnergyFromTiles(state)
}

export function normalizeAllocation(a: Allocation): Allocation {
  const sum = a.training + a.inference + a.research
  if (sum <= 0) return { training: 0.34, inference: 0.33, research: 0.33 }
  return {
    training: a.training / sum,
    inference: a.inference / sum,
    research: a.research / sum,
  }
}

function playerLegacyLeaseCapacity(state: SimState): { inboundPf: number; outboundPf: number } {
  let inboundPf = 0
  let outboundPf = 0
  for (const lease of state.computeLeases) {
    if (lease.status !== 'active') continue
    const sellerLabId =
      lease.sellerLabId ?? (lease.playerSells ? state.playerLabId : lease.rivalId)
    const buyerLabId =
      lease.buyerLabId ?? (lease.playerSells ? lease.rivalId : state.playerLabId)
    if (buyerLabId === state.playerLabId) inboundPf += lease.pf
    if (sellerLabId === state.playerLabId) outboundPf += lease.pf
  }
  return { inboundPf, outboundPf }
}

function weightedRemoteDerate(localPf: number, remotePf: number, localDerate: number): number {
  const total = localPf + remotePf
  if (total <= 1e-9) return 1
  return (localPf * localDerate + remotePf) / total
}

export function computeSnapshot(state: SimState): ComputeSnapshot {
  const key = snapshotKey(state)
  const cached = snapshotCache.get(key)
  if (cached) return cached
  const player = state.player
  const fleet = fleetStats(state)
  const energy = mapEnergy(state)
  const campus = campusBonuses(state)
  const utilCap = Math.min(0.98, player.utilCap)
  const pue = Math.max(1.05, player.pue - campus.pueReduction)

  // Power: fleet draw * effective PUE; grid is shared with rivals (own gen is private)
  const mwDemand = fleet.mw * pue
  const power = resolvePlayerPowerMw(state, mwDemand)
  const mwAvailable = Math.max(0.05, power.mwAvailable)
  // Brownout floor — underpowered halls slow down, they don't black out
  const POWER_FLOOR = 0.22
  const powerDerateRaw = mwDemand > mwAvailable ? mwAvailable / Math.max(1e-6, mwDemand) : 1
  const powerDerate = Math.min(1, Math.max(POWER_FLOOR, powerDerateRaw))
  const powerThrottled = powerDerateRaw < 0.999

  const rackCap = energy.rackCap
  const installedRackUnits = fleet.rackUnitsUsed
  const rackDerate =
    rackCap > 0
      ? Math.min(1, Math.max(0.2, rackCap / Math.max(1, installedRackUnits)))
      : installedRackUnits > 0
        ? 0.2
        : 1

  const trainV = vramPressure(state, 'train')
  const serveV = vramPressure(state, 'serve')

  // Local hardware and remote contracts are tracked separately. Netting would
  // incorrectly erase a simultaneous local sale and remote purchase.
  const legacyLeases = playerLegacyLeaseCapacity(state)
  const providerContracts = labContractCapacityPf(state, state.playerLabId)
  const remoteFlops = Math.max(0, legacyLeases.inboundPf + providerContracts.inboundPf)
  const leasedOut = Math.max(0, legacyLeases.outboundPf + providerContracts.outboundPf)
  let fleetFlops = Math.max(0, fleet.flopsPf - leasedOut)
  const active = player.models.find((m) => m.id === player.pricing.activeModelId)
  const job = player.trainingJob
  const trainModelParams = job?.targetParamsB ?? active?.paramsB ?? 0
  if (active?.family === 'moe' && fleetFlops > 0) {
    fleetFlops *= 1.05
  }
  const rawFlops = Math.max(0, fleetFlops + remoteFlops)

  // Host RAM / CPU needs — matter for train (pipeline), serve (KV), research (workers)
  const systemRamGb = fleet.systemRamGb
  const cpuScore = fleet.cpuScore
  const systemRamNeed = Math.max(
    32,
    (active ? (active.activeParamsB ?? active.paramsB) * 6 : 0) +
      (trainModelParams > 0 ? trainModelParams * 8 : 0) +
      24,
  )
  const cpuNeed = Math.max(
    8,
    (active ? Math.sqrt(Math.max(1, active.paramsB)) * 6 : 4) +
      (job ? 12 : 0) +
      player.researchUnlocked.length * 0.15,
  )
  const systemRamDerate =
    systemRamNeed <= 1
      ? 1
      : Math.min(1, Math.max(0.35, systemRamGb / systemRamNeed))
  const cpuDerate =
    cpuNeed <= 1 ? 1 : Math.min(1, Math.max(0.35, cpuScore / cpuNeed))

  // Soft floors so short power/VRAM never freezes progress completely
  const trainMem = Math.max(0.28, trainV.derate)
  const serveMem = Math.max(0.3, serveV.derate)

  // Engineers improve util conversion and train/serve efficiency
  const engUtil = engineerUtilBonus(state)
  const engServe = engineerServeBonus(state)
  const engTrain = engineerTrainBonus(state)
  const effectiveUtil = Math.min(0.98, utilCap * (1 + engUtil))
  // Local fleet is power/rack/memory constrained. Remote capacity includes its
  // provider host stack, so local VRAM, RAM, CPU, and power never penalize it.
  const localBase = fleetFlops * effectiveUtil * powerDerate * rackDerate
  const remoteBase = remoteFlops * effectiveUtil
  const alloc = normalizeAllocation(player.allocation)

  // Train / serve / research pools — linear in compute + allocation.
  // trainEfficiency is applied in trainCostPfDays (lower target), not here.
  const trainPool =
    (localBase * trainMem * (0.55 + 0.45 * systemRamDerate) + remoteBase) *
    alloc.training *
    (1 + engTrain)
  const inferPool =
    (localBase * serveMem * (0.7 + 0.2 * systemRamDerate + 0.1 * cpuDerate) +
      remoteBase) *
    alloc.inference *
    (1 + engServe)
  const researchPool =
    (localBase *
      (0.55 + 0.45 * cpuDerate) *
      (0.8 + 0.2 * systemRamDerate) +
      remoteBase) *
    alloc.research

  const localThrottled =
    fleetFlops > 0 &&
    (powerThrottled ||
      (rackDerate < 0.999 ||
        trainMem < 0.95 ||
        serveMem < 0.95 ||
        systemRamDerate < 0.9 ||
        cpuDerate < 0.9))

  // Lab sites slightly boost train pool conversion
  const trainBoost = 1 + campus.trainEffBonus
  const combinedPowerDerate = weightedRemoteDerate(
    fleetFlops,
    remoteFlops,
    powerDerate * rackDerate,
  )
  const combinedTrainMem = weightedRemoteDerate(fleetFlops, remoteFlops, trainMem)
  const combinedServeMem = weightedRemoteDerate(fleetFlops, remoteFlops, serveMem)
  const combinedSystemRam = weightedRemoteDerate(
    fleetFlops,
    remoteFlops,
    systemRamDerate,
  )
  const combinedCpu = weightedRemoteDerate(fleetFlops, remoteFlops, cpuDerate)
  const remoteGpuEquivalent = remoteFlops / 0.7
  const chipCount = fleet.gpuCount + remoteGpuEquivalent
  const hardwareTokPerSec = fleet.tokPerSec + remoteFlops * TOK_PER_PF_SEC

  const snapshot: ComputeSnapshot = {
    rawFlopsPf: rawFlops,
    utilCap,
    pue,
    mwDemand,
    mwAvailable,
    powerDerate: combinedPowerDerate,
    effectiveFlopsPf: trainPool * trainBoost + inferPool + researchPool,
    pools: {
      training: trainPool * trainBoost,
      inference: inferPool,
      research: researchPool,
    },
    chipCount,
    avgTokPerSecPerChip: chipCount > 0 ? hardwareTokPerSec / chipCount : 0,
    throttled: localThrottled,
    rackCap,
    // The HUD reports occupied bays, not unhosted inventory. rackDerate above
    // still uses the full installed count so imported over-cap saves throttle.
    racksUsed: Math.min(rackCap, installedRackUnits),
    vramGb: fleet.vramGb + remoteGpuEquivalent * 80,
    vramNeedTrain: trainV.needGb,
    vramNeedServe: serveV.needGb,
    vramDerateTrain: combinedTrainMem,
    vramDerateServe: combinedServeMem,
    systemRamGb: systemRamGb + remoteGpuEquivalent * 512,
    systemRamNeed,
    systemRamDerate: combinedSystemRam,
    cpuScore: cpuScore + remoteGpuEquivalent * 40,
    cpuNeed,
    cpuDerate: combinedCpu,
    engineerServeBonus: engServe,
  }
  snapshotCache.set(key, snapshot)
  if (snapshotCache.size > 48) {
    const oldest = snapshotCache.keys().next().value
    if (oldest !== undefined) snapshotCache.delete(oldest)
  }
  return snapshot
}

export function inferenceTokensPerDay(state: SimState, snap: ComputeSnapshot): number {
  const model = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      (m.release === 'released' || m.shipped),
  )
  if (!model) return 0
  return inferenceCapacityMTok(snap, model, state.player.servingEfficiency)
}

/** @deprecated use fleetStats */
export function totalOnlineChips(player: SimState['player']) {
  // thin wrapper for map.ts compatibility if any
  void player
  return { count: 0, rawFlops: 0, mw: 0, tokPerSec: 0 }
}
