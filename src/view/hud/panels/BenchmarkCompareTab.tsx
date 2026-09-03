import { useMemo, useState } from 'react'
import type { EffortRecipe, Model } from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'
import {
  THINKING_TOKEN_MAX,
  THINKING_TOKEN_MIN,
  effortViewForRecipe,
  migrateEffortRecipes,
} from '../../../sim/balance/modelProduct'
import type { LeaderboardRow } from '../../../sim/training/leaderboard'
import type { EvalMetric } from '../../../sim/training/types'
import { num } from '../format'
import { GameCard, StatRow } from '../ui/kit'
import { EmptyState, StatusChip } from '../ui/HudPrimitives'

/** Rival series tones (player is always mint). Theme tokens only. */
const RIVAL_COLORS = [
  'var(--color-infer)',
  'var(--color-research)',
  'var(--color-amber)',
  'var(--color-muted)',
  'var(--color-line)',
]

const PIN_TONES = ['text-mint', 'text-muted'] as const
const MAX_PINS = PIN_TONES.length

export const BENCHMARK_COMPACT_MEDIA =
  '(max-width: 900px), (orientation: landscape) and (max-height: 600px) and (max-width: 1180px)'

const COMPARE_METRICS: readonly { id: EvalMetric; label: string; short: string }[] = [
  { id: 'overall', label: 'Overall', short: 'Ovr' },
  { id: 'language', label: 'Language', short: 'Lang' },
  { id: 'reasoning', label: 'Reasoning', short: 'Rsn' },
  { id: 'code', label: 'Code', short: 'Code' },
  { id: 'math', label: 'Math', short: 'Math' },
  { id: 'science', label: 'Science', short: 'Sci' },
  { id: 'safety', label: 'Safety', short: 'Saf' },
  { id: 'reliability', label: 'Reliability', short: 'Rel' },
]

const keyFor = (row: LeaderboardRow) => `${row.labId}:${row.entryId}`

/** Mirrors the mobile shell's portrait and short-landscape breakpoint. */
export function isCompactBenchmarkViewport(
  width: number,
  height: number,
): boolean {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) return false
  return width <= 900 || (width <= 1180 && height <= 600 && width > height)
}

export interface FrontierThinking {
  instantCapability: number
  /** Best trained-thinking capability, else Instant. */
  peakCapability: number
  /** Trained thinking budget, or null when the release has none. */
  thinkingTokenMult: number | null
  recipeName: string | null
}

function isTrainedThinking(recipe: EffortRecipe): boolean {
  return recipe.kind === 'trained' && recipe.trained && recipe.thinkingTokenMult > 1
}

/** Peak trained thinking on a public release. Instant-only is an honest empty. */
export function frontierThinkingFor(
  model: Pick<Model, 'capability' | 'benchmarks' | 'productProfile'>,
): FrontierThinking {
  const instantCapability = model.capability
  let best: { recipe: EffortRecipe; capability: number } | null = null
  for (const recipe of migrateEffortRecipes(model.productProfile)) {
    if (!isTrainedThinking(recipe)) continue
    const view = effortViewForRecipe(model, recipe.id)
    const capability = view?.capability ?? model.capability
    const betterCap = best == null || capability > best.capability
    const sameCapHeavier =
      best != null &&
      capability === best.capability &&
      recipe.thinkingTokenMult > best.recipe.thinkingTokenMult
    if (betterCap || sameCapHeavier) best = { recipe, capability }
  }
  return {
    instantCapability,
    peakCapability: best?.capability ?? instantCapability,
    thinkingTokenMult: best?.recipe.thinkingTokenMult ?? null,
    recipeName: best?.recipe.name ?? null,
  }
}

/** Instant / missing thinking stays small; 1.4–8× maps onto the remaining radius. */
export function thinkingPointRadius(thinkingTokenMult: number | null): number {
  if (thinkingTokenMult == null || thinkingTokenMult <= 1) return 3.25
  const span = THINKING_TOKEN_MAX - THINKING_TOKEN_MIN
  const t = (thinkingTokenMult - THINKING_TOKEN_MIN) / Math.max(1e-9, span)
  return Math.round((4.5 + Math.max(0, Math.min(1, t)) * 3.5) * 100) / 100
}

export function formatFrontierThinking(thinking: FrontierThinking): string {
  if (thinking.thinkingTokenMult == null) return 'think —'
  const name = thinking.recipeName?.trim()
  return name
    ? `think ${thinking.thinkingTokenMult.toFixed(1)}× ${name}`
    : `think ${thinking.thinkingTokenMult.toFixed(1)}×`
}

export function formatFrontierReadout(
  row: { model: Pick<Model, 'paramsB' | 'releaseDay'> },
  thinking: FrontierThinking,
): string {
  const cap =
    thinking.thinkingTokenMult != null && thinking.peakCapability > thinking.instantCapability + 0.05
      ? `cap ${num(thinking.instantCapability, 0)} → ${num(thinking.peakCapability, 0)}`
      : `cap ${num(thinking.instantCapability, 0)}`
  return `${cap} · ${formatFrontierThinking(thinking)} · ${formatParams(row.model.paramsB)} · D${row.model.releaseDay}`
}

function bestScore(
  rows: readonly LeaderboardRow[],
  metric: EvalMetric,
  predicate: (row: LeaderboardRow) => boolean,
): number | null {
  let best: number | null = null
  for (const row of rows) {
    if (!predicate(row)) continue
    const score = row.scores[metric]
    if (score == null) continue
    if (best == null || score > best) best = score
  }
  return best
}

