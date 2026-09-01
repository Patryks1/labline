import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createGame } from '../../../sim/createGame'
import { useGameStore } from '../../../store/gameStore'
import { ComputeMarketPanel, defaultCloudContractPf, maxCloudContractPf, OwnedRentedDonut } from './ComputeMarketPanel'
import { pfToMw } from '../format'

describe('OwnedRentedDonut', () => {
  it('renders owned and rented shares with the electrical caption below the chart', () => {
    const markup = renderToStaticMarkup(
      createElement(OwnedRentedDonut, { owned: 18, rented: 6 }),
    )
    expect(markup).toContain('24.00 PF')
    expect(markup).toContain('electrical')
    expect(markup).toContain('var(--color-mint)')
    expect(markup).toContain('var(--color-infer)')
  })

  it('caps the svg and keeps long values out of the absolute overlay', () => {
    const markup = renderToStaticMarkup(
      createElement(OwnedRentedDonut, { owned: 900, rented: 300 }),
    )
    // The svg is hard-capped so it can never outgrow its 96px box.
    expect(markup).toContain('width="88"')
    expect(markup).toContain('height="88"')
    expect(markup).toContain('max-w-full')
    // Only the compact total stays in the absolute overlay.
    const overlay = markup.match(
      /<div class="pointer-events-none absolute[^"]*"[^>]*>(.*?)<\/div>/s,
    )
    expect(overlay).not.toBeNull()
    expect(overlay![1]).not.toContain('electrical')
    // The long electrical value moved below the chart as truncated flow text.
    const caption = markup.match(/<p class="([^"]*)"[^>]*>≈ .* electrical<\/p>/)
    expect(caption).not.toBeNull()
    expect(caption![1]).toContain('truncate')
    expect(caption![1]).not.toContain('absolute')
  })

  it('swaps to a horizontal capacity bar below the narrow breakpoint', () => {
    const markup = renderToStaticMarkup(
      createElement(OwnedRentedDonut, { owned: 12, rented: 4 }),
    )
    // Donut only at/above the breakpoint, bar only below it.
    expect(markup).toContain('min-[400px]:block')
    expect(markup).toContain('min-[400px]:hidden')
    // The wrapper can shrink inside the grid cell.
    expect(markup).toContain('min-w-0')
    expect(markup).toContain('Owned 12.00 PF')
    expect(markup).toContain('Rented 4.00 PF')
  })
})

describe('ComputeMarketPanel', () => {
  it('stacks the capacity mix below the narrow breakpoint', () => {
    useGameStore.setState({ state: createGame(6_407) })
    const markup = renderToStaticMarkup(createElement(ComputeMarketPanel))
    expect(markup).toContain('Compute market')
    expect(markup).toContain('>Compute</span>')
    expect(markup).toContain('>Provider desk</span>')
    expect(markup).toContain('min-[400px]:grid-cols-[auto_minmax(0,1fr)]')
    expect(markup).toContain('data-testid="compute-quote-card"')
    expect(markup).toContain('data-testid="compute-quote-cost-projection"')
    expect(markup).toContain('data-testid="compute-quote-risk-projection"')
    expect(markup).not.toContain('sm:grid-cols-5')
  })

  it('shows the sub-megawatt opening inventory and its full open pool', () => {
    const state = createGame(6_408)
    const provider = state.worldMarkets.cloudProviders.find(
      (entry) => entry.id === 'cloud-northstar',
    )!
    expect(maxCloudContractPf(provider.availablePf)).toBeLessThanOrEqual(1_000)
    expect(defaultCloudContractPf(provider.availablePf)).toBeLessThanOrEqual(
      maxCloudContractPf(provider.availablePf),
    )
    useGameStore.setState({ state })
    const markup = renderToStaticMarkup(createElement(ComputeMarketPanel))
    const maxMw = Number(pfToMw(maxCloudContractPf(provider.availablePf)).toFixed(3))
    expect(maxMw).toBeLessThanOrEqual(1)
    expect(markup).toContain(`max="${maxMw}"`)
  })
})
