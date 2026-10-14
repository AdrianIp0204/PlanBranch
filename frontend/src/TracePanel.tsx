import { useEffect, useState } from "react";
import { api, download, post } from "./api";
import { Field } from "./ui";
import { useProject } from "./store";
import { uid } from "./types";
import type { ExecutionRun, ExecutionRunSummary } from "./execution";

export const verificationLabel = (value: string) =>
  ({
    not_verified: "Not verified",
    observed_check_passed: "Observed check passed",
    observed_check_failed: "Observed check failed",
    stale_evidence: "Stale evidence",
    human_review_required: "Human review required",
    human_review_recorded: "Human review recorded",
    external_result_reported: "External result reported",
    legacy_writable_observation: "Historical writable command (not source-bound)",
    mutable_command_observed: "Writable command observed (not source-bound)",
    command_exit_observed: "Immutable command exit observed (coverage unverified)",
  })[value] ?? value;
type Review = {
  id: string;
  note: string;
  stale: boolean;
  candidateHash: string;
  commandId: string | null;
  filePaths: string[];
  createdAt: string;
};
type Trace = {
  taskTitle: string;
  requirement: { id: string; text: string; meaningHash: string };
  diagramLinks: {
    nodeId: string;
    diagramId: string;
    title: string;
    missing: boolean;
  }[];
  criteria: {
    id: string;
    text: string;
    meaningHash: string;
    verificationState: string;
    reviews: Review[];
  }[];
  runs: ExecutionRunSummary[];
  run: ExecutionRun | null;
  uncertainty: string;
  files: {
    path: string;
    kind: string;
    fileHash: string | null;
    candidateHash: string | null;
    baseRevision: string;
  }[];
};

