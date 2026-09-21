import { useMemo, useState } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { edgeTypes, flowEdges, flowNodes, nodeTypes } from "./Canvas";
import { tidyDiagram } from "./tidyLayout";
import { Dialog, Field } from "./ui";
import type { Diagram } from "./types";

export default function TidyDiagram({
  diagram,
  selectedIds,
  onApply,
  onClose,
}: {
  diagram: Diagram;
  selectedIds: string[];
  onApply: (candidate: Diagram) => void;
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<"horizontal" | "vertical">(
    "vertical",
  );
  const [scope, setScope] = useState<"all" | "selected">("all");
  const candidate = useMemo(
    () => tidyDiagram(diagram, { direction, scope, selectedIds }),
    [diagram, direction, scope, selectedIds],
  );
  const changed = candidate.nodes.filter(
    (n, i) =>
      n.position.x !== diagram.nodes[i].position.x ||
      n.position.y !== diagram.nodes[i].position.y,
  ).length;
  const movable = diagram.nodes.filter(
    (n) => !n.pinned && (scope === "all" || selectedIds.includes(n.id)),
  ).length;
  return (
    <Dialog title="Tidy diagram" onClose={onClose}>
      <div className="tidy-controls">
        <Field label="Direction">
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
          >
            <option value="vertical">Vertical</option>
            <option value="horizontal">Horizontal</option>
          </select>
        </Field>
        <Field label="Scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="all">Entire diagram</option>
            <option value="selected" disabled={!selectedIds.length}>
              Selected nodes ({selectedIds.length})
            </option>
          </select>
        </Field>
      </div>
      <p className="muted" role="status">
        {movable
          ? `${changed} position${changed === 1 ? "" : "s"} will change. Pinned nodes stay fixed.`
          : "No movable nodes in this scope."}
      </p>
      <div
        className="tidy-preview"
        aria-label="Arrangement preview"
        data-testid="tidy-preview"
      >
        <ReactFlow
          key={`${direction}-${scope}`}
          nodes={flowNodes(candidate)}
          edges={flowEdges(candidate)}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          onInit={(instance) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                // The native dialog opens after its children mount. Fit again once its
                // visible dimensions have reached React Flow's measurement observer.
                void instance.fitView({ padding: 0.2 });
              }),
            )
          }
          minZoom={0.05}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          onlyRenderVisibleElements={false}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="dialog-actions">
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={!changed}
          onClick={() => onApply(candidate)}
        >
          Apply arrangement
        </button>
      </div>
    </Dialog>
  );
}
