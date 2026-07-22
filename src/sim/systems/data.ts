/**
 * Token-based data flywheel (MTok = million tokens).
 * Sources: web · user · synth. AI gen burns research PF.
 */
import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_ECONOMY,
  DOMAIN_DATA_CONTRACTS,
  DATA_SELLER_LABELS,
  DATA_QUALITY_LABELS,
  emptyDataMarket,
  generateDataMarketOffers,
  createEmptyLabData,
  formatTokens,
  minDataMTokForParams,
  normalizeDomainStock,
  normalizeWeights,
  recommendedDataMTok,
  recommendedDataUnits,
  resolveDataPlan,
  totalProcessed,
  totalRaw,
  totalSources,
  type DomainDataContract,
} from "../balance/data";
import { createRng, hashSeed, seededId } from "../rng";
import { queueDataOfferOrder } from "./sharedMarkets";
import type {
  DataDomain,
  DataPruneJob,
  DataSellerKind,
  LabData,
  Model,
  ProcessJob,
  SimState,
  SyntheticFillRecord,
  SynthGenJob,
  TrainingDataPlan,
  DataSupplierContract,
} from "../types";
import { computeSnapshot, normalizeAllocation } from "./compute";
import { campusBonuses } from "./campus";
import { aggregateEffects } from "./research";
import { modelCanCurateDataDomain } from "./modelEligibility";
import {
  estimateSyntheticQuality,
  teacherCapabilityForDataDomain,
} from "../balance/modelCapabilities";
import { appendDatasetAsset, syntheticDatasetAsset } from "./dataAssets";
import { playerStaff } from "./staff";
import {
  cloneLabData,
  collectTrafficData,
  dataProcessingThroughput,
  enqueueAutomaticProcessing,
  processDataJobs,
  syntheticGenerationMTokPerDay,
  updateDataQualityIndex,
} from "./dataRuntime";

export {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DOMAIN_DATA_CONTRACTS,
  DATA_SELLER_LABELS,
  DATA_QUALITY_LABELS,
  emptyDataMarket,
  generateDataMarketOffers,
  formatTokens,
  minDataMTokForParams,
  recommendedDataMTok,
  recommendedDataUnits,
  resolveDataPlan,
  totalProcessed,
  totalRaw,
  totalSources,
  createEmptyLabData,
  type DomainDataContract,
};

export function ensureLabData(state: SimState): LabData {
  const raw = state.player.data;
  if (!raw) return createEmptyLabData();
  return cloneLabData(raw);
}

/** Research PF fraction available for tech (1 − data gen). */
export function researchPoolForTech(state: SimState): number {
  const data = ensureLabData(state);
  const share = dataResearchReservationShare(data);
  const safetyShare = state.player.safetyCampaign ? 0.4 : 0;
  return Math.max(0, 1 - share - safetyShare);
}

/** One physical research pool is shared by synthesis, pruning, and tech research. */
export function dataResearchReservationShare(data: LabData): number {
  const synthShare = (data.synthQueue ?? []).reduce(
    (sum, job) => sum + job.researchShare,
    0,
  );
  const pruneShare = (data.pruneQueue ?? []).reduce(
    (sum, job) => sum + job.researchShare,
    0,
  );
  return Math.max(
    0,
    Math.min(DATA_ECONOMY.maxDataGenResearchShare, synthShare + pruneShare),
  );
}

/** Gross research PF before continuous data-generation reservations are removed. */
export function grossResearchPoolPf(state: SimState): number {
  const data = ensureLabData(state);
  const reserved = dataResearchReservationShare(data);
  const snapshot = computeSnapshot(state);
  const techPool = snapshot.pools.research;
  // The scheduler backfills an idle research reservation into training. Action
  // previews still need the capacity that would return when research work is queued.
  const prospectivePool =
    snapshot.effectiveFlopsPf *
    normalizeAllocation(state.player.allocation).research;
  return Math.max(techPool / Math.max(0.15, 1 - reserved), prospectivePool);
}

export const DATA_PRUNE_QUALITY_FLOOR = 65;
const DATA_PRUNE_RESEARCH_SHARE = 0.08;
const DATA_PRUNE_MAX_JOBS = 9;
const DATA_PRUNE_MIN_ACTIVE_PF = 0.05;
const DATA_PRUNE_AUDIT_DAYS = 14;

export interface DataPruneAuditEstimate {
  cashCost: number;
  validDays: number;
  validUntilDay: number;
  unlocked: boolean;
  ok: boolean;
  reason?: string;
}

/** A paid sample audit reveals the otherwise private low-quality share of the corpus. */
export function estimateDataPruneAudit(
  state: SimState,
): DataPruneAuditEstimate {
  const data = ensureLabData(state);
  const corpusMTok = totalRaw(data) + totalProcessed(data);
  const cashCost = Math.max(10_000, Math.min(250_000, corpusMTok * 75));
  const validUntilDay = data.pruneAuditValidUntilDay ?? -1;
  const unlocked = validUntilDay >= state.day;
  let reason: string | undefined;
  if (unlocked) reason = `Audit already active through D${validUntilDay}`;
  else if (corpusMTok < 0.5) reason = "No corpus to audit";
  else if (state.player.cash + 1e-9 < cashCost)
    reason = `Needs ${formatMoneyShort(cashCost)} cash`;
  return {
    cashCost,
    validDays: DATA_PRUNE_AUDIT_DAYS,
    validUntilDay,
    unlocked,
    ok: reason == null,
    reason,
  };
}

export function purchaseDataPruneAudit(state: SimState): SimState {
  const audit = estimateDataPruneAudit(state);
  if (!audit.ok)
    return alert(
      state,
      audit.unlocked ? "info" : "warn",
      audit.reason ?? "Unable to audit corpus.",
    );
  const data = cloneLabData(ensureLabData(state));
  data.pruneAuditValidUntilDay = state.day + audit.validDays;
  const next = {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - audit.cashCost,
      data,
    },
  };
  return alert(
    next,
    "info",
    `Corpus audit complete. Low-quality volumes are visible through D${data.pruneAuditValidUntilDay}.`,
  );
}

export interface DataPruneEstimate {
  domain: DataDomain;
  rawMTok: number;
  processedMTok: number;
  totalMTok: number;
  cashCost: number;
  pfDays: number;
  researchersRequired: number;
  researchShare: number;
  availableResearchPf: number;
  ok: boolean;
  reason?: string;
}

function lowQualityDataForDomain(
  data: LabData,
  domain: DataDomain,
): {
  rawMTok: number;
  processedMTok: number;
} {
  const stock = data.stocks[domain];
  // Raw stock has not passed the eval/cleaning pipeline; audit a conservative
  // slice for duplicates, corrupt records, and low-signal samples.
  const rawRate = Math.max(
    0.1,
    Math.min(0.45, 0.16 + (DATA_PRUNE_QUALITY_FLOOR - stock.quality) / 130),
  );
  const rawMTok = stock.raw * rawRate;
  const qualityInferred =
    stock.processed *
    Math.max(
      0,
      Math.min(0.55, (DATA_PRUNE_QUALITY_FLOOR - stock.quality) / 80),
    );
  const processedMTok = Math.min(
    stock.processed,
    Math.max(stock.fromSynthLQ ?? 0, qualityInferred),
  );
  return { rawMTok, processedMTok };
}

export function estimateDataPrune(
  state: SimState,
  domain: DataDomain,
): DataPruneEstimate {
  const data = ensureLabData(state);
  const audit = estimateDataPruneAudit(state);
  const lowQuality = lowQualityDataForDomain(data, domain);
  const totalMTok = lowQuality.rawMTok + lowQuality.processedMTok;
  const meta = DATA_DOMAIN_META[domain];
  const cashPerMTok = meta.processCostPerMTok * 2.5;
  const pfDaysPerMTok = meta.processHard * 0.65;
  const researchersRequired = Math.max(
    1,
    Math.min(4, Math.ceil(totalMTok / 250)),
  );
  const existingShare = dataResearchReservationShare(data);
  const researchers = playerStaff(state).researcher ?? 0;
  const availableResearchPf =
    grossResearchPoolPf(state) * DATA_PRUNE_RESEARCH_SHARE;
  const alreadyQueued = data.pruneQueue.some((job) => job.domain === domain);
  let reason: string | undefined;
  if (totalMTok < 0.5) reason = "No low-quality stock detected";
  else if (!audit.unlocked)
    reason = `Run corpus audit · ${formatMoneyShort(audit.cashCost)}`;
  else if (alreadyQueued) reason = "Audit already queued";
  else if (data.pruneQueue.length >= DATA_PRUNE_MAX_JOBS)
    reason = "Pruning queue full";
  else if (researchers < researchersRequired) {
    reason = `Needs ${researchersRequired} researchers (have ${researchers})`;
  } else if (state.player.cash + 1e-9 < totalMTok * cashPerMTok) {
    reason = `Needs ${formatMoneyShort(totalMTok * cashPerMTok)} cash`;
  } else if (availableResearchPf < DATA_PRUNE_MIN_ACTIVE_PF)
    reason = "No research compute available";
  else if (
    existingShare + DATA_PRUNE_RESEARCH_SHARE >
    DATA_ECONOMY.maxDataGenResearchShare + 1e-9
  ) {
    reason = "Research pool is fully reserved";
  }
  return {
    domain,
    ...lowQuality,
    totalMTok,
    cashCost: totalMTok * cashPerMTok,
    pfDays: totalMTok * pfDaysPerMTok,
    researchersRequired,
    researchShare: DATA_PRUNE_RESEARCH_SHARE,
    availableResearchPf,
    ok: reason == null,
    reason,
  };
}

