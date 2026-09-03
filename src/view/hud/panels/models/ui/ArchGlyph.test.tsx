import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchGlyph } from "./ArchGlyph";

describe("ArchGlyph", () => {
  it("renders an labelled inline SVG for each architecture kind", () => {
    const dense = renderToStaticMarkup(createElement(ArchGlyph, { kind: "dense" }));
    const moe = renderToStaticMarkup(createElement(ArchGlyph, { kind: "moe", size: "sm" }));

    expect(dense).toContain('aria-label="Dense architecture"');
    expect(dense).toContain("<svg");
    expect(dense).toContain("<rect");
    expect(moe).toContain('aria-label="Mixture-of-experts architecture"');
    expect(moe).toContain('width="16"');
  });
});
