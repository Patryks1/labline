import { getResearchNode, researchBranchForNode } from '../balance/research'
import type { ResearchEvidence, ResearchProgram, SimState } from '../types'
import { computeSnapshot } from './compute'
import { planResearchPath } from './research'

function withAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      { id: `research-program-${state.day}-${message}`, day: state.day, severity, message },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function startResearchProgram(
  state: SimState,
  methodId: string,
  podId: string,
  computeShare = 0.25,
): SimState {
  let method
  try {
    method = getResearchNode(methodId)
  } catch {
    return withAlert(state, 'warn', 'Unknown research method.')
  }
  if (state.player.researchUnlocked.includes(methodId)) {
    return withAlert(state, 'warn', `${method.name} is already integrated.`)
  }
  if ((state.player.researchPrograms ?? []).some((program) => program.methodId === methodId && program.phase !== 'complete')) {
    return withAlert(state, 'warn', `${method.name} already has an active program.`)
  }
  const pod = (state.player.researchPods ?? []).find((candidate) => candidate.id === podId)
  if (!pod) return withAlert(state, 'warn', 'Research pod not found.')
  if (pod.assignmentId) return withAlert(state, 'warn', `${pod.name} already has an assignment.`)
  const lead = (state.player.researchLeads ?? []).find((candidate) => candidate.id === pod.leadId)
  if (!lead) return withAlert(state, 'warn', `${pod.name} needs a named lead.`)
  const missing = method.prereqs.filter((id) => !state.player.researchUnlocked.includes(id))
  if (missing.length > 0) return withAlert(state, 'warn', `Missing prerequisite: ${getResearchNode(missing[0]!).name}.`)

  const program: ResearchProgram = {
    id: `program-${methodId}-${state.day}`,
    methodId,
    podId,
    phase: 'hypothesis',
    evidence: [],
    insightProgress: 0,
    engineeringProgress: 0,
    computeShare: Math.max(0.05, Math.min(0.8, computeShare)),
    disclosure: 'secret',
  }
  return {
    ...state,
    player: {
      ...state.player,
      researchPrograms: [...(state.player.researchPrograms ?? []), program],
      researchPods: (state.player.researchPods ?? []).map((candidate) =>
        candidate.id === podId ? { ...candidate, assignmentId: program.id } : candidate,
      ),
    },
    news: [
      `Day ${state.day}: ${lead.name} opens ${method.name} in ${pod.name} (${researchBranchForNode(methodId)}).`,
      ...state.news,
    ].slice(0, 64),
  }
}

export function queueResearchProgram(state: SimState, methodId: string): SimState {
  let method
  try {
    method = getResearchNode(methodId)
  } catch {
    return withAlert(state, 'warn', 'Unknown research method.')
  }
  if (state.player.researchUnlocked.includes(methodId)) return state
  const programQueue = state.player.researchProgramQueue ?? []
  if (programQueue.includes(methodId)) return state
  const activeMethods = (state.player.researchPrograms ?? [])
    .filter((program) => program.phase !== 'complete')
    .map((program) => program.methodId)
  if (activeMethods.includes(methodId)) return state
  const path = planResearchPath(
    state.player.researchUnlocked,
    [...activeMethods, ...programQueue],
    methodId,
  )
  if (path.reason) return withAlert(state, 'warn', path.reason)
  if (programQueue.length + path.nodeIds.length > 12) {
    return withAlert(
      state,
      'warn',
      `Research path needs ${path.nodeIds.length} queue slots (12 max).`,
    )
  }
  return {
    ...state,
    player: {
      ...state.player,
      researchProgramQueue: [...programQueue, ...path.nodeIds],
    },
    alerts:
      path.nodeIds.length > 1
        ? [
            {
              id: `research-path-${state.day}-${methodId}`,
              day: state.day,
              severity: 'info' as const,
              message: `Queued ${path.nodeIds.length}-method path to ${method.name}.`,
            },
            ...state.alerts,
          ].slice(0, 40)
        : state.alerts,
  }
}

export function dequeueResearchProgram(state: SimState, methodId: string): SimState {
  return {
    ...state,
    player: {
      ...state.player,
      researchProgramQueue: (state.player.researchProgramQueue ?? []).filter(
        (candidate) => candidate !== methodId,
      ),
    },
  }
}

function assignQueuedPrograms(state: SimState): SimState {
  let next = state
  let changed = false
  while (true) {
    const pod = (next.player.researchPods ?? []).find((candidate) => !candidate.assignmentId)
    if (!pod) break
    const methodId = (next.player.researchProgramQueue ?? []).find((candidate) => {
      const method = getResearchNode(candidate)
      return method.prereqs.every((prerequisite) => next.player.researchUnlocked.includes(prerequisite))
    })
    if (!methodId) break
    const before = (next.player.researchPrograms ?? []).length
    next = startResearchProgram(next, methodId, pod.id)
    if ((next.player.researchPrograms ?? []).length === before) break
    next = {
      ...next,
      player: {
        ...next.player,
        researchProgramQueue: (next.player.researchProgramQueue ?? []).filter((candidate) => candidate !== methodId),
      },
    }
    changed = true
  }
  return changed ? next : state
}

function addEvidence(
  evidence: ResearchEvidence[],
  program: ResearchProgram,
  day: number,
  source: ResearchEvidence['source'],
  strength: number,
): ResearchEvidence[] {
  if (evidence.some((item) => item.source === source)) return evidence
  return [
    ...evidence,
    {
      id: `evidence-${program.id}-${source}`,
      strength,
      source,
      day,
    },
  ]
}

