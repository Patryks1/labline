import { isDcKind } from './map'
/**
 * Campus-wide bonuses derived from completed player buildings.
 * Pure helper — used by compute, research, market, mapEnergy.
 */
import type { LabId, SimState } from '../types'
import type { DynamicWorld } from '../world/dynamicWorld'
import {
  compactCompletedFacilitiesForOwner,
  facilityAnchorTiles,
  usesCompactWorld,
} from './worldAccess'

export interface CampusBonuses {
  /** Subtracted from base PUE (cooling towers) */
  pueReduction: number
  /** Multiplier on research PF progress */
  researchMult: number
  /** Multiplier on daily wages (office campuses) */
  wageMult: number
  /** Extra MW from battery / storage */
  batteryMw: number
  /** Added train efficiency (labs) */
  trainEffBonus: number
  /** Brand drift per day from nice campus */
  brandDrift: number
  coolingSites: number
  labSites: number
  officeSites: number
  batterySites: number
}

type CompactCampusCache = {
  revision: number
  byLab: Map<LabId, CampusBonuses>
}

const compactCampusCaches = new WeakMap<DynamicWorld, CompactCampusCache>()

export function campusBonusesForLab(
  state: SimState,
  labId: LabId,
): CampusBonuses {
  const compactWorld = usesCompactWorld(state) ? state.map.world! : undefined
  if (compactWorld) {
    const cache = compactCampusCaches.get(compactWorld)
    if (cache?.revision === compactWorld.revision) {
      const cached = cache.byLab.get(labId)
      if (cached) return cached
    }
  }
  let pueReduction = 0
  let researchMult = 1
  let wageMult = 1
  let batteryMw = 0
  let trainEffBonus = 0
  let brandDrift = 0
  let coolingSites = 0
  let labSites = 0
  let officeSites = 0
  let batterySites = 0

  const applyFacility = (
    kind: string,
    level: number,
    mwCapacity: number,
    regionId: string | undefined,
  ) => {
    const lv = Math.max(1, level)
    switch (kind) {
      case 'cooling':
        coolingSites++
        pueReduction += 0.055 * lv
        trainEffBonus += 0.01 * lv
        break
      case 'lab':
        labSites++
        researchMult += 0.11 * lv
        trainEffBonus += 0.02 * lv
        brandDrift += 0.01
        break
      case 'office':
      case 'hq':
      case 'hq_m':
      case 'hq_l':
        officeSites++
        wageMult -= 0.04 * lv * (kind === 'hq_l' ? 1.4 : kind === 'hq_m' ? 1.15 : 1)
        brandDrift += 0.012 * (kind === 'hq_l' ? 1.3 : 1)
        break
      case 'battery':
        batterySites++
        batteryMw += 3.5 * lv + mwCapacity
        break
      case 'dc':
      case 'dc_m':
      case 'dc_l':
        brandDrift += kind === 'dc_l' ? 0.012 : kind === 'dc_m' ? 0.008 : 0.005
        break
      default:
        break
    }
    if (isDcKind(kind) && regionId === 'north') pueReduction += 0.04
  }

  if (usesCompactWorld(state)) {
    const world = state.map.world!
    for (const facility of compactCompletedFacilitiesForOwner(state, labId) ?? []) {
      const regionIndex = world.staticWorld.region[facility.anchor]
      applyFacility(
        facility.kind,
        facility.level,
        facility.stats?.mwCapacity ?? 0,
        regionIndex === undefined ? undefined : world.staticWorld.regions[regionIndex]?.id,
      )
    }
  } else {
    const facilities = facilityAnchorTiles(state, { ownerId: labId })
    for (const t of facilities) {
      if (t.buildingTarget > 0 && t.buildingProgress < t.buildingTarget) continue
      applyFacility(t.kind, t.level, t.mwCapacity || 0, t.regionId)
    }
  }

  const bonuses: CampusBonuses = {
    pueReduction: Math.min(0.45, pueReduction),
    researchMult: Math.min(2.2, researchMult),
    wageMult: Math.max(0.65, wageMult),
    batteryMw,
    trainEffBonus: Math.min(0.25, trainEffBonus),
    brandDrift,
    coolingSites,
    labSites,
    officeSites,
    batterySites,
  }
  if (compactWorld) {
    let cache = compactCampusCaches.get(compactWorld)
    if (!cache || cache.revision !== compactWorld.revision) {
      cache = { revision: compactWorld.revision, byLab: new Map() }
      compactCampusCaches.set(compactWorld, cache)
    }
    cache.byLab.set(labId, bonuses)
  }
  return bonuses
}

/** Player compatibility wrapper. */
export function campusBonuses(state: SimState): CampusBonuses {
  return campusBonusesForLab(state, state.playerLabId)
}
