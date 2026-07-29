import * as THREE from 'three'
import type { MapTile } from '../../sim/types'
import type { Neighbors } from './tileNeighbors'

const TILE = 1.05

const EMPTY_N: Neighbors = { n: false, e: false, s: false, w: false, mask: 0, count: 0 }

function mat(
  color: number,
  opts: {
    rough?: number
    metal?: number
    emissive?: number
    emInt?: number
    lockColor?: boolean
    brand?: boolean
    shellBase?: number
  } = {},
) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.rough ?? 0.5,
    metalness: opts.metal ?? 0.2,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emInt ?? 0,
  })
  if (opts.lockColor) m.userData.lockColor = true
  if (opts.brand) m.userData.brand = true
  if (opts.shellBase != null) m.userData.shellBase = opts.shellBase
  return m
}

function darken(hex: number, amount: number): number {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  const f = 1 - amount
  return (Math.floor(r * f) << 16) | (Math.floor(g * f) << 8) | Math.floor(b * f)
}

function lighten(hex: number, amount: number): number {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  const f = amount
  return (
    (Math.min(255, Math.floor(r + (255 - r) * f)) << 16) |
    (Math.min(255, Math.floor(g + (255 - g) * f)) << 8) |
    Math.min(255, Math.floor(b + (255 - b) * f))
  )
}

function seed(x: number, y: number) {
  return ((x * 73856093) ^ (y * 19349663)) >>> 0
}

function rng(s: number) {
  let v = s
  return () => {
    v = (v * 1664525 + 1013904223) >>> 0
    return v / 0xffffffff
  }
}

export type DataCenterStyleVariant = 0 | 1 | 2

/** Finite, deterministic variants only: safe for procedural registry caching. */
export function dataCenterStyleVariant(tileX: number, tileY: number): DataCenterStyleVariant {
  return (seed(tileX, tileY) % 3) as DataCenterStyleVariant
}

function mesh(
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  opts?: { lockColor?: boolean; water?: boolean; brand?: boolean; shellBase?: number },
) {
  const m = new THREE.Mesh(geo, material)
  m.position.set(x, y, z)
  if (opts?.lockColor) m.userData.lockColor = true
  if (opts?.water) m.userData.water = true
  if (opts?.brand || material.userData?.brand) m.userData.brand = true
  if (opts?.shellBase != null) m.userData.shellBase = opts.shellBase
  else if (material.userData?.shellBase != null) m.userData.shellBase = material.userData.shellBase
  return m
}

/** LOD: full detail near camera; low is single-mesh slabs for streaming perf. */
export type KitDetail = 'full' | 'low'

/** Shared geometries — never dispose these (see GameMap.disposeObject). */
function sharedGeo<T extends THREE.BufferGeometry>(g: T): T {
  g.userData.shared = true
  return g
}

const GEO = {
  emptySlab: sharedGeo(new THREE.BoxGeometry(TILE * 0.98, 0.05, TILE * 0.98)),
  roadSlab: sharedGeo(new THREE.BoxGeometry(TILE * 0.98, 0.05, TILE * 0.98)),
  lakeSlab: sharedGeo(new THREE.BoxGeometry(TILE * 0.98, 0.08, TILE * 0.98)),
  forestBlob: sharedGeo(new THREE.BoxGeometry(TILE * 0.7, 0.35, TILE * 0.7)),
  cityBlock: sharedGeo(new THREE.BoxGeometry(TILE * 0.55, 0.55, TILE * 0.55)),
  houseBlock: sharedGeo(new THREE.BoxGeometry(TILE * 0.45, 0.28, TILE * 0.4)),
}

/**
 * Detailed procedural 3D building / terrain kits for the campus map.
 * Offline-first — no network; kits use neighbor masks as a tileset auto-tiler.
 * `detail: 'low'` used far from camera / while streaming to keep pan/zoom smooth.
 */
export function createBuildingKit(
  kind: MapTile['kind'],
  color: number,
  heightScale: number,
  tileX = 0,
  tileY = 0,
  neighbors: Neighbors = EMPTY_N,
  detail: KitDetail = 'full',
): THREE.Group {
  const g = new THREE.Group()
  g.userData.kit = kind
  g.userData.mask = neighbors.mask
  g.userData.detail = detail
  const w = TILE * 0.98
  const h = Math.max(0.08, heightScale)
  const r = rng(seed(tileX, tileY))

  if (detail === 'low') {
    return kitLow(g, kind, color, h, w)
  }

  switch (kind) {
    case 'empty':
      return kitEmpty(g, w, color, r)
    case 'dc':
      return kitDcSmall(g, w, h, color, dataCenterStyleVariant(tileX, tileY))
    case 'dc_m':
      return kitDcMedium(g, w, Math.max(h * 1.12, 0.42), color, dataCenterStyleVariant(tileX, tileY))
    case 'dc_l':
      return kitDcLarge(g, w, Math.max(h * 1.28, 0.55), color, dataCenterStyleVariant(tileX, tileY))
    case 'substation':
      return kitSubstation(g, w, h, color)
    case 'solar':
      return kitSolar(g, w, color)
    case 'gas':
      return kitGas(g, w, h, color)
    case 'nuclear':
      return kitNuclear(g, w, h, color)
    case 'fab':
      return kitFab(g, w, h, color)
    case 'city':
      return kitCity(g, w, h, color, r, neighbors, tileX, tileY)
    case 'lake':
      return kitLake(g, w, r, neighbors)
    case 'forest':
      return kitForest(g, w, r, neighbors)
    case 'house':
      return kitHouse(g, w, r)
    case 'road':
      return kitRoad(g, w, r, neighbors, tileX, tileY)
    case 'park':
      return kitPark(g, w, r)
    case 'warehouse':
      return kitWarehouse(g, w, h, color, r)
    case 'cooling':
      return kitCooling(g, w, h, color)
    case 'battery':
      return kitBattery(g, w, h, color)
    case 'office':
    case 'hq':
      return kitOffice(g, w, h, color, r)
    case 'hq_m':
      return kitOffice(g, w, h * 1.15, color, r)
    case 'hq_l':
      return kitOffice(g, w, h * 1.35, color, r)
    case 'lab':
      return kitLab(g, w, h, color)
    default:
      return kitEmpty(g, w, color, r)
  }
}

/** Cheap single-mesh stand-ins — share BufferGeometry across instances. */
function kitLow(
  g: THREE.Group,
  kind: MapTile['kind'],
  color: number,
  h: number,
  w: number,
): THREE.Group {
  const grass = color && color > 0x101010 ? color : 0x2a4a32
  switch (kind) {
    case 'empty':
    case 'park':
      g.add(
        mesh(GEO.emptySlab, mat(grass, { rough: 0.95, metal: 0.02, lockColor: true }), 0, 0.025, 0, {
          lockColor: true,
        }),
      )
      return g
    case 'road':
      g.add(
        mesh(GEO.roadSlab, mat(0x2c2e36, { rough: 0.85, lockColor: true }), 0, 0.025, 0, {
          lockColor: true,
        }),
      )
      return g
    case 'lake':
      g.add(
        mesh(
          GEO.lakeSlab,
          mat(0x1a6a9a, {
            rough: 0.15,
            metal: 0.35,
            emissive: 0x0a3a5a,
            emInt: 0.2,
            lockColor: true,
          }),
          0,
          0.04,
          0,
          { lockColor: true, water: true },
        ),
      )
      return g
    case 'forest':
      g.add(mesh(GEO.emptySlab, mat(0x2a4a32, { rough: 0.95, lockColor: true }), 0, 0.025, 0, { lockColor: true }))
      g.add(
        mesh(GEO.forestBlob, mat(0x2d6a3a, { rough: 0.9, lockColor: true }), 0, 0.22, 0, {
          lockColor: true,
        }),
      )
      return g
    case 'city':
      g.add(mesh(GEO.emptySlab, mat(0x3a3a42, { rough: 0.9, lockColor: true }), 0, 0.025, 0, { lockColor: true }))
      g.add(mesh(GEO.cityBlock, mat(color || 0x6b5b95, { rough: 0.5, metal: 0.2 }), 0, 0.32, 0))
      return g
    case 'house':
      g.add(mesh(GEO.emptySlab, mat(0x3a5a32, { rough: 0.95, lockColor: true }), 0, 0.025, 0, { lockColor: true }))
      g.add(mesh(GEO.houseBlock, mat(color || 0xd4c4a8, { rough: 0.7 }), 0, 0.18, 0))
      return g
    case 'dc': {
      const hh = Math.max(0.2, h * 0.75)
      const shell = shellColor(color, 0x6a7580, 0.22)
      g.add(mesh(new THREE.BoxGeometry(w * 0.7, hh, w * 0.48), mat(shell, { rough: 0.55, metal: 0.22, shellBase: 0x6a7580 }), 0, hh / 2, 0, { shellBase: 0x6a7580 }))
      g.add(mesh(new THREE.BoxGeometry(w * 0.5, 0.04, 0.04), mat(color, { brand: true, emissive: color, emInt: 0.2 }), 0, hh * 0.7, w * 0.25, { brand: true }))
      return g
    }
    case 'dc_m': {
      const hh = Math.max(0.26, h * 0.9)
      const shell = shellColor(color, 0x5c6874, 0.2)
      g.add(mesh(new THREE.BoxGeometry(w * 0.4, hh, w * 0.72), mat(shell, { rough: 0.5, metal: 0.25, shellBase: 0x5c6874 }), -w * 0.18, hh / 2, 0, { shellBase: 0x5c6874 }))
      g.add(mesh(new THREE.BoxGeometry(w * 0.4, hh * 0.85, w * 0.72), mat(shell, { rough: 0.5, metal: 0.25, shellBase: 0x5c6874 }), w * 0.18, hh * 0.42, 0, { shellBase: 0x5c6874 }))
      return g
    }
    case 'dc_l': {
      const hh = Math.max(0.32, h * 1.05)
      const shell = shellColor(color, 0x4f5b68, 0.18)
      g.add(mesh(new THREE.BoxGeometry(w * 0.82, hh, w * 0.55), mat(shell, { rough: 0.48, metal: 0.28, shellBase: 0x4f5b68 }), 0, hh / 2, 0, { shellBase: 0x4f5b68 }))
      g.add(mesh(new THREE.BoxGeometry(w * 0.24, hh * 1.35, w * 0.24), mat(shell, { rough: 0.48, metal: 0.28, shellBase: 0x4f5b68 }), w * 0.28, hh * 0.68, w * 0.12, { shellBase: 0x4f5b68 }))
      return g
    }
    default: {
      // Player / rival structures: industrial shell + brand edge (not solid neon)
      const hh = Math.max(0.18, h * 0.85)
      const base = 0x6a7080
      const shell = shellColor(color || 0x888888, base, 0.25)
      g.add(mesh(new THREE.BoxGeometry(w * 0.75, hh, w * 0.75), mat(shell, { rough: 0.55, metal: 0.22, shellBase: base }), 0, hh / 2, 0, { shellBase: base }))
      g.add(mesh(new THREE.BoxGeometry(w * 0.55, 0.035, 0.04), mat(color || 0x3dffc0, { brand: true, emissive: color || 0x3dffc0, emInt: 0.18 }), 0, hh * 0.75, w * 0.38, { brand: true }))
      return g
    }
  }
}

