import { useGameStore } from '../../store/gameStore'
import { money, num, pct } from './format'

export function RightPanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const alerts = state.alerts.slice(0, 7)
  const f = state.player.finance
  const dayNet =
    typeof f.dayNet === 'number' ? f.dayNet : f.dayRevenue - f.dayCogs - f.dayEnergyCost
  const enterpriseApiRevenue = f.enterpriseRevenue * 0.5
  const enterpriseSubRevenue = f.enterpriseRevenue - enterpriseApiRevenue

  return (
    <aside className="pointer-events-auto relative z-20 flex h-full w-[300px] shrink-0 flex-col border-l border-line/80 bg-panel/95 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-line/80 px-3 py-2.5">
        <h2 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">P&L today</h2>
        <button
          type="button"
          onClick={() => setPanel('stats')}
          className="font-mono text-[0.75rem] text-mint hover:underline"
        >
          Full stats →
        </button>
      </div>
      <div className="space-y-1.5 border-b border-line/80 p-3 font-mono text-xs">
        <Row label="API revenue" value={money(f.apiRevenue + enterpriseApiRevenue)} />
        <Row label="↳ enterprise API" value={money(enterpriseApiRevenue)} />
        <Row label="Sub revenue" value={money(f.subRevenue + enterpriseSubRevenue)} />
        <Row label="↳ enterprise seats" value={money(enterpriseSubRevenue)} />
        <Row label="API COGS" value={money(-f.apiCogs)} danger />
        <Row label="Sub COGS" value={money(-f.subCogs)} danger />
        <Row label="Energy" value={money(-f.dayEnergyCost)} danger />
        <Row label="Facility opex" value={money(-f.dayBuildingOpex)} danger />
        <Row label="Wages" value={money(-f.dayWageCost)} danger />
        <Row label="Marketing" value={money(-(f.dayMarketing ?? 0))} danger />
        <Row label="Chip amort" value={money(-f.dayChipAmort)} danger />
        <div className="my-1 h-px bg-line" />
        <Row
          label="Day net"
          value={money(dayNet)}
          danger={dayNet < 0}
          strong
        />
        <Row
          label="Margin / sub (mo)"
          value={money(f.marginPerSub)}
          danger={f.marginPerSub < 0}
          strong
        />
        <Row
          label="Margin / MTok"
          value={money(f.marginPerMTok)}
          danger={f.marginPerMTok < 0}
          strong
        />
        <Row label="Valuation" value={money(f.valuation)} strong />
        {Number.isFinite(f.runwayDays) && f.runwayDays < 9000 && (
          <Row
            label="Runway"
            value={`${Math.floor(f.runwayDays)}d`}
            danger={f.runwayDays < 30}
          />
        )}
      </div>

      {state.lastMarket.planStats.length > 0 && (
        <>
          <div className="border-b border-line/80 px-3 py-2.5">
            <h2 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
              Plans today
            </h2>
          </div>
          <div className="max-h-36 space-y-1.5 overflow-y-auto border-b border-line/80 p-3 font-mono text-[0.75rem]">
            {state.lastMarket.planStats.map((p) => (
              <div key={p.planId} className="rounded-lg border border-line bg-panel-2 px-2 py-1.5">
                <div className="flex justify-between text-bone">
                  <span>{p.name}</span>
                  <span>{Math.round(p.subscribers).toLocaleString()} subs</span>
                </div>
                <div className="mt-0.5 flex justify-between text-muted">
                  <span>{money(p.dayRevenue)} rev</span>
                  <span className={p.marginPerSubMonth < 0 ? 'text-danger' : 'text-mint'}>
                    {money(p.marginPerSubMonth)}/sub mo
                  </span>
                </div>
                <div className="mt-0.5 flex justify-between text-muted">
                  <span>COGS {money(p.dayCogs)}</span>
                  <span>{p.dayMTok.toFixed(2)} MTok</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="border-b border-line/80 px-3 py-2.5">
        <h2 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
          Rivals · {pct(1 - f.totalShare, 0)} vs you
        </h2>
      </div>
      <div className="panel-scroll max-h-[220px] space-y-1.5 overflow-y-auto border-b border-line/80 p-3">
        {state.rivals.map((r) => {
          const m = r.models[0]
          const overloaded = (r.lastUnserved ?? 0) > 0.12
          return (
            <div key={r.id} className="rounded-xl border border-line bg-panel-2 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-bone">{r.name}</span>
                <span className="font-mono text-[0.8125rem] text-muted">
                  {(r.marketShare * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-1 font-mono text-[0.75rem] leading-snug text-muted">
                {m ? `${m.name} · cap ${m.capability.toFixed(0)}` : '—'} · $
                {r.pricing.apiPricePerMTok.toFixed(1)}/MTok
              </div>
              <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
                {num(r.flopsPf, 0)} PF ·{' '}
                <span className={overloaded ? 'text-danger' : 'text-mint'}>
                  {overloaded
                    ? `${((r.lastUnserved ?? 0) * 100).toFixed(0)}% short`
                    : 'capacity ok'}
                </span>
                {r.dayRevenue != null && r.dayRevenue > 0 && (
                  <span className="text-muted"> · day {money(r.dayRevenue)}</span>
                )}
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-void">
                <div
                  className="h-full bg-infer/80"
                  style={{ width: `${Math.min(100, r.marketShare * 100)}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-b border-line/80 px-3 py-2.5">
        <h2 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">Feed</h2>
      </div>
      <div className="panel-scroll flex-1 space-y-1.5 overflow-y-auto p-3">
        {alerts.map((a) => (
          <div
            key={a.id}
            className={`rounded-lg border px-2.5 py-1.5 text-[0.8125rem] leading-snug ${
              a.severity === 'danger'
                ? 'border-danger/30 bg-danger/10 text-danger'
                : a.severity === 'warn'
                  ? 'border-amber/30 bg-amber/10 text-amber'
                  : 'border-line bg-panel-2 text-muted'
            }`}
          >
            {a.message}
          </div>
        ))}
        {state.news.slice(0, 3).map((n, i) => (
          <div
            key={i}
            className="rounded-lg border border-line/50 px-2.5 py-1.5 text-[0.8125rem] text-muted"
          >
            {n}
          </div>
        ))}
      </div>
    </aside>
  )
}

function Row({
  label,
  value,
  danger,
  strong,
}: {
  label: string
  value: string
  danger?: boolean
  strong?: boolean
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`${strong ? 'font-medium' : ''} ${danger ? 'text-danger' : 'text-bone'}`}>
        {value}
      </span>
    </div>
  )
}
