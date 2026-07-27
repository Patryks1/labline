/**
 * New-game configuration: difficulty presets + advanced overrides.
 * Presets only fill the knobs; advanced fields always win when set explicitly.
 */

export type DifficultyId = 'easy' | 'normal' | 'hard'
export type DrivingSide = 'left' | 'right'
export type CompanyMarkId =
  | 'orbit'
  | 'delta'
  | 'prism'
  | 'hex'
  | 'spire'
  | 'grid'
  | 'nexus'
  | 'wave'
  | 'core'

export interface GameConfig {
  labName: string
  /** Player-selected company identity, persisted with the sandbox. */
  companyMark?: CompanyMarkId
  difficulty: DifficultyId
  seed: number
  /** Map dimensions in tiles */
  mapWidth: number
  mapHeight: number
  /** Target number of metro cores (clamped 2–24); v3 derives smaller settlements. */
  cityCount: number
  rivalCount: number
  /** Multiplier on BUILD_DEFS cash & upgrades */
  economyMult: number
  /** Multiplier on research PF-day costs */
  researchCostMult: number
  /** Multiplier on ECONOMY.startingCash */
  startingCashMult: number
  /** Base land purchase $ for remote empty parcels */
  landValueBase: number
  /** Extra land $ peak at city center */
  landValueCityPeak: number
  /** Traffic lane convention for this sandbox. */
  drivingSide?: DrivingSide
  campaignRules?: CampaignRules
}

/** Legacy map was 15×12 = 180 tiles. The 300×300 frontier default is 500× that. */
export const LEGACY_TILE_COUNT = 15 * 12
export const MIN_MAP_DIMENSION = 20
export const MAX_MAP_DIMENSION = 1000
export const MIN_CITY_COUNT = 2
export const MAX_CITY_COUNT = 24

export const DIFFICULTY_PRESETS: Record<
  DifficultyId,
  Omit<GameConfig, 'labName' | 'seed' | 'difficulty' | 'campaignRules'>
> = {
  easy: {
    mapWidth: 300,
    mapHeight: 300,
    cityCount: 4,
    rivalCount: 5,
    economyMult: 1,
    researchCostMult: 1,
    startingCashMult: 1,
    landValueBase: 2_500_000,
    landValueCityPeak: 28_000_000,
    drivingSide: 'left',
  },
  normal: {
    mapWidth: 300,
    mapHeight: 300,
    cityCount: 4,
    rivalCount: 5,
    economyMult: 1,
    researchCostMult: 1,
    startingCashMult: 1,
    landValueBase: 2_500_000,
    landValueCityPeak: 28_000_000,
    drivingSide: 'left',
  },
  hard: {
    mapWidth: 300,
    mapHeight: 300,
    cityCount: 4,
    rivalCount: 5,
    economyMult: 1,
    researchCostMult: 1,
    startingCashMult: 1,
    landValueBase: 2_500_000,
    landValueCityPeak: 28_000_000,
    drivingSide: 'left',
  },
}

export type AdvancedOverrides = Partial<
  Omit<GameConfig, 'labName' | 'difficulty' | 'seed'>
>

export function buildGameConfig(opts: {
  labName?: string
  companyMark?: CompanyMarkId
  difficulty?: DifficultyId
  seed?: number
  advanced?: AdvancedOverrides
  campaignRules?: Partial<CampaignRules>
}): GameConfig {
  const difficulty = opts.difficulty ?? 'normal'
  const preset = DIFFICULTY_PRESETS[difficulty]
  const adv = opts.advanced ?? {}
  const mapWidth = Math.max(
    MIN_MAP_DIMENSION,
    Math.min(MAX_MAP_DIMENSION, Math.round(adv.mapWidth ?? preset.mapWidth)),
  )
  const mapHeight = Math.max(
    MIN_MAP_DIMENSION,
    Math.min(MAX_MAP_DIMENSION, Math.round(adv.mapHeight ?? preset.mapHeight)),
  )
  // Preserve today's presets while scaling untouched advanced worlds to a
  // useful number of metros. An explicit city value always wins.
  const autoCityCount = Math.max(
    preset.cityCount,
    Math.min(16, Math.round((mapWidth * mapHeight) / 80_000)),
  )
  const cityCount = Math.max(
    MIN_CITY_COUNT,
    Math.min(MAX_CITY_COUNT, Math.round(adv.cityCount ?? autoCityCount)),
  )
  const rivalCount = Math.max(1, Math.min(5, Math.round(adv.rivalCount ?? preset.rivalCount)))

  return {
    labName: (opts.labName?.trim() || 'Labline').slice(0, 32),
    companyMark: opts.companyMark ?? 'orbit',
    difficulty,
    seed: opts.seed ?? 42,
    mapWidth,
    mapHeight,
    cityCount,
    rivalCount,
    economyMult: Math.max(0.4, Math.min(2.5, adv.economyMult ?? preset.economyMult)),
    researchCostMult: Math.max(0.4, Math.min(2.5, adv.researchCostMult ?? preset.researchCostMult)),
    startingCashMult: Math.max(0.3, Math.min(3, adv.startingCashMult ?? preset.startingCashMult)),
    landValueBase: Math.max(100_000, adv.landValueBase ?? preset.landValueBase),
    landValueCityPeak: Math.max(1_000_000, adv.landValueCityPeak ?? preset.landValueCityPeak),
    drivingSide: adv.drivingSide === 'right' ? 'right' : 'left',
    campaignRules: defaultCampaignRules(opts.campaignRules ?? adv.campaignRules),
  }
}

export function defaultGameConfig(): GameConfig {
  return buildGameConfig({ labName: 'Labline', difficulty: 'normal', seed: 42 })
}

export function mapTileCount(cfg: Pick<GameConfig, 'mapWidth' | 'mapHeight'>): number {
  return cfg.mapWidth * cfg.mapHeight
}

/** True when tile count is in the large compact-world band around the default. */
export function isMegaMapScale(cfg: Pick<GameConfig, 'mapWidth' | 'mapHeight'>): boolean {
  const n = mapTileCount(cfg)
  return n >= LEGACY_TILE_COUNT * 80 && n <= LEGACY_TILE_COUNT * 180
}
import { defaultCampaignRules } from '../campaign'
import type { CampaignRules } from '../types'
