import { useMemo, useState } from 'react'
import { ChartLineUp, RocketLaunch } from '@phosphor-icons/react'
import type { CheckpointEvaluationRequest } from '../../sim/balance/checkpointEvaluation'
import type { BenchmarkSuiteId, Model, SimState, SubPlan } from '../../sim/types'
import { apiHostingCostFloor, clampApiListToHostingFloor } from '../../sim/balance/pricing'
import { formatParams } from '../../sim/balance/training'
import { computeSnapshot } from '../../sim/systems/compute'
import { useGameStore } from '../../store/gameStore'
import { type ReleaseEvent, useUiStore } from '../../store/uiStore'
import { money, num } from './format'
import { formatApiListPrice } from './panels/apiPriceUi'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton, HudInput, MetricTile, StatusChip } from './ui/HudPrimitives'
import { TrainingLossChart } from './panels/models/TrainingLossChart'
import { BENCHMARK_SUITE_UI } from './panels/models/benchmarkRunUi'
import { ReleaseEvaluationOrder } from './panels/models/ReleaseEvaluationOrder'
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
  const listReleasedModel = useGameStore((store) => store.listReleasedModel)
  const scheduleReleasedModelEvaluation = useGameStore(
    (store) => store.scheduleReleasedModelEvaluation,
  )

  const review = useMemo(() => {
    if (!event) return null
    const model = releasedModelForEvent(state.player.models, event.modelId, event.name)
    const preferredSuites = preferredReleaseSuites(event)
    const evidence = measuredReleaseEvidence(model, preferredSuites)
    const suiteId = evidence?.suite.suiteId ?? preferredSuites[0] ?? 'language'
    return { model, suiteId, evidence }
  }, [event, state])

  if (!event || !review) return null

  return (
    <ReleaseCelebrationDialog
      event={event}
      review={review}
      plans={state.player.pricing.plans}
      simState={state}
      onClear={clear}
      onList={(payload) => {
        if (!review.model) {
          clear()
          return
        }
        listReleasedModel({ modelId: review.model.id, ...payload })
        clear()
      }}
      onRunEvaluation={(request) => {
        if (!review.model) return
        scheduleReleasedModelEvaluation(review.model.id, request)
      }}
    />
  )
}

