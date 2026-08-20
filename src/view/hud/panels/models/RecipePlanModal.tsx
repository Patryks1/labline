import { ConsoleDialog } from "../../ui/ConsoleDialog";
import { EmptyState, HudButton, StatusChip } from "../../ui/HudPrimitives";
import {
  DATA_DOMAIN_META,
  DATA_DOMAINS,
  formatTokens,
} from "../../../../sim/balance/data";
import { formatParams } from "../../../../sim/balance/training";
import type { RecipePlan } from "./recipePlan";

function topDomains(plan: RecipePlan): string {
  return [...DATA_DOMAINS]
    .sort((a, b) => (plan.weights[b] ?? 0) - (plan.weights[a] ?? 0))
    .slice(0, 3)
    .filter((domain) => (plan.weights[domain] ?? 0) > 0.04)
    .map((domain) => DATA_DOMAIN_META[domain].label)
    .join(" · ");
}

export function RecipePlanModal({
  open,
  plans,
  onClose,
  onChoose,
}: {
  open: boolean;
  plans: readonly RecipePlan[];
  onClose: () => void;
  onChoose: (plan: RecipePlan) => void;
}) {
  return (
    <ConsoleDialog
      open={open}
      titleId="recipe-plan-library"
      eyebrow="Data recipe"
      title="Load a mix"
      description="Start from a previous model's spider, then change it on the radar."
      onClose={onClose}
      closeLabel="Close mix library"
      maxWidthClass="max-w-lg"
    >
      {plans.length === 0 ? (
        <EmptyState
          title="No saved mixes"
          description="Finish a training run to keep its spider as a starting plan."
        />
      ) : (
        <ul className="space-y-2" data-recipe-plan-list="true">
          {plans.map((plan) => (
            <li key={plan.id}>
              <div className="flex items-start justify-between gap-3 rounded-lg border border-line/70 bg-panel-2/50 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-bone">
                    {plan.name}
                  </p>
                  <p className="mt-0.5 font-mono text-[0.625rem] tabular-nums text-muted">
                    {plan.paramsB != null ? formatParams(plan.paramsB) : "—"}
                    {plan.capability != null
                      ? ` · cap ${plan.capability.toFixed(0)}`
                      : ""}
                    {plan.quality != null
                      ? ` · Q${plan.quality.toFixed(0)}`
                      : ""}
                    {plan.tokensMTok != null
                      ? ` · ${formatTokens(plan.tokensMTok)}`
                      : ""}
                  </p>
                  <p className="mt-1 text-[0.6875rem] text-muted">
                    {topDomains(plan) || "Flat mix"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <StatusChip tone="neutral">
                    {Math.round(plan.postTrainShare * 100)}% align
                  </StatusChip>
                  <HudButton
                    type="button"
                    variant="primary"
                    className="!min-h-9 !px-2.5 !text-[0.6875rem]"
                    onClick={() => onChoose(plan)}
                  >
                    Use plan
                  </HudButton>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ConsoleDialog>
  );
}
