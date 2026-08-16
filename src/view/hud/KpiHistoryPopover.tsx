import { useMemo, useState } from 'react'
import { ChartLineUp } from '@phosphor-icons/react'
import type { FinanceDaySnapshot } from '../../sim/types'
import { money, pct } from './format'
import { SegmentedTabs } from './ui/kit'
import { HudButton } from './ui/HudPrimitives'
import { Sparkline } from './ui/dataViz/Sparkline'

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

/**
 * Geometry contract mirrored by the mobile inset sheet CSS. Keeping this
 * calculation exportable lets responsive tests assert containment without
 * depending on a browser layout engine.
 */
// oxlint-disable-next-line react/only-export-components
export function mobileKpiHistoryRect({
  viewportWidth,
  viewportHeight,
  minInlineInset,
  topInset,
  bottomInset,
  safeLeft = 0,
  safeRight = 0,
}: {
  viewportWidth: number
  viewportHeight: number
  minInlineInset: number
  topInset: number
  bottomInset: number
  safeLeft?: number
  safeRight?: number
}) {
  const left = Math.max(minInlineInset, safeLeft)
  const right = viewportWidth - Math.max(minInlineInset, safeRight)
  const top = topInset
  const bottom = viewportHeight - bottomInset
  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

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
  const delta = points.length > 1 ? points.at(-1)!.value - points[0]!.value : 0

  return (
    <section
      className="kpi-history-popover panel-scroll pointer-events-auto fixed left-1/2 top-[3.75rem] z-[90] w-[min(44rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-line bg-panel/95 p-3 shadow-2xl backdrop-blur-xl"
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
          onClick={onClose}
          className="flex min-h-11 items-center justify-center rounded-md px-3 text-[0.6875rem] font-semibold text-muted hover:bg-void hover:text-bone"
        >
          Done
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

      <div className="kpi-history-summary mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
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
        <div className="kpi-history-range w-[12rem]">
          <SegmentedTabs
            ariaLabel="History range"
            active={String(range)}
            onChange={(id) => {
              setRange(Number(id))
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
            <Sparkline
              values={values}
              days={points.map((point) => point.day)}
              format={definition.format}
              label={definition.label}
              color={definition.color}
              height={152}
              area
              ariaLabel={`${definition.label} history`}
              className="mt-1"
              renderTooltip={(hover) => (
                <span className="text-bone">
                  D{points[hover.pointIndex]?.day ?? hover.point.x} · {definition.format(values[hover.pointIndex] ?? hover.point.y)}
                </span>
              )}
            />
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
