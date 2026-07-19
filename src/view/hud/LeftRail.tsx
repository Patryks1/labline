import { useMemo } from 'react'
import {
  Buildings,
  ChartDonut,
  Flask,
  Storefront,
  UsersThree,
} from '@phosphor-icons/react'
import { useGameStore } from '../../store/gameStore'
import type { PanelId } from '../../sim/types'
import { facilityAnchorTiles } from '../../sim/systems/worldAccess'
import { AllocatePanel } from './panels/AllocatePanel'
import { ResearchPanel } from './panels/ResearchPanel'
import { ModelsPanel } from './panels/ModelsPanel'
import { PlansPanel } from './panels/PlansPanel'
import { MarketPanel } from './panels/MarketPanel'
import { ChipsPanel } from './panels/ChipsPanel'
import { RacksPanel } from './panels/RacksPanel'
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
import {
  NAV_GROUPS,
  defaultPanelForGroup,
  groupForPanel,
  type NavGroupId,
} from './navConfig'

/**
 * Floating workspace drawer over the full-bleed map.
 * Collapsed: thin icon rail only (~52px). Expanded: overlay panel, map still visible beside it.
 */
export function LeftRail() {
  const active = useGameStore((s) => s.activePanel)
  const setPanel = useGameStore((s) => s.setPanel)
  const open = useGameStore((s) => s.leftRailOpen)
  const setOpen = useGameStore((s) => s.setLeftRailOpen)
  const state = useGameStore((s) => s.state)

  const group = useMemo(() => groupForPanel(active), [active])
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
    return {
      lab: training || rawData || research,
      infrastructure: rackArriving || fabActive || facilityAnchorTiles(state, { ownerId: 'player' }).some(
        (tile) => tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget,
      ),
      company: alerts,
      strategy: state.player.finance.dayNet < 0 && state.day > 5,
      market: state.lastMarket.unservedRatio > 0.2,
    } as Record<NavGroupId, boolean>
  }, [state])

  return (
    <div className="workspace-shell pointer-events-none">
      {/* Icon rail — always visible, minimal map occlusion */}
      <nav
        className="hud-surface pointer-events-auto relative col-start-1 m-1.5 mr-1 flex min-h-0 flex-col items-stretch gap-1 overflow-hidden rounded-xl p-1"
        aria-label="Workspaces"
      >
        {NAV_GROUPS.map((g) => {
          const on = group.id === g.id && open
          return (
            <button
              key={g.id}
              type="button"
              title={`${g.label} (${g.letter}) — ${g.description}`}
              onClick={() => {
                if (group.id === g.id && open) {
                  setOpen(false)
                  return
                }
                if (g.id === 'infrastructure') {
                  useGameStore.getState().openSites()
                } else {
                  setPanel(defaultPanelForGroup(g.id))
                }
                setOpen(true)
              }}
              className={`group relative flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 transition ${
                on
                  ? 'bg-panel-2 text-mint ring-1 ring-mint/25'
                  : 'text-muted hover:bg-panel-2/80 hover:text-bone'
              }`}
            >
              {on && (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-mint shadow-[0_0_10px_var(--color-mint)]" />
              )}
              <span className="relative">
                <NavIcon id={g.id} />
                {badges[g.id] && (
                  <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-sm bg-amber ring-2 ring-void" />
                )}
              </span>
              <span className={`max-w-full truncate text-[0.625rem] font-medium leading-none ${on ? 'text-mint' : ''}`}>
                {g.short}
              </span>
            </button>
          )
        })}
      </nav>

      {/* Content drawer — overlays map, does not push layout */}
      <div
        className={`hud-surface pointer-events-auto relative col-start-2 m-2 ml-1 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl transition-opacity duration-200 ease-out ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {open && (
          <>
            <header className="relative z-10 shrink-0 border-b border-line/60 px-4 pb-3 pt-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-mint/80">
                    {group.label}
                  </p>
                  <p className="mt-1 truncate text-[0.75rem] text-muted/90">{group.description}</p>
                </div>
                <button
                  type="button"
                  title="Collapse ([)"
                  onClick={() => setOpen(false)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[0.875rem] text-muted hover:bg-panel-2 hover:text-bone"
                >
                  ‹
                </button>
              </div>

              {group.items.length > 1 ? (
              <div
                className="mt-2 grid gap-0.5 rounded-xl bg-void/50 p-0.5"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, group.items.length)}, minmax(0, 1fr))`,
                }}
                role="tablist"
                aria-label={`${group.label} panels`}
              >
                {group.items.map((item) => {
                  const on = active === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      title={`${item.label} — ${item.hint}`}
                      onClick={() => setPanel(item.id)}
                      className={`min-h-8 min-w-0 rounded-lg px-2 py-1.5 text-center text-[0.75rem] font-medium leading-tight transition ${
                        on
                          ? 'bg-bone text-void shadow-sm'
                          : 'text-muted hover:bg-panel-2 hover:text-bone'
                      }`}
                    >
                      <span className="block truncate px-0.5">{item.label}</span>
                    </button>
                  )
                })}
              </div>
              ) : null}
            </header>

            <div
              className={`panel-scroll relative z-10 min-h-0 flex-1 p-4 ${
                active === 'research' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
              }`}
            >
              <PanelBody id={active} />
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
    case 'racks':
      return <RacksPanel />
    case 'buildings':
      return <FleetBuildingsPanel />
    case 'power':
      return <PowerPanel />
    case 'computeMarket':
      return <ComputeMarketPanel />
    case 'build':
      return <BuildPanel />
    case 'chips':
      return <ChipsPanel />
    case 'map':
      return <MapPanel />
    case 'org':
      return <OrgPanel />
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

function NavIcon({ id }: { id: NavGroupId }) {
  const Icon =
    id === 'strategy'
      ? ChartDonut
      : id === 'lab'
        ? Flask
        : id === 'infrastructure'
          ? Buildings
          : id === 'market'
            ? Storefront
            : UsersThree
  return <Icon size="1.25rem" weight="duotone" aria-hidden />
}
