import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DomainRadar } from "./DomainRadar";

describe("DomainRadar specialist pull", () => {
  it("paints red on domains whose mix share specializes the model", () => {
    const markup = renderToStaticMarkup(
      createElement(DomainRadar, {
        requested: { code: 80, math: 10, chat: 10 },
        available: {
          code: { uniqueMTok: 100, syntheticShare: 0 },
          math: { uniqueMTok: 40, syntheticShare: 0 },
          chat: { uniqueMTok: 40, syntheticShare: 0 },
        },
      }),
    );
    expect(markup).toContain("data-radar-specialist");
    expect(markup).toContain('data-radar-specialist-domain="code"');
    expect(markup).not.toContain('data-radar-specialist-domain="math"');
    expect(markup).toContain("var(--color-danger)");
    expect(markup).not.toContain("figcaption");
  });

  it("stays tan when the mix is even", () => {
    const even = 10;
    const markup = renderToStaticMarkup(
      createElement(DomainRadar, {
        requested: {
          code: even,
          math: even,
          science: even,
          law: even,
          health: even,
          chat: even,
          image: even,
          video: even,
          audio: even,
        },
        available: {},
      }),
    );
    expect(markup).not.toContain("data-radar-specialist");
    expect(markup).not.toContain("data-radar-specialist-domain");
  });
});
