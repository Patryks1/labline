import { useMemo, useState } from 'react'
import { SEGMENTS, WORLD_POPULATION } from '../../../sim/balance/economy'
import {
  deriveProductPortfolio,
  PRODUCT_CHANNELS,
} from '../../../sim/systems/productPortfolio'
import type { ProductChannel, ProductOffer } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { selectCompanyModels, selectPlayerCompany } from '../../../sim/company'
import { audience, money, num, pct, people } from '../format'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'
import {
  CardGrid,
  GameCard,
  MeterBar,
  SegmentedTabs,
  StatRow,
} from '../ui/kit'
import { buildFinanceDashboardModel } from '../data/financeDashboardModel'

const PRODUCT_CHANNEL_LABELS: Record<ProductChannel, string> = {
  free_assistant: 'Free assistant',
  consumer_pro: 'Consumer Pro',
  creator_developer: 'Creator / Developer',
  payg_api: 'Pay-as-you-go API',
  reserved_throughput_api: 'Reserved throughput',
  enterprise_dedicated: 'Enterprise dedicated',
}

type MarketTab = 'share' | 'segments' | 'products'

function formatProductOfferPrice(offer: ProductOffer): string {
  const price = offer.pricing
  if (price.monthlyUsd != null) return price.monthlyUsd <= 0 ? 'free' : `${money(price.monthlyUsd)}/mo`
  if (price.minimumCommitmentUsd != null) return `${money(price.minimumCommitmentUsd)} min`
  if (price.inputUsdPerMTok != null || price.outputUsdPerMTok != null) {
    return `${money(price.inputUsdPerMTok ?? 0)}/${money(price.outputUsdPerMTok ?? 0)} per MTok`
  }
  return price.billingModel.replace('_', ' ')
}

