import { CAPABILITY_DOMAINS } from '../balance/modelCapabilities'
import { createRng, hashSeed, seededId } from '../rng'
import type {
  CapabilityDomain,
  DataDomain,
  DataManifest,
  ExperimentRun,
  ForecastBand,
  ModelCheckpoint,
  SegmentId,
  SimState,
  StartTrainingOpts,
  TrainingJob,
  TrainingProgram,
} from '../types'
import { keepInternal, playerTrainingJobs, releaseFromJob, startTraining } from './training'
import { LEGACY_TRAINING_NUMERICS } from '../balance/trainingPrecision'

const CHECKPOINT_THRESHOLDS = [0.25, 0.5, 0.75] as const

const DOMAIN_DATA_AFFINITY: Record<CapabilityDomain, Partial<Record<DataDomain, number>>> = {
  language: { chat: 1, law: 0.1, health: 0.1, science: 0.08, audio: 0.08 },
  reasoning: { math: 0.45, science: 0.35, code: 0.15, chat: 0.05 },
  code: { code: 1 },
  math: { math: 1 },
  science: { science: 1, math: 0.15 },
  vision: { image: 1, video: 0.15 },
  video: { video: 1, image: 0.2 },
  audio: { audio: 1 },
  tools: { code: 0.55, chat: 0.2, math: 0.1, science: 0.1 },
}

export interface StartTrainingProgramOpts extends StartTrainingOpts {
  objective: string
  targetSegments: SegmentId[]
  assignedPodIds?: string[]
  dataManifestId?: string | null
  integratedMethods?: string[]
}

export interface RunPilotOpts {
  domain: CapabilityDomain
  kind?: ExperimentRun['kind']
  /** PF-days already earned by the run and diverted into the experiment. */
  computePfDays: number
}

export type CheckpointIntervention = 'continue' | 'stabilize' | 'abort'
export type ModelFinalization = 'internal' | 'released'

function withAlert(
  state: SimState,
  severity: 'info' | 'warn' | 'danger',
  message: string,
): SimState {
  return {
    ...state,
    alerts: [
      {
        id: seededId('training-program-alert', state.seed, state.day, severity, message),
        day: state.day,
        severity,
        message,
      },
      ...state.alerts,
    ].slice(0, 40),
  }
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value))
}

function normalizeWeights(
  weights: Partial<Record<DataDomain, number>>,
): Partial<Record<DataDomain, number>> {
  const total = Object.values(weights).reduce((sum, value) => sum + Math.max(0, value ?? 0), 0)
  if (total <= 0) return {}
  return Object.fromEntries(
    Object.entries(weights).map(([domain, value]) => [domain, Math.max(0, value ?? 0) / total]),
  ) as Partial<Record<DataDomain, number>>
}

function forecastDomains(job: TrainingJob, confidence: number): Partial<Record<CapabilityDomain, ForecastBand>> {
  const weights = normalizeWeights(job.dataPlan?.weights ?? {})
  const computeSignal = Math.log10(1 + Math.max(0, job.targetPfDays))
  const parameterSignal = Math.log10(1 + Math.max(0, job.targetParamsB) * 10)
  const qualitySignal = clamp((job.dataQualityUsed ?? 45) / 100)
  const coverageSignal = clamp(job.effectiveDataRatio ?? job.dataCoverage ?? 0, 0, 2) / 2
  const general = clamp(
    12 + parameterSignal * 16 + computeSignal * 9 + qualitySignal * 12 + coverageSignal * 8,
    5,
    88,
  )
  const halfWidth = 6 + (1 - confidence) * 12
  const result: Partial<Record<CapabilityDomain, ForecastBand>> = {}

  for (const domain of CAPABILITY_DOMAINS) {
    let affinity = 0
    for (const [dataDomain, coefficient] of Object.entries(DOMAIN_DATA_AFFINITY[domain]) as [
      DataDomain,
      number,
    ][]) {
      affinity += (weights[dataDomain] ?? 0) * coefficient
    }
    let expected = general * (0.72 + Math.min(0.7, affinity) * 0.62)
    if (domain === 'vision' && job.family !== 'diffusion' && job.family !== 'omni') expected = Math.min(18, expected)
    if (domain === 'video' && job.family !== 'video' && job.family !== 'omni') expected = Math.min(10, expected)
    if (domain === 'audio' && job.productPreset !== 'audio' && job.family !== 'omni') expected = Math.min(12, expected)
    if (domain === 'tools' && (job.io?.tools ?? 0) <= 0) expected = Math.min(16, expected)
    expected = clamp(expected, 0, 100)
    result[domain] = {
      low: clamp(expected - halfWidth, 0, 100),
      expected,
      high: clamp(expected + halfWidth, 0, 100),
    }
  }
  return result
}

