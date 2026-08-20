import type { Allocation, SimState } from "../types";
import {
  inferenceCapacityMTok,
  pfPerMTokForModel,
} from "../balance/serveCompute";
import {
  estimateServingMemory,
  residentMemoryFit,
} from "../balance/tokenServe";
import { campusBonuses } from "./campus";
import { labContractCapacityPf } from "./computeContracts";
import { mapEnergy as mapEnergyFromTiles, resolvePlayerPowerMw } from "./map";
import { fleetStats, vramPressure } from "./racks";
import {
  engineerServeBonus,
  engineerTrainBonus,
  engineerUtilBonus,
} from "./staff";
import { playerHallPueMultiplier } from "./dataHallLayouts";
import { fleetPowerDraw, powerDerateForSupply } from "./computePower";
import { activeBalanceTuning, activeBalanceTuningRevision } from "../balance/tuning";
import { servingPlacementNeed } from "./servingPlacement";
import { isLivePublicModel } from "../modelRelease";

export type ComputeStallReason =
  | "ok"
  | "no_operational_racks"
  | "all_capacity_leased_out"
  | "remote_memory_blocked"
  | "contract_expired"
  | "serve_reservation_starved_offline"
  | "no_capacity";

export interface ComputeSnapshot {
  rawFlopsPf: number;
  utilCap: number;
  /** Util after engineer bonus, floored like labEngine. */
  effectiveUtil: number;
  pue: number;
  mwDemand: number;
  mwAvailable: number;
  /** Physical facility draw; PF pools remain authoritative work quantities. */
  mwBreakdown: {
    idle: number;
    training: number;
    inference: number;
    research: number;
  };
  /** Physical draw if each offline pool runs its configured share. */
  mwForecast: { training: number; research: number };
  powerDerate: number;
  effectiveFlopsPf: number;
  pools: { training: number; inference: number; research: number };
  /** Workable base before allocation split (local+remote util-adjusted). */
  fullRawPool: number;
  localFleetPf: number;
  remoteFlopsPf: number;
  leasedOutPf: number;
  chipCount: number;
  avgTokPerSecPerChip: number;
  throttled: boolean;
  rackCap: number;
  racksUsed: number;
  vramGb: number;
  localVramGb: number;
  remoteVramGb: number;
  /** Accelerator RAM reserved for training by the configured compute allocation. */
  trainingRamGb: number;
  vramNeedTrain: number;
  vramNeedServe: number;
  vramDerateTrain: number;
  vramDerateServe: number;
  systemRamGb: number;
  localSystemRamGb: number;
  remoteSystemRamGb: number;
  systemRamNeed: number;
  systemRamDerate: number;
  cpuScore: number;
  cpuNeed: number;
  cpuDerate: number;
  /** Serving-only engineer uplift, consumed once by the token path. */
  engineerServeBonus?: number;
  /** Reserved serving PF before offline work backfills idle capacity. */
  servingReservationPf?: number;
  /**
   * Serve memory fit actually applied to local inference capacity (0–1).
   * Resident serving is admitted only when the complete promised deployment
   * fits HBM and its bounded host staging requirement fits system RAM. There
   * is no implicit expert/weight offload path in this value.
   */
  serveMemFit?: number;
  /** Remote-serve memory fit applied to remote inference capacity (0–1). */
  remoteServeMemFit?: number;
  backfilledPf?: number;
  dutyCycle?: number;
  stallReason: ComputeStallReason;
  stallMessage: string;
}

/** Minimum local residual when leasing outbound (keeps own work alive). */
export const OUTBOUND_LOCAL_RESIDUAL_SHARE = 0.12;

/** Conservative remote accelerator equivalent used by provider and bilateral PF purchases. */
export function remoteAcceleratorRamGb(remotePf: number): number {
  return (Math.max(0, remotePf) / 0.7) * 80;
}

const referenceIds = new WeakMap<object, number>();
let nextReferenceId = 1;
const snapshotCache = new Map<string, ComputeSnapshot>();

function referenceId(value: object | null | undefined): number {
  if (!value) return 0;
  let id = referenceIds.get(value);
  if (id === undefined) {
    id = nextReferenceId++;
    referenceIds.set(value, id);
  }
  return id;
}

