import { useMemo, useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { ResearchUnlockLink } from '../ui/ResearchUnlockLink'
import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_QUALITY_LABELS,
  DATA_SELLER_LABELS,
  ensureDataMarket,
  ensureLabData,
  estimateAllDataPrunes,
  estimateDataPruneAudit,
  estimateDataPrune,
  estimateSynthBudget,
  formatTokens,
  totalProcessed,
  totalRaw,
  totalSources,
  type DataPortfolioChannel,
  type DataPruneEstimate,
} from '../../../sim/systems/data'
import { money, num, pct } from '../format'
import type { DataDomain, DataQualityBand, DataSellerKind } from '../../../sim/types'
import {
  BlockerList,
  CardGrid,
  GameCard,
  LiveDot,
  MeterBar,
  SegmentedTabs,
  StatRow,
  type Blocker,
} from '../ui/kit'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'

type CorpusSourceKey = 'web' | 'bought' | 'user' | 'synth'
type DataTab = 'stocks' | 'sources' | 'market' | 'synth'

const CORPUS_SOURCE_META: Record<
  CorpusSourceKey,
  { label: string; color: string; signal: string; risk: string }
> = {
  web: {
    label: 'Web',
    color: '#7c8b99',
    signal: 'Broad coverage',
    risk: 'Noisy and repetitive',
  },
  bought: {
    label: 'Bought',
    color: '#e9ad55',
    signal: 'Clearer rights',
    risk: 'Expensive and finite',
  },
  user: {
    label: 'User',
    color: '#57d6cb',
    signal: 'Fresh product signal',
    risk: 'Trust-sensitive',
  },
  synth: {
    label: 'Synth',
    color: '#a58be0',
    signal: 'Scales continuously',
    risk: 'Teacher can go stale',
  },
}

const MARKET_FILTERS = [
  ['all', 'All'],
  ['scrap', 'Scrap'],
  ['standard', 'Standard'],
  ['premium', 'Premium'],
  ['curated', 'Curated'],
  ['code', 'Code'],
  ['chat', 'Chat'],
  ['law', 'Law'],
  ['health', 'Health'],
  ['web_scrape', 'Scrapers'],
  ['rival', 'Rivals'],
  ['enterprise', 'Enterprise'],
] as const

