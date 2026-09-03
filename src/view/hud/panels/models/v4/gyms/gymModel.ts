import {
  GYM_BUDGET_MONTH_MAX,
  GYM_BUDGET_MONTH_STEP,
  GYM_CREATE_CASH,
  GYM_DAYS_PER_MONTH,
  GYM_RESEARCH_SHARE_MAX,
  GYM_RESEARCH_SHARE_STEP,
  GYM_RESEARCHER_MAX,
  GYM_TIER_MONTHLY,
} from "../../../../../../sim/training/gyms";
import type { GymKind } from "../../../../../../sim/training/types";

export {
  GYM_BUDGET_MONTH_MAX,
  GYM_BUDGET_MONTH_STEP,
  GYM_CREATE_CASH,
  GYM_DAYS_PER_MONTH,
  GYM_RESEARCH_SHARE_MAX,
  GYM_RESEARCH_SHARE_STEP,
  GYM_RESEARCHER_MAX,
  GYM_TIER_MONTHLY,
};

export const GYM_KINDS: readonly GymKind[] = [
  "code",
  "math",
  "science",
  "agentic",
  "safety",
];

export const GYM_COPY: Record<GymKind, { title: string; blurb: string }> = {
  code: {
    title: "Code gym",
    blurb: "Code gym - verifiable programming tasks",
  },
  math: {
    title: "Math gym",
    blurb: "Math gym - verifiable math problems",
  },
  science: {
    title: "Science gym",
    blurb: "Science gym - scientific reasoning tasks",
  },
  agentic: {
    title: "Agentic gym",
    blurb: "Agentic gym - tool-use trajectories",
  },
  safety: {
    title: "Safety gym",
    blurb: "Safety gym - adversarial and refusal tasks",
  },
};

export function gymNextTierMonthly(currentTier: number): number | null {
  if (currentTier < 0 || currentTier >= 3) return null;
  return GYM_TIER_MONTHLY[currentTier + 1] ?? null;
}
