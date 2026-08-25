import type {
  SimState,
  WorldFeedCategory,
  WorldFeedEvent,
  WorldFeedTone,
} from "../types";

/** Keep the typed journal useful in endless campaigns without growing saves. */
export const FEED_EVENT_LIMIT = 96;

export interface FeedEventInput {
  id: string;
  day: number;
  category: WorldFeedCategory;
  title: string;
  body: string;
  source?: string;
  tone?: WorldFeedTone;
  entityId?: string;
  kind?: string;
}

/** Build a typed entry at a system boundary; no wall-clock or random data. */
export function makeFeedEvent(input: FeedEventInput): WorldFeedEvent {
  return {
    id: input.id,
    day: Math.max(0, Math.floor(input.day)),
    category: input.category,
    title: input.title,
    body: input.body,
    ...(input.source ? { source: input.source } : {}),
    ...(input.tone ? { tone: input.tone } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  };
}

/** Prepend newest entries while de-duplicating deterministic event ids. */
export function appendFeedEvents(
  state: SimState,
  events: readonly (WorldFeedEvent | FeedEventInput)[],
): SimState {
  if (events.length === 0) return state;
  const existing = state.feedEvents ?? [];
  const additions = events.map((event) =>
    "title" in event && "body" in event
      ? makeFeedEvent(event as FeedEventInput)
      : event,
  );
  const seen = new Set<string>();
  const merged: WorldFeedEvent[] = [];
  for (const event of [...additions, ...existing]) {
    if (!event.id || seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
    if (merged.length >= FEED_EVENT_LIMIT) break;
  }
  return { ...state, feedEvents: merged };
}

