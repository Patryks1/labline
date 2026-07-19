/**
 * Lightweight ECS-style tile render world.
 *
 * Entities = map tiles (x,y)
 * Components: kind, owner, color, lod, render path (instance | kit)
 *
 * Bulk terrain (grass/road/lake/forest/house/city/park) is GPU-instanced.
 * Detailed procedural kits only for owned buildings (and optional near-zoom scenic).
 * Streaming radius is deliberately larger than the ortho frustum so pop-in
 * happens outside the camera viewport.
 */
import * as THREE from 'three'
import type { MapTile, RivalLab, TileKind } from '../../sim/types'
import { isScenicKind } from '../../sim/systems/map'
import { createBuildingKit, type KitDetail } from './buildingKits'
import { connectsAs, type Neighbors } from './tileNeighbors'

export const TILE = 1.05

/** How far outside the visible frustum we keep / stream instances (tiles). */
export const STREAM_PAD = 14
/** Extra hide-margin beyond stream so culling is never on-screen. */
export const HIDE_PAD = 10
/** Camera must move this many tiles before restream. */
export const CULL_STEP = 4
/** Max detailed Object3D kits (player/rival + scenic while high zoom). */
export const MAX_KITS = 1800
/**
 * Instance capacity per legacy global pool.
 *
 * The widest supported legacy viewport can retain roughly 28k cells. Keep
 * enough headroom to avoid silently dropping homogeneous terrain while the
 * chunked renderer is being brought online.
 */
export const MAX_INSTANCES = 32768
/** New kit creates per frame. */
export const KIT_BUDGET = 48

/** Match GameMap wheel clamp — max zoom in / out. */
export const ZOOM_IN = 5
export const ZOOM_OUT = 30

const DIRS = [
  { k: 'n' as const, dx: 0, dy: -1, bit: 1 },
  { k: 'e' as const, dx: 1, dy: 0, bit: 2 },
  { k: 's' as const, dx: 0, dy: 1, bit: 4 },
  { k: 'w' as const, dx: -1, dy: 0, bit: 8 },
]

export type LodBand = 'near' | 'mid' | 'far'

/**
 * 1 = fully zoomed in, 0 = fully zoomed out.
 * Used so high LOD stays active for ≥50% of the zoom range.
 */
export function zoomInAmount(frustum: number): number {
  return Math.max(0, Math.min(1, (ZOOM_OUT - frustum) / (ZOOM_OUT - ZOOM_IN)))
}

/**
 * Zoom → LOD band.
 * - near (high kits): zoom-in ≥ 50%  (frustum ≤ 17.5)
 * - mid: zoom-in ≥ ~22%
 * - far: fully zoomed out — instancing dominates
 */
export function lodBandFromZoom(frustum: number): LodBand {
  const z = zoomInAmount(frustum)
  if (z >= 0.5) return 'near'
  if (z >= 0.22) return 'mid'
  return 'far'
}

/** Visible half-extent in tile units for current zoom + aspect. */
export function visibleHalfTiles(frustum: number, aspect: number): { hx: number; hz: number } {
  // Ortho covers ±frustum in Y (screen), ±frustum*aspect in X; isometric pad ~1.35
  const pad = 1.35
  return {
    hx: (frustum * Math.max(aspect, 1) * pad) / TILE,
    hz: (frustum * pad) / TILE,
  }
}

function sharedGeo<T extends THREE.BufferGeometry>(g: T): T {
  g.userData.shared = true
  return g
}

const GEO = {
  slab: sharedGeo(new THREE.BoxGeometry(TILE * 0.98, 0.05, TILE * 0.98)),
  lake: sharedGeo(new THREE.BoxGeometry(TILE * 0.98, 0.08, TILE * 0.98)),
  forest: sharedGeo(new THREE.BoxGeometry(TILE * 0.72, 0.38, TILE * 0.72)),
  house: sharedGeo(new THREE.BoxGeometry(TILE * 0.48, 0.3, TILE * 0.42)),
  city: sharedGeo(new THREE.BoxGeometry(TILE * 0.55, 0.58, TILE * 0.55)),
  block: sharedGeo(new THREE.BoxGeometry(TILE * 0.78, 0.42, TILE * 0.78)),
}

type PoolId =
  | 'empty'
  | 'park'
  | 'road'
  | 'lake'
  | 'forest'
  | 'house'
  | 'city'
  | 'warehouse'
  | 'building'

const POOL_COLORS: Record<PoolId, number> = {
  empty: 0x4a7a48,
  park: 0x3d6a40,
  road: 0x4a4e58,
  lake: 0x2a8aba,
  forest: 0x3d7a45,
  house: 0xd4c4a8,
  city: 0x7a6ba8,
  warehouse: 0x7a8090,
  building: 0x748898,
}

function poolForKind(kind: TileKind): PoolId | null {
  switch (kind) {
    case 'empty':
      return 'empty'
    case 'park':
      return 'park'
    case 'road':
      return 'road'
    case 'lake':
      return 'lake'
    case 'forest':
      return 'forest'
    case 'house':
      return 'house'
    case 'city':
      return 'city'
    case 'warehouse':
      return 'warehouse'
    case 'dc':
    case 'dc_m':
    case 'dc_l':
    case 'substation':
    case 'solar':
    case 'gas':
    case 'nuclear':
    case 'fab':
    case 'cooling':
    case 'battery':
    case 'office':
    case 'hq':
    case 'hq_m':
    case 'hq_l':
    case 'lab':
      return 'building'
    default:
      return 'empty'
  }
}

