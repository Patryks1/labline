import { useMemo, useRef, useState, type TouchEvent } from "react";
import { Check, Trash } from "@phosphor-icons/react";
import { useGameStore } from "../../../store/gameStore";
import { ResearchUnlockLink } from "../ui/ResearchUnlockLink";
import {
  DATA_BULK_BUY_PREMIUM,
  DATA_CONCURRENT_CONTRACT_PREMIUM,
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_MAX_CONTRACTS_PER_SUPPLIER,
  DATA_QUALITY_LABELS,
  DATA_SELLER_LABELS,
  dataCancellationFee,
  dataOfferPurchasableMTok,
  dataOfferRights,
  dataOfferUnitPrice,
  ensureDataMarket,
  ensureLabData,
  eligibleSynthTeachersForDomain,
  estimateAllDataPrunes,
  estimateDataPruneAudit,
  estimateDataPrune,
  estimateSynthBudget,
  formatMix,
  formatTokens,
  listDataSupplierOffers,
  previewDataPurchase,
  supplierTermsFromOffer,
  totalProcessed,
  totalRaw,
  totalSources,
  type DataPruneEstimate,
  type SynthBudgetEstimate,
} from "../../../sim/systems/data";
import {
  dataHygieneSnapshot,
  processingCostPerInspectedMTok,
  processingEffortPerInspectedMTok,
} from "../../../sim/systems/dataRuntime";
import { money, mw, num, pct } from "../format";
import type {
  DataDomain,
  DataMarketOffer,
  DataQualityBand,
  DataSellerKind,
  DatasetRights,
  DataSupplierTerms,
  SimState,
} from "../../../sim/types";
import {
  BlockerList,
  CardGrid,
  GameCard,
  LiveDot,
  MeterBar,
  SegmentedTabs,
  StatRow,
  type Blocker,
} from "../ui/kit";
import {
  EmptyState,
  HudButton,
  HudInput,
  HudRange,
  HudSelect,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import {
  NegotiationHeader,
  NegotiationMessage,
  NegotiationMetric,
} from "../ui/NegotiationRoom";
import {
  parseSyntheticTeacherSelectValue,
  syntheticTeacherSelectOptions,
  syntheticTeacherSelectValue,
} from "../ui/trainingSyntheticTeacherOptions";

type CorpusSourceKey = "web" | "bought" | "user" | "synth";
type DataTab = "stocks" | "sources" | "market" | "synth";

const DATA_TAB_ORDER: readonly DataTab[] = [
  "stocks",
  "sources",
  "market",
  "synth",
];

/**
 * Resolve a deliberate horizontal swipe without stealing ordinary vertical
 * scrolling. Keeping the threshold logic pure also makes the gesture contract
 * easy to verify without a browser-sized test harness.
 */
function dataTabAfterSwipe(
  current: DataTab,
  deltaX: number,
  deltaY: number,
): DataTab {
  if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) {
    return current;
  }
  const index = DATA_TAB_ORDER.indexOf(current);
  const nextIndex = deltaX > 0 ? index + 1 : index - 1;
  return (
    DATA_TAB_ORDER[
      Math.max(0, Math.min(DATA_TAB_ORDER.length - 1, nextIndex))
    ] ?? current
  );
}

function blocksPanelSwipe(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, select, textarea, summary, label, [data-swipe-ignore='true']",
      ),
    )
  );
}

const CORPUS_SOURCE_META: Record<
  CorpusSourceKey,
  { label: string; color: string; signal: string; risk: string }
> = {
  web: {
    label: "Web",
    color: "var(--color-muted)",
    signal: "Broad coverage",
    risk: "Noisy and repetitive",
  },
  bought: {
    label: "Bought",
    color: "var(--color-amber)",
    signal: "Clearer rights",
    risk: "Expensive and finite",
  },
  user: {
    label: "User",
    color: "var(--color-mint)",
    signal: "Fresh product signal",
    risk: "Trust-sensitive",
  },
  synth: {
    label: "Synth",
    color: "var(--color-research)",
    signal: "Scales continuously",
    risk: "Drift risk if the teacher ages",
  },
};

type MarketSourceFilter = "all" | "web" | "scrap" | "licensed";
type MarketLicenseFilter = "all" | Exclude<DatasetRights, "owned">;
type MarketPriceFilter = "all" | "low" | "mid" | "high";
type MarketSort = "priceAsc" | "priceDesc" | "quality" | "size" | "days";

const MARKET_SOURCE_LABELS: Record<
  Exclude<MarketSourceFilter, "all">,
  string
> = {
  web: "Web crawl",
  scrap: "Raw scrape",
  licensed: "Licensed pack",
};

const MARKET_LICENSE_LABELS: Record<
  Exclude<MarketLicenseFilter, "all">,
  string
> = {
  public: "Public",
  licensed: "Licensed",
  restricted: "Restricted",
};

const SELLER_KINDS = Object.keys(DATA_SELLER_LABELS) as DataSellerKind[];
const QUALITY_BANDS = Object.keys(DATA_QUALITY_LABELS) as DataQualityBand[];

/** Keep filter cards wide enough for their selected values in the drawer. */
export const DATA_MARKET_FILTER_GRID_CLASS =
  "grid-cols-1 min-[520px]:grid-cols-2 xl:grid-cols-3 [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:grid-cols-3 [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:max-h-[44vh] [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:overflow-y-auto";
export const DATA_MARKET_FILTER_SELECT_CLASS =
  "min-h-11 w-full min-w-0 text-left text-[0.75rem] font-medium";

export const DATA_PANEL_SWIPE_CLASS =
  "data-panel-swipe touch-pan-y [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:space-y-2";
export const DATA_COMPACT_SECONDARY_CLASS =
  "sm:hidden [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:block";
export const DATA_WIDE_SECONDARY_CLASS =
  "hidden sm:block [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:hidden";

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <label className="grid min-h-11 min-w-0 gap-1 rounded-md border border-line/70 bg-void/55 px-2 py-2">
      <span className="min-w-0 truncate font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted">
        {label}
      </span>
      <HudSelect
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={DATA_MARKET_FILTER_SELECT_CLASS}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-void">
            {option.label}
          </option>
        ))}
      </HudSelect>
    </label>
  );
}

