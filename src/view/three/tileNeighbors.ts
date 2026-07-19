import type { MapTile, TileKind } from '../../sim/types'

/** Cardinal bits: N=1, E=2, S=4, W=8 (classic auto-tile mask). */
export type NeighborMask = number

export interface Neighbors {
  n: boolean
  e: boolean
  s: boolean
  w: boolean
  mask: NeighborMask
  /** Same-kind count among 4-neighbors */
  count: number
}

const DIRS = [
  { k: 'n' as const, dx: 0, dy: -1, bit: 1 },
  { k: 'e' as const, dx: 1, dy: 0, bit: 2 },
  { k: 's' as const, dx: 0, dy: 1, bit: 4 },
  { k: 'w' as const, dx: -1, dy: 0, bit: 8 },
]

/** Kinds that connect for seamless tileset blending. */
export function connectsAs(kind: TileKind, other: TileKind | undefined): boolean {
  if (!other) return false
  if (kind === other) return true
  // Roads run through cities
  if (kind === 'road' && other === 'city') return true
  if (kind === 'city' && other === 'road') return true
  // Forest clusters
  if (kind === 'forest' && other === 'park') return false
  return false
}

export function buildKindIndex(tiles: MapTile[]): Map<string, TileKind> {
  const m = new Map<string, TileKind>()
  for (const t of tiles) m.set(`${t.x},${t.y}`, t.kind)
  return m
}

export function neighborsAt(
  index: Map<string, TileKind>,
  x: number,
  y: number,
  kind: TileKind,
): Neighbors {
  let mask = 0
  let count = 0
  const out = { n: false, e: false, s: false, w: false, mask: 0, count: 0 }
  for (const d of DIRS) {
    const ok = connectsAs(kind, index.get(`${x + d.dx},${y + d.dy}`))
    out[d.k] = ok
    if (ok) {
      mask |= d.bit
      count++
    }
  }
  out.mask = mask
  out.count = count
  return out
}

export function isInterior(n: Neighbors): boolean {
  return n.count === 4
}

export function isEdge(n: Neighbors): boolean {
  return n.count > 0 && n.count < 4
}
