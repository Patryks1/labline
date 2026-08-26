import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoutersTab } from "./RoutersTab";

describe("RoutersTab", () => {
  it("stays locked until Model Router research", () => {
    const markup = renderToStaticMarkup(
      createElement(RoutersTab, {
        models: [],
        onCreate: vi.fn(),
        onSetLane: vi.fn(),
        onActivate: vi.fn(),
        onDelete: vi.fn(),
        researchUnlocked: [],
      }),
    );

    expect(markup).toContain("Router locked");
    expect(markup).toContain("Unlock Model Router");
    expect(markup).not.toContain("Create router");
  });

  it("lets the player pick one specialist per category after unlock", () => {
    const markup = renderToStaticMarkup(
      createElement(RoutersTab, {
        routers: [{ id: "router-1", name: "Prod", lanes: {} }],
        models: [],
        researchUnlocked: ["sys_router"],
        onCreate: vi.fn(),
        onSetLane: vi.fn(),
        onActivate: vi.fn(),
        onDelete: vi.fn(),
      }),
    );

    expect(markup).toContain("Create router");
    expect(markup).toContain("Route each category to its best model");
    expect(markup).toContain("Assign serving models");
    expect(markup).toContain("Chat");
    expect(markup).toContain("Code");
    expect(markup).toContain("Math");
    expect(markup).toContain("Science");
    expect(markup).toContain("Fallback");
  });
});
