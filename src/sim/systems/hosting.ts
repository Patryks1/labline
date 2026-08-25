import { isDcKind, isDcAnchor } from "./map";
/**
 * Model hosting: VRAM + compute needs inside data halls.
 * Small models → compute-heavy (high tok/s target).
 * Giant models → memory-heavy (weights dominate; FLOPS scales sublinearly).
 */
import { getRackSku } from "../balance/rackSkus";
import { defaultServePrecisionForModel, estimateServingMemory, precisionComputeMult } from "../balance/tokenServe";
import type { Model, ServePrecision, SimState } from "../types";
import { fleetStats, resolveRackSku } from "./racks";
import { orderRacksIntoDc } from "./dcRacks";
import { computeSnapshot } from "./compute";
import { facilityAnchorTiles } from "./worldAccess";
import { servingPlacementNeed } from "./servingPlacement";

export interface ModelHostNeed {
  modelId: string;
  name: string;
  paramsB: number;
  /** MoE active params (billions); same as paramsB for dense */
  activeParamsB: number;
  /** GB of fleet VRAM needed to host (serve) — MoE includes expert residency */
  vramGb: number;
  systemRamGb: number;
  weightMemoryGb: number;
  kvCacheGb: number;
  workspaceGb: number;
  precision: ServePrecision;
  /** PF of fleet needed for healthy serve latency — MoE scales with *active* only */
  hostPf: number;
  /** 0–1: bias toward compute (high when active path is large) */
  computeBias: number;
  /** 0–1: bias toward RAM (high when total experts are huge) */
  ramBias: number;
  note: string;
}

export interface RackDeploymentTarget {
  x: number;
  y: number;
}

export interface RackDeploymentQuote {
  skuId: string;
  rackUnits: number;
  selectedHalls: number;
  /** Collision-valid empty cabinet footprints explicitly drawn in layouts. */
  plannedCabinets: number;
  marketAvailable: number;
  affordableRacks: number;
  maxRacks: number;
  canFillPlanned: boolean;
  reservePerRack: number;
}

function plannedCabinetsForSku(
  state: SimState,
  hall: { x: number; y: number; campusId?: string },
  rackUnits: number,
): number {
  const facilityId = hall.campusId ?? `facility:${hall.x},${hall.y}`;
  const layout = state.dataHallLayouts?.[facilityId];
  if (!layout) return 0;
  return layout.objects.filter((object) => {
    if (object.kind !== "rack" || !object.reserved) return false;
    try {
      return (
        Math.max(
          1,
          resolveRackSku(
            object.catalogId,
            state.player.rackDesigns,
          ).rackUnits,
        ) >= rackUnits
      );
    } catch {
      return rackUnits <= 1;
    }
  }).length;
}

/** Aggregate quote for a multi-hall order. Supply and cash are capped once for the whole batch. */
export function quoteRackDeployment(
  state: SimState,
  skuId: string,
  targets: RackDeploymentTarget[],
): RackDeploymentQuote {
  const sku = resolveRackSku(skuId, state.player.rackDesigns);
  const rackUnits = Math.max(1, sku.rackUnits);
  let plannedCabinets = 0;
  let selectedHalls = 0;
  for (const target of targets) {
    const hall = facilityAnchorTiles(state, { ownerId: "player" }).find(
      (tile) => tile.x === target.x && tile.y === target.y,
    );
    if (
      !hall ||
      !isDcKind(hall.kind) ||
      !isDcAnchor(hall) ||
      hall.buildingProgress < hall.buildingTarget
    )
      continue;
    selectedHalls += 1;
    plannedCabinets += plannedCabinetsForSku(state, hall, rackUnits);
  }
  const supply = state.worldMarkets.accelerators[skuId];
  const marketAvailable = Math.max(
    0,
    Math.floor(supply?.available ?? plannedCabinets),
  );
  const reservePerRack = Math.max(
    1,
    (supply?.reserveUnitPrice ?? sku.price) * 1.08,
  );
  const affordableRacks = Math.max(
    0,
    Math.floor(state.player.cash / reservePerRack),
  );
  const maxRacks = Math.max(
    0,
    Math.min(plannedCabinets, marketAvailable, affordableRacks),
  );
  return {
    skuId,
    rackUnits,
    selectedHalls,
    plannedCabinets,
    marketAvailable,
    affordableRacks,
    maxRacks,
    canFillPlanned:
      plannedCabinets > 0 && maxRacks >= plannedCabinets,
    reservePerRack,
  };
}

