import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import Canvas, {
  TaskShape,
  edgeTypes,
  flowEdges,
  flowNodes,
  type FlowNode,
} from "./Canvas";
import Inspector from "./Inspector";
import { ResizeHandle } from "./layout";
import { samePlan, type PlanProposal } from "./planning";
import {
  clearProposalDraft,
  diagramMarks,
  ProposalDraftProvider,
  proposalDraftKey,
  type ChangeMark,
} from "./proposalDraft";
import { useProject } from "./store";
import {
  copy,
  createNode,
  nodeKinds,
  statuses,
  type Content,
  type Diagram,
  type NodeKind,
  type Viewport,
} from "./types";
import "./proposal-workspace.css";

export type ProposalDetail = {
  proposal: PlanProposal;
  content: Content;
  baseContent: Content | null;
  contentHash: string;
};
export type ProposalLeaveGuard = () => boolean;

export type ProposalWorkspaceProps = {
  detail: ProposalDetail;
  projectId: string;
  onApply: (diagram: Diagram | undefined) => Promise<void>;
  onRevise: (diagram: Diagram) => void;
  onDiscard: () => Promise<void>;
  onClose: () => void;
  stale: boolean;
  retryingApply?: boolean;
  onRegisterLeaveGuard?: (guard: ProposalLeaveGuard | null) => void;
};

function ReviewNode(props: NodeProps<FlowNode>) {
  const mark = (props.data as FlowNode["data"] & { changeMark?: ChangeMark })
    .changeMark;
  return (
    <div className={`proposal-node ${mark?.toLowerCase() ?? ""}`}>
      {mark && <span className="proposal-change-badge">{mark}</span>}
      <TaskShape {...props} />
    </div>
  );
}
const reviewNodeTypes = { task: ReviewNode };

export default function ProposalWorkspace(props: ProposalWorkspaceProps) {
  const { detail, projectId } = props;
  const storageKey = proposalDraftKey(
    projectId,
    detail.proposal.id,
    detail.contentHash,
  );
  if (!detail.content.diagrams.some((d) => d.id === detail.proposal.diagramId))
    return (
      <section className="proposal-workspace">
        <p role="alert">This proposed diagram is unavailable.</p>
        <button onClick={props.onClose}>Back to plan</button>
      </section>
    );
  return (
    <ProposalDraftProvider
      key={storageKey}
      projectId={projectId}
      content={detail.content}
      diagramId={detail.proposal.diagramId}
      storageKey={storageKey}
    >
      <Workspace {...props} storageKey={storageKey} />
    </ProposalDraftProvider>
  );
}

