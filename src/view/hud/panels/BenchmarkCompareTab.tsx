import { useEffect, useMemo, useState } from 'react'
import type { BenchmarkSuiteId, EffortRecipe, Model } from '../../../sim/types'
import { formatParams } from '../../../sim/balance/training'
import {
  EVALUATION_MARKETS,
  type BenchmarkMetricDef,
  type EvaluationMarket,
} from '../../../sim/balance/evaluationSuites'
import {
  THINKING_TOKEN_MAX,
  THINKING_TOKEN_MIN,
  effortViewForRecipe,
  migrateEffortRecipes,
} from '../../../sim/balance/modelProduct'
import type { collectLeaderboardModels } from '../../../sim/systems/rivals'
import { num } from '../format'
import {
  publicBenchmarkScore,
  publicBenchmarkScores,
} from '../data/benchmarkViewModel'
import { GameCard, StatRow } from '../ui/kit'
import { HudFilterBar } from '../ui/HudFilterBar'
import { EmptyState } from '../ui/HudPrimitives'
import { LineChart, type LineChartHover, type LineChartSeries } from '../ui/LineChart'
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
export const BENCHMARK_COMPACT_MEDIA =
  '(max-width: 900px), (orientation: landscape) and (max-height: 600px) and (max-width: 1180px)'

