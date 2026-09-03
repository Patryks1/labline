import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  ChartDonut,
  ChartLine,
  ClipboardText,
  Cloud,
  Crosshair,
  Database,
  DotsThree,
  Flask,
  Gauge,
  Bulldozer,
  Hammer,
  HardDrives,
  Lightning,
  MapTrifold,
  Megaphone,
  Package,
  Users,
  UsersThree,
} from '@phosphor-icons/react'
import { useGameStore } from '../../store/gameStore'
import { useUiStore } from '../../store/uiStore'
import type { PanelId } from '../../sim/types'
import { facilityAnchorTiles } from '../../sim/systems/worldAccess'
import { AllocatePanel } from './panels/AllocatePanel'
import { ResearchPanel } from './panels/ResearchPanel'
import { ModelsPanel } from './panels/ModelsPanel'
import { PlansPanel } from './panels/PlansPanel'
import { MarketPanel } from './panels/MarketPanel'
import { HardwarePanel } from './panels/HardwarePanel'
import { MapPanel } from './panels/MapPanel'
import { OrgPanel } from './panels/OrgPanel'
import { StatsPanel } from './panels/StatsPanel'
import { DataPanel } from './panels/DataPanel'
import { BenchmarksPanel } from './panels/BenchmarksPanel'
import { RivalIntelPanel } from './panels/RivalIntelPanel'
import { PowerPanel } from './panels/PowerPanel'
import { ComputeMarketPanel } from './panels/ComputeMarketPanel'
import { FleetBuildingsPanel } from './panels/FleetBuildingsPanel'
import { BuildPanel } from './BuildTray'
import {
  SHELL_NAV_GROUPS,
  shellPanelForPanel,
  type ShellNavGroupId,
} from './navConfig'
import {
  MOBILE_MORE_SECTIONS,
  MOBILE_MORE_UTILITIES,
  MOBILE_PRIMARY_TABS,
  mobilePrimaryPanelForSwipe,
  useShellSwipeGesture,
} from './mobileShellContracts'
import { normalizeTrainingJobs } from './trainingJobViewModel'
import { selectFinanceDashboardReadouts } from './data/financeDashboardModel'
import { trainingStateOf } from '../../sim/training/state'

/**
 * Floating workspace drawer over the full-bleed map.
 * Rail: every destination is a one-level action (Build pinned on top as the
 * map action); group headings are visual landmarks, not nested tablists.
 * Content swaps animate via .panel-swap keyed on the active panel.
 */

interface RailTab {
  id: PanelId
  label: string
  hint: string
  group: ShellNavGroupId
}

/** Flattened visual nav: every panel is a first-class action under a heading. */
const RAIL_SECTIONS: { group: ShellNavGroupId; label: string; tabs: RailTab[] }[] = SHELL_NAV_GROUPS.map((g) => ({
  group: g.id,
  label: g.label,
  tabs: g.items.filter((item) => !(g.id === 'build' && item.id === 'build')).map((item) => ({
    id: item.id,
    label: item.label,
    hint: item.hint,
    group: g.id,
  })),
}))

function panelIcon(id: PanelId) {
  const Icon =
    id === 'build'
      ? Hammer
      : id === 'stats'
      ? Gauge
      : id === 'rivals'
        ? UsersThree
        : id === 'models'
          ? Brain
          : id === 'data'
            ? Database
            : id === 'research'
              ? Flask
              : id === 'benchmarks'
                ? ClipboardText
                : id === 'map'
                  ? MapTrifold
                  : id === 'computeMarket'
                    ? Cloud
                    : id === 'racks'
                      ? HardDrives
                      : id === 'power'
                        ? Lightning
                        : id === 'plans'
                          ? Package
                          : id === 'market'
                            ? ChartDonut
                            : id === 'marketing'
                              ? Megaphone
                              : Users
  return Icon
}

export interface LeftRailProps {
  /** One-shot handoff from the global activity bar to a specific Models run. */
  modelsFocusJobId?: string | null
  onModelsFocusHandled?: () => void
}

