import * as THREE from 'three'
import { smoothRoadCenterline, type RoadJunction, type RoadNetworkPoint } from '../../../sim/world'
import { SurfaceBiomeTexture, SurfaceDataTexture } from './surfaceData'
import { RenderBiome, SurfaceKind, TransportVisual, type ChunkId, type SurfaceTexel, type TileBounds, type ViewportRenderSource } from './types'

const VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;

in vec3 position;
in vec2 uv;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

out vec2 vWorldXZ;
out vec3 vWorldPosition;

void main() {
  vWorldXZ = position.xz;
  vWorldPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/**
 * Procedural tiles are evaluated in tile space, so zooming never samples an
 * atlas gutter or blends categorical tile IDs. fwidth-based edges provide the
 * mip-safe/anti-aliased behavior normally supplied by an atlas mip chain.
 */
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
precision highp int;

uniform highp sampler2D uTileState;
uniform highp sampler2D uBiomeState;
uniform vec2 uMapSize;
uniform highp float uTileSize;
uniform float uTime;
uniform float uPixelsPerTile;
uniform float uRenderTransportRoads;

in vec2 vWorldXZ;
in vec3 vWorldPosition;
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 blend = f * f * (3.0 - 2.0 * f);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0));
  return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
}

float terrainHeight(vec2 p) {
  return valueNoise(p * 0.055) * 0.62
       + valueNoise(p * 0.12 + vec2(31.7, 11.9)) * 0.27
       + valueNoise(p * 0.25 + vec2(7.3, 47.1)) * 0.11;
}

float bitSet(float mask, float bitValue) {
  return mod(floor(mask / bitValue), 2.0);
}

float aaBand(float distanceToEdge, float halfWidth) {
  float aa = max(fwidth(distanceToEdge), 0.0008);
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, distanceToEdge);
}

vec2 segmentProjection(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.00001), 0.0, 1.0);
  return vec2(length(pa - ba * h), h);
}

float roadArm(vec2 p, vec2 endpoint, float enabled, float centerWidth, float seamWidth) {
  vec2 projection = segmentProjection(p, vec2(0.5), endpoint);
  // Every road class reaches a tile boundary at the same width. This makes
  // adjacent tiles meet exactly, while the class-specific width returns well
  // before the rounded intersection hub.
  float width = mix(centerWidth, seamWidth, smoothstep(0.35, 0.94, projection.y));
  return enabled * aaBand(projection.x, width);
}

float signedRoadArm(vec2 p, vec2 endpoint, float enabled, float centerWidth, float seamWidth) {
  vec2 projection = segmentProjection(p, vec2(0.5), endpoint);
  float width = mix(centerWidth, seamWidth, smoothstep(0.35, 0.94, projection.y));
  return mix(2.0, projection.x - width, enabled);
}

