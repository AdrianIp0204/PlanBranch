import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useNodes,
  type EdgeProps,
  applyNodeChanges,
  type Node,
  type NodeProps,
  type NodeChange,
  type ReactFlowInstance,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { useProject } from "./store";
import {
  nodeKinds,
  statuses,
  uid,
  type Diagram,
  type TaskNode,
  type NodeKind,
} from "./types";
import { Dialog, Field, StatusMark } from "./ui";
import { placeEdgeLabel, type Point } from "./edgeLabels";
export type FlowNode = Node<{ task: TaskNode; toggle?: () => void }, "task">;
export const TaskShape = memo(function TaskShape({
  data,
  selected,
}: NodeProps<FlowNode>) {
  const n = data.task;
  return (
    <div
      className={`task-shape shape-${n.type} ${selected ? "is-selected" : ""} task-${n.status}`}
    >
      {<Handle type="target" position={Position.Top} id="in" />}
      <div className="task-kind">
        <span>{nodeKinds[n.type]}</span>
        {n.type !== "note" && (
          <input
            className="nodrag nopan"
            type="checkbox"
            title="Mark task done"
            aria-label={`Mark ${n.title} done`}
            checked={n.status === "done"}
            onChange={data.toggle}
            disabled={!data.toggle}
          />
        )}
      </div>
      <div className="task-title">{n.title || "Untitled node"}</div>
      {n.type === "note" ? (
        <div className="note-excerpt">
          {n.description || "Add context in the inspector"}
        </div>
      ) : (
        <div className="task-meta">
          <span>
            <StatusMark status={n.status} />
            {statuses[n.status]}
          </span>
          {n.checklist.length > 0 && n.type !== "decision" && (
            <span>
              {n.checklist.filter((i) => i.checked).length}/{n.checklist.length}{" "}
              ✓
            </span>
          )}
        </div>
      )}
      {<Handle type="source" position={Position.Bottom} id="out" />}
      {n.type === "decision" && (
        <>
          <Handle type="source" position={Position.Left} id="yes" />
          <Handle type="source" position={Position.Right} id="no" />
        </>
      )}
    </div>
  );
});
export const nodeTypes = { task: TaskShape };
export function flowNodes(diagram: Diagram): FlowNode[] {
  return diagram.nodes.map((n) => ({
    id: n.id,
    type: "task",
    position: n.position,
    data: { task: n },
    width: 220,
    height: n.type === "decision" ? 142 : 112,
  }));
}
/** Keep paths below nodes and labels in React Flow's separate HTML overlay. */
function TaskEdgeShape(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath(props);
  const select = props.data?.onSelect as (() => void) | undefined;
  const nodes = useNodes();
  const pathGroup = useRef<SVGGElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [placement, setPlacement] = useState({ x, y, leader: false });
  useLayoutEffect(() => {
    const element = label.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      setSize((old) =>
        old.width === next.width && old.height === next.height ? old : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.label]);
  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const geometry = pathGroup.current?.querySelector<SVGPathElement>(
      ".react-flow__edge-path",
    );
    if (!geometry) return;
    const length = geometry.getTotalLength();
    const steps = Math.max(2, Math.min(128, Math.ceil(length / 12)));
    const points: Point[] = [];
    for (let step = 1; step < steps; step++) {
      const point = geometry.getPointAtLength((length * step) / steps);
      points.push({ x: point.x, y: point.y });
    }
    const obstacles = nodes
      .filter((n) => !n.hidden)
      .map((n) => {
        const badge = n.data.changeMark ? 24 : 0;
        return {
          x: n.position.x,
          y: n.position.y - badge,
          width: n.measured?.width ?? n.width ?? 220,
          height: (n.measured?.height ?? n.height ?? 112) + badge,
        };
      });
    const next = placeEdgeLabel({ x, y }, size, obstacles, points);
    const leader =
      (next.x !== x || next.y !== y) &&
      !points.some((p) => p.x === next.x && p.y === next.y);
    setPlacement((old) =>
      old.x === next.x && old.y === next.y && old.leader === leader
        ? old
        : { ...next, leader },
    );
  }, [path, x, y, size, nodes]);
  return (
    <>
      <g ref={pathGroup}>
        <BaseEdge
          id={props.id}
          path={path}
          markerStart={props.markerStart}
          markerEnd={props.markerEnd}
          style={props.style}
          interactionWidth={props.interactionWidth}
        />
      </g>
      {props.label && placement.leader && (
        <path
          className="flow-edge-label-leader"
          d={`M ${x},${y} L ${placement.x},${placement.y}`}
          fill="none"
          stroke={props.style?.stroke ?? "#7a9390"}
          strokeWidth={1}
          strokeDasharray="3 3"
          pointerEvents="none"
          aria-hidden="true"
        />
      )}
      {props.label && (
        <EdgeLabelRenderer>
          <div
            ref={label}
            className={`flow-edge-label nodrag nopan ${props.selected ? "selected" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${placement.x}px, ${placement.y}px)`,
              pointerEvents: select ? "all" : "none",
            }}
            role={select ? "button" : undefined}
            tabIndex={select ? 0 : undefined}
            aria-label={
              select ? `Edit connection ${String(props.label)}` : undefined
            }
            onClick={(event) => {
              event.stopPropagation();
              select?.();
            }}
            onKeyDown={(event) => {
              if (select && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                event.stopPropagation();
                select();
              }
            }}
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
export const edgeTypes = { task: TaskEdgeShape };
export function flowEdges(
  diagram: Diagram,
  onSelect?: (id: string) => void,
): Edge[] {
  return diagram.edges.map((e) => ({
    ...e,
    type: "task",
    data: { onSelect: onSelect ? () => onSelect(e.id) : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    style: { stroke: "#7a9390", strokeWidth: 1.7 },
    labelStyle: { fill: "#294641", fontSize: 12, fontWeight: 500 },
    labelBgStyle: { fill: "#f7f9f7" },
    labelBgPadding: [7, 4] as [number, number],
    labelBgBorderRadius: 4,
  }));
}
export default function Canvas({
  diagram,
  selected,
  onSelect,
  onInspect,
  filter,
  onInstance,
  connectRequest,
  onConnected,
  onAddNode,
}: {
  diagram: Diagram;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onInspect?: (id: string) => void;
  filter: string;
  onInstance: (i: ReactFlowInstance<FlowNode>) => void;
  connectRequest: boolean;
  onConnected: () => void;
  onAddNode?: () => void;
}) {
  const { session, change, commit, setView } = useProject();
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const nodesRef = useRef<FlowNode[]>([]);
  const mouseDragging = useRef(false);
  const canvasSelection = useRef<string | null | undefined>(undefined);
  const previousSelection = useRef<{
    diagramId: string;
    selected: string | null;
  } | null>(null);
  const updateNodes = (next: FlowNode[]) => {
    nodesRef.current = next;
    setNodes(next);
  };
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [branch, setBranch] = useState("");
  useEffect(() => {
    const last = previousSelection.current;
    const changedDiagram = last?.diagramId !== diagram.id;
    const changedSelection = changedDiagram || last?.selected !== selected;
    let selectedIds = new Set(
      nodesRef.current.filter((n) => n.selected).map((n) => n.id),
    );
    // Canvas selection is owned by React Flow (including multi-selection). An
    // inspector/catalogue selection is an explicit request to focus one node.
    if (
      changedDiagram ||
      (changedSelection && canvasSelection.current !== selected)
    ) {
      selectedIds = new Set(selected ? [selected] : []);
    }
    previousSelection.current = { diagramId: diagram.id, selected };
    canvasSelection.current = undefined;
    updateNodes(
      flowNodes(diagram).map((n) => ({
        ...n,
        selected: selectedIds.has(n.id),
        style: {
          opacity:
            (filter === "blocked" && n.data.task.status !== "blocked") ||
            (filter === "unfinished" &&
              (n.data.task.status === "done" || n.data.task.type === "note"))
              ? 0.24
              : 1,
        },
        data: {
          ...n.data,
          toggle: () =>
            change(
              (c) => {
                const target = c.diagrams
                  .find((d) => d.id === diagram.id)!
                  .nodes.find((x) => x.id === n.id)!;
                target.status =
                  target.status === "done" ? "not_started" : "done";
              },
              `Change ${n.data.task.title} status`,
              diagram.id,
            ),
        },
      })),
    );
  }, [diagram.id, diagram.nodes, selected, filter]);

  const persistPositions = (
    moved: { id: string; position: TaskNode["position"] }[],
    group: boolean,
  ) => {
    change(
      (c) => {
        const d = c.diagrams.find((item) => item.id === diagram.id)!;
        for (const movedNode of moved) {
          const target = d.nodes.find((n) => n.id === movedNode.id);
          if (target) target.position = { ...movedNode.position };
        }
      },
      "Move nodes",
      diagram.id,
      group,
    );
  };
  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    updateNodes(applyNodeChanges(changes, nodesRef.current));
    // Arrow keys emit completed position changes without drag callbacks. Store
    // those immediately, grouping repeated nudges with the normal 600 ms idle
    // checkpoint. Pointer drags remain transient until their completion event.
    if (!mouseDragging.current) {
      const moved = changes.flatMap((item) =>
        item.type === "position" && item.position && !item.dragging
          ? [{ id: item.id, position: item.position }]
          : [],
      );
      if (moved.length) persistPositions(moved, true);
    }
  };
  const startDragging = () => {
    commit();
    mouseDragging.current = true;
  };
  const finishDragging = (moved: FlowNode[]) => {
    persistPositions(moved, false);
    mouseDragging.current = false;
  };
  const selectFromCanvas = (id: string | null) => {
    canvasSelection.current = id;
    onSelect(id);
  };
  const connect = (connection: Connection, label = "") =>
    change(
      (c) => {
        c.diagrams
          .find((d) => d.id === diagram.id)!
          .edges.push({
            id: uid(),
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle ?? "out",
            targetHandle: connection.targetHandle ?? "in",
            label,
          });
      },
      "Connect nodes",
      diagram.id,
    );
  const edges = flowEdges(diagram, onSelect).map((e) => ({
    ...e,
    selected: e.id === selected,
  }));
  const remove = (nodeIds: string[], edgeIds: string[]) => {
    if (
      !(nodeIds.length + edgeIds.length) ||
      !window.confirm(
        `Delete ${nodeIds.length} node(s) and ${edgeIds.length} selected connection(s)?`,
      )
    )
      return;
    change(
      (c) => {
        const d = c.diagrams.find((d) => d.id === diagram.id)!;
        d.nodes = d.nodes.filter((n) => !nodeIds.includes(n.id));
        d.edges = d.edges.filter(
          (e) =>
            !edgeIds.includes(e.id) &&
            !nodeIds.includes(e.source) &&
            !nodeIds.includes(e.target),
        );
        c.nodeLinks = c.nodeLinks.filter((l) => !nodeIds.includes(l.nodeId));
      },
      "Delete selection",
      diagram.id,
    );
    onSelect(null);
  };
  return (
    <div
      className="graph"
      onKeyDown={(event) => {
        const el = event.target as HTMLElement;
        if (
          (event.key === "Delete" || event.key === "Backspace") &&
          !el.closest('input,textarea,select,[contenteditable="true"]')
        ) {
          event.preventDefault();
          remove(
            nodes.filter((n) => n.selected).map((n) => n.id),
            edges.filter((e) => e.selected).map((e) => e.id),
          );
        }
      }}
    >
      <ReactFlow<FlowNode>
        key={diagram.id}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={onInstance}
        defaultViewport={session.views[diagram.id] ?? { x: 80, y: 60, zoom: 1 }}
        onNodesChange={onNodesChange}
        onNodeDragStart={startDragging}
        onNodeDragStop={(_, __, moved) => finishDragging(moved)}
        onSelectionDragStart={startDragging}
        onSelectionDragStop={(_, moved) => finishDragging(moved)}
        onSelectionStart={() => commit()}
        onConnect={(connection) => connect(connection)}
        onReconnect={(edge, connection) =>
          change(
            (c) => {
              const e = c.diagrams
                .find((d) => d.id === diagram.id)!
                .edges.find((x) => x.id === edge.id)!;
              Object.assign(e, connection);
            },
            "Reconnect nodes",
            diagram.id,
          )
        }
        onNodeClick={(_, n) => selectFromCanvas(n.id)}
        onNodeDoubleClick={(_, n) => {
          selectFromCanvas(n.id);
          onInspect?.(n.id);
        }}
        onEdgeClick={(_, e) => onSelect(e.id)}
        onPaneClick={() => selectFromCanvas(null)}
        onMoveEnd={(_, viewport) => setView(diagram.id, viewport)}
        deleteKeyCode={null}
        minZoom={0.1}
        maxZoom={2.5}
        snapToGrid
        snapGrid={[10, 10]}
        onlyRenderVisibleElements={false}
        nodesConnectable
        edgesReconnectable
      >
        <Background gap={22} size={1} color="#c9d6d2" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            (n.data as { task: TaskNode }).task.type === "note"
              ? "#d8d4c7"
              : "#b2c9c1"
          }
          nodeStrokeWidth={0}
          maskColor="rgba(229,236,232,.55)"
        />
      </ReactFlow>
      {!diagram.nodes.length && (
        <div className="canvas-empty">
          <div className="empty-symbol">◇</div>
          <h2>Add your first step</h2>
          <p>Add a process, then connect it to the next step.</p>
          {onAddNode && (
            <button className="primary" onClick={onAddNode}>
              Add a process
            </button>
          )}
        </div>
      )}
      {connectRequest && (
        <Dialog title="Connect nodes" onClose={onConnected}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              connect(
                { source, target, sourceHandle: "out", targetHandle: "in" },
                branch,
              );
              setSource("");
              setTarget("");
              setBranch("");
              onConnected();
            }}
          >
            <Field label="From">
              <select
                required
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">Choose source…</option>
                {diagram.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose target…</option>
                {diagram.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Branch label">
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="Yes, No, or a condition"
              />
            </Field>
            <div className="dialog-actions">
              <button type="button" onClick={onConnected}>
                Cancel
              </button>
              <button className="primary" disabled={!source || !target}>
                Connect
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
