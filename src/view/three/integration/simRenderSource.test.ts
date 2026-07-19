import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { TERRAIN_KIND, type Facility, type TileId } from '../../../sim/world'
import { DefaultArchetype, LodTier, SurfaceKind, type SurfaceTexel } from '../v2'
import {
  MAX_RETAINED_CHUNK_LAYERS,
  MAX_RETAINED_CHUNKS,
  SimViewportRenderSource,
} from './simRenderSource'

describe('SimViewportRenderSource', () => {
  it('projects compact player and rival facilities through the same instanced path', () => {
    const state = compactGame()
    const world = state.map.world!
    const playerAnchor = findOpenTile(world)
    const playerFacility: Facility = {
      id: 'player-render-test',
      kind: 'dc',
      ownerId: 'player',
      anchor: playerAnchor,
      footprint: [playerAnchor],
      level: 1,
      constructionProgress: 1,
      constructionTarget: 1,
      powered: true,
    }
    world.beginBatch().addFacility(playerFacility).commit()
    const rivalFacility = world.queryFacilities().find((facility) => facility.ownerId !== 'player')
    expect(rivalFacility).toBeDefined()

    const source = new SimViewportRenderSource(state)
    const playerRecords = source.getChunkInstances(chunkFor(playerAnchor, source), LodTier.near)!
    const rivalRecords = source.getChunkInstances(
      chunkFor(rivalFacility!.anchor, source),
      LodTier.near,
    )!

    expect(playerRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          archetypeId: DefaultArchetype.facilitySmall,
          color: 0x3dffc0,
        }),
      ]),
    )
    expect(rivalRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          archetypeId: DefaultArchetype.facilitySmall,
          color: state.rivals[0]!.color,
        }),
      ]),
    )
  })

  it('consumes compact journal deltas and invalidates only touched surface/chunks', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const tile = findOpenTile(world)
    const chunk = chunkFor(tile, source)
    const beforeRevision = source.getChunkRevision(chunk)
    const beforeSurfaceRevision = source.getSurfaceRevision(chunk)

    const commit = world.beginBatch().patchTerrain(tile, { kind: TERRAIN_KIND.road }).commit()
    expect(commit.committed).toBe(true)
    const nextState = {
      ...state,
      map: { ...state.map, worldRevision: commit.revision },
    }
    const delta = source.updateState(nextState)
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    source.readSurface(tile, texel)

    expect(delta.replaceSource).toBe(false)
    expect(delta.entireSurface).toBe(false)
    expect(delta.surfaceTileIds).toContain(tile)
    expect(delta.chunkIds).toContain(chunk)
    expect(source.getChunkRevision(chunk)).toBeGreaterThan(beforeRevision)
    expect(source.getSurfaceRevision(chunk)).toBeGreaterThan(beforeSurfaceRevision)
    expect(texel.kind).toBe(SurfaceKind.road)
  })

  it('keeps neutral compact building land selectable while rejecting neutral scenery', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const open = findOpenTile(world)
    const openX = open % source.width
    const openY = Math.floor(open / source.width)
    expect(source.isSelectable(openX, openY)).toBe(true)

    let scenic: TileId | undefined
    for (let id = 0; id < source.width * source.height; id++) {
      if (world.getKind(id as TileId) !== TERRAIN_KIND.empty && !world.getFacilityAt(id as TileId)) {
        scenic = id as TileId
        break
      }
    }
    expect(scenic).toBeDefined()
    expect(source.isSelectable(scenic! % source.width, Math.floor(scenic! / source.width))).toBe(false)
  })

  it('does not invalidate surface-derived traffic for facility-only state changes', () => {
    const state = compactGame()
    const world = state.map.world!
    const facility = world.queryFacilities()[0]!
    const source = new SimViewportRenderSource(state)
    const chunk = chunkFor(facility.anchor, source)
    const beforeProps = source.getChunkRevision(chunk)
    const beforeSurface = source.getSurfaceRevision(chunk)

    const commit = world
      .beginBatch()
      .updateFacility(facility.id, { powered: !facility.powered })
      .commit()
    source.updateState({
      ...state,
      map: { ...state.map, worldRevision: commit.revision },
    })

    expect(source.getChunkRevision(chunk)).toBeGreaterThan(beforeProps)
    expect(source.getSurfaceRevision(chunk)).toBe(beforeSurface)
  })

  it('keeps legacy chunk snapshots stable until a visual tile revision changes', () => {
    const state = createGame({
      seed: 44,
      advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
    })
    const source = new SimViewportRenderSource(state)
    const first = source.getChunkInstances(0, LodTier.near)
    const second = source.getChunkInstances(0, LodTier.near)
    expect(first).toBe(second)

    const tile = state.map.tiles[0]!
    const changedTile = { ...tile, level: tile.level + 1 }
    const nextTiles = [...state.map.tiles]
    nextTiles[0] = changedTile
    const delta = source.updateState({
      ...state,
      map: { ...state.map, tiles: nextTiles },
    })
    expect(delta.surfaceTileIds).toContain(0)
    expect(source.getChunkInstances(0, LodTier.near)).not.toBe(first)
  })

  it('renders a legacy large data center as one full 3x2 campus model', () => {
    const state = createGame({
      seed: 91,
      advanced: { mapWidth: 60, mapHeight: 60, cityCount: 2, rivalCount: 1 },
    })
    expect(state.map.storage).toBe('legacy')

    const tileByCoordinate = new Map(state.map.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]))
    const anchor = state.map.tiles.find((tile) =>
      [
        [0, 0], [1, 0], [2, 0],
        [0, 1], [1, 1], [2, 1],
      ].every(([dx, dy]) => tileByCoordinate.get(`${tile.x + dx},${tile.y + dy}`)?.kind === 'empty'),
    )
    expect(anchor).toBeDefined()
    const campusCoordinates = new Set(
      [
        [0, 0], [1, 0], [2, 0],
        [0, 1], [1, 1], [2, 1],
      ].map(([dx, dy]) => `${anchor!.x + dx},${anchor!.y + dy}`),
    )
    const campusId = 'legacy-large-render-test'
    const placed = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          campusCoordinates.has(`${tile.x},${tile.y}`)
            ? {
                ...tile,
                kind: 'dc_l' as const,
                owner: 'player' as const,
                campusId,
                campusRole: tile.x === anchor!.x && tile.y === anchor!.y ? 'anchor' as const : 'pad' as const,
                dcSize: 'large' as const,
                buildingProgress: 1,
                buildingTarget: 1,
              }
            : tile,
        ),
      },
    }
    const source = new SimViewportRenderSource(placed)
    const records = Array.from(
      { length: source.chunksWide * source.chunksHigh },
      (_, chunkId) => source.getChunkInstances(chunkId, LodTier.near) ?? [],
    ).flat()
    const campus = records.find(
      (record) =>
        record.archetypeId === DefaultArchetype.facilityLarge &&
        record.color === 0x3dffc0,
    )

    expect(campus).toBeDefined()
    expect(campus!.x).toBeCloseTo((anchor!.x + 1) * source.tileSize)
    expect(campus!.z).toBeCloseTo((anchor!.y + 0.5) * source.tileSize)
    expect(campus!.scaleX).toBeCloseTo(3 * source.tileSize * 0.82)
    expect(campus!.scaleZ).toBeCloseTo(2 * source.tileSize * 0.82)
  })

  it('bounds cached prop snapshots while traversing more than 96 chunks and all tiers', () => {
    const state = createGame({
      seed: 88,
      advanced: { mapWidth: 352, mapHeight: 320, cityCount: 4, rivalCount: 1 },
    })
    const source = new SimViewportRenderSource(state)
    const totalChunks = source.chunksWide * source.chunksHigh
    expect(totalChunks).toBeGreaterThan(96)

    for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
      source.getChunkInstances(chunkId, LodTier.near)
    }
    expect(source.cachedChunkCount).toBe(MAX_RETAINED_CHUNKS)
    expect(source.cachedChunkLayerCount).toBe(MAX_RETAINED_CHUNKS)

    for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
      source.getChunkInstances(chunkId, LodTier.near)
      source.getChunkInstances(chunkId, LodTier.mid)
      source.getChunkInstances(chunkId, LodTier.far)
    }

    expect(source.cachedChunkCount).toBe(MAX_RETAINED_CHUNKS)
    expect(source.cachedChunkLayerCount).toBeLessThanOrEqual(MAX_RETAINED_CHUNK_LAYERS)
  })

  it('renders a 3x2 facility crossing a 32-tile seam exactly once from its centroid chunk', () => {
    const state = compactGame()
    const world = state.map.world!
    let anchorY = -1
    let footprint: TileId[] = []
    for (let y = 4; y < 26; y++) {
      const candidate = [
        idAt(31, y, 128), idAt(32, y, 128), idAt(33, y, 128),
        idAt(31, y + 1, 128), idAt(32, y + 1, 128), idAt(33, y + 1, 128),
      ]
      if (candidate.every((tile) => !world.getFacilityAt(tile))) {
        anchorY = y
        footprint = candidate
        break
      }
    }
    expect(anchorY).toBeGreaterThanOrEqual(0)
    const facility: Facility = {
      id: 'seam-dc-large',
      kind: 'dc_l',
      ownerId: 'player',
      anchor: footprint[0]!,
      footprint,
      level: 1,
      constructionProgress: 1,
      constructionTarget: 1,
      powered: true,
      data: { dcSize: 'large' },
    }
    world.beginBatch().addFacility(facility).commit()
    const source = new SimViewportRenderSource(state)
    const chunkRow = Math.floor(Math.round(anchorY + 0.5) / source.chunkSize)
    const anchorChunk = chunkRow * source.chunksWide
    const centroidChunk = anchorChunk + 1
    const expectedX = 32 * source.tileSize
    const expectedZ = (anchorY + 0.5) * source.tileSize
    const matches = (record: { archetypeId: number; x: number; z: number }) =>
      record.archetypeId === DefaultArchetype.facilityLarge &&
      Math.abs(record.x - expectedX) < 0.0001 &&
      Math.abs(record.z - expectedZ) < 0.0001

    const anchorRecords = source.getChunkInstances(anchorChunk, LodTier.near)!
    const centroidRecords = source.getChunkInstances(centroidChunk, LodTier.near)!
    expect(anchorRecords.filter(matches)).toHaveLength(0)
    expect(centroidRecords.filter(matches)).toHaveLength(1)
  })
})

function compactGame() {
  return createGame({
    seed: 77,
    advanced: { mapWidth: 128, mapHeight: 128, cityCount: 3, rivalCount: 1 },
  })
}

function findOpenTile(world: NonNullable<ReturnType<typeof compactGame>['map']['world']>): TileId {
  for (let id = 0; id < world.descriptor.width * world.descriptor.height; id++) {
    const tile = id as TileId
    if (world.getKind(tile) === TERRAIN_KIND.empty && !world.getFacilityAt(tile)) return tile
  }
  throw new Error('fixture has no open tile')
}

function chunkFor(tile: number, source: SimViewportRenderSource): number {
  const x = tile % source.width
  const y = Math.floor(tile / source.width)
  return Math.floor(y / source.chunkSize) * source.chunksWide + Math.floor(x / source.chunkSize)
}

function idAt(x: number, y: number, width: number): TileId {
  return (y * width + x) as TileId
}
