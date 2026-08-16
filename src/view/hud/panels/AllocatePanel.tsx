import { useMemo, type ReactNode } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { computeSnapshot } from '../../../sim/tick'
import { fleetHostSnapshot } from '../../../sim/systems/hosting'
import { hostedModelOpexDay } from '../../../sim/balance/hostingOpex'
import { formatParams } from '../../../sim/balance/training'
import { gb, money, num, pct, pf, people } from '../format'
import { EmptyState, HudButton, HudRange, MetricTile, PanelScaffold } from '../ui/HudPrimitives'
import { GameCard, MeterBar, StatRow } from '../ui/kit'
import { buildFinanceDashboardModel } from '../data/financeDashboardModel'

export function AllocatePanel() {
  const state = useGameStore((s) => s.state)
  const setPanel = useGameStore((s) => s.setPanel)
  const setAllocation = useGameStore((s) => s.setAllocation)
  const autoBalanceHosting = useGameStore((s) => s.autoBalanceHosting)
  const financeModel = useMemo(() => buildFinanceDashboardModel(state), [state])
  const snap = computeSnapshot(state)
  const host = fleetHostSnapshot(state)
  // Per-model hosting residency + endpoint upkeep (load term shown in finance).
  const hostOpex = hostedModelOpexDay(state, 0)
  const hostOpexByModel = new Map(hostOpex.models.map((m) => [m.modelId, m]))
  const serveMemFit = snap.serveMemFit ?? 1
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
            <StatRow
              label="Memory fit"
              value={pct(serveMemFit, 0)}
              tone={serveMemFit < 0.999 ? 'danger' : 'positive'}
            />
            <StatRow
              label="Hosting opex"
              value={`${money(financeModel.costs.hosting)}/d`}
              tone={financeModel.costs.hosting > 0 ? 'warning' : 'neutral'}
            />
          </div>
          {serveMemFit < 0.999 ? (
            <p className="mt-1.5 text-[0.75rem] text-amber">
              Hosted model does not fit fleet memory — serving degraded, not stopped.
              Throughput runs at {pct(serveMemFit, 0)} while weights stream from slower
              tiers. Add HBM or ship a smaller deployment to restore full speed.
            </p>
          ) : null}
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
              label="HBM have / need"
              value={`${gb(host.vramHave)} / ${gb(host.vramNeed)}`}
              tone={host.vramHave < host.vramNeed ? 'danger' : 'positive'}
            />
            <StatRow
              label="Host RAM have / need"
              value={`${gb(host.systemRamHave)} / ${gb(host.systemRamNeed)}`}
              tone={host.systemRamHave < host.systemRamNeed ? 'danger' : 'positive'}
            />
            <StatRow
              label="Serve PF have / need"
              value={`${pf(host.pfServe)} / ${pf(host.pfNeed)}`}
              tone={host.pfServe < host.pfNeed * 0.75 ? 'warning' : 'neutral'}
            />
            <StatRow
              label="Compute coverage"
              value={pct(Math.min(host.computeCoverage, 2), 0)}
              tone={host.computeCoverage < 0.85 ? 'warning' : 'positive'}
            />
            <StatRow
              label="Bottleneck"
              value={host.shortOn === 'ok' ? 'balanced' : host.shortOn}
              tone={host.shortOn === 'ok' ? 'positive' : 'danger'}
            />
          </div>
          <div className="mt-2 space-y-1.5">
            <MeterBar
              label="HBM cover"
              value={Math.min(1, host.vramCoverage)}
              detail={`${Math.min(120, host.vramCoverage * 100).toFixed(0)}%`}
              tone={host.vramCoverage >= 0.95 ? 'positive' : 'warning'}
            />
            <MeterBar
              label="Host RAM cover"
              value={Math.min(1, host.systemRamCoverage)}
              detail={`${Math.min(120, host.systemRamCoverage * 100).toFixed(0)}%`}
              tone={host.systemRamCoverage >= 1 ? 'positive' : 'warning'}
            />
            <MeterBar
              label="Compute coverage"
              value={Math.min(1, host.computeCoverage)}
              detail={`${Math.min(120, host.computeCoverage * 100).toFixed(0)}%`}
              tone={host.computeCoverage >= 0.85 ? 'positive' : 'warning'}
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
                    {hostOpexByModel.has(m.modelId)
                      ? ` · host ${money(
                          (hostOpexByModel.get(m.modelId)!.residencyDay +
                            hostOpexByModel.get(m.modelId)!.endpointDay),
                        )}/d`
                      : ''}
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
                <HudRange
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
          <StatRow label="Valuation" value={money(financeModel.current.valuation)} strong />
          <StatRow
            label="Share / subs"
            value={`${pct(financeModel.current.share, 1)} · ${people(
              state.lastMarket.planStats?.reduce((s, p) => s + p.subscribers, 0) ?? 0,
            )}`}
          />
        </GameCard>

        <ol className="anim-stagger space-y-1.5 text-[0.8125rem]">
          <Step done={snap.rackCap > 0 && snap.mwAvailable > 0.01} n={1}>
            <HudButton
              type="button"
              variant="ghost"
              className="min-h-11 !p-0 text-left hover:text-mint"
              onClick={() => useGameStore.getState().openSites()}
            >
              Build data hall + interconnect
            </HudButton>
          </Step>
          <Step done={snap.chipCount > 0} n={2}>
            <HudButton type="button" variant="ghost" className="min-h-11 !p-0 text-left hover:text-mint" onClick={() => setPanel('racks')}>
              Order racks into the hall
            </HudButton>
          </Step>
          <Step done={state.player.models.length > 0} n={3}>
            <HudButton type="button" variant="ghost" className="min-h-11 !p-0 text-left hover:text-mint" onClick={() => setPanel('models')}>
              Train & ship a model
            </HudButton>
          </Step>
          <Step
            done={state.lastMarket.planStats?.some((p) => p.subscribers > 0) ?? false}
            n={4}
          >
            <HudButton type="button" variant="ghost" className="min-h-11 !p-0 text-left hover:text-mint" onClick={() => setPanel('plans')}>
              Design plans & watch unit economics
            </HudButton>
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
