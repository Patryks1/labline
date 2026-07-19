import { describe, expect, it } from 'vitest'
import {
  InstancedChunk,
  createDefaultArchetypeRegistry,
  DefaultArchetype,
} from './archetypes'
import { ViewportChunkManager } from './chunks'
import { chunkIdAt, LodTier, type RenderInstance } from './types'

describe('viewport chunks', () => {
  it('selects exact 32x32 visible chunks and one non-rendered prefetch ring', () => {
    const manager = new ViewportChunkManager(1000, 1000)
    const one = manager.update({ minX: 32, maxX: 64, minY: 32, maxY: 64 })
    const center = chunkIdAt(1, 1, manager.chunksWide)
    expect([...one.visible]).toEqual([center])
    expect(one.prefetch.size).toBe(8)
    expect(one.prefetch.has(center)).toBe(false)

    const crossing = manager.update({ minX: 31, maxX: 65, minY: 31, maxY: 65 })
    expect(crossing.visible.size).toBe(9)
    expect(crossing.prefetch.size).toBe(7)
  })

  it('clamps selection at map edges and reports partial edge-chunk bounds', () => {
    const manager = new ViewportChunkManager(1000, 1000)
    const edge = manager.update({ minX: 992, maxX: 1100, minY: 992, maxY: 1100 })
    expect(edge.visible.size).toBe(1)
    const id = [...edge.visible][0]!
    expect(manager.chunkBounds(id)).toEqual({ minX: 992, maxX: 1000, minY: 992, maxY: 1000 })
    expect(edge.prefetch.size).toBe(3)
  })

  it('truncates prefetch admission so protected residency respects its cap', () => {
    const manager = new ViewportChunkManager(1000, 1000, 32, 5)
    const selected = manager.update({ minX: 32, maxX: 64, minY: 32, maxY: 64 })

    expect(selected.visible.size).toBe(1)
    expect(selected.prefetch.size).toBe(4)
    expect(selected.resident.size).toBe(5)
  })

  it('derives each InstancedMesh capacity from actual chunk contents', () => {
    const registry = createDefaultArchetypeRegistry()
    const records: RenderInstance[] = [
      instance(1, DefaultArchetype.tree, 0, 0),
      instance(2, DefaultArchetype.tree, 1, 0),
      instance(3, DefaultArchetype.tree, 2, 0),
      instance(4, DefaultArchetype.house, 0, 1),
      instance(5, DefaultArchetype.house, 1, 1),
    ]
    const chunk = new InstancedChunk(0, LodTier.near, 7, records, registry)

    expect(chunk.stats.instances).toBe(5)
    expect(chunk.stats.capacity).toBe(5)
    expect(chunk.stats.drawCalls).toBe(2)
    expect(chunk.capacityFor(DefaultArchetype.tree)).toBe(3)
    expect(chunk.capacityFor(DefaultArchetype.house)).toBe(2)

    chunk.dispose()
    registry.dispose()
  })
})

function instance(
  entityId: number,
  archetypeId: number,
  x: number,
  z: number,
): RenderInstance {
  return {
    entityId,
    archetypeId,
    x,
    y: 0,
    z,
    yaw: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    color: 0xffffff,
  }
}
