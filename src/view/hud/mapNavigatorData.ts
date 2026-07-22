import type { MapOverlayMode, MapRegion, SimState, TileKind } from '../../sim/types'
import { facilityAnchorTiles, mapTileAtAny } from '../../sim/systems/worldAccess'
import { tileId } from '../../sim/world/ids'
import { TERRAIN_KIND_NAME } from '../../sim/world/types'
import { rivalMapSites, rivalSiteKindLabel } from '../three/rivalMapSites'

/** Navigator overlays share the store MapOverlayMode (zones/power/latency/risk). */
export type MapNavigatorOverlay = Exclude<MapOverlayMode, 'none'>
export type BuildingFilter = 'all' | 'player' | 'rival' | 'dc' | 'hq' | 'power' | 'lab'

export interface MapNavigatorTerrainCell {
  x: number
  y: number
  size: number
  kind: TileKind
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
  cities: NonNullable<SimState['map']['cities']>
  sites: MapNavigatorSite[]
  companies: MapNavigatorCompany[]
  terrain: MapNavigatorTerrainCell[]
}


const MINIMAP_TARGET_CELLS_PER_AXIS = 48
type NavigatorTerrainState = Pick<SimState, 'config' | 'map'>

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

export function minimapTerrainColor(kind: TileKind): string {
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
    const kind = world.getKind(tileId(x, y, world.descriptor.width, world.descriptor.height))
    return (TERRAIN_KIND_NAME[kind] ?? 'empty') as TileKind
  }
  return mapTileAtAny(state, x, y)?.kind ?? 'empty'
}

function dominantTerrainKind(
  state: NavigatorTerrainState,
  x0: number,
  y0: number,
  size: number,
): TileKind {
  const counts = new Map<TileKind, number>()
  let best: TileKind = 'empty'
  let bestScore = -1
  const x1 = Math.min(state.map.width, x0 + size)
  const y1 = Math.min(state.map.height, y0 + size)
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
    }
  }
  return best
}

export function buildMinimapTerrain(
  state: NavigatorTerrainState,
  step = Math.max(
    1,
    Math.ceil(Math.max(state.map.width, state.map.height) / MINIMAP_TARGET_CELLS_PER_AXIS),
  ),
): MapNavigatorTerrainCell[] {
  const cells: MapNavigatorTerrainCell[] = []
  for (let y = 0; y < state.map.height; y += step) {
    for (let x = 0; x < state.map.width; x += step) {
      cells.push({
        x,
        y,
        size: step,
        kind: dominantTerrainKind(state, x, y, step),
      })
    }
  }
  return cells
}

export function numberColor(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value))).toString(16).padStart(6, '0')}`
}

export function buildMapNavigatorData(
  state: SimState,
  terrain = buildMinimapTerrain(state),
): MapNavigatorData {
  const cities = state.map.cities ?? []
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
      marketShare: state.player.finance.totalShare,
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
