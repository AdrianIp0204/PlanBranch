import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Dialog } from "./ui";
import "./codex-connection.css";

export type CodexConnectionStatus = {
  agent: { available: boolean; label: string; reason?: string };
  cliVersion?: string | null;
};

export default function CodexConnection() {
  const [connection, setConnection] = useState<CodexConnectionStatus | null>(
    null,
  );
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const check = async (refresh = false) => {
    const ticket = ++sequence.current;
    setChecking(true);
    setError("");
    try {
      const result = await api<CodexConnectionStatus>(
        refresh ? "/connection?refresh=1" : "/connection",
      );
      if (ticket === sequence.current) setConnection(result);
    } catch (reason) {
      if (ticket === sequence.current) {
        setConnection(null);
        setError(
          reason instanceof Error
            ? reason.message
            : "The connection check could not finish.",
        );
      }
    } finally {
      if (ticket === sequence.current) setChecking(false);
    }
  };
  useEffect(() => {
    void check();
    return () => {
      ++sequence.current;
    };
  }, []);
  const available = !error && !!connection?.agent.available;
  return (
    <section
      className="codex-connection"
      aria-label="Codex connection"
      aria-busy={checking}
    >
      <div className="codex-connection-heading">
        <h2>Codex connection</h2>
        <button disabled={checking} onClick={() => void check(true)}>
          Retry connection
        </button>
      </div>
      <p
        role="status"
        className={`codex-connection-status ${checking ? "checking" : available ? "ready" : "unavailable"}`}
      >
        <span aria-hidden="true">{checking ? "○" : available ? "✓" : "!"}</span>
        {checking
          ? "Checking Codex…"
          : available
            ? "Codex ready"
            : "Codex unavailable"}
        {!checking && available && connection?.cliVersion && (
          <span className="codex-connection-version">
            CLI {connection.cliVersion}
          </span>
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {!checking && !available ? (
        <>
          {!error && connection?.agent.reason && (
            <p>{connection.agent.reason}</p>
          )}
          <p>
            Install Codex CLI, then run <code>codex</code> in a terminal and
            sign in with ChatGPT. Retry when ready.
          </p>
          <a
            href="https://learn.chatgpt.com/docs/codex/cli"
            target="_blank"
            rel="noopener noreferrer"
          >
            Codex setup guide
          </a>
          <p className="codex-connection-manual">
            You can create and edit plans without Codex.
          </p>
        </>
      ) : !checking ? (
        <p>Uses your existing CLI sign-in.</p>
      ) : (
        <p>You can keep planning while this check runs.</p>
      )}
    </section>
  );
}

export function CodexConnectionDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Codex connection"
      className="codex-connection-dialog"
      onClose={onClose}
    >
      <CodexConnection />
    </Dialog>
  );
}
