import type { ResearchTreeLayout } from "../../../sim/balance/researchLayout";

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
