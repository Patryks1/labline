import type {
  CampaignEra,
  DataDomain,
  DatasetAsset,
  LabData,
  LabId,
  SimState,
} from "../types";
import { DATA_DOMAINS } from "../balance/data";
import {
  computeEffectiveDataBreakdown,
  emptyEffectiveDataBreakdown,
} from "../balance/effectiveData";
import type {
  Architecture,
  DataAllocation,
  EffectiveDataBreakdown,
  PostTrainPoolKind,
  PostTrainPools,
  TrainingModifiers,
} from "./types";
import { trainingStateOf, withTrainingState } from "./state";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function blendTeacherSynth(stockShare: number, teacherShare: number | undefined): number {
  const teacher = clamp01(teacherShare ?? 0);
  if (!(teacher > 0)) return clamp01(stockShare);
  return clamp01(stockShare * (1 - teacher) + teacher);
}

/**
 * $ per MTok for instruction/preference; $ per task; $ per trajectory.
 * Instruction/preference prices sit near cleaned chat / preference-pair market
 * lots; task and trajectory prices are per labelled unit, not per million tokens.
 */
export const POST_TRAIN_DATA_PRICE: Record<PostTrainPoolKind, number> = {
  instructionMTok: 800,
  preferenceMTok: 2_400,
  verifiableTasks: 4,
  toolTrajectories: 12,
};

export function postTrainDataUnitLabel(kind: PostTrainPoolKind): string {
  if (kind === "instructionMTok" || kind === "preferenceMTok") return "MTok";
  if (kind === "verifiableTasks") return "tasks";
  return "trajectories";
}

/**
 * Free-tier collected chat MTok converted into post-train pools each day.
 * 5% instruction / 2% preference: traffic is mostly duplicates, so only a
 * thin slice is usable as instruction or preference pairs.
 */
export const POST_TRAIN_TRAFFIC_TO_POOL = {
  instructionPerFreeChatMTok: 0.05,
  preferencePerFreeChatMTok: 0.02,
} as const;

/**
 * Rival labs without a DatasetAsset catalogue get this era-scaled unique
 * inventory, split like the public foundation mix, quality 0.58, no synthetic.
 * Generous vs the player's 500 MTok seed so rivals are not data-starved
 * while their inventory is still a scalar `dataMTok`.
 */
export const ERA_RIVAL_DEFAULT_MTOK: Record<CampaignEra, number> = {
  cloud_startup: 2_000,
  scaling_specialization: 8_000,
  platform_competition: 25_000,
  power_limited_frontier: 80_000,
  frontier_abundance: 200_000,
  endless: 400_000,
};

const RIVAL_DEFAULT_MIX: Partial<Record<DataDomain, number>> = {
  chat: 80,
  code: 180,
  math: 90,
  science: 80,
  image: 40,
  law: 15,
  health: 15,
};

export type AvailableDomainStock = {
  uniqueMTok: number;
  quality: number;
  syntheticShare: number;
  syntheticDepth: number;
  verifiedShare: number;
};

function labDataOf(state: SimState, labId: LabId): LabData | undefined {
  if (labId === state.playerLabId) return state.player.data;
  return state.rivals.find((rival) => rival.id === labId)?.data;
}

function eraOf(state: SimState): CampaignEra {
  return state.calendar?.era ?? state.progression?.era ?? "cloud_startup";
}

function assetDomainMTok(asset: DatasetAsset, domain: DataDomain): number {
  return Math.max(0, asset.volumeMTok) * Math.max(0, asset.domainWeights[domain] ?? 0);
}

function quality01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? clamp01(value / 100) : clamp01(value);
}

function assetQuality01(asset: DatasetAsset): number {
  if (asset.v4Synthetic && Number.isFinite(asset.v4Synthetic.quality)) {
    return quality01(asset.v4Synthetic.quality);
  }
  return quality01(asset.quality);
}

function isSyntheticAsset(asset: DatasetAsset): boolean {
  return (
    asset.source === "synthetic" ||
    asset.v4Synthetic != null ||
    asset.synthetic != null
  );
}

function assetDepth(asset: DatasetAsset): number {
  if (asset.v4Synthetic) return Math.max(0, asset.v4Synthetic.depth);
  return Math.max(0, asset.synthetic?.generationDepth ?? 0);
}

