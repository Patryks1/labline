import { describe, expect, it } from "vitest";
import type {
  DataHallLayout,
  RackInstall,
  RackSku,
} from "../../../../sim/types";
import {
  buildHallRackSlots,
  captureHallClock,
  nextHallSlotIndex,
  projectHallPlanForAnalysis,
  rackVisualKind,
  restoreHallClock,
  semanticGridWindow,
  splitHallWallAroundDoors,
  summarizeHallRackCapacity,
} from "./hallLayoutModel";

const sku = (id: string, name: string) =>
  ({ id, name, rackUnits: 1 }) as RackSku;

describe("hall layout projection", () => {
  it("expands installs into stable physical bays and keeps empty capacity", () => {
    const installs = [
      {
        id: "i1",
        skuId: "gpu",
        x: 1,
        y: 2,
        count: 2,
        rackUnits: 1,
        status: "live",
        paidEach: 1,
        daysLeft: 0,
      },
    ] as RackInstall[];
    const slots = buildHallRackSlots(
      4,
      installs,
      (id) => sku(id, "H100 GPU rack"),
      2,
    );
    expect(slots.map((slot) => slot.kind)).toEqual([
      "gpu",
      "gpu",
      "empty",
      "empty",
    ]);
    expect(slots[2]?.bayLabel).toBe("R02–B01");
  });

  it("classifies readable front-panel patterns", () => {
    expect(rackVisualKind(sku("a", "CPU dense node"))).toBe("cpu");
    expect(rackVisualKind(sku("b", "Liquid cooling CDU"))).toBe("cooling");
    expect(rackVisualKind(sku("c", "RAM memory shelf"))).toBe("memory");
  });

  it("separates installed rack resources from planned cabinet potential", () => {
    const objects = [
      {
        id: "installed",
        kind: "rack",
        catalogId: "gpu",
        rackUnitId: "unit-1",
        x: 0,
        z: 0,
        rotation: 0,
        purchasePrice: 0,
      },
      {
        id: "planned",
        kind: "rack",
        catalogId: "gpu",
        reserved: true,
        x: 4,
        z: 0,
        rotation: 0,
        purchasePrice: 0,
      },
      {
        id: "utility",
        kind: "power",
        catalogId: "pdu-2mw",
        x: 8,
        z: 0,
        rotation: 0,
        purchasePrice: 1,
      },
    ] as const;
    const impact = summarizeHallRackCapacity(objects, () => ({
      flopsPf: 8,
      vramGb: 640,
      mw: 0.008,
      tokPerSec: 96_000,
      rackUnits: 2,
    }));
    expect(impact.installed).toEqual({
      cabinets: 1,
      rackBays: 2,
      flopsPf: 8,
      vramGb: 640,
      mw: 0.008,
      tokPerSec: 96_000,
    });
    expect(impact.planned).toEqual({
      cabinets: 1,
      rackBays: 2,
      flopsPf: 8,
      vramGb: 640,
      mw: 0.008,
      tokPerSec: 96_000,
    });
    expect(impact.ordered.cabinets).toBe(0);
  });

  it("keeps unfunded order drafts separate and counts multi-bay demand", () => {
    const objects = [
      {
        id: "order",
        kind: "rack",
        catalogId: "gpu",
        x: 0,
        z: 0,
        rotation: 0,
        purchasePrice: 0,
      },
    ] as const;
    const impact = summarizeHallRackCapacity(objects, () => ({
      flopsPf: 8,
      vramGb: 640,
      mw: 0.008,
      tokPerSec: 96_000,
      rackUnits: 3,
    }));
    expect(impact.installed.cabinets).toBe(0);
    expect(impact.ordered).toMatchObject({
      cabinets: 1,
      rackBays: 3,
      flopsPf: 8,
    });
  });

  it("projects order drafts and inbound racks as delivered for target analysis only", () => {
    const layout = {
      version: 2,
      facilityId: "hall",
      shellId: "hall-small-v1",
      revision: 1,
      autoPlaceDeliveries: true,
      preferredStrategy: "efficiency",
      objects: [
        {
          id: "draft-rack",
          kind: "rack",
          catalogId: "gpu",
          x: 2,
          z: 2,
          rotation: 0,
          purchasePrice: 0,
        },
        {
          id: "inbound-rack",
          kind: "rack",
          catalogId: "gpu",
          rackUnitId: "ordered-unit",
          x: 8,
          z: 2,
          rotation: 0,
          purchasePrice: 0,
        },
      ],
      walls: [],
      doors: [],
      analysis: {} as DataHallLayout["analysis"],
    } satisfies DataHallLayout;
    const inventory = [
      {
        unitId: "ordered-unit",
        skuId: "gpu",
        mw: 0.01,
        networkGbps: 900,
        delivered: false,
      },
    ];
    const projected = projectHallPlanForAnalysis(layout, inventory, () => ({
      mw: 0.01,
      networkGbps: 900,
      flopsPf: 8,
      rackUnits: 2,
      price: 1,
      generation: 2,
    }));

    expect(inventory[0]?.delivered).toBe(false);
    expect(projected.layout.objects[0]?.rackUnitId).toBe(
      "hall-plan:draft-rack",
    );
    expect(projected.inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unitId: "hall-plan:draft-rack",
          delivered: true,
          rackUnits: 2,
        }),
        expect.objectContaining({
          unitId: "ordered-unit",
          delivered: true,
        }),
      ]),
    );
  });

  it("splits visible wall spans around one or more door openings", () => {
    const wall = {
      id: "wall",
      x1: 0,
      z1: 10,
      x2: 20,
      z2: 10,
      purchasePrice: 1,
    };
    const spans = splitHallWallAroundDoors(wall, [
      { id: "a", wallId: "wall", offset: 0.25, width: 2, purchasePrice: 1 },
      { id: "b", wallId: "wall", offset: 0.75, width: 3, purchasePrice: 1 },
    ]);
    expect(spans.length).toBe(3);
    expect(spans.reduce((sum, span) => sum + span.x2 - span.x1, 0)).toBe(15);
    expect(spans.every((span) => span.z1 === 10 && span.z2 === 10)).toBe(true);
  });

  it("moves within grid bounds for keyboard navigation", () => {
    expect(nextHallSlotIndex(4, "ArrowDown", 7, 3)).toBe(6);
    expect(nextHallSlotIndex(4, "Home", 7, 3)).toBe(0);
    expect(nextHallSlotIndex(0, "ArrowLeft", 7, 3)).toBe(0);
    expect(nextHallSlotIndex(2, "ArrowRight", 7, 3)).toBe(2);
  });

  it("virtualizes a large semantic grid around the selected row", () => {
    expect(semanticGridWindow(24, 12)).toEqual({
      firstRow: 10,
      lastRowExclusive: 14,
    });
    expect(semanticGridWindow(24, 23)).toEqual({
      firstRow: 20,
      lastRowExclusive: 24,
    });
    expect(
      (semanticGridWindow(24, 12).lastRowExclusive -
        semanticGridWindow(24, 12).firstRow) *
        40,
    ).toBe(160);
  });

  it("restores the prior clock only within the same campaign", () => {
    const prior = captureHallClock({ seed: 7, speed: 5, paused: false });
    expect(
      restoreHallClock(
        { seed: 7, speed: 5 as const, paused: true, day: 4 },
        prior,
      ),
    ).toMatchObject({ speed: 5, paused: false });
    expect(
      restoreHallClock({ seed: 8, speed: 1 as const, paused: true }, prior),
    ).toEqual({ seed: 8, speed: 1, paused: true });
  });

  it("honours persisted multi-unit starts before filling remaining bays", () => {
    const installs = [
      {
        id: "later",
        skuId: "gpu",
        x: 1,
        y: 2,
        count: 1,
        rackUnits: 2,
        bayStarts: [4],
        status: "live",
        paidEach: 1,
        daysLeft: 0,
      },
      {
        id: "first",
        skuId: "cpu",
        x: 1,
        y: 2,
        count: 1,
        rackUnits: 1,
        status: "live",
        paidEach: 1,
        daysLeft: 0,
      },
    ] as RackInstall[];
    const slots = buildHallRackSlots(
      8,
      installs,
      (id) => sku(id, id === "cpu" ? "CPU rack" : "GPU rack"),
      4,
    );
    expect(slots[4]?.placementId).toContain("later");
    expect(slots[5]?.placementId).toBe(slots[4]?.placementId);
    expect(slots[0]?.kind).toBe("cpu");
  });
});
