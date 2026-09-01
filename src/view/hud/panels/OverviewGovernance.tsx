import { useState } from 'react'
import type { SimState } from '../../../sim/types'
import { setAutomationPolicies } from '../../../sim/systems/automation'
import { useGameStore } from '../../../store/gameStore'
import { money, num, pct } from '../format'
import { HudButton, StatusChip } from '../ui/HudPrimitives'
import { StatRow } from '../ui/kit'
import { hudDesktopDefaultDisclosureOpen } from '../ui/hudDesktopDisclosure'

const POLICY_DEFS = [
  [
    'overflowCloud',
    'Overflow cloud',
    'Lease capped emergency PF when serving load exceeds the target.',
  ],
  [
    'allocation',
    'Compute allocation',
    'Rebalance train, serve, and research pools with serving headroom.',
  ],
  [
    'dataProcessing',
    'Data processing',
    'Keep raw domain stock flowing into the finite processing queue.',
  ],
  [
    'fleetDeployment',
    'Fleet deployment',
    'Review capacity weekly and order suitable racks within budget.',
  ],
  [
    'productCapacity',
    'Product capacity',
    'Balance API and subscription priority from observed pressure.',
  ],
] as const

type PolicyKey = (typeof POLICY_DEFS)[number][0]

/**
 * Overview owns governance policy. InfrastructureOverview stays focused on
 * sites, fleet capacity, construction, and deployment operations.
 */
export function OverviewGovernance({ state }: { state: SimState }) {
  const [expanded, setExpanded] = useState(hudDesktopDefaultDisclosureOpen)
  const applyState = (next: SimState) => useGameStore.setState({ state: next })
  const advanced = state.config.campaignRules.externalityMode === 'advanced'
  const account = state.externalities?.accounts[state.playerLabId]
  const incidents = (state.externalities?.incidents ?? []).filter(
    (incident) => incident.labId === state.playerLabId,
  )
  const enabledPolicies = POLICY_DEFS.filter(([key]) => state.automation[key].enabled).length

  return (
    <section className="rounded-lg border border-line bg-panel-2 p-3">
      <div className="flex flex-col gap-2 min-[420px]:flex-row min-[420px]:items-start min-[420px]:justify-between">
        <div className="min-w-0">
          <p className="hud-eyebrow">Overview / governance</p>
          <h3 className="text-[0.9375rem] font-semibold text-bone">Policies & externalities</h3>
          <p className="mt-1 max-w-[65ch] text-[0.75rem] leading-relaxed text-muted">
            {advanced
              ? 'Rules meter carbon, cooling water, provenance, and deployment audits across the lab.'
              : 'Standard mode keeps safety and reliability in products while advanced externality costs stay off.'}
          </p>
        </div>
        <StatusChip tone={advanced ? 'warning' : 'positive'}>
          {advanced ? 'Advanced' : 'Standard'} · {enabledPolicies}/5 live
        </StatusChip>
      </div>

      <HudButton
        type="button"
        variant="ghost"
        aria-expanded={expanded}
        aria-controls="overview-governance-details"
        className="mt-3 w-full justify-between border border-line/70 bg-void/30 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{expanded ? 'Hide governance details' : 'Review governance & policies'}</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </HudButton>

      {expanded ? (
        <div id="overview-governance-details" className="mt-3 space-y-3">
          {advanced && account ? (
            <div className="grid grid-cols-2 gap-x-3 border-b border-line/70 pb-2">
              <StatRow label="Energy this month" value={`${num(account.energyMWh, 0)} MWh`} />
              <StatRow label="Compliance spend" value={money(account.complianceCost)} />
              <StatRow
                label="Carbon allocation"
                value={`${num(account.carbonTons, 0)} / ${num(account.carbonBudgetTons, 0)} t`}
                tone={account.carbonTons > account.carbonBudgetTons ? 'danger' : 'neutral'}
              />
              <StatRow
                label="Water allocation"
                value={`${num(account.waterM3, 0)} / ${num(account.waterBudgetM3, 0)} m³`}
                tone={account.waterM3 > account.waterBudgetM3 ? 'danger' : 'neutral'}
              />
              <StatRow label="Data-rights risk" value={pct(account.rightsRisk)} />
              <StatRow label="Deployment-audit risk" value={pct(account.auditRisk)} />
            </div>
          ) : null}

          {advanced && account ? (
            <div className="rounded-lg border border-line/70 bg-void/35 p-2.5">
              <div className="flex justify-between text-[0.75rem] text-muted">
                <span>Enforcement record</span>
                <span className="font-mono">
                  {account.violations} finding{account.violations === 1 ? '' : 's'}
                </span>
              </div>
              {incidents.length === 0 ? (
                <p className="mt-1 text-[0.75rem] text-muted">No published enforcement actions.</p>
              ) : (
                incidents.slice(0, 4).map((incident) => (
                  <div
                    key={incident.id}
                    className="mt-1.5 border-t border-line/60 pt-1.5 text-[0.75rem] text-bone"
                  >
                    {incident.description}
                    <span className="ml-1 font-mono text-danger">−{money(incident.fine)}</span>
                  </div>
                ))
              )}
            </div>
          ) : null}

          <div>
            <div className="mb-2">
              <h4 className="text-[0.8125rem] font-medium text-bone">Operating policies</h4>
              <p className="mt-0.5 text-[0.75rem] text-muted">
                Persistent guardrails prepare the next day through normal quotes, budgets, and order queues.
              </p>
            </div>
            <div className="space-y-1.5">
              {POLICY_DEFS.map(([key, label, description]) => {
                const policyKey = key as PolicyKey
                const enabled = state.automation[policyKey].enabled
                return (
                  <HudButton
                    key={policyKey}
                    type="button"
                    variant={enabled ? 'secondary' : 'ghost'}
                    aria-pressed={enabled}
                    onClick={() =>
                      applyState(
                        setAutomationPolicies(state, {
                          [policyKey]: { ...state.automation[policyKey], enabled: !enabled },
                        }),
                      )
                    }
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-line/70 bg-void/35 px-2.5 py-2 text-left hover:border-mint/40"
                  >
                    <span>
                      <span className="block text-[0.8125rem] text-bone">{label}</span>
                      <span className="block text-[0.6875rem] leading-snug text-muted">{description}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[0.625rem] uppercase text-muted">
                      {enabled ? 'On' : 'Off'}
                    </span>
                  </HudButton>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