function isScenicKitKind(kind: TileKind): boolean {
  return (
    kind === 'city' ||
    kind === 'road' ||
    kind === 'lake' ||
    kind === 'house' ||
    kind === 'forest' ||
    kind === 'warehouse'
  )
}

/**
 * Whether this tile should get a detailed procedural kit at current LOD.
 * High LOD (full kits for scenic + buildings) holds through ≥50% zoom-in.
 * Grass/park always stay instanced (cheap, looks fine).
 */
function wantsKit(
  t: MapTile,
  band: LodBand,
  dist: number,
  nearR: number,
): boolean {
  if (t.kind === 'empty' || t.kind === 'park') return false

  const owned = t.owner === 'player' || (t.owner !== 'neutral' && t.owner !== 'player')
  if (owned) {
    // Owned facilities keep kits until deep zoom-out
    if (band === 'far') return dist < nearR * 0.75
    return true
  }

  if (!isScenicKitKind(t.kind)) return false

  // near = high LOD across (and slightly past) the visible disc
  if (band === 'near') return dist < nearR * 1.2
  // mid = still detailed in the main view
  if (band === 'mid') return dist < nearR * 0.95
  // far = only immediate foreground cities/roads
  return dist < nearR * 0.45 && (t.kind === 'city' || t.kind === 'road')
}

function detailForKit(band: LodBand, dist: number, nearR: number): KitDetail {
  if (band === 'near') return 'full'
  if (band === 'mid' && dist < nearR * 0.8) return 'full'
  return 'low'
}

export function colorForTile(
  t: MapTile,
  throttled: boolean,
  rivals: RivalLab[],
  rivalColors: Record<string, number>,
): number {
  if (t.owner === 'player') {
    // Ownership accent tint (kits use industrial shells + brand stripes from this).
    // Avoid pure neon on full massing — shellColor() in building kits desaturates bodies.
    switch (t.kind) {
      case 'dc':
        return throttled ? 0xff4d6a : 0x3dffc0
      case 'dc_m':
        return throttled ? 0xff6b4a : 0x2dd4a8
      case 'dc_l':
        return throttled ? 0xff3355 : 0x14b8a6
      case 'substation':
        return 0xa8c8c0
      case 'solar':
        return 0x3a6a9a
      case 'gas':
        return 0xb89a70
      case 'nuclear':
        return 0x8ab0a8
      case 'fab':
        return 0xd4c48a
      case 'cooling':
        return 0x6ab0d0
      case 'battery':
        return 0x7aaa60
      case 'office':
      case 'hq':
        return 0xc0c8d0
      case 'hq_m':
        return 0xb0b8c8
      case 'hq_l':
        return 0xa0a8bc
      case 'lab':
        return 0x7aa0d0
      default:
        return 0x3dffc0
    }
  }
  if (t.owner !== 'neutral' && t.owner !== 'player') {
    const rival = rivals.find((r) => r.id === t.owner)
    const base = rival?.color ?? rivalColors[t.owner] ?? 0xff8844
    if (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l') return base
    return darken(base, t.kind === 'substation' ? 0.35 : 0.2)
  }
  switch (t.kind) {
    case 'city':
      return 0x6b5b95
    case 'lake':
      return 0x1a6a9a
    case 'forest':
      return 0x2d6a3a
    case 'house':
      return 0xd4c4a8
    case 'road':
      return 0x2a2c32
    case 'park':
      return 0x2d5a32
    case 'warehouse':
      return 0x6a7080
    case 'empty':
      // Day-readable grass (was near-black under instance×material multiply)
      return t.regionId === 'void' ? 0x3a5a40 : 0x4a7a48
    default:
      return POOL_COLORS.building
  }
}

function darken(hex: number, amount: number): number {
  const r = (hex >> 16) & 0xff
  const g = (hex >> 8) & 0xff
  const b = hex & 0xff
  const f = 1 - amount
  return (Math.floor(r * f) << 16) | (Math.floor(g * f) << 8) | Math.floor(b * f)
}

/** Mix ownership tint into industrial base for live recolor. */
function mixShell(base: number, tint: number, amount = 0.22): number {
  const br = (base >> 16) & 0xff
  const bg = (base >> 8) & 0xff
  const bb = base & 0xff
  const tr = (tint >> 16) & 0xff
  const tg = (tint >> 8) & 0xff
  const tb = tint & 0xff
  const a = amount
  return (
    (Math.floor(br * (1 - a) + tr * a) << 16) |
    (Math.floor(bg * (1 - a) + tg * a) << 8) |
    Math.floor(bb * (1 - a) + tb * a)
  )
}

/** Sim construction ratio 0..1 (1 = complete / no construction). */
function buildRatio(t: MapTile): number {
  if (!t.buildingTarget || t.buildingTarget <= 0) return 1
  return Math.min(1, Math.max(0, t.buildingProgress / t.buildingTarget))
}

/**
 * Visual height factor — buildings grow from a foundation slab toward full height
 * as construction days complete (0.12 → 1.0).
 */
function visualBuildFactor(t: MapTile): number {
  const r = buildRatio(t)
  if (r >= 1) return 1
  return 0.12 + r * 0.88
}

function heightForTile(t: MapTile, buildFactor: number): number {
  // Full design height; construction growth applied via kit.scale.y (not baked in)
  const b = 1
  void buildFactor
  switch (t.kind) {
    case 'empty':
      return 0.06
    case 'lake':
      return 0.14
    case 'road':
      return 0.08
    case 'park':
      return 0.22
    case 'forest':
      return 0.48
    case 'house':
      return 0.36
    case 'warehouse':
      return 0.42
    case 'city':
      return 0.72
    case 'dc':
      return (0.36 + (t.racksUsed / Math.max(1, t.rackCapacity)) * 0.55) * b
    case 'dc_m':
      return (0.48 + (t.racksUsed / Math.max(1, t.rackCapacity || 288)) * 0.65) * b
    case 'dc_l':
      return (0.62 + (t.racksUsed / Math.max(1, t.rackCapacity || 960)) * 0.75) * b
    case 'fab':
    case 'nuclear':
      return 0.58 * b
    case 'gas':
    case 'substation':
      return 0.4 * b
    case 'solar':
      return 0.24 * b
    case 'cooling':
      return 0.42 * b
    case 'battery':
      return 0.32 * b
    case 'office':
    case 'hq':
      return 0.5 * b
    case 'hq_m':
      return 0.58 * b
    case 'hq_l':
      return 0.72 * b
    case 'lab':
      return 0.45 * b
    default:
      return 0.35 * b
  }
}

function neighborsFast(
  tiles: MapTile[],
  w: number,
  h: number,
  x: number,
  y: number,
  kind: TileKind,
): Neighbors {
  let mask = 0
  let count = 0
  const out: Neighbors = { n: false, e: false, s: false, w: false, mask: 0, count: 0 }
  for (const d of DIRS) {
    const nx = x + d.dx
    const ny = y + d.dy
    let other: TileKind | undefined
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
      other = tiles[ny * w + nx]?.kind
    }
    const ok = connectsAs(kind, other)
    out[d.k] = ok
    if (ok) {
      mask |= d.bit
      count++
    }
  }
  out.mask = mask
  out.count = count
  return out
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose()
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose())
      else (o.material as THREE.Material)?.dispose()
    }
  })
}

