/**
 * Data marketplace purchases and supplier negotiation lifecycle.
 *
 * Market lots settle immediately: curated/processed lots land in the
 * train-ready corpus, raw scrape lots enter the processing queue as owned
 * raw stock, and recurring supplier contracts deliver their daily amount.
 *
 * Supplier negotiations persist full terms and follow
 * offered → countered → accepted → active → expired, with countered →
 * rejected and active → cancelled exits. A lab may hold up to
 * DATA_MAX_CONTRACTS_PER_SUPPLIER concurrent contracts with the same
 * supplier; each additional concurrent contract pays a surcharge.
 */
import {
  DATA_DOMAINS,
  DATA_ECONOMY,
  createEmptyLabData,
  formatTokens,
  generateDataMarketOffers,
  normalizeDomainStock,
  normalizeWeights,
} from "../balance/data";
import { seededId } from "../rng";
import type {
  DataDomain,
  DataMarketOffer,
  DataSupplierContract,
  DataSupplierTerms,
  DatasetRights,
  LabData,
  ProcessJob,
  SimState,
} from "../types";
import {
  appendDatasetAsset,
  marketContaminationRisk,
  marketDatasetAsset,
  marketDatasetLineageId,
  mergeRecurringDatasetAsset,
} from "./dataAssets";
import { cloneLabData, defaultProcessingQualityTarget } from "./dataRuntime";
import { chargeExpense, recordCashSpend } from "./financeLedger";

/** Buying every filtered lot at once costs an urgency/liquidity premium. */
export const DATA_BULK_BUY_PREMIUM = 0.15;
/** Cancellation fee band: 10–30% of remaining value, floored at 3 days of spend. */
export const DATA_CANCEL_FEE_MAX_SHARE = 0.3;
export const DATA_CANCEL_FEE_MIN_SHARE = 0.1;
export const DATA_CANCEL_FEE_MIN_DAYS = 3;
/** Concurrent contracts allowed with the same supplier desk. */
export const DATA_MAX_CONTRACTS_PER_SUPPLIER = 3;
/** Surcharge per already-live contract with the same supplier (+25%, +50%, …). */
export const DATA_CONCURRENT_CONTRACT_PREMIUM = 0.25;
/** Suppliers answer standing offers after one day. */
export const DATA_NEGOTIATION_RESPONSE_DAYS = 1;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function ensureData(state: SimState): LabData {
  const raw = state.player.data;
  if (!raw) return createEmptyLabData();
  return cloneLabData(raw);
}

/** Mirrors ensureDataMarket in systems/data without an import cycle. */
function ensureMarket(state: SimState): SimState {
  if (state.dataMarket?.offers?.length) return state;
  const rivals = state.rivals.map((rival) => rival.name);
  return {
    ...state,
    dataMarket: {
      offers: generateDataMarketOffers(state.seed, state.day, rivals, 11),
      lastRefreshDay: state.day,
      nextRefreshDay: state.day + 5,
    },
  };
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
        id: `data-x-${state.day}-${message.slice(0, 14)}`,
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  };
}

// ─── Market lots: delivery state and pricing ───

/** How a purchase reaches the corpus: instantly train-ready, or raw (needs cleaning). */
export type DataDeliveryState = "processed" | "raw" | "recurring";

/** Raw scrape lots are owned but must pass the cleaning pipeline first. */
export function dataOfferDelivery(
  offer: Pick<DataMarketOffer, "source">,
): DataDeliveryState {
  return offer.source === "scrap" ? "raw" : "processed";
}

/** $ per MTok for a listing (cash prices one lot of lotMTok). */
export function dataOfferUnitPrice(
  offer: Pick<DataMarketOffer, "cash" | "lotMTok">,
): number {
  return offer.cash / Math.max(1, offer.lotMTok);
}

/** MTok purchasable right now: one lot, or the remainder if smaller. */
export function dataOfferPurchasableMTok(
  offer: Pick<DataMarketOffer, "lotMTok" | "mTokLeft">,
): number {
  return Math.min(offer.lotMTok, Math.max(0, offer.mTokLeft));
}

/** Price of the currently purchasable slice of a listing. */
export function dataOfferLotCost(
  offer: Pick<DataMarketOffer, "cash" | "lotMTok" | "mTokLeft">,
): number {
  const amount = dataOfferPurchasableMTok(offer);
  if (amount <= 0) return 0;
  return Math.max(
    50_000,
    Math.round(offer.cash * (amount / Math.max(1, offer.lotMTok))),
  );
}

