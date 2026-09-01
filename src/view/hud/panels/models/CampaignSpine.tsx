import { HudButton } from "../../ui/HudPrimitives";
import {
  CAMPAIGN_SPINE_STEPS,
  type CampaignSpineId,
} from "./trainingPresentation";

const STEP_TONE: Record<
  CampaignSpineId,
  { chip: string; active: string; reached: string; ink: string }
> = {
  base: {
    chip: "border-train/50 bg-train/15 text-train",
    active: "!border-train/60 !bg-train/20 !text-train",
    reached: "!border-train/25 !bg-train/5 !text-bone hover:!bg-train/10",
    ink: "text-train",
  },
  eval: {
    chip: "border-research/50 bg-research/15 text-research",
    active: "!border-research/60 !bg-research/20 !text-research",
    reached: "!border-research/25 !bg-research/5 !text-bone hover:!bg-research/10",
    ink: "text-research",
  },
  align: {
    chip: "border-mint/50 bg-mint/15 text-mint",
    active: "!border-mint/60 !bg-mint/20 !text-mint",
    reached: "!border-mint/25 !bg-mint/5 !text-bone hover:!bg-mint/10",
    ink: "text-mint",
  },
  ship: {
    chip: "border-amber/50 bg-amber/15 text-amber",
    active: "!border-amber/60 !bg-amber/20 !text-amber",
    reached: "!border-amber/25 !bg-amber/5 !text-bone hover:!bg-amber/10",
    ink: "text-amber",
  },
};

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
      className="rounded-lg border border-line/70 bg-void/40 px-2 py-2"
    >
      <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {CAMPAIGN_SPINE_STEPS.map((step, index) => {
          const active = focus === step.id;
          const reached = index <= currentIndex;
          const tone = STEP_TONE[step.id];
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
                className={`!flex !min-h-11 !w-full !flex-col !items-start !justify-center !gap-0.5 !rounded-md !border !px-2 !py-1.5 !text-left ${
                  active
                    ? tone.active
                    : reached
                      ? tone.reached
                      : "!border-line/40 !bg-transparent !text-muted hover:!bg-panel-2 hover:!text-bone"
                }`}
              >
                <span
                  aria-hidden
                  className={`inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 font-mono text-[0.5rem] font-semibold tabular-nums ${
                    active || reached ? tone.chip : "border border-line/50 text-muted"
                  }`}
                >
                  {index + 1}
                </span>
                <span className={`truncate text-[0.75rem] font-semibold leading-none ${
                  active ? tone.ink : ""
                }`}>
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
