import {
  defaultCompanyLogoSpec,
  normalizeCompanyLogoSpec,
  type CompanyLogoInk,
  type CompanyLogoSpec,
  type CompanyMarkId,
} from '../../../sim/balance/gameConfig'

const COMPANY_NAME_PREFIXES = [
  'Arc',
  'Beacon',
  'Copper',
  'Helix',
  'Kestrel',
  'Lattice',
  'Morrow',
  'Northstar',
  'Parallax',
  'Signal',
  'Vector',
] as const

const COMPANY_NAME_SUFFIXES = [
  'Compute',
  'Dynamics',
  'Foundry',
  'Frontier',
  'Intelligence',
  'Labs',
  'Research',
  'Systems',
  'Works',
] as const

const MARKS: readonly CompanyMarkId[] = [
  'orbit', 'delta', 'prism', 'hex', 'spire', 'grid', 'nexus', 'wave', 'core',
]

const MARK_SET = new Set<string>(MARKS)
const LOGO_RECIPE_STORAGE_KEY = 'labline.companyLogoRecipes'
const MAX_SAVED_LOGO_RECIPES = 8

export type CompanyLogoRecipeParse =
  | { kind: 'recipe'; mark: CompanyMarkId; spec: CompanyLogoSpec }
  | { kind: 'seed'; seed: number }

/** Pick a name that is guaranteed to differ, even with a hostile/random test RNG. */
export function pickDistinctCompanyName(current: string, random: () => number = Math.random): string {
  const candidates = COMPANY_NAME_PREFIXES.flatMap((prefix) =>
    COMPANY_NAME_SUFFIXES.map((suffix) => `${prefix} ${suffix}`),
  )
  const available = candidates.filter((candidate) => candidate !== current)
  if (available.length === 0) return current
  const sample = random()
  const value = Number.isFinite(sample) ? sample : 0
  const index = Math.min(available.length - 1, Math.max(0, Math.floor(value * available.length)))
  return available[index] ?? available[0]!
}

function randomUnit(random: () => number): number {
  const value = random()
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0
}

/** Produce a visibly different, serializable logo configuration. */
export function randomizeCompanyLogo(
  currentMark: CompanyMarkId,
  currentSpec: CompanyLogoSpec | undefined,
  random: () => number = Math.random,
): { mark: CompanyMarkId; spec: CompanyLogoSpec } {
  const candidates = MARKS.filter((mark) => mark !== currentMark)
  const mark = candidates[Math.floor(randomUnit(random) * candidates.length)] ?? candidates[0] ?? currentMark
  const previous = normalizeCompanyLogoSpec(currentSpec, currentMark)
  const base = defaultCompanyLogoSpec(mark)
  const next = normalizeCompanyLogoSpec({
    ...base,
    symmetry: 3 + Math.floor(randomUnit(random) * 8),
    complexity: 1 + Math.floor(randomUnit(random) * 5),
    rotation: Math.round(randomUnit(random) * 359),
    spread: 0.45 + randomUnit(random) * 0.55,
    seed: Math.floor(randomUnit(random) * 1_000_000),
    ink: randomUnit(random) < 0.5 ? 'black' : 'white',
  }, mark)
  // A hostile deterministic RNG must still change the geometry as well as the motif.
  if (next.seed === previous.seed && next.rotation === previous.rotation) {
    next.seed = (next.seed + 1) % 1_000_000
  }
  return { mark, spec: next }
}

export function encodeCompanyLogoRecipe(mark: CompanyMarkId, spec: CompanyLogoSpec): string {
  const normalized = normalizeCompanyLogoSpec(spec, mark)
  const spreadPct = Math.round(normalized.spread * 100)
  const ink = normalized.ink === 'black' ? 'b' : 'w'
  return `L1/${mark}/${normalized.seed}/${normalized.symmetry}/${normalized.complexity}/${Math.round(normalized.rotation)}/${spreadPct}/${ink}`
}

export function parseCompanyLogoRecipe(raw: string): CompanyLogoRecipeParse | null {
  const value = raw.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const seed = Number(value)
    if (!Number.isFinite(seed)) return null
    return { kind: 'seed', seed: Math.max(0, Math.min(999_999, Math.round(seed))) }
  }
  const parts = value.split('/')
  if (parts.length !== 8 || parts[0] !== 'L1') return null
  const mark = parts[1]
  if (!mark || !MARK_SET.has(mark)) return null
  const seed = Number(parts[2])
  const symmetry = Number(parts[3])
  const complexity = Number(parts[4])
  const rotation = Number(parts[5])
  const spreadPct = Number(parts[6])
  const inkToken = parts[7]
  if (![seed, symmetry, complexity, rotation, spreadPct].every(Number.isFinite)) return null
  if (inkToken !== 'b' && inkToken !== 'w') return null
  const ink: CompanyLogoInk = inkToken === 'b' ? 'black' : 'white'
  return {
    kind: 'recipe',
    mark: mark as CompanyMarkId,
    spec: normalizeCompanyLogoSpec({
      seed,
      symmetry,
      complexity,
      rotation,
      spread: spreadPct / 100,
      ink,
    }, mark as CompanyMarkId),
  }
}

function defaultRecipeStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

export function readSavedLogoRecipes(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultRecipeStorage(),
): string[] {
  if (!storage) return []
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LOGO_RECIPE_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string' && parseCompanyLogoRecipe(item)?.kind === 'recipe')
      .slice(0, MAX_SAVED_LOGO_RECIPES)
  } catch {
    return []
  }
}

export function saveLogoRecipe(
  recipe: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultRecipeStorage(),
): string[] {
  const parsed = parseCompanyLogoRecipe(recipe)
  if (parsed?.kind !== 'recipe') return readSavedLogoRecipes(storage)
  const canonical = encodeCompanyLogoRecipe(parsed.mark, parsed.spec)
  const next = [canonical, ...readSavedLogoRecipes(storage).filter((item) => item !== canonical)]
    .slice(0, MAX_SAVED_LOGO_RECIPES)
  try {
    storage?.setItem(LOGO_RECIPE_STORAGE_KEY, JSON.stringify(next))
  } catch {
    return next
  }
  return next
}

export function removeSavedLogoRecipe(
  recipe: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultRecipeStorage(),
): string[] {
  const next = readSavedLogoRecipes(storage).filter((item) => item !== recipe)
  try {
    storage?.setItem(LOGO_RECIPE_STORAGE_KEY, JSON.stringify(next))
  } catch {
    return next
  }
  return next
}
