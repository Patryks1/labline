import type {
  TrainingCampaignChoice,
  TrainingCampaignEvent,
  TrainingJob,
} from "../../../../sim/types";
import {
  campaignDecisionOptions,
  dutyScientistCampaignChoice,
} from "../../../../sim/balance/trainingCampaign";
import { describeCampaignIntervention } from "../../../../sim/balance/trainingCampaignIntervention";
import { money } from "../../format";
import { ConsoleDialog } from "../../ui/ConsoleDialog";
import { StatusChip } from "../../ui/HudPrimitives";

export function CampaignDecisionModal({
  open,
  job,
  event,
  cash,
  researcherCount,
  onClose,
  onConfirm,
}: {
  open: boolean;
  job: TrainingJob;
  event: TrainingCampaignEvent;
  cash: number;
  researcherCount: number;
  onClose: () => void;
  onConfirm: (choiceId: string) => void;
}) {
  const options = campaignDecisionOptions(event);
  const duty = dutyScientistCampaignChoice(event);

  return (
    <ConsoleDialog
      open={open}
      titleId="campaign-decision-title"
      eyebrow={`${job.name} · ${(event.milestone * 100).toFixed(0)}% gate`}
      title={event.title}
      description={event.description}
      mobileDescription={`Resolve by day ${event.decisionDeadlineDay}.`}
      onClose={onClose}
      closeLabel="Decide later"
      maxWidthClass="max-w-3xl"
    >
      <div className="space-y-3" data-campaign-decision-modal="true">
        <p className="font-mono text-[0.6875rem] leading-5 text-muted">
          Signal: {event.signal}
        </p>
        <p className="rounded-md border border-line/60 bg-void/35 px-2.5 py-2 font-mono text-[0.6875rem] leading-5 text-muted">
          Safe default (AFK) · {duty.label} applies on D
          {event.decisionDeadlineDay} if you walk away ·{" "}
          {describeCampaignIntervention(duty.effects)}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {options.map((choice) => (
            <DecisionOption
              key={choice.id}
              choice={choice}
              cash={cash}
              researcherCount={researcherCount}
              onConfirm={() => onConfirm(choice.id)}
            />
          ))}
        </div>
        <p className="font-mono text-[0.625rem] text-muted">
          One base incident. Closing this keeps the run paused until you pick
          or the AFK default fires. Deadline D{event.decisionDeadlineDay}.
        </p>
      </div>
    </ConsoleDialog>
  );
}

function DecisionOption({
  choice,
  cash,
  researcherCount,
  onConfirm,
}: {
  choice: TrainingCampaignChoice;
  cash: number;
  researcherCount: number;
  onConfirm: () => void;
}) {
  const cost = choice.effects.cashCost ?? 0;
  const staff = choice.effects.minResearchers ?? 0;
  const unaffordable = cash + 1e-9 < cost;
  const understaffed = researcherCount < staff;
  const disabled = unaffordable || understaffed;
  return (
    <button
      type="button"
      disabled={disabled}
      title={
        unaffordable
          ? `Need ${money(cost)}.`
          : understaffed
            ? `Need ${staff} researchers.`
            : undefined
      }
      onClick={onConfirm}
      className="rounded-md border border-line/60 bg-void/40 p-3 text-left transition hover:border-train/55 hover:bg-train/10 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="flex items-start justify-between gap-2">
        <strong className="text-[0.8125rem] text-bone">{choice.label}</strong>
        {cost > 0 ? (
          <StatusChip tone="warning">{money(cost)}</StatusChip>
        ) : (
          <StatusChip tone="neutral">No cash</StatusChip>
        )}
      </span>
      <span className="mt-1.5 block text-[0.75rem] leading-5 text-muted">
        {choice.description}
      </span>
      <span className="mt-2 block font-mono text-[0.625rem] leading-4 text-bone">
        {describeCampaignIntervention(choice.effects)}
      </span>
    </button>
  );
}
