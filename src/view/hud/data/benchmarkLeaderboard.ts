import type {
  BenchmarkMetricId,
  BenchmarkSuiteId,
  EffortBoard,
  EffortRecipe,
  Model,
} from '../../../sim/types'
import {
  INSTANT_EFFORT_ID,
  effortViewForRecipe,
  migrateEffortRecipes,
  serveTokenMultiplierForRecipe,
} from '../../../sim/balance/modelProduct'
import {
  avgTokensPerInteraction,
  type CommercialModelKind,
} from '../../../sim/balance/pricing'
import { buildPublicBenchmarkData } from './benchmarkViewModel'

export type LeaderboardModelRow = {
  labId: string
  labName: string
  color: number
  model: Model
  isPlayer: boolean
  kind: 'model' | 'router'
}

export type LeaderboardEffortRow = LeaderboardModelRow & {
  recipeId: string
  recipeName: string
  displayName: string
  /** Capability for this thinking level. */
  capability: number
  /** Serve-time token multiplier vs a 1× thinking budget. */
  tokenMult: number
  /**
   * List price $/MTok. Same for every thinking row of a model — thinking
   * changes tokens used, not the unit price.
   */
  usdPerMTok: number | null
  scores: Partial<Record<BenchmarkMetricId, number>>
}

export type LeaderboardSortId =
  | 'model'
  | 'lab'
  | 'size'
  | 'cap'
  | 'think'
  | 'tokens'
  | 'price'
  | 'day'
  | BenchmarkMetricId
export type LeaderboardSortDirection = 'asc' | 'desc'

/** `Solace-Think`. Instant-only models keep the bare name. */
export function leaderboardEffortDisplayName(
  modelName: string,
  recipe: Pick<EffortRecipe, 'kind' | 'name'>,
  trainedRecipeCount: number,
): string {
  if (trainedRecipeCount <= 1) return modelName
  const suffix =
    recipe.kind === 'instant' ? 'Instant' : recipe.name.trim() || 'Think'
  const needle = `-${suffix}`
  if (modelName.toLowerCase().endsWith(needle.toLowerCase())) return modelName
  return `${modelName}${needle}`
}

export function trainedLeaderboardRecipes(model: Model): EffortRecipe[] {
  return migrateEffortRecipes(model.productProfile).filter(
    (recipe) => recipe.trained,
  )
}

/**
 * Public suite scores for one thinking recipe. Hard-task benches (knowledge,
 * code, reasoning, science, agents) lift with thinking; other axes stay at
 * the model-level public projection.
 */
export function publicBenchmarkScoresForEffort(
  model: Model,
  suiteId: BenchmarkSuiteId,
  recipeId: string,
): Partial<Record<BenchmarkMetricId, number>> {
  const view = effortViewForRecipe(model, recipeId)
  if (!view) return buildPublicBenchmarkData(model).suites[suiteId] ?? {}
  if (recipeId === INSTANT_EFFORT_ID || view.recipe.kind === 'instant') {
    return buildPublicBenchmarkData(model).suites[suiteId] ?? {}
  }
  return (
    buildPublicBenchmarkData({
      ...model,
      capability: view.capability,
      benchmarks: view.benchmarks,
    }).suites[suiteId] ?? {}
  )
}

export function expandLeaderboardEffortRows(
  rows: readonly LeaderboardModelRow[],
  options: {
    suiteId: BenchmarkSuiteId
    unitUsdPerMTokFor?: (row: LeaderboardModelRow) => number | null
  },
): LeaderboardEffortRow[] {
  const expanded: LeaderboardEffortRow[] = []
  for (const row of rows) {
    const recipes = trainedLeaderboardRecipes(row.model)
    const unitUsd =
      options.unitUsdPerMTokFor?.(row) ?? null
    const efficiency = row.model.productProfile?.tokenEfficiency ?? 50
    for (const recipe of recipes) {
      const view = effortViewForRecipe(row.model, recipe.id)
      expanded.push({
        ...row,
        recipeId: recipe.id,
        recipeName: recipe.kind === 'instant' ? 'Instant' : recipe.name,
        displayName: leaderboardEffortDisplayName(
          row.model.name,
          recipe,
          recipes.length,
        ),
        capability: view?.capability ?? row.model.capability,
        tokenMult: serveTokenMultiplierForRecipe(recipe, efficiency),
        usdPerMTok: unitUsd,
        scores: publicBenchmarkScoresForEffort(
          row.model,
          options.suiteId,
          recipe.id,
        ),
      })
    }
  }
  return expanded
}

export function rankLeaderboardEffortRows(
  rows: readonly LeaderboardEffortRow[],
  sortId: LeaderboardSortId,
  direction: LeaderboardSortDirection = 'desc',
): LeaderboardEffortRow[] {
  const text = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const sign = direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
    const a = left.row
    const b = right.row
    let comparison = 0
    if (sortId === 'model') comparison = text.compare(a.displayName, b.displayName)
    else if (sortId === 'lab') comparison = text.compare(a.labName, b.labName)
    else if (sortId === 'think') comparison = text.compare(a.recipeName, b.recipeName)
    else {
      const sa =
        sortId === 'cap'
          ? a.capability
          : sortId === 'size'
            ? a.model.paramsB
            : sortId === 'tokens'
              ? a.tokenMult
              : sortId === 'price'
                ? (a.usdPerMTok ?? -1)
                : sortId === 'day'
                  ? a.model.releaseDay
                  : (a.scores[sortId] ?? 0)
      const sb =
        sortId === 'cap'
          ? b.capability
          : sortId === 'size'
            ? b.model.paramsB
            : sortId === 'tokens'
              ? b.tokenMult
              : sortId === 'price'
                ? (b.usdPerMTok ?? -1)
                : sortId === 'day'
                  ? b.model.releaseDay
                  : (b.scores[sortId] ?? 0)
      comparison = sa - sb
    }
    if (comparison !== 0) return comparison * sign
    const byName = a.displayName.localeCompare(b.displayName)
    if (byName !== 0) return byName
    const byRecipe = a.recipeId.localeCompare(b.recipeId)
    return byRecipe !== 0 ? byRecipe : left.index - right.index
  })
    .map(({ row }) => row)
}

