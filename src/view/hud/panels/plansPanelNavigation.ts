import type { SubPlan } from "../../../sim/types";

export const PLANS_TAB_IDS = ["demand", "tiers", "api"] as const;
export type PlansTabId = (typeof PLANS_TAB_IDS)[number];

/** Sentinel rendered after the last plan so creation never precedes an existing tier. */
export const NEW_PLAN_SELECTOR_ID = "__new_plan__";

export function planSelectorOrder(
  plans: Pick<SubPlan, "id">[],
): string[] {
  return [...plans.map((plan) => plan.id), NEW_PLAN_SELECTOR_ID];
}
