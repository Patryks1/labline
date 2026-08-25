import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createGame } from "../../../sim/createGame";
import { researchComputeUsage } from "../../../sim/systems/computeBreakdown";
import { useGameStore } from "../../../store/gameStore";
import { ResearchPanel, researchPoolTileDetail, researchPoolTileValue } from "./ResearchPanel";
import {
  RESEARCH_TREE_DEFAULT_ZOOM,
  researchCanvasFitScale,
} from "./researchCanvasLayout";
import { scrollMobileResearchSelection } from "./researchPanelMobile";
import { layoutResearchTree } from "../../../sim/balance/researchLayout";
import {
  initialResearchViewportNodeId,
  nextResearchSelection,
  researchRelationshipSet,
  researchRelationshipTargets,
  shouldClearResearchSelection,
} from "./researchPanelA11y";

describe("ResearchPanel mobile presentation", () => {
  it("allows page scrolling around the canvas and exposes touch-sized view controls", () => {
    useGameStore.setState({ state: createGame(7_221) });

    const markup = renderToStaticMarkup(createElement(ResearchPanel));

    expect(markup).toContain("overflow-y-auto overscroll-contain");
    expect(markup).toContain("touch-pan-y");
    expect(markup).toContain("sm:touch-none");
    expect(markup).toContain("Reset research tree view");
    expect(markup).toContain("tap select · Queue action · pinch/drag");
    expect(markup).toContain('aria-roledescription="research tree"');
    expect(markup).toContain('aria-describedby="research-tree-summary"');
    expect(markup).toContain("Research prerequisite relationships:");
    expect(markup).toContain("research-workbench-layout");
    expect(markup).toContain("research-workbench-queue");
    expect(markup).toContain("research-workbench-main");
    expect(markup).toContain("research-canvas-column");
    expect(markup).toContain("research-node-hit");
    expect(markup).toContain("research-node-queue-action");
    expect(markup).toContain("research-tree-shell");
    expect(markup).toContain("--research-tree-zoom");
    expect(markup).toContain(
      'aria-keyshortcuts="Enter Shift+Enter Escape ArrowLeft ArrowRight ArrowUp ArrowDown"',
    );
    expect(markup).not.toContain("Selected research method");
    expect(markup).toContain("Foundations Pod");
    expect(markup).toContain("research-pod-staff-row");
    expect(markup.match(/class="research-pod-staff-row"/g)).toHaveLength(3);
    expect(markup).toContain("Systems Pod");
    expect(markup).toContain("Applied Intelligence Pod");
    expect(markup).toContain("Requires Research Culture");
    expect(markup).toContain("Requires Lab Structure");
    expect(markup).toContain("locked");
    expect(markup).not.toContain("Open another pod");
    expect(markup).not.toContain("Staff reservation · shared HQ pool");
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

  it("opens on the starting method instead of centering the empty graph midpoint", () => {
    const layout = layoutResearchTree();
    expect(initialResearchViewportNodeId(layout)).toBe("dense_basics");
  });

  it("dismisses the method detail on empty canvas clicks but not inside the card or nodes", () => {
    expect(shouldClearResearchSelection(["research-tree-stage"])).toBe(true);
    expect(shouldClearResearchSelection(["research-workbench-main"])).toBe(true);
    expect(
      shouldClearResearchSelection([
        "research-method-detail",
        "research-tree-stage",
      ]),
    ).toBe(false);
    expect(
      shouldClearResearchSelection(["research-node-hit", "research-tree-stage"]),
    ).toBe(false);
    expect(
      shouldClearResearchSelection([
        "research-node-queue-action",
        "research-tree-stage",
      ]),
    ).toBe(false);
    expect(
      shouldClearResearchSelection([
        "research-tree-toolbar",
        "research-tree-stage",
      ]),
    ).toBe(false);
    expect(shouldClearResearchSelection(["research-workbench-queue"])).toBe(
      false,
    );
  });

  it("toggles the same research node off and switches to another", () => {
    expect(nextResearchSelection("dense_basics", "dense_basics")).toBe(null);
    expect(nextResearchSelection("dense_basics", "lab_structure")).toBe(
      "lab_structure",
    );
    expect(nextResearchSelection(null, "dense_basics")).toBe("dense_basics");
  });

  it("highlights immediate research relationships without lighting the full descendant graph", () => {
    const layout = layoutResearchTree();
    const related = researchRelationshipSet("dense_basics");
    const expected = new Set([
      "dense_basics",
      ...layout.edges
        .filter((edge) => edge.from === "dense_basics")
        .map((edge) => edge.to),
      ...layout.edges
        .filter((edge) => edge.to === "dense_basics")
        .map((edge) => edge.from),
    ]);
    expect(related).toEqual(expected);
    expect(related.size).toBeLessThan(layout.nodes.length / 4);
  });
});

describe("ResearchPanel pool tile", () => {
  it("shows an idle research pool without synthetic draw", () => {
    useGameStore.setState({ state: createGame(8_501) });

    const markup = renderToStaticMarkup(createElement(ResearchPanel));

    expect(markup).toContain("metric-tile--research");
    expect(markup).toContain("idle ·");
    expect(markup).toContain("physical draw");
    expect(markup).not.toContain("synth ·");
  });

  it("factors synthetic generation into the pool tile", () => {
    const base = createGame(8_502);
    const usage = researchComputeUsage({
      ...base,
      player: {
        ...base.player,
        data: {
          ...base.player.data,
          synthQueue: [
            {
              id: "synth-ui",
              domain: "chat",
              modelId: "teacher",
              modelName: "Teacher",
              targetMTok: 0,
              progressMTok: 0,
              continuous: true,
              researchShare: 0.3,
              qualityTier: "lq",
            },
          ],
        },
      },
    });

    expect(researchPoolTileValue(usage)).toContain(" / ");
    expect(researchPoolTileDetail(usage)).toContain("synth ·");
    expect(researchPoolTileDetail(usage)).toContain("physical draw");
    expect(researchPoolTileDetail(usage)).not.toContain("idle ·");
  });
});
