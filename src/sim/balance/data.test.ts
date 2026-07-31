import { describe, expect, it } from 'vitest'
import {
  createEmptyLabData,
  minDataMTokForParams,
  recommendedDataMTok,
} from './data'

describe('starter data foundation', () => {
  it('starts with 500 MTok of mostly text and no free regulated or time media holdings', () => {
    const data = createEmptyLabData()
    const total = Object.values(data.stocks).reduce(
      (sum, stock) => sum + stock.processed,
      0,
    )
    const text = ['chat', 'code', 'math', 'science'].reduce(
      (sum, domain) =>
        sum + data.stocks[domain as keyof typeof data.stocks].processed,
      0,
    )

    expect(total).toBe(500)
    expect(text / total).toBeGreaterThanOrEqual(0.98)
    expect(data.stocks.law.processed).toBe(0)
    expect(data.stocks.health.processed).toBe(0)
    expect(data.stocks.audio.processed).toBe(0)
    expect(data.stocks.video.processed).toBe(0)
    expect(data.stocks.image.processed).toBeLessThanOrEqual(5)
  })

  it('can feed a minimum 125M run but remains below the strong target', () => {
    const total = Object.values(createEmptyLabData().stocks).reduce(
      (sum, stock) => sum + stock.processed,
      0,
    )

    expect(total).toBeGreaterThanOrEqual(minDataMTokForParams(0.125))
    expect(total).toBeLessThan(recommendedDataMTok(0.125, 'dense'))
  })
})
