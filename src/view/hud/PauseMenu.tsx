import { useEffect, useState } from 'react'
import {
  MANUAL_SLOTS,
  type SaveSlotId,
} from '../../sim/save'
import { useGameStore } from '../../store/gameStore'
import {
  RENDER_PRESETS,
  type InterfaceScale,
  type RenderPreset,
  useResolvedUiScale,
  useUiStore,
} from '../../store/uiStore'
import { money } from './format'
import { ArrowsOut, Eye, Monitor, X } from '@phosphor-icons/react'

const SCALE_OPTIONS: { value: InterfaceScale; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 0.8, label: '80%' },
  { value: 0.9, label: '90%' },
  { value: 1, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.25, label: '125%' },
  { value: 1.5, label: '150%' },
]

/**
 * In-run pause menu: resume, save/load slots, return to main menu.
 */
export function PauseMenu() {
  const open = useGameStore((s) => s.pauseMenuOpen)
  const setOpen = useGameStore((s) => s.setPauseMenuOpen)
  const setPaused = useGameStore((s) => s.setPaused)
  const autoPause = useGameStore((s) => s.state.config.campaignRules.autoPause)
  const setAutoPause = useGameStore((s) => s.setAutoPause)
  const saveGame = useGameStore((s) => s.saveGame)
  const loadGame = useGameStore((s) => s.loadGame)
  const deleteSave = useGameStore((s) => s.deleteSave)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const saves = useGameStore((s) => s.saveSlots)
  const saveStatus = useGameStore((s) => s.saveStatus)
  const lifecycleError = useGameStore((s) => s.lifecycleError)
  const newGame = useGameStore((s) => s.newGame)
  const onboardingDismissed = useGameStore((s) => s.state.onboardingDismissed)
  const setOnboardingDismissed = useGameStore((s) => s.setOnboardingDismissed)
  const interfaceScale = useUiStore((s) => s.interfaceScale)
  const setInterfaceScale = useUiStore((s) => s.setInterfaceScale)
  const renderPreset = useUiStore((s) => s.renderPreset)
  const setRenderPreset = useUiStore((s) => s.setRenderPreset)
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const setReducedMotion = useUiStore((s) => s.setReducedMotion)
  const resolvedScale = useResolvedUiScale()
  const [msg, setMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<'main' | 'save' | 'load' | 'interface'>('main')
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    action: string
    onConfirm: () => void
  } | null>(null)
  const [savesTick, setSavesTick] = useState(0)
  useEffect(() => {
    if (open) void refreshSaves()
  }, [open, refreshSaves])
  void savesTick
  const bySlot = Object.fromEntries(saves.map((m) => [m.slotId, m])) as Partial<
    Record<SaveSlotId, (typeof saves)[0]>
  >

  if (!open) return null

  const onSave = async (slotId: SaveSlotId) => {
    const r = await saveGame(slotId)
    if (r.ok) {
      setMsg(`Saved to slot ${slotId === 'auto' ? 'Autosave' : slotId}.`)
      setSavesTick((n) => n + 1)
      setTab('main')
    } else {
      setMsg(r.error)
    }
  }

  const onLoad = (slotId: SaveSlotId) => {
    setConfirm({
      title: 'Load this save?',
      body: 'Current progress since the last save will be lost.',
      action: 'Load save',
      onConfirm: () => {
        void loadGame(slotId).then((result) => {
          if (!result.ok) setMsg(result.error)
        })
      },
    })
  }

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="hud-surface relative w-full max-w-[32rem] overflow-hidden rounded-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-bone">
            {tab === 'main' ? 'Paused' : tab === 'save' ? 'Save run' : tab === 'load' ? 'Load run' : 'Interface'}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-full px-2 py-0.5 text-[0.8125rem] text-muted hover:bg-panel-2 hover:text-bone"
          >
            Esc
          </button>
        </div>

        {(msg ?? lifecycleError) && (
          <p className="mb-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[0.8125rem] text-mint">
            {msg ?? lifecycleError}
          </p>
        )}

        {saveStatus === 'saving' && (
          <p className="mb-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            Writing campaign data…
          </p>
        )}

        {tab === 'main' && (
          <div className="space-y-1.5">
            <MenuBtn
              primary
              label="Resume"
              onClick={() => {
                setOpen(false)
                setPaused(false)
              }}
            />
            <MenuBtn
              label="Save…"
              onClick={() => {
                setMsg(null)
                setTab('save')
              }}
            />
            <MenuBtn
              label="Load…"
              onClick={() => {
                setMsg(null)
                setTab('load')
              }}
            />
            <MenuBtn
              label="Quick save (autosave)"
              onClick={() => void onSave('auto')}
            />
            <MenuBtn
              label="Interface settings"
              onClick={() => {
                setMsg(null)
                setTab('interface')
              }}
            />
            <MenuBtn
              danger
              label="Return to main menu"
              onClick={() => {
                setConfirm({
                  title: 'Return to the main menu?',
                  body: 'Unsaved progress will be lost. The autosave still contains the last completed day.',
                  action: 'Return to menu',
                  onConfirm: () => {
                    setOpen(false)
                    void newGame()
                  },
                })
              }}
            />
          </div>
        )}

        {(tab === 'save' || tab === 'load') && (
          <div className="space-y-2">
            <button
              type="button"
              className="text-[0.8125rem] text-mint hover:underline"
              onClick={() => {
                setTab('main')
                setMsg(null)
              }}
            >
              ← Back
            </button>
            <SlotList
              mode={tab}
              bySlot={bySlot}
              onSave={onSave}
              onLoad={onLoad}
              onDelete={(id) => {
                setConfirm({
                  title: `Delete slot ${id}?`,
                  body: 'This save cannot be recovered after deletion.',
                  action: 'Delete save',
                  onConfirm: () => {
                    void deleteSave(id).then(() => {
                      setMsg(`Deleted slot ${id}.`)
                      setSavesTick((n) => n + 1)
                    })
                  },
                })
              }}
            />
          </div>
        )}

        {tab === 'interface' && (
          <div className="space-y-4">
            <button
              type="button"
              className="text-[0.75rem] text-mint hover:underline"
              onClick={() => setTab('main')}
            >
              ← Back
            </button>

            <section className="rounded-xl border border-line/70 bg-panel-2/70 p-3.5">
              <div className="flex items-start gap-3">
                <Monitor size="1.25rem" className="mt-0.5 text-mint" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[0.875rem] font-semibold text-bone">Render preset</h3>
                  <p className="mt-1 text-[0.75rem] leading-snug text-muted">
                    Pixel ratio, decorative traffic, and LOD transition timing.
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-1.5">
                    {([
                      ['performance', 'Performance'],
                      ['balanced', 'Balanced'],
                      ['quality', 'Quality'],
                    ] as const).map(([id, label]) => {
                      const preset = RENDER_PRESETS[id as RenderPreset]
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={renderPreset === id}
                          onClick={() => setRenderPreset(id)}
                          className={`rounded-lg border px-2 py-2 text-left transition ${
                            renderPreset === id
                              ? 'border-mint/50 bg-mint/15 text-mint'
                              : 'border-line bg-void/35 text-muted hover:text-bone'
                          }`}
                        >
                          <strong className="block text-[0.75rem]">{label}</strong>
                          <span className="mt-1 block font-mono text-[0.625rem] tabular-nums opacity-80">
                            {preset.pixelRatio}× · {preset.decorativeTraffic ? 'traffic' : 'no traffic'} · {preset.lodTransitionMs}ms
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-line/70 bg-panel-2/70 p-3.5">
              <div className="flex items-start gap-3">
                <Monitor size="1.25rem" className="mt-0.5 text-mint" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[0.875rem] font-semibold text-bone">Interface scale</h3>
                      <p className="mt-1 text-[0.75rem] leading-snug text-muted">
                        Auto follows display height. Ultrawide width does not enlarge controls.
                      </p>
                    </div>
                    <span className="status-chip status-chip--positive">{Math.round(resolvedScale * 100)}%</span>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {SCALE_OPTIONS.map((option) => (
                      <button
                        key={String(option.value)}
                        type="button"
                        onClick={() => setInterfaceScale(option.value)}
                        className={`min-h-9 rounded-lg border px-2 font-mono text-[0.6875rem] transition ${
                          interfaceScale === option.value
                            ? 'border-mint/50 bg-mint/15 text-mint'
                            : 'border-line bg-void/35 text-muted hover:text-bone'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setInterfaceScale('auto')}
                    className="mt-2 text-[0.75rem] font-medium text-mint hover:underline"
                  >
                    Reset to Auto
                  </button>
                </div>
              </div>
            </section>

            <button
              type="button"
              aria-pressed={reducedMotion}
              onClick={() => setReducedMotion(!reducedMotion)}
              className="flex w-full items-center gap-3 rounded-xl border border-line/70 bg-panel-2/70 p-3.5 text-left hover:border-mint/30"
            >
              <ArrowsOut size="1.25rem" className="text-mint" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.875rem] font-semibold text-bone">Reduce interface motion</span>
                <span className="mt-1 block text-[0.75rem] text-muted">Remove panel transitions and animated status changes.</span>
              </span>
              <span className={`status-chip ${reducedMotion ? 'status-chip--positive' : ''}`}>{reducedMotion ? 'On' : 'Off'}</span>
            </button>

            <section className="rounded-xl border border-line/70 bg-panel-2/70 p-3.5">
              <div>
                <h3 className="text-[0.875rem] font-semibold text-bone">Simulation auto-pause</h3>
                <p className="mt-1 text-[0.75rem] leading-snug text-muted">
                  Off by default. Enable only the interruptions you want; rack deliveries never stop time.
                </p>
              </div>
              <div className="mt-3 space-y-1.5">
                {([
                  ['projectComplete', 'Project completion', 'Construction, research, or model projects finish.'],
                  ['majorEvent', 'Major world event', 'A new industry event begins.'],
                  ['quarterlyReport', 'Quarterly review', 'A scheduled company review is ready.'],
                  ['runwayEmergency', 'Runway emergency', 'Cash runway falls below 60 days.'],
                ] as const).map(([key, label, description]) => {
                  const enabled = autoPause[key]
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={enabled}
                      onClick={() => setAutoPause(key, !enabled)}
                      className="flex w-full items-center gap-3 rounded-lg border border-line/60 bg-void/35 px-2.5 py-2 text-left hover:border-mint/30"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[0.8125rem] text-bone">{label}</span>
                        <span className="mt-0.5 block text-[0.6875rem] text-muted">{description}</span>
                      </span>
                      <span className={`status-chip ${enabled ? 'status-chip--positive' : ''}`}>
                        {enabled ? 'On' : 'Off'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            <button
              type="button"
              aria-pressed={!onboardingDismissed}
              onClick={() => setOnboardingDismissed(!onboardingDismissed)}
              className="flex w-full items-center gap-3 rounded-xl border border-line/70 bg-panel-2/70 p-3.5 text-left hover:border-mint/30"
            >
              <Eye size="1.25rem" className="text-mint" />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.875rem] font-semibold text-bone">Starter objectives</span>
                <span className="mt-1 block text-[0.75rem] text-muted">Show the guided launch sequence in mission control.</span>
              </span>
              <span className={`status-chip ${!onboardingDismissed ? 'status-chip--positive' : ''}`}>{onboardingDismissed ? 'Hidden' : 'Visible'}</span>
            </button>
          </div>
        )}

        {confirm ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/88 p-5 backdrop-blur-sm">
            <div className="w-full rounded-xl border border-danger/30 bg-panel p-4 shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[1rem] font-semibold text-bone">{confirm.title}</h3>
                  <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{confirm.body}</p>
                </div>
                <button type="button" aria-label="Cancel" onClick={() => setConfirm(null)} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone">
                  <X size="1rem" />
                </button>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" className="hud-button hud-button--secondary" onClick={() => setConfirm(null)}>Cancel</button>
                <button
                  type="button"
                  className="hud-button hud-button--danger"
                  onClick={() => {
                    const action = confirm.onConfirm
                    setConfirm(null)
                    action()
                  }}
                >
                  {confirm.action}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function MenuBtn({
  label,
  onClick,
  primary,
  danger,
}: {
  label: string
  onClick: () => void
  primary?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border px-3 py-2.5 text-left text-[0.8125rem] transition ${
        primary
          ? 'border-mint/40 bg-mint/15 text-mint hover:bg-mint/25'
          : danger
            ? 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/15'
            : 'border-line bg-panel-2 text-bone hover:border-mint/30'
      }`}
    >
      {label}
    </button>
  )
}

function SlotList({
  mode,
  bySlot,
  onSave,
  onLoad,
  onDelete,
}: {
  mode: 'save' | 'load'
  bySlot: Partial<Record<SaveSlotId, { labName: string; day: number; cash: number; savedAt: string; difficulty: string; compatible: boolean; version: number; incompatibilityReason?: string }>>
  onSave: (id: SaveSlotId) => void
  onLoad: (id: SaveSlotId) => void
  onDelete: (id: SaveSlotId) => void
}) {
  const slots: SaveSlotId[] = mode === 'save' ? [...MANUAL_SLOTS, 'auto'] : ['auto', ...MANUAL_SLOTS]
  return (
    <div className="space-y-1.5">
      {slots.map((id) => {
        const m = bySlot[id]
        const label = id === 'auto' ? 'Autosave' : `Slot ${id}`
        return (
          <div
            key={id}
            className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel-2 px-2.5 py-2"
          >
            <div className="min-w-0">
              <div className="text-[0.8125rem] font-medium text-bone">{label}</div>
              {m ? (
                <div className="truncate font-mono text-[0.6875rem] text-muted">
                  {m.labName} · Day {m.day} · {m.difficulty} · {money(m.cash)}
                </div>
              ) : (
                <div className="text-[0.6875rem] text-muted">Empty</div>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              {mode === 'save' && (
                <button
                  type="button"
                  className="rounded-lg bg-mint/20 px-2 py-1 text-[0.75rem] text-mint"
                  onClick={() => void onSave(id)}
                >
                  Save
                </button>
              )}
              {mode === 'load' && m && (
                <button
                  type="button"
                  className={`rounded-lg px-2 py-1 text-[0.75rem] ${
                    m.compatible ? 'bg-mint/20 text-mint' : 'bg-amber/15 text-amber'
                  }`}
                  onClick={() => onLoad(id)}
                >
                  {m.compatible ? 'Load' : `v${m.version}`}
                </button>
              )}
              {m && (
                <button
                  type="button"
                  className="rounded-lg border border-line px-2 py-1 text-[0.75rem] text-danger"
                  onClick={() => onDelete(id)}
                >
                  Del
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
