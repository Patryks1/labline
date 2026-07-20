/**
 * Research tree layout — pure geometry from RESEARCH_NODES.
 *
 * Adding research: append to RESEARCH_NODES with { id, trunk, prereqs, ... }.
 * This module recomputes positions; no manual x/y needed.
 *
 * The full catalog is laid out as an organic left-to-right dependency tree:
 * depth controls horizontal progress, while trunk lanes bend and cross so the
 * result reads as a network rather than ten vertical lists. A single filtered
 * trunk keeps a compact top-to-bottom layout for quick scanning.
 */
import type { ResearchNodeDef } from '../types'
import {
  RESEARCH_NODES,
  RESEARCH_TRUNKS,
  getResearchNode,
  type ResearchTrunkId,
} from './research'

export const RESEARCH_LAYOUT = {
  nodeW: 164,
  nodeH: 70,
  /** Horizontal gap between trunk columns */
  colGap: 64,
  /** Vertical gap between nodes in the same layer */
  rowGap: 38,
  /** Extra vertical gap after a depth layer */
  layerGap: 46,
  padX: 42,
  padY: 56,
  headerH: 32,
} as const

export interface TreeLayoutNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  trunk: ResearchTrunkId
  /** Layer index (0 = roots) */
  depth: number
  /** Order within layer */
  slot: number
  /** Center of node (for edges) */
  cx: number
  cy: number
}

export interface TreeLayoutEdge {
  from: string
  to: string
  /** Both endpoints exist in layout.nodes */
  x1: number
  y1: number
  x2: number
  y2: number
  /** True if prereq is in a different trunk */
  crossTrunk: boolean
}

export interface ResearchTreeLayout {
  nodes: TreeLayoutNode[]
  edges: TreeLayoutEdge[]
  width: number
  height: number
  /** Left edge of each trunk column */
  trunkX: Record<string, number>
  byId: Map<string, TreeLayoutNode>
}

/** Global prereq depth (memoized). */
export function researchDepth(
  id: string,
  memo: Map<string, number> = new Map(),
  stack: Set<string> = new Set(),
): number {
  if (memo.has(id)) return memo.get(id)!
  if (stack.has(id)) {
    // Cycle guard
    memo.set(id, 0)
    return 0
  }
  stack.add(id)
  let node: ResearchNodeDef
  try {
    node = getResearchNode(id)
  } catch {
    memo.set(id, 0)
    stack.delete(id)
    return 0
  }
  if (node.prereqs.length === 0) {
    memo.set(id, 0)
    stack.delete(id)
    return 0
  }
  const d =
    1 + Math.max(...node.prereqs.map((p) => researchDepth(p, memo, stack)))
  memo.set(id, d)
  stack.delete(id)
  return d
}

/**
 * Build the full organic dependency tree. Deterministic; safe to call every render.
 */
export function layoutResearchTree(
  nodes: ResearchNodeDef[] = RESEARCH_NODES,
  trunks: readonly ResearchTrunkId[] = RESEARCH_TRUNKS,
): ResearchTreeLayout {
  const L = RESEARCH_LAYOUT
  const depthMemo = new Map<string, number>()

  if (trunks.length === 1) {
    return layoutLinearTrunks(nodes, trunks, depthMemo)
  }

  const trunkOrder = new Map<ResearchTrunkId, number>(
    trunks.map((trunk, index) => [trunk, index]),
  )
  const layerSlots = new Map<string, number>()
  const byDepth = new Map<number, ResearchNodeDef[]>()

  for (const node of nodes) {
    const trunk = node.trunk as ResearchTrunkId
    if (!trunkOrder.has(trunk)) continue
    const depth = researchDepth(node.id, depthMemo)
    const layer = byDepth.get(depth) ?? []
    layer.push(node)
    byDepth.set(depth, layer)
  }

  const placed: TreeLayoutNode[] = []
  const depthPitch = L.nodeW + 138
  const lanePitch = L.nodeH + 104

  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const layer = (byDepth.get(depth) ?? [])
      .map((node) => {
        const trunk = node.trunk as ResearchTrunkId
        const trunkIndex = trunkOrder.get(trunk) ?? 0
        const slotKey = `${node.trunk}:${depth}`
        const slot = layerSlots.get(slotKey) ?? 0
        layerSlots.set(slotKey, slot + 1)
        const wave = Math.sin(depth * 1.14 + trunkIndex * 0.92) * 68
        const jitterY = (stableUnit(node.id, 17) - 0.5) * 46
        const desiredY =
          L.padY +
          L.headerH +
          trunkIndex * lanePitch +
          wave +
          jitterY +
          slot * (L.nodeH + L.rowGap)
        return { node, trunk, trunkIndex, slot, desiredY }
      })
      .sort((a, b) => a.desiredY - b.desiredY || a.node.name.localeCompare(b.node.name))

    let cursorY = L.padY + L.headerH
    for (const item of layer) {
      const jitterX = (stableUnit(item.node.id, 31) - 0.5) * 34
      const branchOffset = item.trunkIndex % 2 === 0 ? -10 : 16
      const x = Math.max(L.padX, L.padX + depth * depthPitch + jitterX + branchOffset)
      const y = Math.max(item.desiredY, cursorY)
      placed.push({
        id: item.node.id,
        x,
        y,
        w: L.nodeW,
        h: L.nodeH,
        trunk: item.trunk,
        depth,
        slot: item.slot,
        cx: x + L.nodeW / 2,
        cy: y + L.nodeH / 2,
      })
      cursorY = y + L.nodeH + L.rowGap
    }
  }

  const minY = Math.min(...placed.map((node) => node.y), L.padY)
  const yShift = minY < L.padY ? L.padY - minY : 0
  if (yShift > 0) {
    for (const node of placed) {
      node.y += yShift
      node.cy += yShift
    }
  }

  const trunkX: Record<string, number> = {}
  for (const trunk of trunks) {
    const branch = placed.filter((node) => node.trunk === trunk)
    trunkX[trunk] = branch.length > 0 ? Math.min(...branch.map((node) => node.x)) : L.padX
  }

  return finishLayout(nodes, placed, trunkX, true)
}

