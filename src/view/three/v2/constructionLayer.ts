/**
 * Construction animation layer: scaffolding cages and slewing tower cranes on
 * active building sites, plus a one-shot "settle" dust/ring burst when a
 * building completes construction (or first appears already built).
 *
 * Follows the MunicipalPowerLayer idiom: a handful of InstancedMeshes whose
 * animation runs entirely in shaders from one shared time uniform, so the
 * per-frame CPU cost is a single uniform write. Meshes are rebuilt only when
 * the visible site set changes; per-day progress advances rewrite one small
 * instanced attribute in place. Completed buildings cost zero extra draw
 * calls — the settle pool is the only persistent effect and it is invisible
 * (zero-area instances) while idle.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ViewportChunkManager } from './chunks'
import type { ChunkId, RenderConstructionSite, ViewportRenderSource } from './types'

/** Seconds a completion settle burst stays on screen. */
export const SETTLE_LIFE_SECONDS = 1.25
/** Concurrent settle bursts retained; oldest slots are recycled. */
const SETTLE_POOL = 24
/** Bursts skipped when more sites than this vanish in one update (world reset). */
const MASS_VANISH_GUARD = 12

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * 0 → 1 → 0 envelope over construction progress: props assemble once the
 * foundation is down and retract as the building tops out. Zero at both ends.
 */
export function constructionPropEnvelope(progress: number): number {
  const p = clamp01(progress)
  return smoothstep(0.04, 0.16, p) * (1 - smoothstep(0.88, 1, p))
}

/**
 * Scaffold cage height as a fraction of finished building height. The cage
 * leads the rising shell (nearly full height by ~70% progress) and is gone
 * at completion.
 */
export function scaffoldHeightFactor(progress: number): number {
  const p = clamp01(progress)
  if (p >= 1) return 0
  return Math.min(1, 0.22 + p * 1.15)
}

/**
 * Deterministic crane slew angle: a slow constant drift plus a bounded
 * idle oscillation. Phase comes from the stable site id — never Math.random.
 */
export function craneSlewAngle(timeSeconds: number, phase: number): number {
  return phase + timeSeconds * 0.06 + Math.sin(timeSeconds * 0.42 + phase * 1.7) * 0.45
}

/** Settle-burst phase 0 → 1; unborn (negative age) and expired slots read 1. */
export function settlePhase(ageSeconds: number): number {
  if (!(ageSeconds > 0)) return 1
  return clamp01(ageSeconds / SETTLE_LIFE_SECONDS)
}

/** Expanding-ring radius factor over the settle burst (cubic ease-out). */
export function settleRingScale(t: number): number {
  const k = 1 - Math.pow(1 - clamp01(t), 3)
  return 0.3 + k * 1.15
}

/** Dust/flash opacity over the settle burst (quadratic fade). */
export function settleAlpha(t: number): number {
  const k = 1 - clamp01(t)
  return k * k
}

/** Deterministic per-site jitter in [0, 2π) from the stable numeric site id. */
export function sitePhase(id: number): number {
  return ((id >>> 0) % 6283) / 1000
}

interface TimeState {
  value: number
}

export interface ConstructionLayerStats {
  readonly sites: number
  readonly instances: number
  readonly drawCalls: number
  readonly triangles: number
}

function emptyStats(): ConstructionLayerStats {
  return { sites: 0, instances: 0, drawCalls: 0, triangles: 0 }
}

export class ConstructionLayer {
  readonly root = new THREE.Group()
  stats: ConstructionLayerStats = emptyStats()

  private readonly time: TimeState = { value: 0 }
  private readonly scaffoldMaterial = propMaterial('construction-scaffold')
  private readonly mastMaterial = craneMaterial('construction-crane-mast', this.time, false)
  private readonly slewMaterial = craneMaterial('construction-crane-slew', this.time, true)
  private readonly ringMaterial = settleMaterial('construction-settle-ring', this.time, 'ring')
  private readonly dustMaterial = settleMaterial('construction-settle-dust', this.time, 'dust')

  private scaffoldMesh: THREE.InstancedMesh | null = null
  private mastMesh: THREE.InstancedMesh | null = null
  private slewMesh: THREE.InstancedMesh | null = null
  private scaffoldGrow: THREE.InstancedBufferAttribute | null = null
  private mastGrow: THREE.InstancedBufferAttribute | null = null
  private slewGrow: THREE.InstancedBufferAttribute | null = null

