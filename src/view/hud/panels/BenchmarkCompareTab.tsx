import { useMemo, useState } from 'react'
import type { BenchmarkSuiteId } from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'
import {
  EVALUATION_MARKETS,
  type BenchmarkMetricDef,
  type EvaluationMarket,
} from '../../../sim/balance/evaluationSuites'
import type { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { num } from '../format'
import { GameCard, StatRow } from '../ui/kit'
import { EmptyState } from '../ui/HudPrimitives'
import { LineChart, type LineChartSeries } from '../ui/LineChart'
import { RadarChart } from '../ui/RadarChart'

type LeaderboardRow = ReturnType<typeof collectLeaderboardModels>[number]

/** Rival series tones (player is always mint). Theme tokens only. */
const RIVAL_COLORS = [
  'var(--color-infer)',
  'var(--color-research)',
  'var(--color-amber)',
  'var(--color-muted)',
  'var(--color-line)',
]

/** Pin slot text tones — slot 1 = radar primary (mint), slot 2 = radar comparison (muted). */
const PIN_TONES = ['text-mint', 'text-muted', 'text-infer'] as const
const MAX_PINS = PIN_TONES.length

const keyFor = (row: LeaderboardRow) => `${row.labId}:${row.model.id}`

/**
 * "Compare" tab for the Benchmarks panel: frontier progress chart per lab
 * plus a 2-3 model head-to-head (radar + exact suite scores).
 */
export function BenchmarkCompareTab({
  rows,
  suiteId,
  metrics,
  market,
  onMarketChange,
}: {
  rows: LeaderboardRow[]
  suiteId: BenchmarkSuiteId
  metrics: readonly BenchmarkMetricDef[]
  market: EvaluationMarket
  onMarketChange: (market: EvaluationMarket) => void
}) {
  const [hiddenLabIds, setHiddenLabIds] = useState<string[]>([])
  const [pinned, setPinned] = useState<string[]>([])

  /* ── Frontier series: one per lab ─────────────────────────────── */
  const labs = useMemo(() => {
    const byLab = new Map<string, { id: string; name: string; rows: LeaderboardRow[] }>()
    for (const row of rows) {
      const entry = byLab.get(row.labId) ?? { id: row.labId, name: row.labName, rows: [] }
      entry.rows.push(row)
      byLab.set(row.labId, entry)
    }
    const ordered = [...byLab.values()].sort((a, b) =>
      a.id === 'player' ? -1 : b.id === 'player' ? 1 : a.name.localeCompare(b.name),
    )
    let rivalIndex = 0
    return ordered.map((lab) => ({
      ...lab,
      color:
        lab.id === 'player'
          ? 'var(--color-mint)'
          : RIVAL_COLORS[rivalIndex++ % RIVAL_COLORS.length],
    }))
  }, [rows])

  const series: LineChartSeries[] = useMemo(
    () =>
      labs.map((lab) => ({
        id: lab.id,
        label: lab.name,
        color: lab.color,
        points: lab.rows.map((row) => ({ x: row.model.releaseDay, y: row.model.capability })),
      })),
    [labs],
  )
  const rowsByLab = useMemo(() => new Map(labs.map((lab) => [lab.id, lab.rows])), [labs])

  /* ── Head-to-head pinning ─────────────────────────────────────── */
  const rowByKey = useMemo(() => new Map(rows.map((row) => [keyFor(row), row])), [rows])
  const pinnedRows = useMemo(
    () =>
      pinned
        .map((key) => rowByKey.get(key))
        .filter((row): row is LeaderboardRow => row !== undefined),
    [pinned, rowByKey],
  )
  const pinPool = useMemo(() => {
    const top = rows.slice(0, 10)
    const extras = pinnedRows.filter(
      (row) => !top.some((candidate) => keyFor(candidate) === keyFor(row)),
    )
    return [...top, ...extras]
  }, [rows, pinnedRows])

  const togglePin = (key: string) =>
    setPinned((current) =>
      current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : current.length >= MAX_PINS
          ? current
          : [...current, key],
    )

  const changeMarket = (candidate: EvaluationMarket) => {
    setPinned([])
    onMarketChange(candidate)
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to compare"
        description="No released models or published evals yet — train and release a checkpoint, or wait for rivals."
      />
    )
  }

  return (
    <>
      <div className="flex flex-wrap gap-1" aria-label="Evaluation market">
        {EVALUATION_MARKETS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => changeMarket(candidate.id)}
            className={`min-h-11 rounded-md px-2.5 py-1 text-[0.75rem] transition sm:min-h-0 ${
              market === candidate.id ? 'bg-mint text-void' : 'bg-panel-2 text-muted hover:text-bone'
            }`}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      <GameCard eyebrow="Frontier" title="Capability over time" tone="mint">
        <div className="mb-2 flex flex-wrap gap-1" aria-label="Toggle labs">
          {labs.map((lab) => {
            const hidden = hiddenLabIds.includes(lab.id)
            return (
              <button
                key={lab.id}
                type="button"
                aria-pressed={!hidden}
                title={hidden ? `Show ${lab.name}` : `Hide ${lab.name}`}
                onClick={() =>
                  setHiddenLabIds((current) =>
                    hidden
                      ? current.filter((id) => id !== lab.id)
                      : [...current, lab.id],
                  )
                }
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition sm:min-h-0 ${
                  hidden
                    ? 'border-line/50 bg-void/30 text-muted/60'
                    : 'border-line/70 bg-panel-2 text-bone hover:border-line'
                }`}
              >
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: hidden ? 'transparent' : lab.color,
                    boxShadow: hidden ? `inset 0 0 0 1.5px ${lab.color}` : undefined,
                  }}
                />
                <span className="max-w-[8rem] truncate">{lab.name}</span>
                <span className="font-mono text-[0.625rem] tabular-nums text-muted">
                  {lab.rows.length}
                </span>
              </button>
            )
          })}
        </div>
        <div className="rounded-lg border border-line/70 bg-void/40 p-2">
          <LineChart
            series={series}
            hiddenIds={hiddenLabIds}
            height={220}
            xLabel="Release day"
            yLabel="Cap"
            formatX={(value) => `D${Math.round(value)}`}
            ariaLabel="Frontier progress: capability by release day"
            renderTooltip={(hover) => {
              const row = rowsByLab.get(hover.series.id)?.[hover.pointIndex]
              if (!row) return null
              return (
                <span className="block max-w-[11rem]">
                  <span className="block truncate font-sans font-medium text-bone">
                    {row.model.name}
                  </span>
                  <span className="block truncate font-sans text-muted">{row.labName}</span>
                  <span className="block text-bone">
                    cap {num(row.model.capability, 0)} · {formatParams(row.model.paramsB)} · D
                    {row.model.releaseDay}
                  </span>
                </span>
              )
            }}
          />
        </div>
      </GameCard>

      <GameCard eyebrow="Head to head" title="Suite face-off" tone="mint">
        <div className="mb-3 flex flex-wrap gap-1" aria-label="Pin models to compare">
          {pinPool.map((row) => {
            const key = keyFor(row)
            const slot = pinned.indexOf(key)
            const isPinned = slot >= 0
            const full = !isPinned && pinned.length >= MAX_PINS
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isPinned}
                disabled={full}
                title={
                  full
                    ? `Lineup full — unpin a model first (max ${MAX_PINS})`
                    : isPinned
                      ? `Unpin ${row.model.name}`
                      : `Pin ${row.model.name} for comparison`
                }
                onClick={() => togglePin(key)}
                className={`inline-flex min-h-11 max-w-[12rem] items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition sm:min-h-0 ${
                  isPinned
                    ? 'border-mint/60 bg-mint/10 text-bone'
                    : 'border-line/70 bg-panel-2 text-muted hover:text-bone disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted'
                }`}
              >
                {isPinned ? (
                  <span className={`font-mono text-[0.625rem] tabular-nums ${PIN_TONES[slot]}`}>
                    {slot + 1}
                  </span>
                ) : (
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `#${row.color.toString(16).padStart(6, '0')}` }}
                  />
                )}
                <span className="min-w-0 truncate">{row.model.name}</span>
                <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted">
                  {num(row.model.capability, 0)}
                </span>
              </button>
            )
          })}
        </div>

        {pinnedRows.length >= 2 ? (
          <>
            <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
              {pinnedRows.map((row, slot) => (
                <span
                  key={keyFor(row)}
                  className={`inline-flex min-w-0 max-w-[14rem] items-baseline gap-1 text-[0.6875rem] ${PIN_TONES[slot]}`}
                >
                  <span className="shrink-0 font-mono tabular-nums">{slot + 1}</span>
                  <span className="min-w-0 truncate">{row.model.name}</span>
                  <span className="shrink-0 text-muted">· {row.labName}</span>
                </span>
              ))}
            </div>
            <RadarChart
              suiteId={suiteId}
              scores={pinnedRows[0]!.model.benchmarkSuites?.[suiteId] ?? {}}
              comparison={pinnedRows[1]!.model.benchmarkSuites?.[suiteId] ?? {}}
              comparisonLabel={pinnedRows[1]!.model.name}
            />
            <div className="mt-3 border-t border-line/60 pt-2">
              <StatRow
                label="Capability"
                value={<PinnedValues rows={pinnedRows} read={(row) => num(row.model.capability, 0)} />}
                strong
              />
              <StatRow
                label="Parameters"
                value={<PinnedValues rows={pinnedRows} read={(row) => formatParams(row.model.paramsB)} />}
              />
              {metrics.map((metric) => (
                <StatRow
                  key={metric.id}
                  label={metric.short}
                  hint={metric.label}
                  value={
                    <PinnedValues
                      rows={pinnedRows}
                      read={(row) => {
                        const score = row.model.benchmarkSuites?.[suiteId]?.[metric.id] ?? 0
                        return score > 0 ? score.toFixed(0) : '—'
                      }}
                    />
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            title="Pin two models"
            description={`Pick ${pinnedRows.length === 1 ? 'one more' : 'two or three'} models from the chips above to compare exact suite scores.`}
          />
        )}
      </GameCard>
    </>
  )
}

/** Per-pin values in slot tones — column colors match the pin legend above the table. */
function PinnedValues({
  rows,
  read,
}: {
  rows: LeaderboardRow[]
  read: (row: LeaderboardRow) => string
}) {
  return (
    <span className="inline-flex gap-2.5">
      {rows.map((row, slot) => (
        <span key={keyFor(row)} className={PIN_TONES[slot]} title={row.model.name}>
          {read(row)}
        </span>
      ))}
    </span>
  )
}
