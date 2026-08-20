import { HudButton } from "../../ui/HudPrimitives";
import {
  CAMPAIGN_SPINE_STEPS,
  type CampaignSpineId,
} from "./trainingPresentation";

export function CampaignSpine({
  current,
  focus,
  onFocus,
}: {
  current: CampaignSpineId;
  focus: CampaignSpineId;
  onFocus: (step: CampaignSpineId) => void;
}) {
  const currentIndex = CAMPAIGN_SPINE_STEPS.findIndex(
    (step) => step.id === current,
  );

  return (
    <nav
      aria-label="Campaign stages"
      data-campaign-spine="true"
      className="rounded-lg border border-mint/35 bg-mint/5 px-2 py-2"
    >
      <ol className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        {CAMPAIGN_SPINE_STEPS.map((step, index) => {
          const active = focus === step.id;
          const reached = index <= currentIndex;
          return (
            <li key={step.id} className="min-w-0">
              <HudButton
                type="button"
                variant="ghost"
                aria-current={active ? "step" : undefined}
                aria-label={`${step.label}. ${step.hint}`}
                data-campaign-step={step.id}
                data-state={
                  active ? "active" : reached ? "reached" : "upcoming"
                }
                onClick={() => onFocus(step.id)}
                className={`!flex !min-h-11 !w-full !flex-col !items-start !justify-center !gap-0.5 !rounded-md !border-0 !px-1.5 !py-1 !text-left ${
                  active
                    ? "!bg-mint/15 !text-mint"
                    : reached
                      ? "!bg-transparent !text-bone hover:!bg-panel-2"
                      : "!bg-transparent !text-muted hover:!bg-panel-2 hover:!text-bone"
                }`}
              >
                <span
                  aria-hidden
                  className={`font-mono text-[0.5625rem] tabular-nums ${
                    active ? "text-mint" : "text-muted"
                  }`}
                >
                  {index + 1}
                </span>
                <span className="truncate text-[0.6875rem] font-semibold leading-none">
                  {step.label}
                </span>
              </HudButton>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
