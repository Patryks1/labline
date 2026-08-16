import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Model } from '../../../../sim/types'
import { SafetyCampaignSection } from './SafetyCampaignSection'

describe('SafetyCampaignSection controls', () => {
  it('keeps intensity, researcher allocation, and disabled start reason accessible', () => {
    const model = { id: 'model-aster', name: 'Aster' } as Model
    const markup = renderToStaticMarkup(
      createElement(SafetyCampaignSection, {
        model,
        campaign: null,
        intensity: 'standard',
        setIntensity: vi.fn(),
        researchers: 1,
        setResearchers: vi.fn(),
        researcherCount: 3,
        estimate: null,
        onStart: vi.fn(),
        onCancel: vi.fn(),
      }),
    )

    expect(markup).toContain('Safety post-training')
    expect(markup).toContain('hud-button--ghost')
    expect(markup).toContain('hud-range mt-1')
    expect(markup).toContain('Create standard safety checkpoint')
    expect(markup).toContain('Cannot start safety campaign')
  })
})
