import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import { ResizeHandle, clamp } from "./layout";
import { Dialog } from "./ui";
import ModelControls, {
  isLegacyPlanningServerError,
  useModelSelection,
} from "./ModelControls";
import QuestionCard from "./QuestionCard";
import { api } from "./api";
import { useProject } from "./store";
import { uid } from "./types";
import {
  samePlan,
  selectionLabel,
  readPlanningDrafts,
  writePlanningDrafts,
  reviewFieldLabel,
  reviewNames,
  reviewValueText,
  type PlanningState,
  type PlanningPrompt,
  type ProposedChange,
  type QuestionDrafts,
  type ProposalRevision,
  type AnswerSubmission,
  type QuestionAnswer,
  type QuestionSet,
} from "./planning";
import "./planning.css";

type Tab = "conversation" | "comments" | "review";
const tabs: Tab[] = ["conversation", "comments", "review"];
const tabNames = {
  conversation: "Chat",
  comments: "Comments",
  review: "Changes",
};
const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed. Try again.";
function Change({
  change,
  beforeNames,
  afterNames,
}: {
  change: ProposedChange;
  beforeNames: ReturnType<typeof reviewNames>;
  afterNames: ReturnType<typeof reviewNames>;
}) {
  const action = (
    { add: "Add", remove: "Remove", update: "Update" } as Record<string, string>
  )[change.kind.split("_")[0]];
  const names = change.kind.startsWith("add_") ? afterNames : beforeNames;
  const heading =
    action && change.kind.endsWith("_node")
      ? `${action} node: ${names.nodes[change.nodeId ?? ""] || "Untitled node"}`
      : action && change.kind.endsWith("_edge")
        ? `${action} connection: ${names.edges[change.edgeId ?? ""] || "Connection"}`
        : change.label;
  return (
    <li className="planning-change">
      <h4>
        {heading}
        {change.field && (
          <span className="planning-change-field">
            {" "}
            · {reviewFieldLabel(change.field)}
          </span>
        )}
      </h4>
      <div className="planning-diff">
        <div>
          <strong>Before</strong>
          <pre>{reviewValueText(change, change.before, beforeNames)}</pre>
        </div>
        <div>
          <strong>After</strong>
          <pre>{reviewValueText(change, change.after, afterNames)}</pre>
        </div>
      </div>
    </li>
  );
}

