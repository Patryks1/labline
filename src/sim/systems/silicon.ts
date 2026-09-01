import { ECONOMY } from '../balance/economy'
import { getChipDef, registerCustomChip } from '../balance/chips'
import { aggregateEffects } from './research'
import type {
  ChipDesignFocus,
  ChipDesignTechId,
  FabPhase,
  SimState,
} from '../types'
import { createRng } from '../rng'
import { facilityAnchorTiles } from './worldAccess'

const PHASE_ORDER: FabPhase[] = [
  'idle',
  'architecture',
  'tapeout',
  'fab_queue',
  'yield_ramp',
  'volume',
]

export const CHIP_DESIGN_AREA_BUDGET = 8

export type ChipDesignTech = {
  id: ChipDesignTechId
  name: string
  description: string
  area: number
  requiredResearch: string
  training: number
  inference: number
  power: number
  yieldBonus?: number
}

export const CHIP_DESIGN_TECH: readonly ChipDesignTech[] = [
  {
    id: 'matrix_array',
    name: 'Tensor matrix array',
    description: 'Large dense math blocks for pretraining throughput.',
    area: 2,
    requiredResearch: 'si_arch',
    training: 0.24,
    inference: 0.06,
    power: 0.05,
  },
  {
    id: 'hbm_fabric',
    name: 'HBM fabric',
    description: 'Feeds large batches and long contexts without starving compute.',
    area: 3,
    requiredResearch: 'si_hbm_stack',
    training: 0.18,
    inference: 0.12,
    power: 0.04,
  },
  {
    id: 'kv_cache',
    name: 'On-die KV cache',
    description: 'Dedicated cache and decode engines raise tokens per second.',
    area: 2,
    requiredResearch: 'si_infer_asic',
    training: 0.02,
    inference: 0.34,
    power: -0.06,
  },
  {
    id: 'chiplet_mesh',
    name: 'Chiplet mesh',
    description: 'Modular tiles trade a little area for better manufacturing yield.',
    area: 3,
    requiredResearch: 'si_chiplets',
    training: 0.11,
    inference: 0.11,
    power: -0.03,
    yieldBonus: 0.09,
  },
  {
    id: 'optical_io',
    name: 'Optical scale-out',
    description: 'Photonic I/O improves pod scaling while lowering link power.',
    area: 3,
    requiredResearch: 'si_photonic_io',
    training: 0.17,
    inference: 0.15,
    power: -0.1,
  },
  {
    id: 'sparse_router',
    name: 'Sparse routing engine',
    description: 'Hardware routing and expert dispatch for MoE workloads.',
    area: 2,
    requiredResearch: 'si_moe_npu',
    training: 0.08,
    inference: 0.24,
    power: -0.03,
  },
]

export type ChipDesignScore = {
  focus: ChipDesignFocus
  usedArea: number
  trainingMult: number
  inferenceMult: number
  powerMult: number
  perfPerWattMult: number
  yieldBonus: number
}

export function scoreChipDesign(
  focus: ChipDesignFocus = 'balanced',
  techIds: readonly ChipDesignTechId[] = [],
): ChipDesignScore {
  let trainingMult = focus === 'training' ? 1.22 : focus === 'inference' ? 0.9 : 1
  let inferenceMult = focus === 'inference' ? 1.32 : focus === 'training' ? 0.88 : 1
  let powerMult = focus === 'inference' ? 0.94 : focus === 'training' ? 1.06 : 1
  let usedArea = 0
  let yieldBonus = 0
  const selected = new Set(techIds)
  for (const tech of CHIP_DESIGN_TECH) {
    if (!selected.has(tech.id)) continue
    usedArea += tech.area
    trainingMult += tech.training
    inferenceMult += tech.inference
    powerMult += tech.power
    yieldBonus += tech.yieldBonus ?? 0
  }
  powerMult = Math.max(0.7, powerMult)
  const throughputMean = (trainingMult + inferenceMult) / 2
  return {
    focus,
    usedArea,
    trainingMult,
    inferenceMult,
    powerMult,
    perfPerWattMult: throughputMean / powerMult,
    yieldBonus,
  }
}

function fabDesignEditable(state: SimState): boolean {
  return state.player.fab.phase === 'idle' || state.player.fab.phase === 'volume'
}

export function setChipDesignFocus(state: SimState, focus: ChipDesignFocus): SimState {
  if (!fabDesignEditable(state)) return state
  return {
    ...state,
    player: { ...state.player, fab: { ...state.player.fab, designFocus: focus } },
  }
}

