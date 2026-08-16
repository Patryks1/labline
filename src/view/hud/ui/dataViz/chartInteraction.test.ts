import { describe, expect, it, vi } from 'vitest'
import { consumeChartEscape } from './chartInteraction'

describe('consumeChartEscape', () => {
  it('clears chart selection without reaching global game hotkeys', () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const clear = vi.fn()

    const consumed = consumeChartEscape(
      { key: 'Escape', preventDefault, stopPropagation },
      clear,
    )

    expect(consumed).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('does not consume other keyboard navigation', () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const clear = vi.fn()

    const consumed = consumeChartEscape(
      { key: 'ArrowRight', preventDefault, stopPropagation },
      clear,
    )

    expect(consumed).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })
})
