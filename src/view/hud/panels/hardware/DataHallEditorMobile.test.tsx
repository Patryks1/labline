import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HallMobileWorkspaceTabs } from "./DataHallEditorOverlay";

describe("HallMobileWorkspaceTabs", () => {
  it("presents one touch-sized Palette, Floor, and Inspect flow", () => {
    const markup = renderToStaticMarkup(
      createElement(HallMobileWorkspaceTabs, {
        active: "floor",
        hasSelection: false,
        placementActive: true,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Hall editor workspace"');
    expect(markup).toContain('id="hall-mobile-tab-palette"');
    expect(markup).toContain('id="hall-mobile-tab-floor"');
    expect(markup).toContain('id="hall-mobile-tab-inspect"');
    expect(markup).toContain('aria-controls="hall-mobile-panel-floor"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("max-[900px]:grid");
  });

  it("announces selection and placement state without relying on color", () => {
    const markup = renderToStaticMarkup(
      createElement(HallMobileWorkspaceTabs, {
        active: "inspect",
        hasSelection: true,
        placementActive: true,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Palette, placement selected"');
    expect(markup).toContain('aria-label="Inspect, asset selected"');
  });
});
