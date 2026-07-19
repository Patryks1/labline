import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ECONOMY } from '../../../sim/balance/economy'
import {
  analyzeApiPricing,
  analyzePlanPricing,
  apiModelKind,
  apiModelValueIndex,
  blendApiPrice,
  deriveApiUnitEconomics,
  serveInfraCost,
  splitInOutMTok,
} from '../../../sim/balance/pricing'
import { formatParams } from '../../../sim/balance/training'
import { energyPriceForState } from '../../../sim/systems/map'
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
  planPriceTooHighScore,
  premiumPlanScrutiny,
  planServeModifiers,
  modelForServePrecision,
  planSubsidyRatio,
  unlockedPlanPrecisions,
} from '../../../sim/systems/plans'
import type { PlanOfferingBreadth } from '../../../sim/systems/plans'
import { BENCHMARK_DEFS } from '../../../sim/balance/benchmarks'
import { useGameStore } from '../../../store/gameStore'
import { money, num, people } from '../format'
import type {
  Model,
  PlanDayStats,
  PlanServePrecision,
  ProductChannel,
  ProductOffer,
  SubPlan,
} from '../../../sim/types'
import { computeSnapshot } from '../../../sim/tick'
import { SliderField } from '../ui/SliderField'
import { ResearchUnlockLink } from '../ui/ResearchUnlockLink'
import {
  deriveProductPortfolio,
  PRODUCT_CHANNELS,
} from '../../../sim/systems/productPortfolio'
import { ApiEconomicsControl } from '../ui/ApiEconomicsControl'

const PRODUCT_CHANNEL_LABELS: Record<ProductChannel, string> = {
  free_assistant: 'Free assistant',
  consumer_pro: 'Consumer Pro',
  creator_developer: 'Creator / Developer',
  payg_api: 'Pay-as-you-go API',
  reserved_throughput_api: 'Reserved throughput',
  enterprise_dedicated: 'Enterprise dedicated',
}

function formatNumberDraft(value: number, decimals?: number): string {
  return decimals == null ? String(value) : value.toFixed(decimals)
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
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  step?: number
  decimals?: number
  className: string
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(() => formatNumberDraft(value, decimals))
  const inputRef = useRef<HTMLInputElement>(null)
  const editingRef = useRef(false)

  useEffect(() => {
    if (!editingRef.current) {
      setDraft(formatNumberDraft(value, decimals))
    }
  }, [value, decimals])

  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(formatNumberDraft(value, decimals))
      return
    }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed))
    const next = decimals == null
      ? clamped
      : Math.round(clamped * 10 ** decimals) / 10 ** decimals
    onCommit(next)
    setDraft(formatNumberDraft(next, decimals))
  }

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
        editingRef.current = true
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        editingRef.current = false
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(formatNumberDraft(value, decimals))
          event.currentTarget.blur()
        }
      }}
      className={className}
    />
  )
}

