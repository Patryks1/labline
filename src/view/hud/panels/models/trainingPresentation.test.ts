import { describe, expect, it } from 'vitest'
import type { TrainingResourceAllocation } from '../../../../sim/systems/training'
import {
  classifyTrainingStatus,
  hardwareDiagnostic,
  lossStageMarkers,
  trainingEnergyLabel,
  trainingReleaseDisabledReason,
  trainingRemainingTime,
} from './trainingPresentation'

const readyResources: TrainingResourceAllocation = {
  rawPf: 12,
  effectivePf: 10,
  computeShare: 1,
  ramAllocatedGb: 160,
  ramRequiredGb: 120,
  ramReady: true,
  systemRamAllocatedGb: 512,
  systemRamRequiredGb: 256,
  systemRamReady: true,
  bottleneck: 'none',
}

const baseStatus = {
  completeReady: false,
  plateaued: false,
  computeDone: false,
}

describe('training presentation', () => {
  it('uses allocated compute only for the live countdown', () => {
    expect(trainingRemainingTime({
      targetPfDays: 100,
      progressPfDays: 40,
      allocatedPf: 10,
    })).toMatchObject({ computeEta: 6, etaDays: 6 })

    expect(trainingRemainingTime({
      targetPfDays: 100,
      progressPfDays: 40,
      allocatedPf: 2,
    })).toMatchObject({ computeEta: 30, etaDays: 30 })

    expect(trainingRemainingTime({
      targetPfDays: 100,
      progressPfDays: 40,
      allocatedPf: 0,
    }).etaDays).toBe(Infinity)
  })

  it('keeps an early-release gate reason available to both button title and inline copy', () => {
    const reason = 'Wait for a sustained loss plateau.'
    expect(trainingReleaseDisabledReason({ ok: false, reason })).toBe(reason)
    expect(trainingReleaseDisabledReason({ ok: true })).toBeUndefined()
  })

  it('classifies progressing, plateaued, unstable, memory-blocked, and power-blocked runs', () => {
    expect(classifyTrainingStatus(baseStatus).statusLabel).toBe('Progressing')
    expect(classifyTrainingStatus({ ...baseStatus, plateaued: true }).statusLabel).toBe('Plateaued')
    expect(classifyTrainingStatus({ ...baseStatus, stallReason: 'Numerical instability caused NaN loss' }).statusLabel).toBe('Unstable')
    expect(classifyTrainingStatus({
      ...baseStatus,
      resources: { ...readyResources, ramReady: false, ramAllocatedGb: 80, bottleneck: 'hbm' },
    }).statusLabel).toBe('Memory blocked')
    expect(classifyTrainingStatus({ ...baseStatus, stallReason: 'Site power brownout' }).statusLabel).toBe('Power blocked')
  })

  it('phrases actionable HBM, host-memory, throughput, and bottleneck diagnostics', () => {
    expect(hardwareDiagnostic({
      ...readyResources,
      effectivePf: 0,
      ramAllocatedGb: 80,
      systemRamAllocatedGb: 128,
      bottleneck: 'both',
    })).toBe('No compatible training hardware: HBM short by 40 GB · system RAM short by 128 GB · 0 PF/d allocated · bottleneck: both.')
  })

  it('marks only transitions into post-training stages and formats energy telemetry', () => {
    const points = [
      { day: 1, progress: 0.1, loss: 4, stage: 'base' as const },
      { day: 2, progress: 0.2, loss: 3.5, stage: 'base' as const },
      { day: 3, progress: 0.3, loss: 3.8, stage: 'sft' as const },
      { day: 4, progress: 0.4, loss: 3.3, stage: 'sft' as const },
      { day: 5, progress: 0.5, loss: 3.6, stage: 'rlhf' as const },
    ]

    expect(lossStageMarkers(points).map(({ point, index }) => [point.stage, index])).toEqual([
      ['sft', 2],
      ['rlhf', 4],
    ])
    expect(trainingEnergyLabel({ energyMWh: 48, mwDays: 2 })).toBe('energy 48.0 MWh · 2.00 MW-d')
    expect(trainingEnergyLabel({ energyMWh: 48, mwDays: 2, estimated: true })).toBe('energy ~48.0 MWh · ~2.00 MW-d')
    expect(trainingEnergyLabel({})).toBe('energy — · telemetry pending')
  })
})
