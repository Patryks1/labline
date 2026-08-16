import { describe, expect, it } from "vitest";
import { createGame } from "../createGame";
import { emptyStaff } from "../balance/staff";
import { canPlaceBuilding, placeBuilding } from "./map";
import {
  HQ_OFFICE_CATALOG,
  analyzeHqOfficeLayout,
  applyHqOfficePlan,
  hqOfficeAutomaticLayout,
  hqOfficeEffects,
  hqOfficeLayoutForKind,
  hqOfficeStarterLayout,
  migrateHqOfficeLayouts,
  previewHqObjectPlacement,
  quoteHqOfficePlan,
} from "./hqOffice";
import {
  dataStaffThroughputBonus,
  playerHqStaffCap,
  researchTalentMult,
  staffWagePerDay,
} from "./staff";
import { mapTileAtAny } from "./worldAccess";
import { roundTripState } from "../save";
import { TERRAIN_KIND, type TileId } from "../world";
import { tileCoords } from "../world/ids";
import type { HqOfficeObjectPlacement, SimState } from "../types";

function placeableHq(state: SimState): { x: number; y: number } {
  const world = state.map.world!;
  for (let id = 0; id < world.staticWorld.kind.length; id += 1) {
    if (world.staticWorld.kind[id] !== TERRAIN_KIND.empty) continue;
    const { x, y } = tileCoords(id as TileId, world.descriptor.width);
    if (canPlaceBuilding(state, x, y, "hq").ok) return { x, y };
  }
  throw new Error("No placeable HQ spot");
}

function object(
  id: string,
  catalogId: string,
  x: number,
  z: number,
): HqOfficeObjectPlacement {
  const item = HQ_OFFICE_CATALOG.find((entry) => entry.id === catalogId)!;
  return { id, kind: item.kind, catalogId, x, z, rotation: 0, purchasePrice: item.purchasePrice };
}

