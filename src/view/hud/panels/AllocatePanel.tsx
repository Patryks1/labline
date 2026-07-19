import type { ReactNode } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { computeSnapshot } from '../../../sim/tick'
import { fleetHostSnapshot } from '../../../sim/systems/hosting'
import { formatParams } from '../../../sim/balance/training'
import { gb, money, num, pct, pf, people } from '../format'

export function AllocatePanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const setAllocation = useGameStore((s) => s.setAllocation)
  const autoBalanceHosting = useGameStore((s) => s.autoBalanceHosting)
  const snap = computeSnapshot(state)
  const host = fleetHostSnapshot(state)
  const a = state.player.allocation

  const setSplit = (key: 'training' | 'inference' | 'research', v: number) => {
    const next = { ...a, [key]: Math.max(0.05, v) }
    const sum = next.training + next.inference + next.research
    setAllocation({
      training: next.training / sum,
      inference: next.inference / sum,
      research: next.research / sum,
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">Compute ops</h2>
        <p className="hud-panel-sub">
          The Serve slider is the inference budget for <strong className="text-bone">all</strong> API
          + sub traffic. Demand = users × usage × model size. One hall alone cannot hold double-digit
          share — grow racks, power, and Serve %.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Raw PF" value={pf(snap.rawFlopsPf)} />
        <Stat label="Effective PF" value={pf(snap.effectiveFlopsPf)} mint />
        <Stat label="Util cap" value={pct(snap.utilCap, 0)} />
        <Stat label="Serving eff" value={pct(state.player.servingEfficiency, 0)} />
        <Stat label="Fleet VRAM" value={gb(snap.vramGb)} />
        <Stat label="PUE" value={num(state.player.pue, 2)} />
        <Stat label="Racks" value={num(snap.chipCount, 0)} />
        <Stat label="Power derate" value={pct(snap.powerDerate, 0)} danger={snap.throttled} />
      </div>

      {/* Live traffic vs inference pool — makes the Serve slider meaningful */}
      <div className="rounded-2xl border border-line bg-panel-2 p-3 space-y-2">
        <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
          Inference load (shared pool)
        </h3>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[0.75rem] text-muted">
          <span>Serve allocation</span>
          <span className="text-right text-infer">{pct(a.inference, 0)}</span>
          <span>Pool PF (have)</span>
          <span className="text-right text-bone">
            {pf(state.lastMarket.capacityPf ?? snap.pools.inference)}
          </span>
          <span>Traffic PF (need)</span>
          <span
            className={`text-right ${
              (state.lastMarket.demandPf ?? 0) >
              (state.lastMarket.capacityPf ?? snap.pools.inference) * 1.02
                ? 'text-danger'
                : 'text-mint'
            }`}
          >
            {pf(state.lastMarket.demandPf ?? 0)}
          </span>
          <span>Tokens served / demand</span>
          <span className="text-right text-bone">
            {num(state.lastMarket.servedMTok, 1)} / {num(state.lastMarket.playerDemandMTok, 1)} MTok
          </span>
          <span>Unserved</span>
          <span
            className={`text-right ${
              state.lastMarket.unservedRatio > 0.08 ? 'text-danger' : 'text-mint'
            }`}
          >
            {pct(state.lastMarket.unservedRatio, 0)}
          </span>
        </div>
        <Bar
          label="Pool util (traffic / serve PF)"
          value={Math.min(
            1.25,
            (state.lastMarket.demandPf ?? 0) /
              Math.max(0.01, state.lastMarket.capacityPf ?? snap.pools.inference),
          )}
          ok={
            (state.lastMarket.demandPf ?? 0) <=
            (state.lastMarket.capacityPf ?? snap.pools.inference) * 1.05
          }
        />
        <p className="text-[0.75rem] leading-snug text-muted">
          Raising Serve % steals PF from train/research and raises capacity. Serving-efficiency
          research lowers PF per token so more users fit. Bigger models burn more
          PF per token — high-usage plans need more halls.
        </p>
      </div>

      {/* Hosting balance */}
      <div className="rounded-2xl border border-line bg-panel-2 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
            Model hosting (data halls)
          </h3>
          <button
            type="button"
            className="rounded-full bg-mint/20 px-2.5 py-1 text-[0.75rem] font-medium text-mint"
            onClick={() => autoBalanceHosting()}
          >
            Auto-balance ~80%
          </button>
        </div>
        <p className="text-[0.75rem] leading-snug text-muted">
          Targets ~80% serve compute util and enough VRAM. Orders recommended racks into free bays
          when short.
        </p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[0.75rem] text-muted">
          <span>VRAM have / need</span>
          <span
            className={`text-right ${host.vramHave < host.vramNeed ? 'text-danger' : 'text-mint'}`}
          >
            {gb(host.vramHave)} / {gb(host.vramNeed)}
          </span>
          <span>Serve PF have / need</span>
          <span
            className={`text-right ${host.pfServe < host.pfNeed * 0.75 ? 'text-amber' : 'text-bone'}`}
          >
            {pf(host.pfServe)} / {pf(host.pfNeed)}
          </span>
          <span>Compute util (target 80%)</span>
          <span
            className={`text-right ${
              host.computeUtil < 0.65
                ? 'text-amber'
                : host.computeUtil > 1.05
                  ? 'text-danger'
                  : 'text-mint'
            }`}
          >
            {pct(Math.min(host.computeUtil, 2), 0)}
          </span>
          <span>Short on</span>
          <span
            className={`text-right ${
              host.shortOn === 'ok' ? 'text-mint' : 'text-danger'
            }`}
          >
            {host.shortOn === 'ok' ? 'balanced' : host.shortOn}
          </span>
        </div>

        {/* Bars */}
        <Bar
          label="VRAM cover"
          value={Math.min(1.2, host.vramUtil)}
          ok={host.vramUtil >= 0.95}
        />
        <Bar
          label="Compute util"
          value={Math.min(1.2, host.computeUtil)}
          ok={host.computeUtil >= 0.7 && host.computeUtil <= 1.05}
        />

        {host.models.length === 0 ? (
          <p className="text-[0.75rem] text-muted">Release a model to see hosting needs.</p>
        ) : (
          <div className="space-y-1.5">
            {host.models.map((m) => (
              <div
                key={m.modelId}
                className="rounded-lg border border-line bg-void/50 px-2 py-1.5 text-[0.75rem]"
              >
                <div className="flex justify-between font-medium text-bone">
                  <span>{m.name}</span>
                  <span className="font-mono text-muted">{formatParams(m.paramsB)}</span>
                </div>
                <div className="mt-0.5 font-mono text-muted">
                  Host {gb(m.vramGb)} VRAM · {pf(m.hostPf)} serve PF
                  {m.activeParamsB < m.paramsB * 0.99
                    ? ` · act ${m.activeParamsB.toFixed(1)}B / tot ${m.paramsB.toFixed(0)}B`
                    : ''}{' '}
                  · compute {pct(m.computeBias, 0)} · RAM {pct(m.ramBias, 0)}
                </div>
                <p className="mt-0.5 text-muted">{m.note}</p>
              </div>
            ))}
          </div>
        )}

        <p className="text-[0.75rem] text-muted">{host.recommendedSkuReason}</p>
      </div>

      {/* Manual split */}
      <div className="rounded-2xl border border-line bg-panel-2 p-3 space-y-3">
        <h3 className="text-[0.8125rem] font-medium text-muted">Pool split</h3>
        {(
          [
            ['training', 'Training', 'text-train', a.training],
            ['inference', 'Serve', 'text-infer', a.inference],
            ['research', 'Research', 'text-research', a.research],
          ] as const
        ).map(([key, label, cls, val]) => (
          <label key={key} className="block text-[0.75rem] text-muted">
            <div className="flex justify-between">
              <span className={cls}>{label}</span>
              <span className="font-mono text-bone">
                {pct(val, 0)} · {pf(
                  key === 'training'
                    ? snap.pools.training
                    : key === 'inference'
                      ? snap.pools.inference
                      : snap.pools.research,
                )}
              </span>
            </div>
            <input
              type="range"
              min={0.05}
              max={0.9}
              step={0.01}
              value={val}
              onChange={(e) => setSplit(key, Number(e.target.value))}
              className="mt-1 w-full"
            />
          </label>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-panel-2 p-3 text-xs">
        <div className="flex justify-between text-muted">
          <span>Valuation</span>
          <span className="font-mono text-bone">{money(state.player.finance.valuation)}</span>
        </div>
        <div className="mt-1 flex justify-between text-muted">
          <span>Share / subs (paid plans)</span>
          <span className="font-mono text-bone">
            {pct(state.player.finance.totalShare, 1)} ·{' '}
            {people(
              state.lastMarket.planStats?.reduce((s, p) => s + p.subscribers, 0) ?? 0,
            )}
          </span>
        </div>
      </div>

      <ol className="space-y-2 text-xs">
        <Step done={snap.rackCap > 0 && snap.mwAvailable > 0.01} n={1}>
          <button type="button" className="text-left hover:text-mint" onClick={() => useGameStore.getState().openSites()}>
            Build data hall + interconnect
          </button>
        </Step>
        <Step done={snap.chipCount > 0} n={2}>
          <button type="button" className="text-left hover:text-mint" onClick={() => setPanel('racks')}>
            Order racks into the hall
          </button>
        </Step>
        <Step done={state.player.models.length > 0} n={3}>
          <button type="button" className="text-left hover:text-mint" onClick={() => setPanel('models')}>
            Train & ship a model
          </button>
        </Step>
        <Step done={(state.lastMarket.planStats?.some((p) => p.subscribers > 0) ?? false)} n={4}>
          <button type="button" className="text-left hover:text-mint" onClick={() => setPanel('plans')}>
            Design plans & watch unit economics
          </button>
        </Step>
      </ol>
    </div>
  )
}

function Bar({ label, value, ok }: { label: string; value: number; ok: boolean }) {
  const w = Math.min(100, Math.max(0, value * 100))
  return (
    <div>
      <div className="flex justify-between text-[0.6875rem] text-muted">
        <span>{label}</span>
        <span className={ok ? 'text-mint' : 'text-amber'}>{w.toFixed(0)}%</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-void">
        <div
          className={`h-full ${ok ? 'bg-mint' : 'bg-amber'}`}
          style={{ width: `${w}%` }}
        />
      </div>
    </div>
  )
}

function Step({ done, n, children }: { done: boolean; n: number; children: ReactNode }) {
  return (
    <li className={`flex gap-2 ${done ? 'text-mint' : 'text-muted'}`}>
      <span className="font-mono text-[0.75rem] opacity-70">{n}.</span>
      <span>{children}</span>
    </li>
  )
}

function Stat({
  label,
  value,
  mint,
  danger,
}: {
  label: string
  value: string
  mint?: boolean
  danger?: boolean
}) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-2.5 py-2">
      <div className="text-[0.75rem] text-muted">{label}</div>
      <div
        className={`mt-0.5 font-mono text-sm ${
          danger ? 'text-danger' : mint ? 'text-mint' : 'text-bone'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
