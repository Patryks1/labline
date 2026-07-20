import { useMemo, useState } from 'react'
import { blendApiPrice } from '../../../sim/balance/pricing'
import { planAllowanceMTokPerMonth } from '../../../sim/systems/plans'
import { competitiveCatchUpSnapshot } from '../../../sim/systems/sharedMarkets'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'

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

  if (!rival) return <p className="text-sm text-muted">No rival labs in this campaign.</p>
  const estimate = rival.publicEstimate
  const publicModels = rival.models.filter((model) => model.release === 'released' || model.shipped)
  const competitiveResponse = competitiveCatchUpSnapshot(state)

  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Rival intelligence</h2>
        <p className="hud-panel-sub">Public offers, disclosed projects, and uncertain operating ranges.</p>
      </div>

      <section className="rounded-xl border border-line bg-panel-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">Market position</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted">Select a rival to inspect its public intelligence.</p>
          </div>
          <span className="shrink-0 font-mono text-sm text-research">{pct(rival.marketShare, 1)}</span>
        </div>
        <div className="mt-3 space-y-2">
          {[
            { id: 'player', name: 'You', share: state.player.finance.totalShare },
            ...rankedRivals.map((entry) => ({ id: entry.id, name: entry.name, share: entry.marketShare })),
          ]
            .toSorted((left, right) => right.share - left.share)
            .map((entry) => {
              const selected = entry.id === rival.id
              const isPlayer = entry.id === 'player'
              return (
                <button
                  key={entry.id}
                  type="button"
                  disabled={isPlayer}
                  aria-pressed={selected}
                  onClick={() => setSelectedId(entry.id)}
                  className={`grid w-full grid-cols-[5rem_minmax(0,1fr)_3rem] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.6875rem] transition-colors ${
                    selected
                      ? 'bg-research/10 ring-1 ring-research/35'
                      : isPlayer
                        ? 'cursor-default bg-mint/5'
                        : 'hover:bg-void/55'
                  }`}
                >
                  <span className={`truncate ${selected ? 'font-semibold text-research' : isPlayer ? 'text-mint' : 'text-muted'}`}>
                    {entry.name}
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-void">
                    <span
                      className={`block h-full rounded-full ${isPlayer ? 'bg-mint' : selected ? 'bg-research' : 'bg-line'}`}
                      style={{ width: `${Math.min(100, entry.share * 100)}%` }}
                    />
                  </span>
                  <span className="text-right font-mono text-bone">{pct(entry.share, 0)}</span>
                </button>
              )
            })}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-panel-2 p-3">
        <h3 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">Estimated range</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <RangeRail label="Compute" values={estimate?.computePf} format={(value) => `${num(value, 0)} PF`} />
          <RangeRail label="Training data" values={estimate?.dataMTok} format={(value) => `${num(value, 0)} MTok`} />
          <RangeRail label="Runway" values={estimate?.runwayDays} format={(value) => `${num(value, 0)}d`} />
          <RangeRail label="Cash" values={estimate?.cash} format={money} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5"><IntelStat label="Debt" value={range(estimate?.debt, money)} /><IntelStat label="Service" value={(rival.lastUnserved ?? 0) > 0.05 ? `${pct(rival.lastUnserved ?? 0, 0)} short` : 'Healthy'} /><IntelStat label="Confidence" value={estimate ? pct(estimate.confidence, 0) : '—'} /></div>
      </section>

      {estimate?.announcedProject && (
        <div className="rounded-xl border border-amber/30 bg-amber/5 px-3 py-2 text-[0.8125rem] text-amber">
          Announced: <strong className="text-bone">{estimate.announcedProject}</strong>
        </div>
      )}

      {competitiveResponse.active && competitiveResponse.rivalId === rival.id && (
        <div className="rounded-xl border border-mint/35 bg-mint/5 px-3 py-2 text-[0.8125rem] text-mint">
          <strong className="text-bone">Lead challenger:</strong> capital markets are funding
          accelerator purchases and scale-up against a{' '}
          {(competitiveResponse.shareGap * 100).toFixed(0)}-point share gap
          {competitiveResponse.capabilityGap >= 1
            ? ` and ${competitiveResponse.capabilityGap.toFixed(0)} capability-point gap.`
            : '.'}
        </div>
      )}

      <section className="space-y-1.5">
        <h3 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">Released models & API</h3>
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[44rem] text-left text-[0.75rem]">
            <thead className="bg-void/60 font-mono text-muted">
              <tr>
                <th className="px-2 py-1.5">Model</th><th className="px-2 py-1.5">Capability</th>
                <th className="px-2 py-1.5">Input / output</th><th className="px-2 py-1.5">Speed</th>
                <th className="px-2 py-1.5">Features</th><th className="px-2 py-1.5">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {publicModels.map((model) => {
                const input = model.apiPriceInPerMTok ?? rival.pricing.apiPriceInPerMTok
                const output = model.apiPriceOutPerMTok ?? rival.pricing.apiPriceOutPerMTok
                return (
                  <tr key={model.id} className="border-t border-line/70 text-bone">
                    <td className="px-2 py-2"><strong>{model.name}</strong><span className="block text-muted">{model.backbone ?? model.family} · {num(model.paramsB, 1)}B</span></td>
                    <td className="px-2 py-2 font-mono">{model.capability.toFixed(0)}</td>
                    <td className="px-2 py-2 font-mono">${input.toFixed(2)} / ${output.toFixed(2)}<span className="block text-muted">${blendApiPrice(input, output).toFixed(2)} blend</span></td>
                    <td className="px-2 py-2 font-mono">{num(model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult, 0)} tok/s</td>
                    <td className="px-2 py-2">{model.modalities.join(', ')}</td>
                    <td className="px-2 py-2">{model.outcome ? `${model.outcome.kind} · ${model.outcome.yieldMultiplier.toFixed(3)}×` : 'not disclosed'}</td>
                  </tr>
                )
              })}
              {publicModels.length === 0 && <tr><td colSpan={6} className="px-3 py-5 text-center text-muted">No public release.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">Subscription offers</h3>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {(rival.pricing.plans ?? []).filter((plan) => plan.enabled).map((plan) => (
            <div key={plan.id} className="rounded-xl border border-line bg-panel-2 px-2.5 py-2">
              <div className="flex justify-between text-sm text-bone"><strong>{plan.name}</strong><span className="font-mono">{money(plan.pricePerMonth)}/mo</span></div>
              <div className="mt-1 font-mono text-[0.6875rem] text-muted">{num(planAllowanceMTokPerMonth(plan), 2)} MTok included · {plan.servePrecision ?? 'fp16'}</div>
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}

function IntelStat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg border border-line/70 bg-void/35 px-2 py-1.5"><div className="truncate text-[0.5625rem] uppercase tracking-wider text-muted">{label}</div><div className="mt-0.5 truncate font-mono text-[0.75rem] text-bone" title={value}>{value}</div></div>
}

function RangeRail({ label, values, format }: { label: string; values?: [number, number]; format: (value: number) => string }) {
  const low = values?.[0] ?? 0
  const high = values?.[1] ?? 0
  const spread = high > 0 ? Math.max(.08, (high - low) / high) : 0
  return <div className="rounded-lg bg-void/40 p-2" title={`${label} is an intelligence estimate, not an exact private value.`}><div className="flex justify-between gap-2 text-[0.6875rem]"><span className="text-muted">{label}</span><span className="font-mono text-bone">{values ? `${format(low)}–${format(high)}` : '—'}</span></div><div className="mt-2 h-1.5 rounded-full bg-line/30"><div className="h-full rounded-full bg-research" style={{ marginLeft: `${Math.max(0, 100 - spread * 100)}%`, width: `${spread * 100}%` }} /></div></div>
}
