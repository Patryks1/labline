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
  assignedResearchPrograms,
  dequeueResearchProgram,
  researchPodStaffAvailability,
  openResearchPod,
  publishMethod,
  queueResearchProgram,
  researchProgramBlockReason,
  setActiveResearchProgram,
  setResearchPodStaff,
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

function withOpenedPod(
  state: SimState,
  templateId: string,
  unlock: string[] = [],
): SimState {
  return openResearchPod(
    {
      ...state,
      player: {
        ...state.player,
        cash: Math.max(state.player.cash, 10_000_000),
        researchUnlocked: [
          ...new Set([...(state.player.researchUnlocked ?? []), ...unlock]),
        ],
      },
    },
    templateId,
  )
}

function withFoundationsRoster(
  state: SimState,
  researchers: number,
  engineers: number,
  dataStaff: number,
): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      researchPods: (state.player.researchPods ?? []).map((pod) =>
        pod.id === 'pod-foundations'
          ? { ...pod, researchers, engineers, dataStaff }
          : pod,
      ),
    },
  }
}

/** Live freeze: Foundations already in pilot, then the card shows 4/2/3. */
function inFlightFoundationsPilot(seed: number): SimState {
  let state = startResearchProgram(
    staffed(createGame(seed), 4, 2, 3),
    'opt_fp16',
    'pod-foundations',
    0.25,
  )
  const started = state.player.researchPrograms?.find(
    (program) => program.methodId === 'opt_fp16',
  )
  if (!started) {
    throw new Error(state.alerts[0]?.message ?? 'opt_fp16 did not start')
  }
  for (let day = 0; day < 40; day++) {
    state = tickResearchPrograms({ ...state, day: state.day + 1 })
    const program = state.player.researchPrograms?.find(
      (item) => item.methodId === 'opt_fp16' && item.phase !== 'complete',
    )
    if (program?.phase === 'pilot') {
      return withFoundationsRoster(state, 4, 2, 3)
    }
  }
  throw new Error('opt_fp16 never reached pilot')
}

