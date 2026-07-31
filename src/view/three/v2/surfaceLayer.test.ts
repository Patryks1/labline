import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { TRANSPORT_CLASS_SHIFT, TRANSPORT_FLAGS, TRANSPORT_ROAD_CLASS, WORLD_FORMAT_VERSION, WORLD_GENERATOR_VERSION_V3, compileRoadNetwork, type StaticWorld } from '../../../sim/world'
import { appendJunctionCrosswalks, MapSurfaceLayer } from './surfaceLayer'
import { LodTier, RenderBiome, SurfaceFlag, SurfaceKind, TransportVisual, type ChunkId, type SurfaceTexel, type ViewportRenderSource } from './types'

describe('MapSurfaceLayer road autotiling', () => {
  it('builds five real zebra stripes across every selected junction approach', () => {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const groups: Array<{ start: number; count: number; materialIndex: number }> = []
    appendJunctionCrosswalks(positions, uvs, indices, groups, {
      index: 0, id: 'junction:test', tileId: 0 as never, x: 4.5, y: 4.5, elevation: 0,
      segmentIds: ['n', 'e', 's', 'w'],
      ports: [
        { segmentId: 'n', tileId: 0 as never, headingX: 0, headingY: -1 },
        { segmentId: 'e', tileId: 0 as never, headingX: 1, headingY: 0 },
        { segmentId: 's', tileId: 0 as never, headingX: 0, headingY: 1 },
        { segmentId: 'w', tileId: 0 as never, headingX: -1, headingY: 0 },
      ],
      signalized: true, hasCrosswalks: true, hasStopLines: true,
    }, 0.25, 1, () => 0)

    expect(groups).toHaveLength(20)
    expect(groups.every((group) => group.count === 6 && group.materialIndex === 2)).toBe(true)
    expect(indices).toHaveLength(120)
    expect(positions).toHaveLength(20 * 4 * 3)
    expect(uvs).toHaveLength(20 * 4 * 2)
  })

  it('decodes transport mode and maps all clockwise topology bits to rounded arms', () => {
    const surface = new MapSurfaceLayer({ width: 2, height: 2, tileSize: 1 })
    const shader = surface.material.fragmentShader

    expect(shader).toContain('float transportMode = step(127.5, bytes.r)')
    expect(shader).toContain('float kind = mod(bytes.r, 16.0)')
    expect(shader).toContain('float style = floor(mod(bytes.r, 128.0) / 16.0) * transportMode')
    expect(shader).toContain('segmentProjection(p, vec2(0.5), endpoint)')
    expect(shader).toContain('vec2(0.5, 0.0), bitSet(mask, 1.0)')
    expect(shader).toContain('vec2(1.0, 0.0), bitSet(mask, 2.0)')
    expect(shader).toContain('vec2(1.0, 0.5), bitSet(mask, 4.0)')
    expect(shader).toContain('vec2(1.0, 1.0), bitSet(mask, 8.0)')
    expect(shader).toContain('vec2(0.5, 1.0), bitSet(mask, 16.0)')
    expect(shader).toContain('vec2(0.0, 1.0), bitSet(mask, 32.0)')
    expect(shader).toContain('vec2(0.0, 0.5), bitSet(mask, 64.0)')
    expect(shader).toContain('vec2(0.0, 0.0), bitSet(mask, 128.0)')

    surface.dispose()
  })

  it('keeps legacy roads and includes class widths, medians, shoulders, and bridge decks', () => {
    const surface = new MapSurfaceLayer({ width: 1, height: 1, tileSize: 1 })
    const shader = surface.material.fragmentShader

    expect(shader).toContain('float legacyRoad = (1.0 - transportMode)')
    expect(shader).toContain('if (uRenderTransportRoads > 0.5)')
    expect(shader).toContain('float legacyMask = bitSet(mask, 1.0)')
    expect(shader).toContain('bitSet(mask, 8.0) * 64.0')
    expect(shader).toContain('float roadClass = mix(1.0, mod(style, 4.0) + 1.0, transportMode)')
    expect(shader).toContain('float halfWidth = mix(0.145, 0.255')
    expect(shader).toContain('float bridge = step(3.5, style)')
    expect(shader).toContain('float roadEdge = signedFill(roadDistance - 0.018)')
    expect(shader).toContain('float median = markings * step(3.5, roadClass)')

    surface.dispose()
  })

  it('tapers every class to continuous tile-boundary geometry and never dots markings', () => {
    const surface = new MapSurfaceLayer({ width: 1, height: 1, tileSize: 1 })
    const shader = surface.material.fragmentShader

    expect(shader).toContain('const float seamWidth = 0.185')
    expect(shader).toContain('smoothstep(0.35, 0.94, projection.y)')
    expect(shader).toContain('float roadDistance = roadSignedDistance8')
    expect(shader.match(/roadSignedDistance8\(local/g)).toHaveLength(1)
    expect(shader).toContain('const float seamLineWidth = 0.011')
    expect(shader).toContain('float intersection = step(2.5, connectedArmCount(roadMask))')
    expect(shader).not.toContain('float dash =')
    expect(shader).not.toContain('rampChevron')

    surface.dispose()
  })

  it('uses white dashed road markings and hides them at overview zoom', () => {
    const surface = new MapSurfaceLayer({ width: 1, height: 1, tileSize: 1 })
    const marking = surface['roadMaterials'][2]!

    expect(marking.color.getHex()).toBe(0xf4f2e9)
    expect(marking.transparent).toBe(true)
    surface.setFrame(0, 23)
    expect(marking.visible).toBe(false)
    expect(marking.opacity).toBe(0)
    surface.setFrame(0, 26)
    expect(marking.visible).toBe(true)
    expect(marking.opacity).toBeCloseTo(0.5)
    surface.setFrame(0, 29)
    expect(marking.opacity).toBe(1)

    surface.dispose()
  })

  it('lights actual heightfield slopes and keeps water out of the terrain shader', () => {
    const surface = new MapSurfaceLayer({ width: 3, height: 2, tileSize: 1.25 })
    const shader = surface.material.fragmentShader

    expect(shader).toContain('cross(dFdy(vWorldPosition), dFdx(vWorldPosition))')
    expect(shader).toContain('float soilPatch =')
    expect(shader).toContain('float exposedSlope =')
    expect(shader).not.toContain('vec3 deepWater')
    expect(surface.waterRoot.name).toBe('map-independent-water-chunks')

    surface.dispose()
  })

  it('blends biome display colors while preserving an independent categorical texture', () => {
    const source = testSource()
    const surface = new MapSurfaceLayer({ width: 2, height: 2, tileSize: 1, source })
    const shader = surface.material.fragmentShader

    expect([...surface.biomeData.data]).toEqual([
      RenderBiome.plains,
      RenderBiome.forest,
      RenderBiome.arid,
      RenderBiome.coast,
    ])
    expect(shader).toContain('uniform highp sampler2D uBiomeState')
    expect(shader).toContain('vec3 biomePalette(float biome)')
    expect(shader).toContain('float biomeAt(ivec2 tile)')
    expect(shader).toContain('float biomeKernel(float distanceToCenter)')
    expect(shader).toContain('abs(distanceToCenter) / 2.0')
    expect(shader).toContain('vec3 biomeGround(vec2 tileCoord, float region, out vec4 climate)')
    expect(shader).toContain('warp * 0.34')
    expect(shader).toContain('for (int oy = -2; oy <= 2; oy++)')
    expect(shader).toContain('for (int ox = -2; ox <= 2; ox++)')
    expect(shader).toContain('climate /= max(totalWeight, 0.0001)')
    expect(shader).toContain('vWorldXZ / uTileSize + vec2(0.5)')
    expect(shader).not.toContain('vMapUv * uMapSize')
    expect(shader).toContain('float biome = floor(texelFetch(uBiomeState, tile, 0).r * 255.0 + 0.5)')
    expect(shader).toContain('vec3 grass = biomeGround(tileCoord, region, biomeInfluence)')
    expect(shader).toContain('float aridness = biomeInfluence.x')
    expect(shader).toContain('float moisture = biomeInfluence.y')
    expect(shader).toContain('float rockiness = biomeInfluence.z')
    expect(shader).toContain('float coastSand = biomeInfluence.w')
    expect(surface.biomeData.texture.minFilter).toBe(THREE.NearestFilter)
    expect(surface.biomeData.texture.generateMipmaps).toBe(false)
    expect(surface.material.uniforms.uBiomeState!.value).toBe(surface.biomeData.texture)
    expect(surface.material.uniforms.uTileSize!.value).toBe(1)
    surface.dispose()
  })

  it('builds raycastable 3d terrain with separate water and bridge geometry', () => {
    const source = testSource()
    const surface = new MapSurfaceLayer({ width: 2, height: 2, tileSize: 1, source, chunkSize: 2 })
    surface.updateVisibleChunks(new Set([0]), () => ({ minX: 0, maxX: 2, minY: 0, maxY: 2 }))

    const positions = surface.geometry.getAttribute('position')
    const heights = Array.from({ length: positions.count }, (_, index) => positions.getY(index))
    expect(Math.max(...heights)).toBeGreaterThan(0)
    expect(surface.terrainRoot.children).toHaveLength(1)
    expect(surface.waterRoot.children).toHaveLength(1)
    expect(surface.foamRoot.children).toHaveLength(1)
    expect(surface.bridgeRoot.children).toHaveLength(1)
    expect(surface.roadRoot.children).toHaveLength(0)
    expect(surface.pickObjects).toEqual([surface.terrainRoot, surface.bridgeRoot])

    const foam = surface.foamRoot.children[0] as THREE.Mesh
    expect(foam.name).toBe('shoreline-foam-0')
    expect((foam.material as THREE.MeshStandardMaterial).name).toBe('tasteful-shoreline-foam')
    expect((foam.material as THREE.MeshStandardMaterial).depthWrite).toBe(false)

    const water = surface.waterRoot.children[0] as THREE.Mesh
    const waterPositions = water.geometry.getAttribute('position')
    const waterHeights = Array.from({ length: waterPositions.count }, (_, index) => waterPositions.getY(index))
    // The isolated test lake owns four exposed edges. Its water and foam are
    // recessed below the canonical 0.18 water level instead of riding above
    // the raised shoreline, while foam remains just above the water itself.
    expect(Math.max(...waterHeights)).toBeCloseTo(0.172)
    const foamPositions = foam.geometry.getAttribute('position')
    const foamHeights = Array.from({ length: foamPositions.count }, (_, index) => foamPositions.getY(index))
    expect(Math.min(...foamHeights)).toBeCloseTo(0.178)
    expect(Math.min(...foamHeights)).toBeGreaterThan(Math.max(...waterHeights))

    // One vertex per immutable lattice corner is sufficient: interpolated
    // half-tile vertices carried no additional terrain information.
    expect(positions.count).toBe(9)
    expect(surface.geometry.index?.count).toBe(24)
    expect(surface.geometry.index?.array).toBeInstanceOf(Uint16Array)

    surface.dispose()
  })

  it('animates water ripples and freezes their clock while simulation is paused', () => {
    const surface = new MapSurfaceLayer({ width: 1, height: 1, tileSize: 1 })
    const water = surface['waterMaterial']
    const time = water.userData.waterTime as { value: number }

    expect(water.customProgramCacheKey()).toBe('labline-independent-water-v3')
    expect(water.normalMap?.name).toBe('procedural-water-wave-normals')
    expect(water.normalMap?.wrapS).toBe(THREE.RepeatWrapping)
    expect(water.clearcoat).toBeCloseTo(0.72)
    surface.setFrame(1, 20, false)
    surface.setFrame(2, 20, false)
    expect(time.value).toBeCloseTo(1)
    surface.setFrame(3, 20, true)
    expect(time.value).toBeCloseTo(1)
    const pausedOffset = water.normalMap!.offset.clone()
    surface.setFrame(4, 20, false)
    expect(time.value).toBeCloseTo(2)
    expect(water.normalMap!.offset.equals(pausedOffset)).toBe(false)

    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <color_fragment>\n#include <normal_fragment_maps>\n}',
    }
    water.onBeforeCompile(shader as never, {} as never)
    expect(shader.vertexShader).toContain('uWaterTime * 0.22')
    expect(shader.vertexShader).toContain('uWaterTime * 0.11')
    expect(shader.fragmentShader).toContain('float waterShimmer')

    surface.dispose()
  })

  it('batches marked rivers separately with slow directional flow and narrow bank foam', () => {
    const source: ViewportRenderSource = {
      width: 2, height: 1, tileSize: 1,
      getWaterElevation: () => 0.1,
      readSurface(tileId, out) {
        out.kind = SurfaceKind.lake
        out.neighborMask = 0
        out.region = 0
        out.flags = tileId === 1 ? SurfaceFlag.river : 0
        out.transport = undefined
      },
      getChunkInstances: () => [], getChunkRevision: () => 0,
    }
    const surface = new MapSurfaceLayer({ width: 2, height: 1, tileSize: 1, source, chunkSize: 2 })
    surface.updateVisibleChunks(new Set([0]), () => ({ minX: 0, maxX: 2, minY: 0, maxY: 1 }))

    expect(surface.waterRoot.children).toHaveLength(1)
    expect(surface.riverRoot.children).toHaveLength(1)
    expect(surface.riverRoot.children[0]!.name).toBe('river-surface-0')
    expect((surface.riverRoot.children[0] as THREE.Mesh).material).toBe(surface['riverMaterial'])
    expect(surface['riverMaterial'].name).toBe('flowing-river-water')
    expect(surface['riverMaterial'].customProgramCacheKey()).toBe('labline-flowing-river-v1')
    expect(surface['riverMaterial'].normalMap?.repeat.y).toBeGreaterThan(surface['riverMaterial'].normalMap!.repeat.x)

    const foam = (surface.foamRoot.children[0] as THREE.Mesh).geometry.getAttribute('position')
    const riverBankXs = Array.from({ length: foam.count }, (_, index) => foam.getX(index))
      .filter((x) => x > 0.5 && x < 1.5)
    expect(Math.max(...riverBankXs) - Math.min(...riverBankXs)).toBeLessThan(1.2)

    surface.setFrame(1, 20, false)
    surface.setFrame(2, 20, false)
    const flowingOffset = surface['riverMaterial'].normalMap!.offset.clone()
    surface.setFrame(3, 20, true)
    expect(surface['riverMaterial'].normalMap!.offset.equals(flowingOffset)).toBe(true)
    surface.dispose()
  })

  it('keeps procedural bridge details chunk-batched and scales decks, parapets, and piers by class', () => {
    const local = new MapSurfaceLayer({ width: 1, height: 1, tileSize: 1, source: bridgeSource(TransportVisual.local) })
    const highway = new MapSurfaceLayer({ width: 1, height: 1, tileSize: 1, source: bridgeSource(TransportVisual.highway) })
    const bounds = () => ({ minX: 0, maxX: 1, minY: 0, maxY: 1 })
    local.updateVisibleChunks(new Set([0]), bounds)
    highway.updateVisibleChunks(new Set([0]), bounds)

    expect(local.bridgeRoot.children).toHaveLength(1)
    expect(highway.bridgeRoot.children).toHaveLength(1)
    const localGeometry = (local.bridgeRoot.children[0] as THREE.Mesh).geometry
    const highwayGeometry = (highway.bridgeRoot.children[0] as THREE.Mesh).geometry
    expect(localGeometry.getAttribute('position').count).toBeGreaterThan(16)
    expect(highwayGeometry.getAttribute('position').count).toBe(localGeometry.getAttribute('position').count)
    localGeometry.computeBoundingBox()
    highwayGeometry.computeBoundingBox()
    expect(highwayGeometry.boundingBox!.max.x - highwayGeometry.boundingBox!.min.x)
      .toBeGreaterThan(localGeometry.boundingBox!.max.x - localGeometry.boundingBox!.min.x)
    expect(highwayGeometry.boundingBox!.max.y).toBeGreaterThan(localGeometry.boundingBox!.max.y)
    local.dispose()
    highway.dispose()
  })

  it('builds terrain-conforming road ribbons with canonical cross-chunk seams', () => {
    const source = transportRibbonSource(false)
    const surface = new MapSurfaceLayer({ width: 4, height: 1, tileSize: 1, source, chunkSize: 2 })
    surface.updateVisibleChunks(
      new Set([0, 1]),
      (chunkId) => chunkId === 0
        ? { minX: 0, maxX: 2, minY: 0, maxY: 1 }
        : { minX: 2, maxX: 4, minY: 0, maxY: 1 },
    )

    expect(surface.material.uniforms.uRenderTransportRoads!.value).toBe(0)
    expect(surface.roadRoot.children).toHaveLength(2)
    const [west, east] = surface.roadRoot.children as THREE.Mesh[]
    const westPositions = west!.geometry.getAttribute('position')
    const eastPositions = east!.geometry.getAttribute('position')
    const westSeamY = yValuesAtX(westPositions, 1.5)
    const eastSeamY = yValuesAtX(eastPositions, 1.5)
    expect(westSeamY.length).toBeGreaterThan(0)
    expect(eastSeamY.length).toBeGreaterThan(0)
    expect(westSeamY).toEqual(eastSeamY)
    expect(west!.geometry.groups.some((group) => group.materialIndex === 0)).toBe(true)
    expect(west!.geometry.groups.some((group) => group.materialIndex === 1)).toBe(true)
    expect(west!.geometry.groups.some((group) => group.materialIndex === 2)).toBe(true)
    // Hundreds of ribbons still collapse to at most one draw per material.
    expect(west!.geometry.groups).toHaveLength(3)

    surface.dispose()
  })

  it('separates compiled junction fans from segment ribbons in depth', () => {
    const width = 3
    const height = 3
    const transport = new Uint16Array(width * height)
    const packed = (mask: number) => mask | (TRANSPORT_ROAD_CLASS.collector << TRANSPORT_CLASS_SHIFT) | TRANSPORT_FLAGS.settlement
    transport[3] = packed(1 << 2)
    transport[4] = packed((1 << 2) | (1 << 4) | (1 << 6))
    transport[5] = packed(1 << 6)
    transport[7] = packed(1 << 0)
    const world: StaticWorld = {
      descriptor: { formatVersion: WORLD_FORMAT_VERSION, generatorVersion: WORLD_GENERATOR_VERSION_V3,
        seed: 1, width, height, chunkSize: 3, cityCount: 2, landValueBase: 1,
        landValueCityPeak: 2, energyPricePerMWh: 1, waterCoverage: 0.02 },
      kind: new Uint8Array(width * height), region: new Uint8Array(width * height),
      feature: new Uint16Array(width * height), variantMask: new Uint8Array(width * height), transport,
      cities: [], regions: [], lakes: [], starterPads: [], staticHash: 'junction-depth',
      coverage: { water: 0, urban: 0, forest: 0 },
    }
    const network = compileRoadNetwork(world)
    const source: ViewportRenderSource = {
      width, height, tileSize: 1, useHeightfieldRoadMeshes: true,
      getRoadNetwork: () => network, getRoadNetworkRevision: () => 0,
      getCornerElevation: () => 0.1, getTileElevation: () => 0.1,
      readSurface(tileId, out) {
        out.kind = SurfaceKind.grass; out.region = 0; out.flags = 0
        out.transport = transport[tileId] || undefined
        out.neighborMask = transport[tileId]! & 0xff
      },
      getChunkInstances: () => [], getChunkRevision: () => 0,
    }
    const surface = new MapSurfaceLayer({ width, height, tileSize: 1, source, chunkSize: 3 })
    surface.updateVisibleChunks(new Set([0]), () => ({ minX: 0, maxX: width, minY: 0, maxY: height }))
    const road = surface.roadRoot.children[0] as THREE.Mesh
    expect(road.geometry.groups.length).toBeLessThanOrEqual(3)
    expect(road.geometry.getAttribute('position').count).toBeGreaterThan(24)
    expect(network.junctions.some((junction) => junction.ports.length === 3)).toBe(true)
    const asphalt = road.geometry.groups.find((group) => group.materialIndex === 1)!
    expect(asphalt.count).toBeGreaterThan(0)
    const index = road.geometry.index!
    const positions = road.geometry.getAttribute('position')
    const asphaltHeights = new Set(Array.from(
      { length: asphalt.count },
      (_, offset) => positions.getY(index.getX(asphalt.start + offset)).toFixed(3),
    ))
    expect(asphaltHeights).toContain('0.140')
    expect(asphaltHeights).toContain('0.142')
    const materials = road.material as THREE.MeshStandardMaterial[]
    expect(materials.every((material) => material.polygonOffset)).toBe(true)
    expect(materials[2]!.polygonOffsetFactor).toBeLessThan(materials[1]!.polygonOffsetFactor)
    surface.dispose()
  })

  it('renders a continuous compiled degree-two turn with three material groups', () => {
    const width = 3
    const height = 3
    const transport = new Uint16Array(width * height)
    const packed = (mask: number) => mask
      | (TRANSPORT_ROAD_CLASS.collector << TRANSPORT_CLASS_SHIFT)
      | TRANSPORT_FLAGS.settlement
    transport[3] = packed(1 << 2)
    transport[4] = packed((1 << 6) | (1 << 4))
    transport[7] = packed(1 << 0)
    const world: StaticWorld = {
      descriptor: { formatVersion: WORLD_FORMAT_VERSION, generatorVersion: WORLD_GENERATOR_VERSION_V3,
        seed: 1, width, height, chunkSize: 3, cityCount: 2, landValueBase: 1,
        landValueCityPeak: 2, energyPricePerMWh: 1, waterCoverage: 0.02 },
      kind: new Uint8Array(width * height), region: new Uint8Array(width * height),
      feature: new Uint16Array(width * height), variantMask: new Uint8Array(width * height), transport,
      cities: [], regions: [], lakes: [], starterPads: [], staticHash: 'turn',
      coverage: { water: 0, urban: 0, forest: 0 },
    }
    const network = compileRoadNetwork(world)
    const source: ViewportRenderSource = {
      width, height, tileSize: 1, useHeightfieldRoadMeshes: true,
      getRoadNetwork: () => network, getRoadNetworkRevision: () => 0,
      getCornerElevation: () => 0.1, getTileElevation: () => 0.1,
      readSurface(tileId, out) {
        out.kind = SurfaceKind.grass; out.region = 0; out.flags = 0
        out.transport = transport[tileId] || undefined
        out.neighborMask = transport[tileId]! & 0xff
      },
      getChunkInstances: () => [], getChunkRevision: () => 0,
    }
    const surface = new MapSurfaceLayer({ width, height, tileSize: 1, source, chunkSize: 3 })
    surface.updateVisibleChunks(new Set([0]), () => ({ minX: 0, maxX: width, minY: 0, maxY: height }))
    const road = surface.roadRoot.children[0] as THREE.Mesh
    expect(road.geometry.groups.length).toBeLessThanOrEqual(3)
    expect(road.geometry.getAttribute('position').count).toBeGreaterThan(24)
    expect(network.segments).toHaveLength(1)
    expect(network.segments[0]!.points).toHaveLength(3)
    const asphalt = road.geometry.groups.find((group) => group.materialIndex === 1)!
    expect(asphalt.count).toBeGreaterThan(0)
    const materials = road.material as THREE.MeshStandardMaterial[]
    expect(materials.every((material) => material.polygonOffset)).toBe(true)
    expect(materials[2]!.polygonOffsetFactor).toBeLessThan(materials[1]!.polygonOffsetFactor)
    surface.dispose()
  })

  it('cuts the single center marking into short geometry dashes with real gaps', () => {
    const width = 8
    const height = 1
    const transport = new Uint16Array(width)
    const packed = (mask: number) => mask
      | (TRANSPORT_ROAD_CLASS.arterial << TRANSPORT_CLASS_SHIFT)
      | TRANSPORT_FLAGS.settlement
    transport[0] = packed(1 << 2)
    for (let x = 1; x < width - 1; x++) transport[x] = packed((1 << 6) | (1 << 2))
    transport[width - 1] = packed(1 << 6)
    const world: StaticWorld = {
      descriptor: { formatVersion: WORLD_FORMAT_VERSION, generatorVersion: WORLD_GENERATOR_VERSION_V3,
        seed: 2, width, height, chunkSize: width, cityCount: 2, landValueBase: 1,
        landValueCityPeak: 2, energyPricePerMWh: 1, waterCoverage: 0.02 },
      kind: new Uint8Array(width), region: new Uint8Array(width),
      feature: new Uint16Array(width), variantMask: new Uint8Array(width), transport,
      cities: [], regions: [], lakes: [], starterPads: [], staticHash: 'marking-dashes',
      coverage: { water: 0, urban: 0, forest: 0 },
    }
    const network = compileRoadNetwork(world)
    const source: ViewportRenderSource = {
      width, height, tileSize: 1, useHeightfieldRoadMeshes: true,
      getRoadNetwork: () => network, getRoadNetworkRevision: () => 0,
      getCornerElevation: () => 0, getTileElevation: () => 0,
      readSurface(tileId, out) {
        out.kind = SurfaceKind.grass; out.region = 0; out.flags = 0
        out.transport = transport[tileId] || undefined
        out.neighborMask = transport[tileId]! & 0xff
      },
      getChunkInstances: () => [], getChunkRevision: () => 0,
    }
    const surface = new MapSurfaceLayer({ width, height, tileSize: 1, source, chunkSize: width })
    surface.updateVisibleChunks(new Set([0]), () => ({ minX: 0, maxX: width, minY: 0, maxY: height }))

    const road = surface.roadRoot.children[0] as THREE.Mesh
    const marking = road.geometry.groups.find((group) => group.materialIndex === 2)!
    const positions = road.geometry.getAttribute('position')
    const indices = road.geometry.index!
    const spans = new Map<string, number>()
    for (let start = marking.start; start < marking.start + marking.count; start += 6) {
      const xs = Array.from({ length: 6 }, (_, offset) => positions.getX(indices.getX(start + offset)))
      const min = Math.min(...xs)
      const max = Math.max(...xs)
      const key = `${min.toFixed(3)}:${max.toFixed(3)}`
      spans.set(key, (spans.get(key) ?? 0) + 1)
    }
    const intervals = [...spans.keys()]
      .map((key) => key.split(':').map(Number) as [number, number])
      .sort((a, b) => a[0] - b[0])

    expect(intervals.length).toBeGreaterThan(10)
    expect(intervals.every(([start, end]) => end - start <= 0.281)).toBe(true)
    expect(intervals.slice(1).every(([start], index) => start - intervals[index]![1] >= 0.219)).toBe(true)
    // Arterials keep only the center stripe; no parallel side markings remain.
    expect([...spans.values()].every((count) => count === 1)).toBe(true)
    surface.dispose()
  })

  it('retains hidden surface chunks and reuses their geometry on a return pan', () => {
    const source = transportRibbonSource(false)
    const surface = new MapSurfaceLayer({ width: 4, height: 1, tileSize: 1, source, chunkSize: 2 })
    const bounds = (chunkId: ChunkId) => chunkId === 0
      ? { minX: 0, maxX: 2, minY: 0, maxY: 1 }
      : { minX: 2, maxX: 4, minY: 0, maxY: 1 }
    surface.updateVisibleChunks(new Set([0]), bounds, new Set([0, 1]))
    const first = (surface.terrainRoot.children[0] as THREE.Group).children[0] as THREE.Mesh
    const geometry = first.geometry

    surface.updateVisibleChunks(new Set([1]), bounds, new Set([0, 1]))
    expect(first.parent?.visible).toBe(false)
    surface.updateVisibleChunks(new Set([0]), bounds, new Set([0, 1]))

    expect(first.parent?.visible).toBe(true)
    expect(first.geometry).toBe(geometry)
    surface.dispose()
  })

  it('builds one cached non-pickable biome fascia only for true perimeter chunks', () => {
    const source = edgeSource()
    const surface = new MapSurfaceLayer({ width: 4, height: 4, tileSize: 1, source, chunkSize: 2 })
    const bounds = (chunkId: ChunkId) => chunkId === 0
      ? { minX: 1, maxX: 3, minY: 1, maxY: 3 }
      : { minX: 0, maxX: 2, minY: 0, maxY: 2 }

    surface.updateVisibleChunks(new Set([0]), bounds, new Set([0, 1]))
    expect(surface.edgeRoot.children).toHaveLength(0)
    surface.updateVisibleChunks(new Set([1]), bounds, new Set([0, 1]))

    expect(surface.edgeRoot.children).toHaveLength(1)
    expect(surface.pickObjects).not.toContain(surface.edgeRoot)
    const edge = surface.edgeRoot.children[0] as THREE.Mesh
    expect(edge.geometry.groups).toHaveLength(0)
    expect(Array.isArray(edge.material)).toBe(false)
    expect(edge.geometry.getAttribute('color').count).toBe(edge.geometry.getAttribute('position').count)
    const color = edge.geometry.getAttribute('color')
    const uniqueColors = new Set(Array.from({ length: color.count }, (_, index) =>
      `${color.getX(index).toFixed(4)},${color.getY(index).toFixed(4)},${color.getZ(index).toFixed(4)}`,
    ))
    expect(uniqueColors.size).toBeGreaterThan(3)
    edge.geometry.computeBoundingBox()
    expect(edge.geometry.boundingBox!.min.x).toBeLessThan(-0.5)
    expect(edge.geometry.boundingBox!.min.z).toBeLessThan(-0.5)

    const geometry = edge.geometry
    surface.updateVisibleChunks(new Set([0]), bounds, new Set([0, 1]))
    expect(edge.visible).toBe(false)
    surface.updateVisibleChunks(new Set([1]), bounds, new Set([0, 1]))
    expect(edge.visible).toBe(true)
    expect(edge.geometry).toBe(geometry)
    surface.dispose()
  })

  it('keeps flat compatibility transport in the shader instead of making meshes', () => {
    const source = transportRibbonSource(true)
    const surface = new MapSurfaceLayer({ width: 4, height: 1, tileSize: 1, source, chunkSize: 4 })
    surface.updateVisibleChunks(new Set([0]), () => ({ minX: 0, maxX: 4, minY: 0, maxY: 1 }))

    expect(surface.material.uniforms.uRenderTransportRoads!.value).toBe(1)
    expect(surface.roadRoot.children).toHaveLength(0)

    surface.dispose()
  })
})

