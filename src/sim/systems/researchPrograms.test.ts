import { describe, expect, it } from 'vitest'
import { RESEARCH_BRANCHES, RESEARCH_NODES, researchBranchForNode } from '../balance/research'
import { createGame } from '../createGame'
import { publishMethod, queueResearchProgram, startResearchProgram, tickResearchPrograms } from './researchPrograms'

describe('research programs and pods', () => {
  it('maps the existing method backbone into seven branches', () => {
    expect(Object.keys(RESEARCH_BRANCHES)).toHaveLength(7)
    expect(RESEARCH_NODES.every((node) => researchBranchForNode(node.id) in RESEARCH_BRANCHES)).toBe(true)
  })

  it('requires and reserves a named-lead pod', () => {
    const state = createGame(601)
    const next = startResearchProgram(state, 'sys_batching', 'pod-systems', 0.3)
    expect(next.player.researchPrograms).toHaveLength(1)
    expect(next.player.researchPods?.find((pod) => pod.id === 'pod-systems')?.assignmentId).toBe(next.player.researchPrograms?.[0]?.id)
    const duplicate = startResearchProgram(next, 'sys_quant', 'pod-systems', 0.3)
    expect(duplicate.player.researchPrograms).toHaveLength(1)
  })

  it('progresses through evidence and integration before unlocking', () => {
    let state = startResearchProgram(createGame(602), 'sys_batching', 'pod-systems', 0.8)
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
    let state = createGame(603)
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
      'opt_mixed',
      'opt_torch_compile',
    ])
  })
})
