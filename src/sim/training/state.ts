import type { LabId, SimState } from "../types";
import type { Architecture, ModelDesign, PostTrainPools, TrainingState } from "./types";

function emptyPools(): PostTrainPools {
  return {
    instructionMTok: 0,
    preferenceMTok: 0,
    verifiableTasks: 0,
    toolTrajectories: 0,
  };
}

export function emptyTrainingState(): TrainingState {
  return {
    runs: [],
    checkpoints: [],
    recipes: [],
    evals: [],
    endpoints: [],
    gyms: [],
    pools: emptyPools(),
    reservations: [],
    seasons: [],
    biggestTrainedParamsB: 0,
    moeRunsCompleted: 0,
  };
}

/** Player → `state.player.training ?? empty`; rival → matching `rivals[i].training ?? empty`. */
export function trainingStateOf(state: SimState, labId: LabId): TrainingState {
  if (labId === state.playerLabId) {
    return state.player.training ?? emptyTrainingState();
  }
  const rival = state.rivals.find((candidate) => candidate.id === labId);
  return rival?.training ?? emptyTrainingState();
}

/** Immutable player or rival training-slice replacement. */
export function withTrainingState(
  state: SimState,
  labId: LabId,
  next: TrainingState,
): SimState {
  if (labId === state.playerLabId) {
    return {
      ...state,
      player: { ...state.player, training: next },
    };
  }
  return {
    ...state,
    rivals: state.rivals.map((rival) =>
      rival.id === labId ? { ...rival, training: next } : rival,
    ),
  };
}

/** Dense 7B fp32 language, 4k context, text→text. */
export function defaultArchitecture(): Architecture {
  return {
    backbone: "dense",
    totalParamsB: 7,
    activeParamsB: 7,
    precision: "fp32",
    preset: "language",
    inputs: ["text"],
    outputs: ["text"],
    contextK: 4,
  };
}

export function defaultDesign(day: number): ModelDesign {
  return {
    id: "design-default",
    name: "Untitled",
    goal: "flagship",
    arch: defaultArchitecture(),
    data: { domainMTok: {}, holdoutShare: 0.05 },
    mode: { kind: "pretrain" },
    compute: { pfPerDay: 1, priority: 1, source: "local" },
    createdDay: day,
  };
}
