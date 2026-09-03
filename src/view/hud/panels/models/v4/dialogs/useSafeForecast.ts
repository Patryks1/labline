import { useMemo, type DependencyList } from "react";

export type SafeForecast<T> =
  | { forecast: T; error: null }
  | { forecast: null; error: string };

/** Catch workstream stubs that still throw `not implemented`. Never call the store at module scope. */
export function useSafeForecast<T>(fn: () => T, deps: DependencyList): SafeForecast<T> {
  return useMemo(() => {
    try {
      return { forecast: fn(), error: null };
    } catch (cause) {
      return {
        forecast: null,
        error: cause instanceof Error ? cause.message : "Forecast unavailable",
      };
    }
    // Caller supplies the closed-over inputs; fn is invoked inside this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
