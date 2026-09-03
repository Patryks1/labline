import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TRAINING_V4 } from "../../../../../../sim/training/constants";
import { SunsetDialog, DEFAULT_SUNSET_DRAIN_DAYS } from "./SunsetDialog";

describe("SunsetDialog", () => {
  it("defaults drain days to the V4 sunset contract", () => {
    expect(DEFAULT_SUNSET_DRAIN_DAYS).toBe(TRAINING_V4.endpoints.sunsetDrainDays);
    const markup = renderToStaticMarkup(
      createElement(SunsetDialog, {
        open: true,
        onClose: vi.fn(),
        endpointId: "ep-1",
      }),
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain(`value="${TRAINING_V4.endpoints.sunsetDrainDays}"`);
    expect(markup).toContain("Drain days");
    expect(markup).toContain("HBM");
  });
});