/** Submit one supply-aware batch and distribute it across the selected halls. */
export function deployRackBatchAcrossHalls(
  state: SimState,
  skuId: string,
  targets: RackDeploymentTarget[],
  requestedRacks: number,
): SimState {
  const quote = quoteRackDeployment(state, skuId, targets);
  let remaining = Math.min(
    Math.max(0, Math.floor(requestedRacks)),
    quote.maxRacks,
  );
  if (remaining <= 0) return state;
  let next = state;
  for (const target of targets) {
    if (remaining <= 0) break;
    const hall = facilityAnchorTiles(next, { ownerId: "player" }).find(
      (tile) => tile.x === target.x && tile.y === target.y,
    );
    if (!hall) continue;
    const count = Math.min(
      remaining,
      plannedCabinetsForSku(next, hall, quote.rackUnits),
    );
    if (count <= 0) continue;
    const cashBefore = next.player.cash;
    next = orderRacksIntoDc(next, target.x, target.y, skuId, count);
    if (next.player.cash >= cashBefore) break; // blocked or unaffordable
    remaining -= count;
  }
  return next;
}

/** Hosting shape from model size — used for UI + auto-balance. */
export function modelHostNeed(
  m: Model,
  opts?: { precision?: ServePrecision; concurrentRequests?: number; contextTokens?: number },
): ModelHostNeed {
  const precision = opts?.precision ?? defaultServePrecisionForModel(m);
  const memory = estimateServingMemory({
    model: m,
    precision,
    concurrentRequests: opts?.concurrentRequests,
    avgInputTokens: opts?.contextTokens,
  });
  const vramGb = memory.residentMemoryGb;
  const isMoe = m.backbone === "moe" || (m.backbone == null && m.family === "moe");
  // Serve FLOPS: active path only for MoE; full size for dense
  const activeB = Math.max(
    0.01,
    isMoe ? (m.activeParamsB ?? m.paramsB * 0.1) : m.paramsB,
  );
  const totalB = Math.max(activeB, m.paramsB);
  // Compute need tracks active; VRAM tracks total (experts) for MoE
  const computeBias = Math.max(
    0.12,
    Math.min(0.92, 1.05 - Math.log10(activeB + 1) * 0.28),
  );
  let ramBias = 1 - computeBias;
  if (isMoe && totalB > activeB * 4) {
    // Huge expert set → memory-bound even with small active
    ramBias = Math.max(
      ramBias,
      Math.min(0.88, 0.45 + Math.log10(totalB / activeB) * 0.22),
    );
  }
  // Minimum low-latency replica floor. Work per token is linear in active
  // parameters; live traffic below remains the authoritative incremental load.
  const hostPf =
    activeB *
    0.45 *
    Math.max(0.5, m.inferCostMult ?? 1) *
    precisionComputeMult(precision) *
    (isMoe ? 0.92 : 1);

  let note: string;
  if (isMoe) {
    note =
      totalB > activeB * 6
        ? `MoE: serve compute ≈ ${activeB.toFixed(1)}B active · VRAM holds ~${totalB.toFixed(0)}B experts — prioritize high-VRAM racks.`
        : `MoE: host PF scales with active (${activeB.toFixed(1)}B), not full ${totalB.toFixed(0)}B total.`;
  } else if (activeB < 40) {
    note = "Compute-heavy: favor high-FLOPS racks; VRAM is modest.";
  } else if (activeB < 200) {
    note = "Balanced: need both FLOPS and VRAM.";
  } else if (activeB < 800) {
    note = "Memory-leaning: high-VRAM racks matter more than peak FLOPS.";
  } else {
    note = "Memory-bound giant: prioritize VRAM density; FLOPS secondary.";
  }

  return {
    modelId: m.id,
    name: m.name,
    paramsB: m.paramsB,
    activeParamsB: activeB,
    vramGb,
    systemRamGb: memory.requiredSystemRamGb,
    weightMemoryGb: memory.weightMemoryGb,
    kvCacheGb: memory.kvCacheGb,
    workspaceGb: memory.workspaceGb,
    precision,
    hostPf,
    computeBias,
    ramBias,
    note,
  };
}

