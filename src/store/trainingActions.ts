import type {
  Endpoint,
  Forecast,
  GymKind,
  ModelDesign,
  PostTrainForecast,
  PostTrainPoolKind,
  StartResult,
  TierBudget,
} from "../sim/training/types";

type DistillInput = Parameters<typeof import("../sim/training/distill").distillDesign>[2];
type ContinueInput = Parameters<typeof import("../sim/training/continue").continueDesign>[2];
type RecipeInput = Parameters<typeof import("../sim/training/postTrain").forecastRecipe>[2];
type OrderEvalInput = Parameters<typeof import("../sim/training/evaluate").orderEval>[2];
type CreateEndpointInput = Parameters<typeof import("../sim/training/endpoints").createEndpoint>[2];
type CreateRouterInput = Parameters<typeof import("../sim/training/endpoints").createRouter>[2];
type SynthesizeInput = Parameters<
  typeof import("../sim/training/postTrain").synthesizePostTrainData
>[1];

export interface TrainingActions {
  forecastDesign(design: ModelDesign): Forecast;
  forecastRecipe(input: RecipeInput): PostTrainForecast;
  startRun(design: ModelDesign): StartResult;
  pauseRun(runId: string): void;
  resumeRun(runId: string): void;
  cancelRun(runId: string): void;
  setRunPriority(runId: string, priority: number): void;
  setRunPfPerDay(runId: string, pfPerDay: number): void;
  resolveIncident(runId: string, incidentId: string, choiceId: string): void;
  snapshotCheckpoint(runId: string, name?: string): void;
  keepCheckpoint(id: string): void;
  discardCheckpoint(id: string): void;
  renameCheckpoint(id: string, name: string): void;
  openSourceCheckpoint(id: string): void;
  openSourceEndpoint(id: string): void;
  startDistill(input: DistillInput): StartResult;
  startContinue(input: ContinueInput): StartResult;
  mergeCheckpoints(aId: string, bId: string, name: string): StartResult;
  startRecipe(input: RecipeInput): StartResult;
  cancelRecipe(id: string): void;
  orderEval(input: OrderEvalInput): StartResult;
  createEndpoint(input: CreateEndpointInput): StartResult;
  createRouter(input: CreateRouterInput): StartResult;
  updateEndpoint(
    id: string,
    patch: Partial<
      Pick<Endpoint, "name" | "members" | "policy" | "precision" | "pricing" | "openWeights">
    >,
  ): void;
  setEndpointTier(id: string, budget: TierBudget, served: boolean): void;
  sunsetEndpoint(id: string, drainDays: number): void;
  retireEndpoint(id: string): void;
  createGym(kind: GymKind): StartResult;
  upgradeGym(id: string): void;
  assignGymResearchers(id: string, n: number): void;
  assignGymResearchShare(id: string, share: number): void;
  assignGymMonthlyBudget(id: string, monthly: number): void;
  assignGymTeacher(id: string, checkpointId: string): void;
  assignGymAuditShare(id: string, share: number): void;
  cleanPostTrainPool(kind: PostTrainPoolKind): void;
  buyPostTrainData(kind: PostTrainPoolKind, amount: number): void;
  synthesizePostTrainData(input: SynthesizeInput): StartResult;
}
