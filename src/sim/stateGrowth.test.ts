import { describe, expect, it } from 'vitest'
import { createGame } from './createGame'
import { boundHistories, HISTORY_LIMITS } from './systems/history'
import { submitLabIntent } from './systems/labEngine'
import type { LabIntent, SimState } from './types'

function loanIntent(state: SimState, index: number): LabIntent {
  const id = `intent-loan-${index}`
  return {
    id,
    labId: state.playerLabId,
    kind: 'loan_application',
    submittedDay: index,
    application: {
      id: `application-${index}`,
      labId: state.playerLabId,
      principal: 5_000_000,
      termDays: 90,
      submittedDay: index,
      status: 'pending',
    },
  }
}

describe('bounded operational state', () => {
  it('coalesces current-policy intents instead of building a daily history', () => {
    let state = createGame(72_101)
    for (let index = 0; index < 1_000; index += 1) {
      state = submitLabIntent(state, {
        id: `allocation-${index}`,
        labId: state.playerLabId,
        kind: 'allocation',
        allocation: { training: 0.2, inference: 0.7, research: 0.1 },
        submittedDay: index,
      })
    }

    expect(state.worldMarkets.intents).toHaveLength(1)
    expect(state.worldMarkets.intents[0]?.id).toBe('allocation-999')
  })

  it('caps transaction intents and compacts oversized imported queues', () => {
    let state = createGame(72_102)
    for (let index = 0; index < 1_000; index += 1) {
      state = submitLabIntent(state, loanIntent(state, index))
    }

    expect(state.worldMarkets.intents).toHaveLength(HISTORY_LIMITS.pendingIntents)
    expect(state.worldMarkets.intents[0]?.id).toBe(
      `intent-loan-${1_000 - HISTORY_LIMITS.pendingIntents}`,
    )
    expect(state.worldMarkets.intents.at(-1)?.id).toBe('intent-loan-999')

    const imported = {
      ...state,
      worldMarkets: {
        ...state.worldMarkets,
        intents: Array.from({ length: 400 }, (_, index) => loanIntent(state, index)),
      },
    }
    const compacted = boundHistories(imported)
    expect(compacted.worldMarkets.intents).toHaveLength(HISTORY_LIMITS.pendingIntents)
    expect(compacted.worldMarkets.intents[0]?.id).toBe(
      `intent-loan-${400 - HISTORY_LIMITS.pendingIntents}`,
    )
  })
})
