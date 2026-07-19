import { useEffect, useMemo, useState } from 'react'
import { useGameStore } from '../../../store/gameStore'
import type {
  DataDomain,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelProductPreset,
  TrainMode,
} from '../../../sim/types'
import { BENCHMARK_DEFS } from '../../../sim/balance/benchmarks'
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
  hasCorpusSpecialists,
  newDataSinceModel,
  specialistDomainBoost,
  totalProcessed,
} from '../../../sim/systems/data'
import { modelCostMult, serveInfraCost, suggestApiInOut } from '../../../sim/balance/pricing'
import {
  familyServeMult,
  sizeTokMult,
} from '../../../sim/balance/tokenServe'
import { energyPriceForState } from '../../../sim/systems/map'
import { computeSnapshot } from '../../../sim/tick'
import { money, num } from '../format'
import { SizeSlider } from '../ui/SizeSlider'
import { modelTrainVramGb } from '../../../sim/balance/racks'
import {
  isGenerationOnlyModel,
  modelCanCurateDataDomain,
} from '../../../sim/systems/modelEligibility'
import { recentModelTemplates, resolveModelIteration } from '../modelNaming'
import {
  defaultModelStack,
  modelStackModifiers,
  modelStackModulesForFamily,
  sanitizeModelStack,
} from '../../../sim/balance/modelStack'

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
  const setModelApiPrice = useGameStore((s) => s.setModelApiPrice)
  const setModelApiInOut = useGameStore((s) => s.setModelApiInOut)
  const applyModelApiMarkup = useGameStore((s) => s.applyModelApiMarkup)
  const apiMarkupPct = useGameStore((s) => s.state.player.pricing.apiMarkupPct)
  const setPanel = useGameStore((s) => s.setPanel)
  const snap = computeSnapshot(state)
  const infra = serveInfraCost(state, snap, energyPriceForState(state))

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
  /** Per-domain specialist model ids (research: Specialist Curators) */
  const [domainModels, setDomainModels] = useState<Partial<Record<DataDomain, string>>>({})
  const [modelStack, setModelStack] = useState<string[]>(() =>
    defaultModelStack(state.player.researchUnlocked, 'dense'),
  )

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
  const specialistsUnlocked = hasCorpusSpecialists(state)

  const teachers = state.player.models
  const modelIteration = useMemo(() => resolveModelIteration(teachers, name), [teachers, name])
  const previousTemplates = useMemo(() => recentModelTemplates(teachers), [teachers])
  const generalCuratorModels = useMemo(
    () => teachers.filter((model) => !isGenerationOnlyModel(model)),
    [teachers],
  )
  const curatorModelsByDomain = useMemo(
    () => Object.fromEntries(
      DATA_DOMAINS.map((domain) => [
        domain,
        teachers.filter((model) => modelCanCurateDataDomain(model, domain)),
      ]),
    ) as Record<DataDomain, Model[]>,
    [teachers],
  )
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
      domainModels: specialistsUnlocked ? domainModels : undefined,
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
      specialistsUnlocked,
      domainModels,
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

  const weightSum = DATA_DOMAINS.reduce((s, d) => s + weights[d], 0) || 1

  const setWeight = (d: DataDomain, v: number) => {
    setWeights((w) => ({ ...w, [d]: Math.max(0, v) }))
  }

  const volMax = Math.max(processedAvail * 2, recData * 2.5, minMTok * 2, 100)
  const shortfall = Math.max(0, dataMTok - processedAvail)

  const setDomainModel = (d: DataDomain, id: string) => {
    setDomainModels((m) => {
      const next = { ...m }
      if (!id) delete next[d]
      else next[d] = id
      return next
    })
  }

  const applySameModelAll = (id: string) => {
    if (!id) {
      setDomainModels({})
      return
    }
    const selected = teachers.find((model) => model.id === id)
    if (!selected || isGenerationOnlyModel(selected)) return
    const next: Partial<Record<DataDomain, string>> = {}
    for (const d of DATA_DOMAINS) {
      if (modelCanCurateDataDomain(selected, d)) next[d] = id
    }
    setDomainModels(next)
  }

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
                  train −{Math.round((1 - stackModifiers.trainCostMult) * 100)}%
                </span>
                <span className="rounded-full bg-research/10 px-2 py-0.5 text-research">
                  cap +{stackModifiers.capabilityBonus.toFixed(1)}
                </span>
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
                    : null,
                  module.capabilityBonus > 0
                    ? `cap +${module.capabilityBonus.toFixed(1)}`
                    : null,
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
                        setPanel('research')
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
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
                Training data
              </h3>
              <button
                type="button"
                className="text-[0.75rem] text-mint hover:underline"
                onClick={() => setPanel('data')}
              >
                Corpus stocks →
              </button>
            </div>
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
              {mode !== 'continue' && shortfall > 1 && (
                <span className="ml-1 text-amber">
                  · +{formatTokens(shortfall)} synth fill for shortfall
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
            <div
              className={`mt-2 space-y-1.5 ${!mixUnlocked ? 'pointer-events-none opacity-45' : ''}`}
            >
              {!mixUnlocked && (
                <button
                  type="button"
                  onClick={() => setPanel('research')}
                  className="w-full rounded-lg border border-amber/40 bg-amber/10 px-2 py-1.5 text-left text-[0.75rem] text-amber hover:border-mint/40"
                >
                  Domain mix locked — research{' '}
                  <strong className="text-bone">Mixture Engineering</strong> (Lab → Research → Data
                  column, top). Click to open research.
                </button>
              )}
              {DATA_DOMAINS.map((d) => {
                const pct = Math.round((weights[d] / weightSum) * 100)
                const have = labData.stocks[d].processed
                const need = dataMTok * (weights[d] / weightSum)
                const short = need > have + 0.05
                return (
                  <div key={d}>
                    <div className="flex justify-between text-[0.75rem]">
                      <span className="text-bone">{DATA_DOMAIN_META[d].label}</span>
                      <span className={short ? 'text-amber' : 'text-muted'}>
                        {pct}% · need {formatTokens(need)} / have {formatTokens(have)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      disabled={!mixUnlocked}
                      value={Math.round(weights[d] * 100)}
                      onChange={(e) => setWeight(d, Number(e.target.value) / 100)}
                      className="w-full disabled:cursor-not-allowed"
                    />
                  </div>
                )
              })}
            </div>

            {/* Specialist curators per corpus */}
            <div
              className={`mt-3 rounded-lg border border-line/80 bg-void/40 p-2 ${
                !specialistsUnlocked ? 'opacity-50' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[0.75rem] font-medium uppercase tracking-wider text-muted">
                  Specialist models
                </h4>
                {specialistsUnlocked && teachers.length > 0 && (
                  <button
                    type="button"
                    className="text-[0.6875rem] text-mint hover:underline"
                    onClick={() => {
                      const first =
                        domainModels.code ||
                        domainModels.chat ||
                        generalCuratorModels[0]?.id ||
                        ''
                      if (first) applySameModelAll(first)
                    }}
                  >
                    Same model → all
                  </button>
                )}
              </div>
              {!specialistsUnlocked ? (
                <button
                  type="button"
                  onClick={() => setPanel('research')}
                  className="mt-1 w-full rounded-lg border border-amber/40 bg-amber/10 px-2 py-1.5 text-left text-[0.75rem] text-amber hover:border-mint/40"
                >
                  Locked — research <strong className="text-bone">Specialist Curators</strong>{' '}
                  (Data column, under Mixture Engineering). Click to open research.
                </button>
              ) : teachers.length === 0 ? (
                <p className="mt-1 text-[0.75rem] text-muted">
                  Train a model first, then assign it as a curator for each domain.
                </p>
              ) : (
                <div className="mt-1.5 space-y-1">
                  <label className="block text-[0.75rem] text-muted">
                    Apply one model to every domain
                    <select
                      className="mt-0.5 w-full rounded-md border border-line bg-void px-1.5 py-1 text-[0.8125rem] text-bone"
                      value=""
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '__clear') applySameModelAll('')
                        else if (v) applySameModelAll(v)
                      }}
                    >
                      <option value="">Choose…</option>
                      <option value="__clear">Clear all</option>
                      {generalCuratorModels.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · cap {t.capability.toFixed(0)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {DATA_DOMAINS.map((d) => {
                    const mid = domainModels[d] ?? ''
                    const m = curatorModelsByDomain[d].find((t) => t.id === mid)
                    const boost = m ? specialistDomainBoost(m, d) : 0
                    return (
                      <div key={d} className="flex items-center gap-1.5">
                        <span className="w-12 shrink-0 text-[0.75rem] text-bone">
                          {DATA_DOMAIN_META[d].label}
                        </span>
                        <select
                          className="min-w-0 flex-1 rounded-md border border-line bg-void px-1.5 py-0.5 text-[0.75rem] text-bone"
                          value={mid}
                          onChange={(e) => setDomainModel(d, e.target.value)}
                        >
                          <option value="">None</option>
                          {curatorModelsByDomain[d].map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        {boost > 0.5 && (
                          <span className="shrink-0 font-mono text-[0.6875rem] text-mint">
                            +{boost.toFixed(0)}Q
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
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

          <div className="rounded-xl border border-line/70 bg-void/60 p-2.5 font-mono text-[0.75rem]">
            <div className="mb-2 flex items-center justify-between border-b border-line/60 pb-2">
              <div>
                <div className="text-[0.6875rem] uppercase tracking-wider text-muted">Baseline forecast</div>
                <div className="mt-0.5 text-sm text-bone">
                  cap ~{trainingForecast.expectedCapability.toFixed(0)} · {num(trainingForecast.interactiveTokPerSec, 0)} tok/s
                </div>
              </div>
              <RiskPill risk={trainingForecast.risk} />
            </div>
            <div className="flex justify-between text-muted">
              <span>Train cost</span>
              <span className="text-bone">{num(costPf, 0)} PF-days</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Upfront + data</span>
              <span className={state.player.cash < upfront ? 'text-danger' : 'text-bone'}>
                {money(upfront)}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>Est. calendar</span>
              <span
                className={
                  daysEst === Infinity
                    ? 'text-danger'
                    : daysEst > 120
                      ? 'text-amber'
                      : 'text-bone'
                }
              >
                {daysEst === Infinity
                  ? '∞ (no train pool)'
                  : `~${daysEst}d (${Math.max(1, Math.round(daysEst / 30))} mo) @ train pool`}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>Accelerator equivalents</span>
              <span className={underProvisioned ? 'text-amber' : 'text-bone'}>
                ~{recChips.toLocaleString()} recommended · {Math.floor(snap.chipCount).toLocaleString()} available
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>Train pool</span>
              <span className="text-bone">{num(snap.pools.training, 2)} PF</span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>Effective data / modality</span>
              <span className="text-bone">
                {trainingForecast.effectiveDataRatio.toFixed(2)}× · {trainingForecast.modalityComputeMult.toFixed(2)}× compute
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>VRAM required</span>
              <span className={snap.vramGb < needVramGb ? 'text-danger' : 'text-bone'}>
                {num(needVramGb, 0)} / {num(snap.vramGb, 0)} GB
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>Public frontier comparison</span>
              <span className={trainingForecast.expectedCapability + 5 < publicFrontier ? 'text-amber' : 'text-mint'}>
                {publicFrontier > 0
                  ? `${trainingForecast.expectedCapability >= publicFrontier ? '+' : ''}${(trainingForecast.expectedCapability - publicFrontier).toFixed(0)} cap`
                  : 'no public peer'}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between text-muted">
              <span>Site power</span>
              <span className={snap.throttled ? 'text-danger' : 'text-bone'}>
                {num(snap.mwDemand, 2)} / {num(snap.mwAvailable, 2)} MW
                {snap.throttled ? ' · THROTTLED' : ''}
              </span>
            </div>
            {snap.throttled && (
              <p className="mt-1.5 text-danger">
                Power-throttled — expand interconnect/generation or train ETA balloons.
              </p>
            )}
            {underProvisioned && (
              <p className="mt-1.5 text-amber">
                Light fleet for this size — order more racks into halls for a faster run.
              </p>
            )}
            {trainingForecast.warnings.map((warning) => (
              <p key={warning} className="mt-1.5 text-amber">
                {warning}
              </p>
            ))}
            {paramsB >= 300 && !snap.throttled && (
              <p className="mt-1.5 text-muted">
                Frontier scale: train time and serve load are the real limits.
              </p>
            )}
            {state.alerts[0]?.severity === 'warn' && state.alerts[0].day === state.day && (
              <p className="mt-1.5 text-amber">{state.alerts[0].message}</p>
            )}
          </div>

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
        onPrice={setModelApiPrice}
        onPriceInOut={setModelApiInOut}
        onApplyMarkup={applyModelApiMarkup}
        markupPct={apiMarkupPct}
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
        onPrice={setModelApiPrice}
        onPriceInOut={setModelApiInOut}
        onApplyMarkup={applyModelApiMarkup}
        markupPct={apiMarkupPct}
        showTokenEconomics
        unitCostActive={infra.costPerMTok}
        activeModelRef={active ?? released[0] ?? null}
      />

      {active && (active.release === 'released' || active.shipped) && (
        <div className="rounded-2xl border border-line bg-panel-2 p-3">
          <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">
            Benchmarks · {active.name}
          </h3>
          <div className="mt-2 space-y-1.5">
            {BENCHMARK_DEFS.map((d) => {
              const score = active.benchmarks[d.id] ?? 0
              return (
                <div key={d.id}>
                  <div className="flex justify-between text-[0.75rem]">
                    <span className="text-muted">{d.name}</span>
                    <span className="font-mono text-bone">{score.toFixed(0)}</span>
                  </div>
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-void">
                    <div
                      className={`h-full ${scoreColor(score)}`}
                      style={{ width: `${score}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <button type="button" className="btn-ghost w-full py-2" onClick={() => setPanel('plans')}>
        Plans & product packaging →
      </button>
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
  onPrice: _onPrice,
  onPriceInOut,
  onApplyMarkup,
  markupPct,
  privateList,
  showTokenEconomics,
  unitCostActive,
  activeModelRef,
}: {
  title: string
  models: Model[]
  empty: string
  pricingId: string | null
  onSelect: (id: string) => void
  onRelease: (id: string) => void
  onDelete: (id: string) => void
  onPrice: (id: string, price: number | null) => void
  onPriceInOut: (id: string, priceIn: number | null, priceOut: number | null) => void
  onApplyMarkup: (id: string, markupPct: number) => void
  markupPct: number
  privateList?: boolean
  showTokenEconomics?: boolean
  unitCostActive?: number
  activeModelRef?: Model | null
}) {
  void _onPrice
  return (
    <div className="space-y-2">
      <h3 className="text-[0.8125rem] font-medium uppercase tracking-wider text-muted">{title}</h3>
      {models.length === 0 && <p className="text-xs text-muted">{empty}</p>}
      {models.map((m) => {
        const unit =
          showTokenEconomics && unitCostActive != null && activeModelRef
            ? Math.max(
                0.005,
                unitCostActive *
                  (modelCostMult(m) / Math.max(0.08, modelCostMult(activeModelRef))),
              )
            : unitCostActive
        const sug =
          showTokenEconomics && unit != null
            ? suggestApiInOut({
                costPerMTokBase: unit,
                paramsB: m.paramsB,
                activeParamsB: m.activeParamsB,
                family: m.family,
                inferCostMult: m.inferCostMult,
                capability: m.capability,
                markupPct,
                applyModelMult: false,
              })
            : null
        return (
        <div
          key={m.id}
          className={`rounded-xl border px-2.5 py-2 ${
            pricingId === m.id ? 'border-mint/50 bg-mint/10' : 'border-line bg-panel-2'
          }`}
        >
          <button type="button" onClick={() => onSelect(m.id)} className="w-full text-left">
            <div className="flex justify-between text-sm">
              <span className="font-medium text-bone">{m.name}</span>
              <span className="font-mono text-[0.8125rem] text-muted">cap {m.capability.toFixed(0)}</span>
            </div>
            <div className="mt-0.5 font-mono text-[0.75rem] text-muted">
              {m.backbone ?? m.family} · {(m.productPreset ?? m.family).replaceAll('_', ' ')}
              {m.family === 'moe'
                ? ` · ${formatParams(m.paramsB)} / ${formatParams(m.activeParamsB ?? 0)} act`
                : ` · ${formatParams(m.paramsB)}`}
              {m.distilled ? ' · distilled' : ''}
              {m.postTrain !== 'none' ? ` · ${m.postTrain}` : ''}
            </div>
            {showTokenEconomics && (
              <div className="mt-1 font-mono text-[0.6875rem] text-muted">
                {num(m.serviceProfile?.interactiveTokPerSec ?? 52 * m.tokPerSecMult, 0)} tok/s interactive
                {' · '}tok ×{sizeTokMult(m).toFixed(2)} · fam {familyServeMult(m.family)} · burn cost ~
                {unit != null ? money(unit) : '—'}/MTok
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-1 font-mono text-[0.625rem] text-muted">
              {m.modalities.map((modality) => (
                <span key={modality} className="rounded-full border border-line/70 bg-void px-1.5 py-0.5">
                  {modality.toUpperCase()}
                </span>
              ))}
              {m.outcome && (
                <span
                  className={`rounded-full border px-1.5 py-0.5 ${
                    m.outcome.kind === 'breakthrough'
                      ? 'border-mint/35 text-mint'
                      : m.outcome.kind === 'stumble'
                        ? 'border-danger/35 text-danger'
                        : 'border-line text-muted'
                  }`}
                >
                  {m.outcome.kind.toUpperCase()} · {m.outcome.yieldMultiplier.toFixed(3)}× YIELD
                </span>
              )}
            </div>
            {m.capabilities && (
              <div className="mt-1.5 grid grid-cols-3 gap-1 font-mono text-[0.625rem]">
                {Object.entries(m.capabilities.domains)
                  .toSorted((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([domain, score]) => (
                    <span key={domain} className="rounded border border-mint/15 bg-mint/5 px-1.5 py-1 text-muted">
                      {domain.toUpperCase()} <strong className="text-mint">{score.toFixed(0)}</strong>
                    </span>
                  ))}
              </div>
            )}
          </button>

          {!privateList && (
            <div className="mt-2 space-y-1.5">
              <div className="text-[0.6875rem] text-muted">
                API list (this model only)
                {sug && (
                  <span className="text-muted/80">
                    {' '}
                    · floor ${sug.costIn.toFixed(3)}/${sug.costOut.toFixed(3)} · markup list $
                    {sug.priceIn.toFixed(3)}/${sug.priceOut.toFixed(3)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="text-[0.75rem] text-muted">
                  In $/1M
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder={String(m.suggestedApiPriceIn ?? m.costApiPriceIn)}
                    value={m.apiPriceInPerMTok ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') onPriceInOut(m.id, null, m.apiPriceOutPerMTok)
                      else
                        onPriceInOut(
                          m.id,
                          Math.max(0, Number(v) || 0),
                          m.apiPriceOutPerMTok ??
                            m.suggestedApiPriceOut ??
                            m.costApiPriceOut,
                        )
                    }}
                    className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1 font-mono text-xs text-bone outline-none"
                  />
                </label>
                <label className="text-[0.75rem] text-muted">
                  Out $/1M
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder={String(m.suggestedApiPriceOut ?? m.costApiPriceOut)}
                    value={m.apiPriceOutPerMTok ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') onPriceInOut(m.id, m.apiPriceInPerMTok, null)
                      else
                        onPriceInOut(
                          m.id,
                          m.apiPriceInPerMTok ??
                            m.suggestedApiPriceIn ??
                            m.costApiPriceIn,
                          Math.max(0, Number(v) || 0),
                        )
                    }}
                    className="mt-0.5 w-full rounded-md border border-line bg-void px-2 py-1 font-mono text-xs text-bone outline-none"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[0.6875rem] text-muted">
                <span>
                  cost ${m.costApiPriceIn?.toFixed(3) ?? '—'}/${m.costApiPriceOut?.toFixed(3) ?? '—'}
                </span>
                <span>· sug ${m.suggestedApiPriceIn?.toFixed(3)}/${m.suggestedApiPriceOut?.toFixed(3)}</span>
                <button
                  type="button"
                  className="rounded-full bg-void px-2 py-0.5 text-mint hover:bg-mint/10"
                  onClick={() =>
                    onPriceInOut(m.id, m.costApiPriceIn, m.costApiPriceOut)
                  }
                >
                  At cost
                </button>
                <button
                  type="button"
                  className="rounded-full bg-mint/15 px-2 py-0.5 text-mint"
                  onClick={() => onApplyMarkup(m.id, markupPct)}
                >
                  +{markupPct}% markup
                </button>
              </div>
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {privateList && (
              <button
                type="button"
                onClick={() => onRelease(m.id)}
                className="rounded-full bg-mint/15 px-2.5 py-1 text-[0.75rem] text-mint"
              >
                Release publicly
              </button>
            )}
            <button
              type="button"
              onClick={() => onDelete(m.id)}
              className="rounded-full border border-danger/30 px-2.5 py-1 text-[0.75rem] text-danger hover:bg-danger/10"
            >
              Delete
            </button>
          </div>

          {!privateList && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {BENCHMARK_DEFS.slice(0, 4).map((d) => (
                <span
                  key={d.id}
                  className="rounded-full bg-void px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted"
                >
                  {d.short} {(m.benchmarks[d.id] ?? 0).toFixed(0)}
                </span>
              ))}
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}

function scoreColor(score: number) {
  if (score >= 70) return 'bg-mint'
  if (score >= 45) return 'bg-infer'
  if (score >= 25) return 'bg-amber'
  return 'bg-danger/70'
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
