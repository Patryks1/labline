import { CheckCircle, Crosshair, WarningCircle } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { useGameStore } from '../../store/gameStore'
import { useUiStore } from '../../store/uiStore'
import { buildObjectives, type Objective } from './objectives'
import { StatusChip } from './ui/HudPrimitives'

export function ObjectivesButton() {
  const state = useGameStore((s) => s.state)
  const open = useUiStore((s) => s.objectivesOpen)
  const setOpen = useUiStore((s) => s.setObjectivesOpen)
  const objectives = useMemo(
    () => buildObjectives(state, !state.onboardingDismissed),
    [state],
  )
  const urgent = objectives.find((objective) => objective.severity !== 'info')

  return (
    <button
      type="button"
      aria-expanded={open}
      aria-pressed={open}
      title="Objectives and operational risks"
      onClick={() => setOpen(!open)}
      className={`hidden h-8 max-w-[15rem] items-center gap-1.5 rounded-lg border px-2 text-[0.75rem] lg:flex 2xl:gap-2 2xl:px-2.5 ${
        urgent
          ? 'border-amber/35 bg-amber/10 text-amber'
          : 'border-line/70 bg-void/40 text-muted hover:text-bone'
      }`}
    >
      <Crosshair size="1rem" weight="duotone" />
      <span className="hidden truncate 2xl:inline">{urgent?.title ?? objectives[0]?.title ?? 'Objectives clear'}</span>
      <span className="font-mono text-[0.625rem]">{objectives.length}</span>
    </button>
  )
}

export function ObjectivesDock() {
  const state = useGameStore((s) => s.state)
  const open = useUiStore((s) => s.objectivesOpen)
  const setOpen = useUiStore((s) => s.setObjectivesOpen)
  const setPanel = useGameStore((s) => s.setPanel)
  const setBuildMode = useGameStore((s) => s.setBuildMode)
  const setOnboardingDismissed = useGameStore((s) => s.setOnboardingDismissed)
  const objectives = useMemo(
    () => buildObjectives(state, !state.onboardingDismissed),
    [state],
  )

  if (!open) return null

  const activate = (objective: Objective) => {
    if (objective.buildKind) setBuildMode(objective.buildKind)
    else setPanel(objective.panel)
    setOpen(false)
  }

  return (
    <aside className="objectives-dock hud-surface pointer-events-auto absolute z-40 w-[21rem] rounded-lg p-3">
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div>
          <p className="hud-eyebrow">Mission control</p>
          <h2 className="mt-1 text-[1rem] font-semibold tracking-tight text-bone">Next decisions</h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex min-h-11 items-center justify-center rounded-lg px-3 text-[0.6875rem] font-semibold text-muted hover:bg-panel-2 hover:text-bone"
        >
          Done
        </button>
      </div>

      <div className="relative z-10 mt-3 space-y-2">
        {objectives.length > 0 ? objectives.map((objective) => (
          <button
            key={objective.id}
            type="button"
            onClick={() => activate(objective)}
            className="objective-row group min-h-11 w-full rounded-lg border border-line/70 bg-panel-2/70 p-3 text-left hover:border-mint/35 hover:bg-panel-2"
          >
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 ${objective.severity === 'danger' ? 'text-danger' : objective.severity === 'warning' ? 'text-amber' : 'text-mint'}`}>
                {objective.severity === 'info' ? <Crosshair size="1rem" /> : <WarningCircle size="1rem" weight="fill" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.8125rem] font-semibold text-bone">{objective.title}</span>
                <span className="mt-1 block text-[0.75rem] leading-snug text-muted">{objective.description}</span>
                <span className="mt-2 flex items-center justify-between gap-2">
                  <StatusChip tone={objective.severity === 'danger' ? 'danger' : objective.severity === 'warning' ? 'warning' : 'positive'}>
                    {objective.progress}
                  </StatusChip>
                  <span className="text-[0.75rem] font-medium text-mint group-hover:underline">{objective.actionLabel}</span>
                </span>
              </span>
            </div>
          </button>
        )) : (
          <div className="flex items-center gap-3 rounded-lg border border-mint/25 bg-mint/5 p-3 text-[0.8125rem] text-muted">
            <CheckCircle size="1.25rem" className="text-mint" /> No immediate operational risks.
          </div>
        )}
      </div>

      <div className="relative z-10 mt-3 flex items-center justify-between border-t border-line/60 pt-3">
        <span className="text-[0.6875rem] text-muted">Starter guidance</span>
        <button
          type="button"
          onClick={() => setOnboardingDismissed(!state.onboardingDismissed)}
          className="min-h-11 px-2 text-[0.75rem] font-medium text-mint hover:underline"
        >
          {state.onboardingDismissed ? 'Enable' : 'Hide'}
        </button>
      </div>
    </aside>
  )
}
