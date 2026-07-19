/**
 * Pure seeded procedural world generator.
 *
 * Pipeline (roads-first city planning):
 *  1. Place city anchors
 *  2. Build arterial highways between cities (orthogonal only)
 *  3. Stamp local street grids at each city
 *  4. Place buildings only next to roads (city core, suburbs, warehouses)
 *  5. Place lakes/forests away from the network
 *  6. Land value + starter pads
 */
import type { GameConfig } from '../balance/gameConfig'
import { ECONOMY } from '../balance/economy'
import { createRng, type Rng } from '../rng'
import type { MapCity, MapRegion, MapTile, TileKind } from '../types'
import { cityTalentCapacity, cityTalentInitial } from '../balance/staff'

/** @deprecated use MapCity — kept as alias for generator */
export type CityAnchor = MapCity

export interface GeneratedMap {
  width: number
  height: number
  tiles: MapTile[]
  regions: MapRegion[]
  energyPricePerMWh: number
  activeRegionId: string
  cities: MapCity[]
}

const CITY_NAMES = [
  'Harborline',
  'Midridge',
  'Northfen',
  'Ashford',
  'Kelvin Bay',
  'Stonewell',
]

function key(x: number, y: number) {
  return `${x},${y}`
}

function inBounds(x: number, y: number, w: number, h: number) {
  return x >= 0 && y >= 0 && x < w && y < h
}

