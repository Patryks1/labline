import { useMemo, useState } from 'react'
import type {
  BenchmarkMetricId,
  BenchmarkSuiteId,
  EvaluationProfile,
} from '../../../sim/types'
import { SUITE_METRICS } from '../../../sim/balance/evaluationSuites'
import { polygonPoints, radarGeometry, scaledPoint } from './radarGeometry'

export function RadarChart({
  suiteId,
  scores,
  profile,
  comparison,
  comparisonLabel = 'Public frontier',
}: {
  suiteId: BenchmarkSuiteId
  scores: Partial<Record<BenchmarkMetricId, number>>
  profile?: EvaluationProfile
  comparison?: Partial<Record<BenchmarkMetricId, number>>
  comparisonLabel?: string
}) {
  const metrics = SUITE_METRICS[suiteId]
  const [hovered, setHovered] = useState<BenchmarkMetricId | null>(null)
  const [pinned, setPinned] = useState<BenchmarkMetricId | null>(null)
  const active = pinned ?? hovered ?? metrics[0]?.id ?? null
  const geometry = useMemo(() => radarGeometry(metrics.length), [metrics.length])
  const scorePoints = polygonPoints(metrics.map((metric) => scores[metric.id] ?? 0), geometry.axes)
  const ceilingPoints = polygonPoints(
    metrics.map((metric) => profile?.[metric.id]?.ceiling ?? 96),
    geometry.axes,
  )
  const comparisonPoints = comparison
    ? polygonPoints(metrics.map((metric) => comparison[metric.id] ?? 0), geometry.axes)
    : ''
  const activeMetric = metrics.find((metric) => metric.id === active)
  const activeScore = active ? scores[active] ?? 0 : 0
  const activeProfile = active ? profile?.[active] : undefined

  return (
    <figure className="rounded-xl border border-line/70 bg-void/35 p-2.5">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_11rem]">
        <svg
          viewBox="-55 -16 430 292"
          className="mx-auto w-full max-w-[28rem] overflow-visible"
          role="img"
          aria-label={`${suiteId.replaceAll('_', ' ')} radar chart`}
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
          {comparisonPoints && (
            <polygon
              points={comparisonPoints}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeDasharray="5 4"
              className="text-muted"
            />
          )}
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
              <g key={metric.id}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={selected ? 4.5 : 3}
                  fill={selected ? 'var(--color-bone)' : 'var(--color-mint)'}
                  stroke="var(--color-void)"
                  strokeWidth="1.5"
                />
                <foreignObject
                  x={axis.labelX - 78}
                  y={axis.labelY - 14}
                  width="156"
                  height="34"
                >
                  <button
                    type="button"
                    className={`w-full rounded px-1 py-0.5 text-center font-mono text-[0.56rem] leading-tight transition ${selected ? 'bg-mint/15 text-bone' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
                    onMouseEnter={() => setHovered(metric.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(metric.id)}
                    onBlur={() => setHovered(null)}
                    onClick={() => setPinned(metric.id)}
                    aria-pressed={pinned === metric.id}
                  >
                    {metric.short}
                  </button>
                </foreignObject>
              </g>
            )
          })}
        </svg>

        <figcaption className="min-h-32 border-t border-line/60 pt-2 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <div className="text-[0.625rem] uppercase tracking-[0.16em] text-muted">Axis readout</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <strong className="text-[0.8125rem] font-medium text-bone">{activeMetric?.label}</strong>
            <span className="font-mono text-sm text-mint">{activeScore.toFixed(2)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-panel">
            <div className="h-full bg-mint transition-transform motion-reduce:transition-none" style={{ width: `${Math.max(0, Math.min(100, activeScore))}%` }} />
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
          {comparison && <p className="mt-2 font-mono text-[0.625rem] text-muted">— — {comparisonLabel}</p>}
        </figcaption>
      </div>
      <ul className="sr-only">
        {metrics.map((metric) => (
          <li key={metric.id}>{metric.label}: {(scores[metric.id] ?? 0).toFixed(2)}</li>
        ))}
      </ul>
    </figure>
  )
}