function assetVerifiedShare(asset: DatasetAsset): number {
  if (asset.v4Synthetic) return clamp01(asset.v4Synthetic.verifiedShare);
  const strength = asset.synthetic?.verifierStrength ?? 0;
  return strength > 0 ? clamp01(strength) : 0;
}

function mixFromAssets(
  assets: readonly DatasetAsset[],
): Partial<Record<DataDomain, AvailableDomainStock>> {
  const acc: Partial<
    Record<
      DataDomain,
      {
        unique: number;
        qualityAcc: number;
        synth: number;
        depthAcc: number;
        verifiedAcc: number;
      }
    >
  > = {};
  for (const asset of assets) {
    for (const domain of DATA_DOMAINS) {
      const mtok = assetDomainMTok(asset, domain);
      if (!(mtok > 0)) continue;
      const row = acc[domain] ?? {
        unique: 0,
        qualityAcc: 0,
        synth: 0,
        depthAcc: 0,
        verifiedAcc: 0,
      };
      row.unique += mtok;
      row.qualityAcc += assetQuality01(asset) * mtok;
      if (isSyntheticAsset(asset)) {
        row.synth += mtok;
        row.depthAcc += assetDepth(asset) * mtok;
        row.verifiedAcc += assetVerifiedShare(asset) * mtok;
      }
      acc[domain] = row;
    }
  }
  const out: Partial<Record<DataDomain, AvailableDomainStock>> = {};
  for (const domain of DATA_DOMAINS) {
    const row = acc[domain];
    if (!row || !(row.unique > 0)) continue;
    out[domain] = {
      uniqueMTok: row.unique,
      quality: row.qualityAcc / row.unique,
      syntheticShare: row.synth / row.unique,
      syntheticDepth: row.synth > 0 ? row.depthAcc / row.synth : 0,
      verifiedShare: row.synth > 0 ? row.verifiedAcc / row.synth : 0,
    };
  }
  return out;
}

function mixFromProcessed(
  data: LabData,
): Partial<Record<DataDomain, AvailableDomainStock>> {
  const out: Partial<Record<DataDomain, AvailableDomainStock>> = {};
  for (const domain of DATA_DOMAINS) {
    const stock = data.stocks[domain];
    const processed = Math.max(0, stock?.processed ?? 0);
    if (!(processed > 0)) continue;
    const synth = Math.max(0, (stock.fromSynthHQ ?? 0) + (stock.fromSynthLQ ?? 0));
    out[domain] = {
      uniqueMTok: processed,
      quality: quality01(stock.quality ?? 0),
      syntheticShare: processed > 0 ? Math.min(1, synth / processed) : 0,
      syntheticDepth: synth > 0 ? 1 : 0,
      verifiedShare: 0,
    };
  }
  return out;
}

function generousRivalDefault(
  state: SimState,
  labId: LabId,
): Partial<Record<DataDomain, AvailableDomainStock>> {
  const rival = state.rivals.find((candidate) => candidate.id === labId);
  const mixTotal =
    Object.values(RIVAL_DEFAULT_MIX).reduce((sum, n) => sum + (n ?? 0), 0) || 1;
  let total = ERA_RIVAL_DEFAULT_MTOK[eraOf(state)];
  if (rival?.dataMTok && rival.dataMTok > 0) {
    total = Math.max(total, rival.dataMTok);
  }
  const out: Partial<Record<DataDomain, AvailableDomainStock>> = {};
  const quality = quality01(rival?.dataQuality ?? 58);
  if (rival?.domainMTok) {
    for (const domain of DATA_DOMAINS) {
      const mtok = Math.max(0, rival.domainMTok[domain] ?? 0);
      if (!(mtok > 0)) continue;
      out[domain] = {
        uniqueMTok: mtok,
        quality,
        syntheticShare: 0,
        syntheticDepth: 0,
        verifiedShare: 0,
      };
    }
    if (Object.keys(out).length > 0) return out;
  }
  for (const domain of DATA_DOMAINS) {
    const weight = (RIVAL_DEFAULT_MIX[domain] ?? 0) / mixTotal;
    const mtok = total * weight;
    if (!(mtok > 0)) continue;
    out[domain] = {
      uniqueMTok: mtok,
      quality,
      syntheticShare: 0,
      syntheticDepth: 0,
      verifiedShare: 0,
    };
  }
  return out;
}

