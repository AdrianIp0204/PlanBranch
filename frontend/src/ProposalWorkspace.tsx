import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
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
  useProposalDraft,
  proposalDraftKey,
  type ChangeMark,
} from "./proposalDraft";
import { useProject } from "./store";
import type { DraftReference } from "./durableDrafts";
import {
  reviewChanges,
  reviewHints,
  retainReviewCursor,
  type ReviewCursor,
  type ReviewTarget,
} from "./reviewChanges";
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
export type ProposalLeaveGuard = () => Promise<boolean>;

export type ProposalWorkspaceProps = {
  detail: ProposalDetail;
  projectId: string;
  onApply: (
    diagram: Diagram | undefined,
    draft?: DraftReference,
  ) => Promise<void>;
  onCancelApply?: () => void;
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
      proposalId={detail.proposal.id}
      contentHash={detail.contentHash}
      readOnly={["accepted", "rejected"].includes(detail.proposal.state)}
    >
      <Workspace {...props} storageKey={storageKey} />
    </ProposalDraftProvider>
  );
}

function Workspace({
  detail,
  onApply,
  onCancelApply,
  onRevise,
  onDiscard,
  onClose,
  stale,
  retryingApply = false,
  onRegisterLeaveGuard,
  storageKey,
}: ProposalWorkspaceProps & { storageKey: string }) {
  const { session, change, commit, undo, redo, getSnapshot, saveError, flush } =
    useProject();
  const durable = useProposalDraft();
  const recovering =
    retryingApply ||
    durable.draft?.state === "applying" ||
    (durable.draft?.state === "applied" && detail.proposal.state === "pending");
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
  const previewInstance = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const mountedView = useRef("");
  const pendingReveal = useRef<ReviewTarget | null>(null);
  const [reviewCursor, setReviewCursor] = useState<ReviewCursor>({
    key: null,
    index: -1,
  });
  const { changes, counts } = useMemo(
    () => reviewChanges(before, diagram),
    [before, diagram],
  );
  const hints = useMemo(() => reviewHints(diagram), [diagram]);
  const currentChange = retainReviewCursor(changes, reviewCursor);
  useLayoutEffect(() => {
    if (
      currentChange.key !== reviewCursor.key ||
      currentChange.index !== reviewCursor.index
    )
      setReviewCursor(currentChange);
  }, [
    currentChange.key,
    currentChange.index,
    reviewCursor.key,
    reviewCursor.index,
  ]);
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
  const editLocked = busy || recovering || durable.switching;
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
  const viewKey = manual && side === "after" ? "manual" : `${side}-preview`;
  const fitTarget = (
    instance: ReactFlowInstance<FlowNode>,
    target: ReviewTarget,
  ) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pendingReveal.current !== target) return;
        pendingReveal.current = null;
        void instance.fitView({
          nodes: target.nodeIds.map((id) => ({ id })),
          padding: 0.55,
          duration: 0,
          maxZoom: 1,
        });
      }),
    );
  };
  const reveal = (target: ReviewTarget) => {
    commit();
    setSide(target.side);
    setSelected((previous) => ({ ...previous, [target.side]: target.id }));
    pendingReveal.current = target;
    const targetKey =
      manual && target.side === "after" ? "manual" : `${target.side}-preview`;
    const instance =
      targetKey === "manual" ? manualInstance.current : previewInstance.current;
    if (mountedView.current === targetKey && instance)
      fitTarget(instance, target);
  };
  const navigateChange = (index: number) => {
    const item = changes[index];
    if (!item) return;
    setReviewCursor({ key: item.key, index });
    reveal(item);
  };
  const previousChange = () =>
    navigateChange(
      currentChange.index <= 0 ? changes.length - 1 : currentChange.index - 1,
    );
  const nextChange = () =>
    navigateChange((currentChange.index + 1) % changes.length);
  const navigatorKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !(event.target instanceof HTMLButtonElement) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !changes.length
    )
      return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowLeft") previousChange();
    else if (event.key === "ArrowRight") nextChange();
    else navigateChange(event.key === "Home" ? 0 : changes.length - 1);
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
    if (busyRef.current || durable.switching) return;
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
      if (action === "apply") {
        if (!recovering && !(await flush())) return;
        const reference = durable.getReference();
        if (!reference)
          throw new Error("Save the proposal draft before applying it.");
        await onApply(
          samePlan(candidate, original) ? undefined : copy(candidate),
          reference,
        );
      } else await onDiscard();
      clearProposalDraft(storageKey);
    } catch (reason) {
      await durable.refresh();
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
  const canLeave: ProposalLeaveGuard = async () => {
    if (busyRef.current || durable.switching) return false;
    // Prepared/committed Apply intents are durable and recoverable on return.
    if (recovering) return true;
    return flush();
  };
  useLayoutEffect(() => {
    onRegisterLeaveGuard?.(canLeave);
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard, flush, recovering, durable.switching]);
  const leave = async () => {
    if (await canLeave()) onClose();
  };
  const recoverAction = async (action: () => Promise<boolean>) => {
    setError("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    }
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
          void durable.retry();
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
            disabled={
              busy ||
              durable.switching ||
              durable.status === "conflict" ||
              (!canApply && !recovering)
            }
            aria-describedby={
              recovering ? "proposal-apply-recovery" : undefined
            }
            onClick={() => void run("apply")}
          >
            {busy ? "Working…" : recovering ? "Retry apply" : "Apply changes"}
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
            disabled={editLocked || !reviewable}
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
            disabled={busy || durable.switching}
            onClick={() => void leave()}
          >
            Back to plan
          </button>
        </div>
      </header>
      {recovering && (
        <p
          className="proposal-notice"
          role="status"
          id="proposal-apply-recovery"
        >
          Apply is awaiting confirmation. Retry checks the saved receipt without
          duplicating changes.
          {durable.draft?.state === "applying" && (
            <button
              onClick={() =>
                void recoverAction(async () => {
                  if (
                    !window.confirm(
                      "Cancel this pending Apply and return to editing?",
                    )
                  )
                    return false;
                  const cancelled = await durable.cancelApply();
                  if (cancelled) onCancelApply?.();
                  return cancelled;
                })
              }
            >
              Cancel pending apply
            </button>
          )}
        </p>
      )}
      {stale && !recovering && (
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
      <div className="proposal-draft-bar">
        <span role="status" data-testid="proposal-draft-state">
          {durable.switching
            ? "Loading draft…"
            : recovering
              ? "Apply recorded"
              : durable.status === "saved"
                ? durable.draft.draftRevision
                  ? "Draft saved"
                  : "Original proposal"
                : durable.status === "saving"
                  ? "Saving draft…"
                  : durable.status === "conflict"
                    ? "Draft conflict"
                    : durable.status === "failed"
                      ? "Draft not saved"
                      : "Unsaved draft"}
          {durable.draft?.updatedAt && durable.status === "saved" && (
            <small>
              {" "}
              ·{" "}
              {new Date(durable.draft.updatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          )}
        </span>
        {durable.status === "failed" && !recovering && (
          <button onClick={() => void recoverAction(durable.retry)}>
            Retry draft save
          </button>
        )}
        {durable.conflict && (
          <>
            <span>Both versions were kept.</span>
            <button onClick={() => void recoverAction(durable.useRecovery)}>
              Use my copy
            </button>
            <button
              onClick={() =>
                void recoverAction(
                  async () =>
                    window.confirm(
                      "Load the other saved draft and discard any newer unsaved edits in this window?",
                    ) && durable.loadLatest(),
                )
              }
            >
              Load other draft
            </button>
          </>
        )}
        {(durable.drafts.filter((d) => d.state !== "discarded").length > 1 ||
          (durable.drafts.some((d) => d.state !== "discarded") &&
            !durable.draft.draftRevision)) && (
          <select
            aria-label="Saved proposal draft"
            value={durable.draft.draftRevision ? durable.draft.id : ""}
            disabled={busy || durable.switching}
            onChange={(event) => {
              const id = event.target.value;
              void recoverAction(
                async () => (await canLeave()) && durable.selectDraft(id),
              );
            }}
          >
            {!durable.draft.draftRevision && (
              <option value="">Original proposal</option>
            )}
            {durable.drafts
              .filter((d) => d.state !== "discarded")
              .map((draft, index) => (
                <option key={draft.id} value={draft.id}>
                  {draft.conflictOf ? "Recovered copy" : "Draft"} {index + 1} ·{" "}
                  {new Date(draft.updatedAt).toLocaleTimeString()}
                </option>
              ))}
          </select>
        )}
      </div>
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
        ) : null}
        <div
          className="proposal-navigator"
          role="group"
          aria-label="Review changes"
          data-current-change={currentChange.key ?? ""}
          onKeyDown={navigatorKeys}
        >
          <button
            className="quiet"
            aria-label="Previous change"
            title="Previous change (Left arrow)"
            disabled={!changes.length || busy || durable.switching}
            onClick={previousChange}
          >
            ←
          </button>
          <select
            aria-label="Review change"
            value={currentChange.key ?? ""}
            disabled={!changes.length || busy || durable.switching}
            onChange={(event) =>
              navigateChange(
                changes.findIndex((item) => item.key === event.target.value),
              )
            }
          >
            <option value="" disabled>
              {changes.length ? "Choose a change" : "No diagram changes"}
            </option>
            {changes.map((item) => (
              <option key={item.key} value={item.key}>
                {item.kind[0].toUpperCase() + item.kind.slice(1)}{" "}
                {item.entity === "node" ? "node" : "connection"}: {item.title}
              </option>
            ))}
          </select>
          <span
            data-testid="review-change-position"
            className="proposal-change-position"
            aria-live="polite"
            aria-atomic="true"
          >
            {currentChange.index + 1} of {changes.length}
          </span>
          <button
            className="quiet"
            aria-label="Next change"
            title="Next change (Right arrow)"
            disabled={!changes.length || busy || durable.switching}
            onClick={nextChange}
          >
            →
          </button>
        </div>
        <div
          className="proposal-legend"
          aria-label="Change counts"
          data-testid="review-change-counts"
        >
          <span className="added">{counts.added} added</span>
          <span className="changed">{counts.changed} changed</span>
          <span className="removed">{counts.removed} removed</span>
        </div>
        <details
          className="proposal-hints"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}
        >
          <summary>
            {hints.length
              ? `Review hints (${hints.length})`
              : "Review hints · none"}
          </summary>
          <div className="proposal-hints-content">
            <p>
              Suggestions only. Separate flows and unlabeled branches can be
              intentional.
            </p>
            {hints.length ? (
              <ul>
                {hints.map((hint) => (
                  <li key={hint.key}>
                    <button
                      className="quiet"
                      disabled={busy || durable.switching}
                      onClick={(event) => {
                        reveal(hint);
                        const disclosure =
                          event.currentTarget.closest("details");
                        if (disclosure) {
                          disclosure.open = false;
                          disclosure
                            .querySelector("summary")
                            ?.focus({ preventScroll: true });
                        }
                      }}
                    >
                      {hint.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                No missing criteria, unlabeled decision branches, or separate
                flows found. This does not verify the plan.
              </p>
            )}
          </div>
        </details>
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
                mountedView.current = "manual";
                if (pendingReveal.current?.side === "after")
                  fitTarget(instance, pendingReveal.current);
                else if (!session.views[diagram.id])
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
              fitView={!previewViews.current[side] && !pendingReveal.current}
              onInit={(instance) => {
                previewInstance.current = instance;
                mountedView.current = viewKey;
                if (pendingReveal.current?.side === side)
                  fitTarget(instance, pendingReveal.current);
              }}
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
            : `${edited ? (durable.status === "saved" ? "Draft saved separately" : "Draft changes pending") : "Preview only"} · saved plan unchanged`}
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