function formatScore(value: number | null): string {
  return value == null ? '—' : num(value, 1)
}

/**
 * Compare tab: public player scores vs the frontier, plus a two-row pin.
 * All numbers come from leaderboard rows (no hidden capability).
 */
export function BenchmarkCompareTab({
  rows,
}: {
  rows: LeaderboardRow[]
}) {
  const [pinned, setPinned] = useState<string[]>([])

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

  const labColor = useMemo(() => {
    const map = new Map<string, string>()
    let rivalIndex = 0
    for (const row of rows) {
      if (map.has(row.labId)) continue
      map.set(
        row.labId,
        row.isPlayer
          ? 'var(--color-mint)'
          : RIVAL_COLORS[rivalIndex++ % RIVAL_COLORS.length]!,
      )
    }
    return map
  }, [rows])

  const togglePin = (key: string) =>
    setPinned((current) =>
      current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : current.length >= MAX_PINS
          ? current
          : [...current, key],
    )

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to compare"
        description="No live endpoints or published evals yet — train and release a checkpoint, or wait for rivals."
      />
    )
  }

  return (
    <div data-benchmark-compare>
      <GameCard
        eyebrow="Frontier"
        title="You vs the public board"
        tone="mint"
        mobileSummary="Public scores only. Hidden capability never appears here."
      >
        <div
          role="region"
          aria-label="Player versus frontier by metric"
          tabIndex={0}
          data-swipe-ignore="true"
          className="touch-pan-x touch-pan-y overflow-x-auto overscroll-x-contain rounded-md border border-line/60"
        >
          <table className="w-full min-w-[28rem] border-collapse text-left text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line bg-panel-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                <th className="sticky left-0 bg-panel-2 px-2 py-2">Metric</th>
                <th className="px-2 py-2 text-right">You</th>
                <th className="px-2 py-2 text-right">Frontier</th>
                <th className="px-2 py-2 text-right">Delta</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_METRICS.map((metric) => {
                const player = bestScore(rows, metric.id, (row) => row.isPlayer)
                const frontier = bestScore(rows, metric.id, () => true)
                const delta =
                  player != null && frontier != null ? player - frontier : null
                return (
                  <tr
                    key={metric.id}
                    data-compare-metric={metric.id}
                    className="border-b border-line/50"
                  >
                    <td className="sticky left-0 bg-panel px-2 py-1.5 text-bone">{metric.label}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-mint">
                      {formatScore(player)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">
                      {formatScore(frontier)}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right font-mono tabular-nums ${
                        delta == null
                          ? 'text-muted'
                          : delta >= 0
                            ? 'text-mint'
                            : 'text-danger'
                      }`}
                    >
                      {delta == null
                        ? '—'
                        : `${delta >= 0 ? '+' : ''}${num(delta, 1)}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </GameCard>

      <GameCard
        eyebrow="Head-to-head"
        title="Pin two public rows"
        mobileSummary="Pick two live endpoints, then inspect exact scores."
      >
        <div
          className="mb-3 flex touch-pan-x touch-pan-y snap-x snap-proximity gap-1 overflow-x-auto overscroll-x-contain pb-1 min-[1181px]:flex-wrap min-[1181px]:overflow-visible min-[1181px]:pb-0"
          role="group"
          aria-label="Pin models to compare"
          data-swipe-ignore="true"
        >
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
                    ? `Lineup full — unpin a row first (max ${MAX_PINS})`
                    : isPinned
                      ? `Unpin ${row.name}`
                      : `Pin ${row.name} for comparison`
                }
                onClick={() => togglePin(key)}
                className={`inline-flex min-h-11 max-w-[12rem] shrink-0 snap-start items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition min-[1181px]:min-h-0 ${
                  isPinned
                    ? 'border-mint/60 bg-mint/10 text-bone'
                    : 'border-line/70 bg-panel-2 text-muted hover:text-bone disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted'
                }`}
              >
                {isPinned ? (
                  <span className={`font-mono text-[0.625rem] tabular-nums ${PIN_TONES[slot] ?? 'text-mint'}`}>
                    {slot + 1}
                  </span>
                ) : (
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: labColor.get(row.labId) }}
                  />
                )}
                <span className="min-w-0 truncate">{row.name}</span>
                <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted">
                  {num(row.overall, 0)}
                </span>
              </button>
            )
          })}
        </div>

        {pinnedRows.length >= 2 ? (
          <div className="space-y-1">
            {COMPARE_METRICS.map((metric) => (
              <StatRow
                key={metric.id}
                label={metric.label}
                value={
                  <span className="inline-flex gap-3 font-mono tabular-nums">
                    {pinnedRows.map((row, slot) => (
                      <span key={keyFor(row)} className={PIN_TONES[slot] ?? 'text-muted'}>
                        {formatScore(row.scores[metric.id] ?? null)}
                      </span>
                    ))}
                  </span>
                }
                strong={metric.id === 'overall'}
              />
            ))}
          </div>
        ) : (
          <p className="text-[0.75rem] text-muted">Pin two public rows to inspect exact scores.</p>
        )}

        {rows.some((row) => row.contaminated.length > 0) ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {rows.flatMap((row) =>
              row.contaminated.map((metric) => (
                <StatusChip
                  key={`${keyFor(row)}:${metric}`}
                  tone="warning"
                  title={`${row.name} flagged on ${metric}`}
                >
                  {row.name} · {metric}
                </StatusChip>
              )),
            )}
          </div>
        ) : null}
      </GameCard>
    </div>
  )
}
