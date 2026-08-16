import { describe, expect, it } from 'vitest'
import { mobileKpiHistoryRect } from './KpiHistoryPopover'

describe('KpiHistoryPopover responsive geometry', () => {
  it('keeps the 390px sheet fully inside the viewport', () => {
    const rect = mobileKpiHistoryRect({
      viewportWidth: 390,
      viewportHeight: 844,
      minInlineInset: 4.8,
      topInset: 108.8,
      bottomInset: 68.8,
    })

    expect(rect.left).toBeCloseTo(4.8)
    expect(rect.right).toBeCloseTo(385.2)
    expect(rect.width).toBeCloseTo(380.4)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(844)
  })

  it('honors asymmetric safe-area insets without escaping the viewport', () => {
    const rect = mobileKpiHistoryRect({
      viewportWidth: 390,
      viewportHeight: 844,
      minInlineInset: 4.8,
      topInset: 108.8,
      bottomInset: 68.8,
      safeLeft: 12,
      safeRight: 8,
    })

    expect(rect.left).toBe(12)
    expect(rect.right).toBe(382)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(390)
  })
})