/** License carried by a market lot (matches marketDatasetAsset rights mapping). */
export function dataOfferRights(
  offer: Pick<DataMarketOffer, "sellerKind" | "source">,
): Exclude<DatasetRights, "owned"> {
  const publicSource =
    offer.sellerKind === "opensource" || offer.source === "web";
  return publicSource
    ? "public"
    : offer.source === "licensed"
      ? "licensed"
      : "restricted";
}

// ─── Purchase preview ───

export interface DataPurchasePreview {
  offerIds: string[];
  lots: number;
  /** True when the preview carries the buy-all urgency premium. */
  bulk: boolean;
  volumeMTok: number;
  rawMTok: number;
  processedMTok: number;
  tokensByDomain: Partial<Record<DataDomain, number>>;
  /** Volume-weighted listed quality. */
  weightedQuality: number;
  /** Volume-weighted contamination risk 0–1. */
  contaminationRisk: number;
  licensedMTok: number;
  publicMTok: number;
  restrictedMTok: number;
  /** Sum of live lot costs before any premium. */
  baseCost: number;
  /** Extra charged for consuming all filtered liquidity at once. */
  bulkPremium: number;
  totalCost: number;
  ok: boolean;
  reason?: string;
}

function emptyPurchasePreview(bulk: boolean): DataPurchasePreview {
  return {
    offerIds: [],
    lots: 0,
    bulk,
    volumeMTok: 0,
    rawMTok: 0,
    processedMTok: 0,
    tokensByDomain: {},
    weightedQuality: 0,
    contaminationRisk: 0,
    licensedMTok: 0,
    publicMTok: 0,
    restrictedMTok: 0,
    baseCost: 0,
    bulkPremium: 0,
    totalCost: 0,
    ok: false,
  };
}

/** Preview one or more live listings before purchase (bulk applies the 15% premium). */
export function previewDataPurchase(
  state: SimState,
  offerIds: readonly string[],
  opts?: { bulk?: boolean },
): DataPurchasePreview {
  const s = ensureMarket(state);
  const bulk = opts?.bulk === true;
  const wanted = new Set(offerIds);
  const offers = (s.dataMarket?.offers ?? []).filter(
    (offer) => wanted.has(offer.id) && offer.mTokLeft > 0,
  );
  const preview = emptyPurchasePreview(bulk);
  if (offers.length === 0) {
    preview.reason = "No live listings selected";
    return preview;
  }

  let qualityWeight = 0;
  for (const offer of offers) {
    const amount = dataOfferPurchasableMTok(offer);
    if (amount <= 0) continue;
    const cost = dataOfferLotCost(offer);
    preview.offerIds.push(offer.id);
    preview.lots += 1;
    preview.baseCost += cost;
    preview.volumeMTok += amount;
    if (dataOfferDelivery(offer) === "raw") preview.rawMTok += amount;
    else preview.processedMTok += amount;
    preview.tokensByDomain[offer.domain] =
      (preview.tokensByDomain[offer.domain] ?? 0) + amount;
    preview.weightedQuality += offer.quality * amount;
    preview.contaminationRisk +=
      marketContaminationRisk(offer.quality, offer.qualityBand) * amount;
    qualityWeight += amount;
    const rights = dataOfferRights(offer);
    if (rights === "licensed") preview.licensedMTok += amount;
    else if (rights === "public") preview.publicMTok += amount;
    else preview.restrictedMTok += amount;
  }
  if (preview.lots === 0) {
    preview.reason = "Selected listings are sold out";
    return preview;
  }
  preview.weightedQuality /= Math.max(1e-9, qualityWeight);
  preview.contaminationRisk /= Math.max(1e-9, qualityWeight);
  preview.bulkPremium = bulk
    ? Math.round(preview.baseCost * DATA_BULK_BUY_PREMIUM)
    : 0;
  preview.totalCost = preview.baseCost + preview.bulkPremium;
  preview.ok = state.player.cash + 1e-9 >= preview.totalCost;
  if (!preview.ok) {
    preview.reason = `Need $${(preview.totalCost / 1e6).toFixed(2)}M cash`;
  }
  return preview;
}

// ─── Purchase settlement ───

/**
 * Deposit a purchased lot into the corpus (no cash handling here).
 * Processed lots land train-ready; raw lots enter the processing queue.
 * Returns whether the raw lot was queued for cleaning immediately.
 */
