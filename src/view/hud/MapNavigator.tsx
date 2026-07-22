import {
  Buildings,
  CaretLeft,
  CaretRight,
  Factory,
  Lightning,
  MapTrifold,
  ShieldWarning,
  Timer,
} from '@phosphor-icons/react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import type { MapOverlayMode } from '../../sim/types'
import { useGameStore } from '../../store/gameStore'
import {
  buildMapNavigatorData,
  buildMinimapTerrain,
  minimapTerrainColor,
  regionOverlayFill,
  type MapNavigatorSite,
  type MapNavigatorTerrainCell,
} from './mapNavigatorData'

const OVERLAYS: Array<{
  id: Exclude<MapOverlayMode, 'none'>
  label: string
  title: string
  icon: typeof MapTrifold
}> = [
  { id: 'zones', label: 'Zones', title: 'Show city and market zones', icon: MapTrifold },
  { id: 'power', label: 'Power', title: 'Show regional energy cost', icon: Lightning },
  { id: 'latency', label: 'Latency', title: 'Show distance-to-market latency', icon: Timer },
  { id: 'risk', label: 'Risk', title: 'Show regulatory risk', icon: ShieldWarning },
]

type BuildingFilter = 'all' | 'player' | 'rival'

/**
 * Compact Capitalism Lab-style world navigator.
 * Overlay icons drive both the minimap and the live map via gameStore.mapOverlay.
 */
