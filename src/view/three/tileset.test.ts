import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createBuildingKit } from './buildingKits'
import { buildKindIndex, neighborsAt } from './tileNeighbors'
import { generateProceduralMap, roadsConnectCities } from '../../sim/systems/mapGen'
import { defaultGameConfig } from '../../sim/balance/gameConfig'

describe('tileset auto-tiling', () => {
  it('neighbor mask is full for interior lake cells in a multi-tile lake', () => {
    const cfg = { ...defaultGameConfig(), seed: 77, mapWidth: 40, mapHeight: 40, cityCount: 2 }
    const map = generateProceduralMap(cfg)
    const index = buildKindIndex(map.tiles)
    const lakes = map.tiles.filter((t) => t.kind === 'lake')
    expect(lakes.length).toBeGreaterThan(8)

    // At least one interior lake (4 neighbors) should exist on coherent bodies
    const interiors = lakes.filter((t) => neighborsAt(index, t.x, t.y, 'lake').count === 4)
    expect(interiors.length).toBeGreaterThan(0)

    // Edge lakes have fewer connections
    const edges = lakes.filter((t) => {
      const n = neighborsAt(index, t.x, t.y, 'lake')
      return n.count > 0 && n.count < 4
    })
    expect(edges.length).toBeGreaterThan(0)
  })

  it('generates compact connected lake basins instead of one-tile ribbons', () => {
    for (const seed of [2, 11, 19, 41, 77, 103]) {
      const map = generateProceduralMap({
        ...defaultGameConfig(),
        seed,
        mapWidth: 60,
        mapHeight: 60,
        cityCount: 2,
      })
      const remaining = new Set(map.tiles.filter((tile) => tile.kind === 'lake').map((tile) => `${tile.x},${tile.y}`))
      const components: Array<Array<{ x: number; y: number }>> = []

      while (remaining.size) {
        const start = remaining.values().next().value as string
        const queue = [start]
        const component: Array<{ x: number; y: number }> = []
        remaining.delete(start)
        while (queue.length) {
          const current = queue.pop()!
          const [x, y] = current.split(',').map(Number) as [number, number]
          component.push({ x, y })
          for (const neighbor of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
            if (!remaining.delete(neighbor)) continue
            queue.push(neighbor)
          }
        }
        components.push(component)
      }

      expect(components.length).toBeGreaterThan(0)
      for (const component of components.filter((cells) => cells.length >= 5)) {
        const xs = component.map((cell) => cell.x)
        const ys = component.map((cell) => cell.y)
        const spanX = Math.max(...xs) - Math.min(...xs) + 1
        const spanY = Math.max(...ys) - Math.min(...ys) + 1
        expect(Math.min(spanX, spanY)).toBeGreaterThanOrEqual(2)
        expect(component.length / (spanX * spanY)).toBeGreaterThan(0.38)
      }
    }
  })

  it('road kits connect based on neighbor mask and may include traffic', () => {
    const nAll = { n: true, e: true, s: true, w: true, mask: 15, count: 4 }
    const cross = createBuildingKit('road', 0x333, 0.1, 5, 5, nAll)
    expect(cross.children.length).toBeGreaterThan(2)

    const nNs = { n: true, e: false, s: true, w: false, mask: 5, count: 2 }
    const ns = createBuildingKit('road', 0x333, 0.1, 1, 2, nNs)
    expect(ns.children.length).toBeGreaterThan(1)
  })

  it('lake interior kit is seamless full-water (more water, less shore props)', () => {
    const interior = { n: true, e: true, s: true, w: true, mask: 15, count: 4 }
    const edge = { n: false, e: true, s: true, w: true, mask: 14, count: 3 }
    const a = createBuildingKit('lake', 0x1a6a9a, 0.14, 3, 3, interior)
    const b = createBuildingKit('lake', 0x1a6a9a, 0.14, 4, 3, edge)
    expect(a).toBeInstanceOf(THREE.Group)
    expect(b).toBeInstanceOf(THREE.Group)
    // Edge kits should have more meshes (shore banks)
    expect(b.children.length).toBeGreaterThanOrEqual(a.children.length)
  })

  it('roads-first: cities sit on road network and cities are connected', () => {
    const map = generateProceduralMap({
      ...defaultGameConfig(),
      seed: 11,
      mapWidth: 48,
      mapHeight: 48,
      cityCount: 3,
    })
    const cityTiles = map.tiles.filter((t) => t.kind === 'city')
    const roadTiles = map.tiles.filter((t) => t.kind === 'road')
    expect(map.cities.length).toBe(3)
    expect(cityTiles.length).toBeGreaterThan(12)
    expect(roadTiles.length).toBeGreaterThan(40)

    // Every city tile must be adjacent to a road (or be road itself — not)
    const roadSet = new Set(roadTiles.map((t) => `${t.x},${t.y}`))
    const adj = (x: number, y: number) =>
      roadSet.has(`${x + 1},${y}`) ||
      roadSet.has(`${x - 1},${y}`) ||
      roadSet.has(`${x},${y + 1}`) ||
      roadSet.has(`${x},${y - 1}`)
    const cityOnNetwork = cityTiles.filter((t) => adj(t.x, t.y))
    expect(cityOnNetwork.length / cityTiles.length).toBeGreaterThan(0.85)

    // Highways connect city anchors
    const c0 = map.cities[0]!
    const c1 = map.cities[1]!
    expect(roadsConnectCities(map.tiles, map.width, map.height, c0, c1)).toBe(true)
  })

  it('empty grass kits are not near-black', () => {
    const g = createBuildingKit('empty', 0x2a4a32, 0.06, 0, 0)
    const ground = g.children[0] as THREE.Mesh
    const mat = ground.material as THREE.MeshStandardMaterial
    expect(mat.color.getHex()).toBeGreaterThan(0x101010)
  })
})