/** Only inputs that can affect compute/power/hosting belong in this key. */
function snapshotKey(state: SimState): string {
  const player = state.player;
  return [
    state.map.storage ?? "legacy",
    state.map.world?.revision ?? referenceId(state.map.tiles),
    referenceId(player.rackFleet),
    referenceId(player.chips),
    referenceId(player.deployedRacks),
    referenceId(player.rackDesigns),
    referenceId(state.dataHallLayouts),
    // Nested layout mutations replace per-hall objects while sometimes keeping
    // the outer map identity in transitional callers; revisions must invalidate.
    Object.values(state.dataHallLayouts ?? {})
      .map((layout) => `${layout.facilityId}:${layout.revision}:${layout.analysis?.revision ?? 0}`)
      .sort()
      .join(","),
    referenceId(player.models),
    referenceId(player.pricing),
    referenceId(player.trainingJob),
    referenceId(player.trainingJobs),
    referenceId(player.activeResearch),
    referenceId(player.researchPrograms),
    referenceId(player.safetyCampaign),
    referenceId(state.lastMarket),
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
    player.pricing.activeModelId ?? "",
    activeBalanceTuningRevision(),
  ].join("|");
}

export function mapEnergy(state: SimState) {
  return mapEnergyFromTiles(state);
}

export function normalizeAllocation(a: Allocation): Allocation {
  const sum = a.training + a.inference + a.research;
  if (sum <= 0) return { training: 0.34, inference: 0.33, research: 0.33 };
  return {
    training: a.training / sum,
    inference: a.inference / sum,
    research: a.research / sum,
  };
}

function playerLegacyLeaseCapacity(state: SimState): {
  inboundPf: number;
  outboundPf: number;
} {
  let inboundPf = 0;
  let outboundPf = 0;
  for (const lease of state.computeLeases) {
    if (lease.status !== "active") continue;
    const sellerLabId =
      lease.sellerLabId ??
      (lease.playerSells ? state.playerLabId : lease.rivalId);
    const buyerLabId =
      lease.buyerLabId ??
      (lease.playerSells ? lease.rivalId : state.playerLabId);
    if (buyerLabId === state.playerLabId) inboundPf += lease.pf;
    if (sellerLabId === state.playerLabId) outboundPf += lease.pf;
  }
  return { inboundPf, outboundPf };
}

function weightedRemoteDerate(
  localPf: number,
  remotePf: number,
  localDerate: number,
  remoteDerate = 1,
): number {
  const total = localPf + remotePf;
  if (total <= 1e-9) return 1;
  return (localPf * localDerate + remotePf * remoteDerate) / total;
}

/**
 * Minimum live placement for one request per routed endpoint. Requested-load
 * concurrency is admission controlled by the PF/queue settlement; requiring
 * KV for every offered request up front would create a paradox where higher
 * demand makes an otherwise resident model produce zero capacity.
 */
export function minimumResidentServingNeed(state: SimState): {
  hbmNeedGb: number;
  systemRamNeedGb: number;
} {
  const placements = servingPlacementNeed(state).placements;
  let hbmNeedGb = 0;
  let systemRamNeedGb = 0;
  for (const placement of placements) {
    const minimum = estimateServingMemory({
      model: placement.model,
      precision: placement.precision,
      concurrentRequests: 1,
      avgInputTokens: placement.contextTokens,
    });
    hbmNeedGb += minimum.residentMemoryGb;
    systemRamNeedGb += minimum.requiredSystemRamGb;
  }
  return { hbmNeedGb, systemRamNeedGb };
}

