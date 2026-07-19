import { isBuildableKind, isDcKind } from '../../sim/systems/map'
import type { SimState } from '../../sim/types'
import { tileCoords } from '../../sim/world'

export interface RivalMapSite {
  id: string
  ownerId: string
  companyName: string
  color: number
  x: number
  y: number
  kind: string
  name: string
  progress: number
  target: number
  rackCapacity: number
  racksUsed: number
}

const KIND_LABELS: Record<string, string> = {
  dc: 'Compute hall',
  dc_m: 'Compute campus',
  dc_l: 'Hyperscale campus',
  hq: 'HQ',
  hq_m: 'HQ campus',
  hq_l: 'HQ tower',
  lab: 'Research lab',
  substation: 'Grid interconnect',
  solar: 'Solar farm',
  gas: 'Gas plant',
  nuclear: 'Nuclear plant',
  battery: 'Battery yard',
  fab: 'Chip fab',
  cooling: 'Cooling plant',
}

export function rivalSiteKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

export function rivalSiteIsConstructing(site: RivalMapSite): boolean {
  return site.target > 0 && site.progress < site.target
}

export function rivalSiteProgress(site: RivalMapSite): number {
  if (site.target <= 0) return 1
  return Math.max(0, Math.min(1, site.progress / site.target))
}

export function rivalMapSites(state: SimState): RivalMapSite[] {
  const rivalsById = new Map(state.rivals.map((rival) => [rival.id, rival]))
  const sites: RivalMapSite[] = []

  if (state.map.storage === 'compact' && state.map.world) {
    const world = state.map.world
    for (const facility of world.queryFacilities()) {
      const rival = rivalsById.get(facility.ownerId)
      if (!rival) continue
      const { x, y } = tileCoords(facility.anchor, state.map.width)
      const savedName = facility.data?.name
      sites.push({
        id: facility.id,
        ownerId: rival.id,
        companyName: rival.name,
        color: rival.color,
        x,
        y,
        kind: facility.kind,
        name:
          typeof savedName === 'string'
            ? savedName
            : `${rival.name} ${rivalSiteKindLabel(facility.kind)}`,
        progress: facility.constructionProgress,
        target: facility.constructionTarget,
        rackCapacity: facility.stats?.rackCapacity ?? 0,
        racksUsed: facility.stats?.racksUsed ?? 0,
      })
    }
  } else {
    for (const tile of state.map.tiles) {
      const rival = rivalsById.get(tile.owner)
      if (!rival || !isBuildableKind(tile.kind as never) || tile.campusRole === 'pad') continue
      sites.push({
        id: tile.campusId ?? `${rival.id}-${tile.x}-${tile.y}`,
        ownerId: rival.id,
        companyName: rival.name,
        color: rival.color,
        x: tile.x,
        y: tile.y,
        kind: tile.kind,
        name: tile.name || `${rival.name} ${rivalSiteKindLabel(tile.kind)}`,
        progress: tile.buildingProgress,
        target: tile.buildingTarget,
        rackCapacity: tile.rackCapacity,
        racksUsed: tile.racksUsed,
      })
    }
  }

  return sites.sort(compareRivalSites)
}

export function primaryRivalMapSites(sites: readonly RivalMapSite[]): RivalMapSite[] {
  const primary = new Map<string, RivalMapSite>()
  for (const site of sites) {
    if (!primary.has(site.ownerId)) primary.set(site.ownerId, site)
  }
  return [...primary.values()]
}

function compareRivalSites(a: RivalMapSite, b: RivalMapSite): number {
  const owner = a.companyName.localeCompare(b.companyName)
  if (owner !== 0) return owner
  const aConstructing = rivalSiteIsConstructing(a) ? 0 : 1
  const bConstructing = rivalSiteIsConstructing(b) ? 0 : 1
  if (aConstructing !== bConstructing) return aConstructing - bConstructing
  const kind = siteKindPriority(a.kind) - siteKindPriority(b.kind)
  if (kind !== 0) return kind
  return a.id.localeCompare(b.id)
}

function siteKindPriority(kind: string): number {
  if (kind === 'hq' || kind === 'hq_m' || kind === 'hq_l') return 0
  if (isDcKind(kind)) return 1
  if (kind === 'lab' || kind === 'fab') return 2
  return 3
}
