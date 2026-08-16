export const RESEARCH_TREE_MIN_ZOOM = 0.28;

/**
 * The initial canvas view is a working view, not an all-tree thumbnail.
 * At the latter size the 164px method cards become unreadable once the full
 * 102-node graph is fit into a narrow workbench.  Keep the readable view
 * deliberately larger and let users pan; the explicit Fit action remains
 * available for an overview of the whole graph.
 */
export const RESEARCH_TREE_DEFAULT_ZOOM = 0.62;

/** Fit the full research graph without letting the first view clip its edges. */
export function researchCanvasFitScale(
  viewportWidth: number,
  viewportHeight: number,
  layoutWidth: number,
  layoutHeight: number,
): number {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    layoutWidth <= 0 ||
    layoutHeight <= 0
  ) {
    return RESEARCH_TREE_MIN_ZOOM;
  }
  const fit = Math.min(
    (viewportWidth - 32) / layoutWidth,
    (viewportHeight - 32) / layoutHeight,
  );
  return Math.max(RESEARCH_TREE_MIN_ZOOM, Math.min(1.05, fit));
}
