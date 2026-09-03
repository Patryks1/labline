import { describe, expect, it } from "vitest";
import type { Checkpoint } from "../../../../../../sim/training/types";
import {
  bestSingleCapabilities,
  compositeFallbackCapabilities,
  eligibleCheckpoints,
  emptyCapabilities,
  validateRouterDraft,
} from "./fleetModel";

describe("validateRouterDraft", () => {
  it("requires at least two members and exactly one primary", () => {
    expect(
      validateRouterDraft({ name: "R", policy: "domain", members: [] }).ok,
    ).toBe(false);
    expect(
      validateRouterDraft({
        name: "R",
        policy: "domain",
        members: [{ checkpointId: "a", role: "primary" }],
      }).ok,
    ).toBe(false);
    expect(
      validateRouterDraft({
        name: "R",
        policy: "domain",
        members: [
          { checkpointId: "a", role: "member" },
          { checkpointId: "b", role: "member" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateRouterDraft({
        name: "R",
        policy: "domain",
        members: [
          { checkpointId: "a", role: "primary" },
          { checkpointId: "b", role: "primary" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateRouterDraft({
        name: "R",
        policy: "domain",
        members: [
          { checkpointId: "a", role: "primary" },
          { checkpointId: "b", role: "fallback" },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects the single policy for routers", () => {
    const result = validateRouterDraft({
      name: "R",
      policy: "single",
      members: [
        { checkpointId: "a", role: "primary" },
        { checkpointId: "b", role: "member" },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

describe("composite fallback math", () => {
  it("takes the per-domain max and picks the strongest single member", () => {
    const a = emptyCapabilities();
    a.domains.code = 80;
    a.domains.math = 10;
    const b = emptyCapabilities();
    b.domains.code = 20;
    b.domains.math = 90;
    const composite = compositeFallbackCapabilities([a, b]);
    expect(composite.domains.code).toBe(80);
    expect(composite.domains.math).toBe(90);
    expect(bestSingleCapabilities([a, b])).toBe(b);
  });
});

describe("eligibleCheckpoints", () => {
  it("keeps only kept and released checkpoints", () => {
    const pool = eligibleCheckpoints([
      { status: "kept" },
      { status: "released" },
      { status: "stealth" },
      { status: "retired" },
    ] as Checkpoint[]);
    expect(pool).toHaveLength(2);
  });
});
