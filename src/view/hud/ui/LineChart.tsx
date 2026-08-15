import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

/**
 * Minimal multi-series line/scatter chart for HUD panels.
 * Hand-rolled SVG, theme-token colors only (see docs/ui-revamp-design-system.md).
 * NOT a generic chart library — extend only when a panel needs it.
 */

export interface LineChartPoint {
  x: number
  y: number
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
  pointIndex: number
  /** Pixel position of the point inside the chart box (for tooltip placement). */
  left: number
  top: number
}

const PAD = { left: 36, right: 12, top: 10, bottom: 22 }

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
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<LineChartHover | null>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const visible = useMemo(
    () => series.filter((s) => !hiddenIds.includes(s.id) && s.points.length > 0),
    [series, hiddenIds],
  )

  const { xFor, yFor, xTicks, yTicks } = useMemo(() => {
    const xs = visible.flatMap((s) => s.points.map((p) => p.x))
    const ys = visible.flatMap((s) => s.points.map((p) => p.y))
    const xMinRaw = xs.length > 0 ? Math.min(...xs) : 0
    const xMaxRaw = xs.length > 0 ? Math.max(...xs) : 1
    const yMinRaw = ys.length > 0 ? Math.min(...ys) : 0
    const yMaxRaw = ys.length > 0 ? Math.max(...ys) : 1
    const xSpan = Math.max(1e-9, xMaxRaw - xMinRaw)
    const yPad = Math.max(1, (yMaxRaw - yMinRaw) * 0.14)
    const yMin = yMinRaw - yPad
    const yMax = yMaxRaw + yPad
    const w = Math.max(10, width - PAD.left - PAD.right)
    const h = Math.max(10, height - PAD.top - PAD.bottom)
    return {
      xFor: (x: number) =>
        xs.length <= 1 ? PAD.left + w / 2 : PAD.left + ((x - xMinRaw) / xSpan) * w,
      yFor: (y: number) => PAD.top + h - ((y - yMin) / Math.max(1e-9, yMax - yMin)) * h,
      xTicks: [0, 1, 2, 3, 4].map((i) => xMinRaw + (xSpan * i) / 4),
      yTicks: [0, 1, 2, 3].map((i) => yMin + ((yMax - yMin) * i) / 3),
    }
  }, [visible, width, height])

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (visible.length === 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - bounds.left
    const py = event.clientY - bounds.top
    let best: LineChartHover | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const s of visible) {
      s.points.forEach((point, pointIndex) => {
        const left = xFor(point.x)
        const top = yFor(point.y)
        const dist = Math.abs(left - px) * 2 + Math.abs(top - py)
        if (dist < bestDist) {
          bestDist = dist
          best = { series: s, point, pointIndex, left, top }
        }
      })
    }
    setHover(best)
  }

  return (
    <div ref={boxRef} className="relative w-full" style={{ height }}>
      {width > 0 && visible.length > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            className="block touch-none"
            role="img"
            aria-label={ariaLabel}
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHover(null)}
          >
            {/* grid + y ticks */}
            {yTicks.map((tick) => (
              <g key={`y-${tick}`}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={yFor(tick)}
                  y2={yFor(tick)}
                  stroke="currentColor"
                  strokeWidth="1"
                  className="text-line/50"
                />
                <text
                  x={PAD.left - 6}
                  y={yFor(tick) + 3}
                  textAnchor="end"
                  fontSize="10"
                  fill="currentColor"
                  className="font-mono text-muted tabular-nums"
                >
                  {formatY(tick)}
                </text>
              </g>
            ))}
            {/* x ticks */}
            {xTicks.map((tick) => (
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
            ))}
            {yLabel ? (
              <text
                x={PAD.left - 6}
                y={PAD.top - 2}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                className="text-muted"
              >
                {yLabel}
              </text>
            ) : null}
            {xLabel ? (
              <text
                x={width - PAD.right}
                y={height - 6}
                textAnchor="end"
                fontSize="10"
                fill="currentColor"
                className="text-muted"
              >
                {xLabel}
              </text>
            ) : null}

            {/* per-series trend line + dots */}
            {visible.map((s) => {
              const sorted = [...s.points].sort((a, b) => a.x - b.x)
              const path = sorted
                .map(
                  (p, i) =>
                    `${i === 0 ? 'M' : 'L'} ${xFor(p.x).toFixed(2)} ${yFor(p.y).toFixed(2)}`,
                )
                .join(' ')
              return (
                <g key={s.id}>
                  {sorted.length > 1 ? (
                    <path
                      d={path}
                      fill="none"
                      stroke={s.color}
                      strokeWidth="1.5"
                      strokeOpacity="0.6"
                    />
                  ) : null}
                  {s.points.map((p, i) => {
                    const active =
                      hover?.series.id === s.id && hover.pointIndex === i
                    return (
                      <circle
                        key={`${s.id}-${i}`}
                        cx={xFor(p.x)}
                        cy={yFor(p.y)}
                        r={active ? 4.5 : 3}
                        fill={s.color}
                        stroke="var(--color-void)"
                        strokeWidth="1.25"
                      />
                    )
                  })}
                </g>
              )
            })}

            {/* hover crosshair */}
            {hover ? (
              <line
                x1={hover.left}
                x2={hover.left}
                y1={PAD.top}
                y2={height - PAD.bottom}
                stroke="currentColor"
                strokeWidth="1"
                strokeDasharray="3 3"
                className="text-bone/30"
              />
            ) : null}
          </svg>

          {hover ? (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-md border border-line/70 bg-panel px-2 py-1 font-mono text-[0.6875rem] tabular-nums shadow-lg"
              style={{
                left: Math.min(Math.max(hover.left, 72), Math.max(72, width - 96)),
                top: Math.max(4, hover.top - 8),
                transform: 'translate(-50%, -100%)',
              }}
            >
              {renderTooltip ? (
                renderTooltip(hover)
              ) : (
                <span className="text-bone">
                  {hover.series.label} · {formatX(hover.point.x)} · {formatY(hover.point.y)}
                </span>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex h-full items-center justify-center text-center text-[0.8125rem] text-muted">
          No visible series — toggle a lab back on.
        </div>
      )}
    </div>
  )
}
