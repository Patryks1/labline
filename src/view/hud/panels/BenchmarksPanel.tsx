import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  BenchmarkMetricId,
  BenchmarkSuiteId,
  EffortBoard,
  Model,
  ModelReview,
  SimState,
} from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'
import {
  INSTANT_EFFORT_ID,
  effortBoardsFor,
  migrateEffortRecipes,
  effortViewForRecipe,
} from '../../../sim/balance/modelProduct'
import { blendApiPrice } from '../../../sim/balance/pricing'
import { apiUnitCostPerMTok } from '../../../sim/balance/unitEconomics'
import { computeSnapshot } from '../../../sim/tick'
import {
  EVALUATION_MARKETS,
  evaluationMarketsForModel,
  suiteForEvaluationMarket,
  type EvaluationMarket,
  type BenchmarkMetricDef,
} from '../../../sim/balance/evaluationSuites'
import { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { modelOfferApiInOut } from '../../../sim/systems/market'
import { playerTrainingJobs } from '../../../sim/systems/training'
import { isInternalFleetModel } from '../../../sim/modelRelease'
import { useGameStore } from '../../../store/gameStore'
import { money, num } from '../format'
import {
  buildAudienceReviewGroups,
  type ApiReviewGroup,
  type PlanAudienceReview,
} from './planReviews'
import {
  expandLeaderboardEffortRows,
  effectiveEffortBoardUsdPerBaseMTok,
  leaderboardEffortRowKey,
  leaderboardMetricCostTitle,
  nextLeaderboardSortDirection,
  officialLeaderboardRankByKey,
  rankLeaderboardEffortRows,
  type LeaderboardEffortRow,
  type LeaderboardSortDirection,
  type LeaderboardSortId,
} from '../data/benchmarkLeaderboard'
import {
  benchmarkEffortRecipes,
  benchmarkTaskWorkload,
  estimateBenchmarkTaskCost,
  type BenchmarkTaskCostEstimate,
} from '../../../sim/balance/benchmarkCost'
import {
  benchmarkMetricsForSuite,
  publicBenchmarkScore,
} from '../data/benchmarkViewModel'
import {
  BENCHMARK_COMPACT_MEDIA,
  BenchmarkCompareTab,
} from './BenchmarkCompareTab'
import { GameCard, MeterBar, SegmentedTabs, StatRow } from '../ui/kit'
import { HudFilterBar } from '../ui/HudFilterBar'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'

const PAGE = 15

type BenchTab = 'leaderboard' | 'internal' | 'compare' | 'reviews'

type InternalBenchmarkRow = {
  id: string
  name: string
  status: 'training' | 'internal'
  day: number
  capability: number | null
  safety: number | null
  suite: number | null
  pending: boolean
  model: Model | null
  effortBoards?: EffortBoard[]
}

type InternalBenchmarkSortKey =
  | 'model'
  | 'status'
  | 'cap'
  | 'day'
  | BenchmarkMetricId
  | `effort:${string}:cap`
  | `effort:${string}:usd`

/**
 * Cross-lab eval leaderboard — top 15 by default, load older/weaker models on demand.
 */
export function BenchmarksPanel() {
  const state = useGameStore((s) => s.state)
  const [showAll, setShowAll] = useState(false)
  const [sortId, setSortId] = useState<LeaderboardSortId>('cap')
  const [sortDirection, setSortDirection] =
    useState<LeaderboardSortDirection>('desc')
  const [market, setMarket] = useState<EvaluationMarket>('language')
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null)
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null)
  const [reviewRecipeId, setReviewRecipeId] = useState(INSTANT_EFFORT_ID)
  const [tab, setTab] = useState<BenchTab>('leaderboard')

  const suiteId = suiteForEvaluationMarket(market)
  const metrics = benchmarkMetricsForSuite(suiteId)

  const boardModels = useMemo(() => {
    const all = collectLeaderboardModels(state)
    return all.filter((row) =>
      evaluationMarketsForModel(row.model).includes(market),
    )
  }, [state, market])

  const rows = useMemo(
    () =>
      rankLeaderboardEffortRows(
        expandLeaderboardEffortRows(boardModels, {
          suiteId,
          unitUsdPerMTokFor: (row) =>
            modelListUsdBase(state, row.model, row.labId),
        }).filter((row) => row.recipeId === INSTANT_EFFORT_ID),
        sortId,
        sortDirection,
      ),
    [boardModels, sortId, sortDirection, suiteId, state],
  )

  const changeSort = (nextId: LeaderboardSortId) => {
    setSortDirection((current) =>
      nextLeaderboardSortDirection(sortId, current, nextId),
    )
    setSortId(nextId)
    setShowAll(false)
  }

  const internalRows = useMemo(() => {
    const jobs = playerTrainingJobs(state).filter((job) => !job.failed)
    const training = jobs.map((job) => {
      const snapshot = job.benchmarkSnapshots?.at(-1)
      return {
        id: job.id,
        name: job.name,
        status: 'training' as const,
        day: snapshot?.day ?? state.day,
        capability: snapshot?.capability ?? null,
        safety: snapshot?.safety ?? null,
        suite: snapshot?.suite ?? snapshot?.capability ?? null,
        pending: Boolean(job.pendingBenchmark),
        model: null as (typeof state.player.models)[number] | null,
        effortBoards: snapshot?.effortBoards,
      }
    })
    const internal = state.player.models
      .filter(isInternalFleetModel)
      .map((model) => ({
        id: model.id,
        name: model.name,
        status: 'internal' as const,
        day: model.releaseDay,
        capability: model.capability,
        safety: model.quality.safety,
        suite: publicBenchmarkScore(model, suiteForEvaluationMarket(market), 'mmlu')
          ?? model.capability,
        pending: false,
        model,
        effortBoards: undefined as EffortBoard[] | undefined,
      }))
    return [...training, ...internal]
  }, [state, market])

  const visible = showAll ? rows : rows.slice(0, PAGE)
  const effortColumns = useMemo(
    () =>
      namedEffortColumns([
        ...visible.map((row) => row.model),
        ...internalRows
          .map((row) => row.model)
          .filter((model): model is Model => model != null),
      ]),
    [internalRows, visible],
  )
  const hidden = Math.max(0, rows.length - PAGE)
  const pricingByLab = useMemo(
    () =>
      new Map([
        ['player', state.player.pricing] as const,
        ...state.rivals.map((rival) => [rival.id, rival.pricing] as const),
      ]),
    [state.player.pricing, state.rivals],
  )
  const servingEfficiencyByLab = useMemo(
    () =>
      new Map([
        ['player', state.player.servingEfficiency] as const,
        ...state.rivals.map(
          (rival) => [rival.id, rival.servingEfficiency] as const,
        ),
      ]),
    [state.player.servingEfficiency, state.rivals],
  )
  const selectedRow =
    rows.find((row) => leaderboardEffortRowKey(row) === selectedModelKey) ??
    rows[0]
  const selectedRowKey = selectedRow
    ? leaderboardEffortRowKey(selectedRow)
    : null
  const officialRanks = useMemo(
    () => officialLeaderboardRankByKey(rows),
    [rows],
  )
  const selectedRank = selectedRow
    ? (officialRanks.get(selectedRowKey!) ?? 0)
    : 0
  const selectedPrices = selectedRow
    ? modelOfferApiInOut(
        pricingByLab.get(selectedRow.labId) ?? state.player.pricing,
        selectedRow.model,
      )
    : null
  const selectedServingEfficiency = selectedRow
    ? (servingEfficiencyByLab.get(selectedRow.labId) ?? 1)
    : 1
  const selectedRecipes = selectedRow
    ? benchmarkEffortRecipes(selectedRow.model)
    : []
  const selectedRecipeId = selectedRecipes.some(
    (recipe) => recipe.id === reviewRecipeId,
  )
    ? reviewRecipeId
    : INSTANT_EFFORT_ID
  const selectedPublishedReviews = selectedRow
    ? state.reviews.filter((review) => {
        const labId = selectedRow.isPlayer ? state.playerLabId : selectedRow.labId
        return (
          review.modelId === selectedRow.model.id &&
          (review.labId ?? state.playerLabId) === labId
        )
      })
    : []
  const reviewGroups = useMemo(() => buildAudienceReviewGroups(state), [state])
  const selectedReviewGroup =
    reviewGroups.find((group) => group.reviewId === selectedReviewId) ??
    reviewGroups[0]
  const selectedAudienceGroup = selectedRow?.isPlayer
    ? reviewGroups.find(
        (group): group is ApiReviewGroup =>
          group.reviewKind === 'api' && group.modelId === selectedRow.model.id,
      )
    : undefined

  const leaders = useMemo(() => {
    const map: Record<string, number> = {}
    for (const d of metrics) {
      let best = -1
      for (const r of rows) {
        const s = r.scores[d.id] ?? 0
        if (s > best) best = s
      }
      map[d.id] = best
    }
    return map
  }, [rows, metrics])

  const playerBest = useMemo(() => {
    let best = 0
    for (const r of rows) {
      if (r.isPlayer && r.capability > best) best = r.capability
    }
    return best
  }, [rows])

  const rivalBest = useMemo(() => {
    let best = 0
    for (const r of rows) {
      if (!r.isPlayer && r.capability > best) best = r.capability
    }
    return best
  }, [rows])

  const frontierGap = playerBest - rivalBest

  const bestSuite = useMemo(() => {
    let best = 0
    for (const r of rows) {
      if (!r.isPlayer) continue
      const scores = metrics.map((d) => r.scores[d.id] ?? 0)
      const avg =
        scores.length === 0
          ? 0
          : scores.reduce((sum, value) => sum + value, 0) / scores.length
      if (avg > best) best = avg
    }
    return best
  }, [rows, metrics])

  const activeAudits = useMemo(() => {
    const day = state.day
    return (state.evaluations ?? []).filter(
      (evaluation) =>
        (evaluation.kind === 'blind_audit' ||
          evaluation.kind === 'real_world') &&
        !evaluation.published &&
        evaluation.scheduledDay <= day &&
        evaluation.publishDay >= day,
    ).length
  }, [state.day, state.evaluations])

  const pendingEvals = useMemo(() => {
    return (state.evaluations ?? []).filter(
      (evaluation) => !evaluation.published,
    )
  }, [state.evaluations])

  const gapTone =
    frontierGap > 0
      ? ('positive' as const)
      : frontierGap < -5
        ? ('danger' as const)
        : ('warning' as const)
  const gapLabel =
    frontierGap === 0 && playerBest === 0
      ? '—'
      : frontierGap >= 0
        ? `+${num(frontierGap, 0)}`
        : num(frontierGap, 0)

  return (
    <PanelScaffold
      eyebrow="Evals"
      title="Benchmarks"
      description="Official public Instant scores, one row per released model. Trained effort projections stay in the detailed review; training snapshots stay on Internal."
      mobileDescription="Ranks, model economics and reviews."
    >
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2">
        <MetricTile
          label="Frontier gap"
          value={gapLabel}
          detail={
            <span className="hidden sm:inline">
              {rivalBest > 0 ? `rival ${num(rivalBest, 0)}` : 'no rivals yet'}
            </span>
          }
          tone={gapTone}
        />
        <MetricTile
          label="Best suite"
          value={bestSuite > 0 ? num(bestSuite, 0) : '—'}
          detail={<span className="hidden sm:inline">your avg suite</span>}
          tone={
            bestSuite >= 70 ? 'positive' : bestSuite > 0 ? 'warning' : 'neutral'
          }
        />
        <div className="hidden sm:block">
          <MetricTile
            label="Active audits"
            value={String(activeAudits)}
            detail={
              pendingEvals.length > 0 ? `${pendingEvals.length} pending` : 'clear'
            }
            tone={activeAudits > 0 ? 'research' : 'neutral'}
          />
        </div>
        <div className="hidden sm:block">
          <MetricTile
            label="Board size"
            value={String(rows.length)}
            detail={showAll ? 'all shown' : `top ${Math.min(PAGE, rows.length)}`}
          />
        </div>
        <div className="col-span-2 flex min-h-9 items-center justify-between rounded-md border border-line/60 bg-panel-2/55 px-2.5 text-[0.6875rem] sm:hidden">
          <span className="text-muted">Audits</span>
          <span className={activeAudits > 0 ? 'font-mono text-research' : 'font-mono text-bone'}>
            {activeAudits > 0
              ? `${activeAudits} active · ${pendingEvals.length} pending`
              : pendingEvals.length > 0
                ? `${pendingEvals.length} pending`
                : 'Clear'}
          </span>
        </div>
      </div>

      <div className="mt-3">
        <SegmentedTabs
          ariaLabel="Benchmarks views"
          active={tab}
          onChange={(id) => setTab(id as BenchTab)}
          items={[
            {
              id: 'leaderboard',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Leaderboard
                  <span className="hidden font-mono text-[0.625rem] text-muted sm:inline">
                    {rows.length}
                  </span>
                </span>
              ),
            },
            {
              id: 'internal',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Internal
                  <span className="hidden font-mono text-[0.625rem] text-muted sm:inline">
                    {internalRows.length}
                  </span>
                </span>
              ),
            },
            {
              id: 'compare',
              label: 'Compare',
            },
            {
              id: 'reviews',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Reviews
                  <span className="hidden font-mono text-[0.625rem] text-muted sm:inline">
                    {reviewGroups.length}
                  </span>
                </span>
              ),
            },
          ]}
        />
      </div>

      <div key={tab} className="panel-swap mt-3 space-y-3">
        {tab === 'leaderboard' ? (
          <>
            <HudFilterBar
              ariaLabel="Benchmark filters"
              activeCount={(market === 'language' ? 0 : 1) + (sortId === 'cap' ? 0 : 1)}
              onClear={() => {
                setMarket('language')
                setSortId('cap')
                setSortDirection('desc')
                setShowAll(false)
              }}
              groups={[
                {
                  id: 'market',
                  label: 'Market',
                  description: 'Public evaluation suite',
                  options: EVALUATION_MARKETS.map((candidate) => ({
                    id: candidate.id,
                    label: candidate.label,
                    active: market === candidate.id,
                    onSelect: () => {
                      setMarket(candidate.id)
                      setSortId('cap')
                      setSortDirection('desc')
                      setShowAll(false)
                    },
                  })),
                },
                {
                  id: 'metric',
                  label: 'Rank by',
                  description: 'Capability or suite score',
                  options: [
                    {
                      id: 'capability',
                      label: 'Capability',
                      active: sortId === 'cap',
                      onSelect: () => changeSort('cap'),
                    },
                    ...metrics.map((metric) => ({
                      id: metric.id,
                      label: metric.short,
                      active: sortId === metric.id,
                      onSelect: () => changeSort(metric.id),
                      title: metric.label,
                    })),
                  ],
                },
              ]}
            />

            <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
              <StatusChip tone="positive">PUBLIC</StatusChip>
              <span className="hud-mobile-summary">
                Official Instant ranks. Tap a model for speed, cost and trained
                effort projections.
              </span>
              <span className="hud-mobile-detail">
                Official ranks use each release&apos;s persisted Instant scores.
                Select a model to inspect trained 1–100× effort projections,
                task pricing, speed and physical PF without rewriting the
                public board.
              </span>
            </div>

            {pendingEvals.length > 0 && (
              <details
                className="group rounded-lg border border-research/35 bg-research/5"
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[0.75rem] font-medium text-bone marker:hidden focus-visible:outline focus-visible:outline-1 focus-visible:outline-research">
                  <span>Audits &amp; field reviews</span>
                  <span className="inline-flex items-center gap-2">
                    <StatusChip tone="research">{pendingEvals.length} in flight</StatusChip>
                    <span aria-hidden className="text-muted transition group-open:rotate-90">›</span>
                  </span>
                </summary>
                <div className="anim-stagger space-y-2 border-t border-line/50 p-2.5">
                  {pendingEvals.slice(0, 4).map((evaluation) => {
                    const span = Math.max(
                      1,
                      evaluation.publishDay - evaluation.scheduledDay,
                    )
                    const elapsed = Math.max(
                      0,
                      state.day - evaluation.scheduledDay,
                    )
                    const progress = Math.min(1, elapsed / span)
                    return (
                      <div
                        key={evaluation.id}
                        className="rounded-md border border-line/60 bg-void/40 px-2.5 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[0.8125rem] text-bone">
                            {evaluation.kind === 'blind_audit'
                              ? 'Blind audit'
                              : 'Field review'}{' '}
                            · {evaluation.modelId}
                          </span>
                          <StatusChip tone="research">
                            D{evaluation.publishDay}
                          </StatusChip>
                        </div>
                        <div className="mt-1.5">
                          <MeterBar
                            label="Publish window"
                            value={progress}
                            detail={`${Math.round(progress * 100)}%`}
                            tone="research"
                            live={progress < 1}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </details>
            )}

            <div className="hud-mobile-summary">
              <MobileBenchmarkSort
                sortId={sortId}
                direction={sortDirection}
                metrics={metrics}
                onSort={(nextId) => {
                  if (nextId === sortId) return
                  setSortId(nextId)
                  setSortDirection(defaultSortDirection(nextId))
                  setShowAll(false)
                }}
                onDirectionChange={() => {
                  setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')
                  setShowAll(false)
                }}
              />
            </div>

            <div
              data-mobile-benchmark-leaderboard
              data-mobile-official-benchmarks
              className="hud-mobile-summary anim-stagger space-y-2"
            >
              {visible.map((row, index) => {
                const rowKey = leaderboardEffortRowKey(row)
                const rank = officialRanks.get(rowKey) ?? index + 1
                const selected = rowKey === selectedRowKey
                const prices = modelOfferApiInOut(
                  pricingByLab.get(row.labId) ?? state.player.pricing,
                  row.model,
                )
                const servingEfficiency =
                  servingEfficiencyByLab.get(row.labId) ?? 1
                return (
                  <MobileBenchmarkCard
                    key={rowKey}
                    row={row}
                    rank={rank}
                    selected={selected}
                    metrics={metrics}
                    sortId={sortId}
                    prices={prices}
                    servingEfficiency={servingEfficiency}
                    onSelect={() => {
                      setSelectedModelKey(rowKey)
                      setReviewRecipeId(INSTANT_EFFORT_ID)
                    }}
                  />
                )
              })}
            </div>

            <div
              role="region"
              aria-label="Official benchmark leaderboard"
              tabIndex={0}
              data-swipe-ignore="true"
              data-desktop-official-benchmarks
              className="hud-mobile-detail touch-pan-x touch-pan-y overflow-x-auto overscroll-x-contain rounded-lg border border-line/70"
            >
              <table className="w-full min-w-[720px] border-collapse text-left text-[0.8125rem]">
                <thead className="sticky top-0 z-20">
                  <tr className="border-b border-line bg-panel-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    <th className="sticky left-0 z-10 bg-panel-2 px-2 py-2">
                      #
                    </th>
                    <SortableHeader label="Model" sortKey="model" activeKey={sortId} direction={sortDirection} onSort={changeSort} className="sticky left-6 z-10 bg-panel-2 px-2" />
                    <SortableHeader label="Lab" sortKey="lab" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                    <SortableHeader label="Size" sortKey="size" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                    <SortableHeader label="Cap" fullLabel="Capability" sortKey="cap" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                    <SortableHeader label="Think" fullLabel="Official inference recipe" sortKey="think" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                    <SortableHeader label="Tokens" fullLabel="Official generated-token multiplier" sortKey="tokens" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                    <SortableHeader label="List $/MTok" fullLabel="Blended input/output list price" sortKey="price" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                    {metrics.map((d) => (
                      <SortableHeader
                        key={d.id}
                        label={d.short}
                        fullLabel={d.label}
                        sortKey={d.id}
                        activeKey={sortId}
                        direction={sortDirection}
                        onSort={changeSort}
                        className="px-1 text-center"
                      />
                    ))}
                    <SortableHeader label="Day" sortKey="day" activeKey={sortId} direction={sortDirection} onSort={changeSort} />
                  </tr>
                </thead>
                <tbody className="anim-stagger">
                  {visible.map((r, i) => {
                    const rowKey = leaderboardEffortRowKey(r)
                    const rank = officialRanks.get(rowKey) ?? i + 1
                    const selected = rowKey === selectedRowKey
                    const prices = modelOfferApiInOut(
                      pricingByLab.get(r.labId) ?? state.player.pricing,
                      r.model,
                    )
                    const servingEfficiency =
                      servingEfficiencyByLab.get(r.labId) ?? 1
                    return (
                      <tr
                        key={rowKey}
                        aria-selected={selected}
                        className={`border-b border-line/60 ${
                          selected
                            ? 'bg-mint/12 outline outline-1 -outline-offset-1 outline-mint/35'
                            : r.isPlayer
                            ? 'bg-mint/5'
                            : i % 2 === 0
                              ? 'bg-void/30'
                              : ''
                        }`}
                      >
                        <td className="sticky left-0 z-10 bg-inherit px-2 py-1.5 font-mono tabular-nums text-muted">
                          {rank}
                        </td>
                        <td className="sticky left-6 z-10 max-w-[180px] bg-inherit px-2 py-1.5 font-medium text-bone">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedModelKey(rowKey)
                              setReviewRecipeId(INSTANT_EFFORT_ID)
                            }}
                            aria-controls="benchmark-model-review"
                            aria-expanded={selected}
                            className="group/model flex min-w-0 items-center gap-1 rounded-sm text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
                          >
                            <span className="min-w-0 truncate">
                              {r.displayName}
                            </span>
                            {r.isPlayer && (
                              <StatusChip tone="positive">you</StatusChip>
                            )}
                            {r.kind === 'router' && (
                              <StatusChip tone="research">router</StatusChip>
                            )}
                          </button>
                        </td>
                        <td className="px-1.5 py-1.5">
                          <span className="inline-flex items-center gap-1 text-muted">
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{
                                backgroundColor: `#${r.color.toString(16).padStart(6, '0')}`,
                              }}
                            />
                            {r.labName}
                          </span>
                        </td>
                        <td className="px-1.5 py-1.5 font-mono tabular-nums text-muted">
                          {formatParams(r.model.paramsB)}
                        </td>
                        <td
                          className="px-1.5 py-1.5 font-mono tabular-nums text-bone"
                          title={leaderboardMetricCostTitle(r, {
                            id: 'cap',
                            label: 'Capability',
                          })}
                        >
                          {num(r.capability, 0)}
                        </td>
                        <td
                          className="px-1 py-1.5 text-center font-mono text-muted"
                          title={`${r.recipeName} · ${r.tokenMult.toFixed(1)}× tokens`}
                        >
                          {r.recipeName}
                        </td>
                        <td
                          className="px-1 py-1.5 text-center font-mono tabular-nums text-muted"
                          title={`${r.tokenMult.toFixed(1)}× tokens vs Instant. Total $ for a run can rise with longer traces.`}
                        >
                          {r.tokenMult.toFixed(1)}×
                        </td>
                        <td
                          className="px-1 py-1.5 text-center font-mono tabular-nums text-muted"
                          title="List price per million tokens — not a Deep premium."
                        >
                          {r.usdPerMTok != null ? money(r.usdPerMTok) : '—'}
                        </td>
                        {metrics.map((d) => {
                          const s = r.scores[d.id] ?? 0
                          const isLead =
                            s >= (leaders[d.id] ?? 0) - 0.05 && s > 1
                          return (
                            <td
                              key={d.id}
                              className={`px-1 py-1.5 text-center font-mono tabular-nums ${
                                isLead ? 'text-mint' : 'text-muted'
                              }`}
                            >
                              <BenchmarkScoreCost
                                model={r.model}
                                metric={d}
                                score={s}
                                prices={prices}
                                servingEfficiency={servingEfficiency}
                                placeAbove={i >= visible.length - 3}
                              />
                            </td>
                          )
                        })}
                        <td className="px-1.5 py-1.5 font-mono tabular-nums text-muted">
                          {r.model.releaseDay}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {selectedRow && selectedPrices ? (
              <SelectedBenchmarkModelReview
                row={selectedRow}
                rank={selectedRank}
                suiteId={suiteId}
                metrics={metrics}
                recipeId={selectedRecipeId}
                onRecipeChange={setReviewRecipeId}
                prices={selectedPrices}
                servingEfficiency={selectedServingEfficiency}
                publishedReviews={selectedPublishedReviews}
                audienceGroup={selectedAudienceGroup}
                onOpenReviews={
                  selectedAudienceGroup
                    ? () => {
                        setSelectedReviewId(selectedAudienceGroup.reviewId)
                        setTab('reviews')
                      }
                    : undefined
                }
              />
            ) : null}

            {rows.length === 0 && (
              <EmptyState
                title="No models yet"
                description="Train and release, or wait for rivals to appear on the board."
              />
            )}

            {!showAll && hidden > 0 && (
              <HudButton
                variant="secondary"
                className="w-full"
                onClick={() => setShowAll(true)}
              >
                Load {hidden} older / lower-ranked models
              </HudButton>
            )}
            {showAll && rows.length > PAGE && (
              <HudButton
                variant="ghost"
                className="w-full"
                onClick={() => setShowAll(false)}
              >
                Show top {PAGE} only
              </HudButton>
            )}
          </>
        ) : tab === 'internal' ? (
          <InternalBenchmarksTab
            rows={internalRows}
            suiteId={suiteId}
            metrics={metrics}
            state={state}
            columns={effortColumns}
          />
        ) : tab === 'compare' ? (
          <BenchmarkCompareTab
            rows={boardModels}
            suiteId={suiteId}
            metrics={metrics}
            market={market}
            onMarketChange={(candidate) => {
              setMarket(candidate)
              setSortId('cap')
              setSortDirection('desc')
              setShowAll(false)
            }}
          />
        ) : (
          <ReviewsTab
            reviewGroups={reviewGroups}
            selectedReviewGroup={selectedReviewGroup}
            onSelect={setSelectedReviewId}
          />
        )}
      </div>
    </PanelScaffold>
  )
}

function SortableHeader({
  label,
  fullLabel = label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className = 'px-1.5',
}: {
  label: string
  fullLabel?: string
  sortKey: LeaderboardSortId
  activeKey: LeaderboardSortId
  direction: LeaderboardSortDirection
  onSort: (key: LeaderboardSortId) => void
  className?: string
}) {
  const active = sortKey === activeKey
  const next = active
    ? direction === 'asc'
      ? 'descending'
      : 'ascending'
    : sortKey === 'model' || sortKey === 'lab' || sortKey === 'think'
      ? 'ascending'
      : 'descending'
  return (
    <th
      className={`${className} py-0`}
      title={fullLabel}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex min-h-8 w-full items-center justify-center gap-0.5 py-1 text-inherit hover:text-bone focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
        aria-label={`Sort by ${fullLabel}${active ? `, currently ${direction === 'asc' ? 'ascending' : 'descending'}` : ''}. Activate for ${next}.`}
      >
        <span>{label}</span>
        <span aria-hidden className={active ? 'text-mint' : 'text-muted/45'}>
          {active ? (direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}

function defaultSortDirection(sortId: LeaderboardSortId): LeaderboardSortDirection {
  return sortId === 'model' || sortId === 'lab' || sortId === 'think'
    ? 'asc'
    : 'desc'
}

function MobileBenchmarkSort({
  sortId,
  direction,
  metrics,
  onSort,
  onDirectionChange,
}: {
  sortId: LeaderboardSortId
  direction: LeaderboardSortDirection
  metrics: readonly BenchmarkMetricDef[]
  onSort: (id: LeaderboardSortId) => void
  onDirectionChange: () => void
}) {
  return (
    <div
      data-mobile-benchmark-sort
      className="sticky top-0 z-20 -mx-0.5 flex items-end gap-2 rounded-lg border border-line/70 bg-panel/95 p-2 shadow-lg shadow-void/20 backdrop-blur-md"
    >
      <label className="min-w-0 flex-1 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted">
        Order by
        <select
          aria-label="Mobile benchmark sort"
          className="hud-select mt-1 w-full"
          value={sortId}
          onChange={(event) => onSort(event.target.value as LeaderboardSortId)}
        >
          <option value="cap">Capability</option>
          {metrics.map((metric) => (
            <option key={metric.id} value={metric.id}>{metric.label}</option>
          ))}
          <option value="model">Model name</option>
          <option value="lab">Lab</option>
          <option value="size">Parameters</option>
          <option value="price">List price</option>
          <option value="day">Release day</option>
        </select>
      </label>
      <button
        type="button"
        aria-label={`Sort ${direction === 'asc' ? 'ascending' : 'descending'}; change direction`}
        title="Reverse order"
        onClick={onDirectionChange}
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-line/70 bg-panel-2 font-mono text-sm text-mint focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
      >
        <span aria-hidden>{direction === 'asc' ? '↑' : '↓'}</span>
      </button>
    </div>
  )
}

export function MobileBenchmarkCard({
  row,
  rank,
  selected,
  metrics,
  sortId,
  prices,
  servingEfficiency,
  onSelect,
}: {
  row: LeaderboardEffortRow
  rank: number
  selected: boolean
  metrics: readonly BenchmarkMetricDef[]
  sortId: LeaderboardSortId
  prices: { priceIn: number; priceOut: number }
  servingEfficiency: number
  onSelect: () => void
}) {
  const scorePanelId = `mobile-benchmark-scores-${useId().replace(/:/g, '')}`
  const [scoresOpen, setScoresOpen] = useState(false)
  const priorityMetric =
    metrics.find((metric) => metric.id === sortId) ?? metrics[0]
  const priorityScore = priorityMetric
    ? (row.scores[priorityMetric.id] ?? 0)
    : 0
  return (
    <article
      aria-current={selected ? 'true' : undefined}
      className={`overflow-hidden rounded-lg border ${
        selected
          ? 'border-mint/55 bg-mint/10 ring-1 ring-inset ring-mint/20'
          : row.isPlayer
            ? 'border-mint/25 bg-mint/5'
            : 'border-line/70 bg-panel-2/65'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-controls="benchmark-model-review"
        aria-expanded={selected}
        className="flex min-h-14 w-full items-center gap-2.5 px-2.5 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mint"
      >
        <span className="w-6 shrink-0 text-center font-mono text-[0.75rem] tabular-nums text-muted">
          {rank}
        </span>
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{
            backgroundColor: `#${row.color.toString(16).padStart(6, '0')}`,
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[0.8125rem] font-semibold text-bone">
              {row.displayName}
            </span>
            {row.isPlayer ? <StatusChip tone="positive">you</StatusChip> : null}
            {row.kind === 'router' ? <StatusChip tone="research">router</StatusChip> : null}
          </span>
          <span className="mt-0.5 block truncate text-[0.6875rem] text-muted">
            {row.labName} · {formatParams(row.model.paramsB)} · D{row.model.releaseDay}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-base tabular-nums text-mint">
            {num(row.capability, 0)}
          </span>
          <span className="block text-[0.5625rem] uppercase tracking-wide text-muted">cap</span>
        </span>
      </button>

      <div className="grid grid-cols-3 border-t border-line/50 bg-void/20 px-2 py-1.5">
        <div className="min-w-0 border-r border-line/40 px-1.5">
          <span className="block truncate text-[0.5625rem] uppercase tracking-wide text-muted">
            {priorityMetric?.short ?? 'Score'}
          </span>
          {priorityMetric ? (
            <BenchmarkScoreCost
              model={row.model}
              metric={priorityMetric}
              score={priorityScore}
              prices={prices}
              servingEfficiency={servingEfficiency}
              placeAbove={false}
            />
          ) : <span className="font-mono text-bone">—</span>}
        </div>
        <div className="min-w-0 border-r border-line/40 px-1.5">
          <span className="block truncate text-[0.5625rem] uppercase tracking-wide text-muted">List $/MTok</span>
          <span className="block truncate font-mono text-[0.75rem] tabular-nums text-bone">
            {row.usdPerMTok != null ? money(row.usdPerMTok) : '—'}
          </span>
        </div>
        <div className="min-w-0 px-1.5">
          <span className="block truncate text-[0.5625rem] uppercase tracking-wide text-muted">Official</span>
          <span className="block truncate font-mono text-[0.75rem] text-bone">Instant</span>
        </div>
      </div>

      <section className="border-t border-line/50">
        <button
          type="button"
          aria-expanded={scoresOpen}
          aria-controls={scorePanelId}
          onClick={() => setScoresOpen((current) => !current)}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[0.6875rem] text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
        >
          <span>All {metrics.length} scores &amp; task cost</span>
          <span
            aria-hidden
            className={`transition ${scoresOpen ? 'rotate-90' : ''}`}
          >
            ›
          </span>
        </button>
        {scoresOpen ? (
          <div
            id={scorePanelId}
            role="region"
            aria-label={`${row.model.name} benchmark scores and task costs`}
            tabIndex={0}
            data-swipe-ignore="true"
            className="flex touch-pan-x touch-pan-y snap-x snap-proximity gap-1.5 overflow-x-auto overscroll-x-contain border-t border-line/40 p-2"
          >
            {metrics.map((metric) => (
              <div
                key={metric.id}
                className="flex min-w-[5.25rem] snap-start items-center justify-between gap-1 rounded-md border border-line/50 bg-void/35 px-2 py-1"
              >
                <span className="truncate text-[0.625rem] text-muted">{metric.short}</span>
                <BenchmarkScoreCost
                  model={row.model}
                  metric={metric}
                  score={row.scores[metric.id] ?? 0}
                  prices={prices}
                  servingEfficiency={servingEfficiency}
                  placeAbove={false}
                />
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </article>
  )
}

function formatTaskCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

function formatTaskPf(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 PF-d'
  if (value >= 1) return `${num(value, 2)} PF-d`
  if (value >= 0.001) return `${num(value * 1_000, 2)} mPF-d`
  return `${num(value * 1_000_000, 1)} µPF-d`
}

function effectiveTaskRate(estimate: BenchmarkTaskCostEstimate): number {
  return estimate.billedTokens > 0
    ? (estimate.cost * 1_000_000) / estimate.billedTokens
    : 0
}

export function BenchmarkScoreCost({
  model,
  metric,
  score,
  prices,
  servingEfficiency,
  placeAbove,
}: {
  model: Model
  metric: BenchmarkMetricDef
  score: number
  prices: { priceIn: number; priceOut: number }
  servingEfficiency: number
  placeAbove: boolean
}) {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState<{
    left: number
    top: number
    compact: boolean
  } | null>(null)
  const estimates = useMemo(
    () => benchmarkEffortRecipes(model).map((recipe) =>
      estimateBenchmarkTaskCost(
        model,
        metric.id,
        recipe.id,
        prices,
        servingEfficiency,
      ),
    ),
    [metric.id, model, prices, servingEfficiency],
  )
  const baseline = estimates[0]
  const summary = useMemo(
    () => estimates
      .map(
        (estimate) =>
          `${estimate.recipeName}: ${formatTaskCost(estimate.cost)}, ${num(estimate.billedTokens, 0)} billed tokens, ${formatTaskPf(estimate.computePfDays)}, ${num(estimate.estimatedLatencyMs / 1_000, 1)} seconds`,
      )
      .join('. '),
    [estimates],
  )
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor || typeof window === 'undefined') return
    const compact = window.matchMedia(BENCHMARK_COMPACT_MEDIA).matches
    if (compact) {
      setPosition({ left: 0, top: 0, compact: true })
      return
    }
    const rect = anchor.getBoundingClientRect()
    const width = 304
    const height = Math.min(
      popupRef.current?.offsetHeight ?? 320,
      Math.max(160, window.innerHeight - 16),
    )
    const roomAbove = rect.top - 8
    const roomBelow = window.innerHeight - rect.bottom - 8
    const above = placeAbove || (roomBelow < height && roomAbove > roomBelow)
    setPosition({
      left: Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8),
      ),
      top: above
        ? Math.max(8, rect.top - height - 7)
        : Math.max(8, Math.min(rect.bottom + 7, window.innerHeight - height - 8)),
      compact: false,
    })
  }, [placeAbove])
  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updatePosition()
    const frame = window.requestAnimationFrame(updatePosition)
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setPinned(false)
      setOpen(false)
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', closeOutside, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', closeOutside, true)
    }
  }, [open, updatePosition])
  const show = () => {
    updatePosition()
    setOpen(true)
  }
  const close = () => {
    setPinned(false)
    setOpen(false)
  }
  const togglePinned = () => {
    if (pinned) close()
    else {
      updatePosition()
      setPinned(true)
      setOpen(true)
    }
  }
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onMouseEnter={show}
        onMouseLeave={() => {
          if (!pinned) setOpen(false)
        }}
        onFocus={show}
        onBlur={() => {
          window.requestAnimationFrame(() => {
            const active = document.activeElement
            if (
              !pinned &&
              active !== anchorRef.current &&
              !(active instanceof Node && popupRef.current?.contains(active))
            ) {
              setOpen(false)
            }
          })
        }}
        onClick={togglePinned}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? tooltipId : undefined}
        aria-label={`${metric.label} score ${score > 0 ? score.toFixed(0) : 'not measured'}. Estimated representative task economics from input list $${prices.priceIn.toFixed(2)}/MTok and output list $${prices.priceOut.toFixed(2)}/MTok. ${summary}`}
        aria-describedby={open ? tooltipId : undefined}
        data-benchmark-cost-trigger
        className="group/cost inline-flex min-h-7 min-w-8 items-center justify-center rounded-sm px-0.5 hover:bg-mint/10 focus-visible:bg-mint/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
      >
        <span>{score > 0 ? score.toFixed(0) : '—'}</span>
        <span
          aria-hidden
          className="ml-0.5 text-[0.5rem] text-muted/70 opacity-100"
        >
          $
        </span>
      </button>
      {open && position && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popupRef}
              id={tooltipId}
              role="dialog"
              aria-label={`${metric.label} task economics`}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close()
              }}
              data-mobile-cost-sheet={position.compact ? 'true' : 'false'}
              style={
                position.compact
                  ? undefined
                  : { left: position.left, top: position.top }
              }
              className={`pointer-events-auto fixed z-[100] overflow-y-auto rounded-lg border border-line bg-panel/98 p-2.5 text-left font-sans text-[0.6875rem] font-normal normal-case tracking-normal text-bone shadow-2xl shadow-black/50 backdrop-blur-md ${
                position.compact
                  ? 'inset-x-2 bottom-[calc(var(--mobile-nav-height,0px)+var(--hud-training-height,0px)+0.5rem)] max-h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--hud-training-height,0px)-1rem)] w-auto'
                  : 'max-h-[min(70vh,32rem)] w-[19rem]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-mint">Cost per task</div>
                  <div className="mt-0.5 text-muted">{metric.label}</div>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close task cost details"
                  className={`inline-flex items-center justify-center rounded-md border border-line/70 text-base text-muted hover:text-bone focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint ${
                    position.compact ? 'min-h-11 min-w-11' : 'min-h-8 min-w-8'
                  }`}
                >
                  <span aria-hidden>×</span>
                </button>
              </div>
              <div className="mt-2 space-y-1.5 font-mono">
                {estimates.map((estimate) => (
                  <div key={estimate.recipeId} className="border-t border-line/40 pt-1 first:border-0 first:pt-0">
                    <div className="flex justify-between gap-2">
                      <span className="text-muted">
                        {estimate.recipeName} · {num(estimate.tokenMultiplier, 1)}×
                      </span>
                      <span>{formatTaskCost(estimate.cost)}</span>
                    </div>
                    <div className="mt-0.5 text-muted">
                      {num(estimate.inputTokens, 0)} in + {num(estimate.billedGeneratedTokens, 0)} out · ${num(effectiveTaskRate(estimate), 2)}/MTok effective
                    </div>
                    <div className="text-muted">
                      {formatTaskPf(estimate.computePfDays)} · {num(estimate.estimatedTokensPerSecond, 1)} tok/s · {num(estimate.estimatedLatencyMs / 1_000, 1)}s
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 border-t border-line/60 pt-1.5 text-muted">
                {baseline?.billingBasis === 'tokens'
                  ? `$${num(prices.priceIn, 2)}/MTok input · $${num(prices.priceOut, 2)}/MTok output`
                  : `Native ${baseline?.billingBasis ?? 'media'} price; tokens are serving equivalents`}
              </div>
            </div>,
            document.getElementById('hud-root') ?? document.body,
          )
        : null}
    </>
  )
}

export function projectedBenchmarkScore(
  model: Model,
  metricId: BenchmarkMetricId,
  published: number,
  recipeId: string,
): number {
  if (recipeId === INSTANT_EFFORT_ID || published <= 0) return published
  const workload = benchmarkTaskWorkload(metricId)
  if (
    workload !== 'language' &&
    workload !== 'coding' &&
    workload !== 'reasoning'
  ) {
    return published
  }
  const view = effortViewForRecipe(model, recipeId)
  const lift = Math.max(0, (view?.capability ?? model.capability) - model.capability)
  return Math.max(0, Math.min(100, published + lift))
}

function scoreTone(score: number) {
  return score >= 70
    ? ('positive' as const)
    : score >= 50
      ? ('warning' as const)
      : ('danger' as const)
}

export function SelectedBenchmarkModelReview({
  row,
  rank,
  suiteId,
  metrics,
  recipeId,
  onRecipeChange,
  prices,
  servingEfficiency,
  publishedReviews,
  audienceGroup,
  onOpenReviews,
}: {
  row: LeaderboardEffortRow
  rank: number
  suiteId: BenchmarkSuiteId
  metrics: readonly BenchmarkMetricDef[]
  recipeId: string
  onRecipeChange: (id: string) => void
  prices: { priceIn: number; priceOut: number }
  servingEfficiency: number
  publishedReviews: ModelReview[]
  audienceGroup?: ApiReviewGroup
  onOpenReviews?: () => void
}) {
  const recipes = benchmarkEffortRecipes(row.model)
  const recipe =
    recipes.find((candidate) => candidate.id === recipeId) ?? recipes[0]!
  const projectionActive = recipe.id !== INSTANT_EFFORT_ID
  const tasks = metrics.map((metric) => {
    const published = publicBenchmarkScore(row.model, suiteId, metric.id) ?? 0
    return {
      metric,
      published,
      projected: projectedBenchmarkScore(
        row.model,
        metric.id,
        published,
        recipe.id,
      ),
      estimate: estimateBenchmarkTaskCost(
        row.model,
        metric.id,
        recipe.id,
        prices,
        servingEfficiency,
      ),
    }
  })
  const scored = tasks.filter((task) => task.published > 0)
  const strongest = [...scored].sort((a, b) => b.projected - a.projected)[0]
  const weakest = [...scored].sort((a, b) => a.projected - b.projected)[0]
  const averageCost =
    tasks.reduce((sum, task) => sum + task.estimate.cost, 0) /
    Math.max(1, tasks.length)
  const totalBilledTokens = tasks.reduce(
    (sum, task) => sum + task.estimate.billedTokens,
    0,
  )
  const effectiveUsdPerMTok =
    totalBilledTokens > 0
      ? (tasks.reduce((sum, task) => sum + task.estimate.cost, 0) * 1_000_000) /
        totalBilledTokens
      : 0
  const averagePf =
    tasks.reduce((sum, task) => sum + task.estimate.computePfDays, 0) /
    Math.max(1, tasks.length)
  const averageSpeed =
    tasks.reduce((sum, task) => sum + task.estimate.estimatedTokensPerSecond, 0) /
    Math.max(1, tasks.length)
  const averageTtft =
    tasks.reduce((sum, task) => sum + task.estimate.timeToFirstTokenMs, 0) /
    Math.max(1, tasks.length)
  return (
    <div id="benchmark-model-review" className="scroll-mt-3">
      <GameCard
        eyebrow={`Detailed review · official rank #${rank}`}
        title={row.model.name}
        tone="mint"
        mobileSummary={`${row.labName} · cap ${num(row.capability, 0)} · ${recipe.name} ${recipe.thinkingTokenMult.toFixed(1)}×`}
        actions={
          <span className="hidden sm:inline-flex">
            <StatusChip tone="positive">Instant rank preserved</StatusChip>
          </span>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-3">
          <div className="hud-mobile-detail text-[0.75rem] text-muted">
            {row.labName} · {formatParams(row.model.paramsB)} · released D{row.model.releaseDay}
          </div>
          <label className="w-full text-[0.6875rem] text-muted sm:w-auto sm:min-w-[13rem]">
            Review inference effort
            <select
              className="hud-select mt-1 w-full"
              value={recipe.id}
              onChange={(event) => onRecipeChange(event.target.value)}
              aria-label="Review inference effort"
            >
              {recipes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {candidate.thinkingTokenMult.toFixed(1)}× budget
                </option>
              ))}
            </select>
          </label>
        </div>
        {projectionActive ? (
          <p className="mt-2 rounded-md border border-amber/35 bg-amber/10 px-2.5 py-2 text-[0.6875rem] leading-5 text-amber">
            Unofficial projection: applies this trained recipe&apos;s rapidly
            diminishing capability lift to reasoning-compatible tasks. It does
            not alter published Instant scores or official rank #{rank}.
          </p>
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2 min-[1181px]:grid-cols-5">
          <MetricTile label="Speed" value={`${num(averageSpeed, 1)} tok/s`} detail={`${num(averageTtft, 0)} ms TTFT`} tone="research" />
          <MetricTile label="Cost / task" value={formatTaskCost(averageCost)} detail={`$${num(prices.priceIn, 2)} in · $${num(prices.priceOut, 2)} out`} tone="warning" />
          <MetricTile label="PF / task" value={formatTaskPf(averagePf)} detail={`${num(tasks[0]?.estimate.computeIntensityMultiplier ?? 1, 2)}× intensity`} tone="research" />
          <MetricTile label="Reasoning budget" value={`${recipe.thinkingTokenMult.toFixed(1)}×`} detail={projectionActive ? 'unofficial view' : 'official Instant'} tone={projectionActive ? 'warning' : 'positive'} />
          <div className="hud-mobile-detail">
            <MetricTile label="Effective $/MTok" value={money(effectiveUsdPerMTok)} detail={`${recipe.name} billed mix`} tone="warning" />
          </div>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <section className="rounded-md border border-line/60 bg-void/30 p-2.5">
            <h4 className="text-[0.75rem] font-semibold uppercase tracking-wide text-bone">Task assessment</h4>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {strongest ? <MetricTile label={`Strongest · ${strongest.metric.label}`} value={num(strongest.projected, 0)} detail={projectionActive ? `${num(strongest.published, 0)} published` : 'published Instant'} tone={scoreTone(strongest.projected)} /> : null}
              {weakest ? <MetricTile label={`Weakest · ${weakest.metric.label}`} value={num(weakest.projected, 0)} detail={projectionActive ? `${num(weakest.published, 0)} published` : 'published Instant'} tone={scoreTone(weakest.projected)} /> : null}
            </div>
          </section>
          <section className="rounded-md border border-line/60 bg-void/30 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[0.75rem] font-semibold uppercase tracking-wide text-bone">User reviews</h4>
              {onOpenReviews ? <HudButton variant="ghost" onClick={onOpenReviews}>Open all</HudButton> : null}
            </div>
            {publishedReviews.length > 0 ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[...publishedReviews]
                  .sort((a, b) => b.publishedDay - a.publishedDay)
                  .slice(0, 4)
                  .map((review) => <PublishedBenchmarkReview key={review.id} review={review} />)}
              </div>
            ) : audienceGroup ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {audienceGroup.reviews.slice(0, 4).map((review) => (
                  <AudienceReviewCard key={review.id} review={review} />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[0.75rem] text-muted">No user review has published yet.</p>
            )}
          </section>
        </div>
        <details className="mt-3 rounded-md border border-line/60 bg-void/30">
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] font-medium text-bone hover:bg-panel-2/60">
            <span>Per-task benchmark ledger</span>
            <span className="hidden font-mono text-[0.6875rem] text-muted sm:inline">{tasks.length} tasks · scores, tokens, cost, PF</span>
          </summary>
          <div
            role="region"
            aria-label={`${row.model.name} per-task benchmark ledger`}
            tabIndex={0}
            data-swipe-ignore="true"
            className="touch-pan-x touch-pan-y overflow-x-auto overscroll-x-contain border-t border-line/60"
          >
            <table className="w-full min-w-[680px] text-left text-[0.75rem]">
              <thead className="sticky top-0 z-10 bg-panel-2 font-mono text-[0.625rem] uppercase tracking-wide text-muted">
                <tr><th className="sticky left-0 bg-panel-2 px-2.5 py-2">Task</th><th className="px-2 py-2 text-right">Published</th>{projectionActive ? <th className="px-2 py-2 text-right">Projected</th> : null}<th className="px-2 py-2 text-right">Tokens</th><th className="px-2 py-2 text-right">Cost</th><th className="px-2 py-2 text-right">Latency</th><th className="px-2.5 py-2 text-right">PF</th></tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.metric.id} className="border-t border-line/40">
                    <td className="sticky left-0 bg-panel-2 px-2.5 py-1.5 text-bone">{task.metric.label}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-muted">{task.published > 0 ? num(task.published, 0) : '—'}</td>
                    {projectionActive ? <td className="px-2 py-1.5 text-right font-mono text-amber">{task.projected > 0 ? num(task.projected, 0) : '—'}</td> : null}
                    <td className="px-2 py-1.5 text-right font-mono text-muted">{num(task.estimate.billedTokens, 0)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-bone">{formatTaskCost(task.estimate.cost)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-muted">{num(task.estimate.estimatedLatencyMs / 1_000, 1)}s</td>
                    <td className="px-2.5 py-1.5 text-right font-mono text-research">{formatTaskPf(task.estimate.computePfDays)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </GameCard>
    </div>
  )
}

function PublishedBenchmarkReview({ review }: { review: ModelReview }) {
  const score =
    (review.capability + review.value + review.productQuality + review.trust) / 4
  return (
    <article className="rounded-md border border-line/50 bg-panel-2/45 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] font-medium capitalize text-bone">{review.audience}</span>
        <StatusChip tone={scoreTone(score)}>{num(score, 0)}</StatusChip>
      </div>
      <p className="mt-1 text-[0.6875rem] leading-snug text-muted">{review.headline}</p>
      <p className="mt-1 font-mono text-[0.625rem] text-muted/70">D{review.publishedDay} · {review.phase.replace('_', ' ')}</p>
    </article>
  )
}

export function InternalBenchmarksTab({
  rows,
  suiteId,
  metrics,
  state,
  columns,
}: {
  rows: InternalBenchmarkRow[]
  suiteId: BenchmarkSuiteId
  metrics: readonly BenchmarkMetricDef[]
  state: SimState
  columns: NamedEffortColumn[]
}) {
  const snap = computeSnapshot(state)
  const [sortKey, setSortKey] = useState<InternalBenchmarkSortKey>('day')
  const [sortDirection, setSortDirection] =
    useState<LeaderboardSortDirection>('desc')
  const boardsForRow = (row: (typeof rows)[number]) =>
    row.model
      ? effortBoardsFor(row.model, modelUsdBase(state, snap, row.model, true))
      : (row.effortBoards ?? [])
  const scoreFor = (
    row: (typeof rows)[number],
    metricId: BenchmarkMetricId,
  ) =>
    row.model
      ? (publicBenchmarkScore(row.model, suiteId, metricId) ?? 0)
      : metricId === 'mmlu'
        ? (row.suite ?? 0)
        : metricId === 'safety'
          ? (row.safety ?? 0)
          : 0
  const valueFor = (row: (typeof rows)[number]): string | number => {
    if (sortKey === 'model') return row.name
    if (sortKey === 'status') return row.status
    if (sortKey === 'cap') return row.capability ?? -1
    if (sortKey === 'day') return row.day
    if (sortKey.startsWith('effort:')) {
      const [, key, field] = sortKey.split(':')
      const board = boardForColumn(boardsForRow(row), key!)
      return field === 'usd'
        ? (effectiveEffortBoardUsdPerBaseMTok(board) ?? -1)
        : (board?.capability ?? -1)
    }
    return scoreFor(row, sortKey as BenchmarkMetricId)
  }
  const sortedRows = [...rows].sort((a, b) => {
    const left = valueFor(a)
    const right = valueFor(b)
    const comparison =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right, undefined, { numeric: true })
        : Number(left) - Number(right)
    return comparison * (sortDirection === 'asc' ? 1 : -1)
  })
  const changeSort = (key: InternalBenchmarkSortKey) => {
    setSortDirection((current) =>
      key === sortKey ? (current === 'asc' ? 'desc' : 'asc') : key === 'model' || key === 'status' ? 'asc' : 'desc',
    )
    setSortKey(key)
  }
  const mobilePriorityMetric = metrics.find((metric) => metric.id === sortKey)
  const mobileScoreMetrics = mobilePriorityMetric
    ? [mobilePriorityMetric, ...metrics.filter((metric) => metric.id !== mobilePriorityMetric.id)]
    : metrics
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No internal evals"
        description="Start a run and benchmark it, or keep a finished model internal."
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
        <StatusChip tone="research">LAB</StatusChip>
        <span className="hud-mobile-summary">
          Private snapshots and unreleased checkpoints.
        </span>
        <span className="hud-mobile-detail">
          In-training snapshots and unreleased models. Use Benchmark on a run
          in Models to measure weights without releasing them.
        </span>
      </div>

      <div className="hud-mobile-summary">
        <div
          data-mobile-internal-sort
          className="sticky top-0 z-20 flex items-end gap-2 rounded-lg border border-line/70 bg-panel/95 p-2 shadow-lg shadow-void/20 backdrop-blur-md"
        >
          <label className="min-w-0 flex-1 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-muted">
            Order by
            <select
              aria-label="Mobile internal benchmark sort"
              className="hud-select mt-1 w-full"
              value={sortKey}
              onChange={(event) => {
                const next = event.target.value as InternalBenchmarkSortKey
                if (next === sortKey) return
                setSortKey(next)
                setSortDirection(next === 'model' || next === 'status' ? 'asc' : 'desc')
              }}
            >
              <option value="day">Benchmark day</option>
              <option value="cap">Capability</option>
              <option value="model">Model name</option>
              <option value="status">Status</option>
              {metrics.map((metric) => (
                <option key={metric.id} value={metric.id}>{metric.label}</option>
              ))}
              <option value="effort:instant:cap">Instant capability</option>
              <option value="effort:instant:usd">Instant cost</option>
              {columns.flatMap((column) => [
                <option key={`${column.key}-cap`} value={`effort:${column.key}:cap`}>
                  {column.name} capability
                </option>,
                <option key={`${column.key}-cost`} value={`effort:${column.key}:usd`}>
                  {column.name} cost
                </option>,
              ])}
            </select>
          </label>
          <button
            type="button"
            aria-label={`Sort ${sortDirection === 'asc' ? 'ascending' : 'descending'}; change direction`}
            title="Reverse order"
            onClick={() => setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-line/70 bg-panel-2 font-mono text-sm text-research focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
          >
            <span aria-hidden>{sortDirection === 'asc' ? '↑' : '↓'}</span>
          </button>
        </div>
      </div>

      <div data-mobile-internal-benchmarks className="hud-mobile-summary anim-stagger space-y-2">
        {sortedRows.map((row) => (
          <MobileInternalBenchmarkCard
            key={`${row.status}-${row.id}`}
            row={row}
            scores={mobileScoreMetrics.map((metric) => ({
              metric,
              score: scoreFor(row, metric.id),
            }))}
            boards={boardsForRow(row)}
          />
        ))}
      </div>

      <div
        role="region"
        aria-label="Internal benchmark table"
        tabIndex={0}
        data-swipe-ignore="true"
        data-desktop-internal-benchmarks
        className="hud-mobile-detail touch-pan-x touch-pan-y overflow-x-auto overscroll-x-contain rounded-lg border border-line/70"
      >
        <table className="w-full min-w-[640px] border-collapse text-left text-[0.8125rem]">
          <thead className="sticky top-0 z-20">
            <tr className="border-b border-line bg-panel-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
              <InternalSortableHeader label="Model" sortKey="model" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
              <InternalSortableHeader label="Status" sortKey="status" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
              <InternalSortableHeader label="Cap" sortKey="cap" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
              <EffortColumnHeaders columns={columns} activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
              {metrics.map((metric) => (
                <InternalSortableHeader key={metric.id} label={metric.short} fullLabel={metric.label} sortKey={metric.id} activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
              ))}
              <InternalSortableHeader label="Day" sortKey="day" activeKey={sortKey} direction={sortDirection} onSort={changeSort} />
            </tr>
          </thead>
          <tbody className="anim-stagger">
            {sortedRows.map((row) => (
              <tr key={`${row.status}-${row.id}`} className="border-b border-line/60 bg-mint/5">
                <td className="max-w-[200px] truncate px-2 py-1.5 font-medium text-bone">
                  {row.name}
                </td>
                <td className="px-1.5 py-1.5">
                  <StatusChip tone={row.status === 'training' ? 'warning' : 'research'}>
                    {row.pending ? 'eval' : row.status}
                  </StatusChip>
                </td>
                <td className="px-1.5 py-1.5 font-mono tabular-nums text-bone">
                  {row.capability != null ? num(row.capability, 0) : '—'}
                </td>
                <EffortBoardCells
                  boards={boardsForRow(row)}
                  columns={columns}
                />
                {metrics.map((metric) => {
                  const score = row.model
                    ? publicBenchmarkScore(row.model, suiteId, metric.id)
                    : metric.id === 'mmlu' || metric.id === 'safety'
                      ? metric.id === 'safety'
                        ? row.safety
                        : row.suite
                      : null
                  return (
                    <td
                      key={metric.id}
                      className="px-1 py-1.5 text-center font-mono tabular-nums text-muted"
                    >
                      {score != null && score > 0 ? score.toFixed(0) : '—'}
                    </td>
                  )
                })}
                <td className="px-1.5 py-1.5 font-mono tabular-nums text-muted">
                  {row.day}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MobileInternalBenchmarkCard({
  row,
  scores,
  boards,
}: {
  row: InternalBenchmarkRow
  scores: Array<{ metric: BenchmarkMetricDef; score: number }>
  boards: readonly EffortBoard[]
}) {
  const primaryScore = scores[0]
  return (
    <article className="overflow-hidden rounded-lg border border-research/25 bg-research/5">
      <header className="flex min-h-14 items-center gap-2.5 px-2.5 py-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-semibold text-bone">
            {row.name}
          </span>
          <span className="mt-0.5 block text-[0.6875rem] text-muted">
            Benchmark D{row.day}
          </span>
        </span>
        <StatusChip tone={row.status === 'training' ? 'warning' : 'research'}>
          {row.pending ? 'eval' : row.status}
        </StatusChip>
      </header>

      <div className="grid grid-cols-3 border-t border-line/50 bg-void/20 px-2 py-1.5">
        <MobileCardStat
          label="Capability"
          value={row.capability != null ? num(row.capability, 0) : '—'}
          tone="text-mint"
        />
        <MobileCardStat
          label={primaryScore?.metric.short ?? 'Suite'}
          value={primaryScore && primaryScore.score > 0 ? num(primaryScore.score, 0) : '—'}
        />
        <MobileCardStat
          label="Safety"
          value={row.safety != null && row.safety > 0 ? num(row.safety, 0) : '—'}
          last
        />
      </div>

      <details className="group/internal border-t border-line/50">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.6875rem] text-muted marker:hidden focus-visible:outline focus-visible:outline-1 focus-visible:outline-research">
          <span>Scores &amp; trained effort</span>
          <span aria-hidden className="transition group-open/internal:rotate-90">›</span>
        </summary>
        <div className="space-y-2 border-t border-line/40 p-2">
          <div className="grid grid-cols-2 gap-1.5">
            {scores.map(({ metric, score }) => (
              <div
                key={metric.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-line/45 bg-void/30 px-2 py-1.5"
              >
                <span className="truncate text-[0.625rem] text-muted" title={metric.label}>
                  {metric.short}
                </span>
                <span className="font-mono text-[0.75rem] tabular-nums text-bone">
                  {score > 0 ? num(score, 0) : '—'}
                </span>
              </div>
            ))}
          </div>
          {boards.length > 0 ? (
            <div className="space-y-1" aria-label={`${row.name} effort boards`}>
              {boards.map((board) => {
                const effectiveCost = effectiveEffortBoardUsdPerBaseMTok(board)
                return (
                  <div
                    key={board.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border border-line/45 bg-panel-2/45 px-2 py-1.5 text-[0.6875rem]"
                  >
                    <span className="truncate text-bone">{board.name}</span>
                    <span className="font-mono tabular-nums text-muted">
                      cap {num(board.capability, 0)} · {board.tokenMult.toFixed(1)}×
                    </span>
                    <span className="font-mono tabular-nums text-research">
                      {effectiveCost != null ? money(effectiveCost) : '—'}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-[0.6875rem] text-muted">No trained effort board yet.</p>
          )}
        </div>
      </details>
    </article>
  )
}

function MobileCardStat({
  label,
  value,
  tone = 'text-bone',
  last = false,
}: {
  label: string
  value: string
  tone?: string
  last?: boolean
}) {
  return (
    <div className={`min-w-0 px-1.5 ${last ? '' : 'border-r border-line/40'}`}>
      <span className="block truncate text-[0.5625rem] uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className={`block truncate font-mono text-[0.75rem] tabular-nums ${tone}`}>
        {value}
      </span>
    </div>
  )
}

function ReviewsTab({
  reviewGroups,
  selectedReviewGroup,
  onSelect,
}: {
  reviewGroups: ReturnType<typeof buildAudienceReviewGroups>
  selectedReviewGroup:
    ReturnType<typeof buildAudienceReviewGroups>[number] | undefined
  onSelect: (id: string) => void
}) {
  if (reviewGroups.length === 0) {
    return (
      <EmptyState
        title="No audience reviews"
        description="Enable a subscription plan or release a model API to generate reviews."
      />
    )
  }

  const selectedPrice = selectedReviewGroup
    ? selectedReviewGroup.reviewKind === 'api'
      ? `$${num(selectedReviewGroup.apiPriceInPerMTok, 2)} in · $${num(selectedReviewGroup.apiPriceOutPerMTok, 2)} out`
      : selectedReviewGroup.pricePerMonth <= 0
        ? 'Free'
        : `$${num(selectedReviewGroup.pricePerMonth, 0)}/mo`
    : null

  return (
    <GameCard
      eyebrow="Audience"
      title={selectedReviewGroup?.reviewName ?? 'Reviews'}
      tone="mint"
      mobileSummary={selectedReviewGroup ? `${selectedReviewGroup.modelNames[0] ?? 'No model'} · ${selectedPrice}` : undefined}
      actions={
        selectedReviewGroup ? (
          <span className="hud-mobile-detail font-mono text-[0.6875rem] tabular-nums text-muted">
            {selectedPrice}
          </span>
        ) : undefined
      }
    >
      <div
        role="region"
        aria-label="Review audiences"
        data-swipe-ignore="true"
        className="mb-3 flex touch-pan-x touch-pan-y snap-x snap-proximity gap-1 overflow-x-auto overscroll-x-contain pb-1 min-[1181px]:flex-wrap min-[1181px]:overflow-visible min-[1181px]:pb-0"
      >
        {reviewGroups.map((group) => (
          <button
            key={group.reviewId}
            type="button"
            aria-pressed={selectedReviewGroup?.reviewId === group.reviewId}
            onClick={() => onSelect(group.reviewId)}
            className={`min-h-11 shrink-0 snap-start rounded-md px-2.5 py-1 text-[0.75rem] transition min-[1181px]:min-h-0 ${
              selectedReviewGroup?.reviewId === group.reviewId
                ? 'bg-mint text-void'
                : 'border border-line/70 bg-void/40 text-muted hover:text-bone'
            }`}
          >
            {group.reviewName}
          </button>
        ))}
      </div>

      {selectedReviewGroup && (
        <p
          className="hud-mobile-detail mb-2 truncate text-[0.6875rem] text-muted"
          title={selectedReviewGroup.modelNames.join(', ')}
        >
          {selectedReviewGroup.modelNames.join(' + ') || 'No released model'}
        </p>
      )}

      {selectedReviewGroup ? (
        <div className="anim-stagger grid gap-2 sm:grid-cols-2">
          {selectedReviewGroup.reviews.map((review) => (
            <AudienceReviewCard key={review.id} review={review} />
          ))}
        </div>
      ) : null}
    </GameCard>
  )
}

function AudienceReviewCard({ review }: { review: PlanAudienceReview }) {
  const tone =
    review.score >= 70
      ? ('positive' as const)
      : review.score >= 50
        ? ('warning' as const)
        : ('danger' as const)
  return (
    <GameCard
      title={
        <span className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{review.label}</span>
          <StatusChip tone={tone}>{review.score.toFixed(0)}</StatusChip>
        </span>
      }
      tone={
        tone === 'positive' ? 'mint' : tone === 'warning' ? 'train' : 'danger'
      }
      pad
    >
      <p className="text-[0.8125rem] leading-snug text-muted">
        {review.summary}
      </p>
      <div
        className={`mt-2 grid gap-1.5 ${review.metrics.length === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2'}`}
      >
        {review.metrics.map((metric) => (
          <div key={metric.label} className="min-w-0">
            <StatRow
              label={metric.label}
              value={metric.value.toFixed(0)}
              strong
            />
            <MeterBar
              value={metric.value / 100}
              tone={
                metric.value >= 70
                  ? 'positive'
                  : metric.value >= 50
                    ? 'warning'
                    : 'danger'
              }
            />
          </div>
        ))}
      </div>
    </GameCard>
  )
}

type NamedEffortColumn = { key: string; name: string }

function namedEffortColumns(models: readonly Model[]): NamedEffortColumn[] {
  const seen = new Map<string, string>()
  for (const model of models) {
    for (const recipe of migrateEffortRecipes(model.productProfile)) {
      if (!recipe.trained || recipe.kind === 'instant') continue
      const key = recipe.name.trim().toLowerCase()
      if (!seen.has(key)) seen.set(key, recipe.name)
    }
  }
  return [...seen.entries()].map(([key, name]) => ({ key, name }))
}

function modelUsdBase(
  state: SimState,
  snap: ReturnType<typeof computeSnapshot>,
  model: Model,
  isPlayer: boolean,
): number | null {
  if (isPlayer) return apiUnitCostPerMTok(state, snap, model).blended
  const inn = model.costApiPriceIn
  const out = model.costApiPriceOut
  if (inn == null && out == null) return null
  return blendApiPrice(inn ?? out ?? 0, out ?? inn ?? 0)
}

/** Public list price, never hosting cost, for benchmark billing displays. */
function modelListUsdBase(
  state: SimState,
  model: Model,
  labId: string,
): number {
  const pricing =
    labId === 'player'
      ? state.player.pricing
      : (state.rivals.find((rival) => rival.id === labId)?.pricing ??
        state.player.pricing)
  const offer = modelOfferApiInOut(pricing, model)
  return blendApiPrice(offer.priceIn, offer.priceOut)
}

function boardForColumn(
  boards: readonly EffortBoard[],
  key: string,
): EffortBoard | undefined {
  if (key === INSTANT_EFFORT_ID) {
    return boards.find(
      (board) => board.id === INSTANT_EFFORT_ID || board.name === 'Instant',
    )
  }
  return boards.find((board) => board.name.trim().toLowerCase() === key)
}

function EffortColumnHeaders({
  columns,
  activeKey,
  direction,
  onSort,
}: {
  columns: readonly NamedEffortColumn[]
  activeKey: string
  direction: LeaderboardSortDirection
  onSort: (key: `effort:${string}:cap` | `effort:${string}:usd`) => void
}) {
  return (
    <>
      <InternalSortableHeader label="Instant" fullLabel="Instant capability" sortKey="effort:instant:cap" activeKey={activeKey} direction={direction} onSort={onSort} />
      <InternalSortableHeader label="Instant $/base" fullLabel="Instant provider COGS per Instant-equivalent MTok" sortKey="effort:instant:usd" activeKey={activeKey} direction={direction} onSort={onSort} />
      {columns.flatMap((column) => [
        <InternalSortableHeader
          key={column.key}
          label={column.name}
          fullLabel={`${column.name} capability`}
          sortKey={`effort:${column.key}:cap`}
          activeKey={activeKey}
          direction={direction}
          onSort={onSort}
        />,
        <InternalSortableHeader
          key={`${column.key}-usd`}
          label={`${column.name} $/base`}
          fullLabel={`${column.name} provider COGS per Instant-equivalent MTok`}
          sortKey={`effort:${column.key}:usd`}
          activeKey={activeKey}
          direction={direction}
          onSort={onSort}
        />,
      ])}
    </>
  )
}

function InternalSortableHeader<T extends string>({
  label,
  fullLabel = label,
  sortKey,
  activeKey,
  direction,
  onSort,
}: {
  label: string
  fullLabel?: string
  sortKey: T
  activeKey: string
  direction: LeaderboardSortDirection
  onSort: (key: T) => void
}) {
  const active = activeKey === sortKey
  return (
    <th
      className="px-1 py-0 text-center"
      title={fullLabel}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex min-h-8 w-full items-center justify-center gap-0.5 py-1 hover:text-bone focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint"
        aria-label={`Sort internal benchmarks by ${fullLabel}${active ? `, currently ${direction}` : ''}`}
      >
        {label}
        <span aria-hidden className={active ? 'text-mint' : 'text-muted/45'}>
          {active ? (direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}

function EffortBoardCells({
  boards,
  columns,
}: {
  boards: readonly EffortBoard[]
  columns: readonly NamedEffortColumn[]
}) {
  const instant = boardForColumn(boards, INSTANT_EFFORT_ID)
  return (
    <>
      <EffortCell board={instant} />
      <EffortCostCell board={instant} />
      {columns.map((column) => {
        const board = boardForColumn(boards, column.key)
        return (
          <Fragment key={column.key}>
            <EffortCell board={board} />
            <EffortCostCell board={board} />
          </Fragment>
        )
      })}
    </>
  )
}

function EffortCell({ board }: { board: EffortBoard | undefined }) {
  return (
    <td
      className="px-1 py-1.5 text-center font-mono tabular-nums text-muted"
      title={board ? `${board.tokenMult.toFixed(1)}× tokens` : 'Not trained'}
    >
      {board ? num(board.capability, 0) : '—'}
    </td>
  )
}

function EffortCostCell({ board }: { board: EffortBoard | undefined }) {
  const effectiveCost = effectiveEffortBoardUsdPerBaseMTok(board)
  return (
    <td
      className="px-1 py-1.5 text-center font-mono tabular-nums text-muted"
      title={
        board
          ? `${(board.billedTokenMult ?? board.tokenMult).toFixed(1)}× billable tokens determine customer charges · ${(board.computeTokenMult ?? board.tokenMult).toFixed(1)}× provider compute determines displayed COGS per Instant-equivalent MTok`
          : 'Not trained'
      }
    >
      {effectiveCost != null ? money(effectiveCost) : '—'}
    </td>
  )
}