function depositPurchasedLot(
  state: SimState,
  offer: DataMarketOffer,
  amountMTok: number,
): { state: SimState; queuedRaw: boolean } {
  const data = ensureData(state);
  const stock = normalizeDomainStock(data.stocks[offer.domain]);
  const amount = Math.max(0, amountMTok);
  const market = state.dataMarket!;
  const offers = market.offers.map((candidate) =>
    candidate.id === offer.id
      ? { ...candidate, mTokLeft: Math.max(0, candidate.mTokLeft - amount) }
      : candidate,
  );

  let queuedRaw = false;
  if (dataOfferDelivery(offer) === "raw") {
    stock.raw += amount;
    stock.quality =
      stock.raw > 0
        ? (stock.quality * (stock.raw - amount) + offer.quality * amount) /
          stock.raw
        : offer.quality;
    data.lifetimeCollected += amount;
    // Raw lots are owned but must be processed — queue cleaning immediately
    // when the pipeline has capacity, otherwise they wait in raw stock.
    if (data.processQueue.length < DATA_ECONOMY.maxProcessJobs) {
      const job: ProcessJob = {
        id: seededId(
          "proc-buy",
          state.seed,
          state.day,
          offer.id,
          data.processQueue.length,
        ),
        domain: offer.domain,
        remaining: amount,
        total: amount,
        qualityTarget: defaultProcessingQualityTarget(
          state.player.dataQuality,
          state.player.staff,
        ),
        purchaseLot: {
          lineageId: marketDatasetLineageId({
            labId: state.playerLabId,
            domain: offer.domain,
            name: offer.name,
            sellerKind: offer.sellerKind,
            sellerName: offer.sellerName,
            qualityBand: offer.qualityBand,
            offerSource: offer.source,
          }),
          name: offer.name,
          sellerKind: offer.sellerKind,
          sellerName: offer.sellerName,
          qualityBand: offer.qualityBand,
          offerSource: offer.source,
          purchaseQuality: offer.quality,
        },
      };
      stock.raw = Math.max(0, stock.raw - amount);
      data.processQueue.push(job);
      queuedRaw = true;
    }
    data.stocks[offer.domain] = stock;
  } else {
    const nextProcessed = stock.processed + amount;
    stock.quality =
      nextProcessed > 0
        ? (stock.quality * stock.processed + offer.quality * amount) /
          nextProcessed
        : offer.quality;
    stock.processed = nextProcessed;
    stock.fromBought = (stock.fromBought ?? 0) + amount;
    data.lifetimeCollected += amount;
    data.lifetimeProcessed += amount;
    data.stocks[offer.domain] = stock;

    const assetId = marketDatasetLineageId({
      labId: state.playerLabId,
      domain: offer.domain,
      name: offer.name,
      sellerKind: offer.sellerKind,
      sellerName: offer.sellerName,
      qualityBand: offer.qualityBand,
      offerSource: offer.source,
    });
    const asset = marketDatasetAsset({
      id: assetId,
      name: offer.name,
      domain: offer.domain,
      quantityMTok: amount,
      quality: offer.quality,
      qualityBand: offer.qualityBand,
      sellerKind: offer.sellerKind,
      sellerName: offer.sellerName,
      offerSource: offer.source,
      day: state.day,
    });
    const withAsset = appendDatasetAsset(
      data,
      mergeRecurringDatasetAsset(
        data.assets.find((candidate) => candidate.id === assetId),
        asset,
      ),
    );
    data.assets = withAsset.assets;
  }

  return {
    state: {
      ...state,
      player: { ...state.player, data },
      dataMarket: { ...market, offers },
    },
    queuedRaw,
  };
}

/** Buy a selected amount from one live listing; settles immediately. */
export function buyDataLotAmount(
  state: SimState,
  offerId: string,
  amountMTok: number,
): SimState {
  let s = ensureMarket(state);
  const offer = s.dataMarket!.offers.find(
    (candidate) => candidate.id === offerId,
  );
  if (!offer) return alert(s, "warn", "That listing is no longer on the market.");
  if (offer.mTokLeft <= 0) {
    return alert(
      s,
      "warn",
      `${offer.name} is sold out — wait for the next market refresh.`,
    );
  }
  const amount = Math.min(Math.max(0, amountMTok), offer.mTokLeft);
  if (amount < 0.5) {
    return alert(s, "warn", "Pick at least 0.5 MTok to buy.");
  }
  const cost = Math.max(
    50_000,
    Math.round(offer.cash * (amount / Math.max(1, offer.lotMTok))),
  );
  if (s.player.cash + 1e-9 < cost) {
    return alert(
      s,
      "warn",
      `Need $${(cost / 1e6).toFixed(2)}M for ${formatTokens(amount)}.`,
    );
  }
  const delivery = dataOfferDelivery(offer);
  s = chargeExpense(s, cost, "data");
  const deposited = depositPurchasedLot(s, offer, amount);
  return alert(
    deposited.state,
    "info",
    delivery === "raw"
      ? `Bought ${formatTokens(amount)} ${offer.name} — raw scrape ${deposited.queuedRaw ? "queued for cleaning" : "held in raw stock (queue full)"}.`
      : `Bought ${formatTokens(amount)} ${offer.name} — processed and train-ready.`,
  );
}