export function tickResearchPrograms(state: SimState): SimState {
  const scheduled = assignQueuedPrograms(state)
  if (scheduled !== state) return tickResearchPrograms(scheduled)
  const active = (state.player.researchPrograms ?? []).filter((program) => program.phase !== 'complete')
  if (active.length === 0) return state
  const snapshot = computeSnapshot(state)
  let cash = state.player.cash
  let unlocked = [...state.player.researchUnlocked]
  let pods = [...(state.player.researchPods ?? [])]
  const completed: string[] = []
  const programs = (state.player.researchPrograms ?? []).map((program): ResearchProgram => {
    if (program.phase === 'complete') return program
    const pod = pods.find((candidate) => candidate.id === program.podId)
    const lead = (state.player.researchLeads ?? []).find((candidate) => candidate.id === pod?.leadId)
    if (!pod || !lead) return program
    const method = getResearchNode(program.methodId)
    const headcount = pod.researchers + pod.engineers + pod.dataStaff
    const coordinationCap = 3 + lead.skills.leadership * 8
    const coordination = Math.min(1, coordinationCap / Math.max(1, headcount))
    const leadSkill =
      lead.skills.algorithms * 0.35 +
      lead.skills.systems * 0.25 +
      lead.skills.dataEvals * 0.2 +
      lead.skills.leadership * 0.2
    const compute = snapshot.pools.research * program.computeShare / Math.max(1, active.length)
    const insightStep =
      (0.0035 + compute / Math.max(8, method.costPfDays) * 0.065) *
      (0.55 + leadSkill * 0.65) *
      coordination
    const engineeringStep =
      (0.002 + compute / Math.max(8, method.costPfDays) * 0.045) *
      (0.5 + lead.skills.systems * 0.5) *
      (0.6 + Math.min(1, pod.engineers / 3) * 0.4)
    const burn = Math.min(cash, compute * 2_800 + headcount * 350)
    cash -= burn
    let insightProgress = Math.min(1, program.insightProgress + insightStep)
    let engineeringProgress = program.engineeringProgress
    let phase: ResearchProgram['phase'] = program.phase
    let evidence = program.evidence

    if (phase === 'hypothesis' && insightProgress >= 0.22) phase = 'pilot'
    if (phase === 'pilot' && insightProgress >= 0.43) {
      evidence = addEvidence(evidence, program, state.day, 'pilot', 0.45 + leadSkill * 0.3)
      phase = 'validation'
    }
    if (phase === 'validation' && insightProgress >= 0.68 && evidence.length > 0) {
      evidence = addEvidence(evidence, program, state.day, 'training', 0.5 + leadSkill * 0.35)
      phase = 'integration'
    }
    if (phase === 'integration') {
      engineeringProgress = Math.min(1, engineeringProgress + engineeringStep)
      if (engineeringProgress >= 1 && evidence.length >= 2) {
        phase = 'complete'
        if (!unlocked.includes(program.methodId)) unlocked.push(program.methodId)
        pods = pods.map((candidate) =>
          candidate.id === pod.id ? { ...candidate, assignmentId: null } : candidate,
        )
        completed.push(method.name)
      }
    }
    return { ...program, phase, evidence, insightProgress, engineeringProgress }
  })

  let next: SimState = {
    ...state,
    player: {
      ...state.player,
      cash,
      researchPrograms: programs,
      researchPods: pods,
      researchUnlocked: unlocked,
      researchCashBurnToday: (state.player.researchCashBurnToday ?? 0) + (state.player.cash - cash),
    },
  }
  for (const name of completed) next = withAlert(next, 'info', `${name} integrated. Choose secrecy, publication, or licensing.`)
  return next
}

export function publishMethod(state: SimState, programId: string): SimState {
  const program = (state.player.researchPrograms ?? []).find((item) => item.id === programId)
  if (!program || program.phase !== 'complete') return withAlert(state, 'warn', 'Only completed methods can be published.')
  if (program.disclosure === 'published') return state
  return {
    ...state,
    player: {
      ...state.player,
      brandTrust: Math.min(100, state.player.brandTrust + 2.5),
      researchPrograms: (state.player.researchPrograms ?? []).map((item) =>
        item.id === programId ? { ...item, disclosure: 'published' as const } : item,
      ),
      researchLeads: (state.player.researchLeads ?? []).map((lead) => {
        const pod = (state.player.researchPods ?? []).find((item) => item.id === program.podId)
        return lead.id === pod?.leadId ? { ...lead, reputation: Math.min(100, lead.reputation + 4) } : lead
      }),
    },
    news: [`Day ${state.day}: Published ${getResearchNode(program.methodId).name}; recruiting reputation rises and rival diffusion begins.`, ...state.news].slice(0, 64),
  }
}

export function licenseMethod(state: SimState, programId: string): SimState {
  const program = (state.player.researchPrograms ?? []).find((item) => item.id === programId)
  if (!program || program.phase !== 'complete') return withAlert(state, 'warn', 'Only completed methods can be licensed.')
  if (program.disclosure === 'licensed') return state
  const method = getResearchNode(program.methodId)
  const revenue = Math.round(1_000_000 + method.costPfDays * 85_000)
  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash + revenue,
      researchPrograms: (state.player.researchPrograms ?? []).map((item) =>
        item.id === programId ? { ...item, disclosure: 'licensed' as const } : item,
      ),
    },
    news: [`Day ${state.day}: Licensed ${method.name} for $${(revenue / 1_000_000).toFixed(1)}M. Rival labs can still unlock it, but workaround and negotiation raise their research requirement by 45%.`, ...state.news].slice(0, 64),
  }
}
