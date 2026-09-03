import { TRAINING_V4 } from "./constants";
import { emptyTrainingState } from "./state";
import type { TrainingState } from "./types";

/**
 * Player new-game slice: one tier-0 code gym, a small post-train pool, and season 1.
 * `seed` keys the gym id; `day` is the season start (createGame passes 0).
 */
export function starterTrainingState(seed: number, day: number): TrainingState {
  const tier = TRAINING_V4.gyms.tiers[0];
  return {
    ...emptyTrainingState(),
    gyms: [
      {
        id: `gym-${seed}-code`,
        labId: "player",
        kind: "code",
        tier: 0,
        quality: tier.quality,
        tasksPerDay: tier.tasksPerDay,
        researchers: 0,
        researchShare: 0,
        budgetPerDay: 0,
        auditShare: 0,
      },
    ],
    pools: {
      instructionMTok: 2,
      preferenceMTok: 0.5,
      verifiableTasks: 200,
      toolTrajectories: 0,
    },
    poolQuality: {
      instructionMTok: 0.55,
      preferenceMTok: 0.55,
      verifiableTasks: 0.4,
      toolTrajectories: 0,
    },
    seasons: [
      {
        season: 1,
        startDay: day,
        difficultyIndex: 1,
        contamination: {},
      },
    ],
  };
}
