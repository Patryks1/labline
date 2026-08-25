import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import {
  availableHqStaff,
  reservedHqStaff,
  unreservedStaffHeadcount,
} from "./staffReservations";

describe("shared HQ staff reservations", () => {
  it("prevents pods, gyms, safety, and data audits from reusing staff", () => {
    const base = createGame(991);
    const state = {
      ...base,
      player: {
        ...base.player,
        staff: { researcher: 20, engineer: 8, data_processor: 6, ops: 2 },
        researchPods: [
          {
            id: "pod-a",
            name: "A",
            leadId: "lead-a",
            focus: "data" as const,
            researchers: 5,
            engineers: 2,
            dataStaff: 3,
            assignmentId: null,
          },
        ],
        postTrainGyms: base.player.postTrainGyms?.map((gym) =>
          gym.kind === "code" ? { ...gym, assignedResearchers: 4 } : gym,
        ),
        safetyCampaign: {
          id: "safety",
          modelId: "m",
          modelName: "M",
          intensity: "targeted" as const,
          assignedResearchers: 3,
          minimumResearchers: 3,
          targetTrainingPfDays: 1,
          targetResearchPfDays: 1,
          progressTrainingPfDays: 0,
          progressResearchPfDays: 0,
          cashBudget: 1,
          cashSpent: 0,
          safetyDataMTok: 1,
          safetyDataQuality: 70,
          startDay: base.day,
        },
        data: {
          ...base.player.data,
          pruneQueue: [
            {
              id: "audit",
              domain: "code" as const,
              rawRemaining: 1,
              processedRemaining: 0,
              rawTotal: 1,
              processedTotal: 0,
              cashPerMTok: 1,
              pfDaysPerMTok: 1,
              researchersRequired: 2,
              engineersRequired: 2,
              researchShare: 0.08,
              qualityBefore: 20,
            },
          ],
        },
      },
    };

    expect(reservedHqStaff(state)).toEqual({
      researchers: 14,
      engineers: 4,
      dataStaff: 3,
    });
    expect(availableHqStaff(state)).toEqual({
      researchers: 6,
      engineers: 4,
      dataStaff: 3,
    });
    expect(unreservedStaffHeadcount(state)).toEqual({
      researcher: 6,
      engineer: 4,
      data_processor: 3,
      ops: 2,
    });
  });
});
