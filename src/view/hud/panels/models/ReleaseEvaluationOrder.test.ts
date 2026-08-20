import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { buildScaledModel } from '../../../../sim/balance/modelBuild'
import { ReleaseEvaluationOrder } from './ReleaseEvaluationOrder'

describe('ReleaseEvaluationOrder', () => {
  it('offers compatible suites and a paid run action', () => {
    const model = buildScaledModel({
      id: 'release-order',
      name: 'Spark',
      paramsB: 1,
      family: 'dense',
      day: 1,
      dataCoverage: 8,
      dataQuality: 70,
      shipped: true,
      release: 'released',
    })
    const markup = renderToStaticMarkup(
      createElement(ReleaseEvaluationOrder, {
        model,
        cash: 5_000_000,
        preferredSuiteIds: ['language'],
        onSubmit: vi.fn(),
      }),
    )
    expect(markup).toContain('Language')
    expect(markup).toContain('NDA external')
    expect(markup).toContain('Run evaluation')
    expect(markup).toContain('Standard')
  })
})
