import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  BenchmarkMetricId,
  BenchmarkSuiteId,
  EvaluationProfile,
} from '../../../sim/types'
import { SUITE_METRICS } from '../../../sim/balance/evaluationSuites'
import { polygonPoints, radarGeometry, scaledPoint } from './radarGeometry'
import { consumeChartEscape } from './dataViz/chartInteraction'

export interface RadarComparisonSeries {
  id?: string
  label: string
  scores: Partial<Record<BenchmarkMetricId, number>>
  color?: string
  dashed?: boolean
}

function comparisonSeriesFor(
  comparison: Partial<Record<BenchmarkMetricId, number>> | undefined,
  comparisonLabel: string,
  comparisons: RadarComparisonSeries[] | undefined,
) {
  if (comparisons && comparisons.length > 0) return comparisons
  return comparison ? [{ id: 'comparison', label: comparisonLabel, scores: comparison }] : []
}

export function RadarChart({
  suiteId,
  scores,
  profile,
  comparison,
  comparisonLabel = 'Public frontier',
  comparisons,
  ariaLabel,
  compact = false,
}: {
  suiteId: BenchmarkSuiteId
  scores: Partial<Record<BenchmarkMetricId, number>>
  profile?: EvaluationProfile
  /** Compatibility prop for the original single comparison API. */
  comparison?: Partial<Record<BenchmarkMetricId, number>>
  comparisonLabel?: string
  /** Optional multi-series comparison API; `comparison` remains supported. */
  comparisons?: RadarComparisonSeries[]
  /** Accessible label override for embedded model cards. */
  ariaLabel?: string
  /** Tighten the chart for an inline model-card comparison. */
  compact?: boolean
}) {
  const metrics = SUITE_METRICS[suiteId]
  const readoutId = useId()
  const [hovered, setHovered] = useState<BenchmarkMetricId | null>(null)
  const [pinned, setPinned] = useState<BenchmarkMetricId | null>(null)
  const metricButtons = useRef<Array<SVGGElement | null>>([])
  const active = pinned ?? hovered ?? metrics[0]?.id ?? null
  const comparisonEntries = comparisonSeriesFor(comparison, comparisonLabel, comparisons)
  const geometry = radarGeometry(metrics.length)
  const scorePoints = polygonPoints(metrics.map((metric) => scores[metric.id] ?? 0), geometry.axes)
  const ceilingPoints = polygonPoints(
    metrics.map((metric) => profile?.[metric.id]?.ceiling ?? 96),
    geometry.axes,
  )
  const activeMetric = metrics.find((metric) => metric.id === active)
  const activeScore = active ? scores[active] ?? 0 : 0
  const activeProfile = active ? profile?.[active] : undefined

  const toggleMetric = (metricId: BenchmarkMetricId) => {
    setPinned((current) => (current === metricId ? null : metricId))
  }

  const moveMetricFocus = (event: ReactKeyboardEvent<Element>, index: number) => {
    let nextIndex = index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % metrics.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + metrics.length) % metrics.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = metrics.length - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleMetric(metrics[index]!.id)
      return
    } else if (event.key === 'Escape') {
      consumeChartEscape(event, () => setPinned(null))
      return
    } else return
    event.preventDefault()
    metricButtons.current[nextIndex]?.focus()
    setHovered(metrics[nextIndex]!.id)
  }

  const metricReadout = activeMetric
    ? `${activeMetric.label}: ${activeScore.toFixed(2)}${pinned === activeMetric.id ? ', pinned' : ''}`
    : 'No radar axis selected.'

  return (
    <figure className={compact ? 'rounded-lg border border-line/70 bg-void/35 p-1.5' : 'rounded-xl border border-line/70 bg-void/35 p-2.5'}>
      <div className={compact ? 'grid gap-1.5 grid-cols-[minmax(0,1fr)_8rem]' : 'grid gap-2 lg:grid-cols-[minmax(0,1fr)_11rem]'}>
        <svg
          viewBox="-55 -16 430 292"
          className={`mx-auto w-full overflow-visible touch-none ${compact ? 'max-w-[14rem]' : 'max-w-[28rem]'}`}
          role="group"
          aria-roledescription="radar chart"
          aria-label={ariaLabel ?? `${suiteId.replaceAll('_', ' ')} radar chart`}
          aria-describedby={readoutId}
        >
          {[25, 50, 75, 100].map((level) => (
            <polygon
              key={level}
              points={polygonPoints(metrics.map(() => level), geometry.axes)}
              fill="none"
              stroke="currentColor"
              strokeWidth="0.7"
              className="text-line"
            />
          ))}
          {geometry.axes.map((axis, index) => (
            <line
              key={metrics[index]!.id}
              x1={geometry.center.x}
              y1={geometry.center.y}
              x2={axis.x}
              y2={axis.y}
              stroke="currentColor"
              strokeWidth="0.7"
              className="text-line"
            />
          ))}
          <polygon
            points={ceilingPoints}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="3 4"
            className="text-amber/60"
          />
          {comparisonEntries.map((entry, index) => (
            <polygon
              key={entry.id ?? `${entry.label}-${index}`}
              points={polygonPoints(metrics.map((metric) => entry.scores[metric.id] ?? 0), geometry.axes)}
              fill="none"
              stroke={entry.color ?? 'currentColor'}
              strokeWidth={index === 0 ? '1.2' : '1'}
              strokeDasharray={entry.dashed === false ? undefined : '5 4'}
              className={entry.color ? undefined : 'text-muted'}
              opacity={Math.max(0.45, 0.84 - index * 0.1)}
            />
          ))}
          <polygon
            points={scorePoints}
            fill="color-mix(in srgb, var(--color-mint) 24%, transparent)"
            stroke="var(--color-mint)"
            strokeWidth="2"
          />
          {geometry.axes.map((axis, index) => {
            const metric = metrics[index]!
            const point = scaledPoint(axis, scores[metric.id] ?? 0)
            const selected = metric.id === active
            return (
              <g
                key={metric.id}
                ref={(element) => {
                  metricButtons.current[index] = element
                }}
                tabIndex={0}
                role="button"
                aria-label={metric.label + ": " + (scores[metric.id] ?? 0).toFixed(2)}
                aria-pressed={pinned === metric.id}
                onPointerEnter={() => setHovered(metric.id)}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => setHovered(metric.id)}
                onBlur={() => setHovered(null)}
                onClick={() => toggleMetric(metric.id)}
                onKeyDown={(event) => moveMetricFocus(event, index)}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={selected ? 4.5 : 3}
                  fill={selected ? 'var(--color-bone)' : 'var(--color-mint)'}
                  stroke="var(--color-void)"
                  strokeWidth="1.5"
                  aria-hidden="true"
                />
                <foreignObject
                  x={axis.labelX - 78}
                  y={axis.labelY - 14}
                  width="156"
                  height="34"
                  aria-hidden="true"
                >
                  <span
                    className={`w-full rounded px-1 py-0.5 text-center font-mono text-[0.56rem] leading-tight transition ${selected ? 'bg-mint/15 text-bone' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
                  >
                    {metric.short}
                  </span>
                </foreignObject>
              </g>
            )
          })}
        </svg>

        <figcaption className={compact ? 'min-h-20 border-l border-line/60 pl-2 pt-0 text-[0.9em]' : 'min-h-32 border-t border-line/60 pt-2 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0'}>
          <div className="text-[0.625rem] uppercase tracking-[0.16em] text-muted">Axis readout</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <strong className="text-[0.8125rem] font-medium text-bone">{activeMetric?.label}</strong>
            <span className="font-mono text-sm text-mint">{activeScore.toFixed(2)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-panel">
            <div
              className="h-full bg-mint transition-transform motion-reduce:transition-none"
              style={{ width: `${Math.max(0, Math.min(100, activeScore))}%` }}
            />
          </div>
          <dl className="mt-2 space-y-1 text-[0.6875rem] leading-snug">
            <div>
              <dt className="text-muted">Strongest driver</dt>
              <dd className="text-bone">{activeProfile?.positive ?? 'Model capability and matching data'}</dd>
            </div>
            <div>
              <dt className="text-muted">Main constraint</dt>
              <dd className="text-amber">{activeProfile?.penalty ?? 'Scale and data readiness'}</dd>
            </div>
          </dl>
          {comparisonEntries.length > 0 ? (
            <ul className="mt-2 space-y-0.5 font-mono text-[0.625rem] text-muted">
              {comparisonEntries.map((entry, index) => (
                <li key={entry.id ?? `${entry.label}-${index}`}>
                  <span style={entry.color ? { color: entry.color } : undefined}>━━</span> {entry.label}
                </li>
              ))}
            </ul>
          ) : null}
        </figcaption>
      </div>
      <div id={readoutId} className="sr-only" aria-live="polite">
        {metricReadout}
      </div>
      <ul className="sr-only">
        {metrics.map((metric) => (
          <li key={metric.id}>{metric.label}: {(scores[metric.id] ?? 0).toFixed(2)}</li>
        ))}
      </ul>
    </figure>
  )
}
