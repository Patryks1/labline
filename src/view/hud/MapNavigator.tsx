import {
  Buildings,
  CaretDown,
  CaretUp,
  Factory,
  Lightning,
  MapPin,
  MapTrifold,
  ShieldWarning,
  Timer,
  UsersThree,
} from '@phosphor-icons/react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { mapTileAtAny } from '../../sim/systems/worldAccess'
import { useGameStore } from '../../store/gameStore'
import {
  buildMapNavigatorData,
  regionOverlayFill,
  type MapNavigatorDirectory,
  type MapNavigatorOverlay,
  type MapNavigatorSite,
} from './mapNavigatorData'
import { pct } from './format'

const OVERLAYS: Array<{
  id: MapNavigatorOverlay
  label: string
  title: string
  icon: typeof MapTrifold
}> = [
  { id: 'zones', label: 'Zones', title: 'Show city and market zones', icon: MapTrifold },
  { id: 'energy', label: 'Power', title: 'Show regional energy cost', icon: Lightning },
  { id: 'latency', label: 'Latency', title: 'Show distance-to-market latency', icon: Timer },
  { id: 'risk', label: 'Risk', title: 'Show regulatory risk', icon: ShieldWarning },
]

const DIRECTORIES: Array<{ id: MapNavigatorDirectory; label: string }> = [
  { id: 'buildings', label: 'Buildings' },
  { id: 'zones', label: 'Zones' },
  { id: 'companies', label: 'Companies' },
]

