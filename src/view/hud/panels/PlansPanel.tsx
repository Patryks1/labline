import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ECONOMY } from "../../../sim/balance/economy";
import {
  analyzeApiPricing,
  analyzePlanPricing,
  apiUnitCostPerMTok,
  blendApiPrice,
  commercialApiListPricePerEquivalentMTok,
  commercialModelKind,
  planMarginPerSubMonth,
  serveInfraCost,
  splitInOutMTok,
  suggestCompetitiveApiInOut,
} from "../../../sim/balance/pricing";
import { energyPriceForState } from "../../../sim/systems/map";
import {
  ENTERPRISE_SUBSIDY_PRICE_MULTIPLE,
  enterpriseSubsidyExpectation,
  formatAllowance,
  freeTierDemandProfile,
  isFreePlan,
  planAdvertisedValueRatio,
  planAllowanceMTokPerDay,
  planAllowanceMTokPerMonth,
  planApiEquivalentValue,
  planAllowanceExpectation,
  planComputePriority,
  planModelEntitlements,
  planMonthlyApiValueSubsidy,
  planOfferingBreadth,
  availablePlanPrecisionsForModel,
  planModelServePrecision,
  planPriceTooHighScore,
  premiumPlanScrutiny,
  planServeModifiers,
  modelForServePrecision,
  planSubsidyRatio,
  rivalNearestValueRatio,
  unlockedPlanPrecisions,
  clampPlanDataCollectionRate,
  defaultPlanDataCollectionRate,
  effectivePlanDataCollectionRate,
  maxPlanDataCollectionShare,
  PAID_DATA_COLLECTION_PRICE_CAP,
  PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY,
} from "../../../sim/systems/plans";
import type { PlanOfferingBreadth } from "../../../sim/systems/plans";
import { useGameStore } from "../../../store/gameStore";
import { money, num, pct, people } from "../format";
import type {
  Model,
  ComputeLedger,
  FinanceDaySnapshot,
  NativeWorkUnits,
  PlanDayStats,
  PlanServePrecision,
  PlanStatsDaySnapshot,
  ServeThrottlePolicy,
  SubPlan,
} from "../../../sim/types";
import { computeSnapshot } from "../../../sim/tick";
import { ResearchUnlockLink } from "../ui/ResearchUnlockLink";
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import { GameCard, MeterBar, SegmentedTabs, StatRow } from "../ui/kit";
import { LineChart, type LineChartSeries } from "../ui/LineChart";
import { effectiveApiPeerPricing, formatApiListPrice } from "./apiPriceUi";

type PlansTabId = "demand" | "tiers" | "api" | "usage";

export function ApiCostSummary({
  estimatedCostPerMTok,
  modelCount,
  liveModelCount,
  servedMTok,
  requestedMTok,
}: {
  estimatedCostPerMTok: number;
  modelCount: number;
  liveModelCount: number;
  servedMTok: number;
  requestedMTok: number;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <MetricTile
        label="Estimated cost / 1M tokens"
        value={money(estimatedCostPerMTok)}
        detail="mean serving cost at selected precision"
        tone="serve"
      />
      <MetricTile
        label="API models"
        value={String(modelCount)}
        detail={`${liveModelCount} live endpoints`}
      />
      <MetricTile
        label="API traffic / day"
        value={`${num(servedMTok, 1)} MTok`}
        detail={`${num(requestedMTok, 1)} MTok requested`}
      />
    </div>
  );
}

function formatNumberDraft(
  value: number,
  decimals?: number,
  trimTrailingZeros = false,
): string {
  if (decimals == null) return String(value);
  const fixed = value.toFixed(decimals);
  return trimTrailingZeros ? fixed.replace(/\.?0+$/, "") || "0" : fixed;
}