export function DataPanel() {
  const state = useGameStore((s) => s.state)
  const setCollectionRate = useGameStore((s) => s.setCollectionRate)
  const setAutoProcess = useGameStore((s) => s.setAutoProcess)
  const enqueueProcess = useGameStore((s) => s.enqueueProcess)
  const enqueueProcessAll = useGameStore((s) => s.enqueueProcessAll)
  const enqueueDataPrune = useGameStore((s) => s.enqueueDataPrune)
  const enqueueAllDataPrunes = useGameStore((s) => s.enqueueAllDataPrunes)
  const purchaseDataPruneAudit = useGameStore((s) => s.purchaseDataPruneAudit)
  const buyDataPortfolio = useGameStore((s) => s.buyDataPortfolio)
  const buyDomainContract = useGameStore((s) => s.buyDomainContract)
  const startSynthBudget = useGameStore((s) => s.startSynthBudget)
  const cancelSynthGen = useGameStore((s) => s.cancelSynthGen)

  const data = ensureLabData(state)
  const raw = totalRaw(data)
  const proc = totalProcessed(data)
  const sources = totalSources(data)
  const sourceTotal = sources.web + sources.user + sources.bought + sources.synth
  const srcSum = sourceTotal || 1
  const playerDataOrders = state.worldMarkets.orders.filter(
    (order) => order.labId === state.playerLabId && order.kind === 'data',
  )
  const dataReserved = playerDataOrders.reduce((sum, order) => sum + order.cashReserved, 0)
  const latestDataFills = state.worldMarkets.fills.filter(
    (fill) => fill.labId === state.playerLabId && fill.kind === 'data',
  )

  const [tab, setTab] = useState<DataTab>('stocks')
  const [genShare, setGenShare] = useState(0.25)
  const [selectedSource, setSelectedSource] = useState<CorpusSourceKey>('user')
  const [marketFilter, setMarketFilter] = useState<
    'all' | DataQualityBand | DataDomain | DataSellerKind
  >('all')
  const [portfolioBudgetM, setPortfolioBudgetM] = useState(7.5)
  const [portfolioMix, setPortfolioMix] = useState<Record<DataPortfolioChannel, number>>({
    open: 35,
    broker: 25,
    enterprise: 30,
    rival: 10,
  })

  const synthUnlocked = state.player.researchUnlocked.includes('data_synth')
  const market = ensureDataMarket(state).dataMarket!
  const pruneEstimates = useMemo(
    () => new Map(DATA_DOMAINS.map((domain) => [domain, estimateDataPrune(state, domain)])),
    [state],
  )
  const pruneAllEstimate = useMemo(() => estimateAllDataPrunes(state), [state])
  const pruneAuditEstimate = useMemo(() => estimateDataPruneAudit(state), [state])
  const synthEstimate = useMemo(() => estimateSynthBudget(state, genShare), [state, genShare])
  const autoSynthJob = data.synthQueue.find((job) => job.autoPortfolio)

  const sourceMix = (['web', 'bought', 'user', 'synth'] as const).map((key) => ({
    key,
    value: sources[key],
    share: sources[key] / srcSum,
    ...CORPUS_SOURCE_META[key],
  }))
  const selectedSourceInfo = sourceMix.find((source) => source.key === selectedSource)!
  const sourceDomainRows = DATA_DOMAINS.map((domain) => {
    const stock = data.stocks[domain]
    const volume =
      selectedSource === 'web'
        ? stock.fromWeb
        : selectedSource === 'bought'
          ? stock.fromBought
          : selectedSource === 'user'
            ? stock.fromUser
            : stock.fromSynth
    return { domain, volume: volume ?? 0, quality: stock.quality }
  }).sort((left, right) => right.volume - left.volume)

  const sourceQualityNumerator = sourceDomainRows.reduce(
    (sum, row) => sum + row.volume * row.quality,
    0,
  )
  const sourceQuality =
    selectedSourceInfo.value > 0 ? sourceQualityNumerator / selectedSourceInfo.value : 0
  const sourceQualityBand =
    sourceQuality >= 75
      ? 'High'
      : sourceQuality >= 55
        ? 'Medium'
        : sourceQuality > 0
          ? 'Low'
          : 'No stock'

  const readyShare = proc / Math.max(1, raw + proc)
  const licensedShare = sourceTotal > 0 ? (sources.bought + sources.user) / sourceTotal : 0
  const avgQuality =
    DATA_DOMAINS.reduce((sum, domain) => {
      const stock = data.stocks[domain]
      return sum + (stock.raw + stock.processed) * stock.quality
    }, 0) / Math.max(1, raw + proc)
  const domainsCovered = DATA_DOMAINS.filter((domain) => {
    const stock = data.stocks[domain]
    return stock.raw + stock.processed > 0.5
  }).length
  const collectionRisk =
    data.collectionRate >= 0.8
      ? 'High trust risk'
      : data.collectionRate >= 0.55
        ? 'Guarded'
        : 'Low risk'

  const liveOffers = market.offers.filter((offer) => offer.mTokLeft > 0)
  const pruneAllBlockers: Blocker[] = !pruneAllEstimate.ok
    ? [{ text: pruneAllEstimate.reason ?? 'Cannot prune all domains', tone: 'warning' }]
    : []
  const auditBlockers: Blocker[] = !pruneAuditEstimate.ok
    ? [{ text: pruneAuditEstimate.reason ?? 'Cannot audit corpus', tone: 'warning' }]
    : []
  const synthBlockers: Blocker[] = []
  if (!synthUnlocked) synthBlockers.push({ text: 'Unlock Synthetic Generators research', tone: 'warning' })
  if (!synthEstimate.model) synthBlockers.push({ text: 'Need a usable teacher model', tone: 'warning' })

  return (
    <PanelScaffold
      eyebrow="Assets · Rights · Synth"
      title="Data"
      description="Corpus stocks, acquisition, and synthetic generation."
      actions={
        <StatusChip tone={readyShare >= 0.7 ? 'positive' : 'warning'}>
          {pct(readyShare, 0)} ready
        </StatusChip>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile label="Corpus" value={formatTokens(raw + proc)} detail={`${formatTokens(proc)} ready`} />
        <MetricTile
          label="Licensed"
          value={pct(licensedShare, 0)}
          detail={`${formatTokens(sources.bought + sources.user)} bought/user`}
          tone="positive"
        />
        <MetricTile
          label="Quality"
          value={avgQuality > 0 ? `Q${Math.round(avgQuality)}` : '—'}
          detail={`${domainsCovered}/${DATA_DOMAINS.length} domains`}
          tone={avgQuality >= 70 ? 'positive' : avgQuality >= 50 ? 'warning' : 'neutral'}
        />
        <MetricTile
          label="Today"
          value={`+${formatTokens(data.dayProcessed + (data.daySynthMTok ?? 0))}`}
          detail={`${data.assets.length} assets · ${data.manifests.length} manifests`}
          tone={autoSynthJob ? 'research' : 'neutral'}
        />
      </div>

      <div className="mt-3">
        <SegmentedTabs
          ariaLabel="Data views"
          active={tab}
          onChange={(id) => setTab(id as DataTab)}
          items={[
            { id: 'stocks', label: 'Stocks' },
            { id: 'sources', label: 'Sources' },
            {
              id: 'market',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Market
                  <span className="font-mono text-[0.625rem] text-muted">{liveOffers.length}</span>
                </span>
              ),
            },
            {
              id: 'synth',
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

      <div key={tab} className="panel-swap mt-3 space-y-3">
        {tab === 'stocks' && (
          <>
            <GameCard
              eyebrow="Flywheel"
              title="Collect & clean"
              tone="mint"
              actions={
                <StatusChip
                  tone={
                    data.collectionRate >= 0.8
                      ? 'danger'
                      : data.collectionRate >= 0.55
                        ? 'warning'
                        : 'positive'
                  }
                >
                  {collectionRisk}
                </StatusChip>
              }
            >
              <label className="block text-[0.6875rem] text-muted">
                <span className="flex items-center justify-between">
                  <span>Traffic collection</span>
                  <strong className="font-mono tabular-nums text-bone">
                    {Math.round(data.collectionRate * 100)}%
                  </strong>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(data.collectionRate * 100)}
                  onChange={(e) => setCollectionRate(Number(e.target.value) / 100)}
                  className="mt-1.5 w-full"
                />
              </label>
              <div className="mt-2 grid grid-cols-3 gap-x-3">
                <StatRow label="Collected" value={formatTokens(data.dayCollected)} />
                <StatRow label="Processed" value={formatTokens(data.dayProcessed)} />
                <StatRow label="Queue" value={`${data.processQueue.length}/6`} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[0.8125rem] text-bone">
                  <input
                    type="checkbox"
                    checked={data.autoProcess}
                    onChange={(e) => setAutoProcess(e.target.checked)}
                  />
                  Auto-clean
                </label>
                <HudButton variant="secondary" onClick={() => enqueueProcessAll()}>
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
                  <HudButton variant="ghost" onClick={() => enqueueProcessAll()}>
                    Clean all
                  </HudButton>
                  <HudButton
                    variant="ghost"
                    disabled={!pruneAllEstimate.ok}
                    title={pruneAllEstimate.reason}
                    onClick={() => enqueueAllDataPrunes()}
                  >
                    Prune all
                  </HudButton>
                </div>
              }
            >
              {pruneAllBlockers.length > 0 ? <div className="mb-2"><BlockerList items={pruneAllBlockers} /></div> : null}
              {pruneAuditEstimate.unlocked ? (
                <div className="mb-2 rounded-md border border-amber/20 bg-amber/5 px-2.5 py-2 text-[0.75rem]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted">
                      Audit live · discard{' '}
                      <strong className="font-mono tabular-nums text-amber">
                        {formatTokens(pruneAllEstimate.totalMTok)}
                      </strong>
                    </span>
                    <span className="font-mono tabular-nums text-muted">
                      {money(pruneAllEstimate.cashCost)} · {num(pruneAllEstimate.pfDays, 0)} PFd ·{' '}
                      {pruneAllEstimate.researchersRequired}R
                    </span>
                  </div>
                  <p className="mt-1 text-mint">Volumes unlocked through D{pruneAuditEstimate.validUntilDay}.</p>
                </div>
              ) : (
                <div className="mb-2 space-y-2">
                  {auditBlockers.length > 0 ? <BlockerList items={auditBlockers} /> : null}
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
                  const stock = data.stocks[domain]
                  const queued = data.processQueue
                    .filter((job) => job.domain === domain)
                    .reduce((sum, job) => sum + job.remaining, 0)
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
                      onProcess={() => enqueueProcess(domain, Math.min(stock.raw, 50), 70)}
                      onPrune={() => enqueueDataPrune(domain)}
                    />
                  )
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
                  <StatusChip tone="warning">{data.pruneQueue.length} active</StatusChip>
                }
              >
                <div className="anim-stagger space-y-2">
                  {data.pruneQueue.map((job) => {
                    const total = job.rawTotal + job.processedTotal
                    const remaining = job.rawRemaining + job.processedRemaining
                    const done = 1 - remaining / Math.max(0.01, total)
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
                            {num(total * job.pfDaysPerMTok, 0)} PFd · {job.researchersRequired}R ·{' '}
                            {pct(job.researchShare, 0)} research
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </GameCard>
            ) : null}
          </>
        )}

        {tab === 'sources' && (
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
                <button
                  key={source.key}
                  type="button"
                  onClick={() => setSelectedSource(source.key)}
                  aria-pressed={selectedSource === source.key}
                  className={`rounded-md border px-2.5 py-2 text-left transition ${
                    selectedSource === source.key
                      ? 'border-mint/50 bg-mint/10'
                      : 'border-line/70 bg-void/35 hover:border-line hover:bg-void/55'
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
                </button>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-3 gap-x-3">
              <StatRow label="Share" value={pct(selectedSourceInfo.share, 0)} strong />
              <StatRow
                label="Quality"
                value={
                  sourceQuality > 0
                    ? `Q${Math.round(sourceQuality)} · ${sourceQualityBand}`
                    : 'No stock'
                }
              />
              <StatRow
                label="Signal"
                value={
                  selectedSource === 'synth' && selectedSourceInfo.value > 0
                    ? `${pct((sources.synthHQ ?? 0) / selectedSourceInfo.value, 0)} HQ`
                    : selectedSourceInfo.signal
                }
              />
            </div>

            <div className="mt-3 border-t border-line/60 pt-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-[0.6875rem]">
                <span className="uppercase tracking-[0.12em] text-muted">Top domains</span>
                <span className="text-amber">Watch: {selectedSourceInfo.risk}</span>
              </div>
              <div className="anim-stagger space-y-2">
                {sourceDomainRows.slice(0, 4).map((row) => (
                  <MeterBar
                    key={row.domain}
                    label={DATA_DOMAIN_META[row.domain].label}
                    value={row.volume / Math.max(1, sourceDomainRows[0]?.volume ?? 1)}
                    detail={formatTokens(row.volume)}
                    tone="positive"
                  />
                ))}
              </div>
            </div>
          </GameCard>
        )}

        {tab === 'market' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <MetricTile label="Open bids" value={String(playerDataOrders.length)} />
              <MetricTile label="Reserved" value={money(dataReserved)} tone="warning" />
              <MetricTile
                label="Last fill"
                value={
                  latestDataFills[0]
                    ? formatTokens(latestDataFills[0].quantity)
                    : '—'
                }
                detail={
                  latestDataFills[0] ? `${money(latestDataFills[0].unitPrice)}/MTok` : undefined
                }
              />
            </div>

            <GameCard
              eyebrow="Live lots"
              title="Acquire data"
              tone="mint"
              actions={
                <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
                  {liveOffers.length} live · refresh D{market.nextRefreshDay}
                </span>
              }
            >
              <div className="flex flex-wrap gap-1">
                {MARKET_FILTERS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMarketFilter(id)}
                    className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${
                      marketFilter === id
                        ? 'bg-mint/20 text-mint ring-1 ring-mint/30'
                        : 'bg-void/50 text-muted hover:text-bone'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="anim-stagger mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
                {market.offers
                  .filter((offer) => {
                    if (marketFilter === 'all') return true
                    if (
                      marketFilter === 'scrap' ||
                      marketFilter === 'standard' ||
                      marketFilter === 'premium' ||
                      marketFilter === 'curated'
                    ) {
                      return offer.qualityBand === marketFilter
                    }
                    if (
                      marketFilter === 'web_scrape' ||
                      marketFilter === 'rival' ||
                      marketFilter === 'enterprise' ||
                      marketFilter === 'broker' ||
                      marketFilter === 'research_lab' ||
                      marketFilter === 'opensource'
                    ) {
                      return offer.sellerKind === marketFilter
                    }
                    return offer.domain === marketFilter
                  })
                  .map((offer) => {
                    const soldOut = offer.mTokLeft <= 0
                    const lot = Math.min(
                      offer.lotMTok,
                      Math.max(0, offer.mTokLeft) || offer.lotMTok,
                    )
                    const stockPct =
                      offer.mTokTotal > 0
                        ? Math.min(1, offer.mTokLeft / offer.mTokTotal)
                        : 0
                    const broke = state.player.cash < offer.cash || soldOut
                    const pending = playerDataOrders.find(
                      (order) => order.resourceId === offer.id,
                    )
                    const fill = latestDataFills.find(
                      (entry) => entry.resourceId === offer.id,
                    )
                    const blockers: Blocker[] = []
                    if (soldOut) blockers.push({ text: 'Sold out' })
                    else if (state.player.cash < offer.cash) {
                      blockers.push({
                        text: `Need ${money(offer.cash)} cash`,
                        tone: 'warning',
                      })
                    }
                    return (
                      <div
                        key={offer.id}
                        className={`rounded-md border px-2.5 py-2 ${
                          soldOut
                            ? 'border-line/50 bg-void/20 opacity-70'
                            : 'border-line/70 bg-void/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-[0.8125rem] font-medium text-bone">
                                {offer.name}
                              </span>
                              <StatusChip
                                tone={
                                  offer.qualityBand === 'curated'
                                    ? 'positive'
                                    : offer.qualityBand === 'premium'
                                      ? 'warning'
                                      : 'neutral'
                                }
                              >
                                {DATA_QUALITY_LABELS[offer.qualityBand]}
                              </StatusChip>
                              <StatusChip tone="neutral">
                                {DATA_DOMAIN_META[offer.domain].label}
                              </StatusChip>
                            </div>
                            <p className="mt-0.5 truncate text-[0.75rem] text-muted">
                              {offer.sellerName} · {DATA_SELLER_LABELS[offer.sellerKind]}
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                              <span>Q{offer.quality}</span>
                              <span>
                                Lot {formatTokens(lot)}
                                {offer.mTokLeft > 0 && offer.mTokLeft < offer.mTokTotal
                                  ? ` · ${formatTokens(offer.mTokLeft)} left`
                                  : offer.mTokLeft <= 0
                                    ? ' · sold out'
                                    : ` · ${formatTokens(offer.mTokTotal)} listed`}
                              </span>
                              <span>{offer.daysLeft}d left</span>
                              <span>
                                ~
                                {money(
                                  Math.round(
                                    offer.cash /
                                      Math.max(
                                        1,
                                        Math.min(offer.lotMTok, offer.mTokLeft || offer.lotMTok),
                                      ),
                                  ),
                                )}
                                /MTok
                              </span>
                              {fill ? (
                                <span className="text-mint">
                                  last clear {money(fill.unitPrice)}/MTok
                                </span>
                              ) : null}
                              {pending ? (
                                <span className="text-amber">
                                  bid queued · {money(pending.cashReserved)} · D{state.day + 1}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1.5">
                              <MeterBar
                                value={stockPct}
                                detail={`${pct(stockPct, 0)} stock`}
                                tone={soldOut ? 'danger' : 'positive'}
                              />
                            </div>
                            {blockers.length > 0 ? (
                              <div className="mt-1.5">
                                <BlockerList items={blockers} />
                              </div>
                            ) : null}
                          </div>
                          <HudButton
                            variant="primary"
                            disabled={broke}
                            title={blockers[0]?.text?.toString()}
                            onClick={() => buyDomainContract(offer.id)}
                            className="shrink-0"
                          >
                            {soldOut ? 'Dry' : money(offer.cash)}
                          </HudButton>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </GameCard>

            <GameCard
              eyebrow="Basket"
              title="Portfolio buyer"
              tone="train"
              actions={
                <span className="font-mono text-[0.8125rem] tabular-nums text-amber">
                  {money(portfolioBudgetM * 1_000_000)}
                </span>
              }
            >
              <label className="block text-[0.6875rem] text-muted">
                Budget
                <input
                  type="range"
                  min={0.5}
                  max={50}
                  step={0.5}
                  value={portfolioBudgetM}
                  onChange={(event) => setPortfolioBudgetM(Number(event.target.value))}
                  className="mt-1 w-full"
                />
              </label>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                {(
                  [
                    ['open', 'Open web / public'],
                    ['broker', 'Brokers'],
                    ['enterprise', 'Enterprise / research'],
                    ['rival', 'Rival surplus'],
                  ] as const
                ).map(([channel, label]) => (
                  <label key={channel} className="text-[0.6875rem] text-muted">
                    <span className="flex justify-between">
                      <span>{label}</span>
                      <span className="font-mono tabular-nums text-bone">
                        {portfolioMix[channel]}%
                      </span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={portfolioMix[channel]}
                      onChange={(event) =>
                        setPortfolioMix((current) => ({
                          ...current,
                          [channel]: Number(event.target.value),
                        }))
                      }
                      className="mt-0.5 w-full"
                    />
                  </label>
                ))}
              </div>
              <HudButton
                variant="primary"
                className="mt-3 w-full"
                onClick={() => buyDataPortfolio(portfolioBudgetM * 1_000_000, portfolioMix)}
              >
                Build portfolio from live lots
              </HudButton>
            </GameCard>
          </>
        )}

        {tab === 'synth' && (
          <GameCard
            eyebrow="Synthetic lab"
            title="Automatic generation"
            tone="research"
            live={Boolean(autoSynthJob)}
            actions={
              <StatusChip tone={autoSynthJob ? 'research' : 'neutral'}>
                {autoSynthJob ? 'Live' : 'Idle'} · ~{formatTokens(synthEstimate.grossMTokPerDay)}/d
              </StatusChip>
            }
          >
            <label className="block rounded-md border border-line/70 bg-void/35 p-2.5 text-[0.75rem] text-muted">
              <span className="flex items-center justify-between gap-3">
                <span>Research compute budget</span>
                <strong className="font-mono tabular-nums text-research">
                  {Math.round(genShare * 100)}% · {num(synthEstimate.researchPf, 2)} PF
                </strong>
              </span>
              <input
                type="range"
                min={5}
                max={50}
                step={1}
                value={Math.round(genShare * 100)}
                onChange={(event) => setGenShare(Number(event.target.value) / 100)}
                className="mt-2 w-full"
              />
            </label>

            <div className="mt-2 grid grid-cols-2 gap-x-3 sm:grid-cols-4">
              <StatRow label="Attempts / day" value={formatTokens(synthEstimate.grossMTokPerDay)} />
              <StatRow label="Useful" value={pct(synthEstimate.usefulChance, 0)} />
              <StatRow label="High-Q" value={pct(synthEstimate.hqChance, 0)} />
              <StatRow label="Teacher" value={synthEstimate.model?.name ?? 'None'} />
            </div>

            {!synthUnlocked ? (
              <div className="mt-2">
                <ResearchUnlockLink nodeId="data_synth" label="Open Synthetic Generators research" />
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
              onClick={() => startSynthBudget({ researchShare: genShare })}
            >
              {autoSynthJob ? 'Update compute budget' : 'Start automatic generation'}
            </HudButton>

            {autoSynthJob ? (
              <div className="mt-3 rounded-md border border-research/25 bg-void/50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-[0.8125rem] font-medium text-bone">
                      <LiveDot className="text-research" />
                      Auto portfolio · {autoSynthJob.modelName}
                    </div>
                    <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
                      {Math.round(autoSynthJob.researchShare * 100)}% research · useful → processed
                    </div>
                  </div>
                  <HudButton variant="danger" onClick={() => cancelSynthGen(autoSynthJob.id)}>
                    Stop
                  </HudButton>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-x-3">
                  <StatRow label="High quality" value={formatTokens(autoSynthJob.hqMTok ?? 0)} tone="positive" />
                  <StatRow label="Low quality" value={formatTokens(autoSynthJob.lqMTok ?? 0)} tone="research" />
                  <StatRow label="Rejected" value={formatTokens(autoSynthJob.wastedMTok ?? 0)} tone="danger" />
                </div>
                <div className="mt-2">
                  <MeterBar
                    label="Yield mix"
                    value={(autoSynthJob.hqMTok ?? 0) / Math.max(1, autoSynthJob.progressMTok)}
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
  )
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
  onProcess,
  onPrune,
}: {
  domain: DataDomain
  raw: number
  processed: number
  quality: number
  dayIn: number
  queued: number
  prune: DataPruneEstimate
  auditUnlocked: boolean
  onProcess: () => void
  onPrune: () => void
}) {
  const meta = DATA_DOMAIN_META[domain]
  const total = Math.max(1, raw + processed + queued)
  const readyRatio = processed / total
  const blockers: Blocker[] = []
  if (raw < 0.5) blockers.push({ text: 'Need ≥0.5MTok raw to clean', tone: 'warning' })
  const pruneBlockers: Blocker[] = !prune.ok
    ? [{ text: prune.reason ?? 'Cannot prune', tone: 'warning' }]
    : []

  return (
    <div className="rounded-md border border-line/70 bg-void/35 p-2.5 hover-lift">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[0.8125rem] font-semibold text-bone">{meta.label}</div>
          <div className="mt-0.5 font-mono text-[0.6875rem] tabular-nums text-muted">
            Q{num(quality, 0)} · {pct(readyRatio, 0)} ready
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <HudButton
            variant="ghost"
            disabled={raw < 0.5}
            title={blockers[0]?.text?.toString()}
            onClick={onProcess}
            className="!px-2 !py-1 text-[0.6875rem]"
          >
            Clean
          </HudButton>
          <HudButton
            variant="ghost"
            disabled={!prune.ok}
            title={prune.reason}
            onClick={onPrune}
            className="!px-2 !py-1 text-[0.6875rem]"
          >
            Prune
          </HudButton>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2">
        <StatRow label="Raw" value={formatTokens(raw)} />
        <StatRow label="Ready" value={formatTokens(processed)} tone="positive" />
      </div>

      <div className="mt-1.5">
        <MeterBar
          label={queued > 0.01 ? `Cleaning ${formatTokens(queued)}` : 'Coverage'}
          value={readyRatio}
          detail={pct(readyRatio, 0)}
          tone="positive"
          live={queued > 0.01}
        />
      </div>

      <div className="mt-1.5 border-t border-line/60 pt-1.5 text-[0.6875rem] text-muted">
        {!auditUnlocked ? (
          <span>Audit corpus to reveal low-Q volume</span>
        ) : prune.totalMTok >= 0.5 ? (
          <span className="font-mono tabular-nums">
            Low-Q {formatTokens(prune.totalMTok)} · {money(prune.cashCost)} · {num(prune.pfDays, 0)}{' '}
            PFd · {prune.researchersRequired}R
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
      {dayIn > 0.01 ? (
        <div className="mt-1 font-mono text-[0.6875rem] tabular-nums text-muted">
          +{formatTokens(dayIn)} today
        </div>
      ) : null}
    </div>
  )
}