function kitEmpty(g: THREE.Group, _w: number, color: number, _r: () => number) {
  // Single grass slab (shared geo) — patches were killing pan/zoom on mega maps
  const grassCol = color && color > 0x202020 ? color : 0x4a7a48
  const ground = mesh(
    GEO.emptySlab,
    mat(grassCol, { rough: 0.92, metal: 0.02, lockColor: true }),
    0,
    0.025,
    0,
    { lockColor: true },
  )
  g.add(ground)
  return g
}

/** Mix ownership tint into industrial base (avoids solid neon shells). */
function shellColor(ownerTint: number, base = 0x6a7580, amount = 0.28): number {
  const br = (base >> 16) & 0xff
  const bg = (base >> 8) & 0xff
  const bb = base & 0xff
  const tr = (ownerTint >> 16) & 0xff
  const tg = (ownerTint >> 8) & 0xff
  const tb = ownerTint & 0xff
  const a = amount
  return (
    (Math.floor(br * (1 - a) + tr * a) << 16) |
    (Math.floor(bg * (1 - a) + tg * a) << 8) |
    Math.floor(bb * (1 - a) + tb * a)
  )
}

/** Small edge hall — compact 1-tile POP (96 bays). Single low box + dock + 2 chillers. */
function kitDcSmall(g: THREE.Group, w: number, h: number, color: number, variant: DataCenterStyleVariant) {
  const base = 0x6a7580
  const shell = shellColor(color, base, 0.22)
  const body = mat(shell, { rough: 0.55, metal: 0.22, shellBase: base })
  const accent = mat(darken(shell, 0.22), { rough: 0.48, metal: 0.3, shellBase: base })
  const brand = mat(color, { rough: 0.35, metal: 0.4, emissive: color, emInt: 0.22, brand: true })
  const steel = mat(0x4a5568, { metal: 0.55, rough: 0.35, lockColor: true })

  // Compact rectangular shell
  const hallH = Math.max(0.28, h * 0.92)
  g.add(mesh(new THREE.BoxGeometry(w * 0.72, hallH, w * 0.48), body, 0, hallH / 2, 0.04, { shellBase: base }))
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.78, hallH * 0.08, w * 0.54),
      accent,
      0,
      hallH + hallH * 0.04,
      0.04,
      { shellBase: base },
    ),
  )

  // Two rooftop CRAC units
  for (let i = 0; i < 2; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.14, 0.09, 0.12),
        steel,
        -0.14 + i * 0.28,
        hallH + 0.1,
        -0.02,
        { lockColor: true },
      ),
    )
  }
  if (variant === 1) {
    // Edge-compute variant: compact roof comms spine.
    g.add(mesh(new THREE.BoxGeometry(w * 0.42, 0.035, 0.055), brand, 0, hallH + 0.18, -0.02, { brand: true }))
    g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 8), steel, 0, hallH + 0.1, -0.02, { lockColor: true }))
  } else if (variant === 2) {
    // Warm-climate variant: visibly larger heat rejection bank.
    for (const x of [-0.2, 0, 0.2]) g.add(mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.085, 10), steel, x, hallH + 0.1, -0.02, { lockColor: true }))
  }

  // Side loading dock (single bay)
  g.add(mesh(new THREE.BoxGeometry(w * 0.28, hallH * 0.32, w * 0.22), accent, -w * 0.3, hallH * 0.16, w * 0.22))
  g.add(
    mesh(
      new THREE.BoxGeometry(0.16, 0.03, 0.14),
      mat(0x333840, { rough: 0.9, lockColor: true }),
      -w * 0.3,
      0.03,
      w * 0.38,
      { lockColor: true },
    ),
  )

  // Slim window band
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.55, hallH * 0.1, 0.03),
      mat(0x88ccff, {
        rough: 0.15,
        metal: 0.55,
        emissive: 0x224466,
        emInt: 0.2,
        lockColor: true,
      }),
      0.04,
      hallH * 0.5,
      w * 0.26,
      { lockColor: true },
    ),
  )

  // Ownership brand stripe (only place that uses bright tint)
  g.add(mesh(new THREE.BoxGeometry(w * 0.72, 0.04, 0.03), brand, 0, hallH * 0.72, w * 0.25, { brand: true }))

  // One diesel pad + fence posts
  g.add(
    mesh(
      new THREE.BoxGeometry(0.16, 0.1, 0.12),
      mat(0x3a3f4a, { metal: 0.4, lockColor: true }),
      w * 0.3,
      0.06,
      w * 0.22,
      { lockColor: true },
    ),
  )
  for (const [x, z] of [
    [-0.4, -0.38],
    [0.4, -0.38],
    [-0.4, 0.38],
    [0.4, 0.38],
  ] as const) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.035, 0.14, 0.035),
        mat(0x555a66, { lockColor: true }),
        x * w,
        0.07,
        z * w,
        { lockColor: true },
      ),
    )
  }
  return g
}

/** Medium campus hall — 2×2 footprint massing: dual wings + cooling yard. */
function kitDcMedium(g: THREE.Group, w: number, h: number, color: number, variant: DataCenterStyleVariant) {
  const base = 0x5c6874
  const shell = shellColor(color, base, 0.2)
  const body = mat(shell, { rough: 0.5, metal: 0.25, shellBase: base })
  const accent = mat(darken(shell, 0.25), { rough: 0.45, metal: 0.35, shellBase: base })
  const glow = mat(color, { rough: 0.28, metal: 0.48, emissive: color, emInt: 0.35, brand: true })
  const brand = mat(color, { rough: 0.35, metal: 0.4, emissive: color, emInt: 0.25, brand: true })
  const steel = mat(0x4a5568, { metal: 0.55, rough: 0.32, lockColor: true })
  const hallH = Math.max(0.38, h)

  // Parallel dual halls (campus look on one tile visual)
  g.add(mesh(new THREE.BoxGeometry(w * 0.42, hallH, w * 0.78), body, -w * 0.22, hallH / 2, 0, { shellBase: base }))
  g.add(mesh(new THREE.BoxGeometry(w * 0.42, hallH * 0.88, w * 0.78), body, w * 0.22, hallH * 0.44, 0, { shellBase: base }))

  // Link corridor between wings
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.18, hallH * 0.45, w * 0.28),
      accent,
      0,
      hallH * 0.22,
      0.08,
      { shellBase: base },
    ),
  )

  // Flat roofs
  g.add(
    mesh(new THREE.BoxGeometry(w * 0.46, hallH * 0.06, w * 0.82), accent, -w * 0.22, hallH + 0.02, 0, {
      shellBase: base,
    }),
  )
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.46, hallH * 0.06, w * 0.82),
      accent,
      w * 0.22,
      hallH * 0.88 + 0.02,
      0,
      { shellBase: base },
    ),
  )

  // Cooling yard between wings (4 cylindrical towers)
  for (let i = 0; i < 4; i++) {
    g.add(
      mesh(
        new THREE.CylinderGeometry(0.05, 0.065, hallH * 0.55, 10),
        glow,
        -0.08 + (i % 2) * 0.16,
        hallH * 0.35,
        -0.22 + Math.floor(i / 2) * 0.2,
        { brand: true },
      ),
    )
  }
  if (variant === 1) {
    const solar = mat(0x173f66, { rough: 0.18, metal: 0.65, lockColor: true })
    for (let i = 0; i < 3; i++) g.add(mesh(new THREE.BoxGeometry(0.11, 0.018, 0.2), solar, -0.22 + i * 0.14, hallH + 0.16, 0.17, { lockColor: true }))
  } else if (variant === 2) {
    g.add(mesh(new THREE.CylinderGeometry(0.075, 0.09, hallH * 0.72, 12), steel, 0, hallH * 0.4, -w * 0.38, { lockColor: true }))
  }

  // Rooftop chillers (row of 4)
  for (let i = 0; i < 4; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.11, 0.08, 0.14),
        steel,
        -w * 0.22 + (i - 1.5) * 0.12,
        hallH + 0.1,
        -0.12,
        { lockColor: true },
      ),
    )
  }

  // Loading dock at front
  g.add(
    mesh(new THREE.BoxGeometry(w * 0.38, hallH * 0.28, w * 0.2), accent, -w * 0.15, hallH * 0.14, w * 0.38),
  )
  g.add(
    mesh(
      new THREE.BoxGeometry(0.22, 0.035, 0.16),
      mat(0x333840, { rough: 0.9, lockColor: true }),
      -w * 0.15,
      0.03,
      w * 0.48,
      { lockColor: true },
    ),
  )

  // Blue glass ribbon on both wings
  const glass = mat(0x6eb8ff, {
    rough: 0.12,
    metal: 0.65,
    emissive: 0x1a3a66,
    emInt: 0.28,
    lockColor: true,
  })
  g.add(mesh(new THREE.BoxGeometry(0.03, hallH * 0.14, w * 0.55), glass, -w * 0.44, hallH * 0.52, 0, { lockColor: true }))
  g.add(mesh(new THREE.BoxGeometry(0.03, hallH * 0.12, w * 0.55), glass, w * 0.44, hallH * 0.45, 0, { lockColor: true }))

  // Brand stripe on link corridor
  g.add(mesh(new THREE.BoxGeometry(w * 0.18, 0.035, w * 0.28), brand, 0, hallH * 0.48, 0.08, { brand: true }))

  // Dual gens
  for (let i = 0; i < 2; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.14, 0.1, 0.11),
        mat(0x3a3f4a, { metal: 0.45, lockColor: true }),
        w * 0.32,
        0.06,
        w * 0.18 + i * 0.14,
        { lockColor: true },
      ),
    )
  }

  // Security fence ring
  for (const [x, z] of [
    [-0.44, -0.44],
    [0.44, -0.44],
    [-0.44, 0.44],
    [0.44, 0.44],
    [0, -0.46],
    [0, 0.46],
  ] as const) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.04, 0.16, 0.04),
        mat(0x555a66, { lockColor: true }),
        x * w,
        0.08,
        z * w,
        { lockColor: true },
      ),
    )
  }
  return g
}

