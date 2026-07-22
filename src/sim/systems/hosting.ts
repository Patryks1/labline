import { isDcKind, isDcAnchor } from "./map";
/**
 * Model hosting: VRAM + compute needs inside data halls.
 * Small models → compute-heavy (high tok/s target).
 * Giant models → memory-heavy (weights dominate; FLOPS scales sublinearly).
 */
import { getRackSku } from "../balance/rackSkus";
import { modelVramGb } from "../balance/racks";
import type { Model, SimState } from "../types";
import { fleetStats, resolveRackSku } from "./racks";
import { dcBayUsage, orderRacksIntoDc } from "./dcRacks";
import { computeSnapshot } from "./compute";
import { facilityAnchorTiles } from "./worldAccess";

export interface ModelHostNeed {
  modelId: string;
  name: string;
  paramsB: number;
  /** MoE active params (billions); same as paramsB for dense */
  activeParamsB: number;
  /** GB of fleet VRAM needed to host (serve) — MoE includes expert residency */
  vramGb: number;
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
  freeBays: number;
  fillAllRacks: number;
  marketAvailable: number;
  affordableRacks: number;
  maxRacks: number;
  canFillAll: boolean;
  reservePerRack: number;
}

/** Aggregate quote for a multi-hall order. Supply and cash are capped once for the whole batch. */
export function quoteRackDeployment(
  state: SimState,
  skuId: string,
  targets: RackDeploymentTarget[],
): RackDeploymentQuote {
  const sku = resolveRackSku(skuId, state.player.rackDesigns);
  const rackUnits = Math.max(1, sku.rackUnits);
  let freeBays = 0;
  let fillAllRacks = 0;
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
    const free = dcBayUsage(state, hall.x, hall.y).free;
    selectedHalls += 1;
    freeBays += free;
    fillAllRacks += Math.floor(free / rackUnits);
  }
  const supply = state.worldMarkets.accelerators[skuId];
  const marketAvailable = Math.max(
    0,
    Math.floor(supply?.available ?? fillAllRacks),
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
    Math.min(fillAllRacks, marketAvailable, affordableRacks),
  );
  return {
    skuId,
    rackUnits,
    selectedHalls,
    freeBays,
    fillAllRacks,
    marketAvailable,
    affordableRacks,
    maxRacks,
    canFillAll: fillAllRacks > 0 && maxRacks >= fillAllRacks,
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
    const free = dcBayUsage(next, target.x, target.y).free;
    const count = Math.min(remaining, Math.floor(free / quote.rackUnits));
    if (count <= 0) continue;
    const before = next.worldMarkets.orders.length;
    next = orderRacksIntoDc(next, target.x, target.y, skuId, count);
    if (next.worldMarkets.orders.length <= before) break;
    remaining -= count;
  }
  return next;
}

/** Hosting shape from model size — used for UI + auto-balance. */
export function modelHostNeed(m: Model): ModelHostNeed {
  const vramGb = modelVramGb(
    m.paramsB,
    m.activeParamsB,
    m.family,
    m.trainingNumerics?.computeFormat?.includes("fp32") ? "fp32" : "fp16",
  );
  const isMoe = m.family === "moe";
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
  // Base PF to run the *active* path well (game units)
  const hostPf =
    Math.pow(activeB, 0.55) *
    0.85 *
    (0.55 + computeBias * 0.9) *
    Math.max(0.5, m.inferCostMult ?? 1) *
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
    hostPf,
    computeBias,
    ramBias,
    note,
  };
}

export interface FleetHostSnapshot {
  vramHave: number;
  vramNeed: number;
  pfHave: number;
  pfServe: number;
  pfNeed: number;
  /** compute utilization for serve (target ~0.8) */
  computeUtil: number;
  vramUtil: number;
  shortOn: "ok" | "vram" | "compute" | "both";
  models: ModelHostNeed[];
  /** SKU id best for filling the shortfall */
  recommendedSkuId: string;
  recommendedSkuReason: string;
}

function publicModels(state: SimState): Model[] {
  return state.player.models.filter(
    (m) => m.release === "released" || m.shipped,
  );
}

function activeServeModels(state: SimState): Model[] {
  const pub = publicModels(state);
  if (pub.length === 0) return [];
  const active = pub.find((m) => m.id === state.player.pricing.activeModelId);
  // Host active + any plan-attached models (unique)
  const ids = new Set<string>();
  if (active) ids.add(active.id);
  for (const id of state.player.pricing.apiModelIds ?? []) ids.add(id);
  for (const plan of state.player.pricing.plans) {
    if (!plan.enabled) continue;
    for (const id of plan.modelIds) ids.add(id);
  }
  const list = pub.filter((m) => ids.has(m.id));
  return list.length > 0 ? list : active ? [active] : pub.slice(0, 1);
}

