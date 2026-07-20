import { useMemo, useState } from 'react'
import { BENCHMARK_DEFS } from '../../../sim/balance/benchmarks'
import { formatParams } from '../../../sim/balance/training'
import { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { isGenerationOnlyModel } from '../../../sim/systems/modelEligibility'
import { useGameStore } from '../../../store/gameStore'
import { num } from '../format'
import { buildAudienceReviewGroups, type PlanAudienceReview } from './planReviews'

const PAGE = 15

/**
 * Cross-lab eval leaderboard — top 15 by default, load older/weaker models on demand.
 */
export function BenchmarksPanel() {
  const state = useGameStore((s) => s.state)
  const [showAll, setShowAll] = useState(false)
  const [sortId, setSortId] = useState<'cap' | string>('cap')
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null)

  const rows = useMemo(() => {
    const all = collectLeaderboardModels(state)
    const generalModels = all.filter((row) => !isGenerationOnlyModel(row.model))
    return sortId === 'cap' ? generalModels : [...generalModels].sort((a, b) => {
      const sa = a.model.benchmarks[sortId as keyof typeof a.model.benchmarks] ?? 0
      const sb = b.model.benchmarks[sortId as keyof typeof b.model.benchmarks] ?? 0
      return sb - sa
    })
  }, [state, sortId])

  const visible = showAll ? rows : rows.slice(0, PAGE)
  const hidden = Math.max(0, rows.length - PAGE)
  const reviewGroups = useMemo(() => buildAudienceReviewGroups(state), [state])
  const selectedReviewGroup =
    reviewGroups.find((group) => group.reviewId === selectedReviewId) ?? reviewGroups[0]

  // Per-column leaders for highlight
  const leaders = useMemo(() => {
    const map: Record<string, number> = {}
    for (const d of BENCHMARK_DEFS) {
      let best = -1
      for (const r of rows) {
        const s = r.model.benchmarks[d.id] ?? 0
        if (s > best) best = s
      }
      map[d.id] = best
    }
    return map
  }, [rows])

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-[0.875rem] font-semibold text-bone">Reviews</h2>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Every audience scores the selected plan or model API by what it actually cares about.</p>
          </div>
          {selectedReviewGroup && (
            <div className="text-right font-mono text-[0.6875rem] text-muted">
              <div className="text-bone">
                {selectedReviewGroup.reviewKind === 'api'
                  ? `$${num(selectedReviewGroup.apiPriceInPerMTok, 2)} in · $${num(selectedReviewGroup.apiPriceOutPerMTok, 2)} out / MTok`
                  : selectedReviewGroup.pricePerMonth <= 0
                    ? 'Free'
                    : `$${num(selectedReviewGroup.pricePerMonth, 0)}/mo`}
              </div>
              <div className="max-w-[16rem] truncate" title={selectedReviewGroup.modelNames.join(', ')}>
                {selectedReviewGroup.modelNames.join(' + ') || 'No released model'}
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
          {reviewGroups.map((group) => (
            <button
              key={group.reviewId}
              type="button"
              onClick={() => setSelectedReviewId(group.reviewId)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[0.75rem] ${
                selectedReviewGroup?.reviewId === group.reviewId
                  ? 'bg-mint text-void'
                  : 'border border-line bg-void/40 text-muted hover:text-bone'
              }`}
            >
              {group.reviewName}
            </button>
          ))}
        </div>

        {selectedReviewGroup ? (
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {selectedReviewGroup.reviews.map((review) => (
              <AudienceReviewCard key={review.id} review={review} />
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-line p-4 text-center text-[0.75rem] text-muted">
            Enable a subscription plan or release a model API to generate audience reviews.
          </p>
        )}
      </section>

      <div className="flex flex-wrap gap-1">
        <SortChip active={sortId === 'cap'} onClick={() => setSortId('cap')} label="Capability" />
        {BENCHMARK_DEFS.map((d) => (
          <SortChip
            key={d.id}
            active={sortId === d.id}
            onClick={() => setSortId(d.id)}
            label={d.short}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
        <span className="rounded-full bg-mint/15 px-2 py-0.5 text-mint">PUBLIC</span>
        <span className="rounded-full bg-research/20 px-2 py-0.5 text-research">
          PRIVATE · internal estimate
        </span>
        <span>Private checkpoints appear for comparison but earn no customers or revenue.</span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[720px] border-collapse text-left text-[0.75rem]">
          <thead>
            <tr className="border-b border-line bg-panel-2 font-mono text-muted">
              <th className="sticky left-0 z-10 bg-panel-2 px-2 py-2">#</th>
              <th className="sticky left-6 z-10 bg-panel-2 px-2 py-2">Model</th>
              <th className="px-1.5 py-2">Lab</th>
              <th className="px-1.5 py-2">Size</th>
              <th className="px-1.5 py-2">Cap</th>
              {BENCHMARK_DEFS.map((d) => (
                <th key={d.id} className="px-1 py-2 text-center" title={d.name}>
                  {d.short}
                </th>
              ))}
              <th className="px-1.5 py-2">Day</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const rank = i + 1
              const isPrivate = r.model.release === 'internal' && !r.model.shipped
              return (
                <tr
                  key={`${r.labId}-${r.model.id}`}
                  className={`border-b border-line/60 ${
                    isPrivate
                      ? 'bg-research/10'
                      : r.isPlayer
                        ? 'bg-mint/5'
                        : i % 2 === 0
                          ? 'bg-void/30'
                          : ''
                  }`}
                >
                  <td className="sticky left-0 z-10 bg-inherit px-2 py-1.5 font-mono text-muted">
                    {rank}
                  </td>
                  <td className="sticky left-6 z-10 max-w-[180px] bg-inherit px-2 py-1.5 font-medium text-bone">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate">{r.model.name}</span>
                      {isPrivate && (
                        <span
                          className="shrink-0 rounded-full bg-research/20 px-1 text-[0.625rem] uppercase text-research"
                          title="Internal checkpoint — not released to customers"
                        >
                          private
                        </span>
                      )}
                      {r.isPlayer && (
                        <span className="shrink-0 rounded-full bg-mint/20 px-1 text-[0.6875rem] text-mint">
                          you
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-1.5 py-1.5">
                    <span className="inline-flex items-center gap-1 text-muted">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: `#${r.color.toString(16).padStart(6, '0')}` }}
                      />
                      {r.labName}
                    </span>
                  </td>
                  <td className="px-1.5 py-1.5 font-mono text-muted">
                    {formatParams(r.model.paramsB)}
                  </td>
                  <td className={`px-1.5 py-1.5 font-mono ${isPrivate ? 'text-research' : 'text-bone'}`}>
                    {num(r.model.capability, 0)}
                  </td>
                  {BENCHMARK_DEFS.map((d) => {
                    const s = r.model.benchmarks[d.id] ?? 0
                    const isLead = s >= (leaders[d.id] ?? 0) - 0.05 && s > 1
                    return (
                      <td
                        key={d.id}
                        className={`px-1 py-1.5 text-center font-mono ${
                          isPrivate ? 'text-research' : isLead ? 'text-mint' : 'text-muted'
                        }`}
                      >
                        {s > 0 ? s.toFixed(0) : '—'}
                      </td>
                    )
                  })}
                  <td className="px-1.5 py-1.5 font-mono text-muted">{r.model.releaseDay}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="text-xs text-muted">No models yet — train and release, or wait for rivals.</p>
      )}

      {!showAll && hidden > 0 && (
        <button
          type="button"
          className="w-full rounded-xl border border-line bg-panel-2 py-2 text-[0.8125rem] text-mint hover:border-mint/40"
          onClick={() => setShowAll(true)}
        >
          Load {hidden} older / lower-ranked models
        </button>
      )}
      {showAll && rows.length > PAGE && (
        <button
          type="button"
          className="w-full text-[0.8125rem] text-muted hover:text-bone"
          onClick={() => setShowAll(false)}
        >
          Show top {PAGE} only
        </button>
      )}
    </div>
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
      className={`rounded-full px-2.5 py-1 text-[0.75rem] ${
        active ? 'bg-mint text-void' : 'bg-panel-2 text-muted hover:text-bone'
      }`}
    >
      {label}
    </button>
  )
}

function AudienceReviewCard({ review }: { review: PlanAudienceReview }) {
  const tone = review.score >= 70
    ? 'border-mint/30 bg-mint/5 text-mint'
    : review.score >= 50
      ? 'border-amber/30 bg-amber/5 text-amber'
      : 'border-danger/25 bg-danger/5 text-danger'
  return (
    <article className={`rounded-xl border p-2.5 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[0.75rem] font-semibold text-bone">{review.label}</h3>
        <span className="font-mono text-[0.75rem] font-semibold">{review.score.toFixed(0)}</span>
      </div>
      <p className="mt-1 min-h-8 text-[0.6875rem] leading-snug text-muted">{review.summary}</p>
      <div className={`mt-2 grid gap-1 ${review.metrics.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {review.metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 rounded-lg bg-void/45 px-1.5 py-1">
            <div className="flex items-center justify-between gap-1 font-mono text-[0.5625rem] uppercase text-muted">
              <span className="truncate" title={metric.label}>{metric.label}</span>
              <strong className="text-bone">{metric.value.toFixed(0)}</strong>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-void">
              <div
                className="h-full bg-current"
                style={{ width: `${Math.max(2, metric.value)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </article>
  )
}