/** Large mega campus — multi-volume hyperscale with tower, mast, cooling farm. */
function kitDcLarge(g: THREE.Group, w: number, h: number, color: number, variant: DataCenterStyleVariant) {
  const base = 0x4f5b68
  const shell = shellColor(color, base, 0.18)
  const body = mat(shell, { rough: 0.48, metal: 0.28, shellBase: base })
  const accent = mat(darken(shell, 0.28), { rough: 0.42, metal: 0.4, shellBase: base })
  const glow = mat(color, { rough: 0.25, metal: 0.55, emissive: color, emInt: 0.4, brand: true })
  const brand = mat(color, { rough: 0.32, metal: 0.45, emissive: color, emInt: 0.28, brand: true })
  const steel = mat(0x4a5568, { metal: 0.6, rough: 0.3, lockColor: true })
  const hallH = Math.max(0.48, h)

  // Main mega hall (wide footprint massing)
  g.add(mesh(new THREE.BoxGeometry(w * 0.88, hallH, w * 0.55), body, 0.02, hallH / 2, -0.06, { shellBase: base }))
  // Secondary hall block
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.5, hallH * 0.82, w * 0.42),
      body,
      -w * 0.18,
      hallH * 0.41,
      w * 0.22,
      { shellBase: base },
    ),
  )
  // Admin / office tower
  const towerH = hallH * 1.45
  g.add(
    mesh(new THREE.BoxGeometry(w * 0.26, towerH, w * 0.26), accent, w * 0.3, towerH / 2, w * 0.18, {
      shellBase: base,
    }),
  )
  // Antenna mast on tower
  g.add(
    mesh(
      new THREE.CylinderGeometry(0.018, 0.028, hallH * 0.55, 8),
      mat(0x8899aa, { metal: 0.75, lockColor: true }),
      w * 0.3,
      towerH + hallH * 0.28,
      w * 0.18,
      { lockColor: true },
    ),
  )
  g.add(
    mesh(
      new THREE.SphereGeometry(0.035, 8, 8),
      mat(0xff6644, { emissive: 0xff3311, emInt: 0.6, lockColor: true }),
      w * 0.3,
      towerH + hallH * 0.55,
      w * 0.18,
      { lockColor: true },
    ),
  )

  // Continuous roof plate
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.94, hallH * 0.07, w * 0.62),
      accent,
      0.02,
      hallH + 0.03,
      -0.04,
    ),
  )
  if (variant === 1) {
    // Hyperscale colocation variant: paired cross-hall skybridges.
    for (const z of [-0.16, 0.12]) g.add(mesh(new THREE.BoxGeometry(w * 0.7, 0.075, 0.07), brand, 0, hallH * 0.72, z, { brand: true }))
  } else if (variant === 2) {
    // Water-side cooling variant: unmistakable twin thermal stores.
    for (const x of [-0.23, 0.02]) g.add(mesh(new THREE.CylinderGeometry(0.085, 0.1, hallH * 0.68, 12), steel, x, hallH * 0.36, -w * 0.37, { lockColor: true }))
  }

  // Cooling farm — 6 stacks + 6 chillers
  for (let i = 0; i < 6; i++) {
    g.add(
      mesh(
        new THREE.CylinderGeometry(0.045, 0.06, hallH * 0.5, 10),
        glow,
        -0.34 + (i % 3) * 0.18,
        hallH + hallH * 0.28,
        -0.28 + Math.floor(i / 3) * 0.16,
        { brand: true },
      ),
    )
  }
  for (let i = 0; i < 6; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.1, 0.09, 0.13),
        steel,
        -0.3 + (i % 3) * 0.2,
        hallH + 0.12,
        0.05 + Math.floor(i / 3) * 0.16,
        { lockColor: true },
      ),
    )
  }

  // Triple loading docks
  for (let i = 0; i < 3; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(w * 0.2, hallH * 0.28, w * 0.16),
        accent,
        -w * 0.28 + i * 0.22,
        hallH * 0.14,
        w * 0.4,
      ),
    )
  }
  g.add(
    mesh(
      new THREE.BoxGeometry(w * 0.55, 0.03, 0.14),
      mat(0x333840, { rough: 0.9, lockColor: true }),
      -0.06,
      0.025,
      w * 0.48,
      { lockColor: true },
    ),
  )

  // LED facade strip on main + tower
  const glass = mat(0x88eeff, {
    rough: 0.1,
    metal: 0.7,
    emissive: 0x226688,
    emInt: 0.4,
    lockColor: true,
  })
  g.add(
    mesh(new THREE.BoxGeometry(w * 0.75, hallH * 0.1, 0.035), glass, 0.02, hallH * 0.55, w * 0.22, {
      lockColor: true,
    }),
  )
  g.add(
    mesh(new THREE.BoxGeometry(w * 0.22, towerH * 0.5, 0.03), glass, w * 0.3, towerH * 0.45, w * 0.32, {
      lockColor: true,
    }),
  )
  // Brand stripe on main hall face
  g.add(
    mesh(new THREE.BoxGeometry(w * 0.88, 0.045, 0.03), brand, 0.02, hallH * 0.78, w * 0.22, {
      brand: true,
    }),
  )

  // Generator farm (4 units)
  for (let i = 0; i < 4; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.12, 0.1, 0.1),
        mat(0x3a3f4a, { metal: 0.5, lockColor: true }),
        w * 0.38,
        0.06,
        -0.28 + i * 0.12,
        { lockColor: true },
      ),
    )
  }

  // Perimeter posts denser
  for (const [x, z] of [
    [-0.46, -0.46],
    [0.46, -0.46],
    [-0.46, 0.46],
    [0.46, 0.46],
    [-0.46, 0],
    [0.46, 0],
    [0, -0.46],
    [0, 0.46],
  ] as const) {
    g.add(
      mesh(
        new THREE.BoxGeometry(0.04, 0.18, 0.04),
        mat(0x555a66, { lockColor: true }),
        x * w,
        0.09,
        z * w,
        { lockColor: true },
      ),
    )
  }
  return g
}

