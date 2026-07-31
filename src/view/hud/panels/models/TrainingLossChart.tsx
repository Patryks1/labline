import type { TrainingJob } from '../../../../sim/types'
import { lossStageMarkers, trainingEnergyLabel } from './trainingPresentation'

type LossPoint = NonNullable<TrainingJob['lossHistory']>[number]

export function TrainingLossChart({
  history,
  failed,
  energyMWh,
  mwDays,
  energyEstimated = false,
}: {
  history: LossPoint[]
  failed: boolean
  energyMWh?: number
  mwDays?: number
  energyEstimated?: boolean
}) {
  const points =
    history.length > 1
      ? history
      : history.length === 1
        ? [
            history[0]!,
            {
              ...history[0]!,
              progress: Math.max(0.01, history[0]!.progress),
              loss: history[0]!.loss,
            },
          ]
        : []

  if (!points.length) {
    return (
      <div className="mt-2 rounded-lg border border-line/50 bg-void/25 px-3 py-4 text-[0.8125rem] text-muted">
        Loss telemetry begins when this run receives compute.
      </div>
    )
  }

  const width = 640
  const height = 180
  const padL = 44
  const padR = 12
  const padT = 22
  const padB = 28
  const losses = points.map((point) => point.loss)
  const observedMin = Math.min(...losses)
  const observedMax = Math.max(...losses)
  const observedRange = observedMax - observedMin
  const range = Math.max(0.2, observedRange * 1.2)
  const midpoint = (observedMax + observedMin) / 2
  const min = Math.max(0, midpoint - range / 2)
  const max = min + range
  const firstDay = points[0]!.day
  const lastDay = points.at(-1)!.day
  const daySpan = lastDay - firstDay
  const firstProgress = points[0]!.progress
  const lastProgress = points.at(-1)!.progress
  const progressSpan = lastProgress - firstProgress
  const xForPoint = (point: LossPoint, index: number) => {
    const fraction = daySpan > 0
      ? (point.day - firstDay) / daySpan
      : progressSpan > 1e-9
        ? (point.progress - firstProgress) / progressSpan
        : points.length === 1
          ? 0
          : index / (points.length - 1)
    return padL + Math.max(0, Math.min(1, fraction)) * (width - padL - padR)
  }
  const path = points
    .map((point, index) => {
      const x = xForPoint(point, index)
      const y = padT + ((max - point.loss) / range) * (height - padT - padB)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  const current = points.at(-1)!
  const yTicks = [max, (max + min) / 2, min]
  const stageMarkers = lossStageMarkers(points)
  const hasEnergy = energyMWh != null || mwDays != null
  const energyLabel = trainingEnergyLabel({ energyMWh, mwDays, estimated: energyEstimated })

  return (
    <div className="mt-2 rounded-lg border border-line/60 bg-void/30 p-3">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <p className="hud-eyebrow">Observed loss · {current.stage}</p>
          <p className={`font-mono text-xl font-semibold tabular-nums ${failed ? 'text-danger' : 'text-train'}`}>
            {current.loss.toFixed(3)}
          </p>
        </div>
        <div className="text-right font-mono text-[0.6875rem] tabular-nums text-muted">
          <div>observed min {observedMin.toFixed(3)}</div>
          <div>observed max {observedMax.toFixed(3)}</div>
          <div title={!hasEnergy ? 'Awaiting simulator energy telemetry or a training power field.' : undefined}>
            {energyLabel}
          </div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Training loss over time"
        className="h-40 w-full overflow-visible"
      >
        {yTicks.map((tick, index) => {
          const y = padT + ((max - tick) / range) * (height - padT - padB)
          return (
            <g key={index}>
              <line
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
                stroke="currentColor"
                className="text-line/50"
                strokeWidth="1"
              />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-muted"
                fontSize="10"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {tick.toFixed(2)}
              </text>
            </g>
          )
        })}
        {stageMarkers.map(({ point, index }) => {
          const x = xForPoint(point, index)
          return (
            <g key={`${point.stage}-${point.day}-${index}`}>
              <line
                x1={x}
                y1={padT}
                x2={x}
                y2={height - padB}
                stroke="currentColor"
                className="text-research/70"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
              <text
                x={x + 4}
                y={padT - 6}
                className="fill-research"
                fontSize="9"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {point.stage.toUpperCase()}
              </text>
            </g>
          )
        })}
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          className={failed ? 'text-danger' : 'text-train'}
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
        <text
          x={padL}
          y={height - 8}
          className="fill-muted"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {daySpan > 0 ? `D${points[0]!.day}` : `${Math.round(points[0]!.progress * 100)}%`}
        </text>
        <text
          x={width - padR}
          y={height - 8}
          textAnchor="end"
          className="fill-muted"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {daySpan > 0 ? `D${current.day}` : `${Math.round(current.progress * 100)}%`}
        </text>
      </svg>
    </div>
  )
}
