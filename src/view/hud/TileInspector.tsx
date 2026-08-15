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
import { mapTileAtAny, municipalPowerPlantAt } from '../../sim/systems/worldAccess'
import { cityStatsForIndex } from '../../sim/systems/cityStats'
import { cityIndexFromFeature } from '../../sim/world'
import {
  transportAccessFactorAt,
  transportRegionalCongestionAt,
  transportRoadClassAt,
} from '../../sim/systems/transport'

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
  metrics.push({ label: 'Type', value: municipalPlant ? MUNICIPAL_KIND_LABELS[municipalPlant.kind] : typeLabel(tile.kind) })

  if (municipalPlant) {
    const city = state.map.world?.staticWorld.cities[municipalPlant.cityIndex]
    metrics.push({ label: 'Output', value: `${num(municipalPlant.capacityMw, 0)} MW` })
    if (city) metrics.push({ label: 'Serves', value: city.name })
  }

  if (cityStats) {
    metrics.push({ label: 'Population', value: num(cityStats.population, 0) })
    metrics.push({ label: 'Municipal', value: `${num(cityStats.municipalCapacityMw, 0)} MW` })
    metrics.push({ label: 'Demand', value: `${num(cityStats.municipalDemandMw, 0)} MW` })
    const contractCount = cityStats.cityPowerContractCount + cityStats.powerExportContractCount
    metrics.push({
      label: 'Contracts',
      value: `${contractCount} · ${num(cityStats.cityPowerContractMw, 0)} MW out / ${num(cityStats.powerExportContractMw, 0)} MW in`,
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

  const shown = metrics.slice(0, cityStats ? 10 : 6)
  const citySupply = cityStats?.municipalCapacityMw ?? municipalPlant?.capacityMw ?? 0
  const cityDemand = cityStats?.municipalDemandMw ?? 0
  const utilization = citySupply > 0 ? Math.min(1.2, cityDemand / citySupply) : 0
  const facilityOutput = municipalPlant?.capacityMw ?? Math.max(tile.mwGeneration, tile.mwCapacity)
  const displayedSupply = citySupply || facilityOutput
  const reserveMargin = cityStats?.reserveMargin ?? 0
  const contractOutboundMw = cityStats?.cityPowerContractMw ?? 0
  const contractInboundMw = cityStats?.powerExportContractMw ?? 0
  const contractTotalMw = contractOutboundMw + contractInboundMw
  const powerFlowLabel = cityStats
    ? `${num(displayedSupply, 0)} megawatts capacity flowing to ${num(cityDemand, 0)} megawatts demand`
    : `${num(facilityOutput, 1)} megawatts facility output`

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
      <div className="flex items-start justify-between gap-2 border-b border-line/60 pb-2">
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
          <button
            type="button"
            className="tile-inspector__close flex min-h-11 min-w-11 items-center justify-center rounded-md text-[1rem] text-muted hover:bg-line/40 hover:text-bone"
            onClick={() => clearSelection()}
            aria-label="Close inspector"
          >
            ×
          </button>
        </div>
      </div>

      {(cityStats || facilityOutput > 0) && (
        <div className="mt-2 rounded-lg border border-line/70 bg-void/45 p-2" aria-label="Power flow">
          <div className="flex items-center justify-between gap-2 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted">
            <span>Live power flow</span>
            <span className={utilization > 1 ? 'text-danger' : utilization > 0.85 ? 'text-amber' : 'text-mint'}>
              {cityStats ? `${Math.round(utilization * 100)}% load` : `${num(facilityOutput, 1)} MW`}
            </span>
          </div>
          <svg viewBox="0 0 300 54" className="mt-1 h-12 w-full" role="img" aria-label={powerFlowLabel}>
            <defs><linearGradient id="tile-flow" x1="0" x2="1"><stop stopColor="#48d7d1"/><stop offset="1" stopColor={utilization > 1 ? '#f06a74' : '#e8ad56'}/></linearGradient></defs>
            <path d="M38 27 H262" stroke="#24404a" strokeWidth="8" strokeLinecap="round" />
            <path d="M38 27 H262" stroke="url(#tile-flow)" strokeWidth="3" strokeLinecap="round" strokeDasharray="7 5" />
            <circle cx="30" cy="27" r="13" fill="#10242d" stroke="#48d7d1" strokeWidth="2" />
            <circle cx="270" cy="27" r="13" fill="#10242d" stroke={utilization > 1 ? '#f06a74' : '#e8ad56'} strokeWidth="2" />
            <text x="30" y="30" textAnchor="middle" fill="#e8f2f2" fontSize="8">GEN</text>
            <text x="270" y="30" textAnchor="middle" fill="#e8f2f2" fontSize="8">LOAD</text>
            <text x="56" y="14" fill="#91a6ad" fontSize="8">{num(displayedSupply, 0)} MW capacity</text>
            <text x="244" y="48" textAnchor="end" fill="#91a6ad" fontSize="8">{cityStats ? `${num(cityDemand, 0)} MW demand` : statusLabel}</text>
          </svg>
          {cityStats ? (
            <div className="space-y-2">
              <div>
                <div className="mb-1 flex justify-between font-mono text-[0.5625rem] uppercase tracking-[0.08em] text-muted">
                  <span>Grid load</span><span>{Math.round(utilization * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line/70" role="meter" aria-label="Grid load" aria-valuemin={0} aria-valuemax={120} aria-valuenow={Math.round(utilization * 100)}>
                  <div className={`h-full rounded-full ${utilization > 1 ? 'bg-danger' : utilization > 0.85 ? 'bg-amber' : 'bg-mint'}`} style={{ width: `${Math.min(100, utilization * 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="mb-1 flex justify-between font-mono text-[0.5625rem] uppercase tracking-[0.08em] text-muted">
                  <span>Reserve health</span>
                  <span className={reserveMargin < 0 ? 'text-danger' : reserveMargin < 0.15 ? 'text-amber' : 'text-mint'}>
                    {reserveMargin >= 0 ? '+' : ''}{Math.round(reserveMargin * 100)}%
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-line/70" role="meter" aria-label="Reserve margin" aria-valuemin={-50} aria-valuemax={50} aria-valuenow={Math.round(reserveMargin * 100)}>
                  <div className="absolute inset-y-0 left-1/2 w-px bg-bone/35" />
                  <div
                    className={`absolute inset-y-0 ${reserveMargin < 0 ? 'right-1/2 bg-danger' : 'left-1/2 bg-mint'}`}
                    style={{ width: `${Math.min(50, Math.abs(reserveMargin) * 100)}%` }}
                  />
                </div>
              </div>
              {contractTotalMw > 0 ? (
                <div className="grid grid-cols-2 gap-1.5 font-mono text-[0.5625rem]">
                  <div className="rounded border border-line/60 bg-panel-2/70 px-1.5 py-1 text-muted">
                    Sold <strong className="block text-bone">{num(contractOutboundMw, 0)} MW</strong>
                  </div>
                  <div className="rounded border border-line/60 bg-panel-2/70 px-1.5 py-1 text-muted">
                    Imported <strong className="block text-bone">{num(contractInboundMw, 0)} MW</strong>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

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
          className="mt-2.5 min-h-11 w-full rounded-lg border border-mint/40 bg-mint/10 px-3 py-2 text-[0.75rem] font-medium text-mint hover:bg-mint/20"
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
