import { HudButton } from "../../../../ui/HudPrimitives";
import type { ThinkingTier, TierBudget } from "../../../../../../sim/training/types";
import { trainedThinkingBudgets } from "../../../../../../sim/training/thinking";
import { useGameStore } from "../../../../../../store/gameStore";
import { nextTiers, tierLabel, trySim } from "./fleetModel";

const LAST_SERVED_TITLE = "At least one served tier must remain on";

export function TiersControl({
  endpointId,
  tiers,
}: {
  endpointId: string;
  tiers: ThinkingTier[];
}) {
  const setEndpointTier = useGameStore((s) => s.setEndpointTier);
  const trained = trainedThinkingBudgets({ tiers });

  const toggle = (budget: TierBudget) => {
    const current = tiers.find((tier) => tier.budget === budget);
    if (!current) return;
    const served = !current.served;
    if (!nextTiers(tiers, budget, served)) return;
    trySim(() => {
      setEndpointTier(endpointId, budget, served);
    }, undefined);
  };

  return (
    <div
      className="models-v4-actions"
      role="group"
      aria-label="Thinking tiers"
      data-tiers-control={endpointId}
    >
      {trained.map((budget) => {
        const entry = tiers.find((tier) => tier.budget === budget);
        const lastServed =
          Boolean(entry?.served) && tiers.filter((tier) => tier.served).length <= 1;
        const title = lastServed ? LAST_SERVED_TITLE : undefined;
        return (
          <HudButton
            key={budget}
            variant={entry?.served ? "primary" : "ghost"}
            className="min-h-11 min-w-0 font-mono"
            aria-pressed={entry?.served === true}
            disabled={lastServed}
            disabledReason={title}
            title={title}
            onClick={() => toggle(budget)}
          >
            {tierLabel(budget)}
          </HudButton>
        );
      })}
    </div>
  );
}
