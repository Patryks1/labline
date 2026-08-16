import { useState } from 'react'
import { GameCard } from '../../ui/kit'
import { Sparkline } from '../../ui/dataViz/Sparkline'

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
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const last = values[values.length - 1] ?? 0
  const first = values[0] ?? 0
  const delta = last - first
  const height = tall ? 140 : 56
  const pointIndex =
    activeIndex == null ? Math.max(0, values.length - 1) : Math.max(0, Math.min(values.length - 1, activeIndex))
  const positive = last >= 0

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
      <Sparkline
        values={values}
        secondaryValues={secondaryValues}
        days={days}
        format={format}
        secondaryLabel={secondaryLabel}
        secondaryFormat={secondaryFormat}
        label={label}
        height={height}
        className="mt-0.5"
        ariaLabel={`${label} trend`}
        area={tall}
        onActiveChange={(point) => setActiveIndex(point?.index ?? null)}
      />
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
