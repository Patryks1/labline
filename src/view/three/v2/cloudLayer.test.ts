import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { CloudLayer } from './cloudLayer'

describe('CloudLayer', () => {
  it('builds deterministic one-draw geometry that covers a 300x300 world', () => {
    const options = { width: 300, height: 300, tileSize: 1.05, seed: 0x12345678 }
    const first = new CloudLayer(options)
    const second = new CloudLayer(options)
    const changedSeed = new CloudLayer({ ...options, seed: options.seed + 1 })

    expect(first.stats.banks).toBeGreaterThanOrEqual(36)
    expect(first.stats.puffs).toBeGreaterThanOrEqual(first.stats.banks * 7)
    expect(first.stats.drawCalls).toBe(1)
    expect(first.mesh.frustumCulled).toBe(false)
    expect(first.mesh.renderOrder).toBe(1)
    expect(first.material.transparent).toBe(true)
    expect(first.material.depthWrite).toBe(false)
    expect(first.material.vertexShader).toContain('cloudAnchor.xz + cloudVelocity * uCloudTime')
    expect(first.material.vertexShader).toContain('mod(movingAnchor - uWorldMin, uWorldSpan)')
    expect(first.material.fragmentShader).not.toContain('sampler2D')
    expect(first.material.fragmentShader).toContain('float underside = 1.0 - smoothstep')
    expect(first.material.fragmentShader).toContain('mix(0.16, 0.38, edgeFade)')

    const verticesPerPuff = first.geometry.getAttribute('position').count / first.stats.puffs
    expect(verticesPerPuff).toBeGreaterThan(200)
    expect(verticesPerPuff).toBeLessThan(400)

    const firstAnchors = snapshot(first.geometry, 'cloudAnchor')
    expect(firstAnchors).toEqual(snapshot(second.geometry, 'cloudAnchor'))
    expect(snapshot(first.geometry, 'position')).toEqual(snapshot(second.geometry, 'position'))
    expect(firstAnchors).not.toEqual(snapshot(changedSeed.geometry, 'cloudAnchor'))

    const xs = everyComponent(firstAnchors, 3, 0)
    const zs = everyComponent(firstAnchors, 3, 2)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(250)
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(250)

    first.dispose()
    second.dispose()
    changedSeed.dispose()
  })

  it('freezes on pause and resumes continuously without wall-clock catch-up', () => {
    const layer = new CloudLayer({ width: 32, height: 32, tileSize: 1, seed: 7 })

    layer.setFrame(100, false)
    expect(cloudTime(layer)).toBe(0)
    layer.setFrame(104, false)
    expect(cloudTime(layer)).toBe(4)
    layer.setFrame(110, true)
    layer.setFrame(250, true)
    expect(cloudTime(layer)).toBe(4)

    layer.setFrame(400, false)
    expect(cloudTime(layer)).toBe(4)
    layer.setFrame(401.5, false)
    expect(cloudTime(layer)).toBe(5.5)

    layer.dispose()
  })

  it('supports visibility changes, never intercepts raycasts, and disposes once', () => {
    const layer = new CloudLayer({ width: 24, height: 18, tileSize: 1, seed: 9 })
    const geometryDisposed = vi.fn()
    const materialDisposed = vi.fn()
    layer.geometry.addEventListener('dispose', geometryDisposed)
    layer.material.addEventListener('dispose', materialDisposed)

    layer.setVisible(false)
    expect(layer.root.visible).toBe(false)
    layer.setVisible(true)
    expect(layer.root.visible).toBe(true)

    layer.mesh.updateMatrixWorld(true)
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(12, 30, 9),
      new THREE.Vector3(0, -1, 0),
    )
    expect(raycaster.intersectObject(layer.mesh)).toEqual([])

    layer.dispose()
    layer.dispose()
    expect(geometryDisposed).toHaveBeenCalledOnce()
    expect(materialDisposed).toHaveBeenCalledOnce()
    expect(layer.root.children).toHaveLength(0)
    expect(() => layer.setVisible(true)).toThrow(/disposed/)
    expect(() => layer.setFrame(2, false)).toThrow(/disposed/)
  })
})

function snapshot(geometry: THREE.BufferGeometry, attribute: string): number[] {
  return Array.from(geometry.getAttribute(attribute).array)
}

function everyComponent(values: readonly number[], stride: number, offset: number): number[] {
  const result: number[] = []
  for (let index = offset; index < values.length; index += stride) result.push(values[index]!)
  return result
}

function cloudTime(layer: CloudLayer): number {
  return layer.material.uniforms.uCloudTime!.value as number
}
