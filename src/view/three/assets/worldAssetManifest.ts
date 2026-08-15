import type { LodTier } from '../v2'

export const WORLD_ASSET_MANIFEST_URL = '/assets/world-v4/manifest.json'

export type WorldAssetFamily =
  | 'terrain'
  | 'vegetation'
  | 'residential'
  | 'urban'
  | 'industrial'
  | 'facilities'
  | 'vehicles'
  | 'boats'
  | 'ducks'
  | 'props'
  | 'municipal'

export interface WorldAssetBundle {
  readonly family: WorldAssetFamily
  readonly url: string
  readonly sha256: string
  readonly bytes: number
}

export interface WorldModelEntry {
  readonly family: WorldAssetFamily
  readonly key: string
  readonly archetypeId: number
  readonly tintMode: 'base' | 'owner'
  readonly footprint: readonly [number, number]
  readonly nodes: Readonly<Record<LodTier, string>>
  readonly fallbackKey: string
}

export interface WorldAssetManifest {
  readonly version: 1
  readonly generatedBy: string
  readonly coordinateSystem: {
    readonly up: '+Y'
    readonly forward: '+X'
    readonly ground: 0
    readonly tileSize: 1
  }
  readonly bundles: readonly WorldAssetBundle[]
  readonly models: readonly WorldModelEntry[]
}

const FAMILY_NAMES = new Set<WorldAssetFamily>([
  'terrain', 'vegetation', 'residential', 'urban', 'industrial',
  'facilities', 'vehicles', 'boats', 'ducks', 'props', 'municipal',
])

/** Validate untrusted manifest JSON before it can influence asset requests. */
export function parseWorldAssetManifest(value: unknown): WorldAssetManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bundles) || !Array.isArray(value.models)) {
    throw new Error('Unsupported or malformed world asset manifest')
  }
  if (!isRecord(value.coordinateSystem) || value.coordinateSystem.up !== '+Y' || value.coordinateSystem.forward !== '+X' || value.coordinateSystem.ground !== 0 || value.coordinateSystem.tileSize !== 1) {
    throw new Error('World assets use an incompatible coordinate system')
  }
  const bundles = value.bundles.map((bundle, index) => parseBundle(bundle, index))
  const families = new Set(bundles.map(bundle => bundle.family))
  if (families.size !== bundles.length) throw new Error('World asset manifest has duplicate family bundles')
  const keys = new Set<string>()
  const ids = new Set<number>()
  const models = value.models.map((model, index) => {
    const parsed = parseModel(model, index)
    if (!families.has(parsed.family)) throw new Error(`Model ${parsed.key} references a missing family bundle`)
    if (keys.has(parsed.key)) throw new Error(`Duplicate world model key ${parsed.key}`)
    if (ids.has(parsed.archetypeId)) throw new Error(`Duplicate world model archetype ${parsed.archetypeId}`)
    keys.add(parsed.key); ids.add(parsed.archetypeId)
    return parsed
  })
  return { ...value, bundles, models } as unknown as WorldAssetManifest
}

function parseBundle(value: unknown, index: number): WorldAssetBundle {
  if (!isRecord(value) || !FAMILY_NAMES.has(value.family as WorldAssetFamily) || typeof value.url !== 'string' || !/^\/assets\/world-v4\/[a-z]+\.[a-f0-9]{12}\.glb$/.test(value.url) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    throw new Error(`Malformed world asset bundle at index ${index}`)
  }
  return value as unknown as WorldAssetBundle
}

function parseModel(value: unknown, index: number): WorldModelEntry {
  const nodes = isRecord(value) && isRecord(value.nodes) ? value.nodes : null
  if (!isRecord(value) || !FAMILY_NAMES.has(value.family as WorldAssetFamily) || typeof value.key !== 'string' || !/^[a-z][a-z0-9-]+$/.test(value.key) || !Number.isSafeInteger(value.archetypeId) || (value.archetypeId as number) < 0 || (value.tintMode !== 'base' && value.tintMode !== 'owner') || !Array.isArray(value.footprint) || value.footprint.length !== 2 || !value.footprint.every(dimension => Number.isInteger(dimension) && dimension > 0) || !nodes || !['near', 'mid', 'far'].every(tier => typeof nodes[tier] === 'string') || typeof value.fallbackKey !== 'string') {
    throw new Error(`Malformed world model at index ${index}`)
  }
  return value as unknown as WorldModelEntry
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