const keyFor = (row: LeaderboardRow) => `${row.labId}:${row.model.id}`

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
  row: LeaderboardRow,
  thinking: FrontierThinking,
): string {
  const cap =
    thinking.thinkingTokenMult != null && thinking.peakCapability > thinking.instantCapability + 0.05
      ? `cap ${num(thinking.instantCapability, 0)} → ${num(thinking.peakCapability, 0)}`
      : `cap ${num(thinking.instantCapability, 0)}`
  return `${cap} · ${formatFrontierThinking(thinking)} · ${formatParams(row.model.paramsB)} · D${row.model.releaseDay}`
}

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
  const [pinnedPoint, setPinnedPoint] = useState<LineChartHover | null>(null)
  const [compactViewport, setCompactViewport] = useState(false)

  useEffect(() => {
    const media = window.matchMedia(BENCHMARK_COMPACT_MEDIA)
    const sync = () => setCompactViewport(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  /* ── Frontier series: one per lab ─────────────────────────────── */
  const labs = useMemo(() => {
    const byLab = new Map<string, { id: string; name: string; rows: LeaderboardRow[] }>()
    for (const row of rows) {
      const entry = byLab.get(row.labId) ?? { id: row.labId, name: row.labName, rows: [] }
      entry.rows.push(row)
      byLab.set(row.labId, entry)
    }
    for (const lab of byLab.values()) {
      lab.rows.sort(
        (a, b) =>
          a.model.releaseDay - b.model.releaseDay || a.model.capability - b.model.capability,
      )
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
        points: lab.rows.map((row) => {
          const thinking = frontierThinkingFor(row.model)
          return {
            x: row.model.releaseDay,
            y: thinking.peakCapability,
            r: thinkingPointRadius(thinking.thinkingTokenMult),
            detail: formatFrontierThinking(thinking),
            id: `${row.labId}:${row.model.id}`,
          }
        }),
      })),
    [labs],
  )
  const rowsByLab = useMemo(() => new Map(labs.map((lab) => [lab.id, lab.rows])), [labs])
  const pinnedRow = pinnedPoint
    ? rowsByLab.get(pinnedPoint.series.id)?.[pinnedPoint.pointIndex]
    : undefined

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
    setPinnedPoint(null)
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
      <HudFilterBar
        ariaLabel="Benchmark comparison filters"
        activeCount={market === 'language' ? 0 : 1}
        onClear={() => changeMarket('language')}
        groups={[
          {
            id: 'market',
            label: 'Market',
            description: 'Public evaluation suite',
            options: EVALUATION_MARKETS.map((candidate) => ({
              id: candidate.id,
              label: candidate.label,
              active: market === candidate.id,
              onSelect: () => changeMarket(candidate.id),
            })),
          },
        ]}
      />

      <GameCard
        eyebrow="Frontier"
        title="Cap + thinking over time"
        tone="mint"
        mobileSummary="Tap a point to pin its model."
      >
        <div
          className="mb-2 flex touch-pan-x touch-pan-y snap-x snap-proximity items-center gap-1 overflow-x-auto overscroll-x-contain pb-1 min-[1181px]:flex-wrap min-[1181px]:overflow-visible min-[1181px]:pb-0"
          role="group"
          aria-label="Toggle labs"
          data-swipe-ignore="true"
        >
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
                className={`inline-flex min-h-11 shrink-0 snap-start items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition min-[1181px]:min-h-0 ${
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
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[0.625rem] tabular-nums text-muted"
            title="Point size is thinking budget. Instant-only releases stay small."
          >
            <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden className="text-muted">
              <circle cx="4" cy="5" r="2.25" fill="currentColor" />
              <circle cx="16" cy="5" r="4.25" fill="currentColor" />
            </svg>
            size = think ×
          </span>
        </div>
        <div className="rounded-lg border border-line/70 bg-void/40 p-1.5 sm:p-2">
          <LineChart
            series={series}
            hiddenIds={hiddenLabIds}
            height={compactViewport ? 170 : 220}
            xLabel="Release day"
            yLabel="Cap"
            formatX={(value) => `D${Math.round(value)}`}
            ariaLabel="Frontier progress: capability and thinking by release day"
            onPinChange={setPinnedPoint}
            renderTooltip={(hover) => {
              const row = rowsByLab.get(hover.series.id)?.[hover.pointIndex]
              if (!row) return null
              const thinking = frontierThinkingFor(row.model)
              const cap =
                thinking.thinkingTokenMult != null &&
                thinking.peakCapability > thinking.instantCapability + 0.05
                  ? `cap ${num(thinking.instantCapability, 0)} → ${num(thinking.peakCapability, 0)}`
                  : `cap ${num(thinking.instantCapability, 0)}`
              return (
                <span className="block max-w-[12rem]">
                  <span className="block truncate font-sans font-medium text-bone">
                    {row.model.name}
                  </span>
                  <span className="block truncate font-sans text-muted">{row.labName}</span>
                  <span className="block text-bone">{cap}</span>
                  <span className="block text-bone">{formatFrontierThinking(thinking)}</span>
                  <span className="block text-muted">
                    {formatParams(row.model.paramsB)} · D{row.model.releaseDay}
                  </span>
                </span>
              )
            }}
          />
        </div>
        <p
          aria-live="polite"
          data-benchmark-pinned-point
          className="mt-1.5 min-h-5 text-[0.6875rem] leading-snug text-muted"
        >
          {pinnedPoint && pinnedRow
            ? `Pinned ${pinnedRow.model.name} · ${pinnedRow.labName} · ${formatFrontierReadout(pinnedRow, frontierThinkingFor(pinnedRow.model))}`
            : 'Point size is thinking budget (— if none). Hover or select a point; click or tap to pin.'}
        </p>
      </GameCard>

      <GameCard
        eyebrow="Head to head"
        title="Suite face-off"
        tone="mint"
        mobileSummary="Pick two models, then inspect exact scores."
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
                    ? `Lineup full — unpin a model first (max ${MAX_PINS})`
                    : isPinned
                      ? `Unpin ${row.model.name}`
                      : `Pin ${row.model.name} for comparison`
                }
                onClick={() => togglePin(key)}
                className={`inline-flex min-h-11 max-w-[12rem] shrink-0 snap-start items-center gap-1.5 rounded-md border px-2 py-1 text-[0.75rem] transition min-[1181px]:min-h-0 ${
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
            <div
              className="mb-2 flex touch-pan-x touch-pan-y gap-x-3 overflow-x-auto overscroll-x-contain pb-1 min-[1181px]:flex-wrap min-[1181px]:overflow-visible min-[1181px]:pb-0"
              data-swipe-ignore="true"
            >
              {pinnedRows.map((row, slot) => (
                <span
                  key={keyFor(row)}
                  className={`inline-flex min-w-0 max-w-[14rem] shrink-0 items-baseline gap-1 text-[0.6875rem] ${PIN_TONES[slot]}`}
                >
                  <span className="shrink-0 font-mono tabular-nums">{slot + 1}</span>
                  <span className="min-w-0 truncate">{row.model.name}</span>
                  <span className="shrink-0 text-muted">· {row.labName}</span>
                </span>
              ))}
            </div>
            <RadarChart
              suiteId={suiteId}
              scores={publicBenchmarkScores(pinnedRows[0]!.model, suiteId)}
              comparison={publicBenchmarkScores(pinnedRows[1]!.model, suiteId)}
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
              <details
                data-mobile-compare-scores
                className="hud-mobile-summary mt-1 rounded-md border border-line/55 bg-void/25"
              >
                <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-[0.75rem] text-bone focus-visible:outline focus-visible:outline-1 focus-visible:outline-mint">
                  <span>Exact suite scores</span>
                  <span className="font-mono text-[0.625rem] text-muted">{metrics.length} axes</span>
                </summary>
                <div className="border-t border-line/50 px-2 py-1">
                  <PinnedMetricRows
                    rows={pinnedRows}
                    metrics={metrics}
                    suiteId={suiteId}
                  />
                </div>
              </details>
              <div className="hud-mobile-detail">
                <PinnedMetricRows
                  rows={pinnedRows}
                  metrics={metrics}
                  suiteId={suiteId}
                />
              </div>
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
    <span className="inline-flex flex-wrap justify-end gap-x-2.5 gap-y-0.5">
      {rows.map((row, slot) => (
        <span key={keyFor(row)} className={PIN_TONES[slot]} title={row.model.name}>
          {read(row)}
        </span>
      ))}
    </span>
  )
}

function PinnedMetricRows({
  rows,
  metrics,
  suiteId,
}: {
  rows: LeaderboardRow[]
  metrics: readonly BenchmarkMetricDef[]
  suiteId: BenchmarkSuiteId
}) {
  return (
    <>
      {metrics.map((metric) => (
        <StatRow
          key={metric.id}
          label={metric.short}
          hint={metric.label}
          value={
            <PinnedValues
              rows={rows}
              read={(row) => {
                const score = publicBenchmarkScore(row.model, suiteId, metric.id) ?? 0
                return score > 0 ? score.toFixed(0) : '—'
              }}
            />
          }
        />
      ))}
    </>
  )
}
