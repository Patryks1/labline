import type { ReactNode } from 'react'
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
import { ECONOMY } from '../../../sim/balance/economy'

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
    <div className="space-y-4">
      <div>
        <h2 className="hud-panel-title">Buildings</h2>
        <p className="hud-panel-sub">
          HQs, labs, halls, and plants you own. Place new ones under{' '}
          <button type="button" className="text-mint hover:underline" onClick={() => openSites()}>
            Sites
          </button>
          . Staff HQs under{' '}
          <button
            type="button"
            className="text-mint hover:underline"
            onClick={() => setPanel('org')}
          >
            People
          </button>
          .
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini label="Facilities" value={String(live.length)} />
        <Mini label="Building" value={String(constructing.length)} accent="text-amber" />
        <Mini
          label="HQ desks"
          value={`${staffTotal(staff)}/${hqCap}`}
          accent={hqCap > 0 ? 'text-mint' : 'text-muted'}
        />
        <Mini label="Researchers" value={String(staff.researcher)} />
      </div>

      {constructing.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
            Under construction
          </h3>
          <div className="space-y-1.5">
            {constructing.map((t) => {
              const left = Math.max(0, t.buildingTarget - t.buildingProgress)
              const pct = (t.buildingProgress / Math.max(1, t.buildingTarget)) * 100
              return (
                <BuildingRow
                  key={`c-${t.x}-${t.y}`}
                  tile={t}
                  active={selKey === `${t.x},${t.y}`}
                  badge={`${left}d left`}
                  badgeClass="text-amber"
                >
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-void">
                    <div className="h-full bg-amber" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
                    {kindLabel(t.kind)} · day {t.buildingProgress}/{t.buildingTarget}
                    {t.rackCapacity > 0 ? ` · ${t.rackCapacity} bays` : ''}
                    {isHqKind(t.kind)
                      ? ` · ${getBuildDef(t.kind === 'office' ? 'hq' : (t.kind as never)).staffCap ?? '—'} desks`
                      : ''}
                  </div>
                  <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                    <BuildingDisposeButtons x={t.x} y={t.y} constructing compact />
                  </div>
                </BuildingRow>
              )
            })}
          </div>
        </section>
      )}

      {live.length === 0 && constructing.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel-2 px-3 py-3 text-[0.8125rem] text-muted">
          No buildings yet — open{' '}
          <button type="button" className="text-mint" onClick={() => openSites()}>
            Sites
          </button>{' '}
          to place an HQ, data hall, or power plant.
        </p>
      ) : (
        GROUP_ORDER.map((gid) => {
          const list = byGroup.get(gid)
          if (!list?.length) return null
          return (
            <section key={gid}>
              <h3 className="mb-1.5 text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
                {GROUP_LABELS[gid]}
                <span className="ml-1.5 font-mono text-[0.75rem] text-muted/80">{list.length}</span>
              </h3>
              <div className="space-y-1.5">
                {list.map((t) => (
                  <BuildingRow
                    key={`${t.x}-${t.y}`}
                    tile={t}
                    active={selKey === `${t.x},${t.y}`}
                    badge={kindLabel(t.kind)}
                  >
                    <BuildingDetail tile={t} staffResearchers={staff.researcher} />
                    <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <BuildingDisposeButtons x={t.x} y={t.y} constructing={false} compact />
                    </div>
                  </BuildingRow>
                ))}
              </div>
            </section>
          )
        })
      )}

      {hqCap > 0 && (
        <div className="rounded-xl border border-line bg-panel-2 p-3">
          <h3 className="text-[0.8125rem] font-medium text-bone">Staff roster</h3>
          <div className="mt-1.5 grid grid-cols-2 gap-1 font-mono text-[0.75rem] text-muted">
            {(Object.keys(STAFF_LABELS) as (keyof typeof STAFF_LABELS)[]).map((role) => (
              <div key={role} className="flex justify-between gap-2 rounded-lg bg-void/40 px-2 py-1">
                <span>{STAFF_LABELS[role]}</span>
                <span className="text-bone">{staff[role]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BuildingDetail({
  tile,
  staffResearchers,
}: {
  tile: MapTile
  staffResearchers: number
}) {
  const regionNote = ''
  if (isHqKind(tile.kind)) {
    const cap =
      getBuildDef(tile.kind === 'office' ? 'hq' : (tile.kind as never)).staffCap ?? 12
    const levelBonus = Math.max(0, tile.level - 1) * 4
    return (
      <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
        L{tile.level} · up to {cap + levelBonus} desks · opex {money(displayedFacilityOpex(tile))}/d
        {staffResearchers > 0 ? ` · ${staffResearchers} researchers on payroll` : ''}
      </div>
    )
  }
  if (tile.kind === 'lab') {
    return (
      <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
        L{tile.level} · research mult boost · opex {money(displayedFacilityOpex(tile))}/d
      </div>
    )
  }
  if (isDcKind(tile.kind)) {
    return (
      <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
        L{tile.level} · {tile.racksUsed}/{tile.rackCapacity} bays
        {tile.powered === false ? ' · DOWN' : ''} · opex {money(displayedFacilityOpex(tile))}/d
      </div>
    )
  }
  if (tile.mwCapacity > 0 || tile.mwGeneration > 0) {
    return (
      <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
        L{tile.level}
        {tile.mwCapacity > 0 ? ` · ${num(tile.mwCapacity, 1)} MW grid` : ''}
        {tile.mwGeneration > 0 ? ` · ${num(tile.mwGeneration, 1)} MW gen` : ''}
        {' · '}
        opex {money(displayedFacilityOpex(tile))}/d
      </div>
    )
  }
  return (
    <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
      L{tile.level}
      {tile.opexPerDay > 0 ? ` · opex ${money(displayedFacilityOpex(tile))}/d` : ''}
      {regionNote}
    </div>
  )
}

function BuildingRow({
  tile,
  active,
  badge,
  badgeClass = 'text-muted',
  children,
}: {
  tile: MapTile
  active: boolean
  badge?: string
  badgeClass?: string
  children?: ReactNode
}) {
  const select = () => useGameStore.getState().selectTile(tile.x, tile.y)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={select}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select()
        }
      }}
      className={`w-full rounded-xl border px-3 py-2 text-left transition ${
        active ? 'border-mint/50 bg-mint/10' : 'border-line bg-panel-2 hover:border-mint/30'
      }`}
    >
      <div className="flex items-start justify-between gap-2 text-sm">
        <div
          className="min-w-0 flex-1"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <BuildingNameField tile={tile} compact />
        </div>
        {badge && (
          <span className={`shrink-0 font-mono text-[0.75rem] ${badgeClass}`}>{badge}</span>
        )}
      </div>
      {children}
    </div>
  )
}

function Mini({
  label,
  value,
  accent = 'text-bone',
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-2.5 py-2">
      <div className="text-[0.75rem] text-muted">{label}</div>
      <div className={`font-mono text-sm ${accent}`}>{value}</div>
    </div>
  )
}