function yValuesAtX(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, x: number): number[] {
  const values: number[] = []
  for (let index = 0; index < attribute.count; index++) {
    if (Math.abs(attribute.getX(index) - x) < 1e-6) values.push(Number(attribute.getY(index).toFixed(6)))
  }
  return [...new Set(values)].sort((a, b) => a - b)
}

function transportRibbonSource(flat: boolean): ViewportRenderSource {
  const transport = [
    0,
    (TransportVisual.arterial << 8) | 0x44,
    (TransportVisual.highway << 8) | 0x44,
    0,
  ]
  return {
    width: 4,
    height: 1,
    tileSize: 1,
    getCornerElevation: (x, y) => flat ? 0 : x * 0.08 + y * 0.03,
    getTileElevation: (x, y) => flat ? 0 : (x + 0.5) * 0.08 + (y + 0.5) * 0.03,
    readSurface(tileId: number, out: SurfaceTexel) {
      out.kind = SurfaceKind.grass
      out.neighborMask = transport[tileId]! & 0xff
      out.region = 0
      out.flags = 0
      out.transport = transport[tileId] || undefined
    },
    getChunkInstances: () => [],
    getChunkRevision: () => 0,
  }
}

function bridgeSource(roadClass: number): ViewportRenderSource {
  return {
    width: 1, height: 1, tileSize: 1,
    getWaterElevation: () => 0,
    readSurface(_tileId, out) {
      out.kind = SurfaceKind.lake
      out.neighborMask = 0x11
      out.region = 0
      out.flags = 0
      out.transport = ((roadClass | TransportVisual.bridge) << 8) | 0x11
    },
    getChunkInstances: () => [], getChunkRevision: () => 0,
  }
}