describe("HQ office fit-outs", () => {
  it("builds valid deterministic automatic layouts with real desks", () => {
    for (const preset of ["balanced", "focus", "collaboration"] as const) {
      const first = hqOfficeAutomaticLayout("facility:auto", "hq", preset);
      const second = hqOfficeAutomaticLayout("facility:auto", "hq", preset);

      expect(first.analysis.valid).toBe(true);
      expect(first.analysis.capacityBonus).toBeGreaterThan(0);
      expect(first.objects.some((entry) => entry.kind === "desk")).toBe(true);
      expect(first.objects).toEqual(second.objects);
    }
  });

  it("furnishes the starter grant with twelve represented seats", () => {
    const layout = hqOfficeStarterLayout("facility:starter", "hq");
    expect(layout.analysis.valid).toBe(true);
    expect(layout.analysis.capacityBonus).toBe(12);
    expect(layout.objects.filter((entry) => entry.kind === "desk")).toHaveLength(12);
  });

  it("rejects overlapping or out-of-bounds furniture before apply", () => {
    const layout = hqOfficeLayoutForKind("facility:test", "hq");
    const desk = object("desk:1", "desk-standard", 1, 1);
    const overlap = object("desk:2", "desk-standard", 1, 1);
    expect(previewHqObjectPlacement(layout, desk)).toBe("valid");
    expect(previewHqObjectPlacement({ ...layout, objects: [desk] }, overlap)).toBe("invalid");
    expect(
      previewHqObjectPlacement(layout, object("room:1", "meeting-room", layout.width - 1, layout.depth - 1)),
    ).toBe("invalid");
    const invalid = { ...layout, objects: [desk, overlap], revision: 1 };
    expect(analyzeHqOfficeLayout(invalid).valid).toBe(false);
  });

  it("rejects duplicate object ids so replacement semantics cannot mint seats", () => {
    const layout = hqOfficeLayoutForKind("facility:test", "hq");
    const first = object("desk:1", "desk-standard", 1, 1);
    const duplicate = object("desk:1", "desk-standard", 2, 1);

    expect(analyzeHqOfficeLayout({ ...layout, objects: [first, duplicate], revision: 1 })).toMatchObject({
      valid: false,
      capacityBonus: 1,
      hardErrors: ["Duplicate office object id: desk:1"],
    });
  });

  it("does not apply malformed legacy layout opex", () => {
    const layout = hqOfficeLayoutForKind("facility:test", "hq");
    const first = object("desk:1", "desk-standard", 1, 1);
    const duplicate = object("desk:1", "plant-biophilic", 2, 1);

    const effects = hqOfficeEffects({ ...layout, objects: [first, duplicate] });
    expect(effects.capacityBonus).toBe(0);
    expect(effects.productivityBonus).toBe(0);
    expect(effects.dailyOpex).toBe(0);
    expect(effects.objectCount).toBe(0);
  });

  it("charges the fit-out, persists it, and feeds capacity/productivity into sim formulas", () => {
    let state = createGame(42_812);
    const spot = placeableHq(state);
    state = placeBuilding(state, spot.x, spot.y, "hq");
    const tile = mapTileAtAny(state, spot.x, spot.y)!;
    const facilityId = tile.campusId ?? `facility:${tile.x},${tile.y}`;
    const current = state.hqOfficeLayouts?.[facilityId];
    expect(current).toBeDefined();
    if (!current) throw new Error("starter HQ office layout missing");
    let desk: HqOfficeObjectPlacement | undefined;
    for (let z = 1; z < current.depth && !desk; z += 1) {
      for (let x = 0; x < current.width && !desk; x += 1) {
        const candidate = object(`${facilityId}:added-desk`, "desk-standard", x, z);
        if (previewHqObjectPlacement(current, candidate) === "valid") desk = candidate;
      }
    }
    expect(desk).toBeDefined();
    const plan = {
      facilityId,
      width: 8,
      depth: 6,
      objects: [...current.objects, desk!],
    };
    const beforeCash = state.player.cash;
    const beforeCap = playerHqStaffCap(state);
    expect(beforeCap).toBe(12);
    state = { ...state, player: { ...state.player, staff: { ...emptyStaff(), researcher: 1 } } };
    const beforeResearch = researchTalentMult(state);
    const beforeThroughput = dataStaffThroughputBonus({
      ...state,
      player: { ...state.player, staff: { ...emptyStaff(), data_processor: 1 } },
    });
    const result = applyHqOfficePlan(state, plan);
    expect(result.ok).toBe(true);
    state = result.state;
    expect(state.player.cash).toBe(beforeCash - result.netCost);
    expect(state.hqOfficeLayouts?.[facilityId]?.objects).toHaveLength(current.objects.length + 1);
    expect(playerHqStaffCap(state)).toBe(beforeCap + 1);
    expect(researchTalentMult(state)).toBeGreaterThan(beforeResearch);
    expect(
      dataStaffThroughputBonus({
        ...state,
        player: { ...state.player, staff: { ...emptyStaff(), data_processor: 1 } },
      }),
    ).toBeGreaterThan(beforeThroughput);
    expect(staffWagePerDay(state)).toBeGreaterThan(0);
  });

  it("normalizes old saves without office fields and round-trips new layouts", () => {
    const state = createGame(42_813);
    const migrated = migrateHqOfficeLayouts({ ...state, hqOfficeLayouts: undefined });
    expect(migrated.hqOfficeLayouts).toEqual({});
    const layout = hqOfficeLayoutForKind("facility:test", "hq");
    const withLayout = { ...state, hqOfficeLayouts: { "facility:test": layout } };
    const roundTripped = roundTripState(withLayout);
    expect(roundTripped.hqOfficeLayouts?.["facility:test"]?.version).toBe(1);
    expect(roundTripped.hqOfficeLayouts?.["facility:test"]?.analysis.valid).toBe(true);
  });

  it("quotes only newly-added objects and refunds removed furniture at salvage value", () => {
    const layout = hqOfficeLayoutForKind("facility:test", "hq");
    const desk = object("desk:1", "desk-standard", 2, 2);
    const room = object("room:1", "meeting-room", 4, 2);
    const quote = quoteHqOfficePlan(
      { facilityId: layout.facilityId, width: layout.width, depth: layout.depth, objects: [room] },
      { ...layout, objects: [desk] },
    );
    expect(quote.purchaseCost).toBeGreaterThan(quote.refund);
    expect(quote.buildDays).toBe(4);
  });

  it("charges a catalog replacement even when an object id is reused", () => {
    const layout = hqOfficeLayoutForKind("facility:test", "hq");
    const desk = object("object:1", "desk-standard", 2, 2);
    const replacement = object("object:1", "meeting-room", 2, 2);
    const quote = quoteHqOfficePlan(
      { facilityId: layout.facilityId, width: layout.width, depth: layout.depth, objects: [replacement] },
      { ...layout, objects: [desk] },
    );

    expect(quote.purchaseCost).toBe(HQ_OFFICE_CATALOG.find((item) => item.id === "meeting-room")!.purchasePrice);
    expect(quote.refund).toBe(HQ_OFFICE_CATALOG.find((item) => item.id === "desk-standard")!.purchasePrice * 0.5);
    expect(quote.netCost).toBeGreaterThan(0);
  });
});