export function fleetHostSnapshot(state: SimState): FleetHostSnapshot {
  const models = activeServeModels(state).map(modelHostNeed);
  // Parallel host: sum VRAM; compute need is max + 0.35 * rest (shared batching)
  let vramNeed = 0;
  let pfNeed = 0;
  if (models.length === 1) {
    vramNeed = models[0]!.vramGb;
    pfNeed = models[0]!.hostPf;
  } else if (models.length > 1) {
    const sorted = [...models].sort((a, b) => b.hostPf - a.hostPf);
    vramNeed = models.reduce((s, m) => s + m.vramGb, 0);
    pfNeed =
      sorted[0]!.hostPf +
      sorted.slice(1).reduce((s, m) => s + m.hostPf * 0.35, 0);
  }

  // Align with computeSnapshot: power/VRAM/RAM/CPU derates, not raw fleet PF
  const snap = computeSnapshot(state);
  const pfHave = snap.rawFlopsPf;
  const pfServe = snap.pools.inference;
  const vramHave = snap.vramGb;
  // Hosting plans against admitted load, not every request rejected by the
  // dominant-lab sales ceiling. Latent demand remains visible in Market.
  const trafficPf =
    state.lastMarket?.servedPf ??
    Math.min(
      state.lastMarket?.demandPf ?? 0,
      state.lastMarket?.capacityPf ?? 0,
    );
  const effectivePfNeed = Math.max(pfNeed, trafficPf);
  const computeUtil = effectivePfNeed > 0.01 ? pfServe / effectivePfNeed : 0;
  const vramUtil = vramNeed > 0.01 ? vramHave / vramNeed : 1;

  const shortVram = vramNeed > 0 && vramHave < vramNeed * 0.95;
  const shortCompute =
    effectivePfNeed > 0.01 && pfServe < effectivePfNeed * 0.85;
  let shortOn: FleetHostSnapshot["shortOn"] = "ok";
  if (shortVram && shortCompute) shortOn = "both";
  else if (shortVram) shortOn = "vram";
  else if (shortCompute) shortOn = "compute";

  // Recommend SKU from catalog biases
  let recommendedSkuId = "rack_h100";
  let recommendedSkuReason = "Balanced H-Node for general serve.";
  if (shortOn === "vram" || (models[0] && models[0].ramBias > 0.55)) {
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
    pfHave,
    pfServe,
    pfNeed: effectivePfNeed,
    computeUtil,
    vramUtil,
    shortOn,
    models,
    recommendedSkuId,
    recommendedSkuReason,
  };
}

/**
 * Auto-balance toward ~80% compute util on the serve pool + enough VRAM.
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
  if (host.shortOn === "vram" || host.shortOn === "both") {
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
    (host.shortOn !== "ok" || host.computeUtil < 0.65)
  ) {
    // How many bays to order: close gap toward 80% util / VRAM cover
    let needBays = 0;
    if (host.vramNeed > host.vramHave) {
      const vramGap = host.vramNeed * 1.05 - host.vramHave;
      needBays = Math.max(
        needBays,
        Math.ceil(vramGap / Math.max(1, sku.vramGb)),
      );
    }
    if (host.pfNeed > 0 && host.computeUtil < 0.8) {
      const pfGap = host.pfNeed * 0.85 - host.pfServe;
      if (pfGap > 0) {
        needBays = Math.max(
          needBays,
          Math.ceil(pfGap / Math.max(0.05, sku.flopsPf)),
        );
      }
    }
    needBays = Math.min(48, Math.max(0, needBays));

    // Fill halls with free capacity
    // `needBays` is a bay count; orders are expressed in complete rack SKUs.
    let remainingRacks = Math.ceil(needBays / Math.max(1, sku.rackUnits));
    for (const h of halls) {
      if (remainingRacks <= 0) break;
      const free = dcBayUsage(s, h.x, h.y).free;
      if (free < sku.rackUnits) continue;
      const can = Math.floor(free / sku.rackUnits);
      const buy = Math.min(can, remainingRacks);
      if (buy <= 0) continue;
      const before = s.player.cash;
      s = orderRacksIntoDc(s, h.x, h.y, skuId, buy);
      if (s.player.cash < before) remainingRacks -= buy;
      else break; // couldn't afford
    }
  }

  const after = fleetHostSnapshot(s);
  const msg = `Auto-balance: serve ${(s.player.allocation.inference * 100).toFixed(0)}% · VRAM ${after.vramHave.toFixed(0)}/${after.vramNeed.toFixed(0)} GB · compute util ${(after.computeUtil * 100).toFixed(0)}% · ${after.recommendedSkuReason}`;

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

/**
 * Reserve every free bay in every completed player data hall in one action.
 * The rack screen uses this explicit capacity command; the separate hosting
 * auto-balancer remains demand-based and targets roughly 80% utilization.
 */
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

  const freeAtStart = halls.reduce(
    (sum, hall) => sum + dcBayUsage(state, hall.x, hall.y).free,
    0,
  );
  if (freeAtStart <= 0) {
    return {
      ...state,
      alerts: [
        {
          id: `fill-halls-full-${state.day}`,
          day: state.day,
          severity: "info" as const,
          message: "All completed data-hall bays are already committed.",
        },
        ...state.alerts.filter((entry) => !entry.id.startsWith("fill-halls-")),
      ].slice(0, 40),
    };
  }

  let next = state;
  let racksQueued = 0;
  let baysCommitted = 0;
  let hallsFilled = 0;
  for (const hall of halls) {
    const free = dcBayUsage(next, hall.x, hall.y).free;
    const count = Math.floor(free / Math.max(1, sku.rackUnits));
    if (count <= 0) continue;
    const ordersBefore = next.worldMarkets.orders.length;
    const candidate = orderRacksIntoDc(next, hall.x, hall.y, skuId, count);
    next = candidate;
    if (candidate.worldMarkets.orders.length <= ordersBefore) break;
    racksQueued += count;
    baysCommitted += count * Math.max(1, sku.rackUnits);
    hallsFilled += 1;
  }

  const completelyFilled = baysCommitted >= freeAtStart;
  const message =
    baysCommitted > 0
      ? `Fill halls: queued ${racksQueued}× ${sku.name} across ${hallsFilled} halls · ${baysCommitted}/${freeAtStart} free bays committed${completelyFilled ? "." : " (cash or market access limited)."}`
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
    host.shortOn === "vram"
      ? "Helps VRAM"
      : host.shortOn === "compute"
        ? "Helps compute"
        : "Balanced fit";
  return { score, label };
}
