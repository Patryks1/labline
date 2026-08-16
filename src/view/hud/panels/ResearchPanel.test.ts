import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../sim/createGame";
import { useGameStore } from "../../../store/gameStore";
import { ResearchPanel } from "./ResearchPanel";
import {
  RESEARCH_TREE_DEFAULT_ZOOM,
  researchCanvasFitScale,
} from "./researchCanvasLayout";
import { scrollMobileResearchSelection } from "./researchPanelMobile";
import { layoutResearchTree } from "../../../sim/balance/researchLayout";
import { researchRelationshipTargets } from "./researchPanelA11y";

describe("ResearchPanel mobile presentation", () => {
  it("allows page scrolling around the canvas and exposes touch-sized view controls", () => {
    useGameStore.setState({ state: createGame(7_221) });

    const markup = renderToStaticMarkup(createElement(ResearchPanel));

    expect(markup).toContain("overflow-y-auto overscroll-contain");
    expect(markup).toContain("touch-pan-y");
    expect(markup).toContain("sm:touch-none");
    expect(markup).toContain("Reset research tree view");
    expect(markup).toContain("drag · +/− zoom · tap a method");
    expect(markup).toContain('aria-roledescription="research tree"');
    expect(markup).toContain('aria-describedby="research-tree-summary"');
    expect(markup).toContain("Research prerequisite relationships:");
    expect(markup).toContain("research-workbench-layout");
    expect(markup).toContain("research-workbench-queue");
    expect(markup).toContain("research-workbench-main");
    expect(markup).toContain("research-canvas-column");
    expect(markup).toContain("research-node-hit");
    expect(markup).toContain("--research-tree-zoom");
    expect(markup).toContain(
      'aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"',
    );
  });

  it("keeps every research method semantic while the visual card stays compact", () => {
    useGameStore.setState({ state: createGame(7_222) });

    const markup = renderToStaticMarkup(createElement(ResearchPanel));

    expect(markup.match(/class="research-node-hit/g)).toHaveLength(
      layoutResearchTree().nodes.length,
    );
    expect(markup.match(/class="research-node-surface/g)).toHaveLength(
      layoutResearchTree().nodes.length,
    );
  });

  it("exposes incoming and outgoing keyboard relationship targets", () => {
    const layout = layoutResearchTree();
    const edge = layout.edges[0];
    expect(edge).toBeDefined();

    const source = researchRelationshipTargets(layout, edge!.from);
    const destination = researchRelationshipTargets(layout, edge!.to);

    expect(source.outgoing).toContain(edge!.to);
    expect(destination.incoming).toContain(edge!.from);
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

  it("keeps the default tree readable while Fit remains an explicit overview", () => {
    expect(RESEARCH_TREE_DEFAULT_ZOOM).toBeGreaterThanOrEqual(0.55);
    expect(RESEARCH_TREE_DEFAULT_ZOOM).toBeLessThanOrEqual(0.65);

    const scale = researchCanvasFitScale(520, 560, 1480, 1620);
    expect(scale).toBeGreaterThanOrEqual(0.28);
    expect(scale).toBeLessThan(0.78);
    expect(researchCanvasFitScale(0, 0, 1480, 1620)).toBe(0.28);
  });
});
