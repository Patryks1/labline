import { type ReactNode, useEffect, useRef, useState } from "react";
import { ECONOMY } from "../../../sim/balance/economy";
import {
  analyzeApiPricing,
  analyzePlanPricing,
  blendApiPrice,
  fullyLoadedApiCostFloor,
  modelCostMult,
  serveInfraCost,
  splitInOutMTok,
} from "../../../sim/balance/pricing";
import { energyPriceForState } from "../../../sim/systems/map";
import {
  formatAllowance,
  freeTierDemandProfile,
  isFreePlan,
  planAllowanceMTokPerDay,
  planAllowanceMTokPerMonth,
  planApiEquivalentValue,
  planAllowanceExpectation,
  planComputePriority,
  planOfferingBreadth,
  availablePlanPrecisionsForModel,
  planModelServePrecision,
  planPriceTooHighScore,
  premiumPlanScrutiny,
  planServeModifiers,
  modelForServePrecision,
  planSubsidyRatio,
  unlockedPlanPrecisions,
} from "../../../sim/systems/plans";
import type { PlanOfferingBreadth } from "../../../sim/systems/plans";
import { useGameStore } from "../../../store/gameStore";
import { money, num, people } from "../format";
import type {
  Model,
  ComputeLedger,
  NativeWorkUnits,
  PlanDayStats,
  PlanServePrecision,
  SubPlan,
} from "../../../sim/types";
import { computeSnapshot } from "../../../sim/tick";
import { SliderField } from "../ui/SliderField";
import { ResearchUnlockLink } from "../ui/ResearchUnlockLink";
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from "../ui/HudPrimitives";
import { GameCard, MeterBar, SegmentedTabs } from "../ui/kit";

function formatNumberDraft(value: number, decimals?: number): string {
  return decimals == null ? String(value) : value.toFixed(decimals);
}

