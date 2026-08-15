/**
 * Derived commercial-infill parcel plan for city tiles.
 *
 * Parcels are a pure, deterministic function of the immutable StaticWorld
 * (seed + terrain + district layers), so simulation systems, placement, and
 * growth all compute the identical plan without any persisted state. City
 * growth must preserve these tiles until the player or a rival acquires them.
 */
import type { UrbanUse } from '../types'
import { cityIndexFromFeature } from './generator'
import {
  DISTRICT_KIND,
  TERRAIN_KIND,
  TRANSPORT_CLASS_MASK,
  TRANSPORT_CLASS_SHIFT,
  TRANSPORT_ROAD_CLASS,
  type StaticCity,
  type StaticWorld,
  type TileId,
} from './types'

/** Urban infill costs more than greenfield: land purchase + redevelopment. */
export const URBAN_INFILL_REDEVELOPMENT_MULT = 1.5
/** Share of suitable urban block cells designated commercial_infill (~25–30%). */
export const URBAN_INFILL_SELECT_PERCENT = 28

export interface UrbanInfillParcel {
  readonly id: string
  readonly cityIndex: number
  /** Lowest tile id of the footprint; stable identity for UI/tests. */
  readonly anchorTileId: TileId
  readonly tileIds: readonly TileId[]
  readonly width: number
  readonly height: number
  /** Flagship parcels (3x3 or 3x2) host large HQs in bigger cities. */
  readonly flagship: boolean
  /** Per-tile purchase + redevelopment price charged on placement. */
  readonly landValuePerTile: number
}

export interface UrbanInfillPlan {
  readonly parcels: readonly UrbanInfillParcel[]
  readonly parcelByTile: ReadonlyMap<TileId, UrbanInfillParcel>
  /** Every tile city growth must preserve until acquired. */
  readonly reservedTileIds: ReadonlySet<TileId>
}

const EMPTY_PLAN: UrbanInfillPlan = Object.freeze({
  parcels: Object.freeze([]),
  parcelByTile: new Map<TileId, UrbanInfillParcel>(),
  reservedTileIds: new Set<TileId>(),
})

const planCache = new WeakMap<StaticWorld, UrbanInfillPlan>()

/** Memoized deterministic plan for a static world. */
export function planUrbanInfill(world: StaticWorld): UrbanInfillPlan {
  const cached = planCache.get(world)
  if (cached) return cached
  const plan = computeUrbanInfillPlan(world)
  planCache.set(world, plan)
  return plan
}

/** The commercial-infill parcel covering a tile, if any. */
export function urbanInfillParcelAt(world: StaticWorld, id: TileId): UrbanInfillParcel | undefined {
  return planUrbanInfill(world).parcelByTile.get(id)
}

/** Classify one city tile; undefined for ordinary urban fabric / non-city tiles. */
export function urbanUseAt(world: StaticWorld, id: TileId): UrbanUse | undefined {
  if (cityIndexFromFeature(world.feature[id] ?? 0) === undefined) return undefined
  if (urbanInfillParcelAt(world, id)) return 'commercial_infill'
  const zone = world.district?.[id] ?? DISTRICT_KIND.none
  if (zone === DISTRICT_KIND.municipalCampus) return 'municipal'
  if (world.kind[id] === TERRAIN_KIND.park || zone === DISTRICT_KIND.greenBuffer) return 'park'
  if (streetClass(world, id) !== TRANSPORT_ROAD_CLASS.none) return 'infrastructure'
  return undefined
}

/**
 * Per-tile urban land price: city-centre parcels carry higher land value,
 * and the redevelopment premium keeps infill above greenfield pricing.
 */
export function urbanInfillLandValue(
  world: StaticWorld,
  city: StaticCity,
  id: TileId,
): number {
  const { width, landValueCityPeak } = world.descriptor
  const x = id % width
  const y = Math.floor(id / width)
  const reach = Math.max(4, city.radius * 3.5)
  const proximity = Math.max(0, 1 - Math.hypot(x - city.cx, y - city.cy) / reach)
  const tierWeight = city.tier === 'village'
    ? 0.38
    : city.tier === 'town'
      ? 0.56
      : city.tier === 'satellite'
        ? 0.78
        : 1
  const settlementInfluence = proximity * proximity * tierWeight
  const zone = world.district?.[id] ?? DISTRICT_KIND.none
  const zoneMult = zone === DISTRICT_KIND.core
    ? 2.8
    : zone === DISTRICT_KIND.mixed
      ? 2.2
      : zone === DISTRICT_KIND.suburb
        ? 1.55
        : 1.9
  const coreBoost = 1.15 + settlementInfluence * 0.85
  return Math.floor(
    landValueCityPeak * zoneMult * coreBoost * URBAN_INFILL_REDEVELOPMENT_MULT,
  )
}

