import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import { api, bootstrap, download, post } from "./api";
import { ProjectProvider, useProject } from "./store";
import {
  copy,
  createNode,
  nodeKinds,
  statuses,
  uid,
  type Content,
  type DetectedSymbol,
  type Envelope,
  type NodeKind,
  type ProjectSummary,
  type Reconciliation,
  type Scan,
  type Source,
} from "./types";
import Canvas, { type FlowNode } from "./Canvas";
import Inspector from "./Inspector";
import VariablePanel from "./VariablePanel";
import { Dialog, Empty, ErrorMessage, Field, StatusMark } from "./ui";

export default function App() {
  const [transition, setTransition] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [loading, setLoading] = useState(true);
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
        if (p.projects.length) {
          const e = await api<Envelope>(`/projects/${p.projects[0].id}`);
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
  const open = async (id: string) => {
    setTransition(true);
    try {
      setEnvelope(await api<Envelope>(`/projects/${id}`));
      await refresh();
    } catch (e) {
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
            FlowDesk
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
              FlowDesk
            </div>
            <span className="local-label">LOCAL WORKSPACE</span>
          </header>
          <main>
            <div className="welcome-kicker">YOUR PROGRAM, BEFORE THE CODE</div>
            <h1>A little room to think.</h1>
            <p>
              Map the logic. Keep your decisions, notes, and variables together.
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
        d="M8 18V8h10M8 13h7"
        stroke="#f5f8f4"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="18" cy="18" r="2" fill="#f5f8f4" />
    </svg>
  );
}
function Workbench({
  projects,
  onOpen,
  onNew,
  onExample,
  onImport,
  onCopy,
  onDeleted,
}: {
  projects: ProjectSummary[];
  onOpen: (id: string) => Promise<void>;
  onNew: () => void;
  onExample: () => Promise<void>;
  onImport: () => void;
  onCopy: (c: Content) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { session, change, commit, undo, redo, flush, saveStatus, saveError } =
    useProject();
  const content = session.content;
  const [active, setActive] = useState(content.diagrams[0]?.id ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);
  const [variables, setVariables] = useState(false);
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
  const [scanError, setScanError] = useState("");
  const instance = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const diagram =
    content.diagrams.find((d) => d.id === active) ?? content.diagrams[0];
  useEffect(() => {
    if (!content.diagrams.some((d) => d.id === active))
      setActive(content.diagrams[0]?.id ?? "");
  }, [content.diagrams, active]);
  const refreshEvidence = useCallback(async () => {
    try {
      const [s, v, r] = await Promise.all([
        api<Source>(`/projects/${session.id}/source`),
        api<{ symbols: DetectedSymbol[] }>(`/projects/${session.id}/symbols`),
        api<Reconciliation>(`/projects/${session.id}/reconciliation`),
      ]);
      setSource(s);
      if (s.latestScan) setScan(s.latestScan);
      setSymbols(v.symbols);
      setReconciliation(r);
      setSourcePath(s.root ?? "");
      setIgnoreText(s.ignores.join("\n"));
    } catch (e) {
      setScanError((e as Error).message);
    }
  }, [session.id]);
  useEffect(() => {
    void refreshEvidence();
  }, [refreshEvidence]);
  useEffect(() => {
    void api<Reconciliation>(`/projects/${session.id}/reconciliation`)
      .then(setReconciliation)
      .catch(() => {});
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
  const perform = async (action: () => void | Promise<void>, save = true) => {
    setError("");
    try {
      if (save && !(await flush())) return;
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const historyIndex = session.history.findIndex(
    (h) => h.id === session.cursor,
  );
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
    if (!diagram) return;
    const pos = instance.current?.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 - 80,
    }) ?? { x: 100, y: 100 };
    const n = createNode(kind, {
      x: Math.round(pos.x / 10) * 10,
      y: Math.round(pos.y / 10) * 10,
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
      setActive(d.id);
      setSelected(nodeId);
      setInspector(true);
      setTimeout(
        () =>
          void instance.current?.fitView({
            nodes: [{ id: nodeId }],
            maxZoom: 1.2,
            padding: 0.5,
            duration: 250,
          }),
        100,
      );
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
    <div className={`workspace ${inspector ? "" : "inspector-closed"}`}>
      <header className="topbar">
        <div className="brand">
          <Brand />
          FlowDesk
        </div>
        <div className="breadcrumb">
          <strong>{content.name}</strong>
          <span>/</span>
          <span>{diagram?.name}</span>
        </div>
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
          {statusText}
        </div>
        <div className="history-buttons">
          <button
            className="icon-button"
            disabled={
              !session.pending &&
              historyIndex <= Math.max(0, session.history.length - 101)
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
              !!session.pending || historyIndex === session.history.length - 1
            }
            title={`Redo ${session.history[historyIndex + 1]?.label ?? ""}`}
            aria-label="Redo"
            onClick={() => historyMove("redo")}
          >
            ↷
          </button>
        </div>
        <button className="quiet" onClick={() => void flush()}>
          Save
        </button>
        <button
          onClick={() => {
            setScanDialog(true);
            void refreshEvidence();
          }}
        >
          {scanRunning ? "Scanning…" : "Scan Python"}
        </button>
        <details className="export-menu">
          <summary className="button">
            {busy ? "Exporting…" : "Export ↓"}
          </summary>
          <div className="menu-popover">
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
      </header>
      <aside className="sidebar">
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
            LOCAL · PRIVATE
          </span>
        </div>
      </aside>
      <main className="main-workspace">
        {(saveStatus === "failed" || saveStatus === "conflict") && (
          <div className="save-banner" role="alert">
            <strong>{statusText}.</strong> {saveError}
            <div>
              {saveStatus === "conflict" ? (
                <>
                  <button
                    onClick={() =>
                      void perform(() => onCopy(copy(content)), false)
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
                        void onOpen(session.id);
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
        <div className="canvas-toolbar">
          <div>
            <span className="eyebrow">DIAGRAM</span>
            <h1>
              {diagram?.name ?? "No diagram"}
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
              onClick={() => setConnecting(true)}
            >
              ↗ Connect
            </button>
            <select
              aria-label="Task filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All tasks</option>
              <option value="blocked">Blocked</option>
              <option value="unfinished">Unfinished</option>
            </select>
            <button
              className={inspector ? "quiet active" : "quiet"}
              aria-label="Toggle inspector"
              onClick={() => setInspector((v) => !v)}
            >
              ☷ Inspector
            </button>
          </div>
        </div>
        <div
          className="status-strip"
          title="Task totals exclude note nodes; checklist completion is independent."
        >
          <span className="status-count">
            <strong>{taskNodes.length}</strong> tasks
          </span>
          {Object.entries(statuses).map(([key, label]) => (
            <span key={key}>
              <StatusMark status={key} />
              {counts[key]} {label.toLowerCase()}
            </span>
          ))}
          <small>Notes excluded</small>
          {filter !== "all" && (
            <span className="filter-note">Other nodes are dimmed</span>
          )}
        </div>
        <div className="editor-row">
          <div className="canvas-column" data-testid="diagram-canvas">
            {diagram ? (
              <Canvas
                diagram={diagram}
                selected={selected}
                onSelect={select}
                filter={filter}
                onInstance={(i) => {
                  instance.current = i;
                }}
                connectRequest={connecting}
                onConnected={() => setConnecting(false)}
              />
            ) : (
              <Empty title="Add a diagram">
                Use the + beside Diagrams to begin.
              </Empty>
            )}
          </div>
          {inspector && diagram && (
            <Inspector
              diagram={diagram}
              selected={selected}
              symbols={symbols}
              onSelect={select}
              onVariable={(id) => {
                setVariables(true);
                setVariableFocus(id);
              }}
            />
          )}
        </div>
        {variables ? (
          <VariablePanel
            symbols={symbols}
            focus={variableFocus}
            setFocus={setVariableFocus}
            onReveal={reveal}
            onClose={() => setVariables(false)}
            reconciliation={reconciliation}
          />
        ) : (
          <button
            className="drawer-toggle"
            onClick={() => {
              setVariables(true);
              void refreshEvidence();
            }}
          >
            <span>
              ⌃ <strong>Variable catalogue</strong>
              <span className="muted">
                {content.variables.length} planned · {symbols.length} detected
              </span>
            </span>
            <span>Open catalogue</span>
          </button>
        )}
      </main>
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
                        `Delete diagram “${diagram.name}” and its nodes?`,
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
      {scanDialog && (
        <Dialog title="Python source" onClose={() => setScanDialog(false)}>
          <p className="muted">
            Attach a source directory to inspect Python bindings. FlowDesk reads
            files; it never runs or changes your code.
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
                await refreshEvidence();
              } catch (err) {
                setScanError((err as Error).message);
              }
            }}
          >
            <Field label="Source directory">
              <input
                className="mono"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
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
                onChange={(e) => setIgnoreText(e.target.value)}
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
