import type { ReactNode } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { computeSnapshot } from '../../../sim/tick'
import { fleetHostSnapshot } from '../../../sim/systems/hosting'
import { formatParams } from '../../../sim/balance/training'
import { gb, money, num, pct, pf, people } from '../format'
import { EmptyState, HudButton, MetricTile, PanelScaffold } from '../ui/HudPrimitives'
import { GameCard, MeterBar, StatRow } from '../ui/kit'

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

  const poolUtil = Math.min(
    1.25,
    (state.lastMarket.demandPf ?? 0) /
      Math.max(0.01, state.lastMarket.capacityPf ?? snap.pools.inference),
  )
  const poolOk =
    (state.lastMarket.demandPf ?? 0) <=
    (state.lastMarket.capacityPf ?? snap.pools.inference) * 1.05

  return (
    <PanelScaffold
      eyebrow="Legacy"
      title="Compute ops"
      description="Serve slider covers all API + sub traffic."
      actions={
        <HudButton type="button" variant="ghost" onClick={() => autoBalanceHosting()}>
          Auto-balance ~80%
        </HudButton>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Raw PF" value={pf(snap.rawFlopsPf)} />
          <MetricTile label="Effective PF" value={pf(snap.effectiveFlopsPf)} tone="positive" />
          <MetricTile label="Util cap" value={pct(snap.utilCap, 0)} />
          <MetricTile
            label="Power derate"
            value={pct(snap.powerDerate, 0)}
            tone={snap.throttled ? 'danger' : 'neutral'}
          />
        </div>

        <GameCard eyebrow="Inference" title="Shared pool" tone="infer">
          <div className="space-y-0.5">
            <StatRow label="Serve allocation" value={pct(a.inference, 0)} tone="serve" />
            <StatRow
              label="Pool PF"
              value={pf(state.lastMarket.capacityPf ?? snap.pools.inference)}
            />
            <StatRow
              label="Traffic PF"
              value={pf(state.lastMarket.demandPf ?? 0)}
              tone={
                (state.lastMarket.demandPf ?? 0) >
                (state.lastMarket.capacityPf ?? snap.pools.inference) * 1.02
                  ? 'danger'
                  : 'positive'
              }
            />
            <StatRow
              label="Tokens / demand"
              value={`${num(state.lastMarket.servedMTok, 1)} / ${num(state.lastMarket.playerDemandMTok, 1)} MTok`}
            />
            <StatRow
              label="Unserved"
              value={pct(state.lastMarket.unservedRatio, 0)}
              tone={state.lastMarket.unservedRatio > 0.08 ? 'danger' : 'positive'}
            />
          </div>
          <div className="mt-2">
            <MeterBar
              label="Pool util"
              value={Math.min(1, poolUtil)}
              detail={`${(poolUtil * 100).toFixed(0)}%`}
              tone={poolOk ? 'serve' : 'warning'}
            />
          </div>
        </GameCard>

        <GameCard
          eyebrow="Hosting"
          title="Model halls"
          actions={
            <HudButton type="button" variant="ghost" onClick={() => autoBalanceHosting()}>
              Auto-balance
            </HudButton>
          }
        >
          <div className="space-y-0.5">
            <StatRow
              label="VRAM have / need"
              value={`${gb(host.vramHave)} / ${gb(host.vramNeed)}`}
              tone={host.vramHave < host.vramNeed ? 'danger' : 'positive'}
            />
            <StatRow
              label="Serve PF have / need"
              value={`${pf(host.pfServe)} / ${pf(host.pfNeed)}`}
              tone={host.pfServe < host.pfNeed * 0.75 ? 'warning' : 'neutral'}
            />
            <StatRow
              label="Compute util"
              value={pct(Math.min(host.computeUtil, 2), 0)}
              tone={
                host.computeUtil < 0.65
                  ? 'warning'
                  : host.computeUtil > 1.05
                    ? 'danger'
                    : 'positive'
              }
            />
            <StatRow
              label="Short on"
              value={host.shortOn === 'ok' ? 'balanced' : host.shortOn}
              tone={host.shortOn === 'ok' ? 'positive' : 'danger'}
            />
          </div>
          <div className="mt-2 space-y-1.5">
            <MeterBar
              label="VRAM cover"
              value={Math.min(1, host.vramUtil)}
              detail={`${Math.min(120, host.vramUtil * 100).toFixed(0)}%`}
              tone={host.vramUtil >= 0.95 ? 'positive' : 'warning'}
            />
            <MeterBar
              label="Compute util"
              value={Math.min(1, host.computeUtil)}
              detail={`${Math.min(120, host.computeUtil * 100).toFixed(0)}%`}
              tone={host.computeUtil >= 0.7 && host.computeUtil <= 1.05 ? 'positive' : 'warning'}
            />
          </div>

          {host.models.length === 0 ? (
            <div className="mt-2">
              <EmptyState title="No models hosted" description="Release a model to see hosting needs." />
            </div>
          ) : (
            <div className="anim-stagger mt-2 space-y-1.5">
              {host.models.map((m) => (
                <div
                  key={m.modelId}
                  className="rounded-lg border border-line/70 bg-void/45 px-2.5 py-2"
                >
                  <div className="flex justify-between gap-2 text-[0.8125rem]">
                    <span className="truncate font-medium text-bone">{m.name}</span>
                    <span className="shrink-0 font-mono tabular-nums text-muted">
                      {formatParams(m.paramsB)}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-[0.75rem] tabular-nums text-muted">
                    {gb(m.vramGb)} · {pf(m.hostPf)} · compute {pct(m.computeBias, 0)}
                  </p>
                </div>
              ))}
            </div>
          )}
          {host.recommendedSkuReason ? (
            <p className="mt-2 text-[0.75rem] text-muted">{host.recommendedSkuReason}</p>
          ) : null}
        </GameCard>

        <GameCard eyebrow="Pools" title="Split">
          <div className="space-y-3">
            {(
              [
                ['training', 'Training', 'text-train', a.training, 'train'] as const,
                ['inference', 'Serve', 'text-infer', a.inference, 'serve'] as const,
                ['research', 'Research', 'text-research', a.research, 'research'] as const,
              ]
            ).map(([key, label, cls, val, tone]) => (
              <label key={key} className="block text-[0.8125rem]">
                <div className="flex justify-between gap-2">
                  <span className={cls}>{label}</span>
                  <span className="font-mono tabular-nums text-bone">
                    {pct(val, 0)} ·{' '}
                    {pf(
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
                <MeterBar value={val} tone={tone} />
              </label>
            ))}
          </div>
        </GameCard>

        <GameCard>
          <StatRow label="Valuation" value={money(state.player.finance.valuation)} strong />
          <StatRow
            label="Share / subs"
            value={`${pct(state.player.finance.totalShare, 1)} · ${people(
              state.lastMarket.planStats?.reduce((s, p) => s + p.subscribers, 0) ?? 0,
            )}`}
          />
        </GameCard>

        <ol className="anim-stagger space-y-1.5 text-[0.8125rem]">
          <Step done={snap.rackCap > 0 && snap.mwAvailable > 0.01} n={1}>
            <button
              type="button"
              className="text-left hover:text-mint"
              onClick={() => useGameStore.getState().openSites()}
            >
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
          <Step
            done={state.lastMarket.planStats?.some((p) => p.subscribers > 0) ?? false}
            n={4}
          >
            <button type="button" className="text-left hover:text-mint" onClick={() => setPanel('plans')}>
              Design plans & watch unit economics
            </button>
          </Step>
        </ol>
      </div>
    </PanelScaffold>
  )
}

function Step({ done, n, children }: { done: boolean; n: number; children: ReactNode }) {
  return (
    <li className={`flex gap-2 ${done ? 'text-mint' : 'text-muted'}`}>
      <span className="font-mono text-[0.75rem] tabular-nums opacity-70">{n}.</span>
      <span>{children}</span>
    </li>
  )
}
