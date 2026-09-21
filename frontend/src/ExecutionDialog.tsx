import { useEffect, useRef, useState } from "react";
import { api, ApiError, post } from "./api";
import { Dialog, Field } from "./ui";
import { useProject } from "./store";
import ModelControls, { useModelSelection } from "./ModelControls";
import { briefLabels } from "./BriefFields";
import { copy, uid, type BuildTask, type ProjectBrief } from "./types";
import { samePlan } from "./planning";
import {
  executionActive,
  executionSelectionLabel,
  readExecutionReceipt,
  writeExecutionReceipt,
  type ExecutionAction,
  type ExecutionPreviewResult,
  type ExecutionReceipt,
  type ExecutionReply,
  type ExecutionRun,
  type ExecutionState,
  type RunStart,
} from "./execution";
import "./execution.css";

export default function ExecutionDialog({
  taskId,
  onClose,
  onPlanning,
  initialHistory = false,
}: {
  initialHistory?: boolean;
  taskId: string | null;
  onClose: () => void;
  onPlanning?: () => void;
}) {
  const { session, getSnapshot, commit, flush, synchronize } = useProject();
  const base = `/projects/${session.id}/execution`;
  const [state, setState] = useState<ExecutionState | null>(null);
  const [run, setRun] = useState<ExecutionRun | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const selectedRun = useRef("");
  const initialSelection = useRef(true);
  const [preview, setPreview] = useState<ExecutionPreviewResult | null>(null);
  const [previewSelection, setPreviewSelection] = useState<
    ReturnType<typeof useModelSelection>["selection"] | null
  >(null);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [changeRepository, setChangeRepository] = useState(false);
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [receipt, setReceiptState] = useState<ExecutionReceipt | null>(() =>
    readExecutionReceipt(session.id),
  );
  const receiptRef = useRef(receipt);
  const [filePath, setFilePath] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const alive = useRef(true),
    stateTicket = useRef(0),
    runTicket = useRef(0);
  const models = useModelSelection();
  const task = session.content.buildTasks?.find((item) => item.id === taskId);
  const setReceipt = (next: ExecutionReceipt | null) => {
    receiptRef.current = next;
    writeExecutionReceipt(session.id, next);
    if (alive.current) setReceiptState(next);
  };
  const installRun = (next: ExecutionRun) => {
    if (!alive.current) return;
    runTicket.current++;
    selectedRun.current = next.id;
    setSelectedRunId(next.id);
    setRun(next);
    setPreview(null);
    setState((old) =>
      old
        ? {
            ...old,
            runs: [next, ...old.runs.filter((item) => item.id !== next.id)],
          }
        : old,
    );
    const pending = receiptRef.current;
    if (pending?.kind === "start" && pending.body.previewId === next.previewId)
      setReceipt(null);
    else if (pending && pending.kind !== "start" && pending.runId === next.id) {
      if (
        pending.kind === "accept" &&
        next.acceptedDigest === pending.body.digest
      )
        setReceipt(null);
      if (
        pending.kind === "apply" &&
        next.applied &&
        next.applyState?.digest === pending.body.digest
      )
        setReceipt(null);
      if (pending.kind === "cancel" && !executionActive(next)) setReceipt(null);
      if (
        pending.kind === "complete" &&
        next.completedCursor &&
        getSnapshot().history.some((item) => item.id === next.completedCursor)
      )
        setReceipt(null);
    }
  };
  const loadRun = async (id: string) => {
    const ticket = ++runTicket.current;
    const response = await api<{ run: ExecutionRun }>(`${base}/runs/${id}`);
    if (
      alive.current &&
      ticket === runTicket.current &&
      selectedRun.current === id
    )
      installRun(response.run);
  };
  const loadState = async () => {
    const ticket = ++stateTicket.current;
    const next = await api<ExecutionState>(base);
    if (!alive.current || ticket !== stateTicket.current) return;
    setState(next);
    const pending = receiptRef.current;
    if (pending?.kind === "start") {
      const found = next.runs.find(
        (item) => item.previewId === pending.body.previewId,
      );
      if (found) {
        selectedRun.current = found.id;
        setSelectedRunId(found.id);
        await loadRun(found.id);
      }
    } else if (pending && initialSelection.current) {
      selectedRun.current = pending.runId;
      setSelectedRunId(pending.runId);
      await loadRun(pending.runId);
    } else if (initialHistory && initialSelection.current) {
      const latest =
        next.runs.find((item) => item.taskId === taskId) ?? next.runs[0];
      if (latest) {
        selectedRun.current = latest.id;
        setSelectedRunId(latest.id);
        await loadRun(latest.id);
      }
    }
    initialSelection.current = false;
  };
  useEffect(() => {
    alive.current = true;
    void loadState().catch((reason) => {
      if (alive.current) setError(message(reason));
    });
    return () => {
      alive.current = false;
      stateTicket.current++;
      runTicket.current++;
    };
  }, [base]);
  const hasActive = state?.runs.some(executionActive) || executionActive(run);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      if (busyRef.current) return;
      void (async () => {
        await loadState();
        if (selectedRun.current) await loadRun(selectedRun.current);
      })().catch((reason) => {
        if (alive.current) setError(message(reason));
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [hasActive, base]);
  useEffect(() => {
    if (previewSelection && !samePlan(previewSelection, models.selection)) {
      setPreview(null);
      setPreviewSelection(null);
    }
  }, [models.selection, previewSelection]);
  const work = async (label: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (reason) {
      if (alive.current) setError(message(reason));
      const pending = receiptRef.current;
      // An Apply response can fail after writing files. Only an explicit server
      // receipt declaring this exact request terminal and unwritten permits a
      // new Apply request; uncertain or partial work keeps its original ID.
      const failure =
        reason instanceof ApiError &&
        reason.data &&
        typeof reason.data === "object" &&
        "executionReceipt" in reason.data
          ? reason.data.executionReceipt
          : null;
      const refusedApply =
        pending?.kind === "apply" &&
        failure &&
        typeof failure === "object" &&
        "state" in failure &&
        failure.state === "failed" &&
        "mutationId" in failure &&
        failure.mutationId === pending.body.mutationId;
      if (
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        (pending?.kind !== "apply" || refusedApply)
      )
        setReceipt(null);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy("");
    }
  };
  const saved = async () => {
    commit();
    if (!(await flush()))
      throw new Error("Save or recover your planning changes first.");
  };
  const chooseRun = (id: string) => {
    selectedRun.current = id;
    setSelectedRunId(id);
    setRun(null);
    setFilePath("");
    setError("");
    runTicket.current++;
    if (id) void work("Loading run", () => loadRun(id));
  };
  const chooseRepository = () =>
    void work("Selecting repository", async () => {
      const next = await post<ExecutionState>(`${base}/repository`, {
        path: repositoryPath.trim(),
        confirmed: true,
        mutationId: uid(),
      });
      stateTicket.current++;
      if (!alive.current) return;
      setState(next);
      setChangeRepository(false);
      setPreview(null);
      setAnnouncement("Execution repository selected.");
    });
  const prepare = () =>
    void work("Checking run", async () => {
      if (!taskId || models.problem) return;
      await saved();
      const selection = copy(models.selection);
      const result = await post<ExecutionPreviewResult>(`${base}/preview`, {
        taskId,
        selection,
      });
      if (!alive.current) return;
      setPreview(result);
      setPreviewSelection(selection);
      setAnnouncement(
        result.ready
          ? "Run preview ready. Review it before starting."
          : "Resolve the listed issues before running.",
      );
    });
  const startRun = (body?: RunStart) =>
    void work("Starting run", async () => {
      const captured =
        body ??
        (preview?.ready
          ? {
              mutationId: uid(),
              previewId: preview.preview.id,
              confirmed: true as const,
            }
          : null);
      if (!captured) return;
      setReceipt({ kind: "start", body: captured });
      try {
        const response = await post<ExecutionReply>(`${base}/runs`, captured);
        if (alive.current) {
          installRun(response.run);
          setReceipt(null);
          setAnnouncement("Run started.");
        }
      } catch (reason) {
        await loadState().catch(() => {});
        if (receiptRef.current?.kind === "start") throw reason;
      }
    });
  const mutateRun = (
    action: ExecutionAction,
    retry?: Extract<ExecutionReceipt, { runId: string }>,
  ) =>
    void work(actionLabel(action), async () => {
      const target = retry?.runId ?? run?.id;
      if (!target) return;
      const durableApply =
        action === "apply" && run?.applyRequest
          ? { kind: "apply" as const, runId: target, body: run.applyRequest }
          : undefined;
      const original = retry ?? durableApply;
      const digest = original?.body.digest ?? run?.artifact?.digest;
      if (["accept", "complete", "apply"].includes(action) && !digest)
        throw new Error("Refresh the run results before continuing.");
      if (
        !retry &&
        action === "apply" &&
        !window.confirm(
          `Apply the accepted changes to ${run?.repository.path}? Review the changed files before continuing.`,
        )
      )
        return;
      const dispatch = async (baseRevision?: number) => {
        const captured: Extract<ExecutionReceipt, { runId: string }> =
          original ?? {
            kind: action,
            runId: target,
            body: {
              mutationId: uid(),
              ...(["accept", "complete", "apply"].includes(action)
                ? { digest, confirmed: true as const }
                : {}),
              ...(action === "complete" ? { baseRevision } : {}),
            },
          };
        setReceipt(captured);
        const response = await post<ExecutionReply>(
          `${base}/runs/${target}/${action}`,
          captured.body,
        );
        if (alive.current) installRun(response.run);
        return response;
      };
      try {
        if (action === "complete") {
          commit();
          await synchronize(async (snapshot) => {
            const response = await dispatch(snapshot.revision);
            if (!response.project)
              throw new Error(
                "The completion response is missing the saved plan. Check run status before retrying.",
              );
            return response.project;
          });
        } else await dispatch();
        setReceipt(null);
        if (alive.current)
          setAnnouncement(
            action === "complete"
              ? "Completion recorded. Approve the updated plan before another run."
              : `${actionLabel(action)} finished.`,
          );
      } catch (reason) {
        await loadState().catch(() => {});
        if (selectedRun.current)
          await loadRun(selectedRun.current).catch(() => {});
        throw reason;
      }
    });
  const retryReceipt = () => {
    const pending = receiptRef.current;
    if (!pending) return;
    if (pending.kind === "start") startRun(pending.body);
    else mutateRun(pending.kind, pending);
  };
  const accepted =
    !!run?.artifact && run.acceptedDigest === run.artifact.digest;
  const active = executionActive(run);
  const failedCommands =
    run?.commands.filter(
      (command) => command.exitCode !== null && command.exitCode !== 0,
    ).length ?? 0;
  const file =
    run?.artifact?.files.find((item) => item.path === filePath) ??
    run?.artifact?.files[0];
  const frozen = preview?.preview;
  const previewChanged = !!frozen && session.revision !== frozen.baseRevision;
  return (
    <Dialog title="Run step" onClose={onClose}>
      <div className="execution-dialog">
        <p role="status" className="sr-only">
          {announcement}
        </p>
        <div className="execution-topline">
          <Field label="Execution history">
            <select
              value={selectedRunId}
              disabled={!!busy}
              onChange={(event) => chooseRun(event.target.value)}
            >
              <option value="">Prepare a new run</option>
              {state?.runs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.taskTitle || "Untitled task"} ·{" "}
                  {runStateLabel(item.state)} ·{" "}
                  {new Date(item.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </Field>
          <button
            disabled={!!busy}
            onClick={() =>
              void work("Checking runs", async () => {
                await loadState();
                if (selectedRun.current) await loadRun(selectedRun.current);
              })
            }
          >
            Check run status
          </button>
        </div>
        {error && (
          <p role="alert" className="execution-error">
            {error}
          </p>
        )}
        {receipt && (
          <div className="execution-recovery" role="status">
            <p>
              {receipt.kind === "start"
                ? "Start confirmation is uncertain. Check run history or retry the same reviewed request."
                : `${actionLabel(receipt.kind)} is awaiting confirmation. The original request is retained.`}
            </p>
            <button disabled={!!busy} onClick={retryReceipt}>
              {receipt.kind === "start"
                ? "Retry run request"
                : `Retry ${receipt.kind === "complete" ? "completion" : receipt.kind}`}
            </button>
          </div>
        )}
        {!state ? (
          <p>Loading execution settings…</p>
        ) : !selectedRunId ? (
          <>
            <section
              className="execution-section"
              aria-label="Execution repository"
            >
              <h3>Execution repository</h3>
              {state.repository && !changeRepository ? (
                <div className="execution-repository">
                  <code>{state.repository.path}</code>
                  <button
                    disabled={!!busy || !!receipt}
                    onClick={() => {
                      setRepositoryPath(state.repository!.path);
                      setChangeRepository(true);
                    }}
                  >
                    Change repository
                  </button>
                </div>
              ) : (
                <div className="execution-repository">
                  <Field label="Repository folder">
                    <input
                      value={repositoryPath}
                      onChange={(event) =>
                        setRepositoryPath(event.target.value)
                      }
                      placeholder="Local Git repository path"
                      disabled={!!busy || !!receipt}
                    />
                  </Field>
                  <button
                    onClick={chooseRepository}
                    disabled={!repositoryPath.trim() || !!busy || !!receipt}
                  >
                    Use repository
                  </button>
                  {state.repository && (
                    <button onClick={() => setChangeRepository(false)}>
                      Cancel
                    </button>
                  )}
                </div>
              )}
              <p className="muted">
                Choose a Git repository separately from source scanning. The run
                uses an isolated worktree from its saved commit.
              </p>
            </section>
            {task ? (
              <TaskContext
                task={frozen?.task ?? task}
                brief={frozen?.brief ?? session.content.brief}
              />
            ) : (
              <p className="muted">
                Select a build task to prepare a new run. Existing runs remain
                available in history.
              </p>
            )}
            <section className="execution-section" aria-label="Run settings">
              <h3>Model</h3>
              <fieldset disabled={!!busy || !!receipt}>
                <ModelControls
                  selection={models.selection}
                  capabilities={models.capabilities}
                  onChange={models.setSelection}
                  problemId="execution-model-problem"
                />
              </fieldset>
              {models.problem && (
                <p className="execution-error" id="execution-model-problem">
                  {models.problem}
                </p>
              )}
              <button
                className="quiet"
                disabled={models.refreshing || !!busy}
                onClick={() => void models.refresh()}
              >
                {models.refreshing ? "Refreshing models…" : "Refresh models"}
              </button>
            </section>
            {!state.agent.available && (
              <p className="execution-error">
                {state.agent.reason || "The execution agent is unavailable."}
              </p>
            )}
            {!state.ownership.available && (
              <p className="execution-error">
                {state.ownership.reason ||
                  "This machine cannot safely own an execution process."}
              </p>
            )}
            {preview && (
              <section className="execution-section" aria-label="Run preview">
                <h3>Run preview</h3>
                <p>
                  <strong>Source commit</strong>{" "}
                  <code>{frozen?.sourceCommit ?? "Unavailable"}</code>
                </p>
                {frozen?.repository?.dirty && (
                  <p className="execution-notice">
                    Uncommitted checkout changes are excluded from this run.
                  </p>
                )}
                <p>
                  <strong>Captured model</strong>{" "}
                  {executionSelectionLabel(
                    frozen?.generation?.selection ??
                      previewSelection ??
                      undefined,
                  )}
                </p>
                {preview.issues.length > 0 && (
                  <ul className="execution-issues">
                    {preview.issues.map((issue, index) => (
                      <li key={index}>{issue}</li>
                    ))}
                  </ul>
                )}
                {previewChanged && (
                  <p className="execution-notice">
                    The plan changed after this preview. Preview again before
                    running.
                  </p>
                )}
              </section>
            )}
            <div className="execution-actions">
              <button
                disabled={
                  !task ||
                  !state.repository ||
                  !!busy ||
                  !!receipt ||
                  !!models.problem
                }
                onClick={prepare}
              >
                Preview run
              </button>
              <button
                className="primary"
                disabled={
                  !task ||
                  !preview?.ready ||
                  previewChanged ||
                  !!busy ||
                  !!receipt ||
                  !!models.problem
                }
                onClick={() => startRun()}
              >
                Run step
              </button>
              {onPlanning && (
                <button className="quiet" onClick={onPlanning}>
                  Review plan approval
                </button>
              )}
            </div>
          </>
        ) : !run ? (
          <p>Loading run…</p>
        ) : (
          <>
            <section className="execution-run-heading">
              <h2>{run.taskTitle || "Untitled task"}</h2>
              <span className={`execution-state ${run.state}`}>
                {runStateLabel(run.state)}
              </span>
              {failedCommands > 0 && (
                <p className="execution-notice" role="status">
                  {failedCommands}{" "}
                  {failedCommands === 1 ? "command failed" : "commands failed"}.
                  Review the observed output before accepting.
                </p>
              )}
              <p role="status">{run.progress || "Run recorded."}</p>
              {active && (
                <p className="muted">
                  The run continues when this dialog is closed.
                </p>
              )}
              {run.error && <p className="execution-error">{run.error}</p>}
              <div className="execution-actions">
                {active && (
                  <button
                    disabled={!!busy || !!receipt || run.state === "cancelling"}
                    onClick={() => mutateRun("cancel")}
                  >
                    {run.state === "cancelling" ? "Cancelling…" : "Cancel run"}
                  </button>
                )}
                {!active && (
                  <button
                    disabled={!!busy || !!receipt}
                    onClick={() => mutateRun("refresh")}
                  >
                    Refresh results
                  </button>
                )}
              </div>
            </section>
            <details className="execution-section">
              <summary>Run context</summary>
              <p>
                <strong>Repository</strong> <code>{run.repository.path}</code>
              </p>
              <p>
                <strong>Source commit</strong> <code>{run.sourceCommit}</code>
              </p>
              {run.worktreePath && (
                <p>
                  <strong>Worktree</strong> <code>{run.worktreePath}</code>
                </p>
              )}
              <p>
                <strong>Model</strong>{" "}
                {executionSelectionLabel(run.context.generation?.selection)}
              </p>
              <TaskContext task={run.context.task} brief={run.context.brief} />
            </details>
            {run.summary && (
              <section className="execution-section" aria-label="Agent report">
                <h3>Agent report</h3>
                <p className="execution-prose">{run.summary}</p>
                <p className="muted">
                  Reported by the agent. Check the observed results below.
                </p>
              </section>
            )}
            <section
              className="execution-section"
              aria-label="Observed commands"
            >
              <h3>Observed commands</h3>
              {run.commands.length ? (
                run.commands.map((command) => (
                  <details className="execution-command" key={command.id}>
                    <summary>
                      <code>{command.command}</code>
                      <span>
                        {command.exitCode === null
                          ? command.status
                          : `Exit ${command.exitCode}`}
                      </span>
                    </summary>
                    <pre>{command.output || "No output recorded."}</pre>
                  </details>
                ))
              ) : (
                <p className="muted">No command results recorded.</p>
              )}
            </section>
            <section className="execution-section" aria-label="Changed files">
              <div className="execution-section-heading">
                <h3>Changed files</h3>
                <span>{run.artifact?.files.length ?? 0} files</span>
              </div>
              {run.artifact ? (
                <>
                  {run.artifact.files.length ? (
                    <>
                      <Field label="Changed file">
                        <select
                          value={file?.path ?? ""}
                          onChange={(event) => setFilePath(event.target.value)}
                        >
                          {run.artifact.files.map((item) => (
                            <option key={item.path} value={item.path}>
                              {item.path} · {item.kind}
                              {item.binary ? " · binary" : ""}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {file && (
                        <div
                          className="execution-diff"
                          aria-label={`Diff for ${file.path}`}
                        >
                          <p>
                            <code>{file.path}</code> · {file.kind}
                            {file.binary ? " · binary file" : ""}
                          </p>
                          {file.oldMode !== undefined &&
                            file.newMode !== undefined &&
                            file.oldMode !== file.newMode && (
                              <p>
                                File mode: {fileMode(file.oldMode)} →{" "}
                                {fileMode(file.newMode)}
                              </p>
                            )}
                          <pre>
                            {file.patch ||
                              (file.binary
                                ? "Binary contents are not shown."
                                : "No text diff available.")}
                          </pre>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="muted">No file changes captured.</p>
                  )}
                  <details>
                    <summary>Result fingerprint</summary>
                    <code>{run.artifact.digest}</code>
                  </details>
                </>
              ) : (
                <p className="muted">
                  Results have not been captured. Refresh results after the run
                  stops.
                </p>
              )}
            </section>
            {(run.planStale || run.sourceStale || run.applyPlanStale) && (
              <div className="execution-notice">
                {run.sourceStale && (
                  <p>
                    The repository baseline changed. These results cannot be
                    accepted or applied to the current checkout.
                  </p>
                )}
                {run.planStale && (
                  <p>
                    {run.completedCursor
                      ? "Completion changed the plan. Approve the updated plan before another run."
                      : "The approved plan changed. Review and approve it before accepting or completing this run."}
                  </p>
                )}
                {run.applyPlanStale && (
                  <p>
                    The plan changed beyond this run's completion. Applying
                    these changes is blocked.
                  </p>
                )}
                {onPlanning && (
                  <button onClick={onPlanning}>Review plan approval</button>
                )}
              </div>
            )}
            {run.applyState && run.applyState.state !== "applied" && (
              <p className="execution-notice">
                Checkout apply was interrupted (
                {run.applyState.completed.length} of {run.applyState.fileCount}{" "}
                files recorded). Review the checkout and deliberately retry
                Apply.
              </p>
            )}
            <div className="execution-review-actions">
              <div>
                <button
                  disabled={
                    active ||
                    !!busy ||
                    !!receipt ||
                    !run.artifact ||
                    run.planStale ||
                    run.sourceStale ||
                    accepted
                  }
                  onClick={() => mutateRun("accept")}
                >
                  {accepted ? "Changes accepted" : "Accept changes"}
                </button>
                <p>Record acceptance of this exact result.</p>
              </div>
              <div>
                <button
                  disabled={
                    active ||
                    !!busy ||
                    !!receipt ||
                    !accepted ||
                    !!run.completedCursor ||
                    run.planStale ||
                    run.sourceStale
                  }
                  onClick={() => mutateRun("complete")}
                >
                  {run.completedCursor
                    ? "Completion recorded"
                    : "Complete task"}
                </button>
                <p>Add a task-completion action to the plan.</p>
              </div>
              <div>
                <button
                  disabled={
                    active ||
                    !!busy ||
                    !!receipt ||
                    !accepted ||
                    run.applied ||
                    run.sourceStale ||
                    run.applyPlanStale
                  }
                  onClick={() => mutateRun("apply")}
                >
                  {run.applied
                    ? "Applied to checkout"
                    : run.applyState
                      ? "Retry apply to checkout"
                      : "Apply to checkout"}
                </button>
                <p>Separately update the selected repository.</p>
              </div>
            </div>
          </>
        )}
        {busy && (
          <p role="status" className="execution-busy">
            {busy}…
          </p>
        )}
      </div>
    </Dialog>
  );
}
function TaskContext({
  task,
  brief,
}: {
  task: BuildTask;
  brief?: ProjectBrief;
}) {
  return (
    <section className="execution-section" aria-label="Selected build task">
      <h3>{task.title || "Untitled task"}</h3>
      <p className="execution-prose">
        {task.deliverable || "No deliverable specified."}
      </p>
      <div className="execution-task-context">
        <div>
          <h4>Expected files</h4>
          {task.expectedFiles.some((file) => file.trim()) ? (
            <ul>
              {task.expectedFiles
                .filter((file) => file.trim())
                .map((file, index) => (
                  <li key={index}>
                    <code>{file}</code>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">No expected files specified.</p>
          )}
        </div>
        <div>
          <h4>Acceptance checks</h4>
          {task.acceptanceChecks.some((check) => check.text.trim()) ? (
            <ul>
              {task.acceptanceChecks
                .filter((check) => check.text.trim())
                .map((check) => (
                  <li key={check.id}>{check.text}</li>
                ))}
            </ul>
          ) : (
            <p className="muted">No acceptance checks specified.</p>
          )}
        </div>
      </div>
      {brief && (
        <details>
          <summary>Plan requirements</summary>
          {(Object.keys(briefLabels) as (keyof ProjectBrief)[]).map((field) =>
            brief[field] ? (
              <p className="execution-prose" key={field}>
                <strong>{briefLabels[field]}</strong>
                {"\n"}
                {brief[field]}
              </p>
            ) : null,
          )}
        </details>
      )}
    </section>
  );
}
function message(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "The execution request could not be completed. Check run status.";
}
function actionLabel(action: ExecutionAction) {
  return {
    cancel: "Cancel run",
    refresh: "Refresh results",
    accept: "Accept changes",
    complete: "Complete task",
    apply: "Apply to checkout",
  }[action];
}

function fileMode(mode: string | null) {
  return mode === null
    ? "absent"
    : mode === "100755"
      ? "executable"
      : mode === "100644"
        ? "regular"
        : mode;
}

function runStateLabel(state: ExecutionRun["state"]) {
  return state === "succeeded" ? "Finished" : state;
}