export default function TracePanel({
  taskId,
  runId,
  onRevealNode,
  onOpenRun,
}: {
  taskId: string;
  runId?: string;
  onRevealNode?: (diagramId: string, nodeId: string) => void;
  onOpenRun?: (id: string) => void;
}) {
  const { session, commit, flush } = useProject();
  const [open, setOpen] = useState(false),
    [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [criterionId, setCriterionId] = useState(""),
    [commandId, setCommandId] = useState(""),
    [note, setNote] = useState("");
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const base = `/projects/${session.id}/tasks/${taskId}/traceability`;
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  useEffect(() => {
    if (!open) return;
    let live = true;
    setTrace(null);
    setError("");
    setCriterionId("");
    setCommandId("");
    setFilePaths([]);
    setNote("");
    void api<Trace>(base + query)
      .then((value) => {
        if (live) setTrace(value);
      })
      .catch((reason) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [open, base, query, session.revision]);
  const refresh = async () => {
    setError("");
    try {
      setTrace(await api<Trace>(base + query));
    } catch (reason) {
      setError(String(reason));
    }
  };
  const record = async () => {
    if (!trace?.run?.candidate || !criterionId) return;
    const criterion = trace.criteria.find((item) => item.id === criterionId);
    if (!criterion) return;
    setBusy(true);
    setError("");
    try {
      commit();
      await flush();
      setTrace(
        await post<Trace>(`${base}/reviews`, {
          mutationId: uid(),
          criterionId,
          criterionHash: criterion.meaningHash,
          requirementHash: trace.requirement.meaningHash,
          runId: trace.run.id,
          candidateHash: trace.run.candidate.sha256,
          commandId: commandId || null,
          filePaths,
          note,
          confirmed: true,
        }),
      );
      setNote("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="trace-panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Requirement, code and acceptance evidence</summary>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {open && !trace && !error && <p>Loading traceability…</p>}
      {trace && (
        <>
          <section aria-label="Requirement trace">
            <h3>Requirement</h3>
            <p className="trace-text">
              {trace.requirement.text ||
                "No requirement recorded in the project brief. Add one in planning."}
            </p>
            <p className="muted">
              The project requirement is context for this task. Criterion
              associations need your review.
            </p>
            <details>
              <summary>Stable requirement identity</summary>
              <code>{trace.requirement.id}</code>
              <p>
                Meaning: <code>{trace.requirement.meaningHash}</code>
              </p>
            </details>
            {trace.diagramLinks.length > 0 && (
              <ul>
                {trace.diagramLinks.map((link) => (
                  <li key={link.nodeId}>
                    {onRevealNode && !link.missing ? (
                      <button
                        className="quiet"
                        onClick={() =>
                          onRevealNode(link.diagramId, link.nodeId)
                        }
                      >
                        {link.title}
                      </button>
                    ) : (
                      link.title
                    )}
                    {link.missing
                      ? " · removed diagram element"
                      : " · linked diagram element"}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <h3>{trace.taskTitle} · implementation</h3>
          {trace.run ? (
            <>
              <p>
                Run: {trace.run.state} · base{" "}
                <code>{trace.run.sourceCommit}</code>
              </p>
              {trace.run.planStale && (
                <p className="execution-notice">
                  This is a historical result for changed intent or an earlier
                  selected plan. Its evidence does not verify the current task.
                </p>
              )}
              {onOpenRun && (
                <button onClick={() => onOpenRun(trace.run!.id)}>
                  Open diff and execution review
                </button>
              )}
              <p>
                Candidate:{" "}
                <code>
                  {trace.run.candidate?.sha256 ??
                    "Unavailable while running or for an inaccessible worktree"}
                </code>
              </p>
              {trace.run.candidateStale && (
                <p className="execution-notice">
                  The current candidate differs from the captured diff, or its
                  historical identity is missing. Open execution review and
                  Refresh results before recording new review.
                </p>
              )}
              {trace.run.candidateError && (
                <p className="execution-notice">{trace.run.candidateError}</p>
              )}
              {trace.files.length ? (
                <ul>
                  {trace.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code> · {file.kind}
                      <details>
                        <summary>Revision-bound file reference</summary>
                        <p>
                          File SHA-256:{" "}
                          <code>
                            {file.fileHash ??
                              "File removed or identity unavailable"}
                          </code>
                        </p>
                        <p>
                          Candidate: <code>{file.candidateHash}</code>
                        </p>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No changed files captured.</p>
              )}
              <h3>Checks associated with this task</h3>
              {trace.run.commands.length ? (
                trace.run.commands.map((command) => (
                  <details key={command.id}>
                    <summary>
                      {verificationLabel(
                        command.verificationState ?? "external_result_reported",
                      )}{" "}
                      · {command.command}
                    </summary>
                    <p>
                      Origin:{" "}
                      {command.evidence?.provenance === "host_observed"
                        ? "host-observed isolated process"
                        : "executor report; candidate provenance unavailable"}
                    </p>
                    <p>
                      Recorded candidate:{" "}
                      <code>
                        {command.evidence?.candidateBefore ?? "Not recorded"}
                      </code>
                    </p>
                    {command.evidence?.executionMode && <p>Mode: {command.evidence.executionMode.replaceAll('_', ' ')}. Writable locations: {command.evidence.writableLocations?.join(', ')}.</p>}
                    {command.evidence?.testResult && (
                      <p>
                        JUnit artifact:{" "}
                        {command.evidence.testResult.state.replaceAll("_", " ")}{" "}
                        {command.evidence.testResult.counts &&
                          JSON.stringify(command.evidence.testResult.counts)}
                      </p>
                    )}
                    <pre>{command.output || "No output recorded."}</pre>
                  </details>
                ))
              ) : (
                <p>Not verified: no command evidence recorded.</p>
              )}
            </>
          ) : (
            <p>Not verified: no execution result exists for this task.</p>
          )}
          <h3>Acceptance criteria</h3>
          {trace.criteria.map((criterion) => (
            <section className="trace-criterion" key={criterion.id}>
              <p>
                <strong>{criterion.text || "Untitled criterion"}</strong> ·{" "}
                {verificationLabel(criterion.verificationState)}
              </p>
              {criterion.reviews.map((review) => (
                <details key={review.id}>
                  <summary>
                    {review.stale
                      ? "Stale human review"
                      : "Human review recorded"}{" "}
                    · {new Date(review.createdAt).toLocaleString()}
                  </summary>
                  <p className="trace-text">{review.note}</p>
                  <p>
                    User-confirmed association:{" "}
                    {review.commandId ?? "manual review only"}
                  </p>
                  <p>
                    {review.filePaths.join(", ") ||
                      "No files specifically associated."}
                  </p>
                  <code>{review.candidateHash}</code>
                </details>
              ))}
            </section>
          ))}
          {trace.run?.candidate && trace.criteria.length > 0 && (
            <details>
              <summary>Record criterion review and associations</summary>
              <Field label="Acceptance criterion">
                <select
                  value={criterionId}
                  onChange={(event) => setCriterionId(event.target.value)}
                >
                  <option value="">Select criterion</option>
                  {trace.criteria.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.text}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Supporting command">
                <select
                  value={commandId}
                  onChange={(event) => setCommandId(event.target.value)}
                >
                  <option value="">Manual review, no supporting command</option>
                  {trace.run.commands.map((item) => (
                    <option key={item.id} value={item.id}>
                      {verificationLabel(
                        item.verificationState ?? "external_result_reported",
                      )}{" "}
                      · {item.command}
                    </option>
                  ))}
                </select>
              </Field>
              {trace.files.length > 0 && (
                <fieldset>
                  <legend>Files associated with this criterion</legend>
                  {trace.files.map((file) => (
                    <label key={file.path}>
                      <input
                        type="checkbox"
                        checked={filePaths.includes(file.path)}
                        onChange={(event) =>
                          setFilePaths((old) =>
                            event.target.checked
                              ? [...old, file.path]
                              : old.filter((path) => path !== file.path),
                          )
                        }
                      />
                      {file.path}
                    </label>
                  ))}
                </fieldset>
              )}
              <Field label="What you checked, and what remains uncertain">
                <textarea
                  value={note}
                  maxLength={4000}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Field>
              <button
                disabled={
                  busy ||
                  !criterionId ||
                  !note.trim() ||
                  trace.run.planStale ||
                  trace.run.candidateStale
                }
                onClick={() => void record()}
              >
                Confirm human review
              </button>
              <p className="muted">
                Records your review of this candidate and criterion. Acceptance
                and checkout application remain separate.
              </p>
            </details>
          )}
          <p className="muted">{trace.uncertainty}</p>
          <div className="execution-actions">
            <button disabled={busy} onClick={() => void refresh()}>
              Refresh evidence
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void download(
                  `${base}/export${query}`,
                  "planbranch-task-evidence.json",
                ).catch((reason) => setError(String(reason)))
              }
            >
              Export evidence JSON
            </button>
          </div>
        </>
      )}
    </details>
  );
}