  private ringMesh: THREE.InstancedMesh | null = null
  private dustMesh: THREE.InstancedMesh | null = null
  private settleAttrs: {
    birthAttr: THREE.InstancedBufferAttribute
    phaseAttr: THREE.InstancedBufferAttribute
    sizeAttr: THREE.InstancedBufferAttribute
    dustBirthAttr: THREE.InstancedBufferAttribute
    dustPhaseAttr: THREE.InstancedBufferAttribute
    dustSizeAttr: THREE.InstancedBufferAttribute
  } | null = null
  private readonly ringBirth = new Float32Array(SETTLE_POOL).fill(-1e6)
  private readonly ringPhase = new Float32Array(SETTLE_POOL)
  private readonly ringSize = new Float32Array(SETTLE_POOL)
  private readonly dustBirth = new Float32Array(SETTLE_POOL).fill(-1e6)
  private readonly dustPhase = new Float32Array(SETTLE_POOL)
  private readonly dustSize = new Float32Array(SETTLE_POOL)
  private settleCursor = 0
  private settleSpawns = 0

  private signature: string | null = null
  private currentSites: readonly RenderConstructionSite[] = []
  private prevActive = new Map<number, RenderConstructionSite>()
  private knownStanding = new Set<number>()
  private primed = false

  constructor() {
    this.root.name = 'construction-site-effects'
  }

