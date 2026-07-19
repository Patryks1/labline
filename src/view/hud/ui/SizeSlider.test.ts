import { describe, expect, it } from 'vitest'
import { parseParamsBox } from './modelSize'
import { PARAM_PRESETS } from '../../../sim/balance/training'

describe('model-size suffix parsing', () => {
  it('accepts explicit M, B, and T suffixes', () => {
    expect(parseParamsBox('400M')).toBe(0.4)
    expect(parseParamsBox('7B')).toBe(7)
    expect(parseParamsBox('1.8T')).toBe(1800)
  })

  it('uses the selected visible suffix and rejects invalid values', () => {
    expect(parseParamsBox('125', 'M')).toBe(0.125)
    expect(parseParamsBox('3', 'T')).toBe(3000)
    expect(parseParamsBox('large')).toBeNull()
    expect(parseParamsBox('-7B')).toBeNull()
  })

  it('exposes the full technology timeline checkpoint set', () => {
    expect(PARAM_PRESETS.map((preset) => preset.label)).toEqual([
      '7M', '70M', '125M', '400M', '1B', '1.5B', '3B', '7B', '13B', '22B',
      '34B', '70B', '110B', '180B', '235B', '405B', '671B', '1T', '1.8T',
      '3T', '5T', '7T', '10T', '13T', '20T', '30T',
    ])
  })
})