function layoutLinearTrunks(
  nodes: ResearchNodeDef[],
  trunks: readonly ResearchTrunkId[],
  depthMemo: Map<string, number>,
): ResearchTreeLayout {
  const L = RESEARCH_LAYOUT

  const byTrunk = new Map<string, ResearchNodeDef[]>()
  for (const t of trunks) byTrunk.set(t, [])
  for (const n of nodes) {
    const list = byTrunk.get(n.trunk)
    if (list) list.push(n)
    else byTrunk.set(n.trunk, [n])
  }

  const placed: TreeLayoutNode[] = []
  const trunkX: Record<string, number> = {}
  let maxBottom: number = L.padY

  trunks.forEach((trunk, ti) => {
    const colX = L.padX + ti * (L.nodeW + L.colGap)
    trunkX[trunk] = colX

    const list = (byTrunk.get(trunk) ?? []).slice()
    // Layer → nodes
    const layers = new Map<number, ResearchNodeDef[]>()
    for (const n of list) {
      const d = researchDepth(n.id, depthMemo)
      const arr = layers.get(d) ?? []
      arr.push(n)
      layers.set(d, arr)
    }
    for (const arr of layers.values()) {
      arr.sort(
        (a, b) =>
          a.costPfDays - b.costPfDays || a.name.localeCompare(b.name),
      )
    }

    const depths = [...layers.keys()].sort((a, b) => a - b)
    // Pack layers without overlap: cursorY advances past each node
    let cursorY = L.padY + L.headerH

    for (const d of depths) {
      const layer = layers.get(d) ?? []
      layer.forEach((n, slot) => {
        const x = colX
        const y = cursorY
        placed.push({
          id: n.id,
          x,
          y,
          w: L.nodeW,
          h: L.nodeH,
          trunk: trunk as ResearchTrunkId,
          depth: d,
          slot,
          cx: x + L.nodeW / 2,
          cy: y + L.nodeH / 2,
        })
        cursorY += L.nodeH + L.rowGap
      })
      // Extra space between depth layers (if layer had nodes)
      if (layer.length > 0) cursorY += L.layerGap - L.rowGap
    }

    maxBottom = Math.max(maxBottom, cursorY)
  })

  const layout = finishLayout(nodes, placed, trunkX)
  return {
    ...layout,
    width: L.padX * 2 + trunks.length * L.nodeW + (trunks.length - 1) * L.colGap,
    height: maxBottom + L.padY,
  }
}

function finishLayout(
  nodes: ResearchNodeDef[],
  placed: TreeLayoutNode[],
  trunkX: Record<string, number>,
  horizontal = false,
): ResearchTreeLayout {
  const L = RESEARCH_LAYOUT
  const byId = new Map(placed.map((node) => [node.id, node]))

  const edges: TreeLayoutEdge[] = []
  for (const n of nodes) {
    for (const p of n.prereqs) {
      const from = byId.get(p)
      const to = byId.get(n.id)
      if (!from || !to) continue
      edges.push({
        from: p,
        to: n.id,
        x1: horizontal ? from.x + from.w : from.cx,
        y1: horizontal ? from.cy : from.y + from.h,
        x2: horizontal ? to.x : to.cx,
        y2: horizontal ? to.cy : to.y,
        crossTrunk: from.trunk !== to.trunk,
      })
    }
  }

  const width = Math.max(L.nodeW + L.padX * 2, ...placed.map((node) => node.x + node.w + L.padX))
  const height = Math.max(L.nodeH + L.padY * 2, ...placed.map((node) => node.y + node.h + L.padY))

  return { nodes: placed, edges, width, height, trunkX, byId }
}

function stableUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

/**
 * Layout a single trunk only (full width of panel, tighter).
 * Used when the user filters to Data / etc.
 */
export function layoutResearchTrunk(
  trunk: ResearchTrunkId,
  nodes: ResearchNodeDef[] = RESEARCH_NODES,
): ResearchTreeLayout {
  const subset = nodes.filter((n) => n.trunk === trunk)
  // Fake single-trunk trunks list so column index is 0
  return layoutResearchTree(subset, [trunk])
}

/** Axis-aligned box overlap (strict). */
export function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 0,
): boolean {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  )
}

/** True if any two layout nodes overlap (used in tests). */
export function layoutHasOverlaps(layout: ResearchTreeLayout, pad = 1): boolean {
  const ns = layout.nodes
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      if (boxesOverlap(ns[i]!, ns[j]!, pad)) return true
    }
  }
  return false
}