function narrowForecasts(
  forecasts: Partial<Record<CapabilityDomain, ForecastBand>>,
  confidenceGain: number,
): Partial<Record<CapabilityDomain, ForecastBand>> {
  const factor = clamp(1 - confidenceGain * 2.4, 0.55, 0.95)
  return Object.fromEntries(
    Object.entries(forecasts).map(([domain, band]) => {
      const current = band as ForecastBand
      const lowDistance = current.expected - current.low
      const highDistance = current.high - current.expected
      return [
        domain,
        {
          low: current.expected - lowDistance * factor,
          expected: current.expected,
          high: current.expected + highDistance * factor,
        },
      ]
    }),
  ) as Partial<Record<CapabilityDomain, ForecastBand>>
}

function createManifest(state: SimState, job: TrainingJob): DataManifest {
  const assets = state.player.data.assets ?? []
  const assetVolume = assets.reduce((sum, asset) => sum + Math.max(0, asset.volumeMTok), 0)
  const contaminationRisk =
    assetVolume > 0
      ? assets.reduce(
          (sum, asset) => sum + asset.contaminationRisk * Math.max(0, asset.volumeMTok),
          0,
        ) / assetVolume
      : 0
  const totalMTok = Math.max(0, (job.trainMTok ?? 0) + (job.verifyMTok ?? 0))
  return {
    id: seededId('manifest', state.seed, state.day, job.id),
    assetIds: assets.map((asset) => asset.id),
    domainWeights: normalizeWeights(job.dataPlan?.weights ?? {}),
    uniqueMTok: Math.min(totalMTok, job.dataPlan?.uniqueMTok ?? totalMTok),
    repeatedMTok: Math.max(0, job.dataPlan?.repeatedMTok ?? 0),
    effectiveQuality: job.dataQualityUsed ?? state.player.dataQuality,
    contaminationRisk,
    createdDay: state.day,
  }
}

/**
 * Creates the authoritative program record and starts its underlying legacy job.
 * The program id intentionally matches the job id, giving saves one stable join key.
 */
