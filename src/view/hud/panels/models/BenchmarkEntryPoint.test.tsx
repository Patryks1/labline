import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BenchmarkEntryPoint } from "./BenchmarkEntryPoint";

describe("BenchmarkEntryPoint", () => {
  it("keeps context explicit while delegating to the existing owner handler", () => {
    const markup = renderToStaticMarkup(
      createElement(
        BenchmarkEntryPoint,
        {
          context: { kind: "checkpoint", id: "cp-1" },
          onOpen: vi.fn(),
        },
        "Benchmark",
      ),
    );

    expect(markup).toContain('data-benchmark-entrypoint="checkpoint"');
    expect(markup).toContain('data-benchmark-subject="cp-1"');
    expect(markup).toContain('aria-label="Benchmark cp-1"');
    expect(markup).toContain(">Benchmark</button>");
  });
});
