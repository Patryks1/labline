import type { ResearchTreeLayout } from "../../../sim/balance/researchLayout";
import { RESEARCH_NODES } from "../../../sim/balance/research";

/** Select the first useful method instead of the empty midpoint of the graph. */
export function initialResearchViewportNodeId(
  layout: ResearchTreeLayout,
): string | null {
  return (
    layout.nodes.find((node) => node.id === "dense_basics")?.id ??
    layout.nodes.find((node) => node.depth === 0)?.id ??
    layout.nodes[0]?.id ??
    null
  );
}

/** Highlight the focused method and its immediate dependency relationships. */
export function researchRelationshipSet(focusedId: string | null): Set<string> {
  const related = new Set<string>();
  if (!focusedId) return related;
  related.add(focusedId);
  const focused = RESEARCH_NODES.find((candidate) => candidate.id === focusedId);
  focused?.prereqs.forEach((prereqId) => related.add(prereqId));
  RESEARCH_NODES.filter((candidate) => candidate.prereqs.includes(focusedId)).forEach(
    (candidate) => related.add(candidate.id),
  );
  return related;
}

export function researchRelationshipTargets(
  layout: ResearchTreeLayout,
  nodeId: string,
): { incoming: string[]; outgoing: string[] } {
  return {
    incoming: layout.edges
      .filter((edge) => edge.to === nodeId)
      .map((edge) => edge.from),
    outgoing: layout.edges
      .filter((edge) => edge.from === nodeId)
      .map((edge) => edge.to),
  };
}

export function researchNodeSummaryId(nodeId: string): string {
  return "research-node-summary-" + nodeId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Clicking the selected node again closes its detail; another node switches. */
export function nextResearchSelection(
  currentId: string | null,
  clickedId: string,
): string | null {
  return currentId === clickedId ? null : clickedId;
}

const RESEARCH_DETAIL_KEEP_CLASSES = [
  "research-method-detail",
  "research-node-hit",
  "research-node-queue-action",
  "research-tree-toolbar",
  "research-workbench-queue",
] as const;

/** Empty tree canvas / workbench chrome dismisses; nodes, the card, queue, and zoom keep it. */
export function shouldClearResearchSelection(
  ancestorClasses: Iterable<string>,
): boolean {
  const classes =
    ancestorClasses instanceof Set
      ? ancestorClasses
      : new Set(ancestorClasses);
  for (const keep of RESEARCH_DETAIL_KEEP_CLASSES) {
    if (classes.has(keep)) return false;
  }
  return classes.has("research-tree-stage") || classes.has("research-workbench-main");
}

export function ancestorClassTokens(target: EventTarget | null): string[] {
  if (!(target instanceof Element)) return [];
  const tokens: string[] = [];
  let current: Element | null = target;
  while (current) {
    if (current.classList.length > 0) {
      tokens.push(...current.classList);
    }
    current = current.parentElement;
  }
  return tokens;
}
