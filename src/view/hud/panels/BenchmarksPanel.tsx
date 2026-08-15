import { useMemo, useState } from 'react'
import type { BenchmarkMetricId } from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'
import {
  EVALUATION_MARKETS,
  SUITE_METRICS,
  evaluationMarketsForModel,
  suiteForEvaluationMarket,
  type EvaluationMarket,
} from '../../../sim/balance/evaluationSuites'
import { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { useGameStore } from '../../../store/gameStore'
import { num } from '../format'
import {
  buildAudienceReviewGroups,
  type PlanAudienceReview,
} from './planReviews'
import { BenchmarkCompareTab } from './BenchmarkCompareTab'
import { GameCard, MeterBar, SegmentedTabs, StatRow } from '../ui/kit'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'

const PAGE = 15

type BenchTab = 'leaderboard' | 'compare' | 'reviews'

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
          const sa = a.model.benchmarkSuites?.[suite]?.[sortId] ?? 0
          const sb = b.model.benchmarkSuites?.[suite]?.[sortId] ?? 0
          return sb - sa
        })
  }, [state, sortId, market])

  const suiteId = suiteForEvaluationMarket(market)
  const metrics = SUITE_METRICS[suiteId]

  const visible = showAll ? rows : rows.slice(0, PAGE)
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
        const s = r.model.benchmarkSuites?.[suiteId]?.[d.id] ?? 0
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
        (d) => r.model.benchmarkSuites?.[suiteId]?.[d.id] ?? 0,
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
      description="Seasons, audits & field reviews."
      actions={
        activeSeason ? (
          <StatusChip tone="research">{activeSeason.name}</StatusChip>
        ) : undefined
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
            <div
              className="flex flex-wrap gap-1"
              aria-label="Evaluation market"
            >
              {EVALUATION_MARKETS.map((candidate) => (
                <SortChip
                  key={candidate.id}
                  active={market === candidate.id}
                  onClick={() => {
                    setMarket(candidate.id)
                    setSortId('cap')
                    setShowAll(false)
                  }}
                  label={candidate.label}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              <SortChip
                active={sortId === 'cap'}
                onClick={() => setSortId('cap')}
                label="Capability"
              />
              {metrics.map((d) => (
                <SortChip
                  key={d.id}
                  active={sortId === d.id}
                  onClick={() => setSortId(d.id)}
                  label={d.short}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
              <StatusChip tone="positive">PUBLIC</StatusChip>
              <span>
                Public releases only. Private checkpoint evidence stays in
                Models.
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
                        {metrics.map((d) => {
                          const s =
                            r.model.benchmarkSuites?.[suiteId]?.[d.id] ?? 0
                          const isLead =
                            s >= (leaders[d.id] ?? 0) - 0.05 && s > 1
                          return (
                            <td
                              key={d.id}
                              className={`px-1 py-1.5 text-center font-mono tabular-nums ${
                                isLead ? 'text-mint' : 'text-muted'
                              }`}
                            >
                              {s > 0 ? s.toFixed(0) : '—'}
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

function SortChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-11 rounded-md px-2.5 py-1 text-[0.75rem] transition sm:min-h-0 ${
        active ? 'bg-mint text-void' : 'bg-panel-2 text-muted hover:text-bone'
      }`}
    >
      {label}
    </button>
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