export default function PlanningPanel({
  diagramId,
  nodeId,
  onReveal,
  onApply,
  onClose,
  active = true,
  focusComments = 0,
  composerHeight = 150,
  onComposerResize,
  onPreview,
  onState,
  revisionRequest,
  refreshKey = 0,
}: {
  diagramId: string;
  nodeId: string | null;
  onReveal: (nodeId: string) => void;
  onApply: (proposalId: string, mutationId: string) => Promise<void>;
  onClose: () => void;
  active?: boolean;
  focusComments?: number;
  composerHeight?: number;
  onComposerResize?: (height: number) => void;
  onPreview?: (proposalId: string) => void;
  onState?: (state: PlanningState) => void;
  revisionRequest?: ProposalRevision | null;
  refreshKey?: number;
}) {
  const { session, flush, getSnapshot } = useProject();
  const modelSettings = useModelSelection(active);
  const [recoveredDrafts] = useState(() => readPlanningDrafts(session.id));
  const [state, setState] = useState<PlanningState | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [draft, setDraft] = useState(recoveredDrafts.message);
  const [revision, setRevision] = useState<ProposalRevision | null>(
    recoveredDrafts.revision ?? null,
  );
  const [aboutNode, setAboutNode] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>(
    recoveredDrafts.comments,
  );
  const [commentScope, setCommentScope] = useState<"all" | "selected">("all");
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState("");
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState("");
  const [failedPrompt, setFailedPrompt] = useState<PlanningPrompt | null>(
    recoveredDrafts.failedPrompt,
  );
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDrafts>(
    recoveredDrafts.questionDrafts ?? {},
  );
  const [failedAnswer, setFailedAnswer] = useState<AnswerSubmission | null>(
    recoveredDrafts.failedAnswer ?? null,
  );
  const [announcement, setAnnouncement] = useState("");
  const [help, setHelp] = useState<
    "sharing" | "approval" | "node" | "settings" | null
  >(null);
  const [showSharing, setShowSharing] = useState(() => {
    try {
      return localStorage.getItem("flowdesk.planning-sharing.v1") !== "seen";
    } catch {
      return true;
    }
  });
  const [showJump, setShowJump] = useState(false);
  const [availableHeight, setAvailableHeight] = useState(550);
  const [localComposerHeight, setLocalComposerHeight] =
    useState(composerHeight);
  const conversationView = useRef<HTMLElement>(null);
  const usableHeight = Math.max(0, availableHeight - 9);
  const composerMax = Math.max(
    0,
    Math.floor(usableHeight - Math.min(160, usableHeight * 0.45)),
  );
  const composerMin = Math.min(132, composerMax);
  const currentComposerHeight = clamp(
    onComposerResize ? composerHeight : localComposerHeight,
    composerMin,
    composerMax,
  );
  const resizeComposer = (height: number) => {
    if (onComposerResize) onComposerResize(height);
    else setLocalComposerHeight(height);
  };
  const dismissSharing = () => {
    setShowSharing(false);
    try {
      localStorage.setItem("flowdesk.planning-sharing.v1", "seen");
    } catch {
      /* Still dismiss for this session. */
    }
  };
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const commentComposer = useRef<HTMLTextAreaElement>(null);
  const conversationScroll = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const operation = useRef(false);
  const focusInteraction = useRef(0);
  const uncertainAcceptance = useRef<string | null>(null);
  const mutationIds = useRef(new Map<string, string>());
  function stableMutationId(key: string) {
    let id = mutationIds.current.get(key);
    if (!id) {
      id = uid();
      mutationIds.current.set(key, id);
    }
    return id;
  }
  function focusAfterAction(id: string) {
    if (active)
      requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  function restoreComposerFocus(interaction: number) {
    if (active && mounted.current && focusInteraction.current === interaction)
      composer.current?.focus({ preventScroll: true });
  }
  const failedComment = useRef<{
    mutationId: string;
    nodeId: string;
    diagramId: string;
    text: string;
  } | null>(null);
  const base = `/projects/${session.id}/planning`;
  const diagram = session.content.diagrams.find(
    (item) => item.id === diagramId,
  );
  const node = diagram?.nodes.find((item) => item.id === nodeId);
  const running = state?.request?.status === "running";
  const approvalCurrent = Boolean(
    state?.approval?.current &&
    samePlan(state.approval.snapshot, session.content),
  );
  const pending =
    state?.proposals.filter((proposal) => proposal.state === "pending") ?? [];
  const unresolved =
    state?.comments.filter((comment) => !comment.resolved) ?? [];
  const hasNodes = session.content.diagrams.some((item) =>
    item.nodes.some((candidate) => candidate.type !== "note"),
  );
  const commentDraft =
    node && Object.hasOwn(commentDrafts, node.id) ? commentDrafts[node.id] : "";
  const shownComments =
    state?.comments.filter(
      (comment) =>
        (showResolved || !comment.resolved) &&
        (commentScope === "all" || comment.nodeId === node?.id),
    ) ?? [];
  const questionSets = state?.questionSets ?? [];
  const pendingQuestions = questionSets.find(
    (set) => set.state === "open" || set.state === "stale",
  );
  const questionOutdated = (set: QuestionSet) =>
    set.state === "stale" ||
    Boolean(set.baseSnapshot && !samePlan(set.baseSnapshot, session.content));
  const applicableQuestions =
    pendingQuestions && !questionOutdated(pendingQuestions);
  const approvalReason = applicableQuestions
    ? "Answer the open questions or change direction before approving."
    : running
      ? "Wait for the agent to finish before approving."
      : pending.length
        ? "Accept or reject pending changes before approving."
        : unresolved.length
          ? "Resolve the open node comments before approving."
          : !hasNodes
            ? "Add at least one task or flow node before approving a plan."
            : "";

  async function refresh(force = false) {
    if ((operation.current || uncertainAcceptance.current) && !force) return;
    const sequence = ++requestSequence.current;
    try {
      const next = await api<PlanningState>(base);
      if (mounted.current && sequence === requestSequence.current) {
        setState(next);
        setLoadingError("");
      }
    } catch (err) {
      if (mounted.current && sequence === requestSequence.current)
        setLoadingError(errorText(err));
    }
  }
  useEffect(() => {
    mounted.current = true;
    // A response may arrive after the user has moved to a menu, node, or field.
    // Only the interaction that started the request may restore composer focus.
    const moved = () => {
      focusInteraction.current++;
    };
    const events = ["focusin", "pointerdown", "keydown"] as const;
    for (const event of events) document.addEventListener(event, moved, true);
    return () => {
      mounted.current = false;
      requestSequence.current++;
      for (const event of events)
        document.removeEventListener(event, moved, true);
    };
  }, []);
  useLayoutEffect(() => {
    focusInteraction.current++;
  }, [active, tab]);
  useEffect(() => {
    if (active) void refresh();
    const onFocus = () => {
      if (active) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, session.id, session.revision, refreshKey]);
  useEffect(() => {
    if (state) onState?.(state);
  }, [state, onState]);
  useEffect(() => {
    if (!revisionRequest) return;
    setRevision(revisionRequest);
    setFailedPrompt(null);
    setAboutNode(false);
    setTab("conversation");
    requestAnimationFrame(() => composer.current?.focus());
  }, [revisionRequest?.nonce]);
  useEffect(() => {
    writePlanningDrafts(session.id, {
      message: draft,
      comments: commentDrafts,
      failedPrompt,
      questionDrafts,
      failedAnswer,
      revision,
    });
  }, [
    session.id,
    draft,
    commentDrafts,
    failedPrompt,
    questionDrafts,
    failedAnswer,
    revision,
  ]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 1200);
    return () => clearInterval(timer);
  }, [running, session.id]);
  useEffect(() => {
    if (!focusComments) return;
    setTab("comments");
    setCommentScope("selected");
    if (active) requestAnimationFrame(() => commentComposer.current?.focus());
  }, [focusComments]);
  useEffect(() => {
    if (!node) setAboutNode(false);
  }, [node?.id]);
  useEffect(() => {
    if (!active || tab !== "conversation" || !followConversation.current)
      return;
    const frame = requestAnimationFrame(() => {
      const element = conversationScroll.current;
      if (element && followConversation.current)
        element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    state?.messages.length,
    state?.questionSets?.length,
    running,
    active,
    tab,
  ]);

  useLayoutEffect(() => {
    const element = conversationView.current;
    if (!element || !active || tab !== "conversation") return;
    const measure = () => {
      if (element.clientHeight) setAvailableHeight(element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, tab]);

  async function work(label: string, action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (err) {
      if (mounted.current) {
        if (isLegacyPlanningServerError(err)) {
          modelSettings.markServerIncompatible();
          // This validation response confirms no request was accepted.
          setFailedPrompt(null);
        } else setError(errorText(err));
      }
    } finally {
      operation.current = false;
      if (mounted.current) setBusy("");
    }
  }
  async function saved() {
    if (!(await flush()))
      throw new Error(
        "Save your changes before continuing. Use Retry save or resolve the save conflict in the workspace.",
      );
    return getSnapshot();
  }
  async function mutate(path: string, body: unknown, method = "POST") {
    requestSequence.current++;
    const next = await api<PlanningState>(`${base}${path}`, {
      method,
      body: JSON.stringify(body),
    });
    // Discard any poll that started before this authoritative mutation response.
    requestSequence.current++;
    const receipt = (body as { mutationId?: string }).mutationId;
    if (receipt) {
      for (const [key, id] of mutationIds.current) {
        if (id === receipt) mutationIds.current.delete(key);
      }
    }
    if (mounted.current) {
      setState(next);
      setLoadingError("");
    }
  }
  async function send(prompt?: PlanningPrompt, forceNew = false) {
    if (modelSettings.serverIncompatible) return;
    const capturedRevision = revision;
    const captured: PlanningPrompt = prompt ?? {
      mutationId: uid(),
      text: draft.trim(),
      diagramId: revision?.diagram.id ?? diagramId,
      nodeId: revision ? null : aboutNode ? (node?.id ?? null) : null,
      selection: modelSettings.selection,
      ...(revision
        ? { proposalId: revision.proposalId, proposalDiagram: revision.diagram }
        : {}),
    };
    if (!captured.text) return;
    // An uncertain delivery is retried with its original identifier and payload.
    const body =
      !prompt &&
      !forceNew &&
      failedPrompt &&
      captured.text === failedPrompt.text &&
      captured.diagramId === failedPrompt.diagramId &&
      captured.nodeId === failedPrompt.nodeId &&
      captured.proposalId === failedPrompt.proposalId &&
      samePlan(
        captured.proposalDiagram ?? null,
        failedPrompt.proposalDiagram ?? null,
      )
        ? failedPrompt
        : captured;
    if (body === captured && !prompt && modelSettings.problem) {
      setError(modelSettings.problem);
      return;
    }
    const interaction = focusInteraction.current;
    await work("Sending", async () => {
      await saved();
      setFailedPrompt(body);
      followConversation.current = true;
      await mutate("/messages", body);
      setFailedPrompt(null);
      setFailedAnswer(null);
      setRevision((current) =>
        current?.nonce === capturedRevision?.nonce ? null : current,
      );
      setDraft((current) => (current.trim() === body.text ? "" : current));
      setAnnouncement("Message sent. The agent is preparing a reply.");
      restoreComposerFocus(interaction);
    });
  }
  const failedRequest: PlanningPrompt | null =
    state?.request?.status === "failed" &&
    state.request.text &&
    state.request.diagramId
      ? state.request.payload
        ? { ...state.request.payload, mutationId: state.request.id }
        : {
            mutationId: state.request.id,
            text: state.request.text,
            diagramId: state.request.diagramId,
            nodeId: state.request.nodeId ?? null,
            ...(state.request.selection
              ? { selection: state.request.selection }
              : {}),
          }
      : null;
  const retriesDraft = Boolean(
    failedPrompt &&
    draft.trim() === failedPrompt.text &&
    (revision?.diagram.id ?? diagramId) === failedPrompt.diagramId &&
    (revision ? null : aboutNode ? (node?.id ?? null) : null) ===
      failedPrompt.nodeId &&
    revision?.proposalId === failedPrompt.proposalId &&
    samePlan(revision?.diagram ?? null, failedPrompt.proposalDiagram ?? null),
  );
  function startNewFromFailure() {
    if (!failedRequest) return;
    setDraft((current) => (current.trim() ? current : failedRequest.text));
    setFailedPrompt(null);
    if (
      !revision &&
      failedRequest.proposalId &&
      failedRequest.proposalDiagram
    ) {
      setRevision({
        proposalId: failedRequest.proposalId,
        title:
          state?.proposals.find((item) => item.id === failedRequest.proposalId)
            ?.title ?? "Reviewed proposal",
        diagram: failedRequest.proposalDiagram,
        nonce: uid(),
      });
      setAboutNode(false);
    } else if (!draft.trim())
      setAboutNode(failedRequest.nodeId === node?.id && Boolean(node));
    setTab("conversation");
    setAnnouncement(
      "Review the message and current model settings, then send a new request.",
    );
    requestAnimationFrame(() => composer.current?.focus());
  }
  async function answerQuestions(
    set: QuestionSet,
    answers: QuestionAnswer[],
    replay?: AnswerSubmission,
  ) {
    if (modelSettings.serverIncompatible) return;
    if (!replay && (questionOutdated(set) || modelSettings.problem)) {
      setError(
        questionOutdated(set)
          ? "The plan changed. Ask again using this plan."
          : modelSettings.problem,
      );
      return;
    }
    const interaction = focusInteraction.current;
    await work("Submitting answers", async () => {
      const latest = replay ? getSnapshot() : await saved();
      if (
        !replay &&
        set.baseSnapshot &&
        !samePlan(set.baseSnapshot, latest.content)
      )
        throw new Error("The plan changed. Ask again using this plan.");
      const submission: AnswerSubmission = replay ?? {
        setId: set.id,
        mutationId: uid(),
        baseRevision: latest.revision,
        answers,
        selection: modelSettings.selection,
      };
      setFailedAnswer(submission);
      const { setId, ...body } = submission;
      followConversation.current = true;
      try {
        await mutate(`/questions/${setId}/answers`, body);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          [400, 409, 422].includes(Number(error.status))
        ) {
          setFailedAnswer(null);
          await refresh(true);
        }
        throw error;
      }
      setFailedAnswer(null);
      setAnnouncement("Answers submitted. Codex is continuing the plan.");
      restoreComposerFocus(interaction);
    });
  }
  function revealQuestions() {
    if (!pendingQuestions) return;
    setTab("conversation");
    requestAnimationFrame(() => {
      const card = document.getElementById(
        `question-set-${pendingQuestions.id}`,
      );
      const target = card?.querySelector<HTMLElement>("[tabindex='-1']");
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
  }
  async function askAgain(set: QuestionSet) {
    if (modelSettings.problem) {
      setError(modelSettings.problem);
      return;
    }
    await send({
      mutationId: uid(),
      text: "Please revisit the unanswered questions using the current saved plan. Keep the requirements and answers already confirmed; ask only what is still needed.",
      diagramId: session.content.diagrams.some(
        (item) => item.id === set.diagramId,
      )
        ? set.diagramId
        : diagramId,
      nodeId:
        set.nodeId &&
        session.content.diagrams.some((item) =>
          item.nodes.some((candidate) => candidate.id === set.nodeId),
        )
          ? set.nodeId
          : null,
      selection: modelSettings.selection,
    });
  }
  function renderQuestions(set: QuestionSet) {
    return (
      <QuestionCard
        key={set.id}
        set={set}
        drafts={
          Object.hasOwn(questionDrafts, set.id) ? questionDrafts[set.id] : {}
        }
        stale={questionOutdated(set)}
        busy={Boolean(busy || running || failedAnswer?.setId === set.id)}
        blocked={modelSettings.problem}
        onDraft={(questionId, value) =>
          setQuestionDrafts((current) => ({
            ...current,
            [set.id]: {
              ...(Object.hasOwn(current, set.id) ? current[set.id] : {}),
              [questionId]: value,
            },
          }))
        }
        onSubmit={(answers) => void answerQuestions(set, answers)}
        onAskAgain={() => void askAgain(set)}
      />
    );
  }
  function selectTab(next: Tab) {
    setTab(next);
    if (active)
      requestAnimationFrame(() =>
        document.getElementById(`planning-tab-${next}`)?.focus(),
      );
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const index = tabs.indexOf(current);
    const next =
      event.key === "ArrowRight"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[2]
              : null;
    if (next) {
      event.preventDefault();
      selectTab(next);
    }
  }

  return (
    <aside className="planning-panel" aria-label="Planning conversation">
      <header className="planning-heading">
        <h2>Codex</h2>
        <button
          id="planning-approval-status"
          className={`planning-status ${approvalCurrent ? "is-approved" : ""}`}
          aria-label="Plan status"
          onClick={() => setHelp("approval")}
        >
          {approvalCurrent
            ? "Approved"
            : state?.approval
              ? "Needs review"
              : "Draft"}
        </button>
        {approvalCurrent ? (
          <button
            disabled={Boolean(busy)}
            onClick={() =>
              void work("Reopening", async () => {
                await mutate("/reopen", {
                  mutationId: stableMutationId(`reopen:${state?.approval?.id}`),
                });
                setAnnouncement("Plan reopened for discussion.");
                focusAfterAction("planning-approval-status");
              })
            }
          >
            Reopen plan
          </button>
        ) : (
          <button
            className="quiet"
            disabled={Boolean(busy || approvalReason || !state)}
            aria-describedby={
              approvalReason ? "planning-approval-reason" : undefined
            }
            onClick={() =>
              void work("Approving", async () => {
                const latest = await saved();
                await mutate("/approve", {
                  baseRevision: latest.revision,
                  mutationId: stableMutationId(`approve:${latest.revision}`),
                });
                setAnnouncement(
                  "The saved plan is approved. No steps have been executed.",
                );
                focusAfterAction("planning-approval-status");
              })
            }
          >
            Approve plan
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Close planning conversation"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <span id="planning-approval-reason" className="sr-only">
        {approvalReason}
      </span>
      <div className="planning-tabs" role="tablist" aria-label="Planning views">
        {tabs.map((item) => (
          <button
            key={item}
            role="tab"
            id={`planning-tab-${item}`}
            aria-controls={`planning-view-${item}`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => tabKey(event, item)}
          >
            {tabNames[item]}
            {item === "comments" && unresolved.length > 0
              ? ` (${unresolved.length})`
              : item === "review" && pending.length > 0
                ? ` (${pending.length})`
                : ""}
          </button>
        ))}
      </div>
      <div className="sr-only" role="status">
        {announcement}
      </div>
      {loadingError && (
        <div className="planning-feedback" role="alert">
          <p>{loadingError}</p>
          <button onClick={() => void refresh()}>Retry connection</button>
        </div>
      )}
      {error && (
        <div className="planning-feedback" role="alert">
          {error}
        </div>
      )}
      {!state && !loadingError && (
        <p className="planning-loading" role="status">
          Loading conversation…
        </p>
      )}

      <section
        ref={conversationView}
        id="planning-view-conversation"
        role="tabpanel"
        aria-labelledby="planning-tab-conversation"
        className="planning-tab-content"
        style={
          { "--composer-height": `${currentComposerHeight}px` } as CSSProperties
        }
        hidden={tab !== "conversation"}
      >
        <div
          className="planning-scroll"
          tabIndex={-1}
          aria-label="Chat history"
          ref={conversationScroll}
          onScroll={(event) => {
            const element = event.currentTarget;
            followConversation.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <
              60;
            setShowJump(!followConversation.current);
          }}
        >
          {failedAnswer && (
            <div className="planning-feedback" role="status">
              <p>
                Answer delivery is unconfirmed. Retry keeps the submitted
                answers and model settings.
              </p>
              <button
                disabled={Boolean(
                  busy ||
                  !state?.agent.available ||
                  modelSettings.serverIncompatible,
                )}
                onClick={() => {
                  const set = questionSets.find(
                    (item) => item.id === failedAnswer.setId,
                  );
                  if (set)
                    void answerQuestions(
                      set,
                      failedAnswer.answers,
                      failedAnswer,
                    );
                  else
                    setError(
                      "Reload the conversation to recover these questions before retrying.",
                    );
                }}
              >
                Retry answers
              </button>
            </div>
          )}
          {(modelSettings.problem ||
            modelSettings.capabilities?.status === "unavailable") && (
            <div
              className="planning-feedback"
              id="planning-model-problem"
              role="status"
            >
              <p>
                {modelSettings.problem || modelSettings.capabilities?.reason}
              </p>
              <button
                disabled={modelSettings.refreshing}
                onClick={() =>
                  void modelSettings.refresh(!modelSettings.serverIncompatible)
                }
              >
                {modelSettings.refreshing
                  ? "Checking…"
                  : modelSettings.serverIncompatible
                    ? "Check connection"
                    : "Refresh models"}
              </button>
              <button onClick={() => setHelp("settings")}>
                Model settings
              </button>
            </div>
          )}
          {failedPrompt && !busy && !modelSettings.serverIncompatible && (
            <div className="planning-feedback" role="status">
              <p>
                Retry keeps the original settings:{" "}
                {selectionLabel(failedPrompt.selection)}.
              </p>
              <button
                disabled={Boolean(
                  busy ||
                  running ||
                  modelSettings.problem ||
                  !draft.trim() ||
                  !state?.agent.available,
                )}
                onClick={() => void send(undefined, true)}
              >
                Send as new request
              </button>
            </div>
          )}
          {showSharing && (
            <div className="planning-first-use">
              <p>
                Messages share your plan and discussion with Codex. Attached
                source files stay local.
              </p>
              <button className="quiet" onClick={dismissSharing}>
                Got it
              </button>
              <button className="quiet" onClick={() => setHelp("sharing")}>
                Details
              </button>
            </div>
          )}
          {state && !state.agent.available && (
            <div className="planning-feedback">
              <strong>Codex is unavailable</strong>
              <p>
                {state.agent.reason ||
                  "Install Codex CLI and sign in with your existing account using codex login."}
              </p>
              <button disabled={Boolean(busy)} onClick={() => void refresh()}>
                Recheck Codex
              </button>
            </div>
          )}
          {state && state.messages.length === 0 && (
            <div className="planning-empty">
              <h3>What should this plan accomplish?</h3>
              <p>
                Describe a goal or a change. Review edits before applying them.
              </p>
            </div>
          )}
          <ol className="planning-messages" aria-label="Conversation messages">
            {state?.messages.map((message) => (
              <li
                key={message.id}
                className={`planning-message ${message.role}`}
              >
                <div className="planning-message-byline">
                  <strong>
                    {message.role === "user"
                      ? "You"
                      : message.role === "assistant"
                        ? "Codex"
                        : "FlowDesk"}
                  </strong>
                  <time dateTime={message.createdAt}>
                    {time(message.createdAt)}
                  </time>
                </div>
                {message.nodeId && (
                  <button
                    className="planning-context-link"
                    disabled={
                      !session.content.diagrams.some((item) =>
                        item.nodes.some(
                          (candidate) => candidate.id === message.nodeId,
                        ),
                      )
                    }
                    onClick={() => onReveal(message.nodeId!)}
                  >
                    About: {message.nodeTitle || "Selected node"}
                  </button>
                )}
                {message.text && (
                  <p className="planning-prose">{message.text}</p>
                )}
                {questionSets
                  .filter((set) => set.messageId === message.id)
                  .map(renderQuestions)}
                {message.proposalId && (
                  <button
                    onClick={() => {
                      setTab("review");
                      if (message.proposalId) onPreview?.(message.proposalId);
                      requestAnimationFrame(() =>
                        document
                          .getElementById(`proposal-${message.proposalId}`)
                          ?.focus(),
                      );
                    }}
                  >
                    Review proposed changes
                  </button>
                )}
              </li>
            ))}
          </ol>
          {questionSets
            .filter(
              (set) =>
                !state?.messages.some(
                  (message) => message.id === set.messageId,
                ),
            )
            .map(renderQuestions)}
          {running && (
            <p className="planning-run-status" role="status">
              Codex is thinking…
            </p>
          )}
          {state?.request?.status === "failed" && (
            <div className="planning-feedback" role="alert">
              <strong>Codex could not finish</strong>
              <p>
                {state.request.error ||
                  "The request failed. Your message is retained."}
              </p>
              {failedRequest && (
                <p>Retry uses {selectionLabel(failedRequest.selection)}.</p>
              )}
              {failedRequest && (
                <button
                  disabled={Boolean(
                    busy ||
                    !state.agent.available ||
                    modelSettings.serverIncompatible,
                  )}
                  onClick={() => void send(failedRequest)}
                >
                  Retry agent reply
                </button>
              )}
              {failedRequest && (
                <button
                  disabled={Boolean(busy || running)}
                  onClick={startNewFromFailure}
                >
                  Try with another model
                </button>
              )}
              {state.request.generation && (
                <button onClick={() => setHelp("settings")}>
                  Request details
                </button>
              )}
            </div>
          )}
        </div>
        {pendingQuestions && showJump && (
          <button
            className="planning-question-indicator"
            onClick={revealQuestions}
          >
            {questionOutdated(pendingQuestions)
              ? "Questions need updating"
              : "Questions waiting"}
          </button>
        )}
        {showJump && (
          <button
            className="planning-jump"
            onClick={() => {
              followConversation.current = true;
              setShowJump(false);
              const element = conversationScroll.current;
              if (element) {
                element.scrollTop = element.scrollHeight;
                element.focus({ preventScroll: true });
              }
            }}
          >
            Jump to latest ↓
          </button>
        )}
        <ResizeHandle
          label="Resize message composer"
          controls="planning-compose"
          orientation="horizontal"
          value={currentComposerHeight}
          min={composerMin}
          max={composerMax}
          onChange={resizeComposer}
        />
        <form
          id="planning-compose"
          className="planning-composer message-composer"
          style={{ height: currentComposerHeight }}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {revision && (
            <div className="planning-revision-context" role="status">
              <span>
                Revising: <strong>{revision.title}</strong>
              </span>
              <button
                type="button"
                className="quiet"
                aria-label="Cancel proposal revision"
                onClick={() => {
                  setRevision(null);
                  setFailedPrompt(null);
                }}
              >
                ×
              </button>
            </div>
          )}
          <label className="sr-only" htmlFor="planning-message">
            Message Codex
          </label>
          <textarea
            ref={composer}
            id="planning-message"
            value={draft}
            maxLength={12000}
            rows={3}
            placeholder={
              revision
                ? "Describe what to change in this proposal…"
                : pendingQuestions
                  ? "Change direction or add a requirement…"
                  : "Describe a goal or ask for a change…"
            }
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby="planning-sharing-summary"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                if (
                  !busy &&
                  !running &&
                  state?.agent.available &&
                  !modelSettings.serverIncompatible &&
                  (!modelSettings.problem || retriesDraft)
                )
                  void send();
              }
            }}
          />
          {node && (
            <div className="planning-node-context">
              <label className="planning-check">
                <input
                  type="checkbox"
                  checked={aboutNode}
                  onChange={(event) => setAboutNode(event.target.checked)}
                  aria-label="About selected node"
                />
                About
              </label>
              <button
                className="quiet planning-node-chip"
                onClick={() => setHelp("node")}
                type="button"
                aria-label={`Show selected node: ${node.title || "Untitled node"}`}
              >
                {node.title || "Untitled node"}
              </button>
            </div>
          )}
          <span id="planning-sharing-summary" className="sr-only">
            Shares the manual plan and discussion using your Codex CLI sign-in.
            Attached source files are excluded. Control or Command plus Enter
            sends.
          </span>
          <div className="planning-compose-actions message-actions">
            <ModelControls
              selection={modelSettings.selection}
              capabilities={modelSettings.capabilities}
              onChange={modelSettings.setSelection}
            />
            <button
              type="button"
              className="quiet planning-help"
              onClick={() => setHelp("settings")}
              aria-label="Planning settings and sharing help"
            >
              ⓘ
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                !draft.trim() ||
                !state?.agent.available ||
                modelSettings.serverIncompatible ||
                Boolean(modelSettings.problem && !retriesDraft) ||
                Boolean(busy || running)
              }
            >
              {busy === "Sending"
                ? "Sending…"
                : pendingQuestions
                  ? "Change direction"
                  : "Send"}
            </button>
          </div>
        </form>
      </section>

      <section
        id="planning-view-comments"
        role="tabpanel"
        aria-labelledby="planning-tab-comments"
        className="planning-tab-content"
        hidden={tab !== "comments"}
      >
        <div className="planning-comment-filters">
          <label>
            Show comments
            <select
              value={commentScope}
              onChange={(event) =>
                setCommentScope(event.target.value as "all" | "selected")
              }
            >
              <option value="all">All nodes</option>
              <option value="selected">Selected node</option>
            </select>
          </label>
          <label className="planning-check">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(event) => setShowResolved(event.target.checked)}
            />
            Include resolved
          </label>
        </div>
        <div className="planning-scroll">
          <ol className="planning-comments" aria-label="Node comments">
            {shownComments.map((comment) => {
              const located = session.content.diagrams
                .flatMap((item) =>
                  item.nodes.map((candidate) => ({
                    diagram: item,
                    node: candidate,
                  })),
                )
                .find((item) => item.node.id === comment.nodeId);
              return (
                <li
                  key={comment.id}
                  className={comment.resolved ? "is-resolved" : ""}
                >
                  {located ? (
                    <button
                      className="planning-context-link"
                      aria-label={`Show node ${located.node.title || "Untitled node"} in diagram ${located.diagram.name}`}
                      onClick={() => onReveal(comment.nodeId)}
                    >
                      {located.node.title || "Untitled node"}
                      <small>{located.diagram.name}</small>
                    </button>
                  ) : (
                    <div className="planning-missing-node">
                      <strong>{comment.nodeTitle || "Deleted node"}</strong>
                      <small>Node unavailable in this plan</small>
                    </div>
                  )}
                  <p className="planning-prose">{comment.text}</p>
                  <div className="planning-comment-meta">
                    <time dateTime={comment.createdAt}>
                      {time(comment.createdAt)}
                    </time>
                    <span>{comment.resolved ? "Resolved" : "Open"}</span>
                  </div>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void work("Updating comment", async () => {
                        await mutate(
                          `/comments/${comment.id}`,
                          { resolved: !comment.resolved },
                          "PATCH",
                        );
                        setAnnouncement(
                          comment.resolved
                            ? "Comment reopened."
                            : "Comment resolved.",
                        );
                        focusAfterAction("planning-tab-comments");
                      })
                    }
                  >
                    {comment.resolved ? "Reopen comment" : "Resolve comment"}
                  </button>
                </li>
              );
            })}
          </ol>
          {state && shownComments.length === 0 && (
            <p className="planning-empty">
              {commentScope === "selected" && !node
                ? "Select a node to see its comments."
                : "No open comments in this view."}
              {!showResolved &&
                state.comments.some((comment) => comment.resolved) &&
                " Include resolved comments to see earlier discussion."}
            </p>
          )}
        </div>
        {node ? (
          <form
            className="planning-composer"
            onSubmit={(event) => {
              event.preventDefault();
              const previous = failedComment.current;
              const target =
                previous &&
                previous.nodeId === node.id &&
                previous.diagramId === diagramId &&
                previous.text === commentDraft.trim()
                  ? previous
                  : {
                      nodeId: node.id,
                      diagramId,
                      text: commentDraft.trim(),
                      mutationId: uid(),
                    };
              if (!target.text) return;
              void work("Adding comment", async () => {
                await saved();
                failedComment.current = target;
                await mutate("/comments", target);
                failedComment.current = null;
                setCommentDrafts((current) => {
                  const draft = Object.hasOwn(current, target.nodeId)
                    ? current[target.nodeId]
                    : "";
                  return {
                    ...current,
                    [target.nodeId]: draft.trim() === target.text ? "" : draft,
                  };
                });
                setAnnouncement(
                  "Node comment added. Send a message when you want Codex to address it.",
                );
              });
            }}
          >
            <label htmlFor="planning-comment">
              Comment on: <span>{node.title || "Untitled node"}</span>
            </label>
            <textarea
              ref={commentComposer}
              id="planning-comment"
              rows={3}
              maxLength={12000}
              value={commentDraft}
              onChange={(event) =>
                setCommentDrafts((current) => ({
                  ...current,
                  [node.id]: event.target.value,
                }))
              }
              placeholder="A correction, question, or constraint…"
            />

            <div className="planning-compose-actions">
              <span>{commentDraft.length.toLocaleString()} / 12,000</span>
              <button
                className="primary"
                disabled={!commentDraft.trim() || Boolean(busy || !state)}
              >
                Add comment
              </button>
            </div>
          </form>
        ) : (
          <p className="planning-comment-hint">
            Select a node in the diagram to add a comment.
          </p>
        )}
      </section>

      <section
        id="planning-view-review"
        role="tabpanel"
        aria-labelledby="planning-tab-review"
        className="planning-tab-content"
        hidden={tab !== "review"}
      >
        <div className="planning-scroll">
          {state?.proposals.length === 0 && (
            <div className="planning-empty">
              <h3>No proposed changes yet</h3>
              <p>
                Ask Codex to create or improve the diagram. Proposed edits
                appear here before anything changes.
              </p>
              <button
                onClick={() => {
                  setTab("conversation");
                  if (active)
                    requestAnimationFrame(() => composer.current?.focus());
                }}
              >
                Write a message
              </button>
            </div>
          )}
          {state?.proposals
            .slice()
            .reverse()
            .map((proposal) => (
              <article
                key={proposal.id}
                className="planning-proposal"
                id={`proposal-${proposal.id}`}
                tabIndex={-1}
                aria-label={proposal.title}
              >
                <div className="planning-proposal-byline">
                  <span className={`planning-proposal-state ${proposal.state}`}>
                    {proposal.state === "pending"
                      ? "Needs review"
                      : proposal.state === "stale"
                        ? "Plan changed"
                        : proposal.state === "accepted"
                          ? "Accepted"
                          : "Rejected"}
                  </span>
                  <time dateTime={proposal.createdAt}>
                    {time(proposal.createdAt)}
                  </time>
                </div>
                <h3>{proposal.title}</h3>
                <p className="planning-prose">{proposal.summary}</p>
                <p className="planning-proposal-context">
                  {session.content.diagrams.find(
                    (item) => item.id === proposal.diagramId,
                  )?.name || "Diagram no longer available"}{" "}
                  · {proposal.changes.length} change
                  {proposal.changes.length === 1 ? "" : "s"}
                </p>
                {proposal.state === "stale" && (
                  <p className="planning-feedback">
                    This proposal was made for an earlier plan. Ask Codex for an
                    updated proposal to preserve your latest edits.
                  </p>
                )}
                {onPreview &&
                  (proposal.state === "pending" ||
                    proposal.state === "stale") && (
                    <button
                      className="primary"
                      onClick={() => onPreview(proposal.id)}
                    >
                      Review on canvas
                    </button>
                  )}
                <details
                  className="planning-change-details"
                  open={
                    !onPreview &&
                    (proposal.state === "pending" || proposal.state === "stale")
                  }
                >
                  <summary>
                    Review {proposal.changes.length} change
                    {proposal.changes.length === 1 ? "" : "s"}
                  </summary>
                  <ol>
                    {proposal.changes.map((change, index) => (
                      <Change
                        key={index}
                        change={change}
                        beforeNames={reviewNames(
                          session.content,
                          proposal,
                          "before",
                        )}
                        afterNames={reviewNames(
                          session.content,
                          proposal,
                          "after",
                        )}
                      />
                    ))}
                  </ol>
                </details>
                {proposal.state === "pending" && !onPreview && (
                  <div className="planning-proposal-actions">
                    <button
                      className="primary"
                      disabled={Boolean(busy || running)}
                      onClick={() =>
                        void work("Accepting changes", async () => {
                          try {
                            requestSequence.current++;
                            await onApply(
                              proposal.id,
                              stableMutationId(`accept:${proposal.id}`),
                            );
                            uncertainAcceptance.current = null;
                          } catch (err) {
                            // A confirmed conflict can refresh review state safely.
                            // An uncertain response must retain the acceptance receipt.
                            const confirmedConflict =
                              typeof err === "object" &&
                              err !== null &&
                              "status" in err &&
                              err.status === 409;
                            if (confirmedConflict) {
                              uncertainAcceptance.current = null;
                              await refresh(true);
                            } else {
                              uncertainAcceptance.current = proposal.id;
                            }
                            throw err;
                          }
                          mutationIds.current.delete(`accept:${proposal.id}`);
                          await refresh(true);
                          setAnnouncement(
                            "Proposed changes accepted. Review the diagram before approving the plan.",
                          );
                          focusAfterAction(`proposal-${proposal.id}`);
                        })
                      }
                    >
                      Accept changes
                    </button>
                    <button
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void work("Rejecting changes", async () => {
                          await mutate(`/proposals/${proposal.id}/reject`, {
                            mutationId: stableMutationId(
                              `reject:${proposal.id}`,
                            ),
                          });
                          setAnnouncement("Proposed changes rejected.");
                          focusAfterAction(`proposal-${proposal.id}`);
                        })
                      }
                    >
                      Reject changes
                    </button>
                  </div>
                )}
                {proposal.state === "stale" && !onPreview && (
                  <button
                    onClick={() => {
                      setTab("conversation");
                      setDraft((current) =>
                        current.trim()
                          ? current
                          : `Please update your proposal “${proposal.title}” to reflect the current plan and my comments.`,
                      );
                      if (active)
                        requestAnimationFrame(() => composer.current?.focus());
                    }}
                  >
                    Request updated proposal
                  </button>
                )}
              </article>
            ))}
        </div>
      </section>
      <span id="composer-resize-help" className="sr-only">
        Use arrow keys to resize, Shift for larger steps, and Home or End for
        limits.
      </span>
      {help && (
        <Dialog
          title={
            help === "sharing"
              ? "About planning chat"
              : help === "node"
                ? "Selected node"
                : help === "settings"
                  ? "Planning settings"
                  : "Plan status"
          }
          onClose={() => setHelp(null)}
        >
          {help === "settings" ? (
            <>
              <h3>Next request</h3>
              <p>{selectionLabel(modelSettings.selection)}</p>
              <p>
                {modelSettings.capabilities?.status === "ready"
                  ? "Choices come from your installed Codex CLI. A listed model may still be unavailable to your account."
                  : modelSettings.capabilities?.reason ||
                    "Loading the model list…"}
              </p>
              {modelSettings.capabilities?.status !== "ready" &&
                !modelSettings.serverIncompatible && (
                  <p>
                    CLI default still works. Refresh the list, or update Codex
                    CLI if discovery remains unavailable.
                  </p>
                )}
              {modelSettings.problem && (
                <p role="alert">{modelSettings.problem}</p>
              )}
              <button
                disabled={modelSettings.refreshing}
                onClick={() => void modelSettings.refresh()}
              >
                {modelSettings.refreshing ? "Refreshing…" : "Refresh models"}
              </button>
              <p>
                Selections affect your next request. Retry preserves its
                original settings and context.
              </p>
              {state?.request && (
                <details className="planning-request-details">
                  <summary>Latest request details</summary>
                  <dl>
                    <dt>Requested model</dt>
                    <dd>
                      {selectionLabel(
                        state.request.generation?.selection ??
                          state.request.selection,
                      )}
                    </dd>
                    {state.request.generation?.reportedModel && (
                      <>
                        <dt>Reported model</dt>
                        <dd>{state.request.generation.reportedModel}</dd>
                      </>
                    )}
                    <dt>Codex CLI</dt>
                    <dd>
                      {state.request.generation?.cliVersion || "Not recorded"}
                    </dd>
                    <dt>Instructions</dt>
                    <dd>
                      {state.request.generation?.instructionVersion ||
                        "Legacy request"}
                    </dd>
                    {state.request.generation?.instructionHash && (
                      <>
                        <dt>Instruction hash</dt>
                        <dd>{state.request.generation.instructionHash}</dd>
                      </>
                    )}
                    <dt>Response protocol</dt>
                    <dd>
                      {state.request.generation?.protocolVersion ?? "Legacy"}
                    </dd>
                  </dl>
                </details>
              )}
              <h3>Sharing and shortcuts</h3>
              <p>
                Send shares the manual plan, conversation, and node comments
                using your Codex CLI sign-in. Attached source files, detected
                evidence, and source permissions stay local.
              </p>
              <p>
                Edits require review. Approval does not run any steps. Ctrl / ⌘
                + Enter sends.
              </p>
            </>
          ) : help === "node" ? (
            <>
              <p className="planning-prose">{node?.title || "Untitled node"}</p>
              <p>{diagram?.name}</p>
              <button
                onClick={() => {
                  setHelp(null);
                  if (node) onReveal(node.id);
                }}
              >
                Show in diagram
              </button>
            </>
          ) : help === "sharing" ? (
            <>
              <p>
                Send shares the manual plan, conversation, and node comments
                with Codex using your CLI sign-in. Attached source files,
                detected evidence, and source permissions are not included.
              </p>
              <p>
                Proposed edits need your review. Approval records the saved
                plan; it does not execute steps.
              </p>
              <p>
                Use Ctrl / ⌘ + Enter to send. Your draft stays here when you
                switch views.
              </p>
            </>
          ) : (
            <>
              <p>
                {approvalCurrent
                  ? `Plan approved ${time(state!.approval!.createdAt)}.`
                  : state?.approval
                    ? "The plan has changed since approval."
                    : "This plan is a draft."}
              </p>
              <p>
                {approvalCurrent
                  ? "Execution has not started."
                  : approvalReason ||
                    "The saved plan is ready for your approval."}
              </p>
              <p>Approval records the saved plan. It does not run any steps.</p>
              {approvalReason && (
                <button
                  onClick={() => {
                    setHelp(null);
                    selectTab(
                      applicableQuestions
                        ? "conversation"
                        : pending.length
                          ? "review"
                          : unresolved.length
                            ? "comments"
                            : "conversation",
                    );
                  }}
                >
                  View{" "}
                  {pending.length
                    ? "changes"
                    : unresolved.length
                      ? "comments"
                      : "chat"}
                </button>
              )}
            </>
          )}
          <div className="dialog-actions">
            <button onClick={() => setHelp(null)}>Close</button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}
