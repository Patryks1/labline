import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import {
  emptyStaff,
  STAFF_POACH_INTERVAL_DAYS,
  STAFF_POACH_NOTICE_DAYS,
  staffPoachRetainCost,
} from '../balance/staff'
import {
  pendingStaffPoaches,
  playerStaff,
  retainStaffPoach,
  tickStaff,
} from './staff'

function staffedRaidTarget(seed: number, day: number) {
  const state = createGame(seed)
  return {
    ...state,
    day,
    player: {
      ...state.player,
      cash: 80_000_000,
      brandTrust: 0,
      staff: { ...emptyStaff(), researcher: 5, ops: 0 },
      pendingStaffPoaches: [],
    },
    rivals: state.rivals.map((rival, index) =>
      index === 0
        ? { ...rival, cash: 80_000_000 }
        : rival,
    ),
  }
}

describe('staff poach notice', () => {
  it('does not steal researchers on the old 11-day cadence', () => {
    const next = tickStaff(staffedRaidTarget(12_401, 11))
    expect(playerStaff(next).researcher).toBe(5)
    expect(pendingStaffPoaches(next)).toHaveLength(0)
    expect(next.alerts.some((alert) => alert.message.includes('poached'))).toBe(false)
  })

  it('announces a raise window instead of taking the employee immediately', () => {
    const next = tickStaff(staffedRaidTarget(12_402, STAFF_POACH_INTERVAL_DAYS))
    expect(playerStaff(next).researcher).toBe(5)
    const threat = pendingStaffPoaches(next)[0]
    expect(threat).toMatchObject({
      role: 'researcher',
      count: 1,
      startDay: STAFF_POACH_INTERVAL_DAYS,
      resolveDay: STAFF_POACH_INTERVAL_DAYS + STAFF_POACH_NOTICE_DAYS,
      retainCost: staffPoachRetainCost('researcher'),
    })
    expect(next.alerts[0]?.message).toMatch(/is poaching a researcher/i)
    expect(next.alerts[0]?.message).toContain('Match')
  })

  it('keeps the employee when the player matches the offer', () => {
    const announced = tickStaff(staffedRaidTarget(12_403, STAFF_POACH_INTERVAL_DAYS))
    const threat = pendingStaffPoaches(announced)[0]!
    const beforeCash = announced.player.cash
    const kept = retainStaffPoach(announced, threat.id)
    expect(playerStaff(kept).researcher).toBe(5)
    expect(pendingStaffPoaches(kept)).toHaveLength(0)
    expect(kept.player.cash).toBe(beforeCash - threat.retainCost)
    expect(kept.alerts[0]?.message).toMatch(/matched/i)
  })

  it('completes the raid if the raise window closes unpaid', () => {
    const announced = tickStaff(staffedRaidTarget(12_404, STAFF_POACH_INTERVAL_DAYS))
    const threat = pendingStaffPoaches(announced)[0]!
    const expired = tickStaff({ ...announced, day: threat.resolveDay })
    expect(playerStaff(expired).researcher).toBe(4)
    expect(pendingStaffPoaches(expired)).toHaveLength(0)
    expect(expired.alerts[0]?.message).toMatch(/after the raise window closed/i)
  })

  it('refuses a match the lab cannot pay', () => {
    const announced = tickStaff(staffedRaidTarget(12_405, STAFF_POACH_INTERVAL_DAYS))
    const threat = pendingStaffPoaches(announced)[0]!
    const broke = {
      ...announced,
      player: { ...announced.player, cash: threat.retainCost - 1 },
    }
    const next = retainStaffPoach(broke, threat.id)
    expect(playerStaff(next).researcher).toBe(5)
    expect(pendingStaffPoaches(next)).toHaveLength(1)
    expect(next.alerts[0]?.message).toMatch(/needs/i)
  })
})
