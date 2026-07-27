import { useEffect, useState } from 'react'
import {
  MANUAL_SLOTS,
  type SaveSlotId,
} from '../../sim/save'
import { useGameStore } from '../../store/gameStore'
import { money } from './format'
import { X } from '@phosphor-icons/react'
import { LablineMenuShell } from './menu/LablineMenuShell'
import { SettingsPanel } from './menu/SettingsPanel'

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
  const [msg, setMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<'main' | 'save' | 'load' | 'settings'>('main')
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
  useEffect(() => {
    if (open) return
    setTab('main')
    setMsg(null)
    setConfirm(null)
  }, [open])
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

  const requestClose = () => {
    if (confirm) {
      setConfirm(null)
      return
    }
    setOpen(false)
  }

  return (
    <LablineMenuShell
      variant="pause"
      titleId="labline-pause-title"
      onRequestClose={requestClose}
      contentClassName="max-h-[calc(100dvh-11.5rem)] max-w-[46rem] p-5 sm:p-6"
    >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-bone">
            {tab === 'main' ? 'Paused' : tab === 'save' ? 'Save run' : tab === 'load' ? 'Load run' : 'Settings'}
          </h2>
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">Esc to close</span>
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
              label="Settings"
              onClick={() => {
                setMsg(null)
                setTab('settings')
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

        {tab === 'settings' && (
          <div>
            <button
              type="button"
              className="text-[0.75rem] text-mint hover:underline"
              onClick={() => setTab('main')}
            >
              ← Back
            </button>
            <SettingsPanel gameplay={{
              autoPause,
              setAutoPause,
              onboardingDismissed,
              setOnboardingDismissed,
            }} />
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
    </LablineMenuShell>
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