export function toggleChipDesignTech(state: SimState, techId: ChipDesignTechId): SimState {
  if (!fabDesignEditable(state)) return state
  const tech = CHIP_DESIGN_TECH.find((candidate) => candidate.id === techId)
  if (!tech || !state.player.researchUnlocked.includes(tech.requiredResearch)) return state
  const selected = new Set(state.player.fab.designTechIds ?? [])
  if (selected.has(techId)) selected.delete(techId)
  else {
    const nextArea = scoreChipDesign(
      state.player.fab.designFocus ?? 'balanced',
      [...selected, techId],
    ).usedArea
    if (nextArea > CHIP_DESIGN_AREA_BUDGET) return state
    selected.add(techId)
  }
  return {
    ...state,
    player: {
      ...state.player,
      fab: { ...state.player.fab, designTechIds: [...selected] },
    },
  }
}

export function canStartFab(state: SimState): { ok: boolean; reason?: string } {
  if (!state.player.researchUnlocked.includes('si_arch')) {
    return { ok: false, reason: 'Unlock Accelerator Architecture first.' }
  }
  if (state.player.fab.phase !== 'idle' && state.player.fab.phase !== 'volume') {
    return { ok: false, reason: 'Fab project already running.' }
  }
  const hasFabTile = facilityAnchorTiles(state, { ownerId: 'player' }).some(
    (t) => t.kind === 'fab' && t.buildingProgress >= t.buildingTarget,
  )
  if (!hasFabTile) {
    return { ok: false, reason: 'Build and complete a Fab tile on the map.' }
  }
  const cost = ECONOMY.fabPhases.architecture.cash
  if (state.player.cash < cost) {
    return { ok: false, reason: `Need $${(cost / 1e6).toFixed(0)}M to start architecture.` }
  }
  return { ok: true }
}