export function startTrainingProgram(state: SimState, opts: StartTrainingProgramOpts): SimState {
  if (!opts.objective.trim()) return withAlert(state, 'warn', 'A model program needs a commercial objective.')
  if (opts.targetSegments.length === 0) return withAlert(state, 'warn', 'Choose at least one target segment.')
  if (opts.targetSegments.some((id) => !state.segments.some((segment) => segment.id === id))) {
    return withAlert(state, 'warn', 'The model program includes an unknown target segment.')
  }

  const podIds = [...new Set(opts.assignedPodIds ?? [])]
  for (const podId of podIds) {
    const pod = (state.player.researchPods ?? []).find((candidate) => candidate.id === podId)
    if (!pod) return withAlert(state, 'warn', 'Assigned research pod not found.')
    if (pod.assignmentId) return withAlert(state, 'warn', `${pod.name} already has an assignment.`)
    if (!(state.player.researchLeads ?? []).some((lead) => lead.id === pod.leadId)) {
      return withAlert(state, 'warn', `${pod.name} needs a named lead.`)
    }
  }

  const requestedMethods = [...new Set(opts.integratedMethods ?? state.player.researchUnlocked)]
  const unavailableMethod = requestedMethods.find((id) => !state.player.researchUnlocked.includes(id))
  if (unavailableMethod) return withAlert(state, 'warn', `Method ${unavailableMethod} is not integrated.`)
  if (
    opts.dataManifestId &&
    !(state.player.data.manifests ?? []).some((manifest) => manifest.id === opts.dataManifestId)
  ) {
    return withAlert(state, 'warn', 'Selected data manifest was not found.')
  }

  const previousJobIds = new Set(playerTrainingJobs(state).map((job) => job.id))
  const previousManifestIds = new Set((state.player.data.manifests ?? []).map((manifest) => manifest.id))
  let next = startTraining(state, opts)
  const job = playerTrainingJobs(next).find((candidate) => !previousJobIds.has(candidate.id))
  if (!job) return next

  const generatedManifest = (next.player.data.manifests ?? []).find(
    (manifest) => !previousManifestIds.has(manifest.id),
  )
  const manifest =
    opts.dataManifestId != null
      ? (next.player.data.manifests ?? []).find((item) => item.id === opts.dataManifestId)!
      : generatedManifest ?? createManifest(next, job)
  const shouldAppendManifest = !(next.player.data.manifests ?? []).some((item) => item.id === manifest.id)
  const confidence = 0.38
  const program: TrainingProgram = {
    id: job.id,
    objective: opts.objective.trim(),
    targetSegments: [...new Set(opts.targetSegments)],
    assignedPodIds: podIds,
    pilots: [],
    checkpoints: [],
    domainForecasts: forecastDomains(job, confidence),
    confidence,
    integratedMethods: requestedMethods,
    dataManifestId: manifest.id,
  }

  next = {
    ...next,
    player: {
      ...next.player,
      data: {
        ...next.player.data,
        manifests: shouldAppendManifest
          ? [...(next.player.data.manifests ?? []), manifest]
          : next.player.data.manifests,
      },
      trainingPrograms: [...(next.player.trainingPrograms ?? []), program],
      researchPods: (next.player.researchPods ?? []).map((pod) =>
        podIds.includes(pod.id) ? { ...pod, assignmentId: program.id } : pod,
      ),
    },
    news: [
      `Day ${state.day}: Opened model program ${job.name} for ${program.objective}.`,
      ...next.news,
    ].slice(0, 64),
  }
  return next
}

/**
 * Diverts compute already accumulated by the main run into a deterministic pilot.
 * This prevents a pilot from creating free compute while keeping its result immediate.
 */
export function runPilot(state: SimState, programId: string, opts: RunPilotOpts): SimState {
  const program = (state.player.trainingPrograms ?? []).find((candidate) => candidate.id === programId)
  const jobs = playerTrainingJobs(state)
  const job = jobs.find((candidate) => candidate.id === program?.id)
  if (!program || !job) return withAlert(state, 'warn', 'Training program is not active.')
  if (!CAPABILITY_DOMAINS.includes(opts.domain)) return withAlert(state, 'warn', 'Unknown pilot domain.')
  if (job.progressPfDays / Math.max(1, job.targetPfDays) >= 0.5) {
    return withAlert(state, 'warn', 'Pilots must run before the halfway checkpoint.')
  }
  const computePfDays = Math.max(0.001, opts.computePfDays)
  if (job.progressPfDays + 1e-9 < computePfDays) {
    return withAlert(state, 'warn', 'Accumulate more training compute before diverting it to a pilot.')
  }
  const cashCost = Math.round(computePfDays * 3_500)
  if (state.player.cash < cashCost) return withAlert(state, 'warn', 'Insufficient cash for the pilot experiment.')

  const assignedLeads = program.assignedPodIds
    .map((podId) => (state.player.researchPods ?? []).find((pod) => pod.id === podId))
    .map((pod) => (state.player.researchLeads ?? []).find((lead) => lead.id === pod?.leadId))
    .filter((lead): lead is NonNullable<typeof lead> => lead != null)
  const specialty = assignedLeads.length > 0
    ? assignedLeads.reduce((sum, lead) => sum + (lead.specialties[opts.domain] ?? 0), 0) /
      assignedLeads.length
    : 0.35
  const confidenceGain = clamp(0.035 + Math.log1p(computePfDays) * 0.025 + specialty * 0.035, 0.04, 0.16)
  const experiment: ExperimentRun = {
    id: seededId('pilot', state.seed, state.day, program.id, program.pilots.length, opts.domain, opts.kind ?? 'pilot'),
    kind: opts.kind ?? 'pilot',
    domain: opts.domain,
    computePfDays,
    progressPfDays: computePfDays,
    confidenceGain,
    completed: true,
  }

  return {
    ...state,
    player: {
      ...state.player,
      cash: state.player.cash - cashCost,
      trainingJob: jobs[0]?.id === job.id
        ? { ...job, progressPfDays: Math.max(0, job.progressPfDays - computePfDays) }
        : jobs[0] ?? null,
      trainingJobs: jobs.map((candidate) => candidate.id === job.id ? { ...job, progressPfDays: Math.max(0, job.progressPfDays - computePfDays) } : candidate),
      trainingPrograms: (state.player.trainingPrograms ?? []).map((candidate) =>
        candidate.id === program.id
          ? {
              ...candidate,
              pilots: [...candidate.pilots, experiment],
              confidence: clamp(candidate.confidence + confidenceGain, 0, 0.9),
              domainForecasts: narrowForecasts(candidate.domainForecasts, confidenceGain),
            }
          : candidate,
      ),
    },
    news: [
      `Day ${state.day}: ${opts.domain} ${experiment.kind} narrowed ${job.name}'s forecast (${computePfDays.toFixed(1)} PF-d).`,
      ...state.news,
    ].slice(0, 64),
  }
}