function diagnoseComputeStall(input: {
  localFleetPf: number;
  fleetFlops: number;
  hostedLocalPf: number;
  leasedOut: number;
  remoteFlops: number;
  serveMem: number;
  remoteServeMem: number;
  inferPool: number;
  hasServing: boolean;
  fullRawPool: number;
  effectiveFlopsPf: number;
  trainPool: number;
  serveFraction: number;
  uncappedServeFraction: number;
  offlineFloor: number;
}): { reason: ComputeStallReason; message: string } {
  if (input.effectiveFlopsPf > 0.05 && input.trainPool > 0.05 && input.inferPool > 0.05) {
    return { reason: "ok", message: "" };
  }
  if (
    input.localFleetPf > 1e-6 &&
    input.fleetFlops <= 1e-6 &&
    input.hostedLocalPf > 1e-6 &&
    input.leasedOut >= input.hostedLocalPf * (1 - OUTBOUND_LOCAL_RESIDUAL_SHARE) - 1e-6
  ) {
    return {
      reason: "all_capacity_leased_out",
      message:
        "Most local compute is leased outbound. Reduce sold capacity or buy more hardware.",
    };
  }
  if (input.localFleetPf > 1e-6 && input.fleetFlops <= 1e-6) {
    return {
      reason: "no_operational_racks",
      message:
        "Racks are installed but not operational (power/network layout). Fix data-hall utilities or power the hall.",
    };
  }
  if (
    input.localFleetPf <= 1e-6 &&
    input.remoteFlops <= 1e-6
  ) {
    return {
      reason: "contract_expired",
      message:
        "No local fleet and no active remote compute contracts. Add racks or renew cloud/leases.",
    };
  }
  if (
    input.hasServing &&
    input.inferPool < 0.05 &&
    Math.max(input.serveMem, input.remoteServeMem) < 0.02
  ) {
    return {
      reason: "remote_memory_blocked",
      message:
        "Serve deployment barely fits available HBM/RAM. Quantize, drop concurrent products, or add accelerator memory — serving is nearly offline.",
    };
  }
  if (
    input.fullRawPool > 0.05 &&
    input.trainPool < 0.05 &&
    input.uncappedServeFraction >= 1 - input.offlineFloor - 1e-6
  ) {
    return {
      reason: "serve_reservation_starved_offline",
      message: `Serving demand reserved ~${Math.round(input.serveFraction * 100)}% of capacity. Raise Training allocation or add compute.`,
    };
  }
  if (input.fullRawPool <= 0.05) {
    return {
      reason: "no_capacity",
      message: "No workable compute capacity. Check power, halls, leases, and contracts.",
    };
  }
  return { reason: "ok", message: "" };
}

