import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { nearestChartDatum, prepareChartData, type PreparedChartDatum } from './dataViz/chartGeometry'
import { consumeChartEscape } from './dataViz/chartInteraction'

/**
 * Responsive multi-series line/scatter chart for HUD panels.
 *
 * The chart keeps the caller's source index while sorting geometry once by x.
 * That lets existing tooltip consumers continue looking up their source rows,
 * while hover, tap, and keyboard navigation all address the point rendered on
 * screen. A tap/click pins the readout; the same point unpins it.
 */

export interface LineChartPoint {
  x: number
  y: number
  /** Optional stable domain id. The source index is used when omitted. */
  id?: string
  /** Optional marker radius in px. Selected points grow slightly from this base. */
  r?: number
  /** Extra accessible detail, appended to the default point label. */
  detail?: string
}

export interface LineChartSeries {
  id: string
  label: string
  /** CSS color — pass a theme token, e.g. 'var(--color-mint)'. No inline hex. */
  color: string
  points: LineChartPoint[]
}

export interface LineChartHover {
  series: LineChartSeries
  point: LineChartPoint
  /** Original caller index, retained for compatibility with existing consumers. */
  pointIndex: number
  /** Stable point id used by chart interaction. */
  pointId: string
  /** Pixel position of the point inside the chart box (for tooltip placement). */
  left: number
  top: number
}

const PAD = { left: 36, right: 12, top: 10, bottom: 22 }
const COMPACT_PAD = { left: 4, right: 4, top: 5, bottom: 5 }

type PreparedSeries = Omit<LineChartSeries, 'points'> & {
  points: Array<PreparedChartDatum & LineChartPoint>
}

function pointRadius(point: LineChartPoint, compact: boolean, selected: boolean) {
  const base = point.r ?? (compact ? 3.25 : 3.5)
  const next = selected ? base + 1.25 : base
  return Math.max(2.25, Math.min(9, next))
}

function pointLabel(
  hover: LineChartHover,
  formatX: (value: number) => string,
  formatY: (value: number) => string,
) {
  const base = `${hover.series.label}, ${formatX(hover.point.x)}, ${formatY(hover.point.y)}`
  return hover.point.detail ? `${base}, ${hover.point.detail}` : base
}

