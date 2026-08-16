import { useCallback, type ReactNode } from 'react'
import {
  LineChart,
  type LineChartHover,
  type LineChartPoint,
  type LineChartSeries,
} from '../LineChart'

export interface SparklineActivePoint {
  index: number
  x: number
  y: number
  seriesId: string
  pinned: boolean
}

export interface SparklineProps {
  values: number[]
  secondaryValues?: number[]
  days?: number[]
  format: (value: number) => string
  secondaryLabel?: string
  secondaryFormat?: (value: number) => string
  label?: string
  height?: number
  color?: string
  secondaryColor?: string
  className?: string
  ariaLabel?: string
  area?: boolean
  /** Optional controlled point selection, useful for linked scrubbers. */
  selectedIndex?: number | null
  /** Series to select when selectedIndex is supplied. */
  selectedSeriesId?: string
  onActiveChange?: (point: SparklineActivePoint | null) => void
  renderTooltip?: (hover: LineChartHover) => ReactNode
}

function pointsFor(values: number[], days: number[] | undefined, id: string): LineChartPoint[] {
  return values.map((value, index) => ({
    id: `${id}-${index}`,
    x: days?.[index] ?? index,
    y: value,
  }))
}

export function Sparkline({
  values,
  secondaryValues,
  days,
  format,
  secondaryLabel,
  secondaryFormat,
  label = 'Trend',
  height = 56,
  color = 'var(--color-mint)',
  secondaryColor = 'var(--color-research)',
  className,
  ariaLabel = `${label} sparkline`,
  area = false,
  selectedIndex = null,
  selectedSeriesId = 'primary',
  onActiveChange,
  renderTooltip,
}: SparklineProps) {
  const primarySeries: LineChartSeries = {
    id: 'primary',
    label,
    color,
    points: pointsFor(values, days, 'primary'),
  }
  const secondarySeries: LineChartSeries | null = secondaryValues
    ? {
        id: 'secondary',
        label: secondaryLabel ?? 'Comparison',
        color: secondaryColor,
        points: pointsFor(secondaryValues, days, 'secondary'),
      }
    : null

  const handleActiveChange = useCallback(
    (hover: LineChartHover | null) => {
      if (!hover) {
        onActiveChange?.(null)
        return
      }
      onActiveChange?.({
        index: hover.pointIndex,
        x: hover.point.x,
        y: hover.point.y,
        seriesId: hover.series.id,
        pinned: false,
      })
    },
    [onActiveChange],
  )

  const renderDefaultTooltip = (hover: LineChartHover) => {
    const index = hover.pointIndex
    const value = hover.series.id === 'secondary'
      ? secondaryValues?.[index] ?? hover.point.y
      : values[index] ?? hover.point.y
    const valueFormat = hover.series.id === 'secondary' ? secondaryFormat ?? format : format
    return (
      <span className="text-bone">
        D{days?.[index] ?? index + 1} · {hover.series.label}: {valueFormat(value)}
      </span>
    )
  }

  return (
    <div className={className}>
      <LineChart
        series={secondarySeries ? [primarySeries, secondarySeries] : [primarySeries]}
        height={height}
        compact
        showAxes={false}
        showPoints={false}
        area={area}
        independentYScales={Boolean(secondarySeries)}
        ariaLabel={ariaLabel}
        renderTooltip={renderTooltip ?? renderDefaultTooltip}
        onActiveChange={handleActiveChange}
        selectedPointId={selectedIndex == null ? null : `${selectedSeriesId}-${selectedIndex}`}
      />
    </div>
  )
}
