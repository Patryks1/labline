import type { SimState } from '../types'
import { tickRackDeliveries } from './dcRacks'
import { completeActiveResearchNow } from './research'
import { completeTrainingJobsNow } from './training'
import { commitWorldBatch, usesCompactWorld } from './worldAccess'

export type InstantCheatAction = 'construction' | 'research' | 'training' | 'rackDelivery'

export interface InstantCheatResult {
  state: SimState
  affected: number
}

function completeConstruction(state: SimState): InstantCheatResult {
  if (usesCompactWorld(state)) {
    const facilities = state.map.world!.queryFacilities({ ownerId: state.playerLabId })
      .filter((facility) => facility.constructionProgress < facility.constructionTarget)
    if (facilities.length === 0) return { state, affected: 0 }
    const batch = state.map.world!.beginBatch()
    for (const facility of facilities) {
      batch.updateFacility(facility.id, { constructionProgress: facility.constructionTarget })
    }
    return { state: commitWorldBatch(state, batch), affected: facilities.length }
  }

  const campusIds = new Set<string>()
  let affected = 0
  const tiles = state.map.tiles.map((tile) => {
    if (tile.owner !== 'player' || tile.buildingTarget <= 0 || tile.buildingProgress >= tile.buildingTarget) return tile
    if (tile.campusId) campusIds.add(tile.campusId)
    else affected += 1
    return { ...tile, buildingProgress: tile.buildingTarget }
  })
  affected += campusIds.size
  return affected > 0 ? { state: { ...state, map: { ...state.map, tiles } }, affected } : { state, affected: 0 }
}

function completeResearch(state: SimState): InstantCheatResult {
  const before = state.player.researchUnlocked.length
  const next = completeActiveResearchNow(state)
  return { state: next, affected: next.player.researchUnlocked.length > before ? 1 : 0 }
}

function completeTraining(state: SimState): InstantCheatResult {
  const affected = (state.player.trainingJobs ?? []).filter((job) => !job.failed && !job.awaitingDecision).length
  return { state: affected > 0 ? completeTrainingJobsNow(state) : state, affected }
}

function deliverRacks(state: SimState): InstantCheatResult {
  const affected = state.player.rackFleet
    .filter((rack) => rack.status === 'ordered')
    .reduce((sum, rack) => sum + rack.count, 0)
  if (affected === 0) return { state, affected: 0 }
  const ready = {
    ...state,
    player: {
      ...state.player,
      rackFleet: state.player.rackFleet.map((rack) => rack.status === 'ordered' ? { ...rack, daysLeft: 0 } : rack),
    },
  }
  return { state: tickRackDeliveries(ready), affected }
}

export function applyInstantCheat(state: SimState, action: InstantCheatAction): InstantCheatResult {
  switch (action) {
    case 'construction': return completeConstruction(state)
    case 'research': return completeResearch(state)
    case 'training': return completeTraining(state)
    case 'rackDelivery': return deliverRacks(state)
  }
}
