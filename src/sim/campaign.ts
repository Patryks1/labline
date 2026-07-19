import type {
  CalendarState,
  CampaignEra,
  CampaignRules,
  ProgressionState,
} from './types'
import { GROUNDED_2026_INDUSTRY_PACK } from './balance/industryDataPack'

export const DEFAULT_CAMPAIGN_RULES: CampaignRules = {
  contentPackId: GROUNDED_2026_INDUSTRY_PACK.id,
  startYear: 2026,
  reportYear: 2036,
  endless: true,
  externalityMode: 'standard',
  autoPauseConfigured: true,
  cadence: {
    marketDays: 7,
    accountingDays: 30,
    reviewDays: 90,
    technologyDays: 365,
  },
  autoPause: {
    projectComplete: false,
    majorEvent: false,
    quarterlyReport: false,
    runwayEmergency: false,
  },
}

const DAY_MS = 86_400_000

export function defaultCampaignRules(
  overrides: Partial<CampaignRules> = {},
): CampaignRules {
  return {
    ...DEFAULT_CAMPAIGN_RULES,
    ...overrides,
    cadence: {
      ...DEFAULT_CAMPAIGN_RULES.cadence,
      ...(overrides.cadence ?? {}),
    },
    autoPause: {
      ...DEFAULT_CAMPAIGN_RULES.autoPause,
      ...(overrides.autoPause ?? {}),
    },
  }
}

export function eraForYear(
  year: number,
  reportYear = DEFAULT_CAMPAIGN_RULES.reportYear,
  startYear = DEFAULT_CAMPAIGN_RULES.startYear,
): CampaignEra {
  const elapsedYears = year - startYear
  if (elapsedYears <= 0) return 'cloud_startup'
  if (elapsedYears <= 2) return 'scaling_specialization'
  if (elapsedYears <= 5) return 'platform_competition'
  if (elapsedYears <= 8) return 'power_limited_frontier'
  if (year <= reportYear) return 'frontier_abundance'
  return 'endless'
}

function isMonthEnd(date: Date): boolean {
  const tomorrow = new Date(date.getTime() + DAY_MS)
  return tomorrow.getUTCMonth() !== date.getUTCMonth()
}

/** Day 1 is January 1 of the configured start year. */
export function calendarForDay(
  day: number,
  rules: CampaignRules = DEFAULT_CAMPAIGN_RULES,
): CalendarState {
  const safeDay = Math.max(1, Math.floor(day))
  const date = new Date(Date.UTC(rules.startYear, 0, safeDay))
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / DAY_MS) + 1
  const elapsed = safeDay - 1
  const month = date.getUTCMonth() + 1
  const dayOfMonth = date.getUTCDate()
  const monthEnd = isMonthEnd(date)
  return {
    year: date.getUTCFullYear(),
    month,
    dayOfMonth,
    dayOfYear,
    era: eraForYear(date.getUTCFullYear(), rules.reportYear, rules.startYear),
    isMarketDay: elapsed > 0 && elapsed % Math.max(1, rules.cadence.marketDays) === 0,
    // Accounting and review cadence follows the real calendar. The legacy
    // numeric fields remain in CampaignRules for save compatibility only.
    isAccountingDay: monthEnd,
    isReviewDay: monthEnd && month % 3 === 0,
    // Annual content applies on the first day of the new year, never one day
    // early on December 31. Day 1 is initialization, not an annual advance.
    isTechnologyDay: elapsed > 0 && month === 1 && dayOfMonth === 1,
  }
}

/** The decade report closes after the final operating day of reportYear. */
export function isCampaignReportDate(
  calendar: CalendarState,
  rules: CampaignRules = DEFAULT_CAMPAIGN_RULES,
): boolean {
  return (
    calendar.year > rules.reportYear ||
    (calendar.year === rules.reportYear &&
      calendar.month === 12 &&
      calendar.dayOfMonth === 31)
  )
}

export function createInitialProgression(): ProgressionState {
  return {
    era: 'cloud_startup',
    milestones: [
      {
        id: 'sustainable_launch',
        label: 'Sustainable launch',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'frontier_leader',
        label: 'Frontier Leader',
        qualifyingQuarters: 0,
        requiredQuarters: 4,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'abundance_leader',
        label: 'Abundance Leader',
        qualifyingQuarters: 0,
        requiredQuarters: 4,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'code_record',
        label: 'Code record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'science_record',
        label: 'Science record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'reliability_record',
        label: 'Reliability record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'creator_record',
        label: 'Creator quality record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'energy_efficiency_record',
        label: 'Energy efficiency record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'open_research_record',
        label: 'Open research record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'adoption_record',
        label: 'Adoption record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
      {
        id: 'company_value_record',
        label: 'Company value record',
        qualifyingQuarters: 0,
        requiredQuarters: 1,
        achievedDay: null,
        firstLabId: null,
      },
    ],
    decadeReport: null,
    reportAcknowledged: false,
    runPhase: 'campaign',
  }
}

export function formatCampaignDate(calendar: CalendarState): string {
  return `${calendar.year}-${String(calendar.month).padStart(2, '0')}-${String(
    calendar.dayOfMonth,
  ).padStart(2, '0')}`
}

/** Human-readable campaign clock: the date plus completed days since launch. */
export function formatCampaignClock(calendar: CalendarState, day: number): string {
  const elapsedDays = Math.max(0, Math.floor(day) - 1)
  return `${formatCampaignDate(calendar)} · ${elapsedDays.toLocaleString('en-US')} days since start`
}