export interface FleetHostSnapshot {
  vramHave: number;
  vramNeed: number;
  systemRamHave: number;
  systemRamNeed: number;
  pfHave: number;
  pfServe: number;
  pfNeed: number;
  /** Available serving PF / required PF. This is coverage, not utilization. */
  computeCoverage: number;
  /** Available VRAM / required resident VRAM. This is coverage, not utilization. */
  vramCoverage: number;
  systemRamCoverage: number;
  shortOn: "ok" | "hbm" | "system_ram" | "compute" | "multiple";
  models: ModelHostNeed[];
  /** SKU id best for filling the shortfall */
  recommendedSkuId: string;
  recommendedSkuReason: string;
}

export function fleetHostSnapshot(state: SimState): FleetHostSnapshot {
  const placement = servingPlacementNeed(state);
  const models = placement.placements.map((row) =>
    modelHostNeed(row.model, {
      precision: row.precision,
      concurrentRequests: row.concurrentRequests,
      contextTokens: row.contextTokens,
    }),
  );
  // Each simultaneously hosted model needs a minimum replica. Batching can
  // amortize weight reads within one model, but cannot share work or weights
  // across different models.
  let vramNeed = placement.hbmNeedGb;
  let pfNeed = 0;
  let systemRamNeed = placement.systemRamNeedGb;
  if (models.length === 1) {
    pfNeed = models[0]!.hostPf;
  } else if (models.length > 1) {
    pfNeed = models.reduce((s, m) => s + m.hostPf, 0);
  }

  // Align with computeSnapshot: power/VRAM/RAM/CPU derates, not raw fleet PF
  const snap = computeSnapshot(state);
  const pfHave = snap.rawFlopsPf;
  const pfServe = snap.pools.inference;
  const vramHave = snap.vramGb;
  const systemRamHave = snap.systemRamGb;
  // Hosting plans against admitted load, not every request rejected by the
  // dominant-lab sales ceiling. Latent demand remains visible in Market.
  const trafficPf =
    state.lastMarket?.servedPf ??
    Math.min(
      state.lastMarket?.demandPf ?? 0,
      state.lastMarket?.capacityPf ?? 0,
    );
  const effectivePfNeed = Math.max(pfNeed, trafficPf);
  const computeCoverage = effectivePfNeed > 0.01 ? pfServe / effectivePfNeed : 0;
  const vramCoverage = vramNeed > 0.01 ? vramHave / vramNeed : 1;
  const systemRamCoverage = systemRamNeed > 0.01 ? systemRamHave / systemRamNeed : 1;

  const shortVram = vramNeed > 0 && vramHave + 1e-9 < vramNeed;
  const shortSystemRam = systemRamNeed > 0 && systemRamHave + 1e-9 < systemRamNeed;
  const shortCompute =
    effectivePfNeed > 0.01 && pfServe < effectivePfNeed * 0.85;
  const shortages = Number(shortVram) + Number(shortSystemRam) + Number(shortCompute);
  let shortOn: FleetHostSnapshot["shortOn"] = "ok";
  if (shortages > 1) shortOn = "multiple";
  else if (shortVram) shortOn = "hbm";
  else if (shortSystemRam) shortOn = "system_ram";
  else if (shortCompute) shortOn = "compute";

  // Recommend SKU from catalog biases
  let recommendedSkuId = "rack_h100";
  let recommendedSkuReason = "Balanced H-Node for general serve.";
  if (shortOn === "hbm" || shortOn === "multiple" || (models[0] && models[0].ramBias > 0.55)) {
    recommendedSkuId = "rack_h200";
    recommendedSkuReason =
      "High-VRAM H2-Node — better for large weight residency.";
  } else if (
    shortOn === "compute" ||
    (models[0] && models[0].computeBias > 0.6)
  ) {
    recommendedSkuId = "rack_infer";
    recommendedSkuReason =
      "Serve Sled — more tokens/sec per bay for smaller models.";
  } else if (
    models[0] &&
    (models[0].ramBias > 0.6 || models[0].paramsB >= 400)
  ) {
    recommendedSkuId = "rack_h200";
    recommendedSkuReason =
      models[0].activeParamsB < models[0].paramsB * 0.25
        ? "High-VRAM for large MoE expert residency (active path is smaller)."
        : "Memory-leaning fleet for frontier weights.";
  }

  return {
    vramHave,
    vramNeed,
    systemRamHave,
    systemRamNeed,
    pfHave,
    pfServe,
    pfNeed: effectivePfNeed,
    computeCoverage,
    vramCoverage,
    systemRamCoverage,
    shortOn,
    models,
    recommendedSkuId,
    recommendedSkuReason,
  };
}

