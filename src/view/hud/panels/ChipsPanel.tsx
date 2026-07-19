import {
  canStartFab,
  CHIP_DESIGN_AREA_BUDGET,
  CHIP_DESIGN_TECH,
  fabPhaseLabel,
  scoreChipDesign,
} from '../../../sim/systems/silicon'
import { getResearchNode } from '../../../sim/balance/research'
import type { ChipDesignFocus } from '../../../sim/types'
import { useGameStore } from '../../../store/gameStore'
import { money, pct } from '../format'

const CHIP_FOCUSES: { id: ChipDesignFocus; label: string; detail: string }[] = [
  { id: 'training', label: 'Training', detail: 'More PF, more power' },
  { id: 'balanced', label: 'Balanced', detail: 'Flexible accelerator' },
  { id: 'inference', label: 'Inference', detail: 'More tok/s, less power' },
]

/**
 * Silicon = fab / custom chip campaigns only.
 * Commodity accelerators are ordered as complete racks from the Racks / Sites panel.
 */
export function ChipsPanel() {
  const state = useGameStore((s) => s.state)
  const startFab = useGameStore((s) => s.startFab)
  const setChipDesignFocus = useGameStore((s) => s.setChipDesignFocus)
  const toggleChipDesignTech = useGameStore((s) => s.toggleChipDesignTech)
  const setPanel = useGameStore((s) => s.setPanel)
  const fab = state.player.fab
  const focus = fab.designFocus ?? 'balanced'
  const selectedTech = fab.designTechIds ?? []
  const design = scoreChipDesign(focus, selectedTech)
  const editable = fab.phase === 'idle' || fab.phase === 'volume'
  const startCheck = canStartFab(state)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">Silicon</h2>
        <p className="hud-panel-sub">
          Custom silicon is a long bet after research + fab campus. Day-to-day compute comes from{' '}
          <button type="button" className="text-mint" onClick={() => setPanel('racks')}>
            ordering racks
          </button>{' '}
          into data halls — not buying loose GPUs.
        </p>
      </div>

      <div className="rounded-2xl border border-mint/25 bg-mint/5 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-bone">Chip architecture lab</h3>
            <p className="mt-1 text-[0.75rem] leading-snug text-muted">
              Pick a workload target, then spend limited die area on researched technology blocks.
            </p>
          </div>
          <span className="shrink-0 font-mono text-[0.75rem] text-mint">
            Area {design.usedArea}/{CHIP_DESIGN_AREA_BUDGET}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-1">
          {CHIP_FOCUSES.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={!editable}
              aria-pressed={focus === item.id}
              onClick={() => setChipDesignFocus(item.id)}
              className={`rounded-lg border px-2 py-2 text-left disabled:opacity-45 ${
                focus === item.id
                  ? 'border-mint/55 bg-mint/15 text-bone'
                  : 'border-line bg-void/45 text-muted hover:border-mint/30'
              }`}
            >
              <span className="block text-[0.75rem] font-semibold">{item.label}</span>
              <span className="mt-0.5 block text-[0.625rem] leading-tight">{item.detail}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[0.6875rem]">
          <DesignMetric label="Training PF" value={`×${design.trainingMult.toFixed(2)}`} />
          <DesignMetric label="Inference tok/s" value={`×${design.inferenceMult.toFixed(2)}`} />
          <DesignMetric label="Chip power" value={`×${design.powerMult.toFixed(2)}`} />
          <DesignMetric label="Perf / watt" value={`×${design.perfPerWattMult.toFixed(2)}`} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {CHIP_DESIGN_TECH.map((tech) => {
            const unlocked = state.player.researchUnlocked.includes(tech.requiredResearch)
            const selected = selectedTech.includes(tech.id)
            const wouldOverflow = !selected && design.usedArea + tech.area > CHIP_DESIGN_AREA_BUDGET
            return (
              <button
                key={tech.id}
                type="button"
                disabled={!editable || !unlocked || wouldOverflow}
                aria-pressed={selected}
                onClick={() => toggleChipDesignTech(tech.id)}
                className={`min-h-[5.5rem] rounded-lg border p-2.5 text-left transition disabled:cursor-not-allowed ${
                  selected
                    ? 'border-mint/55 bg-mint/15'
                    : unlocked
                      ? 'border-line bg-panel-2 hover:border-mint/30'
                      : 'border-line/60 bg-void/35 opacity-55'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[0.75rem] font-semibold text-bone">{tech.name}</span>
                  <span className="font-mono text-[0.625rem] text-mint">{tech.area} area</span>
                </span>
                <span className="mt-1 block text-[0.6875rem] leading-snug text-muted">
                  {unlocked ? tech.description : `Research: ${getResearchNode(tech.requiredResearch).name}`}
                </span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          className="mt-3 text-[0.75rem] font-medium text-mint hover:underline"
          onClick={() => setPanel('research')}
        >
          Open chip research tree →
        </button>
      </div>

      <div className="rounded-2xl border border-amber/25 bg-amber/5 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-bone">Custom fab</h3>
          <span className="font-mono text-[0.75rem] text-amber">{fabPhaseLabel(fab.phase)}</span>
        </div>
        {fab.phase !== 'idle' && fab.phase !== 'volume' && (
          <div className="mt-2">
            <div className="flex justify-between font-mono text-[0.75rem] text-muted">
              <span>
                Day {fab.daysInPhase}/{fab.daysRequired}
              </span>
              <span>Sunk {money(fab.cashSunk)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-void">
              <div
                className="h-full bg-amber"
                style={{
                  width: `${fab.daysRequired ? (fab.daysInPhase / fab.daysRequired) * 100 : 0}%`,
                }}
              />
            </div>
            {fab.phase === 'yield_ramp' && (
              <p className="mt-1 font-mono text-[0.75rem] text-muted">
                Yield {pct(fab.yieldRate, 0)}
              </p>
            )}
          </div>
        )}
        {fab.phase === 'volume' && (
          <p className="mt-2 text-[0.8125rem] text-muted">
            Volume online · {fab.chipsProduced} chips produced · ongoing batches every 14d
          </p>
        )}
        <button
          type="button"
          onClick={() => startFab()}
          disabled={!startCheck.ok}
          title={startCheck.reason}
          className="btn-primary mt-3 w-full disabled:opacity-40"
        >
          {fab.phase === 'volume' ? 'Start next gen campaign' : 'Start fab campaign'}
        </button>
        <p className="mt-2 text-[0.75rem] leading-snug text-muted">
          {startCheck.ok
            ? 'Ready for tape-out. Multi-phase: architecture → tape-out → queue → yield → volume.'
            : startCheck.reason}
        </p>
      </div>

      {(state.player.chips?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-line bg-panel-2 p-3">
          <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
            Legacy / fab inventory
          </h3>
          <p className="mt-1 text-[0.75rem] text-muted">
            Older loose chips still contribute to fleet FLOPS. Prefer hall racks for new capacity.
          </p>
          <ul className="mt-2 space-y-1 font-mono text-[0.8125rem] text-bone">
            {state.player.chips.map((c) => (
              <li key={c.defId} className="flex justify-between">
                <span>{c.defId}</span>
                <span className="text-mint">{c.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DesignMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-lg border border-line/70 bg-void/45 px-2 py-1.5 text-muted">
      {label}
      <strong className="float-right text-bone">{value}</strong>
    </span>
  )
}
