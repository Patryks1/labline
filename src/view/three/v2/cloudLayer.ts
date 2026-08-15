import * as THREE from 'three'

export const DEFAULT_CLOUD_SEED = 0x6c61626c
export const CLOUD_MIN_ALTITUDE = 9
export const CLOUD_MAX_ALTITUDE = 16

const CLOUD_MARGIN = 18
const MIN_BANKS = 12
const MAX_BANKS = 48

const VERTEX_SHADER = /* glsl */ `
attribute vec3 cloudAnchor;
attribute vec2 cloudVelocity;
attribute float cloudShade;

uniform vec2 uWorldMin;
uniform vec2 uWorldSpan;
uniform float uCloudTime;

varying vec3 vCloudNormal;
varying vec3 vViewPosition;
varying float vCloudShade;

#include <fog_pars_vertex>

void main() {
  vec2 movingAnchor = cloudAnchor.xz + cloudVelocity * uCloudTime;
  movingAnchor = uWorldMin + mod(movingAnchor - uWorldMin, uWorldSpan);
  vec3 transformed = vec3(position.x + movingAnchor.x, position.y + cloudAnchor.y, position.z + movingAnchor.y);
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vCloudNormal = normalize(normalMatrix * normal);
  vViewPosition = -mvPosition.xyz;
  vCloudShade = cloudShade;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vCloudNormal;
varying vec3 vViewPosition;
varying float vCloudShade;

#include <common>
#include <fog_pars_fragment>

void main() {
  vec3 viewDirection = normalize(vViewPosition);
  vec3 cloudNormal = normalize(vCloudNormal);
  float facing = abs(dot(cloudNormal, viewDirection));
  float edgeFade = smoothstep(0.04, 0.62, facing);
  vec3 lightDirection = normalize(vec3(0.45, 0.82, 0.34));
  float diffuse = 0.66 + 0.34 * max(dot(cloudNormal, lightDirection), 0.0);
  float underside = 1.0 - smoothstep(-0.72, 0.15, cloudNormal.y);
  vec3 cloudColor = mix(vec3(0.62, 0.70, 0.76), vec3(0.98, 0.99, 1.0), diffuse);
  cloudColor = mix(cloudColor, vec3(0.48, 0.58, 0.66), underside * 0.42);
  cloudColor *= 0.94 + vCloudShade * 0.08;
  float opacity = mix(0.16, 0.38, edgeFade) * vCloudShade;
  gl_FragColor = vec4(cloudColor, opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`

export interface CloudLayerOptions {
  width: number
  height: number
  tileSize: number
  seed?: number
  bankCount?: number
}

export interface CloudLayerStats {
  banks: number
  puffs: number
  drawCalls: number
  triangles: number
}

/**
 * One texture-free mesh of sparse low-poly cloud banks. Bank anchors and drift
 * are evaluated in world space in the vertex shader, so camera quarter-turns
 * cannot change their layout and motion never requires a buffer upload.
 */
export class CloudLayer {
  readonly root = new THREE.Group()
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.ShaderMaterial
  readonly stats: CloudLayerStats

  private lastFrameSeconds: number | null = null
  private wasPaused = false
  private cloudTime = 0
  private disposed = false

  constructor(options: CloudLayerOptions) {
    const width = Math.max(1, Math.floor(options.width))
    const height = Math.max(1, Math.floor(options.height))
    const tileSize = Math.max(0.001, options.tileSize)
    const worldWidth = width * tileSize
    const worldDepth = height * tileSize
    const requestedBanks = options.bankCount ?? Math.ceil((worldWidth * worldDepth) / 2_500)
    const bankCount = THREE.MathUtils.clamp(Math.floor(requestedBanks), MIN_BANKS, MAX_BANKS)
    const built = createCloudGeometry(
      worldWidth,
      worldDepth,
      tileSize,
      bankCount,
      options.seed ?? DEFAULT_CLOUD_SEED,
    )
    this.geometry = built.geometry
    this.stats = {
      banks: bankCount,
      puffs: built.puffs,
      drawCalls: 1,
      triangles: this.geometry.getAttribute('position').count / 3,
    }
    const margin = CLOUD_MARGIN * tileSize
    this.material = new THREE.ShaderMaterial({
      name: 'procedural-low-poly-cloud-banks',
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uWorldMin: { value: new THREE.Vector2(-margin, -margin) },
          uWorldSpan: { value: new THREE.Vector2(worldWidth + margin * 2, worldDepth + margin * 2) },
          uCloudTime: { value: 0 },
        },
      ]),
      fog: true,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.name = 'procedural-cloud-banks'
    // Render ahead of map overlays, selection/build previews, and labels so
    // atmosphere never washes out the information-bearing UI layers.
    this.mesh.renderOrder = 1
    this.mesh.frustumCulled = false
    this.mesh.raycast = () => undefined
    this.root.name = 'world-cloud-layer'
    this.root.add(this.mesh)
  }

  /**
   * Advance only across consecutive unpaused frames. The first frame after a
   * pause establishes a fresh wall-clock baseline, preventing a catch-up jump.
   */
  setFrame(timeSeconds: number, paused: boolean): void {
    this.assertLive()
    const next = Number.isFinite(timeSeconds) ? timeSeconds : (this.lastFrameSeconds ?? 0)
    if (
      this.lastFrameSeconds !== null &&
      next >= this.lastFrameSeconds &&
      !paused &&
      !this.wasPaused
    ) {
      this.cloudTime += next - this.lastFrameSeconds
    }
    this.lastFrameSeconds = next
    this.wasPaused = paused
    this.material.uniforms.uCloudTime!.value = this.cloudTime
  }

  setVisible(visible: boolean): void {
    this.assertLive()
    this.root.visible = visible
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.root.remove(this.mesh)
    this.geometry.dispose()
    this.material.dispose()
    this.root.clear()
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('CloudLayer has been disposed')
  }
}

