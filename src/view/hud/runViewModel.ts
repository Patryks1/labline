import type { SimState } from "../../sim/types";
import { trainingStateOf } from "../../sim/training/state";
import { allocateLabTrainingPf } from "../../sim/training/run";
import type { PostTrainRecipe, TrainingRun } from "../../sim/training/types";
import { sizeLabel } from "./panels/models/viewModels/selectors";

export interface RunActivityVM {
  runId: string;
  name: string;
  sizeLabel: string;
  progress: number;
  etaDays: number;
  pendingDecision: boolean;
  band: { p10: number; p50: number; p90: number };
  incidentCount: number;
  /** Other active runs + running recipes besides the primary item. */
  secondaryCount: number;
  kind: "run" | "recipe";
}

const ACTIVE_RUN: ReadonlySet<TrainingRun["status"]> = new Set([
  "queued",
  "running",
  "paused",
  "awaiting_decision",
]);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function unresolvedIncidents(run: TrainingRun): number {
  return run.incidents.filter((incident) => incident.resolvedChoiceId == null).length;
}

function recipeName(state: SimState, recipe: PostTrainRecipe): string {
  const training = trainingStateOf(state, state.playerLabId);
  const checkpoint = training.checkpoints.find((row) => row.id === recipe.checkpointId);
  return checkpoint?.name ? `${checkpoint.name} recipe` : "Post-train recipe";
}

function recipeVm(state: SimState, recipe: PostTrainRecipe, secondaryCount: number): RunActivityVM {
  const training = trainingStateOf(state, state.playerLabId);
  const checkpoint = training.checkpoints.find((row) => row.id === recipe.checkpointId);
  const remainingPf = Math.max(0, recipe.forecast.pfDays - recipe.pfDaysDone);
  let etaDays = remainingPf > 0 ? Number.POSITIVE_INFINITY : 0;
  try {
    const share = allocateLabTrainingPf(state, state.playerLabId)[recipe.id] ?? 0;
    if (share > 1e-9) etaDays = remainingPf / share;
  } catch {
    etaDays = recipe.forecast.days * Math.max(0, 1 - clamp01(recipe.progress));
  }
  return {
    runId: recipe.id,
    name: recipeName(state, recipe),
    sizeLabel: checkpoint ? sizeLabel(checkpoint.arch) : "-",
    progress: clamp01(recipe.progress),
    etaDays,
    pendingDecision: false,
    band: { p10: 0, p50: 0, p90: 0 },
    incidentCount: 0,
    secondaryCount,
    kind: "recipe",
  };
}

function runVm(run: TrainingRun, secondaryCount: number): RunActivityVM {
  const band = run.forecast.capability;
  return {
    runId: run.id,
    name: run.design.name,
    sizeLabel: sizeLabel(run.design.arch),
    progress: clamp01(run.progress),
    etaDays: run.etaDays,
    pendingDecision: run.status === "awaiting_decision",
    band: { p10: band.p10, p50: band.p50, p90: band.p90 },
    incidentCount: unresolvedIncidents(run),
    secondaryCount,
    kind: "run",
  };
}

function compareProgressThenId(
  a: { progress: number; id: string },
  b: { progress: number; id: string },
): number {
  const byProgress = b.progress - a.progress;
  return byProgress !== 0 ? byProgress : a.id.localeCompare(b.id);
}

/**
 * Most urgent player activity: a run awaiting a decision, else the highest-
 * progress active run, else a running post-train recipe.
 */
export function runActivityViewModel(state: SimState): RunActivityVM | null {
  const training = trainingStateOf(state, state.playerLabId);
  const activeRuns = training.runs.filter((run) => ACTIVE_RUN.has(run.status));
  const runningRecipes = training.recipes.filter((recipe) => recipe.status === "running");
  const total = activeRuns.length + runningRecipes.length;
  if (total === 0) return null;
  const secondaryCount = Math.max(0, total - 1);

  const awaiting = activeRuns
    .filter((run) => run.status === "awaiting_decision")
    .toSorted(compareProgressThenId);
  const leadAwaiting = awaiting[0];
  if (leadAwaiting) return runVm(leadAwaiting, secondaryCount);

  const leadRun = [...activeRuns].toSorted(compareProgressThenId)[0];
  if (leadRun) return runVm(leadRun, secondaryCount);

  const leadRecipe = [...runningRecipes].toSorted(compareProgressThenId)[0];
  return leadRecipe ? recipeVm(state, leadRecipe, secondaryCount) : null;
}