export function LineChart({
  series,
  hiddenIds = [],
  height = 220,
  xLabel,
  yLabel,
  formatX = (value) => String(Math.round(value)),
  formatY = (value) => String(Math.round(value)),
  renderTooltip,
  ariaLabel = 'Line chart',
  compact = false,
  showAxes = !compact,
  showPoints = true,
  area = false,
  independentYScales = false,
  onActiveChange,
  onPinChange,
  selectedPointId = null,
}: {
  series: LineChartSeries[]
  /** Series ids to exclude from render and domains (legend toggles live in the caller). */
  hiddenIds?: readonly string[]
  /** Chart box height in px. Keep ≤260 so panels do not scroll at 1080p. */
  height?: number
  xLabel?: string
  yLabel?: string
  formatX?: (value: number) => string
  formatY?: (value: number) => string
  renderTooltip?: (hover: LineChartHover) => ReactNode
  ariaLabel?: string
  /** Hide axes and tighten geometry for embedded trend/sparkline views. */
  compact?: boolean
  /** Defaults to the inverse of compact. */
  showAxes?: boolean
  /** Render point affordances. Points remain keyboard/tap reachable when true. */
  showPoints?: boolean
  /** Add a restrained area under each series. */
  area?: boolean
  /** Preserve compact overlays whose series use different units. */
  independentYScales?: boolean
  /** Called for hover, keyboard, and pinned active-point changes. */
  onActiveChange?: (hover: LineChartHover | null) => void
  /** Called only when a point is pinned or unpinned. */
  onPinChange?: (hover: LineChartHover | null) => void
  /** Optional externally selected point, used by scrubbers and linked views. */
  selectedPointId?: string | null
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const readoutId = useId()
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<LineChartHover | null>(null)
  const [pinned, setPinned] = useState<LineChartHover | null>(null)
  const pad = compact ? COMPACT_PAD : PAD

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const update = () => setWidth(Math.max(1, el.clientWidth || 640))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const visible = useMemo<PreparedSeries[]>(
    () =>
      series
        .filter((entry) => !hiddenIds.includes(entry.id) && entry.points.length > 0)
        .map((entry) => ({
          ...entry,
          points: prepareChartData(entry.points, entry.id),
        })),
    [hiddenIds, series],
  )

  const { xFor, yFor, xTicks, yTicks } = useMemo(() => {
    const xs = visible.flatMap((entry) => entry.points.map((point) => point.x))
    const ys = visible.flatMap((entry) => entry.points.map((point) => point.y))
    const xMinRaw = xs.length > 0 ? Math.min(...xs) : 0
    const xMaxRaw = xs.length > 0 ? Math.max(...xs) : 1
    const yMinRaw = ys.length > 0 ? Math.min(...ys) : 0
    const yMaxRaw = ys.length > 0 ? Math.max(...ys) : 1
    const xSpan = Math.max(1e-9, xMaxRaw - xMinRaw)
    const yPad = Math.max(1, (yMaxRaw - yMinRaw) * 0.14)
    const yMin = yMinRaw - yPad
    const yMax = yMaxRaw + yPad
    const w = Math.max(10, width - pad.left - pad.right)
    const h = Math.max(10, height - pad.top - pad.bottom)
    return {
      xFor: (x: number) =>
        xs.length <= 1 ? pad.left + w / 2 : pad.left + ((x - xMinRaw) / xSpan) * w,
      yFor: (y: number) => pad.top + h - ((y - yMin) / Math.max(1e-9, yMax - yMin)) * h,
      xTicks: [0, 1, 2, 3, 4].map((i) => xMinRaw + (xSpan * i) / 4),
      yTicks: [0, 1, 2, 3].map((i) => yMin + ((yMax - yMin) * i) / 3),
    }
  }, [height, pad.bottom, pad.left, pad.right, pad.top, visible, width])

  const seriesYFor = useMemo(() => {
    const domains = new Map<string, { min: number; max: number }>()
    for (const entry of visible) {
      const values = entry.points.map((point) => point.y)
      const rawMin = values.length > 0 ? Math.min(...values) : 0
      const rawMax = values.length > 0 ? Math.max(...values) : 1
      const padding = Math.max(1, (rawMax - rawMin) * 0.14)
      domains.set(entry.id, { min: rawMin - padding, max: rawMax + padding })
    }
    return domains
  }, [visible])

  const yForSeries = (entry: PreparedSeries, value: number) => {
    const domain = seriesYFor.get(entry.id)
    if (!domain) return yFor(value)
    return pad.top + (height - pad.top - pad.bottom) -
      ((value - domain.min) / Math.max(1e-9, domain.max - domain.min)) * (height - pad.top - pad.bottom)
  }

  const pointEntries = useMemo(
    () => visible.flatMap((entry) => entry.points.map((point) => ({ entry, point }))),
    [visible],
  )

  const makeHover = (entry: PreparedSeries, point: PreparedChartDatum & LineChartPoint): LineChartHover => ({
    series: entry,
    point,
    pointIndex: point.sourceIndex,
    pointId: point.id,
    left: xFor(point.x),
    top: independentYScales ? yForSeries(entry, point.y) : yFor(point.y),
  })

  const nearestHover = (event: Pick<ReactPointerEvent<SVGSVGElement>, 'clientX' | 'clientY' | 'currentTarget'>) => {
    if (pointEntries.length === 0) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    const scaleX = width / Math.max(1, bounds.width)
    const scaleY = height / Math.max(1, bounds.height)
    const pointer = {
      left: (event.clientX - bounds.left) * scaleX,
      top: (event.clientY - bounds.top) * scaleY,
    }
    const nearest = nearestChartDatum(
      pointEntries,
      ({ entry, point }) => ({ left: xFor(point.x), top: independentYScales ? yForSeries(entry, point.y) : yFor(point.y) }),
      pointer,
    )
    return nearest ? makeHover(nearest.datum.entry, nearest.datum.point) : null
  }

  const togglePin = (next: LineChartHover | null) => {
    if (!next) return
    setPinned((current) =>
      current?.series.id === next.series.id && current.pointId === next.pointId ? null : next,
    )
  }

  const pinnedVisible = pinned && visible.some((entry) =>
    entry.id === pinned.series.id && entry.points.some((point) => point.id === pinned.pointId),
  )
  const selectedPoint = selectedPointId
    ? pointEntries.find(({ point }) => point.id === selectedPointId)
    : undefined
  const selected = selectedPoint
    ? makeHover(selectedPoint.entry, selectedPoint.point)
    : null
  const active = pinnedVisible ? pinned : hover ?? selected

  useEffect(() => {
    onActiveChange?.(active)
  }, [active, onActiveChange])

  useEffect(() => {
    onPinChange?.(pinned)
  }, [onPinChange, pinned])

  const moveKeyboard = (event: ReactKeyboardEvent<Element>, current: LineChartHover | null) => {
    if (pointEntries.length === 0) return
    const currentIndex = current
      ? pointEntries.findIndex(({ entry, point }) => entry.id === current.series.id && point.id === current.pointId)
      : -1
    let nextIndex = currentIndex < 0 ? 0 : currentIndex
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = Math.min(pointEntries.length - 1, nextIndex + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = Math.max(0, nextIndex - 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = pointEntries.length - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      togglePin(current ?? makeHover(pointEntries[0]!.entry, pointEntries[0]!.point))
      return
    } else if (event.key === 'Escape') {
      consumeChartEscape(event, () => setPinned(null))
      return
    } else return
    event.preventDefault()
    const next = pointEntries[nextIndex]!
    setHover(makeHover(next.entry, next.point))
  }

  return (
    <div
      ref={boxRef}
      className="hud-chart-frame relative w-full"
      data-mobile-chart="true"
      data-chart-compact={compact ? 'true' : 'false'}
      data-swipe-ignore="true"
      style={{ height }}
    >
      {visible.length > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            className="block touch-pan-y"
            role="group"
            aria-roledescription="line chart"
            aria-label={ariaLabel}
            tabIndex={0}
            aria-describedby={readoutId}
            onPointerMove={(event) => {
              const next = nearestHover(event)
              if (next) setHover(next)
            }}
            onPointerLeave={() => setHover(null)}
            onClick={(event) => togglePin(nearestHover(event))}
            onKeyDown={(event) => moveKeyboard(event, active)}
            onFocus={() => {
              if (!active && pointEntries[0]) setHover(makeHover(pointEntries[0].entry, pointEntries[0].point))
            }}
          >
            {showAxes
              ? yTicks.map((tick) => (
                  <g key={`y-${tick}`}>
                    <line
                      x1={pad.left}
                      x2={width - pad.right}
                      y1={yFor(tick)}
                      y2={yFor(tick)}
                      stroke="currentColor"
                      strokeWidth="1"
                      className="text-line/50"
                    />
                    <text
                      x={pad.left - 6}
                      y={yFor(tick) + 3}
                      textAnchor="end"
                      fontSize="10"
                      fill="currentColor"
                      className="font-mono text-muted tabular-nums"
                    >
                      {formatY(tick)}
                    </text>
                  </g>
                ))
              : null}
            {showAxes
              ? xTicks.map((tick) => (
                  <text
                    key={`x-${tick}`}
                    x={xFor(tick)}
                    y={height - 6}
                    textAnchor="middle"
                    fontSize="10"
                    fill="currentColor"
                    className="font-mono text-muted tabular-nums"
                  >
                    {formatX(tick)}
                  </text>
                ))
              : null}
            {showAxes && yLabel ? (
              <text
                x={pad.left - 6}
                y={pad.top - 2}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                className="text-muted"
              >
                {yLabel}
              </text>
            ) : null}
            {showAxes && xLabel ? (
              <text
                x={width - pad.right}
                y={height - 6}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                className="text-muted"
              >
                {xLabel}
              </text>
            ) : null}

            {visible.map((entry) => {
              const path = entry.points
                .map(
                  (point, index) =>
                    `${index === 0 ? 'M' : 'L'} ${xFor(point.x).toFixed(2)} ${(independentYScales ? yForSeries(entry, point.y) : yFor(point.y)).toFixed(2)}`,
                )
                .join(' ')
              const lastPoint = entry.points.at(-1)
              const areaPath = lastPoint
                ? `${path} L ${xFor(lastPoint.x).toFixed(2)} ${(height - pad.bottom).toFixed(2)} L ${xFor(entry.points[0]!.x).toFixed(2)} ${(height - pad.bottom).toFixed(2)} Z`
                : ''
              return (
                <g key={entry.id}>
                  {area && areaPath ? <path d={areaPath} fill={entry.color} fillOpacity="0.1" stroke="none" /> : null}
                  {entry.points.length > 1 ? (
                    <path
                      d={path}
                      fill="none"
                      stroke={entry.color}
                      strokeWidth={compact ? '1.75' : '1.5'}
                      strokeOpacity="0.72"
                    />
                  ) : null}
                  {showPoints
                    ? entry.points.map((point) => {
                        const pointHover = makeHover(entry, point)
                        const selected = active?.pointId === point.id && active.series.id === entry.id
                        return (
                          <circle
                            key={`${entry.id}-${point.id}`}
                            cx={pointHover.left}
                            cy={pointHover.top}
                            r={pointRadius(point, compact, selected)}
                            data-point-detail={point.detail}
                            fill={selected ? 'var(--color-bone)' : entry.color}
                            stroke="var(--color-void)"
                            strokeWidth="1.25"
                            tabIndex={0}
                            role="button"
                            aria-label={pointLabel(pointHover, formatX, formatY)}
                            aria-pressed={pinned?.pointId === point.id && pinned.series.id === entry.id}
                            onPointerEnter={() => setHover(pointHover)}
                            onFocus={() => setHover(pointHover)}
                            onBlur={() => setHover(null)}
                            onClick={(event) => {
                              event.stopPropagation()
                              togglePin(pointHover)
                            }}
                            onKeyDown={(event) => moveKeyboard(event, pointHover)}
                          />
                        )
                      })
                    : null}
                </g>
              )
            })}

            {active ? (
              <line
                x1={active.left}
                x2={active.left}
                y1={pad.top}
                y2={height - pad.bottom}
                stroke="currentColor"
                strokeWidth="1"
                strokeDasharray="3 3"
                className="text-bone/35"
              />
            ) : null}
          </svg>

          <div
            id={readoutId}
            className="sr-only"
            aria-live="polite"
          >
            {active ? pointLabel(active, formatX, formatY) : `${ariaLabel}. No point selected.`}
          </div>

          {active ? (
            <div
              className="hud-chart-tooltip pointer-events-none absolute top-0 z-10 rounded-md border border-line/70 bg-panel px-2 py-1 font-mono text-[0.6875rem] tabular-nums shadow-lg"
              style={{
                left: `${Math.min(Math.max((active.left / Math.max(1, width)) * 100, compact ? 10 : 12), compact ? 90 : 88)}%`,
                top: `${Math.max(4, (active.top / Math.max(1, height)) * 100)}%`,
                transform: 'translate(-50%, -100%)',
              }}
            >
              {renderTooltip ? (
                renderTooltip(active)
              ) : (
                <span className="text-bone">
                  {active.series.label} · {formatX(active.point.x)} · {formatY(active.point.y)}
                </span>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-full items-center justify-center text-center text-[0.8125rem] text-muted">
          No visible series. Toggle a lab back on.
        </div>
      )}
    </div>
  )
}
