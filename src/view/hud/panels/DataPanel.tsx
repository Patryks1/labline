import { useMemo, useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import {
  DATA_DOMAINS,
  DATA_DOMAIN_META,
  DATA_QUALITY_LABELS,
  DATA_SELLER_LABELS,
  ensureDataMarket,
  ensureLabData,
  estimateAllDataPrunes,
  estimateDataPrune,
  estimateSynthMTokPerDay,
  formatTokens,
  grossResearchPoolPf,
  researchPoolForTech,
  totalProcessed,
  totalRaw,
  totalSources,
  synthTeacherFreshness,
  type DataPortfolioChannel,
  type DataPruneEstimate,
} from '../../../sim/systems/data'
import { money } from '../format'
import type { DataDomain, DataQualityBand, DataSellerKind } from '../../../sim/types'
import { num, pct } from '../format'

type CorpusSourceKey = 'web' | 'bought' | 'user' | 'synth'

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

export function DataPanel() {
  const state = useGameStore((s) => s.state)
  const setCollectionRate = useGameStore((s) => s.setCollectionRate)
  const setAutoProcess = useGameStore((s) => s.setAutoProcess)
  const enqueueProcess = useGameStore((s) => s.enqueueProcess)
  const enqueueProcessAll = useGameStore((s) => s.enqueueProcessAll)
  const enqueueDataPrune = useGameStore((s) => s.enqueueDataPrune)
  const enqueueAllDataPrunes = useGameStore((s) => s.enqueueAllDataPrunes)
  const buyDataPortfolio = useGameStore((s) => s.buyDataPortfolio)
  const buyDomainContract = useGameStore((s) => s.buyDomainContract)
  const startSynthGen = useGameStore((s) => s.startSynthGen)
  const cancelSynthGen = useGameStore((s) => s.cancelSynthGen)

  const data = ensureLabData(state)
  const raw = totalRaw(data)
  const proc = totalProcessed(data)
  const sources = totalSources(data)
  const sourceTotal = sources.web + sources.user + sources.bought + sources.synth
  const srcSum = sourceTotal || 1
  const techShare = researchPoolForTech(state)
  const playerDataOrders = state.worldMarkets.orders.filter(
    (order) => order.labId === state.playerLabId && order.kind === 'data',
  )
  const dataReserved = playerDataOrders.reduce((sum, order) => sum + order.cashReserved, 0)
  const latestDataFills = state.worldMarkets.fills.filter(
    (fill) => fill.labId === state.playerLabId && fill.kind === 'data',
  )

  const models = state.player.models.filter(
    (m) => m.release === 'released' || m.shipped || m.release === 'internal',
  )

  const [genDomain, setGenDomain] = useState<DataDomain>('chat')
  const [genModelId, setGenModelId] = useState(models[0]?.id ?? '')
  const [genShare, setGenShare] = useState(0.25)
  const [genTier, setGenTier] = useState<'hq' | 'lq'>('hq')
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

  const genModel = models.find((m) => m.id === genModelId) ?? models[0]
  const teacherFreshness = genModel
    ? synthTeacherFreshness(state, genModel, genDomain)
    : null
  const estPerDay = useMemo(() => {
    if (!genModel) return 0
    return estimateSynthMTokPerDay(state, genModel, genDomain, genShare)
  }, [state, genModel, genDomain, genShare])

  const sourceMix = (['web', 'bought', 'user', 'synth'] as const).map((key) => ({
    key,
    value: sources[key],
    share: sources[key] / srcSum,
    ...CORPUS_SOURCE_META[key],
  }))
  let sourceCursor = 0
  const sourceGradient = `conic-gradient(${sourceMix
    .map((source) => {
      const start = sourceCursor
      sourceCursor += source.share * 100
      return `${source.color} ${start}% ${sourceCursor}%`
    })
    .join(', ')})`
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
    sourceQuality >= 75 ? 'High' : sourceQuality >= 55 ? 'Medium' : sourceQuality > 0 ? 'Low' : 'No stock'
  const readyShare = proc / Math.max(1, raw + proc)
  const collectionRisk =
    data.collectionRate >= 0.8 ? 'High trust risk' : data.collectionRate >= 0.55 ? 'Guarded' : 'Low risk'

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="hud-panel-title">Data command</h2>
          <p className="hud-panel-sub">Turn raw signal into a clean, diverse training advantage.</p>
        </div>
        <span className={`status-chip ${readyShare >= 0.7 ? 'status-chip--positive' : 'status-chip--warning'}`}>
          {pct(readyShare, 0)} ready
        </span>
      </header>

      <section className="overflow-hidden rounded-2xl border border-line bg-panel-2">
        <div className="grid grid-cols-3 divide-x divide-line">
          <ScoreStat label="Train-ready" value={formatTokens(proc)} tone="mint" />
          <ScoreStat label="Raw backlog" value={formatTokens(raw)} tone={raw > proc ? 'amber' : 'bone'} />
          <ScoreStat label="Net today" value={`+${formatTokens(data.dayProcessed + (data.daySynthMTok ?? 0))}`} tone="bone" />
        </div>
        <div className="border-t border-line px-3 py-2">
          <div className="flex items-center justify-between text-[0.6875rem] text-muted">
            <span>Corpus readiness</span>
            <span className="font-mono text-bone">{formatTokens(proc)} / {formatTokens(raw + proc)}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-void">
            <div className="h-full rounded-full bg-mint" style={{ width: `${Math.max(2, readyShare * 100)}%` }} />
          </div>
        </div>
      </section>

      <section id="data-collect" className="scroll-mt-4 rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Source intelligence</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Select a source to inspect its quality and domain coverage.</p>
          </div>
          <span className="font-mono text-[0.6875rem] text-muted">{formatTokens(sourceTotal)} processed</span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div className="flex items-center justify-center">
            <div
              role="img"
              aria-label="Processed corpus source mix"
              className="relative grid size-28 place-items-center rounded-full"
              style={{ background: sources.web + sources.bought + sources.user + sources.synth > 0 ? sourceGradient : '#17232c' }}
            >
              <div className="grid size-[4.6rem] place-items-center rounded-full border border-line bg-panel-2 text-center">
                <div>
                  <div className="font-mono text-sm font-semibold text-bone">{pct(selectedSourceInfo.share, 0)}</div>
                  <div className="text-[0.625rem] uppercase tracking-wider text-muted">{selectedSourceInfo.label}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {sourceMix.map((source) => (
              <button
                key={source.key}
                type="button"
                onClick={() => setSelectedSource(source.key)}
                aria-pressed={selectedSource === source.key}
                className={`rounded-xl border px-2.5 py-2 text-left transition-colors ${
                  selectedSource === source.key
                    ? 'border-mint/50 bg-mint/10'
                    : 'border-line/70 bg-void/35 hover:border-line hover:bg-void/55'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[0.6875rem] uppercase tracking-wider text-muted">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: source.color }} />
                  {source.label}
                </span>
                <span className="mt-1 block font-mono text-[0.75rem] text-bone">{formatTokens(source.value)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-line/70 bg-void/40 p-2.5">
          <div className="grid grid-cols-3 gap-2">
            <SourceStat label="Share" value={pct(selectedSourceInfo.share, 0)} />
            <SourceStat label="Quality" value={sourceQuality > 0 ? `Q${Math.round(sourceQuality)} · ${sourceQualityBand}` : 'No stock'} />
            <SourceStat
              label="Signal"
              value={
                selectedSource === 'synth' && selectedSourceInfo.value > 0
                  ? `${pct((sources.synthHQ ?? 0) / selectedSourceInfo.value, 0)} HQ`
                  : selectedSourceInfo.signal
              }
            />
          </div>
          <div className="mt-2 border-t border-line/70 pt-2">
            <div className="flex items-center justify-between gap-2 text-[0.6875rem]">
              <span className="text-muted">Top domains</span>
              <span className="text-amber">Watch: {selectedSourceInfo.risk}</span>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {sourceDomainRows.slice(0, 3).map((row) => (
                <div key={row.domain} className="grid grid-cols-[5rem_minmax(0,1fr)_4.5rem] items-center gap-2 text-[0.6875rem]">
                  <span className="truncate text-bone">{DATA_DOMAIN_META[row.domain].label}</span>
                  <div className="h-1 overflow-hidden rounded-full bg-panel-2">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, (row.volume / Math.max(1, sourceDomainRows[0]?.volume ?? 1)) * 100)}%`,
                        backgroundColor: selectedSourceInfo.color,
                      }}
                    />
                  </div>
                  <span className="text-right font-mono text-muted">{formatTokens(row.volume)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Data flywheel</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Collect product signal, then clean it for training.</p>
          </div>
          <span className={`font-mono text-[0.6875rem] ${data.collectionRate >= 0.8 ? 'text-danger' : data.collectionRate >= 0.55 ? 'text-amber' : 'text-mint'}`}>
            {collectionRisk}
          </span>
        </div>
        <label className="mt-3 block text-[0.6875rem] text-muted">
          <span className="flex items-center justify-between">
            <span>Traffic collection</span>
            <strong className="font-mono text-bone">{Math.round(data.collectionRate * 100)}%</strong>
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
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <SourceStat label="Collected today" value={formatTokens(data.dayCollected)} />
          <SourceStat label="Processed today" value={formatTokens(data.dayProcessed)} />
          <SourceStat label="Queue" value={`${data.processQueue.length} / 6 jobs`} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-line/70 bg-void/35 px-2.5 py-2">
          <label className="flex items-center gap-2 text-[0.75rem] text-bone">
            <input type="checkbox" checked={data.autoProcess} onChange={(e) => setAutoProcess(e.target.checked)} />
            Auto-clean new data
          </label>
          <button type="button" className="rounded-full border border-mint/35 px-2.5 py-1 text-[0.6875rem] font-medium text-mint hover:bg-mint/10" onClick={() => enqueueProcessAll()}>
            Process backlog
          </button>
        </div>
      </section>

      <details className="group rounded-2xl border border-line bg-panel-2">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Dataset vault</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Reusable assets and frozen training manifests.</p>
          </div>
          <span className="flex items-center gap-2 font-mono text-[0.6875rem] text-muted">
            {data.assets.length} assets · {data.manifests.length} manifests
            <span className="text-mint transition-transform group-open:rotate-45">+</span>
          </span>
        </summary>
        <div className="space-y-1.5 border-t border-line px-3 py-2.5">
          {data.assets
            .slice(-6)
            .reverse()
            .map((asset) => {
              const topDomain = Object.entries(asset.domainWeights).sort(
                ([, left], [, right]) => (right ?? 0) - (left ?? 0),
              )[0]?.[0]
              return (
                <div key={asset.id} className="rounded-lg border border-line/70 bg-void/40 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[0.75rem] font-medium text-bone">
                      {asset.name}
                    </span>
                    <span className="shrink-0 font-mono text-[0.6875rem] text-mint">
                      {formatTokens(asset.volumeMTok)} · Q{Math.round(asset.quality)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[0.625rem] uppercase tracking-wide text-muted">
                    <span>{topDomain ?? 'mixed'}</span>
                    <span>{asset.source}</span>
                    <span>{asset.rights}</span>
                    <span>div {Math.round(asset.diversity * 100)}</span>
                    <span>risk {Math.round(asset.contaminationRisk * 100)}</span>
                    {asset.synthetic?.method && <span className="text-research">{asset.synthetic.method}</span>}
                  </div>
                </div>
              )
            })}
          {data.assets.length === 0 && (
            <p className="rounded-lg border border-dashed border-line p-3 text-center text-[0.75rem] text-muted">
              Acquire, process, or synthesize data to build the library.
            </p>
          )}
          {data.manifests.at(-1) && (
            <div className="mt-2 border-t border-line pt-2 font-mono text-[0.6875rem] text-muted">
              Latest manifest: {data.manifests.at(-1)!.assetIds.length} assets ·{' '}
              {formatTokens(data.manifests.at(-1)!.uniqueMTok)} unique ·{' '}
              {formatTokens(data.manifests.at(-1)!.repeatedMTok)} repeated · Q
              {Math.round(data.manifests.at(-1)!.effectiveQuality)}
            </div>
          )}
        </div>
      </details>

      <details id="data-synth" className="group scroll-mt-4 rounded-2xl border border-research/35 bg-research/5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-research">Synthetic lab</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Scale data with research compute and a live teacher.</p>
          </div>
          <span className="flex items-center gap-2 font-mono text-[0.6875rem] text-research">
            {data.synthQueue.length} active · ~{formatTokens(estPerDay)}/d
            <span className="transition-transform group-open:rotate-45">+</span>
          </span>
        </summary>
        <div className="space-y-2 border-t border-research/20 px-3 py-2.5">
        <p className="text-[0.75rem] leading-snug text-muted">
          Choose a teacher and research share. Quality falls when a stronger frontier appears.
        </p>
        {models.length === 0 ? (
          <p className="text-[0.75rem] text-amber">Train a model first (internal or public).</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[0.75rem] text-muted">
                Domain
                <select
                  className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1 text-[0.8125rem] text-bone"
                  value={genDomain}
                  onChange={(e) => setGenDomain(e.target.value as DataDomain)}
                >
                  {DATA_DOMAINS.map((d) => (
                    <option key={d} value={d}>
                      {DATA_DOMAIN_META[d].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[0.75rem] text-muted">
                Model
                <select
                  className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1 text-[0.8125rem] text-bone"
                  value={genModelId || models[0]!.id}
                  onChange={(e) => setGenModelId(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · cap {m.capability.toFixed(0)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block text-[0.75rem] text-muted">
              Research share: {Math.round(genShare * 100)}% of pool
              <input
                type="range"
                min={5}
                max={50}
                step={1}
                value={Math.round(genShare * 100)}
                onChange={(e) => setGenShare(Number(e.target.value) / 100)}
                className="mt-1 w-full"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className={`flex-1 rounded-lg border px-2 py-1 text-[0.75rem] ${
                  genTier === 'hq'
                    ? 'border-mint/50 bg-mint/15 text-mint'
                    : 'border-line text-muted'
                }`}
                onClick={() => setGenTier('hq')}
              >
                HQ (slower, clean)
              </button>
              <button
                type="button"
                className={`flex-1 rounded-lg border px-2 py-1 text-[0.75rem] ${
                  genTier === 'lq'
                    ? 'border-danger/50 bg-danger/15 text-danger'
                    : 'border-line text-muted'
                }`}
                onClick={() => setGenTier('lq')}
              >
                LQ (fast, risky)
              </button>
            </div>
            <p className="font-mono text-[0.75rem] text-muted">
              {synthUnlocked
                ? `Diverts ${num(grossResearchPoolPf(state) * genShare, 2)} PF continuously · tech keeps ${pct(Math.max(0, techShare - genShare), 0)} · teacher freshness ${pct(teacherFreshness?.freshness ?? 0, 0)}`
                : 'Locked — queue Mixture Engineering → Data Cleaning → Eval Harness → Synthetic Generators in Research.'}
            </p>
            {teacherFreshness && teacherFreshness.capabilityGap > 0.5 && (
              <p className="rounded-lg border border-amber/30 bg-amber/10 px-2 py-1 text-[0.6875rem] text-amber">
                Teacher trails {teacherFreshness.frontierName} by {teacherFreshness.capabilityGap.toFixed(1)} domain capability. Generated quality will decay until you switch models.
              </p>
            )}
            <button
              type="button"
              disabled={!synthUnlocked}
              className="w-full rounded-full bg-research/25 py-1.5 text-[0.8125rem] font-medium text-research hover:bg-research/35 disabled:opacity-40"
              onClick={() =>
                startSynthGen({
                  domain: genDomain,
                  modelId: genModelId || models[0]!.id,
                  researchShare: genShare,
                  qualityTier: genTier,
                })
              }
            >
              Start continuous {genTier.toUpperCase()} generation · ~{formatTokens(estPerDay)}/d
            </button>
          </>
        )}

        {(data.synthQueue?.length ?? 0) > 0 && (
          <div className="mt-2 space-y-1 border-t border-research/20 pt-2">
            {data.synthQueue.map((j) => {
              const jobModel = models.find((model) => model.id === j.modelId)
              const freshness = jobModel ? synthTeacherFreshness(state, jobModel, j.domain) : null
              return (
                <div key={j.id} className="rounded-lg border border-line bg-void/50 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2 text-[0.75rem]">
                    <span className="text-bone">
                      {DATA_DOMAIN_META[j.domain].label} · {j.modelName}
                    </span>
                    <button
                      type="button"
                      className="text-muted hover:text-danger"
                      onClick={() => cancelSynthGen(j.id)}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="mt-0.5 font-mono text-[0.6875rem] text-muted">
                    {formatTokens(j.progressMTok)} generated · {Math.round(j.researchShare * 100)}% research · {freshness ? `${Math.round(freshness.freshness * 100)}% teacher freshness` : 'teacher unavailable'}
                  </div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-void"><div className="h-full bg-research" style={{ width: `${Math.max(8, (freshness?.freshness ?? 0) * 100)}%` }} /></div>
                </div>
              )
            })}
          </div>
        )}
        </div>
      </details>

      <section id="data-evaluate" className="scroll-mt-4 rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Domain inventory</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Balance coverage before your next training run.</p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              className="rounded-full border border-line px-2.5 py-1 text-[0.6875rem] font-medium text-mint hover:border-mint/35 hover:bg-mint/10"
              onClick={() => enqueueProcessAll()}
            >
              Clean all
            </button>
            <button
              type="button"
              disabled={!pruneAllEstimate.ok}
              title={pruneAllEstimate.reason}
              className="rounded-full border border-amber/40 px-2.5 py-1 text-[0.6875rem] font-medium text-amber hover:bg-amber/10 disabled:cursor-not-allowed disabled:opacity-35"
              onClick={() => enqueueAllDataPrunes()}
            >
              Prune low-Q all
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber/20 bg-amber/5 px-2.5 py-2 text-[0.6875rem]">
          <span className="text-muted">
            Audit preview · discard <strong className="font-mono text-amber">{formatTokens(pruneAllEstimate.totalMTok)}</strong>
          </span>
          <span className="font-mono text-muted">
            {money(pruneAllEstimate.cashCost)} · {num(pruneAllEstimate.pfDays, 0)} PFd · {pruneAllEstimate.researchersRequired} researchers
          </span>
          {!pruneAllEstimate.ok && <span className="w-full text-amber">Blocked: {pruneAllEstimate.reason}</span>}
        </div>
        <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
          {DATA_DOMAINS.map((d) => {
            const s = data.stocks[d]
            const sum = (s.fromWeb ?? 0) + (s.fromBought ?? 0) + (s.fromUser ?? 0) + (s.fromSynth ?? 0) || 1
            return (
              <DomainRow
                key={d}
                domain={d}
                raw={s.raw}
                processed={s.processed}
                quality={s.quality}
                dayIn={data.dayCollectByDomain[d] ?? 0}
                web={(s.fromWeb ?? 0) / sum}
                bought={(s.fromBought ?? 0) / sum}
                user={(s.fromUser ?? 0) / sum}
                synth={(s.fromSynth ?? 0) / sum}
                prune={pruneEstimates.get(d)!}
                onProcess={() => enqueueProcess(d, Math.min(s.raw, 50), 70)}
                onPrune={() => enqueueDataPrune(d)}
              />
            )
          })}
        </div>
      </section>

      <div id="data-process" className="scroll-mt-4">
      {data.processQueue.length > 0 && (
        <div className="rounded-2xl border border-line bg-panel-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[0.8125rem] font-semibold text-bone">Cleaning queue</h3>
            <span className="font-mono text-[0.6875rem] text-muted">{data.processQueue.length} active</span>
          </div>
          <div className="mt-2 space-y-1.5 font-mono text-[0.75rem]">
            {data.processQueue.map((j) => {
              const done = 1 - j.remaining / Math.max(0.01, j.total)
              return (
                <div key={j.id}>
                  <div className="flex justify-between text-muted">
                    <span className="text-bone">{DATA_DOMAIN_META[j.domain].label}</span>
                    <span>
                      {formatTokens(j.remaining)} left · Q{j.qualityTarget.toFixed(0)}
                    </span>
                  </div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-void">
                    <div className="h-full bg-mint/80" style={{ width: `${done * 100}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      </div>

      {data.pruneQueue.length > 0 && (
        <div className="rounded-2xl border border-amber/30 bg-amber/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-[0.8125rem] font-semibold text-bone">Low-quality pruning</h3>
              <p className="mt-0.5 text-[0.6875rem] text-muted">Audits reserve research PF and charge only for tokens discarded.</p>
            </div>
            <span className="font-mono text-[0.6875rem] text-amber">{data.pruneQueue.length} active</span>
          </div>
          <div className="mt-2 space-y-2">
            {data.pruneQueue.map((job) => {
              const total = job.rawTotal + job.processedTotal
              const remaining = job.rawRemaining + job.processedRemaining
              const done = 1 - remaining / Math.max(0.01, total)
              return (
                <div key={job.id} className="rounded-lg border border-line/70 bg-void/45 px-2.5 py-2">
                  <div className="flex justify-between gap-2 text-[0.75rem]">
                    <span className="font-medium text-bone">{DATA_DOMAIN_META[job.domain].label}</span>
                    <span className="font-mono text-muted">{formatTokens(remaining)} left</span>
                  </div>
                  <div className="mt-1 flex h-1 overflow-hidden rounded-full bg-void">
                    <div className="h-full bg-amber" style={{ width: `${Math.max(2, done * 100)}%` }} />
                  </div>
                  <div className="mt-1 flex flex-wrap justify-between gap-1 font-mono text-[0.625rem] text-muted">
                    <span>{money(total * job.cashPerMTok)} total</span>
                    <span>{num(total * job.pfDaysPerMTok, 0)} PFd · {job.researchersRequired}R · {pct(job.researchShare, 0)} research</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <details className="group rounded-2xl border border-line bg-panel-2">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">Acquire data</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Buy live lots or build a diversified portfolio.</p>
          </div>
          <span className="flex items-center gap-2 font-mono text-[0.6875rem] text-muted">
            {market.offers.filter((offer) => offer.mTokLeft > 0).length} live · refresh D{market.nextRefreshDay}
            <span className="text-mint transition-transform group-open:rotate-45">+</span>
          </span>
        </summary>
        <div className="border-t border-line px-3 py-2.5">

        <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[0.6875rem]">
          <div className="rounded-lg border border-line/70 bg-void/45 px-2 py-1.5 text-muted">
            Open bids <span className="block text-bone">{playerDataOrders.length}</span>
          </div>
          <div className="rounded-lg border border-line/70 bg-void/45 px-2 py-1.5 text-muted">
            Cash reserved <span className="block text-bone">{money(dataReserved)}</span>
          </div>
          <div className="rounded-lg border border-line/70 bg-void/45 px-2 py-1.5 text-muted">
            Last fill <span className="block text-bone">{latestDataFills[0] ? `${formatTokens(latestDataFills[0].quantity)} @ ${money(latestDataFills[0].unitPrice)}` : '—'}</span>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {(
            [
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
          ).map(([id, label]) => (
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

        <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-0.5">
          {market.offers
            .filter((c) => {
              if (marketFilter === 'all') return true
              if (
                marketFilter === 'scrap' ||
                marketFilter === 'standard' ||
                marketFilter === 'premium' ||
                marketFilter === 'curated'
              ) {
                return c.qualityBand === marketFilter
              }
              if (
                marketFilter === 'web_scrape' ||
                marketFilter === 'rival' ||
                marketFilter === 'enterprise' ||
                marketFilter === 'broker' ||
                marketFilter === 'research_lab' ||
                marketFilter === 'opensource'
              ) {
                return c.sellerKind === marketFilter
              }
              return c.domain === marketFilter
            })
            .map((c) => {
              const soldOut = c.mTokLeft <= 0
              const lot = Math.min(c.lotMTok, Math.max(0, c.mTokLeft) || c.lotMTok)
              const stockPct =
                c.mTokTotal > 0 ? Math.min(100, (c.mTokLeft / c.mTokTotal) * 100) : 0
              const qColor =
                c.qualityBand === 'scrap'
                  ? 'text-muted'
                  : c.qualityBand === 'curated'
                    ? 'text-mint'
                    : c.qualityBand === 'premium'
                      ? 'text-amber'
                      : 'text-bone'
              const broke = state.player.cash < c.cash || soldOut
              const pending = playerDataOrders.find((order) => order.resourceId === c.id)
              const fill = latestDataFills.find((entry) => entry.resourceId === c.id)
              return (
                <div
                  key={c.id}
                  className={`rounded-xl border px-2.5 py-2 ${
                    soldOut
                      ? 'border-line/50 bg-void/20 opacity-70'
                      : 'border-line bg-void/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[0.8125rem] font-medium text-bone">{c.name}</span>
                        <span
                          className={`rounded-full bg-line/40 px-1.5 py-px font-mono text-[0.6875rem] uppercase ${qColor}`}
                        >
                          {DATA_QUALITY_LABELS[c.qualityBand]}
                        </span>
                        <span className="rounded-full bg-line/30 px-1.5 py-px font-mono text-[0.6875rem] text-muted">
                          {DATA_DOMAIN_META[c.domain].label}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[0.75rem] text-muted">
                        {c.sellerName}
                        <span className="text-muted/70">
                          {' '}
                          · {DATA_SELLER_LABELS[c.sellerKind]}
                        </span>
                        {' · '}
                        {c.blurb}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] text-muted">
                        <span className={qColor}>Q{c.quality}</span>
                        <span>
                          Lot {formatTokens(lot)}
                          {c.mTokLeft > 0 && c.mTokLeft < c.mTokTotal
                            ? ` · ${formatTokens(c.mTokLeft)} left`
                            : c.mTokLeft <= 0
                              ? ' · sold out'
                              : ` · ${formatTokens(c.mTokTotal)} listed`}
                        </span>
                        <span>{c.daysLeft}d left</span>
                        <span>
                          ~
                          {money(
                            Math.round(c.cash / Math.max(1, Math.min(c.lotMTok, c.mTokLeft || c.lotMTok))),
                          )}
                          /MTok
                        </span>
                        {fill && <span className="text-mint">last clear {money(fill.unitPrice)}/MTok</span>}
                        {pending && (
                          <span className="text-amber">
                            bid queued · {money(pending.cashReserved)} reserved · clears D{state.day + 1}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-void">
                        <div
                          className={`h-full ${soldOut ? 'bg-line' : 'bg-mint/70'}`}
                          style={{ width: `${stockPct}%` }}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={broke}
                      onClick={() => buyDomainContract(c.id)}
                      className="shrink-0 rounded-full bg-mint/15 px-2.5 py-1.5 text-[0.75rem] font-medium text-mint disabled:opacity-40"
                    >
                      {soldOut ? 'Dry' : money(c.cash)}
                    </button>
                  </div>
                </div>
              )
            })}
        </div>
        <div className="mt-2 rounded-xl border border-line bg-void/45 p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h4 className="text-[0.75rem] font-semibold uppercase tracking-wider text-bone">Portfolio buyer</h4>
              <p className="mt-0.5 text-[0.6875rem] text-muted">Set a cash ceiling and source appetite. Orders choose the best live lots and clear through the same market as individual bids.</p>
            </div>
            <span className="shrink-0 font-mono text-[0.75rem] text-amber">{money(portfolioBudgetM * 1_000_000)}</span>
          </div>
          <label className="mt-2 block text-[0.6875rem] text-muted">
            Budget
            <input type="range" min={0.5} max={50} step={0.5} value={portfolioBudgetM} onChange={(event) => setPortfolioBudgetM(Number(event.target.value))} className="mt-1 w-full" />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
            {([
              ['open', 'Open web / public'],
              ['broker', 'Brokers'],
              ['enterprise', 'Enterprise / research'],
              ['rival', 'Rival surplus'],
            ] as const).map(([channel, label]) => (
              <label key={channel} className="text-[0.6875rem] text-muted">
                <span className="flex justify-between"><span>{label}</span><span className="font-mono text-bone">{portfolioMix[channel]}%</span></span>
                <input type="range" min={0} max={100} step={5} value={portfolioMix[channel]} onChange={(event) => setPortfolioMix((current) => ({ ...current, [channel]: Number(event.target.value) }))} className="mt-0.5 w-full" />
              </label>
            ))}
          </div>
          <button type="button" className="btn-ghost mt-2 w-full py-1.5 text-xs" onClick={() => buyDataPortfolio(portfolioBudgetM * 1_000_000, portfolioMix)}>
            Build portfolio from live lots
          </button>
        </div>
        </div>
      </details>
    </div>
  )
}

function DomainRow({
  domain,
  raw,
  processed,
  quality,
  dayIn,
  web,
  bought,
  user,
  synth,
  prune,
  onProcess,
  onPrune,
}: {
  domain: DataDomain
  raw: number
  processed: number
  quality: number
  dayIn: number
  web: number
  bought: number
  user: number
  synth: number
  prune: DataPruneEstimate
  onProcess: () => void
  onPrune: () => void
}) {
  const meta = DATA_DOMAIN_META[domain]
  const readyRatio = processed / Math.max(1, raw + processed)
  return (
    <div className="rounded-xl border border-line/70 bg-void/35 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[0.75rem] font-medium text-bone">{meta.label}</div>
          <div className="mt-0.5 font-mono text-[0.625rem] text-muted">Q{num(quality, 0)} · {pct(readyRatio, 0)} ready</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={raw < 0.5}
            onClick={onProcess}
            className="rounded-full border border-line px-2 py-1 text-[0.6875rem] text-mint hover:border-mint/40 disabled:opacity-30"
          >
            Clean
          </button>
          <button
            type="button"
            disabled={!prune.ok}
            title={prune.reason}
            onClick={onPrune}
            className="rounded-full border border-amber/35 px-2 py-1 text-[0.6875rem] text-amber hover:bg-amber/10 disabled:cursor-not-allowed disabled:opacity-30"
          >
            Prune
          </button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[0.6875rem]">
        <span className="text-muted">Raw <strong className="text-bone">{formatTokens(raw)}</strong></span>
        <span className="text-right text-muted">Ready <strong className="text-mint">{formatTokens(processed)}</strong></span>
      </div>
      <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-panel-2">
        <div className="bg-muted/50" style={{ width: `${web * 100}%` }} title="web" />
        <div className="bg-amber/70" style={{ width: `${bought * 100}%` }} title="bought" />
        <div className="bg-mint/70" style={{ width: `${user * 100}%` }} title="user" />
        <div className="bg-research/80" style={{ width: `${synth * 100}%` }} title="synth" />
      </div>
      <div className="mt-1.5 border-t border-line/60 pt-1.5 font-mono text-[0.625rem] text-muted">
        {prune.totalMTok >= 0.5 ? (
          <>
            Low-Q {formatTokens(prune.totalMTok)} · {money(prune.cashCost)} · {num(prune.pfDays, 0)} PFd · {prune.researchersRequired}R
            {!prune.ok && <span className="mt-0.5 block text-amber">{prune.reason}</span>}
          </>
        ) : (
          <span>No low-quality stock detected</span>
        )}
      </div>
      {dayIn > 0.01 && (
        <div className="mt-1 font-mono text-[0.625rem] text-muted">+{formatTokens(dayIn)} today</div>
      )}
    </div>
  )
}

function ScoreStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'mint' | 'amber' | 'bone'
}) {
  const toneClass = tone === 'mint' ? 'text-mint' : tone === 'amber' ? 'text-amber' : 'text-bone'
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-sm font-semibold ${toneClass}`}>{value}</div>
    </div>
  )
}

function SourceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.625rem] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 truncate text-[0.6875rem] font-medium text-bone" title={value}>{value}</div>
    </div>
  )
}
