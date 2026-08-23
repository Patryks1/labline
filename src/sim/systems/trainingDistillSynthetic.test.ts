import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildScaledModel } from '../balance/modelBuild'
import { playerTrainingJobs, startTraining } from './training'
import type { SimState } from '../types'

function richState(seed: number): SimState {
  const state = createGame(seed)
  return { ...state, player: { ...state.player, cash: 1_000_000_000 } }
}

/** Internal 7B teacher (~8.4B tokens of lifetime corpus) — no data_synth research. */
function withTeacher(state: SimState): { state: SimState; teacherId: string } {
  const teacher = buildScaledModel({
    id: 'teacher-1',
    name: 'Teacher',
    paramsB: 7,
    family: 'dense',
    day: state.day,
    dataCoverage: 1.2,
    dataQuality: 70,
    release: 'internal',
    shipped: false,
  })
  return {
    state: {
      ...state,
      player: { ...state.player, models: [teacher, ...state.player.models] },
    },
    teacherId: teacher.id,
  }
}

const oversubscribedPlan = (multiplier: number) => ({
  totalUnits: 1_500,
  totalMTok: 1_500,
  weights: {},
  allowSynthetic: true,
  syntheticMultiplier: multiplier,
})

describe('distill teacher synthetic fill', () => {
  it('fills past the owned corpus from the teacher and records provenance', () => {
    const { state, teacherId } = withTeacher(richState(731))
    const next = startTraining(state, {
      name: 'Student',
      family: 'dense',
      paramsB: 2,
      mode: 'distill',
      teacherId,
      distillTeacherShare: 0.05, // own-corpus recipe: ~1425 MTok vs 500 MTok corpus
      dataPlan: oversubscribedPlan(2),
    })

    const job = playerTrainingJobs(next)[0]
    expect(job).toBeTruthy()
    expect(job!.mode).toBe('distill')
    // Volume past the 500 MTok owned corpus is teacher-generated synthetic.
    expect(job!.syntheticUnits).toBeGreaterThan(500)
    expect(job!.trainMTok + job!.verifyMTok).toBeGreaterThan(1_000)
    const provenance = job!.syntheticProvenance ?? []
    expect(provenance.length).toBeGreaterThan(0)
    expect(provenance.every((record) => record.teacherModelId === teacherId)).toBe(
      true,
    )
    const provenanceVolume = provenance.reduce(
      (sum, record) => sum + record.volumeMTok,
      0,
    )
    expect(provenanceVolume).toBeCloseTo(job!.syntheticUnits)
    // The launched plan itself carries the teacher-generated provenance.
    expect(job!.dataPlan.syntheticMultiplier).toBe(2)
    expect(job!.dataPlan.syntheticProvenance?.length).toBe(provenance.length)
  })

  it('does not fill past the corpus in distill without a multiplier', () => {
    const { state, teacherId } = withTeacher(richState(732))
    const next = startTraining(state, {
      name: 'Student',
      family: 'dense',
      paramsB: 2,
      mode: 'distill',
      teacherId,
      distillTeacherShare: 0.05,
      dataPlan: oversubscribedPlan(0),
    })

    const job = playerTrainingJobs(next)[0]
    expect(job).toBeTruthy()
    expect(job!.syntheticUnits).toBe(0)
    expect(job!.syntheticProvenance ?? []).toHaveLength(0)
  })

  it('stays blocked at the corpus in pretrain without synthetic generation research', () => {
    const { state } = withTeacher(richState(733))
    const next = startTraining(state, {
      name: 'NoSynth',
      family: 'dense',
      paramsB: 2,
      dataPlan: oversubscribedPlan(2),
    })

    const job = playerTrainingJobs(next)[0]
    expect(job).toBeTruthy()
    expect(job!.syntheticUnits).toBe(0)
    expect(job!.trainMTok + job!.verifyMTok).toBeLessThanOrEqual(501)
  })

  it('expands past the corpus in pretrain once synthetic generation is unlocked', () => {
    const { state } = withTeacher(richState(734))
    const unlocked: SimState = {
      ...state,
      player: {
        ...state.player,
        researchUnlocked: [...state.player.researchUnlocked, 'data_synth'],
      },
    }
    const next = startTraining(unlocked, {
      name: 'LabSynth',
      family: 'dense',
      paramsB: 2,
      dataPlan: oversubscribedPlan(2),
    })

    const job = playerTrainingJobs(next)[0]
    expect(job).toBeTruthy()
    // Auto-fill at train start reserves no generation compute, so expansion
    // past ~2× real is compute-gated — still past the owned corpus, just not
    // the full oversubscribed recipe volume.
    expect(job!.syntheticUnits).toBeGreaterThan(400)
    expect(job!.syntheticProvenance?.length).toBeGreaterThan(0)
  })
})
