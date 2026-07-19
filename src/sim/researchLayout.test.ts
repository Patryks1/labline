import { describe, expect, it } from 'vitest'
import { RESEARCH_NODES, RESEARCH_TRUNKS } from './balance/research'
import {
  layoutHasOverlaps,
  layoutResearchTree,
  layoutResearchTrunk,
  researchDepth,
} from './balance/researchLayout'

describe('research tree layout', () => {
  it('places every catalog node exactly once', () => {
    const layout = layoutResearchTree()
    expect(layout.nodes.length).toBe(RESEARCH_NODES.length)
    const ids = new Set(layout.nodes.map((n) => n.id))
    for (const n of RESEARCH_NODES) {
      expect(ids.has(n.id)).toBe(true)
    }
  })

  it('never overlaps node boxes (full tree)', () => {
    const layout = layoutResearchTree()
    expect(layoutHasOverlaps(layout)).toBe(false)
  })

  it('never overlaps within each trunk filter', () => {
    for (const t of RESEARCH_TRUNKS) {
      const layout = layoutResearchTrunk(t)
      expect(layoutHasOverlaps(layout), t).toBe(false)
      const expected = RESEARCH_NODES.filter((n) => n.trunk === t).length
      expect(layout.nodes.length).toBe(expected)
    }
  })

  it('data trunk includes mix + specialists as early layers', () => {
    const layout = layoutResearchTrunk('data')
    const mix = layout.byId.get('data_mix')
    const specialists = layout.byId.get('data_specialists')
    expect(mix).toBeTruthy()
    expect(specialists).toBeTruthy()
    expect(researchDepth('data_mix')).toBe(0)
    expect(researchDepth('data_specialists')).toBe(1)
    // specialists below mix
    expect(specialists!.y).toBeGreaterThan(mix!.y)
  })

  it('adding a synthetic node extends layout without overlap', () => {
    const extra = [
      ...RESEARCH_NODES,
      {
        id: 'data_test_extra',
        trunk: 'data' as const,
        name: 'Test Extra',
        description: 'Layout probe',
        costPfDays: 5,
        daysMin: 2,
        prereqs: ['data_mix'],
        effects: {},
      },
    ]
    const layout = layoutResearchTree(extra, RESEARCH_TRUNKS)
    expect(layout.byId.has('data_test_extra')).toBe(true)
    expect(layoutHasOverlaps(layout)).toBe(false)
  })
})