function checkpointStability(state: SimState, job: TrainingJob, threshold: number): number {
  const rng = createRng(hashSeed(job.outcomeSeed ?? state.seed, job.id, threshold, 'checkpoint'))
  const quality = clamp((job.dataQualityUsed ?? 45) / 100)
  const verification = clamp(1 - (job.trainShare ?? 0.82))
  return clamp(0.48 + quality * 0.25 + verification * 0.65 + (rng.next() - 0.5) * 0.14)
}

/** Resolves the next reached checkpoint without changing the job's hidden outcome seed. */
export function resolveCheckpoint(
  state: SimState,
  programId: string,
  intervention: CheckpointIntervention = 'continue',
): SimState {
  const program = (state.player.trainingPrograms ?? []).find((candidate) => candidate.id === programId)
  const jobs = playerTrainingJobs(state)
  const job = jobs.find((candidate) => candidate.id === program?.id)
  if (!program || !job) return withAlert(state, 'warn', 'Training program is not active.')
  const resolvedCount = program.checkpoints.filter((checkpoint) => checkpoint.progress < 1).length
  const threshold = CHECKPOINT_THRESHOLDS[resolvedCount]
  if (threshold == null) return withAlert(state, 'warn', 'All intervention checkpoints are already resolved.')
  const completion = job.progressPfDays / Math.max(1e-9, job.targetPfDays)
  if (completion + 1e-9 < threshold) {
    return withAlert(state, 'warn', `The ${Math.round(threshold * 100)}% checkpoint has not been reached.`)
  }

  const stabilizationCost = Math.round(Math.max(50_000, job.targetPfDays * 1_500))
  if (intervention === 'stabilize' && state.player.cash < stabilizationCost) {
    return withAlert(state, 'warn', 'Insufficient cash for checkpoint stabilization.')
  }
  const checkpoint: ModelCheckpoint = {
    id: seededId('checkpoint', state.seed, program.id, threshold),
    progress: threshold,
    day: state.day,
    stability: checkpointStability(state, job, threshold),
    reusable: true,
    trainingNumerics:
      job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
  }
  const confidenceGain = 0.07
  const updatedPrograms = (state.player.trainingPrograms ?? []).map((candidate) =>
    candidate.id === program.id
      ? {
          ...candidate,
          checkpoints: [...candidate.checkpoints, checkpoint],
          confidence: clamp(candidate.confidence + confidenceGain, 0, 0.92),
          domainForecasts: narrowForecasts(candidate.domainForecasts, confidenceGain),
        }
      : candidate,
  )

  if (intervention === 'abort') {
    const remainingJobs = jobs.filter((candidate) => candidate.id !== job.id)
    return {
      ...state,
      player: {
        ...state.player,
        trainingJobs: remainingJobs,
        trainingJob: remainingJobs[0] ?? null,
        trainingPrograms: updatedPrograms,
        researchPods: (state.player.researchPods ?? []).map((pod) =>
          program.assignedPodIds.includes(pod.id) && pod.assignmentId === program.id
            ? { ...pod, assignmentId: null }
            : pod,
        ),
      },
      news: [`Day ${state.day}: Aborted ${job.name}; checkpoint preserved for later evidence.`, ...state.news].slice(0, 64),
    }
  }

  let updatedJob = job
  let cash = state.player.cash
  if (intervention === 'stabilize') {
    const totalData = Math.max(0, (job.trainMTok ?? 0) + (job.verifyMTok ?? 0))
    const trainShare = clamp((job.trainShare ?? 0.82) - 0.04, 0.6, 0.95)
    updatedJob = {
      ...job,
      targetPfDays: job.targetPfDays * 1.06,
      trainShare,
      trainMTok: totalData * trainShare,
      verifyMTok: totalData * (1 - trainShare),
      outcomeRisk: job.outcomeRisk === 'high' ? 'medium' : 'low',
    }
    cash -= stabilizationCost
  }

  return {
    ...state,
    player: {
      ...state.player,
      cash,
      trainingJobs: jobs.map((candidate) => candidate.id === updatedJob.id ? updatedJob : candidate),
      trainingJob: jobs[0]?.id === updatedJob.id ? updatedJob : jobs[0] ?? null,
      trainingPrograms: updatedPrograms,
    },
    news: [
      `Day ${state.day}: Resolved ${job.name}'s ${Math.round(threshold * 100)}% checkpoint (${intervention}).`,
      ...state.news,
    ].slice(0, 64),
  }
}

