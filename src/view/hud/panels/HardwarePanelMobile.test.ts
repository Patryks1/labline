import { describe, expect, it } from 'vitest'
import { hardwareViewAfterSwipe } from './hardware/mobileHardwareNavigation'

describe('hardware mobile swipe navigation', () => {
  it('moves between rack and silicon workspaces with a deliberate horizontal swipe', () => {
    expect(hardwareViewAfterSwipe('racks', -80, 8)).toBe('silicon')
    expect(hardwareViewAfterSwipe('silicon', 80, 8)).toBe('racks')
  })

  it('does not switch for short, vertical, or boundary swipes', () => {
    expect(hardwareViewAfterSwipe('racks', -40, 2)).toBe('racks')
    expect(hardwareViewAfterSwipe('racks', -80, 75)).toBe('racks')
    expect(hardwareViewAfterSwipe('silicon', -80, 2)).toBe('silicon')
    expect(hardwareViewAfterSwipe('racks', 80, 2)).toBe('racks')
  })
})
