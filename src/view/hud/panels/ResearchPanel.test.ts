import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../sim/createGame";
import { useGameStore } from "../../../store/gameStore";
import { ResearchPanel } from "./ResearchPanel";
import { scrollMobileResearchSelection } from "./researchPanelMobile";

describe("ResearchPanel mobile presentation", () => {
  it("allows page scrolling around the canvas and exposes touch-sized view controls", () => {
    useGameStore.setState({ state: createGame(7_221) });

    const markup = renderToStaticMarkup(createElement(ResearchPanel));

    expect(markup).toContain("overflow-y-auto overscroll-contain");
    expect(markup).toContain("touch-pan-y");
    expect(markup).toContain("sm:touch-none");
    expect(markup).toContain("Reset research tree view");
    expect(markup).toContain("drag · +/− zoom · tap a method");
  });

  it("brings the selected method into view on mobile without moving desktop", () => {
    const scrollIntoView = vi.fn();
    const element = { scrollIntoView };

    expect(scrollMobileResearchSelection(element, false)).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();

    expect(scrollMobileResearchSelection(element, true)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      behavior: "smooth",
    });
  });
});
