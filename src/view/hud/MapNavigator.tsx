import {
  Buildings,
  CaretLeft,
  CaretRight,
  Cloud,
  Factory,
  Lightning,
  MapTrifold,
  ShieldWarning,
  Timer,
  X,
} from '@phosphor-icons/react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import type { MapOverlayMode } from '../../sim/types'
import { useGameStore, type MapViewport } from '../../store/gameStore'
import { useUiStore } from '../../store/uiStore'
import {
  buildMapNavigatorData,
  buildMinimapTerrain,
  layoutNavigatorCityLabels,
  minimapTerrainColor,
  navigatorPointToWorld,
  navigatorCitySummary,
  navigatorView,
  navigatorZoomAround,
  regionOverlayFill,
  type MapNavigatorData,
  type MapNavigatorCity,
  type MapNavigatorSite,
  type NavigatorCityLabel,
  type NavigatorView,
  type NavigatorZoom,
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

const ZOOM_STOPS: readonly NavigatorZoom[] = [1, 2, 4]
type BuildingFilter = 'all' | 'player' | 'rival'
type DragState = {
  pointerId: number
  startX: number
  startY: number
  centerX: number
  centerY: number
  viewport: boolean
  moved: boolean
}

function mapViewportPolygonPoints(viewport: MapViewport): string {
  const corners = viewport.corners ?? [
    { x: viewport.x, y: viewport.y + viewport.h },
    { x: viewport.x + viewport.w, y: viewport.y + viewport.h },
    { x: viewport.x + viewport.w, y: viewport.y },
    { x: viewport.x, y: viewport.y },
  ]
  return corners.map((point) => `${point.x},${point.y}`).join(' ')
}

function mapViewportHeadingIndicator(
  viewport: MapViewport,
  length: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!viewport.corners) return null
  const nearX = (viewport.corners[0].x + viewport.corners[1].x) / 2
  const nearY = (viewport.corners[0].y + viewport.corners[1].y) / 2
  const x1 = (viewport.corners[2].x + viewport.corners[3].x) / 2
  const y1 = (viewport.corners[2].y + viewport.corners[3].y) / 2
  const dx = x1 - nearX
  const dy = y1 - nearY
  const magnitude = Math.hypot(dx, dy)
  if (magnitude < 1e-6) return null
  return {
    x1,
    y1,
    x2: x1 + dx / magnitude * length,
    y2: y1 + dy / magnitude * length,
  }
}

export function MapViewportOverlay({
  viewport,
  worldPerPixel,
}: {
  viewport: MapViewport
  worldPerPixel: number
}) {
  const heading = mapViewportHeadingIndicator(viewport, worldPerPixel * 5)
  return <g data-map-viewport="true" className="cursor-move">
    <polygon points={mapViewportPolygonPoints(viewport)} fill="rgba(232,242,242,0.08)" stroke="#e8f2f2" strokeWidth={worldPerPixel * 1.1} />
    {viewport.corners ? <line x1={viewport.corners[3].x} y1={viewport.corners[3].y} x2={viewport.corners[2].x} y2={viewport.corners[2].y} stroke="#8ff0d0" strokeWidth={worldPerPixel * 2.1} pointerEvents="none" /> : null}
    {heading ? <line data-map-viewport-heading="true" {...heading} stroke="#8ff0d0" strokeWidth={worldPerPixel * 1.35} strokeLinecap="round" pointerEvents="none" /> : null}
  </g>
}