function DraftNumberInput({
  value,
  onCommit,
  min,
  max,
  step,
  decimals,
  trimTrailingZeros,
  className,
  ariaLabel,
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  trimTrailingZeros?: boolean;
  className: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(() =>
    formatNumberDraft(value, decimals, trimTrailingZeros),
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(formatNumberDraft(value, decimals, trimTrailingZeros));
    }
  }, [value, decimals, trimTrailingZeros]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(formatNumberDraft(value, decimals, trimTrailingZeros));
      return;
    }
    const clamped = Math.max(
      min ?? -Infinity,
      Math.min(max ?? Infinity, parsed),
    );
    const next =
      decimals == null
        ? clamped
        : Math.round(clamped * 10 ** decimals) / 10 ** decimals;
    onCommit(next);
    setDraft(formatNumberDraft(next, decimals, trimTrailingZeros));
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      data-min={min}
      data-max={max}
      data-step={step}
      value={draft}
      aria-label={ariaLabel}
      onFocus={() => {
        editingRef.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        editingRef.current = false;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(formatNumberDraft(value, decimals, trimTrailingZeros));
          event.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}

export function PlansPanel() {
  const state = useGameStore((s) => s.state);
  const createPlan = useGameStore((s) => s.createPlan);
  const updatePlan = useGameStore((s) => s.updatePlan);
  const deletePlan = useGameStore((s) => s.deletePlan);
  const setModelApiInOut = useGameStore((s) => s.setModelApiInOut);
  const setPricing = useGameStore((s) => s.setPricing);
  const stats = state.lastMarket.planStats;
  const models = state.player.models.filter(
    (m) => m.release === "released" || m.shipped,
  );
  const pricing = state.player.pricing;
  const snap = computeSnapshot(state);
  const energyPrice = energyPriceForState(state);
  const infra = serveInfraCost(state, snap, energyPrice);
  const apiRequested = state.lastMarket.apiDemandMTok ?? 0;
  const apiServed = state.lastMarket.apiDayMTok ?? 0;
  const subRequested = Math.max(
    0,
    state.lastMarket.playerDemandMTok - apiRequested,
  );
  const subServed = state.lastMarket.planStats.reduce(
    (sum, plan) => sum + plan.dayMTok,
    0,
  );
  const rivalApiPeers = state.rivals.flatMap((rival) =>
    rival.models
      .filter((model) => model.release === "released" || model.shipped)
      .map((model) => {
        const effective = effectiveApiPeerPricing(rival.pricing, model);
        return {
          price: effective.price,
          capability: model.capability,
          featureScore: model.modalities.length * 18,
          tokPerSec:
            model.serviceProfile?.interactiveTokPerSec ??
            52 * model.tokPerSecMult,
          kind: commercialModelKind(model),
        };
      }),
  );
  const rivalApiInOutPeers = state.rivals.flatMap((rival) => {
    return rival.models
      .filter((model) => model.release === "released" || model.shipped)
      .map((model) => {
        const effective = effectiveApiPeerPricing(rival.pricing, model);
        return {
          priceIn: effective.priceIn,
          priceOut: effective.priceOut,
          capability: model.capability,
          featureScore: model.modalities.length * 18,
          tokPerSec:
            model.serviceProfile?.interactiveTokPerSec ??
            52 * model.tokPerSecMult,
          kind: commercialModelKind(model),
        };
      });
  });
  const rivalPlanPeers = state.rivals.flatMap((rival) => {
    const best = [...rival.models]
      .filter((model) => model.release === "released" || model.shipped)
      .sort((a, b) => b.capability - a.capability)[0];
    if (!best) return [];
    return (rival.pricing.plans ?? [])
      .filter((plan) => plan.enabled)
      .map((plan) => ({
        price: plan.pricePerMonth,
        includedMTokPerMonth: planAllowanceMTokPerMonth(plan),
        capability: best.capability,
        featureScore: best.modalities.length * 18,
      }));
  });

  const active =
    models.find((m) => m.id === pricing.activeModelId) ?? models[0];
  const apiModelIds = pricing.apiModelIds ?? (active ? [active.id] : []);

  const [name, setName] = useState("Team");
  const [price, setPrice] = useState(100);
  const [includedMTok, setIncludedMTok] = useState(
    ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth * 5,
  );
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(
    () => state.player.pricing.plans[0]?.id ?? null,
  );
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [plansTab, setPlansTab] = useState<PlansTabId>("tiers");

  const blendedList = blendApiPrice(
    active?.apiPriceInPerMTok ??
      active?.suggestedApiPriceIn ??
      pricing.apiPriceInPerMTok,
    active?.apiPriceOutPerMTok ??
      active?.suggestedApiPriceOut ??
      pricing.apiPriceOutPerMTok,
  );

  const modelFinance = state.lastMarket.modelFinance ?? [];
  const apiCostEstimates = models.map((model) => {
    const precision = pricing.apiServePrecisionByModel?.[model.id] ?? "fp16";
    const servedModel = modelForServePrecision(
      model,
      precision,
      state.player.researchUnlocked,
    );
    const finance = modelFinance.find((entry) => entry.modelId === model.id);
    return apiUnitCostPerMTok(state, snap, servedModel, {
      energyPricePerMWh: energyPrice,
      dayCogs: finance?.dayApiCogs,
      dayMTok: finance?.dayApiMTok,
    }).blended;
  });
  const estimatedApiCostPerMTok = apiCostEstimates.length
    ? apiCostEstimates.reduce((sum, cost) => sum + cost, 0) /
      apiCostEstimates.length
    : infra.costPerMTok;
  // Portfolio rollup
  const totalSubs = stats.reduce((s, p) => s + p.subscribers, 0);
  const paidSubs = stats
    .filter((p) => !p.isFree)
    .reduce((s, p) => s + p.subscribers, 0);
  const subRevDay = state.player.finance.subRevenue;
  const arpuMo =
    paidSubs > 0 ? (subRevDay * ECONOMY.daysPerMonth) / paidSubs : 0;
  const autoApiPriority = Math.max(
    0.12,
    Math.min(
      0.88,
      apiRequested + subRequested > 0
        ? apiRequested / (apiRequested + subRequested)
        : 0.68,
    ),
  );

  const unservedDemand = Math.max(
    0,
    state.lastMarket.playerDemandMTok - state.lastMarket.servedMTok,
  );
  const mtokServed = state.lastMarket.servedMTok;

  return (
    <PanelScaffold
      eyebrow="Commercial"
      title="Plans"
      description="Tiers, API pricing, and capacity routing."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label="Subscribers"
          value={people(totalSubs)}
          detail={`${people(paidSubs)} paid`}
        />
        <MetricTile
          label="Sub revenue / day"
          value={money(subRevDay)}
          detail={paidSubs > 0 ? `ARPU ${money(arpuMo)}/mo` : "no paid seats"}
          tone="positive"
        />
        <MetricTile
          label="MTok served"
          value={num(mtokServed, 1)}
          detail={`${num(apiServed, 1)} API · ${num(subServed, 1)} seats`}
          tone="serve"
        />
        <MetricTile
          label="Unserved demand"
          value={num(unservedDemand, 1)}
          detail="MTok / day"
          tone={unservedDemand > 0.5 ? "danger" : "neutral"}
        />
      </div>

      <div className="mt-3">
        <SegmentedTabs
          ariaLabel="Plans sections"
          active={plansTab}
          onChange={(id) => setPlansTab(id as PlansTabId)}
          items={[
            { id: "demand", label: "Demand" },
            {
              id: "tiers",
              label: `Tiers (${state.player.pricing.plans.length})`,
            },
            { id: "api", label: `API (${models.length})` },
            { id: "usage", label: "Usage" },
          ]}
        />
      </div>

      <div key={plansTab} className="panel-swap mt-3 space-y-3">
        {plansTab === "demand" ? (
          <PlanDemandSection
            history={state.planStatsHistory}
            stats={stats}
            finance={state.financeHistory}
            overflowMTok={state.lastMarket.overflowMTok}
            trickledMTok={state.lastMarket.trickledMTok}
          />
        ) : null}

        {plansTab === "tiers" ? (
          <>
            <div className="flex items-center justify-end gap-3">
              <HudButton
                type="button"
                variant="primary"
                className="!px-3 !py-1.5 text-[0.75rem]"
                onClick={() => setCreatingPlan(true)}
              >
                New plan
              </HudButton>
            </div>

            <div className="flex gap-1.5 overflow-x-auto rounded-lg bg-void/45 p-1.5">
              {state.player.pricing.plans.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => {
                    setSelectedPlanId(plan.id);
                    setCreatingPlan(false);
                  }}
                  className={`min-h-11 shrink-0 rounded-md border px-3 text-[0.75rem] font-medium sm:min-h-9 ${
                    selectedPlanId === plan.id && !creatingPlan
                      ? "border-mint/45 bg-mint/15 text-mint"
                      : "border-line/70 bg-panel-2 text-muted hover:text-bone"
                  }`}
                >
                  {plan.name} · {plan.enabled ? "Live" : "Paused"}
                </button>
              ))}
            </div>

            <div className="anim-stagger space-y-2.5">
              {state.player.pricing.plans
                .filter((plan) => plan.id === selectedPlanId && !creatingPlan)
                .map((plan) => {
                  const st = stats.find((s) => s.planId === plan.id);
                  const planModel =
                    models.find((m) => plan.modelIds.includes(m.id)) ?? active;
                  return (
                    <PlanCard
                      key={plan.id}
                      plan={plan}
                      stats={st}
                      models={models}
                      allPlans={state.player.pricing.plans}
                      unitCogs={
                        state.lastMarket.marginalPerMTok || infra.costPerMTok
                      }
                      apiList={blendedList}
                      modelCap={planModel?.capability ?? 40}
                      frontierCap={Math.max(
                        planModel?.capability ?? 40,
                        ...models.map((m) => m.capability),
                        ...state.rivals.flatMap((r) =>
                          r.models.map((m) => m.capability),
                        ),
                        40,
                      )}
                      peerPlans={rivalPlanPeers}
                      offeringBreadth={planOfferingBreadth(state, plan)}
                      onChange={(patch) => updatePlan(plan.id, patch)}
                      onDelete={() => {
                        deletePlan(plan.id);
                        setSelectedPlanId(
                          state.player.pricing.plans.find(
                            (candidate) => candidate.id !== plan.id,
                          )?.id ?? null,
                        );
                      }}
                    />
                  );
                })}
            </div>

            {creatingPlan ? (
              <GameCard eyebrow="Create" title="New plan" tone="mint">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-[0.8125rem] text-muted">
                    Name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 text-[0.8125rem] text-bone outline-none"
                    />
                  </label>
                  <label className="text-[0.8125rem] text-muted">
                    Price $/mo
                    <DraftNumberInput
                      ariaLabel="New plan monthly price"
                      min={0}
                      step={1}
                      value={price}
                      decimals={2}
                      onCommit={setPrice}
                      className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[0.8125rem] text-bone outline-none"
                    />
                  </label>
                </div>
                <label className="mt-2 block text-[0.8125rem] text-muted">
                  Included usage (MTok/month)
                  <DraftNumberInput
                    ariaLabel="New plan included MTok per month"
                    min={0.01}
                    step={1}
                    value={includedMTok}
                    decimals={2}
                    onCommit={setIncludedMTok}
                    className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[0.8125rem] text-bone outline-none"
                  />
                  <span className="mt-0.5 block text-[0.6875rem] leading-snug">
                    Fixed physical entitlement. API list-price edits do not
                    change this allowance.
                  </span>
                </label>
                <HudButton
                  type="button"
                  variant="primary"
                  className="mt-3 w-full"
                  onClick={() => {
                    createPlan({
                      name,
                      pricePerMonth: price,
                      usageMultiplier: Math.max(
                        0.1,
                        includedMTok /
                          (ECONOMY.basePlanUsageMTokPerDay *
                            ECONOMY.daysPerMonth),
                      ),
                      includedMTokPerMonth: includedMTok,
                    });
                    setName("Custom");
                    setIncludedMTok(
                      ECONOMY.basePlanUsageMTokPerDay *
                        ECONOMY.daysPerMonth *
                        5,
                    );
                    setCreatingPlan(false);
                  }}
                >
                  Create plan
                </HudButton>
              </GameCard>
            ) : null}
          </>
        ) : null}

        {plansTab === "api" ? (
          <section className="space-y-2">
            <ApiCostSummary
              estimatedCostPerMTok={estimatedApiCostPerMTok}
              modelCount={models.length}
              liveModelCount={apiModelIds.length}
              servedMTok={apiServed}
              requestedMTok={apiRequested}
            />

            {models.length === 0 ? (
              <EmptyState
                title="No released models"
                description="Release a model first — API list prices attach to each public model."
              />
            ) : (
              <div className="anim-stagger space-y-2">
                {models.map((m) => {
                  const fin = modelFinance.find((f) => f.modelId === m.id);
                  const isApiLive = apiModelIds.includes(m.id);
                  const apiPrecision =
                    pricing.apiServePrecisionByModel?.[m.id] ?? "fp16";
                  const apiPrecisionOptions = unlockedPlanPrecisions(
                    state.player.researchUnlocked,
                  );
                  const apiServeMods = planServeModifiers(
                    apiPrecision,
                    state.player.researchUnlocked,
                  );
                  const apiServedModel = modelForServePrecision(
                    m,
                    apiPrecision,
                    state.player.researchUnlocked,
                  );
                  const pin =
                    m.apiPriceInPerMTok ??
                    m.suggestedApiPriceIn ??
                    m.costApiPriceIn ??
                    pricing.apiPriceInPerMTok;
                  const pout =
                    m.apiPriceOutPerMTok ??
                    m.suggestedApiPriceOut ??
                    m.costApiPriceOut ??
                    pricing.apiPriceOutPerMTok;
                  const productKind = commercialModelKind(m);
                  const blend = commercialApiListPricePerEquivalentMTok(
                    productKind,
                    pin,
                    pout,
                    {
                      perImage: m.apiPricePerImage,
                      perAudioMinute: m.apiPricePerAudioMinute,
                      perVideoSecond: m.apiPricePerVideoSecond,
                    },
                  );
                  const dayMTok = fin?.dayApiMTok ?? 0;
                  const { inMTok, outMTok } = splitInOutMTok(dayMTok);
                  const liveCost = apiUnitCostPerMTok(
                    state,
                    snap,
                    apiServedModel,
                    {
                      energyPricePerMWh: energyPrice,
                      dayCogs: fin?.dayApiCogs,
                      dayMTok: fin?.dayApiMTok,
                    },
                  );
                  const pricingStatus = analyzeApiPricing({
                    price: blend,
                    marginalCost: liveCost.blended,
                    capability: apiServedModel.capability,
                    featureScore: m.modalities.length * 18,
                    tokPerSec:
                      apiServedModel.serviceProfile?.interactiveTokPerSec ??
                      52 * apiServedModel.tokPerSecMult,
                    peers: rivalApiPeers.filter(
                      (peer) => peer.kind === productKind,
                    ),
                  });
                  const suggestedApi = suggestCompetitiveApiInOut({
                    costIn: liveCost.costIn,
                    costOut: liveCost.costOut,
                    capability: apiServedModel.capability,
                    featureScore: m.modalities.length * 18,
                    tokPerSec:
                      apiServedModel.serviceProfile?.interactiveTokPerSec ??
                      52 * apiServedModel.tokPerSecMult,
                    peers: rivalApiInOutPeers.filter(
                      (peer) => peer.kind === productKind,
                    ),
                    fallbackPriceIn: m.suggestedApiPriceIn,
                    fallbackPriceOut: m.suggestedApiPriceOut,
                  });
                  const dayNet =
                    (fin?.dayApiRevenue ?? 0) - (fin?.dayApiCogs ?? 0);
                  const currentListRevenueAtPriorTraffic = dayMTok * blend;
                  const settlementDiffersFromCurrentList =
                    dayMTok > 0 &&
                    Math.abs(
                      (fin?.dayApiRevenue ?? 0) -
                        currentListRevenueAtPriorTraffic,
                    ) >
                      Math.max(
                        1,
                        Math.abs(fin?.dayApiRevenue ?? 0) * 0.005,
                        Math.abs(currentListRevenueAtPriorTraffic) * 0.005,
                      );
                  const belowFloor = blend < liveCost.blended;

                  return (
                    <div key={m.id} data-testid={`api-model-card-${m.id}`}>
                      <GameCard
                        eyebrow={isApiLive ? "API live" : "API paused"}
                        title={m.name}
                        tone={
                          isApiLive ? "mint" : belowFloor ? "danger" : "infer"
                        }
                        actions={
                          <HudButton
                            type="button"
                            variant={isApiLive ? "danger" : "primary"}
                            className="!px-2.5 !py-1 text-[0.75rem]"
                            onClick={() => {
                              const next = isApiLive
                                ? apiModelIds.filter((id) => id !== m.id)
                                : [...apiModelIds, m.id];
                              setPricing({ apiModelIds: next });
                            }}
                          >
                            {isApiLive ? "Stop API" : "Sell API"}
                          </HudButton>
                        }
                      >
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <div>
                            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                              Price
                            </div>
                            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
                              ${formatApiListPrice(blend)}/M
                            </div>
                          </div>
                          <div>
                            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                              Floor
                            </div>
                            <div
                              className={`font-mono text-[0.8125rem] tabular-nums ${
                                belowFloor ? "text-danger" : "text-bone"
                              }`}
                            >
                              ${liveCost.blended.toFixed(2)}/M
                            </div>
                          </div>
                          <div>
                            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                              Speed
                            </div>
                            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
                              {num(
                                m.serviceProfile?.interactiveTokPerSec ??
                                  52 * m.tokPerSecMult,
                                0,
                              )}{" "}
                              t/s
                            </div>
                          </div>
                          <div>
                            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                              Traffic
                            </div>
                            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
                              {num(dayMTok, 1)} MTok
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <PricingPill
                            status={pricingStatus.primary}
                            severity={pricingStatus.severity}
                          />
                          {belowFloor ? (
                            <StatusChip tone="danger">
                              Losing money / MTok
                            </StatusChip>
                          ) : null}
                          <StatusChip tone="serve">
                            cap {apiServedModel.capability.toFixed(2)}
                          </StatusChip>
                        </div>

                        <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
                          <UsageCell
                            label="Traffic / day"
                            value={num(dayMTok, 2)}
                            sub={`${num(inMTok, 2)} in · ${num(outMTok, 2)} out MTok`}
                          />
                          <UsageCell
                            label="Settled rev / cost"
                            value={money(fin?.dayApiRevenue ?? 0)}
                            sub={`${money(fin?.dayApiCogs ?? 0)} serving · prior day`}
                            accent="text-mint"
                          />
                          <UsageCell
                            label="Settled net / day"
                            value={money(dayNet)}
                            sub={
                              isApiLive
                                ? "live endpoint"
                                : (fin?.note ?? "not listed")
                            }
                            accent={dayNet < 0 ? "text-danger" : "text-mint"}
                          />
                        </div>

                        {settlementDiffersFromCurrentList ? (
                          <p
                            className="mt-2 rounded-md border border-infer/25 bg-infer/5 px-2.5 py-1.5 text-[0.75rem] leading-5 text-muted"
                            data-testid={`api-current-list-projection-${m.id}`}
                          >
                            Current-list projection at the same traffic:{" "}
                            {money(currentListRevenueAtPriorTraffic)} revenue.
                            The next market settlement uses the current price;
                            prior cash and P&amp;L remain historical.
                          </p>
                        ) : null}

                        <details className="group mt-2 rounded-md border border-line/60 bg-void/40">
                          <summary className="flex min-h-11 cursor-pointer list-none flex-col justify-center gap-0.5 px-2.5 py-2 marker:hidden sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                            <span className="text-[0.8125rem] font-medium text-bone">
                              Serving quality & benchmarks
                            </span>
                            <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                              {apiServeMods.label} · PF ×
                              {apiServeMods.computeMult.toFixed(2)} · cap{" "}
                              {apiServedModel.capability.toFixed(0)}
                            </span>
                          </summary>
                          <div className="border-t border-line/40 px-2.5 pb-2.5 pt-2">
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {apiPrecisionOptions.map((precision) => (
                              <button
                                key={precision}
                                type="button"
                                aria-label={`${m.name} API ${precision === "fp16" ? "Full" : precision.toUpperCase()}`}
                                onClick={() =>
                                  setPricing({
                                    apiServePrecisionByModel: {
                                      ...(pricing.apiServePrecisionByModel ??
                                        {}),
                                      [m.id]: precision,
                                    },
                                  })
                                }
                                className={`rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
                                  apiServeMods.precision === precision
                                    ? "bg-infer/25 text-infer ring-1 ring-infer/40"
                                    : "bg-void text-muted hover:text-bone"
                                }`}
                              >
                                {precision === "fp16"
                                  ? "Full"
                                  : precision.toUpperCase()}
                              </button>
                            ))}
                          </div>
                          {apiPrecisionOptions.length === 1 ? (
                            <ResearchUnlockLink
                              className="mt-1.5"
                              nodeId="sys_quant"
                              label="Unlock API quantization"
                            />
                          ) : null}
                          <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[0.6875rem] sm:grid-cols-4">
                            {(
                              ["mmlu", "coding", "math", "agents"] as const
                            ).map((benchmarkId) => (
                              <div
                                key={benchmarkId}
                                className="rounded-md border border-line/40 px-1.5 py-1"
                              >
                                <div className="uppercase tracking-[0.12em] text-muted">
                                  {benchmarkId}
                                </div>
                                <div
                                  className={
                                    apiServeMods.precision === "int4"
                                      ? "text-danger"
                                      : "text-bone"
                                  }
                                >
                                  {(
                                    apiServedModel.benchmarks[benchmarkId] ?? 0
                                  ).toFixed(0)}
                                  {apiServeMods.benchmarkDeltas[benchmarkId] ? (
                                    <span className="ml-0.5 text-muted">
                                      (
                                      {
                                        apiServeMods.benchmarkDeltas[
                                          benchmarkId
                                        ]
                                      }
                                      )
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ))}
                          </div>
                          {apiServeMods.brandRisk > 0 ? (
                            <p
                              className={`mt-1.5 text-[0.75rem] leading-snug ${
                                apiServeMods.brandRisk >= 0.1
                                  ? "text-danger"
                                  : "text-amber"
                              }`}
                            >
                              Public API eval loss reduces endpoint demand and
                              sustained traffic damages brand trust.
                            </p>
                          ) : null}
                          </div>
                        </details>

                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <label className="text-[0.8125rem] text-muted">
                            <span className="flex items-center justify-between gap-2">
                              <span>Input $/1M tok</span>
                              <span className="font-mono text-[0.6875rem] text-mint">
                                Suggested $
                                {formatApiListPrice(suggestedApi.priceIn)}
                              </span>
                            </span>
                            <DraftNumberInput
                              ariaLabel={`${m.name} input price per million tokens`}
                              min={0}
                              step={0.0000001}
                              value={pin}
                              decimals={7}
                              trimTrailingZeros
                              onCommit={(nextIn) => {
                                setModelApiInOut(m.id, nextIn, pout);
                              }}
                              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[0.8125rem] text-bone outline-none"
                            />
                          </label>
                          <label className="text-[0.8125rem] text-muted">
                            <span className="flex items-center justify-between gap-2">
                              <span>Output $/1M tok</span>
                              <span className="font-mono text-[0.6875rem] text-mint">
                                Suggested $
                                {formatApiListPrice(suggestedApi.priceOut)}
                              </span>
                            </span>
                            <DraftNumberInput
                              ariaLabel={`${m.name} output price per million tokens`}
                              min={0}
                              step={0.0000001}
                              value={pout}
                              decimals={7}
                              trimTrailingZeros
                              onCommit={(committedOut) => {
                                setModelApiInOut(m.id, pin, committedOut);
                              }}
                              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[0.8125rem] text-bone outline-none"
                            />
                          </label>
                        </div>
                        <p className="mt-2 text-[0.75rem] leading-5 text-muted">
                          Estimated cost {money(liveCost.blended)} per 1M tokens
                          ({liveCost.source === "live" ? "settled" : "forecast"}
                          )
                          {belowFloor
                            ? " · current list price is below cost"
                            : ""}
                          . {pricingStatus.explanation}
                        </p>
                      </GameCard>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {plansTab === "usage" ? (
          <div className="space-y-3">
            <ComputeAllocationChart
              apiMTok={apiServed}
              apiPf={Math.max(
                0,
                (state.lastMarket.servedPf ?? 0) -
                  stats.reduce((sum, plan) => sum + (plan.dayInferPf ?? 0), 0),
              )}
              apiModelUsage={state.lastMarket.apiModelUsage ?? []}
              plans={stats}
              ledger={state.lastMarket.computeLedger}
              headroom={state.industryDataPack.compute.onlineHeadroom ?? 0.25}
            >
              <CapacityRoutingControl
                value={pricing.apiVsSubPriority ?? 0.68}
                autoValue={autoApiPriority}
                apiServeFraction={
                  apiRequested > 0 ? Math.min(1, apiServed / apiRequested) : 1
                }
                subscriptionServeFraction={
                  subRequested > 0 ? Math.min(1, subServed / subRequested) : 1
                }
                apiBacklogMTok={Math.max(0, apiRequested - apiServed)}
                subscriptionBacklogMTok={Math.max(0, subRequested - subServed)}
                unservedRatio={
                  apiRequested + subRequested > 0
                    ? Math.min(
                        1,
                        (Math.max(0, apiRequested - apiServed) +
                          Math.max(0, subRequested - subServed)) /
                          (apiRequested + subRequested),
                      )
                    : 0
                }
                onChange={(apiVsSubPriority) =>
                  setPricing({ apiVsSubPriority })
                }
                throttlePolicy={pricing.serveThrottlePolicy ?? "balanced"}
                onThrottlePolicyChange={(serveThrottlePolicy) =>
                  setPricing({ serveThrottlePolicy })
                }
                apiLoad={state.lastMarket.apiLoad ?? 0}
                subLoad={state.lastMarket.subLoad ?? 0}
                apiStrain={state.lastMarket.apiSpeedStrain ?? 0}
                subStrain={state.lastMarket.subSpeedStrain ?? 0}
              />
            </ComputeAllocationChart>
          </div>
        ) : null}
      </div>
    </PanelScaffold>
  );
}

/** Player-series colors for demand charts, assigned in stable first-seen order. Theme tokens only. */
const PLAN_SERIES_COLORS = [
  "var(--color-mint)",
  "var(--color-infer)",
  "var(--color-amber)",
  "var(--color-research)",
  "var(--color-gold)",
  "var(--color-train)",
];

/** Cap daily samples so long histories stay light for per-point SVG dots. */
const DEMAND_CHART_MAX_POINTS = 90;

type PlanSeriesMeta = {
  planId: string;
  name: string;
  color: string;
  paid: boolean;
};

function planDemandSeries(
  metas: PlanSeriesMeta[],
  days: PlanStatsDaySnapshot[],
  read: (plan: PlanStatsDaySnapshot["plans"][number]) => number,
): LineChartSeries[] {
  return metas.map((meta) => ({
    id: meta.planId,
    label: meta.name,
    color: meta.color,
    points: days.flatMap((snap) => {
      const plan = snap.plans.find((entry) => entry.planId === meta.planId);
      return plan ? [{ x: snap.day, y: read(plan) }] : [];
    }),
  }));
}

function PlanDemandSection({
  history,
  stats,
  finance,
  overflowMTok,
  trickledMTok,
}: {
  history: PlanStatsDaySnapshot[];
  stats: PlanDayStats[];
  finance: FinanceDaySnapshot[];
  overflowMTok?: number;
  trickledMTok?: number;
}) {
  const [hiddenPlanIds, setHiddenPlanIds] = useState<string[]>([]);

  const plansMeta = useMemo<PlanSeriesMeta[]>(() => {
    const order: string[] = [];
    const names = new Map<string, string>();
    const everPaid = new Set<string>();
    for (const snap of history) {
      for (const plan of snap.plans) {
        if (!names.has(plan.planId)) order.push(plan.planId);
        names.set(plan.planId, plan.name); // latest name wins
        if (plan.pricePerMonth > 0) everPaid.add(plan.planId);
      }
    }
    return order.map((planId, index) => ({
      planId,
      name: names.get(planId) ?? planId,
      color: PLAN_SERIES_COLORS[index % PLAN_SERIES_COLORS.length],
      paid: everPaid.has(planId),
    }));
  }, [history]);

  const sampled = useMemo(() => {
    const stride = Math.max(
      1,
      Math.ceil(history.length / DEMAND_CHART_MAX_POINTS),
    );
    return stride === 1
      ? history
      : history.filter(
          (_, index) => index % stride === 0 || index === history.length - 1,
        );
  }, [history]);

  const subscriberSeries = useMemo(
    () => planDemandSeries(plansMeta, sampled, (plan) => plan.subscribers),
    [plansMeta, sampled],
  );
  // Free plans never earn subscription revenue — they would flat-line at $0.
  const revenueSeries = useMemo(
    () =>
      planDemandSeries(
        plansMeta.filter((meta) => meta.paid),
        sampled,
        (plan) => plan.dayRevenue,
      ),
    [plansMeta, sampled],
  );

  const financeSampled = useMemo(() => {
    const stride = Math.max(
      1,
      Math.ceil(finance.length / DEMAND_CHART_MAX_POINTS),
    );
    return stride === 1
      ? finance
      : finance.filter(
          (_, index) => index % stride === 0 || index === finance.length - 1,
        );
  }, [finance]);

  const servedVsDemandedSeries = useMemo<LineChartSeries[]>(
    () => [
      {
        id: "served",
        label: "Served",
        color: "var(--color-mint)",
        points: financeSampled.map((snap) => ({
          x: snap.day,
          y: snap.servedMTok,
        })),
      },
      {
        id: "demanded",
        label: "Demanded",
        color: "var(--color-infer)",
        points: financeSampled.map((snap) => ({
          x: snap.day,
          y: snap.demandMTok,
        })),
      },
    ],
    [financeSampled],
  );

  if (history.length === 0) {
    return (
      <EmptyState
        title="No demand trend yet"
        description="Play a day to see demand trends."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1" aria-label="Toggle plans">
        {plansMeta.map((meta) => {
          const hidden = hiddenPlanIds.includes(meta.planId);
          return (
            <button
              key={meta.planId}
              type="button"
              aria-pressed={!hidden}
              title={hidden ? `Show ${meta.name}` : `Hide ${meta.name}`}
              onClick={() =>
                setHiddenPlanIds((current) =>
                  hidden
                    ? current.filter((id) => id !== meta.planId)
                    : [...current, meta.planId],
                )
              }
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition ${
                hidden
                  ? "border-line/50 bg-void/30 text-muted/60"
                  : "border-line/70 bg-panel-2 text-bone hover:border-line"
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: hidden ? "transparent" : meta.color,
                  boxShadow: hidden
                    ? `inset 0 0 0 1.5px ${meta.color}`
                    : undefined,
                }}
              />
              <span className="max-w-[8rem] truncate">{meta.name}</span>
            </button>
          );
        })}
      </div>

      <GameCard eyebrow="Demand" title="Subscribers over time" tone="mint">
        <div className="rounded-lg border border-line/70 bg-void/40 p-2">
          <LineChart
            series={subscriberSeries}
            hiddenIds={hiddenPlanIds}
            height={200}
            xLabel="Day"
            yLabel="Subs"
            formatX={(value) => `D${Math.round(value)}`}
            formatY={(value) => num(value)}
            ariaLabel="Plan subscribers over time"
            renderTooltip={(hover) => (
              <span className="block max-w-[11rem]">
                <span className="block truncate font-sans font-medium text-bone">
                  {hover.series.label}
                </span>
                <span className="block text-bone">
                  {people(hover.point.y)} · D{Math.round(hover.point.x)}
                </span>
              </span>
            )}
          />
        </div>
      </GameCard>

      {revenueSeries.length > 0 ? (
        <GameCard eyebrow="Revenue" title="Plan revenue per day" tone="mint">
          <div className="rounded-lg border border-line/70 bg-void/40 p-2">
            <LineChart
              series={revenueSeries}
              hiddenIds={hiddenPlanIds}
              height={200}
              xLabel="Day"
              yLabel="$/day"
              formatX={(value) => `D${Math.round(value)}`}
              formatY={(value) => money(value)}
              ariaLabel="Plan revenue over time"
              renderTooltip={(hover) => (
                <span className="block max-w-[11rem]">
                  <span className="block truncate font-sans font-medium text-bone">
                    {hover.series.label}
                  </span>
                  <span className="block text-bone">
                    {money(hover.point.y)}/day · D{Math.round(hover.point.x)}
                  </span>
                </span>
              )}
            />
          </div>
        </GameCard>
      ) : null}

      {finance.length > 0 ? (
        <GameCard eyebrow="Capacity" title="Served vs demanded" tone="infer">
          <div className="rounded-lg border border-line/70 bg-void/40 p-2">
            <LineChart
              series={servedVsDemandedSeries}
              height={180}
              xLabel="Day"
              yLabel="MTok"
              formatX={(value) => `D${Math.round(value)}`}
              formatY={(value) => num(value)}
              ariaLabel="Served vs demanded tokens over time"
              renderTooltip={(hover) => (
                <span className="block max-w-[11rem]">
                  <span className="block truncate font-sans font-medium text-bone">
                    {hover.series.label}
                  </span>
                  <span className="block text-bone">
                    {num(hover.point.y, 2)} MTok · D{Math.round(hover.point.x)}
                  </span>
                </span>
              )}
            />
          </div>
          <div className="anim-stagger mt-1">
            <StatRow
              label="Spilled today"
              hint="Unserved demand with nowhere to go"
              tone={overflowMTok ? "danger" : "neutral"}
              value={overflowMTok ? `${num(overflowMTok, 2)} MTok` : "—"}
            />
            <StatRow
              label="Retried on other models"
              hint="Unserved API demand picked up by the lab's other models"
              tone={trickledMTok ? "serve" : "neutral"}
              value={trickledMTok ? `${num(trickledMTok, 2)} MTok` : "—"}
            />
          </div>
        </GameCard>
      ) : null}

      {stats.length > 0 ? (
        <GameCard eyebrow="Today" title="Seats vs capacity" tone="infer">
          <div className="anim-stagger space-y-2">
            {stats.map((planStats) => {
              const seatCap = planStats.maxSeats;
              const hasCap = seatCap != null && seatCap > 0 && seatCap < 1e8;
              const serve = planStats.serveFraction ?? 1;
              const chipTone =
                serve >= 0.97
                  ? "positive"
                  : serve >= 0.8
                    ? "warning"
                    : "danger";
              return (
                <div
                  key={planStats.planId}
                  className="rounded-md border border-line/50 bg-void/40 px-2.5 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[0.8125rem] font-medium text-bone">
                      {planStats.name}
                    </span>
                    <StatusChip tone={chipTone}>
                      {Math.round(serve * 100)}% served
                    </StatusChip>
                  </div>
                  <div className="mt-1.5">
                    {hasCap ? (
                      <MeterBar
                        label="Seat fill"
                        value={Math.min(1, planStats.subscribers / seatCap)}
                        detail={`${people(planStats.subscribers)} / cap ${people(seatCap)}`}
                        tone="serve"
                        live={planStats.subscribers > 0.5}
                      />
                    ) : (
                      <div className="flex items-baseline justify-between gap-2 text-[0.6875rem]">
                        <span className="font-mono tabular-nums text-bone">
                          {people(planStats.subscribers)}
                        </span>
                        <span className="text-muted">open seats</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </GameCard>
      ) : null}
    </div>
  );
}

/** Overload policy options for the segmented control; hint shows for the active one. */
const THROTTLE_POLICY_OPTIONS: {
  id: ServeThrottlePolicy;
  label: string;
  hint: string;
}[] = [
  {
    id: "shed",
    label: "Shed excess",
    hint: "Reject overflow — queues & errors churn users and spill demand to rivals.",
  },
  {
    id: "balanced",
    label: "Balanced",
    hint: "Slow streams for the first ~25% of overload, shed the rest.",
  },
  {
    id: "throttle",
    label: "Slow streams",
    hint: "Serve everyone; streams slow down and demand cools tomorrow.",
  },
];

/** Channel load (demand ÷ reserved capacity): calm ≤90%, strained ≤115%, overloaded above. */
function channelLoadTone(load: number): "positive" | "warning" | "danger" {
  return load > 1.15 ? "danger" : load > 0.9 ? "warning" : "positive";
}

/** Stream speed factor under strain is 1 − 0.6×strain; shown as a slowdown %. */
function strainSlowdownPct(strain: number): number {
  return Math.round(0.6 * strain * 100);
}

function CapacityRoutingControl({
  value,
  autoValue,
  apiServeFraction,
  subscriptionServeFraction,
  apiBacklogMTok,
  subscriptionBacklogMTok,
  unservedRatio,
  onChange,
  throttlePolicy,
  onThrottlePolicyChange,
  apiLoad,
  subLoad,
  apiStrain,
  subStrain,
}: {
  value: number;
  autoValue: number;
  apiServeFraction: number;
  subscriptionServeFraction: number;
  apiBacklogMTok: number;
  subscriptionBacklogMTok: number;
  unservedRatio: number;
  onChange: (value: number) => void;
  throttlePolicy: ServeThrottlePolicy;
  onThrottlePolicyChange: (policy: ServeThrottlePolicy) => void;
  apiLoad: number;
  subLoad: number;
  apiStrain: number;
  subStrain: number;
}) {
  const apiShare = Math.round(value * 100);
  const subscriptionShare = 100 - apiShare;
  const apiHealth = Math.round(apiServeFraction * 100);
  const subscriptionHealth = Math.round(subscriptionServeFraction * 100);
  const bottleneck =
    apiServeFraction <= subscriptionServeFraction ? "API" : "Seats";
  const bottleneckBacklog =
    bottleneck === "API" ? apiBacklogMTok : subscriptionBacklogMTok;
  const pressure =
    unservedRatio > 0.5
      ? {
          label: "Overloaded",
          tone: "border-danger/40 bg-danger/10 text-danger",
        }
      : unservedRatio > 0.2
        ? { label: "Strained", tone: "border-amber/40 bg-amber/10 text-amber" }
        : unservedRatio > 0.05
          ? { label: "Tight", tone: "border-amber/30 bg-amber/8 text-amber" }
          : { label: "Stable", tone: "border-mint/30 bg-mint/8 text-mint" };
  const healthTone = (health: number) =>
    health < 50 ? "text-danger" : health < 90 ? "text-amber" : "text-mint";

  return (
    <section
      aria-label="Capacity routing"
      className="overflow-hidden rounded-lg border border-line/70 bg-void/45"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[0.75rem] font-semibold text-bone">
            Capacity routing
          </h3>
          <span
            className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wide ${pressure.tone}`}
          >
            {pressure.label}
          </span>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-mint/35 bg-mint/10 px-2 py-1 text-[0.6875rem] font-medium text-mint transition-colors hover:bg-mint/20"
          onClick={() => onChange(autoValue)}
          title="Match API and seat capacity to current token demand"
        >
          Auto-balance
        </button>
      </div>

      <div className="px-2.5 py-2">
        <div className="flex items-end justify-between gap-3 font-mono">
          <div>
            <div className="text-[0.625rem] uppercase tracking-wide text-muted">
              Seats
            </div>
            <div className="text-sm font-semibold text-bone">
              {subscriptionShare}%
            </div>
          </div>
          <div className="text-right">
            <div className="text-[0.625rem] uppercase tracking-wide text-muted">
              API
            </div>
            <div className="text-sm font-semibold text-infer">{apiShare}%</div>
          </div>
        </div>
        <input
          type="range"
          min={12}
          max={88}
          step={1}
          value={apiShare}
          onChange={(event) =>
            onChange(
              Math.max(0.12, Math.min(0.88, Number(event.target.value) / 100)),
            )
          }
          className="slider-track mt-1 w-full"
          aria-label="API vs subscription capacity priority"
        />
        <p className="mt-1 text-[0.6875rem] leading-snug text-muted">
          More API capacity → faster API streams under load; seats slow instead.
        </p>

        <div className="mt-1.5 grid grid-cols-2 divide-x divide-line/60 rounded-lg border border-line/50 bg-panel-2/55">
          <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
            <span className="text-[0.6875rem] text-muted">Seats served</span>
            <span
              className={`font-mono text-[0.75rem] font-semibold ${healthTone(subscriptionHealth)}`}
            >
              {subscriptionHealth}%
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
            <span className="text-[0.6875rem] text-muted">API served</span>
            <span
              className={`font-mono text-[0.75rem] font-semibold ${healthTone(apiHealth)}`}
            >
              {apiHealth}%
            </span>
          </div>
        </div>

        <div
          aria-live="polite"
          className={`mt-1.5 flex items-center justify-between gap-2 rounded-md px-2 py-1 font-mono text-[0.625rem] ${unservedRatio > 0.05 ? pressure.tone : "bg-mint/5 text-mint"}`}
          title={`API backlog ${num(apiBacklogMTok, 2)} MTok · seat backlog ${num(subscriptionBacklogMTok, 2)} MTok`}
        >
          {unservedRatio > 0.05 ? (
            <>
              <span>{bottleneck} bottleneck</span>
              <span>{num(bottleneckBacklog, 2)} MTok waiting</span>
            </>
          ) : (
            <>
              <span>Capacity clear</span>
              <span>Both lanes healthy</span>
            </>
          )}
        </div>

        <div className="mt-2 border-t border-line/50 pt-2">
          <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Channel load
          </p>
          <div className="mt-1.5 space-y-1.5">
            <MeterBar
              label="API load"
              value={apiLoad}
              tone={channelLoadTone(apiLoad)}
              live={apiLoad > 1}
              detail={
                <>
                  {pct(apiLoad)}
                  {apiStrain > 0.01 ? (
                    <span className="text-amber">
                      {" "}
                      · streams −{strainSlowdownPct(apiStrain)}%
                    </span>
                  ) : null}
                </>
              }
            />
            <MeterBar
              label="Subs load"
              value={subLoad}
              tone={channelLoadTone(subLoad)}
              live={subLoad > 1}
              detail={
                <>
                  {pct(subLoad)}
                  {subStrain > 0.01 ? (
                    <span className="text-amber">
                      {" "}
                      · streams −{strainSlowdownPct(subStrain)}%
                    </span>
                  ) : null}
                </>
              }
            />
          </div>
        </div>

        <div className="mt-2 border-t border-line/50 pt-2">
          <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Overload policy
          </p>
          <div className="mt-1.5">
            <SegmentedTabs
              ariaLabel="Overload policy"
              active={throttlePolicy}
              onChange={(id) =>
                onThrottlePolicyChange(id as ServeThrottlePolicy)
              }
              items={THROTTLE_POLICY_OPTIONS.map((option) => ({
                id: option.id,
                label: option.label,
                title: option.hint,
              }))}
            />
          </div>
          <p
            aria-live="polite"
            className="mt-1.5 text-[0.6875rem] leading-snug text-muted"
          >
            {
              THROTTLE_POLICY_OPTIONS.find(
                (option) => option.id === throttlePolicy,
              )?.hint
            }
          </p>
        </div>
      </div>
    </section>
  );
}

function PricingPill({
  status,
  severity,
}: {
  status: string;
  severity: "ok" | "amber" | "danger";
}) {
  const label = status.replaceAll("_", " ").toUpperCase();
  const style =
    severity === "danger"
      ? "border-danger/35 bg-danger/10 text-danger"
      : severity === "amber"
        ? "border-amber/35 bg-amber/10 text-amber"
        : "border-mint/30 bg-mint/10 text-mint";
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.625rem] ${style}`}
    >
      {label}
    </span>
  );
}

function UsageCell({
  label,
  value,
  sub,
  accent = "text-bone",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="text-[0.6875rem] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-[0.8125rem] font-medium tabular-nums ${accent}`}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-[0.6875rem] text-muted">{sub}</div>
      )}
    </div>
  );
}

function ComputeAllocationChart({
  apiMTok,
  apiPf,
  apiModelUsage,
  plans,
  ledger,
  headroom,
  children,
}: {
  apiMTok: number;
  apiPf: number;
  apiModelUsage: NonNullable<PlanDayStats["modelUsage"]>;
  plans: PlanDayStats[];
  ledger?: ComputeLedger;
  headroom: number;
  children?: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState("api");
  const colors = [
    "var(--color-mint)",
    "var(--color-infer)",
    "var(--color-amber)",
    "var(--color-research)",
    "var(--color-train)",
    "var(--color-gold)",
  ];
  const segments = [
    {
      id: "api",
      label: "API",
      mtok: apiMTok,
      pf: apiPf,
      subscribers: null as number | null,
      modelUsage: apiModelUsage,
    },
    ...plans.map((plan) => ({
      id: plan.planId,
      label: plan.name,
      mtok: plan.dayMTok,
      pf: plan.dayInferPf,
      subscribers: plan.subscribers,
      modelUsage: plan.modelUsage ?? [],
    })),
  ];
  const totalPf = segments.reduce((sum, segment) => sum + segment.pf, 0);
  const totalMTok = segments.reduce((sum, segment) => sum + segment.mtok, 0);
  const selected =
    segments.find((segment) => segment.id === selectedId) ?? segments[0]!;

  return (
    <section
      className="rounded-lg border border-line bg-panel-2 p-3"
      aria-label="Compute allocation"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-bone">
            Serving compute allocation
          </h3>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
            PF share by API and plan. Hover or select a lane to inspect
            token-normalized model usage.
          </p>
        </div>
        <div className="shrink-0 text-right font-mono">
          <div className="text-[0.8125rem] font-semibold text-bone">
            {num(totalMTok, 2)} MTok/d
          </div>
          <div className="text-[0.625rem] text-muted">
            {num(totalPf, 1)} PF served
          </div>
        </div>
      </div>

      <div className="mt-3 flex h-14 overflow-hidden rounded-lg border border-line bg-void">
        {segments
          .filter((segment) => segment.pf > 0 || segment.mtok > 0)
          .map((segment, index) => {
            const basis =
              totalPf > 0
                ? segment.pf / totalPf
                : segment.mtok / Math.max(totalMTok, 1e-9);
            return (
              <button
                key={segment.id}
                type="button"
                onMouseEnter={() => setSelectedId(segment.id)}
                onFocus={() => setSelectedId(segment.id)}
                onClick={() => setSelectedId(segment.id)}
                aria-pressed={selected.id === segment.id}
                className={`min-w-[3.5rem] border-r border-void/50 px-1.5 text-center transition last:border-r-0 ${selected.id === segment.id ? "brightness-125" : "hover:brightness-110"}`}
                style={{
                  width: `${Math.max(7, basis * 100)}%`,
                  backgroundColor: colors[index % colors.length],
                }}
                title={`${segment.label}: ${num(segment.mtok, 2)} MTok/day · ${num(segment.pf, 2)} PF`}
              >
                <span className="block truncate text-[0.6875rem] font-semibold text-white">
                  {segment.label}
                </span>
                <span className="block font-mono text-[0.625rem] text-white/80">
                  {Math.round(basis * 100)}%
                </span>
              </button>
            );
          })}
      </div>

      <div className="mt-2.5 rounded-lg border border-line/60 bg-void/45 p-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-[0.8125rem] font-semibold text-bone">
              {selected.label}
            </span>
            <span className="ml-2 font-mono text-[0.6875rem] text-muted">
              {num(selected.mtok, 2)} MTok/d · {num(selected.pf, 2)} PF
            </span>
          </div>
          {selected.subscribers != null ? (
            <span className="font-mono text-[0.6875rem] text-mint">
              {people(selected.subscribers)} users
            </span>
          ) : (
            <span className="font-mono text-[0.6875rem] text-infer">
              input + output tokens
            </span>
          )}
        </div>
        <div className="mt-2 space-y-1.5">
          {selected.modelUsage.length > 0 ? (
            selected.modelUsage.map((usage) => (
              <div
                key={usage.modelId}
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 font-mono text-[0.6875rem]"
              >
                <div className="min-w-0">
                  <div className="flex justify-between gap-2">
                    <span className="truncate text-bone">{usage.name}</span>
                    <span className="text-muted">
                      {Math.round(usage.share * 100)}%
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line/50">
                    <div
                      className="h-full bg-infer"
                      style={{ width: `${Math.max(2, usage.share * 100)}%` }}
                    />
                  </div>
                </div>
                <span className="text-muted">{num(usage.dayMTok, 2)} MTok</span>
                <span className="text-amber">
                  {num(usage.dayInferPf, 2)} PF
                </span>
              </div>
            ))
          ) : (
            <p className="text-[0.6875rem] text-muted">
              No served model traffic today.
            </p>
          )}
        </div>
      </div>

      {ledger ? <WorkloadLedger ledger={ledger} headroom={headroom} /> : null}

      {children ? (
        <div className="mt-3 border-t border-line/60 pt-3">{children}</div>
      ) : null}
    </section>
  );
}

function nativeWorkSummary(
  items: ComputeLedger["items"],
  stage: "requested" | "admitted" | "served" | "billed",
): string {
  const totals = items.reduce<Required<NativeWorkUnits>>(
    (sum, item) => {
      const units = item[stage];
      for (const key of Object.keys(sum) as (keyof NativeWorkUnits)[]) {
        sum[key] += Math.max(0, units[key] ?? 0);
      }
      return sum;
    },
    {
      inputMTok: 0,
      cachedInputMTok: 0,
      outputMTok: 0,
      reasoningMTok: 0,
      toolCalls: 0,
      images: 0,
      megapixelSteps: 0,
      audioSeconds: 0,
      videoSeconds: 0,
    },
  );
  const parts: string[] = [];
  const textMTok = totals.inputMTok + totals.outputMTok + totals.reasoningMTok;
  if (textMTok > 0) parts.push(`${num(textMTok, 2)}M tok`);
  if (totals.images > 0) parts.push(`${num(totals.images, 0)} img`);
  if (totals.audioSeconds > 0)
    parts.push(`${num(totals.audioSeconds / 60, 1)} min audio`);
  if (totals.videoSeconds > 0)
    parts.push(`${num(totals.videoSeconds, 1)}s video`);
  return parts.join(" · ") || "0 native work";
}

function WorkloadLedger({
  ledger,
  headroom,
}: {
  ledger: ComputeLedger;
  headroom: number;
}) {
  const usablePf = ledger.capacityPfDays / (1 + Math.max(0, headroom));
  const utilization =
    usablePf > 0 ? Math.min(1, ledger.servedPfDays / usablePf) : 0;
  const latencyReservePf = Math.max(0, ledger.capacityPfDays - usablePf);
  const channelRows = [
    {
      id: "api",
      label: "API",
      items: ledger.items.filter((item) => item.channel === "api"),
      tone: "bg-infer",
      text: "text-infer",
    },
    {
      id: "subscription",
      label: "Plans",
      items: ledger.items.filter((item) => item.channel === "subscription"),
      tone: "bg-mint",
      text: "text-mint",
    },
  ].filter((channel) => channel.items.length > 0);
  const stages = [
    {
      label: "Requested",
      summary: nativeWorkSummary(ledger.items, "requested"),
      pf: ledger.requestedPfDays,
      tone: "text-bone",
    },
    {
      label: "Admitted",
      summary: nativeWorkSummary(ledger.items, "admitted"),
      pf: ledger.admittedPfDays,
      tone: "text-infer",
    },
    {
      label: "Served",
      summary: nativeWorkSummary(ledger.items, "served"),
      pf: ledger.servedPfDays,
      tone: "text-mint",
    },
    {
      label: "Billed",
      summary: nativeWorkSummary(ledger.items, "billed"),
      pf: ledger.billedPfDays,
      tone: "text-amber",
    },
  ];

  return (
    <section
      aria-label="Daily serving workload ledger"
      className="mt-2.5 overflow-hidden rounded-lg border border-line/60 bg-void/45"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-2.5 py-1.5">
        <div>
          <h4 className="text-[0.75rem] font-semibold text-bone">
            Workload ledger
          </h4>
          <p className="text-[0.625rem] text-muted">
            Every admitted unit resolves once through service and billing.
          </p>
        </div>
        <div className="text-right font-mono">
          <div className="text-[0.75rem] font-semibold text-mint">
            {Math.round(utilization * 100)}% used
          </div>
          <div className="text-[0.5625rem] text-muted">
            of post-reserve capacity
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-line/60 bg-line/50 sm:grid-cols-4">
        {stages.map((stage, index) => (
          <div
            key={stage.label}
            className="min-w-0 bg-void/90 px-1.5 py-2 text-center"
            title={`${num(stage.pf, 3)} PF-days`}
          >
            <div className="truncate text-[0.5625rem] uppercase tracking-wide text-muted">
              {index > 0 ? "→ " : ""}
              {stage.label}
            </div>
            <div
              className={`mt-0.5 truncate font-mono text-[0.75rem] font-semibold ${stage.tone}`}
            >
              {stage.summary}
            </div>
            <div className="truncate font-mono text-[0.5625rem] text-muted">
              {num(stage.pf, 2)} PF-d
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-1.5 px-2.5 py-2">
        {channelRows.map((channel) => {
          const requestedPf = channel.items.reduce(
            (sum, item) => sum + item.requestedPfDays,
            0,
          );
          const servedPf = channel.items.reduce(
            (sum, item) => sum + item.servedPfDays,
            0,
          );
          const servedFraction =
            requestedPf > 0 ? Math.min(1, servedPf / requestedPf) : 1;
          return (
            <div
              key={channel.id}
              className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-2"
            >
              <span className={`text-[0.6875rem] font-medium ${channel.text}`}>
                {channel.label}
              </span>
              <div className="h-1.5 overflow-hidden rounded-full bg-line/50">
                <div
                  className={`h-full ${channel.tone}`}
                  style={{ width: `${servedFraction * 100}%` }}
                />
              </div>
              <span
                className="font-mono text-[0.625rem] text-muted"
                title={`Billed: ${nativeWorkSummary(channel.items, "billed")}`}
              >
                {nativeWorkSummary(channel.items, "served")}
              </span>
            </div>
          );
        })}

        <div className="grid gap-1 pt-0.5 font-mono text-[0.5625rem] text-muted sm:grid-cols-3">
          <span title="Capacity held back for p95 traffic and latency spikes">
            latency reserve{" "}
            <b className="text-bone">{num(latencyReservePf, 2)} PF-d</b>
          </span>
          <span
            className="sm:text-center"
            title="Work admitted from the API and plan channel guarantees"
          >
            channel reserve{" "}
            <b className="text-bone">{num(ledger.reservedPfDays, 2)} PF-d</b>
          </span>
          <span
            className="sm:text-right"
            title="Unused channel reservation reassigned to waiting work"
          >
            backfill{" "}
            <b className="text-mint">{num(ledger.backfilledPfDays, 2)} PF-d</b>
          </span>
        </div>
      </div>
    </section>
  );
}

const PLAN_PRECISION_LABELS: Record<PlanServePrecision, string> = {
  fp16: "FP16",
  bf16: "BF16",
  fp8: "FP8",
  int8: "INT8",
  int4: "INT4",
  nvfp4: "NVFP4",
  ternary_1_58: "1.58-bit",
};

function PlanModelRoster({
  plan,
  models,
  unlocked,
  onChange,
}: {
  plan: SubPlan;
  models: Model[];
  unlocked: string[];
  onChange: (patch: Partial<SubPlan>) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const selectedModels = plan.modelIds
    .map((modelId) => models.find((model) => model.id === modelId))
    .filter((model): model is Model => Boolean(model));
  const selectedIds = new Set(selectedModels.map((model) => model.id));
  const availableModels = models.filter((model) => !selectedIds.has(model.id));

  const addModel = (model: Model) => {
    const precision = planModelServePrecision(plan, model, unlocked);
    onChange({
      modelIds: [...plan.modelIds, model.id],
      servePrecisionByModel: {
        ...(plan.servePrecisionByModel ?? {}),
        [model.id]: precision,
      },
    });
    setExpandedModelId(model.id);
    setAddOpen(false);
  };

  const removeModel = (modelId: string) => {
    const precisionByModel = { ...(plan.servePrecisionByModel ?? {}) };
    delete precisionByModel[modelId];
    onChange({
      modelIds: plan.modelIds.filter((id) => id !== modelId),
      servePrecisionByModel: precisionByModel,
    });
    if (expandedModelId === modelId) setExpandedModelId(null);
  };

  const setPrecision = (modelId: string, precision: PlanServePrecision) => {
    onChange({
      servePrecisionByModel: {
        ...(plan.servePrecisionByModel ?? {}),
        [modelId]: precision,
      },
    });
  };

  return (
    <section className="rounded-lg border border-line/60 bg-void/45 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[0.75rem] font-medium text-bone">
            Models on this plan
          </div>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
            Add released models, then open one to choose its serving precision.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen((open) => !open)}
          disabled={availableModels.length === 0}
          className="shrink-0 rounded-full border border-mint/35 bg-mint/10 px-2.5 py-1 text-[0.75rem] font-medium text-mint disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add model
        </button>
      </div>

      {addOpen ? (
        <div className="mt-2 grid grid-cols-1 gap-1 rounded-lg border border-mint/25 bg-panel-2/70 p-1.5 sm:grid-cols-2">
          {availableModels.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => addModel(model)}
              className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-mint/10"
            >
              <span className="truncate text-[0.75rem] font-medium text-bone">
                {model.name}
              </span>
              <span className="shrink-0 font-mono text-[0.625rem] text-muted">
                {model.paramsB < 1
                  ? `${Math.round(model.paramsB * 1_000)}M`
                  : `${num(model.paramsB, 1)}B`}{" "}
                · cap {num(model.capability, 0)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-2 space-y-1.5">
        {selectedModels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-2.5 py-3 text-center text-[0.75rem] text-muted">
            No model is available on this plan yet.
          </div>
        ) : (
          selectedModels.map((model) => {
            const expanded = expandedModelId === model.id;
            const precision = planModelServePrecision(plan, model, unlocked);
            const precisionOptions = availablePlanPrecisionsForModel(
              model,
              unlocked,
            );
            const modifiers = planServeModifiers(precision, unlocked);
            const modalityLabel =
              model.productPreset?.replaceAll("_", " ") ??
              model.modalities.join(" · ");
            return (
              <article
                key={model.id}
                className="overflow-hidden rounded-lg border border-line/50 bg-panel-2/55"
              >
                <div className="flex items-center gap-1.5 p-1.5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedModelId(expanded ? null : model.id)
                    }
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-void/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[0.75rem] font-semibold text-bone">
                        {model.name}
                      </span>
                      <span className="block truncate text-[0.625rem] capitalize text-muted">
                        {modalityLabel}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-mono">
                      <span className="block text-[0.6875rem] font-semibold text-infer">
                        {PLAN_PRECISION_LABELS[precision]}
                      </span>
                      <span className="block text-[0.5625rem] text-muted">
                        compute ×{modifiers.computeMult.toFixed(2)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${model.name} from ${plan.name}`}
                    title="Remove model from plan"
                    onClick={() => removeModel(model.id)}
                    className="rounded-md px-1.5 py-1 text-[0.75rem] text-muted hover:bg-danger/10 hover:text-danger"
                  >
                    ×
                  </button>
                </div>

                {expanded ? (
                  <div className="border-t border-line/50 px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      {precisionOptions.map((option) => {
                        const active = option === precision;
                        const preview = planServeModifiers(option, unlocked);
                        return (
                          <button
                            key={option}
                            type="button"
                            title={`${preview.label} · ${Math.round(preview.computeMult * 100)}% serving compute`}
                            onClick={() => setPrecision(model.id, option)}
                            className={`rounded-full px-2 py-1 font-mono text-[0.6875rem] ${
                              active
                                ? "bg-infer/25 text-infer ring-1 ring-infer/40"
                                : "bg-void text-muted hover:text-bone"
                            }`}
                          >
                            {PLAN_PRECISION_LABELS[option]}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-1.5 text-[0.625rem] leading-snug text-muted">
                      {modifiers.label} uses{" "}
                      {Math.round(modifiers.computeMult * 100)}% of
                      full-precision serve compute
                      {modifiers.capabilityDelta
                        ? ` · capability ${modifiers.capabilityDelta}`
                        : " · no fixed capability penalty"}
                      .
                    </p>
                    {precisionOptions.length <= 2 ? (
                      <ResearchUnlockLink
                        className="mt-1.5"
                        nodeId="sys_quant"
                        label="Research serving quantization for more formats"
                      />
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

type PlanEntitlementRow = ReturnType<typeof planModelEntitlements>[number];

export function PlanEntitlementBreakdown({
  planId,
  entitlements,
}: {
  planId: string;
  entitlements: PlanEntitlementRow[];
}) {
  if (entitlements.length === 0) {
    return (
      <p className="mt-1.5 text-[0.6875rem] text-amber">
        Assign released models to see API-equivalent allowances.
      </p>
    );
  }

  return (
    <>
      <div
        className="mt-1.5 space-y-1.5 sm:hidden"
        data-testid={`mobile-entitlements-${planId}`}
      >
        {entitlements.map((row) => (
          <div
            key={row.modelId}
            className="rounded-md border border-line/45 bg-panel-2/55 px-2 py-1.5 font-mono text-[0.6875rem]"
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="min-w-0 truncate font-medium text-bone">
                {row.name}
              </strong>
              <span className="shrink-0 text-muted">
                {Math.round(row.trafficShare * 100)}% traffic
              </span>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted">
              <span>API eq. {num(row.includedMTokPerMonth, 2)} MTok</span>
              <span className="text-right">
                ~{num(row.interactionsPerDay, 0)} msg/d
              </span>
              <span>Util {Math.round(row.expectedUtilization * 100)}%</span>
              <span className="text-right text-danger">
                COGS{" "}
                {row.rawServingCostPerMonth != null
                  ? money(row.rawServingCostPerMonth)
                  : "—"}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[28rem] border-collapse text-left font-mono text-[0.6875rem]">
          <thead>
            <tr className="text-muted">
              <th className="pb-1 pr-2 font-medium">Model</th>
              <th className="pb-1 pr-2 font-medium">API eq.</th>
              <th className="pb-1 pr-2 font-medium">Msgs/day</th>
              <th className="pb-1 pr-2 font-medium">Util</th>
              <th className="pb-1 font-medium">Raw COGS</th>
            </tr>
          </thead>
          <tbody>
            {entitlements.map((row) => (
              <tr key={row.modelId} className="border-t border-line/40">
                <td className="max-w-[8rem] truncate py-1 pr-2 text-bone">
                  {row.name}
                  <span className="text-muted">
                    {" "}· {Math.round(row.trafficShare * 100)}%
                  </span>
                </td>
                <td className="py-1 pr-2 text-bone">
                  {num(row.includedMTokPerMonth, 2)} MTok
                </td>
                <td className="py-1 pr-2 text-bone">
                  ~{num(row.interactionsPerDay, 0)}
                </td>
                <td className="py-1 pr-2 text-muted">
                  {Math.round(row.expectedUtilization * 100)}%
                </td>
                <td className="py-1 text-danger">
                  {row.rawServingCostPerMonth != null
                    ? money(row.rawServingCostPerMonth)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PlanCard({
  plan,
  stats,
  models,
  allPlans,
  unitCogs,
  apiList,
  modelCap,
  frontierCap,
  peerPlans,
  offeringBreadth,
  onChange,
  onDelete,
}: {
  plan: SubPlan;
  stats?: PlanDayStats;
  models: Model[];
  allPlans: SubPlan[];
  unitCogs: number;
  apiList: number;
  modelCap: number;
  frontierCap: number;
  peerPlans: {
    price: number;
    includedMTokPerMonth: number;
    capability: number;
    featureScore: number;
  }[];
  offeringBreadth: PlanOfferingBreadth;
  onChange: (p: Partial<SubPlan>) => void;
  onDelete: () => void;
}) {
  const unlocked = useGameStore((s) => s.state.player.researchUnlocked);
  const free = isFreePlan(plan);
  const subs = stats?.subscribers ?? 0;
  const allowanceDay = planAllowanceMTokPerDay(plan);
  const allowanceMo = planAllowanceMTokPerMonth(plan);
  // Actual tokens burned per seat today (if any traffic)
  const usedPerUserDay = subs > 0.5 ? (stats?.dayMTok ?? 0) / subs : 0;
  const usedPerUserMo = usedPerUserDay * ECONOMY.daysPerMonth;
  const fill =
    allowanceDay > 0
      ? Math.min(1.25, usedPerUserDay / Math.max(1e-9, allowanceDay))
      : 0;

  const revPerUserMo = free
    ? 0
    : subs > 0.5
      ? ((stats?.dayRevenue ?? 0) * ECONOMY.daysPerMonth) / subs
      : plan.pricePerMonth;
  const marginPerUserMo = planMarginPerSubMonth({
    plan,
    isFree: free,
    unitCostPerMTok: unitCogs,
    allowanceMTokPerDay: allowanceDay,
    settlementMarginPerSubMonth: stats?.marginPerSubMonth,
  });
  const cogsPerUserMo =
    subs > 0.5
      ? ((stats?.dayCogs ?? 0) * ECONOMY.daysPerMonth) / subs
      : allowanceDay * unitCogs * ECONOMY.daysPerMonth;
  const computePfPerUser = stats?.computePfPerSubscriber ?? 0;
  const computePfPerUserLabel =
    computePfPerUser > 0 && computePfPerUser < 0.001
      ? computePfPerUser.toExponential(2)
      : num(computePfPerUser, 3);

  const util = 0.65; // sim default for pricing scores only
  const apiEq =
    stats?.apiEquivalentValue ?? planApiEquivalentValue(plan, apiList, util);
  const subsidy = stats?.subsidyRatio ?? planSubsidyRatio(plan, apiList, util);
  const tooHigh =
    stats?.priceTooHigh ??
    planPriceTooHighScore(plan, {
      apiPricePerMTok: apiList,
      modelCapability: modelCap,
      frontierCapability: frontierCap,
      utilization: util,
    });
  const marginBad = marginPerUserMo < 0;
  const seatCap = stats?.maxSeats;
  const seatFill =
    seatCap != null && seatCap > 0 && seatCap < 1e8
      ? Math.min(1, subs / seatCap)
      : null;
  const messagesPerDay =
    (allowanceMo * 1_000_000) / ECONOMY.daysPerMonth / 2_000;
  const freeDemandProfile = free ? freeTierDemandProfile(plan) : null;
  const planStatus = analyzePlanPricing({
    price: plan.pricePerMonth,
    includedMTokPerMonth: allowanceMo,
    expectedUtilization: stats?.usageRate ?? util,
    marginalCostPerMTok: unitCogs,
    capability: modelCap,
    featureScore: 0,
    peers: peerPlans,
  });
  const premiumScrutiny = premiumPlanScrutiny(plan, allPlans);
  const simState = useGameStore((s) => s.state);
  const allowanceExpectation = planAllowanceExpectation(plan, allowanceMo, {
    valueRatio: planAdvertisedValueRatio(plan, apiList, allowanceMo),
    rivalValueRatio: rivalNearestValueRatio(
      simState,
      plan.pricePerMonth,
      apiList,
    ),
  });
  const dissatisfaction =
    stats?.dissatisfaction ?? allowanceExpectation.dissatisfaction;
  const subsidyGbp = planMonthlyApiValueSubsidy(plan, apiList);
  const enterpriseExpect = enterpriseSubsidyExpectation(plan, subsidyGbp);
  const entitlements = planModelEntitlements(simState, plan, {
    modelCapability: modelCap,
    frontierCapability: frontierCap,
    rawCostPerMTok: (model) => {
      const precision = planModelServePrecision(plan, model, unlocked);
      const mods = planServeModifiers(precision, unlocked);
      const serveModel = modelForServePrecision(model, precision, unlocked);
      const unit = apiUnitCostPerMTok(
        simState,
        computeSnapshot(simState),
        serveModel,
      );
      return Math.max(0.005, unit.blended * mods.computeMult);
    },
  });
  const rawCogsMo = entitlements.reduce(
    (sum, row) => sum + (row.rawServingCostPerMonth ?? 0),
    0,
  );
  const impossibleServing =
    !free &&
    (planStatus.primary === "unsustainable_plan" ||
      (rawCogsMo > 0 && rawCogsMo > plan.pricePerMonth * 0.9));

  return (
    <div
      data-testid={`subscription-plan-card-${plan.id}`}
      className={`overflow-hidden rounded-lg border ${
        free
          ? "border-amber/30 bg-amber/5"
          : plan.enabled
            ? "border-line bg-panel-2"
            : "border-line/50 bg-void/40 opacity-75"
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line/50 px-3 py-2">
        <input
          value={plan.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="min-w-0 basis-full bg-transparent text-sm font-semibold text-bone outline-none sm:flex-1 sm:basis-auto"
        />
        {free && (
          <span className="shrink-0 rounded-full bg-amber/20 px-2 py-0.5 text-[0.6875rem] font-medium text-amber">
            FREE
          </span>
        )}
        {planStatus.primary !== "unsustainable_plan" ? (
          <PricingPill
            status={planStatus.primary}
            severity={planStatus.severity}
          />
        ) : null}
        {marginBad && !free ? (
          <StatusChip tone="danger">Losing money / sub</StatusChip>
        ) : null}
        {dissatisfaction > 0.05 ? (
          <StatusChip tone="danger">
            <span
              title={
                allowanceExpectation.dissatisfaction > 0
                  ? "Included usage is below what customers expect at this price and capability."
                  : "Reliability or available compute is reducing satisfaction."
              }
            >
              {Math.round(dissatisfaction * 100)}% dissatisfied
            </span>
          </StatusChip>
        ) : null}
        <label className="flex min-h-11 shrink-0 items-center gap-2 px-1 text-[0.75rem] text-muted">
          <input
            type="checkbox"
            checked={plan.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          Live
        </label>
      </div>

      {/* Live KPIs — the things you glance at */}
      <div className="grid grid-cols-2 gap-px bg-line/40 sm:grid-cols-4">
        <KpiCell
          label="Subscribers"
          value={people(subs)}
          sub={
            seatCap != null && seatCap < 1e8
              ? `cap ${people(seatCap)}`
              : "open seats"
          }
          bar={seatFill}
        />
        <KpiCell
          label="Rev / user / mo"
          value={free ? "$0" : money(revPerUserMo)}
          sub={free ? "no charge" : `list ${money(plan.pricePerMonth)}`}
          accent={free ? "text-muted" : "text-bone"}
        />
        <KpiCell
          label="Margin / user / mo"
          value={money(marginPerUserMo)}
          sub={
            stats
              ? `compute ${money(cogsPerUserMo)}/mo`
              : `est. compute ${money(cogsPerUserMo)}/mo`
          }
          accent={marginBad ? "text-danger" : "text-mint"}
        />
        <KpiCell
          label="Usage / user"
          value={subs > 0.5 ? `${num(usedPerUserDay, 3)} MTok/d` : "—"}
          sub={
            subs > 0.5
              ? `${num(usedPerUserMo, 1)} MTok/mo · ${Math.round(fill * 100)}% of include`
              : `include ${formatAllowance(plan)}`
          }
          bar={subs > 0.5 ? Math.min(1, fill) : null}
          barWarn={fill > 1}
        />
      </div>

      {/* Token include + pricing controls */}
      <div className="space-y-2.5 px-3 py-2.5">
        {marginBad && !free ? (
          <StatusChip tone="danger">Negative margin / sub</StatusChip>
        ) : null}
        {impossibleServing ? (
          <StatusChip tone="danger">
            Impossible serving — expected COGS exceed ~90% of price
          </StatusChip>
        ) : null}
        {enterpriseExpect.applies && enterpriseExpect.shortfall > 0 ? (
          <StatusChip tone="warning">
            Enterprise needs ≥{ENTERPRISE_SUBSIDY_PRICE_MULTIPLE}× price in API
            value ({money(enterpriseExpect.requiredSubsidyGbp)}+/mo)
          </StatusChip>
        ) : null}
        {!free && messagesPerDay < PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY ? (
          <StatusChip tone="warning">
            Below pro workload — enterprise & pro users expect ≥
            {PLAN_PRO_WORKLOAD_MESSAGES_PER_DAY} msg/day and pick higher tiers
          </StatusChip>
        ) : null}

        <label className="block text-[0.75rem] text-muted">
          Price $/mo
          <DraftNumberInput
            ariaLabel={`${plan.name} monthly price`}
            min={0}
            step={1}
            value={plan.pricePerMonth}
            decimals={2}
            onCommit={(next) => onChange({ pricePerMonth: next })}
            className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-sm text-bone outline-none sm:max-w-[12rem]"
          />
        </label>

        {/* comment 14: Capacity & value — subsidy, seats, compute priority */}
        <div className="rounded-lg border border-line/60 bg-void/45 px-2.5 py-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[0.75rem] font-medium text-bone">
                Capacity & value
              </div>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
                Fixed included usage, enrollment cap, and PF share under load.
                Includes {formatAllowance(plan)}
                {freeDemandProfile
                  ? ` · ${freeDemandProfile.label}`
                  : ` · ~${num(messagesPerDay, 0)} msg/day`}
                .
              </p>
            </div>
            <div className="shrink-0 text-right font-mono text-[0.6875rem]">
              <div className="text-mint">{planComputePriority(plan)}/100</div>
              <div className="text-muted">
                served {Math.round((stats?.serveFraction ?? 1) * 100)}%
              </div>
            </div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <label className="text-[0.75rem] text-muted">
              Included usage (MTok/month)
              <DraftNumberInput
                ariaLabel={`${plan.name} included MTok per month`}
                min={0.01}
                step={1}
                value={allowanceMo}
                decimals={2}
                onCommit={(next) => onChange({ includedMTokPerMonth: next })}
                className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-sm text-bone outline-none"
              />
              <span className="mt-0.5 block text-[0.625rem]">
                API-equivalent value today: {money(subsidyGbp)}
              </span>
            </label>
            <label className="text-[0.75rem] text-muted">
              Subscriber limit
              <DraftNumberInput
                ariaLabel={`${plan.name} subscriber limit`}
                min={0}
                step={1000}
                value={plan.subscriberCap ?? 0}
                decimals={0}
                onCommit={(next) =>
                  onChange({ subscriberCap: next > 0 ? next : undefined })
                }
                className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-sm text-bone outline-none"
              />
              <span className="mt-0.5 block text-[0.625rem]">
                0 = open enrollment
              </span>
            </label>
            <div className="text-[0.75rem] text-muted">
              Compute priority
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={planComputePriority(plan)}
                onChange={(event) =>
                  onChange({ computePriority: Number(event.target.value) })
                }
                className="slider-track mt-2 w-full"
                aria-label={`${plan.name} compute priority`}
              />
              <div className="mt-0.5 flex justify-between font-mono text-[0.625rem]">
                <span>best effort</span>
                <span>protected</span>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-line/60 bg-void/45 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.75rem] font-medium text-bone">
              Per-model entitlements
            </span>
            <span className="font-mono text-[0.625rem] text-muted">
              subsidy ÷ model API list
            </span>
          </div>
          <PlanEntitlementBreakdown
            planId={plan.id}
            entitlements={entitlements}
          />
          {subs > 0.5 ? (
            <div className="mt-1.5">
              <div className="mb-0.5 flex justify-between text-[0.6875rem] text-muted">
                <span>
                  Used {num(usedPerUserDay, 3)} MTok/user ·{" "}
                  {num(allowanceDay, 3)} MTok/d include
                </span>
                <span className={fill > 1 ? "text-amber" : "text-mint"}>
                  {Math.round(fill * 100)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-void">
                <div
                  className={`h-full ${fill > 1 ? "bg-amber" : "bg-infer"}`}
                  style={{ width: `${Math.min(100, fill * 100)}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        {(() => {
          const collectCap = maxPlanDataCollectionShare(plan.pricePerMonth);
          const collectLocked = collectCap <= 0;
          const collectSetting = clampPlanDataCollectionRate(
            plan.pricePerMonth,
            plan.dataCollectionRate ??
              defaultPlanDataCollectionRate(plan.pricePerMonth),
          );
          const collectEffective = effectivePlanDataCollectionRate(
            plan.pricePerMonth,
            collectSetting,
          );
          return (
            <label className="block text-[0.75rem] text-muted">
              <span className="flex items-center justify-between gap-2">
                <span>Chat data collection</span>
                <strong className="font-mono tabular-nums text-bone">
                  {collectLocked
                    ? "Locked"
                    : `${Math.round(collectEffective * 100)}% eff.`}
                </strong>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                disabled={collectLocked}
                value={Math.round(collectSetting * 100)}
                onChange={(e) =>
                  onChange({
                    dataCollectionRate: Number(e.target.value) / 100,
                  })
                }
                className="mt-1.5 w-full disabled:opacity-40"
                aria-label={`${plan.name} chat data collection rate`}
              />
              <span className="mt-0.5 block text-[0.6875rem] leading-snug">
                {collectLocked
                  ? `Plans above $${PAID_DATA_COLLECTION_PRICE_CAP}/mo cannot retain traffic.`
                  : free
                    ? "Free traffic may be collected up to 100%."
                    : `Paid cap ${Math.round(collectCap * 100)}% at $${plan.pricePerMonth.toFixed(0)}/mo (lerp 20%→10% through $${PAID_DATA_COLLECTION_PRICE_CAP}).`}
              </span>
            </label>
          );
        })()}

        {/* Day totals */}
        <PlanModelRoster
          plan={plan}
          models={models}
          unlocked={unlocked}
          onChange={onChange}
        />

        <div className="grid grid-cols-2 gap-1.5 font-mono text-[0.75rem] sm:grid-cols-4">
          <Mini label="Day rev" value={money(stats?.dayRevenue ?? 0)} />
          <Mini
            label="Allocated serve ops"
            value={money(stats?.dayCogs ?? 0)}
            danger
          />
          <Mini label="PF / served user" value={computePfPerUserLabel} />
          <Mini label="Day MTok" value={num(stats?.dayMTok ?? 0, 2)} />
        </div>

        {(stats?.modelUsage?.length ?? 0) > 0 ? (
          <div className="rounded-lg border border-line/60 bg-void/45 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.75rem] font-medium text-bone">
                Actual model utilization
              </span>
              <span className="font-mono text-[0.625rem] text-muted">
                tokens × model compute × precision
              </span>
            </div>
            <div className="mt-1.5 space-y-1">
              {stats!.modelUsage!.map((usage) => (
                <div
                  key={usage.modelId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 font-mono text-[0.6875rem] sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                >
                  <span className="truncate text-bone">
                    {usage.name} · {Math.round(usage.share * 100)}%
                  </span>
                  <span className="text-muted">
                    {num(usage.dayMTok, 2)} MTok
                  </span>
                  <span className="col-start-2 text-right text-danger sm:col-auto">
                    {money(usage.dayMTok * usage.costPerMTok)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {premiumScrutiny.applies ? (
          <div
            className={`rounded-lg border px-2.5 py-2 ${premiumScrutiny.shortfall > 0 ? "border-amber/45 bg-amber/10" : "border-mint/30 bg-mint/5"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className={`text-[0.75rem] font-semibold ${premiumScrutiny.shortfall > 0 ? "text-amber" : "text-mint"}`}
              >
                Premium-plan scrutiny
              </span>
              <span className="font-mono text-[0.6875rem] text-bone">
                {premiumScrutiny.actualUsageRatio.toFixed(1)}× /{" "}
                {premiumScrutiny.expectedUsageRatio}× expected
              </span>
            </div>
            <p className="mt-1 text-[0.6875rem] leading-snug text-muted">
              At {money(plan.pricePerMonth)}/mo, customers compare this with{" "}
              {premiumScrutiny.entryPlanName}. Anything below 20× its included
              usage is criticized and loses demand; rivals face the same rule.
            </p>
          </div>
        ) : null}

        {!free && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.75rem] text-muted">
            <span>
              API value of include{" "}
              <span className="text-bone">{money(apiEq)}/mo</span>
            </span>
            <span
              className={
                subsidy >= 1.05
                  ? "text-amber"
                  : subsidy < 0.75
                    ? "text-danger"
                    : "text-mint"
              }
            >
              {Number.isFinite(subsidy) ? `${subsidy.toFixed(2)}×` : "∞"} vs
              price
              {subsidy >= 1.05
                ? " · subsidizing"
                : subsidy < 0.75
                  ? " · dear vs API"
                  : " · fair"}
            </span>
            {tooHigh > 0.25 && (
              <span className="text-danger">
                price pressure {Math.round(tooHigh * 100)}%
              </span>
            )}
            {planStatus.primary !== "fair" && (
              <span
                className={
                  planStatus.severity === "danger"
                    ? "text-danger"
                    : "text-amber"
                }
              >
                {planStatus.explanation}
              </span>
            )}
          </div>
        )}
        <div>
          <div className="hidden rounded-lg border border-infer/25 bg-infer/5 px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[0.75rem] font-medium text-bone">
                  Offering breadth
                </div>
                <p className="mt-0.5 text-[0.6875rem] text-muted">
                  Best safe generation model per modality.
                </p>
              </div>
              <span className="font-mono text-sm text-infer">
                {offeringBreadth.score.toFixed(2)} / 18
              </span>
            </div>
            {offeringBreadth.contributors.length > 0 ? (
              <div className="mt-2 grid gap-1 sm:grid-cols-3">
                {offeringBreadth.contributors.map((contributor) => (
                  <div
                    key={contributor.modality}
                    className="rounded-md border border-line/60 bg-void/45 px-2 py-1.5"
                  >
                    <div className="flex justify-between font-mono text-[0.625rem] uppercase text-muted">
                      <span>{contributor.modality}</span>
                      <span className="text-mint">
                        +{contributor.points.toFixed(2)}
                      </span>
                    </div>
                    <div
                      className="mt-0.5 truncate text-[0.6875rem] text-bone"
                      title={contributor.modelName}
                    >
                      {contributor.modelName}
                    </div>
                    <div className="font-mono text-[0.625rem] text-muted">
                      suite {contributor.composite.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-[0.6875rem] text-amber">
                Add an image, video, or audio model scoring at least 35 with
                safety at least 30.
              </p>
            )}
          </div>

          <div className="text-[0.75rem] text-muted">Models on this plan</div>
          {models.length === 0 ? (
            <p className="mt-1 text-[0.75rem] text-amber">Ship a model first</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1">
              {models.map((m) => {
                const on = plan.modelIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      const modelIds = on
                        ? plan.modelIds.filter((id) => id !== m.id)
                        : [...plan.modelIds, m.id];
                      onChange({ modelIds });
                    }}
                    className={`rounded-full px-2 py-0.5 text-[0.75rem] ${
                      on ? "bg-mint/20 text-mint" : "bg-void text-muted"
                    }`}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          className="rounded-md border border-danger/35 bg-danger/10 px-2.5 py-1.5 text-[0.75rem] font-medium text-danger hover:bg-danger/20"
          onClick={onDelete}
        >
          Delete plan
        </button>
      </div>
    </div>
  );
}

function KpiCell({
  label,
  value,
  sub,
  accent = "text-bone",
  bar,
  barWarn,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  bar?: number | null;
  barWarn?: boolean;
}) {
  return (
    <div className="bg-panel-2 px-2.5 py-2.5">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className={`mt-0.5 truncate font-mono text-sm font-semibold tabular-nums ${accent}`}
      >
        {value}
      </div>
      {sub && (
        <div
          title={sub}
          className="mt-0.5 truncate font-mono text-[0.6875rem] leading-snug text-muted"
        >
          {sub}
        </div>
      )}
      {bar != null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-void">
          <div
            className={`h-full ${barWarn ? "bg-amber" : "bg-mint/80"}`}
            style={{ width: `${Math.max(0, Math.min(100, bar * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Mini({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="text-[0.6875rem] uppercase text-muted">{label}</div>
      <div
        className={`font-mono text-[0.8125rem] ${danger ? "text-danger" : "text-bone"}`}
      >
        {value}
      </div>
    </div>
  );
}