function createCloudGeometry(
  worldWidth: number,
  worldDepth: number,
  tileSize: number,
  bankCount: number,
  seed: number,
): { geometry: THREE.BufferGeometry; puffs: number } {
  const random = mulberry32(seed >>> 0)
  // Modest radial segmentation keeps the single combined mesh inexpensive,
  // while reading as round rather than as visibly icosahedral rocks.
  const base = new THREE.SphereGeometry(1, 10, 6).toNonIndexed()
  const basePositions = base.getAttribute('position') as THREE.BufferAttribute
  const baseNormals = base.getAttribute('normal') as THREE.BufferAttribute
  const positions: number[] = []
  const normals: number[] = []
  const anchors: number[] = []
  const velocities: number[] = []
  const shades: number[] = []
  const margin = CLOUD_MARGIN * tileSize
  let puffCount = 0

  for (let bank = 0; bank < bankCount; bank++) {
    const anchorX = -margin + random() * (worldWidth + margin * 2)
    const anchorZ = -margin + random() * (worldDepth + margin * 2)
    const anchorY = (CLOUD_MIN_ALTITUDE + random() * (CLOUD_MAX_ALTITUDE - CLOUD_MIN_ALTITUDE)) * tileSize
    const heading = -0.2 + random() * 0.42
    const speed = (0.085 + random() * 0.075) * tileSize
    const velocityX = Math.cos(heading) * speed
    const velocityZ = Math.sin(heading) * speed
    const shade = 0.76 + random() * 0.24
    const puffs = 7 + Math.floor(random() * 4)
    puffCount += puffs

    for (let puff = 0; puff < puffs; puff++) {
      const isCrown = puff < 3
      const angle = puff === 0 ? 0 : ((puff - 1) / (puffs - 1)) * Math.PI * 2 + (random() - 0.5) * 0.45
      const radius = puff === 0 ? 0 : (1.35 + random() * 1.35) * tileSize
      const offsetX = Math.cos(angle) * radius * 1.55
      const offsetZ = Math.sin(angle) * radius * 0.82
      const offsetY = ((isCrown ? 0.18 : -0.12) + (random() - 0.5) * 0.38) * tileSize
      const centreScale = puff === 0 ? 1.24 : 1
      const scaleX = (1.35 + random() * 0.82) * tileSize * centreScale
      const scaleY = (0.72 + random() * 0.48) * tileSize * (isCrown ? 1.12 : 0.9)
      const scaleZ = (1.05 + random() * 0.68) * tileSize * centreScale
      for (let vertex = 0; vertex < basePositions.count; vertex++) {
        const px = basePositions.getX(vertex)
        const py = basePositions.getY(vertex)
        const pz = basePositions.getZ(vertex)
        positions.push(px * scaleX + offsetX, py * scaleY + offsetY, pz * scaleZ + offsetZ)
        const nx = baseNormals.getX(vertex) / scaleX
        const ny = baseNormals.getY(vertex) / scaleY
        const nz = baseNormals.getZ(vertex) / scaleZ
        const inverseLength = 1 / Math.hypot(nx, ny, nz)
        normals.push(nx * inverseLength, ny * inverseLength, nz * inverseLength)
        anchors.push(anchorX, anchorY, anchorZ)
        velocities.push(velocityX, velocityZ)
        shades.push(shade)
      }
    }
  }
  base.dispose()

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('cloudAnchor', new THREE.Float32BufferAttribute(anchors, 3))
  geometry.setAttribute('cloudVelocity', new THREE.Float32BufferAttribute(velocities, 2))
  geometry.setAttribute('cloudShade', new THREE.Float32BufferAttribute(shades, 1))
  return { geometry, puffs: puffCount }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
