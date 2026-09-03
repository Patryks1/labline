import { describe, expect, it } from "vitest";
import {
  computeEffectiveDataBreakdown,
  domainEffectiveTokensMTok,
  effectiveTokensFromEpochs,
  emptyEffectiveDataBreakdown,
  qualityWeightFromQuality,
  repeatEpochMultiplier,
  syntheticDiscountFor,
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

  it("maps quality 0..1 onto weight 0.5..1.2", () => {
    expect(qualityWeightFromQuality(0)).toBeCloseTo(0.5, 8);
    expect(qualityWeightFromQuality(1)).toBeCloseTo(1.2, 8);
    expect(qualityWeightFromQuality(0.5)).toBeCloseTo(0.85, 8);
  });

  it("orders synthetic discount: verified > unverified, depth 1 > depth 3", () => {
    const verified = syntheticDiscountFor({
      syntheticShare: 1,
      verifiedShare: 1,
      depth: 1,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    const unverified = syntheticDiscountFor({
      syntheticShare: 1,
      verifiedShare: 0,
      depth: 1,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    const deep = syntheticDiscountFor({
      syntheticShare: 1,
      verifiedShare: 0,
      depth: 3,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    expect(verified).toBeGreaterThan(unverified);
    expect(unverified).toBeGreaterThan(deep);
    expect(deep).toBeGreaterThanOrEqual(0.4);
    expect(verified).toBeLessThanOrEqual(1);
  });

  it("does not treat two epochs as twice the unique tokens", () => {
    const one = computeEffectiveDataBreakdown({
      domains: [
        {
          domain: "code",
          rawMTok: 100,
          uniqueAvailableMTok: 100,
          quality: 1,
          syntheticShare: 0,
          syntheticDepth: 0,
          verifiedShare: 0,
        },
      ],
      moe: false,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    const two = computeEffectiveDataBreakdown({
      domains: [
        {
          domain: "code",
          rawMTok: 200,
          uniqueAvailableMTok: 100,
          quality: 1,
          syntheticShare: 0,
          syntheticDepth: 0,
          verifiedShare: 0,
        },
      ],
      moe: false,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    expect(two.epochs).toBeCloseTo(2, 8);
    expect(two.effectiveMTok).toBeGreaterThan(one.effectiveMTok);
    expect(two.effectiveMTok).toBeLessThan(one.effectiveMTok * 2);
  });

  it("divides MoE effective tokens by 1.2 and lowers single-domain diversity", () => {
    const row = {
      domain: "code" as const,
      rawMTok: 100,
      uniqueAvailableMTok: 100,
      quality: 1,
      syntheticShare: 0,
      syntheticDepth: 0,
      verifiedShare: 0,
    };
    const dense = computeEffectiveDataBreakdown({
      domains: [row],
      moe: false,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    const moe = computeEffectiveDataBreakdown({
      domains: [row],
      moe: true,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    expect(moe.effectiveMTok).toBeCloseTo(dense.effectiveMTok / 1.2, 8);
    expect(dense.diversity).toBeCloseTo(0.8, 8);
    const mixed = computeEffectiveDataBreakdown({
      domains: [
        { ...row, domain: "code", rawMTok: 50 },
        { ...row, domain: "math", rawMTok: 50 },
      ],
      moe: false,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    expect(mixed.diversity).toBeGreaterThan(dense.diversity);
  });

  it("returns zeros without NaN when nothing is requested", () => {
    const empty = computeEffectiveDataBreakdown({
      domains: [],
      moe: true,
      verifierStrength: 0.2,
      syntheticQuality: 1,
    });
    expect(empty).toEqual(emptyEffectiveDataBreakdown());
    expect(Number.isFinite(empty.effectiveMTok)).toBe(true);
  });
});
