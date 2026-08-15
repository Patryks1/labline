import { describe, expect, it } from 'vitest'
import {
  RESEARCH_BRANCHES,
  RESEARCH_NODES,
  getResearchNode,
  researchBranchForNode,
} from '../balance/research'
import { createGame } from '../createGame'
import type { SimState } from '../types'
import {
  researchDaysTarget,
  researchPfTarget,
  tickResearch,
} from './research'
import {
  publishMethod,
  queueResearchProgram,
  startResearchProgram,
  tickResearchPrograms,
} from './researchPrograms'

function staffed(
  state: SimState,
  researchers = 4,
  engineers = 2,
  dataProcessors = 2,
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      cash: Math.max(state.player.cash, 10_000_000),
      staff: {
        ...(state.player.staff ?? {
          researcher: 0,
          engineer: 0,
          data_processor: 0,
          ops: 0,
        }),
        researcher: researchers,
        engineer: engineers,
        data_processor: dataProcessors,
      },
    },
  }
}

describe('research programs and pods', () => {
  it('maps the existing method backbone into seven branches', () => {
    expect(Object.keys(RESEARCH_BRANCHES)).toHaveLength(7)
    expect(RESEARCH_NODES.every((node) => researchBranchForNode(node.id) in RESEARCH_BRANCHES)).toBe(true)
  })

  it('requires and reserves a named-lead pod', () => {
    const state = staffed(createGame(601))
    const next = startResearchProgram(state, 'sys_batching', 'pod-systems', 0.3)
    expect(next.player.researchPrograms).toHaveLength(1)
    expect(next.player.researchPods?.find((pod) => pod.id === 'pod-systems')).toMatchObject({
      assignmentId: next.player.researchPrograms?.[0]?.id,
      researchers: 1,
      engineers: 1,
      dataStaff: 1,
    })
    const duplicate = startResearchProgram(next, 'sys_quant', 'pod-systems', 0.3)
    expect(duplicate.player.researchPrograms).toHaveLength(1)
  })

  it('cannot reserve the same employed staff into two concurrent pods', () => {
    const state = staffed(createGame(609), 1, 1, 1)
    const first = startResearchProgram(
      state,
      'sys_batching',
      'pod-systems',
      0.4,
    )
    const second = startResearchProgram(
      first,
      'opt_checkpoint',
      'pod-foundations',
      0.4,
    )

    expect(first.player.researchPrograms).toHaveLength(1)
    expect(second.player.researchPrograms).toHaveLength(1)
    expect(second.alerts[0]?.message).toContain(
      'available researchers (have 0)',
    )
  })

  it('progresses through evidence and integration before unlocking', () => {
    let state = startResearchProgram(staffed(createGame(602)), 'sys_batching', 'pod-systems', 0.8)
    for (let day = 0; day < 700 && !state.player.researchUnlocked.includes('sys_batching'); day++) {
      state = tickResearchPrograms({ ...state, day: state.day + 1 })
    }
    const program = state.player.researchPrograms?.[0]
    expect(program?.phase).toBe('complete')
    expect(program?.evidence.length).toBeGreaterThanOrEqual(2)
    expect(state.player.researchUnlocked).toContain('sys_batching')
    const published = publishMethod(state, program!.id)
    expect(published.player.researchPrograms?.[0]?.disclosure).toBe('published')
    expect(published.player.brandTrust).toBeGreaterThan(state.player.brandTrust)
  })

  it('queues dependent methods and assigns them as pods and prerequisites become available', () => {
    let state = staffed(createGame(603))
    state = queueResearchProgram(state, 'sys_batching')
    state = queueResearchProgram(state, 'sys_quant')
    expect(state.player.researchProgramQueue).toEqual(['sys_batching', 'sys_quant'])
    state = tickResearchPrograms(state)
    expect(state.player.researchPrograms?.some((program) => program.methodId === 'sys_batching')).toBe(true)
    expect(state.player.researchProgramQueue).toContain('sys_quant')
    for (let day = 0; day < 900 && !state.player.researchPrograms?.some((program) => program.methodId === 'sys_quant'); day++) {
      state = tickResearchPrograms({ ...state, day: state.day + 1 })
    }
    expect(state.player.researchPrograms?.some((program) => program.methodId === 'sys_quant')).toBe(true)
    expect(state.player.researchProgramQueue).not.toContain('sys_quant')
  })

  it('queues a locked target with its shortest prerequisite path in dependency order', () => {
    let state = createGame(604)
    state = queueResearchProgram(state, 'sys_tensor_rt')
    expect(state.player.researchProgramQueue).toEqual([
      'sys_batching',
      'sys_kernels',
      'sys_compile',
      'sys_tensor_rt',
    ])

    // Selecting the target again and selecting a sibling path never duplicates work.
    state = queueResearchProgram(state, 'sys_tensor_rt')
    state = queueResearchProgram(state, 'opt_torch_compile')
    expect(state.player.researchProgramQueue?.filter((id) => id === 'sys_batching')).toHaveLength(1)
    expect(state.player.researchProgramQueue?.filter((id) => id === 'sys_compile')).toHaveLength(1)
    expect(state.player.researchProgramQueue).toEqual([
      'sys_batching',
      'sys_kernels',
      'sys_compile',
      'sys_tensor_rt',
      'opt_checkpoint',
      'opt_flash',
      'opt_fp16',
      'opt_mixed',
      'opt_torch_compile',
    ])
  })

  it('cannot open or progress closed-loop research below 32 researchers or with zero cash', () => {
    const method = getResearchNode('mm_closed_loop_research')
    const unlocked = ['dense_basics', ...method.prereqs]
    const insufficient = staffed(createGame(605), 31, 6, 4)
    const rejected = startResearchProgram(
      {
        ...insufficient,
        player: { ...insufficient.player, researchUnlocked: unlocked },
      },
      method.id,
      'pod-foundations',
      0.8,
    )
    expect(rejected.player.researchPrograms).toHaveLength(0)
    expect(rejected.alerts[0]?.message).toContain('32 available researchers')

    let active = staffed(createGame(606), 32, 6, 4)
    active = {
      ...active,
      player: { ...active.player, researchUnlocked: unlocked },
    }
    active = startResearchProgram(active, method.id, 'pod-foundations', 0.8)
    expect(active.player.researchPrograms).toHaveLength(1)
    const initial = active.player.researchPrograms![0]!

    const understaffed = tickResearchPrograms({
      ...active,
      player: {
        ...active.player,
        staff: { ...active.player.staff!, researcher: 31 },
      },
    })
    expect(understaffed.player.researchPrograms?.[0]?.progressPfDays).toBe(
      initial.progressPfDays,
    )
    expect(understaffed.player.researchPrograms?.[0]?.daysSpent).toBe(
      initial.daysSpent,
    )

    const broke = tickResearchPrograms({
      ...active,
      player: { ...active.player, cash: 0 },
    })
    expect(broke.player.researchPrograms?.[0]?.progressPfDays).toBe(
      initial.progressPfDays,
    )
    expect(broke.player.researchPrograms?.[0]?.daysSpent).toBe(
      initial.daysSpent,
    )
    expect(broke.player.researchUnlocked).not.toContain(method.id)

    const computeStarved = tickResearchPrograms({
      ...active,
      computeContracts: [],
      computeLeases: [],
      player: {
        ...active.player,
        computeContracts: [],
        allocation: { training: 0.4, inference: 0.6, research: 0 },
      },
    })
    expect(computeStarved.player.researchPrograms?.[0]?.progressPfDays).toBe(
      initial.progressPfDays,
    )
    expect(computeStarved.player.researchPrograms?.[0]?.daysSpent).toBe(
      initial.daysSpent,
    )
  })

  it('applies serving and training effects exactly once on PF-plus-calendar completion', () => {
    const method = getResearchNode('opt_flash')
    let state = staffed(createGame(607), 4, 2, 2)
    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...new Set([...state.player.researchUnlocked, ...method.prereqs]),
        ],
      },
    }
    state = startResearchProgram(state, method.id, 'pod-foundations', 0.8)
    const pod = state.player.researchPods!.find(
      (candidate) => candidate.id === 'pod-foundations',
    )!
    const target = researchPfTarget(state, method)
    const days = researchDaysTarget(method, pod.researchers)
    const program = {
      ...state.player.researchPrograms![0]!,
      phase: 'integration' as const,
      insightProgress: 1,
      engineeringProgress: 1,
      progressPfDays: target,
      daysSpent: days - 1,
      evidence: [
        { id: 'pilot', source: 'pilot' as const, strength: 0.8, day: state.day },
        { id: 'training', source: 'training' as const, strength: 0.8, day: state.day },
      ],
    }
    state = {
      ...state,
      player: {
        ...state.player,
        researchPrograms: [program],
      },
    }
    const servingBefore = state.player.servingEfficiency
    const trainingBefore = state.player.trainEfficiency
    const completed = tickResearchPrograms(state)

    expect(completed.player.researchPrograms?.[0]).toMatchObject({
      phase: 'complete',
      effectsApplied: true,
      daysSpent: days,
    })
    expect(completed.player.researchUnlocked.filter((id) => id === method.id)).toHaveLength(1)
    expect(completed.player.servingEfficiency).toBeCloseTo(
      servingBefore + method.effects.servingEfficiency!,
    )
    expect(completed.player.trainEfficiency).toBeCloseTo(
      trainingBefore + method.effects.trainEfficiency!,
    )

    const repeated = tickResearchPrograms(completed)
    expect(repeated.player.servingEfficiency).toBeCloseTo(
      completed.player.servingEfficiency,
    )
    expect(repeated.player.trainEfficiency).toBeCloseTo(
      completed.player.trainEfficiency,
    )
  })

  it('lets only the legacy authority progress when a malformed save has both active', () => {
    let state = startResearchProgram(
      staffed(createGame(608)),
      'sys_batching',
      'pod-systems',
      0.8,
    )
    const programBefore = state.player.researchPrograms![0]!
    state = {
      ...state,
      player: {
        ...state.player,
        activeResearch: {
          nodeId: 'opt_checkpoint',
          progressPfDays: 0,
          daysSpent: 0,
        },
      },
    }

    const legacyTick = tickResearch(state)
    expect(legacyTick.player.activeResearch?.progressPfDays).toBeGreaterThan(0)
    const podTick = tickResearchPrograms(legacyTick)
    expect(podTick.player.researchPrograms?.[0]?.progressPfDays).toBe(
      programBefore.progressPfDays,
    )
  })
})
