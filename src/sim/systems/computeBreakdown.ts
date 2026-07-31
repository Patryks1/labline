/**
 * Live breakdown of where Train / Serve / Research PF goes and how full each pool is.
 * Pure read of SimState + computeSnapshot — for HUD tooltips.
 */
import { ECONOMY } from '../balance/economy'
import {
  familyServeMult,
  inferenceCapacityMTok,
  pfPerMTokForModel,
  sizeTokMult,
} from '../balance/serveCompute'
import { formatParams } from '../balance/training'
import type { SimState } from '../types'
import { getResearchNode } from '../balance/research'
import { computeSnapshot, normalizeAllocation, type ComputeSnapshot } from './compute'
import { estimateResearchRate, researchPfTarget } from './research'
import { researchPoolForTech } from './data'
import { playerStaff } from './staff'
import { serveInfraCost } from '../balance/pricing'
import { energyPriceForState } from './map'

export type PoolId = 'training' | 'inference' | 'research'

export interface BreakdownLine {
  label: string
  value: string
  /** 0–1 fill bar when meaningful */
  bar?: number
  warn?: boolean
  muted?: boolean
}

export interface PoolBreakdown {
  id: PoolId
  title: string
  /** Effective PF in this pool today */
  poolPf: number
  /** Incremental physical fleet draw attributed to this pool. */
  powerMw: number
  /** Share of allocation (0–1) */
  allocShare: number
  /**
   * How hard the pool is working:
   * - serve: demand / capacity (can exceed 1)
   * - train: 1 if job running, 0 idle
   * - research: 1 if progressing, 0 stalled/idle
   */
  utilization: number
  utilizationLabel: string
  summary: string
  lines: BreakdownLine[]
}

export interface ComputeBreakdown {
  snap: ComputeSnapshot
  rawPf: number
  effectivePf: number
  /** Product of derates after util (power, racks, mem, …) — rough fleet tax */
  fleetYield: number
  train: PoolBreakdown
  serve: PoolBreakdown
  research: PoolBreakdown
}

function fmtPf(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 100) return n.toFixed(0)
  if (Math.abs(n) >= 10) return n.toFixed(1)
  if (Math.abs(n) >= 1) return n.toFixed(2)
  return n.toFixed(3)
}