/** Buy the entire live lot of one listing. */
export function buyEntireDataLot(state: SimState, offerId: string): SimState {
  const s = ensureMarket(state);
  const offer = s.dataMarket!.offers.find(
    (candidate) => candidate.id === offerId,
  );
  if (!offer) return alert(s, "warn", "That listing is no longer on the market.");
  return buyDataLotAmount(s, offerId, dataOfferPurchasableMTok(offer));
}

/**
 * Buy every currently filtered live lot. The 15% urgency premium on the sum of
 * live lot costs is charged exactly once alongside the base cost.
 */
export function buyAllFilteredDataLots(
  state: SimState,
  offerIds: readonly string[],
): SimState {
  let s = ensureMarket(state);
  const preview = previewDataPurchase(s, offerIds, { bulk: true });
  if (preview.lots === 0) {
    return alert(s, "warn", preview.reason ?? "Nothing to buy.");
  }
  if (!preview.ok) {
    return alert(
      s,
      "warn",
      preview.reason ??
        `Need $${(preview.totalCost / 1e6).toFixed(2)}M for this bulk buy.`,
    );
  }
  s = chargeExpense(s, preview.totalCost, "data");
  for (const offerId of preview.offerIds) {
    const offer = s.dataMarket!.offers.find(
      (candidate) => candidate.id === offerId,
    );
    if (!offer || offer.mTokLeft <= 0) continue;
    s = depositPurchasedLot(s, offer, dataOfferPurchasableMTok(offer)).state;
  }
  return alert(
    s,
    "info",
    `Bulk buy: ${preview.lots} lots · ${formatTokens(preview.volumeMTok)} · $${(preview.totalCost / 1e6).toFixed(2)}M (incl. $${(preview.bulkPremium / 1e6).toFixed(2)}M urgency premium).`,
  );
}

// ─── Supplier offers ───

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
    termDays: 180,
  }));
}

/** Baseline negotiable terms for a supplier desk (its current list terms). */
export function supplierTermsFromOffer(
  offer: DataSupplierOffer,
): DataSupplierTerms {
  return {
    dailyDeliveryMTok: offer.dailyDeliveryMTok,
    pricePerMTok: offer.dailyPrice / Math.max(1, offer.dailyDeliveryMTok),
    qualityFloor: offer.quality,
    termDays: offer.termDays,
    domainMix: { ...offer.domainMix },
  };
}

/** Live contracts with one supplier: open negotiations plus delivering terms. */
export function liveSupplierContractCount(
  contracts: readonly DataSupplierContract[],
  supplierId: string,
): number {
  return contracts.filter(
    (contract) =>
      contract.supplierId === supplierId &&
      (contract.status === "offered" ||
        contract.status === "countered" ||
        contract.status === "accepted" ||
        ((contract.status === "active" || contract.status === "extended") &&
          contract.daysRemaining > 0)),
  ).length;
}

/** Concurrency surcharge for the next contract with a supplier desk. */
export function dataSupplierContractPremium(
  state: SimState,
  supplierId: string,
): { count: number; multiplier: number; atCap: boolean } {
  const count = liveSupplierContractCount(
    state.player.dataSupplierContracts ?? [],
    supplierId,
  );
  return {
    count,
    multiplier: 1 + DATA_CONCURRENT_CONTRACT_PREMIUM * count,
    atCap: count >= DATA_MAX_CONTRACTS_PER_SUPPLIER,
  };
}

/** Daily price for a new contract once the concurrency surcharge is applied. */
function priceWithConcurrencyPremium(
  contracts: readonly DataSupplierContract[],
  supplierId: string,
  baseDailyPrice: number,
  excludeContractId?: string,
): number {
  const live = contracts.filter(
    (contract) => contract.id !== excludeContractId,
  );
  const count = liveSupplierContractCount(live, supplierId);
  return Math.round(
    baseDailyPrice * (1 + DATA_CONCURRENT_CONTRACT_PREMIUM * count),
  );
}

// ─── Seller economics ───

export interface SupplierOfferEvaluation {
  /** Total contract economics score; ≥62 accepts, ≥42 counters, else rejects. */
  score: number;
  verdict: "accept" | "counter" | "reject";
  priceValue: number;
  termValue: number;
  volumeValue: number;
  qualityGuaranteeCost: number;
  marketOpportunityCost: number;
  creditPenalty: number;
  /** Terms the seller would sign instead when verdict is counter. */
  counterTerms: DataSupplierTerms;
}

