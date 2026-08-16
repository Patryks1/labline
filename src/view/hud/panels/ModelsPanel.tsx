import { useEffect, useMemo, useState } from "react";
import { DiceFive } from "@phosphor-icons/react";
import { useGameStore } from "../../../store/gameStore";
import { useUiStore } from "../../../store/uiStore";
import type {
  BenchmarkSuiteId,
  DataDomain,
  Model,
  ModelBackbone,
  ModelFamily,
  ModelProductPreset,
  NativeWeightFormat,
  SafetyCampaignIntensity,
  StartTrainingOpts,
  TrainMode,
  TrainingComputeFormat,
} from "../../../sim/types";
import {
  PARAM_PRESETS,
  distillRetentionFor,
  formatParams,
  recommendedChips,
} from "../../../sim/balance/training";
import {
  DEFAULT_TRAINING_NUMERICS,
  estimateTrainingMemoryGb,
  supportsTrainingFormat,
  TRAINING_PRECISION_PROFILES,
  trainingNumericsEconomicsProfile,
} from "../../../sim/balance/trainingPrecision";
import {
  backboneFromFamily,
  familyFromSpec,
  forecastTrainingV3,
  ioForPreset,
  migrateLegacyProductPreset,
  presetFromFamily,
} from "../../../sim/balance/trainingV3";
import {
  capabilityCeiling,
  normalizeDataQuality,
} from "../../../sim/balance/modelScaling";
import { aggregateEffects } from "../../../sim/systems/research";
import {
  DATA_DOMAINS,
  formatTokens,
  minimumTrainingDataMTok,
  recommendedTrainingDataMTok,
} from "../../../sim/balance/data";
import {
  ensureLabData,
  newDataSinceModel,
  totalProcessed,
} from "../../../sim/systems/data";
import { apiUnitCostPerMTok } from "../../../sim/balance/pricing";
import { energyPriceForState } from "../../../sim/systems/map";
import { computeSnapshot } from "../../../sim/tick";
import {
  defaultTrainingDataWeights,
  playerTrainingResourcePlan,
  trainingArchitectureValidation,
  trainingMinimumStatus,
  trainingUnlockEligibility,
  trainingRamFitForNewJob,
} from "../../../sim/systems/training";
import { money, mw, num } from "../format";
import { SizeSlider } from "../ui/SizeSlider";
import { ResearchUnlockLink } from "../ui/ResearchUnlockLink";
import { modelTrainVramGb, modelVramGb } from "../../../sim/balance/racks";
import { resolveRackSku } from "../../../sim/systems/racks";
import {
  generateUniqueModelName,
  isModelNameTaken,
  MODEL_NAME_TAKEN_MESSAGE,
  resolveModelIteration,
} from "../modelNaming";
import {
  defaultModelStack,
  modelStackModifiers,
  modelStackModulesForFamily,
  sanitizeModelStack,
} from "../../../sim/balance/modelStack";
import { normalizeModelEvaluations } from "../../../sim/balance/evaluationSuites";
import { safetyCampaignEstimate } from "../../../sim/systems/safetyCampaigns";
import { playerStaff } from "../../../sim/systems/staff";
import { TrainingDataRadar } from "../ui/TrainingDataRadar";
import {
  syntheticExpansionUnlocked,
  syntheticTrainingProfile,
  teacherSyntheticHeadroomMTok,
} from "../../../sim/balance/syntheticTraining";
import {
  PanelScaffold,
  HudButton,
  HudInput,
  HudRange,
  HudSelect,
  MetricTile,
} from "../ui/HudPrimitives";
import { BlockerList, CardGrid, GameCard, type Blocker } from "../ui/kit";
import { ActiveTrainingCard } from "./models/ActiveTrainingCard";
import type { TrainingLossCheckpointMarker } from "./models/TrainingLossChart";
import { FleetTab } from "./models/FleetTab";
import { SafetyCampaignSection } from "./models/SafetyCampaignSection";
import { CheckpointWorkspace } from "./models/CheckpointWorkspace";
import { CheckpointEvaluationDialog } from "./models/CheckpointEvaluationDialog";
import { BenchmarkEntryPoint } from "./models/BenchmarkEntryPoint";
import {
  checkpointUiRecordFromCandidate,
  type CheckpointReviewMode,
  type CheckpointUiRecord,
} from "./models/checkpointUi";
import {
  hasHardTrainingStartNotice,
  trainingDataGuidanceText,
  trainingStartFailureMessage,
} from "./models/trainingStartUi";
import { TrainingStartFailureBanner } from "./models/TrainingStartFailureBanner";
import {
  directRunCheckpointRequest,
  ensureCurrentRunCheckpoint,
} from "./models/directRunCheckpointActions";
import {
  normalizeTrainingJobs,
  selectPrimaryTrainingJob,
} from "../trainingJobViewModel";
import {
  ModelsTrainingQueue,
  type ModelsWorkspaceView,
} from "./models/ModelsTrainingQueue";
import type { ModelsWorkflowStep } from "./models/ModelsWorkflowStepper";
import { ModelsTrainingModal } from "./models/ModelsTrainingModal";
import {
  CheckpointBranchDialog,
  type CheckpointBranchRequest,
} from "./models/CheckpointBranchDialog";
import { resolveModelsFocusJobId } from "./models/modelsFocus";

const TRAINING_FORMAT_OPTIONS: ReadonlyArray<{
  value: TrainingComputeFormat;
  research?: string;
}> = [
  { value: "fp32" },
  { value: "fp16_mixed", research: "opt_fp16" },
  { value: "bf16_mixed", research: "opt_mixed" },
  { value: "fp8_hybrid", research: "opt_fp8_train" },
  { value: "nvfp4", research: "opt_nvfp4_train" },
];

const MODE_META: Record<TrainMode, { label: string; hint: string }> = {
  pretrain: {
    label: "Pretrain",
    hint: "Train a new model from scratch on your corpus.",
  },
  continue: {
    label: "Continue",
    hint: "Keep training an existing checkpoint on new data.",
  },
  distill: {
    label: "Distill",
    hint: "Compress a teacher model into a smaller student.",
  },
};

const PRODUCT_OPTIONS: ReadonlyArray<{
  value: ModelProductPreset;
  label: string;
}> = [
  { value: "language", label: "Language · text + tools" },
  { value: "audio", label: "Audio" },
  { value: "image_generation", label: "Image generation" },
  { value: "video_generation", label: "Video generation" },
  { value: "omni", label: "Omni" },
];

const BACKBONE_OPTIONS: ReadonlyArray<{ value: ModelBackbone; label: string }> =
  [
    { value: "dense", label: "Dense" },
    { value: "moe", label: "MoE" },
    { value: "diffusion", label: "Diffusion" },
  ];

function bestRecipeWeights(
  family: ModelFamily,
  productPreset: ModelProductPreset,
  dataMTok: number,
  labData: ReturnType<typeof ensureLabData>,
): Record<DataDomain, number> {
  const ideal = defaultTrainingDataWeights(family, productPreset);
  const adjusted = { ...ideal };
  for (const domain of DATA_DOMAINS) {
    const stock = labData.stocks[domain];
    const available = Math.max(0, stock.processed);
    const required = Math.max(1, dataMTok * ideal[domain]);
    const coverage = Math.min(1, available / required);
    const modalityFloor =
      domain === "image" || domain === "video" || domain === "audio"
        ? ideal[domain] * 0.55
        : ideal[domain] * 0.35;
    adjusted[domain] = Math.max(
      modalityFloor,
      ideal[domain] * (0.55 + coverage * 0.45),
    );
  }
  const sum = DATA_DOMAINS.reduce(
    (total, domain) => total + adjusted[domain],
    0,
  );
  return Object.fromEntries(
    DATA_DOMAINS.map((domain) => [domain, adjusted[domain] / sum]),
  ) as Record<DataDomain, number>;
}

function parseSizeInput(value: string, unit: "M" | "B" | "T"): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (unit === "T") return n * 1000;
  if (unit === "M") return n / 1000;
  return n;
}

function applyParamsB(paramsB: number): { val: string; unit: "M" | "B" | "T" } {
  if (paramsB >= 1000) return { val: String(paramsB / 1000), unit: "T" };
  if (paramsB >= 1) return { val: String(paramsB), unit: "B" };
  return { val: String(paramsB * 1000), unit: "M" };
}

export interface ModelsPanelProps {
  /** One-shot shell handoff from a global training action. */
  focusJobId?: string | null;
  onFocusHandled?: () => void;
}