export function LeftRail({
  modelsFocusJobId = null,
  onModelsFocusHandled,
}: LeftRailProps = {}) {
  const active = useGameStore((s) => s.activePanel)
  const setPanel = useGameStore((s) => s.setPanel)
  const open = useGameStore((s) => s.leftRailOpen)
  const setOpen = useGameStore((s) => s.setLeftRailOpen)
  const mapTool = useGameStore((s) => s.mapTool)
  const setMapTool = useGameStore((s) => s.setMapTool)
  const setBuildMode = useGameStore((s) => s.setBuildMode)
  const setCommandDockOpen = useGameStore((s) => s.setCommandDockOpen)
  const commandDockOpen = useGameStore((s) => s.commandDockOpen)
  const state = useGameStore((s) => s.state)
  const objectivesOpen = useUiStore((s) => s.objectivesOpen)
  const setObjectivesOpen = useUiStore((s) => s.setObjectivesOpen)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const mobileMoreCloseRef = useRef<HTMLButtonElement>(null)
  const mobileMoreDialogRef = useRef<HTMLElement>(null)
  const shellActive = useMemo(() => shellPanelForPanel(active), [active])
  const activeWorkspaceLabel = useMemo(
    () =>
      SHELL_NAV_GROUPS.flatMap((group) => group.items).find(
        (item) => item.id === shellActive,
      )?.label ?? 'Workspace',
    [shellActive],
  )

  const badges = useMemo(() => {
    const v4 = trainingStateOf(state, state.playerLabId)
    const v4Busy =
      v4.runs.some(
        (run) =>
          run.status === 'running' ||
          run.status === 'queued' ||
          run.status === 'awaiting_decision',
      ) || v4.recipes.some((recipe) => recipe.status === 'running')
    const training = v4Busy || normalizeTrainingJobs(state).length > 0
    const finance = selectFinanceDashboardReadouts(state)
    const rawData =
      state.player.data &&
      Object.values(state.player.data.stocks).some((s) => s.raw > 0.5)
    const alerts = state.alerts.some((a) => a.severity === 'danger' || a.severity === 'warn')
    const research =
      !!state.player.activeResearch ||
      state.player.researchQueue.length > 0 ||
      (state.player.researchPrograms ?? []).some((program) => program.phase !== 'complete')
    const rackArriving = (state.player.rackFleet ?? []).some((r) => r.status === 'ordered')
    const fabActive = state.player.fab?.phase != null && state.player.fab.phase !== 'idle'
    const constructionActive = facilityAnchorTiles(state, { ownerId: 'player' }).some(
      (tile) => tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget,
    )
    return {
      stats: finance.current.net < 0 && state.day > 5,
      models: training,
      data: rawData,
      research,
      racks: rackArriving || fabActive,
      build: constructionActive,
      org: alerts,
      market: state.lastMarket.unservedRatio > 0.2,
    } as Partial<Record<PanelId, boolean>>
  }, [state])

  const handleTab = (id: PanelId) => {
    setMobileMoreOpen(false)
    setObjectivesOpen(false)
    if (id === 'models') onModelsFocusHandled?.()
    if (active === id && open) {
      setOpen(false)
      return
    }
    if (id === 'map') {
      setMapTool('select')
      useGameStore.getState().openSites()
      return
    }
    if (id === 'build') {
      setMapTool('build')
    } else if (mapTool === 'destroy') {
      setMapTool('select')
    }
    setPanel(id)
    setOpen(true)
  }

  useEffect(() => {
    if (!mobileMoreOpen) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFrame = window.requestAnimationFrame(() => mobileMoreCloseRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileMoreOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const root = mobileMoreDialogRef.current
      if (!root) return
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [mobileMoreOpen])

  const toggleDestroy = () => {
    setMobileMoreOpen(false)
    setObjectivesOpen(false)
    if (mapTool === 'destroy') {
      setMapTool('select')
      return
    }
    setBuildMode(null)
    setMapTool('destroy')
    setOpen(false)
    setCommandDockOpen(false)
  }

  const openMobileMore = () => {
    const next = !mobileMoreOpen
    setMobileMoreOpen(next)
    if (next) {
      setOpen(false)
      setCommandDockOpen(false)
      setObjectivesOpen(false)
    }
  }

  const mobileMoreActive =
    mobileMoreOpen ||
    (open && !MOBILE_PRIMARY_TABS.some((tab) => tab.id === active))

  const nextPrimaryPanel = mobilePrimaryPanelForSwipe(active, 'left')
  const previousPrimaryPanel = mobilePrimaryPanelForSwipe(active, 'right')
  const canSwipePrimary = nextPrimaryPanel != null || previousPrimaryPanel != null
  const workspaceGesture = useShellSwipeGesture<HTMLDivElement>({
    onDown: () => setOpen(false),
    onLeft: nextPrimaryPanel ? () => handleTab(nextPrimaryPanel) : undefined,
    onRight: previousPrimaryPanel ? () => handleTab(previousPrimaryPanel) : undefined,
  })
  const mobileMoreGesture = useShellSwipeGesture<HTMLDivElement>({
    onDown: () => setMobileMoreOpen(false),
  })

  return (
    <div className="workspace-shell pointer-events-none">
      {/* Icon rail: Build action pinned on top, then grouped one-level destinations */}
      <nav
        className="desktop-workspace-rail hud-surface pointer-events-auto relative col-start-1 m-1.5 mr-1 flex min-h-0 flex-col items-stretch gap-0.5 overflow-y-auto rounded-lg p-1 panel-scroll"
        aria-label="Workspaces"
      >
        <button
          type="button"
          aria-label="Build"
          aria-current={active === 'build' && open ? 'page' : undefined}
          title="Build (R) - place facilities and expand campus capacity"
          onClick={() => handleTab('build')}
          className={`group relative flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5 transition ${
            active === 'build' && open
              ? 'border-amber/60 bg-amber/15 text-amber'
              : 'border-line/70 bg-panel-2/60 text-amber/90 hover:border-amber/45 hover:bg-amber/10 hover:text-amber'
          }`}
        >
          <span className="relative">
            <Hammer size="1.25rem" weight="duotone" aria-hidden />
            {badges.build && (
              <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-sm bg-amber ring-2 ring-void" />
            )}
          </span>
          <span className="max-w-full truncate text-[0.625rem] font-semibold leading-none">
            Build
          </span>
        </button>

        <div aria-hidden className="mx-2 my-1 h-px bg-line/60" />

        <button
          type="button"
          aria-label="Destroy"
          title="Destroy — sell owned facilities or cancel construction"
          aria-pressed={mapTool === 'destroy'}
          onClick={() => {
            toggleDestroy()
          }}
          className={`group relative flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1.5 transition ${
            mapTool === 'destroy'
              ? 'border-danger/60 bg-danger/15 text-danger'
              : 'border-line/70 bg-panel-2/60 text-danger/90 hover:border-danger/45 hover:bg-danger/10 hover:text-danger'
          }`}
        >
          <span className="relative">
            <Bulldozer size="1.25rem" weight="duotone" aria-hidden />
          </span>
          <span className="max-w-full truncate text-[0.625rem] font-semibold leading-none">
            Destroy
          </span>
        </button>

        {RAIL_SECTIONS.map((section) => (
          <div key={section.group} className="flex flex-col gap-0.5">
            <div aria-hidden className="mx-2 my-1 h-px bg-line/60" />
            <p className="desktop-rail-group-label" role="heading" aria-level={2}>{section.label}</p>
            {section.tabs.map((tab) => {
              const Icon = panelIcon(tab.id)
              const on = shellActive === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-label={tab.label}
                  aria-current={on && open ? 'page' : undefined}
                  title={`${tab.label} - ${tab.hint}`}
                  onClick={() => handleTab(tab.id)}
                  className={`group relative flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 transition ${
                    on && open
                      ? 'bg-panel-2 text-mint ring-1 ring-mint/25'
                      : 'text-muted hover:bg-panel-2/80 hover:text-bone'
                  }`}
                >
                  {on && open && (
                    <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-mint shadow-[0_0_10px_var(--color-mint)]" />
                  )}
                  <span className="relative">
                    <Icon size="1.2rem" weight="duotone" aria-hidden />
                    {badges[tab.id] && (
                      <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-sm bg-amber ring-2 ring-void" />
                    )}
                  </span>
                  <span
                    className={`max-w-full truncate text-[0.625rem] font-medium leading-none ${
                      on && open ? 'text-mint' : ''
                    }`}
                  >
                    {tab.label}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Content drawer: panel-owned title plus a compact shell context header */}
      <div
        className={`workspace-drawer workspace-drawer--reserve-operations hud-surface pointer-events-auto relative col-start-2 m-2 ml-1 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg transition-opacity duration-200 ease-out ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        role="region"
        aria-label={`${activeWorkspaceLabel} workspace`}
        aria-describedby={open ? 'workspace-mobile-gesture-hint' : undefined}
      >
        {open && (
          <>
            <div
              className="workspace-drawer__mobile-header hidden"
              data-mobile-shell-only="true"
            >
              <div
                {...workspaceGesture}
                className="workspace-drawer__gesture-zone"
                data-shell-gesture-surface="true"
                aria-hidden="true"
              >
                <span className="mobile-sheet-grabber" />
                <span className="workspace-drawer__gesture-hint">
                  {canSwipePrimary
                    ? 'Swipe down to close · sideways to switch'
                    : 'Swipe down to close'}
                </span>
              </div>
              <button
                type="button"
                className="workspace-drawer__mobile-close"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>
            <p id="workspace-mobile-gesture-hint" className="sr-only">
              On a touch screen, swipe down from the top handle to close this workspace.
              {canSwipePrimary
                ? ' Swipe sideways on the handle to move between primary workspaces.'
                : null}
            </p>
            <div
              className={`workspace-drawer__body workspace-drawer__body--shell-reserved panel-scroll relative z-10 min-h-0 flex-1 p-4 ${
                active === 'research' || active === 'models'
                  ? 'flex flex-col overflow-y-auto xl:overflow-hidden'
                  : 'overflow-y-auto'
              }`}
            >
              <div
                key={active}
                className={`panel-swap min-h-0 ${
                  active === 'research' || active === 'models'
                    ? 'flex min-h-full flex-1 flex-col xl:min-h-0'
                    : ''
                }`}
              >
                <PanelBody
                  id={active}
                  modelsFocusJobId={active === 'models' ? modelsFocusJobId : null}
                  onModelsFocusHandled={onModelsFocusHandled}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <nav className="mobile-command-nav hud-surface pointer-events-auto" aria-label="Primary workspaces">
        {MOBILE_PRIMARY_TABS.map((tab) => {
          const Icon = panelIcon(tab.id)
          const selected =
            active === tab.id && (open || (tab.id === 'build' && mapTool === 'build'))
          return (
            <button
              key={tab.id}
              type="button"
              aria-label={tab.label}
              aria-current={selected ? 'page' : undefined}
              onClick={() => handleTab(tab.id)}
              className={selected ? 'is-active' : ''}
            >
              <span className="relative">
                <Icon size="1.25rem" weight="duotone" aria-hidden />
                {badges[tab.id] ? <span className="mobile-nav-badge" /> : null}
              </span>
              <span>{tab.label}</span>
            </button>
          )
        })}
        <button
          type="button"
          aria-label="More workspaces"
          aria-expanded={mobileMoreOpen}
          className={mobileMoreActive ? 'is-active' : ''}
          onClick={openMobileMore}
        >
          <DotsThree size="1.35rem" weight="bold" aria-hidden />
          <span>More</span>
        </button>
      </nav>

      {mobileMoreOpen ? (
        <div className="mobile-more-layer pointer-events-auto">
          <button
            type="button"
            aria-label="Close workspace menu"
            className="mobile-more-backdrop"
            onClick={() => setMobileMoreOpen(false)}
          />
          <section
            ref={mobileMoreDialogRef}
            className="mobile-more-sheet hud-surface"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
            aria-describedby="mobile-more-gesture-description"
          >
            <div
              {...mobileMoreGesture}
              className="mobile-more-gesture-zone hidden"
              data-shell-gesture-surface="true"
              aria-hidden="true"
            >
              <span className="mobile-sheet-grabber" />
              <span className="mobile-more-gesture-hint">Swipe down to close</span>
            </div>
            <p id="mobile-more-gesture-description" className="sr-only">
              Swipe down from the top handle to close this menu.
            </p>
            <header>
              <div>
                <p className="hud-eyebrow">Navigate</p>
                <h2 id="mobile-more-title">All workspaces</h2>
              </div>
              <button
                ref={mobileMoreCloseRef}
                type="button"
                onClick={() => setMobileMoreOpen(false)}
              >
                Done
              </button>
            </header>

            <div className="mobile-more-scroll panel-scroll">
              <section className="mobile-more-utilities" aria-label="Quick tools">
                {MOBILE_MORE_UTILITIES.map((utility) => {
                  const Icon = utility.id === 'intel'
                    ? ChartLine
                    : utility.id === 'objectives'
                      ? Crosshair
                      : Bulldozer
                  return (
                    <button
                      key={utility.id}
                      type="button"
                      aria-pressed={
                        utility.id === 'destroy'
                          ? mapTool === 'destroy'
                          : utility.id === 'intel'
                            ? commandDockOpen
                            : objectivesOpen
                      }
                      onClick={() => {
                        if (utility.id === 'destroy') {
                          toggleDestroy()
                          return
                        }
                        setMobileMoreOpen(false)
                        if (utility.id === 'intel') setCommandDockOpen(true)
                        else setObjectivesOpen(true)
                      }}
                    >
                      <Icon size="1.1rem" weight="duotone" />
                      <span><strong>{utility.label}</strong><small>{utility.hint}</small></span>
                    </button>
                  )
                })}
              </section>

              {MOBILE_MORE_SECTIONS.map((section) => {
                return (
                  <section key={section.group} className="mobile-more-group">
                    <h3>{section.label}</h3>
                    <div>
                      {section.tabs.map((tab) => {
                        const Icon = panelIcon(tab.id)
                        const selected = shellActive === tab.id && open
                        return (
                          <button
                            key={tab.id}
                            type="button"
                            aria-current={selected ? 'page' : undefined}
                            onClick={() => handleTab(tab.id)}
                            className={selected ? 'is-active' : ''}
                          >
                            <Icon size="1.1rem" weight="duotone" />
                            <span><strong>{tab.label}</strong><small>{tab.hint}</small></span>
                            {badges[tab.id] ? <span className="mobile-more-alert" /> : null}
                          </button>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}


function LegacyEventsRedirect() {
  const setCommandView = useGameStore((s) => s.setCommandView)
  const setLeftRailOpen = useGameStore((s) => s.setLeftRailOpen)
  useEffect(() => {
    setCommandView('feed')
    setLeftRailOpen(false)
  }, [setCommandView, setLeftRailOpen])
  return null
}

function PanelBody({
  id,
  modelsFocusJobId,
  onModelsFocusHandled,
}: {
  id: PanelId
  modelsFocusJobId?: string | null
  onModelsFocusHandled?: () => void
}) {
  switch (id) {
    case 'stats':
      return <StatsPanel />
    case 'allocate':
      return <AllocatePanel />
    case 'data':
      return <DataPanel />
    case 'models':
      return (
        <ModelsPanel
          focusJobId={modelsFocusJobId}
          onFocusHandled={onModelsFocusHandled}
        />
      )
    case 'plans':
      return <PlansPanel />
    case 'research':
      return <ResearchPanel />
    case 'market':
      return <MarketPanel />
    case 'marketing':
      return <OrgPanel key="marketing" workspace="marketing" />
    case 'racks':
      return <HardwarePanel view="racks" />
    case 'buildings':
      return <FleetBuildingsPanel />
    case 'power':
      return <PowerPanel />
    case 'computeMarket':
      return <ComputeMarketPanel />
    case 'build':
      return <BuildPanel />
    case 'chips':
      return <HardwarePanel view="silicon" />
    case 'map':
      return <MapPanel />
    case 'org':
      return <OrgPanel key="company" />
    case 'events':
      return <LegacyEventsRedirect />
    case 'benchmarks':
      return <BenchmarksPanel />
    case 'rivals':
      return <RivalIntelPanel />
    default:
      return null
  }
}
