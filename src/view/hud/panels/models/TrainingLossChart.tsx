import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { TrainingBenchmarkSnapshot, TrainingJob } from '../../../../sim/types'
import { lossStageMarkers, trainingEnergyLabel } from './trainingPresentation'
import { consumeChartEscape } from '../../ui/dataViz/chartInteraction'

type LossPoint = NonNullable<TrainingJob['lossHistory']>[number]

type TrainingSelectionKind = 'loss' | 'benchmark' | 'checkpoint'

interface TrainingSelection {
  id: string
  kind: TrainingSelectionKind
  x: number
  y: number
  day: number
  progress: number
  value: number | null
  label: string
  detail: string
}

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
  const readoutId = useId()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const rawPoints =
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
  const points = [...rawPoints].sort((a, b) => a.day - b.day || a.progress - b.progress)

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

  const lossSelections: TrainingSelection[] = points.map((point, index) => ({
    id: `loss-${point.day}-${point.progress}-${index}`,
    kind: 'loss',
    x: xForPoint(point, index),
    y: padT + ((max - point.loss) / range) * (height - padT - padB),
    day: point.day,
    progress: point.progress,
    value: point.loss,
    label: 'Training loss',
    detail: point.stage,
  }))
  const checkpointSelections: TrainingSelection[] = checkpointPoints.map((checkpoint) => {
    const value = checkpoint.loss != null && Number.isFinite(checkpoint.loss) ? checkpoint.loss : null
    return {
      id: `checkpoint-${checkpoint.id}`,
      kind: 'checkpoint',
      x: xForCheckpoint(checkpoint),
      y: value == null ? height - padB - 7 : padT + ((max - value) / range) * (height - padT - padB),
      day: checkpoint.day,
      progress: checkpoint.progress,
      value,
      label: checkpoint.label,
      detail: checkpoint.detail,
    }
  })
  const benchmarkSelections: TrainingSelection[] = benchmarkPoints.map((snapshot, index) => ({
    id: `benchmark-${snapshot.day}-${index}`,
    kind: 'benchmark',
    x: xForBenchmark(snapshot),
    y: capabilityY(snapshot.capability),
    day: snapshot.day,
    progress: snapshot.progress,
    value: snapshot.capability,
    label: 'Benchmark capability',
    detail: snapshot.capabilityLow != null && snapshot.capabilityHigh != null
      ? `${snapshot.capability.toFixed(2)} (${snapshot.capabilityLow.toFixed(2)}–${snapshot.capabilityHigh.toFixed(2)})`
      : snapshot.capability.toFixed(2),
  }))
  const selectionPoints = [...lossSelections, ...checkpointSelections, ...benchmarkSelections]
  const navigationPoints = [...selectionPoints].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))
  const hoveredSelection = selectionPoints.find((selection) => selection.id === hoveredId) ?? null
  const pinnedSelection = selectionPoints.find((selection) => selection.id === pinnedId) ?? null
  const activeSelection = pinnedSelection ?? hoveredSelection

  const nearestSelection = (
    event: Pick<ReactPointerEvent<SVGSVGElement>, 'clientX' | 'clientY' | 'currentTarget'>,
  ) => {
    if (selectionPoints.length === 0) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    const scaleX = width / Math.max(1, bounds.width)
    const scaleY = height / Math.max(1, bounds.height)
    const pointerX = (event.clientX - bounds.left) * scaleX
    const pointerY = (event.clientY - bounds.top) * scaleY
    let nearest: TrainingSelection | null = null
    let distance = Number.POSITIVE_INFINITY
    for (const selection of selectionPoints) {
      const nextDistance = Math.abs(selection.x - pointerX) * 2 + Math.abs(selection.y - pointerY)
      if (nextDistance < distance) {
        distance = nextDistance
        nearest = selection
      }
    }
    return nearest
  }

  const toggleSelection = (selection: TrainingSelection | null) => {
    if (!selection) return
    setHoveredId(selection.id)
    setPinnedId((current) => (current === selection.id ? null : selection.id))
  }

  const moveSelection = (event: ReactKeyboardEvent<Element>, currentId: string | null) => {
    if (navigationPoints.length === 0) return
    const currentIndex = currentId == null ? -1 : navigationPoints.findIndex((selection) => selection.id === currentId)
    let nextIndex = currentIndex < 0 ? 0 : currentIndex
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = Math.min(navigationPoints.length - 1, nextIndex + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = Math.max(0, nextIndex - 1)
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = navigationPoints.length - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleSelection(selectionPoints.find((selection) => selection.id === currentId) ?? navigationPoints[0]!)
      return
    } else if (event.key === 'Escape') {
      consumeChartEscape(event, () => setPinnedId(null))
      return
    } else return
    event.preventDefault()
    setHoveredId(navigationPoints[nextIndex]!.id)
  }

  const selectionLabel = activeSelection
    ? `${activeSelection.label}, day ${activeSelection.day}, ${activeSelection.value == null ? 'no observed value' : activeSelection.value.toFixed(2)}${activeSelection.detail ? `, ${activeSelection.detail}` : ''}`
    : 'No training point selected.'

  return (
    <div className="mt-2 rounded-lg border border-line/60 bg-void/30 p-3">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <p className="hud-eyebrow">Observed loss · {current.stage}</p>
          <p className={`font-mono text-xl font-semibold tabular-nums ${failed ? 'text-danger' : 'text-train'}`}>
            {current.loss.toFixed(2)}
          </p>
        </div>
        <div className="text-right font-mono text-[0.6875rem] tabular-nums text-muted">
          <div>observed min {observedMin.toFixed(2)}</div>
          <div>observed max {observedMax.toFixed(2)}</div>
          <div title={!hasEnergy ? 'Awaiting simulator energy telemetry or a training power field.' : undefined}>
            {energyLabel}
          </div>
        </div>
      </div>
      <div data-training-chart-plot className="relative h-32 w-full overflow-visible sm:h-40">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-roledescription="training loss chart"
        aria-label={`Training loss over time${
          hasCheckpoints
            ? ` with ${checkpointPoints.length} saved checkpoint${checkpointPoints.length === 1 ? '' : 's'}`
            : ''
        }`}
        aria-describedby={readoutId}
        className="h-full w-full touch-pan-y overflow-visible"
        tabIndex={0}
        onPointerMove={(event) => {
          const selection = nearestSelection(event)
          if (selection) setHoveredId(selection.id)
        }}
        onPointerLeave={() => setHoveredId(null)}
        onClick={(event) => toggleSelection(nearestSelection(event))}
        onKeyDown={(event) => moveSelection(event, activeSelection?.id ?? null)}
        onFocus={() => {
          if (!activeSelection && navigationPoints[0]) setHoveredId(navigationPoints[0].id)
        }}
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
        {lossSelections.map((selection) => (
          <circle
            key={selection.id}
            cx={selection.x}
            cy={selection.y}
            r={activeSelection?.id === selection.id ? 5 : 3.5}
            className={failed ? 'fill-danger' : 'fill-train'}
            stroke="var(--color-void)"
            strokeWidth="1.25"
            tabIndex={0}
            role="button"
            aria-label={`${selection.label}, day ${selection.day}, ${selection.value?.toFixed(2) ?? 'unknown'}`}
            aria-pressed={pinnedId === selection.id}
            onPointerEnter={() => setHoveredId(selection.id)}
            onFocus={() => setHoveredId(selection.id)}
            onBlur={() => setHoveredId(null)}
            onClick={(event) => {
              event.stopPropagation()
              toggleSelection(selection)
            }}
            onKeyDown={(event) => moveSelection(event, selection.id)}
          />
        ))}
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
              role="button"
              aria-label={title}
              aria-pressed={pinnedId === `checkpoint-${checkpoint.id}`}
              tabIndex={0}
              className={colorClass}
              onPointerEnter={() => setHoveredId(`checkpoint-${checkpoint.id}`)}
              onFocus={() => setHoveredId(`checkpoint-${checkpoint.id}`)}
              onBlur={() => setHoveredId(null)}
              onClick={(event) => {
                event.stopPropagation()
                toggleSelection(checkpointSelections.find((selection) => selection.id === `checkpoint-${checkpoint.id}`) ?? null)
              }}
              onKeyDown={(event) => moveSelection(event, `checkpoint-${checkpoint.id}`)}
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
              const selectionId = `benchmark-${snap.day}-${index}`
              return (
                <g
                  key={selectionId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Benchmark capability, day ${snap.day}, ${snap.capability.toFixed(2)}`}
                  aria-pressed={pinnedId === selectionId}
                  onPointerEnter={() => setHoveredId(selectionId)}
                  onFocus={() => setHoveredId(selectionId)}
                  onBlur={() => setHoveredId(null)}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleSelection(benchmarkSelections.find((selection) => selection.id === selectionId) ?? null)
                  }}
                  onKeyDown={(event) => moveSelection(event, selectionId)}
                >
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
                    {snap.capability.toFixed(2)}
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
          {daySpan > 0 ? `D${firstDay}` : `${(points[0]!.progress * 100).toFixed(2)}%`}
        </text>
        <text
          x={width - padR}
          y={height - 8}
          textAnchor="end"
          className="fill-muted"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          {daySpan > 0 ? `D${current.day}` : `${(current.progress * 100).toFixed(2)}%`}
        </text>
        {activeSelection ? (
          <line
            x1={activeSelection.x}
            x2={activeSelection.x}
            y1={padT}
            y2={height - padB}
            stroke="currentColor"
            className="text-bone/35"
            strokeWidth="1"
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        ) : null}
      </svg>
      {activeSelection ? (
        <div
          className="pointer-events-none absolute top-2 z-10 w-fit max-w-[12rem] rounded-md border border-line bg-panel px-2 py-1 font-mono text-[0.6875rem] shadow-lg"
          style={{
            left: `${Math.max(8, Math.min(92, (activeSelection.x / width) * 100))}%`,
            transform: `translateX(${activeSelection.x > width * 0.7 ? '-100%' : activeSelection.x < width * 0.3 ? '0' : '-50%'})`,
          }}
        >
          <div className="text-muted">D{activeSelection.day} · {activeSelection.label}</div>
          <div className="text-bone">{activeSelection.value == null ? 'No observed loss' : activeSelection.value.toFixed(2)}</div>
          {activeSelection.detail ? <div className="text-muted">{activeSelection.detail}</div> : null}
        </div>
      ) : null}
      </div>
      <div id={readoutId} className="sr-only" aria-live="polite">
        {selectionLabel}
      </div>
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