export function MarketPanel() {
  const state = useGameStore((s) => s.state)
  const playerCompany = selectPlayerCompany(state)
  const playerModels = selectCompanyModels(state, playerCompany.id)
  const setPanel = useGameStore((s) => s.setPanel)
  const portfolio = deriveProductPortfolio(state)
  const financeModel = useMemo(() => buildFinanceDashboardModel(state), [state])
  const shares = state.lastMarket.sharesByLab
  const [tab, setTab] = useState<MarketTab>('share')

  const labs = useMemo(
    () => [
      { id: 'player', name: 'You' },
      ...state.rivals.map((r) => ({ id: r.id, name: r.name })),
    ],
    [state.rivals],
  )

  const shareRows = useMemo(
    () =>
      labs
        .map((lab) => ({
          ...lab,
          value: Math.max(0, shares[lab.id] ?? 0),
        }))
        .sort((a, b) => b.value - a.value),
    [labs, shares],
  )

  const playerShare = shares.player ?? 0
  const aiUsers = state.segments.reduce((sum, segment) => sum + Math.max(0, segment.size), 0)
  const peopleToConvert = Math.max(0, WORLD_POPULATION - aiUsers)
  const demandMTok = state.lastMarket.playerDemandMTok
  const servedMTok = state.lastMarket.servedMTok
  const serveRatio = demandMTok > 0 ? Math.min(1, servedMTok / demandMTok) : 1
  const unserved = state.lastMarket.unservedRatio
  const demandPf = state.lastMarket.demandPf ?? 0
  const capacityPf = state.lastMarket.capacityPf ?? 0
  const overloaded = unserved > 0.08 && demandPf > capacityPf * 1.02
  const paidSubs =
    state.lastMarket.planStats
      ?.filter((p) => !p.isFree)
      .reduce((s, p) => s + p.subscribers, 0) ?? 0
  const freeSubs =
    state.lastMarket.planStats
      ?.filter((p) => p.isFree)
      .reduce((s, p) => s + p.subscribers, 0) ?? 0

  return (
    <PanelScaffold
      eyebrow="Commercial"
      title="Market"
      description="Share, segments, and surfaces."
      mobileDescription="Share, demand, and products."
      actions={
        <HudButton type="button" variant="ghost" onClick={() => setPanel('stats')}>
          Command
        </HudButton>
      }
    >
      <div className="grid grid-cols-2 gap-2" data-mobile-summary="market-position">
        <MetricTile label="Your share" value={pct(playerShare, 1)} tone="positive" />
        <MetricTile
          label="Served / demand"
          value={`${num(servedMTok, 0)}/${num(demandMTok, 0)}`}
          detail="MTok/d"
          tone={serveRatio < 0.92 ? 'danger' : 'serve'}
        />
        <MetricTile
          label="Unserved"
          value={pct(unserved, 0)}
          tone={unserved > 0.08 ? 'danger' : unserved > 0.03 ? 'warning' : 'neutral'}
        />
        <MetricTile
          label="Paid / free"
          value={`${people(paidSubs)}`}
          detail={`${people(freeSubs)} free`}
          mobilePriority="secondary"
        />
      </div>

      <div className="mt-3">
        <SegmentedTabs
          ariaLabel="Market sections"
          active={tab}
          onChange={(id) => setTab(id as MarketTab)}
          items={[
            { id: 'share', label: 'Share' },
            { id: 'segments', label: 'Segments' },
            { id: 'products', label: `Surfaces (${portfolio.promoted.length}/6)` },
          ]}
        />
      </div>

      <div key={tab} className="panel-swap mt-3">
        {tab === 'share' && (
          <ShareView
            shareRows={shareRows}
            playerShare={playerShare}
            serveRatio={serveRatio}
            demandMTok={demandMTok}
            servedMTok={servedMTok}
            demandPf={demandPf}
            capacityPf={capacityPf}
            unserved={unserved}
            overloaded={overloaded}
            aiUsers={aiUsers}
            peopleToConvert={peopleToConvert}
            dayNet={financeModel.current.net}
            marginPerMTok={playerCompany.finance.marginPerMTok}
            marginPerSub={playerCompany.finance.marginPerSub}
            latencyScore={state.lastMarket.latencyScore}
            effectiveLatency={state.lastMarket.effectiveLatencyScore ?? state.lastMarket.latencyScore}
            servicePain={state.lastMarket.servicePain ?? playerCompany.ops.servicePain ?? 0}
            industryDemand={state.lastMarket.industryDemandMTok ?? state.lastMarket.demandMTok}
            industryServed={state.lastMarket.industryServedMTok ?? state.lastMarket.servedMTok}
            capacityMTok={state.lastMarket.capacityMTok ?? 0}
            servedPf={state.lastMarket.servedPf ?? 0}
          />
        )}
        {tab === 'segments' && <SegmentsView segments={state.segments} />}
        {tab === 'products' && (
          <ProductsView
            portfolio={portfolio}
            models={playerModels}
          />
        )}
      </div>
    </PanelScaffold>
  )
}