export function CloudVisibilityButton({
  cloudsVisible,
  onToggle,
}: {
  cloudsVisible: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label="Show clouds"
      aria-pressed={cloudsVisible}
      title={cloudsVisible ? 'Hide clouds' : 'Show clouds'}
      onClick={onToggle}
      className={`flex h-7 w-7 items-center justify-center rounded-md ${cloudsVisible ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}
    >
      <Cloud size="0.95rem" weight={cloudsVisible ? 'fill' : 'duotone'} />
    </button>
  )
}

export function NavigatorCompass() {
  return (
    <div
      className="pointer-events-none absolute left-1.5 top-1.5 z-10 grid size-8 place-items-center rounded-full border border-mint/45 bg-void/90 font-mono text-[0.625rem] font-semibold text-mint shadow backdrop-blur-sm"
      role="img"
      aria-label="North up"
      title="North up"
    >
      N
    </div>
  )
}

export function NavigatorCityLabelLayer({
  labels,
  cities,
  onPan,
}: {
  labels: readonly NavigatorCityLabel[]
  cities: readonly MapNavigatorCity[]
  onPan: (x: number, y: number) => void
}) {
  const cityById = new Map(cities.map((city) => [city.id, city]))
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]" data-map-city-label-layer="true">
      {labels.map((label) => {
        const city = cityById.get(label.id)
        const summary = city ? navigatorCitySummary(city) : label.text
        return (
          <button
            key={label.id}
            type="button"
            data-map-marker="city-label"
            aria-label={`Pan to ${summary}`}
            title={summary}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              if (city) onPan(city.cx, city.cy)
            }}
            className="pointer-events-auto absolute m-0 select-none overflow-visible whitespace-nowrap border-0 bg-transparent p-0 font-mono outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-mint focus-visible:ring-offset-1 focus-visible:ring-offset-void"
            style={{
              left: label.left,
              top: label.top,
              width: label.width,
              height: label.height,
              fontSize: 11,
              lineHeight: '13px',
              color: city?.tier === 'metro' ? '#dceffc' : '#d8dfdc',
              fontWeight: city?.tier === 'metro' ? 600 : 500,
              textShadow: '0 1px 2px #071319, 0 0 2px rgba(7, 19, 25, 0.9)',
            }}
          >
            {label.text}
          </button>
        )
      })}
    </div>
  )
}

function CloudVisibilityToggle() {
  const cloudsVisible = useUiStore((store) => store.cloudsVisible)
  const toggleClouds = useUiStore((store) => store.toggleClouds)
  return <CloudVisibilityButton cloudsVisible={cloudsVisible} onToggle={toggleClouds} />
}

const rasterCache = new WeakMap<object, WeakMap<object, Map<string, HTMLCanvasElement>>>()

function roadColor(roadClass: number): string {
  if (roadClass >= 4) return '#f0dda2'
  if (roadClass >= 3) return '#d8d1bd'
  if (roadClass >= 2) return '#afb2aa'
  return '#858d8d'
}

function buildBaseRaster(data: MapNavigatorData, dpr: number): HTMLCanvasElement {
  const longest = Math.min(4096, Math.max(768, Math.ceil(Math.max(data.width, data.height) * dpr)))
  const scale = longest / Math.max(data.width, data.height)
  const width = Math.max(1, Math.ceil(data.width * scale))
  const height = Math.max(1, Math.ceil(data.height * scale))
  const cacheKey = `${width}x${height}`
  let byRoads = rasterCache.get(data.terrain)
  if (!byRoads) {
    byRoads = new WeakMap()
    rasterCache.set(data.terrain, byRoads)
  }
  let bySize = byRoads.get(data.roads)
  if (!bySize) {
    bySize = new Map()
    byRoads.set(data.roads, bySize)
  }
  const cached = bySize.get(cacheKey)
  if (cached) return cached

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return canvas
  context.scale(width / data.width, height / data.height)
  context.fillStyle = '#071319'
  context.fillRect(0, 0, data.width, data.height)
  for (const cell of data.terrain) {
    context.fillStyle = minimapTerrainColor(cell)
    context.fillRect(cell.x, cell.y, cell.size + 0.08, cell.size + 0.08)
    if (cell.waterCoverage > 0) {
      context.globalAlpha = Math.max(0.45, Math.min(1, cell.waterCoverage * 1.25))
      context.fillStyle = '#2385b2'
      context.fillRect(cell.x, cell.y, cell.size + 0.08, cell.size + 0.08)
      context.globalAlpha = 1
    }
    if (cell.urbanCoverage > 0.08) {
      context.globalAlpha = Math.min(0.6, 0.22 + cell.urbanCoverage)
      context.fillStyle = '#9ca1a0'
      context.fillRect(
        cell.x + cell.size * 0.2,
        cell.y + cell.size * 0.2,
        cell.size * 0.6,
        cell.size * 0.6,
      )
      context.globalAlpha = 1
    }
  }
  if (data.roads.length > 0) {
    context.lineCap = 'round'
    for (let roadClass = 1; roadClass <= 4; roadClass += 1) {
      context.beginPath()
      for (const edge of data.roads) {
        if (edge.roadClass !== roadClass) continue
        context.moveTo(edge.x1, edge.y1)
        context.lineTo(edge.x2, edge.y2)
      }
      context.strokeStyle = roadColor(roadClass)
      context.lineWidth = 0.5 + roadClass * 0.32
      context.stroke()
    }
  } else {
    for (const cell of data.terrain) {
      if (cell.roadClass <= 0) continue
      const radians = cell.roadAngle * Math.PI / 180
      const half = cell.size * 0.58
      const cx = cell.x + cell.size / 2
      const cy = cell.y + cell.size / 2
      context.beginPath()
      context.moveTo(cx - Math.cos(radians) * half, cy - Math.sin(radians) * half)
      context.lineTo(cx + Math.cos(radians) * half, cy + Math.sin(radians) * half)
      context.strokeStyle = roadColor(cell.roadClass)
      context.lineWidth = 0.55 + cell.roadClass * 0.34
      context.stroke()
    }
  }
  bySize.set(cacheKey, canvas)
  return canvas
}

function TerrainCanvas({ data, view }: { data: MapNavigatorData; view: NavigatorView }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    canvas.width = Math.ceil(rect.width * dpr)
    canvas.height = Math.ceil(rect.height * dpr)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.imageSmoothingEnabled = true
    context.fillStyle = '#071319'
    context.fillRect(0, 0, rect.width, rect.height)
    const base = buildBaseRaster(data, dpr)
    const dx = ((0 - view.x) / view.width) * rect.width
    const dy = ((0 - view.y) / view.height) * rect.height
    context.drawImage(
      base,
      dx,
      dy,
      (data.width / view.width) * rect.width,
      (data.height / view.height) * rect.height,
    )
  }, [data, view])
  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full rounded-md" />
}

function zoomStep(current: NavigatorZoom, direction: -1 | 1): NavigatorZoom {
  const index = ZOOM_STOPS.indexOf(current)
  return ZOOM_STOPS[Math.max(0, Math.min(ZOOM_STOPS.length - 1, index + direction))]!
}

/** Compact world navigator with a cached canvas base and lightweight interactive overlay. */
export function MapNavigator() {
  const state = useGameStore((store) => store.state)
  const selectedTile = useGameStore((store) => store.selectedTile)
  const focusMapTile = useGameStore((store) => store.focusMapTile)
  const panMapToTile = useGameStore((store) => store.panMapToTile)
  const overlay = useGameStore((store) => store.mapOverlay)
  const setMapOverlay = useGameStore((store) => store.setMapOverlay)
  const mapViewport = useGameStore((store) => store.mapViewport)
  const mapCameraTilt = useUiStore((store) => store.mapCameraTilt)
  const rotateMapCamera = useUiStore((store) => store.rotateMapCamera)
  const cycleMapCameraTilt = useUiStore((store) => store.cycleMapCameraTilt)
  const resetMapCamera = useUiStore((store) => store.resetMapCamera)
  const [buildingFilter, setBuildingFilter] = useState<BuildingFilter>('all')
  const [buildingIndex, setBuildingIndex] = useState(0)
  const [zoom, setZoom] = useState<NavigatorZoom>(2)
  const [center, setCenter] = useState(() => ({ x: state.map.width / 2, y: state.map.height / 2 }))
  const [followViewport, setFollowViewport] = useState(true)
  const [size, setSize] = useState({ width: 268, height: 144 })
  const [zoomAnnouncement, setZoomAnnouncement] = useState('Minimap zoom 2 times, following camera')
  const [navigatorExpanded, setNavigatorExpanded] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const compactCloseRef = useRef<HTMLButtonElement>(null)
  const map = state.map
  const config = state.config
  const terrain = useMemo(() => buildMinimapTerrain({ map, config }), [config, map])
  const data = useMemo(() => buildMapNavigatorData(state, terrain), [state, terrain])
  const aspect = size.width / Math.max(1, size.height)
  const view = useMemo(
    () => navigatorView(data.width, data.height, zoom, center.x, center.y, aspect),
    [aspect, center.x, center.y, data.height, data.width, zoom],
  )
  const worldPerPixel = view.height / Math.max(1, size.height)
  const markerScale = worldPerPixel * 8

  useEffect(() => {
    const element = frameRef.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setCenter({ x: data.width / 2, y: data.height / 2 })
    setZoom(2)
    setFollowViewport(true)
  }, [data.height, data.width])

  useEffect(() => {
    if (!followViewport || !mapViewport) return
    setCenter({ x: mapViewport.x + mapViewport.w / 2, y: mapViewport.y + mapViewport.h / 2 })
  }, [followViewport, mapViewport])

  const sites = useMemo(() => {
    if (buildingFilter === 'player') return data.sites.filter((site) => site.ownerType === 'player')
    if (buildingFilter === 'rival') return data.sites.filter((site) => site.ownerType === 'rival')
    return data.sites
  }, [buildingFilter, data.sites])

  const labels = useMemo(() => layoutNavigatorCityLabels(
    data.cities,
    zoom,
    view,
    size.width,
    size.height,
    [
      { x: size.width / 2 - 92, y: size.height - 38, width: 184, height: 38 },
    ],
  ), [data.cities, size.height, size.width, view, zoom])
  const clampPoint = useCallback((x: number, y: number) => ({
    x: Math.max(0, Math.min(data.width - 1, x)),
    y: Math.max(0, Math.min(data.height - 1, y)),
  }), [data.height, data.width])
  const focus = useCallback((x: number, y: number) => {
    const point = clampPoint(Math.round(x), Math.round(y))
    focusMapTile(point.x, point.y)
  }, [clampPoint, focusMapTile])
  const pan = useCallback((x: number, y: number) => {
    const point = clampPoint(Math.round(x), Math.round(y))
    panMapToTile(point.x, point.y)
  }, [clampPoint, panMapToTile])

  const activeSite = sites.length > 0 ? sites[buildingIndex % sites.length]! : null
  const setOverlay = (id: Exclude<MapOverlayMode, 'none'>) => setMapOverlay(overlay === id ? 'none' : id)

  const applyZoom = useCallback((nextZoom: NavigatorZoom, localX = size.width / 2, localY = size.height / 2) => {
    if (nextZoom === zoom) return
    const anchor = navigatorPointToWorld(view, localX, localY, size.width, size.height)
    const next = navigatorZoomAround(data.width, data.height, view, nextZoom, anchor.x, anchor.y, aspect)
    setZoom(nextZoom)
    setCenter({ x: next.x + next.width / 2, y: next.y + next.height / 2 })
    setFollowViewport(false)
    setZoomAnnouncement(`Minimap zoom ${nextZoom} times`)
  }, [aspect, data.height, data.width, size.height, size.width, view, zoom])

  const fit = useCallback(() => {
    setZoom(1)
    setCenter({ x: data.width / 2, y: data.height / 2 })
    setFollowViewport(false)
    setZoomAnnouncement('Minimap fit to world')
  }, [data.height, data.width])

  const follow = useCallback(() => {
    if (mapViewport) {
      setCenter({ x: mapViewport.x + mapViewport.w / 2, y: mapViewport.y + mapViewport.h / 2 })
    }
    setFollowViewport(true)
    setZoomAnnouncement(`Minimap zoom ${zoom} times, following camera`)
  }, [mapViewport, zoom])

  const openNavigator = () => {
    setNavigatorExpanded(true)
    window.requestAnimationFrame(() => compactCloseRef.current?.focus())
  }

  const closeNavigator = () => {
    setNavigatorExpanded(false)
    window.requestAnimationFrame(() => launcherRef.current?.focus())
  }

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, rect }
  }

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    const local = localPoint(event)
    if (!local) return
    const target = event.target as Element
    if (target.closest('[data-map-marker]')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      centerX: center.x,
      centerY: center.y,
      viewport: Boolean(target.closest('[data-map-viewport]')),
      moved: false,
    }
  }

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 3) return
    drag.moved = true
    if (drag.viewport) {
      const local = localPoint(event)
      if (!local) return
      const point = navigatorPointToWorld(view, local.x, local.y, local.rect.width, local.rect.height)
      pan(point.x, point.y)
      return
    }
    setCenter({
      x: drag.centerX - (dx / Math.max(1, size.width)) * view.width,
      y: drag.centerY - (dy / Math.max(1, size.height)) * view.height,
    })
    setFollowViewport(false)
  }

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (drag.moved) return
    const local = localPoint(event)
    if (!local) return
    const point = navigatorPointToWorld(view, local.x, local.y, local.rect.width, local.rect.height)
    pan(point.x, point.y)
  }

  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const local = localPoint(event)
    if (!local) return
    applyZoom(zoomStep(zoom, event.deltaY < 0 ? 1 : -1), local.x, local.y)
  }

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === '+' || event.key === '=') applyZoom(zoomStep(zoom, 1))
    else if (event.key === '-') applyZoom(zoomStep(zoom, -1))
    else if (event.key === 'Home') fit()
    else if (event.key === 'Enter') pan(view.x + view.width / 2, view.y + view.height / 2)
    else if (event.key.startsWith('Arrow')) {
      const dx = event.key === 'ArrowLeft' ? -view.width * 0.12 : event.key === 'ArrowRight' ? view.width * 0.12 : 0
      const dy = event.key === 'ArrowUp' ? -view.height * 0.12 : event.key === 'ArrowDown' ? view.height * 0.12 : 0
      setCenter((current) => ({ x: current.x + dx, y: current.y + dy }))
      setFollowViewport(false)
    } else return
    event.preventDefault()
  }

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        aria-label="Open world navigator"
        aria-expanded={navigatorExpanded}
        aria-controls="world-navigator-panel"
        onClick={openNavigator}
        className="map-navigator-launcher hud-surface pointer-events-auto absolute z-[18] min-h-11 items-center gap-2 rounded-lg px-3 text-[0.75rem] font-semibold text-mint"
      >
        <MapTrifold size="1rem" weight="duotone" /> Map
      </button>
      <aside
        id="world-navigator-panel"
        className="map-navigator hud-surface pointer-events-auto absolute z-[18] overflow-hidden rounded-lg"
        data-expanded={navigatorExpanded ? 'true' : 'false'}
        aria-label="World navigator"
      >
      <div className="map-navigator-compact-heading min-h-10 items-center border-b border-line/70 px-3 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-mint">
        World navigator
      </div>
      <button
        ref={compactCloseRef}
        type="button"
        aria-label="Close world navigator"
        onClick={closeNavigator}
        className="map-navigator-compact-close absolute right-1.5 top-1.5 z-20 min-h-11 min-w-11 items-center justify-center rounded-md border border-line bg-void/90 text-muted hover:text-bone"
      >
        <X size="0.95rem" />
      </button>
      <div className="relative z-10">
        <div className="map-navigator-sitebar flex items-center gap-1.5 border-b border-line/70 px-2 py-1.5">
          <button type="button" aria-label="Previous building" disabled={sites.length === 0} onClick={() => {
            if (sites.length === 0) return
            const next = (buildingIndex - 1 + sites.length) % sites.length
            setBuildingIndex(next)
            focus(sites[next]!.x, sites[next]!.y)
          }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line/70 text-muted hover:bg-panel-2 hover:text-bone disabled:opacity-40">
            <CaretLeft size="0.9rem" />
          </button>
          <button type="button" disabled={!activeSite} onClick={() => activeSite && focus(activeSite.x, activeSite.y)} className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line/70 bg-panel-2/50 px-2 text-left hover:border-mint/40 disabled:opacity-50">
            {activeSite ? <>
              <Factory size="0.8rem" className="shrink-0" style={{ color: activeSite.color }} />
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-bone">{activeSite.label}</span>
              <span className="shrink-0 truncate font-mono text-[0.625rem] text-muted">{activeSite.ownerName} · {buildingIndex % sites.length + 1}/{sites.length}</span>
            </> : <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted"><Buildings size="0.85rem" /> No facilities</span>}
          </button>
          <button type="button" aria-label="Next building" disabled={sites.length === 0} onClick={() => {
            if (sites.length === 0) return
            const next = (buildingIndex + 1) % sites.length
            setBuildingIndex(next)
            focus(sites[next]!.x, sites[next]!.y)
          }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line/70 text-muted hover:bg-panel-2 hover:text-bone disabled:opacity-40">
            <CaretRight size="0.9rem" />
          </button>
        </div>

        <div className="map-navigator-commandbar flex items-center gap-1 border-b border-line/70 bg-void/35 px-2 py-1.5">
          <div className="flex shrink-0 items-center rounded-md border border-line/70 bg-void/45 p-0.5">
            {([['all', 'All'], ['player', 'Yours'], ['rival', 'Rivals']] as const).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={buildingFilter === id} onClick={() => {
                setBuildingFilter(id)
                setBuildingIndex(0)
              }} className={`h-7 rounded px-2 text-[0.625rem] font-medium uppercase tracking-[0.04em] ${buildingFilter === id ? 'bg-mint/15 text-mint shadow-[inset_0_0_0_1px_rgba(72,215,209,.28)]' : id === 'rival' ? 'text-danger/80 hover:bg-panel-2' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}>{label}</button>
            ))}
          </div>
          <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-line/70" />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-0.5">
            {OVERLAYS.map(({ id, label, title, icon: Icon }) => (
              <button key={id} type="button" title={title} aria-label={label} aria-pressed={overlay === id} onClick={() => setOverlay(id)} className={`flex h-7 w-7 items-center justify-center rounded-md ${overlay === id ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}>
                <Icon size="0.92rem" weight={overlay === id ? 'fill' : 'duotone'} />
              </button>
            ))}
            <CloudVisibilityToggle />
            <button type="button" aria-label="Rotate map left" title="Rotate left (Q)" onClick={() => rotateMapCamera(-1)} className="h-7 w-7 rounded-md text-xs text-muted hover:bg-panel-2 hover:text-bone">↶</button>
            <button type="button" aria-label={`Cycle map tilt, current ${mapCameraTilt}`} title="Cycle tilt (T)" onClick={cycleMapCameraTilt} className="h-7 min-w-7 rounded-md px-0.5 font-mono text-[0.5rem] uppercase text-muted hover:bg-panel-2 hover:text-bone">{mapCameraTilt.slice(0, 3)}</button>
            <button type="button" aria-label="Rotate map right" title="Rotate right (E)" onClick={() => rotateMapCamera(1)} className="h-7 w-7 rounded-md text-xs text-muted hover:bg-panel-2 hover:text-bone">↷</button>
            <button type="button" aria-label="Reset map perspective" title="Reset perspective (R)" onClick={resetMapCamera} className="h-7 w-7 rounded-md font-mono text-[0.5625rem] text-muted hover:bg-panel-2 hover:text-bone">R</button>
          </div>
        </div>

        <div className="relative bg-[#071319] p-1.5 pb-1">
          <div ref={frameRef} className="map-navigator-frame relative w-full overflow-hidden rounded-md border border-line/80 bg-void shadow-inner">
            <TerrainCanvas data={data} view={view} />
            <svg
              ref={svgRef}
              viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
              preserveAspectRatio="none"
              role="application"
              tabIndex={0}
              aria-label={`North-up world minimap at ${zoom} times zoom${followViewport ? ', following camera' : ''}. Click to pan the main map; drag to explore.`}
              aria-describedby="map-navigator-help"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { dragRef.current = null }}
              onWheel={onWheel}
              onKeyDown={onKeyDown}
              className="absolute inset-0 h-full w-full cursor-crosshair outline-none focus-visible:ring-1 focus-visible:ring-mint"
            >
              {overlay !== 'none' ? data.regions.map((region, index) => (
                <rect key={region.id} x={region.originX} y={region.originY} width={region.width} height={region.height} fill={regionOverlayFill(region, data.regions, overlay, index)} fillOpacity={0.42} stroke="rgba(145,166,173,0.28)" strokeWidth={worldPerPixel * 0.6} pointerEvents="none"><title>{region.name}</title></rect>
              )) : null}
              {data.cities.map((city) => (
                <g key={city.id} data-map-marker="city" role="button" tabIndex={0} aria-label={`Pan to ${navigatorCitySummary(city)}`} onClick={() => pan(city.cx, city.cy)} onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  pan(city.cx, city.cy)
                }} className="cursor-pointer outline-none">
                  <circle cx={city.cx} cy={city.cy} r={Math.max(markerScale * 0.52, city.radius * 0.18)} fill={city.tier === 'metro' ? 'rgba(95,167,232,0.24)' : 'rgba(192,209,205,0.14)'} stroke={city.tier === 'metro' ? '#7bbdf0' : city.tier === 'satellite' ? '#9fbfc4' : '#8fa6a5'} strokeWidth={worldPerPixel * (city.tier === 'metro' ? 1.2 : 0.8)} />
                  <circle cx={city.cx} cy={city.cy} r={city.tier === 'metro' ? markerScale * 0.22 : markerScale * 0.14} fill={city.tier === 'metro' ? '#b9dcf5' : '#a9b9b7'} />
                  <title>{navigatorCitySummary(city)}</title>
                </g>
              ))}
              {sites.map((site) => <SiteMarker key={`${site.ownerId}-${site.id}`} site={site} active={activeSite?.id === site.id && activeSite.ownerId === site.ownerId} markerScale={markerScale} strokeScale={worldPerPixel} onFocus={focus} />)}
              {activeSite ? <text x={activeSite.x + 0.5 + markerScale * 0.9} y={activeSite.y + 0.5 - markerScale * 0.45} fontSize={worldPerPixel * 9} fontFamily="IBM Plex Mono, monospace" fontWeight={700} fill={activeSite.color} stroke="#071319" strokeWidth={worldPerPixel * 2.4} paintOrder="stroke" pointerEvents="none">{activeSite.label}</text> : null}
              {mapViewport ? <MapViewportOverlay viewport={mapViewport} worldPerPixel={worldPerPixel} /> : null}
              {selectedTile ? <g pointerEvents="none">
                <circle cx={selectedTile.x + 0.5} cy={selectedTile.y + 0.5} r={markerScale * 0.72} fill="none" stroke="#f3c969" strokeWidth={worldPerPixel * 1.25} />
                <line x1={selectedTile.x + 0.5 - markerScale} y1={selectedTile.y + 0.5} x2={selectedTile.x + 0.5 + markerScale} y2={selectedTile.y + 0.5} stroke="#f3c969" strokeWidth={worldPerPixel * 0.55} />
              </g> : null}
            </svg>
            <NavigatorCityLabelLayer labels={labels} cities={data.cities} onPan={pan} />
            <div className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-md border border-line/70 bg-void/90 p-0.5 shadow backdrop-blur-sm">
              <button type="button" aria-label="Zoom minimap out" disabled={zoom === 1} onClick={() => applyZoom(zoomStep(zoom, -1))} className="h-7 w-7 rounded text-sm text-bone hover:bg-panel-2 disabled:opacity-35">−</button>
              <span className="min-w-7 text-center font-mono text-[0.5625rem] text-muted" aria-hidden="true">{zoom}×</span>
              <button type="button" aria-label="Zoom minimap in" disabled={zoom === 4} onClick={() => applyZoom(zoomStep(zoom, 1))} className="h-7 w-7 rounded text-sm text-bone hover:bg-panel-2 disabled:opacity-35">+</button>
              <button type="button" aria-label="Fit minimap to world" onClick={fit} className="h-7 rounded px-1.5 font-mono text-[0.5rem] uppercase text-muted hover:bg-panel-2 hover:text-bone">Fit</button>
              <button type="button" aria-label="Follow main map camera" aria-pressed={followViewport} onClick={follow} className={`h-7 rounded px-1.5 font-mono text-[0.5rem] uppercase ${followViewport ? 'bg-mint/15 text-mint' : 'text-muted hover:bg-panel-2 hover:text-bone'}`}>Follow</button>
            </div>
          </div>
          <div className="map-navigator-legend pointer-events-none flex h-6 items-center gap-2 px-1.5 font-mono text-[0.5rem] uppercase tracking-[0.06em] text-muted">
            <span className="h-1.5 w-1.5 rounded-full border border-mint bg-mint/20" /> Yours
            <span className="h-1.5 w-1.5 rotate-45 border border-danger bg-danger/25" /> Rival
            <span className="ml-auto h-[2px] w-3 bg-[#d8d1bd]" /><span>Road</span>
          </div>
          <span id="map-navigator-help" className="sr-only">The map is north up. Terrain color shows biome and elevation. Roads use distinct widths and colors for local roads, collectors, arterials, and highways. City names appear as the navigator zooms. The outlined camera footprint reflects the exact main map perspective and its mint edge points forward. Use plus and minus to zoom, Follow to track the camera, drag the footprint to pan the main map, drag the background to explore this navigator, or press Home to fit the world.</span>
          <span className="sr-only" aria-live="polite">{zoomAnnouncement}</span>
        </div>
      </div>
      </aside>
    </>
  )
}

function SiteMarker({ site, active, markerScale, strokeScale, onFocus }: { site: MapNavigatorSite; active?: boolean; markerScale: number; strokeScale: number; onFocus: (x: number, y: number) => void }) {
  const size = markerScale * (site.ownerType === 'player' ? 0.72 : 0.62)
  const cx = site.x + 0.5
  const cy = site.y + 0.5
  const half = size / 2
  return (
    <g data-map-marker="facility" role="button" aria-label={`Focus ${site.label}, ${site.ownerName}`} tabIndex={0} onClick={(event) => {
      event.stopPropagation()
      onFocus(site.x, site.y)
    }} onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      onFocus(site.x, site.y)
    }} className="cursor-pointer outline-none">
      <circle cx={cx} cy={cy} r={size + strokeScale * 1.2} fill="rgba(7,17,23,0.82)" />
      {active ? <circle cx={cx} cy={cy} r={size + strokeScale * 0.8} fill="rgba(72,215,209,0.12)" stroke="#e8f2f2" strokeWidth={strokeScale * 0.75} /> : null}
      <polygon points={`${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`} fill={site.color} stroke="#e8f2f2" strokeWidth={strokeScale * 0.55} />
      {site.constructing ? <circle cx={cx} cy={cy} r={size + strokeScale * 0.55} fill="none" stroke="#e8ad56" strokeWidth={strokeScale * 0.65} strokeDasharray={`${strokeScale * 1.4} ${strokeScale}`} /> : null}
      <title>{site.label} · {site.ownerName}</title>
    </g>
  )
}
