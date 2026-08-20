/**
 * Viewport hint for shell chrome tests. Live Models layout is container-query
 * based: a ~626px drawer stays stacked even on a wide window.
 */
export const MODELS_COMPACT_DESKTOP_MIN_WIDTH = 901;
export const MODELS_COMPACT_DESKTOP_MAX_WIDTH = 1200;
export const MODELS_COMPACT_COLUMNS_MIN_WIDTH = 1201;
export const MODELS_COMPACT_COLUMNS_MAX_WIDTH = 1360;

export type ModelsWorkbenchLayout = "stacked" | "columns";

export function modelsWorkbenchLayoutForViewport(
  viewportWidth: number,
): ModelsWorkbenchLayout {
  if (viewportWidth <= MODELS_COMPACT_COLUMNS_MAX_WIDTH) return "stacked";
  return "columns";
}
