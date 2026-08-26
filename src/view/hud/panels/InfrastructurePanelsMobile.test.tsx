import { createElement } from 'react'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { useGameStore } from '../../../store/gameStore'
import { AllocatePanel } from './AllocatePanel'
import { ChipsPanel } from './ChipsPanel'
import { ComputeMarketPanel, ComputeQuoteCard } from './ComputeMarketPanel'
import { FleetBuildingsPanel } from './FleetBuildingsPanel'
import { PowerPanel } from './PowerPanel'
import { RacksPanel } from './RacksPanel'

describe('infrastructure mobile presentation', () => {
  it('uses concise mobile headings and native vertical pan across infrastructure workspaces', () => {
    useGameStore.setState({ state: createGame(81_401) })

    const panels = [
      [RacksPanel, 'Manage halls, racks, and blueprints.'],
      [PowerPanel, 'Supply, cost, and utility deals.'],
      [ComputeMarketPanel, 'Buy, sell, and manage compute.'],
      [ChipsPanel, 'Tune silicon and launch fab runs.'],
      [AllocatePanel, 'Split compute and protect serving.'],
      [FleetBuildingsPanel, 'Manage sites and construction.'],
    ] as const

    for (const [Panel, mobileDescription] of panels) {
      const markup = renderToStaticMarkup(createElement(Panel))
      expect(markup).toContain(mobileDescription)
      expect(markup).toContain('hud-mobile-summary')
      expect(markup).toContain('touch-pan-y')
    }
  })

  it('keeps quote totals visible while projections stay collapsed by default', () => {
    const markup = renderToStaticMarkup(
      createElement(ComputeQuoteCard, {
        providerName: 'Northstar',
        availablePf: 120,
        capacityPf: 24,
        ramGb: 1_024,
        dailyCost: 8_500,
        termDays: 90,
        interruptionRisk: 0.02,
      }),
    )

    expect(markup).toContain('Cost &amp; interruption projection')
    expect(markup).toContain('data-testid="compute-quote-cost-projection"')
    expect(markup).toContain('data-testid="compute-quote-risk-projection"')
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/)
    expect(markup).toContain('min-h-11')
  })

  it('provides swipe rails for repeated halls, recommendations, buildings, and construction', async () => {
    const sources = await Promise.all(
      ['RacksPanel.tsx', 'FleetBuildingsPanel.tsx', 'InfrastructureOverview.tsx'].map(
        (file) => readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8'),
      ),
    )

    for (const source of sources) {
      expect(source).toContain('snap-x snap-mandatory')
      expect(source).toContain('overflow-x-auto overscroll-x-contain')
      expect(source).toContain('touch-pan-x')
      expect(source).toContain('touch-pan-y')
      expect(source).toContain('min-[1181px]:overflow-visible')
    }
    expect(sources[0]).toContain('Recommended rack designs; swipe horizontally')
    expect(sources[1]).toContain('Buildings under construction; swipe horizontally')
    expect(sources[2]).toContain('Construction projects; swipe horizontally')
  })

  it('puts secondary infrastructure diagnostics behind touch-sized disclosures', async () => {
    const sources = await Promise.all(
      ['RacksPanel.tsx', 'PowerPanel.tsx', 'ChipsPanel.tsx', 'AllocatePanel.tsx'].map(
        (file) => readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8'),
      ),
    )

    expect(sources[0]).toContain('Placement details')
    expect(sources[1]).toContain('Power flow details')
    expect(sources[1]).toContain('Power → compute')
    expect(sources[2]).toContain('Architecture modifiers')
    expect(sources[3]).toContain('Memory &amp; capacity')
    expect(sources[3]).toContain('Setup guide')
    expect(sources[3]).not.toContain('label="Valuation"')

    for (const source of sources) {
      expect(source).toMatch(/<summary className="[^"]*min-h-11/)
      expect(source).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/)
    }
  })

  it('lets compact negotiation transcripts hand vertical scroll back to the workspace', async () => {
    const sources = await Promise.all(
      ['ComputeMarketPanel.tsx', 'PowerPanel.tsx'].map((file) =>
        readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8'),
      ),
    )

    for (const source of sources) {
      expect(source).toContain('overflow-y-auto overscroll-y-auto')
      expect(source).not.toContain(
        'max-h-[min(15rem,35dvh)] space-y-2 overflow-y-auto overscroll-contain',
      )
    }
  })
})
