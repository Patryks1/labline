import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { MapTile } from '../../sim/types'
import { TileWorld } from './tileWorld'

function roadMap(width: number, height: number): MapTile[] {
  const tiles: MapTile[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        regionId: 'city_0',
        kind: 'road',
        owner: 'neutral',
        name: 'Road',
        level: 1,
        buildingProgress: 1,
        buildingTarget: 1,
        rackCapacity: 0,
        racksUsed: 0,
        mwCapacity: 0,
        mwGeneration: 0,
        capex: 0,
        opexPerDay: 0,
        note: '',
        landValue: 0,
      })
    }
  }
  return tiles
}

describe('TileWorld LOD convergence', () => {
  const worlds: TileWorld[] = []

  afterEach(() => {
    for (const world of worlds.splice(0)) world.dispose()
  })

  it('replaces far low-detail kits after zooming fully in', () => {
    const scene = new THREE.Scene()
    const world = new TileWorld({ scene, rivalColors: {} })
    worlds.push(world)
    world.setMap(roadMap(24, 24), 24, 24, [])
    world.setGameplay({ throttled: false, buildMode: false, selKey: null })

    world.setCamera(12, 12, 30, 1.6)
    world.stream()
    for (let i = 0; i < 20; i++) world.pumpKits()
    expect([...world.kits.values()].some((kit) => kit.userData.detail === 'low')).toBe(true)

    world.setCamera(12, 12, 5, 1.6)
    world.stream()
    for (let i = 0; i < 20; i++) world.pumpKits()

    const closeKits = [...world.kits.values()].filter((kit) => {
      const dx = Number(kit.userData.x) - 12
      const dy = Number(kit.userData.y) - 12
      return Math.hypot(dx, dy) <= 8
    })
    expect(closeKits.length).toBeGreaterThan(0)
    expect(closeKits.every((kit) => kit.userData.detail === 'full')).toBe(true)
  })
})
