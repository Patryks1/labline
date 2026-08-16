import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MapTile } from "../../../sim/types";
import { BuildingRow } from "./FleetBuildingsPanel";
import {
  activateBuildingRowFromClick,
  activateBuildingRowFromKey,
} from "./FleetBuildingsPanelRowSemantics";

describe("FleetBuildingsPanel row semantics", () => {
  it("keeps the row focusable without nesting a button role", () => {
    const tile = {
      x: 2,
      y: 3,
      kind: "lab",
      owner: "player",
      name: "Research Lab",
    } as MapTile;

    const markup = renderToStaticMarkup(
      createElement(BuildingRow, {
        tile,
        active: false,
        badge: "Research lab",
      }),
    );

    expect(markup).toContain('data-building-row="true"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-keyshortcuts="Enter Space"');
    expect(markup).toContain('aria-label="Select building"');
    expect(markup).not.toContain('role="button"');
  });

  it("selects from a body click but leaves marked controls to their own action", () => {
    const select = vi.fn();

    expect(activateBuildingRowFromClick(false, select)).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);

    expect(activateBuildingRowFromClick(true, select)).toBe(false);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("selects when the row owns Enter or Space, not when a nested control owns the key", () => {
    const select = vi.fn();

    expect(activateBuildingRowFromKey("Enter", true, select)).toBe(true);
    expect(activateBuildingRowFromKey(" ", true, select)).toBe(true);
    expect(select).toHaveBeenCalledTimes(2);

    expect(activateBuildingRowFromKey("Enter", false, select)).toBe(false);
    expect(activateBuildingRowFromKey("ArrowRight", true, select)).toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("marks the caret as an independent row control", () => {
    const tile = {
      x: 2,
      y: 3,
      kind: "lab",
      owner: "player",
      name: "Research Lab",
    } as MapTile;
    const markup = renderToStaticMarkup(
      createElement(BuildingRow, {
        tile,
        active: true,
        badge: "Research lab",
      }),
    );

    expect(markup).toContain('data-building-row-control="true"');
    expect(markup).toContain('aria-label="Select building"');
    expect(activateBuildingRowFromClick(true, vi.fn())).toBe(false);
  });
});
