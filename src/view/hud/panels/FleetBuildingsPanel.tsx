import type { ReactNode } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import {
  getBuildDef,
  isBuildableKind,
  isDcKind,
  isHqKind,
  isScenicKind,
} from '../../../sim/systems/map'
import {
  playerHqStaffCap,
  playerStaff,
  staffTotal,
} from '../../../sim/systems/staff'
import { STAFF_LABELS } from '../../../sim/balance/staff'
import { useGameStore } from '../../../store/gameStore'
import type { MapTile } from '../../../sim/types'
import { facilityAnchorTiles } from '../../../sim/systems/worldAccess'
import { money, num } from '../format'
import { BuildingNameField } from '../ui/BuildingNameField'
import { BuildingDisposeButtons } from './MapPanel'
import {
  activateBuildingRowFromClick,
  activateBuildingRowFromKey,
} from './FleetBuildingsPanelRowSemantics'
import { ECONOMY } from '../../../sim/balance/economy'
import {
  EmptyState,
  HudButton,
  MetricTile,
  PanelScaffold,
  StatusChip,
} from '../ui/HudPrimitives'
import { GameCard, LiveDot, MeterBar, StatRow } from '../ui/kit'

import { HudDesktopDefaultDetails } from '../ui/HudDesktopDefaultDetails'

type GroupId = 'hq' | 'lab' | 'dc' | 'power' | 'fab' | 'other'

const GROUP_ORDER: GroupId[] = ['hq', 'lab', 'dc', 'power', 'fab', 'other']

const GROUP_LABELS: Record<GroupId, string> = {
  hq: 'Headquarters',
  lab: 'Research labs',
  dc: 'Data halls',
  power: 'Power & grid',
  fab: 'Fabs',
  other: 'Other facilities',
}

function displayedFacilityOpex(tile: MapTile): number {
  return tile.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1)
}

function groupForKind(kind: string): GroupId {
  if (isHqKind(kind)) return 'hq'
  if (kind === 'lab') return 'lab'
  if (isDcKind(kind)) return 'dc'
  if (
    kind === 'substation' ||
    kind === 'solar' ||
    kind === 'gas' ||
    kind === 'nuclear' ||
    kind === 'battery' ||
    kind === 'cooling'
  ) {
    return 'power'
  }
  if (kind === 'fab') return 'fab'
  return 'other'
}

function kindLabel(kind: string): string {
  if (isBuildableKind(kind as never)) {
    try {
      return getBuildDef(kind as never).label
    } catch {
      /* fall through */
    }
  }
  return kind
}

function isPlayerFacility(t: MapTile): boolean {
  if (t.owner !== 'player') return false
  if (t.kind === 'empty' || isScenicKind(t.kind)) return false
  if (t.campusRole === 'pad') return false
  return isBuildableKind(t.kind)
}

function isBuildingRowControlTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  return Boolean(target.closest('[data-building-row-control="true"]'))
}

/**
 * Fleet → Buildings: all player facilities (HQ, labs, halls, power, fab).
 */
