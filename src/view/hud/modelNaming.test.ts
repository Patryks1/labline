import { describe, expect, it } from 'vitest'
import { recentModelTemplates, resolveModelIteration } from './modelNaming'

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
