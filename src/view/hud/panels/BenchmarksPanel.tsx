import { Fragment, useMemo, useState } from 'react'
import type {
  BenchmarkMetricId,
  BenchmarkSuiteId,
  EffortBoard,
  Model,
  SimState,
} from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'
import {
  INSTANT_EFFORT_ID,
  effortBoardsFor,
  migrateEffortRecipes,
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
import { playerTrainingJobs } from '../../../sim/systems/training'
import { isInternalFleetModel } from '../../../sim/modelRelease'
import { useGameStore } from '../../../store/gameStore'
import { money, num } from '../format'
import {
  buildAudienceReviewGroups,
  type PlanAudienceReview,
} from './planReviews'
import {
  benchmarkMetricsForSuite,
  publicBenchmarkScore,
} from '../data/benchmarkViewModel'
import { BenchmarkCompareTab } from './BenchmarkCompareTab'
import { BenchmarkEntryPoint } from './models/BenchmarkEntryPoint'
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

/**
 * Cross-lab eval leaderboard — top 15 by default, load older/weaker models on demand.
 */
export function BenchmarksPanel() {
  const state = useGameStore((s) => s.state)
  const [showAll, setShowAll] = useState(false)
  const [sortId, setSortId] = useState<'cap' | BenchmarkMetricId>('cap')
  const [market, setMarket] = useState<EvaluationMarket>('language')
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null)
  const [tab, setTab] = useState<BenchTab>('leaderboard')

  const rows = useMemo(() => {
    const all = collectLeaderboardModels(state)
    const marketModels = all.filter((row) =>
      evaluationMarketsForModel(row.model).includes(market),
    )
    const suite = suiteForEvaluationMarket(market)
    return sortId === 'cap'
      ? marketModels
      : [...marketModels].sort((a, b) => {
          const sa = publicBenchmarkScore(a.model, suite, sortId) ?? 0
          const sb = publicBenchmarkScore(b.model, suite, sortId) ?? 0
          return sb - sa
        })
  }, [state, sortId, market])

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

  const suiteId = suiteForEvaluationMarket(market)
  const metrics = benchmarkMetricsForSuite(suiteId)
  const snap = useMemo(() => computeSnapshot(state), [state])
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
  const reviewGroups = useMemo(() => buildAudienceReviewGroups(state), [state])
  const selectedReviewGroup =
    reviewGroups.find((group) => group.reviewId === selectedReviewId) ??
    reviewGroups[0]

  const leaders = useMemo(() => {
    const map: Record<string, number> = {}
    for (const d of metrics) {
      let best = -1
      for (const r of rows) {
        const s = publicBenchmarkScore(r.model, suiteId, d.id) ?? 0
        if (s > best) best = s
      }
      map[d.id] = best
    }
    return map
  }, [rows, metrics, suiteId])

  const playerBest = useMemo(() => {
    let best = 0
    for (const r of rows) {
      if (r.isPlayer && r.model.capability > best) best = r.model.capability
    }
    return best
  }, [rows])

  const rivalBest = useMemo(() => {
    let best = 0
    for (const r of rows) {
      if (!r.isPlayer && r.model.capability > best) best = r.model.capability
    }
    return best
  }, [rows])

  const frontierGap = playerBest - rivalBest

  const bestSuite = useMemo(() => {
    let best = 0
    for (const r of rows) {
      if (!r.isPlayer) continue
      const scores = metrics.map(
        (d) => publicBenchmarkScore(r.model, suiteId, d.id) ?? 0,
      )
      const avg =
        scores.length === 0
          ? 0
          : scores.reduce((sum, value) => sum + value, 0) / scores.length
      if (avg > best) best = avg
    }
    return best
  }, [rows, metrics, suiteId])

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

  const activeSeason = useMemo(
    () =>
      (state.benchmarkSeasons ?? []).find((season) => season.active) ?? null,
    [state.benchmarkSeasons],
  )

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
      description="Public field scores. Training snapshots stay on Internal. Voice is personality, not capability."
      actions={
        <div className="flex items-center gap-1.5">
          <BenchmarkEntryPoint
            context={{ kind: 'public' }}
            variant="ghost"
            title="Browse public benchmark evidence. Private checkpoint evidence stays in Models."
            onOpen={() => setTab('leaderboard')}
          />
          {activeSeason ? (
            <StatusChip tone="research">{activeSeason.name}</StatusChip>
          ) : null}
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label="Frontier gap"
          value={gapLabel}
          detail={
            rivalBest > 0 ? `rival ${num(rivalBest, 0)}` : 'no rivals yet'
          }
          tone={gapTone}
        />
        <MetricTile
          label="Best suite"
          value={bestSuite > 0 ? num(bestSuite, 0) : '—'}
          detail="your avg suite"
          tone={
            bestSuite >= 70 ? 'positive' : bestSuite > 0 ? 'warning' : 'neutral'
          }
        />
        <MetricTile
          label="Active audits"
          value={String(activeAudits)}
          detail={
            pendingEvals.length > 0 ? `${pendingEvals.length} pending` : 'clear'
          }
          tone={activeAudits > 0 ? 'research' : 'neutral'}
        />
        <MetricTile
          label="Board size"
          value={String(rows.length)}
          detail={showAll ? 'all shown' : `top ${Math.min(PAGE, rows.length)}`}
        />
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
                  <span className="font-mono text-[0.625rem] text-muted">
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
                  <span className="font-mono text-[0.625rem] text-muted">
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
                  <span className="font-mono text-[0.625rem] text-muted">
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
                      onSelect: () => setSortId('cap'),
                    },
                    ...metrics.map((metric) => ({
                      id: metric.id,
                      label: metric.short,
                      active: sortId === metric.id,
                      onSelect: () => setSortId(metric.id),
                      title: metric.label,
                    })),
                  ],
                },
              ]}
            />

            <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
              <StatusChip tone="positive">PUBLIC</StatusChip>
              <span>
                Released models and live routers. A dash means that axis was
                not measured. Voice is how pleasant the model is to talk to —
                it does not raise capability.
              </span>
            </div>

            {pendingEvals.length > 0 && (
              <GameCard
                eyebrow="In flight"
                title="Audits & field reviews"
                tone="research"
                live
              >
                <div className="anim-stagger space-y-2">
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
              </GameCard>
            )}

            <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line/70">
              <table className="w-full min-w-[720px] border-collapse text-left text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-line bg-panel-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    <th className="sticky left-0 z-10 bg-panel-2 px-2 py-2">
                      #
                    </th>
                    <th className="sticky left-6 z-10 bg-panel-2 px-2 py-2">
                      Model
                    </th>
                    <th className="px-1.5 py-2">Lab</th>
                    <th className="px-1.5 py-2">Size</th>
                    <th className="px-1.5 py-2">Cap</th>
                    <EffortColumnHeaders columns={effortColumns} />
                    {metrics.map((d) => (
                      <th
                        key={d.id}
                        className="px-1 py-2 text-center"
                        title={d.label}
                      >
                        {d.short}
                      </th>
                    ))}
                    <th className="px-1.5 py-2">Day</th>
                  </tr>
                </thead>
                <tbody className="anim-stagger">
                  {visible.map((r, i) => {
                    const rank = i + 1
                    return (
                      <tr
                        key={`${r.labId}-${r.model.id}`}
                        className={`border-b border-line/60 ${
                          r.isPlayer
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
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="min-w-0 truncate">
                              {r.model.name}
                            </span>
                            {r.isPlayer && (
                              <StatusChip tone="positive">you</StatusChip>
                            )}
                            {r.kind === 'router' && (
                              <StatusChip tone="research">router</StatusChip>
                            )}
                          </span>
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
                        <td className="px-1.5 py-1.5 font-mono tabular-nums text-bone">
                          {num(r.model.capability, 0)}
                        </td>
                        <EffortBoardCells
                          boards={effortBoardsFor(
                            r.model,
                            modelUsdBase(state, snap, r.model, r.isPlayer),
                          )}
                          columns={effortColumns}
                        />
                        {metrics.map((d) => {
                          const s =
                            publicBenchmarkScore(r.model, suiteId, d.id) ?? 0
                          const isLead =
                            s >= (leaders[d.id] ?? 0) - 0.05 && s > 1
                          return (
                            <td
                              key={d.id}
                              className={`px-1 py-1.5 text-center font-mono tabular-nums ${
                                isLead ? 'text-mint' : 'text-muted'
                              }`}
                            >
                              {s > 0 ? (
                                s.toFixed(0)
                              ) : (
                                <span title="Not measured">—</span>
                              )}
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
            rows={rows}
            suiteId={suiteId}
            metrics={metrics}
            market={market}
            onMarketChange={(candidate) => {
              setMarket(candidate)
              setSortId('cap')
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

function InternalBenchmarksTab({
  rows,
  suiteId,
  metrics,
  state,
  columns,
}: {
  rows: Array<{
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
  }>
  suiteId: BenchmarkSuiteId
  metrics: readonly BenchmarkMetricDef[]
  state: SimState
  columns: NamedEffortColumn[]
}) {
  const snap = computeSnapshot(state)
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
        <span>
          In-training snapshots and unreleased models. Use Benchmark on a run
          in Models to measure weights without releasing them.
        </span>
      </div>
      <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-line/70">
        <table className="w-full min-w-[640px] border-collapse text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line bg-panel-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
              <th className="px-2 py-2">Model</th>
              <th className="px-1.5 py-2">Status</th>
              <th className="px-1.5 py-2">Cap</th>
              <EffortColumnHeaders columns={columns} />
              {metrics.map((metric) => (
                <th key={metric.id} className="px-1 py-2 text-center" title={metric.label}>
                  {metric.short}
                </th>
              ))}
              <th className="px-1.5 py-2">Day</th>
            </tr>
          </thead>
          <tbody className="anim-stagger">
            {rows.map((row) => (
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
                  boards={
                    row.model
                      ? effortBoardsFor(
                          row.model,
                          modelUsdBase(state, snap, row.model, true),
                        )
                      : (row.effortBoards ?? [])
                  }
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

  return (
    <GameCard
      eyebrow="Audience"
      title={selectedReviewGroup?.reviewName ?? 'Reviews'}
      tone="mint"
      actions={
        selectedReviewGroup ? (
          <span className="font-mono text-[0.6875rem] tabular-nums text-muted">
            {selectedReviewGroup.reviewKind === 'api'
              ? `$${num(selectedReviewGroup.apiPriceInPerMTok, 2)} in · $${num(selectedReviewGroup.apiPriceOutPerMTok, 2)} out`
              : selectedReviewGroup.pricePerMonth <= 0
                ? 'Free'
                : `$${num(selectedReviewGroup.pricePerMonth, 0)}/mo`}
          </span>
        ) : undefined
      }
    >
      <div className="mb-3 flex flex-wrap gap-1">
        {reviewGroups.map((group) => (
          <button
            key={group.reviewId}
            type="button"
            onClick={() => onSelect(group.reviewId)}
            className={`min-h-11 rounded-md px-2.5 py-1 text-[0.75rem] transition sm:min-h-0 ${
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
          className="mb-2 truncate text-[0.6875rem] text-muted"
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
}: {
  columns: readonly NamedEffortColumn[]
}) {
  return (
    <>
      <th className="px-1 py-2 text-center" title="Instant capability">
        Instant
      </th>
      <th
        className="px-1 py-2 text-center"
        title="Instant serve cost from campus compute"
      >
        Instant $
      </th>
      {columns.flatMap((column) => [
        <th
          key={column.key}
          className="px-1 py-2 text-center"
          title={`${column.name} capability`}
        >
          {column.name}
        </th>,
        <th
          key={`${column.key}-usd`}
          className="px-1 py-2 text-center"
          title={`${column.name} $/MTok from raw serve compute`}
        >
          {column.name} $
        </th>,
      ])}
    </>
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
  return (
    <td
      className="px-1 py-1.5 text-center font-mono tabular-nums text-muted"
      title={board ? `${board.tokenMult.toFixed(1)}× tokens` : 'Not trained'}
    >
      {board?.usdPerMTok != null ? money(board.usdPerMTok) : '—'}
    </td>
  )
}
