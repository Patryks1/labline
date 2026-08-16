export const MODELS_COMPACT_DESKTOP_MIN_WIDTH = 901;
export const MODELS_COMPACT_DESKTOP_MAX_WIDTH = 1200;
export const MODELS_COMPACT_COLUMNS_MIN_WIDTH = 1201;
export const MODELS_COMPACT_COLUMNS_MAX_WIDTH = 1360;

export type ModelsWorkbenchLayout =
  | "stacked"
  | "compact-columns"
  | "columns";

/**
 * Keep the compact desktop layout contract explicit alongside its CSS hook.
 * At these widths the shell can leave too little inline room for a queue and
 * workbench to remain usable side by side, so the queue stacks above the
 * selected work surface.
 */
export function modelsWorkbenchLayoutForViewport(
  viewportWidth: number,
): ModelsWorkbenchLayout {
  if (
    viewportWidth >= MODELS_COMPACT_DESKTOP_MIN_WIDTH &&
    viewportWidth <= MODELS_COMPACT_DESKTOP_MAX_WIDTH
  ) {
    return "stacked";
  }
  if (
    viewportWidth >= MODELS_COMPACT_COLUMNS_MIN_WIDTH &&
    viewportWidth <= MODELS_COMPACT_COLUMNS_MAX_WIDTH
  ) {
    return "compact-columns";
  }
  return "columns";
}
