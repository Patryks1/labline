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
  const fills = state.worldMarkets.fills
  const [selectedId, setSelectedId] = useState(rivals[0]?.id ?? '')
  const rival = rivals.find((entry) => entry.id === selectedId) ?? rivals[0]
  const resourceWins = useMemo(
    () => fills.filter((fill) => fill.labId === rival?.id).slice(0, 8),
    [fills, rival?.id],
  )

  if (!rival) return <p className="text-sm text-muted">No rival labs in this campaign.</p>
  const estimate = rival.publicEstimate
  const publicModels = rival.models.filter((model) => model.release === 'released' || model.shipped)
  const competitiveResponse = competitiveCatchUpSnapshot(state)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="hud-panel-title">Rival intelligence</h2>
          <p className="hud-panel-sub">Public offers, disclosed projects, and uncertain operating ranges.</p>
        </div>
        <select
          value={rival.id}
          onChange={(event) => setSelectedId(event.target.value)}
          className="rounded-lg border border-line bg-void px-2 py-1.5 text-sm text-bone"
        >
          {rivals.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <IntelStat label="Market share" value={pct(rival.marketShare, 1)} />
        <IntelStat label="Compute estimate" value={range(estimate?.computePf, (value) => `${num(value, 0)} PF`)} />
        <IntelStat label="Data estimate" value={range(estimate?.dataMTok, (value) => `${num(value, 0)} MTok`)} />
        <IntelStat label="Runway estimate" value={range(estimate?.runwayDays, (value) => `${num(value, 0)}d`)} />
        <IntelStat label="Cash estimate" value={range(estimate?.cash, money)} />
        <IntelStat label="Debt estimate" value={range(estimate?.debt, money)} />
        <IntelStat label="Service" value={(rival.lastUnserved ?? 0) > 0.05 ? `${pct(rival.lastUnserved ?? 0, 0)} unserved` : 'Healthy'} />
        <IntelStat label="Confidence" value={estimate ? pct(estimate.confidence, 0) : '—'} />
      </div>

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

      <section className="space-y-1.5">
        <h3 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">Public resource wins</h3>
        {resourceWins.map((fill) => (
          <div key={fill.id} className="flex justify-between rounded-lg border border-line/70 bg-void/35 px-2 py-1.5 font-mono text-[0.6875rem] text-muted">
            <span>D{fill.day} · {fill.kind} · {fill.resourceId}</span>
            <span className="text-bone">{num(fill.quantity, 1)} @ {money(fill.unitPrice)}</span>
          </div>
        ))}
        {resourceWins.length === 0 && <p className="text-[0.75rem] text-muted">No disclosed shared-market wins yet.</p>}
      </section>

      <p className="text-[0.6875rem] text-muted">
        Intelligence never reveals exact private cash, corpus mix, bids, research choice, or deterministic outcome seed.
      </p>
    </div>
  )
}

function IntelStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-line bg-panel-2 px-2.5 py-2"><div className="text-[0.625rem] uppercase tracking-wider text-muted">{label}</div><div className="mt-0.5 font-mono text-[0.8125rem] text-bone">{value}</div></div>
}