function applyReservations(
  mix: Partial<Record<DataDomain, AvailableDomainStock>>,
  reserved: Partial<Record<DataDomain, number>>,
): Partial<Record<DataDomain, AvailableDomainStock>> {
  const out: Partial<Record<DataDomain, AvailableDomainStock>> = {};
  for (const domain of DATA_DOMAINS) {
    const row = mix[domain];
    if (!row) continue;
    out[domain] = {
      ...row,
      uniqueMTok: Math.max(0, row.uniqueMTok - Math.max(0, reserved[domain] ?? 0)),
    };
  }
  return out;
}

/** Unique tokens, quality, synthetic share/depth, and verified share per domain. */
export function availableDomainTokens(
  state: SimState,
  labId: LabId,
): Partial<Record<DataDomain, AvailableDomainStock>> {
  const reserved = reservedTokensFor(state, labId);
  const data = labDataOf(state, labId);
  if (data) {
    const assets = data.assets ?? [];
    const fromAssets = assets.length > 0 ? mixFromAssets(assets) : {};
    const fromStock = mixFromProcessed(data);
    const merged: Partial<Record<DataDomain, AvailableDomainStock>> = { ...fromStock };
    for (const domain of DATA_DOMAINS) {
      const assetRow = fromAssets[domain];
      if (assetRow) merged[domain] = assetRow;
    }
    if (Object.keys(merged).length > 0) {
      return applyReservations(merged, reserved);
    }
  }
  if (labId !== state.playerLabId) {
    return applyReservations(generousRivalDefault(state, labId), reserved);
  }
  return applyReservations({}, reserved);
}

/**
 * D_eff = Σ tokens · qualityWeight · diversity · epochFactor · syntheticDiscount.
 * epochFactor(epochs) = 1 + 0.55 · log2(epochs) on unique tokens. MoE divides D_eff by 1.2.
 */
export function effectiveDataFor(
  state: SimState,
  labId: LabId,
  allocation: DataAllocation,
  arch: Architecture,
  modifiers: TrainingModifiers,
): EffectiveDataBreakdown {
  const requested = Object.entries(allocation.domainMTok).filter(
    (entry): entry is [DataDomain, number] =>
      typeof entry[1] === "number" && entry[1] > 0,
  );
  if (requested.length === 0) return emptyEffectiveDataBreakdown();

  const available = availableDomainTokens(state, labId);
  return computeEffectiveDataBreakdown({
    domains: requested.map(([domain, rawMTok]) => {
      const row = available[domain];
      return {
        domain,
        rawMTok,
        uniqueAvailableMTok: row?.uniqueMTok ?? 0,
        quality: row?.quality ?? 0,
        syntheticShare: blendTeacherSynth(row?.syntheticShare ?? 0, allocation.teacherSynthShare),
        syntheticDepth: row?.syntheticDepth ?? 0,
        verifiedShare: row?.verifiedShare ?? 0,
      };
    }),
    moe: arch.backbone === "moe",
    verifierStrength: modifiers.verifierStrength,
    syntheticQuality: modifiers.syntheticQuality,
  });
}

function labIdForRun(state: SimState, runId: string): LabId | null {
  if (state.player.training?.runs.some((run) => run.id === runId)) {
    return state.playerLabId;
  }
  for (const rival of state.rivals) {
    if (rival.training?.runs.some((run) => run.id === runId)) return rival.id;
  }
  return null;
}

/**
 * Records the unique tokens a run has claimed so concurrent runs cannot all
 * attribute the same corpus. Assets are never deleted by a reservation.
 * Replaces any prior reservation for the same run.
 */
export function reserveTokens(
  state: SimState,
  runId: string,
  allocation: DataAllocation,
): SimState {
  const labId = labIdForRun(state, runId);
  if (!labId) return state;
  const training = trainingStateOf(state, labId);
  const domainMTok: Partial<Record<DataDomain, number>> = {};
  for (const [domain, mtok] of Object.entries(allocation.domainMTok)) {
    if (typeof mtok === "number" && mtok > 0) {
      domainMTok[domain as DataDomain] = mtok;
    }
  }
  return withTrainingState(state, labId, {
    ...training,
    reservations: [
      ...training.reservations.filter((entry) => entry.runId !== runId),
      { runId, domainMTok },
    ],
  });
}

