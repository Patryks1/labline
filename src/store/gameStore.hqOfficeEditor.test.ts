import { describe, expect, it } from "vitest";
import { createGame } from "../sim/createGame";
import { canPlaceBuilding, placeBuilding } from "../sim/systems/map";
import { HQ_OFFICE_CATALOG } from "../sim/systems/hqOffice";
import { mapTileAtAny } from "../sim/systems/worldAccess";
import { TERRAIN_KIND, type TileId } from "../sim/world";
import { tileCoords } from "../sim/world/ids";
import { useGameStore } from "./gameStore";

describe("HQ office editor store callbacks", () => {
  it("opens, applies, and closes a persisted HQ floor plan", () => {
    let state = createGame(42_815);
    const world = state.map.world!;
    let facilityId: string | undefined;
    for (let id = 0; id < world.staticWorld.kind.length && !facilityId; id += 1) {
      if (world.staticWorld.kind[id] !== TERRAIN_KIND.empty) continue;
      const { x, y } = tileCoords(id as TileId, world.descriptor.width);
      if (!canPlaceBuilding(state, x, y, "hq").ok) continue;
      state = placeBuilding(state, x, y, "hq");
      const tile = mapTileAtAny(state, x, y)!;
      facilityId = tile.campusId ?? `facility:${x},${y}`;
    }
    if (!facilityId) throw new Error("No placeable HQ spot");
    useGameStore.setState({ state });
    useGameStore.getState().openHqOfficeEditor(facilityId);
    expect(useGameStore.getState().hqOfficeEditorFacilityId).toBe(facilityId);
    const item = HQ_OFFICE_CATALOG[0]!;
    const result = useGameStore.getState().applyHqOfficeEditorPlan({
      facilityId,
      width: 8,
      depth: 6,
      objects: [
        {
          id: `${facilityId}:object:1`,
          kind: item.kind,
          catalogId: item.id,
          x: 2,
          z: 2,
          rotation: 0,
          purchasePrice: item.purchasePrice,
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(useGameStore.getState().state.hqOfficeLayouts?.[facilityId]?.objects).toHaveLength(1);
    useGameStore.getState().closeHqOfficeEditor();
    expect(useGameStore.getState().hqOfficeEditorFacilityId).toBeNull();
  });
});