export function MapNavigator() {
  const state = useGameStore((store) => store.state)
  const selectedTile = useGameStore((store) => store.selectedTile)
  const focusMapTile = useGameStore((store) => store.focusMapTile)
  const overlay = useGameStore((store) => store.mapOverlay)
  const setMapOverlay = useGameStore((store) => store.setMapOverlay)
  const mapViewport = useGameStore((store) => store.mapViewport)
  const [buildingFilter, setBuildingFilter] = useState<BuildingFilter>('all')
  const [buildingIndex, setBuildingIndex] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const map = state.map
  const config = state.config
  const terrain = useMemo(
    () => buildMinimapTerrain({ map, config }),
    [config, map],
  )
  const data = useMemo(() => buildMapNavigatorData(state, terrain), [state, terrain])

  const sites = useMemo(() => {
    if (buildingFilter === 'player') return data.sites.filter((site) => site.ownerType === 'player')
    if (buildingFilter === 'rival') return data.sites.filter((site) => site.ownerType === 'rival')
    return data.sites
  }, [buildingFilter, data.sites])

  const focus = useCallback((x: number, y: number) => {
    focusMapTile(
      Math.max(0, Math.min(data.width - 1, Math.round(x))),
      Math.max(0, Math.min(data.height - 1, Math.round(y))),
    )
  }, [data.height, data.width, focusMapTile])

  const focusFromMap = useCallback((event: MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    focus(
      ((event.clientX - rect.left) / rect.width) * data.width,
      ((event.clientY - rect.top) / rect.height) * data.height,
    )
  }, [data.height, data.width, focus])

  const activeSite = sites.length > 0 ? sites[buildingIndex % sites.length]! : null

  const setOverlay = (id: Exclude<MapOverlayMode, 'none'>) => {
    setMapOverlay(overlay === id ? 'none' : id)
  }

  return (
    <aside className="map-navigator hud-surface pointer-events-auto absolute z-[18] w-[17.5rem] overflow-hidden rounded-lg">
      <div className="relative z-10">
        <div className="flex items-center gap-1.5 border-b border-line/70 px-2 py-1.5">
          <button
            type="button"
            aria-label="Previous building"
            disabled={sites.length === 0}
            onClick={() => {
              if (sites.length === 0) return
              const next = (buildingIndex - 1 + sites.length) % sites.length
              setBuildingIndex(next)
              const site = sites[next]!
              focus(site.x, site.y)
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line/70 text-muted hover:bg-panel-2 hover:text-bone disabled:opacity-40"
          >
            <CaretLeft size="0.9rem" />
          </button>
          <button
            type="button"
            disabled={!activeSite}
            onClick={() => activeSite && focus(activeSite.x, activeSite.y)}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line/70 bg-panel-2/50 px-2 text-left hover:border-mint/40 disabled:opacity-50"
          >
            {activeSite ? (
              <>
                <Factory size="0.8rem" className="shrink-0" style={{ color: activeSite.color }} />
                <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-bone">
                  {activeSite.label}
                </span>
                <span className="shrink-0 truncate font-mono text-[0.625rem] text-muted">
                  {activeSite.ownerName} · {buildingIndex % sites.length + 1}/{sites.length}
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
                <Buildings size="0.85rem" /> No facilities
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label="Next building"
            disabled={sites.length === 0}
            onClick={() => {
              if (sites.length === 0) return
              const next = (buildingIndex + 1) % sites.length
              setBuildingIndex(next)
              const site = sites[next]!
              focus(site.x, site.y)
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line/70 text-muted hover:bg-panel-2 hover:text-bone disabled:opacity-40"
          >
            <CaretRight size="0.9rem" />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-line/70 px-2 py-1.5">
          {([
            ['all', 'All'],
            ['player', 'Yours'],
            ['rival', 'Rivals'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={buildingFilter === id}
              onClick={() => {
                setBuildingFilter(id)
                setBuildingIndex(0)
              }}
              className={`h-8 rounded-md px-2 text-[0.625rem] font-medium ${buildingFilter === id ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-1 border-b border-line/70 bg-void/35 px-2 py-1.5">
          {OVERLAYS.map(({ id, label, title, icon: Icon }) => (
            <button
              key={id}
              type="button"
              title={title}
              aria-label={label}
              aria-pressed={overlay === id}
              onClick={() => setOverlay(id)}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${overlay === id ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
            >
              <Icon size="0.95rem" weight={overlay === id ? 'fill' : 'duotone'} />
            </button>
          ))}
        </div>

        <div className="relative border-b border-line/70 bg-[#071319] p-1.5">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${data.width} ${data.height}`}
            preserveAspectRatio="none"
            role="application"
            aria-label="World minimap. Click to focus the main map."
            onClick={focusFromMap}
            className="h-36 w-full cursor-crosshair rounded-md border border-line/80 bg-void shadow-inner"
          >
            <TerrainLayer cells={data.terrain} />
            {overlay !== 'none' ? (
              data.regions.map((region, index) => (
                <rect
                  key={region.id}
                  x={region.originX}
                  y={region.originY}
                  width={region.width}
                  height={region.height}
                  fill={regionOverlayFill(region, data.regions, overlay, index)}
                  fillOpacity={0.42}
                  stroke="rgba(145,166,173,0.28)"
                  strokeWidth="0.6"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                >
                  <title>{region.name}</title>
                </rect>
              ))
            ) : null}
            {data.cities.map((city) => (
              <g key={city.id} pointerEvents="none">
                <circle
                  cx={city.cx}
                  cy={city.cy}
                  r={Math.max(1.6, city.radius * 0.55)}
                  fill="rgba(95,167,232,0.10)"
                  stroke="rgba(95,167,232,0.45)"
                  strokeWidth="0.55"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
            {sites.map((site) => (
              <SiteMarker key={`${site.ownerId}-${site.id}`} site={site} onFocus={focus} />
            ))}
            {mapViewport ? (
              <rect
                x={mapViewport.x}
                y={mapViewport.y}
                width={Math.max(1, mapViewport.w)}
                height={Math.max(1, mapViewport.h)}
                fill="rgba(232,242,242,0.08)"
                stroke="#e8f2f2"
                strokeWidth="1.1"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            ) : null}
            {selectedTile ? (
              <g pointerEvents="none">
                <circle
                  cx={selectedTile.x + 0.5}
                  cy={selectedTile.y + 0.5}
                  r="2.6"
                  fill="none"
                  stroke="#e8f2f2"
                  strokeWidth="1.1"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ) : null}
          </svg>
          <div className="pointer-events-none absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-md border border-line/70 bg-void/85 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-mint" /> Yours
            <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Rivals
          </div>
        </div>

      </div>
    </aside>
  )
}

function TerrainLayer({ cells }: { cells: readonly MapNavigatorTerrainCell[] }) {
  return (
    <g aria-hidden="true" pointerEvents="none">
      {cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={cell.size}
          height={cell.size}
          fill={minimapTerrainColor(cell.kind)}
        />
      ))}
    </g>
  )
}

function SiteMarker({
  site,
  onFocus,
}: {
  site: MapNavigatorSite
  onFocus: (x: number, y: number) => void
}) {
  const size = site.ownerType === 'player' ? 2.5 : 2.2
  return (
    <g
      role="button"
      aria-label={`Focus ${site.label}, ${site.ownerName}`}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation()
        onFocus(site.x, site.y)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onFocus(site.x, site.y)
      }}
      className="cursor-pointer outline-none"
    >
      <circle cx={site.x + 0.5} cy={site.y + 0.5} r={size + 1.1} fill="rgba(7,17,23,0.76)" />
      {site.ownerType === 'player' ? (
        <rect
          x={site.x + 0.5 - size / 2}
          y={site.y + 0.5 - size / 2}
          width={size}
          height={size}
          rx="0.35"
          fill={site.color}
          stroke="#e8f2f2"
          strokeWidth="0.55"
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <circle
          cx={site.x + 0.5}
          cy={site.y + 0.5}
          r={size / 2}
          fill={site.color}
          stroke="#e8f2f2"
          strokeWidth="0.55"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {site.constructing ? (
        <circle
          cx={site.x + 0.5}
          cy={site.y + 0.5}
          r={size + 0.55}
          fill="none"
          stroke="#e8ad56"
          strokeWidth="0.65"
          strokeDasharray="1.4 1"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <title>{site.label} · {site.ownerName}</title>
    </g>
  )
}
