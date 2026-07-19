import { describe, expect, it } from 'vitest'
import {
  defaultModelStack,
  modelStackModifiers,
  modelStackModulesForFamily,
  sanitizeModelStack,
} from './modelStack'

describe('model stack integrations', () => {
  it('only enables researched modules compatible with the family', () => {
    expect(sanitizeModelStack(
      ['opt_flash', 'dense_opt', 'moe_balance', 'not-real'],
      ['opt_flash', 'dense_opt', 'moe_balance'],
      'dense',
    )).toEqual(['opt_flash', 'dense_opt'])
  })

  it('stacks hosting, speed, training, and capability tradeoffs', () => {
    const modifiers = modelStackModifiers(['opt_flash', 'sys_kernels', 'dense_opt'], 'dense')
    expect(modifiers.hostingMult).toBeCloseTo(0.94 * 0.88)
    expect(modifiers.speedMult).toBeCloseTo(1.12 * 1.18)
    expect(modifiers.trainCostMult).toBeCloseTo(0.9 * 0.94 * 0.9)
    expect(modifiers.capabilityBonus).toBeCloseTo(1.8)
  })

  it('offers family-specific integrations', () => {
    const ids = modelStackModulesForFamily('moe').map((module) => module.id)
    expect(ids).toContain('moe_balance')
    expect(ids).not.toContain('dense_opt')
    expect(defaultModelStack(['moe_balance'], 'moe')).toEqual(['moe_balance'])
  })
})