  update(
    visible: ReadonlySet<ChunkId>,
    chunks: ViewportChunkManager,
    source: ViewportRenderSource,
  ): void {
    const allSites = source.getConstructionSites?.() ?? []
    const tileSize = source.tileSize

    const activeGlobal = new Map<number, RenderConstructionSite>()
    const standingIds = new Set<number>()
    for (const site of allSites) {
      if (site.progress < 1) activeGlobal.set(site.id, site)
      else standingIds.add(site.id)
    }

    // Padded tile-space union of visible chunks; props exist only on screen.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const chunkId of visible) {
      const b = chunks.chunkBounds(chunkId)
      minX = Math.min(minX, b.minX)
      minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX)
      maxY = Math.max(maxY, b.maxY)
    }
    const pad = 2
    const inView = (site: RenderConstructionSite) =>
      Number.isFinite(minX) &&
      site.tileX >= minX - pad && site.tileX < maxX + pad &&
      site.tileY >= minY - pad && site.tileY < maxY + pad

    // Completion (and demolition) bursts: a previously active site that left
    // the active list settled — unless half the map vanished at once, which
    // means a world reset/load rather than organic completions.
    const vanished: RenderConstructionSite[] = []
    for (const [id, prev] of this.prevActive) {
      if (activeGlobal.has(id)) continue
      this.knownStanding.add(id)
      vanished.push(prev)
    }
    if (vanished.length <= MASS_VANISH_GUARD) {
      for (const prev of vanished) if (inView(prev)) this.spawnBurst(prev, tileSize)
    }
    // First-appearance bursts for buildings placed already complete. The first
    // update only primes the standing set so map load never bursts at once.
    for (const site of allSites) {
      if (site.progress < 1 || this.knownStanding.has(site.id)) continue
      this.knownStanding.add(site.id)
      if (this.primed && inView(site)) this.spawnBurst(site, tileSize)
    }
    // Forget demolished buildings so a later rebuild on the parcel re-settles.
    for (const id of [...this.knownStanding]) {
      if (!standingIds.has(id)) this.knownStanding.delete(id)
    }

    this.prevActive = activeGlobal
    this.primed = true

    const visibleActive = allSites.filter((site) => site.progress < 1 && inView(site))
    const signature = visibleActive
      .map((site) =>
        `${site.id}:${site.x.toFixed(2)}:${site.z.toFixed(2)}:${site.widthTiles}x${site.depthTiles}:${site.heightHint.toFixed(2)}`,
      )
      .sort()
      .join('|')
    if (signature !== this.signature) {
      this.signature = signature
      this.rebuildProps(visibleActive, tileSize)
    } else {
      this.refreshProgress(visibleActive)
    }
    this.refreshStats()
  }

  setFrame(timeSeconds: number): void {
    this.time.value = timeSeconds
  }

  dispose(): void {
    this.clearProps()
    this.disposeSettleMeshes()
    this.scaffoldMaterial.dispose()
    this.mastMaterial.dispose()
    this.slewMaterial.dispose()
    this.ringMaterial.dispose()
    this.dustMaterial.dispose()
    this.root.clear()
    this.prevActive.clear()
    this.knownStanding.clear()
    this.currentSites = []
    this.stats = emptyStats()
  }

  // ── construction props ──────────────────────────────────────────────────

  private rebuildProps(sites: readonly RenderConstructionSite[], tileSize: number): void {
    this.clearProps()
    this.currentSites = sites
    if (sites.length === 0) return

    const scaffoldGeometry = scaffoldFrameGeometry()
    const mastGeometry = craneMastGeometry()
    const slewGeometry = craneSlewGeometry()
    const scaffoldGrow = new Float32Array(sites.length)
    const mastGrow = new Float32Array(sites.length)
    const slewGrow = new Float32Array(sites.length)
    const slewPhase = new Float32Array(sites.length)

    const scaffold = new THREE.InstancedMesh(scaffoldGeometry, this.scaffoldMaterial, sites.length)
    const mast = new THREE.InstancedMesh(mastGeometry, this.mastMaterial, sites.length)
    const slew = new THREE.InstancedMesh(slewGeometry, this.slewMaterial, sites.length)
    scaffold.name = 'construction-scaffold'
    mast.name = 'construction-crane-mast'
    slew.name = 'construction-crane-slew'

    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const identity = new THREE.Quaternion()

    sites.forEach((site, index) => {
      const envelope = constructionPropEnvelope(site.progress)
      scaffoldGrow[index] = site.heightHint * scaffoldHeightFactor(site.progress) * envelope
      mastGrow[index] = envelope
      slewGrow[index] = envelope
      slewPhase[index] = site.phase

      position.set(site.x, site.y + 0.02, site.z)
      scale.set(site.widthTiles * tileSize * 0.98, 1, site.depthTiles * tileSize * 0.98)
      matrix.compose(position, identity, scale)
      scaffold.setMatrixAt(index, matrix)

      const crane = cranePlacement(site, tileSize)
      position.set(crane.x, site.y + 0.01, crane.z)
      scale.set(crane.foot, crane.mastHeight, crane.foot)
      matrix.compose(position, identity, scale)
      mast.setMatrixAt(index, matrix)
      slew.setMatrixAt(index, matrix)
    })

    this.scaffoldGrow = attachGrow(scaffoldGeometry, scaffoldGrow)
    this.mastGrow = attachGrow(mastGeometry, mastGrow)
    this.slewGrow = attachGrow(slewGeometry, slewGrow)
    slewGeometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(slewPhase, 1))

    for (const mesh of [scaffold, mast, slew]) {
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.computeBoundingSphere()
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.4
      this.root.add(mesh)
    }
    this.scaffoldMesh = scaffold
    this.mastMesh = mast
    this.slewMesh = slew
  }

  /** Per-day progress advance: rewrite only the grow attributes in place. */
  private refreshProgress(sites: readonly RenderConstructionSite[]): void {
    if (!this.scaffoldGrow || !this.mastGrow || !this.slewGrow) return
    if (sites.length !== this.currentSites.length) return
    const progressById = new Map<number, number>()
    for (const site of sites) progressById.set(site.id, site.progress)
    let dirty = false
    this.currentSites.forEach((site, index) => {
      const progress = progressById.get(site.id)
      if (progress === undefined || progress === site.progress) return
      const envelope = constructionPropEnvelope(progress)
      this.scaffoldGrow!.array[index] = site.heightHint * scaffoldHeightFactor(progress) * envelope
      this.mastGrow!.array[index] = envelope
      this.slewGrow!.array[index] = envelope
      dirty = true
    })
    if (dirty) {
      this.scaffoldGrow.needsUpdate = true
      this.mastGrow.needsUpdate = true
      this.slewGrow.needsUpdate = true
      this.currentSites = sites
    }
  }

  private clearProps(): void {
    for (const mesh of [this.scaffoldMesh, this.mastMesh, this.slewMesh]) {
      if (!mesh) continue
      this.root.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.scaffoldMesh = null
    this.mastMesh = null
    this.slewMesh = null
    this.scaffoldGrow = null
    this.mastGrow = null
    this.slewGrow = null
  }

  // ── settle bursts ─────────────────────────────────────────────────────────

  private spawnBurst(site: RenderConstructionSite, tileSize: number): void {
    const slot = this.settleCursor
    this.settleCursor = (this.settleCursor + 1) % SETTLE_POOL
    this.settleSpawns++
    const radius = (Math.max(site.widthTiles, site.depthTiles) * 0.5) * tileSize * 1.05 + 0.3
    this.ringBirth[slot] = this.time.value
    this.ringPhase[slot] = site.phase
    this.ringSize[slot] = radius
    this.dustBirth[slot] = this.time.value
    this.dustPhase[slot] = site.phase
    this.dustSize[slot] = radius * 0.9

    const attrs = this.ensureSettleMeshes()
    const matrix = new THREE.Matrix4().makeTranslation(site.x, site.y + 0.03, site.z)
    this.ringMesh!.setMatrixAt(slot, matrix)
    this.dustMesh!.setMatrixAt(slot, matrix)
    this.ringMesh!.instanceMatrix.needsUpdate = true
    this.dustMesh!.instanceMatrix.needsUpdate = true
    attrs.birthAttr.needsUpdate = true
    attrs.phaseAttr.needsUpdate = true
    attrs.sizeAttr.needsUpdate = true
    attrs.dustBirthAttr.needsUpdate = true
    attrs.dustPhaseAttr.needsUpdate = true
    attrs.dustSizeAttr.needsUpdate = true
  }

  private ensureSettleMeshes() {
    if (this.settleAttrs) return this.settleAttrs
    const ringGeometry = settleRingGeometry()
    const dustGeometry = settleDustGeometry()
    const birthAttr = new THREE.InstancedBufferAttribute(this.ringBirth, 1)
    const phaseAttr = new THREE.InstancedBufferAttribute(this.ringPhase, 1)
    const sizeAttr = new THREE.InstancedBufferAttribute(this.ringSize, 1)
    const dustBirthAttr = new THREE.InstancedBufferAttribute(this.dustBirth, 1)
    const dustPhaseAttr = new THREE.InstancedBufferAttribute(this.dustPhase, 1)
    const dustSizeAttr = new THREE.InstancedBufferAttribute(this.dustSize, 1)
    ringGeometry.setAttribute('aBirth', birthAttr)
    ringGeometry.setAttribute('aPhase', phaseAttr)
    ringGeometry.setAttribute('aSize', sizeAttr)
    dustGeometry.setAttribute('aBirth', dustBirthAttr)
    dustGeometry.setAttribute('aPhase', dustPhaseAttr)
    dustGeometry.setAttribute('aSize', dustSizeAttr)

    const ring = new THREE.InstancedMesh(ringGeometry, this.ringMaterial, SETTLE_POOL)
    const dust = new THREE.InstancedMesh(dustGeometry, this.dustMaterial, SETTLE_POOL)
    ring.name = 'construction-settle-ring'
    dust.name = 'construction-settle-dust'
    const dead = new THREE.Matrix4().makeScale(0, 0, 0)
    for (const mesh of [ring, dust]) {
      for (let slot = 0; slot < SETTLE_POOL; slot++) mesh.setMatrixAt(slot, dead)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = false
      mesh.receiveShadow = false
      mesh.frustumCulled = false // shader expands instances far beyond base bounds
      this.root.add(mesh)
    }
    this.ringMesh = ring
    this.dustMesh = dust
    this.settleAttrs = {
      birthAttr,
      phaseAttr,
      sizeAttr,
      dustBirthAttr,
      dustPhaseAttr,
      dustSizeAttr,
    }
    return this.settleAttrs
  }

  private disposeSettleMeshes(): void {
    for (const mesh of [this.ringMesh, this.dustMesh]) {
      if (!mesh) continue
      this.root.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.ringMesh = null
    this.dustMesh = null
    this.settleAttrs = null
  }

  private refreshStats(): void {
    const propInstances = this.currentSites.length * 3
    const settleInstances = this.settleAttrs ? Math.min(this.settleSpawns, SETTLE_POOL) * 2 : 0
    const meshes = [this.scaffoldMesh, this.mastMesh, this.slewMesh, this.ringMesh, this.dustMesh]
    let drawCalls = 0
    let triangles = 0
    for (const mesh of meshes) {
      if (!mesh || !mesh.visible) continue
      drawCalls++
      triangles += triangleCount(mesh.geometry) * mesh.count
    }
    this.stats = {
      sites: this.currentSites.length,
      instances: propInstances + settleInstances,
      drawCalls,
      triangles,
    }
  }
}

// ─── geometry (fresh per rebuild; disposed with the mesh) ──────────────────

function paint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const color = new THREE.Color(hex)
  const count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geometry.deleteAttribute('uv')
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

function boxAt(
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  hex: number,
  rotZ = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(sx, sy, sz)
  if (rotZ !== 0) geometry.rotateZ(rotZ)
  geometry.translate(x, y, z)
  return paint(geometry, hex)
}

const TIMBER = 0xb08d57
const STEEL = 0x7d8a94
const CRANE_YELLOW = 0xe8b23a
const CRANE_DARK = 0xc99a2e
const DARK_METAL = 0x4a4e58
const CAB_GLASS = 0x9fc4d8

/** Unit-footprint scaffold cage (posts, rails, two braces); base y=0, height 1. */
function scaffoldFrameGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (const px of [-0.48, 0.48]) {
    for (const pz of [-0.48, 0.48]) {
      parts.push(boxAt(0.035, 1, 0.035, px, 0.5, pz, TIMBER))
    }
  }
  for (const level of [0.33, 0.66, 0.99]) {
    parts.push(boxAt(0.96, 0.025, 0.025, 0, level, -0.48, STEEL))
    parts.push(boxAt(0.96, 0.025, 0.025, 0, level, 0.48, STEEL))
    parts.push(boxAt(0.025, 0.025, 0.96, -0.48, level, 0, STEEL))
    parts.push(boxAt(0.025, 0.025, 0.96, 0.48, level, 0, STEEL))
  }
  // Diagonal face braces on the ±z faces.
  parts.push(boxAt(0.02, 1.3, 0.02, 0, 0.5, 0.48, STEEL, 0.78))
  parts.push(boxAt(0.02, 1.3, 0.02, 0, 0.5, -0.48, STEEL, -0.78))
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('scaffold frame geometry failed to merge')
  return merged
}

