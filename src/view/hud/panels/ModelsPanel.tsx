import { useEffect, useMemo, useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import type {
  BenchmarkSuiteId,
  DataDomain,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelProductPreset,
  SafetyCampaign,
  SafetyCampaignIntensity,
  TrainMode,
} from '../../../sim/types'
import {
  PARAM_PRESETS,
  estimateTrainDays,
  formatParams,
  recommendedChips,
  trainCostPfDays,
  trainingVolumeMultiplier,
} from '../../../sim/balance/training'
import {
  familyFromSpec,
  forecastTrainingV3,
  ioForPreset,
} from '../../../sim/balance/trainingV3'
import { ECONOMY } from '../../../sim/balance/economy'
import {
  DATA_DOMAIN_META,
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
import {
  apiModelKind,
  apiModelValueIndex,
  deriveApiUnitEconomics,
  serveInfraCost,
  type ApiUnitEconomics,
} from '../../../sim/balance/pricing'
import { energyPriceForState } from '../../../sim/systems/map'
import { computeSnapshot } from '../../../sim/tick'
import { money, num } from '../format'
import { SizeSlider } from '../ui/SizeSlider'
import { ResearchUnlockLink } from '../ui/ResearchUnlockLink'
import { modelTrainVramGb } from '../../../sim/balance/racks'
import { recentModelTemplates, resolveModelIteration } from '../modelNaming'
import {
  defaultModelStack,
  modelStackModifiers,
  modelStackModulesForFamily,
  sanitizeModelStack,
} from '../../../sim/balance/modelStack'
import {
  normalizeModelEvaluations,
  suiteComposite,
} from '../../../sim/balance/evaluationSuites'
import { safetyCampaignEstimate } from '../../../sim/systems/safetyCampaigns'
import { playerStaff } from '../../../sim/systems/staff'
import { RadarChart } from '../ui/RadarChart'
import { ApiEconomicsControl } from '../ui/ApiEconomicsControl'
import { TrainingDataRadar } from '../ui/TrainingDataRadar'
import { normalizedRadarWeights } from '../ui/trainingDataRadarMath'

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

export function ModelsPanel() {
  const state = useGameStore((s) => s.state)
  const startTraining = useGameStore((s) => s.startTraining)
  const advancePostTrain = useGameStore((s) => s.advancePostTrain)
  const keepInternal = useGameStore((s) => s.keepInternal)
  const releaseFromJob = useGameStore((s) => s.releaseFromJob)
  const releaseModel = useGameStore((s) => s.releaseModel)
  const deleteModel = useGameStore((s) => s.deleteModel)
  const setActiveModel = useGameStore((s) => s.setActiveModel)
  const setModelApiInOut = useGameStore((s) => s.setModelApiInOut)
  const startSafetyCampaign = useGameStore((s) => s.startSafetyCampaign)
  const cancelSafetyCampaign = useGameStore((s) => s.cancelSafetyCampaign)
  const openResearchNode = useGameStore((s) => s.openResearchNode)
  const snap = computeSnapshot(state)
  const energyPrice = energyPriceForState(state)
  const infra = serveInfraCost(state, snap, energyPrice)
  const rivalApiPeers = state.rivals.flatMap((rival) =>
    rival.models
      .filter((model) => model.release === 'released' || model.shipped)
      .map((model) => ({
        price:
          model.apiPriceInPerMTok != null && model.apiPriceOutPerMTok != null
            ? model.apiPriceInPerMTok * 0.3 + model.apiPriceOutPerMTok * 0.7
            : rival.pricing.apiPricePerMTok,
        capability: model.capability,
        featureScore: model.modalities.length * 18,
        tokPerSec: model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult,
        valueIndex: apiModelValueIndex(model),
        kind: apiModelKind(model),
      })),
  )
  const economicsForModel = (model: Model): ApiUnitEconomics => {
    const finance = state.lastMarket.modelFinance?.find((row) => row.modelId === model.id)
    return deriveApiUnitEconomics({
      state,
      snap,
      model,
      energyPricePerMWh: energyPrice,
      dayCogs: finance?.dayApiCogs,
      dayMTok: finance?.dayApiMTok,
      peers: rivalApiPeers,
    })
  }

  const [name, setName] = useState('Spark')
  const [backbone, setBackbone] = useState<ModelBackbone>('dense')
  const [productPreset, setProductPreset] = useState<ModelProductPreset>('language')
  const [sizeVal, setSizeVal] = useState('1')
  const [sizeUnit, setSizeUnit] = useState<'M' | 'B' | 'T'>('B')
  const [activeVal, setActiveVal] = useState('8')
  const [activeUnit, setActiveUnit] = useState<'M' | 'B' | 'T'>('B')
  const [mode, setMode] = useState<TrainMode>('pretrain')
  const [teacherId, setTeacherId] = useState('')
  /** Distill: fraction of signal from teacher (rest = your processed corpus). Default ~72% → ~80% retention. */
  const [teacherShare, setTeacherShare] = useState(0.72)
  const [continueFromId, setContinueFromId] = useState('')
  /** Training volume in MTok (million tokens) */
  const [dataMTok, setDataMTok] = useState(500)
  /** Share of volume for training (rest = verify/safety) */
  const [trainShare, setTrainShare] = useState(0.82)
  const [weights, setWeights] = useState<Record<DataDomain, number>>(() =>
    defaultDataWeights('dense'),
  )
  const [allowSynthetic, setAllowSynthetic] = useState(true)
  const [includeSynthHQ, setIncludeSynthHQ] = useState(true)
  const [includeSynthLQ, setIncludeSynthLQ] = useState(false)
  const [modelStack, setModelStack] = useState<string[]>(() =>
    defaultModelStack(state.player.researchUnlocked, 'dense'),
  )
  const [benchmarkSuite, setBenchmarkSuite] = useState<BenchmarkSuiteId>('language')
  const [safetyIntensity, setSafetyIntensity] = useState<SafetyCampaignIntensity>('standard')
  const [safetyResearchers, setSafetyResearchers] = useState(1)

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
  const familyUnlocked = (f: ModelFamily): boolean => {
    if (f === 'dense' || f === 'embedding') return true
    if (f === 'moe') return unlocked.includes('moe_basics')
    if (f === 'diffusion') return unlocked.includes('mm_vision') || unlocked.includes('mm_diff')
    if (f === 'video') return unlocked.includes('mm_video')
    if (f === 'omni') return unlocked.includes('mm_omni')
    return true
  }
  const productUnlocked = (preset: ModelProductPreset): boolean => {
    if (preset === 'language') return true
    if (preset === 'vision_language' || preset === 'audio') return unlocked.includes('mm_vision')
    if (preset === 'image_generation') return unlocked.includes('mm_diff')
    if (preset === 'video_generation') return unlocked.includes('mm_video')
    if (preset === 'omni') return unlocked.includes('mm_omni')
    return false
  }
  const mixUnlocked = unlocked.includes('data_mix')
  const synthUnlocked = unlocked.includes('data_synth')

  const teachers = state.player.models
  const modelIteration = useMemo(() => resolveModelIteration(teachers, name), [teachers, name])
  const previousTemplates = useMemo(() => recentModelTemplates(teachers), [teachers])
  const job = state.player.trainingJob
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
      weights: mixUnlocked ? weights : defaultDataWeights(family),
      allowSynthetic: allowSynthetic && synthUnlocked,
      includeSynthHQ: includeSynthHQ && allowSynthetic && synthUnlocked,
      includeSynthLQ: includeSynthLQ && allowSynthetic && synthUnlocked,
    }),
    [
      dataMTok,
      trainShare,
      mixUnlocked,
      weights,
      family,
      allowSynthetic,
      synthUnlocked,
      includeSynthHQ,
      includeSynthLQ,
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

  // Keep volume slider in sync with model size + available corpus
  useEffect(() => {
    if (mode === 'continue') {
      // Continue only uses data collected since last train — no 1:1 min
      setDataMTok(Math.max(1, Math.round(newSinceContinue || 50)))
      return
    }
    const target = Math.min(
      Math.max(minMTok, Math.min(recData, Math.max(processedAvail, minMTok))),
      Math.max(processedAvail * 1.5, recData * 2, minMTok),
    )
    setDataMTok(Math.round(target))
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

  const costPf = useMemo(() => {
    let base = trainCostPfDays({
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
    })
    if (mode === 'continue') base *= 0.22
    base *= trainingVolumeMultiplier(trainingForecast.effectiveDataRatio)
    base *= trainingForecast.modalityComputeMult
    base *= stackModifiers.trainCostMult
    return base
  }, [
    paramsB,
    family,
    state.player.trainEfficiency,
    activeParamsB,
    mode,
    teacherId,
    teachers,
    continueFromId,
    trainingForecast.effectiveDataRatio,
    trainingForecast.modalityComputeMult,
    stackModifiers.trainCostMult,
  ])

  const upfront = Math.floor(costPf * ECONOMY.trainUpfrontPerPfDay)

  const daysEst = estimateTrainDays(costPf, snap.pools.training)
  const recChips = recommendedChips(paramsB, family)
  const needVramGb = modelTrainVramGb(trainParamsB, activeParamsB, family)
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

  const radarWeights = normalizedRadarWeights(recipePlan.weights)
  const availableByDomain = Object.fromEntries(
    DATA_DOMAINS.map((domain) => [domain, labData.stocks[domain].processed]),
  ) as Record<DataDomain, number>
  const corpusOutcome = Object.fromEntries(DATA_DOMAINS.map((domain) => {
    const target = dataMTok * radarWeights[domain]
    const real = Math.min(target, availableByDomain[domain])
    const missing = Math.max(0, target - real)
    const syntheticQuality = includeSynthHQ && includeSynthLQ ? 0.68 : includeSynthHQ ? 0.86 : includeSynthLQ ? 0.46 : 0
    const synthetic = allowSynthetic && synthUnlocked ? missing : 0
    const fulfilledSignal = target > 0
      ? Math.min(1, (real + synthetic * syntheticQuality) / target)
      : 0
    const defaultShare = Math.max(0.01, defaultDataWeights(family)[domain])
    const focusSignal = Math.min(1, radarWeights[domain] / (defaultShare * 1.35))
    const score = trainingForecast.expectedCapability * 0.72 + fulfilledSignal * 18 + focusSignal * 10
    return [domain, Math.max(0, Math.min(100, score))]
  })) as Record<DataDomain, number>

  const volMax = Math.max(processedAvail * 2, recData * 2.5, minMTok * 2, 100)
  const shortfall = Math.max(0, dataMTok - processedAvail)
  const evaluatedActive = useMemo(() => active ? normalizeModelEvaluations(active) : null, [active])
  const availableSuites = useMemo(
    () => evaluatedActive
      ? (Object.keys(evaluatedActive.benchmarkSuites ?? {}) as BenchmarkSuiteId[])
      : [],
    [evaluatedActive],
  )
  const activeSuite = availableSuites.includes(benchmarkSuite)
    ? benchmarkSuite
    : availableSuites[0] ?? 'language'
  const allPublicModels = [
    ...state.player.models.filter((model) => model.release === 'released' || model.shipped),
    ...state.rivals.flatMap((rival) => rival.models.filter((model) => model.release === 'released' || model.shipped)),
  ].map(normalizeModelEvaluations)
  const frontierComparison = frontierForSuite(allPublicModels, activeSuite)
  const researcherCount = playerStaff(state).researcher ?? 0
  const safetyEstimate = useMemo(
    () => evaluatedActive
      ? safetyCampaignEstimate(state, evaluatedActive.id, safetyIntensity)
      : null,
    [state, evaluatedActive, safetyIntensity],
  )

  useEffect(() => {
    if (availableSuites.length && !availableSuites.includes(benchmarkSuite)) {
      setBenchmarkSuite(availableSuites[0]!)
    }
  }, [availableSuites, benchmarkSuite])

  useEffect(() => {
    if (safetyEstimate) {
      setSafetyResearchers((current) =>
        Math.max(safetyEstimate.minimumResearchers, Math.min(Math.max(1, researcherCount), current)),
      )
    }
  }, [safetyEstimate, researcherCount])

  return (
    <div className="space-y-3">
      <div>
        <h2 className="hud-panel-title">Models</h2>
        <p className="hud-panel-sub">Design the recipe, verify the corpus, size the run, then release it to production.</p>
      </div>

      {job ? (
        <div className="rounded-2xl border border-train/30 bg-train/5 p-3">
          <div className="flex justify-between gap-2 text-sm">
            <span className="font-medium text-bone">{job.name}</span>
            <span className="font-mono text-[0.8125rem] text-muted">
              {job.mode === 'distill'
                ? `distill · teacher ${Math.round((job.distillTeacherShare ?? 0.72) * 100)}%`
                : job.mode === 'continue'
                  ? 'continue'
                  : 'pretrain'}{' '}
              · {job.family}
            </span>
          </div>
          <p className="mt-1 font-mono text-[0.8125rem] text-muted">
            {job.family === 'moe'
              ? `${formatParams(job.targetParamsB)} total · ${formatParams(job.activeParamsB ?? 0)} active`
              : formatParams(job.targetParamsB)}{' '}
            · {formatTokens(job.trainMTok + job.verifyMTok || job.dataPlan?.totalMTok || job.dataPlan?.totalUnits || 0)}{' '}
            data (train {Math.round((job.trainShare ?? 0.82) * 100)}%) · Q
            {num(job.dataQualityUsed ?? 0, 0)} · target {num(job.targetPfDays, 0)} PF-days
            {job.cashBurnPerDay ? ` · burn ${money(job.cashBurnPerDay)}/d` : ''}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <RiskPill risk={job.outcomeRisk ?? 'medium'} />
            <span className="rounded-full border border-line bg-void/50 px-2 py-0.5 font-mono text-[0.6875rem] text-muted">
              effective data {(job.effectiveDataRatio ?? job.dataCoverage ?? 0).toFixed(2)}×
            </span>
            <span className="rounded-full border border-line bg-void/50 px-2 py-0.5 font-mono text-[0.6875rem] text-muted">
              modality compute {(job.modalityComputeMult ?? 1).toFixed(2)}×
            </span>
            <span className="text-[0.6875rem] text-muted">Outcome remains hidden until completion.</span>
          </div>
          {job.dataPlan && (
            <p className="mt-1 text-[0.75rem] text-muted">
              Mix:{' '}
              {DATA_DOMAINS.filter((d) => (job.dataPlan!.weights[d] ?? 0) >= 0.05)
                .map(
                  (d) =>
                    `${DATA_DOMAIN_META[d].label} ${Math.round((job.dataPlan!.weights[d] ?? 0) * 100)}%`,
                )
                .join(' · ')}
              {job.syntheticUnits > 0.05
                ? ` · synthetic ${num(job.syntheticUnits, 1)}u`
                : ''}
            </p>
          )}
          <Bar
            label="Base train"
            value={job.progressPfDays / job.targetPfDays}
            detail={`${num(job.progressPfDays, 1)} / ${num(job.targetPfDays, 1)}`}
          />
          {job.postTrain !== 'none' && (
            <Bar
              label={`Post-train: ${job.postTrain}`}
              value={job.postTrainTarget > 0 ? job.postTrainProgress / job.postTrainTarget : 0}
              detail={`${num(job.postTrainProgress, 1)} / ${num(job.postTrainTarget, 1)}`}
            />
          )}
          {snap.pools.training < 0.05 && (
            <p className="mt-2 text-[0.8125rem] text-danger">
              Train pool near zero — build compute and raise Training allocation.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={job.progressPfDays < job.targetPfDays}
              onClick={() => advancePostTrain()}
              className="rounded-full bg-research/20 px-3 py-1.5 text-xs text-research disabled:opacity-40"
            >
              Next post-train
            </button>
            <button
              type="button"
              disabled={job.progressPfDays < job.targetPfDays}
              onClick={() => keepInternal()}
              className="rounded-full border border-line px-3 py-1.5 text-xs text-bone disabled:opacity-40"
            >
              Keep internal
            </button>
            <button
              type="button"
              disabled={job.progressPfDays < job.targetPfDays}
              onClick={() => releaseFromJob()}
              className="rounded-full bg-mint px-3 py-1.5 text-xs font-medium text-void disabled:opacity-40"
            >
              Release public
            </button>
          </div>
          {job.progressPfDays >= job.targetPfDays && job.postTrain === 'sft' && !unlocked.includes('align_rlhf') ? (
            <ResearchUnlockLink className="mt-2" nodeId="align_rlhf" label="Unlock RLHF Pipeline for the next post-train stage" />
          ) : null}
          {job.progressPfDays >= job.targetPfDays && job.postTrain === 'rlhf' && !unlocked.includes('align_process') ? (
            <ResearchUnlockLink className="mt-2" nodeId="align_process" label="Unlock Process Reward Models for the next stage" />
          ) : null}
        </div>
      ) : (
        <div id="model-recipe" className="space-y-2.5 rounded-2xl border border-line bg-panel-2 p-3 scroll-mt-4">
          <div className="space-y-1.5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
              <label className="block text-xs text-muted">
                Model family
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none focus:border-mint/50"
                  aria-label="Model family name"
                />
              </label>
              <div className="rounded-lg border border-mint/25 bg-mint/5 px-2.5 py-1.5 text-right">
                <div className="font-mono text-[0.625rem] uppercase tracking-wider text-muted">
                  Iteration {modelIteration.iteration}
                </div>
                <div className="max-w-40 truncate text-xs font-medium text-mint" title={modelIteration.name}>
                  {modelIteration.name}
                </div>
              </div>
            </div>
            {previousTemplates.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 font-mono text-[0.625rem] uppercase tracking-wider text-muted">
                  Previous
                </span>
                {previousTemplates.map((template) => (
                  <button
                    key={template}
                    type="button"
                    onClick={() => setName(template)}
                    className={`rounded-full border px-2 py-0.5 text-[0.6875rem] transition ${
                      modelIteration.template.toLocaleLowerCase() === template.toLocaleLowerCase()
                        ? 'border-mint/40 bg-mint/10 text-mint'
                        : 'border-line bg-void/50 text-muted hover:border-mint/30 hover:text-bone'
                    }`}
                  >
                    {template}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted">
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
                  Diffusion{!unlocked.includes('mm_diff') ? ' · research Latent Diffusion' : ''}
                </option>
              </select>
            </label>
            <label className="block text-xs text-muted">
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
                  setDataMTok(recommendedDataMTok(paramsB, nextFamily))
                }}
                className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
              >
                <option value="language">Language · text + tools</option>
                <option value="vision_language" disabled={!productUnlocked('vision_language')}>
                  Vision-language{!productUnlocked('vision_language') ? ' · research Vision' : ''}
                </option>
                <option value="audio" disabled={!productUnlocked('audio')}>
                  Audio{!productUnlocked('audio') ? ' · research Vision encoders' : ''}
                </option>
                <option value="image_generation" disabled={!productUnlocked('image_generation')}>
                  Image generation{!productUnlocked('image_generation') ? ' · research Diffusion' : ''}
                </option>
                <option value="video_generation" disabled={!productUnlocked('video_generation')}>
                  Video generation{!productUnlocked('video_generation') ? ' · research Video' : ''}
                </option>
                <option value="omni" disabled={!productUnlocked('omni')}>
                  Omni{!productUnlocked('omni') ? ' · research Omni Stack' : ''}
                </option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-xl border border-line/60 bg-void/35 p-2">
            <label className="block text-xs text-muted">
              Training mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as TrainMode)}
                className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
              >
                <option value="pretrain">Pretrain</option>
                <option value="distill" disabled={teachers.length === 0}>
                  Distill{teachers.length === 0 ? ' · need a teacher model' : ''}
                </option>
                <option value="continue" disabled={teachers.length === 0}>
                  Continue-train{teachers.length === 0 ? ' · need a base model' : ''}
                </option>
              </select>
            </label>
            <div className="pb-1 text-right font-mono text-[0.6875rem] text-muted">
              <div>{backbone.toUpperCase()} · {productPreset.replaceAll('_', ' ')}</div>
              <div className="text-bone">
                IN {Object.keys(modelIo.inputs).join('+')} → OUT {Object.keys(modelIo.outputs).join('+')}
                {modelIo.tools > 0 ? ' + tools' : ''}
              </div>
            </div>
          </div>

          <section
            className="space-y-2 rounded-xl border border-line/70 bg-void/25 p-2.5"
            aria-labelledby="model-stack-title"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3
                  id="model-stack-title"
                  className="text-[0.75rem] font-medium uppercase tracking-wider text-muted"
                >
                  Model stack
                </h3>
                <p className="text-[0.6875rem] text-muted">
                  Integrate researched methods into these weights.
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1 font-mono text-[0.625rem]">
                <span className="rounded-full bg-mint/10 px-2 py-0.5 text-mint">
                  host −{Math.round((1 - stackModifiers.hostingMult) * 100)}%
                </span>
                <span className="rounded-full bg-serve/10 px-2 py-0.5 text-serve">
                  speed +{Math.round((stackModifiers.speedMult - 1) * 100)}%
                </span>
                <span className="rounded-full bg-train/10 px-2 py-0.5 text-train">
                  train {stackModifiers.trainCostMult <= 1 ? '−' : '+'}{Math.abs(Math.round((1 - stackModifiers.trainCostMult) * 100))}%
                </span>
                <span className="rounded-full bg-research/10 px-2 py-0.5 text-research">
                  cap +{stackModifiers.capabilityBonus.toFixed(1)}
                </span>
                {stackModifiers.reasoningEnabled && (
                  <span className="rounded-sm border border-research/30 bg-research/10 px-2 py-0.5 text-research">
                    reasoning enabled
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {stackModules.map((module) => {
                const available = unlocked.includes(module.id)
                const selected = selectedStack.includes(module.id)
                const effects = [
                  module.hostingMult < 1
                    ? `host −${Math.round((1 - module.hostingMult) * 100)}%`
                    : null,
                  module.speedMult > 1
                    ? `speed +${Math.round((module.speedMult - 1) * 100)}%`
                    : null,
                  module.trainCostMult < 1
                    ? `train −${Math.round((1 - module.trainCostMult) * 100)}%`
                    : module.trainCostMult > 1
                      ? `train +${Math.round((module.trainCostMult - 1) * 100)}%`
                    : null,
                  module.capabilityBonus > 0
                    ? `cap +${module.capabilityBonus.toFixed(1)}`
                    : null,
                  module.reasoningEnabled ? 'reasoning caps unlocked' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
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
                    className={`min-h-20 rounded-lg border p-2 text-left transition ${
                      selected
                        ? 'border-mint/40 bg-mint/10'
                        : available
                          ? 'border-line bg-panel-2/70 hover:border-mint/30'
                          : 'border-line/60 bg-void/45 opacity-65 hover:opacity-90'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-1 text-[0.75rem] font-medium text-bone">
                      {module.name}
                      <span
                        className={`font-mono text-[0.5625rem] uppercase tracking-wider ${
                          selected ? 'text-mint' : available ? 'text-muted' : 'text-amber'
                        }`}
                      >
                        {selected ? 'On' : available ? module.focus : 'Research'}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[0.625rem] leading-snug text-muted">
                      {module.description}
                    </span>
                    <span className="mt-1 block font-mono text-[0.5625rem] text-mint">
                      {effects}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <div id="model-data" className="scroll-mt-4 rounded-xl border border-mint/25 bg-mint/5 p-2.5">
            <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
              Training data
            </h3>
            <p className="mt-1 text-[0.75rem] leading-snug text-muted">
              {mode === 'continue' ? (
                <>
                  Full corpus stays for new pretrains:{' '}
                  <strong className="text-mint">{formatTokens(processedAvail)}</strong>
                  {' · '}
                  <strong className="text-bone">new since this model</strong>:{' '}
                  <strong className="text-mint">{formatTokens(newSinceContinue)}</strong>
                  {priorTokens > 0 && (
                    <>
                      {' · '}
                      lifetime on weights {formatTokens(priorTokens)}
                    </>
                  )}
                  {newSinceContinue < 1 && (
                    <span className="ml-1 text-amber">
                      — collect more data before continue-train helps
                    </span>
                  )}
                </>
              ) : (
                <>
                  Full corpus (reusable):{' '}
                  <strong className="text-mint">{formatTokens(processedAvail)}</strong>
                  {' · '}
                  min 1:1 = <strong className="text-bone">{formatTokens(minMTok)}</strong>
                  {' · '}
                  suggested {formatTokens(recData)}
                  <span className="block mt-0.5 text-muted">
                    Pretrain reads the whole library — stocks are not deleted after train.
                  </span>
                </>
              )}
            </p>
            <label className="mt-2 block text-xs text-muted">
              Volume: {formatTokens(dataMTok)}
              {mode !== 'continue' && dataMTok < minMTok && (
                <span className="ml-1 text-amber">(below 1:1 min — model will be under-trained)</span>
              )}
              {mode === 'continue' && dataMTok > newSinceContinue + 1 && (
                <span className="ml-1 text-amber">
                  · capped by new data (+ optional synth)
                </span>
              )}
              {mode !== 'continue' && shortfall > 1 && allowSynthetic && synthUnlocked && (
                <span className="ml-1 rounded-sm bg-amber/10 px-1.5 py-0.5 text-amber">
                  Synthetic required: {formatTokens(shortfall)} · automatic verifier
                </span>
              )}
              <input
                type="range"
                min={
                  mode === 'continue'
                    ? 1
                    : Math.max(10, Math.round(minMTok * 0.2))
                }
                max={Math.round(
                  mode === 'continue'
                    ? Math.max(newSinceContinue * 1.5, 100)
                    : volMax,
                )}
                step={Math.max(
                  1,
                  Math.round(
                    (mode === 'continue'
                      ? Math.max(newSinceContinue, 50)
                      : volMax) / 200,
                  ),
                )}
                value={Math.min(
                  mode === 'continue'
                    ? Math.max(newSinceContinue * 1.5, 100)
                    : volMax,
                  Math.max(1, dataMTok),
                )}
                onChange={(e) => setDataMTok(Number(e.target.value))}
                className="mt-1 w-full"
              />
            </label>
            <TokenRatioRail
              ratio={trainingForecast.effectiveDataRatio}
              omni={productPreset === 'omni'}
              repeatedEpochs={trainingForecast.repeatedDataEpochs}
            />
            <label className="mt-2 block text-xs text-muted">
              Train {Math.round(trainShare * 100)}% / Verify {Math.round((1 - trainShare) * 100)}%
              <input
                type="range"
                min={40}
                max={95}
                step={1}
                value={Math.round(trainShare * 100)}
                onChange={(e) => setTrainShare(Number(e.target.value) / 100)}
                className="mt-1 w-full"
              />
              <span className="mt-0.5 block text-[0.75rem] text-muted">
                More train → capability · more verify → safety / reliability
              </span>
            </label>
            <div className={`${!mixUnlocked ? 'opacity-75' : ''}`}>
              {!mixUnlocked && (
                <ResearchUnlockLink nodeId="data_mix" label="Unlock domain mix with Mixture Engineering" />
              )}
              <TrainingDataRadar
                weights={recipePlan.weights}
                dataMTok={dataMTok}
                available={availableByDomain}
                syntheticEnabled={allowSynthetic && synthUnlocked}
                includeSynthHQ={includeSynthHQ}
                includeSynthLQ={includeSynthLQ}
                outcome={corpusOutcome}
                disabled={!mixUnlocked}
                onChange={setWeights}
              />
            </div>

            <label
              className={`mt-2 flex items-center gap-2 text-[0.8125rem] ${
                synthUnlocked ? 'text-bone' : 'text-muted opacity-50'
              }`}
            >
              <input
                type="checkbox"
                checked={allowSynthetic && synthUnlocked}
                disabled={!synthUnlocked}
                onChange={(e) => setAllowSynthetic(e.target.checked)}
              />
              Use synthetic data in this train
              {!synthUnlocked && (
                <span className="text-[0.6875rem] text-amber">
                  — unlock Synthetic Generators (data: mix → clean → eval → synth)
                </span>
              )}
            </label>
            {synthUnlocked && allowSynthetic && (
              <div className="mt-1.5 space-y-1 pl-1">
                <label className="flex items-center gap-2 text-[0.8125rem] text-bone">
                  <input
                    type="checkbox"
                    checked={includeSynthHQ}
                    onChange={(e) => setIncludeSynthHQ(e.target.checked)}
                  />
                  Include <strong className="text-mint">HQ synth</strong> (helps quality)
                </label>
                <label className="flex items-center gap-2 text-[0.8125rem] text-bone">
                  <input
                    type="checkbox"
                    checked={includeSynthLQ}
                    onChange={(e) => setIncludeSynthLQ(e.target.checked)}
                  />
                  Include <strong className="text-danger">LQ synth</strong> (volume, can regress)
                </label>
              </div>
            )}
          </div>

          {mode === 'continue' && (
            <label className="block text-xs text-muted">
              Continue from
              <select
                value={continueFromId}
                onChange={(e) => setContinueFromId(e.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-void px-2 py-1.5 text-sm text-bone outline-none"
              >
                <option value="">Select model…</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · cap {t.capability.toFixed(0)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div id="model-scale" className="scroll-mt-4 rounded-xl border border-line/70 bg-void/25 p-3">
          <SizeSlider
            label={family === 'moe' ? 'Total size' : 'Model size'}
            value={paramsB}
            onChange={(p) => {
              const { val, unit } = applyParamsB(p)
              setSizeVal(val)
              setSizeUnit(unit)
              // Keep MoE active path reasonable when total jumps
              if (family === 'moe') {
                const act = Math.min(p, Math.max(0.1, p * 0.1))
                const a = applyParamsB(act)
                setActiveVal(a.val)
                setActiveUnit(a.unit)
              }
            }}
          />
          </div>

          {family === 'moe' && (
            <div>
              <SizeSlider
                label={`Active params (${paramsB > 0 ? (((activeParamsB ?? 0) / paramsB) * 100).toFixed(0) : 0}% of total)`}
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
              <p className="mt-1 text-[0.75rem] leading-snug text-muted">
                <strong className="text-bone">Total</strong> can be far larger than dense (experts).
                Train cost scales with total; <strong className="text-bone">hosting compute / PF</strong>{' '}
                and API cost scale with <strong className="text-bone">active</strong>. VRAM still
                holds most experts.
              </p>
            </div>
          )}

          {mode === 'distill' && (
            <div className="space-y-2 rounded-xl border border-research/30 bg-research/5 p-2.5">
              <label className="block text-xs text-muted">
                Teacher (internal or released)
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
                {teachers.length === 0 && (
                  <p className="mt-1 text-[0.75rem] text-amber">
                    Train a teacher first and Keep internal (or release).
                  </p>
                )}
              </label>
              <div>
                <div className="flex justify-between text-[0.8125rem]">
                  <span className="text-muted">Distill mix</span>
                  <span className="font-mono text-bone">
                    Teacher {Math.round(teacherShare * 100)}% · Own{' '}
                    {Math.round((1 - teacherShare) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={5}
                  max={95}
                  step={1}
                  value={Math.round(teacherShare * 100)}
                  onChange={(e) => setTeacherShare(Number(e.target.value) / 100)}
                  className="mt-1 w-full"
                />
                <div className="mt-0.5 flex justify-between text-[0.6875rem] text-muted">
                  <span>More your corpus</span>
                  <span>More teacher (~80% retention)</span>
                </div>
                <p className="mt-1.5 text-[0.75rem] leading-snug text-muted">
                  Teacher-heavy distill lands near ~80% of the teacher&apos;s capability and burns
                  less of your processed packs. Own-heavy uses your domain mix for specialty but
                  pulls less from the teacher.
                  {teacherId && teachers.find((t) => t.id === teacherId) && (
                    <>
                      {' '}
                      Est. cap ≈{' '}
                      <span className="font-mono text-bone">
                        {(
                          teachers.find((t) => t.id === teacherId)!.capability *
                            0.8 *
                            teacherShare +
                          teachers.find((t) => t.id === teacherId)!.capability *
                            0.35 *
                            (1 - teacherShare)
                        ).toFixed(0)}
                      </span>{' '}
                      (rough, before size/data gates).
                    </>
                  )}
                </p>
              </div>
            </div>
          )}

          <ForecastBoard
            capability={trainingForecast.expectedCapability}
            speed={trainingForecast.interactiveTokPerSec}
            risk={trainingForecast.risk}
            frontier={publicFrontier}
            pfDays={costPf}
            upfront={upfront}
            cash={state.player.cash}
            days={daysEst}
            dataRatio={trainingForecast.effectiveDataRatio}
            modalityCompute={trainingForecast.modalityComputeMult}
            vramNeed={needVramGb}
            vramHave={snap.vramGb}
            chipsNeed={recChips}
            chipsHave={snap.chipCount}
            powerNeed={snap.mwDemand}
            powerHave={snap.mwAvailable}
            warnings={[
              ...(snap.throttled ? ['Site power is throttling the training pool.'] : []),
              ...(underProvisioned ? ['Accelerator fleet is light for this scale.'] : []),
              ...trainingForecast.warnings,
            ]}
          />

          <button
            type="button"
            onClick={() =>
              startTraining({
                name:
                  modelIteration.name ||
                  `${family}-${formatParams(paramsB)}${mode === 'distill' ? '-d' : mode === 'continue' ? '-ct' : ''}`,
                family,
                backbone,
                productPreset,
                io: modelIo,
                paramsB,
                activeParamsB,
                mode,
                teacherId: mode === 'distill' ? teacherId || undefined : undefined,
                distillTeacherShare: mode === 'distill' ? teacherShare : undefined,
                continueFromId: mode === 'continue' ? continueFromId || undefined : undefined,
                dataPlan: recipePlan,
                modelStack: selectedStack,
              })
            }
            disabled={!familyUnlocked(family) || !productUnlocked(productPreset) || !!job}
            className="w-full rounded-full bg-train px-3 py-2 text-xs font-medium text-void disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start{' '}
            {mode === 'distill'
              ? 'distillation'
              : mode === 'continue'
                ? 'continue-train'
                : 'training'}{' '}
            · {money(upfront)} upfront
          </button>
        </div>
      )}

      <ModelList
        title="Internal (private)"
        models={internal}
        empty="No private checkpoints. Finish a job with Keep internal for teachers."
        pricingId={pricing.activeModelId}
        onSelect={setActiveModel}
        onRelease={releaseModel}
        onDelete={deleteModel}
        onPriceInOut={setModelApiInOut}
        frontierCapability={publicFrontier}
        privateList
      />

      <ModelList
        title="Released"
        models={released}
        empty="No public models yet."
        pricingId={pricing.activeModelId}
        onSelect={setActiveModel}
        onRelease={releaseModel}
        onDelete={deleteModel}
        onPriceInOut={setModelApiInOut}
        frontierCapability={publicFrontier}
        showTokenEconomics
        unitCostActive={infra.costPerMTok}
        economicsForModel={economicsForModel}
      />

      {evaluatedActive && (
        <section className="rounded-2xl border border-line bg-panel-2 p-3" aria-labelledby="model-evaluations-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id="model-evaluations-title" className="text-[0.8125rem] font-medium text-bone">
                Evaluations · {evaluatedActive.name}
              </h3>
              <p className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-muted">
                revision {evaluatedActive.revision ?? 1} · {evaluatedActive.reasoningEnabled ? 'reasoning' : 'non-reasoning'}
              </p>
            </div>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Evaluation suites">
              {availableSuites.map((suiteId) => (
                <button
                  key={suiteId}
                  type="button"
                  role="tab"
                  aria-selected={activeSuite === suiteId}
                  onClick={() => setBenchmarkSuite(suiteId)}
                  className={`rounded-sm px-2 py-1 text-[0.625rem] transition ${activeSuite === suiteId ? 'bg-mint text-void' : 'bg-void text-muted hover:text-bone'}`}
                >
                  {suiteId.replace('_generation', '').replace('omni_overview', 'overview').replaceAll('_', ' ')}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2">
            <RadarChart
              suiteId={activeSuite}
              scores={evaluatedActive.benchmarkSuites?.[activeSuite] ?? {}}
              profile={evaluatedActive.evaluationProfile}
              comparison={frontierComparison}
            />
          </div>
        </section>
      )}

      {(evaluatedActive || state.player.safetyCampaign) && (
        <SafetyCampaignCard
          activeModel={evaluatedActive}
          campaign={state.player.safetyCampaign}
          intensity={safetyIntensity}
          setIntensity={setSafetyIntensity}
          researchers={safetyResearchers}
          setResearchers={setSafetyResearchers}
          researcherCount={researcherCount}
          estimate={safetyEstimate}
          onStart={() => evaluatedActive && startSafetyCampaign(evaluatedActive.id, safetyIntensity, safetyResearchers)}
          onCancel={cancelSafetyCampaign}
        />
      )}
    </div>
  )
}

function ModelList({
  title,
  models,
  empty,
  pricingId,
  onSelect,
  onRelease,
  onDelete,
  onPriceInOut,
  frontierCapability,
  privateList,
  showTokenEconomics,
  unitCostActive,
  economicsForModel,
}: {
  title: string
  models: Model[]
  empty: string
  pricingId: string | null
  onSelect: (id: string) => void
  onRelease: (id: string) => void
  onDelete: (id: string) => void
  onPriceInOut: (id: string, priceIn: number | null, priceOut: number | null) => void
  frontierCapability: number
  privateList?: boolean
  showTokenEconomics?: boolean
  unitCostActive?: number
  economicsForModel?: (model: Model) => ApiUnitEconomics
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-muted">{title}</h3>
        <span className="font-mono text-[0.625rem] text-muted">{models.length} weights</span>
      </div>
      {models.length === 0 && <p className="rounded-lg bg-void/35 px-2.5 py-2 text-xs text-muted">{empty}</p>}
      {models.map((source) => {
        const model = normalizeModelEvaluations(source)
        const selected = pricingId === model.id
        const economics = showTokenEconomics ? economicsForModel?.(model) : undefined
        const unit = economics?.directBlended ?? unitCostActive
        const primarySuite = model.benchmarkSuites?.omni_overview
          ?? model.benchmarkSuites?.image_generation
          ?? model.benchmarkSuites?.video_generation
          ?? model.benchmarkSuites?.audio_generation
          ?? model.benchmarkSuites?.language
        const suiteScore = suiteComposite(primarySuite)
        const tier = modelTier(model.capability)
        const nextAt = tier.nextAt
        const progress = nextAt == null
          ? 100
          : ((model.capability - tier.floor) / Math.max(1, nextAt - tier.floor)) * 100
        const gap = model.capability - frontierCapability
        const speed = model.serviceProfile?.interactiveTokPerSec ?? 52 * model.tokPerSecMult
        const priceIn = model.apiPriceInPerMTok
          ?? model.suggestedApiPriceIn
          ?? model.costApiPriceIn
          ?? economics?.directIn
          ?? 0
        const priceOut = model.apiPriceOutPerMTok
          ?? model.suggestedApiPriceOut
          ?? model.costApiPriceOut
          ?? economics?.directOut
          ?? 0
        return (
          <article
            key={model.id}
            className={`overflow-hidden rounded-lg border transition ${selected ? 'border-mint/55 bg-mint/8' : 'border-line/75 bg-panel-2 hover:border-line'}`}
          >
            <button type="button" onClick={() => onSelect(model.id)} className="w-full p-2.5 text-left">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[0.8125rem] font-semibold text-bone">{model.name}</span>
                    <span className={`rounded-sm px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase ${tier.tone}`}>{tier.label}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[0.625rem] text-muted">
                    {privateList ? 'internal' : 'released'} · {model.backbone ?? model.family} · {formatParams(model.paramsB)} · r{model.revision ?? 1}
                  </div>
                </div>
                <span className="font-mono text-sm text-mint">{model.capability.toFixed(2)}</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1 font-mono text-[0.625rem]">
                <RosterStat label="suite" value={suiteScore.toFixed(2)} />
                <RosterStat label="frontier" value={`${gap >= 0 ? '+' : ''}${gap.toFixed(2)}`} tone={gap >= 0 ? 'text-mint' : 'text-amber'} />
                <RosterStat label="speed" value={`${speed.toFixed(2)} t/s`} />
                <RosterStat label="serve" value={unit == null ? '—' : `${displayRate(unit)}/M`} />
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-sm bg-void">
                <div className="h-full bg-mint transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
              </div>
            </button>

            {selected && (
              <div className="border-t border-line/65 bg-void/25 p-2.5">
                <div className="flex flex-wrap gap-1 font-mono text-[0.625rem] text-muted">
                  {model.modalities.map((modality) => (
                    <span key={modality} className="rounded-sm border border-line/70 px-1.5 py-0.5">{modality.toUpperCase()}</span>
                  ))}
                  {model.reasoningEnabled && <span className="rounded-sm border border-research/30 px-1.5 py-0.5 text-research">REASONING</span>}
                  {model.outcome && <span className={model.outcome.kind === 'stumble' ? 'text-danger' : model.outcome.kind === 'breakthrough' ? 'text-mint' : 'text-muted'}>{model.outcome.kind.toUpperCase()}</span>}
                </div>

                {!privateList && economics && (
                  <ApiEconomicsControl
                    modelName={model.name}
                    priceIn={priceIn}
                    priceOut={priceOut}
                    economics={economics}
                    onChange={(nextIn, nextOut) => onPriceInOut(model.id, nextIn, nextOut)}
                  />
                )}

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {privateList && (
                    <button type="button" onClick={() => onRelease(model.id)} className="rounded-sm bg-mint px-2.5 py-1 text-[0.6875rem] font-medium text-void">Release publicly</button>
                  )}
                  <button type="button" onClick={() => onDelete(model.id)} className="ml-auto rounded-sm px-2 py-1 text-[0.6875rem] text-danger hover:bg-danger/10">Delete</button>
                </div>
              </div>
            )}
          </article>
        )
      })}
    </section>
  )
}

function RosterStat({ label, value, tone = 'text-bone' }: { label: string; value: string; tone?: string }) {
  return (
    <span className="rounded-sm bg-void/55 px-1.5 py-1">
      <span className="block uppercase tracking-wider text-muted">{label}</span>
      <strong className={`font-medium ${tone}`}>{value}</strong>
    </span>
  )
}

function modelTier(capability: number) {
  if (capability >= 80) return { label: 'Breakthrough', floor: 80, nextAt: null, tone: 'bg-mint/15 text-mint' }
  if (capability >= 60) return { label: 'Frontier', floor: 60, nextAt: 80, tone: 'bg-serve/15 text-serve' }
  if (capability >= 40) return { label: 'Competitive', floor: 40, nextAt: 60, tone: 'bg-amber/15 text-amber' }
  return { label: 'Prototype', floor: 0, nextAt: 40, tone: 'bg-panel text-muted' }
}

function displayRate(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function ForecastBoard({
  capability,
  speed,
  risk,
  frontier,
  pfDays,
  upfront,
  cash,
  days,
  dataRatio,
  modalityCompute,
  vramNeed,
  vramHave,
  chipsNeed,
  chipsHave,
  powerNeed,
  powerHave,
  warnings,
}: {
  capability: number
  speed: number
  risk: 'low' | 'medium' | 'high'
  frontier: number
  pfDays: number
  upfront: number
  cash: number
  days: number
  dataRatio: number
  modalityCompute: number
  vramNeed: number
  vramHave: number
  chipsNeed: number
  chipsHave: number
  powerNeed: number
  powerHave: number
  warnings: string[]
}) {
  const gap = capability - frontier
  return (
    <section className="rounded-xl border border-line/70 bg-void/55 p-2.5" aria-labelledby="forecast-title">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="forecast-title" className="text-[0.6875rem] uppercase tracking-[0.16em] text-muted">Training forecast</h3>
          <div className="mt-1 flex items-baseline gap-2">
            <strong className="font-mono text-lg font-medium text-bone">{capability.toFixed(2)}</strong>
            <span className="font-mono text-[0.6875rem] text-muted">cap · {speed.toFixed(2)} tok/s</span>
          </div>
        </div>
        <RiskPill risk={risk} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <ForecastMetric label="Frontier gap" value={frontier > 0 ? `${gap >= 0 ? '+' : ''}${gap.toFixed(2)}` : 'No peer'} ratio={frontier > 0 ? capability / Math.max(1, frontier) : 1} tone={gap >= 0 ? 'bg-mint' : 'bg-amber'} />
        <ForecastMetric label="PF-days" value={pfDays.toFixed(2)} ratio={1 / Math.max(1, Math.log10(pfDays + 10))} tone="bg-train" />
        <ForecastMetric label="Calendar" value={days === Infinity ? 'No pool' : `${days.toFixed(0)}d`} ratio={days === Infinity ? 0 : 90 / Math.max(90, days)} tone={days > 120 ? 'bg-amber' : 'bg-mint'} />
      </div>

      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        <div className="rounded-md bg-panel-2/70 p-2">
          <div className="flex justify-between text-[0.6875rem]"><span className="text-muted">Resources</span><span className={cash < upfront ? 'text-danger' : 'text-bone'}>{money(upfront)}</span></div>
          <ReadinessBar label="Cash" value={cash / Math.max(1, upfront)} detail={`${money(cash)} available`} />
          <ReadinessBar label="Data" value={dataRatio} detail={`${dataRatio.toFixed(2)}× · modality ${modalityCompute.toFixed(2)}×`} />
          <ReadinessBar label="Accelerators" value={chipsHave / Math.max(1, chipsNeed)} detail={`${Math.floor(chipsHave).toLocaleString()} / ${chipsNeed.toLocaleString()}`} />
        </div>
        <div className="rounded-md bg-panel-2/70 p-2">
          <div className="text-[0.6875rem] text-muted">Physical readiness</div>
          <ReadinessBar label="VRAM" value={vramHave / Math.max(1, vramNeed)} detail={`${vramHave.toFixed(0)} / ${vramNeed.toFixed(0)} GB`} />
          <ReadinessBar label="Power" value={powerHave / Math.max(0.01, powerNeed)} detail={`${powerHave.toFixed(2)} / ${powerNeed.toFixed(2)} MW`} />
        </div>
      </div>
      {warnings.length > 0 && (
        <div className="mt-2 border-l-2 border-amber/60 pl-2 text-[0.6875rem] leading-snug text-amber">
          {[...new Set(warnings)].slice(0, 3).map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}
    </section>
  )
}

function ForecastMetric({ label, value, ratio, tone }: { label: string; value: string; ratio: number; tone: string }) {
  return (
    <div className="rounded-md bg-panel-2/70 p-2">
      <span className="block text-[0.625rem] uppercase tracking-wider text-muted">{label}</span>
      <strong className="font-mono text-[0.75rem] font-medium text-bone">{value}</strong>
      <div className="mt-1 h-1 overflow-hidden rounded-sm bg-void"><div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }} /></div>
    </div>
  )
}

function ReadinessBar({ label, value, detail }: { label: string; value: number; detail: string }) {
  const ready = value >= 1
  return (
    <div className="mt-1.5">
      <div className="flex justify-between gap-2 font-mono text-[0.625rem]"><span className="text-muted">{label}</span><span className={ready ? 'text-mint' : 'text-amber'}>{detail}</span></div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-sm bg-void"><div className={ready ? 'h-full bg-mint' : 'h-full bg-amber'} style={{ width: `${Math.max(3, Math.min(100, value * 100))}%` }} /></div>
    </div>
  )
}

function SafetyCampaignCard({
  activeModel,
  campaign,
  intensity,
  setIntensity,
  researchers,
  setResearchers,
  researcherCount,
  estimate,
  onStart,
  onCancel,
}: {
  activeModel: Model | null
  campaign: SafetyCampaign | null
  intensity: SafetyCampaignIntensity
  setIntensity: (value: SafetyCampaignIntensity) => void
  researchers: number
  setResearchers: (value: number) => void
  researcherCount: number
  estimate: ReturnType<typeof safetyCampaignEstimate> | null
  onStart: () => void
  onCancel: () => void
}) {
  if (campaign) {
    const trainingProgress = campaign.progressTrainingPfDays / Math.max(0.01, campaign.targetTrainingPfDays)
    const researchProgress = campaign.progressResearchPfDays / Math.max(0.01, campaign.targetResearchPfDays)
    return (
      <section className="rounded-xl border border-research/35 bg-research/5 p-3">
        <div className="flex items-start justify-between gap-2">
          <div><h3 className="text-[0.8125rem] font-medium text-bone">Safety campaign · {campaign.modelName}</h3><p className="font-mono text-[0.625rem] uppercase text-research">{campaign.intensity} · deployed revision stays live</p></div>
          <button type="button" onClick={onCancel} className="rounded-sm px-2 py-1 text-[0.6875rem] text-danger hover:bg-danger/10">Cancel</button>
        </div>
        <ReadinessBar label="Training compute" value={trainingProgress} detail={`${campaign.progressTrainingPfDays.toFixed(2)} / ${campaign.targetTrainingPfDays.toFixed(2)} PF-d`} />
        <ReadinessBar label="Research compute" value={researchProgress} detail={`${campaign.progressResearchPfDays.toFixed(2)} / ${campaign.targetResearchPfDays.toFixed(2)} PF-d`} />
        <p className="mt-2 font-mono text-[0.625rem] text-muted">{campaign.assignedResearchers} researchers · safety set {formatTokens(campaign.safetyDataMTok)} · Q{campaign.safetyDataQuality.toFixed(2)}</p>
      </section>
    )
  }
  if (!activeModel) return null
  return (
    <section className="rounded-xl border border-line/75 bg-panel-2 p-3">
      <div className="flex items-start justify-between gap-2"><div><h3 className="text-[0.8125rem] font-medium text-bone">Safety post-training</h3><p className="text-[0.6875rem] text-muted">Build a safer revision without taking the deployed checkpoint offline.</p></div><span className="font-mono text-[0.625rem] text-muted">{activeModel.safetyTraining?.campaigns ?? 0} complete</span></div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {(['targeted', 'standard', 'frontier'] as SafetyCampaignIntensity[]).map((option) => (
          <button key={option} type="button" onClick={() => setIntensity(option)} className={`rounded-sm px-2 py-1.5 text-[0.6875rem] capitalize transition ${intensity === option ? 'bg-research text-void' : 'bg-void text-muted hover:text-bone'}`}>{option}</button>
        ))}
      </div>
      {estimate && (
        <div className="mt-2 grid grid-cols-3 gap-1 font-mono text-[0.625rem]">
          <RosterStat label="train" value={`${estimate.trainingPfDays.toFixed(2)} PF-d`} />
          <RosterStat label="research" value={`${estimate.researchPfDays.toFixed(2)} PF-d`} />
          <RosterStat label="cash" value={money(estimate.cashBudget)} />
        </div>
      )}
      <label className="mt-2 block text-[0.6875rem] text-muted">Researchers {researchers} / {researcherCount}<input type="range" min={1} max={Math.max(1, researcherCount)} value={Math.min(Math.max(1, researcherCount), researchers)} onChange={(event) => setResearchers(Number(event.target.value))} className="mt-1 w-full" /></label>
      {estimate?.reason && <p className="mt-1.5 text-[0.6875rem] text-amber">{estimate.reason}</p>}
      <button type="button" disabled={!estimate?.ok} onClick={onStart} className="mt-2 w-full rounded-md bg-research px-3 py-2 text-xs font-medium text-void disabled:cursor-not-allowed disabled:opacity-40">Start {intensity} campaign</button>
    </section>
  )
}

function frontierForSuite(models: Model[], suiteId: BenchmarkSuiteId) {
  const scores: Partial<Record<import('../../../sim/types').BenchmarkMetricId, number>> = {}
  for (const model of models) {
    for (const [id, score] of Object.entries(model.benchmarkSuites?.[suiteId] ?? {})) {
      scores[id as import('../../../sim/types').BenchmarkMetricId] = Math.max(scores[id as import('../../../sim/types').BenchmarkMetricId] ?? 0, score ?? 0)
    }
  }
  return scores
}

function RiskPill({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  const style =
    risk === 'high'
      ? 'border-danger/35 bg-danger/10 text-danger'
      : risk === 'medium'
        ? 'border-amber/35 bg-amber/10 text-amber'
        : 'border-mint/35 bg-mint/10 text-mint'
  return (
    <span className={`rounded-full border px-2 py-0.5 font-mono text-[0.625rem] ${style}`}>
      {risk.toUpperCase()} EXPERIMENTAL RISK
    </span>
  )
}

function TokenRatioRail({
  ratio,
  omni,
  repeatedEpochs,
}: {
  ratio: number
  omni: boolean
  repeatedEpochs: number
}) {
  const markers = omni ? [10, 24] : [1, 6, 20]
  const max = omni ? 24 : 20
  const strong = omni ? 10 : 6
  const floor = omni ? 10 : 1
  const color = ratio < floor ? 'bg-danger' : ratio < strong ? 'bg-amber' : 'bg-mint'
  const status = ratio < floor ? 'UNDERTRAINED' : ratio < max ? 'STRONG' : 'FRONTIER DATA'
  return (
    <div className="mt-2 rounded-xl border border-line/70 bg-void/50 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-[0.6875rem]">
        <span className="uppercase tracking-wider text-muted">Quality-weighted tokens / parameter</span>
        <span className={ratio < floor ? 'text-danger' : ratio < strong ? 'text-amber' : 'text-mint'}>
          {ratio.toFixed(2)}× · {status}
        </span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-panel-2">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, (ratio / max) * 100)}%` }} />
        {markers.map((marker) => (
          <div
            key={marker}
            className="absolute top-[-0.2rem] h-3 w-px bg-bone/70"
            style={{ left: `${(marker / max) * 100}%` }}
          />
        ))}
      </div>
      <div className="relative mt-1 h-3 font-mono text-[0.5625rem] text-muted">
        {markers.map((marker) => (
          <span key={marker} className="absolute -translate-x-1/2" style={{ left: `${(marker / max) * 100}%` }}>
            {marker}×
          </span>
        ))}
      </div>
      {repeatedEpochs > 4 && (
        <p className="mt-1 text-[0.6875rem] text-danger">
          Repeated-data risk: {repeatedEpochs.toFixed(1)} corpus epochs; gains decay sharply after four.
        </p>
      )}
    </div>
  )
}

function Bar({ label, value, detail }: { label: string; value: number; detail: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[0.8125rem]">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-muted">{detail}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-void">
        <div className="h-full bg-mint" style={{ width: `${v * 100}%` }} />
      </div>
    </div>
  )
}
