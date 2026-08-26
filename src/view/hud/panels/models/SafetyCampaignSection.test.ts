import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Model } from '../../../../sim/types'
import { SafetyCampaignSection } from './SafetyCampaignSection'

describe('SafetyCampaignSection controls', () => {
  it('keeps setup collapsed by default with its explanation and controls inside', () => {
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
    expect(markup).toContain('data-safety-setup-disclosure="true"')
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/)
    expect(markup).toContain('Configure standard campaign')
    expect(markup).toContain('Estimate unavailable')
    expect(markup).toContain('Expand')
    expect(markup).toContain('Collapse')
    expect(markup).toContain('hud-button--ghost')
    expect(markup).toMatch(/aria-pressed="false"[^>]*>targeted<\/button>/)
    expect(markup).toMatch(/aria-pressed="true"[^>]*>standard<\/button>/)
    expect(markup).toMatch(/aria-pressed="false"[^>]*>frontier<\/button>/)
    expect(markup).toContain('hud-range mt-1')
    expect(markup).toContain('Create standard safety checkpoint')
    expect(markup).toContain('Cannot start safety campaign')
    const disclosureStart = markup.indexOf('data-safety-setup-disclosure="true"')
    const explanation = markup.indexOf('Creates a new safety-trained checkpoint/version')
    const disclosureEnd = markup.indexOf('</details>', disclosureStart)
    expect(explanation).toBeGreaterThan(disclosureStart)
    expect(explanation).toBeLessThan(disclosureEnd)
  })

  it('keeps the PF and cash quote visible in the collapsed summary', () => {
    const markup = renderToStaticMarkup(
      createElement(SafetyCampaignSection, {
        model: { id: 'model-aster', name: 'Aster' } as Model,
        campaign: null,
        intensity: 'frontier',
        setIntensity: vi.fn(),
        researchers: 4,
        setResearchers: vi.fn(),
        researcherCount: 8,
        estimate: {
          ok: true,
          minimumResearchers: 3,
          trainingPfDays: 12.5,
          researchPfDays: 8.5,
          cashBudget: 2_500_000,
          safetyDataMTok: 20,
          safetyDataQuality: 80,
        },
        onStart: vi.fn(),
        onCancel: vi.fn(),
      }),
    )

    expect(markup).toContain('Configure frontier campaign')
    expect(markup).toContain('21.00 PF-d total · $2.50M')
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/)
  })
})