export function releaseReservation(state: SimState, runId: string): SimState {
  let next = state;
  const labIds: LabId[] = [state.playerLabId, ...state.rivals.map((r) => r.id)];
  for (const labId of labIds) {
    const training = trainingStateOf(next, labId);
    if (!training.reservations.some((entry) => entry.runId === runId)) continue;
    next = withTrainingState(next, labId, {
      ...training,
      reservations: training.reservations.filter((entry) => entry.runId !== runId),
    });
  }
  return next;
}

/** Unique tokens already claimed by other in-flight runs of this lab, per domain. */
export function reservedTokensFor(
  state: SimState,
  labId: LabId,
  excludeRunId?: string,
): Partial<Record<DataDomain, number>> {
  const totals: Partial<Record<DataDomain, number>> = {};
  for (const entry of trainingStateOf(state, labId).reservations) {
    if (entry.runId === excludeRunId) continue;
    for (const [domain, mtok] of Object.entries(entry.domainMTok)) {
      const key = domain as DataDomain;
      totals[key] = (totals[key] ?? 0) + (mtok ?? 0);
    }
  }
  return totals;
}

export function poolsFor(state: SimState, labId: LabId): PostTrainPools {
  return trainingStateOf(state, labId).pools;
}

export function poolQualityOf(
  training: { pools: PostTrainPools; poolQuality?: PostTrainPools },
  kind: PostTrainPoolKind,
): number {
  const amount = Math.max(0, training.pools[kind] ?? 0);
  if (!(amount > 0)) return 0;
  const stored = training.poolQuality?.[kind];
  if (typeof stored === "number" && Number.isFinite(stored)) {
    return Math.max(0, Math.min(1, stored));
  }
  return 1;
}

export function blendPoolQuality(
  prevAmount: number,
  prevQuality: number,
  addAmount: number,
  addQuality: number,
): number {
  const a = Math.max(0, prevAmount);
  const b = Math.max(0, addAmount);
  if (a + b <= 0) return 0;
  return (a * prevQuality + b * Math.max(0, Math.min(1, addQuality))) / (a + b);
}

export function addToPool(
  state: SimState,
  labId: LabId,
  kind: PostTrainPoolKind,
  amount: number,
  quality = 1,
): SimState {
  if (!(amount > 0)) return state;
  const training = trainingStateOf(state, labId);
  const prev = training.pools[kind];
  const prevQ = poolQualityOf(training, kind);
  const nextAmount = prev + amount;
  const nextQuality = blendPoolQuality(prev, prevQ, amount, quality);
  return withTrainingState(state, labId, {
    ...training,
    pools: { ...training.pools, [kind]: nextAmount },
    poolQuality: {
      instructionMTok: poolQualityOf(training, "instructionMTok"),
      preferenceMTok: poolQualityOf(training, "preferenceMTok"),
      verifiableTasks: poolQualityOf(training, "verifiableTasks"),
      toolTrajectories: poolQualityOf(training, "toolTrajectories"),
      [kind]: nextQuality,
    },
  });
}

/** Subtracts each pool amount in `use`, clamped at zero. */
export function consumeFromPool(
  state: SimState,
  labId: LabId,
  use: PostTrainPools,
): SimState {
  const training = trainingStateOf(state, labId);
  const pools = { ...training.pools };
  for (const key of Object.keys(pools) as PostTrainPoolKind[]) {
    pools[key] = Math.max(0, pools[key] - Math.max(0, use[key] ?? 0));
  }
  const previousQuality = training.poolQuality;
  if (!previousQuality) {
    return withTrainingState(state, labId, { ...training, pools });
  }
  const poolQuality = {
    instructionMTok:
      pools.instructionMTok > 0 ? poolQualityOf(training, "instructionMTok") : 0,
    preferenceMTok:
      pools.preferenceMTok > 0 ? poolQualityOf(training, "preferenceMTok") : 0,
    verifiableTasks:
      pools.verifiableTasks > 0 ? poolQualityOf(training, "verifiableTasks") : 0,
    toolTrajectories:
      pools.toolTrajectories > 0 ? poolQualityOf(training, "toolTrajectories") : 0,
  };
  return withTrainingState(state, labId, { ...training, pools, poolQuality });
}
