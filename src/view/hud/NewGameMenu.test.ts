import { describe, expect, it } from 'vitest'
import { formatLastPlayed } from './menuTime'

describe('main menu save recency', () => {
  const now = Date.parse('2026-07-18T12:00:00.000Z')

  it('humanizes recent sandbox activity', () => {
    expect(formatLastPlayed('2026-07-18T11:42:00.000Z', now)).toBe('18m ago')
    expect(formatLastPlayed('2026-07-18T06:00:00.000Z', now)).toBe('6h ago')
    expect(formatLastPlayed('2026-07-15T12:00:00.000Z', now)).toBe('3d ago')
  })

  it('handles damaged timestamps without rendering an invalid date', () => {
    expect(formatLastPlayed('not-a-date', now)).toBe('time unknown')
  })
})
