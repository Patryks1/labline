import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import { buildScaledModel } from '../balance/modelBuild'
import { DATA_DOMAINS } from '../balance/data'
import { instantRecipe } from '../balance/modelProduct'
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

  it('uses the selected teacher recipe for distill quality, billed cash, and training PF', () => {
    const configured = (seed: number) => {
      const setup = withTeacher(richState(seed))
      const model = setup.state.player.models.find(
        (candidate) => candidate.id === setup.teacherId,
      )!
      model.productProfile = {
        ...model.productProfile!,
        effortRecipes: [
          instantRecipe(),
          {
            id: 'careful', name: 'Careful', kind: 'trained',
            thinkingTokenMult: 6, trainPfDays: 100, trainCash: 2_000_000,
            trained: true, quality: 0.88, served: true, capabilityBias: 0.7,
          },
        ],
        defaultEffortId: 'instant',
      }
      return setup
    }
    const run = (effortId: string) => {
      const { state, teacherId } = configured(7_311)
      const effortIds = Object.fromEntries(
        DATA_DOMAINS.map((domain) => [domain, effortId]),
      )
      return playerTrainingJobs(startTraining(state, {
        name: `Student-${effortId}`,
        family: 'dense',
        paramsB: 2,
        mode: 'distill',
        teacherId,
        distillTeacherShare: 0.05,
        dataPlan: {
          ...oversubscribedPlan(2),
          syntheticTeacherEffortIds: effortIds,
        },
      }))[0]!
    }
    const instant = run('instant')
    const careful = run('careful')
    const provenance = careful.syntheticProvenance ?? []
    const generationPf = provenance.reduce(
      (sum, record) => sum + (record.generationComputePfDays ?? 0),
      0,
    )

    expect(careful.dataPlan.syntheticTeacherEffortIds).toMatchObject({
      code: 'careful', math: 'careful', chat: 'careful',
    })
    expect(provenance.length).toBeGreaterThan(0)
    expect(provenance.every((record) => record.teacherEffortId === 'careful')).toBe(true)
    expect(provenance.every((record) => (record.billedTokenMultiplier ?? 0) > 1)).toBe(true)
    expect(provenance.every((record) => (record.teacherComputeIntensityMultiplier ?? 0) > 1)).toBe(true)
    expect(generationPf).toBeGreaterThan(0)
    expect(careful.targetPfDays).toBeGreaterThan(instant.targetPfDays)
    expect(careful.cashSunk).toBeGreaterThan(instant.cashSunk)
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
    // Fresh auto-fill now reserves real generation compute and remains bounded
    // by the selected teacher's useful synthetic headroom.
    expect(job!.syntheticUnits).toBeGreaterThan(400)
    expect(job!.syntheticProvenance?.length).toBeGreaterThan(0)
  })
})
