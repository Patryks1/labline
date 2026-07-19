import type { WorldChange, WorldChangesSince } from './types'

/** Bounded monotonic journal. Consumers rebuild visible state when their cursor is stale. */
export class WorldChangeJournal {
  readonly capacity: number
  private entries: WorldChange[] = []
  private sequenceValue = 0
  private evictedThrough = 0

  constructor(capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('journal capacity must be a positive integer')
    }
    this.capacity = capacity
  }

  get sequence(): number {
    return this.sequenceValue
  }

  get size(): number {
    return this.entries.length
  }

  append(change: Omit<WorldChange, 'sequence'>): WorldChange {
    const entry: WorldChange = Object.freeze({
      ...change,
      sequence: ++this.sequenceValue,
      tileIds: Object.freeze([...change.tileIds]),
      chunkIds: Object.freeze([...change.chunkIds]),
      facilityIds: Object.freeze([...change.facilityIds]),
      cityIndexes: Object.freeze([...change.cityIndexes]),
    })
    this.entries.push(entry)
    if (this.entries.length > this.capacity) {
      const removed = this.entries.shift()
      if (removed) this.evictedThrough = removed.sequence
    }
    return entry
  }

  changesSince(sequence: number): WorldChangesSince {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.sequenceValue) {
      return { kind: 'reset', reason: 'invalid-sequence', nextSequence: this.sequenceValue }
    }
    if (sequence < this.evictedThrough) {
      return { kind: 'reset', reason: 'history-evicted', nextSequence: this.sequenceValue }
    }
    if (sequence === this.sequenceValue) {
      return { kind: 'delta', changes: [], nextSequence: this.sequenceValue }
    }
    const first = this.entries.findIndex((entry) => entry.sequence > sequence)
    return {
      kind: 'delta',
      changes: first < 0 ? [] : this.entries.slice(first),
      nextSequence: this.sequenceValue,
    }
  }
}