function Workspace({
  detail,
  onApply,
  onRevise,
  onDiscard,
  onClose,
  stale,
  retryingApply = false,
  onRegisterLeaveGuard,
  storageKey,
}: ProposalWorkspaceProps & { storageKey: string }) {
  const { session, change, commit, undo, redo, getSnapshot, saveError } =
    useProject();
  const { proposal } = detail;
  const diagram = session.content.diagrams.find(
    (d) => d.id === proposal.diagramId,
  )!;
  const original = detail.content.diagrams.find(
    (d) => d.id === proposal.diagramId,
  )!;
  const before = detail.baseContent?.diagrams.find(
    (d) => d.id === proposal.diagramId,
  );
  const [side, setSide] = useState<"before" | "after">("after");
  const [manual, setManual] = useState(false);
  const [selected, setSelected] = useState<
    Record<"before" | "after", string | null>
  >({ before: null, after: null });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const detailsClose = useRef<HTMLButtonElement>(null);
  const focusDetailsOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (detailsOpen && focusDetailsOnOpen.current) {
      focusDetailsOnOpen.current = false;
      detailsClose.current?.focus({ preventScroll: true });
    }
  }, [detailsOpen]);
  const [detailsWidth, setDetailsWidth] = useState(300);
  const [nodeKind, setNodeKind] = useState<NodeKind>("process");
  const [connect, setConnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const manualInstance = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const previewViews = useRef<Partial<Record<"before" | "after", Viewport>>>(
    {},
  );
  const shown = side === "before" && before ? before : diagram;
  const currentSelection = selected[side];
  const selectedExists =
    shown.nodes.some((n) => n.id === currentSelection) ||
    shown.edges.some((e) => e.id === currentSelection);
  const edited = !samePlan(diagram, original);
  const canApply = proposal.state === "pending" && !stale;
  const editLocked = busy || retryingApply;
  const reviewable = proposal.state === "pending" || proposal.state === "stale";
  const marks = diagramMarks(before, diagram);
  const nodeMarks = marks.nodes[side],
    edgeMarks = marks.edges[side];
  const cursor = session.history.findIndex((h) => h.id === session.cursor);
  const select = (id: string | null) => {
    commit();
    setSelected((previous) => ({ ...previous, [side]: id }));
  };
  const inspect = (id: string) => {
    select(id);
    setDetailsOpen(true);
  };
  const closeDetails = () => {
    commit();
    setDetailsOpen(false);
    detailsToggle.current?.focus({ preventScroll: true });
  };
  const add = () => {
    const instance = manualInstance.current;
    const bounds = document
      .querySelector(".proposal-workspace .graph")
      ?.getBoundingClientRect();
    const position =
      instance && bounds
        ? instance.screenToFlowPosition({
            x: bounds.left + bounds.width / 2 - 110,
            y: bounds.top + bounds.height / 2 - 56,
          })
        : { x: 80, y: 80 };
    const node = createNode(nodeKind, position);
    change(
      (c) => c.diagrams.find((d) => d.id === diagram.id)!.nodes.push(node),
      `Add ${nodeKinds[nodeKind]}`,
      diagram.id,
    );
    select(node.id);
    setDetailsOpen(true);
  };
  const run = async (action: "apply" | "discard") => {
    if (busyRef.current) return;
    if (
      action === "discard" &&
      !window.confirm(
        "Discard this proposal and its manual edits? Your saved plan stays unchanged.",
      )
    )
      return;
    commit();
    setError("");
    busyRef.current = true;
    setBusy(true);
    try {
      const candidate = getSnapshot().content.diagrams.find(
        (d) => d.id === diagram.id,
      )!;
      if (action === "apply")
        await onApply(
          samePlan(candidate, original) ? undefined : copy(candidate),
        );
      else await onDiscard();
      clearProposalDraft(storageKey);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The change could not be completed. Your draft is still here.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const canLeave: ProposalLeaveGuard = () => {
    // Read the current draft, including a field edit that has not blurred yet.
    if (busyRef.current || retryingApply) return false;
    const current = getSnapshot().content.diagrams.find(
      (d) => d.id === diagram.id,
    );
    return (
      !saveError ||
      samePlan(current, original) ||
      window.confirm(
        "This browser could not keep your manual edits. Leave this preview and lose those edits?",
      )
    );
  };
  useLayoutEffect(() => {
    onRegisterLeaveGuard?.(canLeave);
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard, getSnapshot, saveError, retryingApply]);
  const leave = () => {
    if (canLeave()) onClose();
  };
  const nodes = flowNodes(shown).map((n) => ({
    ...n,
    selected: n.id === currentSelection,
    data: { ...n.data, changeMark: nodeMarks[n.id] },
    ariaLabel: `${n.data.task.title}${nodeMarks[n.id] ? `, ${nodeMarks[n.id]}` : ""}`,
  }));
  const edges = flowEdges(shown, inspect).map((e) => ({
    ...e,
    selected: e.id === currentSelection,
    label: edgeMarks[e.id]
      ? `${edgeMarks[e.id]}${e.label ? ` · ${String(e.label)}` : " connection"}`
      : e.label,
    style: {
      ...e.style,
      stroke:
        edgeMarks[e.id] === "Removed"
          ? "#996232"
          : edgeMarks[e.id]
            ? "#1c6556"
            : "#7a9390",
      strokeDasharray: edgeMarks[e.id] === "Removed" ? "6 4" : undefined,
      strokeWidth: edgeMarks[e.id] ? 2.5 : 1.7,
    },
  }));
  return (
    <section
      className="proposal-workspace"
      aria-label="Proposed changes workspace"
      aria-busy={busy}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          commit();
          return;
        }
        if (target.closest('input,textarea,select,[contenteditable="true"]'))
          return;
        if (
          (event.ctrlKey || event.metaKey) &&
          ["z", "y", "s"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (manual && !editLocked) {
            if (event.key.toLowerCase() === "s") commit();
            else if (event.key.toLowerCase() === "y" || event.shiftKey) redo();
            else undo();
          }
        }
      }}
    >
      <header className="proposal-review-bar">
        <div className="proposal-heading">
          <span className="eyebrow">
            {manual ? "Editing proposal" : "Proposed changes"}
          </span>
          <strong>{proposal.title}</strong>
        </div>
        <div className="proposal-review-actions">
          <button
            className="primary"
            disabled={busy || (!canApply && !retryingApply)}
            aria-describedby={
              retryingApply ? "proposal-apply-recovery" : undefined
            }
            onClick={() => void run("apply")}
          >
            {busy
              ? "Working…"
              : retryingApply
                ? "Retry apply"
                : "Apply changes"}
          </button>
          <button
            disabled={editLocked || !reviewable}
            onClick={() => {
              commit();
              onRevise(
                copy(
                  getSnapshot().content.diagrams.find(
                    (d) => d.id === diagram.id,
                  )!,
                ),
              );
            }}
          >
            Ask Codex
          </button>
          <button
            disabled={editLocked || !canApply}
            aria-pressed={manual}
            onClick={() => {
              commit();
              setSide("after");
              setManual((value) => !value);
            }}
          >
            {manual ? "Preview" : "Edit manually"}
          </button>
          <button
            className="quiet danger"
            disabled={editLocked || !reviewable}
            onClick={() => void run("discard")}
          >
            Discard
          </button>
          <button
            className="quiet"
            disabled={editLocked}
            aria-describedby={
              retryingApply ? "proposal-apply-recovery" : undefined
            }
            onClick={leave}
          >
            Back to plan
          </button>
        </div>
      </header>
      {retryingApply && (
        <p
          className="proposal-notice"
          role="status"
          id="proposal-apply-recovery"
        >
          Connection interrupted. Choose Retry apply to confirm whether your
          changes were saved. Editing and navigation stay paused until then.
        </p>
      )}
      {stale && !retryingApply && (
        <p className="proposal-notice" role="status">
          The plan has changed since this proposal. Ask for a new proposal
          before applying changes.
        </p>
      )}
      {proposal.state !== "pending" && (
        <p className="proposal-notice">This proposal is {proposal.state}.</p>
      )}
      {(error || saveError) && (
        <p className="error-message" role="alert">
          {error || saveError}
        </p>
      )}
      <div className="proposal-tools">
        <div className="proposal-compare" aria-label="Compare proposal">
          <button
            aria-pressed={side === "after"}
            onClick={() => {
              commit();
              setSide("after");
            }}
          >
            Proposed{edited ? " · edited" : ""}
          </button>
          <button
            disabled={!before}
            aria-pressed={side === "before"}
            onClick={() => {
              commit();
              setSide("before");
            }}
          >
            Before
          </button>
        </div>
        {manual && side === "after" ? (
          <div className="proposal-edit-tools">
            <select
              aria-label="New node type"
              disabled={editLocked}
              value={nodeKind}
              onChange={(event) => setNodeKind(event.target.value as NodeKind)}
            >
              {Object.entries(nodeKinds).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
            <button onClick={add} disabled={editLocked}>
              Add node
            </button>
            <button
              disabled={editLocked || diagram.nodes.length < 2}
              onClick={() => setConnect(true)}
            >
              Connect
            </button>
            <button
              aria-label="Undo manual edit"
              disabled={editLocked || (cursor === 0 && !session.pending)}
              onClick={undo}
            >
              Undo
            </button>
            <button
              aria-label="Redo manual edit"
              disabled={
                editLocked ||
                !!session.pending ||
                cursor >= session.history.length - 1
              }
              onClick={redo}
            >
              Redo
            </button>
          </div>
        ) : (
          <div className="proposal-legend" aria-label="Change legend">
            <span className="added">+ Added</span>
            <span className="changed">~ Changed</span>
            <span className="removed">− Removed in Before</span>
          </div>
        )}
        <button
          ref={detailsToggle}
          className="quiet proposal-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls="proposal-details"
          onClick={(event) => {
            if (detailsOpen) closeDetails();
            else {
              focusDetailsOnOpen.current = event.detail === 0;
              setDetailsOpen(true);
            }
          }}
        >
          Details
        </button>
      </div>
      <div
        className={`proposal-body ${detailsOpen ? "details-open" : ""}`}
        style={
          { "--proposal-details-width": `${detailsWidth}px` } as CSSProperties
        }
      >
        <div
          className="proposal-canvas"
          inert={editLocked}
          aria-label={side === "before" ? "Before diagram" : "Proposed diagram"}
        >
          {manual && side === "after" ? (
            <Canvas
              diagram={diagram}
              selected={currentSelection}
              onSelect={select}
              onInspect={inspect}
              filter="all"
              connectRequest={connect}
              onConnected={() => setConnect(false)}
              onAddNode={add}
              onInstance={(instance) => {
                manualInstance.current = instance;
                if (!session.views[diagram.id])
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                      void instance.fitView({
                        padding: 0.2,
                        duration: 0,
                        maxZoom: 1,
                      });
                    }),
                  );
              }}
            />
          ) : (
            <ReactFlow<FlowNode>
              key={`${side}-preview`}
              nodes={nodes}
              edges={edges}
              nodeTypes={reviewNodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesReconnectable={false}
              deleteKeyCode={null}
              minZoom={0.1}
              maxZoom={2.5}
              fitView={!previewViews.current[side]}
              defaultViewport={previewViews.current[side]}
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              onNodeClick={(_, n) => select(n.id)}
              onNodeDoubleClick={(_, n) => inspect(n.id)}
              onEdgeClick={(_, e) => inspect(e.id)}
              onPaneClick={() => select(null)}
              onMoveEnd={(_, view) => {
                previewViews.current[side] = view;
              }}
            >
              <Background gap={22} size={1} color="#c9d6d2" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          {!shown.nodes.length && !(manual && side === "after") && (
            <div className="proposal-empty">
              {side === "before"
                ? "This diagram was empty."
                : "This proposal leaves the diagram empty."}
            </div>
          )}
        </div>
        {detailsOpen && (
          <>
            <ResizeHandle
              label="Resize proposal details"
              controls="proposal-details"
              orientation="vertical"
              value={detailsWidth}
              min={260}
              max={420}
              onChange={setDetailsWidth}
              onCollapse={closeDetails}
            />
            <div
              className="proposal-inspector"
              id="proposal-details"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeDetails();
              }}
            >
              <button
                ref={detailsClose}
                className="quiet proposal-close-details"
                onClick={closeDetails}
              >
                Close details
              </button>
              {selectedExists ? (
                manual && side === "after" ? (
                  <fieldset disabled={editLocked} className="proposal-fields">
                    <Inspector
                      diagram={shown}
                      selected={currentSelection}
                      symbols={[]}
                      onSelect={select}
                      onVariable={() => {}}
                    />
                  </fieldset>
                ) : (
                  <ReadOnlyDetails
                    diagram={shown}
                    selected={currentSelection}
                  />
                )
              ) : (
                <p className="proposal-details-empty">
                  Select a node or connection.
                </p>
              )}
            </div>
          </>
        )}
      </div>
      <footer className="proposal-footer">
        <span>
          {proposal.state === "accepted"
            ? "Original agent proposal · applied result may include manual edits"
            : `${edited ? (saveError ? "Manual edits in this window" : "Manual edits kept in this browser") : "Preview only"} · saved plan unchanged`}
        </span>
        <span>
          {shown.name} · {shown.nodes.length} nodes
        </span>
      </footer>
    </section>
  );
}