export function MapNavigator() {
  const state = useGameStore((store) => store.state)
  const selectedTile = useGameStore((store) => store.selectedTile)
  const focusMapTile = useGameStore((store) => store.focusMapTile)
  const [open, setOpen] = useState(true)
  const [overlay, setOverlay] = useState<MapNavigatorOverlay>('zones')
  const [directory, setDirectory] = useState<MapNavigatorDirectory>('buildings')
  const svgRef = useRef<SVGSVGElement>(null)
  const data = useMemo(() => buildMapNavigatorData(state), [state])

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

  const selectedRegion = useMemo(() => {
    const tile = selectedTile ? mapTileAtAny(state, selectedTile.x, selectedTile.y) : undefined
    return data.regions.find((region) => region.id === (tile?.regionId ?? state.map.activeRegionId))
      ?? data.regions[0]
  }, [data.regions, selectedTile, state])

  return (
    <aside className={`map-navigator hud-surface pointer-events-auto absolute z-[18] overflow-hidden rounded-xl ${open ? 'w-[21rem]' : 'w-[13.5rem]'}`}>
      <header className="relative z-10 flex items-center gap-2.5 border-b border-line/70 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-mint/25 bg-mint/10 text-mint">
          <MapTrifold size="1rem" weight="duotone" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-semibold text-bone">World navigator</span>
          <span className="block truncate font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted">
            {data.width}×{data.height} · {data.cities.length} cities · {data.companies.length} labs
          </span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Collapse world navigator' : 'Expand world navigator'}
          onClick={() => setOpen((value) => !value)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-bone"
        >
          {open ? <CaretDown size="0.9rem" /> : <CaretUp size="0.9rem" />}
        </button>
      </header>

      {open ? (
        <div className="relative z-10">
          <div className="grid grid-cols-4 border-b border-line/70 bg-void/35 p-1.5">
            {OVERLAYS.map(({ id, label, title, icon: Icon }) => (
              <button
                key={id}
                type="button"
                title={title}
                aria-pressed={overlay === id}
                onClick={() => setOverlay(id)}
                className={`flex min-h-8 items-center justify-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium transition-colors ${overlay === id ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
              >
                <Icon size="0.75rem" weight={overlay === id ? 'fill' : 'regular'} />
                {label}
              </button>
            ))}
          </div>

          <div className="relative border-b border-line/70 bg-[#071319] p-2">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${data.width} ${data.height}`}
              preserveAspectRatio="none"
              role="application"
              aria-label="World minimap. Click to focus the main map."
              onClick={focusFromMap}
              className="h-44 w-full cursor-crosshair rounded-md border border-line/80 bg-void shadow-inner"
            >
              <defs>
                <pattern id="minimap-grid" width="5" height="5" patternUnits="userSpaceOnUse">
                  <path d="M 5 0 L 0 0 0 5" fill="none" stroke="rgba(145,166,173,0.10)" strokeWidth="0.35" />
                </pattern>
              </defs>
              {data.regions.map((region, index) => (
                <rect
                  key={region.id}
                  x={region.originX}
                  y={region.originY}
                  width={region.width}
                  height={region.height}
                  fill={regionOverlayFill(region, data.regions, overlay, index)}
                  stroke="rgba(145,166,173,0.34)"
                  strokeWidth="0.7"
                  vectorEffect="non-scaling-stroke"
                >
                  <title>{region.name}</title>
                </rect>
              ))}
              <rect width={data.width} height={data.height} fill="url(#minimap-grid)" pointerEvents="none" />
              {data.cities.map((city) => (
                <g key={city.id} pointerEvents="none">
                  <circle
                    cx={city.cx}
                    cy={city.cy}
                    r={Math.max(2.5, city.radius)}
                    fill="rgba(95,167,232,0.08)"
                    stroke="rgba(95,167,232,0.6)"
                    strokeWidth="0.75"
                    strokeDasharray="2 1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle cx={city.cx} cy={city.cy} r="1.1" fill="#8cc7f3" />
                </g>
              ))}
              {data.sites.map((site) => (
                <SiteMarker key={`${site.ownerId}-${site.id}`} site={site} onFocus={focus} />
              ))}
              {selectedTile ? (
                <g pointerEvents="none">
                  <circle
                    cx={selectedTile.x + 0.5}
                    cy={selectedTile.y + 0.5}
                    r="3"
                    fill="none"
                    stroke="#e8f2f2"
                    strokeWidth="1.2"
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    d={`M ${selectedTile.x - 3} ${selectedTile.y + 0.5} h 7 M ${selectedTile.x + 0.5} ${selectedTile.y - 3} v 7`}
                    stroke="#e8f2f2"
                    strokeWidth="0.65"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ) : null}
            </svg>
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-md border border-line/70 bg-void/85 px-2 py-1 font-mono text-[0.5rem] uppercase tracking-[0.1em] text-muted backdrop-blur-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-mint" /> Yours
              <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Rivals
              {overlay === 'zones' ? null : <><span className="ml-1">Low</span><span className="h-1.5 w-8 bg-gradient-to-r from-mint via-amber to-danger" /><span>High</span></>}
            </div>
          </div>

          <div className="grid grid-cols-4 border-b border-line/70 bg-panel-2/45 px-2 py-2 text-center">
            <MiniStat label="Cities" value={data.cities.length} />
            <MiniStat label="Zones" value={data.regions.length} />
            <MiniStat label="Sites" value={data.sites.length} />
            <MiniStat label="Rivals" value={state.rivals.length} />
          </div>

          <nav className="grid grid-cols-3 border-b border-line/70 px-2 pt-1.5" aria-label="World directory">
            {DIRECTORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={directory === item.id ? 'page' : undefined}
                onClick={() => setDirectory(item.id)}
                className={`border-b-2 px-2 py-1.5 text-[0.6875rem] font-medium ${directory === item.id ? 'border-mint text-mint' : 'border-transparent text-muted hover:text-bone'}`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="panel-scroll max-h-32 overflow-y-auto p-2">
            {directory === 'buildings' ? data.sites.length > 0 ? data.sites.map((site) => (
              <DirectoryRow
                key={`${site.ownerId}-${site.id}`}
                icon={<Factory size="0.85rem" weight="duotone" />}
                color={site.color}
                title={site.label}
                meta={`${site.ownerName} · ${site.kindLabel}${site.constructing ? ' · building' : ''}`}
                onClick={() => focus(site.x, site.y)}
              />
            )) : <EmptyDirectory text="No facilities have been placed yet." /> : null}
            {directory === 'zones' ? data.regions.map((region) => (
              <DirectoryRow
                key={region.id}
                icon={<MapPin size="0.85rem" weight="duotone" />}
                color="#5fa7e8"
                title={region.name}
                meta={`Power ×${region.energyPriceMult.toFixed(2)} · latency ${Math.round(region.latencyToMarket * 100)} · risk ${pct(region.regulationRisk, 0)}`}
                onClick={() => focus(region.originX + region.width / 2, region.originY + region.height / 2)}
              />
            )) : null}
            {directory === 'companies' ? data.companies.toSorted((a, b) => b.marketShare - a.marketShare).map((company) => (
              <DirectoryRow
                key={company.id}
                icon={<UsersThree size="0.85rem" weight="duotone" />}
                color={company.color}
                title={company.name}
                meta={`${company.siteCount} sites · ${pct(company.marketShare, 1)} market share`}
                onClick={() => focus(company.x, company.y)}
              />
            )) : null}
          </div>

          {selectedRegion ? (
            <footer className="flex items-center justify-between gap-2 border-t border-line/70 bg-void/35 px-3 py-2 font-mono text-[0.5625rem] text-muted">
              <span className="truncate text-bone">{selectedRegion.name}</span>
              <span className="shrink-0">Power ×{selectedRegion.energyPriceMult.toFixed(2)} · L{Math.round(selectedRegion.latencyToMarket * 100)} · R{Math.round(selectedRegion.regulationRisk * 100)}</span>
            </footer>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}

function SiteMarker({
  site,
  onFocus,
}: {
  site: MapNavigatorSite
  onFocus: (x: number, y: number) => void
}) {
  const size = site.ownerType === 'player' ? 2.8 : 2.4
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
      <circle cx={site.x + 0.5} cy={site.y + 0.5} r={size + 1.3} fill="rgba(7,17,23,0.76)" />
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
          r={size + 0.7}
          fill="none"
          stroke="#e8ad56"
          strokeWidth="0.7"
          strokeDasharray="1.4 1"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <title>{site.label} · {site.ownerName}</title>
    </g>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <span className="min-w-0 border-r border-line/60 px-1 last:border-r-0">
      <span className="block font-mono text-[0.6875rem] text-bone">{value}</span>
      <span className="block text-[0.5625rem] uppercase tracking-[0.08em] text-muted">{label}</span>
    </span>
  )
}

function DirectoryRow({
  icon,
  color,
  title,
  meta,
  onClick,
}: {
  icon: ReactNode
  color: string
  title: string
  meta: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-panel-2"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-void/60" style={{ color, borderColor: `${color}55` }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.6875rem] font-medium text-bone group-hover:text-mint">{title}</span>
        <span className="block truncate font-mono text-[0.5625rem] text-muted">{meta}</span>
      </span>
      <MapPin size="0.75rem" className="shrink-0 text-muted group-hover:text-mint" />
    </button>
  )
}

function EmptyDirectory({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-3 text-[0.6875rem] text-muted">
      <Buildings size="1rem" /> {text}
    </div>
  )
}