/** One rounded distance field is reused for pavement, shoulder, and bridge deck. */
float roadSignedDistance8(vec2 p, float mask, float halfWidth) {
  const float seamWidth = 0.185;
  float distanceToRoad = length(p - vec2(0.5)) - halfWidth;
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(0.5, 0.0), bitSet(mask, 1.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(1.0, 0.0), bitSet(mask, 2.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(1.0, 0.5), bitSet(mask, 4.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(1.0, 1.0), bitSet(mask, 8.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(0.5, 1.0), bitSet(mask, 16.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(0.0, 1.0), bitSet(mask, 32.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(0.0, 0.5), bitSet(mask, 64.0), halfWidth, seamWidth));
  distanceToRoad = min(distanceToRoad, signedRoadArm(p, vec2(0.0, 0.0), bitSet(mask, 128.0), halfWidth, seamWidth));
  return distanceToRoad;
}

float signedFill(float signedDistance) {
  float aa = max(fwidth(signedDistance), 0.0008);
  return 1.0 - smoothstep(-aa, aa, signedDistance);
}

float roadCenterLines(vec2 p, float mask, float lineWidth) {
  float line = 0.0;
  const float seamLineWidth = 0.011;
  line = max(line, roadArm(p, vec2(0.5, 0.0), bitSet(mask, 1.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(1.0, 0.0), bitSet(mask, 2.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(1.0, 0.5), bitSet(mask, 4.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(1.0, 1.0), bitSet(mask, 8.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(0.5, 1.0), bitSet(mask, 16.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(0.0, 1.0), bitSet(mask, 32.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(0.0, 0.5), bitSet(mask, 64.0), lineWidth, seamLineWidth));
  line = max(line, roadArm(p, vec2(0.0, 0.0), bitSet(mask, 128.0), lineWidth, seamLineWidth));
  return line;
}

float connectedArmCount(float mask) {
  return bitSet(mask, 1.0) + bitSet(mask, 2.0) + bitSet(mask, 4.0) + bitSet(mask, 8.0)
       + bitSet(mask, 16.0) + bitSet(mask, 32.0) + bitSet(mask, 64.0) + bitSet(mask, 128.0);
}

float exposedShoreDistance(vec2 p, float mask) {
  float distanceToShore = 2.0;
  distanceToShore = min(distanceToShore, mix(p.y, 2.0, bitSet(mask, 1.0)));
  distanceToShore = min(distanceToShore, mix(1.0 - p.x, 2.0, bitSet(mask, 2.0)));
  distanceToShore = min(distanceToShore, mix(1.0 - p.y, 2.0, bitSet(mask, 4.0)));
  distanceToShore = min(distanceToShore, mix(p.x, 2.0, bitSet(mask, 8.0)));
  return distanceToShore;
}

vec3 grassColor(vec2 tile, float region) {
  float variation = hash21(tile + region * 19.31) - 0.5;
  return vec3(0.255, 0.445, 0.275) + variation * vec3(0.035, 0.055, 0.028);
}

vec3 biomePalette(float biome) {
  vec3 plains = vec3(0.255, 0.445, 0.275);
  vec3 forest = vec3(0.145, 0.315, 0.190);
  vec3 arid = vec3(0.505, 0.405, 0.245);
  vec3 wetland = vec3(0.185, 0.345, 0.275);
  vec3 alpine = vec3(0.335, 0.365, 0.335);
  vec3 coast = vec3(0.505, 0.455, 0.305);
  vec3 meadow = vec3(0.355, 0.525, 0.255);
  vec3 boreal = vec3(0.135, 0.275, 0.225);
  vec3 scrubland = vec3(0.465, 0.435, 0.245);
  vec3 color = plains;
  if (biome > 0.5 && biome < 1.5) color = forest;
  else if (biome < 2.5 && biome > 1.5) color = arid;
  else if (biome < 3.5 && biome > 2.5) color = wetland;
  else if (biome < 4.5 && biome > 3.5) color = alpine;
  else if (biome < 5.5 && biome > 4.5) color = coast;
  else if (biome < 6.5 && biome > 5.5) color = meadow;
  else if (biome < 7.5 && biome > 6.5) color = boreal;
  else if (biome > 7.5) color = scrubland;
  return color;
}

float biomeAt(ivec2 tile) {
  ivec2 bounded = clamp(tile, ivec2(0), ivec2(uMapSize) - ivec2(1));
  return floor(texelFetch(uBiomeState, bounded, 0).r * 255.0 + 0.5);
}

float biomeKernel(float distanceToCenter) {
  // The support must end exactly at the outer loop radius. A larger radius
  // gives newly-entering samples non-zero weight when floor(sampleCoord)
  // changes, creating a visible popping seam while the camera pans.
  float t = clamp(1.0 - abs(distanceToCenter) / 2.0, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/**
 * Blend display-only biome color and climate influence across a broad,
 * slightly warped neighbourhood. Gameplay and decoration still consume the
 * exact categorical biome texture, while the ground avoids one-tile stair
 * steps at diagonal regional boundaries.
 */
vec3 biomeGround(vec2 tileCoord, float region, out vec4 climate) {
  vec2 warp = vec2(
    valueNoise(tileCoord * 0.055 + vec2(17.2, 41.7)),
    valueNoise(tileCoord * 0.055 + vec2(73.4, 9.1))
  ) - vec2(0.5);
  vec2 sampleCoord = tileCoord - vec2(0.5) + warp * 0.34;
  ivec2 base = ivec2(floor(sampleCoord));
  vec2 local = fract(sampleCoord);
  vec3 color = vec3(0.0);
  climate = vec4(0.0);
  float totalWeight = 0.0;
  for (int oy = -2; oy <= 2; oy++) {
    float weightY = biomeKernel(float(oy) - local.y);
    for (int ox = -2; ox <= 2; ox++) {
      float weight = weightY * biomeKernel(float(ox) - local.x);
      float sampledBiome = biomeAt(base + ivec2(ox, oy));
      color += biomePalette(sampledBiome) * weight;
      climate += vec4(
        1.0 - step(0.5, abs(sampledBiome - 2.0)),
        1.0 - step(0.5, abs(sampledBiome - 3.0)),
        1.0 - step(0.5, abs(sampledBiome - 4.0)),
        1.0 - step(0.5, abs(sampledBiome - 5.0))
      ) * weight;
      totalWeight += weight;
    }
  }
  color /= max(totalWeight, 0.0001);
  climate /= max(totalWeight, 0.0001);
  float variation = valueNoise(tileCoord * 0.09 + vec2(region * 0.073, region * 0.119)) - 0.5;
  return color + variation * vec3(0.035, 0.048, 0.026);
}

void main() {
  // Reconstruct logical coordinates directly from world space. Whole-map UV
  // interpolation can differ by a low bit on duplicated chunk-edge vertices;
  // world coordinates remain canonical under camera movement and rotation.
  vec2 tileCoord = clamp(vWorldXZ / uTileSize + vec2(0.5), vec2(0.0), uMapSize - vec2(0.0001));
  ivec2 tile = ivec2(floor(tileCoord));
  vec2 local = fract(tileCoord);
  vec4 encoded = texelFetch(uTileState, tile, 0);
  float biome = floor(texelFetch(uBiomeState, tile, 0).r * 255.0 + 0.5);
  vec4 bytes = floor(encoded * 255.0 + 0.5);
  float transportMode = step(127.5, bytes.r);
  float kind = mod(bytes.r, 16.0);
  float mask = bytes.g;
  float style = floor(mod(bytes.r, 128.0) / 16.0) * transportMode;
  float region = bytes.b;
  float flags = bytes.a;

  vec4 biomeInfluence;
  vec3 grass = biomeGround(tileCoord, region, biomeInfluence);
  // Lighting comes from the actual heightfield, not a fake fragment-only hill.
  vec3 reliefNormal = normalize(cross(dFdy(vWorldPosition), dFdx(vWorldPosition)));
  if (reliefNormal.y < 0.0) reliefNormal = -reliefNormal;
  float hillLight = max(0.0, dot(reliefNormal, normalize(vec3(-0.48, 0.78, -0.39))));
  grass *= 0.82 + hillLight * 0.28;
  float soilNoise = valueNoise(tileCoord * 0.31 + vec2(18.4, 6.2));
  float soilPatch = smoothstep(0.67, 0.82, soilNoise) * (0.45 + 0.55 * valueNoise(tileCoord * 1.15));
  float exposedSlope = 1.0 - clamp(reliefNormal.y, 0.0, 1.0);
  float aridness = biomeInfluence.x;
  float moisture = biomeInfluence.y;
  float rockiness = biomeInfluence.z;
  float coastSand = biomeInfluence.w;
  vec3 soil = mix(vec3(0.34, 0.265, 0.17), vec3(0.47, 0.35, 0.19), aridness);
  soil = mix(soil, vec3(0.225, 0.245, 0.17), moisture * 0.72);
  soil = mix(soil, vec3(0.39, 0.385, 0.35), rockiness * 0.78);
  soil = mix(soil, vec3(0.54, 0.46, 0.29), coastSand * 0.72);
  soil *= 0.92 + exposedSlope * 0.16;
  float naturalGround = (1.0 - step(0.5, kind)) + step(4.5, kind) * (1.0 - step(5.5, kind));
  float biomeExposure = aridness * 0.35 + rockiness * 0.42 + coastSand * 0.22 - moisture * 0.16;
  grass = mix(grass, soil, max(soilPatch * (0.42 + biomeExposure), exposedSlope * (0.42 + rockiness * 0.34)) * naturalGround);
  vec3 color = grass;

  if (kind > 1.5 && kind < 2.5) {
    float blockJoint = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
    float joint = 1.0 - smoothstep(0.018, 0.035, blockJoint);
    color = mix(vec3(0.31, 0.315, 0.34), vec3(0.19, 0.20, 0.225), joint * 0.55);
  } else if (kind > 2.5 && kind < 3.5) {
    // The lake surface is independent geometry. This is the visible basin bed
    // through shallow transparent water and around irregular shore edges.
    float basin = valueNoise(tileCoord * 0.16 + vec2(41.0, 9.0));
    color = mix(vec3(0.18, 0.23, 0.17), vec3(0.27, 0.245, 0.17), basin);
  } else if (kind > 3.5 && kind < 4.5) {
    color = grass * vec3(0.82, 1.08, 0.84);
  } else if (kind > 4.5 && kind < 5.5) {
    color = grass * vec3(0.72, 0.91, 0.72);
  } else if (kind > 5.5 && kind < 7.5) {
    color = mix(grass, vec3(0.35, 0.34, 0.33), 0.22);
  } else if (kind > 7.5) {
    color = mix(grass, vec3(0.30, 0.32, 0.34), 0.42);
  }

  // V4 roads are separate meshes. A coherent uniform branch keeps the costly
  // eight-arm SDF and marking evaluation out of every terrain fragment there;
  // flat V2/V3 compatibility worlds still execute the established shader path.
  if (uRenderTransportRoads > 0.5) {
    float legacyRoad = (1.0 - transportMode) * step(0.5, kind) * (1.0 - step(1.5, kind));
    float roadPresent = max(legacyRoad, transportMode * uRenderTransportRoads);
    // V2 stores NESW contiguously; expand it into v3's clockwise 8-way slots.
    float legacyMask = bitSet(mask, 1.0) + bitSet(mask, 2.0) * 4.0
                     + bitSet(mask, 4.0) * 16.0 + bitSet(mask, 8.0) * 64.0;
    float roadMask = mix(legacyMask, mask, transportMode);
    float roadClass = mix(1.0, mod(style, 4.0) + 1.0, transportMode);
    float halfWidth = mix(0.145, 0.255, clamp((roadClass - 1.0) / 3.0, 0.0, 1.0));
    float roadDistance = roadSignedDistance8(local, roadMask, halfWidth);
    float road = signedFill(roadDistance) * roadPresent;
    float bridge = step(3.5, style) * transportMode * uRenderTransportRoads;
    float roadEdge = signedFill(roadDistance - 0.018) * roadPresent;
    float bridgeDeck = signedFill(roadDistance - 0.034) * bridge;
    color = mix(color, vec3(0.085, 0.12, 0.145), bridgeDeck * (1.0 - road) * 0.82);
    color = mix(color, vec3(0.095, 0.10, 0.105), roadEdge * (1.0 - road) * 0.72);
    vec3 asphalt = mix(vec3(0.185, 0.19, 0.20), vec3(0.105, 0.115, 0.13),
                       clamp((roadClass - 1.0) / 3.0, 0.0, 1.0));
    asphalt += bridge * vec3(0.025, 0.035, 0.045);
    color = mix(color, asphalt, road);

    float markedClass = step(1.5, roadClass);
    float markings = roadCenterLines(local, roadMask, roadClass >= 4.0 ? 0.026 : 0.012);
    float intersection = step(2.5, connectedArmCount(roadMask));
    markings *= 1.0 - intersection * (1.0 - smoothstep(0.13, 0.25, length(local - vec2(0.5))));
    vec3 markingColor = roadClass >= 3.0 ? vec3(0.86, 0.72, 0.30) : vec3(0.78, 0.79, 0.72);
    color = mix(color, markingColor, markings * road * markedClass * 0.88);
    // Highways get a continuous divided median with the same seam contract.
    float median = markings * step(3.5, roadClass);
    median *= 1.0 - intersection * (1.0 - smoothstep(0.16, 0.27, length(local - vec2(0.5))));
    color = mix(color, vec3(0.06, 0.075, 0.08), median * road * 0.76);
  }

  float playerOwned = bitSet(flags, 1.0);
  float rivalOwned = bitSet(flags, 2.0);
  float selected = bitSet(flags, 4.0);
  float constructing = bitSet(flags, 8.0);
  color = mix(color, vec3(0.18, 0.76, 0.59), playerOwned * 0.10);
  color = mix(color, vec3(0.82, 0.36, 0.20), rivalOwned * 0.09);

  // Pixel-stable grid: fade before it aliases instead of relying on atlas mips.
  float edgeDistance = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
  float gridWidth = max(fwidth(edgeDistance) * 0.85, 0.001);
  float grid = 1.0 - smoothstep(gridWidth, gridWidth * 2.1, edgeDistance);
  float gridVisibility = smoothstep(9.0, 17.0, uPixelsPerTile);
  color *= 1.0 - grid * gridVisibility * 0.16;
  color = mix(color, vec3(0.35, 1.0, 0.77), selected * (0.18 + grid * 0.34));
  color = mix(color, vec3(0.83, 0.65, 0.24), constructing * 0.08);

  fragColor = vec4(color, 1.0);
}
`

export interface SurfaceLayerOptions {
  width: number
  height: number
  tileSize: number
  data?: SurfaceDataTexture
  source?: ViewportRenderSource
  chunkSize?: number
}

interface SurfaceChunkRecord {
  readonly root: THREE.Group
  readonly geometry: THREE.BufferGeometry
  readonly revision: number
}

// The immutable V4 lattice is already smoothed by generation. A second,
// bilinearly-interpolated vertex inside every half tile does not add terrain
// information, but it quadruples raster triangles and makes chunk builds much
// more expensive. One cell per logical tile retains the exact heightfield and
// grid boundary; canonical finite-difference normals keep the lighting smooth.
const TERRAIN_SUBDIVISIONS = 1
const WATER_LIFT = 0.006
const SHORE_WATER_RECESS = 0.014
const SHORE_FOAM_LIFT = WATER_LIFT - SHORE_WATER_RECESS + 0.006
const SHORE_FOAM_WIDTH = 0.085
const LAKE_BASIN_DEPTH = 0.16
const ROAD_SURFACE_LIFT = 0.040
const ROAD_SHOULDER_LIFT = 0.024
const ROAD_MARKING_LIFT = 0.058
// Keep overview silhouettes clean: paint appears only once the camera enters
// the close-detail band, then reaches full opacity at the near-art threshold.
const ROAD_MARKING_FADE_START_PPT = 24
const ROAD_MARKING_FADE_END_PPT = 28
const ROAD_ARM_STEPS = 4
const EDGE_LIP_TILES = 0.08
const EDGE_SOIL_RECESS = 0.05
const EDGE_SOIL_DEPTH = 0.65
const EDGE_DEPTH_VARIATION = 0.08

/** Bounded, raycastable heightfield chunks plus independent water/bridge meshes. */
export class MapSurfaceLayer {
  readonly data: SurfaceDataTexture
  readonly biomeData: SurfaceBiomeTexture
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.RawShaderMaterial
  readonly mesh = new THREE.Group()
  readonly terrainRoot = new THREE.Group()
  readonly waterRoot = new THREE.Group()
  readonly foamRoot = new THREE.Group()
  readonly bridgeRoot = new THREE.Group()
  readonly roadRoot = new THREE.Group()
  readonly edgeRoot = new THREE.Group()
  readonly pickObjects: THREE.Object3D[] = [this.terrainRoot, this.bridgeRoot]

  private readonly width: number
  private readonly height: number
  private readonly tileSize: number
  private readonly source?: ViewportRenderSource
  private readonly chunkSize: number
  private readonly chunks = new Map<ChunkId, SurfaceChunkRecord>()
  private readonly waterMaterial: THREE.MeshPhysicalMaterial
  private readonly foamMaterial: THREE.MeshStandardMaterial
  private readonly bridgeMaterial: THREE.MeshStandardMaterial
  private readonly roadMaterials: THREE.MeshStandardMaterial[]
  private readonly edgeMaterial: THREE.MeshStandardMaterial
  private readonly useRoadMeshes: boolean
  private waterAnimationTime = 0
  private lastFrameTime: number | undefined

  constructor(options: SurfaceLayerOptions) {
    const { width, height, tileSize } = options
    this.width = width
    this.height = height
    this.tileSize = tileSize
    this.source = options.source
    this.chunkSize = Math.max(1, Math.floor(options.chunkSize ?? 32))
    this.data = options.data ?? new SurfaceDataTexture(width, height)
    if (this.data.width !== width || this.data.height !== height) {
      throw new RangeError('SurfaceDataTexture dimensions do not match the map')
    }
    this.biomeData = new SurfaceBiomeTexture(width, height, (tileId) => {
      const x = tileId % width
      const y = Math.floor(tileId / width)
      return this.source?.getBiome?.(x, y) ?? 0
    })

    this.useRoadMeshes = this.source?.useHeightfieldRoadMeshes ?? this.sourceHasRelief()
    this.material = new THREE.RawShaderMaterial({
      name: 'map-surface-procedural-rgba8',
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTileState: { value: this.data.texture },
        uBiomeState: { value: this.biomeData.texture },
        uMapSize: { value: new THREE.Vector2(width, height) },
        uTileSize: { value: tileSize },
        uTime: { value: 0 },
        uPixelsPerTile: { value: 16 },
        uRenderTransportRoads: { value: this.useRoadMeshes ? 0 : 1 },
      },
      depthWrite: true,
      depthTest: true,
      transparent: false,
      side: THREE.FrontSide,
    })
    this.waterMaterial = createWaterMaterial()
    this.foamMaterial = createShoreFoamMaterial()
    this.bridgeMaterial = new THREE.MeshStandardMaterial({
      name: 'terrain-bridge-decks',
      color: 0x26323b,
      roughness: 0.76,
      metalness: 0.12,
      flatShading: false,
      fog: true,
    })
    const roadMarkingMaterial = roadMaterial('road-marking', 0xf4f2e9, 0.72, -4)
    roadMarkingMaterial.transparent = true
    roadMarkingMaterial.depthWrite = false
    this.roadMaterials = [
      roadMaterial('road-shoulder', 0x4d5150, 0.94, -1),
      roadMaterial('road-asphalt', 0x252a30, 0.82, -2),
      roadMarkingMaterial,
    ]
    this.edgeMaterial = new THREE.MeshStandardMaterial({
      name: 'biome-world-edge-fascia',
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      flatShading: true,
      fog: true,
      side: THREE.DoubleSide,
    })
    this.mesh.name = 'map-heightfield-surface'
    this.terrainRoot.name = 'map-terrain-heightfield-chunks'
    this.waterRoot.name = 'map-independent-water-chunks'
    this.foamRoot.name = 'map-shoreline-foam-chunks'
    this.bridgeRoot.name = 'map-bridge-deck-chunks'
    this.roadRoot.name = 'map-heightfield-road-chunks'
    this.edgeRoot.name = 'map-world-edge-fascia-chunks'
    this.mesh.add(this.edgeRoot, this.terrainRoot, this.waterRoot, this.foamRoot, this.roadRoot, this.bridgeRoot)

    // Keep a small geometry handle for diagnostics/tests; large maps do not
    // allocate a million-cell pick plane during construction.
    const initialBounds: TileBounds = {
      minX: 0,
      maxX: Math.min(width, this.chunkSize),
      minY: 0,
      maxY: Math.min(height, this.chunkSize),
    }
    this.geometry = this.buildTerrainGeometry(initialBounds)
  }

  /** Reconcile only viewport-resident terrain. Chunks share canonical corners. */
  updateVisibleChunks(
    visible: ReadonlySet<ChunkId>,
    chunkBounds: (chunkId: ChunkId) => TileBounds,
    retained: ReadonlySet<ChunkId> = visible,
  ): void {
    for (const [chunkId, record] of this.chunks) {
      this.setChunkVisible(record, visible.has(chunkId))
    }
    for (const chunkId of visible) {
      const revision = this.source?.getSurfaceRevision?.(chunkId) ?? 0
      const current = this.chunks.get(chunkId)
      if (current?.revision === revision) continue
      if (current) this.removeChunk(chunkId, current)
      const bounds = chunkBounds(chunkId)
      const root = new THREE.Group()
      root.name = `terrain-chunk-${chunkId}`
      const geometry = this.buildTerrainGeometry(bounds)
      const terrain = new THREE.Mesh(geometry, this.material)
      terrain.name = `terrain-heightfield-${chunkId}`
      terrain.receiveShadow = true
      terrain.castShadow = false
      terrain.userData.terrainPickSurface = true
      root.add(terrain)
      this.terrainRoot.add(root)

      const edge = this.buildEdgeGeometry(bounds)
      if (edge.getAttribute('position').count > 0) {
        const edgeMesh = new THREE.Mesh(edge, this.edgeMaterial)
        edgeMesh.name = `terrain-edge-fascia-${chunkId}`
        edgeMesh.castShadow = false
        edgeMesh.receiveShadow = true
        // Deliberately absent from pickObjects: the fascia is presentation only.
        this.edgeRoot.add(edgeMesh)
        root.userData.edgeMesh = edgeMesh
      } else edge.dispose()

      const water = this.buildWaterGeometry(bounds)
      if (water.getAttribute('position').count > 0) {
        const waterMesh = new THREE.Mesh(water, this.waterMaterial)
        waterMesh.name = `water-surface-${chunkId}`
        waterMesh.renderOrder = 2
        waterMesh.receiveShadow = true
        waterMesh.userData.waterSurface = true
        this.waterRoot.add(waterMesh)
        root.userData.waterMesh = waterMesh
      } else water.dispose()

      const foam = this.buildShoreFoamGeometry(bounds)
      if (foam.getAttribute('position').count > 0) {
        const foamMesh = new THREE.Mesh(foam, this.foamMaterial)
        foamMesh.name = `shoreline-foam-${chunkId}`
        foamMesh.renderOrder = 3
        foamMesh.receiveShadow = false
        foamMesh.castShadow = false
        this.foamRoot.add(foamMesh)
        root.userData.foamMesh = foamMesh
      } else foam.dispose()

      if (this.useRoadMeshes) {
        const road = this.buildRoadGeometry(bounds)
        if (road.getAttribute('position').count > 0) {
          const roadMesh = new THREE.Mesh(road, this.roadMaterials)
          roadMesh.name = `terrain-roads-${chunkId}`
          roadMesh.castShadow = false
          roadMesh.receiveShadow = true
          roadMesh.renderOrder = 3
          this.roadRoot.add(roadMesh)
          root.userData.roadMesh = roadMesh
        } else road.dispose()
      }

      const bridge = this.buildBridgeGeometry(bounds)
      if (bridge.getAttribute('position').count > 0) {
        const bridgeMesh = new THREE.Mesh(bridge, this.bridgeMaterial)
        bridgeMesh.name = `bridge-decks-${chunkId}`
        bridgeMesh.castShadow = true
        bridgeMesh.receiveShadow = true
        bridgeMesh.renderOrder = 4
        this.bridgeRoot.add(bridgeMesh)
        root.userData.bridgeMesh = bridgeMesh
      } else bridge.dispose()
      this.chunks.set(chunkId, { root, geometry, revision })
    }
    for (const [chunkId, record] of this.chunks) {
      if (!retained.has(chunkId)) this.removeChunk(chunkId, record)
    }
  }

  sampleHeight(worldX: number, worldZ: number): number {
    const tx = THREE.MathUtils.clamp(worldX / this.tileSize + 0.5, 0, this.width)
    const ty = THREE.MathUtils.clamp(worldZ / this.tileSize + 0.5, 0, this.height)
    const x = Math.floor(tx)
    const y = Math.floor(ty)
    const fx = tx - x
    const fy = ty - y
    const h00 = this.cornerHeight(x, y)
    const h10 = this.cornerHeight(x + 1, y)
    const h01 = this.cornerHeight(x, y + 1)
    const h11 = this.cornerHeight(x + 1, y + 1)
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(h00, h10, fx),
      THREE.MathUtils.lerp(h01, h11, fx),
      fy,
    )
  }

  setFrame(timeSeconds: number, pixelsPerTile: number, paused = false): void {
    this.material.uniforms.uTime!.value = timeSeconds
    this.material.uniforms.uPixelsPerTile!.value = Math.max(0, pixelsPerTile)
    const markingMaterial = this.roadMaterials[2]!
    markingMaterial.opacity = THREE.MathUtils.smoothstep(
      pixelsPerTile,
      ROAD_MARKING_FADE_START_PPT,
      ROAD_MARKING_FADE_END_PPT,
    )
    markingMaterial.visible = markingMaterial.opacity > 0.01
    const safeTime = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0
    if (!paused && this.lastFrameTime !== undefined) {
      this.waterAnimationTime += Math.max(0, safeTime - this.lastFrameTime)
    }
    this.lastFrameTime = safeTime
    const time = this.waterMaterial.userData.waterTime as { value: number }
    time.value = this.waterAnimationTime
    const normalMap = this.waterMaterial.normalMap
    if (normalMap) {
      normalMap.offset.set(
        (this.waterAnimationTime * 0.006) % 1,
        (this.waterAnimationTime * 0.0035) % 1,
      )
    }
  }

  dispose(): void {
    for (const [chunkId, record] of this.chunks) this.removeChunk(chunkId, record)
    this.geometry.dispose()
    this.material.dispose()
    this.waterMaterial.normalMap?.dispose()
    this.waterMaterial.dispose()
    this.foamMaterial.dispose()
    this.bridgeMaterial.dispose()
    this.edgeMaterial.dispose()
    for (const material of this.roadMaterials) material.dispose()
    this.data.dispose()
    this.biomeData.dispose()
  }

  private buildTerrainGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const subdivisions = TERRAIN_SUBDIVISIONS
    const cellsX = Math.max(0, bounds.maxX - bounds.minX) * subdivisions
    const cellsY = Math.max(0, bounds.maxY - bounds.minY) * subdivisions
    const row = cellsX + 1
    const positions = new Float32Array((cellsX + 1) * (cellsY + 1) * 3)
    const normals = new Float32Array((cellsX + 1) * (cellsY + 1) * 3)
    const uvs = new Float32Array((cellsX + 1) * (cellsY + 1) * 2)
    let p = 0
    let u = 0
    for (let gy = 0; gy <= cellsY; gy++) {
      const logicalY = bounds.minY + gy / subdivisions
      for (let gx = 0; gx <= cellsX; gx++) {
        const logicalX = bounds.minX + gx / subdivisions
        positions[p++] = (logicalX - 0.5) * this.tileSize
        positions[p++] = this.interpolatedCornerHeight(logicalX, logicalY)
        positions[p++] = (logicalY - 0.5) * this.tileSize
        const normalOffset = ((gy * row) + gx) * 3
        this.writeTerrainNormal(logicalX, logicalY, normals, normalOffset)
        uvs[u++] = logicalX / this.width
        uvs[u++] = logicalY / this.height
      }
    }
    const vertexCount = (cellsX + 1) * (cellsY + 1)
    const indices = vertexCount <= 65_535
      ? new Uint16Array(cellsX * cellsY * 6)
      : new Uint32Array(cellsX * cellsY * 6)
    let i = 0
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        const a = y * row + x
        const b = a + 1
        const c = a + row
        const d = c + 1
        indices[i++] = a
        indices[i++] = c
        indices[i++] = b
        indices[i++] = b
        indices[i++] = c
        indices[i++] = d
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }

  /** Build a single presentation-only draw for the true world perimeter. */
  private buildEdgeGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const positions: number[] = []
    const colors: number[] = []
    const indices: number[] = []
    const lip = this.tileSize * EDGE_LIP_TILES

    const appendSegment = (
      logicalX0: number,
      logicalY0: number,
      logicalX1: number,
      logicalY1: number,
      outwardX: number,
      outwardZ: number,
      biomeX: number,
      biomeY: number,
    ) => {
      const h0 = this.cornerHeight(logicalX0, logicalY0)
      const h1 = this.cornerHeight(logicalX1, logicalY1)
      const x0 = (logicalX0 - 0.5) * this.tileSize
      const z0 = (logicalY0 - 0.5) * this.tileSize
      const x1 = (logicalX1 - 0.5) * this.tileSize
      const z1 = (logicalY1 - 0.5) * this.tileSize
      const ox0 = x0 + outwardX * lip
      const oz0 = z0 + outwardZ * lip
      const ox1 = x1 + outwardX * lip
      const oz1 = z1 + outwardZ * lip
      const palette = edgePalette(this.source?.getBiome?.(biomeX, biomeY) ?? RenderBiome.plains)
      const bottom0 = h0 - EDGE_SOIL_DEPTH - edgeDepthVariation(logicalX0, logicalY0)
      const bottom1 = h1 - EDGE_SOIL_DEPTH - edgeDepthVariation(logicalX1, logicalY1)
      appendColoredQuad(
        positions, colors, indices,
        [x0, h0, z0], [x1, h1, z1], [ox1, h1, oz1], [ox0, h0, oz0],
        palette.turf, palette.turf,
      )
      appendColoredQuad(
        positions, colors, indices,
        [ox0, h0, oz0], [ox1, h1, oz1],
        [ox1, h1 - EDGE_SOIL_RECESS, oz1], [ox0, h0 - EDGE_SOIL_RECESS, oz0],
        palette.turf, palette.soil,
      )
      appendColoredQuad(
        positions, colors, indices,
        [ox0, h0 - EDGE_SOIL_RECESS, oz0], [ox1, h1 - EDGE_SOIL_RECESS, oz1],
        [ox1, bottom1, oz1], [ox0, bottom0, oz0],
        palette.soil, palette.deep,
      )
    }

    if (bounds.minY === 0) for (let x = bounds.minX; x < bounds.maxX; x++) {
      appendSegment(x, 0, x + 1, 0, 0, -1, x, 0)
    }
    if (bounds.maxY === this.height) for (let x = bounds.minX; x < bounds.maxX; x++) {
      appendSegment(x + 1, this.height, x, this.height, 0, 1, x, this.height - 1)
    }
    if (bounds.minX === 0) for (let y = bounds.minY; y < bounds.maxY; y++) {
      appendSegment(0, y + 1, 0, y, -1, 0, 0, y)
    }
    if (bounds.maxX === this.width) for (let y = bounds.minY; y < bounds.maxY; y++) {
      appendSegment(this.width, y, this.width, y + 1, 1, 0, this.width - 1, y)
    }

    const appendCorner = (logicalX: number, logicalY: number, outwardX: number, outwardZ: number) => {
      const h = this.cornerHeight(logicalX, logicalY)
      const x = (logicalX - 0.5) * this.tileSize
      const z = (logicalY - 0.5) * this.tileSize
      const ox = x + outwardX * lip
      const oz = z + outwardZ * lip
      const biomeX = THREE.MathUtils.clamp(logicalX + (outwardX < 0 ? 0 : -1), 0, this.width - 1)
      const biomeY = THREE.MathUtils.clamp(logicalY + (outwardZ < 0 ? 0 : -1), 0, this.height - 1)
      const palette = edgePalette(this.source?.getBiome?.(biomeX, biomeY) ?? RenderBiome.plains)
      const upper = h - EDGE_SOIL_RECESS
      const bottom = h - EDGE_SOIL_DEPTH - edgeDepthVariation(logicalX, logicalY)
      appendColoredQuad(
        positions, colors, indices,
        [x, h, z], [ox, h, z], [ox, h, oz], [x, h, oz],
        palette.turf, palette.turf,
      )
      for (const [a, b] of [
        [[ox, h, z], [ox, h, oz]],
        [[x, h, oz], [ox, h, oz]],
      ] as const) {
        appendColoredQuad(
          positions, colors, indices,
          a, b, [b[0], upper, b[2]], [a[0], upper, a[2]],
          palette.turf, palette.soil,
        )
        appendColoredQuad(
          positions, colors, indices,
          [a[0], upper, a[2]], [b[0], upper, b[2]],
          [b[0], bottom, b[2]], [a[0], bottom, a[2]],
          palette.soil, palette.deep,
        )
      }
    }

    if (bounds.minX === 0 && bounds.minY === 0) appendCorner(0, 0, -1, -1)
    if (bounds.maxX === this.width && bounds.minY === 0) appendCorner(this.width, 0, 1, -1)
    if (bounds.minX === 0 && bounds.maxY === this.height) appendCorner(0, this.height, -1, 1)
    if (bounds.maxX === this.width && bounds.maxY === this.height) appendCorner(this.width, this.height, 1, 1)

    const geometry = arrayGeometry(positions, [], indices)
    geometry.deleteAttribute('uv')
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    return geometry
  }

  private buildWaterGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        this.source?.readSurface(y * this.width + x, texel)
        if (!this.source || texel.kind !== SurfaceKind.lake) continue
        const h = (this.source.getWaterElevation?.(x, y) ?? this.tileHeight(x, y)) + WATER_LIFT
        const mask = texel.neighborMask & 0x0f
        const north = (mask & 1) !== 0
        const east = (mask & 2) !== 0
        const south = (mask & 4) !== 0
        const west = (mask & 8) !== 0
        const shorelineHeight = (exposed: boolean) => h - (exposed ? SHORE_WATER_RECESS : 0)
        const h00 = shorelineHeight(!north || !west)
        const h10 = shorelineHeight(!north || !east)
        const h01 = shorelineHeight(!south || !west)
        const h11 = shorelineHeight(!south || !east)
        const base = positions.length / 3
        const x0 = (x - 0.5) * this.tileSize
        const x1 = (x + 0.5) * this.tileSize
        const z0 = (y - 0.5) * this.tileSize
        const z1 = (y + 0.5) * this.tileSize
        positions.push(x0, h00, z0, x1, h10, z0, x0, h01, z1, x1, h11, z1)
        uvs.push(x, y, x + 1, y, x, y + 1, x + 1, y + 1)
        indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
      }
    }
    return arrayGeometry(positions, uvs, indices)
  }

  /** Narrow, broken ribbons inside exposed lake edges read as surf, not props. */
  private buildShoreFoamGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        this.source?.readSurface(y * this.width + x, texel)
        if (!this.source || texel.kind !== SurfaceKind.lake || (texel.neighborMask & 0x0f) === 0x0f) continue
        const h = (this.source.getWaterElevation?.(x, y) ?? this.tileHeight(x, y)) + SHORE_FOAM_LIFT
        const x0 = (x - 0.5) * this.tileSize
        const x1 = (x + 0.5) * this.tileSize
        const z0 = (y - 0.5) * this.tileSize
        const z1 = (y + 0.5) * this.tileSize
        const width = this.tileSize * SHORE_FOAM_WIDTH
        if ((texel.neighborMask & 1) === 0) appendFoamStrip(positions, uvs, indices, x0, z0, x1, z0, 0, width, h, x, y)
        if ((texel.neighborMask & 2) === 0) appendFoamStrip(positions, uvs, indices, x1, z0, x1, z1, -width, 0, h, x, y)
        if ((texel.neighborMask & 4) === 0) appendFoamStrip(positions, uvs, indices, x1, z1, x0, z1, 0, -width, h, x, y)
        if ((texel.neighborMask & 8) === 0) appendFoamStrip(positions, uvs, indices, x0, z1, x0, z0, width, 0, h, x, y)
      }
    }
    return arrayGeometry(positions, uvs, indices)
  }

  private buildBridgeGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        texel.transport = undefined
        this.source?.readSurface(y * this.width + x, texel)
        const transport = texel.transport ?? 0
        if (!this.source || (transport & (TransportVisual.bridge << 8)) === 0) continue
        const topology = transport & 0xff
        const roadClass = (transport >>> 8) & TransportVisual.classMask
        const halfWidth = this.tileSize * (0.15 + Math.max(0, roadClass - 1) * 0.035)
        const deckY = (this.source.getWaterElevation?.(x, y) ?? this.tileHeight(x, y)) + 0.13
        const endpoints = bridgeEndpoints(topology)
        if (endpoints.length === 0) endpoints.push([0, -0.5], [0, 0.5])
        for (const [dx, dz] of endpoints) {
          appendDeckSegment(
            positions,
            uvs,
            indices,
            x * this.tileSize,
            deckY,
            y * this.tileSize,
            x * this.tileSize + dx * this.tileSize,
            y * this.tileSize + dz * this.tileSize,
            halfWidth,
            0.07,
          )
        }
      }
    }
    return arrayGeometry(positions, uvs, indices)
  }

  /** Build V4 roadbeds from transport topology; bridge cells own separate decks. */
  private buildRoadGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const network = this.source?.getRoadNetwork?.()
    if (network) return this.buildCompiledRoadGeometry(bounds, network)
    return this.buildPackedRoadGeometry(bounds)
  }

  /** Chain geometry gives degree-two turns one continuous fitted ribbon. */
  private buildCompiledRoadGeometry(
    bounds: TileBounds,
    network: NonNullable<ReturnType<NonNullable<ViewportRenderSource['getRoadNetwork']>>>,
  ): THREE.BufferGeometry {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const groups: Array<{ start: number; count: number; materialIndex: number }> = []
    const chunkX = Math.floor(bounds.minX / this.chunkSize)
    const chunkY = Math.floor(bounds.minY / this.chunkSize)
    const chunkId = chunkY * Math.ceil(this.width / this.chunkSize) + chunkX
    const chunk = network.chunks.get(chunkId)
    const segmentIds = new Set(chunk?.segmentIds ?? [])
    const junctionIds = new Set(chunk?.junctionIds ?? [])
    const junctionById = new Map(network.junctions.map((junction) => [junction.id, junction]))
    const sampleHeight = (wx: number, wz: number) => this.sampleHeight(wx, wz)
    const owns = (logicalX: number, logicalY: number) =>
      logicalX >= bounds.minX && logicalX < bounds.maxX && logicalY >= bounds.minY && logicalY < bounds.maxY
    const isBridge = (logicalX: number, logicalY: number) => {
      if (!this.source) return false
      const x = THREE.MathUtils.clamp(Math.floor(logicalX), 0, this.width - 1)
      const y = THREE.MathUtils.clamp(Math.floor(logicalY), 0, this.height - 1)
      const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
      this.source.readSurface(y * this.width + x, out)
      return ((out.transport ?? 0) & (TransportVisual.bridge << 8)) !== 0
    }
    for (const segment of network.segments) {
      if (!segmentIds.has(segment.id) || segment.points.length < 2) continue
      const samples = sampleRoadCurve(segment.points)
      // Use the compiler profile verbatim: lane offsets are derived from this
      // same half-width, so an outer arterial/highway lane cannot escape the
      // asphalt even when tileSize differs from one.
      const halfWidth = segment.profile.halfWidth * this.tileSize
      // Keep longitudinal paint outside the junction asphalt/stop-line area.
      // Values are in logical tile units because the curve points are, too.
      const markingClearance = halfWidth * 1.55 / this.tileSize
      const trimStart = segment.fromJunctionId && (junctionById.get(segment.fromJunctionId)?.ports.length ?? 0) >= 3
        ? markingClearance : 0
      const trimEnd = segment.toJunctionId && (junctionById.get(segment.toJunctionId)?.ports.length ?? 0) >= 3
        ? markingClearance : 0
      appendPolylineRibbon(positions, uvs, indices, groups, 0, samples,
        halfWidth * 1.18, ROAD_SHOULDER_LIFT, this.tileSize, sampleHeight, owns, isBridge)
      appendPolylineRibbon(positions, uvs, indices, groups, 1, samples,
        halfWidth, ROAD_SURFACE_LIFT, this.tileSize, sampleHeight, owns, isBridge)
      if (segment.roadClass >= TransportVisual.collector) {
        appendPolylineRibbon(positions, uvs, indices, groups, 2, samples,
          this.tileSize * (segment.roadClass >= TransportVisual.highway ? 0.018 : 0.011),
          ROAD_MARKING_LIFT, this.tileSize, sampleHeight, owns, isBridge, 0, true, trimStart, trimEnd)
      }
    }
    for (const junction of network.junctions) {
      if (!junctionIds.has(junction.id) || junction.ports.length < 3) continue
      const incident = junction.segmentIds.map((id) => network.segments.find((segment) => segment.id === id)).filter(Boolean)
      const maxClass = Math.max(TransportVisual.local, ...incident.map((segment) => segment!.roadClass))
      const halfWidth = Math.max(...incident.map((segment) => segment!.profile.halfWidth),
        network.profiles[maxClass as keyof typeof network.profiles]?.halfWidth ?? 0.21) * this.tileSize
      appendRoadJunctionPolygon(positions, uvs, indices, groups, 0, junction, halfWidth * 1.18,
        ROAD_SHOULDER_LIFT, this.tileSize, sampleHeight)
      appendRoadJunctionPolygon(positions, uvs, indices, groups, 1, junction, halfWidth,
        ROAD_SURFACE_LIFT, this.tileSize, sampleHeight)
      if (junction.hasStopLines) appendJunctionStopLines(positions, uvs, indices, groups,
        junction, halfWidth, this.tileSize, sampleHeight)
    }
    const consolidated = consolidateRoadGroups(indices, groups, this.roadMaterials.length)
    const geometry = arrayGeometry(positions, uvs, consolidated.indices)
    for (const group of consolidated.groups) geometry.addGroup(group.start, group.count, group.materialIndex)
    return geometry
  }

  private buildPackedRoadGeometry(bounds: TileBounds): THREE.BufferGeometry {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    const groups: Array<{ start: number; count: number; materialIndex: number }> = []
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let y = bounds.minY; y < bounds.maxY; y++) {
      for (let x = bounds.minX; x < bounds.maxX; x++) {
        texel.transport = undefined
        this.source?.readSurface(y * this.width + x, texel)
        const transport = texel.transport ?? 0
        if (transport === 0 || (transport & (TransportVisual.bridge << 8)) !== 0) continue
        const topology = transport & 0xff
        if (topology === 0) continue
        const roadClass = Math.max(1, (transport >>> 8) & TransportVisual.classMask)
        const halfWidth = roadHalfWidth(this.tileSize, roadClass)
        const arms = roadEndpoints(topology)

        for (const [, dx, dz] of arms) {
          const neighbor = this.neighborTransport(x, y, dx, dz)
          const neighborClass = neighbor === 0
            ? roadClass
            : Math.max(1, (neighbor >>> 8) & TransportVisual.classMask)
          // Both chunks calculate this from the same pair of classes.
          const seamWidth = Math.min(halfWidth, roadHalfWidth(this.tileSize, neighborClass))
          appendTerrainRibbon(
            positions, uvs, indices, groups, 0,
            x * this.tileSize, y * this.tileSize,
            dx * this.tileSize * 0.5, dz * this.tileSize * 0.5,
            halfWidth * 1.18, seamWidth * 1.18, ROAD_SHOULDER_LIFT,
            (wx, wz) => this.sampleHeight(wx, wz),
          )
          appendTerrainRibbon(
            positions, uvs, indices, groups, 1,
            x * this.tileSize, y * this.tileSize,
            dx * this.tileSize * 0.5, dz * this.tileSize * 0.5,
            halfWidth, seamWidth, ROAD_SURFACE_LIFT,
            (wx, wz) => this.sampleHeight(wx, wz),
          )
          if (roadClass >= TransportVisual.collector) {
            appendTerrainRibbon(
              positions, uvs, indices, groups, 2,
              x * this.tileSize, y * this.tileSize,
              dx * this.tileSize * 0.5, dz * this.tileSize * 0.5,
              this.tileSize * (roadClass >= TransportVisual.highway ? 0.018 : 0.011),
              this.tileSize * 0.011, ROAD_MARKING_LIFT,
              (wx, wz) => this.sampleHeight(wx, wz),
            )
          }
        }

        // A raised, terrain-conforming fan closes every arm combination and
        // rounds intersections without topology-specific special cases.
        appendTerrainHub(
          positions, uvs, indices, groups, 0,
          x * this.tileSize, y * this.tileSize, halfWidth * 1.18, ROAD_SHOULDER_LIFT,
          (wx, wz) => this.sampleHeight(wx, wz),
        )
        appendTerrainHub(
          positions, uvs, indices, groups, 1,
          x * this.tileSize, y * this.tileSize, halfWidth, ROAD_SURFACE_LIFT,
          (wx, wz) => this.sampleHeight(wx, wz),
        )
      }
    }
    const consolidated = consolidateRoadGroups(indices, groups, this.roadMaterials.length)
    const geometry = arrayGeometry(positions, uvs, consolidated.indices)
    for (const group of consolidated.groups) geometry.addGroup(group.start, group.count, group.materialIndex)
    return geometry
  }

  private writeTerrainNormal(
    logicalX: number,
    logicalY: number,
    target: Float32Array,
    offset: number,
  ): void {
    const step = 1
    const left = this.interpolatedCornerHeight(Math.max(0, logicalX - step), logicalY)
    const right = this.interpolatedCornerHeight(Math.min(this.width, logicalX + step), logicalY)
    const down = this.interpolatedCornerHeight(logicalX, Math.max(0, logicalY - step))
    const up = this.interpolatedCornerHeight(logicalX, Math.min(this.height, logicalY + step))
    const nx = left - right
    const ny = this.tileSize * step * 2
    const nz = down - up
    const inverseLength = 1 / (Math.hypot(nx, ny, nz) || 1)
    target[offset] = nx * inverseLength
    target[offset + 1] = ny * inverseLength
    target[offset + 2] = nz * inverseLength
  }

  private neighborTransport(x: number, y: number, dx: number, dz: number): number {
    const nx = x + Math.sign(dx)
    const ny = y + Math.sign(dz)
    if (!this.source || nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) return 0
    const out: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    this.source.readSurface(ny * this.width + nx, out)
    return out.transport ?? 0
  }

  private sourceHasRelief(): boolean {
    if (!this.source?.getCornerElevation) return false
    // Compatibility sources deliberately return zero. A bounded lattice probe
    // avoids allocating or walking the full million-cell world at startup.
    const samples = 8
    for (let sy = 0; sy <= samples; sy++) {
      const y = Math.round((sy / samples) * this.height)
      for (let sx = 0; sx <= samples; sx++) {
        const x = Math.round((sx / samples) * this.width)
        if (Math.abs(this.source.getCornerElevation(x, y)) > 1e-5) return true
      }
    }
    return false
  }

  private interpolatedCornerHeight(x: number, y: number): number {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    if (fx === 0 && fy === 0) return this.cornerHeight(ix, iy)
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.cornerHeight(ix, iy), this.cornerHeight(ix + 1, iy), fx),
      THREE.MathUtils.lerp(this.cornerHeight(ix, iy + 1), this.cornerHeight(ix + 1, iy + 1), fx),
      fy,
    )
  }

  private cornerHeight(x: number, y: number): number {
    const cx = THREE.MathUtils.clamp(x, 0, this.width)
    const cy = THREE.MathUtils.clamp(y, 0, this.height)
    const base = this.source?.getCornerElevation?.(cx, cy) ?? 0
    if (!this.source) return base
    let adjacent = 0
    let lakes = 0
    const texel: SurfaceTexel = { kind: 0, neighborMask: 0, region: 0, flags: 0 }
    for (let oy = -1; oy <= 0; oy++) for (let ox = -1; ox <= 0; ox++) {
      const tx = cx + ox
      const ty = cy + oy
      if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue
      adjacent++
      this.source.readSurface(ty * this.width + tx, texel)
      if (texel.kind === SurfaceKind.lake) lakes++
    }
    // Shared corner lowering forms a real basin and a sloped bank at mixed
    // land/water corners without allowing neighboring chunks to disagree.
    return base - (adjacent > 0 ? (lakes / adjacent) * LAKE_BASIN_DEPTH : 0)
  }

  private tileHeight(x: number, y: number): number {
    return this.source?.getTileElevation?.(x, y)
      ?? (this.cornerHeight(x, y) + this.cornerHeight(x + 1, y) + this.cornerHeight(x, y + 1) + this.cornerHeight(x + 1, y + 1)) * 0.25
  }

  private removeChunk(chunkId: ChunkId, record: SurfaceChunkRecord): void {
    this.terrainRoot.remove(record.root)
    const water = record.root.userData.waterMesh as THREE.Mesh | undefined
    if (water) {
      this.waterRoot.remove(water)
      water.geometry.dispose()
    }
    const foam = record.root.userData.foamMesh as THREE.Mesh | undefined
    if (foam) {
      this.foamRoot.remove(foam)
      foam.geometry.dispose()
    }
    const bridge = record.root.userData.bridgeMesh as THREE.Mesh | undefined
    if (bridge) {
      this.bridgeRoot.remove(bridge)
      bridge.geometry.dispose()
    }
    const road = record.root.userData.roadMesh as THREE.Mesh | undefined
    if (road) {
      this.roadRoot.remove(road)
      road.geometry.dispose()
    }
    const edge = record.root.userData.edgeMesh as THREE.Mesh | undefined
    if (edge) {
      this.edgeRoot.remove(edge)
      edge.geometry.dispose()
    }
    record.geometry.dispose()
    record.root.clear()
    this.chunks.delete(chunkId)
  }

  private setChunkVisible(record: SurfaceChunkRecord, visible: boolean): void {
    record.root.visible = visible
    const terrain = record.root.children[0] as THREE.Mesh | undefined
    const water = record.root.userData.waterMesh as THREE.Mesh | undefined
    const foam = record.root.userData.foamMesh as THREE.Mesh | undefined
    const bridge = record.root.userData.bridgeMesh as THREE.Mesh | undefined
    const road = record.root.userData.roadMesh as THREE.Mesh | undefined
    const edge = record.root.userData.edgeMesh as THREE.Mesh | undefined
    if (terrain) terrain.visible = visible
    if (water) water.visible = visible
    if (foam) foam.visible = visible
    if (bridge) bridge.visible = visible
    if (road) road.visible = visible
    if (edge) edge.visible = visible
  }
}

type Point3 = readonly [number, number, number]
type Rgb = readonly [number, number, number]

interface EdgePalette {
  turf: Rgb
  soil: Rgb
  deep: Rgb
}

const EDGE_PALETTES: Record<number, EdgePalette> = {
  [RenderBiome.plains]: palette(0x477243, 0x6b4c2b, 0x3f2b20),
  [RenderBiome.forest]: palette(0x315a38, 0x5a4028, 0x35251d),
  [RenderBiome.arid]: palette(0x806438, 0x95632d, 0x5e3e25),
  [RenderBiome.wetland]: palette(0x365e49, 0x4b4030, 0x2b2c27),
  [RenderBiome.alpine]: palette(0x58635a, 0x68655c, 0x41413f),
  [RenderBiome.coast]: palette(0x80734c, 0xa1834f, 0x69533a),
  [RenderBiome.meadow]: palette(0x5c873f, 0x70522e, 0x443321),
  [RenderBiome.boreal]: palette(0x2e5648, 0x4d4936, 0x30342f),
  [RenderBiome.scrubland]: palette(0x77743d, 0x806238, 0x514128),
}

function palette(turf: number, soil: number, deep: number): EdgePalette {
  return { turf: colorTuple(turf), soil: colorTuple(soil), deep: colorTuple(deep) }
}

function colorTuple(hex: number): Rgb {
  const color = new THREE.Color(hex)
  return [color.r, color.g, color.b]
}

function edgePalette(biome: number): EdgePalette {
  return EDGE_PALETTES[biome] ?? EDGE_PALETTES[RenderBiome.plains]!
}

function edgeDepthVariation(logicalX: number, logicalY: number): number {
  const hash = Math.sin(logicalX * 127.1 + logicalY * 311.7 + 19.19) * 43758.5453
  return (hash - Math.floor(hash)) * EDGE_DEPTH_VARIATION
}

function appendColoredQuad(
  positions: number[],
  colors: number[],
  indices: number[],
  a: Point3,
  b: Point3,
  c: Point3,
  d: Point3,
  topColor: Rgb,
  bottomColor: Rgb,
): void {
  const base = positions.length / 3
  positions.push(...a, ...b, ...c, ...d)
  colors.push(...topColor, ...topColor, ...bottomColor, ...bottomColor)
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

function appendFoamStrip(
  positions: number[], uvs: number[], indices: number[],
  x0: number, z0: number, x1: number, z1: number,
  inwardX: number, inwardZ: number, height: number, tileX: number, tileY: number,
): void {
  const base = positions.length / 3
  const seed = ((Math.imul(tileX + 1, 73_856_093) ^ Math.imul(tileY + 1, 19_349_663)) >>> 0) / 0xffff_ffff
  positions.push(
    x0, height, z0, x1, height, z1,
    x0 + inwardX, height, z0 + inwardZ, x1 + inwardX, height, z1 + inwardZ,
  )
  uvs.push(0, seed, 1, seed, 0, seed + 1, 1, seed + 1)
  indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
}

function arrayGeometry(positions: number[], uvs: number[], indices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  if (positions.length > 0) {
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
  }
  return geometry
}

type RoadGeometryGroup = { start: number; count: number; materialIndex: number }
type HeightSampler = (worldX: number, worldZ: number) => number

/** Reorder indices once so each road material costs at most one draw per chunk. */
function consolidateRoadGroups(
  indices: readonly number[],
  groups: readonly RoadGeometryGroup[],
  materialCount: number,
): { indices: number[]; groups: RoadGeometryGroup[] } {
  const ordered: number[] = []
  const consolidated: RoadGeometryGroup[] = []
  for (let materialIndex = 0; materialIndex < materialCount; materialIndex++) {
    const start = ordered.length
    for (const group of groups) {
      if (group.materialIndex !== materialIndex) continue
      for (let index = group.start; index < group.start + group.count; index++) {
        ordered.push(indices[index]!)
      }
    }
    if (ordered.length > start) {
      consolidated.push({ start, count: ordered.length - start, materialIndex })
    }
  }
  return { indices: ordered, groups: consolidated }
}

function roadHalfWidth(tileSize: number, roadClass: number): number {
  return tileSize * (0.15 + Math.max(0, Math.min(3, roadClass - 1)) * 0.035)
}

function roadEndpoints(topology: number): Array<readonly [number, number, number]> {
  const directions: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, -1], [2, 1, -1], [4, 1, 0], [8, 1, 1],
    [16, 0, 1], [32, -1, 1], [64, -1, 0], [128, -1, -1],
  ]
  return directions.filter(([bit]) => (topology & bit) !== 0)
}

function appendTerrainRibbon(
  positions: number[], uvs: number[], indices: number[], groups: RoadGeometryGroup[], materialIndex: number,
  startX: number, startZ: number, deltaX: number, deltaZ: number,
  startHalfWidth: number, endHalfWidth: number, lift: number, sampleHeight: HeightSampler,
): void {
  const length = Math.hypot(deltaX, deltaZ)
  if (length < 1e-6) return
  const lateralX = -deltaZ / length
  const lateralZ = deltaX / length
  const base = positions.length / 3
  for (let step = 0; step <= ROAD_ARM_STEPS; step++) {
    const t = step / ROAD_ARM_STEPS
    const width = THREE.MathUtils.lerp(startHalfWidth, endHalfWidth, t)
    const centerX = startX + deltaX * t
    const centerZ = startZ + deltaZ * t
    for (const side of [1, -1]) {
      const worldX = centerX + lateralX * width * side
      const worldZ = centerZ + lateralZ * width * side
      positions.push(worldX, sampleHeight(worldX, worldZ) + lift, worldZ)
      uvs.push(t, side > 0 ? 0 : 1)
    }
  }
  const groupStart = indices.length
  for (let step = 0; step < ROAD_ARM_STEPS; step++) {
    const a = base + step * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3
    indices.push(a, c, b, b, c, d)
  }
  groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex })
}

function appendTerrainHub(
  positions: number[], uvs: number[], indices: number[], groups: RoadGeometryGroup[], materialIndex: number,
  centerX: number, centerZ: number, radius: number, lift: number, sampleHeight: HeightSampler,
): void {
  const segments = 16
  const base = positions.length / 3
  positions.push(centerX, sampleHeight(centerX, centerZ) + lift, centerZ)
  uvs.push(0.5, 0.5)
  for (let segment = 0; segment <= segments; segment++) {
    const angle = (segment / segments) * Math.PI * 2
    const worldX = centerX + Math.cos(angle) * radius
    const worldZ = centerZ + Math.sin(angle) * radius
    positions.push(worldX, sampleHeight(worldX, worldZ) + lift, worldZ)
    uvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5)
  }
  const groupStart = indices.length
  for (let segment = 0; segment < segments; segment++) {
    indices.push(base, base + segment + 1, base + segment + 2)
  }
  groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex })
}

function sampleRoadCurve(points: readonly RoadNetworkPoint[]): RoadNetworkPoint[] {
  return [...smoothRoadCenterline(points)]
}

function appendPolylineRibbon(
  positions: number[], uvs: number[], indices: number[], groups: RoadGeometryGroup[], materialIndex: number,
  points: readonly RoadNetworkPoint[], halfWidth: number, lift: number, tileSize: number,
  sampleHeight: HeightSampler, owns: (x: number, y: number) => boolean,
  isBridge: (x: number, y: number) => boolean, offset = 0, dashed = false,
  trimStart = 0, trimEnd = 0,
): void {
  const dashLength = 0.28
  const dashGap = 0.22
  const dashPeriod = dashLength + dashGap
  const frame = (index: number) => {
    const previous = points[Math.max(0, index - 1)]!
    const next = points[Math.min(points.length - 1, index + 1)]!
    const dx = next.x - previous.x
    const dy = next.y - previous.y
    const length = Math.hypot(dx, dy) || 1
    return { x: -dy / length, y: dx / length }
  }
  const distances = [0]
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!
    const b = points[index + 1]!
    distances.push(distances[index]! + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const pathEnd = Math.max(trimStart, distances.at(-1)! - trimEnd)
  const appendPiece = (
    a: RoadNetworkPoint, b: RoadNetworkPoint,
    an: { x: number; y: number }, bn: { x: number; y: number },
  ) => {
    const mx = (a.x + b.x) * 0.5
    const my = (a.y + b.y) * 0.5
    if (!owns(mx, my) || isBridge(mx, my)) return
    const x0 = (a.x - 0.5) * tileSize + an.x * offset
    const z0 = (a.y - 0.5) * tileSize + an.y * offset
    const x1 = (b.x - 0.5) * tileSize + bn.x * offset
    const z1 = (b.y - 0.5) * tileSize + bn.y * offset
    const base = positions.length / 3
    positions.push(
      x0 + an.x * halfWidth, sampleHeight(x0 + an.x * halfWidth, z0 + an.y * halfWidth) + lift, z0 + an.y * halfWidth,
      x0 - an.x * halfWidth, sampleHeight(x0 - an.x * halfWidth, z0 - an.y * halfWidth) + lift, z0 - an.y * halfWidth,
      x1 + bn.x * halfWidth, sampleHeight(x1 + bn.x * halfWidth, z1 + bn.y * halfWidth) + lift, z1 + bn.y * halfWidth,
      x1 - bn.x * halfWidth, sampleHeight(x1 - bn.x * halfWidth, z1 - bn.y * halfWidth) + lift, z1 - bn.y * halfWidth,
    )
    uvs.push(0, 0, 0, 1, 1, 0, 1, 1)
    const start = indices.length
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
    groups.push({ start, count: 6, materialIndex })
  }
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index]!
    const b = points[index + 1]!
    const an = frame(index)
    const bn = frame(index + 1)
    const segmentStart = distances[index]!
    const segmentEnd = distances[index + 1]!
    const length = segmentEnd - segmentStart
    if (length < 1e-6) continue
    if (!dashed) {
      appendPiece(a, b, an, bn)
      continue
    }
    let cursor = Math.max(segmentStart, trimStart)
    const end = Math.min(segmentEnd, pathEnd)
    while (cursor < end - 1e-6) {
      const phase = cursor % dashPeriod
      const painted = phase < dashLength - 1e-6
      const boundary = cursor + (painted ? dashLength - phase : dashPeriod - phase)
      const pieceEnd = Math.min(end, boundary)
      if (painted && pieceEnd - cursor > 1e-6) {
        const t0 = (cursor - segmentStart) / length
        const t1 = (pieceEnd - segmentStart) / length
        const pointAt = (t: number): RoadNetworkPoint => ({
          tileId: t < 0.5 ? a.tileId : b.tileId,
          x: THREE.MathUtils.lerp(a.x, b.x, t),
          y: THREE.MathUtils.lerp(a.y, b.y, t),
          elevation: THREE.MathUtils.lerp(a.elevation, b.elevation, t),
        })
        const frameAt = (t: number) => {
          const x = THREE.MathUtils.lerp(an.x, bn.x, t)
          const y = THREE.MathUtils.lerp(an.y, bn.y, t)
          const length = Math.hypot(x, y) || 1
          return { x: x / length, y: y / length }
        }
        appendPiece(pointAt(t0), pointAt(t1), frameAt(t0), frameAt(t1))
      }
      cursor = pieceEnd
    }
  }
}

function appendRoadJunctionPolygon(
  positions: number[], uvs: number[], indices: number[], groups: RoadGeometryGroup[], materialIndex: number,
  junction: RoadJunction, halfWidth: number, lift: number, tileSize: number, sampleHeight: HeightSampler,
): void {
  const cx = (junction.x - 0.5) * tileSize
  const cz = (junction.y - 0.5) * tileSize
  const reach = halfWidth * 1.45
  const boundary = junction.ports.flatMap((port) => {
    const nx = -port.headingY
    const ny = port.headingX
    return [
      { x: cx + port.headingX * reach + nx * halfWidth, z: cz + port.headingY * reach + ny * halfWidth },
      { x: cx + port.headingX * reach - nx * halfWidth, z: cz + port.headingY * reach - ny * halfWidth },
    ]
  }).sort((a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx))
  if (boundary.length < 3) return
  const base = positions.length / 3
  positions.push(cx, sampleHeight(cx, cz) + lift, cz)
  uvs.push(0.5, 0.5)
  for (const point of boundary) {
    positions.push(point.x, sampleHeight(point.x, point.z) + lift, point.z)
    uvs.push((point.x - cx) / (halfWidth * 4) + 0.5, (point.z - cz) / (halfWidth * 4) + 0.5)
  }
  const start = indices.length
  for (let index = 0; index < boundary.length; index++) indices.push(base, base + index + 1, base + ((index + 1) % boundary.length) + 1)
  groups.push({ start, count: indices.length - start, materialIndex })
}

function appendJunctionStopLines(
  positions: number[], uvs: number[], indices: number[], groups: RoadGeometryGroup[],
  junction: RoadJunction, halfWidth: number, tileSize: number, sampleHeight: HeightSampler,
): void {
  const cx = (junction.x - 0.5) * tileSize
  const cz = (junction.y - 0.5) * tileSize
  for (const port of junction.ports) {
    const nx = -port.headingY
    const ny = port.headingX
    const distance = halfWidth * 1.15
    const lineHalf = halfWidth * 0.76
    const thickness = tileSize * 0.018
    const px = cx + port.headingX * distance
    const pz = cz + port.headingY * distance
    const base = positions.length / 3
    const corners = [
      [px + nx * lineHalf + port.headingX * thickness, pz + ny * lineHalf + port.headingY * thickness],
      [px - nx * lineHalf + port.headingX * thickness, pz - ny * lineHalf + port.headingY * thickness],
      [px + nx * lineHalf - port.headingX * thickness, pz + ny * lineHalf - port.headingY * thickness],
      [px - nx * lineHalf - port.headingX * thickness, pz - ny * lineHalf - port.headingY * thickness],
    ] as const
    for (const [x, z] of corners) positions.push(x, sampleHeight(x, z) + ROAD_MARKING_LIFT, z)
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1)
    const start = indices.length
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
    groups.push({ start, count: 6, materialIndex: 2 })
  }
}

function roadMaterial(
  name: string,
  color: number,
  roughness: number,
  polygonOffsetFactor: number,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    name,
    color,
    roughness,
    fog: true,
    depthTest: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor,
    polygonOffsetUnits: polygonOffsetFactor,
  })
}

function createWaterMaterial(): THREE.MeshPhysicalMaterial {
  const time = { value: 0 }
  const normalMap = createWaterNormalTexture()
  const material = new THREE.MeshPhysicalMaterial({
    name: 'independent-lake-water',
    color: 0x176b88,
    roughness: 0.16,
    metalness: 0,
    clearcoat: 0.72,
    clearcoatRoughness: 0.24,
    reflectivity: 0.62,
    ior: 1.333,
    transmission: 0.12,
    transparent: true,
    opacity: 0.82,
    normalMap,
    normalScale: new THREE.Vector2(0.22, 0.22),
    depthWrite: true,
    side: THREE.DoubleSide,
    fog: true,
  })
  material.userData.waterTime = time
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = time
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWaterTime;\nvarying vec2 vWaterPosition;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWaterPosition = position.xz;
transformed.y += (
  sin(position.x * 0.78 + position.z * 0.31 + uWaterTime * 0.22) * 0.004 +
  sin(position.z * 1.06 - position.x * 0.43 - uWaterTime * 0.15) * 0.0025 +
  cos(position.x * 1.55 + position.z * 1.18 + uWaterTime * 0.11) * 0.0015
);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWaterTime;\nvarying vec2 vWaterPosition;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float waterColorPhaseA = vWaterPosition.x * 0.82 + vWaterPosition.y * 0.27 + uWaterTime * 0.18;
float waterColorPhaseB = vWaterPosition.y * 1.13 - vWaterPosition.x * 0.38 - uWaterTime * 0.12;
float waterShimmer = sin(waterColorPhaseA) * cos(waterColorPhaseB) * 0.5 + 0.5;
diffuseColor.rgb *= mix(vec3(0.965, 0.985, 1.0), vec3(1.025, 1.045, 1.055), waterShimmer * 0.28);`,
      )
  }
  material.customProgramCacheKey = () => 'labline-independent-water-v3'
  return material
}

/** Seamless interference normals: broad waves without an image asset or tile seam. */
function createWaterNormalTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  const height = (x: number, y: number) => {
    const u = ((x % size) + size) % size / size
    const v = ((y % size) + size) % size / size
    return Math.sin((u * 3 + v) * Math.PI * 2) * 0.52 +
      Math.sin((v * 4 - u * 2) * Math.PI * 2) * 0.3 +
      Math.cos((u * 5 + v * 3) * Math.PI * 2) * 0.18
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = height(x + 1, y) - height(x - 1, y)
      const dy = height(x, y + 1) - height(x, y - 1)
      const length = Math.hypot(dx, 1.45, dy) || 1
      const offset = (y * size + x) * 4
      data[offset] = Math.round(((-dx / length) * 0.5 + 0.5) * 255)
      data[offset + 1] = Math.round(((-dy / length) * 0.5 + 0.5) * 255)
      data[offset + 2] = Math.round(((1.45 / length) * 0.5 + 0.5) * 255)
      data[offset + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.name = 'procedural-water-wave-normals'
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(0.34, 0.34)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

function createShoreFoamMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: 'tasteful-shoreline-foam',
    color: 0xf7f1df,
    emissive: 0x29261f,
    emissiveIntensity: 0.12,
    roughness: 0.9,
    transparent: true,
    opacity: 0.56,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFoamUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFoamUv = uv;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFoamUv;')
      .replace(
        '#include <alphatest_fragment>',
        `#include <alphatest_fragment>
float foamBreak = sin(vFoamUv.x * 24.0 + vFoamUv.y * 17.0) * 0.5 + 0.5;
float foamEdge = 1.0 - smoothstep(0.08, 0.92, fract(vFoamUv.y));
diffuseColor.a *= smoothstep(0.18, 0.48, foamBreak) * (0.45 + foamEdge * 0.55);
if (diffuseColor.a < 0.08) discard;`,
      )
  }
  material.customProgramCacheKey = () => 'labline-shoreline-foam-v1'
  return material
}

function bridgeEndpoints(topology: number): Array<readonly [number, number]> {
  const directions: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, -0.5], [2, 0.5, -0.5], [4, 0.5, 0], [8, 0.5, 0.5],
    [16, 0, 0.5], [32, -0.5, 0.5], [64, -0.5, 0], [128, -0.5, -0.5],
  ]
  return directions.filter(([bit]) => (topology & bit) !== 0).map(([, x, z]) => [x, z])
}

function appendDeckSegment(
  positions: number[], uvs: number[], indices: number[],
  x0: number, y: number, z0: number, x1: number, z1: number, halfWidth: number, thickness: number,
): void {
  const dx = x1 - x0
  const dz = z1 - z0
  const length = Math.hypot(dx, dz) || 1
  const px = (-dz / length) * halfWidth
  const pz = (dx / length) * halfWidth
  const base = positions.length / 3
  const bottom = y - thickness
  positions.push(
    x0 + px, y, z0 + pz, x0 - px, y, z0 - pz, x1 + px, y, z1 + pz, x1 - px, y, z1 - pz,
    x0 + px, bottom, z0 + pz, x0 - px, bottom, z0 - pz, x1 + px, bottom, z1 + pz, x1 - px, bottom, z1 - pz,
  )
  for (let i = 0; i < 8; i++) uvs.push(i & 1, i >> 1)
  indices.push(
    base, base + 2, base + 1, base + 1, base + 2, base + 3,
    base + 4, base + 5, base + 6, base + 5, base + 7, base + 6,
    base, base + 4, base + 2, base + 4, base + 6, base + 2,
    base + 1, base + 3, base + 5, base + 5, base + 3, base + 7,
    base, base + 1, base + 4, base + 1, base + 5, base + 4,
    base + 2, base + 6, base + 3, base + 3, base + 6, base + 7,
  )
}