export function SynthTeacherRoutingTable({
  state,
  estimate,
  picks,
  effortPicks,
  onPick,
}: {
  state: SimState;
  estimate: SynthBudgetEstimate;
  picks: Record<DataDomain, string>;
  effortPicks: Record<DataDomain, string>;
  onPick: (domain: DataDomain, modelId: string, effortId: string) => void;
}) {
  return (
    <details
      className="group mt-3 overflow-hidden rounded-md border border-line/70 bg-void/45"
      aria-label="Synthetic corpus teacher routing"
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-col justify-center gap-2 px-2.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
            Corpus routing · {estimate.domains.length} domains
          </div>
          <p className="mt-0.5 hidden text-[0.6875rem] text-dim sm:block [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:hidden">
            Yield costs research PF by teacher size and thinking intensity. Weak
            teachers mint mostly low-quality data; trained reasoning can raise
            quality but bills more tokens and reduces fixed-budget yield.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 font-mono text-[0.625rem] tabular-nums text-muted sm:text-right">
          <div>{pct(estimate.usefulChance, 0)} useful</div>
          <div>{pct(estimate.hqChance, 0)} high-Q</div>
          <span className="text-research group-open:hidden">Open</span>
          <span className="hidden text-research group-open:inline">Close</span>
        </div>
      </summary>

      <div className="divide-y divide-line/45 border-t border-line/60">
        {estimate.domains.map((route) => {
          const options = syntheticTeacherSelectOptions(
            eligibleSynthTeachersForDomain(state, route.domain),
            route.domain,
          );
          const assigned = Boolean(picks[route.domain]);
          const selectedOption = assigned
            ? (options.find(
                (option) =>
                  option.teacherId === picks[route.domain] &&
                  option.effortId === (effortPicks[route.domain] || "instant"),
              ) ??
              options.find(
                (option) =>
                  option.teacherId === picks[route.domain] &&
                  option.effortId === "instant",
              ))
            : undefined;
          const yieldDelta = route.yieldDeltaMTokPerDay;
          const costDelta = route.costDeltaPerAcceptedMTok;
          const powerDelta = route.powerDeltaKwhPerAcceptedMTok;
          return (
            <div
              key={route.domain}
              className="grid gap-2 px-2.5 py-2 min-[520px]:grid-cols-[6.25rem_minmax(0,1fr)] min-[520px]:items-center xl:grid-cols-[6.25rem_minmax(11rem,1fr)_minmax(15rem,1.2fr)]"
            >
              <div className="min-w-0">
                <div className="text-[0.75rem] font-semibold text-bone">
                  {DATA_DOMAIN_META[route.domain].label}
                </div>
                <div className="font-mono text-[0.625rem] tabular-nums text-muted">
                  Fit {Math.round(route.overallFit * 100)} · domain{" "}
                  {Math.round(route.domainCapability)}
                </div>
              </div>

              <label className="min-w-0">
                <span className="sr-only">
                  Teacher for {DATA_DOMAIN_META[route.domain].label} corpus
                </span>
                <HudSelect
                  aria-label={`Teacher for ${DATA_DOMAIN_META[route.domain].label} corpus`}
                  value={
                    selectedOption
                      ? syntheticTeacherSelectValue(
                          selectedOption.teacherId,
                          selectedOption.effortId,
                        )
                      : ""
                  }
                  onChange={(event) => {
                    const parsed = parseSyntheticTeacherSelectValue(
                      event.target.value,
                    );
                    onPick(
                      route.domain,
                      parsed?.teacherId ?? "",
                      parsed?.effortId ?? "",
                    );
                  }}
                  className="min-h-11 w-full text-[0.6875rem] font-medium focus:border-research/70"
                >
                  <option value="" className="bg-void">
                    Auto · {route.autoTeacher?.name ?? "No eligible model"} ·
                    Instant
                  </option>
                  {options.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      className="bg-void"
                    >
                      {option.label}
                    </option>
                  ))}
                </HudSelect>
                {route.validation ? (
                  <span className="mt-1 block text-[0.625rem] text-warning">
                    {route.validation}
                  </span>
                ) : null}
              </label>

              <div className="min-w-0 font-mono text-[0.625rem] tabular-nums min-[520px]:col-span-2 xl:col-span-1">
                <div className="grid grid-cols-2 gap-2 text-muted min-[520px]:grid-cols-4">
                  <span>
                    <span className="block text-dim">Yield</span>
                    <strong className="font-medium text-bone">
                      {formatTokens(route.acceptedMTokPerDay)}/d
                    </strong>
                  </span>
                  <span>
                    <span className="block text-dim">Cost</span>
                    <strong className="font-medium text-bone">
                      {money(route.costPerAcceptedMTok)}/MTok
                    </strong>
                  </span>
                  <span>
                    <span className="block text-dim">PF</span>
                    <strong className="font-medium text-bone">
                      {num(route.pfPerAcceptedMTok, 2)}/MTok
                    </strong>
                  </span>
                  <span>
                    <span className="block text-dim">Power</span>
                    <strong className="font-medium text-bone">
                      {num(route.kwhPerAcceptedMTok, 1)} kWh/MTok
                    </strong>
                  </span>
                </div>
                <div
                  className={`mt-1 truncate ${assigned ? "text-research" : "text-dim"}`}
                  title={
                    assigned
                      ? `Versus Auto: ${yieldDelta >= 0 ? "+" : ""}${formatTokens(yieldDelta)}/d, ${costDelta >= 0 ? "+" : ""}${money(costDelta)}/MTok, ${powerDelta >= 0 ? "+" : ""}${num(powerDelta, 1)} kWh/MTok`
                      : "Auto-route baseline"
                  }
                >
                  {assigned
                    ? `${route.effortName} · ${route.billedTokenMultiplier.toFixed(1)}× billed · ${route.computeIntensityMultiplier.toFixed(2)}× PF intensity · vs Auto yield ${yieldDelta >= 0 ? "+" : ""}${formatTokens(yieldDelta)}/d · cost ${costDelta >= 0 ? "+" : ""}${money(costDelta)}`
                    : `Auto · ${route.teacher?.name ?? "no eligible teacher"} · Instant`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

export function DataPanel({
  initialTab = "stocks",
}: {
  /** Test/deep-link entry point; normal navigation still opens Stocks. */
  initialTab?: DataTab;
} = {}) {
  const state = useGameStore((s) => s.state);
  const setCollectionRate = useGameStore((s) => s.setCollectionRate);
  const setAutoProcess = useGameStore((s) => s.setAutoProcess);
  const enqueueProcess = useGameStore((s) => s.enqueueProcess);
  const enqueueProcessAll = useGameStore((s) => s.enqueueProcessAll);
  const enqueueDataPrune = useGameStore((s) => s.enqueueDataPrune);
  const enqueueAllDataPrunes = useGameStore((s) => s.enqueueAllDataPrunes);
  const purchaseDataPruneAudit = useGameStore((s) => s.purchaseDataPruneAudit);
  const acceptDataSupplierOffer = useGameStore(
    (s) => s.acceptDataSupplierOffer,
  );
  const proposeDataSupplierTerms = useGameStore(
    (s) => s.proposeDataSupplierTerms,
  );
  const counterDataSupplierOffer = useGameStore(
    (s) => s.counterDataSupplierOffer,
  );
  const acceptDataSupplierCounter = useGameStore(
    (s) => s.acceptDataSupplierCounter,
  );
  const rejectDataSupplierCounter = useGameStore(
    (s) => s.rejectDataSupplierCounter,
  );
  const cancelDataSupplierContract = useGameStore(
    (s) => s.cancelDataSupplierContract,
  );
  const buyDataLotAmount = useGameStore((s) => s.buyDataLotAmount);
  const buyAllFilteredDataLots = useGameStore((s) => s.buyAllFilteredDataLots);
  const startSynthBudget = useGameStore((s) => s.startSynthBudget);
  const cancelSynthGen = useGameStore((s) => s.cancelSynthGen);

  const data = ensureLabData(state);
  const initialAutoSynthJob = data.synthQueue.find((job) => job.autoPortfolio);
  const raw = totalRaw(data);
  const proc = totalProcessed(data);
  const sources = totalSources(data);
  const sourceTotal =
    sources.web + sources.user + sources.bought + sources.synth;
  const srcSum = sourceTotal || 1;
  const playerDataOrders = state.worldMarkets.orders.filter(
    (order) => order.labId === state.playerLabId && order.kind === "data",
  );
  const dataReserved = playerDataOrders.reduce(
    (sum, order) => sum + order.cashReserved,
    0,
  );
  const latestDataFills = state.worldMarkets.fills.filter(
    (fill) => fill.labId === state.playerLabId && fill.kind === "data",
  );

  const [tab, setTab] = useState<DataTab>(initialTab);
  const panelSwipeStart = useRef<{ x: number; y: number } | null>(null);
  const [genShare, setGenShare] = useState(
    initialAutoSynthJob?.researchShare ?? 0.25,
  );
  const [synthTeacherPickByDomain, setSynthTeacherPickByDomain] = useState<
    Record<DataDomain, string>
  >(
    () =>
      Object.fromEntries(
        DATA_DOMAINS.map((domain) => [
          domain,
          initialAutoSynthJob?.teacherModelIds?.[domain] ?? "",
        ]),
      ) as Record<DataDomain, string>,
  );
  const [synthTeacherEffortPickByDomain, setSynthTeacherEffortPickByDomain] =
    useState<Record<DataDomain, string>>(
      () =>
        Object.fromEntries(
          DATA_DOMAINS.map((domain) => [
            domain,
            initialAutoSynthJob?.teacherEffortIds?.[domain] ?? "",
          ]),
        ) as Record<DataDomain, string>,
    );
  const [selectedSource, setSelectedSource] = useState<CorpusSourceKey>("user");
  // Per-desk delivery-mix picks. Missing entry = the desk's standard mix;
  // a present entry is the player's explicit data-type selection.
  const [domainPickByOffer, setDomainPickByOffer] = useState<
    Record<string, DataDomain[]>
  >({});
  const [supplierOfferPercent, setSupplierOfferPercent] = useState(95);
  const [filterSource, setFilterSource] = useState<MarketSourceFilter>("all");
  const [filterDomain, setFilterDomain] = useState<"all" | DataDomain>("all");
  const [filterQuality, setFilterQuality] = useState<"all" | DataQualityBand>(
    "all",
  );
  const [filterLicense, setFilterLicense] =
    useState<MarketLicenseFilter>("all");
  const [filterSeller, setFilterSeller] = useState<"all" | DataSellerKind>(
    "all",
  );
  const [filterPrice, setFilterPrice] = useState<MarketPriceFilter>("all");
  const [sortBy, setSortBy] = useState<MarketSort>("priceAsc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const supplierOffers = useMemo(() => listDataSupplierOffers(state), [state]);
  const supplierContracts = state.player.dataSupplierContracts ?? [];

  const synthUnlocked = state.player.researchUnlocked.includes("data_synth");
  const market = ensureDataMarket(state).dataMarket!;
  const pruneEstimates = useMemo(
    () =>
      new Map(
        DATA_DOMAINS.map((domain) => [
          domain,
          estimateDataPrune(state, domain),
        ]),
      ),
    [state],
  );
  const pruneAllEstimate = useMemo(() => estimateAllDataPrunes(state), [state]);
  const pruneAuditEstimate = useMemo(
    () => estimateDataPruneAudit(state),
    [state],
  );
  const synthTeacherIds = useMemo(
    () =>
      Object.fromEntries(
        DATA_DOMAINS.flatMap((domain) => {
          const modelId = synthTeacherPickByDomain[domain];
          return modelId ? [[domain, modelId]] : [];
        }),
      ) as Partial<Record<DataDomain, string>>,
    [synthTeacherPickByDomain],
  );
  const synthTeacherEffortIds = useMemo(
    () =>
      Object.fromEntries(
        DATA_DOMAINS.flatMap((domain) => {
          const modelId = synthTeacherPickByDomain[domain];
          const effortId = synthTeacherEffortPickByDomain[domain];
          return modelId && effortId ? [[domain, effortId]] : [];
        }),
      ) as Partial<Record<DataDomain, string>>,
    [synthTeacherEffortPickByDomain, synthTeacherPickByDomain],
  );
  const synthEstimate = useMemo(
    () =>
      estimateSynthBudget(
        state,
        genShare,
        synthTeacherIds,
        synthTeacherEffortIds,
      ),
    [state, genShare, synthTeacherIds, synthTeacherEffortIds],
  );
  const autoSynthJob = initialAutoSynthJob;
  const liveSynthEstimate = useMemo(
    () =>
      autoSynthJob
        ? estimateSynthBudget(
            state,
            autoSynthJob.researchShare,
            autoSynthJob.teacherModelIds,
            autoSynthJob.teacherEffortIds,
          )
        : synthEstimate,
    [state, autoSynthJob, synthEstimate],
  );

  const sourceMix = (["web", "bought", "user", "synth"] as const).map(
    (key) => ({
      key,
      value: sources[key],
      share: sources[key] / srcSum,
      ...CORPUS_SOURCE_META[key],
    }),
  );
  const selectedSourceInfo = sourceMix.find(
    (source) => source.key === selectedSource,
  )!;
  const sourceDomainRows = DATA_DOMAINS.map((domain) => {
    const stock = data.stocks[domain];
    const volume =
      selectedSource === "web"
        ? stock.fromWeb
        : selectedSource === "bought"
          ? stock.fromBought
          : selectedSource === "user"
            ? stock.fromUser
            : stock.fromSynth;
    return { domain, volume: volume ?? 0, quality: stock.quality };
  }).sort((left, right) => right.volume - left.volume);

  const sourceQualityNumerator = sourceDomainRows.reduce(
    (sum, row) => sum + row.volume * row.quality,
    0,
  );
  const sourceQuality =
    selectedSourceInfo.value > 0
      ? sourceQualityNumerator / selectedSourceInfo.value
      : 0;
  const sourceQualityBand =
    sourceQuality >= 75
      ? "High"
      : sourceQuality >= 55
        ? "Medium"
        : sourceQuality > 0
          ? "Low"
          : "No stock";

  const hygiene = dataHygieneSnapshot(data);
  const hygieneTone =
    hygiene.pressure >= 0.6
      ? "danger"
      : hygiene.pressure >= 0.25
        ? "warning"
        : "positive";
  const hygieneLabel =
    hygiene.pressure >= 0.6
      ? "Critical exposure"
      : hygiene.pressure >= 0.25
        ? "Needs hygiene"
        : "Contained";

  const readyShare = proc / Math.max(1, raw + proc);
  const licensedShare =
    sourceTotal > 0 ? (sources.bought + sources.user) / sourceTotal : 0;
  const avgQuality =
    DATA_DOMAINS.reduce((sum, domain) => {
      const stock = data.stocks[domain];
      return sum + (stock.raw + stock.processed) * stock.quality;
    }, 0) / Math.max(1, raw + proc);
  const domainsCovered = DATA_DOMAINS.filter((domain) => {
    const stock = data.stocks[domain];
    return stock.raw + stock.processed > 0.5;
  }).length;
  const collectionRisk =
    data.collectionRate >= 0.8
      ? "High trust risk"
      : data.collectionRate >= 0.55
        ? "Guarded"
        : "Low risk";

  const liveOffers = market.offers.filter((offer) => offer.mTokLeft > 0);
  const unitPrices = liveOffers.map((offer) => dataOfferUnitPrice(offer));
  const priceLowCut =
    unitPrices.length > 0
      ? [...unitPrices].sort((a, b) => a - b)[
          Math.max(0, Math.floor(unitPrices.length / 3) - 1)
        ]!
      : 0;
  const priceHighCut =
    unitPrices.length > 0
      ? [...unitPrices].sort((a, b) => a - b)[
          Math.min(
            unitPrices.length - 1,
            Math.ceil((unitPrices.length * 2) / 3),
          )
        ]!
      : 0;

  const filteredOffers = useMemo(() => {
    const rows = market.offers.filter((offer) => {
      if (filterSource !== "all" && offer.source !== filterSource) return false;
      if (filterDomain !== "all" && offer.domain !== filterDomain) return false;
      if (filterQuality !== "all" && offer.qualityBand !== filterQuality) {
        return false;
      }
      if (filterLicense !== "all" && dataOfferRights(offer) !== filterLicense) {
        return false;
      }
      if (filterSeller !== "all" && offer.sellerKind !== filterSeller) {
        return false;
      }
      if (filterPrice !== "all" && offer.mTokLeft > 0) {
        const unit = dataOfferUnitPrice(offer);
        if (filterPrice === "low" && unit > priceLowCut) return false;
        if (filterPrice === "high" && unit < priceHighCut) return false;
        if (
          filterPrice === "mid" &&
          (unit <= priceLowCut || unit >= priceHighCut)
        ) {
          return false;
        }
      }
      return true;
    });
    const sorted = [...rows];
    sorted.sort((left, right) => {
      if (sortBy === "priceAsc") {
        return dataOfferUnitPrice(left) - dataOfferUnitPrice(right);
      }
      if (sortBy === "priceDesc") {
        return dataOfferUnitPrice(right) - dataOfferUnitPrice(left);
      }
      if (sortBy === "quality") return right.quality - left.quality;
      if (sortBy === "size") return right.mTokLeft - left.mTokLeft;
      return left.daysLeft - right.daysLeft;
    });
    return sorted;
  }, [
    market.offers,
    filterSource,
    filterDomain,
    filterQuality,
    filterLicense,
    filterSeller,
    filterPrice,
    sortBy,
    priceLowCut,
    priceHighCut,
  ]);

  const filteredLiveIds = filteredOffers
    .filter((offer) => offer.mTokLeft > 0)
    .map((offer) => offer.id);
  const filteredLiveKey = filteredLiveIds.join("|");
  const bulkPreview = useMemo(
    () =>
      previewDataPurchase(state, filteredLiveKey.split("|").filter(Boolean), {
        bulk: true,
      }),
    [state, filteredLiveKey],
  );

  const activeFilterCount = [
    filterSource !== "all",
    filterDomain !== "all",
    filterQuality !== "all",
    filterLicense !== "all",
    filterSeller !== "all",
    filterPrice !== "all",
  ].filter(Boolean).length;
  const activeFilterChips = [
    filterSource !== "all"
      ? {
          id: "source",
          label: MARKET_SOURCE_LABELS[filterSource],
          clear: () => setFilterSource("all"),
        }
      : null,
    filterDomain !== "all"
      ? {
          id: "domain",
          label: DATA_DOMAIN_META[filterDomain].label,
          clear: () => setFilterDomain("all"),
        }
      : null,
    filterQuality !== "all"
      ? {
          id: "quality",
          label: DATA_QUALITY_LABELS[filterQuality],
          clear: () => setFilterQuality("all"),
        }
      : null,
    filterLicense !== "all"
      ? {
          id: "license",
          label: MARKET_LICENSE_LABELS[filterLicense],
          clear: () => setFilterLicense("all"),
        }
      : null,
    filterSeller !== "all"
      ? {
          id: "seller",
          label: DATA_SELLER_LABELS[filterSeller],
          clear: () => setFilterSeller("all"),
        }
      : null,
    filterPrice !== "all"
      ? {
          id: "price",
          label:
            filterPrice === "low"
              ? "Lower third"
              : filterPrice === "mid"
                ? "Mid third"
                : "Upper third",
          clear: () => setFilterPrice("all"),
        }
      : null,
  ].filter(Boolean) as Array<{
    id: string;
    label: string;
    clear: () => void;
  }>;

  const pruneAllBlockers: Blocker[] = !pruneAllEstimate.ok
    ? [
        {
          text: pruneAllEstimate.reason ?? "Cannot prune all domains",
          tone: "warning",
        },
      ]
    : [];
  const auditBlockers: Blocker[] = !pruneAuditEstimate.ok
    ? [
        {
          text: pruneAuditEstimate.reason ?? "Cannot audit corpus",
          tone: "warning",
        },
      ]
    : [];
  const synthBlockers: Blocker[] = [];
  if (!synthUnlocked)
    synthBlockers.push({
      text: "Unlock Synthetic Generators research",
      tone: "warning",
    });
  if (!synthEstimate.model)
    synthBlockers.push({
      text: "Need a usable teacher model",
      tone: "warning",
    });

  const beginPanelSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    panelSwipeStart.current =
      event.touches.length === 1 && touch && !blocksPanelSwipe(event.target)
        ? { x: touch.clientX, y: touch.clientY }
        : null;
  };

  const finishPanelSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const start = panelSwipeStart.current;
    panelSwipeStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch || blocksPanelSwipe(event.target)) return;
    setTab((current) =>
      dataTabAfterSwipe(
        current,
        start.x - touch.clientX,
        start.y - touch.clientY,
      ),
    );
  };

  return (
    <PanelScaffold
      eyebrow="Assets · Rights · Synth"
      title="Data"
      description="Corpus stocks, acquisition, and synthetic generation."
      mobileDescription="Corpus, buying & synthetic data."
      actions={
        <StatusChip tone={readyShare >= 0.7 ? "positive" : "warning"}>
          {pct(readyShare, 0)} ready
        </StatusChip>
      }
    >
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        data-testid="data-critical-metrics"
      >
        <MetricTile
          label="Corpus"
          value={formatTokens(raw + proc)}
          detail={`${formatTokens(proc)} ready`}
        />
        <MetricTile
          label="Quality"
          value={avgQuality > 0 ? `Q${Math.round(avgQuality)}` : "—"}
          detail={`${domainsCovered}/${DATA_DOMAINS.length} domains`}
          tone={
            avgQuality >= 70
              ? "positive"
              : avgQuality >= 50
                ? "warning"
                : "neutral"
          }
        />
        <div className={DATA_WIDE_SECONDARY_CLASS}>
          <MetricTile
            label="Licensed"
            value={pct(licensedShare, 0)}
            detail={`${formatTokens(sources.bought + sources.user)} bought/user`}
            tone="positive"
          />
        </div>
        <div className={DATA_WIDE_SECONDARY_CLASS}>
          <MetricTile
            label="Today"
            value={`+${formatTokens(data.dayProcessed)}`}
            detail={`${data.assets.length} assets · ${data.manifests.length} manifests`}
            tone={autoSynthJob ? "research" : "neutral"}
          />
        </div>
      </div>

      <details
        className={`group mt-2 rounded-md border border-line/60 bg-void/30 ${DATA_COMPACT_SECONDARY_CLASS}`}
        data-testid="data-mobile-secondary"
      >
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-bone">
          <span>More corpus stats</span>
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
            {pct(licensedShare, 0)} licensed · +
            {formatTokens(data.dayProcessed)} today
          </span>
        </summary>
        <div className="grid grid-cols-2 gap-x-3 border-t border-line/60 px-2.5 py-2">
          <StatRow
            label="Bought / user"
            value={formatTokens(sources.bought + sources.user)}
          />
          <StatRow label="Assets" value={String(data.assets.length)} />
          <StatRow label="Manifests" value={String(data.manifests.length)} />
          <StatRow
            label="Domains"
            value={`${domainsCovered}/${DATA_DOMAINS.length}`}
          />
        </div>
      </details>

      <div
        className="mt-3 touch-auto overflow-x-auto overscroll-x-contain"
        data-swipe-ignore="true"
        data-testid="data-touch-tabs"
      >
        <SegmentedTabs
          ariaLabel="Data views"
          active={tab}
          onChange={(id) => setTab(id as DataTab)}
          items={[
            { id: "stocks", label: "Stocks" },
            { id: "sources", label: "Sources" },
            {
              id: "market",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Market
                  <span className="font-mono text-[0.625rem] text-muted">
                    {liveOffers.length}
                  </span>
                </span>
              ),
            },
            {
              id: "synth",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {autoSynthJob ? <LiveDot className="text-research" /> : null}
                  Synth
                </span>
              ),
            },
          ]}
        />
      </div>

      <div
        key={tab}
        className={`panel-swap mt-3 space-y-3 ${DATA_PANEL_SWIPE_CLASS}`}
        onTouchStart={beginPanelSwipe}
        onTouchEnd={finishPanelSwipe}
        onTouchCancel={() => {
          panelSwipeStart.current = null;
        }}
        data-testid="data-swipe-surface"
      >
        {tab === "stocks" && (
          <>
            <GameCard
              eyebrow="Flywheel"
              title="Collect & clean"
              tone="mint"
              actions={
                <StatusChip
                  tone={
                    data.collectionRate >= 0.8
                      ? "danger"
                      : data.collectionRate >= 0.55
                        ? "warning"
                        : "positive"
                  }
                >
                  {collectionRisk}
                </StatusChip>
              }
            >
              <div className="rounded-md border border-line/70 bg-void/45 px-2.5 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[0.6875rem]">
                  <span className="uppercase tracking-[0.12em] text-muted">
                    Hygiene load
                  </span>
                  <span className="font-mono tabular-nums text-bone">
                    {pct(hygiene.pressure, 0)} · {hygieneLabel}
                  </span>
                </div>
                <MeterBar
                  value={hygiene.pressure}
                  detail={`${formatTokens(hygiene.exposedMTok)} exposed`}
                  tone={
                    hygieneTone === "danger"
                      ? "danger"
                      : hygieneTone === "warning"
                        ? "warning"
                        : "positive"
                  }
                  live={hygiene.pressure >= 0.25}
                />
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.625rem] tabular-nums text-muted">
                  <span>
                    {formatTokens(
                      data.processQueue.reduce(
                        (sum, job) => sum + Math.max(0, job.remaining),
                        0,
                      ),
                    )}{" "}
                    queued
                  </span>
                  <span>{pct(hygiene.rawShare, 0)} raw/backlog</span>
                  <span>
                    {hygiene.modelDriftRate > 0
                      ? `-${(hygiene.modelDriftRate * 100).toFixed(2)}% model/day`
                      : "No model drift"}
                  </span>
                </div>
                {hygiene.pressure >= 0.25 ? (
                  <p className="mt-1 text-[0.6875rem] leading-snug text-warning">
                    High collection leaves dirty work in flight. Cleaning spends
                    cash and compute; leaving it exposed degrades released
                    models.
                  </p>
                ) : null}
              </div>
              <label className="block text-[0.6875rem] text-muted">
                <span className="flex items-center justify-between">
                  <span>Default intensity (fallback)</span>
                  <strong className="font-mono tabular-nums text-bone">
                    {Math.round(data.collectionRate * 100)}%
                  </strong>
                </span>
                <HudRange
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(data.collectionRate * 100)}
                  onChange={(e) =>
                    setCollectionRate(Number(e.target.value) / 100)
                  }
                  className="mt-1.5 w-full"
                />
              </label>
              <div className="mt-2 grid grid-cols-2 gap-x-3 min-[420px]:grid-cols-3">
                <StatRow
                  label="Collected"
                  value={formatTokens(data.dayCollected)}
                />
                <StatRow
                  label="Processed"
                  value={formatTokens(data.dayProcessed)}
                />
                <StatRow
                  label="Queue"
                  value={`${data.processQueue.length}/6`}
                />
              </div>
              <details className="group mt-2 rounded-md border border-line/60 bg-void/25">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-bone">
                  <span>Collection breakdown</span>
                  <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                    {formatTokens(data.dayCollectChatFree ?? 0)} free ·{" "}
                    {formatTokens(data.dayCollectChatPaid ?? 0)} paid
                  </span>
                </summary>
                <div className="border-t border-line/60 px-2.5 py-2">
                  <div className="grid grid-cols-2 gap-x-3">
                    <StatRow
                      label="Chat · free plans"
                      value={formatTokens(data.dayCollectChatFree ?? 0)}
                    />
                    <StatRow
                      label="Chat · paid ≤$50"
                      value={formatTokens(data.dayCollectChatPaid ?? 0)}
                    />
                  </div>
                  <p className="mt-1.5 text-[0.6875rem] leading-snug text-muted">
                    Free traffic can reach 100%; paid tiers cap collection and
                    high rates reduce trust. Cleaning rejects noisy records
                    instead of making them train-ready.
                  </p>
                </div>
              </details>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[0.8125rem] text-bone">
                  <HudInput
                    type="checkbox"
                    checked={data.autoProcess}
                    onChange={(e) => setAutoProcess(e.target.checked)}
                    className="h-4 min-h-0 w-4 min-w-0 shrink-0 appearance-auto rounded border-line bg-transparent p-0 accent-mint"
                  />
                  Auto-clean
                </label>
                <HudButton
                  variant="secondary"
                  onClick={() => enqueueProcessAll()}
                  className="min-h-11"
                >
                  Process backlog
                </HudButton>
              </div>
            </GameCard>

            <GameCard
              eyebrow="Inventory"
              title="Domain stocks"
              tone="mint"
              actions={
                <div className="flex flex-wrap gap-1.5">
                  <HudButton
                    variant="secondary"
                    onClick={() => enqueueProcessAll()}
                  >
                    Clean all
                  </HudButton>
                  <HudButton
                    variant="danger"
                    disabled={!pruneAllEstimate.ok}
                    title={
                      pruneAllEstimate.ok
                        ? `${money(pruneAllEstimate.cashCost)} · ${num(pruneAllEstimate.pfDays, 0)} PFd · ~${pruneAllEstimate.estimatedDays}d · ${pruneAllEstimate.engineersRequired} data engineers`
                        : pruneAllEstimate.reason
                    }
                    onClick={() => enqueueAllDataPrunes()}
                  >
                    Prune all
                  </HudButton>
                </div>
              }
            >
              {pruneAllBlockers.length > 0 ? (
                <div className="mb-2">
                  <BlockerList items={pruneAllBlockers} />
                </div>
              ) : null}
              {pruneAuditEstimate.unlocked ? (
                <div className="mb-2 rounded-md border border-amber/20 bg-amber/5 px-2.5 py-2 text-[0.75rem]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted">
                      Audit live · discard{" "}
                      <strong className="font-mono tabular-nums text-amber">
                        {formatTokens(pruneAllEstimate.totalMTok)}
                      </strong>
                    </span>
                    <span className="font-mono tabular-nums text-muted">
                      {money(pruneAllEstimate.cashCost)} ·{" "}
                      {num(pruneAllEstimate.pfDays, 0)} PFd · ~
                      {pruneAllEstimate.estimatedDays}d ·{" "}
                      {pruneAllEstimate.researchersRequired}R ·{" "}
                      {pruneAllEstimate.engineersRequired}E
                    </span>
                  </div>
                  <p className="mt-1 text-mint">
                    Volumes unlocked through D{pruneAuditEstimate.validUntilDay}
                    .
                  </p>
                </div>
              ) : (
                <div className="mb-2 space-y-2">
                  {auditBlockers.length > 0 ? (
                    <BlockerList items={auditBlockers} />
                  ) : null}
                  <HudButton
                    variant="secondary"
                    disabled={!pruneAuditEstimate.ok}
                    title={pruneAuditEstimate.reason}
                    onClick={() => purchaseDataPruneAudit()}
                    className="w-full"
                  >
                    Audit corpus · {money(pruneAuditEstimate.cashCost)}
                  </HudButton>
                </div>
              )}

              <CardGrid min="14rem" className="anim-stagger">
                {DATA_DOMAINS.map((domain) => {
                  const stock = data.stocks[domain];
                  const queued = data.processQueue
                    .filter((job) => job.domain === domain)
                    .reduce((sum, job) => sum + job.remaining, 0);
                  return (
                    <DomainStockCard
                      key={domain}
                      domain={domain}
                      raw={stock.raw}
                      processed={stock.processed}
                      quality={stock.quality}
                      dayIn={data.dayCollectByDomain[domain] ?? 0}
                      queued={queued}
                      prune={pruneEstimates.get(domain)!}
                      auditUnlocked={pruneAuditEstimate.unlocked}
                      cleanQuote={
                        stock.raw > 0
                          ? {
                              amount: Math.min(stock.raw, 50),
                              cash:
                                Math.min(stock.raw, 50) *
                                processingCostPerInspectedMTok(
                                  domain,
                                  70,
                                  "web",
                                ),
                              pfDays:
                                Math.min(stock.raw, 50) *
                                processingEffortPerInspectedMTok(
                                  domain,
                                  70,
                                  "web",
                                ),
                            }
                          : undefined
                      }
                      onProcess={() =>
                        enqueueProcess(domain, Math.min(stock.raw, 50), 70)
                      }
                      onPrune={() => enqueueDataPrune(domain)}
                      onBuy={() => {
                        setFilterDomain(domain);
                        setTab("market");
                      }}
                    />
                  );
                })}
              </CardGrid>
            </GameCard>

            {data.pruneQueue.length > 0 ? (
              <GameCard
                eyebrow="Active"
                title="Low-quality pruning"
                tone="train"
                live
                actions={
                  <StatusChip tone="warning">
                    {data.pruneQueue.length} active
                  </StatusChip>
                }
              >
                <div className="anim-stagger space-y-2">
                  {data.pruneQueue.map((job) => {
                    const total = job.rawTotal + job.processedTotal;
                    const remaining = job.rawRemaining + job.processedRemaining;
                    const done = 1 - remaining / Math.max(0.01, total);
                    return (
                      <div
                        key={job.id}
                        className="rounded-md border border-line/70 bg-void/45 px-2.5 py-2"
                      >
                        <div className="flex justify-between gap-2 text-[0.8125rem]">
                          <span className="font-medium text-bone">
                            {DATA_DOMAIN_META[job.domain].label}
                          </span>
                          <span className="font-mono tabular-nums text-muted">
                            {formatTokens(remaining)} left
                          </span>
                        </div>
                        <div className="mt-1.5">
                          <MeterBar
                            value={done}
                            detail={`${pct(done, 0)}`}
                            tone="train"
                            live
                          />
                        </div>
                        <div className="mt-1 flex flex-wrap justify-between gap-1 font-mono text-[0.6875rem] tabular-nums text-muted">
                          <span>{money(total * job.cashPerMTok)}</span>
                          <span>
                            {num(total * job.pfDaysPerMTok, 0)} PFd ·{" "}
                            {job.researchersRequired}R ·{" "}
                            {job.engineersRequired ?? 1}E ·{" "}
                            {pct(job.researchShare, 0)} research
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </GameCard>
            ) : null}
          </>
        )}

        {tab === "sources" && (
          <>
            <GameCard
              eyebrow="Mix"
              title="Source intelligence"
              tone="mint"
              actions={
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  {formatTokens(sourceTotal)} processed
                </span>
              }
            >
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {sourceMix.map((source) => (
                  <HudButton
                    key={source.key}
                    type="button"
                    variant="ghost"
                    onClick={() => setSelectedSource(source.key)}
                    aria-pressed={selectedSource === source.key}
                    className={`min-h-11 w-full rounded-md px-2.5 py-2 text-left transition ${
                      selectedSource === source.key
                        ? "border-mint/50 bg-mint/10"
                        : "border-line/70 bg-void/35 hover:border-line hover:bg-void/55"
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: source.color }}
                      />
                      {source.label}
                    </span>
                    <span className="mt-1 block font-mono text-[0.8125rem] tabular-nums text-bone">
                      {formatTokens(source.value)}
                    </span>
                    <span className="mt-0.5 block font-mono text-[0.6875rem] tabular-nums text-muted">
                      {pct(source.share, 0)}
                    </span>
                  </HudButton>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-x-3 min-[420px]:grid-cols-3">
                <StatRow
                  label="Share"
                  value={pct(selectedSourceInfo.share, 0)}
                  strong
                />
                <StatRow
                  label="Quality"
                  value={
                    sourceQuality > 0
                      ? `Q${Math.round(sourceQuality)} · ${sourceQualityBand}`
                      : "No stock"
                  }
                />
                <StatRow
                  label="Signal"
                  value={
                    selectedSource === "synth" && selectedSourceInfo.value > 0
                      ? `${pct((sources.synthHQ ?? 0) / selectedSourceInfo.value, 0)} HQ`
                      : selectedSourceInfo.signal
                  }
                />
              </div>

              <details className="group mt-3 rounded-md border border-line/60 bg-void/25">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.6875rem]">
                  <span className="uppercase tracking-[0.12em] text-muted">
                    Top domains
                  </span>
                  <span className="text-amber">{selectedSourceInfo.risk}</span>
                </summary>
                <div className="anim-stagger space-y-2 border-t border-line/60 px-2.5 py-2">
                  {sourceDomainRows.slice(0, 4).map((row) => (
                    <MeterBar
                      key={row.domain}
                      label={DATA_DOMAIN_META[row.domain].label}
                      value={
                        row.volume /
                        Math.max(1, sourceDomainRows[0]?.volume ?? 1)
                      }
                      detail={formatTokens(row.volume)}
                      tone="positive"
                    />
                  ))}
                </div>
              </details>
            </GameCard>

            <GameCard
              eyebrow="Reusable corpus"
              title="Dataset assets"
              tone="mint"
              actions={
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  exact inputs are frozen into each training manifest
                </span>
              }
            >
              {data.assets.length === 0 ? (
                <EmptyState
                  title="No inspectable assets yet"
                  description="Collect product traffic, process stock, buy a licensed lot, or generate synthetic data to create reusable corpus assets."
                />
              ) : (
                <CardGrid min="15rem" className="anim-stagger">
                  {[...data.assets]
                    .sort(
                      (left, right) =>
                        right.acquiredDay - left.acquiredDay ||
                        right.volumeMTok - left.volumeMTok,
                    )
                    .slice(0, 12)
                    .map((asset) => {
                      const risk = Math.max(
                        asset.contaminationRisk,
                        asset.rights === "restricted" ? 0.85 : 0,
                      );
                      return (
                        <div
                          key={asset.id}
                          className="rounded-md border border-line/70 bg-void/40 p-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <strong className="block truncate text-[0.8125rem] text-bone">
                                {asset.name}
                              </strong>
                              <span className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                                {asset.source} · {asset.rights}
                              </span>
                            </div>
                            <StatusChip
                              tone={
                                risk >= 0.5
                                  ? "danger"
                                  : risk >= 0.22
                                    ? "warning"
                                    : "positive"
                              }
                            >
                              {risk >= 0.5
                                ? "high risk"
                                : risk >= 0.22
                                  ? "audit"
                                  : "usable"}
                            </StatusChip>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                            <StatRow
                              label="Volume"
                              value={formatTokens(asset.volumeMTok)}
                              strong
                            />
                            <StatRow
                              label="Quality"
                              value={`Q${Math.round(asset.quality)}`}
                            />
                          </div>
                          <details className="group mt-2 rounded-md border border-line/60 bg-void/25">
                            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-[0.6875rem] text-muted">
                              <span>Asset details</span>
                              <span className="font-mono tabular-nums">
                                {pct(asset.diversity, 0)} diverse
                              </span>
                            </summary>
                            <div className="border-t border-line/60 px-2 py-2">
                              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                <StatRow
                                  label="Diversity"
                                  value={pct(asset.diversity, 0)}
                                />
                                <StatRow
                                  label="Freshness"
                                  value={pct(asset.freshness, 0)}
                                />
                              </div>
                              <p className="mt-2 truncate text-[0.6875rem] text-muted">
                                {formatMix(asset.domainWeights)}
                              </p>
                              <p className="mt-1 font-mono text-[0.625rem] text-muted">
                                contamination {pct(asset.contaminationRisk, 0)}
                                {asset.synthetic
                                  ? ` · synth depth ${asset.synthetic.generationDepth} · human anchor ${pct(asset.synthetic.humanAnchorShare, 0)}`
                                  : ""}
                              </p>
                            </div>
                          </details>
                        </div>
                      );
                    })}
                </CardGrid>
              )}
              {data.assets.length > 12 ? (
                <p className="mt-2 text-[0.6875rem] text-muted">
                  Showing the 12 newest assets of {data.assets.length}.
                </p>
              ) : null}
            </GameCard>
          </>
        )}

        {tab === "market" && (
          <>
            <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">
              <MetricTile
                label="Open bids"
                value={String(playerDataOrders.length)}
              />
              <MetricTile
                label="Reserved"
                value={money(dataReserved)}
                tone="warning"
              />
              <div className={DATA_WIDE_SECONDARY_CLASS}>
                <MetricTile
                  label="Last fill"
                  value={
                    latestDataFills[0]
                      ? formatTokens(latestDataFills[0].quantity)
                      : "—"
                  }
                  detail={
                    latestDataFills[0]
                      ? `${money(latestDataFills[0].unitPrice)}/MTok`
                      : undefined
                  }
                />
              </div>
            </div>

            <details
              className={`group rounded-md border border-line/60 bg-void/25 ${DATA_COMPACT_SECONDARY_CLASS}`}
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-bone">
                <span>Last market fill</span>
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  {latestDataFills[0]
                    ? `${formatTokens(latestDataFills[0].quantity)} · ${money(latestDataFills[0].unitPrice)}/MTok`
                    : "No fills"}
                </span>
              </summary>
            </details>

            <GameCard
              eyebrow="Live lots"
              title="Acquire data"
              tone="mint"
              actions={
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  {filteredLiveIds.length}/{liveOffers.length} live · refresh D
                  {market.nextRefreshDay}
                </span>
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <HudButton
                  variant="ghost"
                  aria-expanded={filtersOpen}
                  aria-controls="data-market-filters"
                  onClick={() => setFiltersOpen((open) => !open)}
                  className="min-h-11"
                >
                  Filters
                  {activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
                </HudButton>
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  {activeFilterCount > 0 ? "Refine live lots" : "All live lots"}
                </span>
              </div>
              {activeFilterChips.length > 0 ? (
                <div
                  className="mt-1.5 flex flex-wrap gap-1"
                  aria-label="Active market filters"
                >
                  {activeFilterChips.map((chip) => (
                    <HudButton
                      key={chip.id}
                      variant="ghost"
                      onClick={chip.clear}
                      className="min-h-11 rounded-md px-2 py-1 text-[0.6875rem]"
                      title={`Clear ${chip.label} filter`}
                    >
                      {chip.label}
                      <Trash aria-hidden="true" size="0.75rem" weight="bold" />
                    </HudButton>
                  ))}
                  <HudButton
                    variant="ghost"
                    onClick={() => {
                      setFilterSource("all");
                      setFilterDomain("all");
                      setFilterQuality("all");
                      setFilterLicense("all");
                      setFilterSeller("all");
                      setFilterPrice("all");
                    }}
                    className="min-h-11 px-2 py-1 text-[0.6875rem] text-muted"
                  >
                    Clear all
                  </HudButton>
                </div>
              ) : null}

              {filtersOpen ? (
                <div
                  id="data-market-filters"
                  className={`mt-2 grid gap-1.5 rounded-md border border-line/60 bg-void/25 p-1.5 ${DATA_MARKET_FILTER_GRID_CLASS}`}
                  data-swipe-ignore="true"
                >
                  <FilterSelect
                    label="Acquisition"
                    value={filterSource}
                    onChange={(value) =>
                      setFilterSource(value as MarketSourceFilter)
                    }
                    options={[
                      { value: "all", label: "All sources" },
                      ...(
                        Object.entries(MARKET_SOURCE_LABELS) as [
                          Exclude<MarketSourceFilter, "all">,
                          string,
                        ][]
                      ).map(([value, label]) => ({ value, label })),
                    ]}
                  />
                  <FilterSelect
                    label="Quality"
                    value={filterQuality}
                    onChange={(value) =>
                      setFilterQuality(value as "all" | DataQualityBand)
                    }
                    options={[
                      { value: "all", label: "All bands" },
                      ...QUALITY_BANDS.map((band) => ({
                        value: band,
                        label: DATA_QUALITY_LABELS[band],
                      })),
                    ]}
                  />
                  <FilterSelect
                    label="License"
                    value={filterLicense}
                    onChange={(value) =>
                      setFilterLicense(value as MarketLicenseFilter)
                    }
                    options={[
                      { value: "all", label: "All rights" },
                      ...(
                        Object.entries(MARKET_LICENSE_LABELS) as [
                          Exclude<MarketLicenseFilter, "all">,
                          string,
                        ][]
                      ).map(([value, label]) => ({ value, label })),
                    ]}
                  />
                  <FilterSelect
                    label="Seller"
                    value={filterSeller}
                    onChange={(value) =>
                      setFilterSeller(value as "all" | DataSellerKind)
                    }
                    options={[
                      { value: "all", label: "All sellers" },
                      ...SELLER_KINDS.map((kind) => ({
                        value: kind,
                        label: DATA_SELLER_LABELS[kind],
                      })),
                    ]}
                  />
                  <FilterSelect
                    label="Price"
                    value={filterPrice}
                    onChange={(value) =>
                      setFilterPrice(value as MarketPriceFilter)
                    }
                    options={[
                      { value: "all", label: "Any price" },
                      { value: "low", label: "Lower third" },
                      { value: "mid", label: "Mid third" },
                      { value: "high", label: "Upper third" },
                    ]}
                  />
                  <FilterSelect
                    label="Sort"
                    value={sortBy}
                    onChange={(value) => setSortBy(value as MarketSort)}
                    options={[
                      { value: "priceAsc", label: "$/MTok ↑" },
                      { value: "priceDesc", label: "$/MTok ↓" },
                      { value: "quality", label: "Quality" },
                      { value: "size", label: "Lot size" },
                      { value: "days", label: "Days left" },
                    ]}
                  />
                </div>
              ) : null}

              <div
                className="mt-2 flex touch-auto flex-nowrap gap-1 overflow-x-auto overscroll-x-contain pb-1"
                role="group"
                aria-label="Data type filter"
                data-swipe-ignore="true"
              >
                {(["all", ...DATA_DOMAINS] as const).map((domain) => {
                  const active = filterDomain === domain;
                  const count =
                    domain === "all"
                      ? liveOffers.length
                      : liveOffers.filter((offer) => offer.domain === domain)
                          .length;
                  return (
                    <HudButton
                      key={domain}
                      type="button"
                      variant="ghost"
                      aria-pressed={active}
                      onClick={() => setFilterDomain(domain)}
                      className={`min-h-11 shrink-0 rounded-md px-2 py-1 font-mono text-[0.6875rem] transition ${
                        active
                          ? "border-mint/50 bg-mint/10 text-bone"
                          : "border-line/70 bg-void/35 text-muted hover:border-line hover:bg-void/55"
                      }`}
                    >
                      {domain === "all"
                        ? "All"
                        : DATA_DOMAIN_META[domain].label}
                      <span className="ml-1 tabular-nums text-muted">
                        {count}
                      </span>
                    </HudButton>
                  );
                })}
              </div>

              <div className="mt-2 rounded-md border border-amber/25 bg-amber/5 p-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                      Buy all · +{Math.round(DATA_BULK_BUY_PREMIUM * 100)}%
                      premium
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                      <span>
                        {bulkPreview.lots} lots ·{" "}
                        {formatTokens(bulkPreview.volumeMTok)}
                      </span>
                      <span className="hidden min-[420px]:inline">
                        Q
                        {bulkPreview.lots > 0
                          ? Math.round(bulkPreview.weightedQuality)
                          : "—"}
                      </span>
                      <span className="hidden min-[420px]:inline">
                        Base {money(bulkPreview.baseCost)}
                      </span>
                      <span className="hidden text-amber min-[420px]:inline">
                        Premium {money(bulkPreview.bulkPremium)}
                      </span>
                      <span className="text-bone">
                        Final {money(bulkPreview.totalCost)}
                      </span>
                    </div>
                    {bulkPreview.reason ? (
                      <p className="mt-1 text-[0.75rem] text-amber">
                        {bulkPreview.reason}
                      </p>
                    ) : null}
                  </div>
                  <HudButton
                    variant="primary"
                    disabled={!bulkPreview.ok}
                    title={bulkPreview.reason}
                    onClick={() => buyAllFilteredDataLots(filteredLiveIds)}
                  >
                    Buy all
                  </HudButton>
                </div>
              </div>

              <div className="anim-stagger mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
                {filteredOffers.length === 0 ? (
                  <EmptyState
                    title="No matching lots"
                    description="Widen filters or wait for the next market refresh."
                  />
                ) : (
                  filteredOffers.map((offer) => (
                    <MarketLotRow
                      key={offer.id}
                      offer={offer}
                      cash={state.player.cash}
                      onBuy={buyDataLotAmount}
                    />
                  ))
                )}
              </div>
            </GameCard>

            <details className="group rounded-lg border border-line/70 bg-panel/45">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-[0.8125rem] font-semibold text-bone">
                <span>Supplier contracts</span>
                <span className="font-mono text-[0.6875rem] font-normal tabular-nums text-muted">
                  {
                    supplierContracts.filter((contract) =>
                      ["accepted", "active", "extended"].includes(
                        contract.status,
                      ),
                    ).length
                  }{" "}
                  live · {supplierOffers.length} desks
                </span>
              </summary>
              <div className="border-t border-line/60 p-2">
                <GameCard
                  eyebrow="Suppliers"
                  title="Negotiate delivery"
                  tone="train"
                  actions={
                    <StatusChip tone="warning">
                      {supplierOffers.length} desks
                    </StatusChip>
                  }
                >
                  <p className="mb-2 text-[0.8125rem] text-muted">
                    Recurring delivery desks. Up to{" "}
                    {DATA_MAX_CONTRACTS_PER_SUPPLIER} concurrent contracts per
                    desk — each extra one costs +
                    {Math.round(DATA_CONCURRENT_CONTRACT_PREMIUM * 100)}%.
                  </p>
                  <div className="anim-stagger space-y-2">
                    {supplierOffers.map((offer) => {
                      const openNegotiation = supplierContracts.find(
                        (contract) =>
                          contract.supplierId === offer.id &&
                          (contract.status === "offered" ||
                            contract.status === "countered"),
                      );
                      const liveContracts = supplierContracts.filter(
                        (contract) =>
                          contract.supplierId === offer.id &&
                          (contract.status === "accepted" ||
                            contract.status === "active" ||
                            contract.status === "extended") &&
                          contract.daysRemaining > 0,
                      );
                      const contractCount =
                        liveContracts.length + (openNegotiation ? 1 : 0);
                      const atCap =
                        contractCount >= DATA_MAX_CONTRACTS_PER_SUPPLIER;
                      const premiumMult =
                        1 + DATA_CONCURRENT_CONTRACT_PREMIUM * contractCount;
                      const blocked = atCap || Boolean(openNegotiation);
                      const awaitingResponse =
                        openNegotiation?.status === "offered";
                      const baseTerms = supplierTermsFromOffer(offer);
                      const standardDomains = DATA_DOMAINS.filter(
                        (domain) => (offer.domainMix[domain] ?? 0) > 0,
                      );
                      const domainPick =
                        domainPickByOffer[offer.id] ?? standardDomains;
                      const isCustomPick =
                        domainPickByOffer[offer.id] !== undefined &&
                        (domainPick.length !== standardDomains.length ||
                          domainPick.some(
                            (domain) => !standardDomains.includes(domain),
                          ));
                      // A custom data-type pick shares the volume equally across
                      // the chosen domains; otherwise keep the last proposed mix,
                      // then the desk's standard mix.
                      const negotiatedMix: Partial<Record<DataDomain, number>> =
                        isCustomPick && domainPick.length > 0
                          ? Object.fromEntries(
                              domainPick.map((domain) => [
                                domain,
                                1 / domainPick.length,
                              ]),
                            )
                          : {
                              ...(openNegotiation?.proposedTerms?.domainMix ??
                                baseTerms.domainMix),
                            };
                      const negotiatedTerms: DataSupplierTerms = {
                        ...baseTerms,
                        pricePerMTok:
                          baseTerms.pricePerMTok * (supplierOfferPercent / 100),
                        domainMix: negotiatedMix,
                      };
                      const negotiatedDaily = Math.round(
                        negotiatedTerms.dailyDeliveryMTok *
                          negotiatedTerms.pricePerMTok *
                          premiumMult,
                      );
                      const counterDaily = openNegotiation?.counterTerms
                        ? Math.round(
                            openNegotiation.counterTerms.dailyDeliveryMTok *
                              openNegotiation.counterTerms.pricePerMTok *
                              (1 +
                                DATA_CONCURRENT_CONTRACT_PREMIUM *
                                  liveContracts.length),
                          )
                        : 0;
                      const mix = Object.entries(offer.domainMix)
                        .filter(([, weight]) => (weight ?? 0) > 0)
                        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                        .slice(0, 4)
                        .map(
                          ([domain, weight]) =>
                            `${DATA_DOMAIN_META[domain as DataDomain]?.label ?? domain} ${Math.round((weight ?? 0) * 100)}%`,
                        )
                        .join(" · ");
                      const negotiationStatus =
                        liveContracts.length > 0
                          ? ("signed" as const)
                          : openNegotiation?.status === "countered"
                            ? ("countered" as const)
                            : ("idle" as const);
                      const blockers: Blocker[] = [];
                      if (atCap) {
                        blockers.push({
                          text: `${DATA_MAX_CONTRACTS_PER_SUPPLIER}/${DATA_MAX_CONTRACTS_PER_SUPPLIER} contracts live — let one lapse or cancel first`,
                          tone: "warning",
                        });
                      } else if (openNegotiation?.status === "offered") {
                        blockers.push({
                          text: "Offer pending seller response tomorrow",
                          tone: "warning",
                        });
                      } else if (openNegotiation?.status === "countered") {
                        blockers.push({
                          text: "Seller countered — accept, re-counter, or walk away",
                          tone: "warning",
                        });
                      }
                      if (!blocked && state.player.cash < negotiatedDaily) {
                        blockers.push({
                          text: `Need ${money(negotiatedDaily)} for day 1`,
                          tone: "danger",
                        });
                      }
                      return (
                        <section
                          key={offer.id}
                          className="overflow-hidden rounded-lg border border-line/70 bg-void/30"
                        >
                          <NegotiationHeader
                            title={offer.name}
                            subtitle="Recurring corpus delivery"
                            status={negotiationStatus}
                          />
                          <div className="space-y-2 p-2.5">
                            <NegotiationMessage
                              side="provider"
                              name={offer.name}
                            >
                              We collect and clear a steady mix of {mix}.
                              Delivery runs daily for the full term.
                            </NegotiationMessage>
                            <div className="grid grid-cols-2 gap-1.5 font-mono text-[0.6875rem] sm:grid-cols-4">
                              <NegotiationMetric
                                label="Quality"
                                value={`Q${offer.quality}`}
                              />
                              <NegotiationMetric
                                label="Delivery"
                                value={`${formatTokens(offer.dailyDeliveryMTok)}/d`}
                              />
                              <NegotiationMetric
                                label="Term"
                                value={`${offer.termDays}d`}
                              />
                              <NegotiationMetric
                                label="Contracts"
                                value={`${contractCount}/${DATA_MAX_CONTRACTS_PER_SUPPLIER}`}
                              />
                            </div>

                            {openNegotiation?.status === "countered" &&
                            openNegotiation.counterTerms ? (
                              <NegotiationMessage
                                side="provider"
                                name={offer.name}
                                status="countered"
                              >
                                Counter: {money(counterDaily)}/d · Q≥
                                {Math.round(
                                  openNegotiation.counterTerms.qualityFloor,
                                )}{" "}
                                · {openNegotiation.counterTerms.termDays}d ·{" "}
                                {formatMix(
                                  openNegotiation.counterTerms.domainMix,
                                )}
                              </NegotiationMessage>
                            ) : null}

                            <NegotiationMessage
                              side="player"
                              name="Labline"
                              status={
                                liveContracts.length > 0
                                  ? "signed"
                                  : openNegotiation?.status === "countered"
                                    ? "countered"
                                    : "idle"
                              }
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-mono tabular-nums text-amber">
                                  {money(
                                    Math.round(offer.dailyPrice * premiumMult),
                                  )}
                                  /day
                                  {contractCount > 0 ? (
                                    <span className="text-muted">
                                      {" "}
                                      (list {money(offer.dailyPrice)} +
                                      {Math.round(
                                        DATA_CONCURRENT_CONTRACT_PREMIUM *
                                          contractCount *
                                          100,
                                      )}
                                      % surcharge)
                                    </span>
                                  ) : (
                                    " list"
                                  )}
                                </span>
                                {!blocked ? (
                                  <HudButton
                                    variant="primary"
                                    disabled={
                                      (isCustomPick &&
                                        domainPick.length === 0) ||
                                      state.player.cash <
                                        (isCustomPick
                                          ? negotiatedDaily
                                          : Math.round(
                                              offer.dailyPrice * premiumMult,
                                            ))
                                    }
                                    title={
                                      isCustomPick
                                        ? domainPick.length === 0
                                          ? "Pick at least one data type below"
                                          : `Send custom-mix terms (${formatMix(negotiatedMix)}) — the supplier answers tomorrow and may counter`
                                        : (blockers[0]?.text?.toString() ??
                                          `Sign the desk's standard mix instantly (${mix})`)
                                    }
                                    onClick={() =>
                                      isCustomPick
                                        ? proposeDataSupplierTerms(
                                            offer.id,
                                            negotiatedTerms,
                                          )
                                        : acceptDataSupplierOffer(
                                            offer.id,
                                            supplierOfferPercent / 100,
                                          )
                                    }
                                  >
                                    {isCustomPick
                                      ? "Send offer · custom mix"
                                      : "Accept offer · standard mix"}
                                  </HudButton>
                                ) : atCap ? (
                                  <StatusChip tone="warning">
                                    {DATA_MAX_CONTRACTS_PER_SUPPLIER}/
                                    {DATA_MAX_CONTRACTS_PER_SUPPLIER} contracts
                                  </StatusChip>
                                ) : (
                                  <StatusChip tone="warning">
                                    {openNegotiation?.status}
                                  </StatusChip>
                                )}
                              </div>
                            </NegotiationMessage>

                            {!atCap ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <label className="min-w-0 flex-1 text-[0.6875rem] text-muted">
                                  Offer {supplierOfferPercent}%
                                  <HudRange
                                    min={80}
                                    max={100}
                                    value={supplierOfferPercent}
                                    disabled={awaitingResponse}
                                    onChange={(event) =>
                                      setSupplierOfferPercent(
                                        Number(event.target.value),
                                      )
                                    }
                                    className="ml-2 align-middle"
                                  />
                                  <span className="ml-2 font-mono text-amber">
                                    {money(negotiatedDaily)}/d
                                  </span>
                                </label>
                                <div className="w-full rounded-md border border-line/60 bg-void/40 p-2">
                                  <div className="flex items-center justify-between gap-2 text-[0.6875rem] uppercase tracking-[0.1em] text-muted">
                                    <span>Delivery mix — pick data types</span>
                                    <span className="font-mono normal-case tracking-normal text-amber">
                                      {domainPick.length > 0
                                        ? formatMix(negotiatedMix)
                                        : "Pick ≥1 data type"}
                                    </span>
                                  </div>
                                  <div
                                    className="mt-1.5 flex flex-wrap gap-1"
                                    role="group"
                                    aria-label="Contract data types"
                                  >
                                    {DATA_DOMAINS.map((domain) => {
                                      const active =
                                        domainPick.includes(domain);
                                      const inDeskMix =
                                        (offer.domainMix[domain] ?? 0) > 0;
                                      return (
                                        <HudButton
                                          key={domain}
                                          type="button"
                                          variant="ghost"
                                          aria-pressed={active}
                                          disabled={awaitingResponse}
                                          title={
                                            awaitingResponse
                                              ? "Waiting for the supplier's answer"
                                              : inDeskMix
                                                ? `${DATA_DOMAIN_META[domain].label} — in this desk's standard mix`
                                                : `${DATA_DOMAIN_META[domain].label} — outside the standard mix; the seller may counter`
                                          }
                                          onClick={() =>
                                            setDomainPickByOffer((current) => {
                                              const pick =
                                                current[offer.id] ??
                                                standardDomains;
                                              const nextPick = pick.includes(
                                                domain,
                                              )
                                                ? pick.filter(
                                                    (picked) =>
                                                      picked !== domain,
                                                  )
                                                : [...pick, domain];
                                              return {
                                                ...current,
                                                [offer.id]: nextPick,
                                              };
                                            })
                                          }
                                          className={`min-h-11 rounded-md px-2 py-1 font-mono text-[0.6875rem] transition ${
                                            active
                                              ? "!border-mint !bg-mint/20 !text-mint hover:!border-mint hover:!bg-mint/28 hover:!text-mint"
                                              : "!border-line/70 !bg-void/40 !text-muted hover:!border-line hover:!bg-void/60 hover:!text-bone"
                                          } ${active || inDeskMix ? "" : "!border-dashed"} disabled:opacity-50`}
                                        >
                                          <span className="inline-flex items-center gap-1">
                                            {active ? (
                                              <Check
                                                size="0.7rem"
                                                weight="bold"
                                                aria-hidden
                                              />
                                            ) : null}
                                            {DATA_DOMAIN_META[domain].label}
                                          </span>
                                        </HudButton>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            ) : null}

                            {openNegotiation?.status === "countered" &&
                            openNegotiation.counterTerms ? (
                              <div className="flex flex-wrap gap-1.5">
                                <HudButton
                                  variant="primary"
                                  disabled={state.player.cash < counterDaily}
                                  title="Sign the seller's counter terms"
                                  onClick={() =>
                                    acceptDataSupplierCounter(
                                      openNegotiation.id,
                                    )
                                  }
                                >
                                  Accept counter
                                </HudButton>
                                <HudButton
                                  variant="secondary"
                                  disabled={state.player.cash < negotiatedDaily}
                                  title={
                                    state.player.cash < negotiatedDaily
                                      ? `Need ${money(negotiatedDaily)} to re-counter`
                                      : "Re-counter at your offer %"
                                  }
                                  onClick={() =>
                                    counterDataSupplierOffer(
                                      openNegotiation.id,
                                      negotiatedTerms,
                                    )
                                  }
                                >
                                  Re-counter · {supplierOfferPercent}%
                                </HudButton>
                                <HudButton
                                  variant="ghost"
                                  title="Walk away from this negotiation"
                                  onClick={() =>
                                    rejectDataSupplierCounter(
                                      openNegotiation.id,
                                    )
                                  }
                                >
                                  Decline
                                </HudButton>
                              </div>
                            ) : null}

                            {liveContracts.map((liveContract) => {
                              const cancelFee =
                                dataCancellationFee(liveContract);
                              const cancelDisabledReason =
                                state.player.cash + 1e-9 < cancelFee
                                  ? `Need ${money(cancelFee)} for the cancellation fee`
                                  : undefined;
                              return (
                                <div
                                  key={liveContract.id}
                                  className="space-y-1.5 rounded-md border border-line/60 bg-void/40 p-2"
                                >
                                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                                    <span>
                                      {formatTokens(
                                        liveContract.dailyDeliveryMTok,
                                      )}
                                      /d
                                    </span>
                                    <span>
                                      {money(liveContract.dailyPrice)}/d
                                    </span>
                                    <span>
                                      {liveContract.daysRemaining}d left
                                    </span>
                                    <span>
                                      Delivered{" "}
                                      {formatTokens(
                                        liveContract.deliveredMTok ?? 0,
                                      )}
                                    </span>
                                    <span>
                                      {formatMix(liveContract.domainMix)}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <HudButton
                                      variant="danger"
                                      disabled={Boolean(cancelDisabledReason)}
                                      title={
                                        cancelDisabledReason ??
                                        `Cancel now · fee ${money(cancelFee)}`
                                      }
                                      onClick={() =>
                                        cancelDataSupplierContract(
                                          liveContract.id,
                                        )
                                      }
                                    >
                                      Cancel · {money(cancelFee)} fee
                                    </HudButton>
                                  </div>
                                  {cancelDisabledReason ? (
                                    <BlockerList
                                      items={[
                                        {
                                          text: cancelDisabledReason,
                                          tone: "warning" as const,
                                        },
                                      ]}
                                    />
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                          {blockers.length > 0 ? (
                            <div className="px-2.5 pb-2.5">
                              <BlockerList items={blockers} />
                            </div>
                          ) : null}
                        </section>
                      );
                    })}
                  </div>
                </GameCard>
              </div>
            </details>
          </>
        )}

        {tab === "synth" && (
          <GameCard
            eyebrow="Synthetic lab"
            title="Automatic generation"
            tone="research"
            live={Boolean(autoSynthJob)}
            actions={
              <StatusChip tone={autoSynthJob ? "research" : "neutral"}>
                {autoSynthJob ? "Live" : "Idle"} · ~
                {formatTokens(synthEstimate.grossMTokPerDay)}/d
              </StatusChip>
            }
          >
            <label className="block rounded-md border border-line/70 bg-void/35 p-2.5 text-[0.75rem] text-muted">
              <span className="flex items-center justify-between gap-3">
                <span>Research compute budget</span>
                <strong className="font-mono tabular-nums text-research">
                  {Math.round(genShare * 100)}% ·{" "}
                  {num(synthEstimate.researchPf, 2)} PF
                </strong>
              </span>
              <HudRange
                min={5}
                max={50}
                step={1}
                value={Math.round(genShare * 100)}
                onChange={(event) =>
                  setGenShare(Number(event.target.value) / 100)
                }
                className="mt-2 w-full"
              />
            </label>

            <div className="mt-2 grid grid-cols-2 gap-x-3">
              <StatRow
                label="Accepted / day"
                value={formatTokens(synthEstimate.acceptedMTokPerDay)}
              />
              <StatRow
                label="Compute / day"
                value={money(synthEstimate.dailyComputeCost)}
              />
            </div>

            <details className="group mt-2 rounded-md border border-line/60 bg-void/25">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-bone">
                <span>Generation detail</span>
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  {formatTokens(synthEstimate.grossMTokPerDay)} attempts ·{" "}
                  {mw(synthEstimate.powerMw)}
                </span>
              </summary>
              <div className="grid grid-cols-2 gap-x-3 border-t border-line/60 px-2.5 py-2">
                <StatRow
                  label="Attempts / day"
                  value={formatTokens(synthEstimate.grossMTokPerDay)}
                />
                <StatRow label="Power" value={mw(synthEstimate.powerMw)} />
              </div>
            </details>

            <SynthTeacherRoutingTable
              state={state}
              estimate={synthEstimate}
              picks={synthTeacherPickByDomain}
              effortPicks={synthTeacherEffortPickByDomain}
              onPick={(domain, modelId, effortId) => {
                setSynthTeacherPickByDomain((current) => ({
                  ...current,
                  [domain]: modelId,
                }));
                setSynthTeacherEffortPickByDomain((current) => ({
                  ...current,
                  [domain]: modelId ? effortId : "",
                }));
              }}
            />

            {!synthUnlocked ? (
              <div className="mt-2">
                <ResearchUnlockLink
                  nodeId="data_synth"
                  label="Open Synthetic Generators research"
                />
              </div>
            ) : null}

            {synthBlockers.length > 0 ? (
              <div className="mt-2">
                <BlockerList items={synthBlockers} />
              </div>
            ) : null}

            <HudButton
              variant="primary"
              disabled={!synthUnlocked || !synthEstimate.model}
              title={synthBlockers[0]?.text?.toString()}
              className="mt-3 w-full"
              onClick={() =>
                startSynthBudget({
                  researchShare: genShare,
                  teacherModelIds: synthTeacherIds,
                  teacherEffortIds: synthTeacherEffortIds,
                })
              }
            >
              {autoSynthJob
                ? "Apply routing & compute"
                : "Start automatic generation"}
            </HudButton>

            {autoSynthJob ? (
              <div className="mt-3 rounded-md border border-research/25 bg-void/50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-[0.8125rem] font-medium text-bone">
                      <LiveDot className="text-research" />
                      Corpus portfolio ·{" "}
                      {
                        liveSynthEstimate.domains.filter(
                          (route) => route.teacher,
                        ).length
                      }{" "}
                      routes
                    </div>
                    <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                      {Math.round(autoSynthJob.researchShare * 100)}% research ·{" "}
                      {mw(liveSynthEstimate.powerMw)} ·{" "}
                      {money(liveSynthEstimate.dailyComputeCost)}/d
                    </div>
                  </div>
                  <HudButton
                    variant="danger"
                    onClick={() => cancelSynthGen(autoSynthJob.id)}
                  >
                    Stop
                  </HudButton>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 min-[420px]:grid-cols-3">
                  <StatRow
                    label="High quality"
                    value={formatTokens(autoSynthJob.hqMTok ?? 0)}
                    tone="positive"
                  />
                  <StatRow
                    label="Low quality"
                    value={formatTokens(autoSynthJob.lqMTok ?? 0)}
                    tone="research"
                  />
                  <StatRow
                    label="Rejected"
                    value={formatTokens(autoSynthJob.wastedMTok ?? 0)}
                    tone="danger"
                  />
                </div>
                <div className="mt-2">
                  <MeterBar
                    label="Yield mix"
                    value={
                      (autoSynthJob.hqMTok ?? 0) /
                      Math.max(1, autoSynthJob.progressMTok)
                    }
                    detail={`${formatTokens(autoSynthJob.progressMTok)} attempts`}
                    tone="research"
                    live
                  />
                </div>
              </div>
            ) : (
              <EmptyState
                title="No synth job"
                description="Assign research compute to start automatic portfolio generation."
              />
            )}
          </GameCard>
        )}
      </div>
    </PanelScaffold>
  );
}

function MarketLotRow({
  offer,
  cash,
  onBuy,
}: {
  offer: DataMarketOffer;
  cash: number;
  onBuy: (offerId: string, amountMTok: number) => void;
}) {
  // Default the slider to the full remaining stock.
  const [amount, setAmount] = useState(offer.mTokLeft);
  const soldOut = offer.mTokLeft <= 0;
  const shown = Math.min(Math.max(0, amount), offer.mTokLeft);
  const sliderMin = Math.min(0.5, offer.mTokLeft);
  const sliderStep = offer.mTokLeft >= 200 ? 1 : 0.5;
  const amountCost = Math.max(
    50_000,
    Math.round(offer.cash * (shown / Math.max(1, offer.lotMTok))),
  );
  const lot = dataOfferPurchasableMTok(offer) || offer.lotMTok;
  const buysAll = shown >= offer.mTokLeft - Math.max(0.001, sliderStep / 2);
  const stockPct =
    offer.mTokTotal > 0 ? Math.min(1, offer.mTokLeft / offer.mTokTotal) : 0;
  const rights = dataOfferRights(offer);
  const blockers: Blocker[] = soldOut ? [{ text: "Sold out" }] : [];

  return (
    <div
      className={`w-full rounded-md border px-2.5 py-2 ${
        soldOut
          ? "border-line/50 bg-void/20 opacity-70"
          : "border-line/70 bg-void/40"
      }`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[0.8125rem] font-medium text-bone">
            {offer.name}
          </span>
          <StatusChip
            tone={
              offer.qualityBand === "curated"
                ? "positive"
                : offer.qualityBand === "premium"
                  ? "warning"
                  : "neutral"
            }
          >
            {DATA_QUALITY_LABELS[offer.qualityBand]}
          </StatusChip>
          <StatusChip tone="neutral">
            {DATA_DOMAIN_META[offer.domain].label}
          </StatusChip>
          <StatusChip tone="neutral">
            {MARKET_LICENSE_LABELS[rights]}
          </StatusChip>
        </div>
        <p className="mt-0.5 hidden truncate text-[0.75rem] text-muted sm:block [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:hidden">
          {offer.sellerName} · {DATA_SELLER_LABELS[offer.sellerKind]} ·{" "}
          {MARKET_SOURCE_LABELS[offer.source]}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
          <span>Q{offer.quality}</span>
          <span>
            Lot {formatTokens(lot)}
            {offer.mTokLeft > 0 && offer.mTokLeft < offer.mTokTotal
              ? ` · ${formatTokens(offer.mTokLeft)} left`
              : offer.mTokLeft <= 0
                ? " · sold out"
                : ` · ${formatTokens(offer.mTokTotal)} listed`}
          </span>
          <span>{offer.daysLeft}d left</span>
          <span>~{money(Math.round(dataOfferUnitPrice(offer)))}/MTok</span>
        </div>
        <div className="mt-1.5 hidden min-[420px]:block [@media(max-width:1180px)_and_(orientation:landscape)_and_(max-height:600px)]:hidden">
          <MeterBar
            value={stockPct}
            detail={`${pct(stockPct, 0)} stock`}
            tone={soldOut ? "danger" : "positive"}
          />
        </div>
        {blockers.length > 0 ? (
          <div className="mt-1.5">
            <BlockerList items={blockers} />
          </div>
        ) : null}
      </div>
      {!soldOut ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-line/60 pt-2">
          <label className="min-w-[10rem] flex-1 text-[0.6875rem] text-muted">
            <span className="flex items-center justify-between gap-2">
              <span>Amount (MTok)</span>
              <strong className="font-mono tabular-nums text-bone">
                {formatTokens(shown)} · {money(amountCost)}
              </strong>
            </span>
            <HudRange
              min={sliderMin}
              max={offer.mTokLeft}
              step={sliderStep}
              value={shown}
              onChange={(event) => setAmount(Number(event.target.value))}
              className="mt-1 w-full"
              aria-label={`Buy amount for ${offer.name}`}
            />
          </label>
          <HudButton
            variant="primary"
            disabled={shown < 0.5 || cash < amountCost}
            title={
              shown < 0.5
                ? "Pick at least 0.5 MTok"
                : cash < amountCost
                  ? `Need ${money(amountCost)} cash`
                  : buysAll
                    ? `Buy all remaining stock (${formatTokens(offer.mTokLeft)})`
                    : `Buy ${formatTokens(shown)} instantly`
            }
            onClick={() => onBuy(offer.id, shown)}
            className="min-h-11 max-[419px]:w-full"
          >
            {buysAll ? "Buy all" : "Buy amount"} · {money(amountCost)}
          </HudButton>
        </div>
      ) : null}
    </div>
  );
}

function DomainStockCard({
  domain,
  raw,
  processed,
  quality,
  dayIn,
  queued,
  prune,
  auditUnlocked,
  cleanQuote,
  onProcess,
  onPrune,
  onBuy,
}: {
  domain: DataDomain;
  raw: number;
  processed: number;
  quality: number;
  dayIn: number;
  queued: number;
  prune: DataPruneEstimate;
  auditUnlocked: boolean;
  cleanQuote?: { amount: number; cash: number; pfDays: number };
  onProcess: () => void;
  onPrune: () => void;
  onBuy: () => void;
}) {
  const meta = DATA_DOMAIN_META[domain];
  const total = Math.max(1, raw + processed + queued);
  const readyRatio = processed / total;
  const blockers: Blocker[] = [];
  if (raw < 0.5)
    blockers.push({ text: "Need ≥0.5MTok raw to clean", tone: "warning" });
  const pruneBlockers: Blocker[] = !prune.ok
    ? [{ text: prune.reason ?? "Cannot prune", tone: "warning" }]
    : [];

  return (
    <div className="rounded-md border border-line/70 bg-void/35 p-2.5 hover-lift">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[0.8125rem] font-semibold text-bone">
            {meta.label}
          </div>
          <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
            Q{num(quality, 0)} · {pct(readyRatio, 0)} ready
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <HudButton
            variant="secondary"
            disabled={raw < 0.5}
            title={blockers[0]?.text?.toString()}
            onClick={onProcess}
            className="!min-h-11 !px-2 !py-1 text-[0.6875rem]"
          >
            Clean
          </HudButton>
          <HudButton
            variant="danger"
            disabled={!prune.ok}
            title={
              prune.ok
                ? `${money(prune.cashCost)} · ${num(prune.pfDays, 0)} PFd · ~${prune.estimatedDays}d · ${prune.researchersRequired}R · ${prune.engineersRequired}E`
                : prune.reason
            }
            onClick={onPrune}
            className="!min-h-11 !px-2 !py-1 text-[0.6875rem]"
          >
            Prune
          </HudButton>
          <HudButton
            variant="ghost"
            onClick={onBuy}
            className="!min-h-11 !px-2 !py-1 text-[0.6875rem]"
          >
            Buy
          </HudButton>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2">
        <StatRow label="Raw" value={formatTokens(raw)} />
        <StatRow
          label="Ready"
          value={formatTokens(processed)}
          tone="positive"
        />
      </div>

      <div className="mt-1.5">
        <MeterBar
          label={
            queued > 0.01 ? `Cleaning ${formatTokens(queued)}` : "Coverage"
          }
          value={readyRatio}
          detail={pct(readyRatio, 0)}
          tone="positive"
          live={queued > 0.01}
        />
      </div>

      <details className="group mt-2 rounded-md border border-line/60 bg-void/25">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2 py-1.5 text-[0.6875rem] text-muted">
          <span>Stock details</span>
          <span className="font-mono tabular-nums">
            {dayIn > 0.01 ? `+${formatTokens(dayIn)} today` : "Costs & audit"}
          </span>
        </summary>
        <div className="border-t border-line/60 px-2 py-2">
          {cleanQuote ? (
            <div className="font-mono text-[0.625rem] tabular-nums text-muted">
              Clean quote · {formatTokens(cleanQuote.amount)} · ~
              {money(cleanQuote.cash)} · ~{num(cleanQuote.pfDays, 0)} PFd
            </div>
          ) : null}

          <div className="mt-1.5 text-[0.6875rem] text-muted">
            {!auditUnlocked ? (
              <span>Audit corpus to reveal low-Q volume</span>
            ) : prune.totalMTok >= 0.5 ? (
              <span className="font-mono tabular-nums">
                Low-Q {formatTokens(prune.totalMTok)} · {money(prune.cashCost)}{" "}
                · {num(prune.pfDays, 0)} PFd · {prune.researchersRequired}R
                {` · ${prune.engineersRequired}E · ~${prune.estimatedDays}d`}
              </span>
            ) : (
              <span>No low-quality stock</span>
            )}
          </div>
          {pruneBlockers.length > 0 && auditUnlocked ? (
            <div className="mt-1.5">
              <BlockerList items={pruneBlockers} />
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
