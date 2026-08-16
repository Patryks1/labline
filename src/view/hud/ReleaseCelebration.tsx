import { useMemo } from 'react'
import { ChartLineUp, RocketLaunch } from '@phosphor-icons/react'
import type { BenchmarkSuiteId } from '../../sim/types'
import { formatParams } from '../../sim/balance/training'
import { useGameStore } from '../../store/gameStore'
import { type ReleaseEvent, useUiStore } from '../../store/uiStore'
import { money } from './format'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton, MetricTile, StatusChip } from './ui/HudPrimitives'
import { TrainingLossChart } from './panels/models/TrainingLossChart'
import { BENCHMARK_SUITE_UI } from './panels/models/benchmarkRunUi'
import { measuredReleaseEvidence, releasedModelForEvent } from './releaseReview'

function preferredReleaseSuites(event: ReleaseEvent): BenchmarkSuiteId[] {
  const preferred: BenchmarkSuiteId[] =
    event.productPreset === 'image_generation' || event.family === 'diffusion'
      ? ['image_generation']
      : event.productPreset === 'video_generation' || event.family === 'video'
        ? ['video_generation']
        : event.productPreset === 'audio'
          ? ['audio_generation']
          : event.productPreset === 'omni' || event.family === 'omni'
            ? ['omni_overview', 'language']
            : ['language']
  return [...new Set([...preferred, ...(event.benchmarkSuiteIds ?? [])])]
}