/** Normalized crane mast: base pad + column + rung rings; base y=0, height 1. */
function craneMastGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    boxAt(0.3, 0.05, 0.3, 0, 0.025, 0, DARK_METAL),
    boxAt(0.075, 1, 0.075, 0, 0.5, 0, CRANE_YELLOW),
  ]
  for (const level of [0.2, 0.4, 0.6, 0.8]) {
    parts.push(boxAt(0.12, 0.02, 0.12, 0, level, 0, CRANE_DARK))
  }
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('crane mast geometry failed to merge')
  return merged
}

/**
 * Normalized crane slew assembly (cab, apex, jib, counterweight, tie bars,
 * hook) modeled around the mast axis so the shader can rotate `xz` in place.
 */
function craneSlewGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    boxAt(0.14, 0.07, 0.1, 0.02, 1.035, 0, CAB_GLASS),
    boxAt(0.05, 0.14, 0.05, 0, 1.09, 0, CRANE_YELLOW),
    boxAt(0.78, 0.035, 0.05, 0.33, 1.06, 0, CRANE_YELLOW),
    boxAt(0.22, 0.05, 0.07, -0.17, 1.05, 0, CRANE_DARK),
    boxAt(0.07, 0.09, 0.09, -0.27, 1.0, 0, DARK_METAL),
    // Tie bars from the apex out to the jib and counter-jib.
    boxAt(0.52, 0.014, 0.014, 0.24, 1.13, 0, CRANE_DARK, -0.2),
    boxAt(0.3, 0.014, 0.014, -0.14, 1.13, 0, CRANE_DARK, 0.28),
    // Hook line + block hanging from the jib trolley point.
    boxAt(0.008, 0.22, 0.008, 0.58, 0.93, 0, DARK_METAL),
    boxAt(0.035, 0.045, 0.035, 0.58, 0.8, 0, DARK_METAL),
  ]
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('crane slew geometry failed to merge')
  return merged
}