export function computeSnapshot(state: SimState): ComputeSnapshot {
  const key = snapshotKey(state);
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  const player = state.player;
  const fleet = fleetStats(state);
  const energy = mapEnergy(state);
  const campus = campusBonuses(state);
  const utilCap = Math.min(0.98, player.utilCap);
  const pue = Math.max(1.05, player.pue - campus.pueReduction) * playerHallPueMultiplier(state);

  // Local hardware and remote contracts are tracked separately. Netting would
  // incorrectly erase a simultaneous local sale and remote purchase. Resolve
  // them before electrical duty so inbound work never inflates local MW and
  // outbound sales still keep their hosted power bill.
  const legacyLeases = playerLegacyLeaseCapacity(state);
  const providerContracts = labContractCapacityPf(state, state.playerLabId);
  const remoteFlops = Math.max(
    0,
    legacyLeases.inboundPf + providerContracts.inboundPf,
  );
  const remoteGpuEquivalent = remoteFlops / 0.7;
  const remoteVramGb = remoteAcceleratorRamGb(remoteFlops);
  const remoteSystemRamGb = remoteGpuEquivalent * 512;
  const leasedOut = Math.max(
    0,
    legacyLeases.outboundPf + providerContracts.outboundPf,
  );

  const listedTrainingJobs = player.trainingJobs ?? [];
  const trainingJobs = player.trainingJob
    ? [
        player.trainingJob,
        ...listedTrainingJobs.filter(
          (job) => job.id !== player.trainingJob!.id,
        ),
      ]
    : listedTrainingJobs;
  const activeTrainingJobs = trainingJobs.filter(
    (job) =>
      !job.paused &&
      !job.failed &&
      !job.pendingCampaignEvent &&
      (job.computePriority ?? 50) > 0,
  );
  const hasTraining =
    activeTrainingJobs.length > 0 || Boolean(player.safetyCampaign);
  const hasResearch =
    Boolean(player.activeResearch) ||
    (player.researchPrograms?.length ?? 0) > 0 ||
    Boolean(player.safetyCampaign);
  const configured = normalizeAllocation(player.allocation);
  const trainingDuty = hasTraining ? configured.training * 0.9 : 0;
  const researchDuty = hasResearch ? configured.research * 0.9 : 0;
  // Only local served PF drives campus electricity. Remote purchases already
  // include their provider host stack, and sold outbound capacity remains a
  // local hosting duty even when it is no longer available for local jobs.
  const totalServePf = Math.max(0, state.lastMarket.servedPf ?? 0);
  const localFleetPf = Math.max(0, fleet.flopsPf);
  const localKeepShare =
    localFleetPf > 1e-9
      ? Math.max(0, Math.min(1, (localFleetPf - leasedOut) / localFleetPf))
      : 0;
  const localServeCapacityPf = Math.max(0, localFleetPf - leasedOut);
  const totalServeCapacityPf = Math.max(1e-9, localServeCapacityPf + remoteFlops);
  const localServeShare = localServeCapacityPf / totalServeCapacityPf;
  const localServePf = totalServePf * localServeShare;
  const inferenceDuty =
    localFleetPf > 1e-9 ? Math.min(1, localServePf / localFleetPf) : 0;
  const outboundDuty =
    localFleetPf > 1e-9 ? Math.min(1, leasedOut / localFleetPf) : 0;
  const requestedDuty =
    inferenceDuty + trainingDuty * localKeepShare + researchDuty * localKeepShare + outboundDuty;
  const dutyCycle = Math.max(
    0.05,
    Math.min(
      0.95,
      requestedDuty,
    ),
  );
  // Power: fleet draw * effective PUE; grid is shared with rivals (own gen is private)
  const fleetPower = fleetPowerDraw({
    fullLoadMw: fleet.mw,
    idleMw: fleet.idleMw,
    dutyCycle,
    pue,
  });
  const mwDemand = fleetPower.demandMw;
  const dynamicShareDenominator = Math.max(1e-9, requestedDuty);
  const trainingDynamic =
    fleetPower.dynamicMw *
    ((trainingDuty * localKeepShare) / dynamicShareDenominator);
  const researchDynamic =
    fleetPower.dynamicMw *
    ((researchDuty * localKeepShare) / dynamicShareDenominator);
  const inferenceDynamic =
    fleetPower.dynamicMw *
    ((inferenceDuty + outboundDuty) / dynamicShareDenominator);
  const mwBreakdown = {
    idle: fleetPower.idleMw,
    training: trainingDynamic,
    inference: inferenceDynamic,
    research: researchDynamic,
  };
  const mwForecast = {
    training: fleetPowerDraw({
      fullLoadMw: fleet.mw,
      idleMw: fleet.idleMw,
      dutyCycle: configured.training,
      pue,
    }).demandMw,
    research: fleetPowerDraw({
      fullLoadMw: fleet.mw,
      idleMw: fleet.idleMw,
      dutyCycle: configured.research,
      pue,
    }).demandMw,
  };
  if (requestedDuty <= 1e-9) mwBreakdown.idle += fleetPower.dynamicMw;
  const power = resolvePlayerPowerMw(state, mwDemand);
  const mwAvailable = power.mwAvailable;
  // powerDerateForSupply owns the brownout throughput floor; reported physical
  // availability remains zero when the campus has no supply.
  const powerLimit = powerDerateForSupply(mwDemand, mwAvailable);
  const powerDerate = powerLimit.derate;
  const powerThrottled = powerLimit.throttled;

  const rackCap = energy.rackCap;
  const installedRackUnits = fleet.rackUnitsUsed;
  // Physical hall analysis has already excluded every unplaced, colliding,
  // inaccessible, or utility-starved rack from fleetStats. Applying the
  // shell's legacy bay rating again would double-limit valid geometry.
  const rackDerate = 1;

  const trainV = vramPressure(state, "train");
  const serveV = vramPressure(state, "serve");
  const residentServeNeed = minimumResidentServingNeed(state);

  // Match labEngine: derate hosted local capacity first, then commit outbound
  // contracts from the powered residual. Deducting nominal sold PF before the
  // brownout derate creates free effective capacity for the seller.
  const hostedLocalPf = localFleetPf * powerDerate * rackDerate;
  // Retain a residual for own train/research so leasing cannot silently wipe
  // every local pool while Infrastructure still shows fleet hardware PF.
  const outboundCap =
    hostedLocalPf > 1e-9
      ? hostedLocalPf * (1 - OUTBOUND_LOCAL_RESIDUAL_SHARE)
      : 0;
  const outboundCommittedPf = Math.min(outboundCap, leasedOut);
  let fleetFlops = Math.max(0, hostedLocalPf - outboundCommittedPf);
  const active = player.models.find(
    (m) => m.id === player.pricing.activeModelId,
  );
  const safetyTrainingModel = player.safetyCampaign
    ? player.models.find((model) => model.id === player.safetyCampaign!.modelId)
    : undefined;
  const trainModelParams =
    activeTrainingJobs.reduce(
      (sum, job) => sum + Math.max(0, job.targetParamsB),
      0,
    ) + Math.max(0, safetyTrainingModel?.paramsB ?? 0);
  if (
    (active?.backbone === "moe" ||
      (active?.backbone == null && active?.family === "moe")) &&
    fleetFlops > 0
  ) {
    fleetFlops *= 1.05;
  }
  const rawFlops = Math.max(0, fleetFlops + remoteFlops);

  // Host RAM / CPU needs — matter for train (pipeline), serve (KV), research (workers)
  const systemRamGb = fleet.systemRamGb;
  const cpuScore = fleet.cpuScore;
  const systemRamNeed = Math.max(
    32,
    (active ? (active.activeParamsB ?? active.paramsB) * 6 : 0) +
      (trainModelParams > 0 ? trainModelParams * 8 : 0) +
      24,
  );
  const cpuNeed = Math.max(
    8,
    (active ? Math.sqrt(Math.max(1, active.paramsB)) * 6 : 4) +
      (activeTrainingJobs.length + (safetyTrainingModel ? 1 : 0)) * 12 +
      player.researchUnlocked.length * 0.15,
  );
  const systemRamDerate =
    systemRamNeed <= 1
      ? 1
      : Math.min(1, Math.max(0.35, systemRamGb / systemRamNeed));
  const cpuDerate =
    cpuNeed <= 1 ? 1 : Math.min(1, Math.max(0.35, cpuScore / cpuNeed));

  // Resident serve admission is all-or-nothing. Weight/KV bytes that do not
  // fit HBM cannot receive a magic fraction of accelerator throughput. A
  // future explicit offload policy may add capacity with a measured host/CXL
  // bandwidth and latency penalty; ordinary deployments do not get it free.
  const tuning = activeBalanceTuning();
  const localServeHbmFit = residentMemoryFit(
    residentServeNeed.hbmNeedGb,
    fleet.vramGb,
  );
  const localServeRamFit = residentMemoryFit(
    residentServeNeed.systemRamNeedGb,
    fleet.systemRamGb,
  );
  const serveMem = Math.min(localServeHbmFit, localServeRamFit);

  // Engineers improve util conversion and train/serve efficiency
  const engUtil = engineerUtilBonus(state);
  const engServe = engineerServeBonus(state);
  const engTrain = engineerTrainBonus(state);
  // Match labEngine: never let corrupt/zero utilCap wipe every pool.
  const effectiveUtil = Math.max(
    0.2,
    Math.min(0.98, utilCap * (1 + engUtil)),
  );
  // Local fleet is power/rack/memory constrained. Remote capacity includes its
  // provider host stack, so local VRAM, RAM, CPU, and power never penalize it.
  // fleetFlops is already hosted residual after power/rack derate + outbound commit.
  const localBase = fleetFlops * effectiveUtil;
  const remoteServeHbmFit =
    residentMemoryFit(residentServeNeed.hbmNeedGb, remoteVramGb);
  const remoteServeRamFit =
    residentMemoryFit(residentServeNeed.systemRamNeedGb, remoteSystemRamGb);
  const remoteServeMem = Math.min(remoteServeHbmFit, remoteServeRamFit);
  // Remote train/research keep full remote PF; inference is soft-scaled by fit.
  const remoteWorkBase = remoteFlops * effectiveUtil;
  const remoteInferBase = remoteWorkBase * remoteServeMem;
  const alloc = configured;

  // Reservations are guarantees, not hard partitions. Serving claims its p95
  // requirement first; idle reservation backfills offline work immediately.
  const fullRawPool = Math.max(0, localBase + remoteWorkBase);
  const fullTrainCapacity = (localBase + remoteWorkBase) * (1 + engTrain);
  const fullInferCapacity =
    (localBase * serveMem * (0.9 + 0.1 * cpuDerate) + remoteInferBase) *
    (1 + engServe) *
    tuning.serveCapacityMult;
  const fullResearchCapacity =
    localBase * (0.55 + 0.45 * cpuDerate) * (0.8 + 0.2 * systemRamDerate) +
    remoteWorkBase;
  const hasServing = player.models.some(isLivePublicModel);
  const onlineHeadroom = state.industryDataPack.compute.onlineHeadroom ?? 0.25;
  const forecastServePf =
    Math.max(0, state.lastMarket.demandPf ?? 0) * (1 + onlineHeadroom);
  const serveFractionNeeded =
    fullInferCapacity > 1e-9
      ? Math.min(1, forecastServePf / fullInferCapacity)
      : 0;
  // Protect configured offline shares so demand reservation cannot wipe train/research.
  const offlineFloor = Math.min(
    0.5,
    Math.max(
      alloc.training > 0.001 || hasTraining ? 0.05 : 0,
      Math.min(0.5, alloc.training + (hasResearch ? alloc.research : 0)),
    ),
  );
  const uncappedServeFraction = hasServing
    ? Math.max(alloc.inference, serveFractionNeeded)
    : 0;
  const serveFraction = hasServing
    ? Math.min(uncappedServeFraction, 1 - offlineFloor)
    : 0;
  const remainingFraction = Math.max(0, 1 - serveFraction);
  // Keep prospective train/research reservations visible before the first
  // job exists so players can start research/training from allocation alone.
  // Idle reservations still backfill active queues below.
  const trainingWeight = Math.max(0.001, alloc.training);
  const researchWeight = Math.max(0.001, alloc.research);
  const offlineWeight = trainingWeight + researchWeight;
  let trainFraction =
    offlineWeight > 0
      ? remainingFraction * (trainingWeight / offlineWeight)
      : 0;
  let researchFraction =
    offlineWeight > 0
      ? remainingFraction * (researchWeight / offlineWeight)
      : 0;
  if (!hasServing && alloc.research <= 0.001 && !hasResearch) trainFraction = 1;
  if (!hasServing && hasResearch && !hasTraining && alloc.training <= 0.001) {
    researchFraction = 1;
  }

  const trainPool = fullTrainCapacity * trainFraction;
  const inferPool = fullInferCapacity * serveFraction;
  const researchPool = fullResearchCapacity * researchFraction;
  const configuredOfflineFraction =
    (hasTraining ? alloc.training : 0) + (hasResearch ? alloc.research : 0);
  const backfilledFraction = Math.max(
    0,
    trainFraction + researchFraction - configuredOfflineFraction,
  );

  const localThrottled =
    fleetFlops > 0 &&
    (powerThrottled ||
      rackDerate < 0.999 ||
      trainV.derate < 0.95 ||
      serveMem < 0.95 ||
      systemRamDerate < 0.9 ||
      cpuDerate < 0.9);

  // Lab sites slightly boost train pool conversion
  const trainBoost = 1 + campus.trainEffBonus;
  const combinedPowerDerate = weightedRemoteDerate(
    fleetFlops,
    remoteFlops,
    powerDerate * rackDerate,
  );
  const combinedServeMem = weightedRemoteDerate(
    fleetFlops,
    remoteFlops,
    localServeHbmFit,
    remoteServeHbmFit,
  );
  const combinedSystemRam = weightedRemoteDerate(
    fleetFlops,
    remoteFlops,
    systemRamDerate,
  );
  const combinedCpu = weightedRemoteDerate(fleetFlops, remoteFlops, cpuDerate);
  const totalVramGb = fleet.vramGb + remoteVramGb;
  const trainingRamGb = totalVramGb * alloc.training;
  const combinedTrainMem =
    trainV.needGb > 0 ? Math.min(1, trainingRamGb / trainV.needGb) : 1;
  const chipCount = fleet.gpuCount + remoteGpuEquivalent;
  // Legacy token/sec is display-only. Convert remote PF through the same
  // physical 7B BF16 work estimate used by market settlement; never use a
  // universal tokens/PF multiplier as capacity.
  const referencePfPerMTok = pfPerMTokForModel(
    { paramsB: 7, activeParamsB: 7, family: "dense", inferCostMult: 1 },
    1,
  );
  const remoteDisplayTokPerSec =
    referencePfPerMTok > 0
      ? ((remoteFlops / referencePfPerMTok) * 1e6) / 86_400
      : 0;
  const hardwareTokPerSec = fleet.tokPerSec + remoteDisplayTokPerSec;

  const effectiveFlopsPf = trainPool * trainBoost + inferPool + researchPool;
  const stall = diagnoseComputeStall({
    localFleetPf,
    fleetFlops,
    hostedLocalPf,
    leasedOut,
    remoteFlops,
    serveMem,
    remoteServeMem,
    inferPool,
    hasServing,
    fullRawPool,
    effectiveFlopsPf,
    trainPool: trainPool * trainBoost,
    serveFraction,
    uncappedServeFraction,
    offlineFloor,
  });

  const snapshot: ComputeSnapshot = {
    rawFlopsPf: rawFlops,
    utilCap,
    effectiveUtil,
    pue,
    mwDemand,
    mwAvailable,
    mwBreakdown,
    mwForecast,
    powerDerate: combinedPowerDerate,
    effectiveFlopsPf,
    pools: {
      training: trainPool * trainBoost,
      inference: inferPool,
      research: researchPool,
    },
    fullRawPool,
    localFleetPf,
    remoteFlopsPf: remoteFlops,
    leasedOutPf: leasedOut,
    chipCount,
    avgTokPerSecPerChip: chipCount > 0 ? hardwareTokPerSec / chipCount : 0,
    throttled: localThrottled,
    rackCap,
    racksUsed: installedRackUnits,
    vramGb: totalVramGb,
    localVramGb: fleet.vramGb,
    remoteVramGb,
    trainingRamGb,
    vramNeedTrain: trainV.needGb,
    vramNeedServe: serveV.needGb,
    vramDerateTrain: combinedTrainMem,
    vramDerateServe: combinedServeMem,
    systemRamGb: systemRamGb + remoteSystemRamGb,
    localSystemRamGb: systemRamGb,
    remoteSystemRamGb,
    systemRamNeed,
    systemRamDerate: combinedSystemRam,
    cpuScore: cpuScore + remoteGpuEquivalent * 40,
    cpuNeed,
    cpuDerate: combinedCpu,
    engineerServeBonus: engServe,
    servingReservationPf: fullInferCapacity * Math.min(1, serveFractionNeeded),
    serveMemFit: serveMem,
    remoteServeMemFit: remoteServeMem,
    backfilledPf: fullRawPool * backfilledFraction,
    dutyCycle,
    stallReason: stall.reason,
    stallMessage: stall.message,
  };
  snapshotCache.set(key, snapshot);
  if (snapshotCache.size > 48) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
  return snapshot;
}

export function inferenceTokensPerDay(
  state: SimState,
  snap: ComputeSnapshot,
): number {
  const model = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId && isLivePublicModel(m),
  );
  if (!model) return 0;
  return inferenceCapacityMTok(snap, model, state.player.servingEfficiency);
}

/** @deprecated use fleetStats */
export function totalOnlineChips(player: SimState["player"]) {
  // thin wrapper for map.ts compatibility if any
  void player;
  return { count: 0, rawFlops: 0, mw: 0, tokPerSec: 0 };
}
