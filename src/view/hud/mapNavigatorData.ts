import type { MapOverlayMode, MapRegion, SimState, TileKind } from '../../sim/types'
import { deriveCityStats, type CityStats } from '../../sim/systems/cityStats'
import { facilityAnchorTiles, mapTileAtAny } from '../../sim/systems/worldAccess'
import { tileId } from '../../sim/world/ids'
import {
  BIOME_KIND,
  BIOME_KIND_NAME,
  TERRAIN_KIND_NAME,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_DIRECTION,
  WORLD_CHANGE_FLAGS,
  WORLD_GENERATOR_VERSION_V4,
  WORLD_GENERATOR_VERSION_V5,
  WORLD_GENERATOR_VERSION_V6,
  WORLD_GENERATOR_VERSION_V7,
  type BiomeKindName,
} from '../../sim/world/types'
import { rivalMapSites, rivalSiteKindLabel } from '../three/rivalMapSites'
import { selectFinanceDashboardReadouts } from './data/financeDashboardModel'

/** Navigator overlays share the store MapOverlayMode (zones/power/latency/risk). */
export type MapNavigatorOverlay = Exclude<MapOverlayMode, 'none'>
export type BuildingFilter = 'all' | 'player' | 'rival' | 'dc' | 'hq' | 'power' | 'lab'

export interface MapNavigatorTerrainCell {
  x: number
  y: number
  size: number
  kind: TileKind
  /** Dominant ecological layer; plains for flat compatibility worlds. */
  biome: BiomeKindName
  /** Height normalized over this particular world, used only for relief shading. */
  elevation: number
  /** Local height range normalized with the world height range. */
  relief: number
  waterCoverage: number
  urbanCoverage: number
  roadCoverage: number
  /** none/local/collector/arterial/highway, encoded as 0..4. */
  roadClass: number
  /** Dominant network bearing in screen-space degrees. */
  roadAngle: 0 | 45 | 90 | 135
  roadJunction: boolean
}

export interface MapNavigatorSite {
  id: string
  ownerId: string
  ownerName: string
  ownerType: 'player' | 'rival'
  color: string
  x: number
  y: number
  label: string
  kindLabel: string
  kind: string
  constructing: boolean
}

export interface MapNavigatorCompany {
  id: string
  name: string
  color: string
  marketShare: number
  siteCount: number
  x: number
  y: number
}

export interface MapNavigatorData {
  width: number
  height: number
  regions: MapRegion[]
  cities: MapNavigatorCity[]
  sites: MapNavigatorSite[]
  companies: MapNavigatorCompany[]
  terrain: MapNavigatorTerrainCell[]
  roads: MapNavigatorRoadEdge[]
}

export type MapNavigatorCity = NonNullable<SimState['map']['cities']>[number] & {
  /** Live derived population and municipal power balance for this city. */
  stats: CityStats
}

/** Shared accessible description for both the city marker and its text label. */
export function navigatorCitySummary(city: MapNavigatorCity): string {
  const stats = city.stats
  const reserve = `${stats.reserveMargin >= 0 ? '+' : ''}${Math.round(stats.reserveMargin * 100)}%`
  const contracts = stats.cityPowerContractCount + stats.powerExportContractCount
  return `${city.name}, population ${Math.round(stats.population).toLocaleString()}, ` +
    `municipal capacity ${Math.round(stats.municipalCapacityMw).toLocaleString()} megawatts, ` +
    `demand ${Math.round(stats.municipalDemandMw).toLocaleString()} megawatts, ` +
    `${contracts} active power ${contracts === 1 ? 'contract' : 'contracts'}, reserve margin ${reserve}`
}

export interface MapNavigatorRoadEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  roadClass: number
}

export type NavigatorZoom = 1 | 2 | 4

/** World-space crop shown by both the minimap canvas and SVG overlay. */
export interface NavigatorView {
  x: number
  y: number
  width: number
  height: number
  zoom: NavigatorZoom
}

/** Screen-space box used as both the collision boundary and rendered city-label button boundary. */
export interface NavigatorCityLabel {
  id: string
  text: string
  left: number
  top: number
  width: number
  height: number
}


const MINIMAP_TARGET_CELLS_PER_AXIS = 48
type NavigatorTerrainState = Pick<SimState, 'config' | 'map'>

