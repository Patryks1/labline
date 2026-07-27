import * as THREE from 'three'
import type { ViewportChunkManager } from './chunks'
import { LodTier, type ChunkId, type ViewportRenderSource } from './types'
import {
  MUNICIPAL_POWER_BY_KIND,
  effectDensity,
  transformMunicipalAnchor,
  type MunicipalEffectType,
} from '../assets/municipalPowerLayouts'

interface PowerEffect {
  x: number
  y: number
  z: number
  yaw: number
  phase: number
  scale: number
}

interface TimeState { value: number }

export interface MunicipalPowerLayerStats {
  readonly plants: number
  readonly instances: number
  readonly drawCalls: number
  readonly triangles: number
}

/** Shader-time municipal utility animation; instance transforms remain static. */
export class MunicipalPowerLayer {
  readonly root = new THREE.Group()
  private readonly time: TimeState = { value: 0 }
  private readonly meshes: THREE.InstancedMesh[] = []
  private readonly rotorMaterial = animatedMaterial('municipal-wind-rotor', this.time, 'rotor')
  private readonly vaporMaterial = animatedMaterial('municipal-vapor', this.time, 'vapor')
  private readonly solarMaterial = animatedMaterial('municipal-solar-shimmer', this.time, 'solar')
  private signature = ''
  stats: MunicipalPowerLayerStats = emptyStats()

  constructor() { this.root.name = 'municipal-power-effects' }

  update(
    visible: ReadonlySet<ChunkId>,
    chunks: ViewportChunkManager,
    source: ViewportRenderSource,
    tier: LodTier = LodTier.mid,
  ): void {
    const plants = source.getMunicipalPowerPlants?.() ?? []
    const visiblePlants = plants.filter((plant) => {
      for (const chunkId of visible) {
        const bounds = chunks.chunkBounds(chunkId)
        if (plant.tileX >= bounds.minX && plant.tileX < bounds.maxX &&
          plant.tileY >= bounds.minY && plant.tileY < bounds.maxY) return true
      }
      return false
    })
    const signature = `${tier}|${visiblePlants.map((plant) => `${plant.id}:${plant.kind}`).join(',')}`
    if (signature === this.signature) return
    this.signature = signature
    this.clear()
    const rotors: PowerEffect[] = []
    const vapor: PowerEffect[] = []
    const solar: PowerEffect[] = []
    for (const plant of visiblePlants) {
      const campus = MUNICIPAL_POWER_BY_KIND[plant.kind]
      for (const effect of campus.effects) {
        const count = effectDensity(effect, tier)
        const [x, y, z] = transformMunicipalAnchor(
          [plant.x, plant.y, plant.z], plant.phase, effect.position,
        )
        const target = effectList(effect.type, rotors, vapor, solar)
        for (let index = 0; index < count; index++) target.push({
          x, y, z,
          yaw: plant.phase,
          phase: plant.phase + (count > 1 ? index / count * Math.PI * 2 : 0),
          scale: effect.scale,
        })
      }
    }
    if (rotors.length) this.add('municipal-wind-rotors', rotorGeometry(), this.rotorMaterial, rotors)
    if (vapor.length) this.add('municipal-stack-vapor', new THREE.SphereGeometry(1, 7, 5), this.vaporMaterial, vapor)
    if (solar.length) this.add('municipal-solar-shimmer', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.solarMaterial, solar)
    this.stats = {
      plants: visiblePlants.length,
      instances: rotors.length + vapor.length + solar.length,
      drawCalls: this.meshes.length,
      triangles: this.meshes.reduce((sum, mesh) => sum + triangleCount(mesh.geometry) * mesh.count, 0),
    }
  }

  setFrame(timeSeconds: number): void { this.time.value = timeSeconds }

  dispose(): void {
    this.clear()
    this.rotorMaterial.dispose()
    this.vaporMaterial.dispose()
    this.solarMaterial.dispose()
    this.root.clear()
    this.stats = emptyStats()
  }

  private add(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, effects: readonly PowerEffect[]): void {
    const phase = new Float32Array(effects.map((effect) => effect.phase))
    geometry.setAttribute('powerPhase', new THREE.InstancedBufferAttribute(phase, 1))
    const mesh = new THREE.InstancedMesh(geometry, material, effects.length)
    mesh.name = name
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    effects.forEach((effect, index) => {
      position.set(effect.x, effect.y, effect.z)
      rotation.setFromAxisAngle(up, effect.yaw)
      scale.setScalar(effect.scale)
      matrix.compose(position, rotation, scale)
      mesh.setMatrixAt(index, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingBox()
    mesh.computeBoundingSphere()
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 1.2
    this.meshes.push(mesh)
    this.root.add(mesh)
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    this.meshes.length = 0
    this.stats = emptyStats()
  }
}

function effectList(
  type: MunicipalEffectType,
  rotors: PowerEffect[],
  vapor: PowerEffect[],
  solar: PowerEffect[],
): PowerEffect[] {
  return type === 'rotor' ? rotors : type === 'vapor' ? vapor : solar
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index ? geometry.index.count / 3 : geometry.getAttribute('position').count / 3
}

function emptyStats(): MunicipalPowerLayerStats {
  return { plants: 0, instances: 0, drawCalls: 0, triangles: 0 }
}

function rotorGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(0.14, 1.2)
  const second = geometry.clone().rotateZ(Math.PI / 2)
  const merged = new THREE.BufferGeometry()
  const firstPositions = geometry.getAttribute('position')
  const secondPositions = second.getAttribute('position')
  const positions = new Float32Array((firstPositions.count + secondPositions.count) * 3)
  positions.set(firstPositions.array as ArrayLike<number>, 0)
  positions.set(secondPositions.array as ArrayLike<number>, firstPositions.count * 3)
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  merged.setIndex([0, 2, 1, 2, 3, 1, 4, 6, 5, 6, 7, 5])
  merged.computeVertexNormals()
  geometry.dispose(); second.dispose()
  return merged
}

function animatedMaterial(name: string, time: TimeState, mode: 'rotor' | 'vapor' | 'solar'): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name,
    color: mode === 'vapor' ? 0xdce4df : mode === 'solar' ? 0x83c9e8 : 0xf2f3ed,
    roughness: mode === 'solar' ? 0.15 : 0.72,
    metalness: mode === 'solar' ? 0.45 : 0.08,
    transparent: mode !== 'rotor',
    opacity: mode === 'vapor' ? 0.34 : mode === 'solar' ? 0.3 : 1,
    depthWrite: mode === 'rotor',
    side: THREE.DoubleSide,
    fog: true,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPowerTime = time
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float powerPhase;\nuniform float uPowerTime;\nvoid main() {')
      .replace('#include <begin_vertex>', mode === 'rotor'
        ? '#include <begin_vertex>\nfloat a=uPowerTime*1.35+powerPhase; mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a)); transformed.xy=r*transformed.xy;'
        : mode === 'vapor'
          ? '#include <begin_vertex>\nfloat rise=mod(uPowerTime*0.16+powerPhase/6.28318,1.0); transformed.y+=rise*4.2; transformed.x+=sin(uPowerTime*0.4+powerPhase)*0.45*rise; transformed*=0.7+rise*0.75;'
          : '#include <begin_vertex>\ntransformed.y += sin(uPowerTime*1.4+powerPhase)*0.025;')
  }
  material.customProgramCacheKey = () => `labline-${name}-v1`
  material.userData.powerTime = time
  return material
}