/**
 * Seller acceptance uses total contract economics, not only price:
 * offer value = price value + term value + volume value
 *             − quality guarantee cost − market opportunity cost − credit risk.
 */
export function evaluateSupplierOffer(input: {
  offer: DataSupplierOffer;
  terms: DataSupplierTerms;
  buyerCash: number;
}): SupplierOfferEvaluation {
  const { offer, terms } = input;
  const referencePrice = offer.dailyPrice / Math.max(1, offer.dailyDeliveryMTok);
  const priceRatio = terms.pricePerMTok / Math.max(1e-9, referencePrice);
  const volumeRatio =
    terms.dailyDeliveryMTok / Math.max(1, offer.dailyDeliveryMTok);
  const dailyPrice = terms.dailyDeliveryMTok * terms.pricePerMTok;

  const priceValue = clamp(priceRatio - 0.78, -0.45, 0.6) * 100;
  const termValue = clamp((terms.termDays - 30) / 150, 0, 1) * 12;
  const volumeValue = clamp(volumeRatio - 1, -0.5, 1) * 14;
  const qualityGuaranteeCost = Math.max(0, terms.qualityFloor - offer.quality) * 1.4;
  const marketOpportunityCost =
    Math.max(0, 1 - priceRatio) * clamp(terms.termDays / 90, 0.5, 3) * 16;
  const creditPenalty =
    input.buyerCash < dailyPrice * 3 ? 16 : input.buyerCash < dailyPrice * 7 ? 8 : 0;

  const score = Math.round(
    52 +
      priceValue +
      termValue +
      volumeValue -
      qualityGuaranteeCost -
      marketOpportunityCost -
      creditPenalty,
  );
  const verdict = score >= 62 ? "accept" : score >= 42 ? "counter" : "reject";

  const counterTerms: DataSupplierTerms = {
    dailyDeliveryMTok: Math.round(
      clamp(terms.dailyDeliveryMTok, 20, offer.dailyDeliveryMTok * 1.5),
    ),
    // Sellers never counter below 94% of the current reference rate.
    pricePerMTok:
      Math.round(Math.max(terms.pricePerMTok, referencePrice * 0.94) * 100) /
      100,
    qualityFloor: Math.round(
      clamp(terms.qualityFloor, offer.quality - 6, offer.quality + 5),
    ),
    termDays: Math.round(clamp(terms.termDays, 60, 360)),
    // Seller mix dominates; buyer preference bends it where supported.
    domainMix: normalizeWeights(
      Object.fromEntries(
        DATA_DOMAINS.map((domain) => [
          domain,
          (offer.domainMix[domain] ?? 0) * 0.7 +
            (terms.domainMix[domain] ?? 0) * 0.3,
        ]),
      ),
    ),
  };
  return {
    score,
    verdict,
    priceValue,
    termValue,
    volumeValue,
    qualityGuaranteeCost,
    marketOpportunityCost,
    creditPenalty,
    counterTerms,
  };
}

// ─── Negotiation actions ───

/** Put standing terms on the table; the supplier answers on the next day tick. */
export function proposeDataSupplierTerms(
  state: SimState,
  supplierId: string,
  terms: DataSupplierTerms,
): SimState {
  const offer = listDataSupplierOffers(state).find(
    (candidate) => candidate.id === supplierId,
  );
  if (!offer)
    return alert(state, "warn", "That supplier offer is no longer available.");
  const existing = state.player.dataSupplierContracts ?? [];
  if (liveSupplierContractCount(existing, offer.id) >= DATA_MAX_CONTRACTS_PER_SUPPLIER) {
    return alert(
      state,
      "warn",
      `${offer.name} is at the ${DATA_MAX_CONTRACTS_PER_SUPPLIER}-contract limit — let one lapse or cancel first.`,
    );
  }
  const dailyPrice = Math.round(terms.dailyDeliveryMTok * terms.pricePerMTok);
  if (state.player.cash + 1e-9 < dailyPrice) {
    return alert(
      state,
      "warn",
      `Need $${(dailyPrice / 1e6).toFixed(2)}M cash to back the first day.`,
    );
  }
  const contract: DataSupplierContract = {
    id: seededId("dsc", state.seed, state.day, offer.id),
    supplierId: offer.id,
    supplierName: offer.name,
    domainMix: { ...terms.domainMix },
    quality: offer.quality,
    dailyDeliveryMTok: terms.dailyDeliveryMTok,
    dailyPrice,
    termDays: terms.termDays,
    daysRemaining: terms.termDays,
    acceptedDay: state.day,
    status: "offered",
    proposedTerms: { ...terms, domainMix: { ...terms.domainMix } },
    qualityFloor: terms.qualityFloor,
    offeredDay: state.day,
    deliveredMTok: 0,
  };
  return alert(
    {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: [...existing, contract],
      },
    },
    "info",
    `Offer sent to ${offer.name}: $${Math.round(terms.pricePerMTok)}/MTok · ${formatTokens(terms.dailyDeliveryMTok)}/day · ${terms.termDays}d. Response expected tomorrow.`,
  );
}

