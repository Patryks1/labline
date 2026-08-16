import { describe, expect, it } from "vitest";
import { facilityEditorKindForTile } from "./tileInspectorFacilityAction";

const tile = (
  patch: Partial<Parameters<typeof facilityEditorKindForTile>[0]> = {},
): Parameters<typeof facilityEditorKindForTile>[0] => ({
  kind: "dc",
  owner: "player",
  campusRole: "anchor",
  buildingProgress: 10,
  buildingTarget: 10,
  ...patch,
});

describe("TileInspector facility editor action", () => {
  it("opens the data-hall editor for a completed player hall", () => {
    expect(facilityEditorKindForTile(tile())).toBe("data-hall");
  });

  it("opens the office editor for a completed player HQ", () => {
    expect(
      facilityEditorKindForTile(tile({ kind: "hq_m" })),
    ).toBe("hq-office");
  });

  it("does not offer an editor for pads, construction, rivals, or unrelated buildings", () => {
    expect(facilityEditorKindForTile(tile({ campusRole: "pad" }))).toBeNull();
    expect(facilityEditorKindForTile(tile({ buildingProgress: 4 }))).toBeNull();
    expect(facilityEditorKindForTile(tile({ owner: "rival-a" }))).toBeNull();
    expect(facilityEditorKindForTile(tile({ kind: "solar" }))).toBeNull();
  });
});
