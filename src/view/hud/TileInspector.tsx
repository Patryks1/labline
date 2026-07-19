import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  getBuildDef,
  isBuildableKind,
  isDcAnchor,
  isDcKind,
  isScenicKind,
  ownerLabel,
  scenicLabel,
} from '../../sim/systems/map'
import { dcBayUsage } from '../../sim/systems/dcRacks'
import { useGameStore } from '../../store/gameStore'
import { money, mw, num } from './format'
import { BuildingNameField } from './ui/BuildingNameField'
import { BuildingDisposeButtons } from './panels/MapPanel'
import {
  facilityFootprintTiles,
  mapTileAtAny,
} from '../../sim/systems/worldAccess'
import { ECONOMY } from '../../sim/balance/economy'

function typeLabel(kind: string): string {
  if (isDcKind(kind) && isBuildableKind(kind as never)) {
    return getBuildDef(kind as never).label
  }
  if (isBuildableKind(kind as never)) return getBuildDef(kind as never).label
  if (isScenicKind(kind as never)) return scenicLabel(kind as never)
  if (kind === 'empty') return 'Open land'
  return kind
}

function sizeBlurb(kind: string, size?: string): string | null {
  if (!isDcKind(kind)) return null
  if (size === 'large' || kind === 'dc_l') return 'Large · 6 tiles · 960 bays'
  if (size === 'medium' || kind === 'dc_m') return 'Medium · 4 tiles · 288 bays'
  return 'Small · 1 tile · 96 bays'
}

/**
 * Floating card when a map tile is selected — always visible over the map
 * so players can inspect land / buildings without opening Sites.
 */
export function TileInspector() {
  const selected = useGameStore((s) => s.selectedTile)
  const state = useGameStore((s) => s.state)
  const clearSelection = useGameStore((s) => s.clearSelection)
  const openFleetPanel = useGameStore((s) => s.openFleet)

  if (!selected) return null
  const tile = mapTileAtAny(state, selected.x, selected.y)
  if (!tile) return null

  const goFleet = (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openFleetPanel()
  }

  const region = state.map.regions.find((r) => r.id === tile.regionId)
  const isOurs = tile.owner === 'player'
  const isRival = tile.owner !== 'player' && tile.owner !== 'neutral'
  const constructing = tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget
  const liveDc =
    isOurs &&
    isDcKind(tile.kind) &&
    isDcAnchor(tile) &&
    !constructing &&
    tile.buildingProgress >= tile.buildingTarget
  const usage = liveDc ? dcBayUsage(state, tile.x, tile.y) : null
  const campusN = tile.campusId
    ? facilityFootprintTiles(state, tile.campusId).length
    : 0
  const size = sizeBlurb(tile.kind, tile.dcSize)

  return (
    <div
      className="hud-surface pointer-events-auto absolute right-3 top-3 z-40 w-[min(21rem,calc(100%-1.5rem))] rounded-xl p-3 transition-all"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {region && (
            <div className="font-mono text-[0.75rem] text-muted">
              {region.name}
              {isBuildableKind(tile.kind) ? ` · ${typeLabel(tile.kind)}` : ''}
            </div>
          )}
          <div className="mt-0.5">
            {isOurs && isBuildableKind(tile.kind) ? (
              <BuildingNameField tile={tile} compact />
            ) : (
              <div className="truncate text-sm font-medium text-bone">
                {tile.name || typeLabel(tile.kind)}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[0.75rem] ${
              isOurs
                ? 'bg-mint/20 text-mint'
                : isRival
                  ? 'bg-amber/20 text-amber'
                  : 'bg-line text-muted'
            }`}
          >
            {ownerLabel(tile.owner, state)}
          </span>
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 text-[0.8125rem] text-muted hover:bg-line/40 hover:text-bone"
            onClick={() => clearSelection()}
            aria-label="Close inspector"
          >
            ×
          </button>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[0.75rem] text-muted">
        <span>Type</span>
        <span className="text-right text-bone">{typeLabel(tile.kind)}</span>

        {size && (
          <>
            <span>Class</span>
            <span className="text-right text-bone">{size}</span>
          </>
        )}

        {isDcKind(tile.kind) && (
          <>
            <span>Role</span>
            <span className="text-right text-bone">
              {tile.campusRole === 'pad' ? 'Pad' : 'Anchor'}
              {campusN > 1 ? ` · ${campusN} tiles` : ''}
            </span>
          </>
        )}

        {!isScenicKind(tile.kind) && tile.kind !== 'empty' && (
          <>
            <span>Level</span>
            <span className="text-right text-bone">L{tile.level}</span>
          </>
        )}

        {isDcKind(tile.kind) && isDcAnchor(tile) && (
          <>
            <span>Bays</span>
            <span className="text-right text-bone">
              {usage ? `${usage.used}/${usage.capacity}` : `${tile.racksUsed}/${tile.rackCapacity}`}
            </span>
            <span>Power</span>
            <span className={`text-right ${tile.powered === false ? 'text-danger' : 'text-mint'}`}>
              {tile.powered === false ? 'Down' : 'On'}
            </span>
            {usage && (
              <>
                <span>Hall load</span>
                <span className="text-right text-bone">
                  {mw(usage.mwLive)} · {num(usage.flopsLive, 1)} PF
                </span>
              </>
            )}
          </>
        )}

        {(tile.mwCapacity > 0 || tile.mwGeneration > 0) && (
          <>
            <span>Facility MW</span>
            <span className="text-right text-bone">
              {tile.mwCapacity > 0 ? `${num(tile.mwCapacity, 1)} grid` : ''}
              {tile.mwCapacity > 0 && tile.mwGeneration > 0 ? ' · ' : ''}
              {tile.mwGeneration > 0 ? `${num(tile.mwGeneration, 1)} gen` : ''}
            </span>
          </>
        )}

        {tile.kind === 'empty' && (tile.landValue ?? 0) > 0 && (
          <>
            <span>Land</span>
            <span className="text-right text-bone">{money(tile.landValue)}</span>
          </>
        )}

        {tile.opexPerDay > 0 && isOurs && (
          <>
            <span>Opex</span>
            <span className="text-right text-bone">
              {money(tile.opexPerDay * (ECONOMY.facilityOpexMultiplier ?? 1))}/d
            </span>
          </>
        )}

        {tile.capex > 0 && (
          <>
            <span>Capex</span>
            <span className="text-right text-bone">{money(tile.capex)}</span>
          </>
        )}
      </div>

      {constructing && (
        <p className="mt-2 text-[0.75rem] text-amber">
          Under construction — progress is in Fleet → Racks.
        </p>
      )}

      {tile.note && (
        <p className="mt-2 line-clamp-2 text-[0.75rem] leading-snug text-muted">{tile.note}</p>
      )}

      {(isOurs || constructing) && isBuildableKind(tile.kind) && (
        <button
          type="button"
          className="mt-2.5 w-full rounded-lg border border-mint/40 bg-mint/10 py-1.5 text-[0.75rem] font-medium text-mint hover:bg-mint/20"
          onClick={goFleet}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {constructing ? 'Fleet → construction' : 'Open Fleet'}
        </button>
      )}

      {/* Sell / cancel — primary map surface (Sites panel alone was easy to miss) */}
      {isOurs && isBuildableKind(tile.kind) && (
        <div className="mt-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <BuildingDisposeButtons
            x={tile.x}
            y={tile.y}
            constructing={!!constructing}
          />
        </div>
      )}
    </div>
  )
}
