import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ViewportChunkManager } from './chunks'
import {
  ConstructionLayer,
  constructionPropEnvelope,
  craneSlewAngle,
  scaffoldHeightFactor,
  SETTLE_LIFE_SECONDS,
  settleAlpha,
  settlePhase,
  settleRingScale,
  sitePhase,
} from './constructionLayer'
import type { RenderConstructionSite, ViewportRenderSource } from './types'

function site(overrides: Partial<RenderConstructionSite> = {}): RenderConstructionSite {
  return {
    id: 101,
    tileX: 1,
    tileY: 1,
    x: 1 * 1.05,
    y: 0,
    z: 1 * 1.05,
    widthTiles: 1,
    depthTiles: 1,
    progress: 0.5,
    heightHint: 0.9,
    phase: sitePhase(101),
    ...overrides,
  }
}

function sourceWith(sites: readonly RenderConstructionSite[]): ViewportRenderSource {
  return {
    width: 8,
    height: 8,
    tileSize: 1.05,
    getConstructionSites: () => sites,
    readSurface: () => undefined,
    getChunkInstances: () => [],
    getChunkRevision: () => 0,
  }
}

function meshNamed(layer: ConstructionLayer, name: string): THREE.InstancedMesh | undefined {
  return layer.root.getObjectByName(name) as THREE.InstancedMesh | undefined
}

