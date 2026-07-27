import rawLayouts from './municipalPowerLayouts.json'
import type { LodTier } from '../v2'

export type MunicipalPowerKind = 'coal' | 'wind' | 'solar' | 'nuclear'
export type MunicipalStructureShape = 'box' | 'cylinder' | 'sphere' | 'coolingTower' | 'solarCluster'
export type MunicipalEffectType = 'rotor' | 'vapor' | 'solar'
export type Vec3Tuple = readonly [number, number, number]

export interface MunicipalStructureDescriptor {
  readonly shape: MunicipalStructureShape
  readonly position: Vec3Tuple
  readonly scale: Vec3Tuple
  readonly color: number
}

export interface MunicipalEffectDescriptor {
  readonly type: MunicipalEffectType
  readonly position: Vec3Tuple
  readonly near: number
  readonly mid: number
  readonly far: number
  readonly scale: number
}

export interface MunicipalCampusDescriptor {
  readonly kind: MunicipalPowerKind
  readonly key: string
  readonly archetypeId: number
  readonly color: number
  readonly structures: readonly MunicipalStructureDescriptor[]
  readonly effects: readonly MunicipalEffectDescriptor[]
}

export interface MunicipalPowerLayoutDescriptor {
  readonly version: 1
  readonly footprint: readonly [2, 2]
  readonly campuses: readonly MunicipalCampusDescriptor[]
}

export const MUNICIPAL_POWER_LAYOUTS = parseMunicipalPowerLayouts(rawLayouts)

export const MUNICIPAL_POWER_BY_KIND: Readonly<Record<MunicipalPowerKind, MunicipalCampusDescriptor>> =
  Object.freeze(Object.fromEntries(MUNICIPAL_POWER_LAYOUTS.campuses.map(campus => [campus.kind, campus]))) as
    Readonly<Record<MunicipalPowerKind, MunicipalCampusDescriptor>>

export function effectDensity(effect: MunicipalEffectDescriptor, tier: LodTier): number {
  return effect[tier]
}

/** Rotate a descriptor-local anchor around the campus centre into world space. */
export function transformMunicipalAnchor(
  origin: Vec3Tuple,
  yaw: number,
  local: Vec3Tuple,
): Vec3Tuple {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  return [
    // Match THREE's positive Y-axis quaternion convention exactly.
    origin[0] + local[0] * cos + local[2] * sin,
    origin[1] + local[1],
    origin[2] - local[0] * sin + local[2] * cos,
  ]
}

export function parseMunicipalPowerLayouts(value: unknown): MunicipalPowerLayoutDescriptor {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.footprint) ||
    value.footprint[0] !== 2 || value.footprint[1] !== 2 || !Array.isArray(value.campuses)) {
    throw new Error('Malformed municipal power layout descriptor')
  }
  const kinds = new Set<string>()
  const ids = new Set<number>()
  for (const campus of value.campuses) {
    if (!record(campus) || !['coal', 'wind', 'solar', 'nuclear'].includes(String(campus.kind)) ||
      typeof campus.key !== 'string' || !/^municipal-[a-z]+-campus$/.test(campus.key) ||
      !Number.isSafeInteger(campus.archetypeId) || (campus.archetypeId as number) < 506 ||
      (campus.archetypeId as number) > 509 ||
      typeof campus.color !== 'number' || !Array.isArray(campus.structures) || !Array.isArray(campus.effects)) {
      throw new Error('Malformed municipal campus descriptor')
    }
    if (kinds.has(String(campus.kind)) || ids.has(campus.archetypeId as number)) throw new Error('Duplicate municipal campus kind or archetype')
    kinds.add(String(campus.kind)); ids.add(campus.archetypeId as number)
    for (const structure of campus.structures) validateStructure(structure)
    for (const effect of campus.effects) validateEffect(effect)
  }
  if (kinds.size !== 4) throw new Error('Municipal descriptor must define four campuses')
  return value as unknown as MunicipalPowerLayoutDescriptor
}

function validateStructure(value: unknown): void {
  if (!record(value) || !['box', 'cylinder', 'sphere', 'coolingTower', 'solarCluster'].includes(String(value.shape)) ||
    !vec3(value.position) || !vec3(value.scale) || typeof value.color !== 'number') throw new Error('Malformed municipal structure')
  const [x, y, z] = value.position
  const [sx, sy, sz] = value.scale
  if (sx <= 0 || sy <= 0 || sz <= 0 || y < 0 ||
    Math.abs(x) + sx / 2 > 1 || Math.abs(z) + sz / 2 > 1) {
    throw new Error('Municipal structure exceeds its 2x2 footprint')
  }
}

function validateEffect(value: unknown): void {
  if (!record(value) || !['rotor', 'vapor', 'solar'].includes(String(value.type)) || !vec3(value.position) ||
    !['near', 'mid', 'far'].every(tier => Number.isSafeInteger(value[tier]) && (value[tier] as number) >= 0) ||
    typeof value.scale !== 'number' || value.scale <= 0) throw new Error('Malformed municipal effect')
  const [x, y, z] = value.position
  if (y < 0 || Math.abs(x) > 1 || Math.abs(z) > 1) {
    throw new Error('Municipal effect anchor exceeds its 2x2 footprint')
  }
}

function vec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
