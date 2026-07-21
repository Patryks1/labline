import { useMemo, useState } from 'react'
import { blendApiPrice } from '../../../sim/balance/pricing'
import { planAllowanceMTokPerMonth } from '../../../sim/systems/plans'
import { competitiveCatchUpSnapshot } from '../../../sim/systems/sharedMarkets'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'
import { GameCard, MeterBar, StatRow } from '../ui/kit'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'

function range(values: [number, number] | undefined, format: (value: number) => string): string {
  if (!values) return '—'
  return `${format(values[0])}–${format(values[1])}`
}

/** Public-only rival intelligence. Exact private bids, cash, recipes, and research stay hidden. */
export function RivalIntelPanel() {
  const state = useGameStore((store) => store.state)
  const rivals = state.rivals
  const rankedRivals = useMemo(
    () => rivals.toSorted((left, right) => right.marketShare - left.marketShare),
    [rivals],
  )
  const [selectedId, setSelectedId] = useState(() => rankedRivals[0]?.id ?? '')
  const rival = rankedRivals.find((entry) => entry.id === selectedId) ?? rankedRivals[0]

  if (!rival) {
    return (
      <PanelScaffold title="Rival intelligence" description="No rival labs in this campaign.">
        <EmptyState title="Empty field" description="This campaign has no rival labs to inspect." />
      </PanelScaffold>
    )
  }

  const estimate = rival.publicEstimate
  const publicModels = rival.models.filter((model) => model.release === 'released' || model.shipped)
  const competitiveResponse = competitiveCatchUpSnapshot(state)
  const marketRows = [
    { id: 'player', name: 'You', share: state.player.finance.totalShare },
    ...rankedRivals.map((entry) => ({ id: entry.id, name: entry.name, share: entry.marketShare })),
  ].toSorted((left, right) => right.share - left.share)

  return (
    <PanelScaffold
      title="Rival intelligence"
      eyebrow={`Day ${state.day}`}
      description="Public offers, disclosed projects, and uncertain operating ranges."
    >
      <div className="space-y-3">
        <GameCard eyebrow="Field" title="Market position" tone="research">
          <div className="anim-stagger space-y-1.5">
            {marketRows.map((entry) => {
              const selected = entry.id === rival.id
              const isPlayer = entry.id === 'player'
              return (
                <button
                  key={entry.id}
                  type="button"
                  disabled={isPlayer}
                  aria-pressed={selected}
                  onClick={() => setSelectedId(entry.id)}
                  className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition ${
                    selected
                      ? 'bg-research/10 ring-1 ring-research/35'
                      : isPlayer
                        ? 'cursor-default bg-mint/8'
                        : 'hover-lift hover:bg-void/55'
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-[0.875rem] font-medium ${
                      selected ? 'text-research' : isPlayer ? 'text-mint' : 'text-bone'
                    }`}
                  >
                    {entry.name}
                  </span>
                  <div className="w-[42%] min-w-[7rem]">
                    <MeterBar
                      value={entry.share}
                      tone={isPlayer ? 'positive' : selected ? 'research' : 'warning'}
                      detail={pct(entry.share, 0)}
                    />
                  </div>
                  <span
                    className={`w-14 shrink-0 text-right font-mono text-lg font-semibold tabular-nums ${
                      isPlayer ? 'text-mint' : selected ? 'text-research' : 'text-bone'
                    }`}
                  >
                    {pct(entry.share, 0)}
                  </span>
                </button>
              )
            })}
          </div>
        </GameCard>

        <GameCard
          eyebrow={rival.name}
          title="Estimated range"
          tone="research"
          actions={<StatusChip tone="research">{estimate ? `${pct(estimate.confidence, 0)} conf.` : '—'}</StatusChip>}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricTile
              label="Compute"
              value={range(estimate?.computePf, (value) => `${num(value, 0)} PF`)}
              tone="research"
            />
            <MetricTile
              label="Training data"
              value={range(estimate?.dataMTok, (value) => `${num(value, 0)} MTok`)}
              tone="research"
            />
            <MetricTile
              label="Runway"
              value={range(estimate?.runwayDays, (value) => `${num(value, 0)}d`)}
              tone="research"
            />
            <MetricTile label="Cash" value={range(estimate?.cash, money)} tone="research" />
          </div>
          <div className="mt-3 space-y-0.5">
            <StatRow label="Debt" value={range(estimate?.debt, money)} />
            <StatRow
              label="Service"
              value={(rival.lastUnserved ?? 0) > 0.05 ? `${pct(rival.lastUnserved ?? 0, 0)} short` : 'Healthy'}
              tone={(rival.lastUnserved ?? 0) > 0.05 ? 'danger' : 'positive'}
            />
          </div>
        </GameCard>

        {estimate?.announcedProject ? (
          <GameCard tone="train" title="Announced project">
            <p className="text-[0.8125rem] text-amber">
              <strong className="text-bone">{estimate.announcedProject}</strong>
            </p>
          </GameCard>
        ) : null}

        {competitiveResponse.active && competitiveResponse.rivalId === rival.id ? (
          <GameCard tone="mint" title="Lead challenger">
            <p className="text-[0.8125rem] text-mint">
              Capital markets are funding accelerator purchases against a{' '}
              {(competitiveResponse.shareGap * 100).toFixed(0)}-point share gap
              {competitiveResponse.capabilityGap >= 1
                ? ` and ${competitiveResponse.capabilityGap.toFixed(0)} capability-point gap.`
                : '.'}
            </p>
          </GameCard>
        ) : null}

        <GameCard eyebrow="Public fleet" title="Released models & API" tone="infer">
          <div className="overflow-x-auto rounded-lg border border-line/60">
            <table className="w-full min-w-[42rem] text-left text-[0.8125rem]">
              <thead className="bg-void/60 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-3 py-2.5">Model</th>
                  <th className="px-3 py-2.5">Capability</th>
                  <th className="px-3 py-2.5">Price in / out</th>
                  <th className="px-3 py-2.5">Speed</th>
                  <th className="px-3 py-2.5">Features</th>
                </tr>
              </thead>
              <tbody className="anim-stagger">
                {publicModels.map((model) => {
                  const input = model.apiPriceInPerMTok ?? rival.pricing.apiPriceInPerMTok
                  const output = model.apiPriceOutPerMTok ?? rival.pricing.apiPriceOutPerMTok
                  return (
                    <tr key={model.id} className="border-t border-line/70 text-bone">
                      <td className="px-3 py-3">
                        <strong className="text-[0.875rem]">{model.name}</strong>
                        <span className="mt-0.5 block text-[0.75rem] text-muted">
                          {model.backbone ?? model.family} · {num(model.paramsB, 1)}B
                        </span>
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums">{model.capability.toFixed(0)}</td>
                      <td className="px-3 py-3 font-mono tabular-nums">
                        ${input.toFixed(2)} / ${output.toFixed(2)}
                        <span className="mt-0.5 block text-[0.75rem] text-muted">
                          ${blendApiPrice(input, output).toFixed(2)} blend
                        </span>
                      </td>
                      <td className="px-3 py-3 font-mono tabular-nums">
                        {num(model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult, 0)} tok/s
                      </td>
                      <td className="px-3 py-3 text-muted">{model.modalities.join(', ')}</td>
                    </tr>
                  )
                })}
                {publicModels.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted">
                      No public release.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </GameCard>

        <GameCard eyebrow="Offers" title="Subscription offers" tone="mint">
          {(rival.pricing.plans ?? []).filter((plan) => plan.enabled).length === 0 ? (
            <EmptyState title="No public plans" description="This rival has not disclosed consumer subscription offers." />
          ) : (
            <div className="anim-stagger grid gap-2 sm:grid-cols-2">
              {(rival.pricing.plans ?? [])
                .filter((plan) => plan.enabled)
                .map((plan) => (
                  <div key={plan.id} className="rounded-lg border border-line/70 bg-void/35 px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <strong className="truncate text-[0.875rem] text-bone">{plan.name}</strong>
                      <span className="shrink-0 font-mono text-[0.875rem] tabular-nums text-mint">
                        {money(plan.pricePerMonth)}/mo
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[0.8125rem] text-muted">
                      {num(planAllowanceMTokPerMonth(plan), 2)} MTok · {plan.servePrecision ?? 'fp16'}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </GameCard>

        <div className="flex justify-end">
          <HudButton variant="ghost" onClick={() => useGameStore.getState().setPanel('market')}>
            Open market →
          </HudButton>
        </div>
      </div>
    </PanelScaffold>
  )
}
