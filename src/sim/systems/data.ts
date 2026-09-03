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
  applySynthQualityTax,
  totalProcessed,
  totalRaw,
  totalSources,
  type DomainDataContract,
} from "../balance/data";
import { ECONOMY } from "../balance/economy";
import { ioForPreset, presetFromFamily } from "../balance/trainingV3";
import { createRng, hashSeed, seededId } from "../rng";
import { chargeExpense, recordCashSpend } from "./financeLedger";
import { queueDataOfferOrder } from "./sharedMarkets";
import type {
  DataDomain,
  DataPruneJob,
  DataSellerKind,
  LabData,
  LabId,
  Model,
  ModelFamily,
  ProcessJob,
  SimState,
  SyntheticFillRecord,
  SynthGenJob,
  TrainingDataPlan,
} from "../types";
import { computeSnapshot, normalizeAllocation } from "./compute";
import { campusBonuses } from "./campus";
import { aggregateEffects } from "./research";
import { modelCanCurateDataDomain } from "./modelEligibility";
import {
  estimateSyntheticQuality,
  teacherCapabilityForDataDomain,
} from "../balance/modelCapabilities";
import {
  peakSyntheticTeacherDomainCapability,
  SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK,
  syntheticTeacherGenerationEconomics,
} from "../balance/syntheticTeacherEffort";
import {
  syntheticJobQuality,
  syntheticTrainingProfile,
  teacherDomainStrength,
} from "../balance/syntheticTraining";
import { activeBalanceTuning } from "../balance/tuning";
import { gymResearchReservationShare } from "../balance/modelStudio";
import { v4GymResearchReservationShare } from "../training/gyms";
import {
  domainCapFromCapabilities,
  synthAcceptanceChances,
  synthTeacherActiveParamsB,
  syntheticMTokFromPfDays,
  syntheticQualityFor,
  type SynthTierBudget,
  type SyntheticGenerationJob,
} from "../balance/syntheticGeneration";
import {
  addToPool,
  POST_TRAIN_TRAFFIC_TO_POOL,
} from "../training/dataBridge";
import { trainingStateOf } from "../training/state";
import type { Checkpoint } from "../training/types";
import {
  appendDatasetAsset,
  pruneDatasetAssetsForDomain,
  syntheticDatasetAsset,
  type DatasetPruneBreakdown,
} from "./dataAssets";
import { availableHqStaff, unreservedStaffHeadcount } from "./staffReservations";
import { energyPriceForState } from "./map";
import {
  cloneLabData,
  collectTrafficData,
  dataModelDriftRate,
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

// Marketplace buys and the supplier negotiation lifecycle live in
// dataContracts; re-exported here so existing systems/data imports keep working.
export {
  DATA_BULK_BUY_PREMIUM,
  DATA_CANCEL_FEE_MAX_SHARE,
  DATA_CANCEL_FEE_MIN_SHARE,
  DATA_CANCEL_FEE_MIN_DAYS,
  DATA_CONCURRENT_CONTRACT_PREMIUM,
  DATA_MAX_CONTRACTS_PER_SUPPLIER,
  acceptDataSupplierCounter,
  acceptDataSupplierOffer,
  buyAllFilteredDataLots,
  buyDataLotAmount,
  buyEntireDataLot,
  cancelDataSupplierContract,
  counterDataSupplierOffer,
  dataCancellationFee,
  dataContractRemainingValue,
  dataOfferDelivery,
  dataOfferLotCost,
  dataOfferPurchasableMTok,
  dataOfferRights,
  dataOfferUnitPrice,
  dataSupplierContractPremium,
  evaluateSupplierOffer,
  listDataSupplierOffers,
  liveSupplierContractCount,
  previewDataPurchase,
  proposeDataSupplierTerms,
  rejectDataSupplierCounter,
  supplierTermsFromOffer,
  tickDataSupplierContracts,
  type DataDeliveryState,
  type DataPurchasePreview,
  type DataSupplierOffer,
  type SupplierOfferEvaluation,
} from "./dataContracts";

export function ensureLabData(state: SimState): LabData {
  const raw = state.player.data;
  if (!raw) return createEmptyLabData();
  return cloneLabData(raw);
}

/** In-flight tech-tree / pod work keeps at least this share of the research pool. */
export const TREE_RESEARCH_POOL_FLOOR = 0.15;

function treeResearchActive(state: SimState): boolean {
  return (
    Boolean(state.player.activeResearch) ||
    (state.player.researchPrograms?.some((program) => {
      if (program.phase === "complete") return false;
      const pod = (state.player.researchPods ?? []).find(
        (candidate) => candidate.id === program.podId,
      );
      return pod?.assignmentId === program.id;
    }) ??
      false)
  );
}

/** Legacy studio gyms plus V4 training gyms, capped at the gym research slice. */
export function reservedGymResearchShare(state: SimState): number {
  return Math.max(
    0,
    Math.min(
      0.75,
      gymResearchReservationShare(state.player.postTrainGyms) +
        v4GymResearchReservationShare(state.player.training?.gyms),
    ),
  );
}

/** Research PF fraction available for tech (1 − data gen / gyms / safety). */
export function researchPoolForTech(
  state: SimState,
  options?: { reserveTree?: boolean },
): number {
  const data = ensureLabData(state);
  const share =
    dataResearchReservationShare(data) + reservedGymResearchShare(state);
  const safetyShare = state.player.safetyCampaign ? 0.4 : 0;
  const remainder = Math.max(0, 1 - share - safetyShare);
  if (options?.reserveTree || treeResearchActive(state)) {
    return Math.max(TREE_RESEARCH_POOL_FLOOR, remainder);
  }
  return remainder;
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

/** Maximum data-generation share after gym and safety reservations. */
export function maxDataResearchShareForState(state: SimState): number {
  const gymShare = reservedGymResearchShare(state);
  const safetyShare = state.player.safetyCampaign ? 0.4 : 0;
  return Math.max(
    0,
    DATA_ECONOMY.maxDataGenResearchShare - gymShare - safetyShare,
  );
}

/** Gross research PF before continuous data-generation reservations are removed. */
export function grossResearchPoolPf(state: SimState): number {
  const snapshot = computeSnapshot(state);
  const scheduledPool = snapshot.pools.research;
  // The scheduler backfills an idle research reservation into training. Action
  // previews still need the capacity that would return when research work is queued.
  const prospectivePool =
    snapshot.effectiveFlopsPf *
    normalizeAllocation(state.player.allocation).research;
  // ComputeSnapshot exposes the physical research pool before data/gym/safety
  // consumers split it. Dividing by a reservation here double-counted that
  // slice and let concurrent work consume more PF than the lab owned.
  return Math.max(scheduledPool, prospectivePool);
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
  const next = chargeExpense(
    {
      ...state,
      player: {
        ...state.player,
        data,
      },
    },
    audit.cashCost,
    "data",
  );
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
  engineersRequired: number;
  estimatedDays: number;
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
  // An audit is a second, adversarial pass over the corpus. It costs more than
  // ordinary cleaning because it inspects the rejected tail and rewrites
  // provenance instead of merely accepting useful records.
  const cashPerMTok = meta.processCostPerMTok * 3.25;
  const pfDaysPerMTok = meta.processHard * 0.95;
  const researchersRequired = Math.max(
    1,
    Math.min(4, Math.ceil(totalMTok / 250)),
  );
  const engineersRequired = Math.max(
    1,
    Math.min(6, Math.ceil(totalMTok / 300)),
  );
  const existingShare = dataResearchReservationShare(data);
  // Queue admission checks the lab's non-data reservations; prune jobs can
  // wait behind one another and the daily scheduler assigns their slots.
  const availableStaff = availableHqStaff(state, { includeDataJobs: false });
  const researchers = availableStaff.researchers;
  const engineers = availableStaff.engineers;
  const availableResearchPf =
    grossResearchPoolPf(state) * DATA_PRUNE_RESEARCH_SHARE;
  const cashCost = totalMTok * cashPerMTok;
  const pfDays = totalMTok * pfDaysPerMTok;
  const estimatedDays = Math.max(
    1,
    Math.ceil(pfDays / Math.max(DATA_PRUNE_MIN_ACTIVE_PF, availableResearchPf)),
  );
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
  } else if (engineers < engineersRequired) {
    reason = `Needs ${engineersRequired} data engineers (have ${engineers})`;
  } else if (state.player.cash + 1e-9 < cashCost) {
    reason = `Needs ${formatMoneyShort(cashCost)} cash`;
  } else if (availableResearchPf < DATA_PRUNE_MIN_ACTIVE_PF)
    reason = "No research compute available";
  else if (
    existingShare + DATA_PRUNE_RESEARCH_SHARE >
    maxDataResearchShareForState(state) + 1e-9
  ) {
    reason = "Research pool is fully reserved";
  }
  return {
    domain,
    ...lowQuality,
    totalMTok,
    cashCost,
    pfDays,
    researchersRequired,
    engineersRequired,
    estimatedDays,
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
    engineersRequired: estimate.engineersRequired,
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
  engineersRequired: number;
  estimatedDays: number;
  ok: boolean;
  reason?: string;
}

/**
 * Estimate queue time using the same finite headcount slots that settle jobs.
 * Each active audit holds its researcher and data-engineer slots for the day;
 * jobs that do not fit wait in queue. A blocked preview still gets a useful
 * one-slot duration instead of rendering Infinity in the HUD.
 */
function estimateConcurrentPruneDays(
  candidates: DataPruneEstimate[],
  researchers: number,
  engineers: number,
): number {
  if (candidates.length === 0) return 0;
  const remaining = candidates.map((estimate) =>
    Math.max(1, estimate.estimatedDays),
  );
  const researcherCapacity = Math.max(1, Math.floor(researchers));
  const engineerCapacity = Math.max(1, Math.floor(engineers));
  let days = 0;
  const maxDays = remaining.reduce((sum, value) => sum + value, 0) * 2;

  while (remaining.some((value) => value > 0) && days < maxDays) {
    let researcherSlots = researcherCapacity;
    let engineerSlots = engineerCapacity;
    let active = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      if (remaining[index] <= 0) continue;
      const candidate = candidates[index];
      if (
        candidate.researchersRequired > researcherSlots ||
        candidate.engineersRequired > engineerSlots
      ) {
        continue;
      }
      researcherSlots -= candidate.researchersRequired;
      engineerSlots -= candidate.engineersRequired;
      remaining[index] -= 1;
      active += 1;
    }
    if (active === 0) {
      // The preview is already blocked by staff. Keep the estimate finite and
      // conservative for display; enqueue/tick remains the authority.
      return Math.max(...remaining);
    }
    days += 1;
  }
  return Math.max(1, days);
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
  const engineersRequired = candidates.length
    ? Math.max(...candidates.map((estimate) => estimate.engineersRequired))
    : 0;
  const totalShare =
    dataResearchReservationShare(data) +
    candidates.length * DATA_PRUNE_RESEARCH_SHARE;
  const availableStaff = availableHqStaff(state, { includeDataJobs: false });
  const researchers = availableStaff.researchers;
  const engineers = availableStaff.engineers;
  const estimatedDays = estimateConcurrentPruneDays(
    candidates,
    researchers,
    engineers,
  );
  let reason: string | undefined;
  if (candidates.length === 0) reason = "No low-quality stock detected";
  else if (!audit.unlocked)
    reason = `Run corpus audit · ${formatMoneyShort(audit.cashCost)}`;
  else if (data.pruneQueue.length + candidates.length > DATA_PRUNE_MAX_JOBS)
    reason = "Pruning queue full";
  else if (researchers < researchersRequired) {
    reason = `Needs ${researchersRequired} researchers (have ${researchers})`;
  } else if (engineers < engineersRequired) {
    reason = `Needs ${engineersRequired} data engineers (have ${engineers})`;
  } else if (state.player.cash + 1e-9 < cashCost)
    reason = `Needs ${formatMoneyShort(cashCost)} cash`;
  else if (
    candidates.some(
      (estimate) => estimate.availableResearchPf < DATA_PRUNE_MIN_ACTIVE_PF,
    )
  ) {
    reason = "No research compute available";
  } else if (totalShare > maxDataResearchShareForState(state) + 1e-9) {
    reason = "Needs more free research compute";
  }
  return {
    domains: candidates.map((estimate) => estimate.domain),
    totalMTok,
    cashCost,
    pfDays,
    researchersRequired,
    engineersRequired,
    estimatedDays,
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
  // The player may use its own retained internal checkpoints. Rival internals
  // are intentionally excluded: hidden weights must not leak through data
  // routing, freshness labels, or serving-adjacent forecasts.
  const candidates = [
    ...state.player.models.filter(
      (candidate) =>
        candidate.release === "released" ||
        candidate.shipped ||
        candidate.release === "internal",
    ),
    ...state.rivals.flatMap((rival) =>
      rival.models.filter(
        (candidate) => candidate.release === "released" || candidate.shipped,
      ),
    ),
  ];
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
    aggregateEffects(state.player.researchUnlocked, state.player.researchRanks).dataFlywheel ?? 0;
  const servedByPlan = state.lastMarket.servedMTokByPlanId ?? {};
  const planSlices = state.player.pricing.plans.map((plan) => ({
    id: plan.id,
    pricePerMonth: plan.pricePerMonth,
    servedMTok:
      servedByPlan[plan.id] ??
      state.lastMarket.planStats.find((stat) => stat.planId === plan.id)
        ?.dayMTok ??
      0,
    dataCollectionRate: plan.dataCollectionRate,
  }));
  const result = collectTrafficData({
    data: ensureLabData(state),
    servedMTok:
      state.lastMarket.servedMTok * activeBalanceTuning().dataCollectionMult,
    demandMTok: state.lastMarket.playerDemandMTok,
    brandTrust: state.player.brandTrust,
    dataFlywheel: flywheel,
    segments: state.segments,
    planSlices,
  });
  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      data: result.data,
      brandTrust: result.brandTrust,
    },
  };
  const freeChat = result.data.dayCollectChatFree ?? 0;
  next = addToPool(
    next,
    state.playerLabId,
    "instructionMTok",
    freeChat * POST_TRAIN_TRAFFIC_TO_POOL.instructionPerFreeChatMTok,
  );
  next = addToPool(
    next,
    state.playerLabId,
    "preferenceMTok",
    freeChat * POST_TRAIN_TRAFFIC_TO_POOL.preferencePerFreeChatMTok,
  );
  return next;
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
 * Targeted jobs persist the full generation config: teacher model, target
 * corpus, requested volume, tier, filtering intensity, and compute budget.
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
    /** Filtering intensity 0–1: raises per-token quality, slows throughput. */
    filterIntensity?: number;
    /** Total research PF-days the job may consume before stopping. */
    computeBudgetPfDays?: number;
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
  if (used + share > maxDataResearchShareForState(state) + 0.001) {
    return alert(
      state,
      "warn",
      `Research pool for data gen is full (${Math.round(used * 100)}%). Lower share or wait.`,
    );
  }

  const continuous = opts.targetMTok == null;
  const target = continuous ? 0 : Math.max(5, opts.targetMTok ?? 5);
  const filterIntensity = Math.max(
    0,
    Math.min(1, opts.filterIntensity ?? (tier === "hq" ? 0.7 : 0.35)),
  );
  const computeBudgetPfDays =
    opts.computeBudgetPfDays != null && opts.computeBudgetPfDays > 0
      ? opts.computeBudgetPfDays
      : undefined;
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
    filterIntensity,
    computeBudgetPfDays,
    pfDaysSpent: 0,
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
    activeParamsB: synthTeacherActiveParamsB(model),
    family: model.family,
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
        message: `Continuous AI gen (${tier.toUpperCase()}): ${model.name} → ${DATA_DOMAIN_META[opts.domain].label} (~${Math.round(share * 100)}% research${estDays ? ` · ~${estDays}d` : ""}${computeBudgetPfDays ? ` · ${Math.round(computeBudgetPfDays)} PFd budget` : ""}). Update the teacher when its frontier freshness falls.`,
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
  acceptedMTokPerDay: number;
  powerMw: number;
  energyMWhPerDay: number;
  dailyComputeCost: number;
  /** Token-generation charge included exactly once in dailyComputeCost. */
  dailyTokenCashCost: number;
  costPerAcceptedMTok: number;
  kwhPerAcceptedMTok: number;
  domains: SynthDomainBudgetEstimate[];
}

