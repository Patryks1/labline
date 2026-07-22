import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChartLineUp, X } from '@phosphor-icons/react'
import type { FinanceDaySnapshot } from '../../sim/types'
import { money, pct } from './format'
import { SegmentedTabs } from './ui/kit'
import { HudButton } from './ui/HudPrimitives'

export type KpiHistoryMetric = 'cash' | 'net' | 'share' | 'valuation' | 'brand'

interface CurrentKpis {
  day: number
  cash: number
  net: number
  share: number
  valuation: number
  brand: number
}

interface MetricDefinition {
  label: string
  color: string
  value: (sample: FinanceDaySnapshot) => number
  current: (sample: CurrentKpis) => number
  format: (value: number) => string
}

const METRICS: Record<KpiHistoryMetric, MetricDefinition> = {
  cash: {
    label: 'Cash',
    color: '#43e3d3',
    value: (sample) => sample.cash,
    current: (sample) => sample.cash,
    format: money,
  },
  net: {
    label: 'Day P&L',
    color: '#f0b85a',
    value: (sample) => sample.net,
    current: (sample) => sample.net,
    format: money,
  },
  share: {
    label: 'Market share',
    color: '#66b8ff',
    value: (sample) => sample.share,
    current: (sample) => sample.share,
    format: (value) => pct(value, 1),
  },
  valuation: {
    label: 'Company value',
    color: '#b797ff',
    value: (sample) => sample.valuation,
    current: (sample) => sample.valuation,
    format: money,
  },
  brand: {
    label: 'Brand',
    color: '#ff8f70',
    value: (sample) => sample.brand ?? Number.NaN,
    current: (sample) => sample.brand,
    format: (value) => `${Math.round(value)}/100`,
  },
}

const RANGE_OPTIONS = [
  { id: '30', label: '30D' },
  { id: '90', label: '90D' },
  { id: '180', label: '180D' },
] as const