export function nextLeaderboardSortDirection(
  currentId: LeaderboardSortId,
  currentDirection: LeaderboardSortDirection,
  nextId: LeaderboardSortId,
): LeaderboardSortDirection {
  if (currentId === nextId) return currentDirection === 'asc' ? 'desc' : 'asc'
  return nextId === 'model' || nextId === 'lab' || nextId === 'think'
    ? 'asc'
    : 'desc'
}

export function leaderboardEffortRowKey(row: LeaderboardEffortRow): string {
  return `${row.labId}-${row.model.id}-${row.recipeId}`
}

/** Stable official rank, independent of the table's current presentation sort. */
export function officialLeaderboardRankByKey(
  rows: readonly LeaderboardEffortRow[],
): Map<string, number> {
  return new Map(
    rankLeaderboardEffortRows(rows, 'cap', 'desc').map((row, index) => [
      leaderboardEffortRowKey(row),
      index + 1,
    ]),
  )
}

/**
 * Provider COGS for an Instant-sized request envelope. Legacy boards only
 * persisted the invariant Instant unit cost, so retain it as a compatibility
 * fallback.
 */
export function effectiveEffortBoardUsdPerBaseMTok(
  board: Pick<EffortBoard, 'effectiveUsdPerBaseMTok' | 'usdPerMTok'> | null | undefined,
): number | null {
  return board?.effectiveUsdPerBaseMTok ?? board?.usdPerMTok ?? null
}

/**
 * Map a public leaderboard metric to the serve workload used for typical
 * token usage. Hard benches burn more tokens; chatty axes stay light.
 */
export function metricWorkloadKind(
  metricId: BenchmarkMetricId,
): CommercialModelKind {
  switch (metricId) {
    case 'coding':
    case 'agents':
      return 'coding'
    case 'math':
    case 'science':
    case 'omni_reasoning':
    case 'omni_tools':
      return 'reasoning'
    case 'vision':
    case 'prompt_alignment':
    case 'aesthetics':
    case 'typography':
    case 'subject_consistency':
    case 'editing_control':
    case 'image_safety':
    case 'omni_image':
      return 'image'
    case 'video_prompt_alignment':
    case 'visual_quality':
    case 'temporal_coherence':
    case 'motion_physics':
    case 'video_control':
    case 'video_safety':
    case 'omni_video':
      return 'video'
    case 'intelligibility':
    case 'naturalness':
    case 'voice_consistency':
    case 'music_quality':
    case 'realtime_performance':
    case 'audio_safety':
    case 'omni_audio':
      return 'audio'
    default:
      return 'language'
  }
}

export type LeaderboardMetricCost = {
  workload: CommercialModelKind
  baseTokens: number
  tokens: number
  usdPerMTok: number | null
  usdPerQuery: number | null
}

/** Tokens and $ for one typical query at this thinking level. */
export function leaderboardMetricCost(
  row: Pick<LeaderboardEffortRow, 'tokenMult' | 'usdPerMTok'>,
  metricId: BenchmarkMetricId,
): LeaderboardMetricCost {
  const workload = metricWorkloadKind(metricId)
  const baseTokens = avgTokensPerInteraction(workload)
  const tokens = Math.max(0, baseTokens * Math.max(0, row.tokenMult))
  const usdPerMTok =
    row.usdPerMTok != null && Number.isFinite(row.usdPerMTok)
      ? Math.max(0, row.usdPerMTok)
      : null
  const usdPerQuery =
    usdPerMTok != null ? (tokens / 1_000_000) * usdPerMTok : null
  return { workload, baseTokens, tokens, usdPerMTok, usdPerQuery }
}

function formatTokCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1000) {
    const k = tokens / 1000
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}K`
  }
  return tokens.toFixed(0)
}

function formatQueryCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`
  return `$${usd.toExponential(1)}`
}

/**
 * Native `title` for a score cell: score, thinking usage, and $ at list price.
 */
export function leaderboardMetricCostTitle(
  row: Pick<
    LeaderboardEffortRow,
    'tokenMult' | 'usdPerMTok' | 'recipeName' | 'scores' | 'capability'
  >,
  metric: { id: BenchmarkMetricId | 'cap'; label: string },
): string {
  const score =
    metric.id === 'cap' ? row.capability : row.scores[metric.id]
  const cost = leaderboardMetricCost(
    row,
    metric.id === 'cap' ? 'mmlu' : metric.id,
  )
  const scoreBit =
    score != null && score > 0
      ? `${metric.label} ${Number(score).toFixed(0)}`
      : metric.label
  const usageBit = `${formatTokCount(cost.tokens)} toks (${row.tokenMult.toFixed(1)}× ${row.recipeName})`
  if (cost.usdPerQuery == null || cost.usdPerMTok == null) {
    return `${scoreBit} · ${usageBit} · no list price`
  }
  return `${scoreBit} · ${usageBit} · ${formatQueryCost(cost.usdPerQuery)} / query at $${cost.usdPerMTok.toFixed(2)}/MTok`
}
