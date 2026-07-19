import { useState } from 'react'
import { SEGMENTS, WORLD_POPULATION } from '../../../sim/balance/economy'
import { useGameStore } from '../../../store/gameStore'
import { audience, money, num, pct, people } from '../format'

export function MarketPanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const shares = state.lastMarket.sharesByLab
  const labs = [
    { id: 'player', name: 'You' },
    ...state.rivals.map((r) => ({ id: r.id, name: r.name })),
  ]
  const colors = [
    'var(--color-mint)',
    'var(--color-infer)',
    'var(--color-amber)',
    'var(--color-research)',
    'var(--color-danger)',
    'color-mix(in srgb, var(--color-bone) 48%, transparent)',
  ]
  const shareRows = labs.map((lab, index) => ({
    ...lab,
    value: Math.max(0, shares[lab.id] ?? 0),
    color: colors[index % colors.length]!,
  }))
  const shareTotal = Math.max(0.0001, shareRows.reduce((sum, row) => sum + row.value, 0))
  const [activeLabId, setActiveLabId] = useState('player')
  const activeShare = shareRows.find((row) => row.id === activeLabId) ?? shareRows[0]!
  const circumference = 2 * Math.PI * 42
  const aiUsers = state.segments.reduce((sum, segment) => sum + Math.max(0, segment.size), 0)
  const peopleToConvert = Math.max(0, WORLD_POPULATION - aiUsers)
  let cumulativeShare = 0

  return (
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">Market</h2>
        <p className="hud-panel-sub">
          Share and billing settle from tokens actually served after compute capacity. Rivals use
          the same rule. Intel is also on the right dock (F3).
        </p>
      </div>

      <div className="rounded-2xl border border-line bg-panel-2 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] text-muted">Market share</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted/80">Hover or focus a slice</p>
          </div>
          <div className="relative h-32 w-32 shrink-0" aria-label="Interactive market share chart">
            <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90 overflow-visible">
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke="color-mix(in srgb, var(--color-line) 70%, transparent)"
                strokeWidth="16"
              />
              {shareRows.map((row) => {
                const arcShare = row.value / shareTotal
                const dash = arcShare * circumference
                const offset = -cumulativeShare * circumference
                cumulativeShare += arcShare
                if (dash < 0.1) return null
                return (
                  <circle
                    key={row.id}
                    cx="50"
                    cy="50"
                    r="42"
                    fill="none"
                    stroke={row.color}
                    strokeWidth={activeShare.id === row.id ? 19 : 16}
                    strokeDasharray={`${dash} ${circumference - dash}`}
                    strokeDashoffset={offset}
                    className="cursor-pointer transition-[stroke-width,opacity] duration-150 focus:outline-none"
                    opacity={activeShare.id === row.id ? 1 : 0.74}
                    tabIndex={0}
                    role="button"
                    aria-label={`${row.name}: ${pct(row.value, 1)} market share`}
                    onMouseEnter={() => setActiveLabId(row.id)}
                    onFocus={() => setActiveLabId(row.id)}
                    onClick={() => setActiveLabId(row.id)}
                  >
                    <title>{`${row.name}: ${pct(row.value, 1)}`}</title>
                  </circle>
                )
              })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="max-w-16 truncate text-[0.6875rem] text-muted">{activeShare.name}</span>
              <strong className="font-mono text-[0.9375rem] text-bone">
                {pct(activeShare.value, 1)}
              </strong>
            </div>
          </div>
        </div>
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono text-[0.75rem]">
          {shareRows.map((row) => (
            <button
              type="button"
              key={row.id}
              className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left transition ${
                activeShare.id === row.id
                  ? 'border-line bg-void/55 text-bone'
                  : 'border-transparent text-muted hover:bg-void/30 hover:text-bone'
              }`}
              onMouseEnter={() => setActiveLabId(row.id)}
              onFocus={() => setActiveLabId(row.id)}
              onClick={() => setActiveLabId(row.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span className="truncate">{row.name}</span>
              </span>
              <span className="text-bone">{pct(row.value, 1)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-panel-2 p-3 font-mono text-xs">
        <div className="flex justify-between">
          <span className="text-muted">Industry demand / served</span>
          <span className="text-bone">
            {num(state.lastMarket.industryDemandMTok ?? state.lastMarket.demandMTok, 0)} /{' '}
            {num(state.lastMarket.industryServedMTok ?? state.lastMarket.servedMTok, 0)} MTok
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">AI users / world</span>
          <span className="text-bone">
            {audience(aiUsers)} / {audience(WORLD_POPULATION)}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Remaining to convert</span>
          <span className="text-bone">
            {audience(peopleToConvert)} · {pct(aiUsers / WORLD_POPULATION, 0)} active
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Paid / free subs</span>
          <span className="text-bone">
            {people(
              state.lastMarket.planStats
                ?.filter((p) => !p.isFree)
                .reduce((s, p) => s + p.subscribers, 0) ?? 0,
            )}
            {' / '}
            {people(
              state.lastMarket.planStats
                ?.filter((p) => p.isFree)
                .reduce((s, p) => s + p.subscribers, 0) ?? 0,
            )}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Your demand</span>
          <span>{num(state.lastMarket.playerDemandMTok, 1)} MTok/d</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Served</span>
          <span>{num(state.lastMarket.servedMTok, 1)} MTok/d</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Inference need / pool</span>
          <span
            className={
              (state.lastMarket.demandPf ?? 0) > (state.lastMarket.capacityPf ?? 0) * 1.02
                ? 'text-danger'
                : 'text-bone'
            }
          >
            {num(state.lastMarket.demandPf ?? 0, 2)} / {num(state.lastMarket.capacityPf ?? 0, 2)} PF
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Admitted inference</span>
          <span className="text-bone">{num(state.lastMarket.servedPf ?? 0, 2)} PF</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Token capacity (equiv.)</span>
          <span className="text-bone">
            {num(state.lastMarket.capacityMTok ?? 0, 1)} MTok/d
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Unserved</span>
          <span className={state.lastMarket.unservedRatio > 0.08 ? 'text-danger' : ''}>
            {pct(state.lastMarket.unservedRatio, 0)}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Campus latency</span>
          <span>{num(state.lastMarket.latencyScore, 0)}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Felt latency (w/ load)</span>
          <span
            className={
              (state.lastMarket.effectiveLatencyScore ?? state.lastMarket.latencyScore) < 40
                ? 'text-danger'
                : (state.lastMarket.effectiveLatencyScore ?? 99) < 55
                  ? 'text-amber'
                  : 'text-bone'
            }
          >
            {num(state.lastMarket.effectiveLatencyScore ?? state.lastMarket.latencyScore, 0)}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Service pain</span>
          <span
            className={
              (state.lastMarket.servicePain ?? state.player.servicePain ?? 0) > 0.2
                ? 'text-danger'
                : (state.lastMarket.servicePain ?? 0) > 0.08
                  ? 'text-amber'
                  : 'text-bone'
            }
          >
            {pct(state.lastMarket.servicePain ?? state.player.servicePain ?? 0, 0)}
          </span>
        </div>
        {state.lastMarket.unservedRatio > 0.08 &&
          (state.lastMarket.demandPf ?? 0) > (state.lastMarket.capacityPf ?? 0) * 1.02 && (
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1.5 text-[0.75rem] leading-snug text-danger">
            Overload: demand exceeds inference PF (need {num(state.lastMarket.demandPf ?? 0, 1)} /
            have {num(state.lastMarket.capacityPf ?? 0, 1)}). Add racks, power, Serve %, or ship
            serving-efficiency research.
          </p>
        )}
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Margin / MTok</span>
          <span
            className={state.player.finance.marginPerMTok < 0 ? 'text-danger' : 'text-mint'}
          >
            {money(state.player.finance.marginPerMTok)}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Margin / sub</span>
          <span className={state.player.finance.marginPerSub < 0 ? 'text-danger' : 'text-mint'}>
            {money(state.player.finance.marginPerSub)}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">Day net</span>
          <span
            className={
              (state.player.finance.dayNet ?? 0) < 0 ? 'text-danger' : 'text-mint'
            }
          >
            {money(state.player.finance.dayNet ?? 0)}
          </span>
        </div>
        <button
          type="button"
          className="mt-2 text-[0.8125rem] text-mint hover:underline"
          onClick={() => setPanel('stats')}
        >
          Full financial breakdown →
        </button>
      </div>

      <div>
        <h3 className="mb-1.5 text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
          Segments
        </h3>
        <div className="space-y-1.5">
          {SEGMENTS.map((s) => {
            const st = state.segments.find((x) => x.id === s.id)
            return (
              <div key={s.id} className="rounded-xl border border-line px-2.5 py-2">
                <div className="flex justify-between text-sm">
                  <span className="text-bone">{s.name}</span>
                  <span className="font-mono text-[0.8125rem] text-muted">
                    {st ? audience(st.size) : ''}
                  </span>
                </div>
                <p className="mt-0.5 text-[0.75rem] text-muted">
                  floor {s.qualityFloor} · cares{' '}
                  {Object.entries(s.benchmarkWeights)
                    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                    .slice(0, 3)
                    .map(([k]) => k)
                    .join(', ')}
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
