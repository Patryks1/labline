import { describe, expect, it } from "vitest";
import {
  MODELS_COMPACT_DISCLOSURE_QUERY,
  modelsDesktopDefaultDisclosureOpen,
  modelsMobileOrientationForViewport,
  modelsWorkspaceViewForSwipe,
} from "./modelsResponsiveLayout";

describe("Models mobile layout contract", () => {
  it("recognizes common portrait and landscape phone resolutions", () => {
    expect(modelsMobileOrientationForViewport(390, 844)).toBe("portrait");
    expect(modelsMobileOrientationForViewport(430, 932)).toBe("portrait");
    expect(modelsMobileOrientationForViewport(844, 390)).toBe("landscape");
    expect(modelsMobileOrientationForViewport(932, 430)).toBe("landscape");
    expect(modelsMobileOrientationForViewport(1024, 768)).toBeNull();
  });

  it("moves between adjacent workspaces without wrapping at either edge", () => {
    expect(modelsWorkspaceViewForSwipe("runs", "left")).toBe("checkpoints");
    expect(modelsWorkspaceViewForSwipe("labs", "left")).toBe("routers");
    expect(modelsWorkspaceViewForSwipe("labs", "right")).toBe("checkpoints");
    expect(modelsWorkspaceViewForSwipe("runs", "right")).toBeNull();
    expect(modelsWorkspaceViewForSwipe("fleet", "left")).toBeNull();
  });

  it("opens training-run disclosures on desktop and keeps them collapsed on compact screens", () => {
    expect(
      modelsDesktopDefaultDisclosureOpen(() => ({ matches: false })),
    ).toBe(true);
    expect(
      modelsDesktopDefaultDisclosureOpen((query) => {
        expect(query).toBe(MODELS_COMPACT_DISCLOSURE_QUERY);
        return { matches: true };
      }),
    ).toBe(false);
    expect(modelsDesktopDefaultDisclosureOpen()).toBe(false);
  });
});