/** V4 static layers never change. Keep their bounded navigator projection across React renders. */
const compactTerrainCache = new WeakMap<object, Map<number, MapNavigatorTerrainCell[]>>()
interface MinimapRoadCache {
  sequence: number
  edges: Map<string, MapNavigatorRoadEdge>
  result: MapNavigatorRoadEdge[]
}

const compactRoadCache = new WeakMap<object, MinimapRoadCache>()

const UNIQUE_ROAD_DIRECTIONS = [
  { bit: TRANSPORT_DIRECTION.east, dx: 1, dy: 0 },
  { bit: TRANSPORT_DIRECTION.southEast, dx: 1, dy: 1 },
  { bit: TRANSPORT_DIRECTION.south, dx: 0, dy: 1 },
  { bit: TRANSPORT_DIRECTION.southWest, dx: -1, dy: 1 },
] as const

const TERRAIN_PRIORITY: Partial<Record<TileKind, number>> = {
  road: 8,
  lake: 7,
  city: 6,
  warehouse: 5,
  house: 4,
  park: 3,
  forest: 2,
  empty: 1,
}

const BIOME_COLORS: Record<BiomeKindName, readonly [number, number, number]> = {
  plains: [63, 103, 62],
  forest: [36, 82, 49],
  arid: [121, 99, 65],
  wetland: [43, 87, 78],
  alpine: [100, 112, 112],
  coast: [91, 105, 76],
  meadow: [82, 126, 65],
  boreal: [42, 78, 67],
  scrubland: [105, 105, 62],
}

function hexColor(red: number, green: number, blue: number): string {
  const value = (Math.round(red) << 16) | (Math.round(green) << 8) | Math.round(blue)
  return `#${value.toString(16).padStart(6, '0')}`
}

export function minimapTerrainColor(cell: MapNavigatorTerrainCell | TileKind): string {
  const kind = typeof cell === 'string' ? cell : cell.kind
  if (typeof cell !== 'string' && kind !== 'lake') {
    const base = BIOME_COLORS[cell.biome]
    // Valleys stay deep and cool while ridges catch a restrained bone-colored highlight.
    const shade = (cell.elevation - 0.45) * 34 + cell.relief * 10
    const urbanDesaturation = cell.urbanCoverage * 16
    return hexColor(
      Math.max(0, Math.min(255, base[0] + shade + urbanDesaturation)),
      Math.max(0, Math.min(255, base[1] + shade + urbanDesaturation * 0.72)),
      Math.max(0, Math.min(255, base[2] + shade + urbanDesaturation * 0.55)),
    )
  }
  switch (kind) {
    case 'road':
      return '#3f4450'
    case 'lake':
      return '#2a7fad'
    case 'forest':
      return '#2f6a38'
    case 'park':
      return '#356b39'
    case 'house':
      return '#b8a789'
    case 'city':
      return '#6d6098'
    case 'warehouse':
      return '#6d7382'
    case 'empty':
      return '#3f6a3d'
    default:
      return '#5f7284'
  }
}

function terrainKindAt(state: NavigatorTerrainState, x: number, y: number): TileKind {
  const world = state.map.storage === 'compact' ? state.map.world : undefined
  if (world) {
    const id = tileId(x, y, world.descriptor.width, world.descriptor.height)
    const kind = world.getKind(id)
    return (TERRAIN_KIND_NAME[kind] ?? 'empty') as TileKind
  }
  return mapTileAtAny(state, x, y)?.kind ?? 'empty'
}