function dist2(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function baseTile(
  x: number,
  y: number,
  regionId: string,
  partial: Partial<MapTile> & { kind: TileKind },
): MapTile {
  return {
    x,
    y,
    regionId,
    owner: 'neutral',
    name: '',
    level: 1,
    buildingProgress: 0,
    buildingTarget: 0,
    rackCapacity: 0,
    racksUsed: 0,
    mwCapacity: 0,
    mwGeneration: 0,
    capex: 0,
    opexPerDay: 0,
    note: '',
    landValue: 0,
    cityId: undefined,
    ...partial,
  }
}

/** Orthogonal-only polyline (no diagonals) — roads stay axis-aligned. */
function orthoCorridor(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  preferHorizFirst: boolean,
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = []
  if (preferHorizFirst) {
    const sx = x0 < x1 ? 1 : -1
    for (let x = x0; x !== x1; x += sx) cells.push({ x, y: y0 })
    cells.push({ x: x1, y: y0 })
    const sy = y0 < y1 ? 1 : -1
    for (let y = y0 + sy; y !== y1 + sy; y += sy) {
      if (y === y0) continue
      cells.push({ x: x1, y })
      if (y === y1) break
    }
  } else {
    const sy = y0 < y1 ? 1 : -1
    for (let y = y0; y !== y1; y += sy) cells.push({ x: x0, y })
    cells.push({ x: x0, y: y1 })
    const sx = x0 < x1 ? 1 : -1
    for (let x = x0 + sx; x !== x1 + sx; x += sx) {
      if (x === x0) continue
      cells.push({ x, y: y1 })
      if (x === x1) break
    }
  }
  // Dedupe while preserving order
  const seen = new Set<string>()
  return cells.filter((c) => {
    const k = key(c.x, c.y)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const CITY_INDUSTRIES = ['tech', 'industrial', 'port', 'finance', 'mixed'] as const

function placeCities(rng: Rng, w: number, h: number, count: number): MapCity[] {
  const cities: MapCity[] = []
  const names = [...CITY_NAMES]
  for (let i = names.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[names[i], names[j]] = [names[j]!, names[i]!]
  }
  const minSep = Math.max(12, Math.floor(Math.min(w, h) * 0.3))
  let attempts = 0
  while (cities.length < count && attempts < 100) {
    attempts++
    const margin = Math.floor(Math.min(w, h) * 0.14)
    const cx = rng.int(margin, w - margin - 1)
    const cy = rng.int(margin, h - margin - 1)
    if (cities.some((c) => Math.sqrt(dist2(c.cx, c.cy, cx, cy)) < minSep)) continue
    const i = cities.length
    const radius = rng.int(4, 6)
    const population = Math.round(160_000 + radius * radius * 48_000 + rng.int(0, 220_000))
    const industry = CITY_INDUSTRIES[i % CITY_INDUSTRIES.length]!
    const talentCapacity = cityTalentCapacity(population, industry)
    cities.push({
      id: `city_${i}`,
      name: names[i] ?? `City ${i + 1}`,
      cx,
      cy,
      radius,
      population,
      powerRadius: radius + 4 + rng.int(0, 2),
      powerBuyMw: Math.max(4, 3.5 + radius * 1.5 + population / 220_000),
      powerBuyPriceMult: 0.7 + (i % 3) * 0.07 + rng.range(0, 0.05),
      industry,
      talentCapacity,
      talentAvailable: cityTalentInitial(talentCapacity, 0.32 + rng.range(0, 0.12)),
      talentWageMult: industry === 'tech' ? 1.18 : industry === 'finance' ? 1.12 : 1,
    })
  }
  while (cities.length < count) {
    const i = cities.length
    const radius = 5
    const population = 320_000 + i * 110_000
    const industry = CITY_INDUSTRIES[i % CITY_INDUSTRIES.length]!
    const talentCapacity = cityTalentCapacity(population, industry)
    cities.push({
      id: `city_${i}`,
      name: names[i] ?? `City ${i + 1}`,
      cx: Math.floor(w * (0.22 + i * 0.28)),
      cy: Math.floor(h * (0.28 + (i % 2) * 0.38)),
      radius,
      population,
      powerRadius: radius + 5,
      powerBuyMw: 8 + i * 2,
      powerBuyPriceMult: 0.74,
      industry,
      talentCapacity,
      talentAvailable: cityTalentInitial(talentCapacity, 0.35),
      talentWageMult: industry === 'tech' ? 1.15 : 1,
    })
  }
  return cities
}

export function computeLandValue(
  x: number,
  y: number,
  cities: { cx: number; cy: number }[],
  base: number,
  peak: number,
): number {
  if (cities.length === 0) return base
  let best = Infinity
  for (const c of cities) {
    const d = Math.sqrt(dist2(x, y, c.cx, c.cy))
    if (d < best) best = d
  }
  const fall = Math.exp(-best / 7.5)
  return Math.floor(base + peak * fall)
}

export function nearestCityDistance(
  x: number,
  y: number,
  cities: { cx: number; cy: number }[],
): number {
  if (cities.length === 0) return Infinity
  let best = Infinity
  for (const c of cities) {
    const d = Math.sqrt(dist2(x, y, c.cx, c.cy))
    if (d < best) best = d
  }
  return best
}

export function roadsConnectCities(
  tiles: MapTile[],
  width: number,
  height: number,
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
): boolean {
  const road = new Set<string>()
  for (const t of tiles) {
    if (t.kind === 'road') road.add(key(t.x, t.y))
  }
  // Start: any road within city core
  let start: string | null = null
  for (let dy = -2; dy <= 2 && !start; dy++) {
    for (let dx = -2; dx <= 2 && !start; dx++) {
      const k = key(a.cx + dx, a.cy + dy)
      if (road.has(k)) start = k
    }
  }
  if (!start) return false
  return bfsRoad(road, start, b.cx, b.cy, width, height)
}

function bfsRoad(
  road: Set<string>,
  start: string,
  tx: number,
  ty: number,
  w: number,
  h: number,
): boolean {
  const q = [start]
  const seen = new Set<string>([start])
  const goal = new Set<string>()
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (inBounds(tx + dx, ty + dy, w, h)) goal.add(key(tx + dx, ty + dy))
    }
  }
  while (q.length) {
    const cur = q.shift()!
    if (goal.has(cur)) return true
    const [xs, ys] = cur.split(',').map(Number) as [number, number]
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = xs + dx
      const ny = ys + dy
      const nk = key(nx, ny)
      if (!inBounds(nx, ny, w, h) || seen.has(nk) || !road.has(nk)) continue
      seen.add(nk)
      q.push(nk)
    }
  }
  return false
}

function isRoadAdj(
  roadSet: Set<string>,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    if (inBounds(x + dx, y + dy, w, h) && roadSet.has(key(x + dx, y + dy))) return true
  }
  return false
}

