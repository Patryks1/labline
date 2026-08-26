import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
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
import { mapTileAtAny, municipalPowerPlantAt } from '../../sim/systems/worldAccess'
import { cityStatsForIndex } from '../../sim/systems/cityStats'
import { cityIndexFromFeature } from '../../sim/world'
import {
  transportAccessFactorAt,
  transportRegionalCongestionAt,
  transportRoadClassAt,
} from '../../sim/systems/transport'
import { HudButton, HudCloseButton } from './ui/HudPrimitives'
import { isSheetDismissSwipe } from './menu/mobileOverlayGestures'

const ROAD_CLASS_LABELS = ['No road', 'Local', 'Collector', 'Arterial', 'Highway'] as const
const MUNICIPAL_KIND_LABELS = {
  coal: 'Coal power station',
  wind: 'Municipal wind farm',
  solar: 'Municipal solar farm',
  nuclear: 'Nuclear power station',
} as const

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
  const dismissSwipe = useRef<{ pointerId: number; x: number; y: number } | null>(null)

  if (!selected) return null
  const tile = mapTileAtAny(state, selected.x, selected.y)
  if (!tile) return null
  const municipalPlant = municipalPowerPlantAt(state, selected.x, selected.y)
  const compactWorld = state.map.storage === 'compact' ? state.map.world : undefined
  const selectedTileId = selected.y * state.map.width + selected.x
  const featureCityIndex = compactWorld
    ? cityIndexFromFeature(compactWorld.staticWorld.feature[selectedTileId] ?? 0)
    : undefined
  const cityIndex = municipalPlant?.cityIndex ?? featureCityIndex
  const cityStats = cityIndex === undefined ? undefined : cityStatsForIndex(state, cityIndex)

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
    : municipalPlant
      ? 'Municipal utility'
      : tile.powered === false && isDcKind(tile.kind)
      ? 'Power down'
      : isBuildableKind(tile.kind)
        ? 'Online'
        : tile.kind === 'empty'
          ? 'Vacant'
          : 'Scenic'

  const openSelectedFacility = (e: ReactMouseEvent) => {
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
    setCommandView('sites')
  }

  const metrics: Array<{ label: string; value: string; tone?: string }> = []
  if (region) metrics.push({ label: 'Zone', value: region.name })
  metrics.push({ label: 'Type', value: municipalPlant ? MUNICIPAL_KIND_LABELS[municipalPlant.kind] : typeLabel(tile.kind) })

  if (municipalPlant) {
    const city = state.map.world?.staticWorld.cities[municipalPlant.cityIndex]
    metrics.push({ label: 'Output', value: `${num(municipalPlant.capacityMw, 0)} MW` })
    if (city) metrics.push({ label: 'Serves', value: city.name })
  }

  if (isOurs && isBuildableKind(tile.kind)) {
    metrics.push({ label: 'Level', value: `L${tile.level}` })
    if (tile.opexPerDay > 0) {
      metrics.push({ label: 'Opex', value: `${money(tile.opexPerDay)}/d` })
    }
  }

  if (cityStats) {
    const citySupply = cityStats.municipalCapacityMw
    const cityDemand = cityStats.municipalDemandMw
    metrics.push({
      label: 'Grid',
      value: `${num(citySupply, 0)} / ${num(cityDemand, 0)} MW`,
    })
    metrics.push({
      label: 'Reserve',
      value: `${cityStats.reserveMargin >= 0 ? '+' : ''}${num(cityStats.reserveMargin * 100, 0)}%`,
      tone: cityStats.reserveMargin < 0 ? 'text-amber' : 'text-mint',
    })
  }

  if (isDcKind(tile.kind) && isDcAnchor(tile)) {
    if (usage) {
      metrics.push({ label: 'Placed', value: `${usage.used} rack-width` })
      metrics.push({ label: 'Online', value: `${usage.live} rack-width` })
      if (usage.staged > 0)
        metrics.push({ label: 'Staged', value: `${usage.staged} rack-width` })
    } else {
      metrics.push({ label: 'Placed', value: `${tile.racksUsed} rack-width` })
    }
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

  const tileId = tile.y * state.map.width + tile.x
  const roadClass = transportRoadClassAt(state, tileId)
  const access = transportAccessFactorAt(state, tileId)
  const congestion = transportRegionalCongestionAt(state, tileId)
  metrics.push({ label: 'Road', value: ROAD_CLASS_LABELS[roadClass] ?? 'Road' })
  metrics.push({
    label: 'Access',
    value: `${Math.round(access * 100)}% · ${Math.round((1 / access - 1) * 100)}% delay`,
    tone: access < 0.9 ? 'text-amber' : 'text-mint',
  })
  metrics.push({ label: 'Congestion', value: congestion < 0.15 ? 'Free flow' : `${Math.round(congestion * 100)}%` })

  const shown = metrics.slice(0, 8)

  const startDismissSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return
    dismissSwipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const finishDismissSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dismissSwipe.current
    dismissSwipe.current = null
    if (!start || start.pointerId !== event.pointerId) return
    if (isSheetDismissSwipe(start, { x: event.clientX, y: event.clientY })) clearSelection()
  }

  return (
    <div
      className={`tile-inspector hud-surface pointer-events-auto absolute z-40 rounded-lg p-3 transition-all ${
        mapTool === 'destroy' && isOurs && isBuildableKind(tile.kind)
          ? 'ring-2 ring-danger/50'
          : ''
      }`}
      data-swipe-dismiss="down"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="touch-pan-x border-b border-line/60 pb-2"
        onPointerDown={(event) => {
          event.stopPropagation()
          startDismissSwipe(event)
        }}
        onPointerUp={finishDismissSwipe}
        onPointerCancel={() => { dismissSwipe.current = null }}
      >
        <span aria-hidden className="mx-auto mb-2 hidden h-1 w-10 rounded-full bg-line max-sm:block [@media(max-height:540px)]:block" />
        <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted">
            {statusLabel}
            {region ? <span className="max-sm:hidden [@media(max-height:540px)]:hidden"> · {region.name}</span> : null}
          </div>
          <div className="mt-0.5">
            {isOurs && isBuildableKind(tile.kind) ? (
              <BuildingNameField tile={tile} compact />
            ) : (
              <div className="truncate text-sm font-medium text-bone">
                {municipalPlant ? MUNICIPAL_KIND_LABELS[municipalPlant.kind] : tile.name || typeLabel(tile.kind)}
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
          <HudCloseButton
            label="Close inspector"
            onClick={() => clearSelection()}
            className="tile-inspector__close"
          />
        </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[0.75rem] text-muted">
        {shown.map((row, index) => (
          <div key={row.label} className={`contents ${index >= 5 ? 'max-sm:hidden [@media(max-height:540px)]:hidden' : ''}`}>
            <span>{row.label}</span>
            <span className={`text-right ${row.tone ?? 'text-bone'}`}>{row.value}</span>
          </div>
        ))}
      </div>

      {constructing && (
        <p className="mt-2 text-[0.75rem] text-amber">Under construction.</p>
      )}

      {(isRival || isOurs) && isBuildableKind(tile.kind) && (
        <HudButton
          type="button"
          variant="ghost"
          className="mt-2.5 min-h-11 w-full border-mint/40 bg-mint/10 px-3 py-2 text-[0.75rem] font-medium text-mint hover:bg-mint/20"
          onClick={openSelectedFacility}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="sm:hidden">{isRival ? 'Rival fleet' : 'Open site'}</span>
          <span className="hidden sm:inline">{isRival ? 'Inspect rival fleet' : 'Inspect site'}</span>
        </HudButton>
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
