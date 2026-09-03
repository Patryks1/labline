import { useEffect, useMemo, useRef, useState } from 'react'
import { ChartLineUp, RocketLaunch } from '@phosphor-icons/react'
import type { BenchmarkSuiteId, Model, SimState, SubPlan } from '../../sim/types'
import {
  apiComparablePeerRows,
  apiHostingCostFloor,
  blendApiPrice,
  clampApiListToHostingFloor,
  commercialModelKind,
} from '../../sim/balance/pricing'
import { formatParams } from '../../sim/balance/training'
import { migrateEffortRecipes } from '../../sim/balance/modelProduct'
import { computeSnapshot } from '../../sim/systems/compute'
import { isLivePublicModel, isV4ProjectedModel } from '../../sim/modelRelease'
import { useGameStore } from '../../store/gameStore'
import { type ReleaseEvent, useUiStore } from '../../store/uiStore'
import { money, num } from './format'
import { formatApiListPrice, effectiveApiPeerPricing } from './panels/apiPriceUi'
import {
  formatFrontierThinking,
  frontierThinkingFor,
} from './panels/BenchmarkCompareTab'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton, HudInput, MetricTile, StatusChip } from './ui/HudPrimitives'
import { TrainingLossChart } from './panels/models/TrainingLossChart'
import { BENCHMARK_SUITE_UI } from './panels/models/benchmarkRunUi'
import { measuredReleaseEvidence, releasedModelForEvent, diffNewLiveEndpointIds, endpointCelebrationFacts, liveEndpointsOf } from './releaseReview'

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

export function releaseEffortRecipes(model: Model) {
  return migrateEffortRecipes(model.productProfile)
}

export const trainedThinkingRecipes = releaseEffortRecipes

