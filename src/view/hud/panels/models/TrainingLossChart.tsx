import type { TrainingBenchmarkSnapshot, TrainingJob } from '../../../../sim/types'
import { lossStageMarkers, trainingEnergyLabel } from './trainingPresentation'

type LossPoint = NonNullable<TrainingJob['lossHistory']>[number]

export interface TrainingLossCheckpointMarker {
  id: string
  day: number
  progress: number
  loss: number | null
  label: string
  detail: string
  kind: 'milestone' | 'manual'
  visibility: 'stealth' | 'internal' | 'released'
}

export function TrainingLossChart({
  history,
  failed,
  energyMWh,
  mwDays,
  energyEstimated = false,
  benchmarks,
  checkpoints,
}: {
  history: LossPoint[]
  failed: boolean
  energyMWh?: number
  mwDays?: number
  energyEstimated?: boolean
  benchmarks?: TrainingBenchmarkSnapshot[]
  checkpoints?: TrainingLossCheckpointMarker[]
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
  const padT = 22
  const padB = 28
  const benchmarkPoints = [...(benchmarks ?? [])].sort((a, b) => a.day - b.day)
  const checkpointPoints = [...(checkpoints ?? [])].sort(
    (a, b) => a.day - b.day || a.progress - b.progress,
  )
  const hasBenchmarks = benchmarkPoints.length > 0
  const hasCheckpoints = checkpointPoints.length > 0
  const padR = hasBenchmarks ? 34 : 12
  const checkpointLosses = checkpointPoints.flatMap((checkpoint) =>
    checkpoint.loss != null && Number.isFinite(checkpoint.loss)
      ? [checkpoint.loss]
      : [],
  )
  const losses = [...points.map((point) => point.loss), ...checkpointLosses]
  const observedMin = Math.min(...losses)
  const observedMax = Math.max(...losses)
  const observedRange = observedMax - observedMin
  const range = Math.max(0.2, observedRange * 1.2)
  const midpoint = (observedMax + observedMin) / 2
  const min = Math.max(0, midpoint - range / 2)
  const max = min + range
  const timelineDays = [
    ...points.map((point) => point.day),
    ...benchmarkPoints.map((point) => point.day),
    ...checkpointPoints.map((point) => point.day),
  ]
  const firstDay = Math.min(...timelineDays)
  const lastDay = Math.max(...timelineDays)
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
  // Benchmark checkpoints share the loss chart's day axis; capability rides a
  // fixed 0–100 scale on a right-side axis.
  const xForBenchmark = (snap: TrainingBenchmarkSnapshot) => {
    const fraction =
      daySpan > 0
        ? (snap.day - firstDay) / daySpan
        : progressSpan > 1e-9
          ? (snap.progress - firstProgress) / progressSpan
          : 1
    return padL + Math.max(0, Math.min(1, fraction)) * (width - padL - padR)
  }
  const xForCheckpoint = (checkpoint: TrainingLossCheckpointMarker) => {
    const fraction =
      daySpan > 0
        ? (checkpoint.day - firstDay) / daySpan
        : progressSpan > 1e-9
          ? (checkpoint.progress - firstProgress) / progressSpan
          : checkpoint.progress
    return padL + Math.max(0, Math.min(1, fraction)) * (width - padL - padR)
  }
  const capabilityY = (value: number) =>
    padT + (1 - Math.max(0, Math.min(100, value)) / 100) * (height - padT - padB)
  const benchmarkPath = benchmarkPoints
    .map(
      (snap, index) =>
        `${index === 0 ? 'M' : 'L'} ${xForBenchmark(snap).toFixed(1)} ${capabilityY(snap.capability).toFixed(1)}`,
    )
    .join(' ')
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
        aria-label={`Training loss over time${
          hasCheckpoints
            ? ` with ${checkpointPoints.length} saved checkpoint${checkpointPoints.length === 1 ? '' : 's'}`
            : ''
        }`}
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
        {checkpointPoints.map((checkpoint, index) => {
          const x = xForCheckpoint(checkpoint)
          const y =
            checkpoint.loss != null && Number.isFinite(checkpoint.loss)
              ? padT + ((max - checkpoint.loss) / range) * (height - padT - padB)
              : height - padB - 7
          const colorClass =
            checkpoint.visibility === 'released'
              ? 'text-mint'
              : checkpoint.visibility === 'internal'
                ? 'text-research'
                : 'text-warning'
          const shortLabel =
            checkpoint.kind === 'manual' ? `M${index + 1}` : checkpoint.label
          const title = `${checkpoint.label} · ${checkpoint.detail}`
          return (
            <g
              key={checkpoint.id}
              role="img"
              aria-label={title}
              className={colorClass}
            >
              <title>{title}</title>
              <line
                x1={x}
                y1={padT}
                x2={x}
                y2={height - padB}
                stroke="currentColor"
                strokeWidth="1"
                strokeDasharray={checkpoint.kind === 'manual' ? '2 3' : '1 4'}
                opacity="0.55"
              />
              {checkpoint.kind === 'manual' ? (
                <rect
                  x={x - 4}
                  y={y - 4}
                  width="8"
                  height="8"
                  fill="currentColor"
                />
              ) : (
                <polygon
                  points={`${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}`}
                  fill="currentColor"
                />
              )}
              {checkpoint.visibility !== 'stealth' ? (
                <circle
                  cx={x}
                  cy={y}
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={checkpoint.visibility === 'released' ? '2' : '1'}
                />
              ) : null}
              <text
                x={x}
                y={index % 2 === 0 ? height - padB + 11 : padT - 8}
                textAnchor="middle"
                fill="currentColor"
                fontSize="8"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {shortLabel}
              </text>
            </g>
          )
        })}
        {hasBenchmarks ? (
          <g>
            {[0, 50, 100].map((tick) => (
              <text
                key={`cap-tick-${tick}`}
                x={width - padR + 5}
                y={capabilityY(tick) + 3}
                className="fill-muted"
                fontSize="10"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {tick}
              </text>
            ))}
            <text
              x={width - padR + 5}
              y={padT - 6}
              className="fill-mint"
              fontSize="9"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              CAP
            </text>
            {benchmarkPoints.length > 1 ? (
              <path
                d={benchmarkPath}
                fill="none"
                stroke="currentColor"
                className="text-mint/70"
                strokeWidth="1.5"
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {benchmarkPoints.map((snap, index) => {
              const x = xForBenchmark(snap)
              const y = capabilityY(snap.capability)
              const r = 4
              const hasInterval = snap.capabilityLow != null && snap.capabilityHigh != null
              return (
                <g key={`benchmark-${snap.day}-${index}`}>
                  {hasInterval ? (
                    <>
                      <line
                        x1={x}
                        y1={capabilityY(snap.capabilityHigh!)}
                        x2={x}
                        y2={capabilityY(snap.capabilityLow!)}
                        stroke="currentColor"
                        className="text-mint/60"
                        strokeWidth="1"
                      />
                      <line
                        x1={x - 3}
                        y1={capabilityY(snap.capabilityHigh!)}
                        x2={x + 3}
                        y2={capabilityY(snap.capabilityHigh!)}
                        stroke="currentColor"
                        className="text-mint/60"
                        strokeWidth="1"
                      />
                      <line
                        x1={x - 3}
                        y1={capabilityY(snap.capabilityLow!)}
                        x2={x + 3}
                        y2={capabilityY(snap.capabilityLow!)}
                        stroke="currentColor"
                        className="text-mint/60"
                        strokeWidth="1"
                      />
                    </>
                  ) : null}
                  <polygon
                    points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
                    className="fill-mint"
                  />
                  <text
                    x={x}
                    y={y - r - 4}
                    textAnchor="middle"
                    className="fill-mint"
                    fontSize="9"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {Math.round(snap.capability)}
                  </text>
                </g>
              )
            })}
          </g>
        ) : null}
        <text
          x={padL}
          y={height - 8}
          className="fill-muted"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {daySpan > 0 ? `D${firstDay}` : `${Math.round(points[0]!.progress * 100)}%`}
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
      {hasCheckpoints ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.625rem] text-muted">
          <span><span className="text-warning">◆</span> milestone</span>
          <span><span className="text-warning">■</span> manual</span>
          <span><span className="text-research">◎</span> internal</span>
          <span><span className="text-mint">◎</span> released</span>
        </div>
      ) : null}
    </div>
  )
}
