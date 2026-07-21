import type { TrainingJob } from '../../../../sim/types'

type LossPoint = NonNullable<TrainingJob['lossHistory']>[number]

export function TrainingLossChart({
  history,
  failed,
}: {
  history: LossPoint[]
  failed: boolean
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
  const padT = 14
  const padB = 28
  const losses = points.map((point) => point.loss)
  const min = Math.min(...losses)
  const max = Math.max(...losses)
  const range = Math.max(0.05, max - min)
  const path = points
    .map((point, index) => {
      const x =
        padL +
        (points.length === 1 ? 0 : (index / (points.length - 1)) * (width - padL - padR))
      const y = padT + ((max - point.loss) / range) * (height - padT - padB)
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  const current = points.at(-1)!
  const yTicks = [max, (max + min) / 2, min]

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
          <div>min {min.toFixed(3)}</div>
          <div>max {max.toFixed(3)}</div>
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
          D{points[0]!.day}
        </text>
        <text
          x={width - padR}
          y={height - 8}
          textAnchor="end"
          className="fill-muted"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          D{current.day}
        </text>
      </svg>
    </div>
  )
}