/** Persistent post-release review; it remains until the player dismisses it. */
export function ReleaseCelebration() {
  const event = useUiStore((state) => state.releaseEvent)
  const clear = useUiStore((state) => state.clearRelease)
  const announceRelease = useUiStore((state) => state.announceRelease)
  const state = useGameStore((store) => store.state)
  const listReleasedModel = useGameStore((store) => store.listReleasedModel)
  const seenLiveIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    const live = liveEndpointsOf(state)
    if (seenLiveIds.current == null) {
      seenLiveIds.current = new Set(live.map((endpoint) => endpoint.id))
      return
    }
    const fresh = diffNewLiveEndpointIds(seenLiveIds.current, live)
    for (const id of fresh) {
      seenLiveIds.current.add(id)
      const endpoint = live.find((row) => row.id === id)
      if (!endpoint) continue
      const projected = state.player.models.find((model) => model.id === endpoint.id)
      if (projected && isV4ProjectedModel(projected)) continue
      const current = useUiStore.getState().releaseEvent
      if (current?.modelId === endpoint.id) continue
      const facts = endpointCelebrationFacts(state, endpoint)
      announceRelease({
        name: endpoint.name,
        modelId: endpoint.id,
        capability: facts.overall ?? 0,
      })
    }
  }, [announceRelease, state])

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
}) {
  const latestSnapshot = event.benchmarkSnapshots?.at(-1)
  const endpoint = liveEndpointsOf(simState).find(
    (row) => row.id === event.modelId || row.name === event.name,
  )
  const endpointFacts = endpoint ? endpointCelebrationFacts(simState, endpoint) : null
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
  const [apiOn, setApiOn] = useState(true)
  const [apiIn, setApiIn] = useState(seeded.priceIn)
  const [apiOut, setApiOut] = useState(seeded.priceOut)
  const [planIds, setPlanIds] = useState<string[]>([])
  const hasLoss = (event.lossHistory?.length ?? 0) > 0
  const thinkingHeads = review.model ? releaseEffortRecipes(review.model) : []
  const comparablePeers = useMemo(() => {
    if (!review.model) return []
    const ownKind = commercialModelKind(review.model)
    const blend = blendApiPrice(apiIn, apiOut)
    const peers = simState.rivals.flatMap((rival) =>
      rival.models
        .filter(isLivePublicModel)
        .map((model) => {
          const effective = effectiveApiPeerPricing(rival.pricing, model)
          return {
            name: model.name,
            price: effective.price,
            capability: model.capability,
            featureScore: model.modalities.length * 18,
            tokPerSec:
              model.serviceProfile?.interactiveTokPerSec ??
              52 * model.tokPerSecMult,
            kind: commercialModelKind(model),
            thinking: frontierThinkingFor(model),
          }
        })
        .filter((peer) => peer.kind === ownKind),
    )
    return apiComparablePeerRows(
      blend,
      {
        capability: review.model.capability,
        featureScore: review.model.modalities.length * 18,
        tokPerSec:
          review.model.serviceProfile?.interactiveTokPerSec ??
          52 * review.model.tokPerSecMult,
      },
      peers,
    ).map((row) => ({
      ...row,
      thinking: peers.find((peer) => peer.name === row.name)?.thinking,
    }))
  }, [apiIn, apiOut, review.model, simState.rivals])

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

  return (
    <ConsoleDialog
      open
      titleId={`release-review-${event.id}`}
      eyebrow="Release review · list it"
      title={event.name}
      shellClassName="sm:h-[92dvh]"
      description={(
        <>
          <span className="sm:hidden">
            {endpointFacts
              ? `${endpointFacts.sizeLabel}${endpointFacts.overall != null ? ` · P50/public ${endpointFacts.overall.toFixed(0)}` : ''}`
              : review.model ? formatParams(review.model.paramsB) : event.family ?? 'Model'} · {review.evidence ? 'Evaluation ready' : 'Evaluation pending'}
          </span>
          <span className="hidden sm:inline">
            {endpointFacts
              ? `${endpointFacts.sizeLabel}${endpointFacts.overall != null ? ` · public overall ${endpointFacts.overall.toFixed(1)}` : ''}${endpointFacts.isRouter ? ` · ${endpointFacts.memberCount} members` : ''}`
              : review.model ? formatParams(review.model.paramsB) : event.family ?? 'Model'} · {review.evidence ? `${BENCHMARK_SUITE_UI[review.suiteId].label} measured evaluation` : 'Public evaluation pending'}
          </span>
        </>
      )}
      onClose={onClear}
      closeLabel="Close release review"
      maxWidthClass="max-w-6xl"
      footer={
        review.model ? (
          <div className="flex justify-end">
            <HudButton
              type="button"
              variant="primary"
              className="sm:min-w-40"
              onClick={confirmSell}
            >
              List it
            </HudButton>
          </div>
        ) : (
          <div className="flex justify-end">
            <HudButton type="button" variant="primary" onClick={onClear} className="sm:min-w-40">
              Continue operations
            </HudButton>
          </div>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 grid shrink-0 grid-cols-2 gap-2 sm:mb-4 sm:grid-cols-4">
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
          value={
            endpointFacts?.overall != null
              ? endpointFacts.overall.toFixed(1)
              : review.evidence
                ? review.evidence.suite.score.toFixed(1)
                : 'Unknown'
          }
          tone="positive"
        />
        <MetricTile
          label={endpointFacts?.isRouter ? 'Router members' : 'Measured position'}
          value={
            endpointFacts?.isRouter
              ? String(endpointFacts.memberCount)
              : (review.evidence?.rankLabel ?? '—')
          }
        />
        <MetricTile
          label="API list / MTok"
          value={`${money(suggestedIn)} in · ${money(suggestedOut)} out`}
        />
      </div>

      <section className="hud-mobile-detail shrink-0 rounded-lg border border-line/70 bg-panel-2/55 p-3.5 max-sm:hidden [@media(max-height:540px)]:hidden" aria-labelledby={`release-curve-${event.id}`}>
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

      {review.model ? (
        <section
          className="mt-3 flex min-h-0 flex-1 flex-col rounded-lg border border-line/70 bg-panel-2/55 p-3 sm:mt-4 sm:p-3.5"
          aria-labelledby={`release-gtm-${event.id}`}
        >
          <p className="hud-eyebrow">Go to market</p>
          <h3 id={`release-gtm-${event.id}`} className="mt-1 text-sm font-semibold text-bone">
            Price the API and tick plans
          </h3>
          <div className="mt-3 grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line/60 bg-void/35 px-3 py-2.5">
              <label className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-mint"
                  checked={apiOn}
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
                    disabled={!apiOn}
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
                    disabled={!apiOn}
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
              <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto">
                <div data-testid="release-thinking-heads">
                  <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    Thinking levels
                  </p>
                  <ul className="mt-1 space-y-0.5 font-mono text-[0.6875rem] tabular-nums text-bone">
                    {thinkingHeads.map((recipe) => (
                      <li key={recipe.id}>
                        {recipe.kind === 'instant'
                          ? 'Instant · free serve'
                          : `${recipe.name} · ${recipe.thinkingTokenMult.toFixed(1)}× generated${recipe.trained ? '' : ' · untrained'}${recipe.served ? '' : ' · not serving'}`}
                      </li>
                    ))}
                  </ul>
                </div>
              {comparablePeers.length > 0 ? (
                <div data-testid="release-comparable-peers">
                  <p className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                    Similar capability
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {comparablePeers.map((peer) => (
                      <li
                        key={`${peer.name}-${peer.capability}`}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 font-mono text-[0.6875rem] tabular-nums min-[420px]:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
                      >
                        <span className="min-w-0 truncate text-bone">
                          {peer.name}
                          {peer.thinking?.thinkingTokenMult != null
                            ? ` · ${formatFrontierThinking(peer.thinking)}`
                            : ''}
                        </span>
                        <span className="shrink-0 text-bone">
                          ${formatApiListPrice(peer.price)}/M
                        </span>
                        <span className="text-muted min-[420px]:shrink-0">
                          cap {num(peer.capability, 0)}
                        </span>
                        <span
                          className={`text-right uppercase tracking-[0.08em] min-[420px]:shrink-0 ${
                            peer.position === 'cheaper'
                              ? 'text-mint'
                              : peer.position === 'premium'
                                ? 'text-amber'
                                : 'text-muted'
                          }`}
                        >
                          {peer.position}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              </div>
            </div>
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line/60 bg-void/35 px-3 py-2.5">
              <p className="text-[0.75rem] font-medium text-bone">Plans</p>
              <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
                {plans.length === 0 ? (
                  <p className="text-[0.6875rem] text-muted">No plans yet.</p>
                ) : (
                  plans.map((plan) => {
                    const checked = planIds.includes(plan.id)
                    return (
                      <label
                        key={plan.id}
                        className="flex min-h-11 cursor-pointer items-center gap-2 text-[0.75rem] text-muted"
                      >
                        <input
                          type="checkbox"
                          className="size-5 shrink-0 accent-mint"
                          checked={checked}
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
      </div>
    </ConsoleDialog>
  )
}
