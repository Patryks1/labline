import { describe, expect, it } from 'vitest'
import { buildGameConfig } from '../balance/gameConfig'
import { createGame } from '../createGame'
import type { DataManifest, TrainingProgram } from '../types'
import {
  boundRivalTrainingHistory,
  RIVAL_TRAINING_HISTORY_LIMIT,
} from './rivals'

function trainingProgram(index: number): TrainingProgram {
  return {
    id: `program-${index}`,
    objective: `Generation ${index}`,
    targetSegments: ['startup_api'],
    assignedPodIds: [],
    pilots: [],
    checkpoints: [{
      id: `checkpoint-${index}`,
      progress: 1,
      day: index,
      stability: 0.8,
      reusable: true,
    }],
    domainForecasts: {},
    confidence: 0.95,
    integratedMethods: [],
    dataManifestId: `manifest-${index}`,
  }
}

function manifest(index: number): DataManifest {
  return {
    id: `manifest-${index}`,
    assetIds: Array.from({ length: index + 1 }, (_, asset) => `asset-${asset}`),
    domainWeights: { code: 1 },
    uniqueMTok: 100 + index,
    repeatedMTok: 0,
    effectiveQuality: 0.8,
    contaminationRisk: 0.02,
    createdDay: index,
  }
}

describe('bounded rival training evidence', () => {
  it('keeps only recent programs and their manifests once retired runs overflow', () => {
    const state = createGame({ config: buildGameConfig({ seed: 71 }) })
    const rival = state.rivals[0]!
    const programs = Array.from({ length: 30 }, (_, index) => trainingProgram(index))
    const manifests = Array.from({ length: 30 }, (_, index) => manifest(index))
    const compacted = boundRivalTrainingHistory({
      ...rival,
      trainingPrograms: programs,
      data: { ...rival.data!, manifests },
    })

    expect(compacted.trainingPrograms).toHaveLength(RIVAL_TRAINING_HISTORY_LIMIT)
    expect(compacted.trainingPrograms?.map((program) => program.id)).toEqual(
      programs.slice(-RIVAL_TRAINING_HISTORY_LIMIT).map((program) => program.id),
    )
    expect(compacted.data?.manifests.map((entry) => entry.id)).toEqual(
      manifests.slice(-RIVAL_TRAINING_HISTORY_LIMIT).map((entry) => entry.id),
    )
    expect(compacted.data?.manifests[0]?.assetIds).toHaveLength(19)
    expect(programs).toHaveLength(30)
    expect(manifests).toHaveLength(30)
    expect(boundRivalTrainingHistory(compacted)).toBe(compacted)
  })
})
