import { useEffect, useRef } from "react";
import { useGameStore } from "../../../../store/gameStore";
import { useUiStore } from "../../../../store/uiStore";
import { playerTrainingJobs } from "../../../../sim/systems/training";
import { CampaignDecisionModal } from "./CampaignDecisionModal";

/** Global campaign-incident modal. Auto-opens once per event, even off Models. */
export function CampaignDecisionHost() {
  const state = useGameStore((s) => s.state);
  const resolveTrainingCampaignEvent = useGameStore(
    (s) => s.resolveTrainingCampaignEvent,
  );
  const openJobId = useUiStore((s) => s.campaignDecisionJobId);
  const openCampaignDecision = useUiStore((s) => s.openCampaignDecision);
  const closeCampaignDecision = useUiStore((s) => s.closeCampaignDecision);
  const seenEventIds = useRef(new Set<string>());
  const jobs = playerTrainingJobs(state);

  useEffect(() => {
    for (const job of jobs) {
      const event = job.pendingCampaignEvent;
      if (!event || seenEventIds.current.has(event.id)) continue;
      seenEventIds.current.add(event.id);
      openCampaignDecision(job.id);
      break;
    }
  }, [jobs, openCampaignDecision]);

  useEffect(() => {
    if (!openJobId) return;
    const job = jobs.find((candidate) => candidate.id === openJobId);
    if (!job?.pendingCampaignEvent) {
      closeCampaignDecision();
    }
  }, [closeCampaignDecision, jobs, openJobId]);

  const job = jobs.find((candidate) => candidate.id === openJobId);
  const event = job?.pendingCampaignEvent;
  if (!job) return null;
  if (!event) return null;

  return (
    <CampaignDecisionModal
      open
      job={job}
      event={event}
      cash={state.player.cash}
      researcherCount={state.player.staff?.researcher ?? 0}
      onClose={closeCampaignDecision}
      onConfirm={(choiceId) => {
        resolveTrainingCampaignEvent(job.id, choiceId);
        closeCampaignDecision();
      }}
    />
  );
}