export function FleetBuildingsPanel() {
  const state = useGameStore((s) => s.state)
  const selected = useGameStore((s) => s.selectedTile)
  const openSites = useGameStore((s) => s.openSites)
  const setPanel = useGameStore((s) => s.setPanel)

  const facilities = facilityAnchorTiles(state, { ownerId: 'player' }).filter(isPlayerFacility)
  const constructing = facilities.filter(
    (t) => t.buildingTarget > 0 && t.buildingProgress < t.buildingTarget,
  )
  const live = facilities.filter(
    (t) => t.buildingProgress >= t.buildingTarget || t.buildingTarget <= 0,
  )

  const byGroup = new Map<GroupId, MapTile[]>()
  for (const t of live) {
    const g = groupForKind(t.kind)
    const list = byGroup.get(g) ?? []
    list.push(t)
    byGroup.set(g, list)
  }

  const staff = playerStaff(state)
  const hqCap = playerHqStaffCap(state)
  const selKey = selected ? `${selected.x},${selected.y}` : null

  return (
    <PanelScaffold
      eyebrow="Fleet"
      title="Buildings"
      description="HQs, labs, halls, and plants you own."
      mobileDescription="Manage sites and construction."
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <HudButton type="button" variant="ghost" onClick={() => setPanel('org')}>
            People
          </HudButton>
          <HudButton type="button" variant="primary" onClick={() => openSites()}>
            Sites
          </HudButton>
        </div>
      }
    >
      <div className="min-w-0 touch-pan-y space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile label="Facilities" value={String(live.length)} tone="positive" />
          <MetricTile
            label="Building"
            value={String(constructing.length)}
            mobilePriority={constructing.length > 0 ? 'primary' : 'secondary'}
            tone={constructing.length > 0 ? 'warning' : 'neutral'}
          />
          <MetricTile
            label="HQ desks"
            value={`${staffTotal(staff)}/${hqCap}`}
            mobilePriority="secondary"
            tone={hqCap > 0 ? 'positive' : 'neutral'}
          />
          <MetricTile
            label="Researchers"
            value={String(staff.researcher)}
            mobilePriority="secondary"
            tone="research"
          />
        </div>

        {constructing.length > 0 ? (
          <GameCard eyebrow="Construction" title="Under construction" tone="train" live>
            <div
              className="anim-stagger panel-scroll -mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-1 pb-1 touch-pan-x touch-pan-y min-[1181px]:mx-0 min-[1181px]:block min-[1181px]:space-y-2 min-[1181px]:overflow-visible min-[1181px]:px-0 min-[1181px]:pb-0"
              role="region"
              aria-label="Buildings under construction; swipe horizontally to browse on touch screens"
            >
              {constructing.map((t) => {
                const left = Math.max(0, t.buildingTarget - t.buildingProgress)
                const pct = t.buildingProgress / Math.max(1, t.buildingTarget)
                return (
                  <div key={`c-${t.x}-${t.y}`} className="w-[88%] shrink-0 snap-start min-[1181px]:w-auto">
                    <BuildingRow
                      tile={t}
                      active={selKey === `${t.x},${t.y}`}
                      badge={`${left}d left`}
                      badgeTone="warning"
                    >
                      <MeterBar
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <LiveDot className="text-amber" />
                            {kindLabel(t.kind)}
                          </span>
                        }
                        value={pct}
                        detail={`D${t.buildingProgress}/${t.buildingTarget}`}
                        tone="train"
                        live
                      />
                      <div className="mt-1.5 break-words font-mono text-[0.75rem] tabular-nums text-muted">
                        {t.rackCapacity > 0 ? `${t.rackCapacity} bays` : null}
                        {isHqKind(t.kind)
                          ? ` · ${getBuildDef(t.kind === 'office' ? 'hq' : (t.kind as never)).staffCap ?? '—'} desks`
                          : ''}
                      </div>
                      <div
                        className="mt-1.5"
                        data-building-row-control="true"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <BuildingDisposeButtons x={t.x} y={t.y} constructing compact />
                      </div>
                    </BuildingRow>
                  </div>
                )
              })}
            </div>
          </GameCard>
        ) : null}

        {live.length === 0 && constructing.length === 0 ? (
          <EmptyState
            title="No buildings yet"
            description="Open Sites to place an HQ, data hall, or power plant."
            action={
              <HudButton type="button" variant="primary" onClick={() => openSites()}>
                Open Sites
              </HudButton>
            }
          />
        ) : (
          GROUP_ORDER.map((gid) => {
            const list = byGroup.get(gid)
            if (!list?.length) return null
            return (
              <section key={gid} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-bone">{GROUP_LABELS[gid]}</h3>
                  <span className="font-mono text-[0.6875rem] tabular-nums text-muted">{list.length}</span>
                </div>
                <div className="anim-stagger space-y-1.5">
                  {list.map((t) => (
                    <BuildingRow
                      key={`${t.x}-${t.y}`}
                      tile={t}
                      active={selKey === `${t.x},${t.y}`}
                      badge={kindLabel(t.kind)}
                    >
                      <BuildingDetail tile={t} staffResearchers={staff.researcher} />
                      <div
                        className="mt-1.5"
                        data-building-row-control="true"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <BuildingDisposeButtons x={t.x} y={t.y} constructing={false} compact />
                      </div>
                    </BuildingRow>
                  ))}
                </div>
              </section>
            )
          })
        )}

        {hqCap > 0 ? (
          <HudDesktopDefaultDetails className="group rounded-lg border border-line/70 bg-panel-2/45">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 marker:hidden">
              <span>
                <span className="hud-eyebrow block">People</span>
                <strong className="mt-0.5 block text-sm text-bone">Staff roster</strong>
              </span>
              <span className="shrink-0 font-mono text-[0.75rem] tabular-nums text-bone">
                {staffTotal(staff)}/{hqCap}
              </span>
            </summary>
            <div className="grid grid-cols-2 gap-x-3 border-t border-line/60 px-3 py-2">
              {(Object.keys(STAFF_LABELS) as (keyof typeof STAFF_LABELS)[]).map((role) => (
                <StatRow key={role} label={STAFF_LABELS[role]} value={staff[role]} />
              ))}
            </div>
          </HudDesktopDefaultDetails>
        ) : null}
      </div>
    </PanelScaffold>
  )
}

