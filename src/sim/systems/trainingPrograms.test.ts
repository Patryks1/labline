import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { SimState } from '../types'
import {
  finalizeModel,
  resolveCheckpoint,
  runPilot,
  startTrainingProgram,
  type StartTrainingProgramOpts,
} from './trainingPrograms'

const PROGRAM: StartTrainingProgramOpts = {
  name: 'Helix 400M',
  family: 'dense',
  paramsB: 0.4,
  mode: 'pretrain',
  objective: 'Deliver inexpensive code and science assistance',
  targetSegments: ['indie_api', 'science'],
  assignedPodIds: ['pod-foundations'],
  dataPlan: {
    totalUnits: 400,
    totalMTok: 400,
    weights: {
      chat: 0.4,
      code: 0.3,
      math: 0.1,
      science: 0.1,
      image: 0.05,
      audio: 0.05,
    },
    allowSynthetic: true,
  },
}

function started(seed: number): SimState {
  const state = startTrainingProgram(createGame(seed), PROGRAM)
  expect(state.player.trainingJob).not.toBeNull()
  expect(state.player.trainingPrograms).toHaveLength(1)
  return state
}

describe('authoritative training programs', () => {
  it('snapshots an immutable strategy, method set, data manifest, and pod assignment', () => {
    const state = started(710)
    const job = state.player.trainingJob!
    const program = state.player.trainingPrograms![0]!

    expect(program.id).toBe(job.id)
    expect(program.objective).toBe(PROGRAM.objective)
    expect(program.targetSegments).toEqual(['indie_api', 'science'])
    expect(program.integratedMethods).toEqual(['dense_basics'])
    expect(program.dataManifestId).toBeTruthy()
    const manifest = state.player.data.manifests.find(
      (candidate) => candidate.id === program.dataManifestId,
    )!
    expect(manifest.assetIds).toEqual(['dataset-public-foundation-2026'])
    expect(Object.values(manifest.domainWeights).reduce((sum, weight) => sum + (weight ?? 0), 0)).toBeCloseTo(1)
    expect(manifest.domainWeights.audio ?? 0).toBe(0)
    expect(manifest.domainWeights.video ?? 0).toBe(0)
    expect(job.dataEvidence).toMatchObject({
      effectiveQuality: manifest.effectiveQuality,
      contaminationRisk: manifest.contaminationRisk,
      effectiveTrainingValue: manifest.effectiveTrainingValue,
    })
    expect(state.player.researchPods?.find((pod) => pod.id === 'pod-foundations')?.assignmentId).toBe(job.id)
    expect(program.domainForecasts.code?.high).toBeGreaterThan(program.domainForecasts.code?.low ?? 0)
  })

  it('uses the asset-attributed mix for the live job instead of stock-only recipe weights', () => {
    const initial = createGame(713)
    const foundation = initial.player.data.assets[0]!
    const state = startTrainingProgram(
      {
        ...initial,
        player: {
          ...initial.player,
          data: {
            ...initial.player.data,
            stocks: Object.fromEntries(
              Object.entries(initial.player.data.stocks).map(([domain, stock]) => [
                domain,
                domain === 'chat'
                  ? stock
                  : {
                      ...stock,
                      processed: 0,
                      fromWeb: 0,
                      fromUser: 0,
                      fromBought: 0,
                      fromSynth: 0,
                      fromSynthHQ: 0,
                      fromSynthLQ: 0,
                    },
              ]),
            ) as typeof initial.player.data.stocks,
            assets: [
              {
                ...foundation,
                id: 'chat-only-provenance',
                volumeMTok: 80,
                domainWeights: { chat: 1 },
              },
            ],
          },
        },
      },
      PROGRAM,
    )
    const job = state.player.trainingJob!
    const manifest = state.player.data.manifests.find(
      (candidate) => candidate.id === job.dataManifestId,
    )!

    expect(job, state.alerts[0]?.message).not.toBeNull()
    expect(manifest.domainWeights).toEqual({ chat: 1 })
    expect(job.dataPlan?.weights.chat).toBe(1)
    expect(job.dataPlan?.weights.code).toBe(0)
    expect(job.dataConsumed?.code ?? 0).toBe(0)
    expect(job.dataConsumed?.chat).toBeCloseTo(
      (job.trainMTok ?? 0) + (job.verifyMTok ?? 0),
      8,
    )
  })

  it('spends accumulated compute on a deterministic pilot and narrows ranges without rerolling', () => {
    let state = started(711)
    const job = state.player.trainingJob!
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...job, progressPfDays: job.targetPfDays * 0.2 },
      },
    }
    const program = state.player.trainingPrograms![0]!
    const seedBefore = state.player.trainingJob!.outcomeSeed
    const widthBefore = program.domainForecasts.code!.high - program.domainForecasts.code!.low

    const pilotCompute = job.targetPfDays * 0.1
    const next = runPilot(state, program.id, { domain: 'code', kind: 'ablation', computePfDays: pilotCompute })
    const rerun = runPilot(state, program.id, { domain: 'code', kind: 'ablation', computePfDays: pilotCompute })
    const updated = next.player.trainingPrograms![0]!

    expect(updated.pilots).toHaveLength(1)
    expect(updated.pilots[0]).toMatchObject({ domain: 'code', kind: 'ablation', completed: true })
    expect(next.player.trainingJob?.progressPfDays).toBeCloseTo(job.targetPfDays * 0.1)
    expect(next.player.trainingJob?.outcomeSeed).toBe(seedBefore)
    expect(updated.domainForecasts.code?.expected).toBe(program.domainForecasts.code?.expected)
    expect(updated.domainForecasts.code!.high - updated.domainForecasts.code!.low).toBeLessThan(widthBefore)
    expect(rerun.player.trainingPrograms![0]).toEqual(updated)
    expect(rerun.player.cash).toBe(next.player.cash)
  })

  it('resolves causal checkpoints, finalizes a released model, and frees its pod', () => {
    let state = started(712)
    const programId = state.player.trainingPrograms![0]!.id
    const originalJob = state.player.trainingJob!
    const hiddenSeed = originalJob.outcomeSeed

    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...originalJob, progressPfDays: originalJob.targetPfDays * 0.25 },
      },
    }
    state = resolveCheckpoint(state, programId, 'continue')
    expect(state.player.trainingPrograms![0]!.checkpoints).toHaveLength(1)
    expect(state.player.trainingPrograms![0]!.checkpoints[0]!.trainingNumerics)
      .toEqual(originalJob.trainingNumerics)

    const beforeStabilize = state.player.trainingJob!
    const cashBefore = state.player.cash
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...beforeStabilize, progressPfDays: beforeStabilize.targetPfDays * 0.5 },
      },
    }
    state = resolveCheckpoint(state, programId, 'stabilize')
    expect(state.player.trainingJob?.targetPfDays).toBeGreaterThan(beforeStabilize.targetPfDays)
    expect(state.player.trainingJob?.trainShare).toBeLessThan(beforeStabilize.trainShare)
    expect(state.player.trainingJob?.outcomeSeed).toBe(hiddenSeed)
    expect(state.player.cash).toBeLessThan(cashBefore)

    const stabilized = state.player.trainingJob!
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: {
          ...stabilized,
          progressPfDays: stabilized.targetPfDays,
          daysElapsed: stabilized.minCalendarDays ?? 0,
        },
        trainingJobs: (state.player.trainingJobs ?? [stabilized]).map((job) =>
          job.id === stabilized.id
            ? {
                ...job,
                progressPfDays: job.targetPfDays,
                daysElapsed: job.minCalendarDays ?? 0,
              }
            : job,
        ),
      },
    }
    state = finalizeModel(state, programId, 'released')

    expect(state.player.trainingJob).toBeNull()
    const model = state.player.models.at(-1)!
    expect(model.release).toBe('released')
    expect(model.dataManifestId).toBe(state.player.trainingPrograms![0]!.dataManifestId)
    expect(model.integratedMethods).toEqual(['dense_basics'])
    expect(state.player.trainingPrograms![0]!.checkpoints.at(-1)?.progress).toBe(1)
    expect(state.player.trainingPrograms![0]!.checkpoints.at(-1)?.trainingNumerics)
      .toEqual(originalJob.trainingNumerics)
    expect(state.player.researchPods?.find((pod) => pod.id === 'pod-foundations')?.assignmentId).toBeNull()
    expect(state.evaluations.filter((evaluation) => evaluation.modelId === model.id)).toHaveLength(4)
  })

  it('preserves a reusable checkpoint and releases resources when a run is aborted', () => {
    let state = started(713)
    const programId = state.player.trainingPrograms![0]!.id
    const job = state.player.trainingJob!
    state = {
      ...state,
      player: {
        ...state.player,
        trainingJob: { ...job, progressPfDays: job.targetPfDays * 0.25 },
      },
    }
    state = resolveCheckpoint(state, programId, 'abort')

    expect(state.player.trainingJob).toBeNull()
    expect(state.player.trainingPrograms![0]!.checkpoints[0]).toMatchObject({ progress: 0.25, reusable: true })
    expect(state.player.researchPods?.find((pod) => pod.id === 'pod-foundations')?.assignmentId).toBeNull()
  })
})