export function ModelsPanel({
  focusJobId = null,
  onFocusHandled,
}: ModelsPanelProps = {}) {
  const state = useGameStore((s) => s.state);
  const startTraining = useGameStore((s) => s.startTraining);
  const setTrainingPriority = useGameStore((s) => s.setTrainingPriority);
  const pauseTraining = useGameStore((s) => s.pauseTraining);
  const cancelTraining = useGameStore((s) => s.cancelTraining);
  const selectPostTrain = useGameStore((s) => s.selectPostTrain);
  const promoteTrainingCheckpoint = useGameStore(
    (s) => s.promoteTrainingCheckpoint,
  );
  const discardTrainingCheckpoint = useGameStore(
    (s) => s.discardTrainingCheckpoint,
  );
  const scheduleCheckpointEvaluation = useGameStore(
    (s) => s.scheduleCheckpointEvaluation,
  );
  const createManualTrainingCheckpoint = useGameStore(
    (s) => s.createManualTrainingCheckpoint,
  );
  const forkTrainingCheckpoint = useGameStore((s) => s.forkTrainingCheckpoint);
  const rollbackTrainingJobToCheckpoint = useGameStore(
    (s) => s.rollbackTrainingJobToCheckpoint,
  );
  const recoverFailedPostTrainFromCheckpoint = useGameStore(
    (s) => s.recoverFailedPostTrainFromCheckpoint,
  );
  const keepInternal = useGameStore((s) => s.keepInternal);
  const releaseFromJob = useGameStore((s) => s.releaseFromJob);
  const releaseModel = useGameStore((s) => s.releaseModel);
  const deleteModel = useGameStore((s) => s.deleteModel);
  const setActiveModel = useGameStore((s) => s.setActiveModel);
  const startSafetyCampaign = useGameStore((s) => s.startSafetyCampaign);
  const cancelSafetyCampaign = useGameStore((s) => s.cancelSafetyCampaign);
  const openResearchNode = useGameStore((s) => s.openResearchNode);
  const announceRelease = useUiStore((s) => s.announceRelease);
  const snap = computeSnapshot(state);
  const trainingResources = playerTrainingResourcePlan(state, snap);
  const energyPrice = energyPriceForState(state);

  const [panelTab, setPanelTab] = useState<"runs" | "checkpoints" | "fleet">(
    "runs",
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showNewModel, setShowNewModel] = useState(false);
  const [newModelStep, setNewModelStep] =
    useState<ModelsWorkflowStep>("define");
  const [name, setName] = useState("Spark");
  const [backbone, setBackbone] = useState<ModelBackbone>("dense");
  const [productPreset, setProductPreset] =
    useState<ModelProductPreset>("language");
  const [sizeVal, setSizeVal] = useState("1");
  const [sizeUnit, setSizeUnit] = useState<"M" | "B" | "T">("B");
  const [activeVal, setActiveVal] = useState("8");
  const [activeUnit, setActiveUnit] = useState<"M" | "B" | "T">("B");
  const [mode, setMode] = useState<TrainMode>("pretrain");
  const [teacherId, setTeacherId] = useState("");
  const [teacherShare, setTeacherShare] = useState(0.72);
  const [continueFromId, setContinueFromId] = useState("");
  const [realDataMTok, setRealDataMTok] = useState(500);
  const [syntheticMultiplier, setSyntheticMultiplier] = useState(0);
  const [trainShare, setTrainShare] = useState(0.82);
  const [weights, setWeights] = useState<Record<DataDomain, number>>(() =>
    defaultTrainingDataWeights("dense", "language"),
  );
  const [allowSynthetic, setAllowSynthetic] = useState(true);
  const [includeSynthHQ, setIncludeSynthHQ] = useState(true);
  const [includeSynthLQ, setIncludeSynthLQ] = useState(false);
  const [syntheticTeacherIds, setSyntheticTeacherIds] = useState<
    Partial<Record<DataDomain, string>>
  >({});
  const [modelStack, setModelStack] = useState<string[]>(() =>
    defaultModelStack(state.player.researchUnlocked, "dense"),
  );
  const [safetyIntensity, setSafetyIntensity] =
    useState<SafetyCampaignIntensity>("standard");
  const [safetyResearchers, setSafetyResearchers] = useState(1);
  const [trainingFormat, setTrainingFormat] = useState<TrainingComputeFormat>(
    DEFAULT_TRAINING_NUMERICS.computeFormat,
  );
  const [nativeWeightFormat, setNativeWeightFormat] =
    useState<NativeWeightFormat>("float");
  const [computePriority, setComputePriority] = useState(50);
  const [showPreviousCorpus, setShowPreviousCorpus] = useState(true);
  const [checkpointEvaluationId, setCheckpointEvaluationId] = useState<
    string | null
  >(null);
  const [checkpointEvaluationMode, setCheckpointEvaluationMode] =
    useState<CheckpointReviewMode>("internal");
  const [branchCheckpointId, setBranchCheckpointId] = useState<string | null>(
    null,
  );
  const [branchFailure, setBranchFailure] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<string | null>(null);

  const paramsB = parseSizeInput(sizeVal, sizeUnit);
  const family = familyFromSpec(backbone, productPreset);
  const activeParamsB =
    backbone === "moe" ? parseSizeInput(activeVal, activeUnit) : undefined;
  const modelIo = useMemo(() => ioForPreset(productPreset), [productPreset]);

  const unlocked = state.player.researchUnlocked;
  const stackModules = useMemo(
    () => modelStackModulesForFamily(family),
    [family],
  );
  const selectedStack = useMemo(
    () => sanitizeModelStack(modelStack, unlocked, family),
    [modelStack, unlocked, family],
  );
  const stackModifiers = useMemo(
    () => modelStackModifiers(selectedStack, family),
    [selectedStack, family],
  );
  const productUnlocked = useMemo(() => {
    return (preset: ModelProductPreset): boolean => {
      const candidateBackbone =
        preset === "image_generation" || preset === "video_generation"
          ? "diffusion"
          : backbone === "diffusion"
            ? "dense"
            : backbone;
      return trainingUnlockEligibility({
        family: familyFromSpec(candidateBackbone, preset),
        backbone: candidateBackbone,
        productPreset: preset,
        researchUnlocked: unlocked,
      }).ok;
    };
  }, [backbone, unlocked]);
  const selectedUnlockEligibility = useMemo(
    () =>
      trainingUnlockEligibility({
        family,
        backbone,
        productPreset,
        researchUnlocked: unlocked,
      }),
    [family, backbone, productPreset, unlocked],
  );
  const mixUnlocked = unlocked.includes("data_mix");
  const synthUnlocked = unlocked.includes("data_synth");
  const jobs = useMemo(() => normalizeTrainingJobs(state), [state]);
  const checkpointCandidates = useMemo(
    () => state.player.trainingCheckpoints ?? [],
    [state.player.trainingCheckpoints],
  );
  const checkpointUiByCandidateId = useMemo(() => {
    const records = new Map<string, CheckpointUiRecord>();
    for (const candidate of checkpointCandidates) {
      const retained = candidate.promotedModelId
        ? state.player.models.find(
            (model) => model.id === candidate.promotedModelId,
          )
        : undefined;
      records.set(
        candidate.id,
        checkpointUiRecordFromCandidate(candidate, {
          promotedModelPublic:
            retained?.release === "released" || retained?.shipped === true,
          promotedModelId: retained?.id,
          promotedModelName: retained?.name,
          sourceJobActive: Boolean(
            jobs.some((job) => job.id === candidate.sourceJobId),
          ),
          pendingEvaluations: (
            state.player.privateEvaluationJobs ?? []
          ).flatMap((evaluation) =>
            evaluation.kind === "checkpoint_evaluation" &&
            evaluation.subjectId === candidate.id
              ? [evaluation.pending]
              : [],
          ),
        }),
      );
    }
    return records;
  }, [checkpointCandidates, jobs, state.player]);
  const checkpointEvidenceByModelId = useMemo(() => {
    const records: Record<string, CheckpointUiRecord> = {};
    for (const candidate of checkpointCandidates) {
      const modelId = candidate.promotedModelId;
      const evidence = checkpointUiByCandidateId.get(candidate.id);
      if (modelId && evidence) records[modelId] = evidence;
    }
    return records;
  }, [checkpointCandidates, checkpointUiByCandidateId]);
  const checkpointMarkersByJob = useMemo(() => {
    const byJob = new Map<string, TrainingLossCheckpointMarker[]>();
    for (const candidate of checkpointCandidates) {
      const retained = candidate.promotedModelId
        ? state.player.models.find(
            (model) => model.id === candidate.promotedModelId,
          )
        : undefined;
      const visibility: TrainingLossCheckpointMarker["visibility"] =
        retained?.release === "released" || retained?.shipped
          ? "released"
          : candidate.status === "promoted"
            ? "internal"
            : "stealth";
      const marker: TrainingLossCheckpointMarker = {
        id: candidate.id,
        day: candidate.capturedDay,
        progress: candidate.telemetry.progress,
        loss: candidate.telemetry.loss,
        label:
          candidate.kind === "manual"
            ? candidate.customLabel?.trim() ||
              `Manual checkpoint ${candidate.ordinal}`
            : `C${Math.round(candidate.milestone * 100)}`,
        detail:
          visibility === "released"
            ? `released as ${retained?.name ?? candidate.model.name}`
            : visibility === "internal"
              ? `kept internal as ${retained?.name ?? candidate.model.name}`
              : "stealth weights",
        kind: candidate.kind === "manual" ? "manual" : "milestone",
        visibility,
      };
      const markers = byJob.get(candidate.sourceJobId) ?? [];
      markers.push(marker);
      byJob.set(candidate.sourceJobId, markers);
    }
    return byJob;
  }, [checkpointCandidates, state.player.models]);
  const teachers = state.player.models;
  const distillTeacher =
    mode === "distill"
      ? teachers.find((model) => model.id === teacherId)
      : undefined;
  /** Planning estimate shown in the distill UI (mid data/RNG, pre-run). */
  const expectedDistillTransferPct = distillTeacher
    ? Math.round(
        distillRetentionFor({
          teacherParamsB: distillTeacher.paramsB,
          studentParamsB: paramsB,
          dataFactor: 0.6,
          rng01: 0.5,
        }) * 100,
      )
    : 0;
  const synthExpansionUnlocked = syntheticExpansionUnlocked({
    synthResearchUnlocked: synthUnlocked,
    mode,
    hasDistillTeacher: !!distillTeacher,
  });
  const effectiveSyntheticMultiplier =
    allowSynthetic && synthExpansionUnlocked ? syntheticMultiplier : 0;
  const dataMTok = realDataMTok * (1 + effectiveSyntheticMultiplier);
  const modelIteration = useMemo(
    () => resolveModelIteration(teachers, name),
    [teachers, name],
  );
  const selectedJob =
    jobs.find((job) => job.id === selectedJobId) ??
    (!showNewModel ? selectPrimaryTrainingJob(jobs) : undefined);
  const jobIds = jobs.map((job) => job.id).join("|");

  useEffect(() => {
    if (jobs.length === 0) {
      setSelectedJobId(null);
      return;
    }
    setSelectedJobId((current) => {
      if (current && jobs.some((job) => job.id === current)) return current;
      return selectPrimaryTrainingJob(jobs)?.id ?? jobs[0]?.id ?? null;
    });
  }, [jobIds, jobs]);

  useEffect(() => {
    if (!focusJobId) return;
    const resolvedJobId = resolveModelsFocusJobId(jobs, focusJobId);
    if (resolvedJobId) {
      setPanelTab("runs");
      setSelectedJobId(resolvedJobId);
      setShowNewModel(false);
    }
    onFocusHandled?.();
  }, [focusJobId, jobIds, jobs, onFocusHandled]);
  const rivalModels = useMemo(
    () => state.rivals.flatMap((rival) => rival.models),
    [state.rivals],
  );
  const nameTaken = useMemo(
    () =>
      isModelNameTaken(modelIteration.name, {
        playerModels: state.player.models,
        rivalModels,
        jobs,
      }),
    [modelIteration.name, state.player.models, rivalModels, jobs],
  );
  const pricing = state.player.pricing;
  const active = state.player.models.find(
    (m) => m.id === pricing.activeModelId,
  );
  const labData = ensureLabData(state);
  const trainParamsB =
    mode === "continue"
      ? (teachers.find((t) => t.id === continueFromId)?.paramsB ?? paramsB)
      : paramsB;
  const trainFamily =
    mode === "continue"
      ? (teachers.find((t) => t.id === continueFromId)?.family ?? family)
      : family;
  const trainProductPreset =
    mode === "continue"
      ? (() => {
          const continuing = teachers.find((t) => t.id === continueFromId);
          return continuing
            ? migrateLegacyProductPreset(
                continuing.productPreset ?? productPreset,
                continuing.io,
              )
            : productPreset;
        })()
      : productPreset;
  const trainingDataTargetSpec = {
    paramsB: trainParamsB,
    activeParamsB,
    family: trainFamily,
    backbone,
    trainShare,
  } as const;
  const minMTok = minimumTrainingDataMTok(trainingDataTargetSpec);
  const recData = recommendedTrainingDataMTok(trainingDataTargetSpec);
  const processedAvail = totalProcessed(labData);
  /** Recommended recipe at recommended volume — the radar "Optimal" overlay. */
  const optimalByDomainMTok = useMemo(() => {
    const optimalWeights = bestRecipeWeights(
      trainFamily,
      trainProductPreset,
      Math.max(1, recData),
      labData,
    );
    return Object.fromEntries(
      DATA_DOMAINS.map((domain) => [
        domain,
        (optimalWeights[domain] ?? 0) * recData,
      ]),
    ) as Record<DataDomain, number>;
  }, [trainFamily, trainProductPreset, recData, labData]);
  const continueModel = teachers.find((t) => t.id === continueFromId);
  const previousCorpusWeights = useMemo(() => {
    if (mode !== "continue" || !continueModel?.dataPlan?.weights) return null;
    return continueModel.dataPlan.weights as Record<DataDomain, number>;
  }, [mode, continueModel]);

  const priorTokens = continueModel?.dataTokensUsedMTok ?? 0;
  const newSinceContinue = newDataSinceModel(state, continueModel);
  const recipePlan = useMemo(
    () => ({
      totalUnits: dataMTok,
      totalMTok: dataMTok,
      trainShare,
      weights,
      allowSynthetic: allowSynthetic && synthExpansionUnlocked,
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
      synthExpansionUnlocked,
      includeSynthHQ,
      includeSynthLQ,
      syntheticTeacherIds,
      effectiveSyntheticMultiplier,
    ],
  );
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
          teacherId: mode === "distill" ? teacherId || undefined : undefined,
          distillTeacherShare: mode === "distill" ? teacherShare : undefined,
          modelStack: selectedStack,
          trainingNumerics: {
            computeFormat: trainingFormat,
            nativeWeightFormat,
            recipeVersion: 1,
          },
        },
        labData,
        dataQuality: state.player.dataQuality,
        trainEfficiency: state.player.trainEfficiency,
        trainPoolPf: snap.pools.training,
        trainPowerMw: snap.mwForecast.training,
        teacherParamsB: teachers.find((model) => model.id === teacherId)
          ?.paramsB,
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
      teacherShare,
      selectedStack,
      trainingFormat,
      nativeWeightFormat,
      labData,
      state.player.dataQuality,
      state.player.trainEfficiency,
      snap.pools.training,
      snap.mwForecast.training,
      teachers,
    ],
  );
  const dataGuidance = trainingForecast.dataGuidance
    ? trainingDataGuidanceText({
        selectedMTok: dataMTok,
        rawStrongTargetMTok: trainingForecast.dataGuidance.rawStrongTargetMTok,
        rawStrongTargetMet: trainingForecast.dataGuidance.rawStrongTargetMet,
        effectiveDataRatio: trainingForecast.effectiveDataRatio,
        qualityRetention: trainingForecast.dataGuidance.qualityRetention,
        diversityRetention: trainingForecast.dataGuidance.diversityRetention,
        holdoutRetention: trainingForecast.dataGuidance.holdoutRetention,
      })
    : null;
  const capabilityLimit = useMemo(() => {
    const effects = aggregateEffects(unlocked);
    const researchMult =
      1 +
      Math.min(0.12, (effects.capabilityBonus ?? 0) * 0.015) +
      (backbone === "moe" && unlocked.includes("moe_hier") ? 0.04 : 0);
    const teacherCapability =
      mode === "distill"
        ? teachers.find((model) => model.id === teacherId)?.capability
        : undefined;
    return capabilityCeiling({
      paramsB: trainParamsB,
      activeParamsB,
      family,
      backbone,
      dataCoverage: trainingForecast.effectiveDataRatio,
      dataQuality: normalizeDataQuality({
        labDataQuality: state.player.dataQuality,
      }),
      mixWeights: weights,
      researchMult,
      reasoningEnabled: stackModifiers.reasoningEnabled,
      teacherCapability,
    });
  }, [
    unlocked,
    family,
    backbone,
    mode,
    teachers,
    teacherId,
    trainParamsB,
    activeParamsB,
    trainingForecast.effectiveDataRatio,
    state.player.dataQuality,
    weights,
    stackModifiers.reasoningEnabled,
  ]);

  useEffect(() => {
    if (mode === "continue") {
      setRealDataMTok(Math.max(1, Math.round(newSinceContinue || 50)));
      return;
    }
    const target = Math.min(
      Math.max(minMTok, Math.min(recData, Math.max(processedAvail, minMTok))),
      Math.max(processedAvail * 1.5, recData * 2, minMTok),
    );
    setRealDataMTok(Math.round(Math.min(target, Math.max(1, processedAvail))));
  }, [
    minMTok,
    recData,
    processedAvail,
    trainParamsB,
    trainFamily,
    mode,
    continueFromId,
    newSinceContinue,
  ]);

  useEffect(() => {
    if (mode !== "continue" || !continueModel) return;
    const next = applyParamsB(continueModel.paramsB);
    setSizeVal(next.val);
    setSizeUnit(next.unit);
    if (continueModel.activeParamsB != null) {
      const active = applyParamsB(continueModel.activeParamsB);
      setActiveVal(active.val);
      setActiveUnit(active.unit);
    }
    setBackbone(
      continueModel.backbone ?? backboneFromFamily(continueModel.family),
    );
    setProductPreset(
      migrateLegacyProductPreset(
        continueModel.productPreset ?? presetFromFamily(continueModel.family),
        continueModel.io,
      ),
    );
    if (continueModel.trainingNumerics) {
      setTrainingFormat(continueModel.trainingNumerics.computeFormat);
      setNativeWeightFormat(continueModel.trainingNumerics.nativeWeightFormat);
    }
    if (continueModel.modelStack) {
      setModelStack([...continueModel.modelStack]);
    }
    setName(continueModel.name.replace(/\s+v\d+$/i, "") || continueModel.name);
    if (continueModel.dataPlan?.weights) {
      setWeights({
        ...defaultTrainingDataWeights(
          continueModel.family,
          migrateLegacyProductPreset(
            continueModel.productPreset ?? "language",
            continueModel.io,
          ),
        ),
        ...continueModel.dataPlan.weights,
      });
    }
    setShowPreviousCorpus(true);
  }, [mode, continueFromId, continueModel]);

  const dataCost = Math.max(0, Math.floor(dataMTok * 0.35));
  const setupCost = Math.max(0, trainingForecast.upfrontCash - dataCost);
  const dailyCost = trainingForecast.cashBurnPerDay;
  const upfront = trainingForecast.upfrontCash;
  const daysEst = trainingForecast.etaDays;
  const hostWeightFormat = trainingFormat.includes("fp32")
    ? "fp32"
    : trainingFormat.includes("fp8") || trainingFormat.includes("nvfp4")
      ? "int8"
      : "fp16";
  const hostRamGb = modelVramGb(
    trainParamsB,
    activeParamsB,
    backbone === "moe" ? "moe" : trainFamily,
    hostWeightFormat,
  );
  const recChips = recommendedChips(paramsB, family);
  const trainingMemory = useMemo(
    () =>
      estimateTrainingMemoryGb({
        paramsB: trainParamsB,
        activeParamsB,
        family: backbone === "moe" ? "moe" : family,
        numerics: {
          computeFormat: trainingFormat,
          nativeWeightFormat,
          recipeVersion: 1,
        },
        activationCheckpointing: unlocked.includes("opt_checkpoint"),
      }),
    [
      trainParamsB,
      activeParamsB,
      family,
      backbone,
      trainingFormat,
      nativeWeightFormat,
      unlocked,
    ],
  );
  const numericsEconomics = useMemo(
    () =>
      trainingNumericsEconomicsProfile({
        computeFormat: trainingFormat,
        nativeWeightFormat,
        recipeVersion: 1,
      }),
    [trainingFormat, nativeWeightFormat],
  );
  const precisionRisk =
    numericsEconomics.stabilityRisk >= 0.1 ||
    numericsEconomics.lossVolatilityMultiplier >= 1.5
      ? "high"
      : numericsEconomics.stabilityRisk > 0.02 ||
          numericsEconomics.lossVolatilityMultiplier > 1.1
        ? "medium"
        : "low";
  const needVramGb = Math.max(
    modelTrainVramGb(
      trainParamsB,
      activeParamsB,
      backbone === "moe" ? "moe" : family,
    ),
    trainingMemory.totalGb,
  );
  const prospectiveRamFit = trainingRamFitForNewJob(
    state,
    needVramGb,
    computePriority,
    snap,
    trainingMemory.requiredSystemRamGb,
  );
  const liveRackHardware = (state.player.rackFleet ?? [])
    .filter((rack) => rack.status === "live" && rack.count > 0)
    .map((rack) => resolveRackSku(rack.skuId, state.player.rackDesigns ?? []))
    .map((sku) => ({
      generation: sku.accelerator?.generation ?? 1,
      formats: sku.accelerator?.supportedTrainingFormats,
    }));
  const liveContractHardware = state.computeContracts
    .filter(
      (contract) =>
        contract.buyerLabId === state.playerLabId &&
        contract.status === "active" &&
        contract.pf > 0 &&
        (contract.availableDay == null || state.day >= contract.availableDay),
    )
    .map((contract) => ({
      generation: contract.acceleratorGeneration ?? 1,
      formats: contract.supportedTrainingFormats,
    }));
  const enumeratedHardware = [...liveRackHardware, ...liveContractHardware];
  const hasInboundBilateralCompute = state.computeLeases.some((lease) => {
    if (lease.status !== "active" || lease.pf <= 0) return false;
    const buyerLabId =
      lease.buyerLabId ??
      (lease.playerSells ? lease.rivalId : state.playerLabId);
    return buyerLabId === state.playerLabId;
  });
  const legacyHardware =
    enumeratedHardware.length === 0 &&
    (snap.chipCount > 0 || hasInboundBilateralCompute);
  const maxHardwareGeneration = Math.max(
    legacyHardware ? 1 : 0,
    ...enumeratedHardware.map((hardware) => hardware.generation),
  );
  const formatHardwareAvailable =
    (legacyHardware && supportsTrainingFormat(1, trainingFormat)) ||
    enumeratedHardware.some(
      (hardware) =>
        supportsTrainingFormat(hardware.generation, trainingFormat) &&
        (!hardware.formats || hardware.formats.includes(trainingFormat)),
    );
  const underProvisioned =
    snap.chipCount > 0 && snap.chipCount < recChips * 0.35;
  const publicFrontier = Math.max(
    0,
    ...state.player.models
      .filter((model) => model.release === "released" || model.shipped)
      .map((model) => model.capability),
    ...state.rivals.flatMap((rival) =>
      rival.models
        .filter((model) => model.release === "released" || model.shipped)
        .map((model) => model.capability),
    ),
  );

  const internal = state.player.models.filter(
    (m) => m.release === "internal" || !m.shipped,
  );
  const released = state.player.models.filter(
    (m) => m.release === "released" || m.shipped,
  );

  const realVolMax = Math.max(1, processedAvail);
  const strongestTeacher = teachers.reduce<Model | null>(
    (best, candidate) =>
      !best || candidate.capability > best.capability ? candidate : best,
    null,
  );
  const syntheticTeacherCapability = DATA_DOMAINS.reduce((sum, domain) => {
    const selected = teachers.find(
      (model) => model.id === syntheticTeacherIds[domain],
    );
    return (
      sum +
      ((selected ?? strongestTeacher)?.capability ?? 0) * (weights[domain] ?? 0)
    );
  }, 0);
  const syntheticFrontierCapability = Math.max(
    syntheticTeacherCapability,
    ...state.player.models
      .filter((model) => model.release === "released" || model.shipped)
      .map((model) => model.capability),
    ...state.rivals.flatMap((rival) =>
      rival.models
        .filter((model) => model.release === "released" || model.shipped)
        .map((model) => model.capability),
    ),
  );
  const syntheticTeacherReliability = DATA_DOMAINS.reduce((sum, domain) => {
    const selected = teachers.find(
      (model) => model.id === syntheticTeacherIds[domain],
    );
    return (
      sum +
      ((selected ?? strongestTeacher)?.quality.reliability ?? 0) *
        (weights[domain] ?? 0)
    );
  }, 0);
  const syntheticDataQuality = DATA_DOMAINS.reduce((sum, domain) => {
    const stock = labData.stocks[domain];
    return (
      sum +
      Math.max(0, stock?.quality ?? state.player.dataQuality) *
        (weights[domain] ?? 0)
    );
  }, 0);
  const syntheticProfile = syntheticTrainingProfile({
    realMTok: Math.min(realDataMTok, processedAvail),
    syntheticMTok:
      Math.min(realDataMTok, processedAvail) * effectiveSyntheticMultiplier,
    teacherCapability: Number.isFinite(syntheticTeacherCapability)
      ? syntheticTeacherCapability
      : 0,
    frontierCapability: syntheticFrontierCapability,
    teacherReliability: Number.isFinite(syntheticTeacherReliability)
      ? syntheticTeacherReliability
      : 0,
    dataQuality: Number.isFinite(syntheticDataQuality)
      ? syntheticDataQuality
      : state.player.dataQuality,
    // Forecast-only; actual beyond-2x gains still require generation compute at consumption/finalize time.
    computePfDays: Math.max(0, trainingForecast.targetPfDays),
    seed: `${state.seed}:${family}:${Math.round(realDataMTok)}:${effectiveSyntheticMultiplier.toFixed(1)}`,
  });
  // Distill: the teacher is the synthetic generator — per-domain headroom comes
  // from its training corpus, gated by teacher tier (weak teachers pass less).
  const distillSyntheticHeadroom = useMemo(
    () =>
      distillTeacher
        ? teacherSyntheticHeadroomMTok({
            teacher: distillTeacher,
            frontierCapability: syntheticFrontierCapability,
          })
        : null,
    [distillTeacher, syntheticFrontierCapability],
  );
  const safetyTarget = useMemo(() => {
    const campaign = state.player.safetyCampaign;
    if (campaign) {
      const match = state.player.models.find((m) => m.id === campaign.modelId);
      if (match) return normalizeModelEvaluations(match);
    }
    if (active) return normalizeModelEvaluations(active);
    if (internal[0]) return normalizeModelEvaluations(internal[0]);
    return null;
  }, [state.player.safetyCampaign, state.player.models, active, internal]);
  const checkpointEvaluationCandidate = checkpointEvaluationId
    ? checkpointCandidates.find(
        (candidate) => candidate.id === checkpointEvaluationId,
      )
    : undefined;
  const branchCheckpointCandidate = branchCheckpointId
    ? checkpointCandidates.find(
        (candidate) => candidate.id === branchCheckpointId,
      )
    : undefined;
  const branchSourceRunName = branchCheckpointCandidate
    ? (jobs.find((job) => job.id === branchCheckpointCandidate.sourceJobId)
        ?.name ?? branchCheckpointCandidate.model.name)
    : "Checkpoint";
  const checkpointArchiveEntries = checkpointCandidates.flatMap((candidate) => {
    const checkpoint = checkpointUiByCandidateId.get(candidate.id);
    return checkpoint
      ? [{ sourceJobId: candidate.sourceJobId, checkpoint }]
      : [];
  });
  const saveCurrentRunCheckpoint = (jobId: string): void => {
    const request = directRunCheckpointRequest(
      useGameStore.getState().state,
      jobId,
    );
    if (request) createManualTrainingCheckpoint(request);
  };
  const openCheckpointBranch = (checkpointId: string): void => {
    setBranchFailure(null);
    setBranchCheckpointId(checkpointId);
  };
  const branchCurrentRun = (jobId: string): void => {
    const checkpoint = ensureCurrentRunCheckpoint({
      state: useGameStore.getState().state,
      jobId,
      createCheckpoint: createManualTrainingCheckpoint,
      readState: () => useGameStore.getState().state,
    });
    if (!checkpoint || checkpoint.status === "discarded") return;
    openCheckpointBranch(checkpoint.id);
  };
  const startCheckpointBranch = (request: CheckpointBranchRequest): void => {
    const before = normalizeTrainingJobs(useGameStore.getState().state);
    const beforeIds = new Set(before.map((job) => job.id));
    setBranchFailure(null);
    forkTrainingCheckpoint(request);
    const afterState = useGameStore.getState().state;
    const started = normalizeTrainingJobs(afterState).find(
      (job) => !beforeIds.has(job.id),
    );
    if (!started) {
      setBranchFailure(
        afterState.alerts[0]?.message ??
          "The branch could not start. Check fresh data, cash, and compute capacity.",
      );
      return;
    }
    setSelectedJobId(started.id);
    setPanelTab("runs");
    setBranchCheckpointId(null);
    setBranchFailure(null);
  };
  const benchmarkCurrentRun = (jobId: string): void => {
    const checkpoint = ensureCurrentRunCheckpoint({
      state: useGameStore.getState().state,
      jobId,
      createCheckpoint: createManualTrainingCheckpoint,
      readState: () => useGameStore.getState().state,
    });
    if (!checkpoint || checkpoint.status === "discarded") return;
    setCheckpointEvaluationMode("internal");
    setCheckpointEvaluationId(checkpoint.id);
  };
  const modelEvidenceLabel = (model: Model): string => {
    const evidence = checkpointEvidenceByModelId[model.id];
    if (!evidence) return `cap ${model.capability.toFixed(2)}`;
    const measured = evidence.evaluationScore.estimate;
    return measured == null ? "eval unknown" : `eval ${measured.toFixed(2)}`;
  };
  const researcherCount = playerStaff(state).researcher ?? 0;
  const safetyEstimate = useMemo(
    () =>
      safetyTarget
        ? safetyCampaignEstimate(state, safetyTarget.id, safetyIntensity)
        : null,
    [state, safetyTarget, safetyIntensity],
  );

  useEffect(() => {
    if (safetyEstimate) {
      setSafetyResearchers((current) =>
        Math.max(
          safetyEstimate.minimumResearchers,
          Math.min(Math.max(1, researcherCount), current),
        ),
      );
    }
  }, [safetyEstimate, researcherCount]);

  const blockers = useMemo(() => {
    const items: Blocker[] = [];
    if (!selectedUnlockEligibility.ok) {
      items.push({
        text:
          selectedUnlockEligibility.reason ??
          "Research the selected model product first.",
      });
    }
    const architecture = trainingArchitectureValidation({
      backbone,
      paramsB: trainParamsB,
      activeParamsB,
      mode,
    });
    if (!architecture.ok) {
      items.push({
        text: architecture.reason ?? "Invalid training architecture.",
        tone: "danger",
      });
    }
    if (state.player.cash < upfront) {
      items.push({
        text: `Need ${money(upfront)} upfront, have ${money(state.player.cash)}.`,
      });
    }
    if (mode === "continue" && !continueFromId) {
      items.push({
        text: "Select a base internal model to continue training.",
      });
    }
    if (mode === "continue" && continueFromId && newSinceContinue < 1) {
      items.push({
        text: "Not enough new data since this checkpoint — collect more before continuing.",
        tone: "warning",
      });
    }
    if (mode === "distill" && !teacherId) {
      items.push({ text: "Select a teacher model to distill from." });
    }
    if (mode === "distill" && teachers.length === 0) {
      items.push({
        text: "Train and keep a teacher model internal before distilling.",
      });
    }
    if (snap.pools.training < 0.05) {
      const stall =
        snap.stallReason &&
        snap.stallReason !== "ok" &&
        snap.fullRawPool <= 0.05
          ? snap.stallMessage
          : snap.stallReason === "serve_reservation_starved_offline"
            ? snap.stallMessage
            : snap.fullRawPool <= 0.05
              ? snap.stallMessage ||
                "No workable compute capacity. Check power, halls, leases, and contracts."
              : `No training PF allocated (${num(snap.pools.training, 2)} PF). Raise the Training allocation or add active compute.`;
      items.push({
        text: stall,
        tone: "danger",
      });
    }
    if (!formatHardwareAvailable) {
      const requiredGeneration =
        TRAINING_PRECISION_PROFILES[trainingFormat].minimumHardwareGeneration;
      items.push({
        text:
          maxHardwareGeneration >= requiredGeneration
            ? `${TRAINING_PRECISION_PROFILES[trainingFormat].label} needs generation ${requiredGeneration}+ format support; active generation ${maxHardwareGeneration} hardware exists, but none advertises compatible training kernels.`
            : maxHardwareGeneration > 0
              ? `${TRAINING_PRECISION_PROFILES[trainingFormat].label} needs generation ${requiredGeneration}+ support; the active fleet tops out at generation ${maxHardwareGeneration}. Switch format or allocate compatible hardware.`
              : `${TRAINING_PRECISION_PROFILES[trainingFormat].label} needs generation ${requiredGeneration}+ hardware; no active accelerator fleet or contract is available.`,
        tone: "danger",
      });
    }
    if (!prospectiveRamFit.ready) {
      const hbmShort =
        prospectiveRamFit.candidateAllocatedGb + 1e-9 < needVramGb;
      const systemRamShort =
        prospectiveRamFit.candidateSystemRamAllocatedGb + 1e-9 <
        trainingMemory.requiredSystemRamGb;
      if (hbmShort) {
        items.push({
          text: `HBM short by ${num(needVramGb - prospectiveRamFit.candidateAllocatedGb, 0)} GB: ${num(prospectiveRamFit.candidateAllocatedGb, 0)} GB allocated / ${num(needVramGb, 0)} GB required after the priority split.`,
          tone: "danger",
        });
      }
      if (systemRamShort) {
        items.push({
          text: `Host RAM short by ${num(trainingMemory.requiredSystemRamGb - prospectiveRamFit.candidateSystemRamAllocatedGb, 0)} GB: ${num(prospectiveRamFit.candidateSystemRamAllocatedGb, 0)} GB allocated / ${num(trainingMemory.requiredSystemRamGb, 0)} GB required.`,
          tone: "danger",
        });
      }
      if (!hbmShort && !systemRamShort) {
        items.push({
          text: `${prospectiveRamFit.blockerResource ?? "Memory"} placement blocks ${prospectiveRamFit.blockerName ?? "the new run"}: no single execution domain can fit ${num(prospectiveRamFit.blockerRequiredGb ?? needVramGb, 0)} GB.`,
          tone: "danger",
        });
      }
    }
    if (underProvisioned) {
      items.push({
        text: `Accelerator fleet is light for this scale (have ${Math.floor(snap.chipCount)}, recommend ~${recChips}).`,
        tone: "warning",
      });
    }
    for (const warning of trainingForecast.warnings
      .filter(
        (warning) =>
          !warning.toLowerCase().includes("compatible training hardware"),
      )
      .slice(0, 2)) {
      // Forecast/data findings are advisory — they never block starting a run.
      items.push({
        text: `Advisory: ${warning} (training can still start)`,
        tone: "warning",
      });
    }
    return items;
  }, [
    selectedUnlockEligibility,
    backbone,
    trainParamsB,
    activeParamsB,
    state.player.cash,
    upfront,
    mode,
    continueFromId,
    newSinceContinue,
    teacherId,
    teachers.length,
    snap.pools.training,
    snap.stallReason,
    snap.fullRawPool,
    snap.stallMessage,
    formatHardwareAvailable,
    trainingFormat,
    maxHardwareGeneration,
    prospectiveRamFit.ready,
    prospectiveRamFit.blockerName,
    prospectiveRamFit.blockerRequiredGb,
    prospectiveRamFit.candidateAllocatedGb,
    prospectiveRamFit.candidateSystemRamAllocatedGb,
    prospectiveRamFit.blockerResource,
    needVramGb,
    trainingMemory.requiredSystemRamGb,
    underProvisioned,
    snap.chipCount,
    recChips,
    trainingForecast.warnings,
  ]);

  const blockersWithName: Blocker[] = nameTaken
    ? [{ text: MODEL_NAME_TAKEN_MESSAGE, tone: "danger" }, ...blockers]
    : blockers;
  const hardBlocked = hasHardTrainingStartNotice(blockersWithName) || nameTaken;
  const canStart = !hardBlocked && !nameTaken && selectedUnlockEligibility.ok;

  const selectedJobMinimum = selectedJob
    ? trainingMinimumStatus(selectedJob)
    : null;
  const selectedJobWorkflowStep: ModelsWorkflowStep = (() => {
    if (!selectedJob) return "define";
    if (
      selectedJob.failed ||
      selectedJob.pendingCampaignEvent ||
      selectedJobMinimum?.completeReady
    ) {
      return "review";
    }
    if (selectedJob.progressPfDays > 0 || selectedJob.postTrainProgress > 0) {
      return "compute";
    }
    return "data";
  })();
  const workflowStep = showNewModel ? newModelStep : selectedJobWorkflowStep;
  const workflowCompletedThrough: ModelsWorkflowStep | undefined =
    workflowStep === "data"
      ? "define"
      : workflowStep === "compute"
        ? "data"
        : workflowStep === "review"
          ? "compute"
          : undefined;

  const openNewModel = () => {
    setPanelTab("runs");
    setShowNewModel(true);
    setNewModelStep("define");
  };

  const prefillContinue = (model: Model) => {
    setPanelTab("runs");
    openNewModel();
    setMode("continue");
    setContinueFromId(model.id);
    setName(model.name.replace(/\s+v\d+$/i, "") || model.name);
    const next = applyParamsB(model.paramsB);
    setSizeVal(next.val);
    setSizeUnit(next.unit);
  };

  const handleStartTraining = (request: StartTrainingOpts) => {
    const before = useGameStore.getState().state;
    const beforeJobs = normalizeTrainingJobs(before);
    setStartFailure(null);
    startTraining(request);
    const after = useGameStore.getState().state;
    const afterJobs = normalizeTrainingJobs(after);
    const failure = trainingStartFailureMessage({
      beforeJobIds: beforeJobs.map((job) => job.id),
      beforeAlertId: before.alerts[0]?.id,
      alertChanged: after.alerts !== before.alerts,
      jobs: afterJobs,
      latestAlert: after.alerts[0],
    });
    setStartFailure(failure);
    if (failure) useUiStore.getState().pushToast(failure, "danger");
    else {
      const beforeIds = new Set(beforeJobs.map((job) => job.id));
      const started = afterJobs.find((job) => !beforeIds.has(job.id));
      if (started) {
        setSelectedJobId(started.id);
        setShowNewModel(false);
      }
    }
  };

  const startConfiguredTraining = () => {
    handleStartTraining({
      name:
        modelIteration.name ||
        `${family}-${formatParams(paramsB)}${
          mode === "distill" ? "-d" : mode === "continue" ? "-ct" : ""
        }`,
      family,
      backbone,
      productPreset,
      io: modelIo,
      paramsB,
      activeParamsB,
      mode,
      teacherId: mode === "distill" ? teacherId || undefined : undefined,
      distillTeacherShare: mode === "distill" ? teacherShare : undefined,
      continueFromId:
        mode === "continue" ? continueFromId || undefined : undefined,
      dataPlan: recipePlan,
      modelStack: selectedStack,
      trainingNumerics: {
        computeFormat: trainingFormat,
        nativeWeightFormat,
        recipeVersion: 1,
      },
      computePriority,
    });
  };

  const prefillDistill = (model: Model) => {
    setPanelTab("runs");
    openNewModel();
    setMode("distill");
    setTeacherId(model.id);
    setName(`${model.name.replace(/\s+v\d+$/i, "") || model.name}-d`);
  };

  const handleReleaseModel = (id: string) => {
    const model = state.player.models.find((m) => m.id === id);
    releaseModel(id);
    const released =
      useGameStore
        .getState()
        .state.player.models.find((candidate) => candidate.id === id) ?? model;
    if (released) {
      announceRelease({
        modelId: released.id,
        name: released.name,
        capability: released.capability,
        family: released.family,
        productPreset: released.productPreset,
        benchmarkSuiteIds: Object.keys(
          normalizeModelEvaluations(released).benchmarkSuites ?? {},
        ) as BenchmarkSuiteId[],
        lossHistory: released.trainingLossHistory,
        benchmarkSnapshots: released.trainingBenchmarkSnapshots,
      });
    }
  };

  const handleReleaseFromJob = (jobId: string) => {
    const job = jobs.find((j) => j.id === jobId);
    const existingIds = new Set(state.player.models.map((model) => model.id));
    // Copy this before releaseFromJob finalizes and removes the training job.
    const telemetry = job
      ? {
          lossHistory: job.lossHistory?.map((point) => ({ ...point })),
          benchmarkSnapshots: job.benchmarkSnapshots?.map((snapshot) => ({
            ...snapshot,
            suiteIds: snapshot.suiteIds ? [...snapshot.suiteIds] : undefined,
            suiteResults: snapshot.suiteResults
              ? { ...snapshot.suiteResults }
              : undefined,
          })),
          energyMWh: job.energyMWh,
          energyMwDays: job.energyMwDays,
        }
      : {};
    releaseFromJob(jobId);
    if (job) {
      const nextState = useGameStore.getState().state;
      const jobStillActive = normalizeTrainingJobs(nextState).some(
        (candidate) => candidate.id === job.id,
      );
      if (jobStillActive) return;
      const nextModels = nextState.player.models;
      const released =
        nextModels.find((model) => !existingIds.has(model.id)) ??
        (job.continueFromId
          ? nextModels.find((model) => model.id === job.continueFromId)
          : undefined) ??
        [...nextModels]
          .filter((model) => model.name === job.name)
          .sort((a, b) => (b.revision ?? 1) - (a.revision ?? 1))[0];
      announceRelease({
        modelId: released?.id,
        name: released?.name ?? job.name,
        capability: released?.capability ?? 0,
        family: released?.family ?? job.family,
        productPreset: released?.productPreset ?? job.productPreset,
        benchmarkSuiteIds: released
          ? (Object.keys(
              normalizeModelEvaluations(released).benchmarkSuites ?? {},
            ) as BenchmarkSuiteId[])
          : job.benchmarkSnapshots?.at(-1)?.suiteIds,
        ...telemetry,
      });
    }
  };

  const forecastVerdict = (() => {
    const gap = trainingForecast.expectedCapability - publicFrontier;
    if (publicFrontier <= 0)
      return "No public peer yet — this run sets your first bar.";
    if (gap >= 2)
      return `Likely ahead of the public frontier by +${gap.toFixed(2)} cap.`;
    if (gap >= -1) return "Roughly matches the current public frontier.";
    return `Trails the public frontier by ${Math.abs(gap).toFixed(2)} cap.`;
  })();

  return (
    <PanelScaffold
      title="Models"
      actions={
        panelTab === "runs" ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {selectedJob && !showNewModel ? (
              <BenchmarkEntryPoint
                context={{ kind: "training-run", id: selectedJob.id }}
                disabled={
                  selectedJob.progressPfDays <= 1e-9 &&
                  selectedJob.postTrainProgress <= 1e-9
                }
                title={
                  selectedJob.progressPfDays > 1e-9 ||
                  selectedJob.postTrainProgress > 1e-9
                    ? "Capture the current run checkpoint, then choose suites and evidence depth."
                    : "Allocate compute before benchmarking current weights."
                }
                onOpen={() => benchmarkCurrentRun(selectedJob.id)}
              >
                Benchmark
              </BenchmarkEntryPoint>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <CheckpointBranchDialog
        open={branchCheckpointCandidate != null}
        checkpoint={branchCheckpointCandidate}
        sourceRunName={branchSourceRunName}
        error={branchFailure}
        onClose={() => {
          setBranchCheckpointId(null);
          setBranchFailure(null);
        }}
        onSubmit={startCheckpointBranch}
      />

      {checkpointEvaluationCandidate ? (
        <CheckpointEvaluationDialog
          open
          candidate={checkpointEvaluationCandidate}
          cash={state.player.cash}
          initialMode={checkpointEvaluationMode}
          onClose={() => setCheckpointEvaluationId(null)}
          onSubmit={(request) => {
            scheduleCheckpointEvaluation(
              checkpointEvaluationCandidate.id,
              request,
            );
            setCheckpointEvaluationId(null);
          }}
        />
      ) : null}

      <div key={panelTab} className="panel-swap">
        <div
          className="models-workbench-layout min-w-0 grid gap-3"
          data-models-workbench-layout="responsive"
        >
          <ModelsTrainingQueue
            jobs={jobs}
            resources={trainingResources.jobs}
            selectedJobId={selectedJobId}
            activeView={panelTab as ModelsWorkspaceView}
            viewCounts={{
              runs: jobs.length,
              checkpoints: checkpointCandidates.length,
              fleet: internal.length + released.length,
            }}
            onSelect={(jobId) => {
              setPanelTab("runs");
              setSelectedJobId(jobId);
              setShowNewModel(false);
            }}
            onViewChange={(view) =>
              setPanelTab(view as "runs" | "checkpoints" | "fleet")
            }
            onNewModel={openNewModel}
            onResume={(jobId) => pauseTraining(jobId, false)}
            onRecover={(jobId, checkpointId) =>
              recoverFailedPostTrainFromCheckpoint({ jobId, checkpointId })
            }
          />
          <div className="models-workbench-detail min-w-0 space-y-3">
            {panelTab === "runs" ? (
              <>
                <div
                  hidden={showNewModel || !selectedJob}
                  data-model-selected-run={selectedJob?.id ?? ""}
                  className="space-y-3"
                >
                  {selectedJob ? (
                    <ActiveTrainingCard
                      job={selectedJob}
                      trainingPoolPf={snap.pools.training}
                      resources={trainingResources.jobs[selectedJob.id]}
                      jobs={jobs}
                      unlocked={unlocked}
                      day={state.day}
                      cash={state.player.cash}
                      onPriority={(jobId, priority, reservedPf) =>
                        setTrainingPriority(jobId, priority, reservedPf)
                      }
                      onPause={(jobId, paused) => pauseTraining(jobId, paused)}
                      onCancel={(jobId) => cancelTraining(jobId)}
                      onRelease={(jobId) => handleReleaseFromJob(jobId)}
                      onKeepInternal={(jobId) => keepInternal(jobId)}
                      onBenchmark={benchmarkCurrentRun}
                      onSaveCheckpoint={saveCurrentRunCheckpoint}
                      onBranchCheckpoint={branchCurrentRun}
                      checkpointMarkers={
                        checkpointMarkersByJob.get(selectedJob.id) ?? []
                      }
                      checkpointEvidence={checkpointArchiveEntries
                        .filter((entry) => entry.sourceJobId === selectedJob.id)
                        .map((entry) => entry.checkpoint)}
                      onOpenCheckpointHistory={() => setPanelTab("checkpoints")}
                      onRecoverFromCheckpoint={(jobId, checkpointId) =>
                        recoverFailedPostTrainFromCheckpoint({
                          jobId,
                          checkpointId,
                        })
                      }
                      onSelectPostTrain={(jobId, stage) =>
                        selectPostTrain(jobId, stage)
                      }
                    />
                  ) : null}
                </div>
                <ModelsTrainingModal
                  open={showNewModel}
                  activeStep={newModelStep}
                  completedThrough={workflowCompletedThrough}
                  onStepChange={setNewModelStep}
                  onCancel={() => setShowNewModel(false)}
                  footerAction={
                    newModelStep === "review" ? (
                      <HudButton
                        type="button"
                        variant="primary"
                        disabled={!canStart}
                        title={
                          !canStart
                            ? (() => {
                                const firstHard = blockersWithName.find(
                                  (item) => item.tone !== "warning",
                                );
                                return firstHard
                                  ? String(firstHard.text)
                                  : "Cannot start";
                              })()
                            : undefined
                        }
                        className="w-full sm:w-auto"
                        onClick={startConfiguredTraining}
                      >
                        Start{" "}
                        {mode === "distill"
                          ? "distillation"
                          : mode === "continue"
                            ? "continue-train"
                            : "training"}{" "}
                        · {money(upfront)}
                      </HudButton>
                    ) : null
                  }
                >
                  <div data-model-new-workflow="true" className="space-y-3">
                    <div
                      hidden={newModelStep !== "define"}
                      data-model-step="define"
                      className="space-y-3"
                    >
                      <GameCard
                        eyebrow="Define"
                        title="How do you want to train?"
                        tone="train"
                      >
                        <div className="grid gap-2 sm:grid-cols-3">
                          {(
                            ["pretrain", "continue", "distill"] as TrainMode[]
                          ).map((option) => {
                            const locked =
                              (option === "continue" || option === "distill") &&
                              teachers.length === 0;
                            const on = mode === option;
                            return (
                              <HudButton
                                key={option}
                                type="button"
                                variant="ghost"
                                aria-pressed={on}
                                disabled={locked}
                                title={
                                  locked
                                    ? "Need an existing model first"
                                    : MODE_META[option].hint
                                }
                                onClick={() => setMode(option)}
                                className={`!min-h-11 !justify-start !rounded-md !border !px-3 !py-2.5 !text-left !normal-case !tracking-normal !text-bone transition sm:!min-h-0 ${
                                  on
                                    ? "!border-train/50 !bg-train/10"
                                    : "!border-line/70 !bg-void/30 hover:!border-train/30"
                                } disabled:cursor-not-allowed disabled:opacity-40`}
                              >
                                <span className="block text-sm font-semibold text-bone">
                                  {MODE_META[option].label}
                                </span>
                                <span className="mt-0.5 block text-[0.75rem] text-muted">
                                  {MODE_META[option].hint}
                                </span>
                              </HudButton>
                            );
                          })}
                        </div>
                      </GameCard>

                      <GameCard
                        eyebrow="Define · Lineage"
                        title={
                          mode === "pretrain" ? "Name & family" : "Base model"
                        }
                      >
                        <div className="space-y-2.5">
                          {mode === "continue" ? (
                            <div className="space-y-2">
                              <label className="block text-[0.8125rem] text-muted">
                                Continue from
                                <HudSelect
                                  value={continueFromId}
                                  onChange={(e) =>
                                    setContinueFromId(e.target.value)
                                  }
                                  className="mt-1 min-h-11 w-full text-sm"
                                >
                                  <option value="">Select model…</option>
                                  {teachers.map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name} · {formatParams(t.paramsB)} ·{" "}
                                      {modelEvidenceLabel(t)}
                                    </option>
                                  ))}
                                </HudSelect>
                              </label>
                              {continueModel ? (
                                <div className="rounded-lg border border-mint/30 bg-mint/5 p-3">
                                  <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                      <p className="hud-eyebrow text-mint">
                                        New checkpoint version
                                      </p>
                                      <strong className="mt-0.5 block text-sm text-bone">
                                        {modelIteration.name}
                                      </strong>
                                    </div>
                                    <span className="rounded-full border border-line/70 bg-void/45 px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-muted">
                                      weights inherited
                                    </span>
                                  </div>
                                  <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted">
                                    Architecture, parameter topology, numerics
                                    and model stack are locked to{" "}
                                    {continueModel.name}. Add fresh data now,
                                    then apply SFT, RLHF, process or tools
                                    training before releasing this as a new
                                    version.
                                  </p>
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {mode === "distill" ? (
                            <div className="space-y-2 rounded-md border border-research/30 bg-research/5 p-2.5">
                              <label className="block text-[0.8125rem] text-muted">
                                Teacher
                                <HudSelect
                                  value={teacherId}
                                  onChange={(e) => setTeacherId(e.target.value)}
                                  className="mt-1 min-h-11 w-full text-sm"
                                >
                                  <option value="">Select teacher…</option>
                                  {teachers.map((t) => (
                                    <option key={t.id} value={t.id}>
                                      {t.name} · {formatParams(t.paramsB)} ·{" "}
                                      {t.release === "internal"
                                        ? "internal"
                                        : "public"}{" "}
                                      · {modelEvidenceLabel(t)}
                                    </option>
                                  ))}
                                </HudSelect>
                              </label>
                              <label className="block text-[0.8125rem] text-muted">
                                Distill mix · teacher{" "}
                                {(teacherShare * 100).toFixed(2)}%
                                <HudRange
                                  type="range"
                                  min={5}
                                  max={95}
                                  step={1}
                                  value={Math.round(teacherShare * 100)}
                                  onChange={(e) =>
                                    setTeacherShare(
                                      Number(e.target.value) / 100,
                                    )
                                  }
                                  className="mt-1"
                                />
                              </label>
                              {distillTeacher ? (
                                <p className="text-[0.6875rem] leading-snug text-muted">
                                  Expected transfer ≈{" "}
                                  <span className="font-mono text-mint">
                                    {expectedDistillTransferPct}%
                                  </span>{" "}
                                  of teacher capability (size gap{" "}
                                  {formatParams(distillTeacher.paramsB)} →{" "}
                                  {formatParams(paramsB)}, ±6% from data quality
                                  and run-to-run variance).
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          <div className="space-y-2.5">
                            <div className="grid items-end gap-2 lg:grid-cols-[minmax(12rem,1fr)_auto]">
                              <div className="block min-w-0 text-[0.8125rem] text-muted">
                                <label htmlFor="model-family-name">
                                  {mode === "continue"
                                    ? "New version name"
                                    : "Model name"}
                                </label>
                                <div
                                  className={`relative mt-1 flex rounded-md border bg-void focus-within:border-mint/50 ${nameTaken ? "border-danger/60" : "border-line"}`}
                                >
                                  <HudInput
                                    id="model-family-name"
                                    value={name}
                                    onChange={(event) =>
                                      setName(event.target.value)
                                    }
                                    className="min-h-11 min-w-0 flex-1 !border-0 !bg-transparent px-2 py-1.5 pr-12 text-sm text-bone outline-none"
                                    aria-invalid={nameTaken}
                                  />
                                  <HudButton
                                    type="button"
                                    variant="ghost"
                                    onClick={() =>
                                      setName(
                                        generateUniqueModelName({
                                          playerModels: state.player.models,
                                          rivalModels: state.rivals.flatMap(
                                            (rival) => rival.models,
                                          ),
                                          jobs,
                                        }),
                                      )
                                    }
                                    className="!absolute !inset-y-0 !right-0 !grid !h-auto !min-h-11 !w-11 !place-items-center !border-0 !bg-transparent !p-0 !text-muted transition hover:!bg-panel-2 hover:!text-mint"
                                    title="Generate a unique name"
                                    aria-label="Generate unique model name"
                                  >
                                    <DiceFive
                                      aria-hidden="true"
                                      size={18}
                                      weight="duotone"
                                    />
                                  </HudButton>
                                </div>
                              </div>
                              <fieldset className="min-w-0">
                                <legend className="text-[0.8125rem] text-muted">
                                  Backbone
                                </legend>
                                <div
                                  className="mt-1 flex flex-wrap gap-1"
                                  role="radiogroup"
                                  aria-label="Backbone"
                                >
                                  {BACKBONE_OPTIONS.map((option) => {
                                    const candidatePreset =
                                      option.value === "diffusion" &&
                                      productPreset !== "image_generation" &&
                                      productPreset !== "video_generation"
                                        ? "image_generation"
                                        : productPreset;
                                    const locked = !trainingUnlockEligibility({
                                      family: familyFromSpec(
                                        option.value,
                                        candidatePreset,
                                      ),
                                      backbone: option.value,
                                      productPreset: candidatePreset,
                                      researchUnlocked: unlocked,
                                    }).ok;
                                    const on = backbone === option.value;
                                    return (
                                      <HudButton
                                        key={option.value}
                                        type="button"
                                        variant="ghost"
                                        role="radio"
                                        aria-checked={on}
                                        disabled={locked || mode === "continue"}
                                        title={
                                          mode === "continue"
                                            ? "Inherited from the source checkpoint"
                                            : locked
                                              ? "Research required"
                                              : option.label
                                        }
                                        onClick={() => {
                                          setBackbone(option.value);
                                          const nextPreset = candidatePreset;
                                          if (nextPreset !== productPreset)
                                            setProductPreset(nextPreset);
                                          setWeights(
                                            defaultTrainingDataWeights(
                                              familyFromSpec(
                                                option.value,
                                                nextPreset,
                                              ),
                                              nextPreset,
                                            ),
                                          );
                                        }}
                                        className={`!min-h-11 !rounded-md !border !px-2.5 !py-1.5 !text-[0.75rem] !normal-case !tracking-normal transition disabled:cursor-not-allowed disabled:opacity-40 sm:!min-h-0 ${
                                          on
                                            ? "!border-train/45 !bg-train/15 !text-train"
                                            : "!border-line !bg-transparent !text-muted hover:!text-bone"
                                        }`}
                                      >
                                        {option.label}
                                      </HudButton>
                                    );
                                  })}
                                </div>
                              </fieldset>
                            </div>
                            {nameTaken ? (
                              <p
                                className="text-[0.75rem] text-danger"
                                role="alert"
                              >
                                {MODEL_NAME_TAKEN_MESSAGE}
                              </p>
                            ) : null}
                            <fieldset>
                              <legend className="text-[0.8125rem] text-muted">
                                Product / I/O preset
                              </legend>
                              <div
                                className="mt-1.5 flex flex-wrap gap-1.5"
                                role="radiogroup"
                                aria-label="Product preset"
                              >
                                {PRODUCT_OPTIONS.map((option) => {
                                  const locked = !productUnlocked(option.value);
                                  const on = productPreset === option.value;
                                  return (
                                    <HudButton
                                      key={option.value}
                                      type="button"
                                      variant="ghost"
                                      role="radio"
                                      aria-checked={on}
                                      disabled={locked || mode === "continue"}
                                      title={
                                        mode === "continue"
                                          ? "Inherited from the source checkpoint"
                                          : locked
                                            ? "Research required"
                                            : option.label
                                      }
                                      onClick={() => {
                                        setProductPreset(option.value);
                                        const nextBackbone =
                                          option.value === "image_generation" ||
                                          option.value === "video_generation"
                                            ? "diffusion"
                                            : backbone === "diffusion"
                                              ? "dense"
                                              : backbone;
                                        if (nextBackbone !== backbone)
                                          setBackbone(nextBackbone);
                                        const nextFamily = familyFromSpec(
                                          nextBackbone,
                                          option.value,
                                        );
                                        setWeights(
                                          defaultTrainingDataWeights(
                                            nextFamily,
                                            option.value,
                                          ),
                                        );
                                        setRealDataMTok(
                                          Math.min(
                                            processedAvail,
                                            recommendedTrainingDataMTok({
                                              paramsB,
                                              activeParamsB:
                                                nextBackbone === "moe"
                                                  ? activeParamsB
                                                  : undefined,
                                              family: nextFamily,
                                              backbone: nextBackbone,
                                              trainShare,
                                            }),
                                          ),
                                        );
                                      }}
                                      className={`!min-h-11 !rounded-md !border !px-2.5 !py-1.5 !text-[0.75rem] !normal-case !tracking-normal transition disabled:cursor-not-allowed disabled:opacity-40 sm:!min-h-0 ${
                                        on
                                          ? "!border-mint/45 !bg-mint/15 !text-mint"
                                          : "!border-line !bg-transparent !text-muted hover:!text-bone"
                                      }`}
                                    >
                                      {option.label}
                                    </HudButton>
                                  );
                                })}
                              </div>
                            </fieldset>
                          </div>
                        </div>
                      </GameCard>
                    </div>
                    <div
                      hidden={newModelStep !== "data"}
                      data-model-step="data"
                      className="space-y-3"
                    >
                      <GameCard
                        eyebrow="Data · Recipe"
                        title="Size, data mix & volume"
                        tone="train"
                      >
                        <div className="space-y-3">
                          <div className="rounded-md border border-line/60 bg-void/25 p-2.5">
                            <SizeSlider
                              label={
                                backbone === "moe" ? "Total size" : "Model size"
                              }
                              value={paramsB}
                              disabled={mode === "continue"}
                              disabledReason={
                                mode === "continue"
                                  ? "Size is locked during continuation — it inherits the base checkpoint."
                                  : undefined
                              }
                              onChange={(p) => {
                                const next = applyParamsB(p);
                                setSizeVal(next.val);
                                setSizeUnit(next.unit);
                                if (backbone === "moe") {
                                  const act = Math.min(
                                    p,
                                    Math.max(0.1, p * 0.1),
                                  );
                                  const a = applyParamsB(act);
                                  setActiveVal(a.val);
                                  setActiveUnit(a.unit);
                                }
                              }}
                            />
                            {backbone === "moe" && mode !== "continue" ? (
                              <div className="mt-2">
                                <SizeSlider
                                  label={`Active params (${
                                    paramsB > 0
                                      ? (
                                          ((activeParamsB ?? 0) / paramsB) *
                                          100
                                        ).toFixed(0)
                                      : 0
                                  }% of total)`}
                                  value={activeParamsB ?? 1}
                                  onChange={(p) => {
                                    const capped = Math.min(
                                      paramsB,
                                      Math.max(0.01, p),
                                    );
                                    const a = applyParamsB(capped);
                                    setActiveVal(a.val);
                                    setActiveUnit(a.unit);
                                  }}
                                  max={paramsB}
                                  min={0.01}
                                  stops={PARAM_PRESETS.filter(
                                    (p) => p.paramsB <= paramsB,
                                  ).map((p) => ({
                                    label: p.label,
                                    paramsB: p.paramsB,
                                  }))}
                                />
                              </div>
                            ) : null}
                          </div>

                          <div className="models-training-volume rounded-md border border-mint/25 bg-mint/5 p-2.5">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <span className="hud-eyebrow">Volume</span>
                                <strong className="block font-mono text-base text-bone">
                                  {formatTokens(dataMTok)} total
                                </strong>
                              </div>
                              <div className="text-right font-mono text-[0.6875rem]">
                                <span className="text-mint">
                                  {formatTokens(syntheticProfile.realMTok)} real
                                </span>
                                {synthExpansionUnlocked ? (
                                  <>
                                    <span className="mx-1 text-muted">+</span>
                                    <span className="text-research">
                                      {formatTokens(
                                        syntheticProfile.syntheticMTok,
                                      )}{" "}
                                      synth
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-2 grid grid-cols-3 gap-1.5 text-[0.6875rem]">
                              <div className="rounded border border-line/60 bg-void/30 px-2 py-1.5">
                                <span className="block text-muted">
                                  Available
                                </span>
                                <strong className="font-mono tabular-nums text-bone">
                                  {formatTokens(processedAvail)}
                                </strong>
                              </div>
                              <div className="rounded border border-line/60 bg-void/30 px-2 py-1.5">
                                <span className="block text-muted">
                                  Minimum
                                </span>
                                <strong className="font-mono tabular-nums text-bone">
                                  {formatTokens(minMTok)}
                                </strong>
                              </div>
                              <div className="rounded border border-line/60 bg-void/30 px-2 py-1.5">
                                <span className="block text-muted">
                                  Suggested
                                </span>
                                <strong className="font-mono tabular-nums text-bone">
                                  {formatTokens(recData)}
                                </strong>
                              </div>
                            </div>
                            {mode === "continue" ? (
                              <p className="mt-1.5 text-[0.6875rem] text-muted">
                                New since checkpoint{" "}
                                <strong className="font-mono text-mint">
                                  {formatTokens(newSinceContinue)}
                                </strong>
                                {priorTokens > 0
                                  ? " · lifetime " + formatTokens(priorTokens)
                                  : ""}
                              </p>
                            ) : null}
                            {dataGuidance ? (
                              <div className="mt-2 rounded-md border border-line/60 bg-void/35 px-2.5 py-2 text-[0.6875rem] leading-5">
                                <p
                                  className={
                                    trainingForecast.dataGuidance
                                      ?.rawStrongTargetMet
                                      ? "text-mint"
                                      : "text-amber"
                                  }
                                >
                                  {dataGuidance.headline}
                                </p>
                                {dataGuidance.reductions ? (
                                  <p className="text-muted">
                                    {dataGuidance.reductions}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                            {synthExpansionUnlocked ? (
                              <label className="mt-2 block text-[0.8125rem] text-muted">
                                Real corpus ·{" "}
                                {formatTokens(
                                  Math.min(realDataMTok, processedAvail),
                                )}
                                <HudRange
                                  type="range"
                                  min={1}
                                  max={Math.max(
                                    1,
                                    Math.round(
                                      mode === "continue"
                                        ? Math.max(1, newSinceContinue)
                                        : realVolMax,
                                    ),
                                  )}
                                  step={Math.max(
                                    1,
                                    Math.round(realVolMax / 200),
                                  )}
                                  value={Math.min(
                                    mode === "continue"
                                      ? Math.max(1, newSinceContinue)
                                      : realVolMax,
                                    Math.max(1, realDataMTok),
                                  )}
                                  onChange={(event) =>
                                    setRealDataMTok(Number(event.target.value))
                                  }
                                  className="mt-1"
                                />
                              </label>
                            ) : null}
                            <div className="mt-2 rounded-md border border-line/70 bg-void/40 px-2.5 py-2 text-[0.6875rem]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-muted">Mix</span>
                                <span className="font-mono tabular-nums text-bone">
                                  {formatTokens(realDataMTok)} real
                                  {effectiveSyntheticMultiplier > 0 ? (
                                    <span className="text-gold">
                                      {" "}
                                      +{" "}
                                      {formatTokens(
                                        Math.max(0, dataMTok - realDataMTok),
                                      )}{" "}
                                      synthetic (
                                      {effectiveSyntheticMultiplier.toFixed(2)}
                                      ×)
                                    </span>
                                  ) : (
                                    <span> · no synthetic</span>
                                  )}
                                </span>
                              </div>
                              <p
                                className="mt-1 leading-snug text-muted"
                                title="The radar controls the domain mix. Use all data fills owned stock before synthetic expansion."
                              >
                                {synthExpansionUnlocked && strongestTeacher
                                  ? "Adjust domain mix in the radar."
                                  : "Synthetic expansion is locked until research or a teacher is available."}
                              </p>
                            </div>
                            {!synthUnlocked && distillTeacher ? (
                              <p className="mt-1 text-[0.625rem] leading-snug text-muted">
                                {distillTeacher.name} supplies synthetic tokens
                                beyond the owned corpus for this distill run.
                              </p>
                            ) : null}
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <label className="block text-[0.8125rem] text-muted">
                                Train {(trainShare * 100).toFixed(2)}%
                                <HudRange
                                  type="range"
                                  min={40}
                                  max={95}
                                  step={1}
                                  value={Math.round(trainShare * 100)}
                                  onChange={(e) =>
                                    setTrainShare(Number(e.target.value) / 100)
                                  }
                                  className="mt-1"
                                  aria-label="Training share"
                                  title={`Verify ${((1 - trainShare) * 100).toFixed(2)}%`}
                                />
                              </label>
                              <div className="rounded border border-line/60 bg-void/25 px-2 py-1.5 text-[0.6875rem] text-muted">
                                <span className="block">Verify</span>
                                <strong className="font-mono text-bone">
                                  {((1 - trainShare) * 100).toFixed(2)}%
                                </strong>
                              </div>
                            </div>
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
                            syntheticUnlocked={synthUnlocked}
                            syntheticMultiplier={effectiveSyntheticMultiplier}
                            syntheticExpansionAvailable={
                              synthExpansionUnlocked && !!strongestTeacher
                            }
                            syntheticHeadroomMTok={
                              distillSyntheticHeadroom ?? undefined
                            }
                            syntheticSource={distillTeacher ? "teacher" : "lab"}
                            teachers={teachers}
                            syntheticTeacherIds={syntheticTeacherIds}
                            includeSynthHQ={includeSynthHQ && synthUnlocked}
                            includeSynthLQ={includeSynthLQ && synthUnlocked}
                            previousWeights={previousCorpusWeights}
                            showPreviousOverlay={showPreviousCorpus}
                            onTogglePreviousOverlay={() =>
                              setShowPreviousCorpus((v) => !v)
                            }
                            optimalByDomainMTok={optimalByDomainMTok}
                            onChange={(nextWeights, nextTotalMTok, meta) => {
                              setWeights(nextWeights);
                              if (!meta) {
                                setRealDataMTok(
                                  nextTotalMTok /
                                    Math.max(
                                      1,
                                      1 + effectiveSyntheticMultiplier,
                                    ),
                                );
                                return;
                              }
                              // Derive the real:synthetic ratio from the drag: real is
                              // the coverage of owned usable stock; anything past it is
                              // generated tokens. Keep real within the 8× expansion bound
                              // so real × (1 + mult) reproduces the dragged total exactly.
                              const expansionOn =
                                synthExpansionUnlocked && !!strongestTeacher;
                              let real = expansionOn
                                ? Math.min(
                                    nextTotalMTok,
                                    Math.max(meta.realMTok, nextTotalMTok / 8),
                                  )
                                : nextTotalMTok;
                              if (real <= 1e-9) real = nextTotalMTok;
                              const mult = expansionOn
                                ? Math.max(
                                    0,
                                    Math.min(
                                      7,
                                      nextTotalMTok / Math.max(1e-9, real) - 1,
                                    ),
                                  )
                                : 0;
                              real = nextTotalMTok / (1 + mult);
                              setSyntheticMultiplier(mult);
                              setAllowSynthetic(mult > 0);
                              if (mult > 0) setIncludeSynthHQ(true);
                              setRealDataMTok(real);
                            }}
                            onAutoBalance={() =>
                              setWeights(
                                bestRecipeWeights(
                                  family,
                                  productPreset,
                                  dataMTok,
                                  labData,
                                ),
                              )
                            }
                            onTeacherChange={(domain, teacher) =>
                              setSyntheticTeacherIds((current) => ({
                                ...current,
                                [domain]: teacher,
                              }))
                            }
                            onIncludeSynthHQChange={(value) => {
                              setAllowSynthetic(value || includeSynthLQ);
                              setIncludeSynthHQ(value);
                            }}
                            onIncludeSynthLQChange={(value) => {
                              setAllowSynthetic(value || includeSynthHQ);
                              setIncludeSynthLQ(value);
                            }}
                          />
                        </div>
                      </GameCard>
                    </div>
                    <div
                      hidden={newModelStep !== "compute"}
                      data-model-step="compute"
                      className="space-y-3"
                    >
                      <GameCard
                        eyebrow="Compute · Advanced"
                        title="Numerics & model stack"
                      >
                        <div className="space-y-3">
                          <div className="grid gap-2 sm:grid-cols-2">
                            <label className="models-compute-choice text-[0.8125rem] text-muted">
                              <span className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                                  Compute format
                                </span>
                                <span className="rounded border border-mint/25 bg-mint/10 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-mint">
                                  precision
                                </span>
                              </span>
                              <HudSelect
                                value={trainingFormat}
                                disabled={mode === "continue"}
                                title={
                                  mode === "continue"
                                    ? "Inherited from the source checkpoint"
                                    : undefined
                                }
                                onChange={(event) => {
                                  const next = event.target
                                    .value as TrainingComputeFormat;
                                  setTrainingFormat(next);
                                  if (
                                    nativeWeightFormat === "ternary_1_58" &&
                                    next !== "bf16_mixed"
                                  ) {
                                    setNativeWeightFormat("float");
                                  }
                                }}
                                className="mt-1 min-h-11 w-full text-sm disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {TRAINING_FORMAT_OPTIONS.map((option) => {
                                  const locked = Boolean(
                                    option.research &&
                                    !unlocked.includes(option.research),
                                  );
                                  const optionNumerics = {
                                    computeFormat: option.value,
                                    nativeWeightFormat:
                                      nativeWeightFormat === "ternary_1_58" &&
                                      option.value === "bf16_mixed"
                                        ? nativeWeightFormat
                                        : ("float" as const),
                                    recipeVersion: 1,
                                  };
                                  const optionEconomics =
                                    trainingNumericsEconomicsProfile(
                                      optionNumerics,
                                    );
                                  const optionMemory = estimateTrainingMemoryGb(
                                    {
                                      paramsB: trainParamsB,
                                      activeParamsB,
                                      family:
                                        backbone === "moe" ? "moe" : family,
                                      numerics: optionNumerics,
                                      activationCheckpointing:
                                        unlocked.includes("opt_checkpoint"),
                                    },
                                  );
                                  const optionTradeoff = `quality ${(optionEconomics.qualityCeilingMultiplier * 100).toFixed(2)}% · risk ${optionEconomics.stabilityRisk >= 0.1 || optionEconomics.lossVolatilityMultiplier >= 1.5 ? "high" : optionEconomics.stabilityRisk > 0.02 || optionEconomics.lossVolatilityMultiplier > 1.1 ? "medium" : "low"} · compute ${optionEconomics.trainingWorkMultiplier.toFixed(2)}× · HBM ${num(optionMemory.requiredHbmGb, 2)} GB · cost ${optionEconomics.upfrontCashMultiplier.toFixed(2)}×/${optionEconomics.dailyCashMultiplier.toFixed(2)}×`;
                                  return (
                                    <option
                                      key={option.value}
                                      value={option.value}
                                      disabled={locked}
                                      title={optionTradeoff}
                                    >
                                      {
                                        TRAINING_PRECISION_PROFILES[
                                          option.value
                                        ].label
                                      }
                                      {locked ? " · locked" : ""}
                                    </option>
                                  );
                                })}
                              </HudSelect>
                            </label>
                            <label className="models-compute-choice text-[0.8125rem] text-muted">
                              <span className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                                  Native weights
                                </span>
                                <span className="rounded border border-violet/25 bg-violet/10 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.1em] text-violet-200">
                                  {nativeWeightFormat === "float"
                                    ? "baseline"
                                    : "packed"}
                                </span>
                              </span>
                              <HudSelect
                                value={nativeWeightFormat}
                                disabled={mode === "continue"}
                                title={
                                  mode === "continue"
                                    ? "Inherited from the source checkpoint"
                                    : undefined
                                }
                                onChange={(event) => {
                                  const next = event.target
                                    .value as NativeWeightFormat;
                                  setNativeWeightFormat(next);
                                  if (next === "ternary_1_58")
                                    setTrainingFormat("bf16_mixed");
                                }}
                                className="mt-1 min-h-11 w-full text-sm disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <option value="float">Float weights</option>
                                <option
                                  value="ternary_1_58"
                                  disabled={
                                    family !== "dense" ||
                                    !unlocked.includes("dense_bitnet")
                                  }
                                >
                                  1.58-bit native
                                  {family !== "dense" ||
                                  !unlocked.includes("dense_bitnet")
                                    ? " · locked"
                                    : ""}
                                </option>
                              </HudSelect>
                            </label>
                          </div>
                          <div
                            className="models-numerics-summary rounded-md border border-line/60 bg-void/45 p-2"
                            title={
                              "Inference " +
                              numericsEconomics.inferenceCostMultiplier.toFixed(
                                2,
                              ) +
                              "× · loss volatility " +
                              numericsEconomics.lossVolatilityMultiplier.toFixed(
                                2,
                              ) +
                              "× · packed checkpoint " +
                              num(trainingMemory.packedCheckpointGb, 2) +
                              " GB"
                            }
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted">
                                Selected recipe
                              </span>
                              <span className="rounded border border-mint/35 bg-mint/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-mint">
                                {precisionRisk} risk
                              </span>
                            </div>
                            <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                              <span className="rounded border border-line/50 bg-panel-2/60 px-1.5 py-1 font-mono text-[0.625rem] text-muted">
                                Work{" "}
                                <strong className="text-bone">
                                  {numericsEconomics.trainingWorkMultiplier.toFixed(
                                    2,
                                  )}
                                  ×
                                </strong>
                              </span>
                              <span className="rounded border border-line/50 bg-panel-2/60 px-1.5 py-1 font-mono text-[0.625rem] text-muted">
                                HBM{" "}
                                <strong className="text-bone">
                                  {num(trainingMemory.requiredHbmGb, 2)} GB
                                </strong>
                              </span>
                              <span className="rounded border border-line/50 bg-panel-2/60 px-1.5 py-1 font-mono text-[0.625rem] text-muted">
                                Host{" "}
                                <strong className="text-bone">
                                  {num(trainingMemory.requiredSystemRamGb, 2)}{" "}
                                  GB
                                </strong>
                              </span>
                              <span className="rounded border border-line/50 bg-panel-2/60 px-1.5 py-1 font-mono text-[0.625rem] text-muted">
                                Setup{" "}
                                <strong className="text-bone">
                                  {numericsEconomics.upfrontCashMultiplier.toFixed(
                                    2,
                                  )}
                                  ×
                                </strong>
                              </span>
                            </div>
                          </div>

                          <div>
                            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                              <h4 className="text-[0.8125rem] font-semibold text-bone">
                                Model stack
                              </h4>
                              <div className="flex flex-wrap gap-1 font-mono text-[0.625rem]">
                                <span className="rounded-full bg-mint/10 px-2 py-0.5 text-mint">
                                  host −
                                  {(
                                    (1 - stackModifiers.hostingMult) *
                                    100
                                  ).toFixed(2)}
                                  %
                                </span>
                                <span className="rounded-full bg-infer/10 px-2 py-0.5 text-infer">
                                  speed +
                                  {(
                                    (stackModifiers.speedMult - 1) *
                                    100
                                  ).toFixed(2)}
                                  %
                                </span>
                              </div>
                            </div>
                            <CardGrid min="10rem" className="anim-stagger">
                              {stackModules.map((module) => {
                                const available = unlocked.includes(module.id);
                                const selected = selectedStack.includes(
                                  module.id,
                                );
                                return (
                                  <HudButton
                                    key={module.id}
                                    type="button"
                                    variant="ghost"
                                    aria-pressed={
                                      available ? selected : undefined
                                    }
                                    disabled={mode === "continue"}
                                    title={
                                      mode === "continue"
                                        ? "Inherited from the source checkpoint"
                                        : undefined
                                    }
                                    onClick={() => {
                                      if (!available) {
                                        openResearchNode(module.id);
                                        return;
                                      }
                                      setModelStack((current) =>
                                        current.includes(module.id)
                                          ? current.filter(
                                              (id) => id !== module.id,
                                            )
                                          : [...current, module.id],
                                      );
                                    }}
                                    className={`hover-lift !min-h-11 !justify-start !rounded-md !border !p-2 !text-left !normal-case !tracking-normal !text-bone transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                      selected
                                        ? "!border-mint/40 !bg-mint/10"
                                        : available
                                          ? "!border-line !bg-panel-2/70"
                                          : "!border-line/60 !bg-void/45 !opacity-65"
                                    }`}
                                  >
                                    <span className="flex items-center justify-between gap-1 text-[0.75rem] font-medium text-bone">
                                      {module.name}
                                      <span
                                        className={`font-mono text-[0.625rem] uppercase tracking-[0.12em] ${
                                          selected
                                            ? "text-mint"
                                            : available
                                              ? "text-muted"
                                              : "text-amber"
                                        }`}
                                      >
                                        {selected
                                          ? "On"
                                          : available
                                            ? module.focus
                                            : "Research"}
                                      </span>
                                    </span>
                                    <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted">
                                      {module.description}
                                    </span>
                                  </HudButton>
                                );
                              })}
                            </CardGrid>
                          </div>
                        </div>
                      </GameCard>
                    </div>
                    <div
                      hidden={newModelStep !== "review"}
                      data-model-step="review"
                      className="space-y-3"
                    >
                      <GameCard
                        eyebrow="Review · Launch"
                        title="Forecast & start"
                        tone="train"
                      >
                        <div className="space-y-3">
                          <label className="block text-[0.8125rem] text-muted">
                            Compute priority · {computePriority}/100
                            <HudRange
                              type="range"
                              min={0}
                              max={100}
                              step={5}
                              value={computePriority}
                              onChange={(event) =>
                                setComputePriority(Number(event.target.value))
                              }
                              className="mt-1"
                            />
                          </label>

                          <div
                            className="rounded-md border border-line/60 bg-void/35 p-3"
                            title={`Work ${num(trainingForecast.targetPfDays, 2)} PF·d · power ${mw(trainingForecast.powerMw)} · setup ${money(setupCost)} · data ${money(dataCost)} · daily ${money(dailyCost)}/d · capability ceiling ${capabilityLimit.capability.toFixed(2)} (${capabilityLimit.limitingFactor}) · serving host RAM ${num(hostRamGb, 2)} GB ${hostWeightFormat}`}
                          >
                            <p className="text-[0.8125rem] text-bone">
                              {forecastVerdict}
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
                              <MetricTile
                                label="ETA"
                                value={
                                  daysEst === Infinity
                                    ? "No pool"
                                    : `${daysEst.toFixed(0)}d`
                                }
                                detail={
                                  daysEst === Infinity
                                    ? "need training pool"
                                    : `${num(trainingForecast.targetPfDays, 2)} PF·d · ${trainParamsB >= 1_000 ? `${trainingForecast.minCalendarDays.toFixed(0)}d model/data pipeline floor` : "current allocation estimate"}`
                                }
                                tone={
                                  daysEst === Infinity || daysEst > 120
                                    ? "warning"
                                    : "positive"
                                }
                              />
                              <MetricTile
                                label="Budget"
                                value={money(upfront)}
                                detail={
                                  <>
                                    setup {money(setupCost)} · data{" "}
                                    {money(dataCost)}
                                    <span className="block">
                                      burn {money(dailyCost)}/d
                                    </span>
                                  </>
                                }
                                tone={
                                  state.player.cash < upfront
                                    ? "danger"
                                    : "neutral"
                                }
                              />
                              <MetricTile
                                label="Capability"
                                value={trainingForecast.expectedCapability.toFixed(
                                  2,
                                )}
                                detail={`ceiling ${capabilityLimit.capability.toFixed(2)} · ${trainingForecast.interactiveTokPerSec.toFixed(2)} tok/s`}
                                tone="positive"
                              />
                              <MetricTile
                                label="Memory"
                                value={`${num(prospectiveRamFit.candidateAllocatedGb, 0)} / ${num(needVramGb, 0)} GB`}
                                detail={
                                  <>
                                    HBM assigned / required
                                    <span className="block">
                                      host{" "}
                                      {num(
                                        prospectiveRamFit.candidateSystemRamAllocatedGb,
                                        0,
                                      )}{" "}
                                      /{" "}
                                      {num(
                                        trainingMemory.requiredSystemRamGb,
                                        0,
                                      )}{" "}
                                      GB
                                    </span>
                                  </>
                                }
                                tone={
                                  prospectiveRamFit.ready
                                    ? "positive"
                                    : "danger"
                                }
                              />
                            </div>
                            <div className="mt-2 grid gap-x-4 gap-y-1 rounded-md border border-line/40 bg-panel-2/35 px-2.5 py-2 sm:grid-cols-2">
                              {[
                                {
                                  label: "Compute",
                                  value:
                                    snap.pools.training >= 0.05 &&
                                    formatHardwareAvailable
                                      ? 1
                                      : 0,
                                  text: `${num(snap.pools.training, 2)} PF · gen ${maxHardwareGeneration || "—"}`,
                                  ready:
                                    snap.pools.training >= 0.05 &&
                                    formatHardwareAvailable,
                                },
                                {
                                  label: "HBM",
                                  value:
                                    prospectiveRamFit.candidateAllocatedGb /
                                    Math.max(1, needVramGb),
                                  text: `${num(prospectiveRamFit.candidateAllocatedGb, 0)} / ${num(needVramGb, 0)} GB`,
                                  ready:
                                    prospectiveRamFit.candidateAllocatedGb +
                                      1e-9 >=
                                    needVramGb,
                                },
                                {
                                  label: "Host RAM",
                                  value:
                                    prospectiveRamFit.candidateSystemRamAllocatedGb /
                                    Math.max(
                                      1,
                                      trainingMemory.requiredSystemRamGb,
                                    ),
                                  text: `${num(prospectiveRamFit.candidateSystemRamAllocatedGb, 0)} / ${num(trainingMemory.requiredSystemRamGb, 0)} GB`,
                                  ready:
                                    prospectiveRamFit.candidateSystemRamAllocatedGb +
                                      1e-9 >=
                                    trainingMemory.requiredSystemRamGb,
                                },
                                {
                                  label: "Data",
                                  value: trainingForecast.effectiveDataRatio,
                                  text: `${trainingForecast.effectiveDataRatio.toFixed(2)}× · modality ${trainingForecast.modalityComputeMult.toFixed(2)}×`,
                                  ready:
                                    trainingForecast.effectiveDataRatio >= 0.85,
                                },
                              ].map((readiness) => (
                                <div
                                  key={readiness.label}
                                  className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 font-mono text-[0.625rem] sm:grid-cols-[4.5rem_1fr_auto]"
                                  title={`${readiness.label}: ${readiness.text}`}
                                >
                                  <span className="text-muted">
                                    {readiness.label}
                                  </span>
                                  <span className="h-1.5 overflow-hidden rounded-full bg-void">
                                    <span
                                      className={`block h-full rounded-full ${readiness.ready ? "bg-mint" : "bg-amber"}`}
                                      style={{
                                        width: `${Math.max(0, Math.min(1, readiness.value)) * 100}%`,
                                      }}
                                    />
                                  </span>
                                  <span
                                    className={`col-span-2 text-right sm:col-span-1 ${readiness.ready ? "text-mint" : "text-amber"}`}
                                  >
                                    {readiness.text}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>

                          <BlockerList items={blockersWithName} />

                          <TrainingStartFailureBanner message={startFailure} />
                        </div>
                      </GameCard>
                    </div>
                  </div>
                </ModelsTrainingModal>
              </>
            ) : panelTab === "checkpoints" ? (
              <CheckpointWorkspace
                entries={checkpointArchiveEntries}
                jobs={jobs}
                onCreateManual={createManualTrainingCheckpoint}
                onBenchmark={(checkpointId) => {
                  setCheckpointEvaluationMode("internal");
                  setCheckpointEvaluationId(checkpointId);
                }}
                onReview={(checkpointId) => {
                  setCheckpointEvaluationMode("nda_external");
                  setCheckpointEvaluationId(checkpointId);
                }}
                onPromote={promoteTrainingCheckpoint}
                onDiscard={discardTrainingCheckpoint}
                onBranch={openCheckpointBranch}
                onRollback={rollbackTrainingJobToCheckpoint}
              />
            ) : (
              <FleetTab
                internal={internal}
                released={released}
                checkpointEvidence={checkpointEvidenceByModelId}
                pricingId={pricing.activeModelId}
                frontierCapability={publicFrontier}
                unitCostForModel={(model) =>
                  apiUnitCostPerMTok(state, snap, model, {
                    energyPricePerMWh: energyPrice,
                  }).blended
                }
                onSelect={setActiveModel}
                onRelease={handleReleaseModel}
                onDelete={deleteModel}
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
        </div>
      </div>
    </PanelScaffold>
  );
}
