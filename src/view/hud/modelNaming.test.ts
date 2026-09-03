import { describe, expect, it } from 'vitest'
import {
  continueRunName,
  generateUniqueModelName,
  MODEL_NAME_POOL,
  recentModelTemplates,
  resolveModelIteration,
} from './modelNaming'

describe('model family iterations', () => {
  it('keeps the first model name and versions later iterations', () => {
    expect(resolveModelIteration([], 'Spark')).toEqual({
      template: 'Spark',
      iteration: 1,
      name: 'Spark',
    })
    expect(resolveModelIteration([{ name: 'Spark' }], 'Spark').name).toBe('Spark v2')
  })

  it('continues from the highest existing iteration case-insensitively', () => {
    const result = resolveModelIteration(
      [{ name: 'Spark' }, { name: 'spark v2' }, { name: 'Spark v5' }],
      'SPARK',
    )
    expect(result).toMatchObject({ iteration: 6, name: 'SPARK v6' })
  })

  it('builds a de-duplicated list of recent templates', () => {
    expect(
      recentModelTemplates([
        { name: 'Nova' },
        { name: 'Spark' },
        { name: 'Spark v2' },
        { name: 'Atlas' },
      ]),
    ).toEqual(['Atlas', 'Spark', 'Nova'])
  })
})

describe('run name generation', () => {
  it('picks a pool name that is not already taken', () => {
    const name = generateUniqueModelName({ playerModels: [{ name: 'Spark' }] })
    expect(MODEL_NAME_POOL).toContain(name)
    expect(name).not.toBe('Spark')
  })

  it('avoids the current name when randomizing', () => {
    const name = generateUniqueModelName({}, { avoid: 'Nova' })
    expect(name).not.toBe('Nova')
    expect(MODEL_NAME_POOL).toContain(name)
  })

  it('versions a continued parent name', () => {
    expect(continueRunName('bob', [{ name: 'bob' }])).toBe('bob v2')
    expect(continueRunName('Atlas', [{ name: 'Atlas' }, { name: 'Atlas v2' }])).toBe('Atlas v3')
  })
})
