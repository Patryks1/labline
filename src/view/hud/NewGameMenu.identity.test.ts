import { describe, expect, it } from 'vitest'
import { defaultCompanyLogoSpec, normalizeCompanyLogoSpec } from '../../sim/balance/gameConfig'
import {
  encodeCompanyLogoRecipe,
  parseCompanyLogoRecipe,
  pickDistinctCompanyName,
  randomizeCompanyLogo,
  readSavedLogoRecipes,
  removeSavedLogoRecipe,
  saveLogoRecipe,
} from './ui/companyIdentity'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value
    },
  }
}

describe('new sandbox identity randomization', () => {
  it('always returns a different generated name', () => {
    const current = 'Arc Compute'
    expect(pickDistinctCompanyName(current, () => 0)).not.toBe(current)
    expect(pickDistinctCompanyName(current, () => 0.999999)).not.toBe(current)
  })

  it('uses a stable candidate for a supplied random sample', () => {
    expect(pickDistinctCompanyName('Labline', () => 0)).toBe('Arc Compute')
    expect(pickDistinctCompanyName('Labline', () => 0.5)).toBe('Lattice Intelligence')
  })

  it('randomizes procedural geometry as well as the base mark', () => {
    const current = defaultCompanyLogoSpec('orbit')
    const next = randomizeCompanyLogo('orbit', current, () => 0)
    expect(next.mark).not.toBe('orbit')
    expect(next.spec).not.toEqual(current)
    expect(normalizeCompanyLogoSpec(next.spec, next.mark)).toEqual(next.spec)
  })

  it('clamps imported logo controls to renderer-safe ranges', () => {
    expect(normalizeCompanyLogoSpec({
      version: 1,
      symmetry: 99,
      complexity: -5,
      rotation: 999,
      spread: 0,
      seed: -2,
    }, 'delta')).toMatchObject({
      symmetry: 10,
      complexity: 1,
      rotation: 279,
      spread: 0.35,
      seed: 0,
      ink: 'white',
    })
  })

  it('defaults missing ink to white and accepts black', () => {
    expect(normalizeCompanyLogoSpec({}, 'hex').ink).toBe('white')
    expect(normalizeCompanyLogoSpec({ ink: 'black' }, 'hex').ink).toBe('black')
  })
})

describe('company logo recipes', () => {
  it('round-trips a full logo through a copyable seed', () => {
    const spec = normalizeCompanyLogoSpec({
      ...defaultCompanyLogoSpec('hex'),
      seed: 461,
      symmetry: 6,
      complexity: 2,
      rotation: 18,
      spread: 0.78,
      ink: 'black',
    }, 'hex')
    const recipe = encodeCompanyLogoRecipe('hex', spec)
    expect(recipe).toBe('L1/hex/461/6/2/18/78/b')
    expect(parseCompanyLogoRecipe(recipe)).toEqual({ kind: 'recipe', mark: 'hex', spec })
  })

  it('applies a numeric seed without changing the rest of the mark', () => {
    expect(parseCompanyLogoRecipe('  461  ')).toEqual({ kind: 'seed', seed: 461 })
    expect(parseCompanyLogoRecipe('not-a-seed')).toBeNull()
  })

  it('stores unique saved recipes in most-recent-first order', () => {
    const storage = memoryStorage()
    const first = encodeCompanyLogoRecipe('hex', defaultCompanyLogoSpec('hex'))
    const second = encodeCompanyLogoRecipe('orbit', { ...defaultCompanyLogoSpec('orbit'), ink: 'black' })
    saveLogoRecipe(first, storage)
    expect(saveLogoRecipe(second, storage)[0]).toBe(second)
    expect(readSavedLogoRecipes(storage)).toEqual([second, first])
    expect(removeSavedLogoRecipe(second, storage)).toEqual([first])
  })
})