function BuildingDetail({
  tile,
  staffResearchers,
}: {
  tile: MapTile
  staffResearchers: number
}) {
  if (isHqKind(tile.kind)) {
    const cap = getBuildDef(tile.kind === 'office' ? 'hq' : (tile.kind as never)).staffCap ?? 12
    const levelBonus = Math.max(0, tile.level - 1) * 4
    return (
      <div className="mt-0.5 break-words font-mono text-[0.75rem] leading-relaxed tabular-nums text-muted">
        L{tile.level} · up to {cap + levelBonus} desks · opex {money(displayedFacilityOpex(tile))}/d
        {staffResearchers > 0 ? ` · ${staffResearchers} researchers` : ''}
      </div>
    )
  }
  if (tile.kind === 'lab') {
    return (
      <div className="mt-0.5 break-words font-mono text-[0.75rem] leading-relaxed tabular-nums text-muted">
        L{tile.level} · research boost · opex {money(displayedFacilityOpex(tile))}/d
      </div>
    )
  }
  if (isDcKind(tile.kind)) {
    return (
      <div className="mt-0.5 break-words font-mono text-[0.75rem] leading-relaxed tabular-nums text-muted">
        L{tile.level} · {tile.racksUsed}/{tile.rackCapacity} bays
        {tile.powered === false ? ' · DOWN' : ''} · opex {money(displayedFacilityOpex(tile))}/d
      </div>
    )
  }
  if (tile.mwCapacity > 0 || tile.mwGeneration > 0) {
    return (
      <div className="mt-0.5 break-words font-mono text-[0.75rem] leading-relaxed tabular-nums text-muted">
        L{tile.level}
        {tile.mwCapacity > 0 ? ` · ${num(tile.mwCapacity, 1)} MW grid` : ''}
        {tile.mwGeneration > 0 ? ` · ${num(tile.mwGeneration, 1)} MW gen` : ''}
        {' · '}
        opex {money(displayedFacilityOpex(tile))}/d
      </div>
    )
  }
  return (
    <div className="mt-0.5 break-words font-mono text-[0.75rem] leading-relaxed tabular-nums text-muted">
      L{tile.level}
      {tile.opexPerDay > 0 ? ` · opex ${money(displayedFacilityOpex(tile))}/d` : ''}
    </div>
  )
}

export function BuildingRow({
  tile,
  active,
  badge,
  badgeTone = 'neutral',
  children,
}: {
  tile: MapTile
  active: boolean
  badge?: string
  badgeTone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'serve' | 'research'
  children?: ReactNode
}) {
  const select = () => useGameStore.getState().selectTile(tile.x, tile.y)

  return (
    <article
      aria-keyshortcuts="Enter Space"
      data-building-row="true"
      tabIndex={0}
      onClick={(event) => {
        activateBuildingRowFromClick(isBuildingRowControlTarget(event.target), select)
      }}
      onKeyDown={(event) => {
        if (activateBuildingRowFromKey(event.key, event.target === event.currentTarget, select)) {
          event.preventDefault()
        }
      }}
      className={`hover-lift min-w-0 w-full touch-manipulation cursor-pointer rounded-lg border px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint/50 sm:px-3 ${
        active ? 'border-mint/50 bg-mint/10' : 'border-line/70 bg-panel-2/70 hover:border-mint/30'
      }`}
    >
      <div className="flex items-start justify-between gap-2 text-sm">
        <div
          className="min-w-0 flex-1"
          data-building-row-control="true"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <BuildingNameField tile={tile} compact />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {badge ? <StatusChip tone={badgeTone}>{badge}</StatusChip> : null}
          <HudButton
            type="button"
            variant="ghost"
            aria-label="Select building"
            data-building-row-control="true"
            className="min-h-11 min-w-11 border-transparent p-0 text-muted hover:text-mint sm:min-h-8 sm:min-w-8"
            onClick={(event) => {
              event.stopPropagation()
              select()
            }}
          >
            <CaretRight size="0.9rem" aria-hidden />
          </HudButton>
        </div>
      </div>
      {children}
    </article>
  )
}
