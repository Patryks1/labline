import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { boundHistories } from './history'
import { appendFeedEvents, FEED_EVENT_LIMIT } from './feed'

describe('typed world feed', () => {
  it('prepends deterministic events and de-duplicates replayed ids', () => {
    const state = createGame(912)
    const first = appendFeedEvents(state, [
      {
        id: 'feed-test-1',
        day: state.day,
        category: 'market',
        title: 'Quote moved',
        body: 'The compute desk repriced the opening quote.',
      },
    ])
    const replayed = appendFeedEvents(first, [
      {
        id: 'feed-test-1',
        day: state.day,
        category: 'market',
        title: 'Duplicate quote',
        body: 'This transition should remain one card.',
      },
      {
        id: 'feed-test-2',
        day: state.day + 1,
        category: 'models',
        title: 'Checkpoint reached',
        body: 'A training run crossed a milestone.',
      },
    ])

    expect(replayed.feedEvents?.map((event) => event.id)).toEqual([
      'feed-test-1',
      'feed-test-2',
      'feed-world-open-day-1',
    ])
    expect(replayed.feedEvents?.filter((event) => event.id === 'feed-test-1')).toHaveLength(1)
  })

  it('caps newest-first history and preserves old-save compatibility', () => {
    const state = createGame(913)
    const events = Array.from({ length: FEED_EVENT_LIMIT + 8 }, (_, index) => ({
      id: `feed-test-cap-${index}`,
      day: index + 1,
      category: 'world' as const,
      title: `Transition ${index}`,
      body: 'A bounded transition.',
    })).reverse()
    const next = appendFeedEvents({ ...state, feedEvents: undefined }, events)
    expect(next.feedEvents).toHaveLength(FEED_EVENT_LIMIT)
    expect(next.feedEvents?.[0]?.id).toBe(`feed-test-cap-${FEED_EVENT_LIMIT + 7}`)
    expect(next.feedEvents?.at(-1)?.id).toBe('feed-test-cap-8')
    expect(boundHistories({ ...next, feedEvents: [...next.feedEvents!, ...events] }).feedEvents).toHaveLength(FEED_EVENT_LIMIT)
  })
})
