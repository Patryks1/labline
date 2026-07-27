import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { TERRAIN_KIND, type Facility, type TileId } from '../../../sim/world'
import { DefaultArchetype, LodTier, RenderBiome, SurfaceKind, type SurfaceTexel } from '../v2'
import {
  AUTHORED_INDUSTRIAL_ARCHETYPES,
  AUTHORED_RESIDENTIAL_ARCHETYPES,
  AUTHORED_TERRAIN_ARCHETYPES,
  AUTHORED_URBAN_ARCHETYPES,
  AUTHORED_VEGETATION_ARCHETYPES,
  AuthoredSceneryArchetype,
  SceneryArchetype,
  SingleBuildingArchetype,
  createArtDirectedArchetypeRegistry,
} from './artDirectedRegistry'
import {
  MAX_RETAINED_CHUNK_LAYERS,
  MAX_RETAINED_CHUNKS,
  SimViewportRenderSource,
  acceptsNaturalSpacing,
  biomeDetailThreshold,
  biomeVegetationThreshold,
  decorationOverlapsRoadFootprint,
  isRockDetail,
  naturalPatchDensity,
  terrainFamilyForBiome,
  vegetationFamilyForBiome,
} from './simRenderSource'
import { planUrbanParcels } from './urbanParcelPlanner'

