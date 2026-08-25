import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultCompanyLogoSpec } from '../../../sim/balance/gameConfig'
import { CompanyMark, CompanyMarkBadge } from './CompanyMark'

describe('procedural company marks', () => {
  it('renders filled silhouettes instead of wireframe-only geometry', () => {
    const spec = defaultCompanyLogoSpec('hex')
    const markup = renderToStaticMarkup(createElement(CompanyMark, { mark: 'hex', logo: spec }))
    expect(markup).toContain('fill="currentColor"')
    expect(markup).toContain('fill-rule="evenodd"')
    expect(markup).toContain('viewBox="0 0 32 32"')
  })

  it('places black and white marks on contrasting plates', () => {
    const white = renderToStaticMarkup(createElement(CompanyMarkBadge, {
      mark: 'orbit',
      logo: defaultCompanyLogoSpec('orbit'),
    }))
    const black = renderToStaticMarkup(createElement(CompanyMarkBadge, {
      mark: 'orbit',
      logo: { ...defaultCompanyLogoSpec('orbit'), ink: 'black' },
    }))
    expect(white).toContain('data-logo-ink="white"')
    expect(white).toContain('company-mark-badge--white')
    expect(black).toContain('data-logo-ink="black"')
    expect(black).toContain('company-mark-badge--black')
  })
})
