import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Dialog } from "./ui";
import { updateAgentPreference, usePreferences } from "./preferences";
import { providerIds, providerLabel, type ProviderId } from "./planning";
import "./codex-connection.css";

export type CodexConnectionStatus = {
  agent: { available: boolean; label: string; reason?: string };
  cliVersion?: string | null;
};

export default function CodexConnection() {
  const { preferences } = usePreferences();
  const provider = preferences.planningAgent.provider;
  const label = provider === "codex" ? "Codex" : providerLabel(provider);
  const cloud = ["openai", "anthropic", "gemini"].includes(provider);
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
        provider === "codex"
          ? refresh
            ? "/connection?refresh=1"
            : "/connection"
          : `/agent/status?provider=${provider}${refresh ? "&refresh=1" : ""}`,
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
  }, [provider]);
  const available = !error && !!connection?.agent.available;
  return (
    <section
      className="codex-connection"
      aria-label={`${label} connection`}
      aria-busy={checking}
    >
      <div className="codex-connection-heading">
        <h2>{label} connection</h2>
        <button disabled={checking} onClick={() => void check(true)}>
          Retry connection
        </button>
      </div>
      <label>
        Planning provider
        <select
          aria-label="Planning provider"
          value={provider}
          onChange={(event) =>
            updateAgentPreference("planning", event.target.value as ProviderId)
          }
        >
          {providerIds.map((id) => (
            <option key={id} value={id}>
              {providerLabel(id)}
            </option>
          ))}
        </select>
      </label>
      <p
        role="status"
        className={`codex-connection-status ${checking ? "checking" : available ? "ready" : "unavailable"}`}
      >
        <span aria-hidden="true">{checking ? "○" : available ? "✓" : "!"}</span>
        {checking
          ? `Checking ${label}…`
          : available
            ? cloud
              ? `${label} configured`
              : provider === "codex"
                ? "Codex ready"
                : `${label} connected`
            : `${label} unavailable`}
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
          {provider === "codex" ? (
            <>
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
            </>
          ) : provider === "ollama" ? (
            <p>
              Start Ollama and install a model. PlanBranch uses 127.0.0.1:11434
              unless PLANBRANCH_OLLAMA_URL is set.
            </p>
          ) : (
            <p>
              Set{" "}
              {
                (
                  {
                    openai: "OPENAI_API_KEY",
                    anthropic: "ANTHROPIC_API_KEY",
                    gemini: "GEMINI_API_KEY",
                  } as Record<string, string>
                )[provider]
              }{" "}
              before starting PlanBranch, then restart. Connection setup is also
              in Settings → Agent.
            </p>
          )}
          <p className="codex-connection-manual">
            {provider === "codex"
              ? "You can create and edit plans without Codex."
              : "You can create and edit plans while this provider is unavailable."}
          </p>
        </>
      ) : !checking ? (
        <p>
          {provider === "codex"
            ? "Uses your existing CLI sign-in. Ollama and cloud providers are also available."
            : cloud
              ? "A credential is configured. Model access is checked when you send a request."
              : "Uses your local Ollama server. Choose an installed model in Chat or Settings."}
        </p>
      ) : (
        <p>You can keep planning while this check runs.</p>
      )}
    </section>
  );
}

export function CodexConnectionDialog({ onClose }: { onClose: () => void }) {
  const { preferences } = usePreferences();
  return (
    <Dialog
      title={
        preferences.planningAgent.provider === "codex"
          ? "Codex connection"
          : "Provider connection"
      }
      className="codex-connection-dialog"
      onClose={onClose}
    >
      <CodexConnection />
    </Dialog>
  );
}