function formatMoneyShort(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function enqueueDataPrune(
  state: SimState,
  domain: DataDomain,
): SimState {
  const estimate = estimateDataPrune(state, domain);
  if (!estimate.ok)
    return alert(state, "warn", estimate.reason ?? "Unable to prune data.");
  const data = cloneLabData(ensureLabData(state));
  const meta = DATA_DOMAIN_META[domain];
  const job: DataPruneJob = {
    id: seededId(
      "prune",
      state.seed,
      state.day,
      domain,
      data.pruneQueue.length,
    ),
    domain,
    rawRemaining: estimate.rawMTok,
    processedRemaining: estimate.processedMTok,
    rawTotal: estimate.rawMTok,
    processedTotal: estimate.processedMTok,
    cashPerMTok: estimate.cashCost / Math.max(0.001, estimate.totalMTok),
    pfDaysPerMTok: estimate.pfDays / Math.max(0.001, estimate.totalMTok),
    researchersRequired: estimate.researchersRequired,
    researchShare: estimate.researchShare,
    qualityBefore: data.stocks[domain].quality,
  };
  data.pruneQueue.push(job);
  data.dataGenResearchShare = dataResearchReservationShare(data);
  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: "info" as const,
        message: `Low-quality ${meta.label} audit queued: ${formatTokens(estimate.totalMTok)} · ${formatMoneyShort(estimate.cashCost)} · ${Math.ceil(estimate.pfDays)} PF-days.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export interface AllDataPruneEstimate {
  domains: DataDomain[];
  totalMTok: number;
  cashCost: number;
  pfDays: number;
  researchersRequired: number;
  ok: boolean;
  reason?: string;
}

export function estimateAllDataPrunes(state: SimState): AllDataPruneEstimate {
  const data = ensureLabData(state);
  const audit = estimateDataPruneAudit(state);
  const candidates = DATA_DOMAINS.map((domain) =>
    estimateDataPrune(state, domain),
  ).filter(
    (estimate) =>
      estimate.totalMTok >= 0.5 &&
      !data.pruneQueue.some((job) => job.domain === estimate.domain),
  );
  const cashCost = candidates.reduce(
    (sum, estimate) => sum + estimate.cashCost,
    0,
  );
  const pfDays = candidates.reduce((sum, estimate) => sum + estimate.pfDays, 0);
  const totalMTok = candidates.reduce(
    (sum, estimate) => sum + estimate.totalMTok,
    0,
  );
  const researchersRequired = candidates.length
    ? Math.max(...candidates.map((estimate) => estimate.researchersRequired))
    : 0;
  const totalShare =
    dataResearchReservationShare(data) +
    candidates.length * DATA_PRUNE_RESEARCH_SHARE;
  const researchers = playerStaff(state).researcher ?? 0;
  let reason: string | undefined;
  if (candidates.length === 0) reason = "No low-quality stock detected";
  else if (!audit.unlocked)
    reason = `Run corpus audit · ${formatMoneyShort(audit.cashCost)}`;
  else if (data.pruneQueue.length + candidates.length > DATA_PRUNE_MAX_JOBS)
    reason = "Pruning queue full";
  else if (researchers < researchersRequired) {
    reason = `Needs ${researchersRequired} researchers (have ${researchers})`;
  } else if (state.player.cash + 1e-9 < cashCost)
    reason = `Needs ${formatMoneyShort(cashCost)} cash`;
  else if (
    candidates.some(
      (estimate) => estimate.availableResearchPf < DATA_PRUNE_MIN_ACTIVE_PF,
    )
  ) {
    reason = "No research compute available";
  } else if (totalShare > DATA_ECONOMY.maxDataGenResearchShare + 1e-9) {
    reason = "Needs more free research compute";
  }
  return {
    domains: candidates.map((estimate) => estimate.domain),
    totalMTok,
    cashCost,
    pfDays,
    researchersRequired,
    ok: reason == null,
    reason,
  };
}

export function enqueueAllDataPrunes(state: SimState): SimState {
  const estimate = estimateAllDataPrunes(state);
  if (!estimate.ok)
    return alert(state, "warn", estimate.reason ?? "Unable to prune all data.");
  let next = state;
  for (const domain of estimate.domains) next = enqueueDataPrune(next, domain);
  return next;
}

/** 1 = current frontier teacher; lower values warn that a running corpus is going stale. */
export function synthTeacherFreshness(
  state: SimState,
  model: Model,
  domain: DataDomain,
): { freshness: number; capabilityGap: number; frontierName: string } {
  const candidates = [
    ...state.player.models,
    ...state.rivals.flatMap((rival) => rival.models),
  ].filter(
    (candidate) =>
      candidate.release === "released" ||
      candidate.shipped ||
      candidate.release === "internal",
  );
  let frontier = model;
  let frontierCapability = teacherCapabilityForDataDomain(model, domain);
  for (const candidate of candidates) {
    const capability = teacherCapabilityForDataDomain(candidate, domain);
    if (capability > frontierCapability) {
      frontier = candidate;
      frontierCapability = capability;
    }
  }
  const teacherCapability = teacherCapabilityForDataDomain(model, domain);
  const capabilityGap = Math.max(0, frontierCapability - teacherCapability);
  return {
    freshness: Math.max(0.4, 1 - capabilityGap / 45),
    capabilityGap,
    frontierName: frontier.name,
  };
}

export function collectFromTraffic(state: SimState): SimState {
  const flywheel =
    aggregateEffects(state.player.researchUnlocked).dataFlywheel ?? 0;
  const result = collectTrafficData({
    data: ensureLabData(state),
    servedMTok: state.lastMarket.servedMTok,
    demandMTok: state.lastMarket.playerDemandMTok,
    brandTrust: state.player.brandTrust,
    dataFlywheel: flywheel,
    segments: state.segments,
  });
  return {
    ...state,
    player: {
      ...state.player,
      data: result.data,
      brandTrust: result.brandTrust,
    },
  };
}

export function setCollectionRate(state: SimState, rate: number): SimState {
  const data = cloneLabData(ensureLabData(state));
  data.collectionRate = Math.max(0, Math.min(1, rate));
  return { ...state, player: { ...state.player, data } };
}

export function setAutoProcess(state: SimState, on: boolean): SimState {
  const data = cloneLabData(ensureLabData(state));
  data.autoProcess = on;
  return { ...state, player: { ...state.player, data } };
}

export function enqueueProcess(
  state: SimState,
  domain: DataDomain,
  amount: number,
  qualityTarget = 70,
): SimState {
  const data = cloneLabData(ensureLabData(state));
  const stock = data.stocks[domain];
  const take = Math.min(stock.raw, Math.max(0, amount));
  if (take < 0.5) {
    return alert(
      state,
      "warn",
      `Not enough raw ${DATA_DOMAIN_META[domain].label} tokens to process.`,
    );
  }
  if (data.processQueue.length >= DATA_ECONOMY.maxProcessJobs) {
    return alert(state, "warn", "Processing queue full.");
  }
  stock.raw -= take;
  const job: ProcessJob = {
    id: seededId(
      "proc",
      state.seed,
      state.day,
      domain,
      data.processQueue.length,
    ),
    domain,
    remaining: take,
    total: take,
    qualityTarget: Math.max(30, Math.min(95, qualityTarget)),
  };
  data.processQueue.push(job);
  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: "info" as const,
        message: `Processing ${formatTokens(take)} ${DATA_DOMAIN_META[domain].label} (Q${job.qualityTarget}).`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export function enqueueProcessAll(state: SimState): SimState {
  let s = state;
  for (const d of DATA_DOMAINS) {
    const raw = ensureLabData(s).stocks[d].raw;
    if (raw >= 1) s = enqueueProcess(s, d, raw, 68);
  }
  return s;
}

/**
 * Start AI data generation for a domain using a player model.
 * Burns a share of the research PF pool (slows tech research).
 */
export function startSynthGen(
  state: SimState,
  opts: {
    domain: DataDomain;
    modelId: string;
    targetMTok?: number;
    researchShare: number;
    /** HQ needs data_synth + capable model; LQ is always noisier/faster */
    qualityTier?: "hq" | "lq";
  },
): SimState {
  if (!state.player.researchUnlocked.includes("data_synth")) {
    return alert(
      state,
      "warn",
      "Unlock Synthetic Generators (data tree: mix → clean → eval → synth) first.",
    );
  }
  const model = state.player.models.find((m) => m.id === opts.modelId);
  if (!model) return alert(state, "warn", "Pick a model to generate data.");
  if (!(
    model.release === "released" ||
    model.shipped ||
    model.release === "internal"
  )) {
    return alert(state, "warn", "Model must be a finished checkpoint.");
  }

  let tier: "hq" | "lq" = opts.qualityTier ?? "hq";
  // Weak teachers cannot produce true HQ — force LQ
  if (tier === "hq" && model.capability < 38) {
    tier = "lq";
  }

  const data = cloneLabData(ensureLabData(state));
  if ((data.synthQueue?.length ?? 0) >= DATA_ECONOMY.maxSynthJobs) {
    return alert(state, "warn", "Synth queue full — wait for jobs to finish.");
  }

  const share = Math.max(0.05, Math.min(0.5, opts.researchShare));
  const used = dataResearchReservationShare(data);
  if (used + share > DATA_ECONOMY.maxDataGenResearchShare + 0.001) {
    return alert(
      state,
      "warn",
      `Research pool for data gen is full (${Math.round(used * 100)}%). Lower share or wait.`,
    );
  }

  const continuous = opts.targetMTok == null;
  const target = continuous ? 0 : Math.max(5, opts.targetMTok ?? 5);
  const job: SynthGenJob = {
    id: seededId(
      "synth",
      state.seed,
      state.day,
      opts.domain,
      opts.modelId,
      data.synthQueue.length,
    ),
    domain: opts.domain,
    modelId: model.id,
    modelName: model.name,
    targetMTok: target,
    progressMTok: 0,
    continuous,
    researchShare: share,
    qualityTier: tier,
  };
  data.synthQueue = [...(data.synthQueue ?? []), job];
  data.dataGenResearchShare = dataResearchReservationShare(data);

  const pfDay = grossResearchPoolPf(state) * share;
  const generatedPerDay = syntheticGenerationMTokPerDay({
    domain: opts.domain,
    teacherDomainCapability: teacherCapabilityForDataDomain(model, opts.domain),
    teacherReliability: model.quality.reliability,
    researchPf: pfDay,
    tier,
  });
  const estDays =
    generatedPerDay > 0.01 && !continuous
      ? Math.ceil(target / generatedPerDay)
      : null;

  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: "info" as const,
        message: `Continuous AI gen (${tier.toUpperCase()}): ${model.name} → ${DATA_DOMAIN_META[opts.domain].label} (~${Math.round(share * 100)}% research${estDays ? ` · ~${estDays}d` : ""}). Update the teacher when its frontier freshness falls.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export interface SynthBudgetEstimate {
  model: Model | null;
  researchPf: number;
  grossMTokPerDay: number;
  usefulChance: number;
  hqChance: number;
}

function synthBudgetTeacher(state: SimState): Model | null {
  return (
    state.player.models
      .filter(
        (model) =>
          model.release === "released" ||
          model.shipped ||
          model.release === "internal",
      )
      .sort(
        (left, right) =>
          right.capability * 0.72 +
          right.quality.reliability * 0.28 -
          (left.capability * 0.72 + left.quality.reliability * 0.28),
      )[0] ?? null
  );
}

/** Forecast an automatic synthetic portfolio from one player-facing compute budget. */
export function estimateSynthBudget(
  state: SimState,
  researchShare: number,
): SynthBudgetEstimate {
  const model = synthBudgetTeacher(state);
  const share = Math.max(0.05, Math.min(0.5, researchShare));
  const researchPf = grossResearchPoolPf(state) * share;
  if (!model) {
    return {
      model: null,
      researchPf,
      grossMTokPerDay: 0,
      usefulChance: 0,
      hqChance: 0,
    };
  }

  const intelligence = Math.max(
    0,
    Math.min(
      1,
      (model.capability * 0.72 + model.quality.reliability * 0.28) / 100,
    ),
  );
  const computeSignal = researchPf / Math.max(12, researchPf + 12);
  const grossMTokPerDay = DATA_DOMAINS.reduce(
    (sum, domain) =>
      sum +
      syntheticGenerationMTokPerDay({
        domain,
        teacherDomainCapability: teacherCapabilityForDataDomain(model, domain),
        teacherReliability: model.quality.reliability,
        researchPf: researchPf / DATA_DOMAINS.length,
        tier: "lq",
      }),
    0,
  );

  return {
    model,
    researchPf,
    grossMTokPerDay,
    usefulChance: Math.max(
      0.18,
      Math.min(0.9, 0.2 + intelligence * 0.45 + computeSignal * 0.25),
    ),
    hqChance: Math.max(
      0.12,
      Math.min(0.88, 0.1 + intelligence * 0.58 + computeSignal * 0.2),
    ),
  };
}

/** Start the simplified auto-routing generator used by the Data workspace. */
export function startSynthBudget(
  state: SimState,
  opts: { researchShare: number },
): SimState {
  if (!state.player.researchUnlocked.includes("data_synth")) {
    return alert(
      state,
      "warn",
      "Unlock Synthetic Generators (data tree: mix → clean → eval → synth) first.",
    );
  }
  const estimate = estimateSynthBudget(state, opts.researchShare);
  if (!estimate.model)
    return alert(
      state,
      "warn",
      "Train a finished model before generating data.",
    );

  const data = cloneLabData(ensureLabData(state));
  const existing = data.synthQueue.find((job) => job.autoPortfolio);
  if (existing) {
    const otherShare = data.synthQueue.reduce(
      (sum, job) => sum + (job.id === existing.id ? 0 : job.researchShare),
      0,
    );
    const availableShare = Math.max(
      0,
      DATA_ECONOMY.maxDataGenResearchShare - otherShare,
    );
    if (availableShare < 0.05) {
      return alert(
        state,
        "warn",
        "Research pool is already reserved by other data jobs.",
      );
    }
    const share = Math.max(
      0.05,
      Math.min(0.5, availableShare, opts.researchShare),
    );
    data.synthQueue = data.synthQueue.map((job) =>
      job.id === existing.id ? { ...job, researchShare: share } : job,
    );
    data.dataGenResearchShare = dataResearchReservationShare(data);
    return {
      ...state,
      player: { ...state.player, data },
      alerts: [
        {
          id: `synth-budget-update-${state.day}`,
          day: state.day,
          severity: "info" as const,
          message: `Synthetic compute budget updated to ${Math.round(share * 100)}% of research.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    };
  }

  if (data.synthQueue.length >= DATA_ECONOMY.maxSynthJobs) {
    return alert(
      state,
      "warn",
      "Synthetic queue is full. Stop an existing generator first.",
    );
  }
  const share = Math.max(0.05, Math.min(0.5, opts.researchShare));
  const used = dataResearchReservationShare(data);
  if (used + share > DATA_ECONOMY.maxDataGenResearchShare + 0.001) {
    return alert(
      state,
      "warn",
      "Research pool is already reserved. Lower the synth budget first.",
    );
  }
  const job: SynthGenJob = {
    id: seededId("synth-auto", state.seed, state.day, estimate.model.id),
    domain: "chat",
    modelId: estimate.model.id,
    modelName: estimate.model.name,
    targetMTok: 0,
    progressMTok: 0,
    continuous: true,
    researchShare: share,
    qualityTier: "hq",
    autoPortfolio: true,
    hqMTok: 0,
    lqMTok: 0,
    wastedMTok: 0,
  };
  data.synthQueue = [...data.synthQueue, job];
  data.dataGenResearchShare = dataResearchReservationShare(data);
  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: "info" as const,
        message: `Synthetic compute online: ${Math.round(share * 100)}% research, with ${estimate.model.name} auto-routing useful output.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

export function cancelSynthGen(state: SimState, jobId: string): SimState {
  const data = cloneLabData(ensureLabData(state));
  data.synthQueue = data.synthQueue.filter((j) => j.id !== jobId);
  data.dataGenResearchShare = dataResearchReservationShare(data);
  return { ...state, player: { ...state.player, data } };
}

/** Estimate MTok/day for a synth config (UI). */
export function estimateSynthMTokPerDay(
  state: SimState,
  model: Model,
  domain: DataDomain,
  researchShare: number,
): number {
  const pf =
    grossResearchPoolPf(state) * Math.max(0.05, Math.min(0.5, researchShare));
  return syntheticGenerationMTokPerDay({
    domain,
    teacherDomainCapability: teacherCapabilityForDataDomain(model, domain),
    teacherReliability: model.quality.reliability,
    researchPf: pf,
    tier: "hq",
  });
}

function removeProcessedLowQuality(
  stock: LabData["stocks"][DataDomain],
  amount: number,
): void {
  const oldProcessed = stock.processed;
  const removed = Math.min(oldProcessed, Math.max(0, amount));
  if (removed <= 0) return;

  let sourceLeft = removed;
  const takeLq = Math.min(stock.fromSynthLQ ?? 0, sourceLeft);
  stock.fromSynthLQ = Math.max(0, (stock.fromSynthLQ ?? 0) - takeLq);
  stock.fromSynth = Math.max(
    stock.fromSynthHQ ?? 0,
    (stock.fromSynth ?? 0) - takeLq,
  );
  sourceLeft -= takeLq;

  // Older saves only retain aggregate source counts. Remove remaining inferred
  // low-quality records proportionally so provenance remains conserved.
  const sourceKeys = [
    "fromWeb",
    "fromUser",
    "fromBought",
    "fromSynth",
  ] as const;
  const sourceTotal = sourceKeys.reduce(
    (sum, key) => sum + Math.max(0, stock[key] ?? 0),
    0,
  );
  if (sourceLeft > 0 && sourceTotal > 0) {
    const ratio = Math.min(1, sourceLeft / sourceTotal);
    for (const key of sourceKeys)
      stock[key] = Math.max(0, (stock[key] ?? 0) * (1 - ratio));
    const synthTotal = (stock.fromSynthHQ ?? 0) + (stock.fromSynthLQ ?? 0);
    stock.fromSynth = Math.max(synthTotal, stock.fromSynth ?? 0);
  }

  const nextProcessed = Math.max(0, oldProcessed - removed);
  // Audits target records around Q22. Removing them raises the surviving
  // corpus average without manufacturing any new high-quality tokens.
  stock.quality =
    nextProcessed > 0
      ? Math.max(
          stock.quality,
          Math.min(
            95,
            (stock.quality * oldProcessed - 22 * removed) / nextProcessed,
          ),
        )
      : DATA_PRUNE_QUALITY_FLOOR;
  stock.processed = nextProcessed;
}

function processDataPruneJobs(
  state: SimState,
  dataInput: LabData,
  cashInput: number,
): { data: LabData; cash: number; alerts: SimState["alerts"] } {
  const data = cloneLabData(dataInput);
  let cash = cashInput;
  let alerts = state.alerts;
  const researchers = playerStaff(state).researcher ?? 0;
  const grossResearchPf = grossResearchPoolPf({
    ...state,
    player: { ...state.player, data },
  });
  const queue: DataPruneJob[] = [];

  for (const job of data.pruneQueue) {
    const totalLeft = job.rawRemaining + job.processedRemaining;
    if (totalLeft <= 0.001) continue;
    if (researchers < job.researchersRequired || grossResearchPf <= 0.001) {
      queue.push(job);
      if (state.day % 4 === 0) {
        alerts = [
          {
            id: `prune-stalled-${job.id}-${state.day}`,
            day: state.day,
            severity: "warn" as const,
            message: `${DATA_DOMAIN_META[job.domain].label} pruning stalled — needs ${job.researchersRequired} researchers and research compute.`,
          },
          ...alerts,
        ].slice(0, 40);
      }
      continue;
    }

    const byCompute =
      (grossResearchPf * job.researchShare) /
      Math.max(0.001, job.pfDaysPerMTok);
    const byCash = cash / Math.max(0.001, job.cashPerMTok);
    const step = Math.min(totalLeft, byCompute, byCash);
    if (step <= 0.001) {
      queue.push(job);
      if (state.day % 4 === 0) {
        alerts = [
          {
            id: `prune-cash-${job.id}-${state.day}`,
            day: state.day,
            severity: "warn" as const,
            message: `${DATA_DOMAIN_META[job.domain].label} pruning paused — insufficient cash.`,
          },
          ...alerts,
        ].slice(0, 40);
      }
      continue;
    }

    const rawStep = Math.min(
      job.rawRemaining,
      step * (job.rawRemaining / totalLeft),
    );
    const processedStep = Math.min(job.processedRemaining, step - rawStep);
    const stock = data.stocks[job.domain];
    stock.raw = Math.max(0, stock.raw - rawStep);
    removeProcessedLowQuality(stock, processedStep);
    cash -= (rawStep + processedStep) * job.cashPerMTok;
    const nextJob: DataPruneJob = {
      ...job,
      rawRemaining: Math.max(0, job.rawRemaining - rawStep),
      processedRemaining: Math.max(0, job.processedRemaining - processedStep),
    };
    if (nextJob.rawRemaining + nextJob.processedRemaining > 0.5) {
      queue.push(nextJob);
    } else {
      alerts = [
        {
          id: `prune-done-${job.id}`,
          day: state.day,
          severity: "info" as const,
          message: `${DATA_DOMAIN_META[job.domain].label} audit complete — ${formatTokens(job.rawTotal + job.processedTotal)} low-quality tokens discarded; surviving corpus is Q${Math.round(stock.quality)}.`,
        },
        ...alerts,
      ].slice(0, 40);
    }
  }
  data.pruneQueue = queue;
  data.dataGenResearchShare = dataResearchReservationShare(data);
  return { data, cash: Math.max(0, cash), alerts };
}

export function tickData(state: SimState): SimState {
  let data = cloneLabData(ensureLabData(state));
  data.dayProcessed = 0;
  data.daySynthMTok = 0;
  let cash = state.player.cash;
  let alerts = state.alerts;
  const snap = computeSnapshot(state);

  // ─── AI synth jobs (claim research PF first) ───
  const synthQueue: SynthGenJob[] = [];
  for (const job of data.synthQueue ?? []) {
    if (job.autoPortfolio) {
      const liveState = { ...state, player: { ...state.player, data } };
      const estimate = estimateSynthBudget(liveState, job.researchShare);
      const model = estimate.model;
      if (!model || estimate.grossMTokPerDay <= 0) {
        synthQueue.push(job);
        continue;
      }

      let grossToday = 0;
      let hqToday = 0;
      let lqToday = 0;
      let wasteToday = 0;
      for (const domain of DATA_DOMAINS) {
        const rng = createRng(hashSeed(state.seed, state.day, job.id, domain));
        const domainGross = syntheticGenerationMTokPerDay({
          domain,
          teacherDomainCapability: teacherCapabilityForDataDomain(
            model,
            domain,
          ),
          teacherReliability: model.quality.reliability,
          researchPf: estimate.researchPf / DATA_DOMAINS.length,
          tier: "lq",
        });
        const gross = domainGross * (0.82 + rng.next() * 0.36);
        const usefulFraction = Math.max(
          0.04,
          Math.min(0.96, estimate.usefulChance * (0.68 + rng.next() * 0.64)),
        );
        const hqFraction = Math.max(
          0.05,
          Math.min(0.95, estimate.hqChance * (0.72 + rng.next() * 0.56)),
        );
        const useful = gross * usefulFraction;
        const hq = useful * hqFraction;
        const lq = useful - hq;
        const waste = gross - useful;
        grossToday += gross;
        hqToday += hq;
        lqToday += lq;
        wasteToday += waste;
        if (useful <= 0.001) continue;

        const stock = normalizeDomainStock(data.stocks[domain]);
        const priorProcessed = stock.processed;
        const freshness = synthTeacherFreshness(liveState, model, domain);
        const hqAssetSeed = syntheticDatasetAsset({
          id: `dataset-${job.id}-${domain}-hq`,
          name: `Auto ${DATA_DOMAIN_META[domain].label} synthetic · high quality`,
          domain,
          volumeMTok: hq,
          quality: 0,
          teacherModelId: model.id,
          tier: "hq",
          day: state.day,
        });
        const lqAssetSeed = syntheticDatasetAsset({
          id: `dataset-${job.id}-${domain}-lq`,
          name: `Auto ${DATA_DOMAIN_META[domain].label} synthetic · low quality`,
          domain,
          volumeMTok: lq,
          quality: 0,
          teacherModelId: model.id,
          tier: "lq",
          day: state.day,
        });
        const hqQuality = Math.max(
          18,
          estimateSyntheticQuality({
            domain,
            teacherDomainCapability: teacherCapabilityForDataDomain(
              model,
              domain,
            ),
            provenance: hqAssetSeed.synthetic!,
          }).quality -
            freshness.capabilityGap * 0.35,
        );
        const lqQuality = Math.max(
          12,
          estimateSyntheticQuality({
            domain,
            teacherDomainCapability: teacherCapabilityForDataDomain(
              model,
              domain,
            ),
            provenance: lqAssetSeed.synthetic!,
          }).quality -
            freshness.capabilityGap * 0.5,
        );
        const incomingQuality = (hqQuality * hq + lqQuality * lq) / useful;
        stock.processed = priorProcessed + useful;
        stock.fromSynth = (stock.fromSynth ?? 0) + useful;
        stock.fromSynthHQ = (stock.fromSynthHQ ?? 0) + hq;
        stock.fromSynthLQ = (stock.fromSynthLQ ?? 0) + lq;
        stock.quality =
          stock.processed > 0
            ? (stock.quality * priorProcessed + incomingQuality * useful) /
              stock.processed
            : incomingQuality;
        data.stocks[domain] = stock;

        for (const [assetSeed, amount, quality] of [
          [hqAssetSeed, hq, hqQuality],
          [lqAssetSeed, lq, lqQuality],
        ] as const) {
          if (amount <= 0.001) continue;
          const prior = data.assets.find((asset) => asset.id === assetSeed.id);
          const totalVolume = (prior?.volumeMTok ?? 0) + amount;
          const blendedQuality = prior
            ? (prior.quality * prior.volumeMTok + quality * amount) /
              totalVolume
            : quality;
          data = appendDatasetAsset(data, {
            ...assetSeed,
            volumeMTok: totalVolume,
            quality: blendedQuality,
            freshness: freshness.freshness,
          });
        }
      }

      data.daySynthMTok += hqToday + lqToday;
      data.dayProcessed += hqToday + lqToday;
      data.lifetimeProcessed += hqToday + lqToday;
      data.lifetimeCollected += hqToday + lqToday;
      synthQueue.push({
        ...job,
        modelId: model.id,
        modelName: model.name,
        progressMTok: job.progressMTok + grossToday,
        hqMTok: (job.hqMTok ?? 0) + hqToday,
        lqMTok: (job.lqMTok ?? 0) + lqToday,
        wastedMTok: (job.wastedMTok ?? 0) + wasteToday,
      });
      continue;
    }
    const model = state.player.models.find((m) => m.id === job.modelId);
    if (!model) continue;
    const tier = job.qualityTier ?? "hq";
    const pf =
      grossResearchPoolPf({ ...state, player: { ...state.player, data } }) *
      job.researchShare;
    const meta = DATA_DOMAIN_META[job.domain];
    const gen = syntheticGenerationMTokPerDay({
      domain: job.domain,
      teacherDomainCapability: teacherCapabilityForDataDomain(
        model,
        job.domain,
      ),
      teacherReliability: model.quality.reliability,
      researchPf: pf,
      tier,
    });
    const continuous = job.continuous === true;
    const next = continuous
      ? job.progressMTok + gen
      : Math.min(job.targetMTok, job.progressMTok + gen);
    const step = next - job.progressMTok;
    if (step > 0) {
      const stock = normalizeDomainStock(data.stocks[job.domain]);
      const assetId = `dataset-${job.id}`;
      const generationDepth =
        1 +
        (data.assets ?? []).filter(
          (asset) =>
            asset.id !== assetId &&
            asset.source === "synthetic" &&
            asset.synthetic?.teacherModelIds.includes(model.id) &&
            (asset.domainWeights[job.domain] ?? 0) > 0,
        ).length;
      const syntheticAsset = syntheticDatasetAsset({
        id: assetId,
        name: `${job.modelName} ${meta.label} synthetic curriculum`,
        domain: job.domain,
        volumeMTok: next,
        quality: 0,
        teacherModelId: job.modelId,
        tier,
        day: state.day,
        provenance: { generationDepth },
      });
      const baseQuality = estimateSyntheticQuality({
        domain: job.domain,
        teacherDomainCapability: teacherCapabilityForDataDomain(
          model,
          job.domain,
        ),
        provenance: syntheticAsset.synthetic!,
      }).quality;
      const teacher = synthTeacherFreshness(state, model, job.domain);
      const qIn = Math.max(18, baseQuality - teacher.capabilityGap * 0.45);
      // Real packs keep quality; synth tracked separately for mix control
      const real = Math.max(
        0,
        stock.processed - stock.fromSynthHQ - stock.fromSynthLQ,
      );
      stock.processed = stock.processed + step;
      stock.fromSynth = (stock.fromSynth ?? 0) + step;
      if (tier === "hq") stock.fromSynthHQ = (stock.fromSynthHQ ?? 0) + step;
      else stock.fromSynthLQ = (stock.fromSynthLQ ?? 0) + step;
      // Blended stock quality for display (real-weighted)
      const np = stock.processed;
      stock.quality =
        np > 0
          ? (stock.quality * real +
              qIn * step +
              stock.quality * (stock.processed - real - step)) /
            np
          : qIn;
      // Simpler stable blend:
      stock.quality =
        np > 0 ? (stock.quality * (np - step) + qIn * step) / np : qIn;
      data.stocks[job.domain] = stock;
      data = appendDatasetAsset(data, {
        ...syntheticAsset,
        quality: qIn,
        freshness: teacher.freshness,
      });
      data.daySynthMTok += step;
      data.dayProcessed += step;
      data.lifetimeProcessed += step;
      data.lifetimeCollected += step;
    }
    if (continuous || next < job.targetMTok - 0.1) {
      synthQueue.push({ ...job, progressMTok: next, qualityTier: tier });
    } else {
      alerts = [
        {
          id: `synth-done-${job.id}`,
          day: state.day,
          severity: "info" as const,
          message: `Synth complete (${tier.toUpperCase()}): ${formatTokens(job.targetMTok)} ${meta.label} via ${job.modelName}.`,
        },
        ...alerts,
      ].slice(0, 40);
    }
  }
  data.synthQueue = synthQueue;
  data.dataGenResearchShare = dataResearchReservationShare(data);

  const pruning = processDataPruneJobs(state, data, cash);
  data = pruning.data;
  cash = pruning.cash;
  alerts = pruning.alerts;

  // Research left for processing assist
  const researchLeft =
    snap.pools.research *
    researchPoolForTech({ ...state, player: { ...state.player, data } });

  data = enqueueAutomaticProcessing({
    data,
    day: state.day,
    labId: state.playerLabId,
    dataQuality: state.player.dataQuality,
    staff: state.player.staff,
  });
  const effects = aggregateEffects(state.player.researchUnlocked);
  const processing = processDataJobs({
    data,
    cash,
    throughputMTok: dataProcessingThroughput({
      staff: state.player.staff,
      researchPf: researchLeft,
      labSites: campusBonuses(state).labSites,
      dataFlywheel: effects.dataFlywheel ?? 0,
    }),
    dataQuality: state.player.dataQuality,
    staff: state.player.staff,
    day: state.day,
  });
  data = processing.data;
  cash = processing.cash;
  if (
    processing.blockedForCash &&
    !alerts.some((alertItem) => alertItem.id.startsWith("proc-cash-"))
  ) {
    alerts = [
      {
        id: `proc-cash-${state.day}`,
        day: state.day,
        severity: "warn" as const,
        message: "Data processing paused — need cash for cleaning pipelines.",
      },
      ...alerts,
    ].slice(0, 40);
  }
  const dataQuality = updateDataQualityIndex(state.player.dataQuality, data);

  return {
    ...state,
    player: { ...state.player, cash, data, dataQuality },
    alerts,
  };
}

export interface ConsumeResult {
  ok: boolean;
  reason?: string;
  plan: TrainingDataPlan & { totalMTok: number; trainShare: number };
  consumed: Partial<Record<DataDomain, number>>;
  coverage: number;
  qualityUsed: number;
  syntheticUnits: number;
  synthHqUnits?: number;
  synthLqUnits?: number;
  /** 0–1 fraction of recipe that was low-quality synth */
  synthLqShare?: number;
  cashCost: number;
  nextData: LabData;
  trainMTok: number;
  verifyMTok: number;
  domainQuality?: Partial<Record<DataDomain, number>>;
  lowQualityShareByDomain?: Partial<Record<DataDomain, number>>;
  syntheticProvenance?: SyntheticFillRecord[];
  specialistBoosts?: Partial<Record<DataDomain, number>>;
}

export function hasCorpusSpecialists(state: SimState): boolean {
  return (
    state.player.researchUnlocked.includes("data_specialists") ||
    (aggregateEffects(state.player.researchUnlocked).unlockCorpusSpecialists ??
      false)
  );
}

export function specialistDomainBoost(
  model: Model,
  domain: DataDomain,
): number {
  const b = model.benchmarks;
  const q = model.quality;
  let score = 0;
  switch (domain) {
    case "code":
      score = (b.coding ?? 0) * 0.7 + (b.agents ?? 0) * 0.15 + q.coding * 0.15;
      break;
    case "law":
      score = (b.law ?? 0) * 0.75 + (b.safety ?? 0) * 0.15 + q.reasoning * 0.1;
      break;
    case "health":
      score = (b.health ?? 0) * 0.75 + (b.science ?? 0) * 0.15 + q.safety * 0.1;
      break;
    case "chat":
      score =
        q.chat * 0.45 + (b.mmlu ?? 0) * 0.35 + (b.multilingual ?? 0) * 0.2;
      break;
    case "image":
      score = (b.vision ?? 0) * 0.8 + q.image * 0.2;
      break;
    case "video":
      score = (b.vision ?? 0) * 0.45 + q.video * 0.4 + q.image * 0.15;
      break;
    case "audio":
      score =
        q.chat * 0.4 + (b.multilingual ?? 0) * 0.35 + (b.mmlu ?? 0) * 0.25;
      break;
    default:
      score = model.capability * 0.5;
  }
  const raw = (score / 100) * 16 + model.capability * 0.06;
  return Math.max(0, Math.min(22, raw));
}

export function resolveDomainModel(
  state: SimState,
  modelId: string | undefined | null,
): Model | null {
  if (!modelId) return null;
  return state.player.models.find((m) => m.id === modelId) ?? null;
}

/**
 * Attribute training volume against the corpus.
 *
 * - **Pretrain / distill:** read-only — full collected corpus stays for future pretrains.
 * - **Continue:** only “new” tokens since the model’s watermark; still does not wipe stocks
 *   (watermark advances on the model so the same delta isn’t double-counted for continues).
 * - 1:1 min tokens:params applies to pretrain/distill only.
 */
/**
 * Lab-agnostic corpus recipe (player or rival).
 * Same HQ/LQ synth rules and 1:1 coverage math for every lab.
 */
export function consumeForLabData(
  dataIn: LabData,
  planIn: TrainingDataPlan | undefined,
  paramsB: number,
  family: string,
  opts?: {
    mode?: "pretrain" | "distill" | "continue";
    priorWatermarkMTok?: number;
    /** When true, HQ synth fill requires unlocked research (player). Rivals pass their unlocks. */
    hasSynthResearch?: boolean;
    legacyMix?: string;
  },
): ConsumeResult {
  const mode = opts?.mode ?? "pretrain";
  const isContinue = mode === "continue";
  const plan = resolveDataPlan(planIn, paramsB, family, opts?.legacyMix);
  if (planIn?.domainModels) plan.domainModels = { ...planIn.domainModels };
  if (planIn?.syntheticTeacherIds)
    plan.syntheticTeacherIds = { ...planIn.syntheticTeacherIds };

  const weights = normalizeWeights(plan.weights);
  // Read-only clone for quality — stocks are never permanently depleted by pretrain
  const data = cloneLabData(dataIn);
  const totalProcessedNow = totalProcessed(data);
  const watermark = Math.max(0, opts?.priorWatermarkMTok ?? 0);
  const newSinceTrain = isContinue
    ? Math.max(0, totalProcessedNow - watermark)
    : totalProcessedNow;

  const minMTok = isContinue ? 0 : minDataMTokForParams(paramsB);
  // Continue: cap volume to new data (+ small synth if player asks for more)
  let total = Math.max(1, plan.totalMTok);
  if (isContinue) {
    total = Math.min(
      total,
      Math.max(
        1,
        newSinceTrain + (plan.allowSynthetic ? newSinceTrain * 0.25 : 0),
      ),
    );
    // Soft default: use whatever new data exists
    if (!planIn?.totalMTok && !planIn?.totalUnits) {
      total = Math.max(1, newSinceTrain);
    }
  }

  const trainShare = plan.trainShare;

  const consumed: Partial<Record<DataDomain, number>> = {};
  let syntheticUnits = 0;
  let synthHqUnits = 0;
  let synthLqUnits = 0;
  const cashCost = 0;
  let qualityAcc = 0;
  let qualityW = 0;
  const domainQuality: Partial<Record<DataDomain, number>> = {};
  const lowQualityShareByDomain: Partial<Record<DataDomain, number>> = {};
  const specialistBoosts: Partial<Record<DataDomain, number>> = {};
  const hasSynthResearch = opts?.hasSynthResearch ?? false;
  const useSynth = !!plan.allowSynthetic;
  const useHQ = useSynth && plan.includeSynthHQ !== false && hasSynthResearch;
  const useLQ = useSynth && !!plan.includeSynthLQ;

  // For continue: only a fraction of each domain’s stock counts as “new”
  const newFrac =
    isContinue && totalProcessedNow > 0
      ? Math.min(1, newSinceTrain / totalProcessedNow)
      : 1;

  for (const d of DATA_DOMAINS) {
    const need = total * weights[d];
    if (need <= 0.01) continue;
    const stock = normalizeDomainStock(data.stocks[d]);
    // Real packs (web + user) — always allowed
    const real = Math.max(
      0,
      stock.processed - (stock.fromSynthHQ + stock.fromSynthLQ),
    );
    const hqAvail = useHQ ? stock.fromSynthHQ * newFrac : 0;
    const lqAvail = useLQ ? stock.fromSynthLQ * newFrac : 0;
    const realAvail = real * newFrac;

    let remaining = need;
    const takeReal = Math.min(realAvail, remaining);
    remaining -= takeReal;
    const takeHQ = Math.min(hqAvail, remaining);
    remaining -= takeHQ;
    const takeLQ = Math.min(lqAvail, remaining);
    remaining -= takeLQ;
    const short = remaining;
    const specBoost = 0;

    const take = takeReal + takeHQ + takeLQ;
    if (take > 0) {
      consumed[d] = take;
      const qReal = Math.min(98, stock.quality + specBoost);
      const qHQ = Math.min(
        92,
        (DATA_ECONOMY.syntheticQualityHQ ?? 72) + specBoost * 0.5,
      );
      const qLQ = Math.min(
        45,
        (DATA_ECONOMY.syntheticQualityLQ ?? 28) + specBoost * 0.2,
      );
      const qBlend =
        (qReal * takeReal + qHQ * takeHQ + qLQ * takeLQ) / Math.max(0.01, take);
      domainQuality[d] = qBlend;
      lowQualityShareByDomain[d] = take > 0 ? takeLQ / take : 0;
      qualityAcc += qBlend * take;
      qualityW += take;
      synthHqUnits += takeHQ;
      synthLqUnits += takeLQ;
      syntheticUnits += takeHQ + takeLQ;
    }
    // V3 never conjures a synthetic shortfall at train start. Labs must first
    // generate or buy those tokens, so player and rivals contest real stocks.
    void short;
  }

  // Coverage from **actual attributed** volume (not wishful plan total)
  const actualVolume =
    Math.round(
      Object.values(consumed).reduce((s, v) => s + (v ?? 0), 0) * 1e9,
    ) / 1e9;
  const coverage = isContinue
    ? Math.min(30, actualVolume / Math.max(1, newSinceTrain * 0.5 + 1))
    : Math.min(30, actualVolume / Math.max(1, minMTok));
  let qualityUsed = qualityW > 0 ? qualityAcc / qualityW : 40;
  const synthLqShare = qualityW > 0 ? synthLqUnits / qualityW : 0;
  if (synthLqShare > 0.08) {
    qualityUsed = Math.max(12, qualityUsed * (1 - synthLqShare * 0.35));
  }

  return {
    ok: true,
    plan: {
      ...plan,
      totalMTok: Math.max(actualVolume, 1),
      totalUnits: Math.max(actualVolume, 1),
    },
    consumed,
    coverage,
    qualityUsed,
    syntheticUnits,
    synthHqUnits,
    synthLqUnits,
    synthLqShare,
    cashCost,
    nextData: cloneLabData(dataIn),
    trainMTok: actualVolume * trainShare,
    verifyMTok: actualVolume * (1 - trainShare),
    domainQuality,
    lowQualityShareByDomain,
    specialistBoosts,
  };
}

/** Player wrapper — same recipe as rivals via consumeForLabData. */
export function consumeForTraining(
  state: SimState,
  planIn: TrainingDataPlan | undefined,
  paramsB: number,
  family: string,
  legacyMix?: string,
  opts?: {
    mode?: "pretrain" | "distill" | "continue";
    priorWatermarkMTok?: number;
  },
): ConsumeResult {
  // Specialist domain models still need full player resolve — re-run blend with boosts
  const base = consumeForLabData(
    ensureLabData(state),
    planIn,
    paramsB,
    family,
    {
      mode: opts?.mode,
      priorWatermarkMTok: opts?.priorWatermarkMTok,
      hasSynthResearch: state.player.researchUnlocked.includes("data_synth"),
      legacyMix,
    },
  );
  const canAutoSynthesize =
    !!planIn?.allowSynthetic &&
    state.player.researchUnlocked.includes("data_synth") &&
    state.player.models.length > 0;
  if (canAutoSynthesize) {
    const weights = normalizeWeights(base.plan.weights);
    const wanted = Math.max(
      1,
      planIn?.totalMTok ?? planIn?.totalUnits ?? base.plan.totalMTok,
    );
    const consumed = { ...base.consumed };
    const domainQuality = { ...base.domainQuality };
    const lowQualityShareByDomain = { ...base.lowQualityShareByDomain };
    const syntheticProvenance: SyntheticFillRecord[] = [];
    let syntheticAdded = 0;
    let qualityAcc = 0;
    let qualityVolume = 0;
    const verifierBonus = hasCorpusSpecialists(state) ? 8 : 0;
    const baseVolume = Object.values(base.consumed).reduce(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    const attributedReal = Math.max(0, baseVolume - base.syntheticUnits);
    const requestedMultiplier = Math.max(
      0,
      Math.min(3, planIn?.syntheticMultiplier ?? 3),
    );
    let remainingGenerationBudget = Math.max(
      0,
      attributedReal * requestedMultiplier - base.syntheticUnits,
    );
    for (const domain of DATA_DOMAINS) {
      const short = Math.min(
        remainingGenerationBudget,
        Math.max(0, wanted * weights[domain] - (consumed[domain] ?? 0)),
      );
      if (short <= 0.01) continue;
      const eligibleTeachers = state.player.models
        .filter((model) => modelCanCurateDataDomain(model, domain))
        .toSorted(
          (a, b) =>
            specialistDomainBoost(b, domain) - specialistDomainBoost(a, domain),
        );
      const selectedTeacherId = planIn?.syntheticTeacherIds?.[domain];
      const teacher =
        eligibleTeachers.find((model) => model.id === selectedTeacherId) ??
        eligibleTeachers[0];
      if (!teacher) continue;
      const teacherSignal = specialistDomainBoost(teacher, domain);
      const quality = Math.min(92, 48 + teacherSignal * 1.8 + verifierBonus);
      const qualityTier = quality >= 58 ? ("hq" as const) : ("lq" as const);
      const prior = consumed[domain] ?? 0;
      const priorQuality = domainQuality[domain] ?? base.qualityUsed;
      consumed[domain] = prior + short;
      domainQuality[domain] =
        (priorQuality * prior + quality * short) /
        Math.max(0.01, prior + short);
      lowQualityShareByDomain[domain] =
        qualityTier === "lq" ? short / Math.max(0.01, prior + short) : 0;
      syntheticAdded += short;
      remainingGenerationBudget -= short;
      syntheticProvenance.push({
        domain,
        teacherModelId: teacher.id,
        teacherName: teacher.name,
        volumeMTok: short,
        quality,
        qualityTier,
      });
    }
    const actualVolume = Object.values(consumed).reduce(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    for (const domain of DATA_DOMAINS) {
      const volume = consumed[domain] ?? 0;
      if (volume <= 0) continue;
      qualityAcc += (domainQuality[domain] ?? base.qualityUsed) * volume;
      qualityVolume += volume;
    }
    const trainShare = base.plan.trainShare;
    return {
      ...base,
      plan: { ...base.plan, totalMTok: actualVolume, totalUnits: actualVolume },
      consumed,
      coverage: Math.min(
        30,
        actualVolume / Math.max(1, minDataMTokForParams(paramsB)),
      ),
      qualityUsed:
        qualityVolume > 0 ? qualityAcc / qualityVolume : base.qualityUsed,
      syntheticUnits: base.syntheticUnits + syntheticAdded,
      synthHqUnits:
        (base.synthHqUnits ?? 0) +
        syntheticProvenance
          .filter((item) => item.qualityTier === "hq")
          .reduce((sum, item) => sum + item.volumeMTok, 0),
      synthLqUnits:
        (base.synthLqUnits ?? 0) +
        syntheticProvenance
          .filter((item) => item.qualityTier === "lq")
          .reduce((sum, item) => sum + item.volumeMTok, 0),
      synthLqShare:
        actualVolume > 0
          ? ((base.synthLqUnits ?? 0) +
              syntheticProvenance
                .filter((item) => item.qualityTier === "lq")
                .reduce((sum, item) => sum + item.volumeMTok, 0)) /
            actualVolume
          : 0,
      cashCost: base.cashCost + syntheticAdded * 250,
      trainMTok: actualVolume * trainShare,
      verifyMTok: actualVolume * (1 - trainShare),
      domainQuality,
      lowQualityShareByDomain,
      syntheticProvenance,
      nextData: cloneLabData(ensureLabData(state)),
    };
  }
  // Re-apply specialist boosts when unlocked (player-only feature)
  if (!hasCorpusSpecialists(state) || !planIn?.domainModels) {
    return { ...base, nextData: cloneLabData(ensureLabData(state)) };
  }
  // Rebuild with specialist quality bumps on domains that have models
  let qualityAcc = 0;
  let qualityW = 0;
  const domainQuality = { ...base.domainQuality };
  for (const d of DATA_DOMAINS) {
    const take = base.consumed[d] ?? 0;
    if (take <= 0) continue;
    const mid = planIn.domainModels[d];
    let boost = 0;
    if (mid) {
      const m = resolveDomainModel(state, mid);
      if (m && modelCanCurateDataDomain(m, d))
        boost = specialistDomainBoost(m, d);
    }
    const q = Math.min(98, (domainQuality[d] ?? base.qualityUsed) + boost);
    domainQuality[d] = q;
    qualityAcc += q * take;
    qualityW += take;
  }
  return {
    ...base,
    domainQuality,
    qualityUsed: qualityW > 0 ? qualityAcc / qualityW : base.qualityUsed,
    nextData: cloneLabData(ensureLabData(state)),
  };
}

/** New MTok available for continue-train on a model (since its watermark). */
export function newDataSinceModel(
  state: SimState,
  model: { dataWatermarkMTok?: number } | null | undefined,
): number {
  const data = ensureLabData(state);
  const now = totalProcessed(data);
  const mark = model?.dataWatermarkMTok ?? 0;
  return Math.max(0, now - mark);
}

export function grantPartnershipData(state: SimState): SimState {
  const data = cloneLabData(ensureLabData(state));
  for (const d of DATA_DOMAINS) {
    const add = DATA_ECONOMY.partnershipMTok[d] ?? 0;
    if (add <= 0) continue;
    const s = data.stocks[d];
    const q = DATA_ECONOMY.partnershipQuality;
    const np = s.processed + add;
    s.quality = np > 0 ? (s.quality * s.processed + q * add) / np : q;
    s.processed = np;
    s.fromBought = (s.fromBought ?? 0) + add;
    data.lifetimeProcessed += add;
    data.lifetimeCollected += add;
  }
  return { ...state, player: { ...state.player, data } };
}

export function ensureDataMarket(state: SimState): SimState {
  if (state.dataMarket?.offers?.length) return state;
  const rivals = state.rivals.map((r) => r.name);
  const offers = generateDataMarketOffers(state.seed, state.day, rivals, 11);
  return {
    ...state,
    dataMarket: {
      offers,
      lastRefreshDay: state.day,
      nextRefreshDay: state.day + 5,
    },
  };
}

/** Age listings, drop expired, periodic refresh of the open data market. */
export function tickDataMarket(state: SimState): SimState {
  let s = ensureDataMarket(state);
  const market = s.dataMarket!;
  let offers = market.offers.map((o) => ({
    ...o,
    daysLeft: Math.max(0, o.daysLeft - 1),
  }));
  // Drop expired empty-ish listings; keep stocked ones a bit longer
  offers = offers.filter((o) => o.daysLeft > 0 || o.mTokLeft > 0);
  offers = offers.map((o) => (o.daysLeft <= 0 ? { ...o, mTokLeft: 0 } : o));

  let lastRefreshDay = market.lastRefreshDay;
  let nextRefreshDay = market.nextRefreshDay;
  if (s.day >= nextRefreshDay) {
    const rivals = s.rivals.map((r) => r.name);
    const fresh = generateDataMarketOffers(
      s.seed,
      s.day,
      rivals,
      10 + (s.day % 4),
    );
    // Keep remaining stock on still-active IDs if any; else full replace
    offers = fresh;
    lastRefreshDay = s.day;
    nextRefreshDay = s.day + 4 + (s.day % 5);
  }

  return {
    ...s,
    dataMarket: { offers, lastRefreshDay, nextRefreshDay },
  };
}

/**
 * Buy one lot from a market listing (or remaining MTok if smaller).
 * Scrap is cheap/low quality; curated is expensive/high quality.
 */
export function buyDomainContract(
  state: SimState,
  contractId: string,
): SimState {
  let s = ensureDataMarket(state);
  const market = s.dataMarket!;
  const idx = market.offers.findIndex((x) => x.id === contractId);
  if (idx < 0)
    return alert(s, "warn", "That listing is no longer on the market.");
  const c = market.offers[idx]!;
  if (c.mTokLeft <= 0) {
    return alert(
      s,
      "warn",
      `${c.name} is sold out — wait for the next market refresh.`,
    );
  }
  const buyMTok = Math.min(c.lotMTok, c.mTokLeft);
  const frac = buyMTok / Math.max(1, c.lotMTok);
  const cash = Math.max(50_000, Math.round(c.cash * frac));
  if (s.player.cash < cash) {
    return alert(
      s,
      "warn",
      `Need $${(cash / 1e6).toFixed(2)}M for ${buyMTok} MTok.`,
    );
  }
  return queueDataOfferOrder(s, s.playerLabId, contractId);
}

const DATA_SUPPLIER_COMPANIES = [
  {
    id: "supplier-openweb",
    name: "OpenWeb Harvest",
    domains: {
      chat: 0.35,
      code: 0.2,
      science: 0.15,
      law: 0.05,
      health: 0.05,
      image: 0.1,
      audio: 0.05,
      video: 0.05,
    },
    quality: 58,
    dailyDeliveryMTok: 420,
    dailyPrice: 180_000,
  },
  {
    id: "supplier-broker",
    name: "BrokerLink Data",
    domains: {
      chat: 0.2,
      code: 0.25,
      science: 0.2,
      law: 0.1,
      health: 0.1,
      image: 0.05,
      audio: 0.05,
      video: 0.05,
    },
    quality: 72,
    dailyDeliveryMTok: 260,
    dailyPrice: 310_000,
  },
  {
    id: "supplier-enterprise",
    name: "Enterprise Corpus Co",
    domains: {
      chat: 0.15,
      code: 0.15,
      science: 0.2,
      law: 0.2,
      health: 0.2,
      image: 0.04,
      audio: 0.03,
      video: 0.03,
    },
    quality: 84,
    dailyDeliveryMTok: 180,
    dailyPrice: 540_000,
  },
] as const;

export interface DataSupplierOffer {
  id: string;
  name: string;
  domainMix: Partial<Record<DataDomain, number>>;
  quality: number;
  dailyDeliveryMTok: number;
  dailyPrice: number;
  termDays: number;
}

/** Three deterministic supplier negotiations for recurring data delivery. */
export function listDataSupplierOffers(state: SimState): DataSupplierOffer[] {
  const dayFactor = 1 + Math.min(0.35, state.day / 4000);
  return DATA_SUPPLIER_COMPANIES.map((company) => ({
    id: company.id,
    name: company.name,
    domainMix: { ...company.domains },
    quality: company.quality,
    dailyDeliveryMTok: Math.round(company.dailyDeliveryMTok * dayFactor),
    dailyPrice: Math.round(company.dailyPrice * dayFactor),
    termDays: 30,
  }));
}

export function acceptDataSupplierOffer(
  state: SimState,
  offerId: string,
  priceMultiplier = 1,
): SimState {
  const offer = listDataSupplierOffers(state).find(
    (candidate) => candidate.id === offerId,
  );
  if (!offer)
    return alert(state, "warn", "That supplier offer is no longer available.");
  const existing = state.player.dataSupplierContracts ?? [];
  if (
    existing.some(
      (contract) =>
        contract.supplierId === offer.id && contract.daysRemaining > 0,
    )
  ) {
    return alert(
      state,
      "warn",
      `${offer.name} already has an active contract.`,
    );
  }
  if (state.player.cash < offer.dailyPrice) {
    return alert(
      state,
      "warn",
      `Need $${(offer.dailyPrice / 1e6).toFixed(2)}M cash for the first day of ${offer.name}.`,
    );
  }
  const contract: DataSupplierContract = {
    id: `dsc-${state.seed}-${state.day}-${offer.id}`,
    supplierId: offer.id,
    supplierName: offer.name,
    domainMix: offer.domainMix,
    quality: offer.quality,
    dailyDeliveryMTok: offer.dailyDeliveryMTok,
    dailyPrice: offer.dailyPrice * Math.max(0.8, Math.min(1, priceMultiplier)),
    termDays: offer.termDays,
    daysRemaining: offer.termDays,
    acceptedDay: state.day,
    status: "active",
  };
  return alert(
    {
      ...state,
      player: {
        ...state.player,
        cash: state.player.cash - offer.dailyPrice,
        dataSupplierContracts: [...existing, contract],
      },
    },
    "info",
    `Signed ${offer.name}: ${offer.dailyDeliveryMTok} MTok/day for ${offer.termDays}d.`,
  );
}

export function tickDataSupplierContracts(state: SimState): SimState {
  const contracts = state.player.dataSupplierContracts ?? [];
  if (!contracts.length) return state;

  let cash = state.player.cash;
  let data = cloneLabData(state.player.data);
  let alerts = state.alerts;
  const nextContracts: DataSupplierContract[] = [];

  for (const contract of contracts) {
    if (contract.status !== "active") {
      nextContracts.push(contract);
      continue;
    }
    if (cash < contract.dailyPrice) {
      nextContracts.push({
        ...contract,
        status: "cancelled",
      });
      alerts = [
        {
          id: `supplier-cash-${contract.id}-${state.day}`,
          day: state.day,
          severity: "warn" as const,
          message: `${contract.supplierName} paused — need $${(contract.dailyPrice / 1e6).toFixed(2)}M/day.`,
        },
        ...alerts,
      ].slice(0, 40);
      continue;
    }

    cash -= contract.dailyPrice;
    const mixEntries = Object.entries(contract.domainMix).filter(
      ([, w]) => (w ?? 0) > 0,
    ) as Array<[DataDomain, number]>;
    const weightSum =
      mixEntries.reduce((sum, [, w]) => sum + Math.max(0, w), 0) || 1;
    for (const [domain, weight] of mixEntries) {
      const add =
        (contract.dailyDeliveryMTok * Math.max(0, weight)) / weightSum;
      if (add <= 0) continue;
      const stock = data.stocks[domain];
      data.stocks[domain] = {
        ...stock,
        raw: stock.raw + add,
        quality:
          (stock.quality * stock.raw + contract.quality * add) /
          Math.max(1e-9, stock.raw + add),
      };
    }
    data.lifetimeCollected =
      (data.lifetimeCollected ?? 0) + contract.dailyDeliveryMTok;

    const daysRemaining = Math.max(
      0,
      (contract.daysRemaining ?? contract.termDays) - 1,
    );
    nextContracts.push({
      ...contract,
      daysRemaining,
      status: daysRemaining <= 0 ? "completed" : "active",
    });
  }

  return {
    ...state,
    player: {
      ...state.player,
      cash,
      data,
      dataSupplierContracts: nextContracts,
    },
    alerts,
  };
}

export type DataPortfolioChannel = "open" | "broker" | "enterprise" | "rival";

function portfolioChannel(seller: DataSellerKind): DataPortfolioChannel {
  if (seller === "web_scrape" || seller === "opensource") return "open";
  if (seller === "enterprise" || seller === "research_lab") return "enterprise";
  if (seller === "rival") return "rival";
  return "broker";
}

/** Queue a diversified set of live market lots up to the player's chosen budget. */
export function buyDataPortfolio(
  state: SimState,
  budget: number,
  mix: Record<DataPortfolioChannel, number>,
): SimState {
  let next = ensureDataMarket(state);
  const cap = Math.max(250_000, Math.min(budget, state.player.cash));
  const existing = new Set(
    next.worldMarkets.orders
      .filter(
        (order) => order.labId === state.playerLabId && order.kind === "data",
      )
      .map((order) => order.resourceId),
  );
  const candidates = next
    .dataMarket!.offers.filter(
      (offer) =>
        offer.mTokLeft > 0 &&
        !existing.has(offer.id) &&
        (mix[portfolioChannel(offer.sellerKind)] ?? 0) > 0,
    )
    .toSorted((left, right) => {
      const leftWeight = Math.max(
        0.01,
        mix[portfolioChannel(left.sellerKind)] ?? 0,
      );
      const rightWeight = Math.max(
        0.01,
        mix[portfolioChannel(right.sellerKind)] ?? 0,
      );
      const leftValue =
        (leftWeight * left.quality * Math.min(left.lotMTok, left.mTokLeft)) /
        left.cash;
      const rightValue =
        (rightWeight *
          right.quality *
          Math.min(right.lotMTok, right.mTokLeft)) /
        right.cash;
      return rightValue - leftValue;
    });
  let committed = 0;
  let volumeMTok = 0;
  let lots = 0;
  for (const offer of candidates) {
    if (committed + offer.cash > cap && lots > 0) continue;
    const before = next.worldMarkets.orders.length;
    next = queueDataOfferOrder(next, state.playerLabId, offer.id);
    if (next.worldMarkets.orders.length > before) {
      committed += offer.cash;
      volumeMTok += Math.min(offer.lotMTok, offer.mTokLeft);
      lots += 1;
    }
    if (committed >= cap * 0.92) break;
  }
  if (lots === 0)
    return alert(next, "warn", "No live data lots fit this portfolio budget.");
  return alert(
    next,
    "info",
    `Portfolio submitted: ${lots} source lots · ${formatTokens(volumeMTok)} · up to $${(committed / 1e6).toFixed(2)}M reserved.`,
  );
}

export function listDomainContracts(state?: SimState): DomainDataContract[] {
  if (!state) return DOMAIN_DATA_CONTRACTS;
  return ensureDataMarket(state).dataMarket?.offers ?? [];
}

export function formatMix(
  weights: Partial<Record<DataDomain, number>>,
): string {
  const w = normalizeWeights(weights);
  return DATA_DOMAINS.filter((d) => w[d] >= 0.05)
    .map((d) => `${DATA_DOMAIN_META[d].label} ${Math.round(w[d] * 100)}%`)
    .join(" · ");
}

function alert(
  state: SimState,
  severity: "info" | "warn" | "danger",
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: `data-${state.day}-${message.slice(0, 14)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}
