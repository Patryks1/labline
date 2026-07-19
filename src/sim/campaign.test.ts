import { describe, expect, it } from 'vitest'
import {
  calendarForDay,
  createInitialProgression,
  defaultCampaignRules,
  eraForYear,
  formatCampaignClock,
  isCampaignReportDate,
} from './campaign'

describe('decade campaign calendar', () => {
  it('shows the current date and completed days since the campaign started', () => {
    const rules = defaultCampaignRules({ startYear: 2026 })

    expect(formatCampaignClock(calendarForDay(1, rules), 1)).toBe(
      '2026-01-01 · 0 days since start',
    )
    expect(formatCampaignClock(calendarForDay(1_440, rules), 1_440)).toBe(
      '2029-12-10 · 1,439 days since start',
    )
  })

  it('keeps automatic interruptions opt-in by default', () => {
    const rules = defaultCampaignRules()
    expect(rules.autoPauseConfigured).toBe(true)
    expect(rules.autoPause).toEqual({
      projectComplete: false,
      majorEvent: false,
      quarterlyReport: false,
      runwayEmergency: false,
    })
  })

  it('maps deterministic days onto a Gregorian 2026 calendar', () => {
    const rules = defaultCampaignRules()
    expect(calendarForDay(1, rules)).toMatchObject({
      year: 2026,
      month: 1,
      dayOfMonth: 1,
      era: 'cloud_startup',
    })
    expect(calendarForDay(365, rules)).toMatchObject({
      year: 2026,
      month: 12,
      dayOfMonth: 31,
      isAccountingDay: true,
      isReviewDay: true,
    })
    expect(calendarForDay(366, rules)).toMatchObject({
      year: 2027,
      month: 1,
      dayOfMonth: 1,
      isTechnologyDay: true,
    })
    expect(calendarForDay(790, rules)).toMatchObject({
      year: 2028,
      month: 2,
      dayOfMonth: 29,
      isAccountingDay: true,
    })
  })

  it('uses weekly markets and true month/quarter boundaries', () => {
    const rules = defaultCampaignRules()
    expect(calendarForDay(8, rules).isMarketDay).toBe(true)
    expect(calendarForDay(31, rules)).toMatchObject({
      month: 1,
      dayOfMonth: 31,
      isAccountingDay: true,
      isReviewDay: false,
    })
    expect(calendarForDay(59, rules)).toMatchObject({
      month: 2,
      dayOfMonth: 28,
      isAccountingDay: true,
    })
    expect(calendarForDay(90, rules)).toMatchObject({
      month: 3,
      dayOfMonth: 31,
      isAccountingDay: true,
      isReviewDay: true,
    })
    expect(calendarForDay(91, rules).isReviewDay).toBe(false)
  })

  it('progresses relative to custom campaign years', () => {
    expect(eraForYear(2028)).toBe('scaling_specialization')
    expect(eraForYear(2036)).toBe('frontier_abundance')
    expect(eraForYear(2037)).toBe('endless')
    expect(eraForYear(2030, 2040, 2030)).toBe('cloud_startup')
    expect(eraForYear(2033, 2040, 2030)).toBe('platform_competition')
    expect(eraForYear(2041, 2040, 2030)).toBe('endless')
    expect(createInitialProgression().milestones).toHaveLength(11)
  })

  it('closes the 2026–2036 report on day 4018 exactly', () => {
    const rules = defaultCampaignRules()
    expect(isCampaignReportDate(calendarForDay(4017, rules), rules)).toBe(false)
    expect(calendarForDay(4018, rules)).toMatchObject({
      year: 2036,
      month: 12,
      dayOfMonth: 31,
      isReviewDay: true,
    })
    expect(isCampaignReportDate(calendarForDay(4018, rules), rules)).toBe(true)
    expect(calendarForDay(4019, rules)).toMatchObject({
      year: 2037,
      month: 1,
      dayOfMonth: 1,
      era: 'endless',
    })
  })
})