function dominantTerrainKind(
  state: NavigatorTerrainState,
  x0: number,
  y0: number,
  size: number,
): Omit<MapNavigatorTerrainCell, 'x' | 'y' | 'size' | 'elevation' | 'relief'> & {
  averageElevation: number
  minimumElevation: number
  maximumElevation: number
} {
  const counts = new Map<TileKind, number>()
  const biomeCounts = new Map<BiomeKindName, number>()
  let best: TileKind = 'empty'
  let bestScore = -1
  let bestBiome: BiomeKindName = 'plains'
  let bestBiomeCount = -1
  let elevationTotal = 0
  let minimumElevation = Number.POSITIVE_INFINITY
  let maximumElevation = Number.NEGATIVE_INFINITY
  let water = 0
  let urban = 0
  let roads = 0
  let roadClass = 0
  const roadAxes = [0, 0, 0, 0]
  let samples = 0
  const x1 = Math.min(state.map.width, x0 + size)
  const y1 = Math.min(state.map.height, y0 + size)
  const staticWorld = state.map.storage === 'compact' ? state.map.world?.staticWorld : undefined
  const elevation = staticWorld?.elevation
  const elevationScale = staticWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V4 ||
    staticWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V5 ||
    staticWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V6 ||
    staticWorld?.descriptor.generatorVersion === WORLD_GENERATOR_VERSION_V7
    ? staticWorld.descriptor.elevationScale
    : 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const kind = terrainKindAt(state, x, y)
      const next = (counts.get(kind) ?? 0) + 1
      counts.set(kind, next)
      const score = next * (TERRAIN_PRIORITY[kind] ?? 4)
      if (score > bestScore) {
        best = kind
        bestScore = score
      }
      if (kind === 'lake') water += 1
      if (kind === 'city' || kind === 'house' || kind === 'warehouse') urban += 1
      if (staticWorld) {
        const id = y * staticWorld.descriptor.width + x
        const biome = BIOME_KIND_NAME[staticWorld.biome?.[id] ?? BIOME_KIND.plains] ?? 'plains'
        const biomeCount = (biomeCounts.get(biome) ?? 0) + 1
        biomeCounts.set(biome, biomeCount)
        if (biomeCount > bestBiomeCount) {
          bestBiome = biome
          bestBiomeCount = biomeCount
        }
        const transport = staticWorld.transport?.[id] ?? 0
        const sampleRoadClass = (transport & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
        if (sampleRoadClass > 0) roads += 1
        roadClass = Math.max(roadClass, sampleRoadClass)
        roadAxes[0] += Number(Boolean(transport & (TRANSPORT_DIRECTION.east | TRANSPORT_DIRECTION.west)))
        roadAxes[1] += Number(Boolean(transport & (TRANSPORT_DIRECTION.north | TRANSPORT_DIRECTION.south)))
        roadAxes[2] += Number(Boolean(transport & (TRANSPORT_DIRECTION.southEast | TRANSPORT_DIRECTION.northWest)))
        roadAxes[3] += Number(Boolean(transport & (TRANSPORT_DIRECTION.northEast | TRANSPORT_DIRECTION.southWest)))
        if (elevation) {
          const stride = staticWorld.descriptor.width + 1
          const nw = y * stride + x
          const height = (elevation[nw]! + elevation[nw + 1]! + elevation[nw + stride]! +
            elevation[nw + stride + 1]!) * elevationScale / 4
          elevationTotal += height
          minimumElevation = Math.min(minimumElevation, height)
          maximumElevation = Math.max(maximumElevation, height)
        }
      } else if (kind === 'road') {
        roads += 1
        roadClass = Math.max(roadClass, 1)
      }
      samples += 1
    }
  }
  if (!Number.isFinite(minimumElevation)) minimumElevation = 0
  if (!Number.isFinite(maximumElevation)) maximumElevation = 0
  const rankedAxes = roadAxes
    .map((count, index) => ({ count, index }))
    .sort((a, b) => b.count - a.count)
  const dominantAxis = rankedAxes[0]?.index ?? 0
  return {
    kind: water / samples >= 0.5 ? 'lake' : best,
    biome: bestBiome,
    averageElevation: samples > 0 ? elevationTotal / samples : 0,
    minimumElevation,
    maximumElevation,
    waterCoverage: samples > 0 ? water / samples : 0,
    urbanCoverage: samples > 0 ? urban / samples : 0,
    roadCoverage: samples > 0 ? roads / samples : 0,
    roadClass,
    roadAngle: ([0, 90, 45, 135] as const)[dominantAxis] ?? 0,
    roadJunction: roadClass > 0 && (rankedAxes[1]?.count ?? 0) >= (rankedAxes[0]?.count ?? 0) * 0.55,
  }
}