describe('research programs and pods', () => {
  it('manually reserves and releases pod staff without over-allocating the HQ team', () => {
    const state = withOpenedPod(
      staffed(createGame(600), 2, 1, 1),
      'pod-systems',
      ['org_talent'],
    )
    const assigned = setResearchPodStaff(state, 'pod-systems', 'researchers', 2)
    expect(assigned.player.researchPods?.find((pod) => pod.id === 'pod-systems')?.researchers).toBe(2)
    expect(researchPodStaffAvailability(assigned, 'pod-foundations').available).toMatchObject({
      researchers: 0,
      engineers: 1,
      dataStaff: 1,
    })

    const overAllocated = setResearchPodStaff(assigned, 'pod-foundations', 'researchers', 1)
    expect(overAllocated.player.researchPods?.find((pod) => pod.id === 'pod-foundations')?.researchers).toBe(0)
    expect(overAllocated.alerts[0]?.message).toContain('No researchers available')

    const released = setResearchPodStaff(assigned, 'pod-systems', 'researchers', -2)
    expect(released.player.researchPods?.find((pod) => pod.id === 'pod-systems')?.researchers).toBe(0)
    expect(researchPodStaffAvailability(released).available.researchers).toBe(2)
  })

  it('treats selected-pod availability as an absolute cap instead of adding assigned staff twice', () => {
    const state = staffed(createGame(610), 2, 1, 1)
    const first = setResearchPodStaff(state, 'pod-foundations', 'researchers', 1)
    const capped = setResearchPodStaff(first, 'pod-foundations', 'researchers', 99)
    expect(capped.player.researchPods?.find((pod) => pod.id === 'pod-foundations')?.researchers).toBe(2)
    const blocked = setResearchPodStaff(capped, 'pod-foundations', 'researchers', 1)
    expect(blocked.alerts[0]?.message).toContain('No researchers available')
  })

  it('starts with Foundations only and locks later pods behind research', () => {
    const state = createGame(612)
    expect(state.player.researchPods?.map((pod) => pod.id)).toEqual([
      'pod-foundations',
    ])
    expect(openResearchPod(state, 'pod-systems').player.researchPods).toHaveLength(1)
    expect(openResearchPod(state, 'pod-systems').alerts[0]?.message).toContain(
      'Research Culture',
    )

    const systems = withOpenedPod(state, 'pod-systems', ['org_talent'])
    expect(systems.player.researchPods?.map((pod) => pod.id)).toEqual([
      'pod-foundations',
      'pod-systems',
    ])
    expect(openResearchPod(systems, 'pod-applied').player.researchPods).toHaveLength(2)
    expect(openResearchPod(systems, 'pod-applied').alerts[0]?.message).toContain(
      'Lab Structure',
    )

    const applied = withOpenedPod(systems, 'pod-applied', ['org_labs'])
    expect(applied.player.researchPods).toHaveLength(3)
    expect(openResearchPod(applied, 'pod-evals').player.researchPods).toHaveLength(3)
    expect(openResearchPod(applied, 'pod-evals').alerts[0]?.message).toContain(
      getResearchNode('data_clean').name,
    )
  })

  it('opens additional named pods without manufacturing HQ staff', () => {
    const state = staffed(createGame(611), 2, 1, 1)
    const opened = withOpenedPod(state, 'pod-applied', ['org_labs'])
    expect(opened.player.cash).toBe(state.player.cash - 750_000)
    expect(opened.player.researchPods?.find((pod) => pod.id === 'pod-applied')).toMatchObject({
      researchers: 0,
      engineers: 0,
      dataStaff: 0,
      leadId: 'lead-ada-okafor',
    })
    expect(opened.player.researchLeads?.some((lead) => lead.id === 'lead-ada-okafor')).toBe(true)
    expect(researchPodStaffAvailability(opened).employed).toEqual({
      researchers: 2,
      engineers: 1,
      dataStaff: 1,
    })
  })

  it('does not release a role below an active program minimum', () => {
    const state = withOpenedPod(
      staffed(createGame(599), 2, 1, 1),
      'pod-systems',
      ['org_talent'],
    )
    const active = startResearchProgram(state, 'sys_batching', 'pod-systems', 0.3)
    const reduced = setResearchPodStaff(active, 'pod-systems', 'researchers', -2)
    expect(reduced.player.researchPods?.find((pod) => pod.id === 'pod-systems')?.researchers).toBe(1)
    expect(reduced.alerts[0]?.message).toContain('needs at least 1 researcher')
  })

  it('maps the existing method backbone into seven branches', () => {
    expect(Object.keys(RESEARCH_BRANCHES)).toHaveLength(7)
    expect(RESEARCH_NODES.every((node) => researchBranchForNode(node.id) in RESEARCH_BRANCHES)).toBe(true)
  })

  it('requires and reserves a named-lead pod', () => {
    const state = withOpenedPod(staffed(createGame(601)), 'pod-systems', ['org_talent'])
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
    const state = withOpenedPod(
      staffed(createGame(609), 1, 1, 1),
      'pod-systems',
      ['org_talent'],
    )
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
    let state = startResearchProgram(
      withOpenedPod(staffed(createGame(602)), 'pod-systems', ['org_talent']),
      'sys_batching',
      'pod-systems',
      0.8,
    )
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
    // A viable queue item is picked up immediately; its dependent remains queued.
    expect(state.player.researchPrograms?.some((program) => program.methodId === 'sys_batching')).toBe(true)
    expect(state.player.researchProgramQueue).toEqual(['sys_quant'])
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

  it('applies serving effects exactly once on PF-plus-calendar completion', () => {
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
    // V4-DELETE: training no longer lands on player.trainEfficiency.
    expect(completed.player.trainEfficiency).toBeCloseTo(trainingBefore)

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
      withOpenedPod(staffed(createGame(608)), 'pod-systems', ['org_talent']),
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

  it('runs two queued methods sequentially on the Foundations pod', () => {
    let state = staffed(createGame(620), 4, 2, 2)
    state = queueResearchProgram(state, 'sys_batching')
    state = queueResearchProgram(state, 'opt_checkpoint')
    expect(
      state.player.researchPrograms?.some(
        (program) =>
          program.methodId === 'sys_batching' && program.phase !== 'complete',
      ),
    ).toBe(true)
    expect(state.player.researchProgramQueue).toContain('opt_checkpoint')

    let sawHandoff = false
    for (let day = 0; day < 900; day++) {
      state = tickResearchPrograms({ ...state, day: state.day + 1 })
      const first = state.player.researchPrograms?.find(
        (program) => program.methodId === 'sys_batching',
      )
      const second = state.player.researchPrograms?.find(
        (program) => program.methodId === 'opt_checkpoint',
      )
      if (first?.phase === 'complete' && second && second.phase !== 'complete') {
        sawHandoff = true
        break
      }
    }

    expect(sawHandoff).toBe(true)
    expect(state.player.researchUnlocked).toContain('sys_batching')
    expect(state.player.researchUnlocked).not.toContain('opt_checkpoint')
    expect(
      state.player.researchPods?.find((pod) => pod.id === 'pod-foundations')
        ?.assignmentId,
    ).toBe(
      state.player.researchPrograms?.find(
        (program) => program.methodId === 'opt_checkpoint',
      )?.id,
    )
  })

  it('keeps an in-flight program ticking when a corpus audit also lists staff', () => {
    let state = startResearchProgram(
      staffed(createGame(621), 2, 2, 2),
      'sys_batching',
      'pod-foundations',
      0.8,
    )
    const before = state.player.researchPrograms![0]!
    state = {
      ...state,
      player: {
        ...state.player,
        data: {
          ...state.player.data,
          pruneQueue: [
            {
              id: 'audit-overlap',
              domain: 'chat',
              rawRemaining: 10,
              processedRemaining: 10,
              rawTotal: 10,
              processedTotal: 10,
              cashPerMTok: 1,
              pfDaysPerMTok: 0.1,
              researchersRequired: 2,
              engineersRequired: 2,
              researchShare: 0.08,
              qualityBefore: 40,
            },
          ],
        },
      },
    }

    const ticked = tickResearchPrograms({ ...state, day: state.day + 1 })
    expect(ticked.player.researchPrograms?.[0]?.progressPfDays).toBeGreaterThan(
      before.progressPfDays ?? 0,
    )
  })

  it('still advances tree research when synth and gyms reserve most of the pool', () => {
    let state = startResearchProgram(
      staffed(createGame(622), 4, 2, 2),
      'sys_batching',
      'pod-foundations',
      0.8,
    )
    const before = state.player.researchPrograms![0]!
    state = {
      ...state,
      player: {
        ...state.player,
        data: {
          ...state.player.data,
          synthQueue: [
            {
              id: 'synth-starve',
              domain: 'chat',
              modelId: 'teacher',
              modelName: 'Teacher',
              targetMTok: 0,
              progressMTok: 0,
              continuous: true,
              researchShare: 0.85,
              qualityTier: 'lq',
            },
          ],
        },
        postTrainGyms: (state.player.postTrainGyms ?? []).map((gym) =>
          gym.kind === 'code'
            ? {
                ...gym,
                tier: 1,
                assignedResearchers: 1,
                researchShare: 0.75,
              }
            : gym,
        ),
      },
    }

    const ticked = tickResearchPrograms({ ...state, day: state.day + 1 })
    expect(ticked.player.researchPrograms?.[0]?.progressPfDays).toBeGreaterThan(
      before.progressPfDays ?? 0,
    )
  })

  it('explains why a queued method cannot start with no researchers', () => {
    let state = createGame(623)
    state = {
      ...state,
      player: { ...state.player, cash: Math.max(state.player.cash, 10_000_000) },
    }
    state = queueResearchProgram(state, 'sys_batching')
    expect(state.player.researchPrograms ?? []).toHaveLength(0)
    expect(state.player.researchProgramQueue).toContain('sys_batching')
    expect(state.alerts[0]?.message).toMatch(/researcher/i)
  })

  it('keeps an in-flight Foundations pilot ticking after HQ drops below the pod roster', () => {
    let state = inFlightFoundationsPilot(624)
    const program = state.player.researchPrograms!.find(
      (item) => item.methodId === 'opt_fp16',
    )!
    expect(program.phase).toBe('pilot')
    expect(program.insightProgress).toBeGreaterThan(0.22)
    expect(
      state.player.researchPods?.find((pod) => pod.id === 'pod-foundations'),
    ).toMatchObject({ researchers: 4, engineers: 2, dataStaff: 3 })

    state = staffed(state, 3, 2, 3)
    expect(researchProgramBlockReason(state, program)).toBeUndefined()

    const ticked = tickResearchPrograms({ ...state, day: state.day + 1 })
    const next = ticked.player.researchPrograms!.find(
      (item) => item.methodId === 'opt_fp16',
    )!
    expect(next.progressPfDays).toBeGreaterThan(program.progressPfDays ?? 0)
    expect(next.insightProgress).toBeGreaterThan(program.insightProgress)
    expect(
      ticked.player.researchPods?.find((pod) => pod.id === 'pod-foundations')
        ?.researchers,
    ).toBe(3)
  })

  it('surfaces a pod block when an in-flight pilot no longer has HQ staff', () => {
    let state = inFlightFoundationsPilot(625)
    const program = state.player.researchPrograms!.find(
      (item) => item.methodId === 'opt_fp16',
    )!
    state = staffed(state, 0, 2, 3)
    const before = program.progressPfDays ?? 0
    expect(researchProgramBlockReason(state, program)).toMatch(
      /needs 1\/1\/1 HQ staff \(working 0\/2\/3\)/i,
    )

    const ticked = tickResearchPrograms({ ...state, day: state.day + 1 })
    expect(ticked.player.researchPrograms![0]?.progressPfDays ?? 0).toBe(before)
    expect(ticked.player.researchPrograms![0]?.phase).toBe('pilot')
  })

  it('skips a blocked in-flight method and starts the next eligible queued method', () => {
    let state = staffed(createGame(640), 6, 4, 4)
    state = withFoundationsRoster(state, 6, 4, 4)
    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...new Set([
            ...state.player.researchUnlocked,
            'data_synth',
            'data_eval',
          ]),
        ],
      },
    }
    const blocked: NonNullable<SimState['player']['researchPrograms']>[number] = {
      id: 'program-data_self_train-stuck',
      methodId: 'data_self_train',
      podId: 'pod-foundations',
      phase: 'hypothesis',
      evidence: [],
      insightProgress: 0,
      engineeringProgress: 0,
      progressPfDays: 0,
      daysSpent: 0,
      effectsApplied: false,
      computeShare: 0.25,
      disclosure: 'secret',
    }
    state = {
      ...state,
      player: {
        ...state.player,
        researchPrograms: [blocked],
        researchProgramQueue: ['sys_batching'],
        researchPods: (state.player.researchPods ?? []).map((pod) =>
          pod.id === 'pod-foundations'
            ? { ...pod, assignmentId: blocked.id }
            : pod,
        ),
      },
    }

    const ticked = tickResearchPrograms({ ...state, day: state.day + 1 })
    const active = assignedResearchPrograms(ticked)
    expect(active).toHaveLength(1)
    expect(active[0]?.methodId).toBe('sys_batching')
    expect(ticked.player.researchProgramQueue).toContain('data_self_train')
    expect(ticked.player.researchProgramQueue).not.toContain('sys_batching')
    expect(
      ticked.player.researchPods?.find((pod) => pod.id === 'pod-foundations')
        ?.assignmentId,
    ).toBe(active[0]?.id)
    expect(
      ticked.player.researchPrograms?.some(
        (program) =>
          program.methodId === 'data_self_train' && program.phase !== 'complete',
      ),
    ).toBe(true)
  })

  it('does not start Self-Training Loops on a 6/4/4 HQ roster', () => {
    let state = staffed(createGame(641), 6, 4, 4)
    state = withFoundationsRoster(state, 6, 4, 4)
    state = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [
          ...new Set([
            ...state.player.researchUnlocked,
            'data_synth',
            'data_eval',
          ]),
        ],
      },
    }
    state = queueResearchProgram(state, 'data_self_train')
    state = queueResearchProgram(state, 'sys_batching')
    expect(assignedResearchPrograms(state).map((program) => program.methodId)).toEqual([
      'sys_batching',
    ])
    expect(state.player.researchProgramQueue).toContain('data_self_train')
  })

  it('unqueues the active method and starts the next available queued method', () => {
    let state = staffed(createGame(642), 6, 4, 4)
    state = queueResearchProgram(state, 'sys_batching')
    state = queueResearchProgram(state, 'opt_checkpoint')
    expect(assignedResearchPrograms(state)[0]?.methodId).toBe('sys_batching')
    expect(state.player.researchProgramQueue).toContain('opt_checkpoint')

    const next = dequeueResearchProgram(state, 'sys_batching')
    expect(assignedResearchPrograms(next)[0]?.methodId).toBe('opt_checkpoint')
    expect(next.player.researchProgramQueue).not.toContain('sys_batching')
    expect(
      next.player.researchPrograms?.some(
        (program) => program.methodId === 'sys_batching' && program.phase !== 'complete',
      ),
    ).toBe(false)
    expect(
      next.player.researchPods?.find((pod) => pod.id === 'pod-foundations')
        ?.assignmentId,
    ).toBe(assignedResearchPrograms(next)[0]?.id)
  })

  it('sets a specific queued method as the active research', () => {
    let state = staffed(createGame(643), 6, 4, 4)
    state = queueResearchProgram(state, 'sys_batching')
    state = queueResearchProgram(state, 'opt_checkpoint')
    const switched = setActiveResearchProgram(
      state,
      'opt_checkpoint',
      'pod-foundations',
    )
    expect(assignedResearchPrograms(switched)[0]?.methodId).toBe('opt_checkpoint')
    expect(switched.player.researchProgramQueue).toContain('sys_batching')
    expect(switched.player.researchProgramQueue).not.toContain('opt_checkpoint')
  })
})