function ShareView({
  shareRows,
  playerShare,
  serveRatio,
  demandMTok,
  servedMTok,
  demandPf,
  capacityPf,
  unserved,
  overloaded,
  aiUsers,
  peopleToConvert,
  dayNet,
  marginPerMTok,
  marginPerSub,
  latencyScore,
  effectiveLatency,
  servicePain,
  industryDemand,
  industryServed,
  capacityMTok,
  servedPf,
}: {
  shareRows: { id: string; name: string; value: number }[]
  playerShare: number
  serveRatio: number
  demandMTok: number
  servedMTok: number
  demandPf: number
  capacityPf: number
  unserved: number
  overloaded: boolean
  aiUsers: number
  peopleToConvert: number
  dayNet: number
  marginPerMTok: number
  marginPerSub: number
  latencyScore: number
  effectiveLatency: number
  servicePain: number
  industryDemand: number
  industryServed: number
  capacityMTok: number
  servedPf: number
}) {
  const maxShare = Math.max(0.0001, ...shareRows.map((row) => row.value))

  return (
    <div className="space-y-3">
      <GameCard eyebrow="Battlefield" title="Market share" tone="mint">
        <div className="anim-stagger space-y-2.5">
          {shareRows.map((row) => {
            const isYou = row.id === 'player'
            return (
              <MeterBar
                key={row.id}
                label={
                  <span className={isYou ? 'font-semibold text-mint' : undefined}>
                    {row.name}
                  </span>
                }
                value={row.value / maxShare}
                detail={pct(row.value, 1)}
                tone={isYou ? 'positive' : 'serve'}
                live={isYou && playerShare > 0}
              />
            )
          })}
        </div>
        <details className="group mt-3 border-t border-line/50 pt-1">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-[0.75rem] marker:hidden lg:min-h-0">
            <span className="font-medium text-bone">Market reach</span>
            <span className="font-mono text-muted">{audience(aiUsers)} AI users · <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">⌄</span></span>
          </summary>
        <div className="grid grid-cols-2 gap-2 pb-1">
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">You</div>
            <div className="font-mono text-xl font-semibold tabular-nums text-mint">
              {pct(playerShare, 1)}
            </div>
          </div>
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">Industry</div>
            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
              {num(industryDemand, 0)}/{num(industryServed, 0)}
            </div>
            <div className="text-[0.6875rem] text-muted">MTok demand/served</div>
          </div>
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">AI users</div>
            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
              {audience(aiUsers)}
            </div>
            <div className="text-[0.6875rem] text-muted">
              {pct(aiUsers / WORLD_POPULATION, 0)} of world
            </div>
          </div>
          <div>
            <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">To convert</div>
            <div className="font-mono text-[0.8125rem] tabular-nums text-bone">
              {audience(peopleToConvert)}
            </div>
          </div>
        </div>
        </details>
      </GameCard>

      <GameCard
        eyebrow="Capacity"
        title="Demand vs inference"
        tone={overloaded ? 'danger' : unserved > 0.03 ? 'train' : 'infer'}
        actions={
          overloaded ? <StatusChip tone="danger">Overloaded</StatusChip> : undefined
        }
      >
        <MeterBar
          label="Your demand served"
          value={serveRatio}
          detail={`${num(servedMTok, 1)} / ${num(demandMTok, 1)} MTok`}
          tone={serveRatio < 0.92 ? 'danger' : serveRatio < 0.98 ? 'warning' : 'positive'}
          live={serveRatio < 1}
        />
        <div className="mt-2.5">
          <MeterBar
            label="Inference PF"
            value={capacityPf > 0 ? Math.min(1, demandPf / capacityPf) : demandPf > 0 ? 1 : 0}
            detail={`${num(demandPf, 2)} / ${num(capacityPf, 2)} PF`}
            tone={demandPf > capacityPf * 1.02 ? 'danger' : 'serve'}
          />
        </div>
        <details className="group mt-2 border-t border-line/50 pt-1">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 py-2 text-[0.75rem] marker:hidden lg:min-h-0">
            <span className="font-medium text-bone">Operational detail</span>
            <span className={unserved > 0.08 ? 'font-mono text-danger' : 'font-mono text-muted'}>
              {pct(unserved, 0)} unserved · <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-180">⌄</span>
            </span>
          </summary>
        <div className="space-y-0.5 pb-1">
          <StatRow label="Admitted inference" value={`${num(servedPf, 2)} PF`} />
          <StatRow label="Token capacity" value={`${num(capacityMTok, 1)} MTok/d`} />
          <StatRow
            label="Unserved"
            value={pct(unserved, 0)}
            tone={unserved > 0.08 ? 'danger' : unserved > 0.03 ? 'warning' : 'neutral'}
            strong
          />
          <StatRow
            label="Felt latency"
            value={`${num(effectiveLatency, 0)} (campus ${num(latencyScore, 0)})`}
            tone={effectiveLatency < 40 ? 'danger' : effectiveLatency < 55 ? 'warning' : 'neutral'}
          />
          <StatRow
            label="Service pain"
            value={pct(servicePain, 0)}
            tone={servicePain > 0.2 ? 'danger' : servicePain > 0.08 ? 'warning' : 'neutral'}
          />
        </div>
        </details>
        {overloaded ? (
          <p className="mt-2 text-[0.8125rem] leading-snug text-danger">
            Demand exceeds inference PF. Add racks, power, Serve %, or serving-efficiency research.
          </p>
        ) : null}
      </GameCard>

      <GameCard eyebrow="Unit economics" title="Margins" tone={dayNet < 0 ? 'danger' : 'mint'}>
        <div className="space-y-0.5">
          <StatRow
            label="Margin / MTok"
            value={money(marginPerMTok)}
            tone={marginPerMTok < 0 ? 'danger' : 'positive'}
            strong
          />
          <StatRow
            label="Margin / sub"
            value={money(marginPerSub)}
            tone={marginPerSub < 0 ? 'danger' : 'positive'}
            strong
          />
          <StatRow
            label="Day net"
            value={money(dayNet)}
            tone={dayNet < 0 ? 'danger' : 'positive'}
            strong
          />
        </div>
      </GameCard>
    </div>
  )
}