/** Finalizes the underlying model, attaches immutable program metadata, and releases its pods. */
export function finalizeModel(
  state: SimState,
  programId: string,
  finalization: ModelFinalization = 'internal',
): SimState {
  const program = (state.player.trainingPrograms ?? []).find((candidate) => candidate.id === programId)
  const job = playerTrainingJobs(state).find((candidate) => candidate.id === program?.id)
  if (!program || !job) return withAlert(state, 'warn', 'Training program is not active.')
  if (job.progressPfDays + 1e-9 < job.targetPfDays) return withAlert(state, 'warn', 'Pretraining is not complete.')
  if (job.postTrain !== 'none' && job.postTrainProgress + 1e-9 < job.postTrainTarget) {
    return withAlert(state, 'warn', 'The active post-training phase is not complete.')
  }

  let next = finalization === 'released' ? releaseFromJob(state, job.id) : keepInternal(state, job.id)
  if (playerTrainingJobs(next).some((candidate) => candidate.id === job.id)) return next
  const modelId = job.mode === 'continue' && job.continueFromId
    ? job.continueFromId
    : `model-${state.day}-${job.id}`
  const finalCheckpoint: ModelCheckpoint = {
    id: seededId('checkpoint', state.seed, program.id, 'final'),
    progress: 1,
    day: state.day,
    stability: checkpointStability(state, job, 1),
    reusable: true,
    trainingNumerics:
      job.trainingNumerics ?? job.numerics ?? LEGACY_TRAINING_NUMERICS,
  }

  next = {
    ...next,
    player: {
      ...next.player,
      models: next.player.models.map((model) =>
        model.id === modelId
          ? {
              ...model,
              dataManifestId: program.dataManifestId ?? undefined,
              integratedMethods: [...program.integratedMethods],
            }
          : model,
      ),
      trainingPrograms: (next.player.trainingPrograms ?? []).map((candidate) =>
        candidate.id === program.id
          ? {
              ...candidate,
              checkpoints: candidate.checkpoints.some((checkpoint) => checkpoint.progress >= 1)
                ? candidate.checkpoints
                : [...candidate.checkpoints, finalCheckpoint],
              confidence: Math.max(candidate.confidence, 0.95),
            }
          : candidate,
      ),
      researchPods: (next.player.researchPods ?? []).map((pod) =>
        program.assignedPodIds.includes(pod.id) && pod.assignmentId === program.id
          ? { ...pod, assignmentId: null }
          : pod,
      ),
    },
  }
  return next
}