export function startFabCampaign(state: SimState): SimState {
  const check = canStartFab(state)
  if (!check.ok) {
    return {
      ...state,
      alerts: [
        {
          id: `fab-block-${state.day}`,
          day: state.day,
          severity: 'warn' as const,
          message: check.reason ?? 'Cannot start fab',
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  const effects = aggregateEffects(state.player.researchUnlocked, state.player.researchRanks)
  const speed = 1 + (effects.fabSpeed ?? 0)
  const phase = ECONOMY.fabPhases.architecture
  const days = Math.max(8, Math.round(phase.days / speed))
  const focus = state.player.fab.designFocus ?? 'balanced'
  const designTechIds = state.player.fab.designTechIds ?? []
  const design = scoreChipDesign(focus, designTechIds)

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - phase.cash,
      fab: {
        phase: 'architecture',
        daysInPhase: 0,
        daysRequired: days,
        cashSunk: phase.cash,
        yieldRate: 0.35,
        designPerfPerWatt:
          (2.2 +
            state.player.talent * 0.08 +
            (state.player.staff?.engineer ?? 0) * 0.08) *
          design.perfPerWattMult,
        chipsProduced: 0,
        failed: false,
        designFocus: focus,
        designTechIds: [...designTechIds],
      },
    },
    news: [`Day ${state.day}: Custom silicon architecture kicked off.`, ...state.news].slice(0, 20),
    alerts: [
      {
        id: `fab-start-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Fab campaign started — architecture phase (${days}d, $${(phase.cash / 1e6).toFixed(0)}M).`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function advancePhase(state: SimState, next: FabPhase): SimState {
  if (next === 'volume') {
    return completeFab(state)
  }
  const key = next as keyof typeof ECONOMY.fabPhases
  const phase = ECONOMY.fabPhases[key]
  const effects = aggregateEffects(state.player.researchUnlocked, state.player.researchRanks)
  const speed = 1 + (effects.fabSpeed ?? 0)
  const days = Math.max(6, Math.round(phase.days / speed))
  if (state.player.cash < phase.cash) {
    return {
      ...state,
      player: {
        ...state.player,
        fab: { ...state.player.fab, failed: true, phase: 'idle' },
      },
      alerts: [
        {
          id: `fab-cash-${state.day}`,
          day: state.day,
          severity: 'danger' as const,
          message: `Fab stalled — need $${(phase.cash / 1e6).toFixed(0)}M for ${next}. Project reset.`,
        },
        ...state.alerts,
      ].slice(0, 40),
    }
  }

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - phase.cash,
      fab: {
        ...state.player.fab,
        phase: next,
        daysInPhase: 0,
        daysRequired: days,
        cashSunk: state.player.fab.cashSunk + phase.cash,
      },
    },
    news: [`Day ${state.day}: Fab entered ${next.replace('_', ' ')}.`, ...state.news].slice(0, 20),
  }
}

function completeFab(state: SimState): SimState {
  const fab = state.player.fab
  const design = scoreChipDesign(
    fab.designFocus ?? 'balanced',
    fab.designTechIds ?? [],
  )
  const gen = state.player.researchUnlocked.includes('si_moe_npu') ? 2 : 1
  const base = getChipDef(gen === 2 ? 'custom_v2' : 'custom_v1')
  const id = `custom_run_${state.day}`
  const def = {
    ...base,
    id,
    name: `Labline L${gen} ${design.focus} · run ${state.day}`,
    perfPerWatt: fab.designPerfPerWatt,
    flopsPf:
      base.flopsPf * (0.9 + Math.min(0.98, fab.yieldRate + design.yieldBonus) * 0.3) *
      design.trainingMult,
    mwPerChip: base.mwPerChip * (1.1 - fab.yieldRate * 0.15) * design.powerMult,
    tokPerSec: Math.round(
      base.tokPerSec * (0.95 + fab.yieldRate * 0.25) * design.inferenceMult,
    ),
    custom: true as const,
    moeBoost: (base.moeBoost ?? 1) *
      ((fab.designTechIds ?? []).includes('sparse_router') ? 1.2 : 1),
  }
  registerCustomChip(def)

  const batch = Math.floor(48 + Math.min(0.98, fab.yieldRate + design.yieldBonus) * 80)
  const chips = state.player.chips.map((c) => ({ ...c, arriving: [...c.arriving] }))
  chips.push({ defId: id, count: batch, arriving: [] })

  return {
    ...state,
    player: {
      ...state.player,
      chips,
      fab: {
        ...fab,
        phase: 'volume',
        daysInPhase: 0,
        daysRequired: 0,
        chipsProduced: fab.chipsProduced + batch,
      },
      brandTrust: Math.min(100, state.player.brandTrust + 6),
    },
    news: [
      `Day ${state.day}: Custom silicon online — ${batch}× ${def.name}.`,
      ...state.news,
    ].slice(0, 20),
    alerts: [
      {
        id: `fab-done-${state.day}`,
        day: state.day,
        severity: 'info' as const,
        message: `Fab yield ${(fab.yieldRate * 100).toFixed(0)}% — ${batch} custom chips online.`,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

export function tickFab(state: SimState): SimState {
  const fab = state.player.fab
  if (fab.phase === 'idle' || fab.phase === 'volume' || fab.failed) {
    // volume: small ongoing production if fab tile exists
    if (fab.phase === 'volume' && state.day % 14 === 0) {
      const custom = state.player.chips.find((c) => getChipDef(c.defId).custom)
      if (custom) {
        const chips = state.player.chips.map((c) =>
          c.defId === custom.defId ? { ...c, count: c.count + 8 } : c,
        )
        return {
          ...state,
          player: {
            ...state.player,
            chips,
            fab: { ...fab, chipsProduced: fab.chipsProduced + 8 },
          },
        }
      }
    }
    return state
  }

  const rng = createRng(state.seed + state.day * 31 + 7)
  let next = {
    ...fab,
    daysInPhase: fab.daysInPhase + 1,
  }

  // risk events
  if (fab.phase === 'tapeout' && next.daysInPhase === Math.floor(fab.daysRequired / 2)) {
    if (rng.next() < 0.12 && !state.player.researchUnlocked.includes('si_fab_ops')) {
      next.daysRequired += 10
      return {
        ...state,
        player: { ...state.player, fab: next },
        alerts: [
          {
            id: `fab-delay-${state.day}`,
            day: state.day,
            severity: 'warn' as const,
            message: 'Tape-out delay — mask re-spin (+10 days).',
          },
          ...state.alerts,
        ].slice(0, 40),
      }
    }
  }

  if (fab.phase === 'yield_ramp') {
    next.yieldRate = Math.min(0.92, next.yieldRate + 0.02 + rng.range(0, 0.02))
  }

  if (next.daysInPhase >= next.daysRequired) {
    const idx = PHASE_ORDER.indexOf(fab.phase)
    const following = PHASE_ORDER[idx + 1] ?? 'volume'
    return advancePhase({ ...state, player: { ...state.player, fab: next } }, following)
  }

  return { ...state, player: { ...state.player, fab: next } }
}

export function fabPhaseLabel(phase: FabPhase): string {
  switch (phase) {
    case 'idle':
      return 'No project'
    case 'architecture':
      return 'Architecture'
    case 'tapeout':
      return 'Tape-out'
    case 'fab_queue':
      return 'Fab queue'
    case 'yield_ramp':
      return 'Yield ramp'
    case 'volume':
      return 'Volume production'
  }
}