function SegmentsView({
  segments,
}: {
  segments: Array<{ id: string; size: number; providerShares?: Record<string, number> }>
}) {
  const maxSize = Math.max(1, ...segments.map((segment) => Math.max(0, segment.size)))

  return (
    <GameCard eyebrow="Demographics" title="Audience scale" tone="research">
      <div className="anim-stagger space-y-3">
        {SEGMENTS.map((s) => {
          const st = segments.find((x) => x.id === s.id)
          const size = Math.max(0, st?.size ?? 0)
          const playerShare = Math.max(0, st?.providerShares?.player ?? 0)
          const estimatedUsers = size * playerShare
          const cares = Object.entries(s.benchmarkWeights)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
            .slice(0, 3)
            .map(([k]) => k)
            .join(', ')
          return (
            <div key={s.id} className="rounded-md border border-line/70 bg-void/30 p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[0.8125rem] font-medium text-bone">{s.name}</div>
                  <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                    floor {s.qualityFloor} · {cares || 'general'}
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[0.8125rem] tabular-nums">
                  <div className="text-bone">{audience(size)}</div>
                  <div className="text-mint">{pct(playerShare, 0)} · {audience(estimatedUsers)}</div>
                </div>
              </div>
              <div className="mt-2 h-3 overflow-hidden rounded-sm bg-line/50">
                <div
                  className="h-full bg-research/80"
                  style={{ width: `${(size / maxSize) * 100}%` }}
                  title={`${s.name}: ${audience(size)}`}
                />
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line/40">
                <div
                  className="h-full bg-mint"
                  style={{ width: `${Math.min(100, playerShare * 100)}%` }}
                  title={`Your share ${pct(playerShare, 1)}`}
                />
              </div>
            </div>
          )
        })}
      </div>
    </GameCard>
  )
}

function ProductsView({
  portfolio,
  models,
}: {
  portfolio: ReturnType<typeof deriveProductPortfolio>
  models: { id: string; name: string }[]
}) {
  if (PRODUCT_CHANNELS.length === 0) {
    return <EmptyState title="No surfaces" description="Product channels will appear here." />
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <StatusChip tone={portfolio.promoted.length === 6 ? 'positive' : 'warning'}>
          {portfolio.promoted.length}/6 live
        </StatusChip>
      </div>
      <CardGrid min="13rem" className="anim-stagger">
        {PRODUCT_CHANNELS.map((channel) => {
          const offer = portfolio.byChannel[channel]
          const model = offer
            ? models.find((candidate) => candidate.id === offer.primaryModelId)
            : undefined
          return (
            <GameCard
              key={channel}
              eyebrow={offer ? 'Live' : 'Missing'}
              title={PRODUCT_CHANNEL_LABELS[channel]}
              tone={offer ? 'mint' : undefined}
              actions={
                <StatusChip tone={offer ? 'positive' : 'neutral'}>
                  {offer ? 'live' : 'gap'}
                </StatusChip>
              }
            >
              <div className="truncate font-mono text-[0.8125rem] tabular-nums text-bone">
                {offer
                  ? `${model?.name ?? 'Model'} · ${formatProductOfferPrice(offer)}`
                  : 'Release a compatible model'}
              </div>
            </GameCard>
          )
        })}
      </CardGrid>
    </div>
  )
}
