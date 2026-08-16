import { useEffect, useState } from 'react'
import {
  MANUAL_SLOTS,
  type SaveSlotId,
} from '../../sim/save'
import { useGameStore } from '../../store/gameStore'
import { money, pct } from './format'
import { LablineMenuShell } from './menu/LablineMenuShell'
import { SettingsPanel } from './menu/SettingsPanel'
import { ConsoleDialog } from './ui/ConsoleDialog'
import { HudButton, HudRange } from './ui/HudPrimitives'
import {
  BALANCE_TUNING_GROUPS,
  resolveBalanceTuning,
  type BalanceTuning,
} from '../../sim/balance/tuning'
import {
  runBalanceSimulation,
  type BalanceSimulationReport,
} from '../../sim/play/balanceSimulation'
import type { SimState } from '../../sim/types'

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
  const cash = useGameStore((s) => s.state.player.cash)
  const adjustCheatMoney = useGameStore((s) => s.adjustCheatMoney)
  const runInstantCheat = useGameStore((s) => s.runInstantCheat)
  const balanceTuning = useGameStore((s) => s.state.balanceTuning)
  const gameState = useGameStore((s) => s.state)
  const [msg, setMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<'main' | 'save' | 'load' | 'settings' | 'balance'>('main')
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
      contentClassName="pause-menu-content max-h-[calc(100dvh-11.5rem)] max-w-[46rem] p-5 sm:p-6"
    >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-bone">
            {tab === 'main' ? 'Paused' : tab === 'save' ? 'Save run' : tab === 'load' ? 'Load run' : tab === 'settings' ? 'Settings' : 'Balance'}
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
              label="Balance"
              onClick={() => {
                setMsg(null)
                setTab('balance')
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
            <HudButton
              variant="ghost"
              className="min-h-11 justify-start px-0 text-[0.8125rem] text-mint hover:underline"
              onClick={() => {
                setTab('main')
                setMsg(null)
              }}
            >
              ← Back
            </HudButton>
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
            <HudButton
              variant="ghost"
              className="min-h-11 justify-start px-0 text-[0.75rem] text-mint hover:underline"
              onClick={() => setTab('main')}
            >
              ← Back
            </HudButton>
            <SettingsPanel gameplay={{
              autoPause,
              setAutoPause,
              onboardingDismissed,
              setOnboardingDismissed,
            }} cheats={{ cash, adjustMoney: adjustCheatMoney, runInstantAction: runInstantCheat }} />
          </div>
        )}

        {tab === 'balance' && (
          <BalanceTab
            overrides={balanceTuning}
            snapshot={gameState}
            onBack={() => {
              setTab('main')
              setMsg(null)
            }}
          />
        )}

        <ConsoleDialog
          open={Boolean(confirm)}
          titleId="pause-confirm-title"
          eyebrow="Confirm save operation"
          title={confirm?.title ?? 'Confirm operation'}
          onClose={() => setConfirm(null)}
          closeLabel="Cancel operation"
          maxWidthClass="max-w-[30rem]"
          footer={confirm ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <HudButton variant="secondary" onClick={() => setConfirm(null)}>Cancel</HudButton>
              <HudButton
                variant="danger"
                onClick={() => {
                  const action = confirm.onConfirm
                  setConfirm(null)
                  action()
                }}
              >
                {confirm.action}
              </HudButton>
            </div>
          ) : null}
        >
          <p className="text-[0.875rem] leading-relaxed text-muted">{confirm?.body}</p>
        </ConsoleDialog>
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
    <HudButton
      variant={primary ? 'primary' : danger ? 'danger' : 'secondary'}
      onClick={onClick}
      className="min-h-11 w-full justify-start rounded-xl px-3 py-2.5 text-left text-[0.8125rem] transition"
    >
      {label}
    </HudButton>
  )
}