export function KpiHistoryPopover({
  metric,
  history,
  current,
  onClose,
  onOpenDetails,
  onSelectMetric,
}: {
  metric: KpiHistoryMetric
  history: FinanceDaySnapshot[]
  current: CurrentKpis
  onClose: () => void
  onOpenDetails: () => void
  onSelectMetric?: (metric: KpiHistoryMetric) => void
}) {
  const [range, setRange] = useState(90)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const definition = METRICS[metric]
  const points = useMemo(() => {
    const historical = history
      .map((sample) => ({ day: sample.day, value: definition.value(sample) }))
      .filter((sample) => Number.isFinite(sample.value))
    const currentPoint = { day: current.day, value: definition.current(current) }
    if (historical.at(-1)?.day === current.day) historical[historical.length - 1] = currentPoint
    else historical.push(currentPoint)
    return historical.filter((sample) => sample.day >= current.day - range + 1)
  }, [current, definition, history, range])

  const values = points.map((point) => point.value)
  const rawMin = values.length > 0 ? Math.min(...values) : 0
  const rawMax = values.length > 0 ? Math.max(...values) : 1
  const spread = Math.max(1e-9, rawMax - rawMin)
  const padding = spread * 0.12
  const min = rawMin - padding
  const max = rawMax + padding
  const width = 640
  const height = 168
  const xFor = (index: number) =>
    points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width
  const yFor = (value: number) => height - ((value - min) / Math.max(1e-9, max - min)) * height
  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(2)} ${yFor(point.value).toFixed(2)}`)
    .join(' ')
  const areaPath =
    points.length > 0
      ? `${linePath} L ${xFor(points.length - 1).toFixed(2)} ${height} L ${xFor(0).toFixed(2)} ${height} Z`
      : ''
  const selectedIndex =
    hoverIndex == null
      ? Math.max(0, points.length - 1)
      : Math.min(hoverIndex, Math.max(0, points.length - 1))
  const selected = points[selectedIndex]
  const delta = points.length > 1 ? points.at(-1)!.value - points[0]!.value : 0

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    setHoverIndex(Math.round(ratio * (points.length - 1)))
  }

  return (
    <section
      className="pointer-events-auto fixed left-1/2 top-[3.75rem] z-[90] w-[min(44rem,calc(100vw-1rem))] -translate-x-1/2 rounded-lg border border-line bg-panel/95 p-3 shadow-2xl backdrop-blur-xl"
      aria-label={`${definition.label} history`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-mint/10 text-mint">
            <ChartLineUp size="1.1rem" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-bone">{definition.label} history</h2>
            <p className="truncate font-mono text-[0.6875rem] text-muted">
              D{points[0]?.day ?? current.day}–D{points.at(-1)?.day ?? current.day} · {points.length} closes
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close metric history"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted hover:bg-void hover:text-bone"
        >
          <X size="1rem" />
        </button>
      </div>

      <div className="mt-3">
        <SegmentedTabs
          ariaLabel="KPI series"
          active={metric}
          onChange={(id) => onSelectMetric?.(id as KpiHistoryMetric)}
          items={(Object.keys(METRICS) as KpiHistoryMetric[]).map((id) => ({
            id,
            label: METRICS[id].label,
          }))}
        />
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xl font-semibold tabular-nums text-bone">
            {definition.format(points.at(-1)?.value ?? definition.current(current))}
          </div>
          <div
            className={`mt-0.5 font-mono text-[0.8125rem] tabular-nums ${
              delta < 0 ? 'text-danger' : 'text-mint'
            }`}
          >
            {delta >= 0 ? '+' : ''}
            {definition.format(delta)} over selected range
          </div>
        </div>
        <div className="w-[12rem]">
          <SegmentedTabs
            ariaLabel="History range"
            active={String(range)}
            onChange={(id) => {
              setRange(Number(id))
              setHoverIndex(null)
            }}
            items={RANGE_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
          />
        </div>
      </div>

      <div className="relative mt-2.5 h-44 overflow-hidden rounded-lg border border-line/70 bg-void/55 px-2 py-2">
        {points.length > 1 ? (
          <>
            <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-between font-mono text-[0.625rem] text-muted/80">
              <span>{definition.format(rawMax)}</span>
              <span>{definition.format(rawMin)}</span>
            </div>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="h-full w-full touch-none"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoverIndex(null)}
            >
              <defs>
                <linearGradient id={`kpi-fill-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={definition.color} stopOpacity="0.26" />
                  <stop offset="100%" stopColor={definition.color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={areaPath} fill={`url(#kpi-fill-${metric})`} />
              <path
                d={linePath}
                fill="none"
                stroke={definition.color}
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
              {selected ? (
                <>
                  <line
                    x1={xFor(selectedIndex)}
                    x2={xFor(selectedIndex)}
                    y1="0"
                    y2={height}
                    stroke={definition.color}
                    strokeOpacity="0.35"
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={xFor(selectedIndex)}
                    cy={yFor(selected.value)}
                    r="4"
                    fill={definition.color}
                    stroke="#071217"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              ) : null}
            </svg>
            {selected ? (
              <div
                className="pointer-events-none absolute top-8 -translate-x-1/2 rounded-md border border-line bg-panel px-2 py-1 font-mono text-[0.6875rem] shadow-lg"
                style={{
                  left: `${points.length <= 1 ? 50 : (selectedIndex / (points.length - 1)) * 100}%`,
                }}
              >
                <span className="text-muted">D{selected.day}</span>{' '}
                <span className="text-bone">{definition.format(selected.value)}</span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-[0.8125rem] text-muted">
            {metric === 'brand'
              ? 'Brand history starts recording now.'
              : 'Advance the simulation to build a trend.'}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end">
        <HudButton variant="ghost" onClick={onOpenDetails}>
          Open detailed view →
        </HudButton>
      </div>
    </section>
  )
}