describe('construction animation helpers', () => {
  it('ramps the prop envelope up after foundation and back down near completion', () => {
    expect(constructionPropEnvelope(0)).toBe(0)
    expect(constructionPropEnvelope(1)).toBe(0)
    expect(constructionPropEnvelope(0.5)).toBeCloseTo(1, 5)
    // Monotonic rise through early progress, monotonic fall at the end.
    let previous = 0
    for (const p of [0.06, 0.08, 0.12, 0.16]) {
      const value = constructionPropEnvelope(p)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
    previous = 1
    for (const p of [0.9, 0.94, 0.98, 1]) {
      const value = constructionPropEnvelope(p)
      expect(value).toBeLessThan(previous)
      previous = value
    }
  })

  it('leads the rising shell with the scaffold cage and removes it at completion', () => {
    expect(scaffoldHeightFactor(0)).toBeCloseTo(0.22, 5)
    expect(scaffoldHeightFactor(0.5)).toBeCloseTo(0.795, 5)
    expect(scaffoldHeightFactor(0.7)).toBe(1)
    expect(scaffoldHeightFactor(1)).toBe(0)
    expect(scaffoldHeightFactor(0.4)).toBeGreaterThan(scaffoldHeightFactor(0.2))
  })

  it('slew angle is deterministic, phase-offset, and bounded around its drift', () => {
    const a = craneSlewAngle(12.5, sitePhase(7))
    expect(craneSlewAngle(12.5, sitePhase(7))).toBe(a)
    for (let t = 0; t < 60; t += 1.3) {
      const oscillation = craneSlewAngle(t, 1.25) - 1.25 - t * 0.06
      expect(Math.abs(oscillation)).toBeLessThanOrEqual(0.45 + 1e-9)
    }
    expect(craneSlewAngle(3, sitePhase(1))).not.toBeCloseTo(craneSlewAngle(3, sitePhase(2)), 5)
  })

  it('drives the settle burst from birth to expiry', () => {
    expect(settlePhase(-5)).toBe(1) // unborn slots read as expired
    expect(settlePhase(0.001)).toBeGreaterThan(0)
    expect(settlePhase(SETTLE_LIFE_SECONDS * 0.5)).toBeCloseTo(0.5, 5)
    expect(settlePhase(SETTLE_LIFE_SECONDS + 0.5)).toBe(1)

    expect(settleRingScale(0)).toBeCloseTo(0.3, 5)
    expect(settleRingScale(1)).toBeCloseTo(1.45, 5)
    expect(settleRingScale(0.6)).toBeGreaterThan(settleRingScale(0.4))

    expect(settleAlpha(0)).toBe(1)
    expect(settleAlpha(1)).toBe(0)
    expect(settleAlpha(0.5)).toBeCloseTo(0.25, 5)
  })

  it('derives a stable per-site phase from the numeric id', () => {
    expect(sitePhase(42)).toBe(sitePhase(42))
    expect(sitePhase(42)).toBeGreaterThanOrEqual(0)
    expect(sitePhase(42)).toBeLessThan(Math.PI * 2)
    expect(sitePhase(1)).not.toBe(sitePhase(2))
  })
})

describe('ConstructionLayer', () => {
  it('builds one scaffold and one crane per visible active site', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const layer = new ConstructionLayer()
    layer.update(new Set([0]), chunks, sourceWith([site()]))

    const scaffold = meshNamed(layer, 'construction-scaffold')
    const mast = meshNamed(layer, 'construction-crane-mast')
    const slew = meshNamed(layer, 'construction-crane-slew')
    expect(scaffold?.count).toBe(1)
    expect(mast?.count).toBe(1)
    expect(slew?.count).toBe(1)
    expect(layer.stats.sites).toBe(1)
    expect(layer.stats.drawCalls).toBe(3)
    // No completion yet → no settle effects allocated.
    expect(meshNamed(layer, 'construction-settle-ring')).toBeUndefined()
    layer.dispose()
  })

  it('keeps off-screen sites out of the GPU set entirely', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const layer = new ConstructionLayer()
    layer.update(
      new Set([0]),
      chunks,
      sourceWith([site({ id: 55, tileX: 7, tileY: 7, x: 7.35, z: 7.35 })]),
    )
    expect(meshNamed(layer, 'construction-scaffold')).toBeUndefined()
    expect(layer.stats).toMatchObject({ sites: 0, drawCalls: 0, triangles: 0 })
    layer.dispose()
  })

  it('fires one settle burst when a site completes, then goes quiet', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const layer = new ConstructionLayer()
    layer.setFrame(10)
    layer.update(new Set([0]), chunks, sourceWith([site()]))
    expect(meshNamed(layer, 'construction-settle-ring')).toBeUndefined()

    // Construction completes: the site leaves the active list.
    layer.update(new Set([0]), chunks, sourceWith([site({ progress: 1 })]))
    const ring = meshNamed(layer, 'construction-settle-ring')
    const dust = meshNamed(layer, 'construction-settle-dust')
    expect(ring?.count).toBe(24)
    expect(dust?.count).toBe(24)
    const birth = ring!.geometry.getAttribute('aBirth') as THREE.InstancedBufferAttribute
    expect(birth.getX(0)).toBe(10) // spawned at the layer clock
    // Props for the finished site are gone — completed buildings cost nothing.
    expect(meshNamed(layer, 'construction-scaffold')).toBeUndefined()

    // A later update with no changes spawns nothing new.
    layer.update(new Set([0]), chunks, sourceWith([site({ progress: 1 })]))
    expect(birth.getX(1)).toBeLessThan(0) // slot 1 still dead
    layer.dispose()
  })

  it('primes on first update so pre-built maps never burst, but new placements do', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const layer = new ConstructionLayer()
    // First update sees an already-complete building: prime only, no burst.
    layer.update(new Set([0]), chunks, sourceWith([site({ progress: 1 })]))
    expect(meshNamed(layer, 'construction-settle-ring')).toBeUndefined()

    // A brand-new standing building appears later (placed instantly): burst.
    const placed = site({ id: 202, tileX: 2, tileY: 2, x: 2.1, z: 2.1, progress: 1 })
    layer.update(new Set([0]), chunks, sourceWith([site({ progress: 1 }), placed]))
    const ring = meshNamed(layer, 'construction-settle-ring')
    expect(ring).toBeDefined()
    const birth = ring!.geometry.getAttribute('aBirth') as THREE.InstancedBufferAttribute
    expect(birth.getX(0)).toBeGreaterThanOrEqual(0)
    layer.dispose()
  })

  it('advances per-day progress in place without rebuilding the prop meshes', () => {
    const chunks = new ViewportChunkManager(8, 8, 4, 8)
    const layer = new ConstructionLayer()
    layer.update(new Set([0]), chunks, sourceWith([site({ progress: 0.3 })]))
    const scaffold = meshNamed(layer, 'construction-scaffold')!
    const geometry = scaffold.geometry
    const grow = geometry.getAttribute('aGrow') as THREE.InstancedBufferAttribute
    const before = grow.getX(0)
    expect(before).toBeCloseTo(0.9 * scaffoldHeightFactor(0.3) * constructionPropEnvelope(0.3), 5)

    layer.update(new Set([0]), chunks, sourceWith([site({ progress: 0.6 })]))
    // Same geometry object: attribute rewritten, no rebuild churn.
    expect(meshNamed(layer, 'construction-scaffold')!.geometry).toBe(geometry)
    expect(grow.getX(0)).toBeCloseTo(0.9 * scaffoldHeightFactor(0.6) * constructionPropEnvelope(0.6), 5)
    layer.dispose()
  })
})
