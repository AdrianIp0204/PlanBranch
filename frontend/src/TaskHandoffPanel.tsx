import { useEffect, useRef, useState } from "react";
import { api, ApiError, downloadBlob, post } from "./api";
import { useProject } from "./store";
import { ErrorMessage, Field } from "./ui";
import { uid } from "./types";
import type { ExecutionRun } from "./execution";
import { useRunObservation } from "./useRunObservation";
import "./plan-handoff.css";

type Manifest = {
  schema: string;
  handoffId: string;
  contentHash: string;
  taskId: string;
  baseCommit: string | null;
  baseUnavailableReason?: string | null;
  sourceIncluded: boolean;
  expectedReturn: Record<string, unknown>;
  [key: string]: unknown;
};
type Package = { manifest: Manifest; markdown: string };
type ExternalResult = {
  id: string;
  handoffId: string;
  origin: string;
  verificationState: string;
  baseCommit: string;
  candidateCommit: string;
  contentHash: string;
  compatibilityIssues: string[];
  report: unknown;
  reportTrust: string;
  files: {
    path: string;
    diff: string;
    binary: boolean;
    beforeMode?: string;
    afterMode?: string;
  }[];
  reviews: { id: string; decision: string; note: string; createdAt: string }[];
  localVerifications?: { id: string; state: string; createdAt: string }[];
};
type HandoffState = {
  handoffs: { id: string; contentHash: string; createdAt: string }[];
  results: ExternalResult[];
};