function paintRoad(
  kinds: Map<string, TileKind>,
  names: Map<string, string>,
  roadSet: Set<string>,
  cells: { x: number; y: number }[],
  w: number,
  h: number,
  label: string,
) {
  for (const c of cells) {
    if (!inBounds(c.x, c.y, w, h)) continue
    const k = key(c.x, c.y)
    // Never pave over lakes
    if (kinds.get(k) === 'lake') continue
    kinds.set(k, 'road')
    names.set(k, label)
    roadSet.add(k)
  }
}

export function generateProceduralMap(config: GameConfig): GeneratedMap {
  const w = config.mapWidth
  const h = config.mapHeight
  const rng = createRng(config.seed + 9001)
  const cities = placeCities(rng, w, h, config.cityCount)

  const kinds = new Map<string, TileKind>()
  const names = new Map<string, string>()
  const notes = new Map<string, string>()
  const cityIds = new Map<string, string>()
  const roadSet = new Set<string>()

  // ─── 1) Arterial highways between every city pair (orthogonal L-paths) ───
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      const a = cities[i]!
      const b = cities[j]!
      const path = orthoCorridor(a.cx, a.cy, b.cx, b.cy, rng.next() > 0.5)
      paintRoad(kinds, names, roadSet, path, w, h, 'Highway')
      // Optional second L (ring alternative) for redundancy
      if (rng.next() > 0.55) {
        const path2 = orthoCorridor(a.cx, a.cy, b.cx, b.cy, !(path[1]?.y === a.cy))
        paintRoad(kinds, names, roadSet, path2, w, h, 'Highway')
      }
    }
  }

  // ─── 2) Local street grids at each city (axis-aligned, connected to highways) ───
  for (const city of cities) {
    const half = city.radius
    const x0 = city.cx - half
    const x1 = city.cx + half
    const y0 = city.cy - half
    const y1 = city.cy + half

    // Spacing 2: avenues form a proper grid
    const spacing = 2
    for (let x = x0; x <= x1; x++) {
      if ((x - x0) % spacing !== 0) continue
      const col: { x: number; y: number }[] = []
      for (let y = y0; y <= y1; y++) col.push({ x, y })
      paintRoad(kinds, names, roadSet, col, w, h, `${city.name} Ave`)
    }
    for (let y = y0; y <= y1; y++) {
      if ((y - y0) % spacing !== 0) continue
      const row: { x: number; y: number }[] = []
      for (let x = x0; x <= x1; x++) row.push({ x, y })
      paintRoad(kinds, names, roadSet, row, w, h, `${city.name} St`)
    }

    // Outer ring road
    const ring: { x: number; y: number }[] = []
    for (let x = x0; x <= x1; x++) {
      ring.push({ x, y: y0 }, { x, y: y1 })
    }
    for (let y = y0; y <= y1; y++) {
      ring.push({ x: x0, y }, { x: x1, y })
    }
    paintRoad(kinds, names, roadSet, ring, w, h, `${city.name} Ring`)

    // Spurs from ring outward (suburbs feeders)
    for (let s = 0; s < 4; s++) {
      const dir = (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const
      )[s]!
      let x = city.cx + dir[0] * half
      let y = city.cy + dir[1] * half
      const spur: { x: number; y: number }[] = []
      const len = rng.int(4, 9)
      for (let step = 0; step < len; step++) {
        x += dir[0]
        y += dir[1]
        if (!inBounds(x, y, w, h)) break
        spur.push({ x, y })
      }
      paintRoad(kinds, names, roadSet, spur, w, h, 'Feeder road')
    }
  }

  // ─── 3) Buildings ONLY adjacent to roads ───
  for (const city of cities) {
    const half = city.radius
    const x0 = city.cx - half
    const x1 = city.cx + half
    const y0 = city.cy - half
    const y1 = city.cy + half

    // Core blocks: fill non-road cells inside grid that touch a road
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inBounds(x, y, w, h)) continue
        const k = key(x, y)
        if (roadSet.has(k) || kinds.get(k) === 'road') continue
        if (!isRoadAdj(roadSet, x, y, w, h)) continue
        // Closer to center = denser commercial/city; outer = mix
        const d = Math.sqrt(dist2(x, y, city.cx, city.cy))
        if (d <= half * 0.55) {
          kinds.set(k, 'city')
          names.set(k, `${city.name} downtown`)
          notes.set(k, 'Metro demand block')
          cityIds.set(k, city.id)
        } else if (d <= half) {
          // Mid district: mostly city, some offices as city kind still
          kinds.set(k, 'city')
          names.set(k, city.name)
          notes.set(k, 'Urban district')
          cityIds.set(k, city.id)
        }
      }
    }

    // Plaza at exact center if free, else leave road
    const pk = key(city.cx, city.cy)
    if (!roadSet.has(pk)) {
      kinds.set(pk, 'city')
      names.set(pk, `${city.name} plaza`)
      cityIds.set(pk, city.id)
    }

    // Parks: 2–3 empty road-adjacent cells near ring
    let parks = 0
    for (let tries = 0; tries < 40 && parks < 3; tries++) {
      const px = rng.int(x0 - 1, x1 + 1)
      const py = rng.int(y0 - 1, y1 + 1)
      if (!inBounds(px, py, w, h)) continue
      const k = key(px, py)
      if (kinds.has(k) || roadSet.has(k)) continue
      if (!isRoadAdj(roadSet, px, py, w, h)) continue
      kinds.set(k, 'park')
      names.set(k, `${city.name} park`)
      parks++
    }

    // Suburbs: houses along feeder/ring roads outside core
    for (let y = y0 - 4; y <= y1 + 4; y++) {
      for (let x = x0 - 4; x <= x1 + 4; x++) {
        if (!inBounds(x, y, w, h)) continue
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue
        const k = key(x, y)
        if (kinds.has(k) || roadSet.has(k)) continue
        if (!isRoadAdj(roadSet, x, y, w, h)) continue
        const d = Math.sqrt(dist2(x, y, city.cx, city.cy))
        if (d > half + 4.5) continue
        if (rng.next() > 0.4) {
          kinds.set(k, 'house')
          names.set(k, `${city.name} suburbs`)
          cityIds.set(k, city.id)
        }
      }
    }
  }

  // Warehouses / industrial along highways outside city cores
  const roadList = [...roadSet].map((k) => {
    const [x, y] = k.split(',').map(Number) as [number, number]
    return { x, y }
  })
  let warehouses = 0
  const maxWh = Math.max(8, Math.floor((w * h) / 350))
  for (let i = 0; i < roadList.length && warehouses < maxWh; i++) {
    const r = roadList[(i * 17 + config.seed) % roadList.length]!
    if (nearestCityDistance(r.x, r.y, cities) < 7) continue
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = r.x + dx
      const y = r.y + dy
      const k = key(x, y)
      if (!inBounds(x, y, w, h) || kinds.has(k) || roadSet.has(k)) continue
      if (rng.next() > 0.72) {
        kinds.set(k, 'warehouse')
        names.set(k, 'Logistics yard')
        warehouses++
        break
      }
    }
  }

  // ─── 4) Lakes (away from roads & cities) ───
  function growLake(seedX: number, seedY: number, targetSize: number, label: string) {
    const directions = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const
    const cells = new Map<string, { x: number; y: number }>()
    const frontier = new Map<string, { x: number; y: number }>()

    const canFlood = (x: number, y: number) => {
      const k = key(x, y)
      return (
        inBounds(x, y, w, h) &&
        !roadSet.has(k) &&
        !kinds.has(k) &&
        !isRoadAdj(roadSet, x, y, w, h) &&
        !cities.some((city) => dist2(city.cx, city.cy, x, y) < (city.radius + 4) ** 2)
      )
    }

    if (!canFlood(seedX, seedY)) return 0

    const addCell = (x: number, y: number) => {
      const k = key(x, y)
      cells.set(k, { x, y })
      frontier.delete(k)
      for (const [dx, dy] of directions) {
        const nx = x + dx
        const ny = y + dy
        const neighborKey = key(nx, ny)
        if (!cells.has(neighborKey) && !frontier.has(neighborKey) && canFlood(nx, ny)) {
          frontier.set(neighborKey, { x: nx, y: ny })
        }
      }
    }

    addCell(seedX, seedY)
    while (frontier.size && cells.size < targetSize) {
      let selected: { x: number; y: number } | undefined
      let selectedScore = -Infinity
      for (const candidate of frontier.values()) {
        let cardinalNeighbors = 0
        let diagonalNeighbors = 0
        for (const [dx, dy] of directions) {
          if (cells.has(key(candidate.x + dx, candidate.y + dy))) cardinalNeighbors++
        }
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const) {
          if (cells.has(key(candidate.x + dx, candidate.y + dy))) diagonalNeighbors++
        }

        // Prefer cells that fill the basin instead of extending a thin branch.
        // A small seeded jitter keeps the perimeter irregular without sacrificing
        // four-way connectivity or producing road-like ribbons.
        const radiusPenalty = Math.sqrt(dist2(seedX, seedY, candidate.x, candidate.y)) * 0.9
        const score = cardinalNeighbors * 8 + diagonalNeighbors * 1.5 - radiusPenalty + rng.range(0, 2.75)
        if (score > selectedScore) {
          selected = candidate
          selectedScore = score
        }
      }
      if (!selected) break
      addCell(selected.x, selected.y)
    }

    // Do not leave behind a tiny fragment if obstacles starve a proposed basin.
    const minimumSize = Math.max(4, Math.floor(targetSize * 0.55))
    if (cells.size < minimumSize) return 0
    for (const [k, cell] of cells) {
      kinds.set(k, 'lake')
      names.set(key(cell.x, cell.y), label)
    }
    return cells.size
  }

  for (let i = 0; i < rng.int(2, 4); i++) {
    let lx = rng.int(5, w - 6)
    let ly = rng.int(5, h - 6)
    let guard = 0
    while (
      (roadSet.has(key(lx, ly)) ||
        nearestCityDistance(lx, ly, cities) < 10 ||
        isRoadAdj(roadSet, lx, ly, w, h)) &&
      guard++ < 40
    ) {
      lx = rng.int(5, w - 6)
      ly = rng.int(5, h - 6)
    }
    growLake(lx, ly, rng.int(16, 36), i === 0 ? 'Great basin' : 'Regional lake')
  }
  for (let i = 0; i < Math.max(3, Math.floor((w * h) / 550)); i++) {
    const lx = rng.int(3, w - 4)
    const ly = rng.int(3, h - 4)
    if (roadSet.has(key(lx, ly)) || kinds.has(key(lx, ly))) continue
    growLake(lx, ly, rng.int(5, 11), 'Pond')
  }

  // Forests — clusters not on roads
  for (let i = 0; i < Math.floor((w * h) / 100); i++) {
    const fx = rng.int(2, w - 3)
    const fy = rng.int(2, h - 3)
    const fk = key(fx, fy)
    if (roadSet.has(fk) || kinds.has(fk)) continue
    if (nearestCityDistance(fx, fy, cities) < 6) continue
    // Small forest blob
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (rng.next() > 0.55 && !(dx === 0 && dy === 0)) continue
        const x = fx + dx
        const y = fy + dy
        const k = key(x, y)
        if (!inBounds(x, y, w, h) || roadSet.has(k) || kinds.has(k)) continue
        kinds.set(k, 'forest')
        names.set(k, 'Woodland')
      }
    }
  }

  // Regions
  const regions: MapRegion[] = cities.map((c, i) => {
    const half = Math.floor(Math.min(w, h) / (cities.length + 1))
    const originX = Math.max(0, c.cx - half)
    const originY = Math.max(0, c.cy - half)
    return {
      id: c.id,
      name: c.name,
      originX,
      originY,
      width: Math.min(w - originX, half * 2 + 4),
      height: Math.min(h - originY, half * 2 + 4),
      energyPriceMult: 0.75 + i * 0.15 + rng.range(-0.05, 0.08),
      latencyToMarket: Math.max(
        0.12,
        Math.min(0.85, dist2(c.cx, c.cy, w / 2, h / 2) / (w * h * 0.15)),
      ),
      regulationRisk: 0.06 + i * 0.03,
    }
  })

  function regionIdAt(x: number, y: number): string {
    let best = regions[0]?.id ?? 'void'
    let bestD = Infinity
    for (const c of cities) {
      const d = dist2(x, y, c.cx, c.cy)
      if (d < bestD) {
        bestD = d
        best = c.id
      }
    }
    return best
  }

  // Starter pads: empty road-adjacent parcels near first city (not on buildings)
  const starterPads: { x: number; y: number }[] = []
  const c0 = cities[0]!
  for (let ring = c0.radius + 1; ring <= c0.radius + 7 && starterPads.length < 8; ring++) {
    for (let a = 0; a < 24 && starterPads.length < 8; a++) {
      // Prefer axis-aligned offsets (near feeders)
      const useAxis = a % 2 === 0
      const x = useAxis
        ? c0.cx + (a % 4 < 2 ? ring : -ring)
        : c0.cx + rng.int(-2, 2)
      const y = useAxis
        ? c0.cy + rng.int(-2, 2)
        : c0.cy + (a % 4 < 2 ? ring : -ring)
      if (!inBounds(x, y, w, h)) continue
      const k = key(x, y)
      if (kinds.has(k) || roadSet.has(k)) continue
      if (!isRoadAdj(roadSet, x, y, w, h)) continue
      starterPads.push({ x, y })
      names.set(k, 'Build-ready parcel')
      notes.set(k, 'Open lot on the road network near metro demand.')
    }
  }

  // Rival DCs: road-adjacent outside secondary cities
  const rivalSlots: { x: number; y: number; city: CityAnchor }[] = []
  for (let i = 1; i < cities.length; i++) {
    const c = cities[i]!
    for (const [dx, dy] of [
      [c.radius + 2, 0],
      [-(c.radius + 2), 0],
      [0, c.radius + 2],
      [0, -(c.radius + 2)],
    ] as const) {
      const x = c.cx + dx
      const y = c.cy + dy
      if (!inBounds(x, y, w, h)) continue
      if (kinds.has(key(x, y)) || roadSet.has(key(x, y))) continue
      if (!isRoadAdj(roadSet, x, y, w, h)) continue
      rivalSlots.push({ x, y, city: c })
      break
    }
  }

  // Ensure every road cell is kind road in kinds map
  for (const rk of roadSet) {
    kinds.set(rk, 'road')
    if (!names.has(rk)) names.set(rk, 'Road')
  }

  const tiles: MapTile[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = key(x, y)
      const rid = regionIdAt(x, y)
      let finalKind: TileKind = kinds.get(k) ?? 'empty'
      const landValue = computeLandValue(
        x,
        y,
        cities,
        config.landValueBase,
        config.landValueCityPeak,
      )
      const isStarter = starterPads.some((p) => p.x === x && p.y === y)

      // Sparse forest only far from roads
      if (finalKind === 'empty' && !isStarter) {
        const hsh = (x * 17 + y * 31 + config.seed) % 37
        if (
          hsh === 0 &&
          !isRoadAdj(roadSet, x, y, w, h) &&
          nearestCityDistance(x, y, cities) > 8
        ) {
          finalKind = 'forest'
        }
      }

      const rivalIdx = rivalSlots.findIndex((r) => r.x === x && r.y === y)
      if (rivalIdx >= 0) {
        const rival = rivalSlots[rivalIdx]!
        const rivalIds = [
          'rival_nova',
          'rival_open',
          'rival_sparse',
          'rival_chroma',
          'rival_aegis',
        ] as const
        const owner = rivalIds[rivalIdx % rivalIds.length]!
        tiles.push(
          baseTile(x, y, rid, {
            kind: 'dc',
            owner,
            name: `${rival.city.name} Node`,
            buildingProgress: 1,
            buildingTarget: 1,
            rackCapacity: 160,
            racksUsed: 90,
            opexPerDay: 95_000,
            landValue,
            cityId: rival.city.id,
            note: 'Rival campus — shares the scarce regional grid.',
          }),
        )
        continue
      }

      tiles.push(
        baseTile(x, y, rid, {
          kind: finalKind,
          name: names.get(k) ?? (finalKind === 'empty' ? '' : finalKind),
          note: notes.get(k) ?? '',
          landValue: finalKind === 'empty' ? landValue : 0,
          cityId: cityIds.get(k),
          buildingProgress: finalKind === 'empty' ? 0 : 1,
          buildingTarget: finalKind === 'empty' ? 0 : 1,
          owner: 'neutral',
        }),
      )
    }
  }

  return {
    width: w,
    height: h,
    tiles,
    regions,
    energyPricePerMWh: ECONOMY.energyBasePrice,
    activeRegionId: cities[0]?.id ?? 'city_0',
    cities,
  }
}