/** Flat expanding ring; shader scales `xz` from 0.3 → 1.45 × aSize. */
function settleRingGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.RingGeometry(0.82, 1, 28)
  geometry.rotateX(-Math.PI / 2)
  geometry.deleteAttribute('uv')
  return geometry
}

/** Cluster of low-poly dust blobs around the origin; shader expands/rises. */
function settleDustGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2
    const radius = 0.07 + (i % 3) * 0.015
    const blob = new THREE.IcosahedronGeometry(radius, 0)
    blob.translate(Math.cos(angle) * 0.52, 0.05 + (i % 2) * 0.04, Math.sin(angle) * 0.52)
    parts.push(blob)
  }
  const center = new THREE.IcosahedronGeometry(0.11, 0)
  center.translate(0, 0.08, 0)
  parts.push(center)
  const merged = mergeGeometries(parts, false)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('settle dust geometry failed to merge')
  return merged
}

// ─── materials (one per layer; animation runs on the GPU) ──────────────────

function attachGrow(
  geometry: THREE.BufferGeometry,
  values: Float32Array,
): THREE.InstancedBufferAttribute {
  const attribute = new THREE.InstancedBufferAttribute(values, 1)
  geometry.setAttribute('aGrow', attribute)
  return attribute
}

function propMaterial(name: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name,
    vertexColors: true,
    roughness: 0.7,
    metalness: 0.12,
    fog: true,
  })
}

