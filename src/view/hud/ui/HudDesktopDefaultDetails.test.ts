import { describe, expect, it } from "vitest";
import { COMPACT_FILTER_QUERY } from "./HudFilterBar";
import { hudDesktopDefaultDisclosureOpen } from "./hudDesktopDisclosure";

describe("hudDesktopDefaultDisclosureOpen", () => {
  it("opens disclosures on desktop and keeps them collapsed on compact screens", () => {
    expect(
      hudDesktopDefaultDisclosureOpen(() => ({ matches: false })),
    ).toBe(true);
    expect(
      hudDesktopDefaultDisclosureOpen((query) => {
        expect(query).toBe(COMPACT_FILTER_QUERY);
        return { matches: true };
      }),
    ).toBe(false);
    expect(hudDesktopDefaultDisclosureOpen()).toBe(false);
  });
});