function kitSubstation(g: THREE.Group, w: number, h: number, color: number) {
  const base = mesh(
    new THREE.BoxGeometry(w * 0.75, Math.max(0.12, h * 0.35), w * 0.75),
    mat(color, { rough: 0.55, metal: 0.4 }),
    0,
    Math.max(0.06, h * 0.18),
    0,
  )
  g.add(base)

  const yard = mesh(
    new THREE.BoxGeometry(w * 0.95, 0.04, w * 0.95),
    mat(0x2a2e38, { rough: 0.9, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(yard)

  // Gravel texture dots
  const gritPos = [
    [-0.25, -0.2],
    [0.2, -0.28],
    [-0.15, 0.22],
    [0.28, 0.15],
    [0.05, -0.05],
    [-0.3, 0.05],
  ]
  for (const [gx, gz] of gritPos) {
    const grit = mesh(
      new THREE.BoxGeometry(0.08, 0.015, 0.08),
      mat(0x3a3e48, { rough: 0.95, lockColor: true }),
      gx,
      0.035,
      gz,
      { lockColor: true },
    )
    g.add(grit)
  }

  for (let i = 0; i < 3; i++) {
    const pole = mesh(
      new THREE.CylinderGeometry(0.035, 0.045, 0.55 + i * 0.08, 8),
      mat(0xc0c4cc, { metal: 0.7, rough: 0.3, lockColor: true }),
      -0.22 + i * 0.22,
      0.35 + i * 0.04,
      0,
      { lockColor: true },
    )
    g.add(pole)
    const insulator = mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8),
      mat(0x886644, { rough: 0.6, lockColor: true }),
      -0.22 + i * 0.22,
      0.58 + i * 0.04,
      0,
      { lockColor: true },
    )
    g.add(insulator)
    // Cross arm
    const arm = mesh(
      new THREE.BoxGeometry(0.18, 0.02, 0.03),
      mat(0x888c94, { metal: 0.6, lockColor: true }),
      -0.22 + i * 0.22,
      0.52 + i * 0.04,
      0,
      { lockColor: true },
    )
    g.add(arm)
  }
  const bus = mesh(
    new THREE.BoxGeometry(0.55, 0.03, 0.03),
    mat(0xffcc44, { metal: 0.8, emissive: 0x443300, emInt: 0.2, lockColor: true }),
    0,
    0.62,
    0,
    { lockColor: true },
  )
  g.add(bus)

  // Transformer box
  const xfmr = mesh(
    new THREE.BoxGeometry(0.22, 0.2, 0.18),
    mat(0x3d5c4a, { metal: 0.35, lockColor: true }),
    0.28,
    0.12,
    0.28,
    { lockColor: true },
  )
  g.add(xfmr)
  const bushing = mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.1, 6),
    mat(0xccaa44, { metal: 0.5, lockColor: true }),
    0.28,
    0.28,
    0.28,
    { lockColor: true },
  )
  g.add(bushing)
  return g
}

function kitSolar(g: THREE.Group, w: number, color: number) {
  const pad = mesh(
    new THREE.BoxGeometry(w, 0.05, w),
    mat(0x2a3040, { rough: 0.9, lockColor: true }),
    0,
    0.025,
    0,
    { lockColor: true },
  )
  g.add(pad)
  const panelMat = mat(0x1a3a6a, {
    rough: 0.15,
    metal: 0.65,
    emissive: color || 0x3dffc0,
    emInt: 0.15,
    lockColor: true,
  })
  const frameMat = mat(0x888c94, { metal: 0.7, rough: 0.3, lockColor: true })
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      const px = -0.22 + col * 0.44
      const pz = -0.28 + row * 0.28
      const panel = mesh(new THREE.BoxGeometry(0.38, 0.025, 0.22), panelMat, px, 0.14 + row * 0.02, pz, {
        lockColor: true,
      })
      panel.rotation.x = -0.55
      g.add(panel)
      // cell grid lines
      const line = mesh(
        new THREE.BoxGeometry(0.36, 0.005, 0.008),
        mat(0x0a1a30, { lockColor: true }),
        px,
        0.155 + row * 0.02,
        pz,
        { lockColor: true },
      )
      line.rotation.x = -0.55
      g.add(line)
      const post = mesh(
        new THREE.CylinderGeometry(0.015, 0.02, 0.12, 6),
        frameMat,
        px,
        0.06,
        pz,
        { lockColor: true },
      )
      g.add(post)
    }
  }
  // Inverter cabinet
  const inv = mesh(
    new THREE.BoxGeometry(0.12, 0.14, 0.1),
    mat(0x3a404c, { metal: 0.4, lockColor: true }),
    0.38,
    0.09,
    0.35,
    { lockColor: true },
  )
  g.add(inv)
  return g
}

