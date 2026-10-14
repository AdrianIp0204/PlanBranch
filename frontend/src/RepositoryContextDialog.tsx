import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Dialog } from "./ui";
import { uid } from "./types";
import {
  providerLabel,
  type PlanningPrompt,
  type SourceContextReceipt,
} from "./planning";
import "./repository-context.css";

type Selection = { path: string; symbolId?: string };
type Catalogue = {
  files: string[];
  symbols: Array<{
    id: string;
    file: string;
    name: string;
    scope: string;
    line: number;
  }>;
  revision: string;
  partial: boolean;
  exclusions: string;
};
type Preview = SourceContextReceipt & {
  outgoing: unknown;
  notice: string;
  source: {
    files: Array<{
      path: string;
      text: string;
      startLine: number;
      endLine: number;
      redactedLines: number[];
    }>;
  };
};
const problem = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Context preview could not be prepared.";

export default function RepositoryContextDialog({
  projectId,
  prompt,
  onSend,
  onClose,
}: {
  projectId: string;
  prompt: PlanningPrompt;
  onSend: (prompt: PlanningPrompt) => Promise<void>;
  onClose: () => void;
}) {
  const base = `/projects/${projectId}/planning/context`;
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const previewId = useRef<string | null>(null);
  const sequence = useRef(0);
  const abort = useRef<AbortController | null>(null);
  function cancelPreview() {
    sequence.current++;
    abort.current?.abort();
    if (previewId.current)
      void api(`${base}/${previewId.current}/cancel`, {
        method: "POST",
        body: "{}",
      }).catch(() => {});
    previewId.current = null;
  }
  useEffect(() => {
    const controller = new AbortController();
    void api<Catalogue>(`${base}/files`, { signal: controller.signal })
      .then(setCatalogue)
      .catch((error) => {
        if (!controller.signal.aborted) setError(problem(error));
      });
    return () => {
      controller.abort();
      cancelPreview();
    };
  }, [base]);
  function select(item: Selection, checked: boolean) {
    cancelPreview();
    setPreview(null);
    setConfirmed(false);
    setSelected((items) =>
      checked
        ? [...items, item]
        : items.filter(
            (candidate) =>
              candidate.path !== item.path ||
              candidate.symbolId !== item.symbolId,
          ),
    );
  }
  async function prepare() {
    cancelPreview();
    const attempt = sequence.current;
    const id = uid();
    previewId.current = id;
    abort.current = new AbortController();
    setError("");
    setBusy("Preparing");
    setPreview(null);
    setConfirmed(false);
    try {
      const result = await api<Preview>(`${base}/preview`, {
        method: "POST",
        signal: abort.current.signal,
        body: JSON.stringify({ previewId: id, prompt, selected }),
      });
      if (sequence.current === attempt) setPreview(result);
    } catch (error) {
      if (sequence.current === attempt) setError(problem(error));
    } finally {
      if (sequence.current === attempt) setBusy("");
    }
  }
  async function send() {
    if (!preview || !confirmed) return;
    setBusy("Sending");
    try {
      await onSend({
        ...prompt,
        repositoryConsent: {
          previewId: preview.previewId,
          packageHash: preview.packageHash,
          confirmed: true,
        },
      });
      onClose();
    } catch (error) {
      setError(problem(error));
      setBusy("");
    }
  }
  return (
    <Dialog
      title="Include selected repository context"
      onClose={() => {
        cancelPreview();
        onClose();
      }}
      className="repository-context-dialog"
    >
      <p>
        Select up to 8 files or Python symbol excerpts. This reads the Source
        attachment only; it grants no execution or editing permission.
      </p>
      <p>
        Previous conversation is omitted from this request. Source stays local
        until you confirm the exact package below.
      </p>
      {error && <p role="alert">{error}</p>}
      {catalogue && (
        <>
          <p>{catalogue.exclusions}</p>
          {catalogue.partial && (
            <p role="status">
              The bounded catalogue is partial. Narrow the Source attachment to
              list other files.
            </p>
          )}
          <label>
            Filter files and symbols{" "}
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <fieldset
            disabled={Boolean(busy)}
            className="repository-context-files"
          >
            <legend>Selected source ({selected.length}/8)</legend>
            {catalogue.files
              .filter((path) =>
                path.toLowerCase().includes(query.toLowerCase()),
              )
              .map((path) => {
                const checked = selected.some(
                  (item) => item.path === path && !item.symbolId,
                );
                return (
                  <label key={path}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selected.length >= 8}
                      onChange={(event) =>
                        select({ path }, event.target.checked)
                      }
                    />
                    {path}
                  </label>
                );
              })}
            {catalogue.symbols
              .filter((symbol) =>
                `${symbol.file} ${symbol.name} ${symbol.scope}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((symbol) => {
                const checked = selected.some(
                  (item) => item.symbolId === symbol.id,
                );
                return (
                  <label key={symbol.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selected.length >= 8}
                      onChange={(event) =>
                        select(
                          { path: symbol.file, symbolId: symbol.id },
                          event.target.checked,
                        )
                      }
                    />
                    {symbol.file}:{symbol.line} · {symbol.scope}.{symbol.name}{" "}
                    (excerpt)
                  </label>
                );
              })}
          </fieldset>
          <button
            type="button"
            disabled={!selected.length || Boolean(busy)}
            onClick={() => void prepare()}
          >
            Preview outgoing request
          </button>
        </>
      )}
      {busy === "Preparing" && (
        <p role="status">
          Preparing a bounded preview…{" "}
          <button
            onClick={() => {
              cancelPreview();
              setBusy("");
            }}
          >
            Cancel preview
          </button>
        </p>
      )}
      {preview && (
        <section aria-label="Source sharing preview">
          <h3>
            {providerLabel(preview.provider)} · {preview.model}
          </h3>
          <p>
            {preview.requestBytes.toLocaleString()} bytes · frozen revision{" "}
            {preview.revision.slice(0, 12)}
          </p>
          <p>{preview.notice}</p>
          {preview.source.files.map((file, index) => (
            <details key={`${file.path}-${index}`} open>
              <summary>
                {file.path}:{file.startLine}–{file.endLine}
                {file.redactedLines.length
                  ? ` · ${file.redactedLines.length} redacted lines`
                  : ""}
              </summary>
              <pre>{file.text}</pre>
            </details>
          ))}
          <details>
            <summary>
              Exact outgoing source-bearing request and instructions
            </summary>
            <pre>{JSON.stringify(preview.outgoing, null, 2)}</pre>
          </details>
          <p className="repository-context-hash">
            Package SHA-256: {preview.packageHash}
          </p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I confirm sending this frozen package to{" "}
            {providerLabel(preview.provider)} / {preview.model}.
          </label>
          <button
            className="primary"
            disabled={!confirmed || Boolean(busy)}
            onClick={() => void send()}
          >
            Confirm and send this package
          </button>
        </section>
      )}
    </Dialog>
  );
}

export function RepositoryReferences({
  projectId,
  source,
}: {
  projectId: string;
  source: SourceContextReceipt;
}) {
  const [current, setCurrent] = useState(source);
  const [error, setError] = useState("");
  return (
    <details className="repository-context-references">
      <summary>Inspected source · {source.revision.slice(0, 12)}</summary>
      <p>
        Selected source supported this proposal; it is not test evidence. Hashes
        identify bytes, not correctness.
      </p>
      <ul>
        {current.files.map((file, index) => (
          <li key={`${file.path}-${index}`}>
            {file.path}:{file.startLine}–{file.endLine}{" "}
            {file.symbol ? `· ${file.symbol.scope}.${file.symbol.name}` : ""}
            <br />
            {file.stale === true
              ? "Stale reference — source or revision changed"
              : file.stale === false
                ? "Source bytes and revision still match"
                : "Freshness not checked"}
            <small className="repository-context-hash">
              SHA-256: {file.fileHash}
            </small>
          </li>
        ))}
      </ul>
      {source.requestId && (
        <button
          onClick={() =>
            void api<SourceContextReceipt>(
              `/projects/${projectId}/planning/context/references/${source.requestId}`,
            )
              .then(setCurrent)
              .catch((error) => setError(problem(error)))
          }
        >
          Check source freshness
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
