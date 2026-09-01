import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecipeRadarDialog } from "./RecipeRadarDialog";

describe("RecipeRadarDialog", () => {
  it("hosts the training radar in a labelled mix editor", () => {
    const markup = renderToStaticMarkup(
      createElement(
        RecipeRadarDialog,
        {
          open: true,
          title: "Spider mix",
          onClose: vi.fn(),
        },
        createElement(
          "div",
          { "data-models-radar": "training-data" },
          "radar",
        ),
      ),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("Data recipe");
    expect(markup).toContain("Spider mix");
    expect(markup).toContain(
      "Drag domains on the radar. Verify share and teachers stay on this mix.",
    );
    expect(markup).toContain('aria-label="Close spider mix"');
    expect(markup).toContain("max-w-5xl");
    expect(markup).toContain('data-models-radar="training-data"');
    expect(markup).toContain("radar");
  });

  it("uses continue-train copy and stays closed without stealing the workflow", () => {
    const openMarkup = renderToStaticMarkup(
      createElement(RecipeRadarDialog, {
        open: true,
        title: "New tokens",
        onClose: vi.fn(),
      }),
    );
    expect(openMarkup).toContain("New tokens");
    expect(openMarkup).not.toContain("Spider mix");

    const closed = renderToStaticMarkup(
      createElement(RecipeRadarDialog, {
        open: false,
        title: "Spider mix",
        onClose: vi.fn(),
      }),
    );
    expect(closed).toBe("");
  });
});