export function buildMinimapTerrain(
  state: NavigatorTerrainState,
  step = Math.max(
    1,
    Math.ceil(Math.max(state.map.width, state.map.height) / MINIMAP_TARGET_CELLS_PER_AXIS),
  ),
): MapNavigatorTerrainCell[] {
  const staticWorld = state.map.storage === 'compact' ? state.map.world?.staticWorld : undefined
  const cachedByStep = staticWorld ? compactTerrainCache.get(staticWorld) : undefined
  const cached = cachedByStep?.get(step)
  if (cached) return cached
  const cells: MapNavigatorTerrainCell[] = []
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let y = 0; y < state.map.height; y += step) {
    for (let x = 0; x < state.map.width; x += step) {
      const summary = dominantTerrainKind(state, x, y, step)
      minimum = Math.min(minimum, summary.minimumElevation)
      maximum = Math.max(maximum, summary.maximumElevation)
      cells.push({
        x,
        y,
        size: step,
        ...summary,
        elevation: summary.averageElevation,
        relief: summary.maximumElevation - summary.minimumElevation,
      })
    }
  }
  const range = maximum > minimum ? maximum - minimum : 1
  for (const cell of cells) {
    cell.elevation = Math.max(0, Math.min(1, (cell.elevation - minimum) / range))
    cell.relief = Math.max(0, Math.min(1, cell.relief / range))
  }
  if (staticWorld) {
    const byStep = cachedByStep ?? new Map<number, MapNavigatorTerrainCell[]>()
    byStep.set(step, cells)
    if (!cachedByStep) compactTerrainCache.set(staticWorld, byStep)
  }
  return cells
}

