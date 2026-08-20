import { describe, expect, it } from "vitest";
import {
  largestSingleDomainHbmGb,
  trainingFitsPlacementDomain,
} from "./placementDomains";

describe("placement domains", () => {
  it("does not add local and cloud HBM together", () => {
    const snapshot = { localVramGb: 80, remoteVramGb: 80 };
    expect(largestSingleDomainHbmGb(snapshot)).toEqual({
      domain: "local",
      hbmGb: 80,
    });
    const gate = trainingFitsPlacementDomain({
      requiredHbmGb: 120,
      snapshot: {
        ...snapshot,
        localSystemRamGb: 256,
        remoteSystemRamGb: 256,
      },
    });
    expect(gate.ok).toBe(false);
    expect(gate.chosenHbmGb).toBe(80);
  });

  it("accepts a job that fits the larger single domain", () => {
    const gate = trainingFitsPlacementDomain({
      requiredHbmGb: 140,
      snapshot: {
        localVramGb: 80,
        remoteVramGb: 180,
        localSystemRamGb: 64,
        remoteSystemRamGb: 512,
      },
    });
    expect(gate.ok).toBe(true);
    expect(gate.domain).toBe("cloud");
  });
});
