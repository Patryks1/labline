import type { IndustryDataPack } from '../types'

/**
 * All real-world calibration is routed through this immutable pack. Future
 * balance packs get a new id; existing v4 saves remain pinned to this one.
 */
export const GROUNDED_2026_INDUSTRY_PACK: IndustryDataPack = {
  id: 'grounded-2026-v1',
  version: 1,
  calibratedThroughYear: 2026,
  demand: {
    baselineUsefulTasks: 1,
    reportYearMinMultiplier: 4,
    reportYearMaxMultiplier: 12,
  },
  compute: {
    cloudOwnedPremiumMin: 0.3,
    cloudOwnedPremiumMax: 0.6,
    emergencyPremium: 1.5,
    modelVersion: 1,
    trainingTimeCompression: 1,
    onlineHeadroom: 0.2,
    baselineTrainingMfu: 0.35,
  },
  infrastructure: {
    colocationLeadDays: [90, 180],
    ownedLeadDays: [180, 720],
    ownedPaybackMonths: [60, 84],
  },
  benchmarkFamilies: [
    'general-reasoning',
    'code',
    'math',
    'science',
    'chat-preference',
    'vision',
    'video-audio',
    'agents',
    'factuality',
    'safety',
    'latency',
    'throughput',
    'cost-per-useful-task',
  ],
  speculativeAfterYear: 2026,
}

/** Default for new campaigns. Existing saves retain their embedded v1 pack. */
export const GROUNDED_2026_COMPUTE_V2_PACK: IndustryDataPack = {
  ...GROUNDED_2026_INDUSTRY_PACK,
  id: 'grounded-2026-compute-v2',
  version: 2,
  compute: {
    ...GROUNDED_2026_INDUSTRY_PACK.compute,
    modelVersion: 2,
    trainingTimeCompression: 4,
    onlineHeadroom: 0.25,
    baselineTrainingMfu: 0.35,
  },
}

export const INDUSTRY_DATA_PACKS: Readonly<Record<string, IndustryDataPack>> = {
  [GROUNDED_2026_INDUSTRY_PACK.id]: GROUNDED_2026_INDUSTRY_PACK,
  [GROUNDED_2026_COMPUTE_V2_PACK.id]: GROUNDED_2026_COMPUTE_V2_PACK,
}

export function getIndustryDataPack(id: string): IndustryDataPack | null {
  return INDUSTRY_DATA_PACKS[id] ?? null
}