/** Extract each compact-world road edge once from the authoritative topology bits. */
export function buildMinimapRoads(state: NavigatorTerrainState): MapNavigatorRoadEdge[] {
  const world = state.map.storage === 'compact' ? state.map.world : undefined
  const staticWorld = world?.staticWorld
  if (!staticWorld?.transport) return []
  const baseTransport = staticWorld.transport
  const width = staticWorld.descriptor.width
  const height = staticWorld.descriptor.height
  const cacheKey = world ?? staticWorld
  const prior = compactRoadCache.get(cacheKey)
  if (prior && (!world || prior.sequence === world.sequence)) return prior.result
  const edges = prior?.edges ?? new Map<string, MapNavigatorRoadEdge>()
  const writeTileEdges = (id: number) => {
    const x = id % width
    const y = Math.floor(id / width)
    for (const direction of UNIQUE_ROAD_DIRECTIONS) edges.delete(`${id}:${direction.bit}`)
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const transport = world?.getTransport(id as never) ?? baseTransport[id] ?? 0
    const roadClass = (transport & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
    if (roadClass === 0) return
    for (const direction of UNIQUE_ROAD_DIRECTIONS) {
      if ((transport & direction.bit) === 0) continue
      const nx = x + direction.dx
      const ny = y + direction.dy
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const neighbor = world?.getTransport((ny * width + nx) as never) ?? baseTransport[ny * width + nx] ?? 0
      const neighborClass = (neighbor & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
      edges.set(`${id}:${direction.bit}`, {
        x1: x + 0.5,
        y1: y + 0.5,
        x2: nx + 0.5,
        y2: ny + 0.5,
        roadClass: Math.max(roadClass, neighborClass),
      })
    }
  }

  if (!prior) {
    for (let id = 0; id < width * height; id += 1) writeTileEdges(id)
  } else if (world) {
    const changes = world.changesSince(prior.sequence)
    if (changes.kind === 'reset') {
      edges.clear()
      for (let id = 0; id < width * height; id += 1) writeTileEdges(id)
    } else {
      const dirty = new Set<number>()
      for (const change of changes.changes) {
        if ((change.flags & WORLD_CHANGE_FLAGS.terrain) === 0) continue
        for (const id of change.tileIds) {
          const x = id % width
          const y = Math.floor(id / width)
          for (let oy = -1; oy <= 1; oy += 1) {
            for (let ox = -1; ox <= 1; ox += 1) {
              const nx = x + ox
              const ny = y + oy
              if (nx >= 0 && ny >= 0 && nx < width && ny < height) dirty.add(ny * width + nx)
            }
          }
        }
      }
      if (dirty.size === 0) {
        prior.sequence = world.sequence
        return prior.result
      }
      for (const id of [...dirty].sort((a, b) => a - b)) writeTileEdges(id)
    }
  }
  const result = [...edges.values()]
  compactRoadCache.set(cacheKey, { sequence: world?.sequence ?? 0, edges, result })
  return result
}

export function navigatorView(
  worldWidth: number,
  worldHeight: number,
  zoom: NavigatorZoom,
  centerX: number,
  centerY: number,
  viewportAspect: number,
): NavigatorView {
  const safeAspect = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 1
  const worldAspect = worldWidth / Math.max(1, worldHeight)
  // Cover the navigator frame rather than containing the whole world. The
  // previous contain projection exposed out-of-world space as black bars.
  const fitWidth = worldAspect < safeAspect ? worldWidth : worldHeight * safeAspect
  const fitHeight = worldAspect < safeAspect ? worldWidth / safeAspect : worldHeight
  const width = fitWidth / zoom
  const height = fitHeight / zoom
  const clampAxis = (value: number, worldSize: number, viewSize: number) => {
    if (viewSize >= worldSize) return worldSize / 2
    return Math.max(viewSize / 2, Math.min(worldSize - viewSize / 2, value))
  }
  const cx = clampAxis(centerX, worldWidth, width)
  const cy = clampAxis(centerY, worldHeight, height)
  return { x: cx - width / 2, y: cy - height / 2, width, height, zoom }
}

export function navigatorPointToWorld(
  view: NavigatorView,
  localX: number,
  localY: number,
  pixelWidth: number,
  pixelHeight: number,
): { x: number; y: number } {
  return {
    x: view.x + (localX / Math.max(1, pixelWidth)) * view.width,
    y: view.y + (localY / Math.max(1, pixelHeight)) * view.height,
  }
}

export function navigatorZoomAround(
  worldWidth: number,
  worldHeight: number,
  current: NavigatorView,
  zoom: NavigatorZoom,
  anchorX: number,
  anchorY: number,
  viewportAspect: number,
): NavigatorView {
  const next = navigatorView(worldWidth, worldHeight, zoom, anchorX, anchorY, viewportAspect)
  const u = (anchorX - current.x) / current.width
  const v = (anchorY - current.y) / current.height
  return navigatorView(
    worldWidth,
    worldHeight,
    zoom,
    anchorX + (0.5 - u) * next.width,
    anchorY + (0.5 - v) * next.height,
    viewportAspect,
  )
}

/** Stable, screen-space label placement; lower-priority labels yield on collision. */
export function layoutNavigatorCityLabels(
  cities: SimState['map']['cities'],
  zoom: NavigatorZoom,
  view: NavigatorView,
  pixelWidth: number,
  pixelHeight: number,
  reserved: readonly { x: number; y: number; width: number; height: number }[] = [],
): NavigatorCityLabel[] {
  const visibleTiers = zoom === 1
    ? new Set(['metro'])
    : zoom === 2
      ? new Set(['metro', 'satellite', 'town'])
      : new Set(['metro', 'satellite', 'town', 'village'])
  const priority: Record<string, number> = { metro: 0, satellite: 1, town: 2, village: 3 }
  const sorted = [...(cities ?? [])]
    .filter((city) => visibleTiers.has(city.tier ?? 'metro'))
    .sort((a, b) =>
      (priority[a.tier ?? 'metro'] ?? 9) - (priority[b.tier ?? 'metro'] ?? 9) ||
      b.population - a.population ||
      a.id.localeCompare(b.id))
  const boxes = [...reserved]
  const labels: NavigatorCityLabel[] = []
  const offsets = [
    [8, -7, 'start'], [8, 4, 'start'], [-8, -7, 'end'], [-8, 4, 'end'],
    [0, -13, 'middle'], [0, 12, 'middle'], [12, -13, 'start'], [-12, 12, 'end'],
  ] as const
  const characterWidth = 6.6
  const lineHeight = 13
  const horizontalPadding = 2
  const intersects = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  for (const city of sorted) {
    const px = ((city.cx - view.x) / view.width) * pixelWidth
    const py = ((city.cy - view.y) / view.height) * pixelHeight
    if (px < -20 || py < -20 || px > pixelWidth + 20 || py > pixelHeight + 20) continue
    const textWidth = Math.max(24, city.name.length * characterWidth)
    for (const [dx, dy, anchor] of offsets) {
      const textLeft = px + dx - (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0)
      const box = {
        x: textLeft - horizontalPadding,
        y: py + dy - 10,
        width: textWidth + horizontalPadding * 2,
        height: lineHeight,
      }
      if (box.x < 2 || box.y < 2 || box.x + box.width > pixelWidth - 2 || box.y + box.height > pixelHeight - 2) continue
      if (boxes.some((other) => intersects(box, other))) continue
      boxes.push(box)
      labels.push({
        id: city.id,
        text: city.name,
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      })
      break
    }
  }
  return labels
}

export function numberColor(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value))).toString(16).padStart(6, '0')}`
}

export function buildMapNavigatorData(
  state: SimState,
  terrain = buildMinimapTerrain(state),
): MapNavigatorData {
  const share = selectFinanceDashboardReadouts(state).current.share
  const statsById = new Map(deriveCityStats(state).map((stats) => [stats.cityId, stats]))
  const cities: MapNavigatorCity[] = (state.map.cities ?? []).flatMap((city) => {
    const stats = statsById.get(city.id)
    return stats ? [{ ...city, population: stats.population, stats }] : []
  })
  const fallback = cities[0] ?? {
    cx: state.map.width / 2,
    cy: state.map.height / 2,
  }
  const playerSites: MapNavigatorSite[] = facilityAnchorTiles(state, { ownerId: 'player' }).map(
    (tile) => ({
      id: tile.campusId ?? `player-${tile.x}-${tile.y}`,
      ownerId: 'player',
      ownerName: state.player.name,
      ownerType: 'player',
      color: '#48d7d1',
      x: tile.x,
      y: tile.y,
      label: tile.name || rivalSiteKindLabel(tile.kind),
      kindLabel: rivalSiteKindLabel(tile.kind),
      kind: tile.kind,
      constructing:
        tile.buildingTarget > 0 && tile.buildingProgress < tile.buildingTarget,
    }),
  )
  const rivalSites: MapNavigatorSite[] = rivalMapSites(state).map((site) => ({
    id: site.id,
    ownerId: site.ownerId,
    ownerName: site.companyName,
    ownerType: 'rival',
    color: numberColor(site.color),
    x: site.x,
    y: site.y,
    label: site.name,
    kindLabel: rivalSiteKindLabel(site.kind),
    kind: site.kind,
    constructing: site.target > 0 && site.progress < site.target,
  }))
  const sites = [...playerSites, ...rivalSites]
  const companies: MapNavigatorCompany[] = [
    {
      id: 'player',
      name: state.player.name,
      color: '#48d7d1',
      marketShare: share,
      siteCount: playerSites.length,
      x: playerSites[0]?.x ?? fallback.cx,
      y: playerSites[0]?.y ?? fallback.cy,
    },
    ...state.rivals.map((rival) => {
      const companySites = rivalSites.filter((site) => site.ownerId === rival.id)
      const region = state.map.regions.find((candidate) => candidate.id === rival.regionId)
      return {
        id: rival.id,
        name: rival.name,
        color: numberColor(rival.color),
        marketShare: rival.marketShare,
        siteCount: companySites.length,
        x: companySites[0]?.x ?? (region ? region.originX + region.width / 2 : fallback.cx),
        y: companySites[0]?.y ?? (region ? region.originY + region.height / 2 : fallback.cy),
      }
    }),
  ]

  return {
    width: state.map.width,
    height: state.map.height,
    regions: state.map.regions,
    cities,
    sites,
    companies,
    terrain,
    roads: buildMinimapRoads(state),
  }
}

export function filterNavigatorSites(
  sites: readonly MapNavigatorSite[],
  filter: BuildingFilter,
): MapNavigatorSite[] {
  return sites.filter((site) => {
    if (filter === 'all') return true
    if (filter === 'player') return site.ownerType === 'player'
    if (filter === 'rival') return site.ownerType === 'rival'
    if (filter === 'dc') return site.kind.startsWith('dc')
    if (filter === 'hq') return site.kind.startsWith('hq')
    if (filter === 'power') {
      return ['substation', 'solar', 'gas', 'nuclear', 'battery'].includes(site.kind)
    }
    if (filter === 'lab') return site.kind === 'lab' || site.kind === 'fab'
    return true
  })
}

export function regionOverlayFill(
  region: MapRegion,
  regions: readonly MapRegion[],
  overlay: MapNavigatorOverlay,
  index: number,
): string {
  if (overlay === 'zones') {
    const palette = ['#173942', '#193447', '#1c3e3c', '#243848', '#263b3d', '#1b3541']
    return palette[index % palette.length]!
  }

  const metric = overlay === 'power'
    ? region.energyPriceMult
    : overlay === 'latency'
      ? region.latencyToMarket
      : region.regulationRisk
  const values = regions.map((candidate) => overlay === 'power'
    ? candidate.energyPriceMult
    : overlay === 'latency'
      ? candidate.latencyToMarket
      : candidate.regulationRisk)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const normalized = max > min ? (metric - min) / (max - min) : 0.5
  const hue = 168 - normalized * 156
  const lightness = 22 + normalized * 9
  return `hsl(${hue.toFixed(0)} 48% ${lightness.toFixed(0)}%)`
}
