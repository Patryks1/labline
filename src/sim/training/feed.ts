import { pushAlert } from "../alerts";
import { seededId } from "../rng";
import { appendFeedEvents } from "../systems/feed";
import type { LabId, SimAlert, SimState, WorldFeedCategory, WorldFeedTone } from "../types";

export interface TrainingFeedInput {
  title: string;
  body: string;
  labId: LabId;
  kind: string;
  tone?: WorldFeedTone;
  entityId?: string;
  alert?: { severity: SimAlert["severity"]; message: string };
}

function categoryFor(state: SimState, labId: LabId): WorldFeedCategory {
  return labId === state.playerLabId ? "models" : "rivals";
}

/** Append a models/rivals journal row, a news line, and an optional HUD alert. */
export function pushTrainingFeed(state: SimState, input: TrainingFeedInput): SimState {
  const day = state.day;
  const id = seededId("feed", input.kind, input.labId, input.entityId, input.title, day);
  let next: SimState = {
    ...state,
    alerts: state.alerts ?? [],
    news: state.news ?? [],
  };
  next = {
    ...next,
    news: [`Day ${day}: ${input.title} — ${input.body}`, ...next.news].slice(0, 64),
  };
  next = appendFeedEvents(next, [
    {
      id,
      day,
      category: categoryFor(state, input.labId),
      title: input.title,
      body: input.body,
      source: "Training Desk",
      tone: input.tone ?? "neutral",
      entityId: input.labId,
      kind: input.kind,
    },
  ]);
  if (input.alert) {
    const alertId = seededId("alert", input.kind, input.labId, input.entityId, day);
    next = pushAlert(next, input.alert.severity, input.alert.message, alertId);
  }
  return next;
}
