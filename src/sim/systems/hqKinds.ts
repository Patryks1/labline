/** Canonical HQ shell classification shared by map placement and office fit-outs. */
export function isHqKind(kind: string): boolean {
  return kind === "hq" || kind === "hq_m" || kind === "hq_l" || kind === "office";
}

export function isHqAnchor(tile: { kind: string; campusRole?: string }): boolean {
  return isHqKind(tile.kind) && tile.campusRole !== "pad";
}
