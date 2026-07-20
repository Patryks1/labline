import type { MapRegion, SimState } from '../../sim/types'
import { facilityAnchorTiles } from '../../sim/systems/worldAccess'
import { rivalMapSites, rivalSiteKindLabel } from '../three/rivalMapSites'

export type MapNavigatorOverlay = 'zones' | 'energy' | 'latency' | 'risk'
export type MapNavigatorDirectory = 'buildings' | 'zones' | 'companies'

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
}

export function numberColor(value: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.floor(value))).toString(16).padStart(6, '0')}`
}

export function buildMapNavigatorData(state: SimState): MapNavigatorData {
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
  }
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

  const metric = overlay === 'energy'
    ? region.energyPriceMult
    : overlay === 'latency'
      ? region.latencyToMarket
      : region.regulationRisk
  const values = regions.map((candidate) => overlay === 'energy'
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
