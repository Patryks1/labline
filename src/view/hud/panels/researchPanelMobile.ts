export const RESEARCH_COMPACT_MEDIA_QUERY =
  "(max-width: 900px), (max-width: 1180px) and (orientation: landscape) and (max-height: 600px)";

export function scrollMobileResearchSelection(
  element: Pick<HTMLElement, "scrollIntoView"> | null,
  mobile: boolean,
): boolean {
  if (!mobile || !element) return false;
  element.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return true;
}

export type ResearchGesturePoint = { x: number; y: number };
export type ResearchGestureView = {
  x: number;
  y: number;
  scale: number;
};

function distance(a: ResearchGesturePoint, b: ResearchGesturePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpoint(
  a: ResearchGesturePoint,
  b: ResearchGesturePoint,
): ResearchGesturePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Keep the graph point beneath a two-finger gesture anchored while the user
 * pinches and pans. Keeping this math outside React also makes the gesture
 * deterministic and independently testable.
 */
export function researchPinchView(
  startView: ResearchGestureView,
  startA: ResearchGesturePoint,
  startB: ResearchGesturePoint,
  nextA: ResearchGesturePoint,
  nextB: ResearchGesturePoint,
  minScale: number,
  maxScale: number,
): ResearchGestureView {
  const startDistance = distance(startA, startB);
  const nextDistance = distance(nextA, nextB);
  if (
    !Number.isFinite(startDistance) ||
    !Number.isFinite(nextDistance) ||
    startDistance <= 0 ||
    !Number.isFinite(startView.scale) ||
    startView.scale <= 0
  ) {
    return startView;
  }

  const startMidpoint = midpoint(startA, startB);
  const nextMidpoint = midpoint(nextA, nextB);
  const scale = Math.max(
    minScale,
    Math.min(maxScale, startView.scale * (nextDistance / startDistance)),
  );
  const contentX = (startMidpoint.x - startView.x) / startView.scale;
  const contentY = (startMidpoint.y - startView.y) / startView.scale;

  return {
    x: nextMidpoint.x - contentX * scale,
    y: nextMidpoint.y - contentY * scale,
    scale,
  };
}

export type ResearchTouchIntent = "pending" | "pan" | "scroll";

/** A one-finger vertical gesture belongs to the page; a horizontal swipe pans the tree. */
export function researchTouchIntent(
  deltaX: number,
  deltaY: number,
  threshold = 6,
): ResearchTouchIntent {
  if (Math.hypot(deltaX, deltaY) < threshold) return "pending";
  return Math.abs(deltaX) > Math.abs(deltaY) * 1.1 ? "pan" : "scroll";
}