function streetClass(world: StaticWorld, id: number): number {
  return ((world.transport?.[id] ?? 0) & TRANSPORT_CLASS_MASK) >>> TRANSPORT_CLASS_SHIFT
}

/** Cardinal neighbor has a street a driveway can meet (highways excluded). */
function hasStreetAccess(world: StaticWorld, id: number): boolean {
  const { width, height } = world.descriptor
  const x = id % width
  const y = Math.floor(id / width)
  const candidates = [
    y > 0 ? id - width : -1,
    x + 1 < width ? id + 1 : -1,
    y + 1 < height ? id + width : -1,
    x > 0 ? id - 1 : -1,
  ]
  for (const neighbor of candidates) {
    if (neighbor < 0) continue
    const roadClass = streetClass(world, neighbor)
    if (roadClass === TRANSPORT_ROAD_CLASS.local ||
        roadClass === TRANSPORT_ROAD_CLASS.collector ||
        roadClass === TRANSPORT_ROAD_CLASS.arterial) return true
  }
  return false
}

/**
 * Suitable urban block cells: inside a settlement, on city/house fabric or a
 * carved urban lot — never on water, roads (incl. arterials/bridges),
 * municipal power assets, or protected parks/green buffers.
 */
function isSuitableCell(world: StaticWorld, id: number): number | undefined {
  const cityIndex = cityIndexFromFeature(world.feature[id] ?? 0)
  if (cityIndex === undefined) return undefined
  const terrain = world.kind[id]
  if (terrain !== TERRAIN_KIND.city &&
      terrain !== TERRAIN_KIND.house &&
      terrain !== TERRAIN_KIND.empty) return undefined
  if (streetClass(world, id) !== TRANSPORT_ROAD_CLASS.none) return undefined
  const zone = world.district?.[id] ?? DISTRICT_KIND.none
  if (zone === DISTRICT_KIND.municipalCampus || zone === DISTRICT_KIND.greenBuffer) return undefined
  return cityIndex
}

function mix32(input: number): number {
  let value = input >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb_352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846c_a68b)
  value ^= value >>> 16
  return value >>> 0
}

interface Window {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly score: number
}

/** Best street-served w×h window of suitable, unassigned cells near the centre. */
function bestWindow(
  world: StaticWorld,
  city: StaticCity,
  suitable: ReadonlyMap<number, number>,
  assigned: ReadonlySet<number>,
  w: number,
  h: number,
): Window | undefined {
  const { width, seed } = world.descriptor
  const extent = Math.ceil(city.radius * 1.6)
  let best: Window | undefined
  for (let y = city.cy - extent; y <= city.cy + extent - (h - 1); y++) {
    for (let x = city.cx - extent; x <= city.cx + extent - (w - 1); x++) {
      let ok = true
      let streetServed = false
      for (let oy = 0; oy < h && ok; oy++) {
        for (let ox = 0; ox < w && ok; ox++) {
          const id = (y + oy) * width + (x + ox)
          if (assigned.has(id) || suitable.get(id) !== city.index) { ok = false; break }
          if (!streetServed && hasStreetAccess(world, id)) streetServed = true
        }
      }
      if (!ok || !streetServed) continue
      const distance = Math.hypot(x + (w - 1) / 2 - city.cx, y + (h - 1) / 2 - city.cy)
      const score = distance * 4096 + (mix32((y * width + x) ^ seed ^ 0x51f1_c3a5) % 4096)
      if (!best || score < best.score) best = { x, y, w, h, score }
    }
  }
  return best
}

