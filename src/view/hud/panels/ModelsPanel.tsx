import { useEffect, useMemo, useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import { useUiStore } from '../../../store/uiStore'
import type {
  BenchmarkSuiteId,
  DataDomain,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelProductPreset,
  NativeWeightFormat,
  SafetyCampaignIntensity,
  TrainMode,
  TrainingComputeFormat,
} from '../../../sim/types'
import {
  PARAM_PRESETS,
  estimateTrainDays,
  estimateTrainingRun,
  formatParams,
  recommendedChips,
} from '../../../sim/balance/training'
import {
  estimateTrainingMemoryGb,
  TRAINING_PRECISION_PROFILES,
} from '../../../sim/balance/trainingPrecision'
import {
  familyFromSpec,
  forecastTrainingV3,
  ioForPreset,
} from '../../../sim/balance/trainingV3'
import { ECONOMY } from '../../../sim/balance/economy'
import {
  DATA_DOMAINS,
  defaultDataWeights,
  formatTokens,
  minDataMTokForParams,
  recommendedDataMTok,
} from '../../../sim/balance/data'
import {
  ensureLabData,
  newDataSinceModel,
  totalProcessed,
} from '../../../sim/systems/data'
import { serveInfraCost } from '../../../sim/balance/pricing'
import { energyPriceForState } from '../../../sim/systems/map'
import { computeSnapshot } from '../../../sim/tick'
import { money, num } from '../format'
import { SizeSlider } from '../ui/SizeSlider'
import { ResearchUnlockLink } from '../ui/ResearchUnlockLink'
import { modelTrainVramGb } from '../../../sim/balance/racks'
import { resolveModelIteration } from '../modelNaming'
import {
  defaultModelStack,
  modelStackModifiers,
  modelStackModulesForFamily,
  sanitizeModelStack,
} from '../../../sim/balance/modelStack'
import {
  normalizeModelEvaluations,
} from '../../../sim/balance/evaluationSuites'
import { safetyCampaignEstimate } from '../../../sim/systems/safetyCampaigns'
import { playerStaff } from '../../../sim/systems/staff'
import { RadarChart } from '../ui/RadarChart'
import { TrainingDataRadar } from '../ui/TrainingDataRadar'
import { syntheticTrainingProfile } from '../../../sim/balance/syntheticTraining'
import { PanelScaffold, HudButton, MetricTile, StatusChip } from '../ui/HudPrimitives'
import {
  BlockerList,
  CardGrid,
  GameCard,
  SegmentedTabs,
  type Blocker,
} from '../ui/kit'
import { ActiveTrainingCard } from './models/ActiveTrainingCard'
import { FleetTab } from './models/FleetTab'
import { SafetyCampaignSection } from './models/SafetyCampaignSection'

const TRAINING_FORMAT_OPTIONS: ReadonlyArray<{
  value: TrainingComputeFormat
  research?: string
}> = [
  { value: 'fp32' },
  { value: 'fp16_mixed' },
  { value: 'bf16_mixed', research: 'opt_mixed' },
  { value: 'fp8_hybrid', research: 'opt_fp8_train' },
  { value: 'nvfp4', research: 'opt_nvfp4_train' },
]

const MODE_META: Record<TrainMode, { label: string; hint: string }> = {
  pretrain: { label: 'Pretrain', hint: 'Train a new model from scratch on your corpus.' },
  continue: { label: 'Continue', hint: 'Keep training an existing checkpoint on new data.' },
  distill: { label: 'Distill', hint: 'Compress a teacher model into a smaller student.' },
}

function bestRecipeWeights(
  family: ModelFamily,
  dataMTok: number,
  labData: ReturnType<typeof ensureLabData>,
): Record<DataDomain, number> {
  const ideal = defaultDataWeights(family)
  const adjusted = { ...ideal }
  for (const domain of DATA_DOMAINS) {
    const stock = labData.stocks[domain]
    const available = Math.max(0, stock.processed)
    const required = Math.max(1, dataMTok * ideal[domain])
    const coverage = Math.min(1, available / required)
    const modalityFloor = domain === 'image' || domain === 'video' || domain === 'audio'
      ? ideal[domain] * 0.55
      : ideal[domain] * 0.35
    adjusted[domain] = Math.max(modalityFloor, ideal[domain] * (0.55 + coverage * 0.45))
  }
  const sum = DATA_DOMAINS.reduce((total, domain) => total + adjusted[domain], 0)
  return Object.fromEntries(DATA_DOMAINS.map((domain) => [domain, adjusted[domain] / sum])) as Record<DataDomain, number>
}

function parseSizeInput(value: string, unit: 'M' | 'B' | 'T'): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 1
  if (unit === 'T') return n * 1000
  if (unit === 'M') return n / 1000
  return n
}

function applyParamsB(paramsB: number): { val: string; unit: 'M' | 'B' | 'T' } {
  if (paramsB >= 1000) return { val: String(paramsB / 1000), unit: 'T' }
  if (paramsB >= 1) return { val: String(paramsB), unit: 'B' }
  return { val: String(paramsB * 1000), unit: 'M' }
}

function frontierForSuite(models: Model[], suiteId: BenchmarkSuiteId) {
  const scores: Partial<Record<import('../../../sim/types').BenchmarkMetricId, number>> = {}
  for (const model of models) {
    for (const [id, score] of Object.entries(model.benchmarkSuites?.[suiteId] ?? {})) {
      scores[id as import('../../../sim/types').BenchmarkMetricId] = Math.max(
        scores[id as import('../../../sim/types').BenchmarkMetricId] ?? 0,
        score ?? 0,
      )
    }
  }
  return scores
}

