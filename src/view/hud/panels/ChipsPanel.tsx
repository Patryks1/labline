import {
  canStartFab,
  CHIP_DESIGN_AREA_BUDGET,
  CHIP_DESIGN_TECH,
  fabPhaseLabel,
  scoreChipDesign,
} from '../../../sim/systems/silicon'
import type { ChipDesignFocus } from '../../../sim/types'
import { getResearchNode } from '../../../sim/balance/research'
import { useGameStore } from '../../../store/gameStore'
import { money, pct } from '../format'
import { ResearchUnlockLink } from '../ui/ResearchUnlockLink'
import { EmptyState, HudButton, MetricTile, PanelScaffold, StatusChip } from '../ui/HudPrimitives'
import { BlockerList, GameCard, MeterBar, StatRow } from '../ui/kit'

const CHIP_FOCUSES: { id: ChipDesignFocus; label: string; detail: string }[] = [
  { id: 'training', label: 'Training', detail: 'More PF, more power' },
  { id: 'balanced', label: 'Balanced', detail: 'Flexible accelerator' },
  { id: 'inference', label: 'Inference', detail: 'More tok/s, less power' },
]

/** Silicon = fab / custom chip campaigns only. */
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
  const fabLive = fab.phase !== 'idle' && fab.phase !== 'volume'
  const fabProgress = fab.daysRequired ? fab.daysInPhase / fab.daysRequired : 0
  const lockedTech = CHIP_DESIGN_TECH.filter(
    (tech) => !state.player.researchUnlocked.includes(tech.requiredResearch),
  )

  return (
    <PanelScaffold
      eyebrow="Hardware"
      title="Silicon"
      description="Design custom die area, then run a fab campaign."
      mobileDescription="Tune silicon and launch fab runs."
      actions={
        <HudButton type="button" variant="ghost" onClick={() => setPanel('racks')}>
          Order racks
        </HudButton>
      }
    >
      <div className="min-w-0 touch-pan-y space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Area used" value={`${design.usedArea}/${CHIP_DESIGN_AREA_BUDGET}`} tone="research" />
          <MetricTile label="Train PF" value={`×${design.trainingMult.toFixed(2)}`} />
          <MetricTile label="Infer tok/s" value={`×${design.inferenceMult.toFixed(2)}`} tone="serve" />
          <MetricTile
            label="Perf / watt"
            value={`×${design.perfPerWattMult.toFixed(2)}`}
            mobilePriority="secondary"
            tone="positive"
          />
        </div>

        <GameCard eyebrow="Architecture lab" title="Workload focus" tone="research">
          <div className="grid grid-cols-3 gap-1.5">
            {CHIP_FOCUSES.map((item) => (
              <HudButton
                key={item.id}
                type="button"
                variant="ghost"
                disabled={!editable}
                aria-pressed={focus === item.id}
                onClick={() => setChipDesignFocus(item.id)}
                className={`min-h-11 rounded-md border px-2 py-2 text-left transition disabled:opacity-45 ${
                  focus === item.id
                    ? 'border-research/55 bg-research/15 text-bone'
                    : 'border-line/70 bg-void/45 text-muted hover:border-research/30 hover:text-bone'
                }`}
              >
                <span className="block text-[0.75rem] font-semibold">{item.label}</span>
                <span className="mt-0.5 hidden text-[0.6875rem] leading-tight min-[420px]:block">{item.detail}</span>
              </HudButton>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <StatRow label="Chip power" value={`×${design.powerMult.toFixed(2)}`} />
            <StatRow label="Editable" value={editable ? 'Yes' : 'Locked mid-run'} tone={editable ? 'positive' : 'warning'} />
          </div>

          <details className="group mt-3 rounded-md border border-line/60 bg-void/30">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-2 text-[0.75rem] text-muted marker:hidden">
              <span>Architecture modifiers</span>
              <span className="shrink-0 font-mono tabular-nums text-bone">
                {selectedTech.length} selected · {design.usedArea}/{CHIP_DESIGN_AREA_BUDGET}
              </span>
            </summary>
            <div className="border-t border-line/60 p-2">
              <div className="anim-stagger grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
                {CHIP_DESIGN_TECH.map((tech) => {
                  const unlocked = state.player.researchUnlocked.includes(tech.requiredResearch)
                  const selected = selectedTech.includes(tech.id)
                  const wouldOverflow = !selected && design.usedArea + tech.area > CHIP_DESIGN_AREA_BUDGET
                  const disabled = !editable || !unlocked || wouldOverflow
                  return (
                    <HudButton
                      key={tech.id}
                      type="button"
                      variant="ghost"
                      disabled={disabled}
                      aria-pressed={selected}
                      title={
                        !unlocked
                          ? `Research: ${getResearchNode(tech.requiredResearch).name}`
                          : wouldOverflow
                            ? 'Not enough die area'
                            : !editable
                              ? 'Design locked during fab run'
                              : undefined
                      }
                      onClick={() => toggleChipDesignTech(tech.id)}
                      className={`min-h-11 rounded-lg border p-2.5 text-left transition hover-lift disabled:cursor-not-allowed ${
                        selected
                          ? 'border-research/55 bg-research/15 ring-1 ring-research/40'
                          : unlocked
                            ? 'border-line/70 bg-panel-2/70 hover:border-research/30'
                            : 'border-line/50 bg-void/35 opacity-55'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[0.75rem] font-semibold text-bone">{tech.name}</span>
                        <span className="font-mono text-[0.6875rem] tabular-nums text-research">{tech.area}</span>
                      </span>
                      <span className="mt-1 block text-[0.6875rem] leading-snug text-muted">
                        {unlocked ? tech.description : `Locked · ${getResearchNode(tech.requiredResearch).name}`}
                      </span>
                    </HudButton>
                  )
                })}
              </div>

              {lockedTech.length > 0 ? (
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {lockedTech.map((tech) => (
                    <ResearchUnlockLink key={tech.id} nodeId={tech.requiredResearch} label={`Unlock ${tech.name}`} />
                  ))}
                </div>
              ) : null}

              <HudButton type="button" variant="ghost" className="mt-2 min-h-11 w-full" onClick={() => setPanel('research')}>
                Open chip research →
              </HudButton>
            </div>
          </details>
        </GameCard>

        <GameCard
          eyebrow="Custom fab"
          title={fab.phase === 'volume' ? 'Volume online' : 'Fab campaign'}
          tone="train"
          live={fabLive}
          actions={<StatusChip tone={fabLive ? 'warning' : fab.phase === 'volume' ? 'positive' : 'neutral'}>{fabPhaseLabel(fab.phase)}</StatusChip>}
        >
          {fabLive ? (
            <div className="space-y-2">
              <MeterBar
                label={`Day ${fab.daysInPhase}/${fab.daysRequired}`}
                value={fabProgress}
                detail={`Sunk ${money(fab.cashSunk)}`}
                tone="train"
                live
              />
              {fab.phase === 'yield_ramp' ? (
                <StatRow label="Yield" value={pct(fab.yieldRate, 0)} tone="warning" />
              ) : null}
            </div>
          ) : null}

          {fab.phase === 'volume' ? (
            <p className="text-[0.8125rem] text-muted">
              {fab.chipsProduced} chips produced · batches every 14d
            </p>
          ) : null}

          {!startCheck.ok ? <BlockerList items={[{ text: startCheck.reason }]} /> : null}

          <HudButton
            type="button"
            variant="primary"
            className="mt-3 w-full"
            disabled={!startCheck.ok}
            title={startCheck.reason}
            onClick={() => startFab()}
          >
            {fab.phase === 'volume' ? 'Start next gen campaign' : 'Start fab campaign'}
          </HudButton>

          {!state.player.researchUnlocked.includes('si_arch') ? (
            <ResearchUnlockLink className="mt-2" nodeId="si_arch" label="Open Accelerator Architecture" />
          ) : null}
        </GameCard>

        {(state.player.chips?.length ?? 0) > 0 ? (
          <GameCard eyebrow="Inventory" title="Legacy / fab chips" mobilePriority="secondary">
            <ul className="anim-stagger space-y-1">
              {state.player.chips.map((c) => (
                <li key={c.defId}>
                  <StatRow label={c.defId} value={String(c.count)} tone="positive" strong />
                </li>
              ))}
            </ul>
          </GameCard>
        ) : (
          <EmptyState title="No fab inventory" description="Volume campaigns stock chips here. Prefer hall racks for new capacity." />
        )}
      </div>
    </PanelScaffold>
  )
}