function BalanceTab({
  overrides,
  snapshot,
  onBack,
}: {
  overrides: Partial<BalanceTuning> | undefined
  snapshot: SimState
  onBack: () => void
}) {
  const setBalanceTuning = useGameStore((s) => s.setBalanceTuning)
  const resetBalanceTuning = useGameStore((s) => s.resetBalanceTuning)
  const resolved = resolveBalanceTuning(overrides)
  const [simDays, setSimDays] = useState(90)
  const [simRunning, setSimRunning] = useState(false)
  const [simProgress, setSimProgress] = useState(0)
  const [report, setReport] = useState<BalanceSimulationReport | null>(null)

  const runSimulation = () => {
    if (simRunning) return
    setSimRunning(true)
    setSimProgress(0)
    setReport(null)
    // Defer so the "running" paint lands before the synchronous sim loop
    // blocks the main thread; progress flows back through onProgress
    // (React batches the state updates). Runs are capped at 180 days here.
    setTimeout(() => {
      const result = runBalanceSimulation(snapshot, simDays, {
        onProgress: (done, total) => {
          setSimProgress(total > 0 ? done / total : 1)
        },
      })
      setReport(result)
      setSimProgress(1)
      setSimRunning(false)
    }, 30)
  }

  return (
    <div className="max-h-[calc(100dvh-16rem)] space-y-4 overflow-y-auto pr-1">
      <HudButton
        variant="ghost"
        className="min-h-11 justify-start px-0 text-[0.75rem] text-mint hover:underline"
        onClick={onBack}
      >
        ← Back
      </HudButton>

      {BALANCE_TUNING_GROUPS.map((group) => (
        <section key={group.id}>
          <h3 className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">
            {group.label}
          </h3>
          <div className="space-y-2">
            {group.sliders.map((slider) => {
              const value = resolved[slider.key]
              return (
                <div
                  key={slider.key}
                  className="rounded-xl border border-line bg-panel-2 px-2.5 py-2"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[0.75rem] font-medium text-bone">{slider.label}</span>
                    <span className="font-mono text-[0.6875rem] tabular-nums text-mint">
                      {slider.format(value)}
                    </span>
                  </div>
                  <HudRange
                    min={slider.min}
                    max={slider.max}
                    step={slider.step}
                    value={value}
                    title={slider.hint}
                    onChange={(event) =>
                      setBalanceTuning({
                        [slider.key]: Number(event.currentTarget.value),
                      } as Partial<BalanceTuning>)
                    }
                    className="mt-1 w-full"
                  />
                  <p className="mt-0.5 text-[0.625rem] leading-snug text-muted">{slider.hint}</p>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      <HudButton
        variant="secondary"
        className="min-h-11 w-full"
        onClick={() => resetBalanceTuning()}
      >
        Reset to defaults
      </HudButton>

      <section className="border-t border-line pt-3">
        <h3 className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">
          Simulation
        </h3>
        <p className="mb-2 text-[0.6875rem] leading-snug text-muted">
          Fast-forward a clone of this run with the current tuning. The live game is not touched.
        </p>
        <div className="flex items-center gap-1.5">
          {[30, 90, 180].map((d) => (
            <HudButton
              key={d}
              variant="secondary"
              disabled={simRunning}
              onClick={() => setSimDays(d)}
              className={`min-h-11 min-w-11 rounded-lg px-2.5 py-1 text-[0.75rem] transition disabled:opacity-50 ${
                simDays === d
                  ? 'border-mint/40 bg-mint/15 text-mint'
                  : 'border-line bg-panel-2 text-bone hover:border-mint/30'
              }`}
            >
              {d}d
            </HudButton>
          ))}
          <HudButton
            variant="primary"
            disabled={simRunning}
            onClick={runSimulation}
            className="ml-auto min-h-11 px-3 py-1 text-[0.75rem] transition disabled:opacity-50"
          >
            {simRunning ? `Running… ${Math.round(simProgress * 100)}%` : 'Run'}
          </HudButton>
        </div>

        {report && (
          <div className="mt-2 space-y-1.5 rounded-xl border border-line bg-panel-2 px-2.5 py-2 text-[0.75rem]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted">Days simulated</span>
              <span className="font-mono tabular-nums text-bone">
                {report.daysSimulated} (day {report.startDay} → {report.startDay + report.daysSimulated})
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted">Cash</span>
              <span className="font-mono tabular-nums text-bone">
                {money(report.startCash)} → {money(report.endCash)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted">Cash negative</span>
              <span className="font-mono tabular-nums text-bone">
                {report.firstCashNegativeDay !== null ? `Day ${report.firstCashNegativeDay}` : 'Never'}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted">Top capability</span>
              <span className="font-mono tabular-nums text-bone">{report.endTopCapability.toFixed(1)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted">Avg unserved demand</span>
              <span className="font-mono tabular-nums text-bone">{pct(report.avgUnservedRatio)}</span>
            </div>
            {report.error && (
              <p className="rounded-lg border border-danger/30 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger">
                Simulation stopped early: {report.error}
              </p>
            )}
            {report.warnings.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-[0.6875rem] text-amber">
                {report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
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
                  <HudButton
                    variant="primary"
                    className="min-h-11 min-w-11 rounded-lg px-2 py-1 text-[0.75rem]"
                    onClick={() => void onSave(id)}
                  >
                    Save
                  </HudButton>
              )}
              {mode === 'load' && m && (
                  <HudButton
                    variant="secondary"
                    className={`min-h-11 min-w-11 rounded-lg px-2 py-1 text-[0.75rem] ${
                      m.compatible ? 'bg-mint/20 text-mint' : 'bg-amber/15 text-amber'
                    }`}
                    onClick={() => onLoad(id)}
                  >
                    {m.compatible ? 'Load' : `v${m.version}`}
                  </HudButton>
              )}
              {m && (
                <HudButton
                  variant="danger"
                  className="min-h-11 min-w-11 rounded-lg px-2 py-1 text-[0.75rem]"
                  onClick={() => onDelete(id)}
                >
                  Del
                </HudButton>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