function fmtMTok(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function pct01(n: number): string {
  return `${Math.round(Math.max(0, n) * 100)}%`
}

export function buildComputeBreakdown(state: SimState): ComputeBreakdown {
  const snap = computeSnapshot(state)
  const alloc = normalizeAllocation(state.player.allocation)
  const rawPf = snap.rawFlopsPf
  const effectivePf = snap.effectiveFlopsPf
  const fleetYield = rawPf > 1e-9 ? effectivePf / rawPf : 0

  const train = buildTrainBreakdown(state, snap, alloc.training)
  const serve = buildServeBreakdown(state, snap, alloc.inference)
  const research = buildResearchBreakdown(state, snap, alloc.research)

  return {
    snap,
    rawPf,
    effectivePf,
    fleetYield,
    train,
    serve,
    research,
  }
}

function buildTrainBreakdown(
  state: SimState,
  snap: ComputeSnapshot,
  allocShare: number,
): PoolBreakdown {
  const poolPf = snap.pools.training
  const powerMw = snap.mwBreakdown.training
  const listedJobs = state.player.trainingJobs ?? []
  const legacyJob = state.player.trainingJob
  const jobs = legacyJob
    ? [legacyJob, ...listedJobs.filter((entry) => entry.id !== legacyJob.id)]
    : listedJobs
  const activeJobs = jobs.filter((entry) => !entry.paused)
  const job = activeJobs[0] ?? legacyJob ?? listedJobs[0]
  const lines: BreakdownLine[] = [
    {
      label: 'Pool PF',
      value: `${fmtPf(poolPf)} PF`,
    },
    {
      label: 'Power draw',
      value: `${powerMw.toFixed(3)} MW`,
    },
    {
      label: 'Allocation',
      value: pct01(allocShare),
      bar: allocShare,
    },
    {
      label: 'Train efficiency',
      value: pct01(state.player.trainEfficiency),
    },
    {
      label: 'VRAM derate',
      value: pct01(snap.vramDerateTrain),
      warn: snap.vramDerateTrain < 0.9,
      bar: snap.vramDerateTrain,
    },
  ]

  let utilization = 0
  let utilizationLabel = 'Idle'
  let summary = 'No training job — train PF is idle.'

  if (activeJobs.length > 0 || state.player.safetyCampaign) {
    const totalRemaining = activeJobs.reduce(
      (sum, entry) => sum + Math.max(0, entry.targetPfDays - entry.progressPfDays),
      0,
    )
    const burn = poolPf
    const daysLeft = burn > 1e-6 ? totalRemaining / burn : Infinity
    utilization = 1
    utilizationLabel = activeJobs.length > 1 ? `${activeJobs.length} jobs` : 'In use'
    const headline = job
      ? `Training ${formatParams(job.targetParamsB)}`
      : 'Safety campaign running'
    summary =
      activeJobs.length > 1
        ? `${headline} · ${activeJobs.length} active jobs share the train pool.`
        : `${headline} · ${pct01(job ? job.progressPfDays / Math.max(1e-6, job.targetPfDays) : 0)} complete.`
    if (job) {
      lines.push(
        {
          label: activeJobs.length > 1 ? 'Lead job' : 'Job',
          value: `${job.mode ?? 'pretrain'} · ${formatParams(job.targetParamsB)}`,
        },
        {
          label: 'Progress',
          value: `${fmtPf(job.progressPfDays)} / ${fmtPf(job.targetPfDays)} PF·d`,
          bar: Math.min(1, job.progressPfDays / Math.max(1e-6, job.targetPfDays)),
        },
      )
    }
    if (activeJobs.length > 1) {
      lines.push({
        label: 'Active jobs',
        value: String(activeJobs.length),
      })
    }
    if (state.player.safetyCampaign) {
      lines.push({
        label: 'Safety campaign',
        value: state.player.safetyCampaign.modelId,
        muted: true,
      })
    }
    lines.push(
      {
        label: 'Burn today',
        value: `${fmtPf(burn)} PF (shared pool)`,
      },
      {
        label: 'ETA',
        value: Number.isFinite(daysLeft) ? `~${Math.ceil(daysLeft)}d` : '—',
      },
    )
  } else {
    lines.push({
      label: 'Status',
      value: 'Idle — start a train job in Lab → Models',
      muted: true,
    })
  }

  return {
    id: 'training',
    title: 'Train pool',
    poolPf,
    powerMw,
    allocShare,
    utilization,
    utilizationLabel,
    summary,
    lines,
  }
}

function buildServeBreakdown(
  state: SimState,
  snap: ComputeSnapshot,
  allocShare: number,
): PoolBreakdown {
  const poolPf = snap.pools.inference
  const powerMw = snap.mwBreakdown.inference
  const lm = state.lastMarket
  const model = state.player.models.find(
    (m) =>
      m.id === state.player.pricing.activeModelId &&
      (m.release === 'released' || m.shipped),
  )
  const liveCap =
    model != null
      ? inferenceCapacityMTok(snap, model, state.player.servingEfficiency, allocShare)
      : lm.capacityMTok ?? 0
  const demandM = lm.playerDemandMTok ?? 0
  const util = liveCap > 1e-9 ? demandM / liveCap : demandM > 0 ? 2 : 0
  const utilClamped = Math.min(1, util)

  const pfPer =
    model != null
      ? pfPerMTokForModel(model, state.player.servingEfficiency)
      : ECONOMY.pfPerMTokAt7B

  const apiDemand = lm.apiDemandMTok ?? 0
  const planDemand = Math.max(0, demandM - apiDemand)
  const apiPrio =
    lm.apiVsSubPriority ??
    state.player.pricing.apiVsSubPriority ??
    ECONOMY.defaultApiVsSubPriority
  const apiPoolM = liveCap * apiPrio
  const subPoolM = liveCap * (1 - apiPrio)

  let costPer = 0
  try {
    costPer = serveInfraCost(state, snap, energyPriceForState(state)).costPerMTok
  } catch {
    costPer = 0
  }

  const hwTps = snap.chipCount * snap.avgTokPerSecPerChip
  const lines: BreakdownLine[] = [
    {
      label: 'Token Cap',
      value: `${fmtMTok(liveCap)} MTok/d`,
    },
    {
      label: 'Power draw',
      value: `${powerMw.toFixed(3)} MW`,
    },
    {
      label: 'Demand / Cap',
      value: `${fmtMTok(demandM)} / ${fmtMTok(liveCap)} MTok`,
      bar: utilClamped,
      warn: util > 1.02,
    },
    {
      label: 'Pool utilization',
      value: pct01(util),
      bar: utilClamped,
      warn: util > 0.95,
    },
    {
      label: 'Served',
      value: `${fmtMTok(lm.servedMTok ?? 0)} MTok`,
      warn: (lm.unservedRatio ?? 0) > 0.08,
    },
    {
      label: 'API vs plans dem',
      value: `${fmtMTok(apiDemand)} · ${fmtMTok(planDemand)} MTok`,
    },
    {
      label: 'Token split API/subs',
      value: `${fmtMTok(apiPoolM)} / ${fmtMTok(subPoolM)}`,
    },
    {
      label: 'Hardware t/s',
      value: `${fmtPf(hwTps)} raw rack t/s`,
    },
    {
      label: 'Allocation',
      value: pct01(allocShare),
      bar: allocShare,
    },
    {
      label: 'Serve efficiency',
      value: pct01(state.player.servingEfficiency),
    },
    {
      label: 'Unit cost',
      value: costPer > 0 ? `$${costPer.toFixed(3)}/MTok` : '—',
    },
    {
      label: 'Pool PF (train unit)',
      value: `${fmtPf(poolPf)} PF`,
      muted: true,
    },
  ]

  if (model) {
    const active = model.activeParamsB ?? model.paramsB
    lines.push({
      label: 'Active model',
      value: `${model.name || 'Model'} · ${formatParams(model.paramsB)}${
        Math.abs(active - model.paramsB) > 0.01 ? ` (${formatParams(active)} act)` : ''
      }`,
    })
    lines.push({
      label: 'Size / family mult',
      value: `×${sizeTokMult(model).toFixed(2)} tok · fam ${familyServeMult(model.family)} · ${fmtPf(pfPer)} PF/MTok`,
    })
  } else {
    lines.push({
      label: 'Active model',
      value: 'None released — Cap is 0',
      warn: true,
      muted: true,
    })
  }

  if ((lm.unservedRatio ?? 0) > 0.01) {
    lines.push({
      label: 'Unserved',
      value: pct01(lm.unservedRatio ?? 0),
      warn: true,
      bar: Math.min(1, lm.unservedRatio ?? 0),
    })
  }

  const utilizationLabel =
    util > 1.05 ? 'Overloaded' : util > 0.85 ? 'Busy' : util > 0.15 ? 'Partial' : 'Idle'
  const summary =
    util > 1.05
      ? `Demand exceeds token Cap by ${pct01(util - 1)} — raise Serve %, racks, or ship a smaller model.`
      : util > 0.15
        ? `Serving uses ~${pct01(utilClamped)} of token Cap (racks × model).`
        : 'Little traffic — token Cap is mostly headroom.'

  return {
    id: 'inference',
    title: 'Serve pool',
    poolPf,
    powerMw,
    allocShare,
    utilization: util,
    utilizationLabel,
    summary,
    lines,
  }
}

function buildResearchBreakdown(
  state: SimState,
  snap: ComputeSnapshot,
  allocShare: number,
): PoolBreakdown {
  const poolPf = snap.pools.research
  const powerMw = snap.mwBreakdown.research
  const techShare = researchPoolForTech(state)
  const dataShare = Math.max(0, 1 - techShare)
  const researchPf = poolPf * techShare
  const job = state.player.activeResearch
  const programs = state.player.researchPrograms ?? []
  const staff = playerStaff(state)
  const lines: BreakdownLine[] = [
    {
      label: 'Pool PF',
      value: `${fmtPf(poolPf)} PF`,
    },
    {
      label: 'Power draw',
      value: `${powerMw.toFixed(3)} MW`,
    },
    {
      label: 'Allocation',
      value: pct01(allocShare),
      bar: allocShare,
    },
    {
      label: 'To tech tree',
      value: `${pct01(techShare)} · ${fmtPf(researchPf)} PF`,
      bar: techShare,
    },
  ]
  if (dataShare > 0.02) {
    lines.push({
      label: 'To data pipeline',
      value: `${pct01(dataShare)} · ${fmtPf(poolPf * dataShare)} PF`,
      muted: true,
    })
  }
  lines.push({
    label: 'Researchers',
    value: String(staff.researcher ?? 0),
    warn: (staff.researcher ?? 0) < 1,
  })

  let utilization = 0
  let utilizationLabel = 'Idle'
  let summary = 'No active research — research PF is idle.'

  if (programs.length > 0) {
    lines.push({
      label: 'Programs',
      value: `${programs.length} active`,
    })
  }

  if (job) {
    const node = getResearchNode(job.nodeId)
    const target = researchPfTarget(state, node)
    const progress = job.progressPfDays / Math.max(1e-6, target)
    const rate = estimateResearchRate(state, job.nodeId)
    const daysLeft =
      rate.pfPerDay > 1e-6
        ? Math.max(0, target - job.progressPfDays) / rate.pfPerDay
        : Infinity
    utilization = rate.pfPerDay > 0 ? 1 : 0
    utilizationLabel = rate.pfPerDay > 0 ? 'In use' : 'Stalled'
    summary =
      rate.pfPerDay > 0
        ? `Researching ${node.name} · ${pct01(progress)} · ${fmtPf(rate.pfPerDay)} PF·d/day.`
        : `Stalled on ${node.name} — need researchers or more research PF.`
    lines.push(
      {
        label: 'Project',
        value: node.name,
      },
      {
        label: 'Progress',
        value: `${fmtPf(job.progressPfDays)} / ${fmtPf(target)} PF·d`,
        bar: Math.min(1, progress),
      },
      {
        label: 'Rate',
        value:
          rate.pfPerDay > 0
            ? `${fmtPf(rate.pfPerDay)} PF·d/day`
            : '0 — check staff / PF',
        warn: rate.pfPerDay <= 0,
      },
      {
        label: 'ETA',
        value: Number.isFinite(daysLeft) ? `~${Math.ceil(daysLeft)}d` : '—',
      },
    )
  } else if (programs.length > 0) {
    utilization = 1
    utilizationLabel = 'Programs'
    summary = `${programs.length} research program${programs.length === 1 ? '' : 's'} drawing from the research pool.`
    lines.push({
      label: 'Status',
      value: 'Programs running — tech-tree node idle',
      muted: true,
    })
  } else {
    lines.push({
      label: 'Status',
      value: 'Idle — queue a node in Tech',
      muted: true,
    })
  }

  return {
    id: 'research',
    title: 'Research pool',
    poolPf,
    powerMw,
    allocShare,
    utilization,
    utilizationLabel,
    summary,
    lines,
  }
}
