import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { WORLD_VOID_MARGIN_TILES, WORLD_VOID_Y, WorldVoidLayer } from './worldVoidLayer'

describe('WorldVoidLayer', () => {
  it('covers a large map with constant two-triangle geometry and world-space shader detail', () => {
    const layer = new WorldVoidLayer({ width: 300, height: 180, tileSize: 1.05 })
    const position = layer.geometry.getAttribute('position')

    expect(position.count).toBe(4)
    expect(layer.geometry.index?.count).toBe(6)
    expect(layer.geometry.parameters.width).toBeCloseTo((300 + WORLD_VOID_MARGIN_TILES * 2) * 1.05)
    expect(layer.geometry.parameters.height).toBeCloseTo((180 + WORLD_VOID_MARGIN_TILES * 2) * 1.05)
    expect(layer.mesh.position.y).toBe(WORLD_VOID_Y)
    expect(layer.mesh.rotation.x).toBe(-Math.PI * 0.5)
    expect(layer.material.fog).toBe(true)
    expect(layer.material.fragmentShader).toContain('float voidFbm')
    expect(layer.material.fragmentShader).toContain('vec2 voidDomainWarp')
    expect(layer.material.fragmentShader).toContain('float roundedCloudLobes')
    expect(layer.material.fragmentShader).toContain('float roundedLobes = roundedCloudLobes')
    expect(layer.material.fragmentShader).toContain('float softGaps = voidFbm')
    expect(layer.material.fragmentShader).toContain('float crownLight = clamp')
    expect(layer.material.fragmentShader).toContain('float cloudBody = smoothstep')
    expect(layer.material.fragmentShader).toContain('vec3 cloudShade')
    expect(layer.material.fragmentShader).toContain('vec3 cloudLight')
    expect(layer.material.fragmentShader).toContain('float edgeCloud = exp')
    expect(layer.material.fragmentShader).not.toContain('gridLine')
    expect(layer.material.fragmentShader).not.toContain('periodicLine')
    expect(layer.material.fragmentShader).not.toContain('sampler2D')

    layer.dispose()
  })

  it('matches the finite-world bounds and never participates in raycasts', () => {
    const layer = new WorldVoidLayer({ width: 4, height: 3, tileSize: 2, marginTiles: 4 })
    const min = layer.material.uniforms.uWorldMin!.value as THREE.Vector2
    const max = layer.material.uniforms.uWorldMax!.value as THREE.Vector2
    const raycaster = new THREE.Raycaster(new THREE.Vector3(3, 10, 2), new THREE.Vector3(0, -1, 0))

    layer.mesh.updateMatrixWorld(true)
    expect(min.toArray()).toEqual([-1, -1])
    expect(max.toArray()).toEqual([7, 5])
    expect(raycaster.intersectObject(layer.mesh)).toEqual([])

    layer.dispose()
  })

  it('updates only time and disposes its GPU resources once', () => {
    const layer = new WorldVoidLayer({ width: 8, height: 8, tileSize: 1 })
    const geometryDisposed = vi.fn()
    const materialDisposed = vi.fn()
    layer.geometry.addEventListener('dispose', geometryDisposed)
    layer.material.addEventListener('dispose', materialDisposed)

    layer.setFrame(12.5)
    expect(layer.material.uniforms.uTime!.value).toBe(12.5)
    layer.dispose()
    layer.dispose()

    expect(geometryDisposed).toHaveBeenCalledOnce()
    expect(materialDisposed).toHaveBeenCalledOnce()
    expect(() => layer.setFrame(13)).toThrow(/disposed/)
  })
})
