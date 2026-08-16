import type { MapTile } from "../../sim/types";
import {
  isDcAnchor,
  isDcKind,
  isHqAnchor,
  isHqKind,
} from "../../sim/systems/map";

export type FacilityEditorKind = "data-hall" | "hq-office";

/** Map selection routes directly to the spatial editor owned by the facility. */
export function facilityEditorKindForTile(
  tile: Pick<
    MapTile,
    | "kind"
    | "owner"
    | "campusRole"
    | "buildingProgress"
    | "buildingTarget"
  >,
): FacilityEditorKind | null {
  if (
    tile.owner !== "player" ||
    tile.buildingProgress + 1e-9 < tile.buildingTarget
  ) {
    return null;
  }
  if (isDcKind(tile.kind) && isDcAnchor(tile)) return "data-hall";
  if (isHqKind(tile.kind) && isHqAnchor(tile)) return "hq-office";
  return null;
}
