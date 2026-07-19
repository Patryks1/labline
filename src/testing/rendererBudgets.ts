import {
  summarizeFrameMetrics,
  type FrameMetricSample,
  type FrameStatsSummary,
  type RenderLod,
} from './cameraReplay'

export interface LodStructuralBudget {
  drawCalls: number
  triangles: number
}

export interface RendererBudgetProfile {
  idleP95Ms: number
  interactionP95Ms: number
  overallP99Ms: number
  maxFramesOver33MsRatio: number
  maxChunkWorkMs: number
  maxResidentCpuChunks: number
  maxGpuChunkLayers: number
  lod: Record<RenderLod, LodStructuralBudget>
  requireNoMissingTiles: boolean
  requireNoCapacityRejects: boolean
  requireNoCloseUpPlaceholders: boolean
}

export interface RendererBudgetViolation {
  metric: string
  actual: number
  budget: number
  message: string
}

export interface RendererBudgetEvaluation {
  pass: boolean
  summary: FrameStatsSummary
  violations: RendererBudgetViolation[]
}

/** Hardware timing gates plus deterministic structural limits from the 1000² plan. */
export const DEFAULT_RENDERER_BUDGET: Readonly<RendererBudgetProfile> = {
  idleP95Ms: 16.7,
  interactionP95Ms: 20,
  overallP99Ms: 33.3,
  maxFramesOver33MsRatio: 0.01,
  maxChunkWorkMs: 2,
  maxResidentCpuChunks: 96,
  maxGpuChunkLayers: 288,
  lod: {
    near: { drawCalls: 250, triangles: 1_500_000 },
    mid: { drawCalls: 180, triangles: 900_000 },
    far: { drawCalls: 100, triangles: 400_000 },
  },
  requireNoMissingTiles: true,
  requireNoCapacityRejects: true,
  requireNoCloseUpPlaceholders: true,
}

function addViolation(
  violations: RendererBudgetViolation[],
  metric: string,
  actual: number,
  budget: number,
  suffix = '',
) {
  if (actual <= budget) return
  violations.push({
    metric,
    actual,
    budget,
    message: `${metric} ${actual.toFixed(2)} exceeds ${budget.toFixed(2)}${suffix}`,
  })
}

export function evaluateRendererBudget(
  samples: readonly FrameMetricSample[],
  budget: RendererBudgetProfile = DEFAULT_RENDERER_BUDGET,
): RendererBudgetEvaluation {
  const summary = summarizeFrameMetrics(samples)
  const violations: RendererBudgetViolation[] = []
  addViolation(violations, 'idle frame p95 ms', summary.idleFrameMs.p95, budget.idleP95Ms)
  addViolation(
    violations,
    'interaction frame p95 ms',
    summary.interactionFrameMs.p95,
    budget.interactionP95Ms,
  )
  addViolation(violations, 'overall frame p99 ms', summary.frameMs.p99, budget.overallP99Ms)
  addViolation(
    violations,
    'frames over 33.3 ms ratio',
    summary.framesOver33MsRatio,
    budget.maxFramesOver33MsRatio,
  )
  addViolation(violations, 'chunk work ms', summary.maxChunkWorkMs, budget.maxChunkWorkMs)
  addViolation(
    violations,
    'resident CPU chunks',
    summary.maxResidentCpuChunks,
    budget.maxResidentCpuChunks,
  )
  addViolation(
    violations,
    'GPU chunk layers',
    summary.maxGpuChunkLayers,
    budget.maxGpuChunkLayers,
  )
  for (const lod of ['near', 'mid', 'far'] as const) {
    addViolation(
      violations,
      `${lod} draw calls`,
      summary.maxDrawCalls[lod],
      budget.lod[lod].drawCalls,
    )
    addViolation(
      violations,
      `${lod} triangles`,
      summary.maxTriangles[lod],
      budget.lod[lod].triangles,
    )
  }
  if (budget.requireNoMissingTiles) {
    addViolation(violations, 'missing tiles', summary.totalMissingTiles, 0)
  }
  if (budget.requireNoCapacityRejects) {
    addViolation(violations, 'instance capacity rejects', summary.totalCapacityRejects, 0)
  }
  if (budget.requireNoCloseUpPlaceholders) {
    addViolation(
      violations,
      'close-up placeholders',
      summary.totalCloseUpPlaceholders,
      0,
    )
  }
  return { pass: violations.length === 0, summary, violations }
}

export function formatRendererBudgetFailures(evaluation: RendererBudgetEvaluation): string {
  if (evaluation.pass) return 'renderer budget passed'
  return evaluation.violations.map((violation) => violation.message).join('\n')
}
