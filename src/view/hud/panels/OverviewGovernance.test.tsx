import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { useGameStore } from '../../../store/gameStore'
import { InfrastructureOverview } from './InfrastructureOverview'
import { MapPanel } from './MapPanel'
import { OrgPanel } from './OrgPanel'
import { OverviewGovernance } from './OverviewGovernance'

describe('Overview governance ownership', () => {
  it('renders policy in the main Overview surface as collapsed progressive disclosure', () => {
    const state = createGame(64_220)
    useGameStore.setState({ state })

    const markup = renderToStaticMarkup(createElement(MapPanel))

    expect(markup).toContain('Overview / governance')
    expect(markup).toContain('Review governance &amp; policies')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-controls="overview-governance-details"')
    expect(markup).not.toContain('role="tablist"')
  })

  it('keeps the policy section and callbacks out of Infrastructure and Company', () => {
    const state = createGame(64_221)
    useGameStore.setState({ state })

    const infrastructure = renderToStaticMarkup(createElement(InfrastructureOverview))
    const company = renderToStaticMarkup(createElement(OrgPanel))
    const compact = renderToStaticMarkup(createElement(OverviewGovernance, { state }))

    expect(infrastructure).not.toContain('Operating policies')
    expect(infrastructure).not.toContain('Governance')
    expect(infrastructure).not.toContain('>Facilities<')
    expect(infrastructure).toContain('Open sites intel')
    expect(company).not.toContain('Operating policies')
    expect(company).not.toContain('Governance')
    expect(compact).not.toContain('Operating policies')
  })
})
