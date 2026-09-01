import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { tickMarket } from '../systems/market'
import {
  SERVE_OUTAGE_MIN_DEMAND_MTOK,
  isInferenceOutage,
} from './serveThrottle'

describe('isInferenceOutage', () => {
  it('does not fire on a fresh game snapshot', () => {
    const state = createGame(11)
    expect(
      isInferenceOutage({
        capacityPf: state.lastMarket.capacityPf,
        unservedRatio: state.lastMarket.unservedRatio,
        demandMTok: state.lastMarket.playerDemandMTok,
      }),
    ).toBe(false)
  })

  it('does not treat an empty idle pool as an outage', () => {
    expect(
      isInferenceOutage({ capacityPf: 0, unservedRatio: 0, demandMTok: 0 }),
    ).toBe(false)
    expect(
      isInferenceOutage({
        capacityPf: 0,
        unservedRatio: 1,
        demandMTok: SERVE_OUTAGE_MIN_DEMAND_MTOK,
      }),
    ).toBe(false)
  })

  it('fires when demand exists and the inference pool is empty', () => {
    expect(
      isInferenceOutage({ capacityPf: 0, unservedRatio: 0, demandMTok: 1 }),
    ).toBe(true)
  })

  it('fires when coverage cannot admit 40%+ of demand', () => {
    expect(
      isInferenceOutage({ capacityPf: 50, unservedRatio: 0.4, demandMTok: 8 }),
    ).toBe(true)
    expect(
      isInferenceOutage({ capacityPf: 50, unservedRatio: 0.39, demandMTok: 8 }),
    ).toBe(false)
  })

  it('does not post a serve outage on the first market tick of a new game', () => {
    const next = tickMarket(createGame(37))
    expect(next.lastMarket.serveOutage).toBeFalsy()
    expect(
      next.feedEvents?.some((event) => event.kind === 'serve_outage'),
    ).toBeFalsy()
  })
})
