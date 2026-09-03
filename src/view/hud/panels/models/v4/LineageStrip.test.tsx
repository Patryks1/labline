import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LineageStrip } from "./LineageStrip";
import type { LineageNodeVM } from "../viewModels/types";

function node(over: Partial<LineageNodeVM> & Pick<LineageNodeVM, "id" | "name">): LineageNodeVM {
  return {
    version: "1.0",
    stage: "base",
    status: "kept",
    depth: 0,
    isSelected: false,
    onPath: false,
    children: [],
    ...over,
  };
}

function fixture(): LineageNodeVM[] {
  return [
    node({
      id: "root",
      name: "Coder",
      onPath: true,
      children: [
        node({
          id: "post",
          name: "Coder Instruct",
          version: "1.1",
          stage: "post",
          depth: 1,
          onPath: true,
          children: [
            node({
              id: "leaf",
              name: "auto-25",
              version: "0.33",
              depth: 2,
              isSelected: true,
              onPath: true,
            }),
            node({
              id: "sib",
              name: "auto-50",
              version: "0.67",
              depth: 2,
            }),
          ],
        }),
        node({
          id: "other",
          name: "Coder 2",
          version: "1.2",
          depth: 1,
          children: [
            node({
              id: "hidden",
              name: "hidden-child",
              version: "1.3",
              stage: "post",
              depth: 2,
            }),
          ],
        }),
      ],
    }),
  ];
}

describe("LineageStrip", () => {
  it("collapses the tree behind a disclosure and keeps the selected path open", () => {
    const markup = renderToStaticMarkup(
      createElement(LineageStrip, { roots: fixture(), onSelect: () => undefined }),
    );

    expect(markup).toContain('data-lineage-strip="true"');
    expect(markup).toContain("<details");
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(markup).toContain("Lineage");
    expect(markup).toContain("auto-25 0.33");
    expect(markup).toMatch(/models-v4-lineage__summary-count">6</);
    expect(markup).toContain('data-lineage-tree="true"');
    expect(markup).toContain('role="tree"');
    expect(markup).toContain('data-lineage-id="root"');
    expect(markup).toContain('data-lineage-id="post"');
    expect(markup).toContain('data-lineage-id="sib"');
    expect(markup).toContain('data-lineage-id="other"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain('data-expanded="true"');
    expect(markup).toContain("auto-25");
    expect(markup).toContain("0.33 · base");
    expect(markup).toContain("1.1 · post");
    expect(markup).toContain("models-v4-lineage__branch");
    expect(markup).toContain('aria-label="Collapse Coder"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("hidden-child");
  });

  it("renders nothing when the lineage is empty", () => {
    expect(
      renderToStaticMarkup(createElement(LineageStrip, { roots: [], onSelect: () => undefined })),
    ).toBe("");
  });
});