/** Re-counter from a countered negotiation with fresh terms. */
export function counterDataSupplierOffer(
  state: SimState,
  contractId: string,
  terms: DataSupplierTerms,
): SimState {
  const contracts = state.player.dataSupplierContracts ?? [];
  const contract = contracts.find((candidate) => candidate.id === contractId);
  if (!contract || contract.status !== "countered") {
    return alert(state, "warn", "No counteroffer to answer.");
  }
  const dailyPrice = Math.round(terms.dailyDeliveryMTok * terms.pricePerMTok);
  if (state.player.cash + 1e-9 < dailyPrice) {
    return alert(
      state,
      "warn",
      `Need $${(dailyPrice / 1e6).toFixed(2)}M cash to back the first day.`,
    );
  }
  return alert(
    {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: contracts.map((candidate) =>
          candidate.id === contractId
            ? {
                ...candidate,
                status: "offered" as const,
                proposedTerms: { ...terms, domainMix: { ...terms.domainMix } },
                counterTerms: undefined,
                offeredDay: state.day,
                dailyDeliveryMTok: terms.dailyDeliveryMTok,
                dailyPrice,
                termDays: terms.termDays,
                daysRemaining: terms.termDays,
                qualityFloor: terms.qualityFloor,
                domainMix: { ...terms.domainMix },
              }
            : candidate,
        ),
      },
    },
    "info",
    `Re-counter sent to ${contract.supplierName}. Response expected tomorrow.`,
  );
}

/** Sign the seller's counter terms; the first delivery settles on the next tick. */
export function acceptDataSupplierCounter(
  state: SimState,
  contractId: string,
): SimState {
  const contracts = state.player.dataSupplierContracts ?? [];
  const contract = contracts.find((candidate) => candidate.id === contractId);
  if (!contract || contract.status !== "countered" || !contract.counterTerms) {
    return alert(state, "warn", "No counteroffer to accept.");
  }
  const terms = contract.counterTerms;
  const baseDailyPrice = Math.round(terms.dailyDeliveryMTok * terms.pricePerMTok);
  const dailyPrice = priceWithConcurrencyPremium(
    contracts,
    contract.supplierId,
    baseDailyPrice,
    contract.id,
  );
  if (state.player.cash + 1e-9 < dailyPrice) {
    return alert(
      state,
      "warn",
      `Need $${(dailyPrice / 1e6).toFixed(2)}M cash for the first day of ${contract.supplierName}.`,
    );
  }
  return alert(
    {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: contracts.map((candidate) =>
          candidate.id === contractId
            ? {
                ...candidate,
                status: "accepted" as const,
                domainMix: { ...terms.domainMix },
                dailyDeliveryMTok: terms.dailyDeliveryMTok,
                dailyPrice,
                termDays: terms.termDays,
                daysRemaining: terms.termDays,
                qualityFloor: terms.qualityFloor,
                acceptedDay: state.day,
                proposedTerms: { ...terms, domainMix: { ...terms.domainMix } },
                counterTerms: undefined,
              }
            : candidate,
        ),
      },
    },
    "info",
    `Signed ${contract.supplierName}: ${formatTokens(terms.dailyDeliveryMTok)}/day for ${terms.termDays}d at $${Math.round(terms.pricePerMTok)}/MTok (Q≥${Math.round(terms.qualityFloor)}).`,
  );
}

/** Walk away from a countered negotiation. */
export function rejectDataSupplierCounter(
  state: SimState,
  contractId: string,
): SimState {
  const contracts = state.player.dataSupplierContracts ?? [];
  const contract = contracts.find((candidate) => candidate.id === contractId);
  if (!contract || (contract.status !== "countered" && contract.status !== "offered")) {
    return alert(state, "warn", "No open negotiation to decline.");
  }
  return alert(
    {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: contracts.map((candidate) =>
          candidate.id === contractId
            ? { ...candidate, status: "rejected" as const }
            : candidate,
        ),
      },
    },
    "info",
    `Declined ${contract.supplierName}'s terms. The desk stays open for a fresh offer.`,
  );
}

