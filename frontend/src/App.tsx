import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { readPreferences } from "./preferences";
import { readWorkspaceMemory, rememberedPlace, rememberWorkspace } from "./workspaceMemory";
import type { DraftGuard } from "./writingDrafts";
import CommandPalette from "./CommandPalette";
import type { CommandResult } from "./commandSearch";
import { useQuickJumpShortcut } from "./useQuickJumpShortcut";
import SettingsDialog from "./SettingsDialog";
import { presetLayout, readPersonalLayout, savePersonalLayout, boundLayout, type SavedLayout } from "./workspacePresets";
import type { ReactFlowInstance } from "@xyflow/react";
import { api, ApiError, bootstrap, download, post } from "./api";
import { ProjectProvider, useProject } from "./store";
import {
  copy,
  createNode,
  nodeKinds,
  statuses,
  uid,
  type Content,
  type BuildTask,
  type Diagram,
  type DetectedSymbol,
  type Envelope,
  type NodeKind,
  type ProjectSummary,
  type ProjectBrief,
  type Reconciliation,
  type Scan,
  type Source,
} from "./types";
import Canvas, { type FlowNode } from "./Canvas";
import Inspector from "./Inspector";
import TidyDiagram from "./TidyDiagram";
import BuildView from "./BuildView";
import { deletionNotice } from "./buildTasks";
import ProjectBriefDialog from "./ProjectBriefDialog";
import CodexConnection, { CodexConnectionDialog } from "./CodexConnection";
import type {
  DraftReference,
  DraftDetail,
  AcceptanceRequest,
} from "./durableDrafts";
import PlanningPanel from "./PlanningPanel";
import ProposalWorkspace, {
  type ProposalLeaveGuard,
} from "./ProposalWorkspace";
import {
  samePlan,
  type PlanningState,
  type ProposalDetail,
  type ProposalRevision,
} from "./planning";
import VariablePanel from "./VariablePanel";
import { Dialog, Empty, ErrorMessage, Field, StatusMark } from "./ui";
import { useLayout, ResizeHandle, clamp, focusAfterLayout } from "./layout";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  SetStateAction,
} from "react";

function preserveDisclosureKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
  // React Flow listens for Space on document; let native summaries activate first.
  if (
    event.key === " " &&
    event.target instanceof Element &&
    event.target.closest("summary")
  )
    event.stopPropagation();
}

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeSearch, setWelcomeSearch] = useState(false);
  const afterWelcomeSearch = useRef<(() => void) | null>(null);
  const pendingProjectFocus = useRef(false);
  const [transition, setTransition] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [loading, setLoading] = useState(true);
  useQuickJumpShortcut(() => setWelcomeSearch(true), !envelope && !loading);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    const result = await api<{ projects: ProjectSummary[] }>("/projects");
    setProjects(result.projects);
    return result.projects;
  };
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await bootstrap();
        const p = await api<{ projects: ProjectSummary[] }>("/projects");
        if (!alive) return;
        setProjects(p.projects);
        if (p.projects.length && readPreferences().startup === "resume") {
          const saved = readWorkspaceMemory().projectId;
          const id = p.projects.some(p => p.id === saved) ? saved : p.projects[0].id;
          const e = await api<Envelope>(`/projects/${id}`);
          if (alive) setEnvelope(e);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!envelope || transition || !pendingProjectFocus.current) return;
    pendingProjectFocus.current = false;
    const frame = requestAnimationFrame(() => focusAfterLayout(
      rememberedPlace(envelope.id, envelope.content).view === "build" ? "build-title" : "canvas-title",
    ));
    return () => cancelAnimationFrame(frame);
  }, [envelope, transition]);
  const open = async (id: string, command = false) => {
    setTransition(true);
    try {
      const next = await api<Envelope>(`/projects/${id}`);
      await refresh();
      pendingProjectFocus.current = command;
      setEnvelope(next);
    } catch (e) {
      if (command) throw e;
      setError((e as Error).message);
    } finally {
      setTransition(false);
    }
  };
  const create = async (body: unknown) => {
    setTransition(true);
    try {
      const result = await post<Envelope>("/projects", body);
      setEnvelope(result);
      await refresh();
      setCreating(false);
      setName("");
    } finally {
      setTransition(false);
    }
  };
  const importFile = async (file: File) => {
    setTransition(true);
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Choose a project JSON file smaller than 10 MB.");
      const body = JSON.parse(await file.text());
      const result = await post<Envelope>("/import", body);
      setEnvelope(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTransition(false);
    }
  };
  const newDialog = creating && (
    <Dialog title="New project" onClose={() => setCreating(false)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await create({ name: name.trim() });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field label="Project name">
          <input
            required
            autoFocus
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="What are you building?"
          />
        </Field>
        <div className="dialog-actions">
          <button type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
          <button className="primary" disabled={transition || !name.trim()}>
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importFile(file);
          e.target.value = "";
        }}
      />
      {loading ? (
        <div className="loading">
          <div className="brand">
            <Brand />
            PlanBranch
          </div>
          <p>Opening your workspace…</p>
        </div>
      ) : envelope ? (
        <ProjectProvider
          key={envelope.id + ":" + envelope.revision}
          envelope={envelope}
        >
          <div className="application-content" inert={transition}>
            <Workbench
              onSettings={() => setSettingsOpen(true)}
              projects={projects}
              onOpen={open}
              onNew={() => setCreating(true)}
              onExample={() => create({ sample: true })}
              onImport={() => fileRef.current?.click()}
              onCopy={(content) => create({ content })}
              onDeleted={async () => {
                setEnvelope(null);
                const list = await refresh();
                if (list.length) await open(list[0].id);
              }}
            />
          </div>
        </ProjectProvider>
      ) : (
        <div className="welcome">
          <header className="topbar">
            <div className="brand">
              <Brand />
              PlanBranch
            </div>
            <span className="local-label">LOCAL WORKSPACE</span>
            <button className="quiet" aria-label="Quick jump" title="Quick jump (Ctrl/Cmd+K)" onClick={() => setWelcomeSearch(true)}>Search</button>
            <button className="quiet" onClick={() => setSettingsOpen(true)}>Settings</button>
          </header>
          <main>
            <div className="welcome-kicker">VISUAL AI CODING PLANNER</div>
            <h1 id="canvas-title" tabIndex={-1}>
              {projects.length ? "Open a project" : "Create your first project"}
            </h1>
            <p>
              Describe a goal in chat, review the diagram, and refine the plan
              together.
            </p>
            <div className="welcome-actions">
              <button className="primary" onClick={() => setCreating(true)}>
                New project
              </button>
              <button
                onClick={() =>
                  void create({ sample: true }).catch((e) =>
                    setError(e.message),
                  )
                }
              >
                Load example
              </button>
              <button
                className="quiet"
                onClick={() => fileRef.current?.click()}
              >
                Import JSON
              </button>
            </div>
            {projects.length > 0 && <nav className="welcome-projects" aria-label="Projects">{projects.map(project => <button key={project.id} onClick={() => void open(project.id)}>{project.name}</button>)}</nav>}
            <CodexConnection />
            <div className="welcome-flow" aria-hidden="true">
              <span>Start</span>
              <i>→</i>
              <span>Plan a step</span>
              <i>→</i>
              <span className="welcome-decision">Decide</span>
            </div>
            <p className="welcome-footnote">
              Stored on your computer. Ready when you are.
            </p>
          </main>
        </div>
      )}
      {transition && (
        <div className="transition-shield" role="status">
          Opening project…
        </div>
      )}
      {welcomeSearch && <CommandPalette projects={projects} content={null} actions={[{ id: "settings", title: "Open settings" }, { id: "new-project", title: "New project" }]} onChoose={async (result) => {
        if (result.type === "project") {
          if (!projects.some(p => p.id === result.id)) throw Error("That project is no longer available.");
          await open(result.id, true);
        } else if (result.type === "action") afterWelcomeSearch.current = () => result.id === "settings" ? setSettingsOpen(true) : setCreating(true);
      }} onClose={() => { setWelcomeSearch(false); const action = afterWelcomeSearch.current; afterWelcomeSearch.current = null; if (action) requestAnimationFrame(action); }} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {newDialog}
      {error && (
        <Dialog title="Something needs attention" onClose={() => setError("")}>
          <ErrorMessage message={error} />
          <div className="dialog-actions">
            <button onClick={() => setError("")}>Close</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function Brand() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      fill="none"
      aria-hidden="true"
    >
      <rect width="26" height="26" rx="7" fill="currentColor" />
      <path
        d="M8 18V8m0 5h5a5 5 0 0 0 5-5"
        stroke="#f5f8f4"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="8" cy="7" r="2" fill="#f5f8f4" />
      <circle cx="8" cy="19" r="2" fill="#f5f8f4" />
      <circle cx="18" cy="7" r="2" fill="#f5f8f4" />
    </svg>
  );
}
function Workbench({
  onSettings,
  projects,
  onOpen,
  onNew,
  onExample,
  onImport,
  onCopy,
  onDeleted,
}: {
  onSettings: () => void;
  projects: ProjectSummary[];
  onOpen: (id: string, command?: boolean) => Promise<void>;
  onNew: () => void;
  onExample: () => Promise<void>;
  onImport: () => void;
  onCopy: (c: Content) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const {
    session,
    change,
    commit,
    undo,
    redo,
    flush,
    synchronize,
    getSnapshot,
    saveStatus,
    saveError,
  } = useProject();
  const content = session.content;
  const [active, setActive] = useState(() => rememberedPlace(session.id, content).diagramId);
  const [briefOpen, setBriefOpen] = useState(false);
  const [quickJump, setQuickJump] = useState(false);
  const afterQuickJump = useRef<(() => void) | null>(null);
  const performing = useRef(false);
  useQuickJumpShortcut(() => setQuickJump(true));
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"diagram" | "build">(
    () => rememberedPlace(session.id, content).view,
  );
  const [selectedBuildTask, setSelectedBuildTask] = useState<string | null>(
    () => rememberedPlace(session.id, content).taskId,
  );
  useEffect(() => { rememberWorkspace(session.id, { diagramId: active, view: workspaceView, taskId: selectedBuildTask }); }, [session.id, active, workspaceView, selectedBuildTask]);
  const [returnToBuild, setReturnToBuild] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tidy, setTidy] = useState<{
    diagram: Diagram;
    selectedIds: string[];
  } | null>(null);
  const { layout, preference, applyLayout, reset, windowSize } = useLayout();
  const [personalLayout, setPersonalLayout] = useState(readPersonalLayout);
  const stacked = windowSize.width <= 900 || windowSize.height <= 650;
  const [narrowNavigationOpen, setNarrowNavigationOpen] = useState(false);
  const navigation = stacked ? narrowNavigationOpen : layout.navigationOpen;
  useEffect(() => {
    if (stacked) setNarrowNavigationOpen(false);
  }, [stacked]);
  const inspector = layout.inspectorOpen;
  const variables = layout.catalogueOpen;
  const planning = layout.sidePanel === "planning";
  const [planningVisited, setPlanningVisited] = useState(planning);
  const [commentFocus, setCommentFocus] = useState(0);
  const [proposalPreview, setProposalPreview] = useState<ProposalDetail | null>(
    null,
  );
  const [planningSnapshot, setPlanningSnapshot] =
    useState<PlanningState | null>(null);
  const [proposalRevision, setProposalRevision] =
    useState<ProposalRevision | null>(null);
  const [planningRefresh, setPlanningRefresh] = useState(0);
  const [uncertainApply, setUncertainApply] = useState<{
    proposalId: string;
    mutationId: string;
    candidate?: Diagram;
    draft?: DraftReference;
    contentHash: string;
  } | null>(null);
  const proposalPreviewRef = useRef(proposalPreview);
  proposalPreviewRef.current = proposalPreview;
  const proposalLeaveGuard = useRef<ProposalLeaveGuard | null>(null);
  const writingLeaveGuard = useRef<DraftGuard | null>(null);
  const registerWritingLeaveGuard = useCallback((guard: DraftGuard | null) => { writingLeaveGuard.current = guard; }, []);
  const registerProposalLeaveGuard = useCallback(
    (guard: ProposalLeaveGuard | null) => {
      proposalLeaveGuard.current = guard;
    },
    [],
  );
  const previewSequence = useRef(0);
  const seenProposals = useRef(new Set<string>());
  const previewMutation = useRef<{ key: string; id: string } | null>(null);
  const [focusPane, setFocusPane] = useState<"canvas" | "dock">(
    layout.inspectorOpen && planning ? "dock" : "canvas",
  );
  const setInspector = (value: SetStateAction<boolean>) =>
    preference("inspectorOpen", value);
  const setVariables = (value: SetStateAction<boolean>) =>
    preference("catalogueOpen", value);
  const [variableFocus, setVariableFocus] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [connecting, setConnecting] = useState(false);
  const [diagramDialog, setDiagramDialog] = useState<"new" | "rename" | null>(
    null,
  );
  const [diagramName, setDiagramName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<Source>({
    root: null,
    ignores: [],
    attached: false,
  });
  const [symbols, setSymbols] = useState<DetectedSymbol[]>([]);
  const [reconciliation, setReconciliation] = useState<Reconciliation>({
    suggestions: [],
    reviews: [],
  });
  const [scanDialog, setScanDialog] = useState(false);
  const [scan, setScan] = useState<Scan | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [ignoreText, setIgnoreText] = useState("");
  const [allowRead, setAllowRead] = useState(false);
  const sourceInputGeneration = useRef(0);
  const [scanError, setScanError] = useState("");
  const instance = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [panelLimit, setPanelLimit] = useState(340);
  const dockMin = planning ? 300 : 280;
  const inspectorMax = Math.max(
    dockMin,
    Math.min(
      planning ? 680 : 520,
      windowSize.width - (layout.navigationOpen ? 224 : 0) - 360,
    ),
  );
  const catalogueMin = Math.min(230, Math.max(100, panelLimit));
  const catalogueMax = Math.max(catalogueMin, Math.min(600, panelLimit));
  const inspectorWidth = clamp(
    planning ? layout.chatWidth : layout.inspectorWidth,
    dockMin,
    inspectorMax,
  );
  const catalogueHeight = clamp(
    layout.catalogueHeight,
    catalogueMin,
    catalogueMax,
  );
  const closeCatalogue = () => {
    setVariables(false);
    focusAfterLayout("open-catalogue");
  };
  const closeInspector = () => {
    setInspector(false);
    setFocusPane("canvas");
    focusAfterLayout(planning ? "toggle-planning" : "toggle-inspector");
  };
  const openPlanning = (comments = false) => {
    setPlanningVisited(true);
    setNarrowNavigationOpen(false);
    setFocusPane("dock");
    preference("sidePanel", "planning");
    setInspector(true);
    if (comments) setCommentFocus((value) => value + 1);
  };
  const acceptProposal = async (
    proposalId: string,
    mutationId: string,
    candidate?: Diagram,
    contentHash?: string,
    draft?: DraftReference,
  ) => {
    await synchronize(async (snapshot) => {
      const base = `/projects/${snapshot.id}/planning/proposals/${proposalId}`;
      let request: AcceptanceRequest | Record<string, unknown> = {
        baseRevision: snapshot.revision,
        mutationId,
        ...(candidate ? { diagram: candidate } : {}),
        ...(contentHash ? { contentHash } : {}),
      };
      if (draft) {
        const { draft: saved } = await api<{ draft: DraftDetail }>(
          `${base}/drafts/${draft.draftId}`,
        );
        // A prior Apply may have committed or stopped after preparing its intent.
        // Only this explicit user action replays that frozen receipt.
        if (saved.applyRequest) request = saved.applyRequest;
        else {
          const prepared = await post<{ applyRequest: AcceptanceRequest }>(
            `${base}/drafts/${draft.draftId}/prepare-apply`,
            {
              baseDraftRevision: draft.draftRevision,
              baseRevision: snapshot.revision,
              mutationId,
            },
          );
          request = prepared.applyRequest;
        }
      }
      const result = await post<{ project: Envelope }>(
        `${base}/accept`,
        request,
      );
      return result.project;
    });
  };
  const previewProposal = useCallback(
    async (proposalId: string) => {
      const ticket = ++previewSequence.current;
      // Selecting the open proposal only focuses it; never reset its draft or receipt.
      if (proposalPreviewRef.current?.proposal.id === proposalId) {
        setFocusPane("canvas");
        return;
      }
      try {
        const detail = await api<ProposalDetail>(
          `/projects/${session.id}/planning/proposals/${proposalId}`,
        );
        if (ticket !== previewSequence.current) return;
        // Fetches can finish after a manual edit or while Apply is in flight.
        // Consult the current workspace immediately before replacing it.
        if (
          proposalPreviewRef.current &&
          proposalLeaveGuard.current &&
          !(await proposalLeaveGuard.current())
        )
          return;
        if (ticket !== previewSequence.current) return;
        setProposalPreview(detail);
        setFocusPane("canvas");
        setNarrowNavigationOpen(false);
        previewMutation.current = null;
      } catch (err) {
        if (ticket === previewSequence.current)
          setError((err as Error).message);
      }
    },
    [session.id],
  );
  useEffect(() => {
    const latest = planningSnapshot?.proposals
      .slice()
      .reverse()
      .find((p) => p.state === "pending");
    const unseen = latest && !seenProposals.current.has(latest.id);
    planningSnapshot?.proposals.forEach((p) => seenProposals.current.add(p.id));
    if (latest && unseen) {
      void previewProposal(latest.id);
    }
  }, [planningSnapshot, previewProposal]);
  const closeProposal = () => {
    ++previewSequence.current;
    setProposalPreview(null);
    setFocusPane("canvas");
  };
  const currentProposal =
    proposalPreview &&
    planningSnapshot?.proposals.find(
      (p) => p.id === proposalPreview.proposal.id,
    );
  const proposalStale = Boolean(
    proposalPreview &&
    ((currentProposal ?? proposalPreview.proposal).state !== "pending" ||
      (proposalPreview.baseContent &&
        !samePlan(proposalPreview.baseContent, session.content))),
  );
  const applyPreview = async (candidate?: Diagram, draft?: DraftReference) => {
    if (!proposalPreview) return;
    const key = JSON.stringify({
      id: proposalPreview.proposal.id,
      candidate,
      draft,
      contentHash: proposalPreview.contentHash,
    });
    if (previewMutation.current?.key !== key)
      previewMutation.current = { key, id: uid() };
    // A lost response may already have committed. Replay that exact receipt,
    // even if refreshing chat now reports the proposal as accepted.
    const receipt =
      uncertainApply?.proposalId === proposalPreview.proposal.id
        ? uncertainApply
        : {
            proposalId: proposalPreview.proposal.id,
            mutationId: previewMutation.current.id,
            candidate: candidate ? copy(candidate) : undefined,
            draft,
            contentHash: proposalPreview.contentHash,
          };
    try {
      await acceptProposal(
        receipt.proposalId,
        receipt.mutationId,
        receipt.candidate,
        receipt.contentHash,
        receipt.draft,
      );
    } catch (err) {
      setUncertainApply(
        err instanceof ApiError && err.status >= 400 && err.status < 500
          ? null
          : receipt,
      );
      throw err;
    }
    setUncertainApply(null);
    setActive(proposalPreview.proposal.diagramId);
    if (
      proposalPreview.proposal.editableSections?.includes("buildTasks") &&
      !proposalPreview.proposal.editableSections.includes("diagram")
    )
      setWorkspaceView("build");
    setSelected(null);
    previewMutation.current = null;
    closeProposal();
    setPlanningRefresh((v) => v + 1);
    setNotice("Changes applied. Undo restores the previous plan.");
  };
  const discardPreview = async () => {
    if (!proposalPreview) return;
    const key = `discard:${proposalPreview.proposal.id}`;
    if (previewMutation.current?.key !== key)
      previewMutation.current = { key, id: uid() };
    await post(
      `/projects/${session.id}/planning/proposals/${proposalPreview.proposal.id}/reject`,
      { mutationId: previewMutation.current.id },
    );
    closeProposal();
    setPlanningRefresh((v) => v + 1);
  };
  const revisePreview = (
    candidate: Diagram,
    brief?: ProjectBrief,
    buildTasks?: BuildTask[],
  ) => {
    if (!proposalPreview) return;
    setProposalRevision({
      proposalId: proposalPreview.proposal.id,
      title: proposalPreview.proposal.title,
      diagram: candidate,
      editableSections: proposalPreview.proposal.editableSections ?? [
        "diagram",
      ],
      ...(brief ? { brief: copy(brief) } : {}),
      ...(buildTasks !== undefined ? { buildTasks: copy(buildTasks) } : {}),
      nonce: uid(),
    });
    openPlanning();
  };
  const openSource = () => {
    setScanDialog(true);
    void refreshEvidence(true);
  };
  const diagram =
    content.diagrams.find((d) => d.id === active) ?? content.diagrams[0];
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const measure = () => {
      const chrome = Array.from(main.children).filter(
        (element) =>
          !element.matches(".editor-row,.catalogue-pane,.drawer-toggle"),
      );
      const used = chrome.reduce(
        (height, element) => height + element.getBoundingClientRect().height,
        0,
      );
      setPanelLimit(
        Math.floor(main.clientHeight - used - (stacked ? 140 : 220)),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    Array.from(main.children).forEach((element) => {
      if (!element.matches(".editor-row,.catalogue-pane,.drawer-toggle"))
        observer.observe(element);
    });
    return () => observer.disconnect();
  }, [
    stacked,
    layout.navigationOpen,
    diagram.name,
    saveStatus,
    saveError,
    error,
    notice,
    scan?.status,
  ]);
  useEffect(() => {
    if (!content.diagrams.some((d) => d.id === active))
      setActive(content.diagrams[0]?.id ?? "");
  }, [content.diagrams, active]);
  const evidenceRequest = useRef(0);
  const reconciliationRequest = useRef(0);
  const refreshEvidence = useCallback(
    async (syncSourceInputs = false) => {
      const request = ++evidenceRequest.current;
      const comparison = ++reconciliationRequest.current;
      const inputGeneration = sourceInputGeneration.current;
      try {
        const [s, v, r] = await Promise.all([
          api<Source>(`/projects/${session.id}/source`),
          api<{ symbols: DetectedSymbol[] }>(`/projects/${session.id}/symbols`),
          api<Reconciliation>(`/projects/${session.id}/reconciliation`),
        ]);
        if (request !== evidenceRequest.current) return;
        setSource(s);
        if (s.latestScan) setScan(s.latestScan);
        setSymbols(v.symbols);
        if (comparison === reconciliationRequest.current) setReconciliation(r);
        if (
          syncSourceInputs &&
          inputGeneration === sourceInputGeneration.current
        ) {
          setSourcePath(s.root ?? "");
          setIgnoreText(s.ignores.join("\n"));
        }
      } catch (e) {
        setScanError((e as Error).message);
      }
    },
    [session.id],
  );
  useEffect(() => {
    void refreshEvidence(true);
    return () => {
      evidenceRequest.current += 1;
      reconciliationRequest.current += 1;
    };
  }, [refreshEvidence]);
  useEffect(() => {
    const request = ++reconciliationRequest.current;
    let active = true;
    void api<Reconciliation>(`/projects/${session.id}/reconciliation`)
      .then((result) => {
        if (active && request === reconciliationRequest.current)
          setReconciliation(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session.id, session.revision]);
  const scanRunning =
    !!scan &&
    ["queued", "running", "scanning", "pending", "cancelling"].includes(
      scan.status,
    );
  useEffect(() => {
    if (!scanRunning || !scan) return;
    let stop = false;
    const timer = setTimeout(async () => {
      try {
        const next = await api<Scan>(
          `/projects/${session.id}/scans/${scan.id}`,
        );
        if (stop) return;
        setScan(next);
        if (
          !["queued", "running", "scanning", "pending", "cancelling"].includes(
            next.status,
          )
        )
          await refreshEvidence();
      } catch (e) {
        if (!stop) {
          setScanError((e as Error).message);
          setScan({ ...scan, status: "failed" });
        }
      }
    }, 800);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [scan, scanRunning, session.id, refreshEvidence]);
  async function flushForNavigation(savePlan = true) {
    // Either editor can change while the other queue is saving. Drain both
    // again before leaving, instead of trusting an earlier acknowledgement.
    while (true) {
      if (savePlan && !(await flush())) throw Error("The plan has not saved. Retry its save or resolve the conflict before navigating.");
      if (writingLeaveGuard.current && !(await writingLeaveGuard.current.flush()))
        throw Error("Your writing has not saved. Open Chat to retry or recover the draft before leaving.");
      const latest = getSnapshot();
      if ((!savePlan || latest.generation === latest.savedGeneration) && !writingLeaveGuard.current?.pending()) return;
    }
  }
  const perform = async (action: () => void | Promise<void>, save = true) => {
    if (performing.current) return;
    performing.current = true;
    setError("");
    try {
      if (save) await flushForNavigation();
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      performing.current = false;
    }
  };
  const historyIndex = session.history.findIndex(
    (h) => h.id === session.cursor,
  );
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      document
        .querySelectorAll<HTMLDetailsElement>("details[data-popup][open]")
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const historyMove = (direction: "undo" | "redo") => {
    commit();
    const step =
      direction === "undo"
        ? session.history[historyIndex]
        : session.history[historyIndex + 1];
    if (direction === "undo") undo();
    else redo();
    if (step?.diagramId) setActive(step.diagramId);
    setSelected(null);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (proposalPreview) return;
      const target = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flush();
        return;
      }
      if (target.closest('input,textarea,select,[contenteditable="true"]'))
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        historyMove(e.shiftKey ? "redo" : "undo");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        historyMove("redo");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const addNode = (kind: NodeKind) => {
    if (proposalPreview) return;
    if (!diagram) return;
    setWorkspaceView("diagram");
    const canvas = canvasRef.current?.getBoundingClientRect();
    const center = instance.current?.screenToFlowPosition({
      x: canvas ? canvas.x + canvas.width / 2 : window.innerWidth / 2,
      y: canvas ? canvas.y + canvas.height / 2 : window.innerHeight / 2,
    }) ?? { x: 210, y: 156 };
    const n = createNode(kind, {
      x: Math.round((center.x - 110) / 10) * 10,
      y: Math.round((center.y - (kind === "decision" ? 71 : 56)) / 10) * 10,
    });
    change(
      (c) => {
        c.diagrams.find((d) => d.id === diagram.id)!.nodes.push(n);
      },
      `Add ${nodeKinds[kind]}`,
      diagram.id,
    );
    setSelected(n.id);
    setInspector(true);
  };
  const select = (id: string | null) => {
    commit();
    setSelected(id);
    if (id) setInspector(true);
  };
  const reveal = (nodeId: string) => {
    const d = content.diagrams.find((d) =>
      d.nodes.some((n) => n.id === nodeId),
    );
    if (d) {
      commit();
      setWorkspaceView("diagram");
      setActive(d.id);
      setSelected(nodeId);
      if (stacked) {
        setFocusPane("canvas");
        focusAfterLayout("canvas-title");
      }
      setInspector(true);
      setTimeout(
        () =>
          void instance.current?.fitView({
            nodes: [{ id: nodeId }],
            maxZoom: 1.2,
            padding: 0.5,
            duration: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? 0
              : 180,
          }),
        100,
      );
    }
  };
  const chooseLayout = (saved: SavedLayout) => {
    applyLayout(boundLayout(saved.layout));
    if (saved.layout.sidePanel === "planning") setPlanningVisited(true);
    setWorkspaceView(saved.view);
    setNarrowNavigationOpen(false);
    setFocusPane("canvas");
    if (proposalPreviewRef.current) setNotice("Layout updated; your proposal review stays open.");
  };
  const chooseCommand = async (result: CommandResult) => {
    if (performing.current) throw Error("A workspace action is finishing. Try again when it completes.");
    if (result.type === "action" && result.id === "settings") {
      afterQuickJump.current = onSettings;
      return;
    }
    if (proposalPreviewRef.current && proposalLeaveGuard.current && !(await proposalLeaveGuard.current()))
      throw Error("The proposal draft has not saved. Resolve its save before navigating.");
    await flushForNavigation();
    if (result.type === "project") {
      if (!projects.some(p => p.id === result.id)) throw Error("That project is no longer available.");
      if (result.id !== session.id) await onOpen(result.id, true);
      else afterQuickJump.current = () => focusAfterLayout(workspaceView === "build" ? "build-title" : "canvas-title");
      return;
    }
    if (result.type === "action") {
      if (result.id === "save") return;
      if (result.id === "new-project") { afterQuickJump.current = onNew; return; }
      if (proposalPreviewRef.current) closeProposal();
      if (result.id === "brief") afterQuickJump.current = () => setBriefOpen(true);
      if (result.id === "tidy") {
        if (!diagram?.nodes.length) throw Error("Add nodes before arranging this diagram.");
        afterQuickJump.current = () => setTidy({ diagram: copy(diagram), selectedIds: instance.current?.getNodes().filter(n => n.selected).map(n => n.id) ?? [] });
      }
      return;
    }
    if (result.type === "node" || result.type === "diagram") {
      const target = content.diagrams.find(d => d.id === result.diagramId);
      if (!target || (result.type === "node" && !target.nodes.some(n => n.id === result.id)))
        throw Error("That diagram item is no longer available. Search again.");
      if (proposalPreviewRef.current) closeProposal();
      setFilter("all");
      setWorkspaceView("diagram"); setActive(target.id); setFocusPane("canvas"); setNarrowNavigationOpen(false);
      if (result.type === "node") reveal(result.id);
      else setSelected(null);
      afterQuickJump.current = () => focusAfterLayout("canvas-title");
    } else if (result.type === "task") {
      if (!content.buildTasks?.some(t => t.id === result.id)) throw Error("That Build task is no longer available.");
      if (proposalPreviewRef.current) closeProposal();
      setWorkspaceView("build"); setSelectedBuildTask(result.id); setFocusPane("canvas"); setNarrowNavigationOpen(false);
      afterQuickJump.current = () => focusAfterLayout("build-title");
    } else if (result.type === "variable") {
      const exists = result.detected ? symbols.some(v => v.id === result.id) : content.variables.some(v => v.id === result.id);
      if (!exists) throw Error("That variable is no longer available. Search again.");
      if (proposalPreviewRef.current) closeProposal();
      setWorkspaceView("diagram"); setVariableFocus(result.id); setVariables(true); setFocusPane("canvas"); setNarrowNavigationOpen(false);
      afterQuickJump.current = () => focusAfterLayout("variable-catalogue");
    }
  };
  const taskNodes = diagram?.nodes.filter((n) => n.type !== "note") ?? [];
  const counts = Object.fromEntries(
    Object.keys(statuses).map((s) => [
      s,
      taskNodes.filter((n) => n.status === s).length,
    ]),
  );
  const saved = session.generation === session.savedGeneration;
  const statusText =
    saveStatus === "conflict"
      ? "Save conflict"
      : saveStatus === "failed"
        ? "Save failed"
        : saveStatus === "saving"
          ? "Saving…"
          : saved
            ? "Saved"
            : "Unsaved changes";
  const exportFile = async (kind: "json" | "markdown" | "png") => {
    setBusy(true);
    await perform(async () => {
      if (kind === "png") {
        const { exportPng } = await import("./png");
        await exportPng(diagram);
      } else
        await download(
          `/projects/${session.id}/export/${kind}`,
          `${content.name.replace(/[^a-z0-9_-]+/gi, "-")}.${kind === "json" ? "json" : "md"}`,
        );
    });
    setBusy(false);
  };
  return (
    <div
      className={`workspace ${navigation && !proposalPreview ? "" : "navigation-closed"} ${inspector ? "" : "inspector-closed"} ${stacked ? "compact-workspace" : ""} ${focusPane === "dock" && inspector ? "focus-dock" : "focus-canvas"}`}
      onKeyDown={preserveDisclosureKeys}
      onKeyUp={preserveDisclosureKeys}
      style={
        {
          "--inspector-width": `${inspectorWidth}px`,
          "--catalogue-height": `${catalogueHeight}px`,
        } as CSSProperties
      }
    >
      <span className="sr-only" id="resize-help">
        Use arrow keys to resize, Shift for larger steps, Home or End for
        limits, and Enter to collapse. Use the panel button to reopen.
      </span>
      <header className="topbar">
        <button
          id="toggle-navigation"
          disabled={Boolean(proposalPreview)}
          className="icon-button navigation-toggle"
          aria-label="Toggle navigation"
          title="Projects and diagrams"
          aria-expanded={navigation}
          aria-controls="workspace-navigation"
          onClick={() =>
            stacked
              ? setNarrowNavigationOpen((value) => !value)
              : preference("navigationOpen", (value) => !value)
          }
        >
          ☰
        </button>
        <div className="brand">
          <Brand />
          PlanBranch
        </div>
        <div className="breadcrumb" aria-label="Current project and diagram">
          <button
            className="quiet"
            disabled={Boolean(proposalPreview)}
            onClick={() => {
              select(null);
              preference("sidePanel", "inspector");
              setFocusPane("dock");
              setInspector(true);
            }}
            aria-label={`Project details: ${content.name}`}
          >
            {content.name}
          </button>
          <span>/</span>
          <span>{diagram?.name}</span>
        </div>
        <button
          className="quiet project-brief-toggle"
          aria-label="Project brief"
          disabled={Boolean(proposalPreview)}
          onClick={() => {
            commit();
            setBriefOpen(true);
          }}
        >
          Brief
        </button>
        <div
          className={`save-state ${saveStatus}`}
          data-testid="save-state"
          role="status"
          title={
            session.savedAt
              ? `Last saved ${new Date(session.savedAt).toLocaleString()}`
              : ""
          }
        >
          <span className={saved ? "saved-dot" : "dirty-dot"} />
          <span>
            {statusText}
            <small>
              {session.savedAt
                ? `Last saved ${new Date(session.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "No saved changes yet"}
            </small>
          </span>
        </div>
        <div className="history-buttons">
          <button
            className="icon-button"
            disabled={
              Boolean(proposalPreview) ||
              (!session.pending &&
                historyIndex <= Math.max(0, session.history.length - 101))
            }
            title={`Undo ${session.pending?.label ?? session.history[historyIndex]?.label ?? ""}`}
            aria-label="Undo"
            onClick={() => historyMove("undo")}
          >
            ↶
          </button>
          <button
            className="icon-button"
            disabled={
              Boolean(proposalPreview) ||
              !!session.pending ||
              historyIndex === session.history.length - 1
            }
            title={`Redo ${session.history[historyIndex + 1]?.label ?? ""}`}
            aria-label="Redo"
            onClick={() => historyMove("redo")}
          >
            ↷
          </button>
        </div>
        <button
          className="quiet"
          disabled={Boolean(proposalPreview)}
          onClick={() => void flush()}
        >
          Save
        </button>
        <button onClick={openSource}>
          {scanRunning ? "Scanning…" : "Scan Python"}
        </button>
        <details
          className="export-menu popup-menu"
          data-popup
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              event.currentTarget.open = false;
          }}
        >
          <summary className="button">
            {busy ? "Exporting…" : "Export ↓"}
          </summary>
          <div
            className="menu-popover"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button")) {
                const menu = event.currentTarget.closest("details");
                if (menu) {
                  menu.open = false;
                  menu.querySelector("summary")?.focus();
                }
              }
            }}
          >
            <button disabled={busy} onClick={() => void exportFile("json")}>
              Project JSON
            </button>
            <button
              disabled={busy || !diagram}
              onClick={() => void exportFile("png")}
            >
              Full diagram PNG
            </button>
            <button disabled={busy} onClick={() => void exportFile("markdown")}>
              Implementation brief
            </button>
            <button
              onClick={() =>
                void perform(async () => {
                  const result = await post<{ filename: string }>("/backup");
                  setNotice(`Backup saved: ${result.filename}`);
                })
              }
            >
              Back up database
            </button>
          </div>
        </details>
        <div
          className="workspace-focus"
          role="group"
          aria-label="Workspace views"
        >
          <button
            className="quiet canvas-focus-toggle"
            aria-pressed={focusPane === "canvas"}
            onClick={() => {
              setFocusPane("canvas");
              setNarrowNavigationOpen(false);
              focusAfterLayout(
                workspaceView === "build" ? "build-title" : "canvas-title",
              );
            }}
          >
            {workspaceView === "build" ? "Build view" : "Canvas"}
          </button>
          <button
            id="toggle-inspector"
            className={
              inspector && !planning && (!stacked || focusPane === "dock")
                ? "quiet active"
                : "quiet"
            }
            aria-label="Toggle inspector"
            aria-expanded={
              inspector && !planning && (!stacked || focusPane === "dock")
            }
            aria-controls="inspector-pane"
            onClick={() => {
              if (inspector && !planning && (!stacked || focusPane === "dock"))
                closeInspector();
              else {
                setWorkspaceView("diagram");
                preference("sidePanel", "inspector");
                setNarrowNavigationOpen(false);
                setFocusPane("dock");
                focusAfterLayout("inspector-pane");
                setInspector(true);
              }
            }}
          >
            Inspector
          </button>
          <button
            id="toggle-planning"
            className={
              inspector && planning && (!stacked || focusPane === "dock")
                ? "quiet active"
                : "quiet"
            }
            aria-label="Toggle planning chat"
            aria-expanded={
              inspector && planning && (!stacked || focusPane === "dock")
            }
            aria-controls="planning-pane"
            onClick={() =>
              inspector && planning && (!stacked || focusPane === "dock")
                ? closeInspector()
                : openPlanning()
            }
          >
            Chat
          </button>
        </div>
        <button className="quiet" aria-label="Quick jump" title="Quick jump (Ctrl/Cmd+K)" onClick={() => setQuickJump(true)}>Search</button>
        <button className="quiet" onClick={onSettings}>Settings</button>
        <details
          className="layout-menu popup-menu"
          data-popup
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              event.currentTarget.open = false;
          }}
        >
          <summary className="button">Layout</summary>
          <div className="menu-popover">
            <p>Panel sizes stay in this browser.</p>
            {(["planning", "review", "build"] as const).map((name) => <button key={name} onClick={(event) => {
              chooseLayout(presetLayout(name));
              const menu = event.currentTarget.closest("details");
              if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
            }}>{name[0].toUpperCase() + name.slice(1)} layout</button>)}
            <button onClick={(event) => {
              const saved = { layout, view: workspaceView };
              if (savePersonalLayout(saved)) { setPersonalLayout(saved); setNotice("Personal layout saved in this browser."); }
              else setError("Browser storage is unavailable. Your layout could not be saved.");
              const menu = event.currentTarget.closest("details");
              if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
            }}>Save personal layout</button>
            <button disabled={!personalLayout} onClick={(event) => {
              if (personalLayout) chooseLayout(personalLayout);
              const menu = event.currentTarget.closest("details");
              if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
            }}>Personal layout</button>
            <button
              onClick={(event) => {
                reset();
                setNarrowNavigationOpen(false);
                setFocusPane("canvas");
                const menu = event.currentTarget.closest("details");
                if (menu) {
                  menu.open = false;
                  menu.querySelector("summary")?.focus();
                }
              }}
            >
              Restore default layout
            </button>
            <button
              onClick={(event) => {
                const menu = event.currentTarget.closest("details");
                if (menu) {
                  menu.open = false;
                  menu.querySelector("summary")?.focus();
                }
                setConnectionOpen(true);
              }}
            >
              Codex connection
            </button>
          </div>
        </details>
      </header>
      {navigation && !proposalPreview && (
        <aside
          className="sidebar"
          id="workspace-navigation"
          aria-label="Workspace navigation"
        >
          <div className="sidebar-heading">
            PROJECTS
            <button
              className="icon-button"
              aria-label="New project"
              title="New project"
              onClick={() => void perform(onNew)}
            >
              +
            </button>
          </div>
          <nav className="project-list" aria-label="Projects">
            {projects.map((p) => (
              <button
                key={p.id}
                className={p.id === session.id ? "active" : ""}
                onClick={() => {
                  if (p.id !== session.id) void perform(() => onOpen(p.id));
                }}
              >
                <span className="project-icon">▤</span>
                <span>{p.id === session.id ? content.name : p.name}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-heading diagram-heading">
            DIAGRAMS
            <button
              className="icon-button"
              aria-label="New diagram"
              onClick={() => {
                setDiagramDialog("new");
                setDiagramName("");
              }}
            >
              +
            </button>
          </div>
          <nav className="diagram-list" aria-label="Diagrams">
            {content.diagrams.map((d, i) => (
              <button
                key={d.id}
                className={d.id === diagram?.id ? "active" : ""}
                onClick={() => {
                  commit();
                  setWorkspaceView("diagram");
                  setActive(d.id);
                  setSelected(null);
                }}
              >
                <span className="diagram-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{d.name}</span>
              </button>
            ))}
          </nav>
          <div className="palette">
            <div className="sidebar-heading">ADD A NODE</div>
            {(Object.entries(nodeKinds) as [NodeKind, string][]).map(
              ([kind, label]) => (
                <button
                  key={kind}
                  aria-label={`Add ${label}`}
                  onClick={() => addNode(kind)}
                >
                  <span className={`palette-icon palette-${kind}`}>
                    {kind === "decision"
                      ? "◇"
                      : kind === "note"
                        ? "≡"
                        : kind === "io"
                          ? "▱"
                          : kind === "start" || kind === "end"
                            ? "◯"
                            : "▭"}
                  </span>
                  {label}
                  <span className="palette-plus">+</span>
                </button>
              ),
            )}
            <p>Drag between handles to connect steps.</p>
          </div>
          <div className="sidebar-bottom">
            <button className="quiet" onClick={() => void perform(onImport)}>
              ↥ Import JSON
            </button>
            <button className="quiet" onClick={() => void perform(onExample)}>
              ◇ Load example
            </button>
            <details className="project-options">
              <summary>Project options</summary>
              <button
                className="danger quiet"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete project “${content.name}”? Its attached source files will stay in place.`,
                    )
                  )
                    void perform(async () => {
                      await api(`/projects/${session.id}`, {
                        method: "DELETE",
                        body: JSON.stringify({
                          revision: session.revision,
                          confirmed: true,
                        }),
                      });
                      await onDeleted();
                    }, false);
                }}
              >
                Delete project
              </button>
            </details>
            <span className="local-label">
              <span />
              STORED LOCALLY
            </span>
          </div>
        </aside>
      )}
      <div className="work-area">
        {proposalPreview && (
          <main
            className="main-workspace proposal-host"
            onFocusCapture={() => setFocusPane("canvas")}
            onPointerDownCapture={() => setFocusPane("canvas")}
            inert={stacked && focusPane === "dock" && inspector}
            aria-hidden={
              stacked && focusPane === "dock" && inspector ? true : undefined
            }
          >
            <ProposalWorkspace
              key={proposalPreview.proposal.id + proposalPreview.contentHash}
              detail={proposalPreview}
              projectId={session.id}
              stale={proposalStale}
              retryingApply={
                uncertainApply?.proposalId === proposalPreview.proposal.id
              }
              onApply={applyPreview}
              onCancelApply={() => setUncertainApply(null)}
              onRevise={revisePreview}
              onDiscard={discardPreview}
              onClose={closeProposal}
              onRegisterLeaveGuard={registerProposalLeaveGuard}
            />
          </main>
        )}
        <main
          className="main-workspace"
          style={proposalPreview ? { display: "none" } : undefined}
          onFocusCapture={() => setFocusPane("canvas")}
          onPointerDownCapture={() => setFocusPane("canvas")}
          ref={mainRef}
          inert={stacked && focusPane === "dock" && inspector}
          aria-hidden={
            stacked && focusPane === "dock" && inspector ? true : undefined
          }
        >
          {scanRunning && (
            <div className="scan-progress" role="status">
              <span className="scan-activity" aria-hidden="true" />
              <span>
                Scanning Python · {scan?.files?.length ?? 0} files checked
              </span>
              <button className="quiet" onClick={openSource}>
                View progress
              </button>
              <button
                className="quiet"
                onClick={() => {
                  if (scan) void post(`/projects/${session.id}/scans/${scan.id}/cancel`)
                    .catch((reason) => setScanError((reason as Error).message));
                }}
              >
                Cancel scan
              </button>
            </div>
          )}
          {(saveStatus === "failed" || saveStatus === "conflict") && (
            <div className="save-banner" role="alert">
              <strong>{statusText}.</strong> {saveError}
              <div>
                {saveStatus === "conflict" ? (
                  <>
                    <button
                      onClick={() =>
                        void perform(async () => { await flushForNavigation(false); await onCopy(copy(getSnapshot().content)); }, false)
                      }
                    >
                      Keep draft as new project
                    </button>
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            "Discard this local draft and reload the saved version?",
                          )
                        )
                          void perform(async () => { await flushForNavigation(false); await onOpen(session.id); }, false);
                      }}
                    >
                      Discard and reload
                    </button>
                  </>
                ) : (
                  <button onClick={() => void flush()}>Retry save</button>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button
                className="icon-button"
                aria-label="Dismiss notice"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          )}
          <div className="workspace-mode" role="group" aria-label="Plan views">
            <button
              className="quiet"
              aria-pressed={workspaceView === "diagram"}
              onClick={() => {
                commit();
                setWorkspaceView("diagram");
              }}
            >
              Diagram
            </button>
            <button
              className="quiet"
              aria-pressed={workspaceView === "build"}
              onClick={() => {
                commit();
                setWorkspaceView("build");
                setReturnToBuild(false);
              }}
            >
              Build
            </button>
            {returnToBuild && workspaceView === "diagram" && (
              <button
                className="quiet back-build"
                onClick={() => {
                  commit();
                  setWorkspaceView("build");
                  setReturnToBuild(false);
                  focusAfterLayout("build-title");
                }}
              >
                Back to build task
              </button>
            )}
          </div>
          {workspaceView === "build" && (
            <BuildView
              onPlanning={() => openPlanning()}
              selectedId={selectedBuildTask}
              onSelect={setSelectedBuildTask}
              onRevealNode={(_diagramId, nodeId) => {
                setReturnToBuild(true);
                reveal(nodeId);
              }}
            />
          )}
          <div
            style={{
              display: workspaceView === "diagram" ? "contents" : "none",
            }}
          >
            <div className="canvas-toolbar">
              <div>
                <h1 id="canvas-title" tabIndex={-1}>
                  <span>{diagram?.name ?? "No diagram"}</span>
                  <button
                    className="icon-button"
                    aria-label="Rename diagram"
                    onClick={() => {
                      setDiagramName(diagram.name);
                      setDiagramDialog("rename");
                    }}
                  >
                    ✎
                  </button>
                </h1>
              </div>
              <div className="toolbar-actions">
                <button
                  className="quiet"
                  disabled={!diagram?.nodes.length}
                  onClick={() =>
                    setTidy({
                      diagram: copy(diagram),
                      selectedIds:
                        instance.current
                          ?.getNodes()
                          .filter((n) => n.selected)
                          .map((n) => n.id) ?? [],
                    })
                  }
                >
                  Tidy diagram
                </button>
                <details
                  className="add-menu popup-menu"
                  data-popup
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector("summary")?.focus();
                    }
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                      event.currentTarget.open = false;
                  }}
                >
                  <summary className="button">+ Add node</summary>
                  <div className="menu-popover">
                    {(Object.entries(nodeKinds) as [NodeKind, string][]).map(
                      ([kind, label]) => (
                        <button
                          key={kind}
                          onClick={(event) => {
                            addNode(kind);
                            const menu = event.currentTarget.closest("details");
                            if (menu) {
                              menu.open = false;
                              menu.querySelector("summary")?.focus();
                            }
                          }}
                        >
                          {label}
                        </button>
                      ),
                    )}
                  </div>
                </details>
                <button
                  className="quiet"
                  disabled={!diagram?.nodes.length}
                  title={
                    !diagram?.nodes.length
                      ? "Add nodes before connecting them"
                      : "Choose nodes and a branch label"
                  }
                  onClick={() => setConnecting(true)}
                >
                  ↗ Connect
                </button>
                <select
                  aria-label="Task filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All steps</option>
                  <option value="blocked">Blocked</option>
                  <option value="unfinished">Unfinished</option>
                </select>
              </div>
            </div>
            <div
              className="status-strip"
              title="Diagram step totals exclude notes; Build task status is separate."
            >
              <span className="status-count">
                <strong>{taskNodes.length}</strong> steps
              </span>
              {Object.entries(statuses)
                .filter(([key]) => counts[key] > 0)
                .map(([key, label]) => (
                  <span key={key}>
                    <StatusMark status={key} />
                    {counts[key]} {label.toLowerCase()}
                  </span>
                ))}
              {filter !== "all" && (
                <span className="filter-note">Other nodes are dimmed</span>
              )}
            </div>
            <div className="editor-row">
              <div
                className="canvas-column"
                data-testid="diagram-canvas"
                ref={canvasRef}
              >
                {diagram ? (
                  <Canvas
                    diagram={diagram}
                    selected={selected}
                    onSelect={select}
                    onInspect={() => {
                      preference("sidePanel", "inspector");
                      setInspector(true);
                      setFocusPane("dock");
                      focusAfterLayout("inspector-pane");
                    }}
                    filter={filter}
                    onInstance={(i) => {
                      instance.current = i;
                    }}
                    connectRequest={connecting}
                    onConnected={() => setConnecting(false)}
                    onAddNode={() => addNode("process")}
                  />
                ) : (
                  <Empty title="Add a diagram">
                    Use the + beside Diagrams to begin.
                  </Empty>
                )}
              </div>
            </div>
            {variables ? (
              <div className="catalogue-pane">
                <ResizeHandle
                  label="Resize variable catalogue"
                  controls="variable-catalogue"
                  orientation="horizontal"
                  value={catalogueHeight}
                  min={catalogueMin}
                  max={catalogueMax}
                  onChange={(value) => preference("catalogueHeight", value)}
                  onCollapse={closeCatalogue}
                />
                <VariablePanel
                  symbols={symbols}
                  focus={variableFocus}
                  setFocus={setVariableFocus}
                  onReveal={reveal}
                  onClose={closeCatalogue}
                  reconciliation={reconciliation}
                  onAttachSource={openSource}
                />
              </div>
            ) : (
              <button
                className="drawer-toggle"
                id="open-catalogue"
                aria-label="Variable catalogue — Open catalogue"
                aria-expanded={false}
                aria-controls="variable-catalogue"
                onClick={() => {
                  setVariables(true);
                  focusAfterLayout("catalogue-search");
                  void refreshEvidence();
                }}
              >
                <span>
                  ⌃ <strong>Variable catalogue</strong>
                  <span className="muted">
                    {content.variables.length} planned · {symbols.length}{" "}
                    detected
                  </span>
                </span>
                <span>Open catalogue</span>
              </button>
            )}
          </div>
        </main>
        {inspector &&
          diagram &&
          (workspaceView === "diagram" || planning || proposalPreview) &&
          (!proposalPreview || planning) && (
            <>
              <ResizeHandle
                label={planning ? "Resize planning chat" : "Resize inspector"}
                controls={planning ? "planning-pane" : "inspector-pane"}
                orientation="vertical"
                value={inspectorWidth}
                min={dockMin}
                max={inspectorMax}
                onChange={(value) =>
                  preference(planning ? "chatWidth" : "inspectorWidth", value)
                }
                onCollapse={closeInspector}
              />
              {!planning && (
                <div
                  className="inspector-pane"
                  onFocusCapture={() => setFocusPane("dock")}
                  onPointerDownCapture={() => setFocusPane("dock")}
                  id="inspector-pane"
                  tabIndex={-1}
                  hidden={stacked && focusPane !== "dock"}
                >
                  {variableFocus && (
                    <button
                      className="back-to-variable quiet"
                      onClick={() => {
                        setVariables(true);
                        setFocusPane("canvas");
                        focusAfterLayout("variable-detail-heading");
                      }}
                    >
                      ← Back to variable
                    </button>
                  )}
                  <Inspector
                    diagram={diagram}
                    selected={selected}
                    symbols={symbols}
                    onSelect={select}
                    onDiscuss={() => openPlanning(true)}
                    onVariable={(id) => {
                      setVariables(true);
                      setFocusPane("canvas");
                      setVariableFocus(id);
                      focusAfterLayout(
                        id ? "variable-detail-heading" : "catalogue-search",
                      );
                    }}
                  />
                </div>
              )}
            </>
          )}
        {planningVisited && diagram && (
          <div
            className="inspector-pane planning-pane"
            onFocusCapture={() => setFocusPane("dock")}
            onPointerDownCapture={() => setFocusPane("dock")}
            id="planning-pane"
            hidden={
              !inspector || !planning || (stacked && focusPane !== "dock")
            }
          >
            <PlanningPanel
              onDraftGuard={registerWritingLeaveGuard}
              diagramId={diagram.id}
              nodeId={
                diagram.nodes.some((node) => node.id === selected)
                  ? selected
                  : null
              }
              active={
                inspector && planning && (!stacked || focusPane === "dock")
              }
              composerHeight={layout.composerHeight}
              onComposerResize={(value) => preference("composerHeight", value)}
              focusComments={commentFocus}
              refreshKey={planningRefresh}
              onState={setPlanningSnapshot}
              onPreview={previewProposal}
              revisionRequest={proposalRevision}
              onReveal={reveal}
              onApply={acceptProposal}
              onClose={closeInspector}
            />
          </div>
        )}
      </div>
      {diagramDialog && (
        <Dialog
          title={diagramDialog === "new" ? "New diagram" : "Rename diagram"}
          onClose={() => setDiagramDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (diagramDialog === "new") {
                const id = uid();
                change(
                  (c) => {
                    c.diagrams.push({
                      id,
                      name: diagramName.trim(),
                      nodes: [],
                      edges: [],
                    });
                  },
                  "Add diagram",
                  id,
                );
                setActive(id);
                setSelected(null);
              } else
                change(
                  (c) => {
                    c.diagrams.find((d) => d.id === diagram.id)!.name =
                      diagramName.trim();
                  },
                  "Rename diagram",
                  diagram.id,
                );
              setDiagramDialog(null);
            }}
          >
            <Field label="Diagram name">
              <input
                required
                autoFocus
                value={diagramName}
                maxLength={200}
                onChange={(e) => setDiagramName(e.target.value)}
              />
            </Field>
            <div className="dialog-actions">
              {diagramDialog === "rename" && content.diagrams.length > 1 && (
                <button
                  type="button"
                  className="danger quiet"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete diagram “${diagram.name}” and its nodes?${deletionNotice(
                          content,
                          diagram.nodes.map((n) => n.id),
                        )}`,
                      )
                    ) {
                      change(
                        (c) => {
                          const ids = diagram.nodes.map((n) => n.id);
                          c.diagrams = c.diagrams.filter(
                            (d) => d.id !== diagram.id,
                          );
                          c.nodeLinks = c.nodeLinks.filter(
                            (l) => !ids.includes(l.nodeId),
                          );
                        },
                        "Delete diagram",
                        diagram.id,
                      );
                      setDiagramDialog(null);
                    }
                  }}
                >
                  Delete diagram
                </button>
              )}
              <button type="button" onClick={() => setDiagramDialog(null)}>
                Cancel
              </button>
              <button className="primary" disabled={!diagramName.trim()}>
                {diagramDialog === "new" ? "Create diagram" : "Rename"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {tidy && (
        <TidyDiagram
          diagram={tidy.diagram}
          selectedIds={tidy.selectedIds}
          onClose={() => setTidy(null)}
          onApply={(candidate) => {
            const current = content.diagrams.find(
              (d) => d.id === tidy.diagram.id,
            );
            if (!samePlan(current, tidy.diagram)) {
              setTidy(null);
              setError(
                "The diagram changed. Open Tidy again to preview the latest plan.",
              );
              return;
            }
            change(
              (c) => {
                const target = c.diagrams.find((d) => d.id === candidate.id)!;
                target.nodes = target.nodes.map((n) => ({
                  ...n,
                  position: candidate.nodes.find((item) => item.id === n.id)!
                    .position,
                }));
              },
              "Tidy diagram",
              candidate.id,
            );
            setTidy(null);
          }}
        />
      )}
      {briefOpen && <ProjectBriefDialog onClose={() => setBriefOpen(false)} />}
      {quickJump && <CommandPalette projects={projects} content={content} symbols={symbols} actions={[
        { id: "settings", title: "Open settings" }, { id: "new-project", title: "New project" },
        { id: "save", title: "Save workspace" }, { id: "brief", title: "Project brief" },
        ...(diagram?.nodes.length ? [{ id: "tidy", title: "Tidy diagram" }] : []),
      ]} onChoose={chooseCommand} onClose={() => { setQuickJump(false); const action = afterQuickJump.current; afterQuickJump.current = null; if (action) requestAnimationFrame(action); }} />}
      {connectionOpen && (
        <CodexConnectionDialog onClose={() => setConnectionOpen(false)} />
      )}
      {scanDialog && (
        <Dialog title="Python source" onClose={() => setScanDialog(false)}>
          <p className="muted">
            Attach a source directory to inspect Python bindings. PlanBranch
            reads files; it never runs or changes your code.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setScanError("");
              try {
                const s = await post<Source>(`/projects/${session.id}/source`, {
                  root: sourcePath,
                  ignores: ignoreText
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  confirmed: allowRead,
                });
                setSource(s);
                setAllowRead(false);
                await refreshEvidence(true);
              } catch (err) {
                setScanError((err as Error).message);
              }
            }}
          >
            <Field label="Source directory">
              <input
                className="mono"
                value={sourcePath}
                onChange={(e) => {
                  sourceInputGeneration.current += 1;
                  setSourcePath(e.target.value);
                }}
                placeholder="C:\\projects\\my-program or /home/me/my-program"
                required
              />
            </Field>
            <Field
              label="Additional ignore patterns"
              hint="One pattern per line. Common environments, caches and build outputs are already ignored."
            >
              <textarea
                className="mono"
                value={ignoreText}
                onChange={(e) => {
                  sourceInputGeneration.current += 1;
                  setIgnoreText(e.target.value);
                }}
                placeholder="generated/**"
              />
            </Field>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowRead}
                onChange={(e) => setAllowRead(e.target.checked)}
              />
              Allow read-only access to this directory
            </label>
            <div className="dialog-actions">
              <button disabled={!allowRead || scanRunning}>
                Attach directory
              </button>
              {source.attached && (
                <button
                  type="button"
                  className="primary"
                  disabled={scanRunning}
                  onClick={() =>
                    void perform(async () => {
                      setScanError("");
                      try {
                        setScan(
                          await post<Scan>(`/projects/${session.id}/scans`),
                        );
                      } catch (e) {
                        setScanError((e as Error).message);
                      }
                    })
                  }
                >
                  {symbols.length ? "Rescan Python files" : "Scan Python files"}
                </button>
              )}
            </div>
          </form>
          <ErrorMessage message={scanError} />
          {source.attached && (
            <p className="attached-path mono">Attached: {source.root}</p>
          )}
          {scan && (
            <div className="scan-results">
              <div className="section-heading">
                Scan {scan.status}
                {scanRunning && (
                  <button
                    className="quiet"
                    onClick={async () => {
                      try {
                        await post(
                          `/projects/${session.id}/scans/${scan.id}/cancel`,
                        );
                      } catch (e) {
                        setScanError((e as Error).message);
                      }
                    }}
                  >
                    Cancel scan
                  </button>
                )}
              </div>
              {scan.summary && (
                <dl className="scan-summary">
                  {Object.entries(scan.summary).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replaceAll("_", " ")}</dt>
                      <dd>
                        {typeof value === "object"
                          ? JSON.stringify(value)
                          : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="scan-file-list">
                {scan.files?.map((f, i) => (
                  <div key={i}>
                    <code>{f.file ?? f.path}</code>
                    <span>{f.status}</span>
                    {(f.error || f.message) && (
                      <small>{f.error ?? f.message}</small>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <small>
            Annotations are shown as written. Unannotated types stay unknown.
            Failed files keep stale observations.
          </small>
          <div className="dialog-actions">
            <button
              onClick={() => {
                setScanDialog(false);
                setVariables(true);
              }}
            >
              Open catalogue
            </button>
            <button onClick={() => setScanDialog(false)}>Close</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
