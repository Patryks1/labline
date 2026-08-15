import * as THREE from 'three'

/** Enough ground-plane overscan for the widest supported zoom and camera tilt. */
export const WORLD_VOID_MARGIN_TILES = 128
export const WORLD_VOID_Y = -1.15

const VERTEX_SHADER = /* glsl */ `
varying vec2 vWorldXZ;

#include <fog_pars_vertex>

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldXZ = worldPosition.xz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform vec2 uWorldMin;
uniform vec2 uWorldMax;
uniform vec2 uWorldCenter;
uniform float uTileSize;
uniform float uTime;

varying vec2 vWorldXZ;

#include <common>
#include <fog_pars_fragment>

float voidHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float voidNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = voidHash(cell);
  float b = voidHash(cell + vec2(1.0, 0.0));
  float c = voidHash(cell + vec2(0.0, 1.0));
  float d = voidHash(cell + vec2(1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float voidFbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.55;
  mat2 turn = mat2(0.82, -0.57, 0.57, 0.82);
  for (int octave = 0; octave < 5; octave++) {
    value += voidNoise(p) * amplitude;
    p = turn * p * 2.03 + vec2(13.7, 7.1);
    amplitude *= 0.48;
  }
  return value;
}

vec2 voidDomainWarp(vec2 p) {
  vec2 warp = vec2(
    voidFbm(p * 0.72 + vec2(3.1, 11.7)),
    voidFbm(p * 0.72 + vec2(19.4, 5.3))
  );
  return p + (warp - 0.5) * 1.35;
}

// A small Worley-style lobe field gives the cloud banks recognisable rounded
// edges. The broad FBM envelope below groups the lobes instead of producing a
// regular field of dots.
float roundedCloudLobes(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  float lobes = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbour = vec2(float(x), float(y));
      vec2 id = cell + neighbour;
      vec2 centre = neighbour + vec2(voidHash(id), voidHash(id + 37.2));
      float radius = mix(0.48, 0.78, voidHash(id + 91.7));
      float distanceToLobe = length(local - centre) / radius;
      lobes = max(lobes, 1.0 - smoothstep(0.58, 1.08, distanceToLobe));
    }
  }
  return lobes;
}

void main() {
  vec2 p = vWorldXZ;
  vec2 outsideDelta = max(max(uWorldMin - p, p - uWorldMax), vec2(0.0));
  float outsideDistance = length(outsideDelta);

  // A cloud ocean below the finite world. Domain-warped broad envelopes bind
  // overlapping round lobes into coherent banks, with calm opposing drift.
  vec2 cloudUv = p / (uTileSize * 42.0);
  vec2 drift = vec2(uTime * 0.00125, -uTime * 0.00065);
  vec2 warpedUv = voidDomainWarp(cloudUv + drift);
  float broadCloud = voidFbm(warpedUv * 0.82 + vec2(7.4, 2.6));
  float roundedLobes = roundedCloudLobes(warpedUv * 2.15);
  float softGaps = voidFbm(warpedUv * 2.7 - drift * 0.8 + vec2(21.3, 8.7));
  float bankEnvelope = smoothstep(0.39, 0.67, broadCloud);
  float cloudBody = smoothstep(0.16, 0.72, roundedLobes * 0.76 + bankEnvelope * 0.58 - softGaps * 0.20);

  // A directional density difference models sunlit crowns and blue-grey
  // undersides without textures or extra geometry.
  float crownNoise = voidFbm(warpedUv * 1.18 - vec2(0.10, 0.14));
  float undersideNoise = voidFbm(warpedUv * 1.18 + vec2(0.10, 0.14));
  float crownLight = clamp(0.52 + (crownNoise - undersideNoise) * 2.2, 0.0, 1.0);
  float cloudTop = smoothstep(0.28, 0.92, roundedLobes) * (0.55 + crownLight * 0.45);

  vec3 deepSky = vec3(0.035, 0.105, 0.145);
  vec3 cloudShade = vec3(0.29, 0.42, 0.50);
  vec3 cloudMid = vec3(0.60, 0.71, 0.76);
  vec3 cloudLight = vec3(0.88, 0.93, 0.94);
  vec3 cloudColor = mix(cloudShade, cloudMid, bankEnvelope * 0.52 + crownLight * 0.18);
  cloudColor = mix(cloudColor, cloudLight, cloudTop * 0.72);
  vec3 color = mix(deepSky, cloudColor, cloudBody * 0.94);

  // Clouds gather softly against the world fascia so the map feels suspended
  // above them rather than cut out over an empty plane.
  float edgeCloud = exp(-outsideDistance / (uTileSize * 4.2));
  color = mix(color, cloudLight, edgeCloud * (0.10 + cloudBody * 0.12));
  float farHaze = smoothstep(uTileSize * 18.0, uTileSize * 120.0, outsideDistance);
  color = mix(color, vec3(0.22, 0.39, 0.48), farHaze * 0.18);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`

export interface WorldVoidLayerOptions {
  width: number
  height: number
  tileSize: number
  marginTiles?: number
}

/** One non-pickable, texture-free draw beneath the finite map surface. */
export class WorldVoidLayer {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  readonly material: THREE.ShaderMaterial
  readonly geometry: THREE.PlaneGeometry

  private disposed = false

  constructor(options: WorldVoidLayerOptions) {
    const width = Math.max(1, options.width)
    const height = Math.max(1, options.height)
    const tileSize = Math.max(0.001, options.tileSize)
    const margin = Math.max(1, options.marginTiles ?? WORLD_VOID_MARGIN_TILES) * tileSize
    const worldWidth = width * tileSize
    const worldDepth = height * tileSize
    const minX = -tileSize * 0.5
    const minZ = -tileSize * 0.5
    const maxX = (width - 0.5) * tileSize
    const maxZ = (height - 0.5) * tileSize

    this.geometry = new THREE.PlaneGeometry(worldWidth + margin * 2, worldDepth + margin * 2)
    this.material = new THREE.ShaderMaterial({
      name: 'world-void-procedural-atmosphere',
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uWorldMin: { value: new THREE.Vector2(minX, minZ) },
          uWorldMax: { value: new THREE.Vector2(maxX, maxZ) },
          uWorldCenter: { value: new THREE.Vector2((minX + maxX) * 0.5, (minZ + maxZ) * 0.5) },
          uTileSize: { value: tileSize },
          uTime: { value: 0 },
        },
      ]),
      fog: true,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'world-void-atmosphere'
    this.mesh.position.set((minX + maxX) * 0.5, WORLD_VOID_Y, (minZ + maxZ) * 0.5)
    this.mesh.rotation.x = -Math.PI * 0.5
    this.mesh.renderOrder = -100
    // Interaction raycasts target explicit terrain/prop roots, but disabling
    // this too keeps future scene-wide picking from treating the void as land.
    this.mesh.raycast = () => undefined
  }

  setFrame(timeSeconds: number): void {
    if (this.disposed) throw new Error('WorldVoidLayer has been disposed')
    this.material.uniforms.uTime!.value = timeSeconds
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.geometry.dispose()
    this.material.dispose()
  }
}