/** Instant-sign convenience used by the simple "Accept offer" action. */
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
  if (liveSupplierContractCount(existing, offer.id) >= DATA_MAX_CONTRACTS_PER_SUPPLIER) {
    return alert(
      state,
      "warn",
      `${offer.name} is at the ${DATA_MAX_CONTRACTS_PER_SUPPLIER}-contract limit — let one lapse or cancel first.`,
    );
  }
  const baseDailyPrice =
    offer.dailyPrice * Math.max(0.8, Math.min(1, priceMultiplier));
  const dailyPrice = priceWithConcurrencyPremium(
    existing,
    offer.id,
    baseDailyPrice,
  );
  if (state.player.cash + 1e-9 < dailyPrice) {
    return alert(
      state,
      "warn",
      `Need $${(dailyPrice / 1e6).toFixed(2)}M cash for the first day of ${offer.name}.`,
    );
  }
  const terms = supplierTermsFromOffer(offer);
  const contract: DataSupplierContract = {
    id: `dsc-${state.seed}-${state.day}-${offer.id}-${existing.length}`,
    supplierId: offer.id,
    supplierName: offer.name,
    domainMix: offer.domainMix,
    quality: offer.quality,
    dailyDeliveryMTok: offer.dailyDeliveryMTok,
    dailyPrice,
    termDays: offer.termDays,
    daysRemaining: offer.termDays,
    acceptedDay: state.day,
    status: "accepted",
    proposedTerms: terms,
    qualityFloor: terms.qualityFloor,
    deliveredMTok: 0,
  };
  return alert(
    {
      ...state,
      player: {
        ...state.player,
        dataSupplierContracts: [...existing, contract],
      },
    },
    "info",
    `Signed ${offer.name}: ${offer.dailyDeliveryMTok} MTok/day for ${offer.termDays}d at $${dailyPrice.toLocaleString()}/day.`,
  );
}

// ─── Cancellation ───

export function dataContractRemainingValue(
  contract: Pick<DataSupplierContract, "dailyPrice" | "daysRemaining">,
): number {
  return contract.dailyPrice * Math.max(0, contract.daysRemaining);
}

/**
 * Cancellation fee = min(remaining × 30%, max(remaining × 10%, 3 days of spend)).
 * The fee is charged exactly once; cancellationFeeCharged records it.
 */
export function dataCancellationFee(
  contract: Pick<
    DataSupplierContract,
    "dailyPrice" | "daysRemaining" | "cancellationFeeCharged"
  >,
): number {
  if (contract.cancellationFeeCharged != null) return 0;
  const remaining = dataContractRemainingValue(contract);
  return Math.round(
    Math.min(
      remaining * DATA_CANCEL_FEE_MAX_SHARE,
      Math.max(
        remaining * DATA_CANCEL_FEE_MIN_SHARE,
        contract.dailyPrice * DATA_CANCEL_FEE_MIN_DAYS,
      ),
    ),
  );
}

/** Cancel a live contract and charge the one-time cancellation fee. */
export function cancelDataSupplierContract(
  state: SimState,
  contractId: string,
): SimState {
  const contracts = state.player.dataSupplierContracts ?? [];
  const contract = contracts.find((candidate) => candidate.id === contractId);
  if (!contract) return alert(state, "warn", "Contract not found.");
  if (
    contract.status !== "active" &&
    contract.status !== "extended" &&
    contract.status !== "accepted"
  ) {
    return alert(state, "warn", "Only a live contract can be cancelled.");
  }
  const fee = dataCancellationFee(contract);
  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      dataSupplierContracts: contracts.map((candidate) =>
        candidate.id === contractId
          ? {
              ...candidate,
              status: "cancelled" as const,
              daysRemaining: 0,
              cancellationFeeCharged:
                (candidate.cancellationFeeCharged ?? 0) + fee,
            }
          : candidate,
      ),
    },
  };
  if (fee > 0) next = chargeExpense(next, fee, "data");
  return alert(
    next,
    "info",
    fee > 0
      ? `Cancelled ${contract.supplierName} — one-time fee $${(fee / 1e6).toFixed(2)}M.`
      : `Cancelled ${contract.supplierName} — no fee due.`,
  );
}

// ─── Daily settlement ───

function isDelivering(contract: DataSupplierContract): boolean {
  return (
    contract.status === "active" ||
    contract.status === "extended" ||
    contract.status === "accepted"
  );
}

/**
 * Advance supplier negotiations one day and settle live contracts.
 * Standing offers get a seller response (accept/counter/reject); accepted
 * contracts settle day one and flip active; active/extended contracts charge
 * the daily price and deposit the daily mix split across the domain mix.
 */