export type SynthTeacherAssignment = "auto" | "assigned" | "fallback";

export interface SynthDomainBudgetEstimate {
  domain: DataDomain;
  requestedTeacherId?: string;
  requestedEffortId?: string;
  teacher: Model | null;
  autoTeacher: Model | null;
  assignment: SynthTeacherAssignment;
  validation?: string;
  effortId: string;
  effortName: string;
  effortQuality: number;
  thinkingTokenMultiplier: number;
  billedTokenMultiplier: number;
  computeIntensityMultiplier: number;
  domainCapability: number;
  modalityFit: number;
  toolFit: number;
  overallFit: number;
  researchPf: number;
  grossMTokPerDay: number;
  generatedTokenMTokPerDay: number;
  usefulChance: number;
  hqChance: number;
  acceptedMTokPerDay: number;
  powerMw: number;
  energyMWhPerDay: number;
  dailyComputeCost: number;
  dailyTokenCashCost: number;
  costPerAcceptedMTok: number;
  pfPerAcceptedMTok: number;
  kwhPerAcceptedMTok: number;
  yieldDeltaMTokPerDay: number;
  costDeltaPerAcceptedMTok: number;
  powerDeltaKwhPerAcceptedMTok: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/** Only retained player weights can teach. Training candidates never leak here. */
export function eligibleSynthTeachers(state: SimState): Model[] {
  return state.player.models.filter(
    (model) =>
      model.release === "released" ||
      model.shipped ||
      model.release === "internal",
  );
}

export function eligibleSynthTeachersForDomain(
  state: SimState,
  domain: DataDomain,
): Model[] {
  return eligibleSynthTeachers(state).filter((model) =>
    modelCanCurateDataDomain(model, domain),
  );
}

function teacherIo(model: Model) {
  return (
    model.io ??
    ioForPreset(
      model.productPreset ?? presetFromFamily(model.family),
      model.capability,
    )
  );
}

/** How well the actual model I/O and tool stack matches a generated corpus. */
export function synthTeacherFit(
  model: Model,
  domain: DataDomain,
): {
  domainCapability: number;
  modalityFit: number;
  toolFit: number;
  overallFit: number;
} {
  const io = teacherIo(model);
  const domainCapability = Math.max(
    0,
    Math.min(100, teacherCapabilityForDataDomain(model, domain)),
  );
  const textOutput = clamp01((io.outputs.text ?? 0) / 100);
  let modalityFit = textOutput;
  if (domain === "image") {
    modalityFit = clamp01(
      ((io.outputs.image ?? 0) * 0.72 + (io.inputs.image ?? 0) * 0.28) / 100,
    );
  } else if (domain === "video") {
    modalityFit = clamp01(
      ((io.outputs.video ?? 0) * 0.78 +
        (io.inputs.video ?? 0) * 0.16 +
        (io.inputs.image ?? 0) * 0.06) /
        100,
    );
  } else if (domain === "audio") {
    modalityFit = clamp01(
      ((io.outputs.audio ?? 0) * 0.74 + (io.inputs.audio ?? 0) * 0.26) / 100,
    );
  }
  const rawToolFit = clamp01(
    Math.max(io.tools ?? 0, model.capabilities?.domains.tools ?? 0) / 100,
  );
  const toolWeight =
    domain === "code"
      ? 0.18
      : domain === "math"
        ? 0.1
        : domain === "science"
          ? 0.05
          : 0;
  const toolFit = toolWeight > 0 ? rawToolFit : 1;
  const overallFit = clamp01(
    (domainCapability / 100) * (0.58 - toolWeight) +
      clamp01(model.quality.reliability / 100) * 0.2 +
      modalityFit * 0.22 +
      toolFit * toolWeight,
  );
  return { domainCapability, modalityFit, toolFit, overallFit };
}

function synthTeacherRoutingScore(model: Model, domain: DataDomain): number {
  const fit = synthTeacherFit(model, domain);
  if (!modelCanCurateDataDomain(model, domain)) return -Infinity;
  return (
    fit.overallFit * 100 +
    fit.domainCapability * 0.18 -
    Math.log10(1 + Math.max(0.007, model.activeParamsB ?? model.paramsB)) * 2
  );
}

export function autoSynthTeacher(
  state: SimState,
  domain: DataDomain,
): Model | null {
  return (
    [...eligibleSynthTeachersForDomain(state, domain)].sort(
      (left, right) =>
        synthTeacherRoutingScore(right, domain) -
        synthTeacherRoutingScore(left, domain),
    )[0] ?? null
  );
}

function resolveSynthTeacher(
  state: SimState,
  domain: DataDomain,
  requestedTeacherId?: string,
): {
  teacher: Model | null;
  autoTeacher: Model | null;
  assignment: SynthTeacherAssignment;
  validation?: string;
} {
  const autoTeacher = autoSynthTeacher(state, domain);
  if (!requestedTeacherId) {
    return { teacher: autoTeacher, autoTeacher, assignment: "auto" };
  }
  const requested = eligibleSynthTeachers(state).find(
    (model) => model.id === requestedTeacherId,
  );
  if (!requested) {
    return {
      teacher: autoTeacher,
      autoTeacher,
      assignment: "fallback",
      validation: "Assigned teacher is unavailable; Auto is active.",
    };
  }
  if (!modelCanCurateDataDomain(requested, domain)) {
    return {
      teacher: autoTeacher,
      autoTeacher,
      assignment: "fallback",
      validation: `${requested.name} cannot generate this corpus; Auto is active.`,
    };
  }
  return {
    teacher: requested,
    autoTeacher,
    assignment: "assigned",
  };
}

function synthDomainBudget(
  state: SimState,
  domain: DataDomain,
  researchPf: number,
  powerMw: number,
  requestedTeacherId?: string,
  requestedEffortId?: string,
  autoReference = false,
): Omit<
  SynthDomainBudgetEstimate,
  | "yieldDeltaMTokPerDay"
  | "costDeltaPerAcceptedMTok"
  | "powerDeltaKwhPerAcceptedMTok"
> {
  const resolved = resolveSynthTeacher(
    state,
    domain,
    autoReference ? undefined : requestedTeacherId,
  );
  const model = resolved.teacher;
  if (!model) {
    return {
      domain,
      requestedTeacherId,
      requestedEffortId,
      ...resolved,
      effortId: "instant",
      effortName: "Instant",
      effortQuality: 1,
      thinkingTokenMultiplier: 1,
      billedTokenMultiplier: 1,
      computeIntensityMultiplier: 1,
      domainCapability: 0,
      modalityFit: 0,
      toolFit: 0,
      overallFit: 0,
      researchPf,
      grossMTokPerDay: 0,
      generatedTokenMTokPerDay: 0,
      usefulChance: 0,
      hqChance: 0,
      acceptedMTokPerDay: 0,
      powerMw,
      energyMWhPerDay: powerMw * 24,
      dailyComputeCost: 0,
      dailyTokenCashCost: 0,
      costPerAcceptedMTok: 0,
      pfPerAcceptedMTok: 0,
      kwhPerAcceptedMTok: 0,
    };
  }
  const baseFit = synthTeacherFit(model, domain);
  const effortEconomics = syntheticTeacherGenerationEconomics({
    model,
    domain,
    effortId: autoReference ? undefined : requestedEffortId,
    acceptedMTok: 1,
  });
  const domainCapability = effortEconomics.effectiveDomainCapability;
  const overallFit = clamp01(
    baseFit.overallFit +
      ((domainCapability - baseFit.domainCapability) / 100) * 0.58,
  );
  const effectiveResearchPf =
    researchPf /
    Math.max(
      1,
      effortEconomics.billedTokenMultiplier *
        effortEconomics.computeIntensityMultiplier,
    );
  const grossMTokPerDay = syntheticGenerationMTokPerDay({
    domain,
    teacherDomainCapability: domainCapability,
    teacherReliability: model.quality.reliability,
    researchPf: effectiveResearchPf,
    tier: "lq",
    activeParamsB: synthTeacherActiveParamsB(model),
    family: model.family,
  });
  const { usefulChance, hqChance } = synthAcceptanceChances({
    domain,
    domainCapability,
    overallFit,
    modalityFit: baseFit.modalityFit,
    toolFit: baseFit.toolFit,
    reliability: model.quality.reliability,
    researchPf,
  });
  const acceptedMTokPerDay = grossMTokPerDay * usefulChance;
  const energyMWhPerDay = powerMw * 24;
  const energyCost = energyMWhPerDay * energyPriceForState(state);
  const researchComputeCost = researchPf * ECONOMY.researchCashPerPfDay * 0.55;
  const generatedTokenMTokPerDay =
    grossMTokPerDay * effortEconomics.billedTokenMultiplier;
  const dailyTokenCashCost =
    generatedTokenMTokPerDay *
    SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK;
  const dailyComputeCost =
    energyCost + researchComputeCost + dailyTokenCashCost;
  return {
    domain,
    requestedTeacherId,
    requestedEffortId,
    ...resolved,
    ...baseFit,
    domainCapability,
    overallFit,
    effortId: effortEconomics.effortId,
    effortName: effortEconomics.effortName,
    effortQuality: effortEconomics.effortQuality,
    thinkingTokenMultiplier: effortEconomics.thinkingTokenMultiplier,
    billedTokenMultiplier: effortEconomics.billedTokenMultiplier,
    computeIntensityMultiplier: effortEconomics.computeIntensityMultiplier,
    researchPf,
    grossMTokPerDay,
    generatedTokenMTokPerDay,
    usefulChance,
    hqChance,
    acceptedMTokPerDay,
    powerMw,
    energyMWhPerDay,
    dailyComputeCost,
    dailyTokenCashCost,
    costPerAcceptedMTok:
      acceptedMTokPerDay > 0 ? dailyComputeCost / acceptedMTokPerDay : 0,
    pfPerAcceptedMTok:
      acceptedMTokPerDay > 0 ? researchPf / acceptedMTokPerDay : 0,
    kwhPerAcceptedMTok:
      acceptedMTokPerDay > 0
        ? (energyMWhPerDay * 1_000) / acceptedMTokPerDay
        : 0,
  };
}

/** Forecast an automatic synthetic portfolio from one player-facing compute budget. */
export function estimateSynthBudget(
  state: SimState,
  researchShare: number,
  teacherModelIds: Partial<Record<DataDomain, string>> = {},
  teacherEffortIds: Partial<Record<DataDomain, string>> = {},
): SynthBudgetEstimate {
  const share = Math.max(0.05, Math.min(0.5, researchShare));
  const researchPf = grossResearchPoolPf(state) * share;
  const snapshot = computeSnapshot(state);
  // Local snapshots expose measured research draw. Remote/idle-to-active pools
  // need a conservative accelerator-equivalent forecast so synthetic compute
  // never appears power-free in previews.
  const powerMw = Math.max(
    snapshot.mwBreakdown.research * share,
    researchPf * 0.0016 * Math.max(1, state.player.pue),
  );
  const domainPf = researchPf / DATA_DOMAINS.length;
  const domainPowerMw = powerMw / DATA_DOMAINS.length;
  const domains = DATA_DOMAINS.map((domain): SynthDomainBudgetEstimate => {
    const selected = synthDomainBudget(
      state,
      domain,
      domainPf,
      domainPowerMw,
      teacherModelIds[domain],
      teacherEffortIds[domain],
    );
    const automatic = teacherModelIds[domain]
      ? synthDomainBudget(
          state,
          domain,
          domainPf,
          domainPowerMw,
          undefined,
          undefined,
          true,
        )
      : selected;
    return {
      ...selected,
      yieldDeltaMTokPerDay:
        selected.acceptedMTokPerDay - automatic.acceptedMTokPerDay,
      costDeltaPerAcceptedMTok:
        selected.costPerAcceptedMTok - automatic.costPerAcceptedMTok,
      powerDeltaKwhPerAcceptedMTok:
        selected.kwhPerAcceptedMTok - automatic.kwhPerAcceptedMTok,
    };
  });
  const grossMTokPerDay = domains.reduce(
    (sum, domain) => sum + domain.grossMTokPerDay,
    0,
  );
  const acceptedMTokPerDay = domains.reduce(
    (sum, domain) => sum + domain.acceptedMTokPerDay,
    0,
  );
  const usefulChance =
    grossMTokPerDay > 0 ? acceptedMTokPerDay / grossMTokPerDay : 0;
  const hqChance =
    acceptedMTokPerDay > 0
      ? domains.reduce(
          (sum, domain) => sum + domain.acceptedMTokPerDay * domain.hqChance,
          0,
        ) / acceptedMTokPerDay
      : 0;
  const dailyComputeCost = domains.reduce(
    (sum, domain) => sum + domain.dailyComputeCost,
    0,
  );
  const dailyTokenCashCost = domains.reduce(
    (sum, domain) => sum + domain.dailyTokenCashCost,
    0,
  );
  const energyMWhPerDay = domains.reduce(
    (sum, domain) => sum + domain.energyMWhPerDay,
    0,
  );

  return {
    model: domains.find((domain) => domain.domain === "chat")?.teacher ?? null,
    researchPf,
    grossMTokPerDay,
    usefulChance,
    hqChance,
    acceptedMTokPerDay,
    powerMw,
    energyMWhPerDay,
    dailyComputeCost,
    dailyTokenCashCost,
    costPerAcceptedMTok:
      acceptedMTokPerDay > 0 ? dailyComputeCost / acceptedMTokPerDay : 0,
    kwhPerAcceptedMTok:
      acceptedMTokPerDay > 0
        ? (energyMWhPerDay * 1_000) / acceptedMTokPerDay
        : 0,
    domains,
  };
}

/** Start the simplified auto-routing generator used by the Data workspace. */
export function startSynthBudget(
  state: SimState,
  opts: {
    researchShare: number;
    teacherModelIds?: Partial<Record<DataDomain, string>>;
    teacherEffortIds?: Partial<Record<DataDomain, string>>;
  },
): SimState {
  if (!state.player.researchUnlocked.includes("data_synth")) {
    return alert(
      state,
      "warn",
      "Unlock Synthetic Generators (data tree: mix → clean → eval → synth) first.",
    );
  }
  const estimate = estimateSynthBudget(
    state,
    opts.researchShare,
    opts.teacherModelIds,
    opts.teacherEffortIds,
  );
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
      maxDataResearchShareForState(state) - otherShare,
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
      job.id === existing.id
        ? {
            ...job,
            researchShare: share,
            teacherModelIds: { ...(opts.teacherModelIds ?? {}) },
            teacherEffortIds: { ...(opts.teacherEffortIds ?? {}) },
          }
        : job,
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
          message: `Synthetic compute and corpus teacher routing updated: ${Math.round(share * 100)}% of research.`,
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
  if (used + share > maxDataResearchShareForState(state) + 0.001) {
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
    teacherModelIds: { ...(opts.teacherModelIds ?? {}) },
    teacherEffortIds: { ...(opts.teacherEffortIds ?? {}) },
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

const V4_VERIFIER_STRENGTH = 0.2;

function modelsForLab(state: SimState, labId: LabId): Model[] {
  if (labId === state.playerLabId) return state.player.models ?? [];
  return state.rivals.find((rival) => rival.id === labId)?.models ?? [];
}

function parseTeacherRef(ref: string): {
  kind: "model" | "checkpoint" | "any";
  id: string;
} {
  if (ref.startsWith("checkpoint:")) {
    return { kind: "checkpoint", id: ref.slice("checkpoint:".length) };
  }
  if (ref.startsWith("model:")) {
    return { kind: "model", id: ref.slice("model:".length) };
  }
  return { kind: "any", id: ref };
}

export interface V4SynthTeacher {
  name: string;
  domainCap: number;
  activeParamsB: number;
  family?: ModelFamily;
  modelId?: string;
  checkpointId?: string;
  maxSyntheticDepth: number;
}

function teacherFromModel(model: Model, domain: DataDomain): V4SynthTeacher {
  return {
    name: model.name,
    domainCap: teacherCapabilityForDataDomain(model, domain),
    activeParamsB: synthTeacherActiveParamsB(model),
    family: model.family,
    modelId: model.id,
    maxSyntheticDepth: (model.syntheticShare ?? 0) > 0 ? 1 : 0,
  };
}

function teacherFromCheckpoint(
  checkpoint: Checkpoint,
  domain: DataDomain,
): V4SynthTeacher {
  return {
    name: checkpoint.name,
    domainCap: domainCapFromCapabilities(checkpoint.truth, domain),
    activeParamsB: Math.max(
      0.007,
      checkpoint.arch.activeParamsB ?? checkpoint.arch.totalParamsB,
    ),
    checkpointId: checkpoint.id,
    maxSyntheticDepth:
      (checkpoint.trainingSummary.syntheticShare ?? 0) > 0 ? 1 : 0,
  };
}

export function resolveV4SynthTeacher(
  state: SimState,
  labId: LabId,
  teacherRef: string,
  domain: DataDomain,
): V4SynthTeacher | null {
  const parsed = parseTeacherRef(teacherRef);
  const models = modelsForLab(state, labId);
  const checkpoints = trainingStateOf(state, labId).checkpoints;
  const model =
    parsed.kind !== "checkpoint"
      ? (models.find((candidate) => candidate.id === parsed.id) ?? null)
      : null;
  const checkpoint =
    parsed.kind !== "model"
      ? (checkpoints.find((candidate) => candidate.id === parsed.id) ?? null)
      : null;
  if (parsed.kind === "model") return model ? teacherFromModel(model, domain) : null;
  if (parsed.kind === "checkpoint") {
    return checkpoint ? teacherFromCheckpoint(checkpoint, domain) : null;
  }
  if (model) return teacherFromModel(model, domain);
  if (checkpoint) return teacherFromCheckpoint(checkpoint, domain);
  return null;
}

/** Start an explicit V4 generation job. Tokens are written as a DatasetAsset on complete. */
export function startSyntheticGenerationJob(
  state: SimState,
  opts: {
    domain: DataDomain;
    teacherRef: string;
    tierBudget: SynthTierBudget;
    targetMTok: number;
    verify?: boolean;
  },
): SimState {
  const target = Math.max(0, opts.targetMTok);
  if (!(target > 0)) {
    return alert(state, "warn", "Synthetic generation needs a positive token target.");
  }
  const teacher = resolveV4SynthTeacher(
    state,
    state.playerLabId,
    opts.teacherRef,
    opts.domain,
  );
  if (!teacher) {
    return alert(state, "warn", "Pick a finished model or checkpoint as teacher.");
  }
  const data = cloneLabData(ensureLabData(state));
  const job: SyntheticGenerationJob = {
    id: seededId(
      "v4synth",
      state.seed,
      state.day,
      opts.domain,
      opts.teacherRef,
      data.syntheticJobs?.length ?? 0,
    ),
    domain: opts.domain,
    teacherRef: opts.teacherRef,
    tierBudget: opts.tierBudget,
    targetMTok: target,
    generatedMTok: 0,
    verify: opts.verify === true,
    startDay: state.day,
    status: "running",
  };
  data.syntheticJobs = [...(data.syntheticJobs ?? []), job];
  return {
    ...state,
    player: { ...state.player, data },
    alerts: [
      {
        id: job.id,
        day: state.day,
        severity: "info" as const,
        message: `Generating ${formatTokens(target)} ${DATA_DOMAIN_META[opts.domain].label} via ${teacher.name} (tier ${opts.tierBudget}).`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

function completeV4SyntheticJob(
  state: SimState,
  data: LabData,
  job: SyntheticGenerationJob,
  teacher: V4SynthTeacher,
): LabData {
  const depth = 1 + teacher.maxSyntheticDepth;
  const verifierStrength = job.verify ? V4_VERIFIER_STRENGTH : 0;
  const quality01 = syntheticQualityFor({
    teacherDomainCap: teacher.domainCap,
    tierBudget: job.tierBudget,
    verifierStrength,
    depth,
  });
  const volume = Math.max(job.generatedMTok, job.targetMTok);
  const method = job.verify ? "verifier" : "imitation";
  const assetId = `dataset-v4-${job.id}`;
  const next = appendDatasetAsset(data, {
    id: assetId,
    name: `${teacher.name} ${DATA_DOMAIN_META[job.domain].label} synthetic`,
    volumeMTok: volume,
    domainWeights: { [job.domain]: 1 },
    verticalTags: [job.domain, "synthetic", "v4"],
    quality: quality01 * 100,
    diversity: job.verify ? 0.72 : 0.48,
    freshness: 1,
    rights: "owned",
    source: "synthetic",
    exclusiveUntilDay: null,
    contaminationRisk: job.verify ? 0.08 : 0.22,
    synthetic: {
      method,
      teacherModelIds: teacher.modelId ? [teacher.modelId] : [],
      generationDepth: depth,
      promptDiversity: job.verify ? 0.72 : 0.48,
      verifierStrength,
      candidatesPerAccepted: job.verify ? 4 : 1,
      humanAnchorShare: 0.08,
    },
    v4Synthetic: {
      teacherCheckpointId: teacher.checkpointId,
      teacherModelId: teacher.modelId,
      teacherName: teacher.name,
      tierBudget: job.tierBudget,
      depth,
      verifiedShare: job.verify ? 1 : 0,
      method,
      quality: quality01,
      generatedDay: state.day,
    },
    acquiredDay: state.day,
  });
  const stock = normalizeDomainStock(next.stocks[job.domain]);
  const prior = stock.processed;
  stock.processed = prior + volume;
  stock.fromSynth = (stock.fromSynth ?? 0) + volume;
  if (quality01 >= 0.58) stock.fromSynthHQ = (stock.fromSynthHQ ?? 0) + volume;
  else stock.fromSynthLQ = (stock.fromSynthLQ ?? 0) + volume;
  stock.quality =
    stock.processed > 0
      ? (stock.quality * prior + quality01 * 100 * volume) / stock.processed
      : quality01 * 100;
  next.stocks[job.domain] = stock;
  next.daySynthMTok += volume;
  next.dayProcessed += volume;
  next.lifetimeProcessed += volume;
  next.lifetimeCollected += volume;
  return next;
}

function advanceV4SyntheticJobs(
  state: SimState,
  dataIn: LabData,
  cash: number,
  alerts: SimState["alerts"],
): { data: LabData; cash: number; alerts: SimState["alerts"] } {
  const jobs: SyntheticGenerationJob[] = (dataIn.syntheticJobs ?? []).map(
    (job) => ({ ...job }),
  );
  const running = jobs.filter((job) => job.status === "running");
  if (running.length === 0) {
    return { data: { ...dataIn, syntheticJobs: jobs }, cash, alerts };
  }
  const live = { ...state, player: { ...state.player, data: dataIn } };
  const snap = computeSnapshot(live);
  const pfPool =
    snap.pools.inference * 0.2 + grossResearchPoolPf(live) * 0.12;
  const pfPerJob = pfPool / running.length;
  let data = dataIn;
  let nextCash = cash;
  let nextAlerts = alerts;
  for (const job of jobs) {
    if (job.status !== "running") continue;
    const teacher = resolveV4SynthTeacher(
      live,
      state.playerLabId,
      job.teacherRef,
      job.domain,
    );
    if (!teacher) continue;
    const remaining = Math.max(0, job.targetMTok - job.generatedMTok);
    const minted = Math.min(
      remaining,
      syntheticMTokFromPfDays({
        pfDays: pfPerJob,
        tierBudget: job.tierBudget,
        teacherActiveParamsB: teacher.activeParamsB,
        domain: job.domain,
        family: teacher.family,
      }),
    );
    if (minted > 0) {
      const unitCost = syntheticMTokFromPfDays({
        pfDays: 1,
        tierBudget: job.tierBudget,
        teacherActiveParamsB: teacher.activeParamsB,
        domain: job.domain,
        family: teacher.family,
      });
      const pfDays = unitCost > 0 ? minted / unitCost : 0;
      nextCash -=
        minted * SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK * job.tierBudget +
        pfDays * ECONOMY.researchCashPerPfDay * 0.55;
      job.generatedMTok += minted;
    }
    if (job.generatedMTok >= job.targetMTok - 1e-6) {
      job.generatedMTok = job.targetMTok;
      job.status = "completed";
      data = completeV4SyntheticJob(state, data, job, teacher);
      nextAlerts = [
        {
          id: `v4synth-done-${job.id}`,
          day: state.day,
          severity: "info" as const,
          message: `Synth complete: ${formatTokens(job.targetMTok)} ${DATA_DOMAIN_META[job.domain].label} via ${teacher.name}.`,
        },
        ...nextAlerts,
      ].slice(0, 40);
    }
  }
  data = { ...data, syntheticJobs: jobs };
  return { data, cash: nextCash, alerts: nextAlerts };
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
    activeParamsB: synthTeacherActiveParamsB(model),
    family: model.family,
  });
}

function removeProcessedLowQuality(
  stock: LabData["stocks"][DataDomain],
  amount: number,
  removedQualityMTok: number,
  breakdown: DatasetPruneBreakdown,
): void {
  const oldProcessed = stock.processed;
  const removed = Math.min(oldProcessed, Math.max(0, amount));
  if (removed <= 0) return;

  const priorSynthOther = Math.max(
    0,
    (stock.fromSynth ?? 0) -
      (stock.fromSynthHQ ?? 0) -
      (stock.fromSynthLQ ?? 0),
  );
  const take = (
    key: "fromWeb" | "fromUser" | "fromBought" | "fromSynthHQ" | "fromSynthLQ",
    requested: number,
  ): number => {
    const actual = Math.min(
      Math.max(0, stock[key] ?? 0),
      Math.max(0, requested),
    );
    stock[key] = Math.max(0, (stock[key] ?? 0) - actual);
    return actual;
  };
  let sourceRemoved = 0;
  sourceRemoved += take("fromWeb", breakdown.webMTok);
  sourceRemoved += take("fromUser", breakdown.userMTok);
  sourceRemoved += take("fromBought", breakdown.boughtMTok);
  sourceRemoved += take("fromSynthHQ", breakdown.synthHqMTok);
  sourceRemoved += take("fromSynthLQ", breakdown.synthLqMTok);

  // Older saves may have aggregate stock without complete backing assets.
  // Remove any un-attributed remainder proportionally without double-counting
  // the synthetic total and its HQ/LQ subcategories.
  const sourceLeft = Math.max(0, removed - sourceRemoved);
  const sourceTotal =
    Math.max(0, stock.fromWeb ?? 0) +
    Math.max(0, stock.fromUser ?? 0) +
    Math.max(0, stock.fromBought ?? 0) +
    Math.max(0, stock.fromSynthHQ ?? 0) +
    Math.max(0, stock.fromSynthLQ ?? 0) +
    priorSynthOther;
  let nextSynthOther = priorSynthOther;
  if (sourceLeft > 0 && sourceTotal > 0) {
    const ratio = Math.min(1, sourceLeft / sourceTotal);
    stock.fromWeb = Math.max(0, (stock.fromWeb ?? 0) * (1 - ratio));
    stock.fromUser = Math.max(0, (stock.fromUser ?? 0) * (1 - ratio));
    stock.fromBought = Math.max(0, (stock.fromBought ?? 0) * (1 - ratio));
    stock.fromSynthHQ = Math.max(0, (stock.fromSynthHQ ?? 0) * (1 - ratio));
    stock.fromSynthLQ = Math.max(0, (stock.fromSynthLQ ?? 0) * (1 - ratio));
    nextSynthOther *= 1 - ratio;
  }
  stock.fromSynth =
    (stock.fromSynthHQ ?? 0) + (stock.fromSynthLQ ?? 0) + nextSynthOther;

  const nextProcessed = Math.max(0, oldProcessed - removed);
  const assetBackedRemoved = Math.min(
    removed,
    Math.max(
      0,
      breakdown.webMTok +
        breakdown.userMTok +
        breakdown.boughtMTok +
        breakdown.synthHqMTok +
        breakdown.synthLqMTok,
    ),
  );
  const fallbackRemoved = Math.max(0, removed - assetBackedRemoved);
  const fallbackQuality = Math.min(stock.quality, 22);
  const removedQualityMass =
    Math.max(0, removedQualityMTok) + fallbackRemoved * fallbackQuality;
  // Recompute the surviving weighted mean from the exact assets removed. This
  // raises quality only when the discarded slice was actually below average.
  stock.quality =
    nextProcessed > 0
      ? Math.max(
          stock.quality,
          Math.min(
            95,
            (stock.quality * oldProcessed - removedQualityMass) / nextProcessed,
          ),
        )
      : DATA_PRUNE_QUALITY_FLOOR;
  stock.processed = nextProcessed;
}

function processDataPruneJobs(
  state: SimState,
  dataInput: LabData,
  cashInput: number,
  alertsInput?: SimState["alerts"],
): { data: LabData; cash: number; alerts: SimState["alerts"] } {
  let data = cloneLabData(dataInput);
  let cash = cashInput;
  let alerts = alertsInput ?? state.alerts;
  const availableStaff = availableHqStaff(state, { includeDataJobs: false });
  const researchers = availableStaff.researchers;
  const engineers = availableStaff.engineers;
  let researcherSlots = Math.max(0, researchers);
  let engineerSlots = Math.max(0, engineers);
  const grossResearchPf = grossResearchPoolPf({
    ...state,
    player: { ...state.player, data },
  });
  const queue: DataPruneJob[] = [];

  for (const job of data.pruneQueue) {
    const totalLeft = job.rawRemaining + job.processedRemaining;
    if (totalLeft <= 0.001) continue;
    const engineersRequired = Math.max(1, job.engineersRequired ?? 1);
    if (
      researchers < job.researchersRequired ||
      engineers < engineersRequired ||
      researcherSlots < job.researchersRequired ||
      engineerSlots < engineersRequired ||
      grossResearchPf <= 0.001
    ) {
      queue.push(job);
      if (state.day % 4 === 0) {
        alerts = [
          {
            id: `prune-stalled-${job.id}-${state.day}`,
            day: state.day,
            severity: "warn" as const,
            message: `${DATA_DOMAIN_META[job.domain].label} pruning stalled — needs ${job.researchersRequired} researchers, ${engineersRequired} data engineers, and research compute.`,
          },
          ...alerts,
        ].slice(0, 40);
      }
      continue;
    }

    // A running audit holds its declared staff slots for this daily pass.
    // This prevents a bulk queue from silently reusing one engineer on every
    // domain while keeping the queue itself resumable as headcount expands.
    researcherSlots -= job.researchersRequired;
    engineerSlots -= engineersRequired;

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
    const assetPrune = pruneDatasetAssetsForDomain({
      data,
      domain: job.domain,
      amountMTok: processedStep,
    });
    data = assetPrune.data;
    const stock = data.stocks[job.domain];
    stock.raw = Math.max(0, stock.raw - rawStep);
    removeProcessedLowQuality(
      stock,
      processedStep,
      assetPrune.removedQualityMTok,
      assetPrune.breakdown,
    );
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
  // Never clamp the company ledger here. A prune queue may pause when it
  // cannot fund more work, but existing debt must survive into settlement.
  return { data, cash, alerts };
}

/**
 * Apply one bounded hygiene penalty to already released checkpoints.
 *
 * Training evidence remains immutable, so this models an operationally stale
 * served model rather than rewriting the run's historical data snapshot. The
 * per-model day marker makes direct/retried tick calls idempotent.
 */
export const CORPUS_DRIFT_INTERVAL_DAYS = 20;

function applyCorpusDrift(state: SimState, data: LabData): SimState {
  const rate = dataModelDriftRate(data);
  if (rate <= 0) return state;
  if (state.day % CORPUS_DRIFT_INTERVAL_DAYS !== 0) return state;

  let changed = false;
  const models = state.player.models.map((model) => {
    if (model.corpusDriftLastDay === state.day) return model;
    const prior = Math.max(0, model.corpusDriftTotal ?? 0);
    const applied = Math.min(rate, Math.max(0, 0.24 - prior));
    if (applied <= 0) return { ...model, corpusDriftLastDay: state.day };
    changed = true;
    const retain = 1 - applied;
    const qualityRetain = 1 - applied * 0.85;
    const benchmarks = Object.fromEntries(
      Object.entries(model.benchmarks).map(([key, value]) => [
        key,
        Math.max(0, value * qualityRetain),
      ]),
    ) as typeof model.benchmarks;
    const quality = Object.fromEntries(
      Object.entries(model.quality).map(([key, value]) => [
        key,
        Math.max(0, value * qualityRetain),
      ]),
    ) as unknown as typeof model.quality;
    const capabilities = model.capabilities
      ? {
          ...model.capabilities,
          domains: Object.fromEntries(
            Object.entries(model.capabilities.domains).map(([key, value]) => [
              key,
              Math.max(0, value * qualityRetain),
            ]),
          ) as typeof model.capabilities.domains,
          factuality: Math.max(0, model.capabilities.factuality * qualityRetain),
          steerability: Math.max(0, model.capabilities.steerability * qualityRetain),
          robustness: Math.max(0, model.capabilities.robustness * qualityRetain),
          safety: Math.max(0, model.capabilities.safety * qualityRetain),
          reliability: Math.max(0, model.capabilities.reliability * qualityRetain),
        }
      : undefined;
    return {
      ...model,
      capability: Math.max(1, model.capability * retain),
      benchmarks,
      quality,
      capabilities,
      corpusDriftTotal: prior + applied,
      corpusDriftLastDay: state.day,
    };
  });
  if (!changed) return state;
  return {
    ...state,
    player: { ...state.player, models },
    alerts: [
      {
        id: `data-drift-${state.day}`,
        day: state.day,
        severity: "warn" as const,
        message: `Corpus hygiene degraded every model by ${(rate * 100).toFixed(2)}% this 20-day cycle. Clean or prune exposed data before the next review.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
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
      const estimate = estimateSynthBudget(
        liveState,
        job.researchShare,
        job.teacherModelIds,
        job.teacherEffortIds,
      );
      if (!estimate.model || estimate.grossMTokPerDay <= 0) {
        synthQueue.push(job);
        continue;
      }

      // Synthetic inference shares the research pool, pays the PF-day burden,
      // and is billed for every generated/reasoning token exactly once here.
      // Electricity stays visible in the quote but fleet operations settle it.
      cash -= Math.max(
        0,
        estimate.dailyComputeCost -
          estimate.energyMWhPerDay * energyPriceForState(state),
      );

      let grossToday = 0;
      let hqToday = 0;
      let lqToday = 0;
      let wasteToday = 0;
      for (const domain of DATA_DOMAINS) {
        const domainEstimate = estimate.domains.find(
          (candidate) => candidate.domain === domain,
        );
        const model = domainEstimate?.teacher;
        if (!domainEstimate || !model) continue;
        const rng = createRng(hashSeed(state.seed, state.day, job.id, domain));
        const gross =
          domainEstimate.grossMTokPerDay * (0.82 + rng.next() * 0.36);
        const usefulFraction = Math.max(
          0.04,
          Math.min(
            0.96,
            domainEstimate.usefulChance * (0.68 + rng.next() * 0.64),
          ),
        );
        const hqFraction = Math.max(
          0.05,
          Math.min(0.95, domainEstimate.hqChance * (0.72 + rng.next() * 0.56)),
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
          id: `dataset-${job.id}-${domain}-${model.id}-hq`,
          name: `Auto ${DATA_DOMAIN_META[domain].label} synthetic · high quality`,
          domain,
          volumeMTok: hq,
          quality: 0,
          teacherModelId: model.id,
          tier: "hq",
          day: state.day,
          provenance: {
            teacherEffortIds: [domainEstimate.effortId],
            teacherEffortNames: [domainEstimate.effortName],
            teacherThinkingTokenMultiplier:
              domainEstimate.thinkingTokenMultiplier,
            teacherEffortQuality: domainEstimate.effortQuality,
            billedTokenMultiplier: domainEstimate.billedTokenMultiplier,
            computeIntensityMultiplier:
              domainEstimate.computeIntensityMultiplier,
            generationCashPerAttemptedMTok:
              domainEstimate.billedTokenMultiplier *
              SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK,
          },
        });
        const lqAssetSeed = syntheticDatasetAsset({
          id: `dataset-${job.id}-${domain}-${model.id}-lq`,
          name: `Auto ${DATA_DOMAIN_META[domain].label} synthetic · low quality`,
          domain,
          volumeMTok: lq,
          quality: 0,
          teacherModelId: model.id,
          tier: "lq",
          day: state.day,
          provenance: {
            teacherEffortIds: [domainEstimate.effortId],
            teacherEffortNames: [domainEstimate.effortName],
            teacherThinkingTokenMultiplier:
              domainEstimate.thinkingTokenMultiplier,
            teacherEffortQuality: domainEstimate.effortQuality,
            billedTokenMultiplier: domainEstimate.billedTokenMultiplier,
            computeIntensityMultiplier:
              domainEstimate.computeIntensityMultiplier,
            generationCashPerAttemptedMTok:
              domainEstimate.billedTokenMultiplier *
              SYNTHETIC_GENERATION_CASH_PER_BILLED_MTOK,
          },
        });
        const hqQuality = Math.max(
          18,
          estimateSyntheticQuality({
            domain,
            teacherDomainCapability: domainEstimate.domainCapability,
            provenance: hqAssetSeed.synthetic!,
          }).quality -
            freshness.capabilityGap * 0.35,
        );
        const lqQuality = Math.max(
          12,
          estimateSyntheticQuality({
            domain,
            teacherDomainCapability: domainEstimate.domainCapability,
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
        modelId: estimate.model.id,
        modelName: estimate.model.name,
        progressMTok: job.progressMTok + grossToday,
        hqMTok: (job.hqMTok ?? 0) + hqToday,
        lqMTok: (job.lqMTok ?? 0) + lqToday,
        wastedMTok: (job.wastedMTok ?? 0) + wasteToday,
        pfDaysSpent: (job.pfDaysSpent ?? 0) + estimate.researchPf,
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
    // Targeted jobs stop when their persisted compute budget is exhausted.
    const budget = job.computeBudgetPfDays ?? Infinity;
    const budgetLeft = Math.max(0, budget - (job.pfDaysSpent ?? 0));
    if (budgetLeft <= 0) {
      alerts = [
        {
          id: `synth-budget-done-${job.id}`,
          day: state.day,
          severity: "info" as const,
          message: `Synth budget spent (${tier.toUpperCase()}): ${formatTokens(job.progressMTok)} ${meta.label} via ${job.modelName} used its ${Math.round(budget)} PF-day budget.`,
        },
        ...alerts,
      ].slice(0, 40);
      continue;
    }
    const pfScale = pf > 0 ? Math.min(1, budgetLeft / pf) : 0;
    // Targeted generators use the same research-compute cash burden as the
    // automatic portfolio. Fleet electricity is settled separately.
    cash -=
      pf *
      pfScale *
      ECONOMY.researchCashPerPfDay *
      0.55;
    const filterIntensity = Math.max(
      0,
      Math.min(1, job.filterIntensity ?? 0.5),
    );
    const attempted =
      syntheticGenerationMTokPerDay({
        domain: job.domain,
        teacherDomainCapability: teacherCapabilityForDataDomain(
          model,
          job.domain,
        ),
        teacherReliability: model.quality.reliability,
        researchPf: pf,
        tier,
        activeParamsB: synthTeacherActiveParamsB(model),
        family: model.family,
      }) *
      pfScale *
      // Harder filtering rejects more candidates before deposit.
      (1 - 0.3 * filterIntensity);
    const fit = synthTeacherFit(model, job.domain);
    const chances = synthAcceptanceChances({
      domain: job.domain,
      domainCapability: fit.domainCapability,
      overallFit: fit.overallFit,
      modalityFit: fit.modalityFit,
      toolFit: fit.toolFit,
      reliability: model.quality.reliability,
      researchPf: pf * pfScale,
    });
    const useful = attempted * chances.usefulChance;
    const gen = tier === "hq" ? useful * chances.hqChance : useful;
    const pfDaysSpent = (job.pfDaysSpent ?? 0) + pf * pfScale;
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
      // Synthetic quality = teacher strength × method quality × filtering
      // quality × depth decay. A teacher weak in this domain cannot produce
      // strong data from general capability alone (70% domain weight).
      const teacher = synthTeacherFreshness(state, model, job.domain);
      const qIn = syntheticJobQuality({
        teacherStrength: teacherDomainStrength({
          domainBenchmark: teacherCapabilityForDataDomain(model, job.domain),
          reliability: model.quality.reliability,
          capability: model.capability,
        }),
        method: tier === "hq" ? "filtered" : "imitation",
        filterIntensity,
        generationDepth,
      });
      stock.processed = stock.processed + step;
      stock.fromSynth = (stock.fromSynth ?? 0) + step;
      if (tier === "hq") stock.fromSynthHQ = (stock.fromSynthHQ ?? 0) + step;
      else stock.fromSynthLQ = (stock.fromSynthLQ ?? 0) + step;
      // Blended stock quality for display (real-weighted)
      const np = stock.processed;
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
      synthQueue.push({
        ...job,
        progressMTok: next,
        qualityTier: tier,
        pfDaysSpent,
      });
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

  const v4Synth = advanceV4SyntheticJobs(state, data, cash, alerts);
  data = v4Synth.data;
  cash = v4Synth.cash;
  alerts = v4Synth.alerts;

  const pruning = processDataPruneJobs(state, data, cash, alerts);
  data = pruning.data;
  cash = pruning.cash;
  alerts = pruning.alerts;

  // Research left for processing assist
  const researchLeft =
    snap.pools.research *
    researchPoolForTech({ ...state, player: { ...state.player, data } });

  const dataRuntimeStaff = unreservedStaffHeadcount({
    ...state,
    player: { ...state.player, data },
  });

  data = enqueueAutomaticProcessing({
    data,
    day: state.day,
    labId: state.playerLabId,
    dataQuality: state.player.dataQuality,
    staff: dataRuntimeStaff,
  });
  const effects = aggregateEffects(state.player.researchUnlocked, state.player.researchRanks);
  const processing = processDataJobs({
    data,
    cash,
    throughputMTok: dataProcessingThroughput({
      staff: dataRuntimeStaff,
      researchPf: researchLeft,
      labSites: campusBonuses(state).labSites,
      dataFlywheel: effects.dataFlywheel ?? 0,
    }),
    dataQuality: state.player.dataQuality,
    staff: dataRuntimeStaff,
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
  const spent = Math.max(0, state.player.cash - cash);
  const next = {
    ...state,
    player: { ...state.player, cash, data, dataQuality },
    alerts,
  };
  const settled = spent > 0 ? recordCashSpend(next, spent, "data") : next;
  return applyCorpusDrift(settled, data);
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
  /** Fresh teacher inference work required by generated training tokens. */
  syntheticGenerationPfDays?: number;
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
    (aggregateEffects(state.player.researchUnlocked, state.player.researchRanks).unlockCorpusSpecialists ??
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
  if (planIn?.syntheticTeacherEffortIds) {
    plan.syntheticTeacherEffortIds = {
      ...planIn.syntheticTeacherEffortIds,
    };
  }

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
    const pile = Math.max(0, stock.processed) * newFrac;
    const hqInPile = Math.max(0, stock.fromSynthHQ) * newFrac;
    const lqInPile = Math.max(0, stock.fromSynthLQ) * newFrac;
    const realInPile = Math.max(0, pile - hqInPile - lqInPile);
    const pileMass = realInPile + hqInPile + lqInPile;
    const pileTake = Math.min(need, pile);
    const realShare = pileMass > 1e-9 ? realInPile / pileMass : 1;
    const hqShare = pileMass > 1e-9 ? hqInPile / pileMass : 0;
    const lqShare = pileMass > 1e-9 ? lqInPile / pileMass : 0;
    let takeReal = pileTake * realShare;
    let takeHQ = pileTake * hqShare;
    let takeLQ = pileTake * lqShare;
    let remaining = need - pileTake;
    if (useHQ && remaining > 0.01) {
      const extraHq = Math.min(Math.max(0, hqInPile - takeHQ), remaining);
      takeHQ += extraHq;
      remaining -= extraHq;
    }
    if (useLQ && remaining > 0.01) {
      const extraLq = Math.min(Math.max(0, lqInPile - takeLQ), remaining);
      takeLQ += extraLq;
      remaining -= extraLq;
    }
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
    // V4-DELETE: leftover shortfall used to conjure virtual synth at train start.
    // V4 tokens come only from explicit generation jobs that write DatasetAssets.
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
  const synthLqShare = qualityW > 0 ? synthLqUnits / qualityW : 0;
  const synthShare = qualityW > 0 ? syntheticUnits / qualityW : 0;
  const qualityUsed = applySynthQualityTax(
    qualityW > 0 ? qualityAcc / qualityW : 40,
    synthShare,
    synthLqShare,
  );

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
  // V4-DELETE: train-start virtual synthetic fill and radar expansion.
  // Requested multiplier oversubscribes owned corpus with generated tokens
  // that never become DatasetAssets. V4 requires an explicit generation job.
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
    let syntheticGenerationPfDays = 0;
    let syntheticGenerationCashCost = 0;
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
      Math.min(7, planIn?.syntheticMultiplier ?? 7),
    );
    let remainingGenerationBudget = Math.max(
      0,
      attributedReal * requestedMultiplier - base.syntheticUnits,
    );
    const dataAttribution = ensureLabData(state);
    const totalProcessedNow = totalProcessed(dataAttribution);
    const watermark = Math.max(0, opts?.priorWatermarkMTok ?? 0);
    const newSinceTrain =
      opts?.mode === "continue"
        ? Math.max(0, totalProcessedNow - watermark)
        : totalProcessedNow;
    const newFrac =
      opts?.mode === "continue" && totalProcessedNow > 0
        ? Math.min(1, newSinceTrain / totalProcessedNow)
        : 1;
    for (const domain of DATA_DOMAINS) {
      let short = Math.min(
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
      const requestedEffortId =
        planIn?.syntheticTeacherEffortIds?.[domain];
      const plannedGeneration = syntheticTeacherGenerationEconomics({
        model: teacher,
        domain,
        effortId: requestedEffortId,
        acceptedMTok: short,
      });
      const teacherDomainCapability =
        plannedGeneration.effectiveDomainCapability;
      const frontierDomainCapability = Math.max(
        teacherDomainCapability,
        ...state.player.models.map((model) =>
          peakSyntheticTeacherDomainCapability(model, domain),
        ),
        ...state.rivals.flatMap((rival) =>
          rival.models.map((model) =>
            peakSyntheticTeacherDomainCapability(model, domain),
          ),
        ),
      );
      const domainStock = normalizeDomainStock(dataAttribution.stocks[domain]);
      const realAnchor = Math.max(
        0,
        Math.min(
          wanted * weights[domain],
          Math.max(
            0,
            domainStock.processed -
              domainStock.fromSynthHQ -
              domainStock.fromSynthLQ,
          ) * newFrac,
        ),
      );
      if (realAnchor <= 0.01) continue;
      const profile = syntheticTrainingProfile({
        realMTok: realAnchor,
        syntheticMTok: short,
        teacherCapability: teacherDomainCapability,
        frontierCapability: frontierDomainCapability,
        teacherReliability: teacher.quality.reliability,
        dataQuality: domainStock.quality,
        // Fresh synthetic expansion is real, billed inference work. The same
        // PF quote is frozen onto the run and joins its training target.
        computePfDays: plannedGeneration.computePfDays,
        seed: `${state.seed}:${state.day}:${domain}:${teacher.id}:${plannedGeneration.effortId}`,
      });
      short = Math.min(short, profile.effectiveSyntheticMTok);
      if (short <= 0.01) continue;
      const generation = syntheticTeacherGenerationEconomics({
        model: teacher,
        domain,
        effortId: plannedGeneration.effortId,
        acceptedMTok: short,
      });
      const provenance = {
        teacherModelIds: [teacher.id],
        generationDepth: 1,
        promptDiversity: Math.min(
          1,
          0.6 +
            teacher.quality.reliability / 350 +
            generation.effortQuality * 0.12,
        ),
        verifierStrength:
          domain === "code" || domain === "math" ? verifierBonus / 8 : 0,
        candidatesPerAccepted: verifierBonus > 0 ? 4 : 1,
        humanAnchorShare: 0.08,
      };
      const quality = Math.min(
        92,
        estimateSyntheticQuality({
          domain,
          teacherDomainCapability,
          provenance,
        }).quality,
      );
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
      syntheticGenerationPfDays += generation.computePfDays;
      syntheticGenerationCashCost += generation.cashCost;
      remainingGenerationBudget -= short;
      syntheticProvenance.push({
        domain,
        teacherModelId: teacher.id,
        teacherName: teacher.name,
        teacherEffortId: generation.effortId,
        teacherEffortName: generation.effortName,
        teacherThinkingTokenMult: generation.thinkingTokenMultiplier,
        teacherEffortQuality: generation.effortQuality,
        billedTokenMultiplier: generation.billedTokenMultiplier,
        teacherComputeIntensityMultiplier:
          generation.computeIntensityMultiplier,
        generatedTokenMTok: generation.generatedTokenMTok,
        generationComputePfDays: generation.computePfDays,
        generationCashCost: generation.cashCost,
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
    const synthHqUnits =
      (base.synthHqUnits ?? 0) +
      syntheticProvenance
        .filter((item) => item.qualityTier === "hq")
        .reduce((sum, item) => sum + item.volumeMTok, 0);
    const synthLqUnits =
      (base.synthLqUnits ?? 0) +
      syntheticProvenance
        .filter((item) => item.qualityTier === "lq")
        .reduce((sum, item) => sum + item.volumeMTok, 0);
    const syntheticUnits = base.syntheticUnits + syntheticAdded;
    const synthLqShare = actualVolume > 0 ? synthLqUnits / actualVolume : 0;
    return {
      ...base,
      plan: { ...base.plan, totalMTok: actualVolume, totalUnits: actualVolume },
      consumed,
      coverage: Math.min(
        30,
        actualVolume / Math.max(1, minDataMTokForParams(paramsB)),
      ),
      qualityUsed: applySynthQualityTax(
        qualityVolume > 0 ? qualityAcc / qualityVolume : base.qualityUsed,
        actualVolume > 0 ? syntheticUnits / actualVolume : 0,
        synthLqShare,
      ),
      syntheticUnits,
      synthHqUnits,
      synthLqUnits,
      synthLqShare,
      cashCost: base.cashCost + syntheticGenerationCashCost,
      syntheticGenerationPfDays:
        (base.syntheticGenerationPfDays ?? 0) +
        syntheticGenerationPfDays,
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
  const actualVolume = Object.values(base.consumed).reduce(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  return {
    ...base,
    domainQuality,
    qualityUsed: applySynthQualityTax(
      qualityW > 0 ? qualityAcc / qualityW : base.qualityUsed,
      actualVolume > 0 ? base.syntheticUnits / actualVolume : 0,
      base.synthLqShare ?? 0,
    ),
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
