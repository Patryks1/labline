import * as THREE from 'three'
import { SurfaceDataTexture } from './surfaceData'

const VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;

in vec3 position;
in vec2 uv;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

out vec2 vMapUv;
out vec2 vWorldXZ;

void main() {
  vMapUv = uv;
  vWorldXZ = position.xz;
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
uniform vec2 uMapSize;
uniform float uTime;
uniform float uPixelsPerTile;

in vec2 vMapUv;
in vec2 vWorldXZ;
out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float bitSet(float mask, float bitValue) {
  return mod(floor(mask / bitValue), 2.0);
}

float aaBand(float distanceToEdge, float halfWidth) {
  float aa = max(fwidth(distanceToEdge), 0.0008);
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, distanceToEdge);
}

float roadShape(vec2 p, float mask) {
  float halfWidth = 0.18;
  float center = aaBand(abs(p.x - 0.5), halfWidth) * aaBand(abs(p.y - 0.5), halfWidth);
  // Map rows increase toward +Z, so north occupies the low-Y half of a tile.
  float north = bitSet(mask, 1.0) * step(p.y, 0.5) * aaBand(abs(p.x - 0.5), halfWidth);
  float east = bitSet(mask, 2.0) * step(0.5, p.x) * aaBand(abs(p.y - 0.5), halfWidth);
  float south = bitSet(mask, 4.0) * step(0.5, p.y) * aaBand(abs(p.x - 0.5), halfWidth);
  float west = bitSet(mask, 8.0) * step(p.x, 0.5) * aaBand(abs(p.y - 0.5), halfWidth);
  return clamp(max(center, max(max(north, east), max(south, west))), 0.0, 1.0);
}

float roadStripe(vec2 p, float mask) {
  float vertical = max(bitSet(mask, 1.0), bitSet(mask, 4.0));
  float horizontal = max(bitSet(mask, 2.0), bitSet(mask, 8.0));
  float dashV = step(0.48, fract((p.y + vWorldXZ.y) * 4.0));
  float dashH = step(0.48, fract((p.x + vWorldXZ.x) * 4.0));
  float v = vertical * aaBand(abs(p.x - 0.5), 0.012) * dashV;
  float h = horizontal * aaBand(abs(p.y - 0.5), 0.012) * dashH;
  return max(v, h);
}

float shoreBand(vec2 p, float mask) {
  float edge = 0.052;
  float north = (1.0 - bitSet(mask, 1.0)) * (1.0 - smoothstep(0.0, edge, p.y));
  float east = (1.0 - bitSet(mask, 2.0)) * smoothstep(1.0 - edge, 1.0, p.x);
  float south = (1.0 - bitSet(mask, 4.0)) * smoothstep(1.0 - edge, 1.0, p.y);
  float west = (1.0 - bitSet(mask, 8.0)) * (1.0 - smoothstep(0.0, edge, p.x));
  return clamp(max(max(north, east), max(south, west)), 0.0, 1.0);
}

vec3 grassColor(vec2 tile, float region) {
  float variation = hash21(tile + region * 19.31) - 0.5;
  return vec3(0.255, 0.445, 0.275) + variation * vec3(0.035, 0.055, 0.028);
}

void main() {
  vec2 tileCoord = clamp(vMapUv * uMapSize, vec2(0.0), uMapSize - vec2(0.0001));
  ivec2 tile = ivec2(floor(tileCoord));
  vec2 local = fract(tileCoord);
  vec4 encoded = texelFetch(uTileState, tile, 0);
  vec4 bytes = floor(encoded * 255.0 + 0.5);
  float kind = bytes.r;
  float mask = bytes.g;
  float region = bytes.b;
  float flags = bytes.a;

  vec3 grass = grassColor(vec2(tile), region);
  vec3 color = grass;

  if (kind > 0.5 && kind < 1.5) {
    float road = roadShape(local, mask);
    color = mix(grass, vec3(0.155, 0.165, 0.18), road);
    color = mix(color, vec3(0.68, 0.62, 0.39), roadStripe(local, mask) * road * 0.72);
  } else if (kind > 1.5 && kind < 2.5) {
    float blockJoint = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
    float joint = 1.0 - smoothstep(0.018, 0.035, blockJoint);
    color = mix(vec3(0.31, 0.315, 0.34), vec3(0.19, 0.20, 0.225), joint * 0.55);
  } else if (kind > 2.5 && kind < 3.5) {
    float wave = sin(vWorldXZ.x * 1.4 + uTime * 0.7) * sin(vWorldXZ.y * 1.15 - uTime * 0.5);
    color = vec3(0.075, 0.35, 0.53) + wave * vec3(0.012, 0.035, 0.045);
    color = mix(color, vec3(0.19, 0.42, 0.38), shoreBand(local, mask) * 0.58);
  } else if (kind > 3.5 && kind < 4.5) {
    color = grass * vec3(0.82, 1.08, 0.84);
  } else if (kind > 4.5 && kind < 5.5) {
    color = grass * vec3(0.72, 0.91, 0.72);
  } else if (kind > 5.5 && kind < 7.5) {
    color = mix(grass, vec3(0.35, 0.34, 0.33), 0.22);
  } else if (kind > 7.5) {
    color = mix(grass, vec3(0.30, 0.32, 0.34), 0.42);
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
}

/** One map-sized, indexed quad (four vertices / two triangles). */
export class MapSurfaceLayer {
  readonly data: SurfaceDataTexture
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.RawShaderMaterial
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.RawShaderMaterial>

  constructor(options: SurfaceLayerOptions) {
    const { width, height, tileSize } = options
    this.data = options.data ?? new SurfaceDataTexture(width, height)
    if (this.data.width !== width || this.data.height !== height) {
      throw new RangeError('SurfaceDataTexture dimensions do not match the map')
    }

    const minX = -tileSize * 0.5
    const minZ = -tileSize * 0.5
    const maxX = (width - 0.5) * tileSize
    const maxZ = (height - 0.5) * tileSize
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [minX, 0, minZ, maxX, 0, minZ, maxX, 0, maxZ, minX, 0, maxZ],
        3,
      ),
    )
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    // Counter-clockwise when viewed from above (+Y).
    this.geometry.setIndex([0, 3, 1, 1, 3, 2])
    this.geometry.computeBoundingBox()
    this.geometry.computeBoundingSphere()

    this.material = new THREE.RawShaderMaterial({
      name: 'map-surface-procedural-rgba8',
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTileState: { value: this.data.texture },
        uMapSize: { value: new THREE.Vector2(width, height) },
        uTime: { value: 0 },
        uPixelsPerTile: { value: 16 },
      },
      depthWrite: true,
      depthTest: true,
      transparent: false,
      side: THREE.FrontSide,
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'map-surface-two-triangle-plane'
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.frustumCulled = true
  }

  setFrame(timeSeconds: number, pixelsPerTile: number): void {
    this.material.uniforms.uTime!.value = timeSeconds
    this.material.uniforms.uPixelsPerTile!.value = Math.max(0, pixelsPerTile)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.data.dispose()
  }
}