export function tickDataSupplierContracts(state: SimState): SimState {
  const contracts = state.player.dataSupplierContracts ?? [];
  if (!contracts.length) return state;

  let cash = state.player.cash;
  let data = cloneLabData(state.player.data);
  let alerts = state.alerts;
  let nextContracts: DataSupplierContract[] = contracts.map((contract) => {
    if (contract.status !== "offered") return contract;
    const offeredDay = contract.offeredDay ?? contract.acceptedDay;
    if (state.day - offeredDay < DATA_NEGOTIATION_RESPONSE_DAYS) return contract;
    const offer = listDataSupplierOffers(state).find(
      (candidate) => candidate.id === contract.supplierId,
    );
    if (!offer || !contract.proposedTerms) {
      return { ...contract, status: "rejected" as const };
    }
    const evaluation = evaluateSupplierOffer({
      offer,
      terms: contract.proposedTerms,
      buyerCash: cash,
    });
    if (evaluation.verdict === "accept") {
      const terms = contract.proposedTerms;
      const dailyPrice = priceWithConcurrencyPremium(
        contracts,
        contract.supplierId,
        Math.round(terms.dailyDeliveryMTok * terms.pricePerMTok),
        contract.id,
      );
      alerts = [
        {
          id: `supplier-yes-${contract.id}-${state.day}`,
          day: state.day,
          severity: "info" as const,
          message: `${contract.supplierName} accepted your terms — ${formatTokens(terms.dailyDeliveryMTok)}/day for ${terms.termDays}d at $${Math.round(dailyPrice / Math.max(1, terms.dailyDeliveryMTok))}/MTok.`,
        },
        ...alerts,
      ].slice(0, 40);
      return {
        ...contract,
        status: "accepted" as const,
        acceptedDay: state.day,
        dailyPrice,
        counterTerms: undefined,
      };
    }
    if (evaluation.verdict === "counter") {
      alerts = [
        {
          id: `supplier-counter-${contract.id}-${state.day}`,
          day: state.day,
          severity: "info" as const,
          message: `${contract.supplierName} countered: $${Math.round(evaluation.counterTerms.pricePerMTok)}/MTok · Q≥${evaluation.counterTerms.qualityFloor} · ${evaluation.counterTerms.termDays}d (score ${evaluation.score}).`,
        },
        ...alerts,
      ].slice(0, 40);
      return {
        ...contract,
        status: "countered" as const,
        counterTerms: evaluation.counterTerms,
      };
    }
    alerts = [
      {
        id: `supplier-no-${contract.id}-${state.day}`,
        day: state.day,
        severity: "warn" as const,
        message: `${contract.supplierName} rejected the offer — the economics were too thin (score ${evaluation.score}).`,
      },
      ...alerts,
    ].slice(0, 40);
    return { ...contract, status: "rejected" as const };
  });

  const settled: DataSupplierContract[] = [];
  for (const contract of nextContracts) {
    if (!isDelivering(contract)) {
      settled.push(contract);
      continue;
    }
    if (cash + 1e-9 < contract.dailyPrice) {
      settled.push({ ...contract, status: "cancelled" as const });
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
    const deliveredQuality = Math.max(
      contract.quality,
      contract.qualityFloor ?? 0,
    );
    const mixEntries = Object.entries(contract.domainMix).filter(
      ([, weight]) => (weight ?? 0) > 0,
    ) as Array<[DataDomain, number]>;
    const weightSum =
      mixEntries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0) || 1;
    for (const [domain, weight] of mixEntries) {
      const add =
        (contract.dailyDeliveryMTok * Math.max(0, weight)) / weightSum;
      if (add <= 0) continue;
      const stock = data.stocks[domain];
      data.stocks[domain] = {
        ...stock,
        raw: stock.raw + add,
        quality:
          (stock.quality * stock.raw + deliveredQuality * add) /
          Math.max(1e-9, stock.raw + add),
      };
    }
    data.lifetimeCollected =
      (data.lifetimeCollected ?? 0) + contract.dailyDeliveryMTok;

    const daysRemaining = Math.max(
      0,
      (contract.daysRemaining ?? contract.termDays) - 1,
    );
    settled.push({
      ...contract,
      daysRemaining,
      deliveredMTok:
        (contract.deliveredMTok ?? 0) + contract.dailyDeliveryMTok,
      status:
        daysRemaining <= 0
          ? "expired"
          : contract.status === "accepted"
            ? "active"
            : contract.status,
    });
  }

  const spent = Math.max(0, state.player.cash - cash);
  const next = {
    ...state,
    player: {
      ...state.player,
      cash,
      data,
      dataSupplierContracts: settled,
    },
    alerts,
  };
  return spent > 0 ? recordCashSpend(next, spent, "data") : next;
}