export function ModelsPanel() {
  const state = useGameStore((s) => s.state)
  const startTraining = useGameStore((s) => s.startTraining)
  const setTrainingPriority = useGameStore((s) => s.setTrainingPriority)
  const pauseTraining = useGameStore((s) => s.pauseTraining)
  const cancelTraining = useGameStore((s) => s.cancelTraining)
  const selectPostTrain = useGameStore((s) => s.selectPostTrain)
  const benchmarkTrainingJob = useGameStore((s) => s.benchmarkTrainingJob)
  const keepInternal = useGameStore((s) => s.keepInternal)
  const releaseFromJob = useGameStore((s) => s.releaseFromJob)
  const releaseModel = useGameStore((s) => s.releaseModel)
  const deleteModel = useGameStore((s) => s.deleteModel)
  const setActiveModel = useGameStore((s) => s.setActiveModel)
  const setModelApiInOut = useGameStore((s) => s.setModelApiInOut)
  const applyModelApiMarkup = useGameStore((s) => s.applyModelApiMarkup)
  const startSafetyCampaign = useGameStore((s) => s.startSafetyCampaign)
  const cancelSafetyCampaign = useGameStore((s) => s.cancelSafetyCampaign)
  const apiMarkupPct = useGameStore((s) => s.state.player.pricing.apiMarkupPct)
  const openResearchNode = useGameStore((s) => s.openResearchNode)
  const announceRelease = useUiStore((s) => s.announceRelease)
  const snap = computeSnapshot(state)
  const infra = serveInfraCost(state, snap, energyPriceForState(state))

  const [panelTab, setPanelTab] = useState<'train' | 'fleet'>('train')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [name, setName] = useState('Spark')
  const [backbone, setBackbone] = useState<ModelBackbone>('dense')
  const [productPreset, setProductPreset] = useState<ModelProductPreset>('language')
  const [sizeVal, setSizeVal] = useState('1')
  const [sizeUnit, setSizeUnit] = useState<'M' | 'B' | 'T'>('B')
  const [activeVal, setActiveVal] = useState('8')
  const [activeUnit, setActiveUnit] = useState<'M' | 'B' | 'T'>('B')
  const [mode, setMode] = useState<TrainMode>('pretrain')
  const [teacherId, setTeacherId] = useState('')
  const [teacherShare, setTeacherShare] = useState(0.72)
  const [continueFromId, setContinueFromId] = useState('')
  const [realDataMTok, setRealDataMTok] = useState(500)
  const [syntheticMultiplier, setSyntheticMultiplier] = useState(0)
  const [trainShare, setTrainShare] = useState(0.82)
  const [weights, setWeights] = useState<Record<DataDomain, number>>(() => defaultDataWeights('dense'))
  const [allowSynthetic, setAllowSynthetic] = useState(true)
  const [includeSynthHQ, setIncludeSynthHQ] = useState(true)
  const [includeSynthLQ, setIncludeSynthLQ] = useState(false)
  const [syntheticTeacherIds, setSyntheticTeacherIds] = useState<Partial<Record<DataDomain, string>>>({})
  const [modelStack, setModelStack] = useState<string[]>(() =>
    defaultModelStack(state.player.researchUnlocked, 'dense'),
  )
  const [benchmarkSuite, setBenchmarkSuite] = useState<BenchmarkSuiteId>('language')
  const [safetyIntensity, setSafetyIntensity] = useState<SafetyCampaignIntensity>('standard')
  const [safetyResearchers, setSafetyResearchers] = useState(1)
  const [trainingFormat, setTrainingFormat] = useState<TrainingComputeFormat>('fp16_mixed')
  const [nativeWeightFormat, setNativeWeightFormat] = useState<NativeWeightFormat>('float')
  const [computePriority, setComputePriority] = useState(50)

  const paramsB = parseSizeInput(sizeVal, sizeUnit)
  const family = familyFromSpec(backbone, productPreset)
  const activeParamsB = backbone === 'moe' ? parseSizeInput(activeVal, activeUnit) : undefined
  const modelIo = useMemo(() => ioForPreset(productPreset), [productPreset])

  const unlocked = state.player.researchUnlocked
  const stackModules = useMemo(() => modelStackModulesForFamily(family), [family])
  const selectedStack = useMemo(
    () => sanitizeModelStack(modelStack, unlocked, family),
    [modelStack, unlocked, family],
  )
  const stackModifiers = useMemo(
    () => modelStackModifiers(selectedStack, family),
    [selectedStack, family],
  )
  const familyUnlocked = useMemo(() => {
    return (f: ModelFamily): boolean => {
      if (f === 'dense' || f === 'embedding') return true
      if (f === 'moe') return unlocked.includes('moe_basics')
      if (f === 'diffusion') return unlocked.includes('mm_vision') || unlocked.includes('mm_diff')
      if (f === 'video') return unlocked.includes('mm_video')
      if (f === 'omni') return unlocked.includes('mm_omni')
      return true
    }
  }, [unlocked])
  const productUnlocked = useMemo(() => {
    return (preset: ModelProductPreset): boolean => {
      if (preset === 'language') return true
      if (preset === 'vision_language' || preset === 'audio') return unlocked.includes('mm_vision')
      if (preset === 'image_generation') return unlocked.includes('mm_diff')
      if (preset === 'video_generation') return unlocked.includes('mm_video')
      if (preset === 'omni') return unlocked.includes('mm_omni')
      return false
    }
  }, [unlocked])
  const mixUnlocked = unlocked.includes('data_mix')
  const synthUnlocked = unlocked.includes('data_synth')
  const effectiveSyntheticMultiplier = allowSynthetic && synthUnlocked ? syntheticMultiplier : 0
  const dataMTok = realDataMTok * (1 + effectiveSyntheticMultiplier)

  const teachers = state.player.models
  const modelIteration = useMemo(() => resolveModelIteration(teachers, name), [teachers, name])
  const jobs = state.player.trainingJobs?.length
    ? state.player.trainingJobs
    : state.player.trainingJob
      ? [state.player.trainingJob]
      : []
  const pricing = state.player.pricing
  const active = state.player.models.find((m) => m.id === pricing.activeModelId)
  const labData = ensureLabData(state)
  const trainParamsB =
    mode === 'continue'
      ? teachers.find((t) => t.id === continueFromId)?.paramsB ?? paramsB
      : paramsB
  const trainFamily =
    mode === 'continue'
      ? teachers.find((t) => t.id === continueFromId)?.family ?? family
      : family
  const minMTok = minDataMTokForParams(trainParamsB)
  const recData = recommendedDataMTok(trainParamsB, trainFamily)
  const processedAvail = totalProcessed(labData)
  const continueModel = teachers.find((t) => t.id === continueFromId)
  const priorTokens = continueModel?.dataTokensUsedMTok ?? 0
  const newSinceContinue = newDataSinceModel(state, continueModel)
  const recipePlan = useMemo(
    () => ({
      totalUnits: dataMTok,
      totalMTok: dataMTok,
      trainShare,
      weights,
      allowSynthetic: allowSynthetic && synthUnlocked,
      includeSynthHQ: includeSynthHQ && allowSynthetic && synthUnlocked,
      includeSynthLQ: includeSynthLQ && allowSynthetic && synthUnlocked,
      syntheticTeacherIds,
      syntheticMultiplier: effectiveSyntheticMultiplier,
    }),
    [
      dataMTok,
      trainShare,
      weights,
      allowSynthetic,
      synthUnlocked,
      includeSynthHQ,
      includeSynthLQ,
      syntheticTeacherIds,
      effectiveSyntheticMultiplier,
    ],
  )
  const trainingForecast = useMemo(
    () =>
      forecastTrainingV3({
        spec: {
          name: modelIteration.name,
          backbone,
          productPreset,
          paramsB: trainParamsB,
          activeParamsB,
          io: modelIo,
          dataPlan: recipePlan,
          mode,
          teacherId: mode === 'distill' ? teacherId || undefined : undefined,
          modelStack: selectedStack,
        },
        labData,
        dataQuality: state.player.dataQuality,
        trainEfficiency: state.player.trainEfficiency,
        trainPoolPf: snap.pools.training,
      }),
    [
      modelIteration.name,
      backbone,
      productPreset,
      trainParamsB,
      activeParamsB,
      modelIo,
      recipePlan,
      mode,
      teacherId,
      selectedStack,
      labData,
      state.player.dataQuality,
      state.player.trainEfficiency,
      snap.pools.training,
    ],
  )

  useEffect(() => {
    if (mode === 'continue') {
      setRealDataMTok(Math.max(1, Math.round(newSinceContinue || 50)))
      return
    }
    const target = Math.min(
      Math.max(minMTok, Math.min(recData, Math.max(processedAvail, minMTok))),
      Math.max(processedAvail * 1.5, recData * 2, minMTok),
    )
    setRealDataMTok(Math.round(Math.min(target, Math.max(1, processedAvail))))
  }, [
    minMTok,
    recData,
    processedAvail,
    trainParamsB,
    trainFamily,
    mode,
    continueFromId,
    newSinceContinue,
  ])

  useEffect(() => {
    if (mode !== 'continue' || !continueModel) return
    const next = applyParamsB(continueModel.paramsB)
    setSizeVal(next.val)
    setSizeUnit(next.unit)
    if (continueModel.activeParamsB != null) {
      const active = applyParamsB(continueModel.activeParamsB)
      setActiveVal(active.val)
      setActiveUnit(active.unit)
    }
    if (continueModel.backbone) setBackbone(continueModel.backbone)
    if (continueModel.productPreset) setProductPreset(continueModel.productPreset)
    setName(continueModel.name.replace(/\s+v\d+$/i, '') || continueModel.name)
  }, [mode, continueFromId, continueModel])

  const trainingRun = useMemo(() => {
    let estimate = estimateTrainingRun({
      paramsB:
        mode === 'continue'
          ? (teachers.find((t) => t.id === continueFromId)?.paramsB ?? paramsB)
          : paramsB,
      family:
        mode === 'continue'
          ? (teachers.find((t) => t.id === continueFromId)?.family ?? family)
          : family,
      trainEfficiency: state.player.trainEfficiency,
      activeParamsB,
      mode: mode === 'continue' ? 'pretrain' : mode === 'distill' ? 'distill' : 'pretrain',
      teacherParamsB: teachers.find((t) => t.id === teacherId)?.paramsB,
      trainingTokensMTok: dataMTok * trainShare,
      verificationTokensMTok: dataMTok * (1 - trainShare),
      modalityComputeMult: trainingForecast.modalityComputeMult * stackModifiers.trainCostMult,
    })
    if (mode === 'continue') {
      estimate = {
        ...estimate,
        trainingPfDays: estimate.trainingPfDays * 0.22,
        verificationPfDays: estimate.verificationPfDays * 0.22,
        physicalPfDays: estimate.physicalPfDays * 0.22,
        gamePfDays: estimate.gamePfDays * 0.22,
      }
    }
    return estimate
  }, [
    paramsB,
    family,
    state.player.trainEfficiency,
    activeParamsB,
    mode,
    teacherId,
    teachers,
    continueFromId,
    dataMTok,
    trainShare,
    trainingForecast.modalityComputeMult,
    stackModifiers.trainCostMult,
  ])

  const costPf = trainingRun.gamePfDays
  const upfront = Math.max(1_000, Math.floor(costPf * ECONOMY.trainUpfrontPerPfDay))
  const daysEst = estimateTrainDays(costPf, snap.pools.training)
  const recChips = recommendedChips(paramsB, family)
  const trainingMemory = useMemo(
    () =>
      estimateTrainingMemoryGb({
        paramsB: trainParamsB,
        activeParamsB,
        family,
        numerics: {
          computeFormat: trainingFormat,
          nativeWeightFormat,
          recipeVersion: 1,
        },
        activationCheckpointing: unlocked.includes('opt_checkpoint'),
      }),
    [trainParamsB, activeParamsB, family, trainingFormat, nativeWeightFormat, unlocked],
  )
  const needVramGb = Math.max(
    modelTrainVramGb(trainParamsB, activeParamsB, family),
    trainingMemory.totalGb,
  )
  const underProvisioned = snap.chipCount > 0 && snap.chipCount < recChips * 0.35
  const publicFrontier = Math.max(
    0,
    ...state.player.models
      .filter((model) => model.release === 'released' || model.shipped)
      .map((model) => model.capability),
    ...state.rivals.flatMap((rival) =>
      rival.models
        .filter((model) => model.release === 'released' || model.shipped)
        .map((model) => model.capability),
    ),
  )

  const internal = state.player.models.filter((m) => m.release === 'internal' || !m.shipped)
  const released = state.player.models.filter((m) => m.release === 'released' || m.shipped)

  const realVolMax = Math.max(1, processedAvail)
  const strongestTeacher = teachers.reduce<Model | null>(
    (best, candidate) => (!best || candidate.capability > best.capability ? candidate : best),
    null,
  )
  const syntheticTeacherCapability = DATA_DOMAINS.reduce((sum, domain) => {
    const selected = teachers.find((model) => model.id === syntheticTeacherIds[domain])
    return sum + ((selected ?? strongestTeacher)?.capability ?? 0) * (weights[domain] ?? 0)
  }, 0)
  const syntheticFrontierCapability = Math.max(
    syntheticTeacherCapability,
    ...state.player.models
      .filter((model) => model.release === 'released' || model.shipped)
      .map((model) => model.capability),
    ...state.rivals.flatMap((rival) =>
      rival.models
        .filter((model) => model.release === 'released' || model.shipped)
        .map((model) => model.capability),
    ),
  )
  const syntheticProfile = syntheticTrainingProfile({
    realMTok: Math.min(realDataMTok, processedAvail),
    syntheticMTok: Math.min(realDataMTok, processedAvail) * effectiveSyntheticMultiplier,
    teacherCapability: Number.isFinite(syntheticTeacherCapability) ? syntheticTeacherCapability : 0,
    frontierCapability: syntheticFrontierCapability,
  })
  const evaluatedActive = useMemo(
    () => (active ? normalizeModelEvaluations(active) : null),
    [active],
  )
  const safetyTarget = useMemo(() => {
    const campaign = state.player.safetyCampaign
    if (campaign) {
      const match = state.player.models.find((m) => m.id === campaign.modelId)
      if (match) return normalizeModelEvaluations(match)
    }
    if (active) return normalizeModelEvaluations(active)
    if (internal[0]) return normalizeModelEvaluations(internal[0])
    return null
  }, [state.player.safetyCampaign, state.player.models, active, internal])
  const availableSuites = useMemo(
    () =>
      evaluatedActive
        ? (Object.keys(evaluatedActive.benchmarkSuites ?? {}) as BenchmarkSuiteId[])
        : [],
    [evaluatedActive],
  )
  const activeSuite = availableSuites.includes(benchmarkSuite)
    ? benchmarkSuite
    : availableSuites[0] ?? 'language'
  const allPublicModels = [
    ...state.player.models.filter((model) => model.release === 'released' || model.shipped),
    ...state.rivals.flatMap((rival) =>
      rival.models.filter((model) => model.release === 'released' || model.shipped),
    ),
  ].map(normalizeModelEvaluations)
  const frontierComparison = frontierForSuite(allPublicModels, activeSuite)
  const researcherCount = playerStaff(state).researcher ?? 0
  const safetyEstimate = useMemo(
    () =>
      safetyTarget ? safetyCampaignEstimate(state, safetyTarget.id, safetyIntensity) : null,
    [state, safetyTarget, safetyIntensity],
  )

  useEffect(() => {
    if (availableSuites.length && !availableSuites.includes(benchmarkSuite)) {
      setBenchmarkSuite(availableSuites[0]!)
    }
  }, [availableSuites, benchmarkSuite])

  useEffect(() => {
    if (safetyEstimate) {
      setSafetyResearchers((current) =>
        Math.max(
          safetyEstimate.minimumResearchers,
          Math.min(Math.max(1, researcherCount), current),
        ),
      )
    }
  }, [safetyEstimate, researcherCount])

  const blockers = useMemo(() => {
    const items: Blocker[] = []
    if (!familyUnlocked(family)) {
      items.push({ text: 'Backbone family is locked — research the required unlock first.' })
    }
    if (!productUnlocked(productPreset)) {
      items.push({ text: 'Product / I/O preset is locked — research the required unlock first.' })
    }
    if (state.player.cash < upfront) {
      items.push({
        text: `Need ${money(upfront)} upfront, have ${money(state.player.cash)}.`,
      })
    }
    if (mode === 'continue' && !continueFromId) {
      items.push({ text: 'Select a base internal model to continue training.' })
    }
    if (mode === 'continue' && continueFromId && newSinceContinue < 1) {
      items.push({
        text: 'Not enough new data since this checkpoint — collect more before continuing.',
        tone: 'warning',
      })
    }
    if (mode === 'distill' && !teacherId) {
      items.push({ text: 'Select a teacher model to distill from.' })
    }
    if (mode === 'distill' && teachers.length === 0) {
      items.push({ text: 'Train and keep a teacher model internal before distilling.' })
    }
    if (snap.pools.training < 0.05) {
      items.push({
        text: 'Training pool near zero — build compute and raise Training allocation.',
        tone: 'warning',
      })
    }
    if (needVramGb > snap.vramGb + 0.01) {
      items.push({
        text: `Need ${num(needVramGb, 0)} GB VRAM, have ${num(snap.vramGb, 0)} GB.`,
        tone: 'warning',
      })
    }
    if (underProvisioned) {
      items.push({
        text: `Accelerator fleet is light for this scale (have ${Math.floor(snap.chipCount)}, recommend ~${recChips}).`,
        tone: 'warning',
      })
    }
    for (const warning of trainingForecast.warnings.slice(0, 2)) {
      items.push({ text: warning, tone: 'warning' })
    }
    return items
  }, [
    familyUnlocked,
    productUnlocked,
    family,
    productPreset,
    state.player.cash,
    upfront,
    mode,
    continueFromId,
    newSinceContinue,
    teacherId,
    teachers.length,
    snap.pools.training,
    needVramGb,
    snap.vramGb,
    underProvisioned,
    snap.chipCount,
    recChips,
    trainingForecast.warnings,
  ])

  const hardBlocked = blockers.some((item) => item.tone !== 'warning')
  const canStart = !hardBlocked && familyUnlocked(family) && productUnlocked(productPreset)

  const prefillContinue = (model: Model) => {
    setPanelTab('train')
    setMode('continue')
    setContinueFromId(model.id)
    setName(model.name.replace(/\s+v\d+$/i, '') || model.name)
    const next = applyParamsB(model.paramsB)
    setSizeVal(next.val)
    setSizeUnit(next.unit)
  }

  const prefillDistill = (model: Model) => {
    setPanelTab('train')
    setMode('distill')
    setTeacherId(model.id)
    setName(`${model.name.replace(/\s+v\d+$/i, '') || model.name}-d`)
  }

  const handleReleaseModel = (id: string) => {
    const model = state.player.models.find((m) => m.id === id)
    releaseModel(id)
    if (model) announceRelease({ name: model.name, capability: model.capability })
  }

  const handleReleaseFromJob = (jobId: string) => {
    const job = jobs.find((j) => j.id === jobId)
    const matched = job
      ? state.player.models.find((m) => m.name === job.name)
      : undefined
    releaseFromJob(jobId)
    if (job) {
      announceRelease({
        name: job.name,
        capability: matched?.capability ?? trainingForecast.expectedCapability ?? 0,
      })
    }
  }


  const forecastVerdict = (() => {
    const gap = trainingForecast.expectedCapability - publicFrontier
    if (publicFrontier <= 0) return 'No public peer yet — this run sets your first bar.'
    if (gap >= 2) return `Likely ahead of the public frontier by +${gap.toFixed(1)} cap.`
    if (gap >= -1) return 'Roughly matches the current public frontier.'
    return `Trails the public frontier by ${Math.abs(gap).toFixed(1)} cap.`
  })()

  return (
    <PanelScaffold
      title="Models"
      eyebrow="Training · Fleet"
      description="Pick a mode, set the recipe, launch the run — then manage the fleet."
    >
      {jobs.map((job) => (
        <div key={job.id} className="mb-3">
          <ActiveTrainingCard
            job={job}
            trainingPoolPf={snap.pools.training}
            jobs={jobs}
            unlocked={unlocked}
            day={state.day}
            onPriority={(jobId, priority, reservedPf) =>
              setTrainingPriority(jobId, priority, reservedPf)
            }
            onPause={(jobId, paused) => pauseTraining(jobId, paused)}
            onCancel={(jobId) => cancelTraining(jobId)}
            onRelease={(jobId) => handleReleaseFromJob(jobId)}
            onBenchmark={(jobId) => benchmarkTrainingJob(jobId)}
            onKeepInternal={(jobId) => keepInternal(jobId)}
            onSelectPostTrain={(jobId, stage) => selectPostTrain(jobId, stage)}
            safetyProps={
              job.progressPfDays >= job.targetPfDays && !job.failed
                ? {
                    model:
                      state.player.models.find((m) => m.name === job.name) ??
                      safetyTarget,
                    campaign:
                      state.player.safetyCampaign?.modelName === job.name
                        ? state.player.safetyCampaign
                        : null,
                    intensity: safetyIntensity,
                    setIntensity: setSafetyIntensity,
                    researchers: safetyResearchers,
                    setResearchers: setSafetyResearchers,
                    researcherCount,
                    estimate: safetyEstimate,
                    onStart: () => {
                      const target =
                        state.player.models.find((m) => m.name === job.name) ??
                        safetyTarget
                      if (target) {
                        startSafetyCampaign(
                          target.id,
                          safetyIntensity,
                          safetyResearchers,
                        )
                      }
                    },
                    onCancel: cancelSafetyCampaign,
                  }
                : undefined
            }
          />
        </div>
      ))}

      <div className="mb-3">
        <SegmentedTabs
          ariaLabel="Models views"
          active={panelTab}
          onChange={(id) => setPanelTab(id as 'train' | 'fleet')}
          items={[
            { id: 'train', label: 'Train' },
            {
              id: 'fleet',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Fleet
                  <span className="font-mono text-[0.625rem] text-muted">
                    {internal.length + released.length}
                  </span>
                </span>
              ),
            },
          ]}
        />
      </div>

      <div key={panelTab} className="panel-swap space-y-3">
        {panelTab === 'train' ? (
          <>
            <GameCard eyebrow="1 · Mode" title="How do you want to train?" tone="train">
              <div className="grid gap-2 sm:grid-cols-3">
                {(['pretrain', 'continue', 'distill'] as TrainMode[]).map((option) => {
                  const locked =
                    (option === 'continue' || option === 'distill') && teachers.length === 0
                  const on = mode === option
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={locked}
                      title={
                        locked
                          ? 'Need an existing model first'
                          : MODE_META[option].hint
                      }
                      onClick={() => setMode(option)}
                      className={`rounded-md border px-3 py-2.5 text-left transition ${
                        on
                          ? 'border-train/50 bg-train/10'
                          : 'border-line/70 bg-void/30 hover:border-train/30'
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      <span className="block text-sm font-semibold text-bone">
                        {MODE_META[option].label}
                      </span>
                      <span className="mt-0.5 block text-[0.75rem] text-muted">
                        {MODE_META[option].hint}
                      </span>
                    </button>
                  )
                })}
              </div>
            </GameCard>

            <GameCard
              eyebrow="2 · Lineage"
              title={mode === 'pretrain' ? 'Name & family' : 'Base model'}
            >
              <div className="space-y-2.5">
                {mode === 'continue' ? (
                  <label className="block text-[0.8125rem] text-muted">
                    Continue from
                    <select
                      value={continueFromId}
                      onChange={(e) => setContinueFromId(e.target.value)}
                      className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
                    >
                      <option value="">Select model…</option>
                      {teachers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {formatParams(t.paramsB)} · cap {t.capability.toFixed(0)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {mode === 'distill' ? (
                  <div className="space-y-2 rounded-md border border-research/30 bg-research/5 p-2.5">
                    <label className="block text-[0.8125rem] text-muted">
                      Teacher
                      <select
                        value={teacherId}
                        onChange={(e) => setTeacherId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
                      >
                        <option value="">Select teacher…</option>
                        {teachers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} · {formatParams(t.paramsB)} ·{' '}
                            {t.release === 'internal' ? 'internal' : 'public'} · cap{' '}
                            {t.capability.toFixed(0)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-[0.8125rem] text-muted">
                      Distill mix · teacher {Math.round(teacherShare * 100)}%
                      <input
                        type="range"
                        min={5}
                        max={95}
                        step={1}
                        value={Math.round(teacherShare * 100)}
                        onChange={(e) => setTeacherShare(Number(e.target.value) / 100)}
                        className="mt-1 w-full"
                      />
                    </label>
                  </div>
                ) : null}

                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                  <label className="block text-[0.8125rem] text-muted">
                    Model name
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none focus:border-mint/50"
                      aria-label="Model family name"
                    />
                  </label>
                  <div className="rounded-md border border-mint/25 bg-mint/5 px-2.5 py-1.5 text-right">
                    <div className="hud-eyebrow">Iteration {modelIteration.iteration}</div>
                    <div
                      className="max-w-40 truncate text-xs font-medium text-mint"
                      title={modelIteration.name}
                    >
                      {modelIteration.name}
                    </div>
                  </div>
                </div>
              </div>
            </GameCard>

            <GameCard eyebrow="3 · Recipe" title="Size, data mix & volume" tone="train">
              <div className="space-y-3">
                <div className="rounded-md border border-line/60 bg-void/25 p-2.5">
                  <SizeSlider
                    label={family === 'moe' ? 'Total size' : 'Model size'}
                    value={paramsB}
                    disabled={mode === 'continue'}
                    disabledReason={
                      mode === 'continue'
                        ? 'Size is locked during continuation — it inherits the base checkpoint.'
                        : undefined
                    }
                    onChange={(p) => {
                      const next = applyParamsB(p)
                      setSizeVal(next.val)
                      setSizeUnit(next.unit)
                      if (family === 'moe') {
                        const act = Math.min(p, Math.max(0.1, p * 0.1))
                        const a = applyParamsB(act)
                        setActiveVal(a.val)
                        setActiveUnit(a.unit)
                      }
                    }}
                  />
                  {family === 'moe' && mode !== 'continue' ? (
                    <div className="mt-2">
                      <SizeSlider
                        label={`Active params (${
                          paramsB > 0
                            ? (((activeParamsB ?? 0) / paramsB) * 100).toFixed(0)
                            : 0
                        }% of total)`}
                        value={activeParamsB ?? 1}
                        onChange={(p) => {
                          const capped = Math.min(paramsB, Math.max(0.01, p))
                          const a = applyParamsB(capped)
                          setActiveVal(a.val)
                          setActiveUnit(a.unit)
                        }}
                        max={paramsB}
                        min={0.01}
                        stops={PARAM_PRESETS.filter((p) => p.paramsB <= paramsB).map((p) => ({
                          label: p.label,
                          paramsB: p.paramsB,
                        }))}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="rounded-md border border-mint/25 bg-mint/5 p-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span className="hud-eyebrow">Training volume</span>
                      <strong className="block font-mono text-base text-bone">
                        {formatTokens(dataMTok)} total
                      </strong>
                    </div>
                    <div className="text-right font-mono text-[0.6875rem]">
                      <span className="text-mint">
                        {formatTokens(syntheticProfile.realMTok)} real
                      </span>
                      <span className="mx-1 text-muted">+</span>
                      <span className="text-research">
                        {formatTokens(syntheticProfile.syntheticMTok)} synth
                      </span>
                    </div>
                  </div>
                  <p className="mt-1 text-[0.75rem] text-muted">
                    {mode === 'continue' ? (
                      <>
                        New since checkpoint:{' '}
                        <strong className="text-mint">{formatTokens(newSinceContinue)}</strong>
                        {priorTokens > 0 ? (
                          <> · lifetime on weights {formatTokens(priorTokens)}</>
                        ) : null}
                      </>
                    ) : (
                      <>
                        Corpus {formatTokens(processedAvail)} · min {formatTokens(minMTok)} ·
                        suggested {formatTokens(recData)}
                      </>
                    )}
                  </p>
                  <label className="mt-2 block text-[0.8125rem] text-muted">
                    Real corpus · {formatTokens(Math.min(realDataMTok, processedAvail))}
                    <input
                      type="range"
                      min={1}
                      max={Math.max(
                        1,
                        Math.round(
                          mode === 'continue'
                            ? Math.max(1, newSinceContinue)
                            : realVolMax,
                        ),
                      )}
                      step={Math.max(1, Math.round(realVolMax / 200))}
                      value={Math.min(
                        mode === 'continue'
                          ? Math.max(1, newSinceContinue)
                          : realVolMax,
                        Math.max(1, realDataMTok),
                      )}
                      onChange={(event) => setRealDataMTok(Number(event.target.value))}
                      className="mt-1 w-full"
                    />
                  </label>
                  <label className="mt-2 block text-[0.8125rem] text-muted">
                    Synthetic expansion · {effectiveSyntheticMultiplier.toFixed(1)}×
                    <input
                      type="range"
                      min={0}
                      max={3}
                      step={0.1}
                      value={effectiveSyntheticMultiplier}
                      disabled={!synthUnlocked || !strongestTeacher}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setSyntheticMultiplier(value)
                        setAllowSynthetic(value > 0)
                        if (value > 0) setIncludeSynthHQ(true)
                      }}
                      className="mt-1 w-full"
                    />
                  </label>
                  <label className="mt-2 block text-[0.8125rem] text-muted">
                    Train {Math.round(trainShare * 100)}% / Verify{' '}
                    {Math.round((1 - trainShare) * 100)}%
                    <input
                      type="range"
                      min={40}
                      max={95}
                      step={1}
                      value={Math.round(trainShare * 100)}
                      onChange={(e) => setTrainShare(Number(e.target.value) / 100)}
                      className="mt-1 w-full"
                    />
                  </label>
                  {!mixUnlocked ? (
                    <ResearchUnlockLink
                      className="mt-2"
                      nodeId="data_mix"
                      label="Unlock automated Mixture Engineering"
                    />
                  ) : null}
                  {!synthUnlocked ? (
                    <ResearchUnlockLink
                      className="mt-1"
                      nodeId="data_synth"
                      label="Unlock Synthetic Generators"
                    />
                  ) : null}
                </div>

                <TrainingDataRadar
                  weights={weights}
                  totalMTok={dataMTok}
                  data={labData}
                  autoBalanceDisabled={!mixUnlocked}
                  teachers={teachers}
                  syntheticTeacherIds={syntheticTeacherIds}
                  includeSynthHQ={includeSynthHQ && synthUnlocked}
                  includeSynthLQ={includeSynthLQ && synthUnlocked}
                  onChange={setWeights}
                  onAutoBalance={() =>
                    setWeights(bestRecipeWeights(family, dataMTok, labData))
                  }
                  onTeacherChange={(domain, teacher) =>
                    setSyntheticTeacherIds((current) => ({ ...current, [domain]: teacher }))
                  }
                  onIncludeSynthHQChange={(value) => {
                    setAllowSynthetic(value || includeSynthLQ)
                    setIncludeSynthHQ(value)
                  }}
                  onIncludeSynthLQChange={(value) => {
                    setAllowSynthetic(value || includeSynthHQ)
                    setIncludeSynthLQ(value)
                  }}
                />
              </div>
            </GameCard>

            <GameCard
              eyebrow="4 · Advanced"
              title="Backbone, numerics & stack"
              actions={
                <HudButton
                  type="button"
                  variant="ghost"
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  {advancedOpen ? 'Hide' : 'Show'}
                </HudButton>
              }
            >
              {!advancedOpen ? (
                <p className="text-[0.8125rem] text-muted">
                  {backbone.toUpperCase()} · {productPreset.replaceAll('_', ' ')} ·{' '}
                  {TRAINING_PRECISION_PROFILES[trainingFormat].label}
                  {selectedStack.length
                    ? ` · ${selectedStack.length} stack modules`
                    : ''}
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[0.8125rem] text-muted">
                      Backbone
                      <select
                        value={backbone}
                        onChange={(e) => {
                          const next = e.target.value as ModelBackbone
                          setBackbone(next)
                          const nextPreset =
                            next === 'diffusion' &&
                            productPreset !== 'image_generation' &&
                            productPreset !== 'video_generation'
                              ? 'image_generation'
                              : productPreset
                          if (nextPreset !== productPreset) setProductPreset(nextPreset)
                          const nextFamily = familyFromSpec(next, nextPreset)
                          setWeights(defaultDataWeights(nextFamily))
                        }}
                        className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
                      >
                        <option value="dense">Dense</option>
                        <option value="moe" disabled={!familyUnlocked('moe')}>
                          MoE{!familyUnlocked('moe') ? ' · research Sparse Basics' : ''}
                        </option>
                        <option value="diffusion" disabled={!unlocked.includes('mm_diff')}>
                          Diffusion
                          {!unlocked.includes('mm_diff') ? ' · research Latent Diffusion' : ''}
                        </option>
                      </select>
                    </label>
                    <label className="block text-[0.8125rem] text-muted">
                      Product / I/O preset
                      <select
                        value={productPreset}
                        onChange={(e) => {
                          const next = e.target.value as ModelProductPreset
                          setProductPreset(next)
                          const nextBackbone =
                            next === 'image_generation' || next === 'video_generation'
                              ? 'diffusion'
                              : backbone
                          if (nextBackbone !== backbone) setBackbone(nextBackbone)
                          const nextFamily = familyFromSpec(nextBackbone, next)
                          setWeights(defaultDataWeights(nextFamily))
                          setRealDataMTok(
                            Math.min(processedAvail, recommendedDataMTok(paramsB, nextFamily)),
                          )
                        }}
                        className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
                      >
                        <option value="language">Language · text + tools</option>
                        <option
                          value="vision_language"
                          disabled={!productUnlocked('vision_language')}
                        >
                          Vision-language
                          {!productUnlocked('vision_language') ? ' · research Vision' : ''}
                        </option>
                        <option value="audio" disabled={!productUnlocked('audio')}>
                          Audio{!productUnlocked('audio') ? ' · research Vision encoders' : ''}
                        </option>
                        <option
                          value="image_generation"
                          disabled={!productUnlocked('image_generation')}
                        >
                          Image generation
                          {!productUnlocked('image_generation')
                            ? ' · research Diffusion'
                            : ''}
                        </option>
                        <option
                          value="video_generation"
                          disabled={!productUnlocked('video_generation')}
                        >
                          Video generation
                          {!productUnlocked('video_generation') ? ' · research Video' : ''}
                        </option>
                        <option value="omni" disabled={!productUnlocked('omni')}>
                          Omni{!productUnlocked('omni') ? ' · research Omni Stack' : ''}
                        </option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[0.8125rem] text-muted">
                      Compute format
                      <select
                        value={trainingFormat}
                        onChange={(event) => {
                          const next = event.target.value as TrainingComputeFormat
                          setTrainingFormat(next)
                          if (
                            nativeWeightFormat === 'ternary_1_58' &&
                            next !== 'bf16_mixed'
                          ) {
                            setNativeWeightFormat('float')
                          }
                        }}
                        className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
                      >
                        {TRAINING_FORMAT_OPTIONS.map((option) => {
                          const locked = Boolean(
                            option.research && !unlocked.includes(option.research),
                          )
                          return (
                            <option key={option.value} value={option.value} disabled={locked}>
                              {TRAINING_PRECISION_PROFILES[option.value].label}
                              {locked ? ' · research required' : ''}
                            </option>
                          )
                        })}
                      </select>
                    </label>
                    <label className="text-[0.8125rem] text-muted">
                      Native weights
                      <select
                        value={nativeWeightFormat}
                        onChange={(event) => {
                          const next = event.target.value as NativeWeightFormat
                          setNativeWeightFormat(next)
                          if (next === 'ternary_1_58') setTrainingFormat('bf16_mixed')
                        }}
                        className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
                      >
                        <option value="float">Float weights</option>
                        <option
                          value="ternary_1_58"
                          disabled={family !== 'dense' || !unlocked.includes('dense_bitnet')}
                        >
                          1.58-bit native / BitNet
                          {family !== 'dense' || !unlocked.includes('dense_bitnet')
                            ? ' · research + dense required'
                            : ''}
                        </option>
                      </select>
                    </label>
                  </div>

                  <div>
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-[0.8125rem] font-semibold text-bone">Model stack</h4>
                      <div className="flex flex-wrap gap-1 font-mono text-[0.625rem]">
                        <span className="rounded-full bg-mint/10 px-2 py-0.5 text-mint">
                          host −{Math.round((1 - stackModifiers.hostingMult) * 100)}%
                        </span>
                        <span className="rounded-full bg-infer/10 px-2 py-0.5 text-infer">
                          speed +{Math.round((stackModifiers.speedMult - 1) * 100)}%
                        </span>
                      </div>
                    </div>
                    <CardGrid min="10rem" className="anim-stagger">
                      {stackModules.map((module) => {
                        const available = unlocked.includes(module.id)
                        const selected = selectedStack.includes(module.id)
                        return (
                          <button
                            key={module.id}
                            type="button"
                            aria-pressed={available ? selected : undefined}
                            onClick={() => {
                              if (!available) {
                                openResearchNode(module.id)
                                return
                              }
                              setModelStack((current) =>
                                current.includes(module.id)
                                  ? current.filter((id) => id !== module.id)
                                  : [...current, module.id],
                              )
                            }}
                            className={`hover-lift rounded-md border p-2 text-left transition ${
                              selected
                                ? 'border-mint/40 bg-mint/10'
                                : available
                                  ? 'border-line bg-panel-2/70'
                                  : 'border-line/60 bg-void/45 opacity-65'
                            }`}
                          >
                            <span className="flex items-center justify-between gap-1 text-[0.75rem] font-medium text-bone">
                              {module.name}
                              <span
                                className={`font-mono text-[0.625rem] uppercase tracking-[0.12em] ${
                                  selected
                                    ? 'text-mint'
                                    : available
                                      ? 'text-muted'
                                      : 'text-amber'
                                }`}
                              >
                                {selected ? 'On' : available ? module.focus : 'Research'}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted">
                              {module.description}
                            </span>
                          </button>
                        )
                      })}
                    </CardGrid>
                  </div>
                </div>
              )}
            </GameCard>

            <GameCard eyebrow="5 · Launch" title="Forecast & start" tone="train">
              <div className="space-y-3">
                <label className="block text-[0.8125rem] text-muted">
                  Compute priority · {computePriority}/100
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={computePriority}
                    onChange={(event) => setComputePriority(Number(event.target.value))}
                    className="mt-1 w-full"
                  />
                </label>

                <div className="rounded-md border border-line/60 bg-void/35 p-3">
                  <p className="text-[0.8125rem] text-bone">{forecastVerdict}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <MetricTile
                      label="Calendar"
                      value={daysEst === Infinity ? 'No pool' : `${daysEst.toFixed(0)}d`}
                      tone={daysEst > 120 ? 'warning' : 'positive'}
                    />
                    <MetricTile
                      label="Upfront"
                      value={money(upfront)}
                      detail={`cash ${money(state.player.cash)}`}
                      tone={state.player.cash < upfront ? 'danger' : 'neutral'}
                    />
                    <MetricTile
                      label="Capability"
                      value={trainingForecast.expectedCapability.toFixed(1)}
                      detail={`${trainingForecast.interactiveTokPerSec.toFixed(0)} tok/s`}
                      tone="positive"
                    />
                    <MetricTile
                      label="Data coverage"
                      value={`${trainingForecast.effectiveDataRatio.toFixed(2)}×`}
                      detail={`modality ${trainingForecast.modalityComputeMult.toFixed(2)}×`}
                      tone={
                        trainingForecast.effectiveDataRatio < 0.85 ? 'warning' : 'neutral'
                      }
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusChip
                      tone={
                        trainingForecast.risk === 'high'
                          ? 'danger'
                          : trainingForecast.risk === 'medium'
                            ? 'warning'
                            : 'positive'
                      }
                    >
                      {trainingForecast.risk.toUpperCase()} RISK
                    </StatusChip>
                    <span className="font-mono text-[0.6875rem] text-muted">
                      {num(costPf, 1)} PF-days · {formatParams(trainParamsB)}
                    </span>
                  </div>
                </div>

                <BlockerList items={blockers} />

                <HudButton
                  type="button"
                  variant="primary"
                  disabled={!canStart}
                  title={
                    !canStart
                      ? blockers[0]
                        ? String(blockers[0].text)
                        : 'Cannot start'
                      : undefined
                  }
                  className="w-full"
                  onClick={() =>
                    startTraining({
                      name:
                        modelIteration.name ||
                        `${family}-${formatParams(paramsB)}${
                          mode === 'distill' ? '-d' : mode === 'continue' ? '-ct' : ''
                        }`,
                      family,
                      backbone,
                      productPreset,
                      io: modelIo,
                      paramsB,
                      activeParamsB,
                      mode,
                      teacherId: mode === 'distill' ? teacherId || undefined : undefined,
                      distillTeacherShare: mode === 'distill' ? teacherShare : undefined,
                      continueFromId:
                        mode === 'continue' ? continueFromId || undefined : undefined,
                      dataPlan: recipePlan,
                      modelStack: selectedStack,
                      trainingNumerics: {
                        computeFormat: trainingFormat,
                        nativeWeightFormat,
                        recipeVersion: 1,
                      },
                      computePriority,
                    })
                  }
                >
                  Start{' '}
                  {mode === 'distill'
                    ? 'distillation'
                    : mode === 'continue'
                      ? 'continue-train'
                      : 'training'}{' '}
                  · {money(upfront)}
                </HudButton>
              </div>
            </GameCard>

            {!jobs.length && safetyTarget ? (
              <SafetyCampaignSection
                model={safetyTarget}
                campaign={state.player.safetyCampaign}
                intensity={safetyIntensity}
                setIntensity={setSafetyIntensity}
                researchers={safetyResearchers}
                setResearchers={setSafetyResearchers}
                researcherCount={researcherCount}
                estimate={safetyEstimate}
                onStart={() =>
                  safetyTarget &&
                  startSafetyCampaign(safetyTarget.id, safetyIntensity, safetyResearchers)
                }
                onCancel={cancelSafetyCampaign}
              />
            ) : null}

            {evaluatedActive ? (
              <GameCard
                eyebrow="Evaluations"
                title={evaluatedActive.name}
                actions={
                  <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                    rev {evaluatedActive.revision ?? 1}
                  </span>
                }
              >
                <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Evaluation suites">
                  {availableSuites.map((suiteId) => (
                    <button
                      key={suiteId}
                      type="button"
                      role="tab"
                      aria-selected={activeSuite === suiteId}
                      onClick={() => setBenchmarkSuite(suiteId)}
                      className={`rounded-md px-2 py-1 text-[0.6875rem] transition ${
                        activeSuite === suiteId
                          ? 'bg-mint text-void'
                          : 'bg-void text-muted hover:text-bone'
                      }`}
                    >
                      {suiteId
                        .replace('_generation', '')
                        .replace('omni_overview', 'overview')
                        .replaceAll('_', ' ')}
                    </button>
                  ))}
                </div>
                <RadarChart
                  suiteId={activeSuite}
                  scores={evaluatedActive.benchmarkSuites?.[activeSuite] ?? {}}
                  profile={evaluatedActive.evaluationProfile}
                  comparison={frontierComparison}
                />
              </GameCard>
            ) : null}
          </>
        ) : (
          <FleetTab
            internal={internal}
            released={released}
            pricingId={pricing.activeModelId}
            markupPct={apiMarkupPct}
            frontierCapability={publicFrontier}
            unitCostActive={infra.costPerMTok}
            activeModelRef={active ?? released[0] ?? null}
            onSelect={setActiveModel}
            onRelease={handleReleaseModel}
            onDelete={deleteModel}
            onPriceInOut={setModelApiInOut}
            onApplyMarkup={applyModelApiMarkup}
            onTrainFurther={prefillContinue}
            onDistill={prefillDistill}
            safetySlot={
              safetyTarget || state.player.safetyCampaign ? (
                <SafetyCampaignSection
                  model={safetyTarget}
                  campaign={state.player.safetyCampaign}
                  intensity={safetyIntensity}
                  setIntensity={setSafetyIntensity}
                  researchers={safetyResearchers}
                  setResearchers={setSafetyResearchers}
                  researcherCount={researcherCount}
                  estimate={safetyEstimate}
                  onStart={() =>
                    safetyTarget &&
                    startSafetyCampaign(
                      safetyTarget.id,
                      safetyIntensity,
                      safetyResearchers,
                    )
                  }
                  onCancel={cancelSafetyCampaign}
                />
              ) : null
            }
          />
        )}
      </div>
    </PanelScaffold>
  )
}
