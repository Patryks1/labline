import { describe, expect, it } from 'vitest'
import { createGame } from '../createGame'
import type { RackInstall, TrainingJob } from '../types'
import { applyInstantCheat } from './cheats'

function game() {
  return createGame({
    seed: 4_219,
    difficulty: 'easy',
    advanced: { mapWidth: 24, mapHeight: 24, cityCount: 2, rivalCount: 1 },
  })
}

describe('instant cheat actions', () => {
  it('finishes every player construction facility', () => {
    const state = game()
    const facility = [...state.map.world!.facilitiesById.values()][0]!
    state.map.world!.beginBatch().updateFacility(facility.id, {
      ownerId: state.playerLabId,
      constructionProgress: 2,
      constructionTarget: 30,
    }).commit()

    const result = applyInstantCheat(state, 'construction')

    expect(result.affected).toBeGreaterThan(0)
    const completed = result.state.map.world!.facilitiesById.get(facility.id)!
    expect(completed.constructionProgress).toBe(completed.constructionTarget)
  })

  it('completes active research through its normal unlock path', () => {
    const state = game()
    const nodeId = 'sys_batching'
    state.player.researchUnlocked = state.player.researchUnlocked.filter((id) => id !== nodeId)
    state.player.activeResearch = { nodeId, progressPfDays: 0, daysSpent: 0 }

    const result = applyInstantCheat(state, 'research')

    expect(result.affected).toBe(1)
    expect(result.state.player.researchUnlocked).toContain(nodeId)
    expect(result.state.player.activeResearch).toBeNull()
  })

  it('moves training runs to their release decision without auto-releasing them', () => {
    const state = game()
    const job = {
      id: 'cheat-training',
      name: 'Instant Model',
      targetPfDays: 120,
      recommendedPfDays: 100,
      progressPfDays: 4,
      postTrain: 'sft',
      postTrainProgress: 1,
      postTrainTarget: 9,
      failed: false,
      awaitingDecision: false,
    } as TrainingJob
    state.player.trainingJobs = [job]
    state.player.trainingJob = job

    const result = applyInstantCheat(state, 'training')
    const completed = result.state.player.trainingJobs![0]!

    expect(result.affected).toBe(1)
    expect(completed.progressPfDays).toBe(120)
    expect(completed.postTrainProgress).toBe(9)
    expect(completed.awaitingDecision).toBe(false)
    expect(result.state.player.models).toEqual(state.player.models)
  })

  it('delivers every ordered rack through the delivery merge path', () => {
    const state = game()
    const ordered = {
      id: 'cheat-racks', skuId: 'rack_h100', x: 2, y: 2, count: 3,
      rackUnits: 1, status: 'ordered', daysLeft: 8, paidEach: 1_000_000,
    } satisfies RackInstall
    state.player.rackFleet = [ordered]

    const result = applyInstantCheat(state, 'rackDelivery')

    expect(result.affected).toBe(3)
    expect(result.state.player.rackFleet).toContainEqual(expect.objectContaining({
      id: ordered.id,
      status: 'live',
      daysLeft: 0,
    }))
  })
})
