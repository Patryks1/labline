import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IncidentModal } from "./IncidentModal";
import { stubIncident } from "../viewModels/testFixtures";

describe("IncidentModal", () => {
  it("renders three incident choices with effect summaries", () => {
    const incident = stubIncident();
    const markup = renderToStaticMarkup(
      createElement(IncidentModal, {
        open: true,
        runId: "run-1",
        incident,
        onClose: vi.fn(),
      }),
    );
    expect(markup).toContain('data-incident-modal="true"');
    expect(markup).toContain("Loss spike at scale");
    expect(markup).toContain("Lower the learning rate");
    expect(markup).toContain("Buy diagnostic compute");
    expect(markup).toContain("Push through");
    expect(markup).toContain("σ ×0.85");
    expect(markup).toContain("cost ×1.15");
    expect(markup).toContain("rollback 4%");
    expect(markup).toContain('data-incident-choice="stabilize"');
    expect(markup).toContain('data-incident-choice="spend"');
    expect(markup).toContain('data-incident-choice="push"');
  });
});
