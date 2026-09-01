import { COMPACT_FILTER_QUERY } from "../../ui/HudFilterBar";
import { hudDesktopDefaultDisclosureOpen } from "../../ui/hudDesktopDisclosure";

/**
 * Viewport hint for shell chrome tests. Live Models layout is container-query
 * based: a ~626px drawer stays stacked even on a wide window.
 */
export const MODELS_COMPACT_DESKTOP_MIN_WIDTH = 901;
export const MODELS_COMPACT_DESKTOP_MAX_WIDTH = 1200;
export const MODELS_COMPACT_COLUMNS_MIN_WIDTH = 1201;
export const MODELS_COMPACT_COLUMNS_MAX_WIDTH = 1360;

/** Compact HUD query shared with filter/CSS density: collapsed by default. */
export const MODELS_COMPACT_DISCLOSURE_QUERY = COMPACT_FILTER_QUERY;

export type ModelsWorkbenchLayout = "stacked" | "columns";

export type ModelsMobileOrientation = "portrait" | "landscape";

export type ModelsWorkspaceView =
  | "runs"
  | "checkpoints"
  | "labs"
  | "routers"
  | "fleet";

export const MODELS_WORKSPACE_VIEWS: readonly ModelsWorkspaceView[] = [
  "runs",
  "checkpoints",
  "labs",
  "routers",
  "fleet",
] as const;

export function modelsWorkbenchLayoutForViewport(
  viewportWidth: number,
): ModelsWorkbenchLayout {
  if (viewportWidth <= MODELS_COMPACT_COLUMNS_MAX_WIDTH) return "stacked";
  return "columns";
}

/**
 * Small-screen render contract used by focused tests and the Models shell.
 * Landscape phones stay compact even when their width crosses the usual
 * `sm` breakpoint.
 */
export function modelsMobileOrientationForViewport(
  viewportWidth: number,
  viewportHeight: number,
): ModelsMobileOrientation | null {
  if (viewportWidth <= 640 && viewportHeight >= viewportWidth) {
    return "portrait";
  }
  if (viewportHeight <= 540 && viewportWidth < 1024) {
    return "landscape";
  }
  return null;
}

/** Adjacent Models destination for a deliberate horizontal content swipe. */
export function modelsWorkspaceViewForSwipe(
  current: ModelsWorkspaceView,
  direction: "left" | "right",
): ModelsWorkspaceView | null {
  const index = MODELS_WORKSPACE_VIEWS.indexOf(current);
  const next = index + (direction === "left" ? 1 : -1);
  return MODELS_WORKSPACE_VIEWS[next] ?? null;
}

/**
 * Training-run accordions stay collapsed on compact viewports and start open
 * on desktop, matching the HUD compact media query used by filters and CSS.
 */
export const modelsDesktopDefaultDisclosureOpen =
  hudDesktopDefaultDisclosureOpen;