function ReadOnlyDetails({
  diagram,
  selected,
}: {
  diagram: Diagram;
  selected: string | null;
}) {
  const node = diagram.nodes.find((n) => n.id === selected);
  const edge = diagram.edges.find((e) => e.id === selected);
  if (edge)
    return (
      <div className="proposal-readonly-details">
        <h3>Connection</h3>
        <p>
          {diagram.nodes.find((n) => n.id === edge.source)?.title} →{" "}
          {diagram.nodes.find((n) => n.id === edge.target)?.title}
        </p>
        <p>{edge.label || "No label"}</p>
      </div>
    );
  if (!node) return null;
  const fields: [string, string][] = [
    ["Description", node.description],
    ["Blocker", node.blocker],
    ["Notes", node.notes],
    ["Pseudocode", node.pseudocode],
    ["Target file", node.targetFile],
    ["Function / scope", node.targetScope],
    ["Decision rationale", node.why],
    ["Alternatives", node.alternatives],
  ];
  return (
    <div className="proposal-readonly-details">
      <h3>{node.title}</h3>
      <p>
        {nodeKinds[node.type]} · {statuses[node.status]}
      </p>
      <dl>
        {fields
          .filter(([, value]) => !!value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {node.checklist.length > 0 && (
        <>
          <h4>Checklist</h4>
          <ul>
            {node.checklist.map((item) => (
              <li key={item.id}>
                {item.checked ? "✓" : "○"} {item.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