function kitGas(g: THREE.Group, w: number, h: number, color: number) {
  const pad = mesh(
    new THREE.BoxGeometry(w * 0.9, 0.04, w * 0.9),
    mat(0x333840, { lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(pad)

  const tank = mesh(
    new THREE.CylinderGeometry(w * 0.28, w * 0.3, h * 0.9, 16),
    mat(color, { rough: 0.35, metal: 0.55 }),
    0,
    h * 0.45,
    0,
  )
  g.add(tank)
  const cap = mesh(
    new THREE.SphereGeometry(w * 0.28, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    mat(darken(color, 0.15), { metal: 0.5 }),
    0,
    h * 0.9,
    0,
  )
  g.add(cap)

  // Ladder
  for (let i = 0; i < 5; i++) {
    const rung = mesh(
      new THREE.BoxGeometry(0.1, 0.015, 0.02),
      mat(0x888888, { metal: 0.7, lockColor: true }),
      w * 0.3,
      0.15 + i * 0.1,
      0,
      { lockColor: true },
    )
    g.add(rung)
  }

  const pipe = mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.35, 8),
    mat(0x666666, { metal: 0.7, lockColor: true }),
    0.25,
    0.2,
    0.15,
    { lockColor: true },
  )
  pipe.rotation.z = Math.PI / 2
  g.add(pipe)

  // Valve house
  const valve = mesh(
    new THREE.BoxGeometry(0.18, 0.16, 0.16),
    mat(0x4a5566, { metal: 0.4, lockColor: true }),
    -0.32,
    0.1,
    0.28,
    { lockColor: true },
  )
  g.add(valve)
  // Flame stack
  const stack = mesh(
    new THREE.CylinderGeometry(0.03, 0.04, 0.35, 8),
    mat(0x555a66, { metal: 0.5, lockColor: true }),
    0.3,
    0.28,
    -0.28,
    { lockColor: true },
  )
  g.add(stack)
  const flame = mesh(
    new THREE.ConeGeometry(0.04, 0.1, 6),
    mat(0xff8844, { emissive: 0xff4400, emInt: 0.6, lockColor: true }),
    0.3,
    0.5,
    -0.28,
    { lockColor: true },
  )
  g.add(flame)
  return g
}

function kitNuclear(g: THREE.Group, w: number, h: number, color: number) {
  const pad = mesh(
    new THREE.BoxGeometry(w * 0.95, 0.04, w * 0.95),
    mat(0x3a3e48, { rough: 0.85, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(pad)

  const containment = mesh(
    new THREE.CylinderGeometry(w * 0.28, w * 0.32, h, 16),
    mat(color, { rough: 0.4, metal: 0.35 }),
    0.12,
    h / 2,
    0.1,
  )
  g.add(containment)
  const dome = mesh(
    new THREE.SphereGeometry(w * 0.28, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    mat(0xe8e6e1, { rough: 0.3, metal: 0.2, lockColor: true }),
    0.12,
    h,
    0.1,
    { lockColor: true },
  )
  g.add(dome)

  // Cooling towers (hyperboloid-ish)
  for (let i = 0; i < 2; i++) {
    const tower = mesh(
      new THREE.CylinderGeometry(0.1, 0.16, h * 0.9, 12),
      mat(0xc8ccc4, { rough: 0.7, lockColor: true }),
      -0.32 + i * 0.18,
      h * 0.45,
      -0.28,
      { lockColor: true },
    )
    g.add(tower)
    const lip = mesh(
      new THREE.TorusGeometry(0.1, 0.02, 6, 12),
      mat(0xb0b4ac, { lockColor: true }),
      -0.32 + i * 0.18,
      h * 0.9,
      -0.28,
      { lockColor: true },
    )
    lip.rotation.x = Math.PI / 2
    g.add(lip)
  }

  // Turbine hall
  const hall = mesh(
    new THREE.BoxGeometry(0.35, h * 0.4, 0.25),
    mat(darken(color, 0.2), { metal: 0.3, lockColor: true }),
    0.3,
    h * 0.22,
    -0.28,
    { lockColor: true },
  )
  g.add(hall)
  return g
}

function kitFab(g: THREE.Group, w: number, h: number, color: number) {
  const body = mesh(
    new THREE.BoxGeometry(w * 0.95, h * 0.65, w * 0.8),
    mat(color, { rough: 0.35, metal: 0.45 }),
    0,
    h * 0.32,
    0,
  )
  g.add(body)
  const cleanroom = mesh(
    new THREE.BoxGeometry(w * 0.55, h * 0.45, w * 0.55),
    mat(0xaaccff, {
      rough: 0.15,
      metal: 0.3,
      emissive: 0x223355,
      emInt: 0.3,
      lockColor: true,
    }),
    0,
    h * 0.75,
    0,
    { lockColor: true },
  )
  g.add(cleanroom)
  // HVAC ducts
  for (let i = 0; i < 3; i++) {
    const duct = mesh(
      new THREE.BoxGeometry(0.12, 0.08, 0.35),
      mat(0x8899aa, { metal: 0.6, lockColor: true }),
      -0.2 + i * 0.2,
      h * 1.0,
      0.15,
      { lockColor: true },
    )
    g.add(duct)
  }
  // Loading airlock
  const airlock = mesh(
    new THREE.BoxGeometry(0.2, 0.22, 0.15),
    mat(0xccddee, { metal: 0.4, lockColor: true }),
    w * 0.38,
    0.14,
    w * 0.28,
    { lockColor: true },
  )
  g.add(airlock)
  // Gas cylinder rack
  for (let i = 0; i < 3; i++) {
    const cyl = mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.16, 8),
      mat([0x4488ff, 0xff6644, 0x44cc88][i]!, { metal: 0.5, lockColor: true }),
      -w * 0.38,
      0.1,
      -0.15 + i * 0.1,
      { lockColor: true },
    )
    g.add(cyl)
  }
  return g
}

function kitCity(
  g: THREE.Group,
  w: number,
  h: number,
  color: number,
  r: () => number,
  n: Neighbors,
  tileX: number,
  tileY: number,
) {
  // Urban pavement base (seamless across city tiles)
  const base = mesh(
    new THREE.BoxGeometry(w, 0.06, w),
    mat(0x3a3e48, { rough: 0.88, lockColor: true }),
    0,
    0.03,
    0,
    { lockColor: true },
  )
  g.add(base)

  // Cross streets when adjacent to roads/city — grid feel
  if (n.n || n.s) {
    const strip = mesh(
      new THREE.BoxGeometry(0.22, 0.02, w),
      mat(0x2a2c32, { rough: 0.85, lockColor: true }),
      0,
      0.055,
      0,
      { lockColor: true },
    )
    g.add(strip)
  }
  if (n.e || n.w) {
    const strip = mesh(
      new THREE.BoxGeometry(w, 0.02, 0.22),
      mat(0x2a2c32, { rough: 0.85, lockColor: true }),
      0,
      0.055,
      0,
      { lockColor: true },
    )
    g.add(strip)
  }

  // Block density from seed + neighbor fill
  const district = (tileX * 3 + tileY * 7) % 4
  const towerCount = district === 0 ? 4 : district === 1 ? 3 : district === 2 ? 5 : 2
  const baseH = Math.max(0.45, h * (district === 0 ? 1.15 : district === 3 ? 0.55 : 0.85))

  for (let i = 0; i < towerCount; i++) {
    const bh = baseH * (0.55 + r() * 0.7)
    const bw = 0.18 + r() * 0.14
    const bd = 0.18 + r() * 0.12
    // Pack into quadrants so blocks look intentional
    const qx = (i % 2 === 0 ? -1 : 1) * (0.18 + r() * 0.12)
    const qz = (i < 2 ? -1 : 1) * (0.16 + r() * 0.12)
    const bCol =
      i % 2 === 0
        ? lighten(color || 0x6b5b95, 0.08 + r() * 0.12)
        : darken(color || 0x6b5b95, 0.1 + r() * 0.15)
    const building = mesh(
      new THREE.BoxGeometry(bw, bh, bd),
      mat(bCol, { rough: 0.38, metal: 0.28, lockColor: true }),
      qx,
      bh / 2 + 0.04,
      qz,
      { lockColor: true },
    )
    g.add(building)
    const roof = mesh(
      new THREE.BoxGeometry(bw * 1.06, 0.04, bd * 1.06),
      mat(darken(bCol, 0.25), { metal: 0.35, lockColor: true }),
      qx,
      bh + 0.06,
      qz,
      { lockColor: true },
    )
    g.add(roof)
    // Lit windows
    const floors = Math.max(2, Math.floor(bh / 0.11))
    for (let f = 0; f < floors; f++) {
      if (r() > 0.55) continue
      const lit = r() > 0.25
      const win = mesh(
        new THREE.BoxGeometry(bw * 0.55, 0.035, 0.02),
        mat(lit ? 0xffe599 : 0x2a3548, {
          rough: 0.2,
          emissive: lit ? 0xaa7744 : 0x000000,
          emInt: lit ? 0.45 : 0,
          lockColor: true,
        }),
        qx,
        0.12 + f * (bh * 0.8) / floors,
        qz + bd / 2 + 0.01,
        { lockColor: true },
      )
      g.add(win)
    }
  }

  // Street furniture on edge tiles
  if (n.count < 4 && r() > 0.4) {
    const lamp = mesh(
      new THREE.CylinderGeometry(0.015, 0.02, 0.32, 6),
      mat(0x666a72, { metal: 0.5, lockColor: true }),
      n.e ? -0.38 : 0.38,
      0.18,
      n.s ? -0.38 : 0.38,
      { lockColor: true },
    )
    g.add(lamp)
    const bulb = mesh(
      new THREE.SphereGeometry(0.035, 6, 5),
      mat(0xffeebb, { emissive: 0xffcc66, emInt: 0.55, lockColor: true }),
      lamp.position.x,
      0.36,
      lamp.position.z,
      { lockColor: true },
    )
    g.add(bulb)
  }
  return g
}

/**
 * Lake auto-tile: full water when interior, shore only on open edges.
 * Neighboring lake tiles blend into continuous water bodies.
 */
function kitLake(g: THREE.Group, w: number, r: () => number, n: Neighbors) {
  const waterCol = 0x1a7aad
  const deepCol = 0x0f4e6e
  const shoreCol = 0xc2b280
  const grassCol = 0x3d6a42

  // Underlay always grass so edges never show void
  const under = mesh(
    new THREE.BoxGeometry(w, 0.04, w),
    mat(grassCol, { rough: 0.95, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(under)

  // Expand water to tile edges where neighbors are also lake (seamless)
  const padN = n.n ? 0.5 : 0.12
  const padS = n.s ? 0.5 : 0.12
  const padE = n.e ? 0.5 : 0.12
  const padW = n.w ? 0.5 : 0.12
  const waterW = w * (padW + padE)
  const waterD = w * (padN + padS)
  const ox = ((padE - padW) / 2) * w
  const oz = ((padS - padN) / 2) * w

  const water = mesh(
    new THREE.BoxGeometry(Math.max(0.2, waterW), 0.07, Math.max(0.2, waterD)),
    mat(n.count === 4 ? deepCol : waterCol, {
      rough: 0.08,
      metal: 0.72,
      emissive: 0x0a3555,
      emInt: 0.22,
      lockColor: true,
    }),
    ox,
    0.04,
    oz,
    { lockColor: true, water: true },
  )
  water.userData.water = true
  g.add(water)

  // Shore banks only on open sides
  const shoreW = 0.1
  if (!n.n) {
    g.add(
      mesh(
        new THREE.BoxGeometry(waterW * 0.95, 0.035, shoreW),
        mat(shoreCol, { rough: 0.92, lockColor: true }),
        ox,
        0.04,
        oz - waterD / 2 + shoreW / 2,
        { lockColor: true },
      ),
    )
  }
  if (!n.s) {
    g.add(
      mesh(
        new THREE.BoxGeometry(waterW * 0.95, 0.035, shoreW),
        mat(shoreCol, { rough: 0.92, lockColor: true }),
        ox,
        0.04,
        oz + waterD / 2 - shoreW / 2,
        { lockColor: true },
      ),
    )
  }
  if (!n.w) {
    g.add(
      mesh(
        new THREE.BoxGeometry(shoreW, 0.035, waterD * 0.9),
        mat(shoreCol, { rough: 0.92, lockColor: true }),
        ox - waterW / 2 + shoreW / 2,
        0.04,
        oz,
        { lockColor: true },
      ),
    )
  }
  if (!n.e) {
    g.add(
      mesh(
        new THREE.BoxGeometry(shoreW, 0.035, waterD * 0.9),
        mat(shoreCol, { rough: 0.92, lockColor: true }),
        ox + waterW / 2 - shoreW / 2,
        0.04,
        oz,
        { lockColor: true },
      ),
    )
  }

  // Reeds only on shore edges
  if (n.count < 4) {
    for (let i = 0; i < 3; i++) {
      const side = !n.n ? 'n' : !n.s ? 's' : !n.w ? 'w' : 'e'
      const reedH = 0.1 + r() * 0.1
      const reed = mesh(
        new THREE.CylinderGeometry(0.008, 0.012, reedH, 4),
        mat(0x4a7a3a, { rough: 0.85, lockColor: true }),
        side === 'w' ? -w * 0.35 : side === 'e' ? w * 0.35 : (r() - 0.5) * 0.4,
        reedH / 2 + 0.04,
        side === 'n' ? -w * 0.35 : side === 's' ? w * 0.35 : (r() - 0.5) * 0.4,
        { lockColor: true },
      )
      g.add(reed)
    }
  }

  // Interior sparkle
  if (n.count >= 3 && r() > 0.6) {
    const lily = mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.012, 8),
      mat(0x3d8a4a, { rough: 0.7, lockColor: true }),
      (r() - 0.5) * 0.25,
      0.08,
      (r() - 0.5) * 0.25,
      { lockColor: true },
    )
    g.add(lily)
  }
  return g
}

function kitForest(g: THREE.Group, w: number, r: () => number, _n: Neighbors = EMPTY_N) {
  void _n
  const ground = mesh(
    new THREE.BoxGeometry(w, 0.05, w),
    mat(0x1e3a24, { rough: 0.95, lockColor: true }),
    0,
    0.025,
    0,
    { lockColor: true },
  )
  g.add(ground)

  // Leaf litter patches
  for (let i = 0; i < 5; i++) {
    const litter = mesh(
      new THREE.BoxGeometry(0.1 + r() * 0.08, 0.015, 0.1 + r() * 0.06),
      mat(0x3a4a28, { rough: 0.95, lockColor: true }),
      (r() - 0.5) * 0.7,
      0.04,
      (r() - 0.5) * 0.7,
      { lockColor: true },
    )
    g.add(litter)
  }

  const count = 5 + Math.floor(r() * 4)
  for (let i = 0; i < count; i++) {
    const tree = new THREE.Group()
    const trunkH = 0.16 + r() * 0.2
    const trunk = mesh(
      new THREE.CylinderGeometry(0.02 + r() * 0.015, 0.03 + r() * 0.015, trunkH, 6),
      mat(0x5c3a1e, { rough: 0.85, lockColor: true }),
      0,
      trunkH / 2,
      0,
      { lockColor: true },
    )
    tree.add(trunk)

    const species = r()
    if (species < 0.55) {
      // Pine
      for (let layer = 0; layer < 3; layer++) {
        const canopy = mesh(
          new THREE.ConeGeometry(0.14 - layer * 0.03 + r() * 0.03, 0.2 + r() * 0.08, 7),
          mat(0x1e5a2e + Math.floor(r() * 0x001800), { rough: 0.75, lockColor: true }),
          0,
          trunkH + 0.08 + layer * 0.12,
          0,
          { lockColor: true },
        )
        tree.add(canopy)
      }
    } else if (species < 0.85) {
      // Broadleaf
      const canopy = mesh(
        new THREE.SphereGeometry(0.14 + r() * 0.06, 8, 6),
        mat(0x2d7a3a + Math.floor(r() * 0x001a00), { rough: 0.7, lockColor: true }),
        0,
        trunkH + 0.12,
        0,
        { lockColor: true },
      )
      tree.add(canopy)
      const canopy2 = mesh(
        new THREE.SphereGeometry(0.1 + r() * 0.04, 7, 5),
        mat(0x3d8a4a, { rough: 0.7, lockColor: true }),
        0.05,
        trunkH + 0.18,
        -0.04,
        { lockColor: true },
      )
      tree.add(canopy2)
    } else {
      // Birch-ish thin
      const canopy = mesh(
        new THREE.SphereGeometry(0.11, 7, 5),
        mat(0x5aaa5a, { rough: 0.65, lockColor: true }),
        0,
        trunkH + 0.1,
        0,
        { lockColor: true },
      )
      tree.add(canopy)
      // pale bark stripe
      const bark = mesh(
        new THREE.BoxGeometry(0.025, trunkH * 0.7, 0.01),
        mat(0xe8e0d0, { rough: 0.8, lockColor: true }),
        0.025,
        trunkH * 0.4,
        0,
        { lockColor: true },
      )
      tree.add(bark)
    }

    tree.position.set((r() - 0.5) * 0.72, 0, (r() - 0.5) * 0.72)
    tree.rotation.y = r() * Math.PI * 2
    g.add(tree)
  }

  // Fallen log
  if (r() > 0.45) {
    const log = mesh(
      new THREE.CylinderGeometry(0.03, 0.035, 0.28, 6),
      mat(0x4a3020, { rough: 0.9, lockColor: true }),
      (r() - 0.5) * 0.3,
      0.05,
      (r() - 0.5) * 0.3,
      { lockColor: true },
    )
    log.rotation.z = Math.PI / 2
    log.rotation.y = r() * 1.5
    g.add(log)
  }

  // Mushroom cluster
  if (r() > 0.6) {
    for (let i = 0; i < 3; i++) {
      const stem = mesh(
        new THREE.CylinderGeometry(0.01, 0.012, 0.04, 5),
        mat(0xeee8d8, { lockColor: true }),
        0.2 + i * 0.04,
        0.05,
        0.15,
        { lockColor: true },
      )
      g.add(stem)
      const cap = mesh(
        new THREE.SphereGeometry(0.025, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2),
        mat(0xcc4433, { lockColor: true }),
        0.2 + i * 0.04,
        0.07,
        0.15,
        { lockColor: true },
      )
      g.add(cap)
    }
  }
  return g
}

function kitHouse(g: THREE.Group, w: number, r: () => number) {
  // Yard
  const ground = mesh(
    new THREE.BoxGeometry(w, 0.04, w),
    mat(0x3a4a38, { rough: 0.9, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(ground)
  // Driveway strip
  const drive = mesh(
    new THREE.BoxGeometry(0.18, 0.025, w * 0.45),
    mat(0x4a4e58, { rough: 0.85, lockColor: true }),
    -0.32,
    0.035,
    0.15,
    { lockColor: true },
  )
  g.add(drive)

  const style = Math.floor(r() * 3)
  const houses = style === 0 ? 1 : style === 1 ? 2 : 3
  const wallColors = [0xd4c4a8, 0xc8b8a0, 0xe8dcc8, 0xb0a090, 0xd0c8c0, 0xa8b8c8]
  const roofColors = [0x8b3a2a, 0x4a5566, 0x5a4030, 0x2a3a4a, 0x6b4423]

  for (let i = 0; i < houses; i++) {
    const bw = 0.26 + r() * 0.1
    const bd = 0.22 + r() * 0.08
    const bh = 0.18 + r() * 0.12
    const wallCol = wallColors[Math.floor(r() * wallColors.length)]!
    const roofCol = roofColors[Math.floor(r() * roofColors.length)]!
    const wall = mat(wallCol, { rough: 0.8, lockColor: true })
    const ox = houses === 1 ? 0 : -0.28 + i * 0.3 + (r() - 0.5) * 0.04
    const oz = (r() - 0.5) * 0.12

    const body = mesh(new THREE.BoxGeometry(bw, bh, bd), wall, ox, bh / 2 + 0.04, oz, {
      lockColor: true,
    })
    g.add(body)

    // Foundation
    const found = mesh(
      new THREE.BoxGeometry(bw * 1.05, 0.04, bd * 1.05),
      mat(0x5a5e68, { rough: 0.9, lockColor: true }),
      ox,
      0.04,
      oz,
      { lockColor: true },
    )
    g.add(found)

    // Pitched roof (two slabs + ridge)
    const roofMat = mat(roofCol, { rough: 0.65, lockColor: true })
    const roofL = mesh(
      new THREE.BoxGeometry(bw * 1.12, 0.035, bd * 0.72),
      roofMat,
      ox,
      bh + 0.1,
      oz - bd * 0.14,
      { lockColor: true },
    )
    roofL.rotation.x = 0.5
    g.add(roofL)
    const roofR = mesh(
      new THREE.BoxGeometry(bw * 1.12, 0.035, bd * 0.72),
      roofMat,
      ox,
      bh + 0.1,
      oz + bd * 0.14,
      { lockColor: true },
    )
    roofR.rotation.x = -0.5
    g.add(roofR)

    // Chimney
    if (r() > 0.4) {
      const chim = mesh(
        new THREE.BoxGeometry(0.05, 0.12, 0.05),
        mat(0x6a5040, { rough: 0.8, lockColor: true }),
        ox + bw * 0.25,
        bh + 0.18,
        oz,
        { lockColor: true },
      )
      g.add(chim)
    }

    // Door
    const door = mesh(
      new THREE.BoxGeometry(0.055, 0.1, 0.02),
      mat(0x4a3020, { rough: 0.7, lockColor: true }),
      ox - bw * 0.1,
      0.09,
      oz + bd / 2 + 0.01,
      { lockColor: true },
    )
    g.add(door)

    // Windows with glow
    for (const side of [-1, 1] as const) {
      const lit = r() > 0.3
      const win = mesh(
        new THREE.BoxGeometry(0.07, 0.055, 0.015),
        mat(lit ? 0xffeebb : 0x6688aa, {
          emissive: lit ? 0xaa8844 : 0x000000,
          emInt: lit ? 0.5 : 0,
          rough: 0.25,
          lockColor: true,
        }),
        ox + side * bw * 0.22,
        bh * 0.55 + 0.04,
        oz + bd / 2 + 0.01,
        { lockColor: true },
      )
      g.add(win)
    }

    // Porch roof
    if (houses <= 2 && r() > 0.5) {
      const porch = mesh(
        new THREE.BoxGeometry(bw * 0.5, 0.02, 0.1),
        mat(roofCol, { rough: 0.7, lockColor: true }),
        ox,
        bh * 0.55,
        oz + bd / 2 + 0.05,
        { lockColor: true },
      )
      g.add(porch)
    }

    // Hedge / bush
    if (r() > 0.45) {
      const bush = mesh(
        new THREE.SphereGeometry(0.06 + r() * 0.03, 6, 5),
        mat(0x2d6a3a, { rough: 0.85, lockColor: true }),
        ox + bw * 0.45,
        0.08,
        oz + bd * 0.4,
        { lockColor: true },
      )
      g.add(bush)
    }
  }

  // Mailbox
  if (r() > 0.5) {
    const post = mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.14, 5),
      mat(0x555555, { metal: 0.4, lockColor: true }),
      -0.38,
      0.09,
      0.35,
      { lockColor: true },
    )
    g.add(post)
    const box = mesh(
      new THREE.BoxGeometry(0.06, 0.04, 0.04),
      mat(0x3366aa, { metal: 0.3, lockColor: true }),
      -0.38,
      0.17,
      0.35,
      { lockColor: true },
    )
    g.add(box)
  }

  // Car sometimes
  if (r() > 0.55) {
    const car = mesh(
      new THREE.BoxGeometry(0.14, 0.06, 0.08),
      mat([0x3366cc, 0xcc3333, 0xeeeeee, 0x222222][Math.floor(r() * 4)]!, {
        metal: 0.5,
        rough: 0.35,
        lockColor: true,
      }),
      -0.32,
      0.07,
      0.28,
      { lockColor: true },
    )
    g.add(car)
    const cabin = mesh(
      new THREE.BoxGeometry(0.08, 0.04, 0.07),
      mat(0x88aacc, { metal: 0.4, lockColor: true }),
      -0.3,
      0.12,
      0.28,
      { lockColor: true },
    )
    g.add(cabin)
  }
  return g
}

/**
 * Road auto-tile: asphalt extends fully to edges with road neighbors
 * so corridors read as continuous streets.
 */
function kitRoad(
  g: THREE.Group,
  w: number,
  r: () => number,
  n: Neighbors,
  tileX: number,
  tileY: number,
) {
  // Grass shoulders
  g.add(
    mesh(
      new THREE.BoxGeometry(w, 0.03, w),
      mat(0x3a5a32, { rough: 0.95, lockColor: true }),
      0,
      0.015,
      0,
      { lockColor: true },
    ),
  )

  let { n: cn, e: ce, s: cs, w: cw } = n
  // Dead-end / isolated: still draw a short segment
  if (n.count === 0) {
    cn = true
    cs = true
  }

  const roadH = 0.05
  const halfLane = w * 0.22 // half width of carriageway

  // Extent toward each side: full half-tile if connected, else stop short (curb)
  const extN = cn ? w * 0.5 : halfLane
  const extS = cs ? w * 0.5 : halfLane
  const extE = ce ? w * 0.5 : halfLane
  const extW = cw ? w * 0.5 : halfLane

  // NS carriageway
  if (cn || cs) {
    const depth = extN + extS
    const z = (extS - extN) / 2
    g.add(
      mesh(
        new THREE.BoxGeometry(halfLane * 2, roadH, depth),
        mat(0x2c2e36, { rough: 0.82, lockColor: true }),
        0,
        0.03,
        z,
        { lockColor: true },
      ),
    )
  }
  // EW carriageway
  if (ce || cw) {
    const width = extE + extW
    const x = (extE - extW) / 2
    g.add(
      mesh(
        new THREE.BoxGeometry(width, roadH, halfLane * 2),
        mat(0x2c2e36, { rough: 0.82, lockColor: true }),
        x,
        0.03,
        0,
        { lockColor: true },
      ),
    )
  }
  // Intersection cap
  if ((cn || cs) && (ce || cw)) {
    g.add(
      mesh(
        new THREE.BoxGeometry(halfLane * 2.05, roadH + 0.004, halfLane * 2.05),
        mat(0x262830, { rough: 0.82, lockColor: true }),
        0,
        0.032,
        0,
        { lockColor: true },
      ),
    )
  }

  // Lane dashes
  const horizPrimary = (ce || cw) && !cn && !cs
  for (let i = -1; i <= 1; i++) {
    g.add(
      mesh(
        new THREE.BoxGeometry(horizPrimary ? 0.14 : 0.028, 0.012, horizPrimary ? 0.028 : 0.14),
        mat(0xddcc66, { rough: 0.5, emissive: 0x443300, emInt: 0.14, lockColor: true }),
        horizPrimary ? i * 0.26 : 0,
        0.058,
        horizPrimary ? 0 : i * 0.26,
        { lockColor: true },
      ),
    )
  }

  // Cars on connected roads
  if (n.count >= 1 && r() > 0.42) {
    const carCol = [0x3366cc, 0xcc3333, 0xeeeeee, 0x222222, 0xffaa22][Math.floor(r() * 5)]!
    const alongX = (ce || cw) && (!(cn || cs) || r() > 0.45)
    const car = mesh(
      new THREE.BoxGeometry(alongX ? 0.22 : 0.11, 0.07, alongX ? 0.11 : 0.22),
      mat(carCol, { metal: 0.45, rough: 0.35, lockColor: true }),
      0,
      0.09,
      0,
      { lockColor: true },
    )
    car.userData.traffic = true
    car.userData.trafficAxis = alongX ? 'x' : 'z'
    car.userData.trafficPhase = r() * Math.PI * 2
    car.userData.trafficSpeed = 0.4 + r() * 0.45
    g.add(car)
    const cabin = mesh(
      new THREE.BoxGeometry(alongX ? 0.1 : 0.08, 0.05, alongX ? 0.08 : 0.1),
      mat(0x88aacc, { metal: 0.4, lockColor: true }),
      0,
      0.14,
      0,
      { lockColor: true },
    )
    cabin.userData.traffic = true
    g.add(cabin)
  }

  if (r() > 0.62 || (tileX + tileY) % 4 === 0) {
    const lx = !ce ? halfLane + 0.12 : -(halfLane + 0.12)
    const lz = !cs ? halfLane + 0.12 : -(halfLane + 0.12)
    g.add(
      mesh(
        new THREE.CylinderGeometry(0.015, 0.02, 0.38, 6),
        mat(0x666a72, { metal: 0.55, lockColor: true }),
        lx,
        0.21,
        lz,
        { lockColor: true },
      ),
    )
    g.add(
      mesh(
        new THREE.SphereGeometry(0.035, 6, 5),
        mat(0xffeebb, { emissive: 0xffcc44, emInt: 0.45, lockColor: true }),
        lx,
        0.42,
        lz,
        { lockColor: true },
      ),
    )
  }
  return g
}

function kitPark(g: THREE.Group, w: number, r: () => number) {
  const grass = mesh(
    new THREE.BoxGeometry(w, 0.05, w),
    mat(0x2d5a32, { rough: 0.95, lockColor: true }),
    0,
    0.025,
    0,
    { lockColor: true },
  )
  g.add(grass)

  // Lighter grass patches
  for (let i = 0; i < 3; i++) {
    const patch = mesh(
      new THREE.BoxGeometry(0.2 + r() * 0.15, 0.02, 0.15 + r() * 0.1),
      mat(0x3d7a42, { rough: 0.95, lockColor: true }),
      (r() - 0.5) * 0.5,
      0.04,
      (r() - 0.5) * 0.5,
      { lockColor: true },
    )
    g.add(patch)
  }

  // Winding path
  const path = mesh(
    new THREE.BoxGeometry(w * 0.18, 0.02, w * 0.85),
    mat(0x8a7a60, { rough: 0.85, lockColor: true }),
    0.08,
    0.04,
    0,
    { lockColor: true },
  )
  path.rotation.y = 0.25 + r() * 0.2
  g.add(path)

  // Bench
  const seat = mesh(
    new THREE.BoxGeometry(0.28, 0.03, 0.08),
    mat(0x6a4a2a, { rough: 0.7, lockColor: true }),
    -0.25,
    0.1,
    0.2,
    { lockColor: true },
  )
  g.add(seat)
  const back = mesh(
    new THREE.BoxGeometry(0.28, 0.08, 0.02),
    mat(0x5a3a1a, { rough: 0.7, lockColor: true }),
    -0.25,
    0.14,
    0.16,
    { lockColor: true },
  )
  g.add(back)
  for (const sx of [-0.1, 0.1] as const) {
    const leg = mesh(
      new THREE.BoxGeometry(0.02, 0.08, 0.06),
      mat(0x444444, { metal: 0.4, lockColor: true }),
      -0.25 + sx,
      0.05,
      0.2,
      { lockColor: true },
    )
    g.add(leg)
  }

  // Shade tree
  const trunk = mesh(
    new THREE.CylinderGeometry(0.03, 0.04, 0.22, 6),
    mat(0x5c3a1e, { lockColor: true }),
    0.25,
    0.13,
    -0.2,
    { lockColor: true },
  )
  g.add(trunk)
  const canopy = mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    mat(0x3d8a4a, { rough: 0.75, lockColor: true }),
    0.25,
    0.32,
    -0.2,
    { lockColor: true },
  )
  g.add(canopy)
  const canopy2 = mesh(
    new THREE.SphereGeometry(0.12, 7, 5),
    mat(0x4d9a5a, { rough: 0.7, lockColor: true }),
    0.32,
    0.36,
    -0.15,
    { lockColor: true },
  )
  g.add(canopy2)

  // Fountain
  if (r() > 0.4) {
    const basin = mesh(
      new THREE.CylinderGeometry(0.1, 0.12, 0.05, 12),
      mat(0x8899aa, { metal: 0.4, lockColor: true }),
      -0.15,
      0.06,
      -0.25,
      { lockColor: true },
    )
    g.add(basin)
    const water = mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.02, 12),
      mat(0x4a9acc, {
        rough: 0.1,
        metal: 0.6,
        emissive: 0x225566,
        emInt: 0.2,
        lockColor: true,
      }),
      -0.15,
      0.09,
      -0.25,
      { lockColor: true, water: true },
    )
    water.userData.water = true
    g.add(water)
    const spout = mesh(
      new THREE.CylinderGeometry(0.015, 0.02, 0.12, 6),
      mat(0xaaaaaa, { metal: 0.7, lockColor: true }),
      -0.15,
      0.14,
      -0.25,
      { lockColor: true },
    )
    g.add(spout)
  }

  // Flowers
  for (let i = 0; i < 6; i++) {
    const flower = mesh(
      new THREE.SphereGeometry(0.022, 6, 4),
      mat([0xff6688, 0xffcc44, 0x88aaff, 0xff88cc, 0xffffff, 0xffaa66][i]!, {
        emissive: 0x221111,
        emInt: 0.12,
        lockColor: true,
      }),
      (r() - 0.5) * 0.55,
      0.06,
      (r() - 0.5) * 0.55,
      { lockColor: true },
    )
    g.add(flower)
  }

  // Picnic table
  if (r() > 0.55) {
    const table = mesh(
      new THREE.BoxGeometry(0.2, 0.03, 0.12),
      mat(0x7a5a3a, { rough: 0.7, lockColor: true }),
      0.28,
      0.1,
      0.28,
      { lockColor: true },
    )
    g.add(table)
  }
  return g
}

function kitWarehouse(g: THREE.Group, w: number, h: number, color: number, r: () => number) {
  const bodyH = Math.max(0.28, h * 0.55)
  const c = color || 0x6a7080

  const pad = mesh(
    new THREE.BoxGeometry(w, 0.04, w),
    mat(0x3a3e48, { rough: 0.9, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(pad)

  const body = mesh(
    new THREE.BoxGeometry(w * 0.9, bodyH, w * 0.7),
    mat(c, { rough: 0.55, metal: 0.35 }),
    0,
    bodyH / 2,
    0,
  )
  g.add(body)

  // Corrugated roof
  const roof = mesh(
    new THREE.BoxGeometry(w * 0.98, 0.05, w * 0.78),
    mat(0x4a5566, { metal: 0.6, rough: 0.4, lockColor: true }),
    0,
    bodyH + 0.04,
    0,
    { lockColor: true },
  )
  roof.rotation.x = 0.08
  g.add(roof)

  // Roof ridge vents
  for (let i = 0; i < 3; i++) {
    const vent = mesh(
      new THREE.BoxGeometry(0.08, 0.04, 0.12),
      mat(0x3a404c, { metal: 0.5, lockColor: true }),
      -0.2 + i * 0.2,
      bodyH + 0.1,
      0,
      { lockColor: true },
    )
    g.add(vent)
  }

  // Loading bays
  for (const bx of [-0.22, 0.12] as const) {
    const bay = mesh(
      new THREE.BoxGeometry(0.2, 0.18, 0.04),
      mat(0x1a1e28, { rough: 0.6, lockColor: true }),
      bx,
      0.12,
      w * 0.36,
      { lockColor: true },
    )
    g.add(bay)
    // Bay bumper
    const bump = mesh(
      new THREE.BoxGeometry(0.2, 0.03, 0.03),
      mat(0xffcc00, { rough: 0.5, lockColor: true }),
      bx,
      0.03,
      w * 0.38,
      { lockColor: true },
    )
    g.add(bump)
  }

  // Office annex
  const office = mesh(
    new THREE.BoxGeometry(0.25, bodyH * 0.55, 0.22),
    mat(lighten(c, 0.15), { metal: 0.25, lockColor: true }),
    w * 0.32,
    bodyH * 0.28,
    -w * 0.2,
    { lockColor: true },
  )
  g.add(office)
  const win = mesh(
    new THREE.BoxGeometry(0.12, 0.06, 0.02),
    mat(0x88ccff, { emissive: 0x224466, emInt: 0.25, lockColor: true }),
    w * 0.32,
    bodyH * 0.35,
    -w * 0.2 + 0.12,
    { lockColor: true },
  )
  g.add(win)

  // Shipping container stack
  if (r() > 0.35) {
    const contColors = [0x2266aa, 0xcc4422, 0x228844]
    for (let i = 0; i < 2; i++) {
      const cont = mesh(
        new THREE.BoxGeometry(0.22, 0.1, 0.12),
        mat(contColors[i % 3]!, { metal: 0.45, rough: 0.5, lockColor: true }),
        -w * 0.35,
        0.08 + i * 0.11,
        -w * 0.28,
        { lockColor: true },
      )
      g.add(cont)
    }
  }

  // Forklift silhouette
  if (r() > 0.5) {
    const lift = mesh(
      new THREE.BoxGeometry(0.1, 0.06, 0.08),
      mat(0xffaa22, { metal: 0.4, lockColor: true }),
      0.3,
      0.06,
      w * 0.3,
      { lockColor: true },
    )
    g.add(lift)
  }
  return g
}

function kitCooling(g: THREE.Group, w: number, h: number, color: number) {
  const pad = mesh(
    new THREE.BoxGeometry(w * 0.9, 0.04, w * 0.9),
    mat(0x2a3040, { rough: 0.9, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(pad)
  for (let i = 0; i < 3; i++) {
    const tower = mesh(
      new THREE.CylinderGeometry(0.12, 0.16, h * 0.9 + 0.15, 12),
      mat(color || 0x7a8a9a, { rough: 0.55, metal: 0.35 }),
      -0.28 + i * 0.28,
      (h * 0.9 + 0.15) / 2,
      0,
    )
    g.add(tower)
    const fan = mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.04, 10),
      mat(0x334455, { metal: 0.6, lockColor: true }),
      -0.28 + i * 0.28,
      h * 0.9 + 0.18,
      0,
      { lockColor: true },
    )
    g.add(fan)
  }
  const pipe = mesh(
    new THREE.BoxGeometry(0.7, 0.05, 0.05),
    mat(0x6688aa, { metal: 0.5, lockColor: true }),
    0,
    0.12,
    0.28,
    { lockColor: true },
  )
  g.add(pipe)
  return g
}

function kitBattery(g: THREE.Group, w: number, h: number, color: number) {
  const pad = mesh(
    new THREE.BoxGeometry(w, 0.04, w),
    mat(0x1e2430, { rough: 0.9, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(pad)
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const cell = mesh(
        new THREE.BoxGeometry(0.22, 0.18 + h * 0.15, 0.28),
        mat(color || 0x3dffc0, { metal: 0.4, rough: 0.4 }),
        -0.28 + col * 0.28,
        0.12 + h * 0.08,
        -0.18 + row * 0.36,
      )
      g.add(cell)
      const led = mesh(
        new THREE.BoxGeometry(0.06, 0.02, 0.02),
        mat(0x44ff88, { emissive: 0x22aa44, emInt: 0.5, lockColor: true }),
        -0.28 + col * 0.28,
        0.2 + h * 0.08,
        -0.18 + row * 0.36 + 0.15,
        { lockColor: true },
      )
      g.add(led)
    }
  }
  const inverter = mesh(
    new THREE.BoxGeometry(0.2, 0.16, 0.14),
    mat(0x4a5566, { metal: 0.5, lockColor: true }),
    0.35,
    0.1,
    0.3,
    { lockColor: true },
  )
  g.add(inverter)
  return g
}

function kitOffice(g: THREE.Group, w: number, h: number, color: number, r: () => number) {
  const plaza = mesh(
    new THREE.BoxGeometry(w, 0.05, w),
    mat(0x2a2e38, { rough: 0.85, lockColor: true }),
    0,
    0.025,
    0,
    { lockColor: true },
  )
  g.add(plaza)
  const bodyH = Math.max(0.35, h * 0.7)
  const body = mesh(
    new THREE.BoxGeometry(w * 0.7, bodyH, w * 0.55),
    mat(color || 0xc8d0dc, { rough: 0.4, metal: 0.2 }),
    0,
    bodyH / 2,
    0,
  )
  g.add(body)
  // Glass curtain
  for (let f = 0; f < 3; f++) {
    const glass = mesh(
      new THREE.BoxGeometry(w * 0.55, 0.06, 0.02),
      mat(0x88ccee, {
        metal: 0.5,
        rough: 0.15,
        emissive: 0x224455,
        emInt: 0.2 + r() * 0.15,
        lockColor: true,
      }),
      0,
      0.12 + f * 0.12,
      w * 0.28,
      { lockColor: true },
    )
    g.add(glass)
  }
  const roof = mesh(
    new THREE.BoxGeometry(w * 0.75, 0.04, w * 0.6),
    mat(0x4a5566, { metal: 0.4, lockColor: true }),
    0,
    bodyH + 0.03,
    0,
    { lockColor: true },
  )
  g.add(roof)
  // Sign
  const sign = mesh(
    new THREE.BoxGeometry(0.2, 0.06, 0.02),
    mat(0x3dffc0, { emissive: 0x0a3d2e, emInt: 0.35, lockColor: true }),
    0,
    bodyH * 0.7,
    w * 0.29,
    { lockColor: true },
  )
  g.add(sign)
  return g
}

function kitLab(g: THREE.Group, w: number, h: number, color: number) {
  const pad = mesh(
    new THREE.BoxGeometry(w, 0.04, w),
    mat(0x243040, { rough: 0.9, lockColor: true }),
    0,
    0.02,
    0,
    { lockColor: true },
  )
  g.add(pad)
  const bodyH = Math.max(0.28, h * 0.55)
  const body = mesh(
    new THREE.BoxGeometry(w * 0.85, bodyH, w * 0.7),
    mat(color || 0x6a90b8, { metal: 0.35, rough: 0.4 }),
    0,
    bodyH / 2,
    0,
  )
  g.add(body)
  const dome = mesh(
    new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    mat(0xaaccff, {
      metal: 0.3,
      rough: 0.2,
      emissive: 0x335577,
      emInt: 0.35,
      lockColor: true,
    }),
    0.15,
    bodyH,
    -0.1,
    { lockColor: true },
  )
  g.add(dome)
  // Antenna array
  for (let i = 0; i < 3; i++) {
    const ant = mesh(
      new THREE.CylinderGeometry(0.01, 0.015, 0.2, 5),
      mat(0xcccccc, { metal: 0.7, lockColor: true }),
      -0.2 + i * 0.12,
      bodyH + 0.12,
      0.15,
      { lockColor: true },
    )
    g.add(ant)
  }
  const door = mesh(
    new THREE.BoxGeometry(0.12, 0.14, 0.03),
    mat(0x1a2030, { lockColor: true }),
    0,
    0.1,
    w * 0.36,
    { lockColor: true },
  )
  g.add(door)
  return g
}

export const BUILDING_KIT_KINDS = [
  'dc',
  'dc_m',
  'dc_l',
  'substation',
  'solar',
  'gas',
  'nuclear',
  'fab',
  'city',
  'lake',
  'forest',
  'house',
  'road',
  'park',
  'warehouse',
  'cooling',
  'battery',
  'office',
  'hq',
  'hq_m',
  'hq_l',
  'lab',
] as const