function testSource(): ViewportRenderSource {
  return {
    width: 2,
    height: 2,
    tileSize: 1,
    getCornerElevation: (x, y) => (x + y) * 0.1,
    getTileElevation: (x, y) => (x + y + 1) * 0.1,
    getWaterElevation: () => 0.18,
    getBiome: (x, y) => [
      RenderBiome.plains,
      RenderBiome.forest,
      RenderBiome.arid,
      RenderBiome.coast,
    ][y * 2 + x]!,
    readSurface(tileId: number, out: SurfaceTexel) {
      out.kind = tileId === 0 ? SurfaceKind.lake : SurfaceKind.grass
      out.neighborMask = 0
      out.region = 0
      out.flags = 0
      out.transport = tileId === 0
        ? (TransportVisual.bridge << 8) | (TransportVisual.local << 8) | 0x11
        : undefined
    },
    getChunkInstances: (_chunkId, _tier: LodTier) => [],
    getChunkRevision: () => 0,
  }
}

function edgeSource(): ViewportRenderSource {
  return {
    width: 4,
    height: 4,
    tileSize: 1,
    getCornerElevation: (x, y) => x * 0.03 + y * 0.02,
    getTileElevation: (x, y) => (x + y + 1) * 0.025,
    getBiome: (x) => x % 2 === 0 ? RenderBiome.plains : RenderBiome.arid,
    readSurface(_tileId, out) {
      out.kind = SurfaceKind.grass
      out.neighborMask = 0
      out.region = 0
      out.flags = 0
      out.transport = undefined
    },
    getChunkInstances: () => [],
    getChunkRevision: () => 0,
  }
}