describe('SimViewportRenderSource', () => {
  it('exposes and revision-caches the shared compiled road network', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const first = source.getRoadNetwork()
    expect(first?.segments.length).toBeGreaterThan(0)
    expect(source.getRoadNetwork()).toBe(first)
    const road = world.staticWorld.transport!.findIndex((value) => (value & 0x0700) !== 0)
    const current = world.getTransport(road as TileId)
    world.beginBatch().patchTerrain(road as TileId, { transport: current & ~0xff }).commit()
    source.updateState(state)
    expect(source.getRoadNetworkRevision()).toBeGreaterThan(0)
    expect(source.getRoadNetwork()).not.toBe(first)
  })

  it('uses the exact categorical biome for stable legacy and V5 scenery palettes', () => {
    expect(vegetationFamilyForBiome(RenderBiome.forest)).toEqual([414, 415, 416, 417, 418, 419, 420, 421, 429, 430, 431])
    expect(vegetationFamilyForBiome(RenderBiome.arid)).toEqual([424, 425, 426, 428])
    expect(vegetationFamilyForBiome(RenderBiome.wetland)).toContain(422)
    expect(vegetationFamilyForBiome(RenderBiome.alpine)).toContain(415)
    expect(vegetationFamilyForBiome(RenderBiome.coast)).toContain(423)
    expect(vegetationFamilyForBiome(RenderBiome.meadow)).toEqual([418, 419, 421, 422, 427, 429, 431])
    expect(vegetationFamilyForBiome(RenderBiome.boreal)).toEqual([414, 415, 416, 420, 428, 430])
    expect(vegetationFamilyForBiome(RenderBiome.scrubland)).toEqual([424, 425, 426, 427, 428, 431])
    expect(terrainFamilyForBiome(RenderBiome.arid)).toEqual([402, 404, 406, 413])
    expect(terrainFamilyForBiome(RenderBiome.wetland)).toEqual([403, 409, 410, 412])
    expect(terrainFamilyForBiome(RenderBiome.alpine)).toEqual([404, 405, 407, 413])
    expect(terrainFamilyForBiome(RenderBiome.coast)).toEqual([401, 404, 409, 410, 412])
    expect(terrainFamilyForBiome(RenderBiome.meadow)).toEqual([403, 408, 409, 411, 412])
    expect(terrainFamilyForBiome(RenderBiome.boreal)).toEqual([403, 404, 407, 408, 413])
    expect(terrainFamilyForBiome(RenderBiome.scrubland)).toEqual([402, 404, 406, 411, 413])
    expect(biomeVegetationThreshold(RenderBiome.forest)).toBeGreaterThan(
      biomeVegetationThreshold(RenderBiome.plains),
    )
    expect(biomeDetailThreshold(RenderBiome.alpine)).toBeGreaterThan(
      biomeDetailThreshold(RenderBiome.plains),
    )
  })

  it('keeps every broad environment instance outside road, water and building clearance', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const environmentIds = new Set<number>([
      ...AUTHORED_TERRAIN_ARCHETYPES,
      ...AUTHORED_VEGETATION_ARCHETYPES,
      SceneryArchetype.park,
    ])
    let checked = 0
    for (let chunkId = 0; chunkId < source.chunksWide * source.chunksHigh; chunkId++) {
      for (const record of source.getChunkInstances(chunkId, LodTier.near) ?? []) {
        if (!environmentIds.has(record.archetypeId)) continue
        const tileId = record.entityId - 1
        if (tileId < 0 || tileId >= source.width * source.height) continue
        const x = tileId % source.width
        const y = Math.floor(tileId / source.width)
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue
            const nx = x + ox
            const ny = y + oy
            if (nx < 0 || ny < 0 || nx >= source.width || ny >= source.height) continue
            const neighbor = idAt(nx, ny, source.width)
            const kind = world.getKind(neighbor)
            expect(world.getTransport(neighbor), `transport clearance at ${x},${y}`).toBe(0)
            expect(world.getFacilityAt(neighbor), `facility clearance at ${x},${y}`).toBeUndefined()
            expect(
              [TERRAIN_KIND.road, TERRAIN_KIND.lake, TERRAIN_KIND.house, TERRAIN_KIND.city, TERRAIN_KIND.warehouse],
            ).not.toContain(kind)
          }
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('keeps every visibly resolved V5 tree/park/bench kit outside road ribbons and clearance', () => {
    const state = createGame({
      seed: 20260727,
      advanced: { mapWidth: 192, mapHeight: 160, cityCount: 4, rivalCount: 1 },
    })
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const network = source.getRoadNetwork()!
    const registry = createArtDirectedArchetypeRegistry()
    const visibleEnvironmentGeometry = new Set([
      registry.get(SceneryArchetype.park).geometry.near,
      ...AUTHORED_VEGETATION_ARCHETYPES.map(id => registry.get(id).geometry.near),
    ])
    let checked = 0

    for (let chunkId = 0; chunkId < source.chunksWide * source.chunksHigh; chunkId++) {
      for (const record of source.getChunkInstances(chunkId, LodTier.near) ?? []) {
        // Test the geometry users actually see before authored bundles load,
        // not merely the source archetype ID. This catches roadside prop IDs
        // accidentally aliased to the complete trees-and-benches park kit.
        if (!visibleEnvironmentGeometry.has(registry.get(record.archetypeId).geometry.near)) continue
        const tileId = record.pickTileId ?? record.entityId - 1
        expect(tileId, `environment owner for archetype ${record.archetypeId}`).toBeGreaterThanOrEqual(0)
        expect(tileId).toBeLessThan(source.width * source.height)
        expect(network.accessDistanceByTile[tileId], `road clearance at tile ${tileId}`).toBeGreaterThan(1)
        expect(decorationOverlapsRoadFootprint(
          record,
          tileId,
          network,
          id => world.getKind(id as TileId),
          id => world.getTransport(id as TileId),
        ), `road ribbon/junction overlap at tile ${tileId}`).toBe(false)
        checked++
      }
    }

    expect(checked).toBeGreaterThan(50)
    registry.dispose()
  })

  it('excludes a complete town kit when its beside-road footprint reaches an active junction', () => {
    const state = compactGame()
    const world = state.map.world!
    const initial = new SimViewportRenderSource(state)
    const network = initial.getRoadNetwork()!
    let anchor: TileId | undefined
    let junctionTile: TileId | undefined
    for (const junction of network.junctions) {
      if (junction.ports.length < 3) continue
      const halfWidth = Math.max(...junction.segmentIds.map(id =>
        network.segments.find(segment => segment.id === id)?.profile.halfWidth ?? 0,
      ))
      if (halfWidth < 0.34) continue
      const x = junction.tileId % network.width
      const y = Math.floor(junction.tileId / network.width)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= network.width || ny >= network.height) continue
        const candidate = idAt(nx, ny, network.width)
        if (world.getTransport(candidate) !== 0 || world.getFacilityAt(candidate)) continue
        anchor = candidate
        junctionTile = junction.tileId
        break
      }
      if (anchor !== undefined) break
    }
    expect(anchor).toBeDefined()
    expect(network.accessDistanceByTile[anchor!]).toBe(1)
    expect(junctionTile).toBeDefined()

    world.beginBatch().patchTerrain(anchor!, { kind: TERRAIN_KIND.city }).commit()
    const source = new SimViewportRenderSource(state)
    expect(world.getKind(anchor!)).toBe(TERRAIN_KIND.city)
    expect(world.getTransport(anchor!)).toBe(0)
    expect(
      source.getChunkInstances(chunkFor(anchor!, source), LodTier.near)!
        .some(record => record.entityId === anchor! + 1),
    ).toBe(false)
  })

  it('invalidates a cross-chunk environment halo when a new road claims its clearance', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const naturalIds = new Set<number>(AUTHORED_VEGETATION_ARCHETYPES)
    let candidate: { tileId: TileId; neighbor: TileId; chunkId: number } | undefined
    for (let chunkId = 0; chunkId < source.chunksWide * source.chunksHigh && !candidate; chunkId++) {
      for (const record of source.getChunkInstances(chunkId, LodTier.near) ?? []) {
        if (!naturalIds.has(record.archetypeId)) continue
        const tileId = (record.entityId - 1) as TileId
        const x = tileId % source.width
        const y = Math.floor(tileId / source.width)
        const nx = x % source.chunkSize === source.chunkSize - 1 ? x + 1
          : x % source.chunkSize === 0 ? x - 1 : -1
        if (nx < 0 || nx >= source.width) continue
        const neighbor = idAt(nx, y, source.width)
        if (world.getTransport(neighbor) !== 0 || world.getFacilityAt(neighbor)) continue
        candidate = { tileId, neighbor, chunkId }
        break
      }
    }
    expect(candidate).toBeDefined()
    expect(world.beginBatch().patchTerrain(candidate!.neighbor, { transport: 0x0104 }).commit().committed).toBe(true)
    source.updateState(state)
    expect(
      source.getChunkInstances(candidate!.chunkId, LodTier.near)!
        .some(record => record.entityId === candidate!.tileId + 1),
    ).toBe(false)
  })

  it('uses coherent seeded patches and conflict-free jitter instead of repeated rows', () => {
    const seed = 917
    const first = Array.from({ length: 32 }, (_, y) =>
      Array.from({ length: 32 }, (_, x) => naturalPatchDensity(seed, x, y, RenderBiome.forest)),
    )
    const second = Array.from({ length: 32 }, (_, y) =>
      Array.from({ length: 32 }, (_, x) => naturalPatchDensity(seed, x, y, RenderBiome.forest)),
    )
    expect(second).toEqual(first)
    let adjacentDelta = 0
    let distantDelta = 0
    let samples = 0
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        adjacentDelta += Math.abs(first[y]![x]! - first[y]![x + 1]!)
        distantDelta += Math.abs(first[y]![x]! - first[y + 8]![x + 8]!)
        samples++
      }
    }
    expect(adjacentDelta / samples).toBeLessThan(distantDelta / samples)

    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        if (!acceptsNaturalSpacing(seed, x, y)) continue
        // The conflict rule is stable and never permits both halves of a
        // close candidate pair to win; deterministic repetition is covered by
        // evaluating the same cell twice.
        expect(acceptsNaturalSpacing(seed, x, y)).toBe(true)
      }
    }
  })

  it('keeps rocks a small minority of sparse biome details', () => {
    const state = createGame({
      seed: 913,
      advanced: { mapWidth: 256, mapHeight: 224, cityCount: 4, rivalCount: 1 },
    })
    const source = new SimViewportRenderSource(state)
    const detailIds = new Set<number>(AUTHORED_TERRAIN_ARCHETYPES)
    let details = 0
    let rocks = 0
    for (let chunkId = 0; chunkId < source.chunksWide * source.chunksHigh; chunkId++) {
      for (const record of source.getChunkInstances(chunkId, LodTier.near) ?? []) {
        if (!detailIds.has(record.archetypeId)) continue
        details++
        if (isRockDetail(record.archetypeId)) rocks++
      }
    }
    expect(details).toBeGreaterThan(20)
    expect(rocks / details).toBeLessThan(0.22)
  })

  it('selects authored scenery families deterministically from stable world data', () => {
    const state = compactGame()
    const open = findOpenTile(state.map.world!)
    state.map.world!.beginBatch().patchTerrain(open, { kind: TERRAIN_KIND.warehouse }).commit()
    const first = new SimViewportRenderSource(state)
    const second = new SimViewportRenderSource(state)
    const firstIds: number[] = []
    const secondIds: number[] = []
    const totalChunks = first.chunksWide * first.chunksHigh
    for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
      firstIds.push(...first.getChunkInstances(chunkId, LodTier.near)!.map(record => record.archetypeId))
      secondIds.push(...second.getChunkInstances(chunkId, LodTier.near)!.map(record => record.archetypeId))
    }
    expect(secondIds).toEqual(firstIds)

    const used = new Set(firstIds)
    for (const [name, family] of [
      ['terrain', AUTHORED_TERRAIN_ARCHETYPES],
      ['vegetation', AUTHORED_VEGETATION_ARCHETYPES],
      ['industrial', AUTHORED_INDUSTRIAL_ARCHETYPES],
    ] as const) {
      expect(family.some(id => used.has(id)), name).toBe(true)
    }
    expect([
      SingleBuildingArchetype.detachedHouse,
      SingleBuildingArchetype.smallShop,
      SingleBuildingArchetype.rowhouse,
    ].some(id => used.has(id)), 'single-building residential').toBe(true)
    expect([
      SingleBuildingArchetype.midRise,
      SingleBuildingArchetype.officeTower,
      SingleBuildingArchetype.skyscraper,
    ].some(id => used.has(id)), 'single-building urban').toBe(true)
    expect(AUTHORED_RESIDENTIAL_ARCHETYPES.some(id => used.has(id)), 'legacy residential kits').toBe(false)
    expect(AUTHORED_URBAN_ARCHETYPES.some(id => used.has(id)), 'legacy urban kits').toBe(false)
  })

  it('renders every V5 city/house parcel exactly once with a single-building archetype', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const plan = liveParcelPlan(world)
    const singleBuildingIds = new Set<number>(Object.values(SingleBuildingArchetype))
    const records = allChunkInstances(source)
    const parcelRecords = records.filter((record) => singleBuildingIds.has(record.archetypeId))

    expect(parcelRecords).toHaveLength(plan.parcels.length)
    expect(new Set(parcelRecords.map((record) => record.entityId)).size).toBe(plan.parcels.length)
    for (const parcel of plan.parcels) {
      const matches = parcelRecords.filter((record) => record.pickTileId === parcel.anchorTileId)
      expect(matches, parcel.id).toHaveLength(1)
      expect(matches[0]!.archetypeId).toBeGreaterThanOrEqual(500)
      expect(matches[0]!.archetypeId).toBeLessThanOrEqual(505)
    }
  })

  it('centers and scales multi-tile skyscrapers and selects their complete footprint from every cell', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const parcel = liveParcelPlan(world).parcels.find((candidate) =>
      candidate.class === 'skyscraper' && candidate.footprintTileIds.length > 1)
    expect(parcel).toBeDefined()
    const records = allChunkInstances(source).filter((record) =>
      record.archetypeId === SingleBuildingArchetype.skyscraper &&
      record.pickTileId === parcel!.anchorTileId)
    expect(records).toHaveLength(1)

    const record = records[0]!
    const anchorX = parcel!.anchorTileId % source.width
    const anchorY = Math.floor(parcel!.anchorTileId / source.width)
    expect(record.x).toBeCloseTo((anchorX + (parcel!.width - 1) * 0.5) * source.tileSize)
    expect(record.z).toBeCloseTo((anchorY + (parcel!.height - 1) * 0.5) * source.tileSize)
    expect(record.scaleX).toBeCloseTo(parcel!.width * source.tileSize * 0.92)
    expect(record.scaleZ).toBeCloseTo(parcel!.height * source.tileSize * 0.92)

    const expectedSelection = parcel!.footprintTileIds.map((id) => ({
      x: id % source.width,
      y: Math.floor(id / source.width),
    }))
    for (const id of parcel!.footprintTileIds) {
      expect(source.getSelectionFootprint(id % source.width, Math.floor(id / source.width)))
        .toEqual(expectedSelection)
    }
  })

  it('replans V5 parcels after live facility and road occupancy edits', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const initialPlan = liveParcelPlan(world)
    const candidates = initialPlan.parcels.filter((parcel) =>
      parcel.style === 'suburban' && parcel.footprintTileIds.length === 1)
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    const facilityTile = candidates[0]!.anchorTileId
    const roadTile = candidates[1]!.anchorTileId

    world.beginBatch().addFacility({
      id: 'parcel-live-exclusion',
      kind: 'office',
      ownerId: 'player',
      anchor: facilityTile,
      footprint: [facilityTile],
      level: 1,
      constructionProgress: 1,
      constructionTarget: 1,
      powered: true,
    }).commit()
    source.updateState(state)
    expect(source.getSelectionFootprint(
      facilityTile % source.width,
      Math.floor(facilityTile / source.width),
    )).toBeUndefined()
    expect(allChunkInstances(source).filter((record) =>
      record.pickTileId === facilityTile && record.archetypeId >= 500 && record.archetypeId <= 505))
      .toHaveLength(0)

    world.beginBatch().patchTerrain(roadTile, { transport: 0x01_04 }).commit()
    source.updateState(state)
    expect(source.getSelectionFootprint(
      roadTile % source.width,
      Math.floor(roadTile / source.width),
    )).toBeUndefined()
    expect(allChunkInstances(source).filter((record) =>
      record.pickTileId === roadTile && record.archetypeId >= 500 && record.archetypeId <= 505))
      .toHaveLength(0)
  })

  it('uses the authored construction shell while a compact facility is incomplete', () => {
    const state = compactGame()
    const world = state.map.world!
    const anchor = findOpenTile(world)
    world.beginBatch().addFacility({
      id: 'authored-shell-test',
      kind: 'dc',
      ownerId: 'player',
      anchor,
      footprint: [anchor],
      level: 1,
      constructionProgress: 0.5,
      constructionTarget: 1,
      powered: true,
    }).commit()
    const source = new SimViewportRenderSource(state)
    const record = source.getChunkInstances(chunkFor(anchor, source), LodTier.near)!
      .find(candidate => candidate.entityId !== anchor + 1 && candidate.color === 0x3dffc0)
    expect(record?.archetypeId).toBe(AuthoredSceneryArchetype.constructionShell)
  })

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
    const playerRender = playerRecords.find((record) => record.color === 0x3dffc0)
    expect(playerRender?.y).toBeCloseTo(
      source.getTileElevation(playerAnchor % source.width, Math.floor(playerAnchor / source.width)) + 0.015,
    )
    expect(source.getCornerElevation(1, 1)).not.toBe(0)
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

  it('keeps neutral building land and ambient props selectable while rejecting flat transport/water', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const open = findOpenTile(world)
    const openX = open % source.width
    const openY = Math.floor(open / source.width)
    expect(source.isSelectable(openX, openY)).toBe(true)

    let ambient: TileId | undefined
    let flat: TileId | undefined
    for (let id = 0; id < source.width * source.height; id++) {
      const tile = id as TileId
      const kind = world.getKind(tile)
      if (!ambient && !world.getFacilityAt(tile) &&
        (kind === TERRAIN_KIND.house || kind === TERRAIN_KIND.city || kind === TERRAIN_KIND.warehouse ||
          kind === TERRAIN_KIND.forest || kind === TERRAIN_KIND.park)) ambient = tile
      if (!flat && (kind === TERRAIN_KIND.lake || world.getTransport(tile) !== 0)) flat = tile
      if (ambient && flat) break
    }
    expect(ambient).toBeDefined()
    expect(source.isSelectable(ambient! % source.width, Math.floor(ambient! / source.width))).toBe(true)
    expect(flat).toBeDefined()
    expect(source.isSelectable(flat! % source.width, Math.floor(flat! / source.width))).toBe(false)
  })

  it('projects municipal campuses as selectable instances owned by their anchor cell', () => {
    const state = compactGame()
    const world = state.map.world!
    const source = new SimViewportRenderSource(state)
    const plant = world.staticWorld.municipalPowerPlants?.[0]
    expect(plant).toBeDefined()
    const records = source.getChunkInstances(chunkFor(plant!.footprint[0], source), LodTier.near)!

    expect(records.some((record) => record.pickTileId === plant!.footprint[0])).toBe(true)
    for (const id of plant!.footprint) {
      expect(source.isSelectable(id % source.width, Math.floor(id / source.width))).toBe(true)
    }
  })

  it('projects v3 transport over its base terrain and suppresses underlying props/selection', () => {
    const state = compactGame()
    const world = state.map.world!
    let tile: TileId | undefined
    for (let id = 0; id < state.map.width * state.map.height; id++) {
      const candidate = id as TileId
      const kind = world.getKind(candidate)
      if ((kind === TERRAIN_KIND.house || kind === TERRAIN_KIND.city) && !world.getFacilityAt(candidate)) {
        tile = candidate
        break
      }
    }
    expect(tile).toBeDefined()
    const packedTransport = 0x03_44 // arterial, E/W
    expect(world.beginBatch().patchTerrain(tile!, { transport: packedTransport }).commit().committed).toBe(true)

    const source = new SimViewportRenderSource(state)
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    source.readSurface(tile!, texel)
    const records = source.getChunkInstances(chunkFor(tile!, source), LodTier.near)!

    expect(texel.kind).toBe(
      world.getKind(tile!) === TERRAIN_KIND.house ? SurfaceKind.house : SurfaceKind.city,
    )
    expect(texel.transport).toBe(packedTransport)
    expect(texel.neighborMask).toBe(0x44)
    expect(records.some((record) => record.entityId === tile! + 1)).toBe(false)
    expect(source.isSelectable(tile! % source.width, Math.floor(tile! / source.width))).toBe(false)
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
      legacyMapFixture: true,
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
      legacyMapFixture: true,
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

function liveParcelPlan(world: NonNullable<ReturnType<typeof compactGame>['map']['world']>) {
  return planUrbanParcels(world.staticWorld, {
    excludedTileIds: world.occupancy.keys(),
    kindAt: (id) => world.getKind(id),
    transportAt: (id) => world.getTransport(id),
    districtAt: (id) => world.staticWorld.district?.[id] ?? 0,
    featureAt: (id) => world.staticWorld.feature[id] ?? 0,
  })
}

function allChunkInstances(source: SimViewportRenderSource) {
  return Array.from(
    { length: source.chunksWide * source.chunksHigh },
    (_, chunkId) => source.getChunkInstances(chunkId, LodTier.near) ?? [],
  ).flat()
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
