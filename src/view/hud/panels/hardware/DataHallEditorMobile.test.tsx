import { createElement } from "react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HallMobileWorkspaceTabs,
} from "./DataHallEditorOverlay";
import {
  hallEditorTabTarget,
  hallMobileWorkspaceAfterSwipe,
} from "./mobileHardwareNavigation";

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
    expect(markup).toContain("touch-pan-y");
    expect(markup).toContain('data-swipe-navigation="hall-workspaces"');
    expect(markup).toContain("orientation:landscape");
    expect(markup).toContain("max-width:1180px");
    expect(markup).toContain("safe-area-inset-left");
    expect(markup).toContain("safe-area-inset-right");
    expect(markup).toContain("Swipe left or right");
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

  it("moves through workspaces only for deliberate horizontal swipes", () => {
    expect(hallMobileWorkspaceAfterSwipe("palette", -90, 8)).toBe("floor");
    expect(hallMobileWorkspaceAfterSwipe("floor", -90, 8)).toBe("inspect");
    expect(hallMobileWorkspaceAfterSwipe("inspect", 90, 8)).toBe("floor");
    expect(hallMobileWorkspaceAfterSwipe("floor", 90, 8)).toBe("palette");
  });

  it("keeps boundaries, taps, and vertical scrolling stable", () => {
    expect(hallMobileWorkspaceAfterSwipe("palette", 90, 4)).toBe("palette");
    expect(hallMobileWorkspaceAfterSwipe("inspect", -90, 4)).toBe("inspect");
    expect(hallMobileWorkspaceAfterSwipe("floor", -40, 2)).toBe("floor");
    expect(hallMobileWorkspaceAfterSwipe("floor", -90, 80)).toBe("floor");
  });

  it("wraps Tab at both dialog boundaries while leaving ordinary movement native", () => {
    expect(
      hallEditorTabTarget({
        shiftKey: false,
        atFirst: false,
        atLast: true,
        activeOnDialog: false,
        activeInside: true,
      }),
    ).toBe("first");
    expect(
      hallEditorTabTarget({
        shiftKey: true,
        atFirst: true,
        atLast: false,
        activeOnDialog: false,
        activeInside: true,
      }),
    ).toBe("last");
    expect(
      hallEditorTabTarget({
        shiftKey: false,
        atFirst: false,
        atLast: false,
        activeOnDialog: false,
        activeInside: true,
      }),
    ).toBeNull();
    expect(
      hallEditorTabTarget({
        shiftKey: true,
        atFirst: false,
        atLast: false,
        activeOnDialog: true,
        activeInside: true,
      }),
    ).toBe("last");
  });

  it("protects every landscape workspace body from left and right display cutouts", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./DataHallEditorOverlay.tsx", import.meta.url)),
      "utf8",
    );

    for (const panelId of [
      "hall-mobile-panel-palette",
      "hall-mobile-panel-floor",
      "hall-mobile-panel-inspect",
    ]) {
      const panelStart = source.indexOf(`id="${panelId}"`);
      expect(panelStart).toBeGreaterThan(-1);
      const panelMarkup = source.slice(panelStart, panelStart + 3_000);
      expect(panelMarkup).toContain("max-width:1180px");
      expect(panelMarkup).toContain("max-height:600px");
      expect(panelMarkup).toContain(
        "pl-[max(0.75rem,env(safe-area-inset-left))]",
      );
      expect(panelMarkup).toContain(
        "pr-[max(0.75rem,env(safe-area-inset-right))]",
      );
    }
  });

  it("owns focus for its full modal lifecycle and handles Escape before control guards", async () => {
    const source = await readFile(
      fileURLToPath(new URL("./DataHallEditorOverlay.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("const editorRef = useRef<HTMLElement | null>(null)");
    expect(source).toContain("window.requestAnimationFrame");
    expect(source).toContain("data-hall-editor-initial-focus");
    expect(source).toContain("if (previous?.isConnected) previous.focus()");
    expect(source).toContain("ref={editorRef}");
    expect(source).toContain("tabIndex={-1}");
    expect(source).toContain("onKeyDown={trapEditorFocus}");
    expect(source).toContain("root.querySelectorAll<HTMLElement>(HALL_EDITOR_FOCUSABLE)");

    const handlerStart = source.indexOf("const handler = (event: KeyboardEvent)");
    const handler = source.slice(handlerStart, handlerStart + 1_800);
    expect(handler.indexOf('event.key === "Escape"')).toBeGreaterThan(-1);
    expect(handler.indexOf('event.key === "Escape"')).toBeLessThan(
      handler.indexOf("target?.matches"),
    );
  });
});
