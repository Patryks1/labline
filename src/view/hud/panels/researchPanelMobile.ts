export function scrollMobileResearchSelection(
  element: Pick<HTMLElement, "scrollIntoView"> | null,
  mobile: boolean,
): boolean {
  if (!mobile || !element) return false;
  element.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return true;
}