/** Crane material: `aGrow` retracts height; slew variant also rotates `xz`. */
function craneMaterial(name: string, time: TimeState, slew: boolean): THREE.MeshStandardMaterial {
  const material = propMaterial(name)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSiteTime = time
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `attribute float aGrow;\nattribute float aPhase;\nuniform float uSiteTime;\nvoid main() {`,
      )
      .replace(
        '#include <begin_vertex>',
        slew
          ? `#include <begin_vertex>
transformed.y *= aGrow;
float slewA = aPhase + uSiteTime*0.06 + sin(uSiteTime*0.42 + aPhase*1.7)*0.45;
mat2 slewR = mat2(cos(slewA),-sin(slewA),sin(slewA),cos(slewA));
transformed.xz = slewR*transformed.xz;`
          : `#include <begin_vertex>
transformed.y *= aGrow;`,
      )
  }
  material.customProgramCacheKey = () => `labline-${name}-v1`
  return material
}

/**
 * Settle-burst material: instances expand and fade by `uSiteTime - aBirth`.
 * Expired slots collapse to zero area, so the pool costs nothing while idle.
 */
function settleMaterial(name: string, time: TimeState, mode: 'ring' | 'dust'): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name,
    color: mode === 'ring' ? 0xe6d9b8 : 0xcfc0a2,
    roughness: 0.9,
    metalness: 0,
    flatShading: mode === 'dust',
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  })
  const life = SETTLE_LIFE_SECONDS.toFixed(3)
  const motion =
    mode === 'ring'
      ? `float ringS = (0.3 + ease*1.15) * aSize;
transformed.xz *= ringS * live;`
      : `float dustS = mix(0.35, 1.3, ease) * aSize;
transformed.xz *= dustS * live;
transformed.y = (transformed.y * aSize + ease*0.45*aSize + sin(aPhase*3.1 + transformed.x*7.0)*0.06*t) * live;`
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSiteTime = time
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `attribute float aBirth;\nattribute float aPhase;\nattribute float aSize;\nuniform float uSiteTime;\nvarying float vSettleA;\nvoid main() {`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float t = clamp((uSiteTime - aBirth) / ${life}, 0.0, 1.0);
float live = 1.0 - step(1.0, t);
float ease = 1.0 - pow(1.0 - t, 3.0);
vSettleA = (1.0 - t) * (1.0 - t) * live;
${motion}`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vSettleA;\nvoid main() {')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vSettleA;')
  }
  material.customProgramCacheKey = () => `labline-${name}-v1`
  return material
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Crane sits just beside the footprint on a deterministic side. */
function cranePlacement(
  site: RenderConstructionSite,
  tileSize: number,
): { x: number; z: number; foot: number; mastHeight: number } {
  const side = Math.floor((site.phase / (Math.PI * 2)) * 4) & 3
  const spanX = site.widthTiles * tileSize
  const spanZ = site.depthTiles * tileSize
  const alongX = side === 0 || side === 2
  const span = alongX ? spanX : spanZ
  const distance = span * 0.5 + 0.34
  const sign = side === 0 || side === 1 ? 1 : -1
  return {
    x: site.x + (alongX ? sign * distance : 0),
    z: site.z + (alongX ? 0 : sign * distance),
    // Hook (normalized x = 0.58) should hang over the footprint centre.
    foot: Math.max(0.9, distance / 0.58),
    mastHeight: Math.max(0.85, site.heightHint * 1.28 + 0.12),
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3
}
