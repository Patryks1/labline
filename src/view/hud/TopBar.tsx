import { useState } from 'react'
import { useGameStore } from '../../store/gameStore'
import { money, num, pct } from './format'
import type { Speed } from '../../sim/types'
import {
  CalendarBlank,
  FloppyDisk,
  GearSix,
  Pause,
  Play,
  Question,
} from '@phosphor-icons/react'
import { ObjectivesButton } from './ObjectivesDock'
import { useUiStore } from '../../store/uiStore'
import { formatCampaignDate } from '../../sim/campaign'
import { KpiHistoryPopover, type KpiHistoryMetric } from './KpiHistoryPopover'
import { selectFinanceDashboardView } from './data/financeDashboardModel'
import { CompanyMarkBadge } from './ui/CompanyMark'
import { selectPlayerCompany } from '../../sim/company'

/** Play speeds only — pause is a separate control (not crammed as "0"). */
const PLAY_SPEEDS: Speed[] = [1, 2, 5]

/**
 * Floating top chrome — game play bar:
 *  1. Day clock + transport (left)
 *  2. Live KPIs with chart popovers (center)
 *  3. Utility (right)
 */
export function TopBar() {
  const [activeMetric, setActiveMetric] = useState<KpiHistoryMetric | null>(null)
  const state = useGameStore((s) => s.state)
  const playerCompany = selectPlayerCompany(state)
  const setSpeed = useGameStore((s) => s.setSpeed)
  const setPaused = useGameStore((s) => s.setPaused)
  const togglePause = useGameStore((s) => s.togglePause)
  const setPanel = useGameStore((s) => s.setPanel)
  const toggleHotkeyHelp = useGameStore((s) => s.toggleHotkeyHelp)
  const setPauseMenuOpen = useGameStore((s) => s.setPauseMenuOpen)
  const quickSave = useGameStore((s) => s.quickSave)
  const setCommandView = useGameStore((s) => s.setCommandView)
  const pushToast = useUiStore((s) => s.pushToast)
  const financeView = selectFinanceDashboardView(state)
  const { current: finance, history } = financeView
  const pnl = finance.net
  const paused = state.paused || state.speed === 0
  const campaignDate = formatCampaignDate(state.calendar)
  const companyName = state.config.labName?.trim() || state.player.name?.trim() || 'Labline'
  const companyMark = state.config.companyMark ?? 'orbit'
  const companyLogo = state.config.companyLogo

  return (
    <header className="top-command-bar pointer-events-none p-2 pb-1">
      <div className="top-command-main hud-surface pointer-events-auto relative flex h-full min-w-0 items-center gap-3 overflow-hidden rounded-lg px-3">
        <div className="top-command-brand shrink-0 items-center gap-2" aria-label={companyName} title={companyName}>
          <CompanyMarkBadge
            mark={companyMark}
            logo={companyLogo}
            className="top-command-brand__mark"
            markClassName="size-[1.15rem]"
          />
          <span className="top-command-brand__wordmark truncate">{companyName}</span>
        </div>

        {/* ── Zone 1: day clock + transport ── */}
        <div className="top-command-controls flex shrink-0 items-center gap-2 sm:gap-2.5">
          <div
            className="top-command-clock"
            data-paused={paused}
            data-mobile-priority="primary"
          >
            <div className="top-command-clock__icon" aria-hidden="true">
              <CalendarBlank size="1rem" weight="duotone" />
            </div>
            <div className="top-command-clock__content">
              <div className="top-command-clock__row">
                <span className="top-command-clock__label">DAY</span>
                <strong className="top-command-clock__day">{state.day.toLocaleString()}</strong>
              </div>
              <div className="top-command-clock__meta" data-mobile-detail="secondary">
                <time>{campaignDate}</time>
              </div>
            </div>
          </div>

          <div className="mx-0.5 h-8 w-px shrink-0 bg-line/80" />

          {/* Transport: Pause first, then speeds, then step */}
          <div
            className="top-command-transport flex items-center gap-0.5 rounded-lg border border-line/70 bg-void/50 p-0.5"
            role="group"
            aria-label="Game speed"
          >
            <button
              type="button"
              aria-label={paused ? 'Resume simulation' : 'Pause simulation'}
              aria-pressed={paused}
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
                  aria-label={`${sp} times speed`}
                  aria-pressed={active}
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
          </div>

        </div>

        {/* ── Zone 2: KPIs (never collide with transport) ── */}
        <div className="top-command-kpis flex min-w-0 flex-1 items-center justify-center gap-3 overflow-hidden px-1 xl:gap-4">
          <Metric
            label="Cash"
            value={money(playerCompany.finance.cash)}
            mobilePriority="primary"
            danger={playerCompany.finance.cash < 1e6}
            active={activeMetric === 'cash'}
            onClick={() => setActiveMetric((current) => current === 'cash' ? null : 'cash')}
          />
          <Metric
            label="Day P&L"
            value={money(pnl)}
            mobilePriority="primary"
            danger={pnl < 0}
            active={activeMetric === 'net'}
            onClick={() => setActiveMetric((current) => current === 'net' ? null : 'net')}
          />
          <Metric
            label="Share"
            value={pct(finance.share)}
            mobilePriority="secondary"
            active={activeMetric === 'share'}
            onClick={() => setActiveMetric((current) => current === 'share' ? null : 'share')}
          />
          <Metric
            label="Value"
            value={money(finance.valuation)}
            mobilePriority="tertiary"
            className="hidden md:flex"
            active={activeMetric === 'valuation'}
            onClick={() => setActiveMetric((current) => current === 'valuation' ? null : 'valuation')}
          />
          <Metric
            label="Brand"
            value={`${num(finance.brand ?? 0, 0)}/100`}
            mobilePriority="tertiary"
            className="hidden md:flex"
            active={activeMetric === 'brand'}
            onClick={() => setActiveMetric((current) => current === 'brand' ? null : 'brand')}
          />
        </div>

        {/* ── Zone 3: utility ── */}
        <div className="top-command-utility flex shrink-0 items-center gap-1">
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
            className="top-command-save hidden h-8 items-center gap-1.5 rounded-lg border border-line/60 px-2 text-[0.75rem] text-muted hover:border-mint/40 hover:text-mint sm:inline-flex"
          >
            <FloppyDisk size="1rem" /> <span className="hidden 2xl:inline">Save</span>
          </button>
          <button
            type="button"
            aria-label="Open hotkey help"
            title="Hotkeys (?)"
            onClick={toggleHotkeyHelp}
            className="top-command-help flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"
          >
            <Question size="1.1rem" />
          </button>
          <button
            type="button"
            aria-label="Open game menu"
            title="Pause menu"
            onClick={() => setPauseMenuOpen(true)}
            className="top-command-menu flex h-8 w-8 items-center justify-center rounded-lg border border-line/60 text-[0.75rem] text-muted hover:border-line hover:text-bone sm:w-auto sm:gap-1.5 sm:px-2.5"
          >
            <GearSix size="1rem" /> <span className="hidden 2xl:inline">Menu</span>
          </button>
        </div>
      </div>
      {activeMetric ? (
        <div id="kpi-history-popover" role="dialog" aria-label="KPI history" className="contents">
          <KpiHistoryPopover
            metric={activeMetric}
            history={history}
            current={{
              day: state.day,
              cash: finance.cash,
              net: finance.net,
              share: finance.share,
              valuation: finance.valuation,
              brand: finance.brand ?? 0,
          }}
          onClose={() => setActiveMetric(null)}
          onSelectMetric={setActiveMetric}
          onOpenDetails={() => {
            if (activeMetric === 'share') setPanel('market')
            else if (activeMetric === 'brand') setPanel('marketing')
            else if (activeMetric === 'valuation') setPanel('stats')
            else {
              setPanel('stats')
              setCommandView('pnl')
            }
            setActiveMetric(null)
          }}
          />
        </div>
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
  controlsId = 'kpi-history-popover',
  mobilePriority = 'secondary',
  className = '',
}: {
  label: string
  value: string
  danger?: boolean
  active?: boolean
  onClick?: () => void
  controlsId?: string
  mobilePriority?: 'primary' | 'secondary' | 'tertiary'
  className?: string
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      aria-expanded={onClick ? active === true : undefined}
      aria-controls={onClick ? controlsId : undefined}
      data-mobile-priority={mobilePriority}
      title={onClick ? `View ${label} history` : undefined}
      className={`top-command-metric flex min-w-[4rem] max-w-[7rem] shrink flex-col items-start rounded-md px-1 py-1 leading-none ${
        onClick ? 'text-left hover:opacity-90' : ''
      } ${active ? 'bg-mint/10 ring-1 ring-mint/30' : ''} ${className}`}
    >
      <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted">{label}</span>
      <span
        className={`mt-1 max-w-full truncate font-mono text-sm font-semibold tabular-nums ${
          danger ? 'text-danger' : 'text-bone'
        }`}
      >
        {value}
      </span>
    </Comp>
  )
}
