import { useMemo } from 'react'
import {
  Brain,
  ChartDonut,
  ClipboardText,
  Cloud,
  Database,
  Flask,
  Gauge,
  Hammer,
  HardDrives,
  Lightning,
  MapTrifold,
  Megaphone,
  Package,
  Users,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import { useGameStore } from '../../store/gameStore'
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
import { EventsPanel } from './panels/EventsPanel'
import { StatsPanel } from './panels/StatsPanel'
import { DataPanel } from './panels/DataPanel'
import { BenchmarksPanel } from './panels/BenchmarksPanel'
import { RivalIntelPanel } from './panels/RivalIntelPanel'
import { PowerPanel } from './panels/PowerPanel'
import { ComputeMarketPanel } from './panels/ComputeMarketPanel'
import { FleetBuildingsPanel } from './panels/FleetBuildingsPanel'
import { BuildPanel } from './BuildTray'
import { NAV_GROUPS, groupForPanel, type NavGroupId } from './navConfig'

/**
 * Floating workspace drawer over the full-bleed map.
 * Rail: every panel is its own tab (Build pinned on top as the map action).
 * Content swaps animate via .panel-swap keyed on the active panel.
 */

interface RailTab {
  id: PanelId
  label: string
  hint: string
  group: NavGroupId
}

/** Flattened nav: every panel is a first-class tab, groups become dividers. */
const RAIL_SECTIONS: { group: NavGroupId; tabs: RailTab[] }[] = NAV_GROUPS.filter(
  (g) => g.id !== 'build',
).map((g) => ({
  group: g.id,
  tabs: g.items.map((item) => ({
    id: item.id,
    label: item.label,
    hint: item.hint,
    group: g.id,
  })),
}))

function panelIcon(id: PanelId) {
  const Icon =
    id === 'stats'
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

export function LeftRail() {
  const active = useGameStore((s) => s.activePanel)
  const setPanel = useGameStore((s) => s.setPanel)
  const open = useGameStore((s) => s.leftRailOpen)
  const setOpen = useGameStore((s) => s.setLeftRailOpen)
  const state = useGameStore((s) => s.state)

  const group = useMemo(() => groupForPanel(active), [active])
  const activeItem = useMemo(
    () => group.items.find((item) => item.id === active) ?? null,
    [group, active],
  )

  const badges = useMemo(() => {
    const training = !!state.player.trainingJob
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
      stats: state.player.finance.dayNet < 0 && state.day > 5,
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
    if (active === id && open) {
      setOpen(false)
      return
    }
    if (id === 'map') {
      useGameStore.getState().openSites()
      return
    }
    setPanel(id)
    setOpen(true)
  }

  return (
    <div className="workspace-shell pointer-events-none">
      {/* Icon rail: Build action pinned on top, then every panel as its own tab */}
      <nav
        className="hud-surface pointer-events-auto relative col-start-1 m-1.5 mr-1 flex min-h-0 flex-col items-stretch gap-0.5 overflow-y-auto rounded-xl p-1 panel-scroll"
        aria-label="Workspaces"
      >
        <button
          type="button"
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

        {RAIL_SECTIONS.map((section) => (
          <div key={section.group} className="flex flex-col gap-0.5">
            <div aria-hidden className="mx-2 my-1 h-px bg-line/60" />
            {section.tabs.map((tab) => {
              const Icon = panelIcon(tab.id)
              const on = active === tab.id || (tab.id === 'racks' && active === 'chips')
              return (
                <button
                  key={tab.id}
                  type="button"
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

      {/* Content drawer: stable header + animated panel swap */}
      <div
        className={`hud-surface pointer-events-auto relative col-start-2 m-2 ml-1 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl transition-opacity duration-200 ease-out ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {open && (
          <>
            <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line/60 px-4">
              <div className="flex min-w-0 items-baseline gap-2">
                <p className="shrink-0 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-mint/80">
                  {group.label}
                </p>
                <h2 className="truncate text-sm font-semibold text-bone">
                  {activeItem?.label ?? group.label}
                </h2>
                <p className="hidden truncate text-[0.75rem] text-muted/90 xl:block">
                  {activeItem?.hint ?? group.description}
                </p>
              </div>
              <button
                type="button"
                title="Collapse ([)"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"
              >
                <X size="0.9rem" />
              </button>
            </header>

            <div
              className={`panel-scroll relative z-10 min-h-0 flex-1 p-4 ${
                active === 'research' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
              }`}
            >
              <div key={active} className="panel-swap min-h-0">
                <PanelBody id={active} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PanelBody({ id }: { id: PanelId }) {
  switch (id) {
    case 'stats':
      return <StatsPanel />
    case 'allocate':
      return <AllocatePanel />
    case 'data':
      return <DataPanel />
    case 'models':
      return <ModelsPanel />
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
      return <EventsPanel />
    case 'benchmarks':
      return <BenchmarksPanel />
    case 'rivals':
      return <RivalIntelPanel />
    default:
      return null
  }
}
