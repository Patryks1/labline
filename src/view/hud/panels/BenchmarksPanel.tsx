import { useMemo, useState } from 'react'
import { BENCHMARK_DEFS } from '../../../sim/balance/benchmarks'
import { formatParams } from '../../../sim/balance/training'
import { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { competitiveCatchUpSnapshot } from '../../../sim/systems/sharedMarkets'
import { isGenerationOnlyModel } from '../../../sim/systems/modelEligibility'
import { useGameStore } from '../../../store/gameStore'
import { num } from '../format'

const PAGE = 15

/**
 * Cross-lab eval leaderboard — top 15 by default, load older/weaker models on demand.
 */
export function BenchmarksPanel() {
  const state = useGameStore((s) => s.state)
  const [showAll, setShowAll] = useState(false)
  const [sortId, setSortId] = useState<'cap' | string>('cap')

  const { rows, excludedGenerationModels } = useMemo(() => {
    const all = collectLeaderboardModels(state)
    const generalModels = all.filter((row) => !isGenerationOnlyModel(row.model))
    const sorted = sortId === 'cap' ? generalModels : [...generalModels].sort((a, b) => {
      const sa = a.model.benchmarks[sortId as keyof typeof a.model.benchmarks] ?? 0
      const sb = b.model.benchmarks[sortId as keyof typeof b.model.benchmarks] ?? 0
      return sb - sa
    })
    return {
      rows: sorted,
      excludedGenerationModels: all.length - generalModels.length,
    }
  }, [state, sortId])

  const visible = showAll ? rows : rows.slice(0, PAGE)
  const hidden = Math.max(0, rows.length - PAGE)
  const season = state.benchmarkSeasons.find((item) => item.active) ?? state.benchmarkSeasons.at(-1)
  const pendingEvaluations = state.evaluations
    .filter((evaluation) => !evaluation.published)
    .toSorted((a, b) => a.publishDay - b.publishDay)
  const latestReviews = state.reviews
    .toSorted((a, b) => b.publishedDay - a.publishedDay)
    .slice(0, 6)
  const catchUp = useMemo(() => competitiveCatchUpSnapshot(state), [state])
  const catchUpLab = catchUp.rivalId
    ? state.rivals.find((rival) => rival.id === catchUp.rivalId)?.name
    : null

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
      <div>
        <h2 className="hud-panel-title">Benchmarks</h2>
        <p className="hud-panel-sub">
          Public and internal models across labs. Training outcomes can move individual evals —
          not overnight wipeouts. Sorted by capability by default.
        </p>
        {excludedGenerationModels > 0 && (
          <p className="mt-1 text-[0.6875rem] text-muted">
            {excludedGenerationModels} image/video generation model{excludedGenerationModels === 1 ? '' : 's'} excluded from general reasoning ranks.
          </p>
        )}
        {catchUp.frontierAgeDays > 0 && (
          <p className={`mt-1 text-[0.6875rem] ${catchUp.frontierStale ? 'text-amber' : 'text-muted'}`}>
            Player frontier age {catchUp.frontierAgeDays}d · rival response window{' '}
            {catchUp.frontierStaleAfterDays}d
            {catchUp.frontierStale && catchUpLab ? ` · ${catchUpLab} frontier sprint active` : ''}
          </p>
        )}
      </div>

      <section className="rounded-xl border border-mint/20 bg-mint/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-bone">
              {season?.name ?? 'Benchmark season pending'}
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">
              Internal estimates, public suites, blind audits, and field evidence publish on separate clocks.
            </p>
          </div>
          <span className="shrink-0 font-mono text-[0.6875rem] text-mint">
            v{season?.version ?? 0} · difficulty {((season?.difficulty ?? 0) * 100).toFixed(0)}
          </span>
        </div>
        {pendingEvaluations.length > 0 ? (
          <div className="mt-2 grid grid-cols-2 gap-1">
            {pendingEvaluations.slice(0, 6).map((evaluation) => {
              const model = state.player.models.find((item) => item.id === evaluation.modelId)
              return (
                <div key={evaluation.id} className="rounded border border-line/60 bg-void/40 px-2 py-1 font-mono text-[0.625rem]">
                  <span className="block truncate text-bone">{model?.name ?? evaluation.modelId}</span>
                  <span className="text-muted">{evaluation.kind.replaceAll('_', ' ')} · D{evaluation.publishDay}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-[0.75rem] text-muted">Release a model to enter this season.</p>
        )}
      </section>

      {latestReviews.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">Audience reviews</h3>
          {latestReviews.map((review) => (
            <div key={review.id} className="rounded-lg border border-line bg-panel-2 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.75rem] text-bone">{review.headline}</span>
                <span className="shrink-0 font-mono text-[0.625rem] uppercase text-muted">{review.phase.replace('_', ' ')}</span>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1 font-mono text-[0.625rem] text-muted">
                <Rating label="Cap" value={review.capability} />
                <Rating label="Value" value={review.value} />
                <Rating label="Product" value={review.productQuality} />
                <Rating label="Trust" value={review.trust} />
              </div>
            </div>
          ))}
        </section>
      )}

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

function Rating({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded bg-void/45 px-1.5 py-1">
      {label} <strong className="text-bone">{value.toFixed(0)}</strong>
    </span>
  )
}