function computeUrbanInfillPlan(world: StaticWorld): UrbanInfillPlan {
  // Growth reservation (the mechanism that preserves parcels) exists from V3.
  if (Number(world.descriptor.generatorVersion) < 3) return EMPTY_PLAN
  const { width, seed } = world.descriptor
  const suitable = new Map<number, number>()
  for (let id = 0; id < world.kind.length; id++) {
    const cityIndex = isSuitableCell(world, id)
    if (cityIndex !== undefined && world.cities.some((city) => city.index === cityIndex)) {
      suitable.set(id, cityIndex)
    }
  }
  if (suitable.size === 0) return EMPTY_PLAN

  const parcels: UrbanInfillParcel[] = []
  const assigned = new Set<number>()

  const addParcel = (city: StaticCity, tileIds: number[], w: number, h: number, flagship: boolean) => {
    tileIds.sort((a, b) => a - b)
    const anchorTileId = tileIds[0]! as TileId
    for (const id of tileIds) assigned.add(id)
    parcels.push(Object.freeze({
      id: `urban-infill:${city.index}:${anchorTileId}`,
      cityIndex: city.index,
      anchorTileId,
      tileIds: Object.freeze(tileIds.map((id) => id as TileId)),
      width: w,
      height: h,
      flagship,
      landValuePerTile: urbanInfillLandValue(world, city, anchorTileId),
    }))
  }

  for (const city of world.cities) {
    const cells = [...suitable.entries()]
      .filter(([, cityIndex]) => cityIndex === city.index)
      .map(([id]) => id)
    if (cells.length === 0) continue
    const streetCells = new Set(cells.filter((id) => hasStreetAccess(world, id)))
    const rolled = cells
      .filter((id) => mix32(id ^ seed ^ 0x1af1_11) % 100 < URBAN_INFILL_SELECT_PERCENT * 2)
      .sort((a, b) => mix32(a ^ seed) - mix32(b ^ seed) || a - b)
    const major = city.tier !== 'village'
    // Tier-scaled guarantees so every non-village city offers in-city HQ pads:
    // metros mark two flagship large-HQ sites plus three 2×2 campuses,
    // satellites one flagship plus two campuses, towns two campuses. All are
    // best-effort windows; tiny settlements degrade to whatever fits.
    const flagshipAttempts = city.tier === 'metro' ? 2 : city.tier === 'satellite' ? 1 : 0
    const mediumAttempts = city.tier === 'metro' ? 3 : major ? 2 : 0
    const minSingles = city.tier === 'metro' || city.tier === 'satellite' ? 6 : major ? 4 : 0
    let used = 0
    let minCells = mediumAttempts * 4 + minSingles

    // Flagships first so bigger cities mark large HQ pads even when only a
    // 2×2 window remains. Prefer 3×3 → 3×2 → 2×3 → 2×2. Windows score by
    // distance to the centre, so the first pads sit near the city core.
    for (let attempt = 0; attempt < flagshipAttempts; attempt++) {
      const win = bestWindow(world, city, suitable, assigned, 3, 3) ??
        bestWindow(world, city, suitable, assigned, 3, 2) ??
        bestWindow(world, city, suitable, assigned, 2, 3) ??
        bestWindow(world, city, suitable, assigned, 2, 2)
      if (!win) break
      addParcel(city, windowTileIds(world, win), win.w, win.h, true)
      used += win.w * win.h
      minCells += win.w * win.h
    }

    // Medium 2×2 pads for HQ_m; tiny settlements degrade to whatever fits.
    for (let n = 0; n < mediumAttempts; n++) {
      const win = bestWindow(world, city, suitable, assigned, 2, 2)
      if (!win) break
      addParcel(city, windowTileIds(world, win), 2, 2, false)
      used += 4
    }

    // 1x1 parcels fill the remaining budget from rolled street-adjacent
    // cells. The ~28% share is a target; small cities are minimum-bound.
    const budget = Math.max(minCells, Math.round(cells.length * URBAN_INFILL_SELECT_PERCENT / 100))
    const singlesWanted = Math.max(minSingles, budget - used)
    let singles = 0
    for (const id of rolled) {
      if (singles >= singlesWanted) break
      if (assigned.has(id) || !streetCells.has(id)) continue
      addParcel(city, [id], 1, 1, false)
      singles++
    }
    // Minimums: every major city keeps its guaranteed usable 1x1 parcels.
    if (singles < minSingles) {
      const topUp = [...streetCells]
        .filter((id) => !assigned.has(id))
        .map((id) => ({
          id,
          score: Math.hypot(id % width - city.cx, Math.floor(id / width) - city.cy) * 4096 +
            (mix32(id ^ seed ^ 0x7a11) % 4096),
        }))
        .sort((a, b) => a.score - b.score || a.id - b.id)
      for (const candidate of topUp) {
        if (singles >= minSingles) break
        addParcel(city, [candidate.id], 1, 1, false)
        singles++
      }
    }
  }

  parcels.sort((a, b) => a.anchorTileId - b.anchorTileId)
  const parcelByTile = new Map<TileId, UrbanInfillParcel>()
  const reservedTileIds = new Set<TileId>()
  for (const parcel of parcels) {
    for (const id of parcel.tileIds) {
      parcelByTile.set(id, parcel)
      reservedTileIds.add(id)
    }
  }
  return Object.freeze({
    parcels: Object.freeze(parcels),
    parcelByTile,
    reservedTileIds,
  })
}

function windowTileIds(world: StaticWorld, win: Window): number[] {
  const { width } = world.descriptor
  const tileIds: number[] = []
  for (let oy = 0; oy < win.h; oy++) {
    for (let ox = 0; ox < win.w; ox++) tileIds.push((win.y + oy) * width + (win.x + ox))
  }
  return tileIds
}
