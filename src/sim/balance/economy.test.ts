import { describe, expect, it } from 'vitest'
import { INITIAL_AI_USERS, SEGMENTS, WORLD_POPULATION } from './economy'

describe('AI audience balance', () => {
  it('starts with two billion AI users inside an eight billion world', () => {
    expect(SEGMENTS.reduce((sum, segment) => sum + segment.baseSize, 0)).toBe(INITIAL_AI_USERS)
    expect(INITIAL_AI_USERS).toBe(2_000_000_000)
    expect(WORLD_POPULATION).toBe(8_000_000_000)
  })
})
