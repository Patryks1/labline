import { describe, expect, it } from "vitest";
import {
  domainEffectiveTokensMTok,
  effectiveTokensFromEpochs,
  repeatEpochMultiplier,
  syntheticLineagePenalty,
} from "./effectiveData";

describe("effective data", () => {
  it("does not treat ten epochs as ten unique corpora", () => {
    expect(repeatEpochMultiplier(1)).toBe(1);
    expect(repeatEpochMultiplier(2)).toBeCloseTo(1.55, 5);
    expect(repeatEpochMultiplier(10)).toBeLessThan(3);
    expect(effectiveTokensFromEpochs({ uniqueMTok: 100, epochs: 10 })).toBeLessThan(
      300,
    );
  });

  it("applies domain quality, diversity and provenance", () => {
    const effective = domainEffectiveTokensMTok({
      domain: "code",
      rawTokensMTok: 100,
      quality: 0.5,
      diversity: 0.8,
      freshness: 1,
      provenanceConfidence: 1,
      contaminationPenalty: 1,
      repetitionPenalty: 1,
      syntheticLineagePenalty: 1,
    });
    expect(effective).toBeCloseTo(40, 5);
  });

  it("reduces unverified recursive synthetic value", () => {
    expect(syntheticLineagePenalty(0, false)).toBe(1);
    expect(syntheticLineagePenalty(3, false)).toBeLessThan(
      syntheticLineagePenalty(3, true),
    );
  });
});