function ReleaseCelebrationDialog({
  event,
  review,
  plans,
  simState,
  onClear,
  onList,
  onRunEvaluation,
}: {
  event: ReleaseEvent
  review: {
    model: Model | undefined
    suiteId: BenchmarkSuiteId
    evidence: ReturnType<typeof measuredReleaseEvidence>
  }
  plans: readonly SubPlan[]
  simState: SimState
  onClear: () => void
  onList: (payload: {
    sell: boolean
    apiIn?: number | null
    apiOut?: number | null
    planIds?: readonly string[]
  }) => void
  onRunEvaluation: (request: CheckpointEvaluationRequest) => void
}) {
  const latestSnapshot = event.benchmarkSnapshots?.at(-1)
  const hosting = useMemo(() => {
    if (!review.model) return null
    return apiHostingCostFloor(simState, computeSnapshot(simState), review.model)
  }, [review.model, simState])
  const suggestedIn =
    review.model?.apiPriceInPerMTok ?? review.model?.suggestedApiPriceIn ?? 0.8
  const suggestedOut =
    review.model?.apiPriceOutPerMTok ?? review.model?.suggestedApiPriceOut ?? 3.2
  const seeded = hosting
    ? clampApiListToHostingFloor(suggestedIn, suggestedOut, hosting)
    : { priceIn: suggestedIn, priceOut: suggestedOut }
  const [sell, setSell] = useState(true)
  const [apiOn, setApiOn] = useState(true)
  const [apiIn, setApiIn] = useState(seeded.priceIn)
  const [apiOut, setApiOut] = useState(seeded.priceOut)
  const [planIds, setPlanIds] = useState<string[]>([])
  const [showEvalOrder, setShowEvalOrder] = useState(!review.evidence)
  const hasLoss = (event.lossHistory?.length ?? 0) > 0
  const pendingEvaluations = useMemo(() => {
    if (!review.model) return []
    return (simState.player.privateEvaluationJobs ?? []).filter(
      (job) =>
        job.kind === 'released_model_evaluation' &&
        job.subjectId === review.model?.id,
    )
  }, [review.model, simState.player.privateEvaluationJobs])

  const confirmSell = () => {
    const listed = hosting
      ? clampApiListToHostingFloor(apiIn, apiOut, hosting)
      : { priceIn: apiIn, priceOut: apiOut }
    onList({
      sell: true,
      apiIn: apiOn ? listed.priceIn : null,
      apiOut: apiOn ? listed.priceOut : null,
      planIds,
    })
  }
  const confirmHold = () => onList({ sell: false })

  return (
    <ConsoleDialog
      open
      titleId={`release-review-${event.id}`}
      eyebrow="Release review · list it"
      title={event.name}
      description={`${review.model ? formatParams(review.model.paramsB) : event.family ?? 'Model'} · ${review.evidence ? `${BENCHMARK_SUITE_UI[review.suiteId].label} measured evaluation` : 'Public evaluation pending'}`}
      onClose={onClear}
      closeLabel="Close release review"
      maxWidthClass="max-w-6xl"
      footer={
        review.model ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[0.75rem] text-muted">
              Public on evals. Demand starts only after you list it.
            </p>
            <div className="flex flex-wrap gap-2">
              <HudButton type="button" variant="ghost" onClick={confirmHold}>
                Release without selling
              </HudButton>
              <HudButton
                type="button"
                variant="primary"
                className="sm:min-w-40"
                onClick={sell ? confirmSell : confirmHold}
              >
                {sell ? 'List it' : 'Release without selling'}
              </HudButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[0.75rem] text-muted">
              Release is public on evals. Listing controls need the finished model row.
            </p>
            <HudButton type="button" variant="primary" onClick={onClear} className="sm:min-w-40">
              Continue operations
            </HudButton>
          </div>
        )
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
          value={`${money(suggestedIn)} in · ${money(suggestedOut)} out`}
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
            <div className="flex flex-wrap items-center gap-2">
              {review.evidence ? (
                <StatusChip tone="research">
                  {(review.evidence.report.quote.accuracy * 100).toFixed(0)}% accuracy
                </StatusChip>
              ) : null}
              {review.model && review.evidence ? (
                <HudButton
                  type="button"
                  variant="ghost"
                  className="!px-2.5 !py-1 text-[0.75rem]"
                  onClick={() => setShowEvalOrder((open) => !open)}
                >
                  {showEvalOrder ? 'Hide benchmark order' : 'Run benchmarks'}
                </HudButton>
              ) : null}
            </div>
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
              {showEvalOrder && review.model ? (
                <ReleaseEvaluationOrder
                  model={review.model}
                  cash={simState.player.cash}
                  preferredSuiteIds={preferredReleaseSuites(event)}
                  onSubmit={onRunEvaluation}
                />
              ) : null}
            </>
          ) : (
            <div className="mt-3 rounded-lg border border-research/25 bg-research/5 px-4 py-5">
              <ChartLineUp className="mx-auto text-research" size="1.5rem" />
              <strong className="mt-2 block text-center text-sm text-bone">
                {pendingEvaluations.length > 0
                  ? 'Evaluation in flight'
                  : 'Public evaluation pending'}
              </strong>
              <p className="mx-auto mt-1 max-w-lg text-center text-[0.75rem] leading-relaxed text-muted">
                {pendingEvaluations.length > 0
                  ? `Results land on day ${Math.max(...pendingEvaluations.map((job) => job.readyDay))}. Latent scores stay hidden until the panel reports.`
                  : 'No measured report is retained for this exact model version yet. Commission a study here, or list it and measure later.'}
              </p>
              {review.model && showEvalOrder ? (
                <ReleaseEvaluationOrder
                  model={review.model}
                  cash={simState.player.cash}
                  preferredSuiteIds={preferredReleaseSuites(event)}
                  onSubmit={onRunEvaluation}
                />
              ) : review.model ? (
                <div className="mt-3 flex justify-center">
                  <HudButton
                    type="button"
                    variant="secondary"
                    onClick={() => setShowEvalOrder(true)}
                  >
                    Run benchmarks
                  </HudButton>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {review.model ? (
        <section
          className="mt-4 rounded-lg border border-line/70 bg-panel-2/55 p-3.5"
          aria-labelledby={`release-gtm-${event.id}`}
        >
          <p className="hud-eyebrow">Go to market</p>
          <h3 id={`release-gtm-${event.id}`} className="mt-1 text-sm font-semibold text-bone">
            Sell, price the API, and tick plans
          </h3>
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(12rem,0.7fr)_minmax(16rem,1fr)_minmax(16rem,1fr)]">
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-line/60 bg-void/35 px-3 py-2.5 text-[0.75rem] text-muted">
              <input
                type="checkbox"
                className="mt-0.5 accent-mint"
                checked={sell}
                onChange={(event) => setSell(event.target.checked)}
              />
              <span>
                <strong className="block text-bone">Sell this model</strong>
                Off keeps it on the board without demand.
              </span>
            </label>
            <div className="rounded-md border border-line/60 bg-void/35 px-3 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted">
                <input
                  type="checkbox"
                  className="accent-mint"
                  checked={apiOn}
                  disabled={!sell}
                  onChange={(event) => setApiOn(event.target.checked)}
                />
                <span className="font-medium text-bone">API listing</span>
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-[0.6875rem] text-muted">
                  In $/MTok
                  <HudInput
                    className="mt-1 w-full"
                    type="number"
                    min={hosting?.costIn ?? 0}
                    step={0.01}
                    disabled={!sell || !apiOn}
                    value={apiIn}
                    invalid={Boolean(hosting && apiIn < hosting.costIn)}
                    onChange={(event) => setApiIn(Number(event.target.value))}
                    onBlur={() => {
                      if (!hosting) return
                      const listed = clampApiListToHostingFloor(apiIn, apiOut, hosting)
                      setApiIn(listed.priceIn)
                      setApiOut(listed.priceOut)
                    }}
                  />
                  {hosting ? (
                    <span className="mt-1 block font-mono text-[0.625rem] tabular-nums text-mint">
                      Floor ${formatApiListPrice(hosting.costIn)}
                    </span>
                  ) : null}
                </label>
                <label className="text-[0.6875rem] text-muted">
                  Out $/MTok
                  <HudInput
                    className="mt-1 w-full"
                    type="number"
                    min={hosting?.costOut ?? 0}
                    step={0.01}
                    disabled={!sell || !apiOn}
                    value={apiOut}
                    invalid={Boolean(hosting && apiOut < hosting.costOut)}
                    onChange={(event) => setApiOut(Number(event.target.value))}
                    onBlur={() => {
                      if (!hosting) return
                      const listed = clampApiListToHostingFloor(apiIn, apiOut, hosting)
                      setApiIn(listed.priceIn)
                      setApiOut(listed.priceOut)
                    }}
                  />
                  {hosting ? (
                    <span className="mt-1 block font-mono text-[0.625rem] tabular-nums text-mint">
                      Floor ${formatApiListPrice(hosting.costOut)}
                    </span>
                  ) : null}
                </label>
              </div>
              {hosting ? (
                <p className="mt-2 text-[0.625rem] leading-relaxed text-muted">
                  {hosting.source === 'cloud_reference'
                    ? 'No serving replica on campus — floor is a cloud-rental quote for this size.'
                    : `Hosting floor from energy, racks, halls, and leases at this model's size (${review.model ? formatParams(review.model.paramsB) : 'model'} · ${num(hosting.capacityMTok)} MTok/day). Output costs more than input because decode is memory-bound.`}
                </p>
              ) : null}
            </div>
            <div className="rounded-md border border-line/60 bg-void/35 px-3 py-2.5">
              <p className="text-[0.75rem] font-medium text-bone">Plans</p>
              <div className="mt-2 flex max-h-36 flex-col gap-1.5 overflow-y-auto">
                {plans.length === 0 ? (
                  <p className="text-[0.6875rem] text-muted">No plans yet.</p>
                ) : (
                  plans.map((plan) => {
                    const checked = planIds.includes(plan.id)
                    return (
                      <label
                        key={plan.id}
                        className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted"
                      >
                        <input
                          type="checkbox"
                          className="accent-mint"
                          checked={checked}
                          disabled={!sell}
                          onChange={() =>
                            setPlanIds((current) =>
                              checked
                                ? current.filter((id) => id !== plan.id)
                                : [...current, plan.id],
                            )
                          }
                        />
                        <span className="truncate text-bone">{plan.name}</span>
                        <span className="ml-auto font-mono text-[0.625rem]">
                          {money(plan.pricePerMonth)}/mo
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </ConsoleDialog>
  )
}