/** Persistent post-release review; it remains until the player dismisses it. */
export function ReleaseCelebration() {
  const event = useUiStore((state) => state.releaseEvent)
  const clear = useUiStore((state) => state.clearRelease)
  const state = useGameStore((store) => store.state)

  const review = useMemo(() => {
    if (!event) return null
    const model = releasedModelForEvent(state.player.models, event.modelId, event.name)
    const preferredSuites = preferredReleaseSuites(event)
    const evidence = measuredReleaseEvidence(model, preferredSuites)
    const suiteId = evidence?.suite.suiteId ?? preferredSuites[0] ?? 'language'
    return { model, suiteId, evidence }
  }, [event, state])

  if (!event || !review) return null

  const latestSnapshot = event.benchmarkSnapshots?.at(-1)
  const apiIn = review.model?.apiPriceInPerMTok ?? review.model?.suggestedApiPriceIn
  const apiOut = review.model?.apiPriceOutPerMTok ?? review.model?.suggestedApiPriceOut
  const hasLoss = (event.lossHistory?.length ?? 0) > 0

  return (
    <ConsoleDialog
      open
      titleId={`release-review-${event.id}`}
      eyebrow="Release review · production live"
      title={event.name}
      description={`${review.model ? formatParams(review.model.paramsB) : event.family ?? 'Model'} · ${review.evidence ? `${BENCHMARK_SUITE_UI[review.suiteId].label} measured evaluation` : 'Public evaluation pending'}`}
      onClose={clear}
      closeLabel="Close release review"
      maxWidthClass="max-w-6xl"
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.75rem] text-muted">
            {review.evidence
              ? 'Release is live. Review measured evidence and list pricing before scaling traffic.'
              : 'Release is live. Evaluation scores stay unknown until a measured report completes.'}
          </p>
          <HudButton type="button" variant="primary" onClick={clear} className="sm:min-w-40">
            Continue operations
          </HudButton>
        </div>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label="Release status"
          value={
            <span className="flex items-center gap-1.5">
              <RocketLaunch aria-hidden size="0.875rem" weight="fill" />
              Public
            </span>
          }
          tone="gold"
        />
        <MetricTile
          label="Evaluation score"
          value={review.evidence ? review.evidence.suite.score.toFixed(1) : 'Unknown'}
          tone="positive"
        />
        <MetricTile
          label="Measured position"
          value={review.evidence?.rankLabel ?? '—'}
        />
        <MetricTile
          label="API list / MTok"
          value={apiIn != null && apiOut != null ? `${money(apiIn)} in · ${money(apiOut)} out` : 'Not listed'}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(20rem,0.82fr)_minmax(32rem,1.18fr)]">
        <section className="rounded-lg border border-line/70 bg-panel-2/55 p-3.5" aria-labelledby={`release-curve-${event.id}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="hud-eyebrow">Training trace</p>
              <h3 id={`release-curve-${event.id}`} className="mt-1 text-sm font-semibold text-bone">
                Loss and private evaluation checkpoints
              </h3>
            </div>
            {latestSnapshot?.totalCost != null ? (
              <StatusChip tone="research">{money(latestSnapshot.totalCost)} eval</StatusChip>
            ) : null}
          </div>
          {hasLoss ? (
            <TrainingLossChart
              history={event.lossHistory ?? []}
              failed={false}
              energyMWh={event.energyMWh}
              mwDays={event.energyMwDays}
              benchmarks={event.benchmarkSnapshots}
            />
          ) : (
            <div className="mt-3 rounded-lg border border-line/50 bg-void/30 px-3 py-8 text-center">
              <ChartLineUp className="mx-auto text-muted" size="1.5rem" />
              <p className="mt-2 text-[0.75rem] text-muted">
                This checkpoint predates retained training telemetry. Public evaluation evidence remains pending.
              </p>
            </div>
          )}
        </section>

        <section className="min-w-0 rounded-lg border border-line/70 bg-panel-2/55 p-3.5" aria-labelledby={`release-bench-${event.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="hud-eyebrow">Measured evidence</p>
              <h3 id={`release-bench-${event.id}`} className="mt-1 text-sm font-semibold text-bone">
                {review.evidence
                  ? `${BENCHMARK_SUITE_UI[review.suiteId].label} · same-metric public peers`
                  : 'Public evaluation pending'}
              </h3>
            </div>
            {review.evidence ? (
              <StatusChip tone="research">
                {(review.evidence.report.quote.accuracy * 100).toFixed(0)}% accuracy
              </StatusChip>
            ) : null}
          </div>
          {review.evidence ? (
            <>
              <div className="panel-scroll mt-3 overflow-x-auto rounded-md border border-line/60">
                <table className="w-full min-w-[38rem] border-collapse text-left text-[0.75rem]">
                  <thead>
                    <tr className="border-b border-line/70 bg-void/55 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-muted">
                      <th className="px-2.5 py-2">Metric</th>
                      <th className="px-2 py-2 text-right">Estimate</th>
                      <th className="px-2 py-2 text-right">Interval</th>
                      <th className="px-2 py-2 text-right">Closest public peer</th>
                      <th className="px-2 py-2 text-right">Delta</th>
                      <th className="px-2 py-2 text-right">Rank</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.evidence.metrics.map((metric) => (
                      <tr key={metric.metricId} className="border-b border-line/45 bg-panel/20 last:border-0">
                        <td className="px-2.5 py-2 font-medium text-bone">{metric.label}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-mint">{metric.score.toFixed(1)}</td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-muted">{metric.low.toFixed(1)}–{metric.high.toFixed(1)}</td>
                        <td className="px-2 py-2 text-right text-muted">
                          {metric.rival ? `${metric.rival.modelName}${metric.rival.labName ? ` · ${metric.rival.labName}` : ''}` : '—'}
                        </td>
                        <td className={`px-2 py-2 text-right font-mono tabular-nums ${metric.rival && metric.rival.delta >= 0 ? 'text-mint' : 'text-warning'}`}>
                          {metric.rival ? `${metric.rival.delta >= 0 ? '+' : ''}${metric.rival.delta.toFixed(1)}` : '—'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums text-bone">
                          {metric.rival ? `#${metric.rival.rank}/${metric.rival.fieldSize}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 font-mono text-[0.625rem] tabular-nums text-muted">
                Report day {review.evidence.report.completedDay} · {review.evidence.report.request.mode.replaceAll('_', ' ')} · {money(review.evidence.report.quote.totalCost)} · {(review.evidence.report.confidence * 100).toFixed(0)}% confidence
              </p>
            </>
          ) : (
            <div className="mt-3 rounded-lg border border-research/25 bg-research/5 px-4 py-8 text-center">
              <ChartLineUp className="mx-auto text-research" size="1.5rem" />
              <strong className="mt-2 block text-sm text-bone">Public evaluation pending</strong>
              <p className="mx-auto mt-1 max-w-lg text-[0.75rem] leading-relaxed text-muted">
                No measured report is retained for this exact model version yet. Its latent capability and benchmark suites remain hidden until evaluation evidence completes.
              </p>
            </div>
          )}
        </section>
      </div>
    </ConsoleDialog>
  )
}
