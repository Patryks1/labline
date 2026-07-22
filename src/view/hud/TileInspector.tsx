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
import { useUiStore } from '../../store/uiStore'
import { money, num } from './format'
import { BuildingNameField } from './ui/BuildingNameField'
import { BuildingDisposeButtons } from './panels/MapPanel'
import { mapTileAtAny } from '../../sim/systems/worldAccess'

function typeLabel(kind: string): string {
  if (isDcKind(kind) && isBuildableKind(kind as never)) {
    return getBuildDef(kind as never).label
  }
  if (isBuildableKind(kind as never)) return getBuildDef(kind as never).label
  if (isScenicKind(kind as never)) return scenicLabel(kind as never)
  if (kind === 'empty') return 'Open land'
  return kind
}

/**
 * Compact floating card when a map tile is selected.
 * Identity + owner + status + a few context metrics only.
 */
export function TileInspector() {
  const selected = useGameStore((s) => s.selectedTile)
  const state = useGameStore((s) => s.state)
  const mapTool = useGameStore((s) => s.mapTool)
  const clearSelection = useGameStore((s) => s.clearSelection)
  const openFleetForOwner = useGameStore((s) => s.openFleetForOwner)
  const setSelectedRivalId = useGameStore((s) => s.setSelectedRivalId)
  const setUiSelectedRivalId = useUiStore((s) => s.setSelectedRivalId)
  const setCommandView = useGameStore((s) => s.setCommandView)

  if (!selected) return null
  const tile = mapTileAtAny(state, selected.x, selected.y)
  if (!tile) return null

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
  const region = state.map.regions.find((r) => r.id === tile.regionId)
  const statusLabel = constructing
    ? 'Building'
    : tile.powered === false && isDcKind(tile.kind)
      ? 'Power down'
      : isBuildableKind(tile.kind)
        ? 'Online'
        : tile.kind === 'empty'
          ? 'Vacant'
          : 'Scenic'

  const goFleet = (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isRival) {
      setSelectedRivalId(tile.owner)
      setUiSelectedRivalId(tile.owner)
      setCommandView('rivals')
      openFleetForOwner(tile.owner)
      return
    }
    setUiSelectedRivalId(null)
    openFleetForOwner('player')
  }

  const metrics: Array<{ label: string; value: string; tone?: string }> = []
  if (region) metrics.push({ label: 'Zone', value: region.name })
  metrics.push({ label: 'Type', value: typeLabel(tile.kind) })

  if (isDcKind(tile.kind) && isDcAnchor(tile)) {
    const bays = usage
      ? `${usage.used}/${usage.capacity}`
      : `${tile.racksUsed}/${tile.rackCapacity}`
    metrics.push({ label: 'Bays', value: bays })
  } else if (tile.kind === 'empty' && (tile.landValue ?? 0) > 0) {
    metrics.push({ label: 'Land', value: money(tile.landValue) })
  } else if ((tile.mwCapacity > 0 || tile.mwGeneration > 0) && isOurs) {
    metrics.push({
      label: 'Power',
      value: [
        tile.mwCapacity > 0 ? `${num(tile.mwCapacity, 1)} MW grid` : '',
        tile.mwGeneration > 0 ? `${num(tile.mwGeneration, 1)} MW gen` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })
  }

  // Identity + one context metric max for a dumb, action-led inspector.
  const shown = metrics.slice(0, 3)

  return (
    <div
      className={`tile-inspector hud-surface pointer-events-auto absolute z-40 rounded-lg p-3 transition-all ${
        mapTool === 'destroy' && isOurs && isBuildableKind(tile.kind)
          ? 'ring-2 ring-danger/50'
          : ''
      }`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted">
            {statusLabel}
            {region ? ` · ${region.name}` : ''}
          </div>
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
        {shown.map((row) => (
          <div key={row.label} className="contents">
            <span>{row.label}</span>
            <span className={`text-right ${row.tone ?? 'text-bone'}`}>{row.value}</span>
          </div>
        ))}
      </div>

      {constructing && (
        <p className="mt-2 text-[0.75rem] text-amber">Under construction.</p>
      )}

      {(isOurs || isRival || constructing) && isBuildableKind(tile.kind) && (
        <button
          type="button"
          className="mt-2.5 w-full rounded-lg border border-mint/40 bg-mint/10 py-1.5 text-[0.75rem] font-medium text-mint hover:bg-mint/20"
          onClick={goFleet}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {isRival ? 'Inspect rival fleet' : constructing ? 'Open Fleet' : 'Open Fleet'}
        </button>
      )}

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
