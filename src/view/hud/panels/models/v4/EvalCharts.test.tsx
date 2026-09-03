import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvalBarChart, EvalRadar, LossSpark, relativeEvalScale } from "./EvalCharts";

describe("EvalCharts", () => {
  it("renders measured bars from eval means", () => {
    const markup = renderToStaticMarkup(
      createElement(EvalBarChart, {
        measured: {
          overall: { mean: 48, ci: 4 },
          language: { mean: 51, ci: 3 },
        },
      }),
    );
    expect(markup).toContain('data-eval-chart="bars"');
    expect(markup).toContain("Measured scores");
    expect(markup).toContain("48.0");
  });

  it("renders a spider graph once three domains are measured", () => {
    const markup = renderToStaticMarkup(
      createElement(EvalRadar, {
        measured: {
          overall: { mean: 8.8, ci: 1.6 },
          language: { mean: 11, ci: 1.6 },
          reasoning: { mean: 7.8, ci: 1.6 },
          code: { mean: 8, ci: 1.6 },
          math: { mean: 5.1, ci: 1.6 },
          science: { mean: 8.5, ci: 1.6 },
        },
      }),
    );
    expect(markup).toContain('data-eval-chart="radar"');
    expect(markup).toContain('data-eval-scale="relative"');
    expect(markup).toContain("data-eval-ci");
    expect(markup).toContain('data-eval-ci-bar="language"');
    expect(markup).toContain("±1.6");
    expect(markup).toContain("Relative");
    expect(markup).toContain("Measured scores");
    expect(markup).toContain("8.8");
    expect(markup).toContain("polygon");
    expect(markup).not.toContain("0 to 100");
    expect(markup).not.toContain('data-eval-chart="bars"');
    const languageR = Number(markup.match(/data-eval-ci-bar="language"[\s\S]*?data-eval-r="([\d.]+)"/)?.[1]);
    const mathR = Number(markup.match(/data-eval-ci-bar="math"[\s\S]*?data-eval-r="([\d.]+)"/)?.[1]);
    expect(languageR).toBeGreaterThan(mathR);
    expect(languageR).toBeGreaterThan(50);
  });

  it("fits early scores to the measured ± band instead of a 0-100 axis", () => {
    const scale = relativeEvalScale([
      { measurement: { mean: 5.1, ci: 1.6 } },
      { measurement: { mean: 11, ci: 1.6 } },
    ]);
    expect(scale.toRadar(11)).toBeGreaterThan(scale.toRadar(5.1));
    expect(scale.toRadar(11)).toBeGreaterThan(70);
    expect(scale.toRadar(5.1)).toBeLessThan(40);
  });

  it("falls back to bars when fewer than three domains are measured", () => {
    const markup = renderToStaticMarkup(
      createElement(EvalRadar, {
        measured: {
          overall: { mean: 48, ci: 4 },
          language: { mean: 51, ci: 3 },
        },
      }),
    );
    expect(markup).toContain('data-eval-chart="bars"');
    expect(markup).not.toContain('data-eval-chart="radar"');
  });

  it("renders a loss spark when two samples exist", () => {
    const markup = renderToStaticMarkup(
      createElement(LossSpark, {
        samples: [
          { progress: 0.1, loss: 3.2 },
          { progress: 0.4, loss: 2.6 },
        ],
      }),
    );
    expect(markup).toContain('data-loss-spark="true"');
    expect(markup).toContain("2.600");
  });

  it("renders a compact spark without a caption", () => {
    const markup = renderToStaticMarkup(
      createElement(LossSpark, {
        compact: true,
        samples: [
          { progress: 0.1, loss: 3.2 },
          { progress: 0.4, loss: 2.6 },
        ],
      }),
    );
    expect(markup).toContain('data-loss-spark="compact"');
    expect(markup).not.toContain("from 3.200");
  });
});
