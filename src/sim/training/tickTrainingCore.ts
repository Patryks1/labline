import type { SimState } from "../types";
import { tickEvals, tickSeasons } from "./evaluate";
import { tickEndpoints } from "./endpoints";
import { tickGyms, tickRecipes } from "./postTrain";
import { tickRivalTraining } from "./rivals";
import { tickRuns } from "./run";

const warnedSteps = new Set<string>();

function runStep(
  name: string,
  fn: (state: SimState) => SimState,
  state: SimState,
): SimState {
  try {
    return fn(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("not implemented:")) throw error;
    if (!warnedSteps.has(name)) {
      warnedSteps.add(name);
      console.warn(`tickTrainingCore: skipped ${name} (${message})`);
    }
    return state;
  }
}

/**
 * Ordered V4 training tick. Rival planning starts runs before `tickRuns`
 * advances them. Each step is isolated so unimplemented workstreams skip
 * without stalling the rest of the game. Not wired into `src/sim/tick.ts` yet.
 */
export function tickTrainingCore(state: SimState): SimState {
  let next = state;
  next = runStep("tickGyms", tickGyms, next);
  next = runStep("tickRecipes", tickRecipes, next);
  next = runStep("tickRivalTraining", tickRivalTraining, next);
  next = runStep("tickRuns", tickRuns, next);
  next = runStep("tickEvals", tickEvals, next);
  next = runStep("tickSeasons", tickSeasons, next);
  next = runStep("tickEndpoints", tickEndpoints, next);
  return next;
}

/** Same order as `tickTrainingCore` without the per-step try/catch. */
export function tickTrainingCoreStrict(state: SimState): SimState {
  let next = tickGyms(state);
  next = tickRecipes(next);
  next = tickRivalTraining(next);
  next = tickRuns(next);
  next = tickEvals(next);
  next = tickSeasons(next);
  next = tickEndpoints(next);
  return next;
}
