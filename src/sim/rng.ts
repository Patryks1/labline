/** Mulberry32 seeded PRNG — deterministic sim. */
export function createRng(seed: number) {
  let s = seed >>> 0
  return {
    next(): number {
      s += 0x6d2b79f5
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    range(min: number, max: number): number {
      return min + this.next() * (max - min)
    },
    int(min: number, max: number): number {
      return Math.floor(this.range(min, max + 1))
    },
    pick<T>(arr: T[]): T {
      return arr[Math.floor(this.next() * arr.length)]!
    },
  }
}

export type Rng = ReturnType<typeof createRng>

/** Stable 32-bit seed from mixed numeric/string parts. */
export function hashSeed(...parts: (string | number | boolean | null | undefined)[]): number {
  let hash = 2166136261 >>> 0
  for (const part of parts) {
    const text = String(part ?? '')
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 16777619) >>> 0
    }
    hash ^= 0xff
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/** Deterministic identifier for persisted simulation entities. */
export function seededId(
  prefix: string,
  ...parts: (string | number | boolean | null | undefined)[]
): string {
  return `${prefix}-${hashSeed(prefix, ...parts).toString(36)}`
}
