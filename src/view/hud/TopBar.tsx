import { useState } from 'react'
import { useGameStore } from '../../store/gameStore'
import { money, pct } from './format'
import type { Speed } from '../../sim/types'
import {
  CaretRight,
  FloppyDisk,
  GearSix,
  Pause,
  Play,
  Question,
} from '@phosphor-icons/react'
import { ObjectivesButton } from './ObjectivesDock'
import { useUiStore } from '../../store/uiStore'
import { formatCampaignClock } from '../../sim/campaign'
import { KpiHistoryPopover, type KpiHistoryMetric } from './KpiHistoryPopover'

/** Play speeds only — pause is a separate control (not crammed as "0"). */
const PLAY_SPEEDS: Speed[] = [1, 2, 5]

/**
 * Floating top chrome — three clear zones:
 *  1. Identity + time transport + drawer toggles (left)
 *  2. Live KPIs (center)
 *  3. Utility (right)
 */
export function TopBar() {
  const [activeMetric, setActiveMetric] = useState<KpiHistoryMetric | null>(null)
  const state = useGameStore((s) => s.state)
  const setSpeed = useGameStore((s) => s.setSpeed)
  const setPaused = useGameStore((s) => s.setPaused)
  const togglePause = useGameStore((s) => s.togglePause)
  const stepDay = useGameStore((s) => s.stepDay)
  const setPanel = useGameStore((s) => s.setPanel)
  const toggleHotkeyHelp = useGameStore((s) => s.toggleHotkeyHelp)
  const setPauseMenuOpen = useGameStore((s) => s.setPauseMenuOpen)
  const quickSave = useGameStore((s) => s.quickSave)
  const setCommandView = useGameStore((s) => s.setCommandView)
  const f = state.player.finance
  const pushToast = useUiStore((s) => s.pushToast)
  const pnl =
    typeof f.dayNet === 'number' ? f.dayNet : f.dayRevenue - f.dayCogs - f.dayEnergyCost
  const paused = state.paused || state.speed === 0

  return (
    <header className="top-command-bar pointer-events-none p-2 pb-1">
      <div className="hud-surface pointer-events-auto relative flex h-full min-w-0 items-center gap-3 overflow-hidden rounded-xl px-3">
        {/* ── Zone 1: identity + transport + drawers ── */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <div className="min-w-0">
            <div className="max-w-[10rem] truncate text-[0.875rem] font-semibold tracking-tight text-bone">
              {state.player.name || 'Labline'}
            </div>
            <div className="font-mono text-[0.6875rem] tabular-nums text-muted">
              {formatCampaignClock(state.calendar, state.day)}
              <span className="text-muted/60"> · {state.calendar.era.replaceAll('_', ' ').toUpperCase()}</span>
            </div>
          </div>

          <div className="mx-0.5 h-7 w-px shrink-0 bg-line/80" />

          {/* Transport: Pause first, then speeds, then step */}
          <div
            className="flex items-center gap-0.5 rounded-xl border border-line/70 bg-void/50 p-0.5"
            role="group"
            aria-label="Game speed"
          >
            <button
              type="button"
              title={paused ? 'Resume (Space)' : 'Pause (Space)'}
              onClick={togglePause}
              className={`flex h-8 min-w-8 items-center justify-center rounded-lg px-2 font-mono text-[0.75rem] font-semibold transition ${
                paused
                  ? 'bg-mint text-void shadow-sm'
                  : 'bg-panel-2 text-bone hover:bg-panel-2/80'
              }`}
            >
              {paused ? <Play size="1rem" weight="fill" /> : <Pause size="1rem" weight="fill" />}
            </button>
            {PLAY_SPEEDS.map((sp) => {
              const active = !paused && state.speed === sp
              return (
                <button
                  key={sp}
                  type="button"
                  title={`${sp}× speed`}
                  onClick={() => {
                    setPaused(false)
                    setSpeed(sp)
                  }}
                  className={`h-8 min-w-8 rounded-lg px-1.5 font-mono text-[0.75rem] transition ${
                    active ? 'bg-mint/20 text-mint ring-1 ring-mint/35' : 'text-muted hover:text-bone'
                  }`}
                >
                  {sp}×
                </button>
              )
            })}
            <button
              type="button"
              title="Step one day (+)"
              onClick={stepDay}
              className="flex h-8 items-center gap-1 rounded-lg px-2 font-mono text-[0.75rem] text-muted hover:bg-panel-2 hover:text-bone"
            >
              <CaretRight size="0.85rem" weight="bold" /> 1d
            </button>
          </div>

        </div>

        {/* ── Zone 2: KPIs (never collide with transport) ── */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3 overflow-hidden px-1 xl:gap-4">
          <Metric
            label="Cash"
            value={money(state.player.cash)}
            danger={state.player.cash < 1e6}
            active={activeMetric === 'cash'}
            onClick={() => setActiveMetric((current) => current === 'cash' ? null : 'cash')}
          />
          <Metric
            label="Day P&L"
            value={money(pnl)}
            danger={pnl < 0}
            active={activeMetric === 'net'}
            onClick={() => setActiveMetric((current) => current === 'net' ? null : 'net')}
          />
          <Metric
            label="Share"
            value={pct(f.totalShare, 1)}
            active={activeMetric === 'share'}
            onClick={() => setActiveMetric((current) => current === 'share' ? null : 'share')}
          />
          <Metric
            label="Value"
            value={money(f.valuation)}
            className="hidden md:flex"
            active={activeMetric === 'valuation'}
            onClick={() => setActiveMetric((current) => current === 'valuation' ? null : 'valuation')}
          />
          <Metric
            label="Brand"
            value={`${Math.round(state.player.brandTrust)}/100`}
            className="hidden md:flex"
            active={activeMetric === 'brand'}
            onClick={() => setActiveMetric((current) => current === 'brand' ? null : 'brand')}
          />
        </div>

        {/* ── Zone 3: utility ── */}
        <div className="flex shrink-0 items-center gap-1">
          <ObjectivesButton />
          <button
            type="button"
            title="Quick save (Ctrl/Cmd+S)"
            onClick={() => {
              void quickSave().then((result) => {
                pushToast(
                  result.ok ? 'Autosave updated.' : result.error,
                  result.ok ? 'positive' : 'danger',
                )
              })
            }}
            className="hidden h-8 items-center gap-1.5 rounded-lg border border-line/60 px-2 text-[0.75rem] text-muted hover:border-mint/40 hover:text-mint sm:inline-flex"
          >
            <FloppyDisk size="1rem" /> <span className="hidden 2xl:inline">Save</span>
          </button>
          <button
            type="button"
            title="Hotkeys (?)"
            onClick={toggleHotkeyHelp}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"
          >
            <Question size="1.1rem" />
          </button>
          <button
            type="button"
            title="Pause menu"
            onClick={() => setPauseMenuOpen(true)}
            className="hidden h-8 items-center gap-1.5 rounded-lg border border-line/60 px-2.5 text-[0.75rem] text-muted hover:border-line hover:text-bone sm:inline-flex"
          >
            <GearSix size="1rem" /> <span className="hidden 2xl:inline">Menu</span>
          </button>
        </div>
      </div>
      {activeMetric ? (
        <KpiHistoryPopover
          metric={activeMetric}
          history={state.financeHistory}
          current={{
            day: state.day,
            cash: state.player.cash,
            net: pnl,
            share: f.totalShare,
            valuation: f.valuation,
            brand: state.player.brandTrust,
          }}
          onClose={() => setActiveMetric(null)}
          onOpenDetails={() => {
            if (activeMetric === 'share') setPanel('market')
            else if (activeMetric === 'brand') setPanel('org')
            else {
              setPanel('stats')
              setCommandView('pnl')
            }
            setActiveMetric(null)
          }}
        />
      ) : null}
    </header>
  )
}

function Metric({
  label,
  value,
  danger,
  active,
  onClick,
  className = '',
}: {
  label: string
  value: string
  danger?: boolean
  active?: boolean
  onClick?: () => void
  className?: string
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      title={onClick ? `View ${label} history` : undefined}
      className={`flex min-w-[4rem] max-w-[7rem] shrink flex-col items-start rounded-md px-1 py-1 leading-none ${
        onClick ? 'text-left hover:opacity-90' : ''
      } ${active ? 'bg-mint/10 ring-1 ring-mint/30' : ''} ${className}`}
    >
      <span className="text-[0.625rem] uppercase tracking-[0.12em] text-muted">{label}</span>
      <span
        className={`mt-1 max-w-full truncate font-mono text-[0.8125rem] font-medium tabular-nums ${
          danger ? 'text-danger' : 'text-bone'
        }`}
      >
        {value}
      </span>
    </Comp>
  )
}
