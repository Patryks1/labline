import { COMPACT_FILTER_QUERY } from "./HudFilterBar";

/**
 * Compact HUD query shared with filters and CSS density. Disclosures stay
 * collapsed on that query and start open on desktop.
 */
export function hudDesktopDefaultDisclosureOpen(
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">,
): boolean {
  const media =
    matchMedia ??
    (typeof window !== "undefined"
      ? window.matchMedia?.bind(window)
      : undefined);
  if (typeof media !== "function") return false;
  return !media(COMPACT_FILTER_QUERY).matches;
}
