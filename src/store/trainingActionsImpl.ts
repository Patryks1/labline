import {
  assignGymResearchers,
  assignGymResearchShare,
  assignGymMonthlyBudget,
  assignGymTeacher,
  assignGymAuditShare,
  buyPostTrainData,
  cancelRecipe,
  cancelRun,
  cleanPostTrainPool,
  continueDesign,
  createEndpoint,
  createGym,
  createRouter,
  discardCheckpoint,
  distillDesign,
  forecastDesign,
  forecastRecipe,
  keepCheckpoint,
  mergeCheckpoints,
  orderEval,
  pauseRun,
  renameCheckpoint,
  resolveIncident,
  resumeRun,
  retireEndpoint,
  openSourceCheckpoint,
  openSourceEndpoint,
  setEndpointTier,
  setRunPriority,
  setRunPfPerDay,
  snapshotCheckpoint,
  startRecipe,
  startRun,
  sunsetEndpoint,
  synthesizePostTrainData,
  updateEndpoint,
  upgradeGym,
} from "../sim/training";
import type { Forecast, ModelDesign, PostTrainForecast, StartResult } from "../sim/training/types";
import type { TrainingActions } from "./trainingActions";
import type { GameStore } from "./gameStore";

export type TrainingSet = (mutation: (prev: GameStore) => Partial<GameStore>) => void;

const FAILED: StartResult = { ok: false, reason: "not started" };

function applyResult(
  set: TrainingSet,
  run: (state: GameStore["state"]) => { state: GameStore["state"]; result: StartResult },
): StartResult {
  let result: StartResult = FAILED;
  set((st) => {
    const next = run(st.state);
    result = next.result;
    return { state: next.state };
  });
  return result;
}

function applyState(
  set: TrainingSet,
  run: (state: GameStore["state"]) => GameStore["state"],
): void {
  set((st) => ({ state: run(st.state) }));
}

export function createTrainingActions(
  set: TrainingSet,
  get: () => GameStore,
): TrainingActions {
  const playerLabId = () => get().state.playerLabId;

  return {
    forecastDesign: (design: ModelDesign): Forecast =>
      forecastDesign(get().state, playerLabId(), design),

    forecastRecipe: (input): PostTrainForecast =>
      forecastRecipe(get().state, playerLabId(), input),

    startRun: (design) =>
      applyResult(set, (state) => startRun(state, state.playerLabId, design)),

    pauseRun: (runId) => applyState(set, (state) => pauseRun(state, runId)),

    resumeRun: (runId) => applyState(set, (state) => resumeRun(state, runId)),

    cancelRun: (runId) => applyState(set, (state) => cancelRun(state, runId)),

    setRunPriority: (runId, priority) =>
      applyState(set, (state) => setRunPriority(state, runId, priority)),

    setRunPfPerDay: (runId, pfPerDay) =>
      applyState(set, (state) => setRunPfPerDay(state, runId, pfPerDay)),

    resolveIncident: (runId, incidentId, choiceId) =>
      applyState(set, (state) => resolveIncident(state, runId, incidentId, choiceId)),

    snapshotCheckpoint: (runId, name) =>
      applyState(set, (state) => snapshotCheckpoint(state, runId, { name }).state),

    keepCheckpoint: (id) => applyState(set, (state) => keepCheckpoint(state, id)),

    discardCheckpoint: (id) => applyState(set, (state) => discardCheckpoint(state, id)),

    renameCheckpoint: (id, name) =>
      applyState(set, (state) => renameCheckpoint(state, id, name)),

    openSourceCheckpoint: (id) =>
      applyState(set, (state) => openSourceCheckpoint(state, id)),

    openSourceEndpoint: (id) =>
      applyState(set, (state) => openSourceEndpoint(state, id)),

    startDistill: (input) =>
      applyResult(set, (state) => {
        const design = distillDesign(state, state.playerLabId, input);
        return startRun(state, state.playerLabId, design);
      }),

    startContinue: (input) =>
      applyResult(set, (state) => {
        const design = continueDesign(state, state.playerLabId, input);
        return startRun(state, state.playerLabId, design);
      }),

    mergeCheckpoints: (aId, bId, name) =>
      applyResult(set, (state) => mergeCheckpoints(state, aId, bId, name)),

    startRecipe: (input) =>
      applyResult(set, (state) => startRecipe(state, state.playerLabId, input)),

    cancelRecipe: (id) => applyState(set, (state) => cancelRecipe(state, id)),

    orderEval: (input) =>
      applyResult(set, (state) => orderEval(state, state.playerLabId, input)),

    createEndpoint: (input) =>
      applyResult(set, (state) => createEndpoint(state, state.playerLabId, input)),

    createRouter: (input) =>
      applyResult(set, (state) => createRouter(state, state.playerLabId, input)),

    updateEndpoint: (id, patch) =>
      applyState(set, (state) => updateEndpoint(state, id, patch)),

    setEndpointTier: (id, budget, served) =>
      applyState(set, (state) => setEndpointTier(state, id, budget, served)),

    sunsetEndpoint: (id, drainDays) =>
      applyState(set, (state) => sunsetEndpoint(state, id, drainDays)),

    retireEndpoint: (id) => applyState(set, (state) => retireEndpoint(state, id)),

    createGym: (kind) =>
      applyResult(set, (state) => createGym(state, state.playerLabId, kind)),

    upgradeGym: (id) => applyState(set, (state) => upgradeGym(state, id)),

    assignGymResearchers: (id, n) =>
      applyState(set, (state) => assignGymResearchers(state, id, n)),

    assignGymResearchShare: (id, share) =>
      applyState(set, (state) => assignGymResearchShare(state, id, share)),

    assignGymMonthlyBudget: (id, monthly) =>
      applyState(set, (state) => assignGymMonthlyBudget(state, id, monthly)),

    assignGymTeacher: (id, checkpointId) =>
      applyState(set, (state) => assignGymTeacher(state, id, checkpointId)),

    assignGymAuditShare: (id, share) =>
      applyState(set, (state) => assignGymAuditShare(state, id, share)),

    cleanPostTrainPool: (kind) =>
      applyState(set, (state) => cleanPostTrainPool(state, kind)),

    buyPostTrainData: (kind, amount) =>
      applyState(set, (state) => buyPostTrainData(state, kind, amount)),

    synthesizePostTrainData: (input) =>
      applyResult(set, (state) => synthesizePostTrainData(state, input)),
  };
}
