import { CaretRight } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { LineageNodeVM } from "../viewModels/types";

const STAGE_LABEL: Record<LineageNodeVM["stage"], string> = {
  base: "base",
  post: "post",
};

function selectedLineageNode(nodes: LineageNodeVM[]): LineageNodeVM | undefined {
  for (const node of nodes) {
    if (node.isSelected) return node;
    const nested = selectedLineageNode(node.children);
    if (nested) return nested;
  }
  return undefined;
}

function countLineageNodes(nodes: LineageNodeVM[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countLineageNodes(node.children);
  return total;
}

function pathExpandIds(nodes: LineageNodeVM[]): string[] {
  const ids: string[] = [];
  const walk = (node: LineageNodeVM) => {
    if (node.children.length > 0 && (node.onPath || node.isSelected)) ids.push(node.id);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return ids;
}

function LineageBranch({
  node,
  expandedIds,
  onSelect,
  onToggle,
}: {
  node: LineageNodeVM;
  expandedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && expandedIds.has(node.id);
  const meta = `${node.version} · ${STAGE_LABEL[node.stage]}`;

  return (
    <li
      className="models-v4-lineage__item"
      data-lineage-id={node.id}
      data-selected={node.isSelected ? "true" : undefined}
      data-on-path={node.onPath ? "true" : undefined}
      data-expanded={expanded ? "true" : hasChildren ? "false" : undefined}
      data-stage={node.stage}
    >
      <div className="models-v4-lineage__row">
        {hasChildren ? (
          <button
            type="button"
            className="models-v4-lineage__toggle"
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={expanded}
            onClick={() => onToggle(node.id)}
          >
            <CaretRight
              aria-hidden="true"
              size="0.7rem"
              weight="bold"
              className={`models-v4-lineage__caret${expanded ? " models-v4-lineage__caret--open" : ""}`}
            />
          </button>
        ) : (
          <span className="models-v4-lineage__leaf" aria-hidden="true" />
        )}
        <button
          type="button"
          role="treeitem"
          aria-selected={node.isSelected}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-current={node.isSelected ? "true" : undefined}
          title={`${node.name} ${meta}`}
          onClick={() => onSelect(node.id)}
          className="models-v4-lineage__node"
        >
          <span className="models-v4-lineage__name">{node.name}</span>
          <span className="models-v4-lineage__meta">{meta}</span>
        </button>
      </div>
      {hasChildren && expanded ? (
        <ul className="models-v4-lineage__branch" role="group">
          {node.children.map((child) => (
            <LineageBranch
              key={child.id}
              node={child}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function LineageStrip({
  roots,
  onSelect,
}: {
  roots: LineageNodeVM[];
  onSelect: (id: string) => void;
}) {
  const selected = selectedLineageNode(roots);
  const selectedId = selected?.id;
  const pathIds = useMemo(() => pathExpandIds(roots), [roots]);
  const [expandedIds, setExpandedIds] = useState(() => new Set(pathIds));

  useEffect(() => {
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of pathIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedId, pathIds]);

  if (roots.length === 0) return null;

  const count = countLineageNodes(roots);
  const selectedLabel = selected ? `${selected.name} ${selected.version}` : "None selected";

  return (
    <details className="models-v4-lineage group/lineage" data-lineage-strip="true">
      <summary className="models-v4-lineage__summary">
        <CaretRight
          aria-hidden="true"
          size="0.75rem"
          weight="bold"
          className="models-v4-lineage__summary-caret"
        />
        <span className="models-v4-lineage__summary-label">Lineage</span>
        <span className="models-v4-lineage__summary-selected">{selectedLabel}</span>
        <span className="models-v4-lineage__summary-count">{count}</span>
      </summary>
      <ul
        className="models-v4-lineage__tree"
        role="tree"
        aria-label="Checkpoint lineage"
        data-lineage-tree="true"
      >
        {roots.map((root) => (
          <LineageBranch
            key={root.id}
            node={root}
            expandedIds={expandedIds}
            onSelect={onSelect}
            onToggle={(id) => {
              setExpandedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
          />
        ))}
      </ul>
    </details>
  );
}