export default function TaskHandoffPanel({
  taskId,
  onRun,
}: {
  taskId: string;
  onRun?: (runId?: string) => void;
}) {
  const { session, commit, flush, getSnapshot } = useProject();
  const [state, setState] = useState<HandoffState>({
    handoffs: [],
    results: [],
  });
  const [preview, setPreview] = useState<Package | null>(null);
  const [supporting, setSupporting] = useState("");
  const [returned, setReturned] = useState("");
  const [handoffId, setHandoffId] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const path = `/projects/${session.id}/handoffs`;
  const refresh = async () =>
    setState(
      await api<HandoffState>(`${path}?taskId=${encodeURIComponent(taskId)}`),
    );
  useEffect(() => {
    setState({ handoffs: [], results: [] });
    setPreview(null);
    setHandoffId("");
    setReturned("");
    setError("");
  }, [path, taskId]);
  useEffect(() => {
    let current = true;
    setPreview(null);
    void api<HandoffState>(`${path}?taskId=${encodeURIComponent(taskId)}`)
      .then((value) => {
        if (current) setState(value);
      })
      .catch((cause: Error) => {
        if (current) setError(cause.message);
      });
    return () => {
      current = false;
    };
  }, [path, taskId, session.revision]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    commit();
    if (!(await flush()))
      throw new Error(
        "Save or recover the current plan before preparing a handoff.",
      );
    const result = await post<Package>(path, {
      taskId,
      baseRevision: getSnapshot().revision,
      supportingContext: supporting,
    });
    setPreview(result);
    setHandoffId(result.manifest.handoffId);
    await refresh();
  }
  async function openSaved(id: string) {
    const result = await api<Package>(`${path}/${id}`);
    setPreview(result);
    setHandoffId(id);
  }
  async function importResult() {
    const value = JSON.parse(returned) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        "Paste one JSON return object from the handoff template.",
      );
    await post(`${path}/${handoffId}/results`, value);
    await refresh();
    setReturned("");
    setMessage(
      "External result imported for review. No code was executed or applied.",
    );
  }
  async function review(result: ExternalResult, decision: string) {
    await post(`/projects/${session.id}/external-results/${result.id}/review`, {
      decision,
      note: reviewNotes[result.id] ?? "",
      contentHash: result.contentHash,
    });
    await refresh();
    setMessage(
      "Human review recorded. External test claims remain external; PlanBranch did not apply code.",
    );
  }
  const returnTemplate = preview
    ? {
        ...preview.manifest.expectedReturn,
        manifestHash: preview.manifest.contentHash,
      }
    : null;
  return (
    <section
      className="task-handoff"
      aria-label="External agent handoff and review"
    >
      <ErrorMessage message={error} />
      {message && <p role="status">{message}</p>}
      <details>
        <summary>Use an external coding agent</summary>
        <p>
          Export this approved task for your editor or terminal agent, then
          return a commit for review. Source is excluded by default.
        </p>
        <details>
          <summary>Include selected supporting context</summary>
          <Field
            label="Supporting context for this export"
            hint="Optional: paste only the excerpts you intend to share. Review the concrete package before copying or downloading; provider consent does not authorize this export."
          >
            <textarea
              maxLength={64000}
              value={supporting}
              onChange={(event) => {
                setSupporting(event.target.value);
                setPreview(null);
              }}
            />
          </Field>
        </details>
        <button disabled={busy} onClick={() => void perform(prepare)}>
          Preview implementation handoff
        </button>
        {preview && (
          <section aria-label="Handoff export preview">
            <p>
              {preview.manifest.sourceIncluded
                ? "Includes the supporting context you selected."
                : "No repository source included."}{" "}
              Base:{" "}
              {preview.manifest.baseCommit ??
                "Unavailable: planning-only package"}
              .
            </p>
            {preview.manifest.baseUnavailableReason && (
              <p>{preview.manifest.baseUnavailableReason}</p>
            )}
            <details open>
              <summary>Exact implementation brief</summary>
              <pre tabIndex={0}>{preview.markdown}</pre>
            </details>
            <details>
              <summary>
                Structured manifest ·{" "}
                {new Blob([
                  JSON.stringify(preview.manifest),
                ]).size.toLocaleString()}{" "}
                bytes
              </summary>
              <pre tabIndex={0}>
                {JSON.stringify(preview.manifest, null, 2)}
              </pre>
            </details>
            <div className="plan-handoff-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await navigator.clipboard.writeText(preview.markdown);
                    setMessage("Implementation brief copied.");
                  })
                }
              >
                Copy implementation brief
              </button>
              <button
                onClick={() =>
                  downloadBlob(
                    new Blob([JSON.stringify(preview.manifest, null, 2)], {
                      type: "application/json",
                    }),
                    `planbranch-handoff-${preview.manifest.handoffId}.json`,
                  )
                }
              >
                Export handoff JSON
              </button>
              <button
                onClick={() => {
                  setReturned(JSON.stringify(returnTemplate, null, 2));
                  setHandoffId(preview.manifest.handoffId);
                }}
              >
                Use return template
              </button>
            </div>
          </section>
        )}
        {!!state.handoffs.length && (
          <>
            <h3>Return a local commit</h3>
            <p>
              Make the external candidate commit available locally. PlanBranch
              reads its objects and shows the diff without checking it out,
              running commands from the report, or changing your files. Portable
              patch import is not supported; commit the patch in your own editor
              first.
            </p>
            <Field label="Original handoff">
              <select
                value={handoffId}
                onChange={(event) => setHandoffId(event.target.value)}
              >
                <option value="">Select a handoff</option>
                {state.handoffs.map((handoff) => (
                  <option key={handoff.id} value={handoff.id}>
                    {new Date(handoff.createdAt).toLocaleString()} ·{" "}
                    {handoff.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
            <button
              disabled={busy || !handoffId}
              onClick={() => void perform(() => openSaved(handoffId))}
            >
              Inspect saved export
            </button>
            <Field
              label="Returned result JSON"
              hint="Use the template, replace candidateCommit with a full local commit hash, and optionally include a test report. Reports are untrusted claims."
            >
              <textarea
                className="handoff-return"
                value={returned}
                onChange={(event) => setReturned(event.target.value)}
                maxLength={100000}
                spellCheck={false}
              />
            </Field>
            <button
              disabled={busy || !handoffId || !returned.trim()}
              onClick={() => void perform(importResult)}
            >
              Import for review
            </button>
          </>
        )}
      </details>
      {state.results.map((result) => (
        <article
          key={result.id}
          className="external-result"
          aria-label="External result review"
        >
          <h3>{result.verificationState}</h3>
          <p>
            Provenance: <strong>{result.origin}</strong>. {result.reportTrust}
          </p>
          <p className="revision-line">
            Base {result.baseCommit}
            <br />
            Candidate {result.candidateCommit}
          </p>
          {!!result.compatibilityIssues.length && (
            <div role="status">
              <strong>Stale result — acceptance disabled</strong>
              <ul>
                {result.compatibilityIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {!result.files.length && (
            <p>No files changed between these commits.</p>
          )}
          {result.files.map((file) => (
            <details key={file.path}>
              <summary>
                {file.path}
                {file.binary ? " · binary" : ""}
              </summary>
              {file.beforeMode !== file.afterMode && (
                <p>
                  File mode: {file.beforeMode ?? "absent"} →{" "}
                  {file.afterMode ?? "absent"}
                </p>
              )}
              <pre tabIndex={0}>{file.diff || "No textual changes."}</pre>
            </details>
          ))}
          <details>
            <summary>External test report · untrusted content</summary>
            <pre tabIndex={0}>{JSON.stringify(result.report, null, 2)}</pre>
          </details>
          <button
            onClick={() =>
              downloadBlob(
                new Blob(
                  [
                    JSON.stringify(
                      {
                        schema: "planbranch.external-review.v1",
                        projectId: session.id,
                        taskId,
                        ...result,
                        origin: "external",
                      },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                ),
                `planbranch-external-review-${result.id}.json`,
              )
            }
          >
            Export external review JSON
          </button>
          <Field label="Human review note">
            <textarea
              value={reviewNotes[result.id] ?? ""}
              maxLength={8000}
              onChange={(event) =>
                setReviewNotes((notes) => ({
                  ...notes,
                  [result.id]: event.target.value,
                }))
              }
            />
          </Field>
          <div className="plan-handoff-actions">
            <button
              disabled={
                busy ||
                !reviewNotes[result.id]?.trim() ||
                !!result.compatibilityIssues.length
              }
              onClick={() => void perform(() => review(result, "accepted"))}
            >
              Record accepted review
            </button>
            <button
              disabled={busy || !reviewNotes[result.id]?.trim()}
              onClick={() =>
                void perform(() => review(result, "changes_requested"))
              }
            >
              Request changes
            </button>
          </div>
          <p className="muted">
            A review records your judgment; it does not approve execution,
            certify the external tests, apply the commit, or mark the task done.
            Use your existing Git tools to integrate the reviewed commit. Local
            checks require a separate authorized run.
          </p>
          <ExternalVerification
            key={`${session.id}/${taskId}/${result.id}/${result.contentHash}/${result.candidateCommit}`}
            projectId={session.id}
            result={result}
            onOpenRun={onRun}
          />
          {!!result.reviews.length && (
            <ul>
              {result.reviews.map((item) => (
                <li key={item.id}>
                  {item.decision === "accepted"
                    ? "Human review recorded: accepted, not applied"
                    : "Changes requested"}{" "}
                  · {new Date(item.createdAt).toLocaleString()}
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}

type VerificationPreview = {
  ready: boolean;
  issues: string[];
  preview: {
    id: string;
    candidateCommit: string;
    command: string;
    timeoutSeconds: number;
    generation?: { commandPolicy?: { imageLabel?: string; version?: string } };
  };
};

function ExternalVerification({
  projectId,
  result,
  onOpenRun,
}: {
  projectId: string;
  result: ExternalResult;
  onOpenRun?: (runId: string) => void;
}) {
  const { commit, flush } = useProject();
  const [command, setCommand] = useState("");
  const [seconds, setSeconds] = useState(60);
  const [preview, setPreview] = useState<VerificationPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<{
    previewId: string;
    mutationId: string;
    confirmed: true;
  } | null>(null);
  const {
    run,
    error: observationError,
    observe,
    refresh: refreshObservation,
  } = useRunObservation(projectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const base = `/projects/${projectId}/external-results/${result.id}/verification`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
  }, [result.contentHash, result.candidateCommit]);
  function invalidate() {
    setPreview(null);
    setConfirmed(false);
  }
  async function prepare() {
    setBusy(true);
    setError("");
    invalidate();
    try {
      commit();
      if (!(await flush()))
        throw new Error(
          "Save or recover the plan before preparing local verification.",
        );
      if (!alive.current) return;
      const next = await post<VerificationPreview>(`${base}/preview`, {
        contentHash: result.contentHash,
        command,
        timeoutSeconds: seconds,
      });
      if (alive.current) setPreview(next);
    } catch (cause) {
      if (alive.current) setError((cause as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function start() {
    if (!pending && (!preview?.ready || !confirmed)) return;
    const body = pending ?? {
      previewId: preview!.preview.id,
      mutationId: uid(),
      confirmed: true as const,
    };
    setPending(body);
    setBusy(true);
    setError("");
    try {
      const next = await post<{ run: ExecutionRun }>(`${base}/start`, body);
      if (alive.current) {
        observe(next.run);
        setPending(null);
        invalidate();
      }
    } catch (cause) {
      if (alive.current) {
        setError((cause as Error).message);
        if (
          cause instanceof ApiError &&
          cause.status >= 400 &&
          cause.status < 500
        ) {
          setPending(null);
          invalidate();
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const active = Boolean(
    run && ["queued", "running", "cancelling"].includes(run.state),
  );
  return (
    <details className="external-verification">
      <summary>Verify returned candidate without editing</summary>
      <p>
        Choose a check yourself. It runs directly in the configured isolated
        runtime against the exact returned commit. No coding agent is called and
        source changes are not copied back. The external report keeps its
        original provenance.
      </p>
      <p>
        First select the same execution repository and use your Git tools to
        check out the returned commit with a clean working tree. PlanBranch will
        not change your checkout.
      </p>
      <ErrorMessage message={error || observationError} />
      <Field
        label="Local verification command"
        hint="Commands in the imported report are never selected or run automatically."
      >
        <textarea
          value={command}
          maxLength={8000}
          disabled={busy || active || !!pending}
          onChange={(event) => {
            setCommand(event.target.value);
            invalidate();
          }}
        />
      </Field>
      <Field label="Verification timeout in seconds">
        <input
          type="number"
          min={1}
          max={120}
          value={seconds}
          disabled={busy || active || !!pending}
          onChange={(event) => {
            setSeconds(Number(event.target.value));
            invalidate();
          }}
        />
      </Field>
      <button
        disabled={
          busy ||
          active ||
          !!pending ||
          !command.trim() ||
          !!result.compatibilityIssues.length
        }
        onClick={() => void prepare()}
      >
        Preview verification without editing
      </button>
      {preview && (
        <section aria-label="Local verification preview">
          <p>
            Returned candidate: <code>{preview.preview.candidateCommit}</code>
          </p>
          <pre>{preview.preview.command}</pre>
          <p>
            Working directory: repository root. Timeout:{" "}
            {preview.preview.timeoutSeconds} seconds.{" "}
            {preview.preview.generation?.commandPolicy?.imageLabel
              ? `Runtime image: ${preview.preview.generation.commandPolicy.imageLabel}.`
              : "The configured Docker runtime is required."}
          </p>
          {!!preview.issues.length && (
            <ul>
              {preview.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !!pending || !preview.ready}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            I authorize this check against this returned candidate without
            editing source.
          </label>
          <button
            disabled={
              busy ||
              !preview.ready ||
              !confirmed ||
              !!pending ||
              !!result.compatibilityIssues.length
            }
            onClick={() => void start()}
          >
            Run verification without editing
          </button>
        </section>
      )}
      {pending && !busy && (
        <>
          <p>
            The start response is unresolved. Retry the same request to
            reconcile it without starting a second check.
          </p>
          <button onClick={() => void start()}>Retry verification start</button>
        </>
      )}
      {run && (
        <section aria-label="Local verification result">
          <h4>
            {observationError
              ? `Last observed local verification: ${run.state}`
              : run.state === "succeeded"
                ? "Verification process completed"
                : `Local verification: ${run.state}`}
          </h4>
          <p>{run.summary || run.progress}</p>
          {run.error && <p role="alert">{run.error}</p>}
          {(run.planStale || run.candidateStale) && (
            <p>
              These observations are stale for the current intent or candidate.
            </p>
          )}
          {run.commands.map((item) => (
            <details key={item.id} open>
              <summary>
                {item.command} ·{" "}
                {item.verificationState?.replaceAll("_", " ") ?? item.status}
              </summary>
              <p>
                Exit status: {item.exitCode ?? "unavailable"}. Provenance:{" "}
                {item.evidence?.provenance ?? "unavailable"}.
              </p>
              <pre>{item.output}</pre>
            </details>
          ))}
          <p>
            Process success alone does not prove a requirement. Inspect the
            observation and record any criterion association separately.
          </p>
          <button onClick={refreshObservation}>
            Refresh local observation
          </button>
          {onOpenRun && (
            <button onClick={() => onOpenRun(run.id)}>
              Open local observation review
            </button>
          )}
        </section>
      )}
      {!!result.localVerifications?.length && (
        <section aria-label="Saved local verification history">
          <h4>Saved local verification history</h4>
          <ul>
            {result.localVerifications.map((item) => (
              <li key={item.id}>
                {item.state} · {new Date(item.createdAt).toLocaleString()}{" "}
                {onOpenRun && (
                  <button onClick={() => onOpenRun(item.id)}>
                    Review local check
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p>
            These separate local observations do not change the external
            report’s provenance.
          </p>
        </section>
      )}
    </details>
  );
}
