import { useState } from 'react'
import { sparkPath } from '../../../../sim/systems/stats'
import { GameCard } from '../../ui/kit'

export function SparkTrendCard({
  label,
  values,
  secondaryValues,
  days,
  format,
  secondaryLabel,
  secondaryFormat,
  tall = false,
}: {
  label: string
  values: number[]
  secondaryValues?: number[]
  days?: number[]
  format: (n: number) => string
  secondaryLabel?: string
  secondaryFormat?: (n: number) => string
  tall?: boolean
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const last = values[values.length - 1] ?? 0
  const first = values[0] ?? 0
  const delta = last - first
  const height = tall ? 140 : 56
  const path = sparkPath(values, 200, height)
  const secondaryPath = secondaryValues ? sparkPath(secondaryValues, 200, height) : ''
  const positive = last >= 0
  const pointIndex =
    hovered == null ? values.length - 1 : Math.max(0, Math.min(values.length - 1, hovered))

  return (
    <GameCard
      eyebrow="Trend"
      title={label}
      actions={
        <div className="text-right">
          <div className={`font-mono text-sm tabular-nums ${positive ? 'text-bone' : 'text-danger'}`}>
            {format(last)}
          </div>
          <div className={`font-mono text-[0.6875rem] tabular-nums ${delta >= 0 ? 'text-mint' : 'text-danger'}`}>
            {delta >= 0 ? '+' : ''}
            {format(delta)} window
          </div>
        </div>
      }
    >
      <svg
        viewBox={`0 0 200 ${height}`}
        className={`mt-0.5 w-full cursor-crosshair ${tall ? 'h-[140px]' : 'h-14'}`}
        preserveAspectRatio="none"
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setHovered(
            Math.round(
              ((event.clientX - rect.left) / Math.max(1, rect.width)) * Math.max(0, values.length - 1),
            ),
          )
        }}
        onPointerLeave={() => setHovered(null)}
      >
        {secondaryPath ? (
          <path d={secondaryPath} fill="none" stroke="currentColor" strokeWidth="1" className="text-research/70" />
        ) : null}
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.75" className="text-mint/85" />
        {hovered != null && values.length > 1 ? (
          <line
            x1={(pointIndex / (values.length - 1)) * 200}
            x2={(pointIndex / (values.length - 1)) * 200}
            y1="0"
            y2={height}
            stroke="rgba(240,246,245,.45)"
            strokeWidth=".8"
          />
        ) : null}
      </svg>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[0.625rem] text-muted">
        <span>D{days?.[pointIndex] ?? pointIndex + 1}</span>
        <span className="text-mint">
          {label}: {format(values[pointIndex] ?? 0)}
        </span>
        {secondaryValues ? (
          <span className="text-research">
            {secondaryLabel}: {(secondaryFormat ?? format)(secondaryValues[pointIndex] ?? 0)}
          </span>
        ) : null}
      </div>
    </GameCard>
  )
}