export function applyEmissive(
  mesh: THREE.Object3D,
  selected: boolean,
  emHex: number,
  emInt: number,
) {
  const highlight = selected || emInt > 0
  mesh.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !(o.material instanceof THREE.MeshStandardMaterial)) return
    // Never wash locked detail (glass, steel, fence) with ownership glow
    if (o.userData.lockColor || o.material.userData?.lockColor) {
      return
    }
    const mat = o.material
    if (o.userData._emSaved === undefined) {
      o.userData._emSaved = mat.emissive.getHex()
      o.userData._emIntSaved = mat.emissiveIntensity
    }
    if (highlight) {
      // Selection: soft mint wash, not full-bright green body
      if (selected) {
        mat.emissive.setHex(0x1a4a3a)
        mat.emissiveIntensity = Math.min(0.22, Math.max(emInt, 0.18))
      } else {
        mat.emissive.setHex(emHex)
        mat.emissiveIntensity = emInt
      }
    } else {
      mat.emissive.setHex(o.userData._emSaved as number)
      mat.emissiveIntensity = o.userData._emIntSaved as number
    }
  })
  mesh.userData.selected = selected
}

export function emissiveForTile(
  t: MapTile,
  selected: boolean,
  buildMode: boolean,
  throttled: boolean,
): { emHex: number; emInt: number } {
  if (selected) return { emHex: 0x1a4a3a, emInt: 0.2 }
  if (buildMode && t.kind === 'empty' && (t.owner === 'neutral' || t.owner === 'player')) {
    return { emHex: 0x14332a, emInt: 0.18 }
  }
  // Throttle only: soft red pulse on DCs — never constant green glow
  if (
    throttled &&
    t.owner === 'player' &&
    (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l')
  ) {
    return { emHex: 0xff4d6a, emInt: 0.35 }
  }
  return { emHex: 0x000000, emInt: 0 }
}

// ─── Instance pool ───────────────────────────────────────────────────────────

class InstancePool {
  mesh: THREE.InstancedMesh
  private readonly capacity: number
  /** entity key → instance index */
  private indexOf = new Map<string, number>()
  /** instance index → entity key */
  private keyOf: string[] = []
  private count = 0
  private readonly dummy = new THREE.Object3D()
  private readonly color = new THREE.Color()
  private readonly scratchMat = new THREE.Matrix4()
  private readonly scratchCol = new THREE.Color()
  private dirty = false
  private minDirty = Infinity
  private maxDirty = -1

  constructor(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    yLift: number,
  ) {
    this.capacity = capacity
    this.mesh = new THREE.InstancedMesh(geo, material, capacity)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false // we stream; GPU frustum would fight soft edge
    this.mesh.count = 0
    this.mesh.userData.yLift = yLift
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
  }

  has(key: string) {
    return this.indexOf.has(key)
  }

  size() {
    return this.count
  }

  set(
    key: string,
    x: number,
    y: number,
    hex: number,
    sx = 1,
    sy = 1,
    sz = 1,
  ): boolean {
    let idx = this.indexOf.get(key)
    if (idx === undefined) {
      if (this.count >= this.capacity) return false
      idx = this.count++
      this.indexOf.set(key, idx)
      this.keyOf[idx] = key
      this.mesh.count = this.count
    }
    const lift = (this.mesh.userData.yLift as number) || 0.025
    this.dummy.position.set(x * TILE, lift * Math.max(sy, 0.2), y * TILE)
    this.dummy.scale.set(sx, sy, sz)
    this.dummy.rotation.set(0, 0, 0)
    this.dummy.updateMatrix()
    this.mesh.setMatrixAt(idx, this.dummy.matrix)
    this.color.setHex(hex)
    this.mesh.setColorAt(idx, this.color)
    if (this.mesh.instanceColor?.usage !== THREE.DynamicDrawUsage) {
      this.mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage)
    }
    this.dirty = true
    this.minDirty = Math.min(this.minDirty, idx)
    this.maxDirty = Math.max(this.maxDirty, idx)
    return true
  }

  remove(key: string) {
    const idx = this.indexOf.get(key)
    if (idx === undefined) return
    const last = this.count - 1
    if (idx !== last) {
      const lastKey = this.keyOf[last]!
      this.mesh.getMatrixAt(last, this.scratchMat)
      this.mesh.setMatrixAt(idx, this.scratchMat)
      if (this.mesh.instanceColor) {
        this.mesh.getColorAt(last, this.scratchCol)
        this.mesh.setColorAt(idx, this.scratchCol)
      }
      this.keyOf[idx] = lastKey
      this.indexOf.set(lastKey, idx)
    }
    this.indexOf.delete(key)
    this.count--
    this.mesh.count = Math.max(0, this.count)
    this.dirty = true
    this.minDirty = Math.min(this.minDirty, idx)
    this.maxDirty = Math.max(this.maxDirty, Math.max(idx, last))
  }

  flush() {
    if (!this.dirty) return
    if (this.maxDirty >= this.minDirty) {
      const count = this.maxDirty - this.minDirty + 1
      this.mesh.instanceMatrix.addUpdateRange(this.minDirty * 16, count * 16)
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.addUpdateRange(this.minDirty * 3, count * 3)
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.dirty = false
    this.minDirty = Infinity
    this.maxDirty = -1
  }

  clear() {
    this.indexOf.clear()
    this.keyOf.length = 0
    this.count = 0
    this.mesh.count = 0
    this.dirty = true
    this.minDirty = 0
    this.maxDirty = Math.max(0, this.capacity - 1)
  }
}

// ─── Entity record ───────────────────────────────────────────────────────────

type RenderPath = 'instance' | 'kit' | 'none'

interface TileEntity {
  x: number
  y: number
  kind: TileKind
  owner: string
  mask: number
  color: number
  path: RenderPath
  pool: PoolId | null
  kit: THREE.Object3D | null
  selected: boolean
}

export type TileWorldOpts = {
  scene: THREE.Scene
  rivalColors: Record<string, number>
}

export class TileWorld {
  readonly scene: THREE.Scene
  readonly rivalColors: Record<string, number>
  readonly entities = new Map<string, TileEntity>()
  readonly kits = new Map<string, THREE.Object3D>()
  readonly rings = new Map<string, THREE.Mesh>()
  readonly animList: THREE.Object3D[] = []
  /** Construction day timers (sprites above under-construction buildings). */
  readonly buildTimers = new Map<string, THREE.Sprite>()

  private pools = new Map<PoolId, InstancePool>()
  private tiles: MapTile[] = []
  private mapW = 0
  private mapH = 0
  private rivals: RivalLab[] = []
  private pending: string[] = []
  private camTx = 0
  private camTz = 0
  private band: LodBand = 'mid'
  private streamR = 20
  private hideR = 30
  private nearR = 12
  private throttled = false
  private buildMode = false
  private selKey: string | null = null
  private timerTexCache = new Map<string, THREE.CanvasTexture>()

  constructor(opts: TileWorldOpts) {
    this.scene = opts.scene
    this.rivalColors = opts.rivalColors
    this.initPools()
  }

  private initPools() {
    // Base material MUST be white — InstancedMesh multiplies material.color × instanceColor.
    // A tinted base + tinted instances was crushing everything to near-black.
    const mkMat = (opts?: { rough?: number; metal?: number; em?: number; emInt?: number }) =>
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: opts?.rough ?? 0.75,
        metalness: opts?.metal ?? 0.08,
        emissive: opts?.em ?? 0x000000,
        emissiveIntensity: opts?.emInt ?? 0,
        envMapIntensity: 1,
      })

    const add = (
      id: PoolId,
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      yLift: number,
    ) => {
      const pool = new InstancePool(geo, mat, MAX_INSTANCES, yLift)
      this.scene.add(pool.mesh)
      this.pools.set(id, pool)
    }

    add('empty', GEO.slab, mkMat({ rough: 0.92 }), 0.025)
    add('park', GEO.slab, mkMat({ rough: 0.92 }), 0.025)
    add('road', GEO.slab, mkMat({ rough: 0.82 }), 0.028)
    add(
      'lake',
      GEO.lake,
      mkMat({ rough: 0.18, metal: 0.35, em: 0x1a4a6a, emInt: 0.12 }),
      0.04,
    )
    add('forest', GEO.forest, mkMat({ rough: 0.88 }), 0.2)
    add('house', GEO.house, mkMat({ rough: 0.65 }), 0.16)
    add('city', GEO.city, mkMat({ rough: 0.48, metal: 0.12 }), 0.3)
    add('warehouse', GEO.block, mkMat({ rough: 0.55, metal: 0.1 }), 0.22)
    add('building', GEO.block, mkMat({ rough: 0.42, metal: 0.2 }), 0.22)
  }

  setMap(tiles: MapTile[], w: number, h: number, rivals: RivalLab[]) {
    this.tiles = tiles
    this.mapW = w
    this.mapH = h
    this.rivals = rivals
  }

  setCamera(tx: number, tz: number, frustum: number, aspect: number) {
    this.camTx = tx
    this.camTz = tz
    this.band = lodBandFromZoom(frustum)
    const vis = visibleHalfTiles(frustum, aspect)
    // Stream well beyond visible viewport so edges never pop on-screen
    const visMax = Math.max(vis.hx, vis.hz)
    this.streamR = visMax + STREAM_PAD
    this.hideR = this.streamR + HIDE_PAD
    // Kit coverage radius — stay high through "near" (≤50% zoomed out)
    this.nearR =
      this.band === 'near' ? visMax * 1.05 : this.band === 'mid' ? visMax * 0.92 : visMax * 0.55
  }

  setGameplay(opts: {
    throttled: boolean
    buildMode: boolean
    selKey: string | null
  }) {
    this.throttled = opts.throttled
    this.buildMode = opts.buildMode
    this.selKey = opts.selKey
  }

  tileAt(x: number, y: number): MapTile | null {
    if (x < 0 || y < 0 || x >= this.mapW || y >= this.mapH) return null
    return this.tiles[y * this.mapW + x] ?? null
  }

  key(x: number, y: number) {
    return `${x},${y}`
  }

  /**
   * Main stream: ensure instances for stream window, hide far, queue kits.
   * Call when camera moves / zoom changes / map mutates.
   */
  stream() {
    if (!this.mapW) return
    const cx = this.camTx
    const cz = this.camTz
    const r = this.streamR
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(this.mapW - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cz - r))
    const y1 = Math.min(this.mapH - 1, Math.ceil(cz + r))

    const needed = new Set<string>()
    const kitQueue: string[] = []

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.tileAt(x, y)
        if (!t) continue
        const k = this.key(x, y)
        needed.add(k)
        const dist = Math.hypot(x - cx, y - cz)
        this.ensureEntity(t, dist, kitQueue)
      }
    }

    // Hide / drop outside hide radius (never on-screen)
    for (const [k, ent] of this.entities) {
      if (needed.has(k)) continue
      const d = Math.hypot(ent.x - cx, ent.y - cz)
      if (d > this.hideR) {
        this.releaseEntity(k)
      }
    }

    // Prefer kits nearest camera
    kitQueue.sort((a, b) => {
      const [ax, ay] = a.split(',').map(Number) as [number, number]
      const [bx, by] = b.split(',').map(Number) as [number, number]
      return Math.hypot(ax - cx, ay - cz) - Math.hypot(bx - cx, by - cz)
    })
    this.pending = kitQueue

    this.capKits()
    this.flushPools()
  }

  /** Drain kit create budget (call each frame). */
  pumpKits() {
    if (!this.pending.length) return
    let budget = KIT_BUDGET
    const cx = this.camTx
    const cz = this.camTz
    while (budget > 0 && this.pending.length) {
      const k = this.pending.shift()!
      const [xs, ys] = k.split(',')
      const x = Number(xs)
      const y = Number(ys)
      const t = this.tileAt(x, y)
      if (!t) continue
      const dist = Math.hypot(x - cx, y - cz)
      if (dist > this.streamR + 1) continue
      if (!wantsKit(t, this.band, dist, this.nearR)) continue
      // Already have matching kit?
      const ent = this.entities.get(k)
      const desiredDetail = detailForKit(this.band, dist, this.nearR)
      const desiredMask = neighborsFast(this.tiles, this.mapW, this.mapH, x, y, t.kind).mask
      if (
        ent?.kit &&
        ent.kind === t.kind &&
        ent.owner === t.owner &&
        ent.kit.userData.detail === desiredDetail &&
        ent.kit.userData.mask === desiredMask
      ) {
        continue
      }
      this.promoteToKit(t, dist)
      budget--
    }
    this.rebuildAnimList()
    this.flushPools()
  }

  /** After placeBuilding — force structure update for changed tiles. */
  syncStructure() {
    const cx = this.camTx
    const cz = this.camTz
    // Walk entities that diverged + any player buildings (in case entity was missing)
    const dirty: MapTile[] = []
    for (const [k, ent] of this.entities) {
      const t = this.tileAt(ent.x, ent.y)
      if (!t) continue
      if (ent.kind !== t.kind || ent.owner !== t.owner) dirty.push(t)
      void k
    }
    // Also pick up player facilities that might only exist in sim (safety net)
    for (const t of this.tiles) {
      if (t.owner !== 'player' || t.kind === 'empty') continue
      const ent = this.entities.get(this.key(t.x, t.y))
      if (!ent || ent.kind !== t.kind || ent.owner !== t.owner || !ent.kit) {
        if (!dirty.some((d) => d.x === t.x && d.y === t.y)) dirty.push(t)
      }
    }
    for (const t of dirty) {
      const k = this.key(t.x, t.y)
      const dist = Math.hypot(t.x - cx, t.y - cz)
      this.releaseEntity(k)
      this.ensureEntity(t, dist, this.pending)
      // Always promote owned buildings immediately (don't wait for budgeted pump)
      if (wantsKit(t, this.band, dist, this.nearR) || t.owner === 'player') {
        this.promoteToKit(t, dist)
      }
    }
    this.flushPools()
    this.rebuildAnimList()
  }

  applySelection(key: string | null) {
    const prev = this.selKey
    this.selKey = key
    if (prev && prev !== key) this.paintSelection(prev, false)
    if (key) this.paintSelection(key, true)
  }

  refreshBuildMode() {
    for (const [k, ent] of this.entities) {
      if (ent.kind !== 'empty' || ent.path !== 'kit' || !ent.kit) continue
      const t = this.tileAt(ent.x, ent.y)
      if (!t) continue
      const selected = this.selKey === k
      const { emHex, emInt } = emissiveForTile(t, selected, this.buildMode, false)
      applyEmissive(ent.kit, selected, emHex, emInt)
    }
  }

  lightSyncPlayer() {
    for (const ent of this.entities.values()) {
      if (ent.owner !== 'player') continue
      const t = this.tileAt(ent.x, ent.y)
      if (!t) continue
      const col = colorForTile(t, this.throttled && (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l'), this.rivals, this.rivalColors)
      const factor = visualBuildFactor(t)
      const ratio = buildRatio(t)
      if (ent.path === 'instance' && ent.pool) {
        this.placeInstance(ent, t, col)
      } else if (ent.kit) {
        // Grow construction scale each day from foundation → full
        if (!isScenicKind(t.kind)) {
          ent.kit.scale.set(1, ratio >= 1 ? 1 : factor, 1)
        }
        if (ent.color !== col) {
          ent.color = col
          ent.kit.traverse((o) => {
            if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
              if (o.userData.lockColor || o.material.userData?.lockColor) return
              // Brand / glow accents keep full ownership tint; massing stays industrial
              if (o.userData.brand || o.material.userData?.brand) {
                o.material.color.setHex(col)
                if (o.material.emissive) {
                  o.material.emissive.setHex(col)
                }
                return
              }
              // Soft re-tint only (body already industrial at kit create)
              const base = o.userData.shellBase as number | undefined
              if (base != null) {
                o.material.color.setHex(mixShell(base, col, 0.22))
              }
            }
          })
        }
        this.syncRing(ent, t)
      }
      const h = heightForTile(t, 1) * (ratio >= 1 ? 1 : factor)
      this.syncBuildTimer(t, h)
    }
    // Drop timers for tiles no longer under construction
    for (const k of [...this.buildTimers.keys()]) {
      const [xs, ys] = k.split(',')
      const t = this.tileAt(Number(xs), Number(ys))
      if (!t || t.buildingProgress >= t.buildingTarget || t.buildingTarget <= 0) {
        this.removeBuildTimer(k)
      }
    }
    this.flushPools()
  }

  dispose() {
    for (const kit of this.kits.values()) {
      this.scene.remove(kit)
      disposeObject(kit)
    }
    this.kits.clear()
    for (const ring of this.rings.values()) {
      this.scene.remove(ring)
      if (!ring.geometry.userData?.shared) ring.geometry.dispose()
      ;(ring.material as THREE.Material).dispose()
    }
    this.rings.clear()
    for (const k of [...this.buildTimers.keys()]) this.removeBuildTimer(k)
    for (const tex of this.timerTexCache.values()) tex.dispose()
    this.timerTexCache.clear()
    for (const pool of this.pools.values()) {
      this.scene.remove(pool.mesh)
      // shared geos — don't dispose geometry
      ;(pool.mesh.material as THREE.Material).dispose()
      pool.mesh.dispose()
    }
    this.pools.clear()
    this.entities.clear()
  }

  /** Sprite timer above under-construction player buildings (anchor only for multi-tile). */
  private syncBuildTimer(t: MapTile, height: number) {
    const k = this.key(t.x, t.y)
    const under =
      t.owner === 'player' &&
      t.buildingTarget > 0 &&
      t.buildingProgress < t.buildingTarget &&
      !isScenicKind(t.kind) &&
      // one timer per campus (anchor) or single-tile building
      t.campusRole !== 'pad'
    if (!under) {
      this.removeBuildTimer(k)
      return
    }
    const left = Math.max(0, t.buildingTarget - t.buildingProgress)
    const label = left <= 0 ? 'done' : `${left}d`
    let spr = this.buildTimers.get(k)
    if (!spr) {
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      spr = new THREE.Sprite(mat)
      spr.renderOrder = 20
      spr.scale.set(1.35, 0.48, 1)
      this.scene.add(spr)
      this.buildTimers.set(k, spr)
    }
    const mat = spr.material as THREE.SpriteMaterial
    if (spr.userData.timerLabel !== label) {
      const tex = this.timerTexture(label)
      if (mat.map && mat.map !== tex) {
        // don't dispose cached textures
      }
      mat.map = tex
      mat.needsUpdate = true
      spr.userData.timerLabel = label
    }
    const y = Math.max(0.55, height + 0.55)
    spr.position.set(t.x * TILE, y, t.y * TILE)
    spr.visible = true
  }

  private removeBuildTimer(k: string) {
    const spr = this.buildTimers.get(k)
    if (!spr) return
    this.scene.remove(spr)
    ;(spr.material as THREE.SpriteMaterial).dispose()
    this.buildTimers.delete(k)
  }

  private timerTexture(label: string): THREE.CanvasTexture {
    const hit = this.timerTexCache.get(label)
    if (hit) return hit
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 56
    const g = canvas.getContext('2d')!
    g.clearRect(0, 0, 160, 56)
    // pill
    g.fillStyle = 'rgba(14,16,22,0.88)'
    g.beginPath()
    g.roundRect(8, 8, 144, 40, 12)
    g.fill()
    g.strokeStyle = 'rgba(255, 196, 80, 0.75)'
    g.lineWidth = 2
    g.stroke()
    // clock glyph
    g.fillStyle = '#ffc450'
    g.font = '600 22px Geist, system-ui, sans-serif'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillText('⏱', 18, 28)
    g.fillStyle = '#eceae4'
    g.font = '700 22px Geist, system-ui, sans-serif'
    g.textAlign = 'center'
    g.fillText(label, 96, 30)
    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    this.timerTexCache.set(label, tex)
    return tex
  }

  // ── internals ────────────────────────────────────────────────────────────

  private ensureEntity(t: MapTile, dist: number, kitQueue: string[]) {
    const k = this.key(t.x, t.y)
    const col = colorForTile(
      t,
      this.throttled && t.owner === 'player' && (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l'),
      this.rivals,
      this.rivalColors,
    )
    const wantKit = wantsKit(t, this.band, dist, this.nearR)
    let ent = this.entities.get(k)

    if (!ent) {
      ent = {
        x: t.x,
        y: t.y,
        kind: t.kind,
        owner: t.owner,
        mask: 0,
        color: col,
        path: 'none',
        pool: null,
        kit: null,
        selected: false,
      }
      this.entities.set(k, ent)
    } else if (ent.kind !== t.kind || ent.owner !== t.owner) {
      // Structure changed
      this.clearRender(ent)
      ent.kind = t.kind
      ent.owner = t.owner
      ent.color = col
      ent.path = 'none'
      ent.pool = null
      ent.kit = null
    }

    if (wantKit) {
      if (ent.path === 'kit' && ent.kit) {
        const desiredDetail = detailForKit(this.band, dist, this.nearR)
        const desiredMask = neighborsFast(
          this.tiles,
          this.mapW,
          this.mapH,
          t.x,
          t.y,
          t.kind,
        ).mask
        if (
          ent.kit.userData.detail !== desiredDetail ||
          ent.kit.userData.mask !== desiredMask
        ) {
          // Keep the current representation visible until the replacement is
          // ready, but always queue the correct LOD/topology.
          kitQueue.push(k)
        }
      } else {
        // Instance stand-in until kit pumps
        this.placeInstance(ent, t, col)
        kitQueue.push(k)
      }
    } else {
      // Demote kit → instance when zoomed out / far
      if (ent.path === 'kit') {
        this.clearRender(ent)
        ent.path = 'none'
        ent.kit = null
      }
      this.placeInstance(ent, t, col)
    }
  }

  private placeInstance(ent: TileEntity, t: MapTile, col: number): boolean {
    const poolId = poolForKind(t.kind)
    if (!poolId) return false
    const pool = this.pools.get(poolId)
    if (!pool) return false

    // If was on another pool, remove
    if (ent.path === 'instance' && ent.pool && ent.pool !== poolId) {
      this.pools.get(ent.pool)?.remove(this.key(ent.x, ent.y))
    }
    // Hide kit if any
    if (ent.kit) {
      ent.kit.visible = false
    }

    const factor = visualBuildFactor(t)
    let sy = 1
    if (poolId === 'building' || poolId === 'city' || poolId === 'warehouse') {
      const h = heightForTile(t, 1)
      const base = Math.max(0.55, h / 0.42)
      // Grow from ground while under construction
      sy = Math.max(0.12, base * factor)
    }

    // Slight color variation for grass so mega-map isn't flat
    let hex = col
    if (poolId === 'empty') {
      const n = ((t.x * 73856093) ^ (t.y * 19349663)) >>> 0
      const v = (n % 24) - 12
      hex = shiftGreen(col, v)
    }

    // Player buildings: lift higher so they never sit under grass slabs
    const yBoost = poolId === 'building' && t.owner === 'player' ? 1.15 : 1
    const placed = pool.set(this.key(t.x, t.y), t.x, t.y, hex, 1, sy * yBoost, 1)
    if (!placed) return false
    ent.path = 'instance'
    ent.pool = poolId
    ent.color = col
    ent.kind = t.kind
    ent.owner = t.owner
    return true
  }

  private promoteToKit(t: MapTile, dist: number) {
    const k = this.key(t.x, t.y)
    let ent = this.entities.get(k)
    if (!ent) {
      ent = {
        x: t.x,
        y: t.y,
        kind: t.kind,
        owner: t.owner,
        mask: 0,
        color: 0,
        path: 'none',
        pool: null,
        kit: null,
        selected: false,
      }
      this.entities.set(k, ent)
    }

    // Cap kits
    if (this.kits.size >= MAX_KITS && !this.kits.has(k)) {
      this.evictFarthestKit()
      if (this.kits.size >= MAX_KITS) return
    }

    const col = colorForTile(
      t,
      this.throttled && t.owner === 'player' && (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l'),
      this.rivals,
      this.rivalColors,
    )
    const factor = visualBuildFactor(t)
    const ratio = buildRatio(t)
    const height = heightForTile(t, factor)
    const neigh = neighborsFast(this.tiles, this.mapW, this.mapH, t.x, t.y, t.kind)
    // full procedural kits for high/mid zoom; low only when far zoomed out
    const detail = detailForKit(this.band, dist, this.nearR)

    // Remove any instance stand-in (including leftover grass on that cell)
    if (ent.pool) {
      this.pools.get(ent.pool)?.remove(k)
      ent.pool = null
    }
    for (const p of this.pools.values()) {
      if (p.has(k)) p.remove(k)
    }
    if (ent.kit) {
      this.scene.remove(ent.kit)
      disposeObject(ent.kit)
      this.kits.delete(k)
    }

    const kit = createBuildingKit(t.kind, col, height, t.x, t.y, neigh, detail)
    kit.userData = {
      x: t.x,
      y: t.y,
      kind: t.kind,
      color: col,
      scenic: isScenicKind(t.kind),
      mask: neigh.mask,
      owner: t.owner,
      detail,
      selected: false,
    }
    kit.position.set(t.x * TILE, 0, t.y * TILE)
    // Grow from foundation up as days complete
    if (!isScenicKind(t.kind) && ratio < 1) kit.scale.set(1, factor, 1)
    else kit.scale.set(1, 1, 1)
    kit.visible = true
    this.scene.add(kit)
    this.kits.set(k, kit)
    this.syncBuildTimer(t, height * (ratio < 1 ? factor : 1))

    ent.kit = kit
    ent.path = 'kit'
    ent.kind = t.kind
    ent.owner = t.owner
    ent.mask = neigh.mask
    ent.color = col

    // Ownership ring
    this.syncRing(ent, t)

    const selected = this.selKey === k
    const { emHex, emInt } = emissiveForTile(
      t,
      selected,
      this.buildMode,
      this.throttled && t.owner === 'player' && (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l'),
    )
    applyEmissive(kit, selected, emHex, emInt)
  }

  private syncRing(ent: TileEntity, t: MapTile) {
    const k = this.key(t.x, t.y)
    const scenic = isScenicKind(t.kind)
    let ring = this.rings.get(k)
    if (!scenic && t.kind !== 'empty' && t.owner !== 'neutral') {
      if (!ring) {
        ring = new THREE.Mesh(
          new THREE.BoxGeometry(TILE * 0.98, 0.04, TILE * 0.98),
          new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.4,
            metalness: 0.3,
            emissive: 0x111111,
            emissiveIntensity: 0.3,
          }),
        )
        this.scene.add(ring)
        this.rings.set(k, ring)
      }
      ring.visible = true
      ring.position.set(t.x * TILE, 0.03, t.y * TILE)
      const mat = ring.material as THREE.MeshStandardMaterial
      if (t.owner === 'player') {
        mat.color.setHex(0x3dffc0)
        mat.emissive.setHex(0x0a3d2e)
      } else {
        mat.color.setHex(this.rivalColors[t.owner] ?? 0xff8844)
        mat.emissive.setHex(0x221100)
      }
    } else if (ring) {
      ring.visible = false
    }
    void ent
  }

  private paintSelection(key: string, selected: boolean) {
    const ent = this.entities.get(key)
    if (!ent?.kit) return
    const t = this.tileAt(ent.x, ent.y)
    if (!t) return
    const { emHex, emInt } = emissiveForTile(
      t,
      selected,
      this.buildMode,
      this.throttled && t.owner === 'player' && (t.kind === 'dc' || t.kind === 'dc_m' || t.kind === 'dc_l'),
    )
    applyEmissive(ent.kit, selected, emHex, emInt)
  }

  private clearRender(ent: TileEntity) {
    const k = this.key(ent.x, ent.y)
    if (ent.path === 'instance' && ent.pool) {
      this.pools.get(ent.pool)?.remove(k)
    }
    if (ent.kit) {
      this.scene.remove(ent.kit)
      disposeObject(ent.kit)
      this.kits.delete(k)
      ent.kit = null
    }
    const ring = this.rings.get(k)
    if (ring) {
      this.scene.remove(ring)
      if (!ring.geometry.userData?.shared) ring.geometry.dispose()
      ;(ring.material as THREE.Material).dispose()
      this.rings.delete(k)
    }
    this.removeBuildTimer(k)
  }

  private releaseEntity(k: string) {
    const ent = this.entities.get(k)
    if (!ent) return
    this.clearRender(ent)
    this.entities.delete(k)
  }

  private capKits() {
    while (this.kits.size > MAX_KITS) {
      if (!this.evictFarthestKit()) break
    }
  }

  private evictFarthestKit(): boolean {
    let farKey: string | null = null
    let farD = -1
    for (const [k, kit] of this.kits) {
      const d = Math.hypot((kit.userData.x as number) - this.camTx, (kit.userData.y as number) - this.camTz)
      if (d > farD) {
        farD = d
        farKey = k
      }
    }
    if (!farKey) return false
    const ent = this.entities.get(farKey)
    if (!ent) {
      const kit = this.kits.get(farKey)
      if (kit) {
        this.scene.remove(kit)
        disposeObject(kit)
        this.kits.delete(farKey)
      }
      return true
    }
    const t = this.tileAt(ent.x, ent.y)
    this.clearRender(ent)
    ent.path = 'none'
    ent.kit = null
    if (t) this.placeInstance(ent, t, ent.color)
    return true
  }

  private rebuildAnimList() {
    this.animList.length = 0
    for (const kit of this.kits.values()) {
      if (!kit.visible) continue
      if (kit.userData.kind === 'road' || kit.userData.kind === 'lake') this.animList.push(kit)
    }
  }

  private flushPools() {
    for (const p of this.pools.values()) p.flush()
  }
}

function shiftGreen(hex: number, delta: number): number {
  const r = (hex >> 16) & 0xff
  const g = Math.max(0, Math.min(255, ((hex >> 8) & 0xff) + delta))
  const b = hex & 0xff
  return (r << 16) | (g << 8) | b
}