function DraftNumberInput({
  value,
  onCommit,
  min,
  max,
  step,
  decimals,
  className,
  ariaLabel,
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  className: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(() => formatNumberDraft(value, decimals));
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(formatNumberDraft(value, decimals));
    }
  }, [value, decimals]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(formatNumberDraft(value, decimals));
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
    setDraft(formatNumberDraft(next, decimals));
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
          setDraft(formatNumberDraft(value, decimals));
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
      .map((model) => ({
        price:
          model.apiPriceInPerMTok != null && model.apiPriceOutPerMTok != null
            ? blendApiPrice(model.apiPriceInPerMTok, model.apiPriceOutPerMTok)
            : rival.pricing.apiPricePerMTok,
        capability: model.capability,
        featureScore: model.modalities.length * 18,
        tokPerSec:
          model.serviceProfile?.interactiveTokPerSec ??
          52 * model.tokPerSecMult,
      })),
  );
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
  const [included, setIncluded] = useState(6);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(
    () => state.player.pricing.plans[0]?.id ?? null,
  );
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [plansTab, setPlansTab] = useState<"tiers" | "api" | "usage">("tiers");

  const blendedList = blendApiPrice(
    active?.apiPriceInPerMTok ??
      active?.suggestedApiPriceIn ??
      pricing.apiPriceInPerMTok,
    active?.apiPriceOutPerMTok ??
      active?.suggestedApiPriceOut ??
      pricing.apiPriceOutPerMTok,
  );

  const modelFinance = state.lastMarket.modelFinance ?? [];
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
          onChange={(id) => setPlansTab(id as "tiers" | "api" | "usage")}
          items={[
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
        {plansTab === "tiers" ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[0.8125rem] text-muted">
                Select a plan to edit offer and unit economics.
              </p>
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
                  className={`min-h-9 shrink-0 rounded-md border px-3 text-[0.75rem] font-medium ${
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
                <div className="grid grid-cols-2 gap-2">
                  <label className="col-span-2 text-[0.8125rem] text-muted sm:col-span-1">
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
                <div className="mt-2">
                  <div className="mb-1 flex justify-between text-[0.8125rem] text-muted">
                    <span>Included tokens / user</span>
                    <span className="font-mono text-bone">
                      {formatAllowance({
                        id: "",
                        name: "",
                        pricePerMonth: price,
                        usageMultiplier:
                          included /
                          (ECONOMY.basePlanUsageMTokPerDay *
                            ECONOMY.daysPerMonth),
                        includedMTokPerMonth: included,
                        usageRate: null,
                        modelIds: [],
                        enabled: true,
                      })}
                    </span>
                  </div>
                  <SliderField
                    label={`${num(included, 2)} MTok/month (~${num((included * 1_000_000) / ECONOMY.daysPerMonth / 2_000, 0)} messages/day)`}
                    value={included}
                    min={0.06}
                    max={60}
                    step={0.06}
                    onChange={setIncluded}
                    colorClass="bg-mint"
                    format={(v) => `${v.toFixed(1)}M`}
                  />
                  <DraftNumberInput
                    ariaLabel="New plan included million tokens per month"
                    min={0.06}
                    max={300}
                    step={0.06}
                    value={included}
                    decimals={2}
                    onCommit={setIncluded}
                    className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1 font-mono text-[0.8125rem] text-bone outline-none"
                  />
                </div>
                <HudButton
                  type="button"
                  variant="primary"
                  className="mt-3 w-full"
                  onClick={() => {
                    createPlan({
                      name,
                      pricePerMonth: price,
                      usageMultiplier:
                        included /
                        (ECONOMY.basePlanUsageMTokPerDay *
                          ECONOMY.daysPerMonth),
                    });
                    setName("Custom");
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
            <div className="flex items-center justify-between gap-2">
              <p className="text-[0.8125rem] text-muted">
                List $/1M tokens · marginal baseline {money(infra.costPerMTok)}
                /MTok
              </p>
              <StatusChip tone="serve">fully loaded floor per model</StatusChip>
            </div>

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
                  const blend = blendApiPrice(pin, pout);
                  const dayMTok = fin?.dayApiMTok ?? 0;
                  const { inMTok, outMTok } = splitInOutMTok(dayMTok);
                  const modelUnit =
                    active != null
                      ? Math.max(
                          0.005,
                          infra.costPerMTok *
                            (modelCostMult(m) /
                              Math.max(0.08, modelCostMult(active))),
                        )
                      : infra.costPerMTok;
                  const liveCost = fullyLoadedApiCostFloor({
                    dayCogs: fin?.dayApiCogs,
                    dayMTok: fin?.dayApiMTok,
                    marginalCostPerMTok: modelUnit,
                  });
                  const outCheap = pout < pin;
                  const pricingStatus = analyzeApiPricing({
                    price: blend,
                    marginalCost: liveCost.blended,
                    capability: apiServedModel.capability,
                    featureScore: m.modalities.length * 18,
                    tokPerSec:
                      apiServedModel.serviceProfile?.interactiveTokPerSec ??
                      52 * apiServedModel.tokPerSecMult,
                    peers: rivalApiPeers,
                  });
                  const dayNet =
                    (fin?.dayApiRevenue ?? 0) - (fin?.dayApiCogs ?? 0);
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
                              ${blend.toFixed(2)}/M
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

                        <div className="mt-2 grid grid-cols-3 gap-1.5">
                          <UsageCell
                            label="Traffic / day"
                            value={num(dayMTok, 2)}
                            sub={`${num(inMTok, 2)} in · ${num(outMTok, 2)} out MTok`}
                          />
                          <UsageCell
                            label="Revenue / cost"
                            value={money(fin?.dayApiRevenue ?? 0)}
                            sub={`${money(fin?.dayApiCogs ?? 0)} serving`}
                            accent="text-mint"
                          />
                          <UsageCell
                            label="Net / day"
                            value={money(dayNet)}
                            sub={
                              isApiLive
                                ? "live endpoint"
                                : (fin?.note ?? "not listed")
                            }
                            accent={dayNet < 0 ? "text-danger" : "text-mint"}
                          />
                        </div>

                        <div className="mt-2 rounded-md border border-line/60 bg-void/40 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[0.8125rem] font-medium text-bone">
                              API precision
                            </span>
                            <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                              {apiServeMods.label} · PF ×
                              {apiServeMods.computeMult.toFixed(2)} · cap{" "}
                              {apiServedModel.capability.toFixed(0)}
                            </span>
                          </div>
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
                          <div className="mt-2 grid grid-cols-4 gap-1 font-mono text-[0.6875rem]">
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

                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="text-[0.8125rem] text-muted">
                            Input $/1M tok
                            <DraftNumberInput
                              ariaLabel={`${m.name} input price per million tokens`}
                              min={0}
                              step={0.01}
                              value={pin}
                              decimals={2}
                              onCommit={(nextIn) => {
                                const nextOut = Math.max(pout, nextIn);
                                setModelApiInOut(m.id, nextIn, nextOut);
                              }}
                              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[0.8125rem] text-bone outline-none"
                            />
                          </label>
                          <label className="text-[0.8125rem] text-muted">
                            Output $/1M tok
                            <DraftNumberInput
                              ariaLabel={`${m.name} output price per million tokens`}
                              min={0}
                              step={0.01}
                              value={pout}
                              decimals={2}
                              onCommit={(committedOut) => {
                                let nextOut = committedOut;
                                if (nextOut < pin) nextOut = pin;
                                setModelApiInOut(m.id, pin, nextOut);
                              }}
                              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[0.8125rem] text-bone outline-none"
                            />
                          </label>
                        </div>
                        {outCheap ? (
                          <p className="mt-1 text-[0.75rem] text-amber">
                            Output raised to match input — generation costs more
                            than prefill.
                          </p>
                        ) : null}

                        <div className="mt-2 rounded-md border border-line/60 bg-void/40 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[0.8125rem] font-medium text-bone">
                                Price margin
                              </div>
                              <p className="mt-0.5 text-[0.75rem] text-muted">
                                Allocated compute floor{" "}
                                {money(liveCost.blended)}/M ·{" "}
                                {pricingStatus.explanation}
                              </p>
                            </div>
                            <label className="flex shrink-0 items-center gap-1.5 text-[0.75rem] text-muted">
                              <DraftNumberInput
                                ariaLabel={`${m.name} API margin percent`}
                                min={-50}
                                max={500}
                                step={1}
                                value={Math.max(
                                  -50,
                                  Math.min(
                                    500,
                                    (blend /
                                      Math.max(
                                        0.001,
                                        blendApiPrice(
                                          liveCost.costIn,
                                          liveCost.costOut,
                                        ),
                                      ) -
                                      1) *
                                      100,
                                  ),
                                )}
                                decimals={1}
                                onCommit={(marginPct) => {
                                  const priceMultiplier = Math.max(
                                    0.5,
                                    1 + marginPct / 100,
                                  );
                                  const costIn = liveCost.costIn;
                                  const costOut = liveCost.costOut;
                                  const nextIn = costIn * priceMultiplier;
                                  const nextOut = Math.max(
                                    nextIn,
                                    costOut * priceMultiplier,
                                  );
                                  setModelApiInOut(m.id, nextIn, nextOut);
                                }}
                                className="w-20 rounded-md border border-mint/35 bg-void px-2 py-1 font-mono text-[0.8125rem] text-bone outline-none focus:border-mint"
                              />
                              <span className="font-mono text-bone">%</span>
                            </label>
                          </div>
                        </div>
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
              />
            </ComputeAllocationChart>
          </div>
        ) : null}
      </div>
    </PanelScaffold>
  );
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
}: {
  value: number;
  autoValue: number;
  apiServeFraction: number;
  subscriptionServeFraction: number;
  apiBacklogMTok: number;
  subscriptionBacklogMTok: number;
  unservedRatio: number;
  onChange: (value: number) => void;
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
      className="overflow-hidden rounded-xl border border-line/70 bg-void/45"
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
    "#8b5cf6",
    "#38bdf8",
    "#2dd4bf",
    "#f59e0b",
    "#f97316",
    "#eab308",
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
      className="rounded-2xl border border-line bg-panel-2 p-3"
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

      <div className="mt-2.5 rounded-xl border border-line/60 bg-void/45 p-2.5">
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

function nativeMTok(units: NativeWorkUnits): number {
  return Math.max(0, units.inputMTok ?? 0) + Math.max(0, units.outputMTok ?? 0);
}

function WorkloadLedger({
  ledger,
  headroom,
}: {
  ledger: ComputeLedger;
  headroom: number;
}) {
  const admittedMTok = ledger.items.reduce(
    (sum, item) => sum + nativeMTok(item.admitted),
    0,
  );
  const servedMTok = ledger.items.reduce(
    (sum, item) => sum + nativeMTok(item.served),
    0,
  );
  const billedMTok = ledger.items.reduce(
    (sum, item) => sum + nativeMTok(item.billed),
    0,
  );
  const requestedMTok = ledger.items.reduce(
    (sum, item) => sum + nativeMTok(item.requested),
    0,
  );
  const usablePf = ledger.capacityPfDays / (1 + Math.max(0, headroom));
  const utilization =
    usablePf > 0 ? Math.min(1, ledger.servedPfDays / usablePf) : 0;
  const latencyReservePf = Math.max(0, ledger.capacityPfDays - usablePf);
  const channelRows = [
    {
      id: "api",
      label: "API",
      items: ledger.items.filter((item) => item.kind === "api_text"),
      tone: "bg-infer",
      text: "text-infer",
    },
    {
      id: "subscription",
      label: "Plans",
      items: ledger.items.filter((item) => item.kind === "subscription_text"),
      tone: "bg-mint",
      text: "text-mint",
    },
  ].filter((channel) => channel.items.length > 0);
  const stages = [
    {
      label: "Requested",
      mtok: requestedMTok,
      pf: ledger.requestedPfDays,
      tone: "text-bone",
    },
    {
      label: "Admitted",
      mtok: admittedMTok,
      pf: ledger.admittedPfDays,
      tone: "text-infer",
    },
    {
      label: "Served",
      mtok: servedMTok,
      pf: ledger.servedPfDays,
      tone: "text-mint",
    },
    {
      label: "Billed",
      mtok: billedMTok,
      pf: ledger.billedPfDays,
      tone: "text-amber",
    },
  ];

  return (
    <section
      aria-label="Daily serving workload ledger"
      className="mt-2.5 overflow-hidden rounded-xl border border-line/60 bg-void/45"
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

      <div className="grid grid-cols-4 divide-x divide-line/50 border-b border-line/60">
        {stages.map((stage, index) => (
          <div
            key={stage.label}
            className="min-w-0 px-1.5 py-2 text-center"
            title={`${num(stage.pf, 3)} PF-days`}
          >
            <div className="truncate text-[0.5625rem] uppercase tracking-wide text-muted">
              {index > 0 ? "→ " : ""}
              {stage.label}
            </div>
            <div
              className={`mt-0.5 truncate font-mono text-[0.75rem] font-semibold ${stage.tone}`}
            >
              {num(stage.mtok, 2)}M
            </div>
            <div className="truncate font-mono text-[0.5625rem] text-muted">
              {num(stage.pf, 2)} PF-d
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-1.5 px-2.5 py-2">
        {channelRows.map((channel) => {
          const requested = channel.items.reduce(
            (sum, item) => sum + nativeMTok(item.requested),
            0,
          );
          const served = channel.items.reduce(
            (sum, item) => sum + nativeMTok(item.served),
            0,
          );
          const billed = channel.items.reduce(
            (sum, item) => sum + nativeMTok(item.billed),
            0,
          );
          const servedFraction =
            requested > 0 ? Math.min(1, served / requested) : 1;
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
              <span className="font-mono text-[0.625rem] text-muted">
                {num(served, 1)}/{num(requested, 1)}M · {num(billed, 1)}M billed
              </span>
            </div>
          );
        })}

        <div className="grid grid-cols-3 gap-1 pt-0.5 font-mono text-[0.5625rem] text-muted">
          <span title="Capacity held back for p95 traffic and latency spikes">
            latency reserve{" "}
            <b className="text-bone">{num(latencyReservePf, 2)} PF-d</b>
          </span>
          <span
            className="text-center"
            title="Work admitted from the API and plan channel guarantees"
          >
            channel reserve{" "}
            <b className="text-bone">{num(ledger.reservedPfDays, 2)} PF-d</b>
          </span>
          <span
            className="text-right"
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
    <section className="rounded-xl border border-line/60 bg-void/45 px-2.5 py-2">
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
  const marginPerUserMo =
    stats?.marginPerSubMonth ??
    (free
      ? -allowanceDay * unitCogs * ECONOMY.daysPerMonth
      : plan.pricePerMonth - allowanceDay * unitCogs * ECONOMY.daysPerMonth);
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
  const allowanceExpectation = planAllowanceExpectation(plan);
  const dissatisfaction =
    stats?.dissatisfaction ?? allowanceExpectation.dissatisfaction;

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
      <div className="flex items-center gap-2 border-b border-line/50 px-3 py-2">
        <input
          value={plan.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-bone outline-none"
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
        <label className="flex shrink-0 items-center gap-1 text-[0.75rem] text-muted">
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
        <div className="hidden grid gap-2 sm:grid-cols-2">
          <MeterBar
            label="Usage vs include"
            value={Math.min(1, fill)}
            detail={
              subs > 0.5 ? `${Math.round(fill * 100)}%` : formatAllowance(plan)
            }
            tone={fill > 1 ? "warning" : "serve"}
            live={plan.enabled && subs > 0.5}
          />
          <MeterBar
            label="Seat fill"
            value={Math.min(1, seatFill ?? 0)}
            detail={
              seatCap != null && seatCap < 1e8
                ? `${people(subs)} / ${people(seatCap)}`
                : people(subs)
            }
            tone={marginBad ? "danger" : "positive"}
          />
        </div>
        {marginBad && !free ? (
          <StatusChip tone="danger">Losing money per sub</StatusChip>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[0.75rem] text-muted">
            Price $/mo
            <DraftNumberInput
              ariaLabel={`${plan.name} monthly price`}
              min={0}
              step={1}
              value={plan.pricePerMonth}
              decimals={2}
              onCommit={(next) => onChange({ pricePerMonth: next })}
              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-sm text-bone outline-none"
            />
          </label>
          <label className="text-[0.75rem] text-muted">
            Included MTok / month
            <DraftNumberInput
              ariaLabel={`${plan.name} included million tokens per month`}
              min={0.001}
              step={0.01}
              value={allowanceMo}
              decimals={2}
              onCommit={(next) => onChange({ includedMTokPerMonth: next })}
              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-sm text-bone outline-none"
            />
          </label>
        </div>

        <label className="block text-[0.75rem] text-muted">
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
          <span className="mt-0.5 block text-[0.6875rem]">
            0 leaves enrollment open.
          </span>
        </label>

        <div
          className={`hidden rounded-xl border px-2.5 py-2 ${allowanceExpectation.dissatisfaction > 0 ? "border-danger/40 bg-danger/8" : "border-mint/25 bg-mint/5"}`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[0.75rem] font-medium text-bone">
              Allowance expectation
            </span>
            <span className="font-mono text-[0.6875rem] text-bone">
              {allowanceExpectation.minimumMTok.toFixed(0)}–
              {allowanceExpectation.maximumMTok.toFixed(0)}M tok/mo
            </span>
          </div>
          <p
            className={`mt-1 text-[0.6875rem] leading-snug ${allowanceExpectation.dissatisfaction > 0 ? "text-danger" : "text-muted"}`}
          >
            {allowanceExpectation.label}
            {allowanceExpectation.dissatisfaction > 0
              ? ` Current allowance creates ${Math.round(allowanceExpectation.dissatisfaction * 100)}% dissatisfaction and directly reduces demand.`
              : " This offer clears the minimum allowance customers expect."}
          </p>
          {(stats?.stabilityDissatisfaction ?? 0) > 0.05 ? (
            <p className="mt-1 text-[0.6875rem] leading-snug text-amber">
              Unstable unit economics add{" "}
              {Math.round((stats?.stabilityDissatisfaction ?? 0) * 100)}%
              dissatisfaction. Repeated losses make users expect throttling or
              plan withdrawal.
            </p>
          ) : null}
          {free ? (
            <p className="mt-1 text-[0.6875rem] leading-snug text-muted">
              Free remains the widest demand funnel when live; its low compute
              priority limits how much of that demand can actually be served.
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-line/60 bg-void/45 px-2.5 py-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[0.75rem] font-medium text-bone">
                Compute priority
              </div>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
                Weighted share of the subscription PF pool when capacity is
                tight.
              </p>
            </div>
            <div className="shrink-0 text-right font-mono text-[0.6875rem]">
              <div className="text-mint">{planComputePriority(plan)}/100</div>
              <div className="text-muted">
                served {Math.round((stats?.serveFraction ?? 1) * 100)}%
              </div>
            </div>
          </div>
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
          <div className="mt-1 flex justify-between font-mono text-[0.625rem] text-muted">
            <span>best effort</span>
            <span>protected capacity</span>
          </div>
        </div>

        {/* Included allowance callout */}
        <div className="rounded-xl border border-line/60 bg-void/45 px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[0.75rem] text-muted">Included / user</span>
            <span className="font-mono text-xs font-medium text-bone">
              {formatAllowance(plan)}
            </span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 font-mono text-[0.75rem] text-muted">
            <span>Per day</span>
            <span className="text-right text-bone">
              {num(allowanceDay, 3)} MTok
            </span>
            <span>Per month</span>
            <span className="text-right text-bone">
              {num(allowanceMo, 2)} MTok
            </span>
            <span>Friendly estimate</span>
            <span className="text-right text-bone">
              ~{num(messagesPerDay, 0)} messages/day
            </span>
            {freeDemandProfile ? (
              <>
                <span>Audience</span>
                <span className="text-right text-bone">
                  {freeDemandProfile.label}
                </span>
              </>
            ) : null}
            {subs > 0.5 && (
              <>
                <span>Used today</span>
                <span className="text-right text-bone">
                  {num(usedPerUserDay, 3)} MTok/user
                </span>
              </>
            )}
          </div>
          {subs > 0.5 && (
            <div className="mt-1.5">
              <div className="mb-0.5 flex justify-between text-[0.6875rem] text-muted">
                <span>Pool fill vs include</span>
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
          )}
        </div>

        {/* Day totals */}
        <PlanModelRoster
          plan={plan}
          models={models}
          unlocked={unlocked}
          onChange={onChange}
        />

        <div className="grid grid-cols-4 gap-1.5 font-mono text-[0.75rem]">
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
          <div className="rounded-xl border border-line/60 bg-void/45 px-2.5 py-2">
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
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 font-mono text-[0.6875rem]"
                >
                  <span className="truncate text-bone">
                    {usage.name} · {Math.round(usage.share * 100)}%
                  </span>
                  <span className="text-muted">
                    {num(usage.dayMTok, 2)} MTok
                  </span>
                  <span className="text-danger">
                    {money(usage.dayMTok * usage.costPerMTok)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {premiumScrutiny.applies ? (
          <div
            className={`rounded-xl border px-2.5 py-2 ${premiumScrutiny.shortfall > 0 ? "border-amber/45 bg-amber/10" : "border-mint/30 bg-mint/5"}`}
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
          <div className="hidden rounded-xl border border-infer/25 bg-infer/5 px-2.5 py-2">
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