/**
 * Auto-balance toward the existing ~80% minimum compute-coverage policy plus
 * enough resident VRAM.
 * - Tweaks train/serve/research split
 * - Orders recommended racks into halls with free bays (if cash allows)
 */
export function autoBalanceHosting(state: SimState): SimState {
  const host = fleetHostSnapshot(state);
  const models = host.models;
  if (models.length === 0) {
    return {
      ...state,
      alerts: [
        {
          id: `host-none-${state.day}`,
          day: state.day,
          severity: "warn" as const,
          message: "No public model to host — release a model first.",
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }

  // Target: inference pool covers ~traffic need (or host floor), aiming ~80% util
  const fleet = fleetStats(state);
  const pfHave = Math.max(0.01, fleet.flopsPf);
  const trafficNeed = Math.max(host.pfNeed, state.lastMarket?.demandPf ?? 0);
  // Desired serve PF covers traffic with a little headroom, capped so train/research remain
  const targetServePf = Math.min(
    pfHave * 0.85,
    Math.max(trafficNeed * 1.15, pfHave * 0.25),
  );
  let inferShare = Math.min(0.88, Math.max(0.15, targetServePf / pfHave));
  // If VRAM short, still keep some train but prioritize serve less if can't load model
  if (host.shortOn === "hbm" || host.shortOn === "multiple") {
    inferShare = Math.min(0.55, inferShare);
  }
  const trainShare = Math.max(0.1, (1 - inferShare) * 0.55);
  const researchShare = Math.max(0.08, 1 - inferShare - trainShare);
  const sum = inferShare + trainShare + researchShare;
  let s: SimState = {
    ...state,
    player: {
      ...state.player,
      allocation: {
        training: trainShare / sum,
        inference: inferShare / sum,
        research: researchShare / sum,
      },
    },
  };

  // Order racks into free bays to close VRAM/compute gap
  const skuId = host.recommendedSkuId;
  let sku;
  try {
    sku = getRackSku(skuId);
  } catch {
    sku = null;
  }

  const halls = facilityAnchorTiles(s, { ownerId: "player" }).filter(
    (t) =>
      isDcKind(t.kind) &&
      isDcAnchor(t) &&
      t.buildingProgress >= t.buildingTarget,
  );

  if (
    sku &&
    halls.length > 0 &&
    (host.shortOn !== "ok" || host.computeCoverage < 0.65)
  ) {
    // How many bays to order: close gap toward 80% compute/VRAM coverage
    let needBays = 0;
    if (host.vramNeed > host.vramHave) {
      const vramGap = host.vramNeed * 1.05 - host.vramHave;
      needBays = Math.max(
        needBays,
        Math.ceil(vramGap / Math.max(1, sku.vramGb)),
      );
    }
    if (host.pfNeed > 0 && host.computeCoverage < 0.8) {
      const pfGap = host.pfNeed * 0.85 - host.pfServe;
      if (pfGap > 0) {
        needBays = Math.max(
          needBays,
          Math.ceil(pfGap / Math.max(0.05, sku.flopsPf)),
        );
      }
    }
    needBays = Math.min(48, Math.max(0, needBays));

    // Fill only explicit empty cabinet footprints. Hardware without a drawn
    // destination remains staged rather than consuming an abstract shell bay.
    let remainingRacks = Math.ceil(needBays / Math.max(1, sku.rackUnits));
    for (const h of halls) {
      if (remainingRacks <= 0) break;
      const can = plannedCabinetsForSku(s, h, Math.max(1, sku.rackUnits));
      const buy = Math.min(can, remainingRacks);
      if (buy <= 0) continue;
      const before = s.player.cash;
      s = orderRacksIntoDc(s, h.x, h.y, skuId, buy);
      if (s.player.cash < before) remainingRacks -= buy;
      else break; // couldn't afford
    }
  }

  const after = fleetHostSnapshot(s);
  const msg = `Auto-balance: serve ${(s.player.allocation.inference * 100).toFixed(0)}% · VRAM ${after.vramHave.toFixed(0)}/${after.vramNeed.toFixed(0)} GB · compute coverage ${(after.computeCoverage * 100).toFixed(0)}% · ${after.recommendedSkuReason}`;

  return {
    ...s,
    alerts: [
      {
        id: `host-bal-${s.day}`,
        day: s.day,
        severity: (after.shortOn === "ok" ? "info" : "warn") as "info" | "warn",
        message: msg,
      },
      ...s.alerts.filter((a) => !a.id.startsWith("host-")),
    ].slice(0, 40),
  };
}

/** Fill every explicit empty cabinet footprint across completed halls. */
export function fillAllAvailableRackBays(state: SimState): SimState {
  const host = fleetHostSnapshot(state);
  const skuId = host.recommendedSkuId;
  let sku;
  try {
    sku = getRackSku(skuId);
  } catch {
    return {
      ...state,
      alerts: [
        {
          id: `fill-halls-sku-${state.day}`,
          day: state.day,
          severity: "warn" as const,
          message: "No compatible market rack is available for this fleet.",
        },
        ...state.alerts.filter((entry) => !entry.id.startsWith("fill-halls-")),
      ].slice(0, 40),
    };
  }

  const halls = facilityAnchorTiles(state, { ownerId: "player" })
    .filter(
      (tile) =>
        isDcKind(tile.kind) &&
        isDcAnchor(tile) &&
        tile.buildingProgress >= tile.buildingTarget,
    )
    .toSorted((a, b) => a.y - b.y || a.x - b.x);

  const spacesAtStart = halls.reduce(
    (sum, hall) =>
      sum + plannedCabinetsForSku(state, hall, Math.max(1, sku.rackUnits)),
    0,
  );
  if (spacesAtStart <= 0) {
    return {
      ...state,
      alerts: [
        {
          id: `fill-halls-full-${state.day}`,
          day: state.day,
          severity: "info" as const,
          message:
            "No compatible empty cabinet footprints are planned. Add physical rack placements in the hall editor first.",
        },
        ...state.alerts.filter((entry) => !entry.id.startsWith("fill-halls-")),
      ].slice(0, 40),
    };
  }

  let next = state;
  let racksQueued = 0;
  let rackWidthsCommitted = 0;
  let hallsFilled = 0;
  for (const hall of halls) {
    const count = plannedCabinetsForSku(
      next,
      hall,
      Math.max(1, sku.rackUnits),
    );
    if (count <= 0) continue;
    const cashBefore = next.player.cash;
    next = orderRacksIntoDc(next, hall.x, hall.y, skuId, count);
    if (next.player.cash >= cashBefore) break; // blocked or unaffordable
    racksQueued += count;
    rackWidthsCommitted += count * Math.max(1, sku.rackUnits);
    hallsFilled += 1;
  }

  const completelyFilled = racksQueued >= spacesAtStart;
  const message =
    racksQueued > 0
      ? `Fill plans: queued ${racksQueued}× ${sku.name} across ${hallsFilled} halls · ${racksQueued}/${spacesAtStart} physical cabinet footprints committed (${rackWidthsCommitted} rack-width units)${completelyFilled ? "." : " (cash or market access limited)."}`
      : "No racks were queued — check cash and market access.";
  return {
    ...next,
    alerts: [
      {
        id: `fill-halls-${next.day}`,
        day: next.day,
        severity: (completelyFilled ? "info" : "warn") as "info" | "warn",
        message,
      },
      ...next.alerts.filter((entry) => !entry.id.startsWith("fill-halls-")),
    ].slice(0, 40),
  };
}

/** Prefer high-VRAM or high-FLOPS racks when selling is needed? (export for UI tips) */
export function rackFitScore(
  state: SimState,
  skuId: string,
): { score: number; label: string } {
  const host = fleetHostSnapshot(state);
  let sku;
  try {
    sku = resolveRackSku(skuId, state.player.rackDesigns);
  } catch {
    return { score: 0, label: "unknown" };
  }
  const ramB = host.models[0]?.ramBias ?? 0.5;
  const compB = host.models[0]?.computeBias ?? 0.5;
  const vramScore = sku.vramGb * ramB;
  const flopScore = sku.flopsPf * 80 * compB;
  const score = vramScore + flopScore;
  const label =
    host.shortOn === "hbm"
      ? "Helps HBM"
      : host.shortOn === "system_ram"
        ? "Helps host RAM"
      : host.shortOn === "compute"
        ? "Helps compute"
        : "Balanced fit";
  return { score, label };
}