export function PlansPanel() {
  const state = useGameStore((s) => s.state)
  const createPlan = useGameStore((s) => s.createPlan)
  const updatePlan = useGameStore((s) => s.updatePlan)
  const deletePlan = useGameStore((s) => s.deletePlan)
  const setModelApiInOut = useGameStore((s) => s.setModelApiInOut)
  const setPricing = useGameStore((s) => s.setPricing)
  const stats = state.lastMarket.planStats
  const models = state.player.models.filter(
    (m) => m.release === 'released' || m.shipped,
  )
  const pricing = state.player.pricing
  const portfolio = deriveProductPortfolio(state)
  const snap = computeSnapshot(state)
  const energyPrice = energyPriceForState(state)
  const infra = serveInfraCost(state, snap, energyPrice)
  const apiRequested = state.lastMarket.apiDemandMTok ?? 0
  const apiServed = state.lastMarket.apiDayMTok ?? 0
  const subRequested = Math.max(0, state.lastMarket.playerDemandMTok - apiRequested)
  const subServed = state.lastMarket.planStats.reduce((sum, plan) => sum + plan.dayMTok, 0)
  const rivalApiPeers = state.rivals.flatMap((rival) =>
    rival.models
      .filter((model) => model.release === 'released' || model.shipped)
      .map((model) => ({
        price:
          model.apiPriceInPerMTok != null && model.apiPriceOutPerMTok != null
            ? blendApiPrice(model.apiPriceInPerMTok, model.apiPriceOutPerMTok)
            : rival.pricing.apiPricePerMTok,
        capability: model.capability,
        featureScore: model.modalities.length * 18,
        tokPerSec: model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult,
        valueIndex: apiModelValueIndex(model),
        kind: apiModelKind(model),
      })),
  )
  const rivalPlanPeers = state.rivals.flatMap((rival) => {
    const best = [...rival.models]
      .filter((model) => model.release === 'released' || model.shipped)
      .sort((a, b) => b.capability - a.capability)[0]
    if (!best) return []
    return (rival.pricing.plans ?? []).filter((plan) => plan.enabled).map((plan) => ({
      price: plan.pricePerMonth,
      includedMTokPerMonth: planAllowanceMTokPerMonth(plan),
      capability: best.capability,
      featureScore: best.modalities.length * 18,
    }))
  })

  const active = models.find((m) => m.id === pricing.activeModelId) ?? models[0]
  const apiModelIds = pricing.apiModelIds ?? (active ? [active.id] : [])

  const [name, setName] = useState('Team')
  const [price, setPrice] = useState(100)
  const [included, setIncluded] = useState(6)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(
    () => state.player.pricing.plans[0]?.id ?? null,
  )
  const [creatingPlan, setCreatingPlan] = useState(false)

  const blendedList = blendApiPrice(
    active?.apiPriceInPerMTok ??
      active?.suggestedApiPriceIn ??
      pricing.apiPriceInPerMTok,
    active?.apiPriceOutPerMTok ??
      active?.suggestedApiPriceOut ??
      pricing.apiPriceOutPerMTok,
  )

  const modelFinance = state.lastMarket.modelFinance ?? []
  // Portfolio rollup
  const totalSubs = stats.reduce((s, p) => s + p.subscribers, 0)
  const paidSubs = stats.filter((p) => !p.isFree).reduce((s, p) => s + p.subscribers, 0)
  const subRevDay = state.player.finance.subRevenue
  const arpuMo =
    paidSubs > 0 ? (subRevDay * ECONOMY.daysPerMonth) / paidSubs : 0
  const autoApiPriority = Math.max(
    0.12,
    Math.min(
      0.88,
      apiRequested + subRequested > 0
        ? apiRequested / (apiRequested + subRequested)
        : 0.68,
    ),
  )

  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Plans & API</h2>
        <p className="hud-panel-sub">
          Per-model API in/out prices · seat plans · usage & unit economics.
        </p>
      </div>

      {/* Portfolio snapshot */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <BigStat label="Subscribers" value={people(totalSubs)} accent="text-bone" />
        <BigStat
          label="Sub revenue / day"
          value={money(subRevDay)}
          accent="text-mint"
        />
        <BigStat
          label="ARPU / mo"
          value={paidSubs > 0 ? money(arpuMo) : '—'}
          sub={paidSubs > 0 ? `${people(paidSubs)} paid` : 'no paid seats'}
        />
        <BigStat
          label="API / day"
          value={money(state.player.finance.apiRevenue)}
          sub={`${num(state.lastMarket.apiDayMTok, 1)} MTok`}
        />
      </div>

      <ComputeAllocationChart
        apiMTok={apiServed}
        apiPf={Math.max(
          0,
          (state.lastMarket.servedPf ?? 0) -
            stats.reduce((sum, plan) => sum + (plan.dayInferPf ?? 0), 0),
        )}
        apiModelUsage={state.lastMarket.apiModelUsage ?? []}
        plans={stats}
      >
        <CapacityRoutingControl
          value={pricing.apiVsSubPriority ?? 0.68}
          autoValue={autoApiPriority}
          apiServeFraction={apiRequested > 0 ? Math.min(1, apiServed / apiRequested) : 1}
          subscriptionServeFraction={subRequested > 0 ? Math.min(1, subServed / subRequested) : 1}
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
          onChange={(apiVsSubPriority) => setPricing({ apiVsSubPriority })}
        />
      </ComputeAllocationChart>

      {/* ── Per-model API list ── */}
      <section className="space-y-2">
        <div>
          <div>
            <h3 className="text-xs font-semibold text-bone">API models</h3>
            <p className="text-[0.75rem] text-muted">
              Direct token cost and market value are recomputed for each model and precision.
              Campus overhead remains a company-level diagnostic.
            </p>
          </div>
        </div>

        {models.length === 0 ? (
          <div className="rounded-xl border border-amber/30 bg-amber/5 px-3 py-4 text-center text-[0.8125rem] text-amber">
            Release a model first — API list prices attach to each public model.
          </div>
        ) : (
          <div className="space-y-2">
            {models.map((m) => {
              const fin = modelFinance.find((f) => f.modelId === m.id)
              const isApiLive = apiModelIds.includes(m.id)
              const apiPrecision = pricing.apiServePrecisionByModel?.[m.id] ?? 'fp16'
              const apiPrecisionOptions = unlockedPlanPrecisions(state.player.researchUnlocked)
              const apiServeMods = planServeModifiers(
                apiPrecision,
                state.player.researchUnlocked,
              )
              const apiServedModel = modelForServePrecision(
                m,
                apiPrecision,
                state.player.researchUnlocked,
              )
              const pin =
                m.apiPriceInPerMTok ??
                m.suggestedApiPriceIn ??
                m.costApiPriceIn ??
                pricing.apiPriceInPerMTok
              const pout =
                m.apiPriceOutPerMTok ??
                m.suggestedApiPriceOut ??
                m.costApiPriceOut ??
                pricing.apiPriceOutPerMTok
              const blend = blendApiPrice(pin, pout)
              const dayMTok = fin?.dayApiMTok ?? 0
              const { inMTok, outMTok } = splitInOutMTok(dayMTok)
              const economics = deriveApiUnitEconomics({
                state,
                snap,
                model: m,
                serveModel: apiServedModel,
                energyPricePerMWh: energyPrice,
                dayCogs: fin?.dayApiCogs,
                dayMTok: fin?.dayApiMTok,
                peers: rivalApiPeers,
              })
              const outCheap = pout < pin
              const pricingStatus = analyzeApiPricing({
                price: blend,
                marginalCost: economics.directBlended,
                capability: apiServedModel.capability,
                featureScore: m.modalities.length * 18,
                tokPerSec:
                  apiServedModel.serviceProfile?.interactiveTokPerSec ??
                  52 * apiServedModel.tokPerSecMult,
                valueIndex: economics.valueIndex,
                peers: rivalApiPeers.filter((peer) => peer.kind === apiModelKind(apiServedModel)),
              })

              return (
                <div
                  key={m.id}
                  data-testid={`api-model-card-${m.id}`}
                  className={`rounded-2xl border p-2.5 ${
                    isApiLive
                      ? 'border-mint/40 bg-mint/5'
                      : 'border-line bg-panel-2'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-bone">{m.name}</span>
                        {isApiLive && (
                          <span className="rounded-full bg-mint/20 px-1.5 py-0.5 font-mono text-[0.6875rem] text-mint">
                            API LIVE
                          </span>
                        )}
                        <span className="font-mono text-[0.75rem] text-muted">
                          {formatParams(m.paramsB)} · cap {apiServedModel.capability.toFixed(0)}
                        </span>
                        <PricingPill status={pricingStatus.primary} severity={pricingStatus.severity} />
                      </div>
                      <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
                        blended ${blend.toFixed(3)}/MTok · direct ${economics.directBlended.toFixed(3)}/MTok
                      </div>
                      <div className="mt-0.5 font-mono text-[0.6875rem] text-muted">
                        peer median {pricingStatus.peerMedian == null ? '—' : `$${pricingStatus.peerMedian.toFixed(3)}`}
                        {' · '}interactive {num(m.serviceProfile?.interactiveTokPerSec ?? 52 * m.tokPerSecMult, 0)} tok/s
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      <button
                        type="button"
                        className={`rounded-full px-2 py-0.5 text-[0.75rem] ring-1 ${isApiLive ? 'bg-danger/10 text-danger ring-danger/30' : 'bg-mint/10 text-mint ring-mint/30'}`}
                        onClick={() => {
                          const next = isApiLive
                            ? apiModelIds.filter((id) => id !== m.id)
                            : [...apiModelIds, m.id]
                          setPricing({ apiModelIds: next })
                        }}
                      >
                        {isApiLive ? 'Stop API' : 'Sell API'}
                      </button>
                    </div>
                  </div>

                  {/* Compact live demand and unit economics */}
                  <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[0.75rem]">
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
                      value={money(
                        (fin?.dayApiRevenue ?? 0) - (fin?.dayApiCogs ?? 0),
                      )}
                      sub={isApiLive ? 'live endpoint' : fin?.note ?? 'not listed'}
                      accent={
                        (fin?.dayApiRevenue ?? 0) - (fin?.dayApiCogs ?? 0) < 0
                          ? 'text-danger'
                          : 'text-mint'
                      }
                    />
                  </div>

                  <div className="mt-2 rounded-xl border border-line/60 bg-void/40 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.75rem] font-medium text-bone">API precision</span>
                      <span className="font-mono text-[0.6875rem] text-muted">
                        {apiServeMods.label} · PF ×{apiServeMods.computeMult.toFixed(2)} · cap{' '}
                        {apiServedModel.capability.toFixed(0)}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {apiPrecisionOptions.map((precision) => (
                        <button
                          key={precision}
                          type="button"
                          aria-label={`${m.name} API ${precision === 'fp16' ? 'Full' : precision.toUpperCase()}`}
                          onClick={() =>
                            setPricing({
                              apiServePrecisionByModel: {
                                ...(pricing.apiServePrecisionByModel ?? {}),
                                [m.id]: precision,
                              },
                            })
                          }
                          className={`rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
                            apiServeMods.precision === precision
                              ? 'bg-infer/25 text-infer ring-1 ring-infer/40'
                              : 'bg-void text-muted hover:text-bone'
                          }`}
                        >
                          {precision === 'fp16' ? 'Full' : precision.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    {apiPrecisionOptions.length === 1 ? (
                      <ResearchUnlockLink className="mt-1.5" nodeId="sys_quant" label="Unlock API quantization" />
                    ) : null}
                    <div className="mt-2 grid grid-cols-4 gap-1 font-mono text-[0.625rem]">
                      {(['mmlu', 'coding', 'math', 'agents'] as const).map((benchmarkId) => (
                        <div key={benchmarkId} className="rounded-md border border-line/40 px-1.5 py-1">
                          <div className="uppercase text-muted">{benchmarkId}</div>
                          <div className={apiServeMods.precision === 'int4' ? 'text-danger' : 'text-bone'}>
                            {(apiServedModel.benchmarks[benchmarkId] ?? 0).toFixed(0)}
                            {apiServeMods.benchmarkDeltas[benchmarkId] ? (
                              <span className="ml-0.5 text-muted">
                                ({apiServeMods.benchmarkDeltas[benchmarkId]})
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                    {apiServeMods.brandRisk > 0 ? (
                      <p className={`mt-1.5 text-[0.6875rem] leading-snug ${apiServeMods.brandRisk >= 0.1 ? 'text-danger' : 'text-amber'}`}>
                        Public API eval loss reduces endpoint demand and sustained traffic damages brand trust.
                      </p>
                    ) : null}
                  </div>

                  {outCheap && (
                    <p className="mt-1 text-[0.75rem] text-amber">
                      Output is below input; editing either field will restore the generation premium.
                    </p>
                  )}
                  <ApiEconomicsControl
                    modelName={m.name}
                    priceIn={pin}
                    priceOut={pout}
                    economics={economics}
                    onChange={(nextIn, nextOut) => setModelApiInOut(m.id, nextIn, nextOut)}
                  />
                </div>
              )
            })}
          </div>
        )}

      </section>

      <div className="border-t border-line/60 pt-1">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold text-bone">Subscription plans</h3>
            <p className="text-[0.75rem] text-muted">Select a plan to edit its offer and live unit economics.</p>
          </div>
          <button
            type="button"
            className="hud-button border border-mint/45 bg-mint/15 text-mint hover:bg-mint/25"
            onClick={() => setCreatingPlan(true)}
          >
            New plan
          </button>
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto rounded-lg bg-void/45 p-1.5">
        {state.player.pricing.plans.map((plan) => (
          <button
            key={plan.id}
            type="button"
            onClick={() => {
              setSelectedPlanId(plan.id)
              setCreatingPlan(false)
            }}
            className={`min-h-9 shrink-0 rounded-md border px-3 text-[0.75rem] font-medium ${selectedPlanId === plan.id && !creatingPlan ? 'border-mint/45 bg-mint/15 text-mint' : 'border-line/70 bg-panel-2 text-muted hover:text-bone'}`}
          >
            {plan.name} · {plan.enabled ? 'Live' : 'Paused'}
          </button>
        ))}
      </div>

      {/* Plan cards */}
      <div className="space-y-2.5">
        {state.player.pricing.plans.filter((plan) => plan.id === selectedPlanId && !creatingPlan).map((plan) => {
          const st = stats.find((s) => s.planId === plan.id)
          const planModel =
            models.find((m) => plan.modelIds.includes(m.id)) ?? active
          return (
            <PlanCard
              key={plan.id}
              plan={plan}
              stats={st}
              models={models}
              allPlans={state.player.pricing.plans}
              unitCogs={state.lastMarket.marginalPerMTok || infra.costPerMTok}
              apiList={blendedList}
              modelCap={planModel?.capability ?? 40}
              frontierCap={Math.max(
                planModel?.capability ?? 40,
                ...models.map((m) => m.capability),
                ...state.rivals.flatMap((r) => r.models.map((m) => m.capability)),
                40,
              )}
              peerPlans={rivalPlanPeers}
              offeringBreadth={planOfferingBreadth(state, plan)}
              onChange={(patch) => updatePlan(plan.id, patch)}
              onDelete={() => {
                deletePlan(plan.id)
                setSelectedPlanId(state.player.pricing.plans.find((candidate) => candidate.id !== plan.id)?.id ?? null)
              }}
            />
          )
        })}
      </div>

      {/* New plan */}
      {creatingPlan ? <div className="rounded-2xl border border-mint/25 bg-mint/5 p-3 space-y-2.5">
        <h3 className="text-xs font-medium text-mint">New plan</h3>
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 text-[0.75rem] text-muted sm:col-span-1">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
            />
          </label>
          <label className="text-[0.75rem] text-muted">
            Price $/mo
            <DraftNumberInput
              ariaLabel="New plan monthly price"
              min={0}
              step={1}
              value={price}
              decimals={2}
              onCommit={setPrice}
              className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-sm text-bone outline-none"
            />
          </label>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-[0.75rem] text-muted">
            <span>Included tokens / user</span>
            <span className="font-mono text-bone">
              {formatAllowance({
                id: '',
                name: '',
                pricePerMonth: price,
                usageMultiplier:
                  included / (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth),
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
            className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1 font-mono text-xs text-bone outline-none"
          />
        </div>
        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => {
            createPlan({
              name,
              pricePerMonth: price,
              usageMultiplier:
                included / (ECONOMY.basePlanUsageMTokPerDay * ECONOMY.daysPerMonth),
            })
            setName('Custom')
            setCreatingPlan(false)
          }}
        >
          Create plan
        </button>
      </div> : null}

      <PromotedEndpoints
        portfolio={portfolio}
        models={state.player.models}
      />
    </div>
  )
}

function formatProductOfferPrice(offer: ProductOffer): string {
  const price = offer.pricing
  if (price.monthlyUsd != null) return price.monthlyUsd <= 0 ? 'free' : `${money(price.monthlyUsd)}/mo`
  if (price.minimumCommitmentUsd != null) return `${money(price.minimumCommitmentUsd)} min`
  if (price.inputUsdPerMTok != null || price.outputUsdPerMTok != null) {
    return `${money(price.inputUsdPerMTok ?? 0)}/${money(price.outputUsdPerMTok ?? 0)} per MTok`
  }
  return price.billingModel.replace('_', ' ')
}

function PromotedEndpoints({
  portfolio,
  models,
}: {
  portfolio: ReturnType<typeof deriveProductPortfolio>
  models: Model[]
}) {
  return (
    <section className="rounded-2xl border border-line bg-panel-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-bone">Promoted endpoints</h3>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
            Six public surfaces share your released model fleet and serving capacity.
          </p>
        </div>
        <span className="font-mono text-[0.75rem] text-mint">
          {portfolio.promoted.length}/6 live
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {PRODUCT_CHANNELS.map((channel) => {
          const offer = portfolio.byChannel[channel]
          const model = offer
            ? models.find((candidate) => candidate.id === offer.primaryModelId)
            : undefined
          return (
            <div
              key={channel}
              className={`rounded-lg border px-2 py-1.5 ${
                offer ? 'border-mint/30 bg-mint/5' : 'border-line/70 bg-void/35'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[0.6875rem] font-medium text-bone">
                  {PRODUCT_CHANNEL_LABELS[channel]}
                </span>
                <span className={`font-mono text-[0.625rem] uppercase ${offer ? 'text-mint' : 'text-muted'}`}>
                  {offer ? 'live' : 'missing'}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[0.625rem] text-muted">
                {offer
                  ? `${model?.name ?? 'Model'} · ${formatProductOfferPrice(offer)}`
                  : 'Release and package a compatible model'}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function BigStat({
  label,
  value,
  sub,
  accent = 'text-bone',
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-2.5 py-2">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-sm font-semibold tabular-nums ${accent}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted">{sub}</div>}
    </div>
  )
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
  value: number
  autoValue: number
  apiServeFraction: number
  subscriptionServeFraction: number
  apiBacklogMTok: number
  subscriptionBacklogMTok: number
  unservedRatio: number
  onChange: (value: number) => void
}) {
  const apiShare = Math.round(value * 100)
  const subscriptionShare = 100 - apiShare
  const apiHealth = Math.round(apiServeFraction * 100)
  const subscriptionHealth = Math.round(subscriptionServeFraction * 100)
  const bottleneck = apiServeFraction <= subscriptionServeFraction ? 'API' : 'Seats'
  const bottleneckBacklog = bottleneck === 'API' ? apiBacklogMTok : subscriptionBacklogMTok
  const pressure = unservedRatio > 0.5
    ? { label: 'Overloaded', tone: 'border-danger/40 bg-danger/10 text-danger' }
    : unservedRatio > 0.2
      ? { label: 'Strained', tone: 'border-amber/40 bg-amber/10 text-amber' }
      : unservedRatio > 0.05
        ? { label: 'Tight', tone: 'border-amber/30 bg-amber/8 text-amber' }
        : { label: 'Stable', tone: 'border-mint/30 bg-mint/8 text-mint' }
  const healthTone = (health: number) =>
    health < 50 ? 'text-danger' : health < 90 ? 'text-amber' : 'text-mint'

  return (
    <section
      aria-label="Capacity routing"
      className="overflow-hidden rounded-xl border border-line/70 bg-void/45"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[0.75rem] font-semibold text-bone">Capacity routing</h3>
          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wide ${pressure.tone}`}>
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
            <div className="text-[0.625rem] uppercase tracking-wide text-muted">Seats</div>
            <div className="text-sm font-semibold text-bone">{subscriptionShare}%</div>
          </div>
          <div className="text-right">
            <div className="text-[0.625rem] uppercase tracking-wide text-muted">API</div>
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
            onChange(Math.max(0.12, Math.min(0.88, Number(event.target.value) / 100)))
          }
          className="slider-track mt-1 w-full"
          aria-label="API vs subscription capacity priority"
        />

        <div className="mt-1.5 grid grid-cols-2 divide-x divide-line/60 rounded-lg border border-line/50 bg-panel-2/55">
          <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
            <span className="text-[0.6875rem] text-muted">Seats served</span>
            <span className={`font-mono text-[0.75rem] font-semibold ${healthTone(subscriptionHealth)}`}>
              {subscriptionHealth}%
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
            <span className="text-[0.6875rem] text-muted">API served</span>
            <span className={`font-mono text-[0.75rem] font-semibold ${healthTone(apiHealth)}`}>
              {apiHealth}%
            </span>
          </div>
        </div>

        <div
          aria-live="polite"
          className={`mt-1.5 flex items-center justify-between gap-2 rounded-md px-2 py-1 font-mono text-[0.625rem] ${unservedRatio > 0.05 ? pressure.tone : 'bg-mint/5 text-mint'}`}
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
  )
}

function PricingPill({
  status,
  severity,
}: {
  status: string
  severity: 'ok' | 'amber' | 'danger'
}) {
  const label = status.replaceAll('_', ' ').toUpperCase()
  const style =
    severity === 'danger'
      ? 'border-danger/35 bg-danger/10 text-danger'
      : severity === 'amber'
        ? 'border-amber/35 bg-amber/10 text-amber'
        : 'border-mint/30 bg-mint/10 text-mint'
  return (
    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.625rem] ${style}`}>
      {label}
    </span>
  )
}

function UsageCell({
  label,
  value,
  sub,
  accent = 'text-bone',
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-lg border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="text-[0.6875rem] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 font-mono text-[0.8125rem] font-medium tabular-nums ${accent}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[0.6875rem] text-muted">{sub}</div>}
    </div>
  )
}

function ComputeAllocationChart({
  apiMTok,
  apiPf,
  apiModelUsage,
  plans,
  children,
}: {
  apiMTok: number
  apiPf: number
  apiModelUsage: NonNullable<PlanDayStats['modelUsage']>
  plans: PlanDayStats[]
  children?: ReactNode
}) {
  const [selectedId, setSelectedId] = useState('api')
  const colors = ['#8b5cf6', '#38bdf8', '#2dd4bf', '#f59e0b', '#f97316', '#eab308']
  const segments = [
    {
      id: 'api',
      label: 'API',
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
  ]
  const totalPf = segments.reduce((sum, segment) => sum + segment.pf, 0)
  const totalMTok = segments.reduce((sum, segment) => sum + segment.mtok, 0)
  const selected = segments.find((segment) => segment.id === selectedId) ?? segments[0]!

  return (
    <section className="rounded-2xl border border-line bg-panel-2 p-3" aria-label="Compute allocation">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-bone">Serving compute allocation</h3>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
            PF share by API and plan. Hover or select a lane to inspect token-normalized model usage.
          </p>
        </div>
        <div className="shrink-0 text-right font-mono">
          <div className="text-[0.8125rem] font-semibold text-bone">{num(totalMTok, 2)} MTok/d</div>
          <div className="text-[0.625rem] text-muted">{num(totalPf, 1)} PF served</div>
        </div>
      </div>

      <div className="mt-3 flex h-14 overflow-hidden rounded-lg border border-line bg-void">
        {segments.filter((segment) => segment.pf > 0 || segment.mtok > 0).map((segment, index) => {
          const basis = totalPf > 0 ? segment.pf / totalPf : segment.mtok / Math.max(totalMTok, 1e-9)
          return (
            <button
              key={segment.id}
              type="button"
              onMouseEnter={() => setSelectedId(segment.id)}
              onFocus={() => setSelectedId(segment.id)}
              onClick={() => setSelectedId(segment.id)}
              aria-pressed={selected.id === segment.id}
              className={`min-w-[3.5rem] border-r border-void/50 px-1.5 text-center transition last:border-r-0 ${selected.id === segment.id ? 'brightness-125' : 'hover:brightness-110'}`}
              style={{ width: `${Math.max(7, basis * 100)}%`, backgroundColor: colors[index % colors.length] }}
              title={`${segment.label}: ${num(segment.mtok, 2)} MTok/day · ${num(segment.pf, 2)} PF`}
            >
              <span className="block truncate text-[0.6875rem] font-semibold text-white">{segment.label}</span>
              <span className="block font-mono text-[0.625rem] text-white/80">{Math.round(basis * 100)}%</span>
            </button>
          )
        })}
      </div>

      <div className="mt-2.5 rounded-xl border border-line/60 bg-void/45 p-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-[0.8125rem] font-semibold text-bone">{selected.label}</span>
            <span className="ml-2 font-mono text-[0.6875rem] text-muted">
              {num(selected.mtok, 2)} MTok/d · {num(selected.pf, 2)} PF
            </span>
          </div>
          {selected.subscribers != null ? (
            <span className="font-mono text-[0.6875rem] text-mint">{people(selected.subscribers)} users</span>
          ) : (
            <span className="font-mono text-[0.6875rem] text-infer">input + output tokens</span>
          )}
        </div>
        <div className="mt-2 space-y-1.5">
          {selected.modelUsage.length > 0 ? selected.modelUsage.map((usage) => (
            <div key={usage.modelId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 font-mono text-[0.6875rem]">
              <div className="min-w-0">
                <div className="flex justify-between gap-2">
                  <span className="truncate text-bone">{usage.name}</span>
                  <span className="text-muted">{Math.round(usage.share * 100)}%</span>
                </div>
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-line/50">
                  <div className="h-full bg-infer" style={{ width: `${Math.max(2, usage.share * 100)}%` }} />
                </div>
              </div>
              <span className="text-muted">{num(usage.dayMTok, 2)} MTok</span>
              <span className="text-amber">{num(usage.dayInferPf, 2)} PF</span>
            </div>
          )) : (
            <p className="text-[0.6875rem] text-muted">No served model traffic today.</p>
          )}
        </div>
      </div>

      {children ? <div className="mt-3 border-t border-line/60 pt-3">{children}</div> : null}
    </section>
  )
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
  plan: SubPlan
  stats?: PlanDayStats
  models: Model[]
  allPlans: SubPlan[]
  unitCogs: number
  apiList: number
  modelCap: number
  frontierCap: number
  peerPlans: { price: number; includedMTokPerMonth: number; capability: number; featureScore: number }[]
  offeringBreadth: PlanOfferingBreadth
  onChange: (p: Partial<SubPlan>) => void
  onDelete: () => void
}) {
  const unlocked = useGameStore((s) => s.state.player.researchUnlocked)
  const free = isFreePlan(plan)
  const precisions = unlockedPlanPrecisions(unlocked)
  const quantUnlocked = precisions.length > 1
  const serveMods = planServeModifiers(plan.servePrecision, unlocked)
  const subs = stats?.subscribers ?? 0
  const allowanceDay = planAllowanceMTokPerDay(plan)
  const allowanceMo = planAllowanceMTokPerMonth(plan)
  // Actual tokens burned per seat today (if any traffic)
  const usedPerUserDay = subs > 0.5 ? (stats?.dayMTok ?? 0) / subs : 0
  const usedPerUserMo = usedPerUserDay * ECONOMY.daysPerMonth
  const fill =
    allowanceDay > 0 ? Math.min(1.25, usedPerUserDay / Math.max(1e-9, allowanceDay)) : 0

  const revPerUserMo = free
    ? 0
    : subs > 0.5
      ? ((stats?.dayRevenue ?? 0) * ECONOMY.daysPerMonth) / subs
      : plan.pricePerMonth
  const marginPerUserMo = stats?.marginPerSubMonth ?? (free
    ? -allowanceDay * unitCogs * ECONOMY.daysPerMonth
    : plan.pricePerMonth - allowanceDay * unitCogs * ECONOMY.daysPerMonth)
  const cogsPerUserMo =
    subs > 0.5
      ? ((stats?.dayCogs ?? 0) * ECONOMY.daysPerMonth) / subs
      : allowanceDay * unitCogs * ECONOMY.daysPerMonth
  const computePfPerUser = stats?.computePfPerSubscriber ?? 0
  const computePfPerUserLabel =
    computePfPerUser > 0 && computePfPerUser < 0.001
      ? computePfPerUser.toExponential(2)
      : num(computePfPerUser, 3)

  const util = 0.65 // sim default for pricing scores only
  const apiEq =
    stats?.apiEquivalentValue ?? planApiEquivalentValue(plan, apiList, util)
  const subsidy =
    stats?.subsidyRatio ?? planSubsidyRatio(plan, apiList, util)
  const tooHigh =
    stats?.priceTooHigh ??
    planPriceTooHighScore(plan, {
      apiPricePerMTok: apiList,
      modelCapability: modelCap,
      frontierCapability: frontierCap,
      utilization: util,
    })
  const marginBad = marginPerUserMo < 0
  const seatCap = stats?.maxSeats
  const seatFill =
    seatCap != null && seatCap > 0 && seatCap < 1e8
      ? Math.min(1, subs / seatCap)
      : null
  const messagesPerDay = (allowanceMo * 1_000_000) / ECONOMY.daysPerMonth / 2_000
  const freeDemandProfile = free ? freeTierDemandProfile(plan) : null
  const planStatus = analyzePlanPricing({
    price: plan.pricePerMonth,
    includedMTokPerMonth: allowanceMo,
    expectedUtilization: stats?.usageRate ?? util,
    marginalCostPerMTok: unitCogs,
    capability: modelCap,
    featureScore: 0,
    peers: peerPlans,
  })
  const premiumScrutiny = premiumPlanScrutiny(plan, allPlans)
  const allowanceExpectation = planAllowanceExpectation(plan)
  const dissatisfaction = stats?.dissatisfaction ?? allowanceExpectation.dissatisfaction
  const benchmarkModel = models.find((candidate) => plan.modelIds.includes(candidate.id)) ?? models[0]
  const benchmarkIds = ['mmlu', 'coding', 'math', 'law', 'health', 'agents'] as const

  return (
    <div
      data-testid={`subscription-plan-card-${plan.id}`}
      className={`overflow-hidden rounded-2xl border ${
        free
          ? 'border-amber/30 bg-amber/5'
          : plan.enabled
            ? 'border-line bg-panel-2'
            : 'border-line/50 bg-void/40 opacity-75'
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
        <PricingPill status={planStatus.primary} severity={planStatus.severity} />
        {dissatisfaction > 0.05 ? (
          <span className="shrink-0 rounded-full border border-danger/35 bg-danger/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-danger">
            {Math.round(dissatisfaction * 100)}% DISSATISFIED
          </span>
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
              : 'open seats'
          }
          bar={seatFill}
        />
        <KpiCell
          label="Rev / user / mo"
          value={free ? '$0' : money(revPerUserMo)}
          sub={free ? 'no charge' : `list ${money(plan.pricePerMonth)}`}
          accent={free ? 'text-muted' : 'text-bone'}
        />
        <KpiCell
          label="Margin / user / mo"
          value={money(marginPerUserMo)}
          sub={
            stats
              ? `compute ${money(cogsPerUserMo)}/mo`
              : `est. compute ${money(cogsPerUserMo)}/mo`
          }
          accent={marginBad ? 'text-danger' : 'text-mint'}
        />
        <KpiCell
          label="Usage / user"
          value={subs > 0.5 ? `${num(usedPerUserDay, 3)} MTok/d` : '—'}
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

        <div className={`rounded-xl border px-2.5 py-2 ${allowanceExpectation.dissatisfaction > 0 ? 'border-danger/40 bg-danger/8' : 'border-mint/25 bg-mint/5'}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[0.75rem] font-medium text-bone">Allowance expectation</span>
            <span className="font-mono text-[0.6875rem] text-bone">
              {allowanceExpectation.minimumMTok.toFixed(0)}–{allowanceExpectation.maximumMTok.toFixed(0)}M tok/mo
            </span>
          </div>
          <p className={`mt-1 text-[0.6875rem] leading-snug ${allowanceExpectation.dissatisfaction > 0 ? 'text-danger' : 'text-muted'}`}>
            {allowanceExpectation.label}
            {allowanceExpectation.dissatisfaction > 0
              ? ` Current allowance creates ${Math.round(allowanceExpectation.dissatisfaction * 100)}% dissatisfaction and directly reduces demand.`
              : ' This offer clears the minimum allowance customers expect.'}
          </p>
          {(stats?.stabilityDissatisfaction ?? 0) > 0.05 ? (
            <p className="mt-1 text-[0.6875rem] leading-snug text-amber">
              Unstable unit economics add {Math.round((stats?.stabilityDissatisfaction ?? 0) * 100)}% dissatisfaction. Repeated losses make users expect throttling or plan withdrawal.
            </p>
          ) : null}
          {free ? (
            <p className="mt-1 text-[0.6875rem] leading-snug text-muted">
              Free remains the widest demand funnel when live; its low compute priority limits how much of that demand can actually be served.
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-line/60 bg-void/45 px-2.5 py-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[0.75rem] font-medium text-bone">Compute priority</div>
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted">
                Weighted share of the subscription PF pool when capacity is tight.
              </p>
            </div>
            <div className="shrink-0 text-right font-mono text-[0.6875rem]">
              <div className="text-mint">{planComputePriority(plan)}/100</div>
              <div className="text-muted">served {Math.round((stats?.serveFraction ?? 1) * 100)}%</div>
            </div>
          </div>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={planComputePriority(plan)}
            onChange={(event) => onChange({ computePriority: Number(event.target.value) })}
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
            <span className="text-right text-bone">{num(allowanceDay, 3)} MTok</span>
            <span>Per month</span>
            <span className="text-right text-bone">{num(allowanceMo, 2)} MTok</span>
            <span>Friendly estimate</span>
            <span className="text-right text-bone">~{num(messagesPerDay, 0)} messages/day</span>
            {freeDemandProfile ? (
              <>
                <span>Audience</span>
                <span className="text-right text-bone">{freeDemandProfile.label}</span>
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
                <span className={fill > 1 ? 'text-amber' : 'text-mint'}>
                  {Math.round(fill * 100)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-void">
                <div
                  className={`h-full ${fill > 1 ? 'bg-amber' : 'bg-infer'}`}
                  style={{ width: `${Math.min(100, fill * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Day totals */}
        <div className="grid grid-cols-4 gap-1.5 font-mono text-[0.75rem]">
          <Mini label="Day rev" value={money(stats?.dayRevenue ?? 0)} />
          <Mini label="Allocated serve ops" value={money(stats?.dayCogs ?? 0)} danger />
          <Mini label="PF / served user" value={computePfPerUserLabel} />
          <Mini label="Day MTok" value={num(stats?.dayMTok ?? 0, 2)} />
        </div>

        {(stats?.modelUsage?.length ?? 0) > 0 ? (
          <div className="rounded-xl border border-line/60 bg-void/45 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.75rem] font-medium text-bone">Actual model utilization</span>
              <span className="font-mono text-[0.625rem] text-muted">tokens × model compute × precision</span>
            </div>
            <div className="mt-1.5 space-y-1">
              {stats!.modelUsage!.map((usage) => (
                <div key={usage.modelId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 font-mono text-[0.6875rem]">
                  <span className="truncate text-bone">{usage.name} · {Math.round(usage.share * 100)}%</span>
                  <span className="text-muted">{num(usage.dayMTok, 2)} MTok</span>
                  <span className="text-danger">{money(usage.dayMTok * usage.costPerMTok)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {premiumScrutiny.applies ? (
          <div className={`rounded-xl border px-2.5 py-2 ${premiumScrutiny.shortfall > 0 ? 'border-amber/45 bg-amber/10' : 'border-mint/30 bg-mint/5'}`}>
            <div className="flex items-center justify-between gap-3">
              <span className={`text-[0.75rem] font-semibold ${premiumScrutiny.shortfall > 0 ? 'text-amber' : 'text-mint'}`}>
                Premium-plan scrutiny
              </span>
              <span className="font-mono text-[0.6875rem] text-bone">
                {premiumScrutiny.actualUsageRatio.toFixed(1)}× / {premiumScrutiny.expectedUsageRatio}× expected
              </span>
            </div>
            <p className="mt-1 text-[0.6875rem] leading-snug text-muted">
              At {money(plan.pricePerMonth)}/mo, customers compare this with {premiumScrutiny.entryPlanName}. Anything below 20× its included usage is criticized and loses demand; rivals face the same rule.
            </p>
          </div>
        ) : null}

        {!free && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[0.75rem] text-muted">
            <span>
              API value of include{' '}
              <span className="text-bone">{money(apiEq)}/mo</span>
            </span>
            <span
              className={
                subsidy >= 1.05
                  ? 'text-amber'
                  : subsidy < 0.75
                    ? 'text-danger'
                    : 'text-mint'
              }
            >
              {Number.isFinite(subsidy) ? `${subsidy.toFixed(2)}×` : '∞'} vs price
              {subsidy >= 1.05
                ? ' · subsidizing'
                : subsidy < 0.75
                  ? ' · dear vs API'
                  : ' · fair'}
            </span>
            {tooHigh > 0.25 && (
              <span className="text-danger">
                price pressure {Math.round(tooHigh * 100)}%
              </span>
            )}
            {planStatus.primary !== 'fair' && (
              <span className={planStatus.severity === 'danger' ? 'text-danger' : 'text-amber'}>
                {planStatus.explanation}
              </span>
            )}
          </div>
        )}
        {/* Serve precision — quant after research unlock */}
        <div className="rounded-xl border border-line/60 bg-void/40 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.75rem] font-medium text-bone">Serve precision</span>
            <span className="font-mono text-[0.6875rem] text-muted">
              {serveMods.label} · compute ×{serveMods.computeMult.toFixed(2)}
              {serveMods.capabilityDelta !== 0
                ? ` · cap ${serveMods.capabilityDelta}`
                : ''}
            </span>
          </div>
          {quantUnlocked ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(
                [
                  { id: 'fp16' as const, label: 'Full', hint: 'Best quality · full PF' },
                  { id: 'int8' as const, label: 'INT8', hint: '~68% compute · small eval hit' },
                  { id: 'int4' as const, label: 'INT4', hint: '~42% compute · severe eval and brand hit' },
                ] as { id: PlanServePrecision; label: string; hint: string }[]
              )
                .filter((o) => precisions.includes(o.id))
                .map((o) => {
                  const on = serveMods.precision === o.id
                  return (
                    <button
                      key={o.id}
                      type="button"
                      title={o.hint}
                      onClick={() => onChange({ servePrecision: o.id })}
                      className={`rounded-full px-2.5 py-1 text-[0.75rem] font-medium ${
                        on
                          ? 'bg-infer/25 text-infer ring-1 ring-infer/40'
                          : 'bg-void text-muted hover:text-bone'
                      }`}
                    >
                      {o.label}
                    </button>
                  )
                })}
            </div>
          ) : (
            <ResearchUnlockLink
              className="mt-1"
              nodeId="sys_quant"
              label="Unlock INT8 Quantization for cheaper serving"
            />
          )}
          {benchmarkModel ? (
            <div className="mt-2 overflow-x-auto rounded-lg border border-line/50">
              <table className="min-w-[37rem] w-full border-collapse font-mono text-[0.625rem]">
                <thead className="bg-panel-2 text-muted">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Precision</th>
                    <th className="px-2 py-1 text-right font-medium">Compute</th>
                    {benchmarkIds.map((id) => (
                      <th key={id} className="px-2 py-1 text-right font-medium">
                        {BENCHMARK_DEFS.find((benchmark) => benchmark.id === id)?.short ?? id}
                      </th>
                    ))}
                    <th className="px-2 py-1 text-right font-medium">Brand risk</th>
                  </tr>
                </thead>
                <tbody>
                  {(['fp16', 'int8', 'int4'] as PlanServePrecision[]).map((precision) => {
                    const preview = planServeModifiers(precision, ['sys_quant', 'sys_fp8'])
                    const activePrecision = serveMods.precision === precision
                    const available = precisions.includes(precision)
                    return (
                      <tr key={precision} className={`border-t border-line/40 ${activePrecision ? 'bg-infer/10 text-bone' : available ? 'text-muted' : 'text-muted/45'}`}>
                        <td className="px-2 py-1.5 font-semibold uppercase">
                          {precision === 'fp16' ? 'Full' : precision}
                          {!available ? ' · locked' : ''}
                        </td>
                        <td className="px-2 py-1.5 text-right">{Math.round(preview.computeMult * 100)}%</td>
                        {benchmarkIds.map((id) => {
                          const base = benchmarkModel.benchmarks[id] ?? 0
                          const score = Math.max(0, base + (preview.benchmarkDeltas[id] ?? 0))
                          return (
                            <td key={id} className={`px-2 py-1.5 text-right ${precision === 'int4' ? 'text-danger' : ''}`} title={`${benchmarkModel.name} ${id}: ${base.toFixed(0)} → ${score.toFixed(0)}`}>
                              {score.toFixed(0)}
                              {preview.benchmarkDeltas[id] ? <span className="ml-0.5 opacity-70">({preview.benchmarkDeltas[id]})</span> : null}
                            </td>
                          )
                        })}
                        <td className={`px-2 py-1.5 text-right ${preview.brandRisk >= 0.1 ? 'text-danger' : preview.brandRisk > 0 ? 'text-amber' : 'text-mint'}`}>
                          {preview.brandRisk === 0 ? 'none' : preview.brandRisk < 0.1 ? 'low' : 'severe'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {quantUnlocked && serveMods.precision !== 'fp16' && (
            <p className="mt-1 text-[0.6875rem] leading-snug text-amber">
              Quant saves inference PF for this plan only. The displayed eval loss affects demand;
              sustained severe INT4 exposure also reduces brand trust.
            </p>
          )}
        </div>

        <div>
          <div className="rounded-xl border border-infer/25 bg-infer/5 px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[0.75rem] font-medium text-bone">Offering breadth</div>
                <p className="mt-0.5 text-[0.6875rem] text-muted">Best safe generation model per modality.</p>
              </div>
              <span className="font-mono text-sm text-infer">{offeringBreadth.score.toFixed(2)} / 18</span>
            </div>
            {offeringBreadth.contributors.length > 0 ? (
              <div className="mt-2 grid gap-1 sm:grid-cols-3">
                {offeringBreadth.contributors.map((contributor) => (
                  <div key={contributor.modality} className="rounded-md border border-line/60 bg-void/45 px-2 py-1.5">
                    <div className="flex justify-between font-mono text-[0.625rem] uppercase text-muted">
                      <span>{contributor.modality}</span>
                      <span className="text-mint">+{contributor.points.toFixed(2)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[0.6875rem] text-bone" title={contributor.modelName}>{contributor.modelName}</div>
                    <div className="font-mono text-[0.625rem] text-muted">suite {contributor.composite.toFixed(2)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-[0.6875rem] text-amber">Add an image, video, or audio model scoring at least 35 with safety at least 30.</p>
            )}
          </div>

          <div className="text-[0.75rem] text-muted">Models on this plan</div>
          {models.length === 0 ? (
            <p className="mt-1 text-[0.75rem] text-amber">Ship a model first</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1">
              {models.map((m) => {
                const on = plan.modelIds.includes(m.id)
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      const modelIds = on
                        ? plan.modelIds.filter((id) => id !== m.id)
                        : [...plan.modelIds, m.id]
                      onChange({ modelIds })
                    }}
                    className={`rounded-full px-2 py-0.5 text-[0.75rem] ${
                      on ? 'bg-mint/20 text-mint' : 'bg-void text-muted'
                    }`}
                  >
                    {m.name}
                  </button>
                )
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
  )
}

function KpiCell({
  label,
  value,
  sub,
  accent = 'text-bone',
  bar,
  barWarn,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
  bar?: number | null
  barWarn?: boolean
}) {
  return (
    <div className="bg-panel-2 px-2.5 py-2.5">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-sm font-semibold tabular-nums ${accent}`}>
        {value}
      </div>
      {sub && (
        <div title={sub} className="mt-0.5 truncate font-mono text-[0.6875rem] leading-snug text-muted">{sub}</div>
      )}
      {bar != null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-void">
          <div
            className={`h-full ${barWarn ? 'bg-amber' : 'bg-mint/80'}`}
            style={{ width: `${Math.max(0, Math.min(100, bar * 100))}%` }}
          />
        </div>
      )}
    </div>
  )
}

function Mini({
  label,
  value,
  danger,
}: {
  label: string
  value: string
  danger?: boolean
}) {
  return (
    <div className="rounded-lg border border-line/50 bg-void/40 px-2 py-1.5">
      <div className="text-[0.6875rem] uppercase text-muted">{label}</div>
      <div className={`font-mono text-[0.8125rem] ${danger ? 'text-danger' : 'text-bone'}`}>
        {value}
      </div>
    </div>
  )
}
